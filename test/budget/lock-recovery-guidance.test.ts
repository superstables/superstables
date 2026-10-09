import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const { createIdentitySource } = await import(join(root, 'src/core/process-identity.mjs'));
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-recovery-guidance-')); homes.push(home);
  const ops = join(home, 'budget/ops/solana-devnet'), approvals = join(home, 'budget/approvals'), records = join(home, 'records');
  for (const dir of [ops, approvals, records]) mkdirSync(dir, { recursive: true });
  return { home, ops, approvals, records };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function unlock(home: string, target: string[], answer = 'payment-lock', unverified = false) {
  const result = spawnSync(process.execPath, ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', ...target, '--confirm', ...(unverified ? ['--unverified'] : [])], {
    env: { ...process.env, SUPERSTABLES_HOME: home }, input: `${answer}\n`, encoding: 'utf8', timeout: 20_000,
  });
  return { ...result, result: JSON.parse(result.stdout.trim().slice(7)) };
}
for (const cap of [false, true]) {
  it(`${cap ? 'cap' : 'operation'}: crash then different boot needs the exact owner override`, () => {
    const b = box(), path = cap ? join(b.records, 'cap.lock') : join(b.ops, 'paid-op.buy.lock');
    const owner = { ...createIdentitySource().record(), pid: 2147483646, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', writtenAt: Date.now() - 40 * 86400_000, heartbeatAt: Date.now() - 40 * 86400_000 };
    const bytes = JSON.stringify(owner); writeFileSync(path, bytes); utimesSync(path, owner.writtenAt / 1000, owner.writtenAt / 1000);
    const journal = join(b.ops, 'paid-op.json'); writeFileSync(journal, '{"state":"submitted","transaction":"retained-evidence"}');
    const target = cap ? ['--cap'] : ['--rail', 'solana', '--op', 'paid-op'], token = cap ? 'payment-lock' : 'paid-op';
    const plain = unlock(b.home, target, token);
    expect(plain.status).toBe(5); expect(plain.stderr).toContain('Cannot clear'); expect(readFileSync(path, 'utf8')).toBe(bytes);
    const override = unlock(b.home, target, `${token} unverified`, true);
    expect(override.status, override.stderr).toBe(0); expect(override.result.reason).toBe('locks_cleared');
    expect(override.stderr).toContain('may allow a second payment'); expect(override.stderr.match(/Clearing the .*without proof/g)).toHaveLength(1);
    expect(existsSync(path)).toBe(false); expect(readFileSync(journal, 'utf8')).toBe('{"state":"submitted","transaction":"retained-evidence"}');
  });
}
it.runIf(process.platform === 'linux')('legacy verified live cap rejects plain and unverified unlock', () => {
  const b = box(), identity = createIdentitySource().record();
  const path = join(b.records, 'cap.lock'), bytes = JSON.stringify({ pid: identity.pid, pidStart: identity.pidStart, owner: '0.3.0-owner' });
  writeFileSync(path, bytes);
  for (const unverified of [false, true]) {
    const r = unlock(b.home, ['--cap'], `payment-lock${unverified ? ' unverified' : ''}`, unverified);
    expect(r.status).toBe(5); expect(r.result.reason).toBe('op_in_progress'); expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(r.stderr).not.toContain('Cannot clear'); expect(r.stderr).not.toContain('Clearing the payment lock without proof');
  }
});
it('verified live head cap gives busy guidance without recommending an override', () => {
  const b = box(), path = join(b.records, 'cap.lock'), bytes = JSON.stringify(createIdentitySource().record());
  writeFileSync(path, bytes);
  const r = unlock(b.home, ['--cap']);
  expect(r.status).toBe(5); expect(r.result.reason).toBe('op_in_progress'); expect(r.result.next).toBe("The payment lock is held. Its process may still be running. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear payment locks.");
  expect(r.stderr).not.toContain('Cannot clear'); expect(r.stderr).not.toContain('--unverified'); expect(readFileSync(path, 'utf8')).toBe(bytes);
});
for (const hasLedger of [false, true]) {
  for (const unverified of [false, true]) it(`unknown attempt, ledger=${hasLedger}, override=${unverified}: not found, without clearing unrelated locks`, () => {
    const b = box(), lock = join(b.records, 'reconcile.lock');
    const bytes = '{"pid":2,"bootId":null}'; writeFileSync(lock, bytes);
    if (hasLedger) writeFileSync(join(b.records, 'attempts.jsonl'), '{"id":"other","state":"submitting"}\n');
    const r = unlock(b.home, ['--attempt', 'missing'], `payment-lock${unverified ? ' unverified' : ''}`, unverified);
    expect(r.status).toBe(3); expect(r.result.reason).toBe('attempt_not_found'); expect(r.result.next).toBe('check the original attempt ID and record directory');
    expect(r.stdout).not.toContain('The payment lock is held'); expect(r.stderr).not.toContain('Cannot clear'); expect(readFileSync(lock, 'utf8')).toBe(bytes);
  });
}
for (const mismatch of ['rail', 'chain', 'missing']) it(`approval ${mismatch}: not found with no busy or override recommendation`, () => {
  const b = box(), id = 'oa-20261006200000-01234567', path = join(b.approvals, `${id}.json.lock`);
  if (mismatch !== 'missing') {
    writeFileSync(join(b.approvals, `${id}.json`), JSON.stringify({ id, rail: mismatch === 'rail' ? 'evm' : 'solana', chain: mismatch === 'chain' ? 'mainnet' : 'devnet' }));
    writeFileSync(path, '{"pid":2}');
  }
  const r = unlock(b.home, ['--rail', 'solana', '--approval', id]);
  expect(r.status).toBe(3); expect(r.result.reason).toBe('approval_not_found'); expect(r.result.next).toBe('check the original rail, chain and approval ID');
  expect(r.stdout).not.toContain('The payment lock is held'); expect(r.stderr).not.toContain('Cannot clear'); expect(r.stderr).not.toContain('--unverified');
  if (mismatch !== 'missing') expect(readFileSync(path, 'utf8')).toBe('{"pid":2}');
});
for (const target of [['--cap'], ['--rail', 'solana', '--approvals']]) it(`${target.join(' ')} without locks reports no_lock`, () => {
  const b = box(), r = unlock(b.home, target);
  expect(r.status).toBe(0); expect(r.result.reason).toBe('no_lock');
});

// macOS agent sandboxes deny the sysctl behind os.uptime(); libuv then throws ERR_SYSTEM_ERROR uv_uptime.
const deniedUptime = () => { throw Object.assign(new Error('uv_uptime returned EPERM'), { code: 'ERR_SYSTEM_ERROR' }); };
it('takes and releases an operation lock when the boot clock is denied', () => {
  const b = box(), path = join(b.ops, 'paid-op.buy.lock');
  const script = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; import { readFileSync, existsSync } from 'node:fs';
os.uptime = ${deniedUptime.toString()}; syncBuiltinESMExports();
const { lockFile } = await import(${JSON.stringify(pathToFileURL(join(root, 'budget/op-lock.mjs')).href)});
const lock = lockFile(${JSON.stringify(path)}); const record = JSON.parse(readFileSync(${JSON.stringify(path)}, 'utf8'));
lock.release(); console.log(JSON.stringify({ ok: lock.ok, bootElapsedMs: record.bootElapsedMs ?? null, released: !existsSync(${JSON.stringify(path)}) }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toEqual({ ok: true, bootElapsedMs: null, released: true });
});
it.runIf(process.platform === 'linux')('an unavailable boot clock never proves a reused PID dead', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const real = createIdentitySource();
    const bootElapsed = () => 300_000;
    const start = (pid: number) => pid === child.pid ? `linux:${real.record().bootId}:18000` : real.start(pid);
    const readFile = (path: string, encoding: BufferEncoding) => path === '/proc/stat' ? `btime ${Math.floor(Date.now() / 1000) - 300}\n` : readFileSync(path, encoding);
    const run = () => '100';
    const working = createIdentitySource({ bootElapsed, start, readFile, run }), denied = createIdentitySource({ bootElapsed: deniedUptime, start, readFile, run });
    expect(denied.record().bootElapsedMs).toBeUndefined();
    const bootElapsedMs = 60_000;
    // The holder wrote before the child existed, so a readable boot clock proves the PID was reused.
    const owner = { ...working.record(), pid: child.pid, pidStart: null, pidStartUtc: null, hostPid: null, bootElapsedMs, writtenAt: Date.now() - (working.bootElapsed() - bootElapsedMs) };
    const attempt = (record: object, identitySource: object) => {
      const b = box(), path = join(b.ops, 'paid-op.buy.lock'), bytes = JSON.stringify(record);
      writeFileSync(path, bytes);
      const lock = lockFile(path, { identitySource });
      try { return { ok: lock.ok, kept: lock.ok || readFileSync(path, 'utf8') === bytes }; } finally { if (lock.ok) lock.release(); }
    };
    expect(attempt(owner, working)).toEqual({ ok: true, kept: true });
    expect(attempt(owner, denied)).toEqual({ ok: false, kept: true });
    const { bootElapsedMs: _, ...unclocked } = owner;
    expect(attempt(unclocked, working)).toEqual({ ok: false, kept: true });
  } finally { child.kill('SIGKILL'); await once(child, 'exit').catch(() => {}); }
});
