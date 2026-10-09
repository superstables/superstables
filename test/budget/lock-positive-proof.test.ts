import { afterEach, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentitySource, inspectProcess } from '../../src/core/process-identity.mjs';
import { once } from 'node:events';
import { withFileLock } from '../../src/core/lock.js';
import { lockFile, lockNext } from '../../budget/op-lock.mjs';
const boot = '11111111-2222-3333-4444-555555555555';
const machine = '0123456789abcdef0123456789abcdef';
const initial = 'pid:[4026531836]';
const root = resolve(import.meta.dirname, '../..');
const homes: string[] = [];
const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
function linux({ namespace = initial, readable = true, entries = ['44', '55'], unreadableCandidate = false, start = `linux:${boot}:100`, probeCode = 'ESRCH', elapsed = 10_000_000 } = {}) {
  return createIdentitySource({ platform: 'linux', bootElapsed: () => elapsed,
    readFile: path => {
      if (path === '/proc/self/mountinfo') return '1 0 0:1 / /proc rw - proc proc rw\n';
      if (path === '/etc/machine-id') return machine;
      if (path === '/proc/sys/kernel/random/boot_id') return boot;
      if (path === '/proc/self/status') return readable ? `NSpid:\t${process.pid}\n` : denied();
      if (path === '/proc/44/status') return 'NSpid:\t44\t1\n';
      if (path === '/proc/55/status') return 'NSpid:\t55\t2\n';
      if (path === '/proc/stat') return `btime ${Date.now() / 1000 - elapsed / 1000}\n`;
      return denied();
    },
    readlink: path => {
      if (path === '/proc/self/ns/pid') return readable ? namespace : denied();
      if (path === '/proc/44/ns/pid') return denied();
      if (path === '/proc/55/ns/pid') return unreadableCandidate ? denied() : 'pid:[unrelated]';
      return denied();
    }, readdir: () => entries, start: () => start,
    run: () => '100', probe: () => { if (probeCode !== 'ok') throw Object.assign(new Error('probe'), { code: probeCode }); return true; },
  });
}
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-positive-proof-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  return { home, path: join(dir, 'paid-op.buy.lock') };
}
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it('records stable host identity from machine-id and falls back to dbus machine-id', () => {
  const source = linux(); expect(source.record().hostId).toBe(machine);
  const fallback = createIdentitySource({ platform: 'linux', readFile: path => path === '/var/lib/dbus/machine-id' ? machine : denied() });
  expect(fallback.record().hostId).toBe(machine);
});
it('never trusts ESRCH when its own proc view is unreadable, even with matching host and boot', () => {
  const source = linux({ readable: false });
  expect(source.nested()).toBe(true);
  expect(inspectProcess({ ...source.record(), pid: 42, namespace: initial }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('a previous boot with a reused live PID stays possibly alive even on the same stable host', () => {
  const source = linux({ probeCode: 'ok' });
  const owner = { ...source.record(), pid: 42, writtenAt: Date.now() - 10_100_000, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  expect(inspectProcess(owner, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
  expect(inspectProcess({ ...owner, hostId: 'another-host' }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
  expect(inspectProcess({ ...owner, hostId: null }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('ignores an unreadable unrelated namespace link, but retains an unreadable matching candidate', () => {
  const source = linux(); const owner = { ...source.record(), pid: 2, namespace: 'pid:[dead-child]' };
  expect(inspectProcess(owner, source)).toEqual({ state: 'dead' });
  expect(inspectProcess(owner, linux({ unreadableCandidate: true }))).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('requires both readable namespace identities before using a PID probe or start mismatch', () => {
  const source = linux(); const owner = { ...source.record(), pid: 42, pidStart: 'old' };
  expect(inspectProcess(owner, source)).toEqual({ state: 'dead' });
  expect(inspectProcess({ ...owner, namespace: null }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
for (const platform of ['linux', 'darwin'] satisfies NodeJS.Platform[]) {
  it(`${platform}: uses a 60-second reuse margin and refuses clock doubt`, () => {
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const base = linux({ probeCode: 'ok', start: `linux:${boot}:999900` });
    const source = platform === 'linux' ? base : { ...base, record: () => ({ ...base.record(), platform: 'darwin', namespace: null }), start: () => 'darwin:utc:1799999999' };
    const owner = { ...source.record(), pid: 42, pidStart: null, writtenAt: Date.now() - 61_000, bootElapsedMs: 9_939_000 };
    expect(inspectProcess(owner, source)).toEqual({ state: 'dead' });
    expect(inspectProcess({ ...owner, writtenAt: Date.now() - 3000, bootElapsedMs: 9_997_000 }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
    expect(inspectProcess({ ...owner, writtenAt: Date.now() - 63_000 }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
    expect(inspectProcess({ ...owner, bootId: null }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
    expect(inspectProcess({ ...owner, hostId: null }, source)).toMatchObject({ state: 'alive', possiblyAlive: true });
  });
}
function unlock(home: string, { tty = true, confirm = true, answer = 'paid-op unverified\n', unverified = true } = {}) {
  return spawnSync(process.execPath, [...(tty ? ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs')] : []), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', ...(confirm ? ['--confirm'] : []), ...(unverified ? ['--unverified'] : [])], { env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8', input: answer });
}
it('requires confirm, a terminal and exactly op unverified; preserves the journal', () => {
  const b = box(); const record = JSON.stringify({ pid: 2, platform: 'linux', namespace: null, bootId: null });
  const journal = b.path.replace('.buy.lock', '.json'); writeFileSync(journal, '{"state":"unknown"}');
  writeFileSync(b.path, record);
  for (const options of [{ confirm: false }, { tty: false }, { answer: 'wrong unverified\n' }, { answer: 'paid-op\n' }, { answer: 'paid-op unverified extra\n' }, { answer: 'paid-op\nunverified\n' }]) {
    const result = unlock(b.home, options); expect(result.status, result.stderr).toBe(3);
    expect(result.stdout).not.toContain('--unverified');
    if (options.answer) expect(result.stderr).toContain('Confirmation did not match. No locks were cleared.');
    expect(readFileSync(b.path, 'utf8')).toBe(record);
  }
  const ordinary = unlock(b.home, { unverified: false, answer: 'paid-op\n' }); expect(ordinary.status).toBe(5);
  expect(ordinary.stdout).not.toContain('--unverified');
  const resultLine = ordinary.stdout.split('\n').find(line => line.startsWith('RESULT '));
  expect(resultLine).toBeDefined();
  const result = JSON.parse(resultLine?.slice(7) ?? '{}');
  expect(result.next).toBe("Operation paid-op is locked. Its process may still be running. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear operation locks.");
  expect(result.next).not.toContain('unlock');
  expect(ordinary.stderr).toContain("Cannot clear the lock for operation paid-op because Superstables cannot confirm that its process has stopped. Run the command in your own terminal, outside any agent's sandbox. If the check still fails, stop every process working on this operation across all containers and hosts, then rerun the same command with --confirm --unverified.");
  const override = unlock(b.home); expect(override.status, override.stderr).toBe(0);
  expect(override.stderr).toContain("Superstables cannot confirm that every process working on operation paid-op has stopped. Clearing its lock while any process can still run may allow a second payment for the same operation. Stop all work on it across processes, containers and hosts, and keep it stopped until unlock finishes.");
  expect(override.stderr).toContain('To clear the lock without that proof, type paid-op unverified exactly:');
  expect(override.stderr).toContain('Clearing the lock for operation paid-op without proof that its process has stopped. You confirmed that all work on this operation has stopped.');
  expect(override.stdout).not.toContain('--unverified'); expect(existsSync(b.path)).toBe(false); expect(readFileSync(journal, 'utf8')).toBe('{"state":"unknown"}');
});
it('an unverified dispatcher cannot hide a verified live rail child from the owner override', () => {
  const b = box(); const real = createIdentitySource();
  const record = { ...real.record(), pid: 2147483646, pidStart: null, railPid: process.pid, railPidStart: real.record().pidStart };
  // Only the dispatcher start is blocked; the real child identity is still positive evidence of life.
  const source = { ...real, start: (pid: number) => pid === record.pid ? undefined : real.start(pid), probe: (pid: number) => pid === record.pid ? denied() : real.probe(pid) };
  writeFileSync(b.path, JSON.stringify(record));
  const lock = lockFile(b.path, { identitySource: source, confirmPossiblyAlive: true, confirmUnverifiable: true });
  expect(lock.ok).toBe(false); expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
  expect(lockNext(lock, 'paid-op', 'solana', 'devnet')).not.toContain('--unverified');
});
it('even the explicit owner override protects a verified live holder', () => {
  const b = box(); const record = JSON.stringify(createIdentitySource().record()); writeFileSync(b.path, record);
  const result = unlock(b.home); expect(result.status).toBe(5); expect(readFileSync(b.path, 'utf8')).toBe(record);
});

it('unlock help gives the exact owner-only flag description', () => {
  const b = box();
  const help = spawnSync(process.execPath, [join(root, 'budget/cli.mjs'), 'unlock', '--help'], { encoding: 'utf8', env: { ...process.env, SUPERSTABLES_HOME: b.home } });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--unverified: Clear a lock without proof that its process has stopped. Owner only, after stopping all work on the operation. Requires typed confirmation in your own terminal.');
});

const noProc = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-user', '--dev-bind', '/', '/', '--tmpfs', '/proc'];
it.runIf(process.platform === 'linux')('a real no-proc sandbox refuses a live host holder without changing its locks', () => {
  const b = box(), holder = lockFile(b.path);
  expect(holder.ok).toBe(true);
  const original = readFileSync(b.path, 'utf8');
  try {
    const reader = spawnSync('bwrap', [...noProc, process.execPath, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'], { input: 'paid-op\n', encoding: 'utf8', env: { ...process.env, SUPERSTABLES_HOME: b.home } });
    expect(reader.status, reader.stderr).toBe(5);
    expect(reader.stdout).toContain('Its process may still be running.');
    expect(reader.stdout).not.toContain('--unverified');
    expect(readFileSync(b.path, 'utf8')).toBe(original);
  } finally { if (holder.ok) holder.release(); }
});
it.runIf(process.platform === 'linux')('a real no-proc sandbox cannot take a live host core cap lock', async () => {
  const b = box(), cap = join(b.home, 'cap.lock');
  await withFileLock(cap, async () => {
    const original = readFileSync(cap, 'utf8');
    const reader = spawnSync('bwrap', [...noProc, process.execPath, '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `const { withFileLock } = await import(${JSON.stringify(join(root, 'src/core/lock.ts'))}); try { await withFileLock(${JSON.stringify(cap)}, () => console.log('acquired'), 100); process.exitCode = 1; } catch (err) { console.log(err.message); }`], { encoding: 'utf8' });
    expect(reader.status, reader.stderr).toBe(0);
    expect(reader.stdout).not.toContain('acquired');
    expect(reader.stdout).toContain("outside the agent's sandbox");
    expect(readFileSync(cap, 'utf8')).toBe(original);
  });
});
it.runIf(process.platform === 'linux')('a dead real no-proc holder requires the explicit owner override', () => {
  const b = box(), journal = b.path.replace('.buy.lock', '.json'); writeFileSync(journal, '{"state":"submitted"}');
  const written = spawnSync('bwrap', [...noProc, process.execPath, '--input-type=module', '-e', `const { lockFile } = await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))}); const a = lockFile(${JSON.stringify(b.path)}); if (!a.ok) process.exit(1); process.kill(process.pid, 'SIGKILL');`], { encoding: 'utf8' });
  expect(existsSync(b.path), written.stderr).toBe(true);
  const original = readFileSync(b.path, 'utf8');
  const ordinary = unlock(b.home, { unverified: false, answer: 'paid-op\n' });
  expect(ordinary.status).toBe(5); expect(readFileSync(b.path, 'utf8')).toBe(original);
  expect(unlock(b.home).status).toBe(0);
  expect(existsSync(b.path)).toBe(false); expect(readFileSync(journal, 'utf8')).toBe('{"state":"submitted"}');
});
it.runIf(process.platform === 'linux')('a real live holder with blocked identity survives the round-2 two-second clock step', async () => {
  const b = box(), blocked = join(b.home, 'blocked.mjs'), stepped = join(b.home, 'clockstep.mjs');
  writeFileSync(blocked, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; for (const name of ['readFileSync','readlinkSync','readdirSync']) { const original = fs[name]; fs[name] = function(path,...args) { if (String(path).startsWith('/proc/')) throw Object.assign(new Error('denied'),{code:'EACCES'}); return original.call(this,path,...args); }; } syncBuiltinESMExports();`);
  writeFileSync(stepped, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; const original = fs.readFileSync; fs.readFileSync = function(path,...args) { const out = original.call(this,path,...args); return String(path) === '/proc/stat' ? String(out).replace(/^btime (\\d+)$/m,(_,b)=>'btime '+(Number(b)+2)) : out; }; syncBuiltinESMExports();`);
  const p = spawn(process.execPath, ['--import', blocked, '--input-type=module', '-e', `const { lockFile } = await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))}); const a = lockFile(${JSON.stringify(b.path)}); if (!a.ok) process.exit(1); console.log('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(p.stdout, 'data');
    const record = readFileSync(b.path, 'utf8');
    expect(JSON.parse(record).pidStart).toBeNull();
    const reader = spawnSync(process.execPath, ['--import', stepped, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'], { input: 'paid-op\n', encoding: 'utf8', env: { ...process.env, SUPERSTABLES_HOME: b.home } });
    expect(reader.status, reader.stderr).toBe(5); expect(readFileSync(b.path, 'utf8')).toBe(record);
    const holderPid = p.pid;
    expect(holderPid).toBeDefined();
    if (holderPid !== undefined) expect(() => process.kill(holderPid, 0)).not.toThrow();
  } finally { p.kill('SIGKILL'); await once(p, 'exit'); }
});

it('recovers a reused namespace inode from a readable start mismatch, while unreadable evidence stays possibly alive', () => {
  const source = linux({ probeCode: 'ok' });
  const stale = { ...source.record(), pid: 42, pidStart: `linux:${boot}:0` };
  expect(inspectProcess(stale, source)).toEqual({ state: 'dead' });
  expect(inspectProcess(stale, { ...source, start: () => undefined })).toMatchObject({ state: 'alive', possiblyAlive: true });
});

it('uses the exact agent string for a possibly-alive breaker owner as well as the main lock', () => {
  const b = box(), real = createIdentitySource();
  writeFileSync(b.path, JSON.stringify({ ...real.record(), pid: 2147483646, pidStart: null }));
  mkdirSync(b.path + '.break'); writeFileSync(join(b.path + '.break', 'generation.owner'), '{"pid":2}');
  const lock = lockFile(b.path); expect(lock.ok).toBe(false);
  if (!lock.ok) {
    expect(lock.details).toBe("Operation paid-op is locked. Its process may still be running. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear operation locks.");
    expect(lockNext(lock, 'paid-op', 'solana', 'devnet')).toBe(lock.details);
    expect(lock.details).not.toContain('unlock'); expect(lock.details).not.toContain('--unverified');
  }
});
