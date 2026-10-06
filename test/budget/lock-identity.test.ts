import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentitySource } from '../../budget/lock-identity.mjs';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const { lockFile, lockNext } = await import(join(root, 'budget/op-lock.mjs'));
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-identity-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  return { home, dir, path: join(dir, 'mac-op.json.lock') };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function mac({ dead = false, readable = true, bootReadable = true } = {}) {
  const run = vi.fn((command: string, args: string[]) => {
    if (command === 'sysctl') {
      expect(args).toEqual(['-n', 'kern.boottime']);
      if (!bootReadable) throw new Error('sysctl unavailable');
      return '{ sec = 1791234000, usec = 12345 } Tue Oct 6 00:00:00 2026';
    }
    expect(command).toBe('ps'); expect(args.slice(0, 3)).toEqual(['-o', 'lstart=', '-p']);
    if (!readable) throw Object.assign(new Error('ps unavailable'), { status: 2 });
    if (dead && args[3] === '42') throw Object.assign(new Error('no process'), { status: 1 });
    return ' Tue Oct  6 00:01:00 2026\n';
  });
  const probe = vi.fn((pid: number): true => {
    if (dead && pid === 42) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  return createIdentitySource({ platform: 'darwin', host: 'test-mac', run, probe });
}
function record(path: string, identitySource: ReturnType<typeof createIdentitySource>, patch = {}) {
  const owner = { ...identitySource.record(), pid: 42, pidStart: 'darwin:Tue Oct  6 00:01:00 2026', ...patch };
  writeFileSync(path, JSON.stringify(owner)); return readFileSync(path, 'utf8');
}
describe('macOS identity on any test host', () => {
  it('publishes hostname, sysctl boot time, PID and ps start time without a namespace', () => {
    const b = box(); const identitySource = mac(); const lock = lockFile(b.path, { identitySource });
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(b.path, 'utf8'))).toMatchObject({ platform: 'darwin', hostname: 'test-mac', bootId: 'darwin:1791234000:12345', namespace: null, pid: process.pid, pidStart: 'darwin:Tue Oct  6 00:01:00 2026' });
    if (lock.ok) lock.release();
  });
  it('protects a running same-Mac holder even during confirmed recovery', () => {
    const b = box(); const identitySource = mac(); const text = record(b.path, identitySource);
    const lock = lockFile(b.path, { identitySource, confirmUnverifiable: true });
    expect(lock.ok).toBe(false);
    if (!lock.ok) expect(lock.details).toContain('held by process 42');
    expect(readFileSync(b.path, 'utf8')).toBe(text);
  });
  it('automatically recovers a dead same-Mac holder', () => {
    const b = box(); const identitySource = mac({ dead: true }); record(b.path, identitySource);
    const lock = lockFile(b.path, { identitySource }); expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  });
  it('automatically recovers a reused macOS PID from ps start identity', () => {
    const b = box(); const identitySource = mac(); record(b.path, identitySource, { pidStart: 'darwin:older start' });
    const lock = lockFile(b.path, { identitySource }); expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  });
  it('retains a dead dispatcher while its macOS rail child is alive', () => {
    const b = box(); const identitySource = mac({ dead: true });
    record(b.path, identitySource, { railPid: 43, railPidStart: 'darwin:Tue Oct  6 00:01:00 2026' });
    expect(lockFile(b.path, { identitySource }).ok).toBe(false);
  });
  for (const patch of [{ hostname: 'another-mac' }, { platform: 'linux' }, { bootId: 'another-boot' }]) {
    it(`does not recover a foreign macOS record ${JSON.stringify(patch)}`, () => {
      const b = box(); const identitySource = mac({ dead: true }); const text = record(b.path, identitySource, patch);
      expect(lockFile(b.path, { identitySource }).ok).toBe(false); expect(readFileSync(b.path, 'utf8')).toBe(text);
    });
  }
  it('retains holders if macOS boot time cannot be read', () => {
    const b = box(); const identitySource = mac({ dead: true, bootReadable: false }); record(b.path, identitySource);
    expect(lockFile(b.path, { identitySource }).ok).toBe(false);
  });
  it('protects a PID shown alive when ps cannot be read', () => {
    const b = box(); const identitySource = mac({ readable: false }); record(b.path, identitySource);
    expect(lockFile(b.path, { identitySource, confirmUnverifiable: true }).ok).toBe(false);
  });
});
it('keeps other platforms unverifiable without readable process start identity', () => {
  const b = box(); const identitySource = createIdentitySource({ platform: 'freebsd', host: 'test-host', start: () => undefined });
  record(b.path, identitySource, { pid: 2147483646 });
  expect(lockFile(b.path, { identitySource }).ok).toBe(false);
});
it('recovers matching other-platform records only with readable start identity', () => {
  const b = box(); const identitySource = createIdentitySource({ platform: 'freebsd', host: 'test-host', start: () => 'new-start' });
  record(b.path, identitySource, { pidStart: 'old-start' });
  const lock = lockFile(b.path, { identitySource }); expect(lock.ok).toBe(true); if (lock.ok) lock.release();
});
it('normally releases despite an orphaned foreign takeover mutex', () => {
  const b = box(); const lock = lockFile(b.path); expect(lock.ok).toBe(true);
  mkdirSync(b.path + '.break'); writeFileSync(join(b.path + '.break', 'foreign.owner'), '{"platform":"foreign","pid":42}');
  if (lock.ok) lock.release();
  expect(existsSync(b.path)).toBe(false); expect(existsSync(b.path + '.break')).toBe(true);
  const successor = lockFile(b.path); expect(successor.ok).toBe(true); if (successor.ok) successor.release();
});
it('agent busy guidance stops at the owner recovery docs', () => {
  const b = box(); writeFileSync(b.path, '{'); const lock = lockFile(b.path); expect(lock.ok).toBe(false);
  const next = lockNext(lock, 'mac-op', 'solana', 'devnet');
  expect(next).toContain('Stop and ask the owner'); expect(next).toContain('budget/CLI.md#operation-lock-recovery');
  expect(next).not.toContain('superstables budget unlock'); expect(next).not.toContain('--confirm');
});
function unlock(b: ReturnType<typeof box>, terminal: boolean, answer = 'mac-op') {
  const preload = terminal ? ['--import', join(import.meta.dirname, '../helpers/budget-owner-terminal.mjs')] : [];
  const r = spawnSync(process.execPath, [...preload, join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'mac-op', '--confirm'], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', input: `${answer}\n` });
  const line = r.stdout.split('\n').find(l => l.startsWith('RESULT '));
  return { ...r, result: line ? JSON.parse(line.slice(7)) : null };
}
it('refuses noninteractive unlock even with --confirm and a piped op ID', () => {
  const b = box(); const text = '{"platform":"foreign","pid":42}'; writeFileSync(b.path, text);
  const r = unlock(b, false); expect(r.status, r.stderr).toBe(3); expect(r.result.reason).toBe('owner_terminal_required');
  expect(r.result.next).not.toContain('--confirm'); expect(readFileSync(b.path, 'utf8')).toBe(text);
});
it('refuses the wrong typed op ID without removing any lock', () => {
  const b = box(); writeFileSync(b.path, '{'); const r = unlock(b, true, 'other-op');
  expect(r.status, r.stderr).toBe(3); expect(r.result.reason).toBe('owner_confirmation_mismatch'); expect(existsSync(b.path)).toBe(true);
});
it('reports no lock after typed owner confirmation with an existing journal', () => {
  const b = box(); writeFileSync(join(b.dir, 'mac-op.json'), '{"state":"settled"}');
  const r = unlock(b, true); expect(r.status, r.stderr).toBe(0); expect(r.result.reason).toBe('no_lock');
  expect(r.stderr).toContain('no lock for operation mac-op'); expect(r.stderr).not.toContain('abandoned locks cleared');
});

it('refuses closed terminal input without removing any lock', () => {
  const b = box(); writeFileSync(b.path, '{');
  const r = spawnSync(process.execPath, ['--import', join(import.meta.dirname, '../helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'mac-op', '--confirm'], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', input: '' });
  expect(r.status, r.stderr).toBe(3); expect(r.stdout).toContain('owner_confirmation_mismatch'); expect(existsSync(b.path)).toBe(true);
});
