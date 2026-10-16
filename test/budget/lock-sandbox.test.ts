import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIdentitySource } from '../../budget/lock-identity.mjs';
import { lockFile } from '../../budget/op-lock.mjs';
import { hostIdentity } from '../helpers/host-identity.js';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const helper = join(root, 'test/helpers/budget-blocked-identity.mjs');
const terminal = join(root, 'test/helpers/budget-owner-terminal.mjs');
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-sandbox-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'sandbox-op.buy.lock');
  return { home, dir, path };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function cli(b: ReturnType<typeof box>, action: string, error = 'EPERM', blocked = true, unverified = false) {
  const r = spawnSync(process.execPath, [
    ...(blocked ? ['--import', helper] : []), '--import', terminal,
    join(root, 'budget/cli.mjs'), action, '--rail', 'solana', '--op', 'sandbox-op', ...(action === 'unlock' ? ['--confirm', ...(unverified ? ['--unverified'] : [])] : []),
  ], { env: { ...process.env, SUPERSTABLES_HOME: b.home, BUDGET_TEST_IDENTITY_ERROR: error }, encoding: 'utf8', input: `${unverified ? 'sandbox-op unverified' : 'sandbox-op'}\n` });
  const line = r.stdout.split('\n').find(l => l.startsWith('RESULT '));
  return { ...r, result: line ? JSON.parse(line.slice(7)) : null };
}
for (const error of ['EPERM', 'ENOENT']) {
  it(`${error}: blocked identity refuses live-holder unlock and reconcile without changing the lock or journal`, () => {
    const b = box();
    const text = JSON.stringify(createIdentitySource().record());
    const journal = '{"op":"sandbox-op","state":"settled"}';
    writeFileSync(b.path, text); writeFileSync(join(b.dir, 'sandbox-op.json'), journal);
    for (const action of ['unlock', 'reconcile']) {
      const r = cli(b, action, error);
      expect(r.status, r.stderr).toBe(5);
      expect(r.result).toMatchObject({ op: 'sandbox-op', state: 'unknown', reason: 'op_in_progress' });
      expect(r.result.next).toContain('Its process may still be running');
      expect(r.result.next).toContain("outside the agent's sandbox");
      expect(r.stderr).not.toContain('overriding unverifiable lock');
      expect(readFileSync(b.path, 'utf8')).toBe(text);
      expect(readFileSync(join(b.dir, 'sandbox-op.json'), 'utf8')).toBe(journal);
    }
  });
  it(`${error}: blocked identity with ESRCH remains recoverable via owner unlock`, () => {
    const b = box();
    writeFileSync(b.path, JSON.stringify({ ...createIdentitySource().record(), pid: 2147483646, pidStart: 'old' }));
    const journal = '{"state":"unknown"}'; writeFileSync(join(b.dir, 'sandbox-op.json'), journal);
    expect(cli(b, 'unlock', error).status).toBe(5);
    const r = cli(b, 'unlock', error, true, true);
    expect(r.status, r.stderr).toBe(0); expect(r.result.reason).toBe('locks_cleared');
    expect(existsSync(b.path)).toBe(false); expect(readFileSync(join(b.dir, 'sandbox-op.json'), 'utf8')).toBe(journal);
  });
}

for (const platform of ['linux', 'darwin'] satisfies NodeJS.Platform[]) {
  for (const code of ['EPERM', 'ENOENT']) {
    for (const probeCode of ['success', 'EPERM', 'ESRCH', 'EACCES']) {
      it(`${platform}: ${code} identity reads with ${probeCode} PID probe protect all possibly live holders`, () => {
        const b = box();
        const denied = () => { throw Object.assign(new Error('sandbox denies identity'), { code, status: 1 }); };
        const identitySource = createIdentitySource({ platform, host: 'local', readFile: denied, readlink: denied, run: denied,
          probe: () => { if (probeCode !== 'success') throw Object.assign(new Error('probe'), { code: probeCode }); return true; } });
        const text = JSON.stringify({ platform, hostname: 'local', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', namespace: 'pid:[test]', pid: 42, pidStart: 'old-start' });
        writeFileSync(b.path, text);
        expect(lockFile(b.path, { identitySource }).ok).toBe(false);
        const recovered = lockFile(b.path, { identitySource, confirmUnverifiable: true });
        try {
          expect(recovered.ok).toBe(false);
          if (!recovered.ok) expect(readFileSync(b.path, 'utf8')).toBe(text);
        } finally { if (recovered.ok) recovered.release(); }
      });
    }
  }
}

it('blocked identity still protects a live rail child when the dispatcher PID is dead', () => {
  const b = box();
  const real = createIdentitySource();
  const identitySource = { ...real, record: () => ({ ...real.record(), bootId: null }), start: () => undefined };
  const text = JSON.stringify({ ...real.record(), pid: 2147483646, railPid: process.pid, railPidStart: 'hidden' });
  writeFileSync(b.path, text);
  expect(lockFile(b.path, { identitySource, confirmUnverifiable: true }).ok).toBe(false);
  expect(readFileSync(b.path, 'utf8')).toBe(text);
});

it('blocked identity protects a live breaker even during owner recovery', () => {
  const b = box();
  const real = createIdentitySource();
  const identitySource = { ...real, record: () => ({ ...real.record(), bootId: null }), start: () => undefined };
  writeFileSync(b.path, JSON.stringify({ ...real.record(), pid: 2147483646 }));
  mkdirSync(b.path + '.break');
  const ownerPath = join(b.path + '.break', 'live.owner');
  const text = JSON.stringify(real.record()); writeFileSync(ownerPath, text);
  const result = lockFile(b.path, { identitySource, confirmUnverifiable: true });
  expect(result.ok).toBe(false); expect(readFileSync(ownerPath, 'utf8')).toBe(text);
});

for (const code of ['EPERM', 'ENOENT']) {
  it(`${code}: approval and core readers retain live PIDs and groups when identity is hidden`, async () => {
    const b = box();
    const child = spawn(process.execPath, ['--import', helper, '--import', 'tsx', '--input-type=module', '-e', `
      const { sameProcess, groupAlive } = await import(${JSON.stringify(join(root, 'budget/procs.mjs'))});
      const { alive, processesAlive } = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});
      const { processRunning, withFileLock } = await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});
      const { writeFileSync, readFileSync } = await import('node:fs');
      const pid = process.pid, dead = 2147483646, start = 'read-before-sandbox';
      writeFileSync(${JSON.stringify(b.path)}, JSON.stringify({ pid, pidStart: start, owner: 'original' }));
      let wrote = false, busy = false;
      try { await withFileLock(${JSON.stringify(b.path)}, () => { wrote = true; }, 10); } catch { busy = true; }
      console.log(JSON.stringify({
        live: [sameProcess(pid, start), alive(pid, start), groupAlive(pid, start), processesAlive({ pid, pidStart: start }), processRunning({ pid, start })],
        dead: [sameProcess(dead, start), alive(dead, start), groupAlive(dead, start), processRunning({ pid: dead, start })],
        wrote, busy, owner: JSON.parse(readFileSync(${JSON.stringify(b.path)}, 'utf8')).owner,
      }));
    `], { cwd: root, env: { ...process.env, SUPERSTABLES_HOME: b.home, BUDGET_TEST_IDENTITY_ERROR: code }, detached: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ live: [true, true, true, true, true], dead: [true, true, true, true], wrote: false, busy: true, owner: 'original' });
  });
}

it('approval readers treat EPERM and unknown PID-probe failures as possibly alive', () => {
  const b = box();
  const r = spawnSync(process.execPath, ['--import', helper, '--input-type=module', '-e', `
    const { pidAlive, sameProcess, groupAlive } = await import(${JSON.stringify(join(root, 'budget/procs.mjs'))});
    const { alive, processesAlive } = await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});
    const results = [];
    for (const code of ['EPERM', 'EACCES']) {
      process.kill = () => { throw Object.assign(new Error('probe denied'), { code }); };
      results.push([pidAlive(42), sameProcess(42, 'start'), groupAlive(42, 'start'), alive(42, 'start'), processesAlive({ pid: 42, pidStart: 'start' })]);
    }
    console.log(JSON.stringify(results));
  `], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual([[true, true, true, true, true], [true, true, true, true, true]]);
});

it('an owner can recover a reused PID outside the sandbox after identity becomes readable', (context) => {
  // The host is asked on its own, not through the client's identity code: only a host that gives nothing to read (a real
  // sandbox) skips this test. A host that does give it must show up in the client's record, or the test fails.
  const host = hostIdentity();
  if (!host.bootId || !host.startTime || (process.platform === 'linux' && !host.namespace)) context.skip('outside-sandbox recovery requires a host with readable identity; injected identity controls still run');
  const record = createIdentitySource().record();
  expect(record.bootId).toBe(host.bootId);
  if (process.platform === 'linux') {
    expect(record.namespace).toBe(host.namespace);
    expect(record.pidStart).toBe(`linux:${host.bootId}:${host.startTime}`);
  } else expect(record.pidStart).toBeTruthy();
  const b = box();
  writeFileSync(b.path, JSON.stringify({ ...record, pidStart: 'linux:old-process', ...(typeof record.pidStartUtc === 'number' ? { pidStartUtc: record.pidStartUtc + 1 } : {}) }));
  const blocked = cli(b, 'unlock'); expect(blocked.status).toBe(5); expect(blocked.result.next).toContain("outside the agent's sandbox");
  const outside = cli(b, 'unlock', 'EPERM', false);
  expect(outside.status, outside.stderr).toBe(0); expect(outside.result.reason).toBe('locks_cleared'); expect(existsSync(b.path)).toBe(false);
});

for (const mac of [false, true]) {
  const preloads = [...(mac ? ['--import', join(root, 'test/helpers/budget-macos-identity.mjs')] : []), '--import', helper];
  it(`${mac ? 'macOS' : 'Linux'}: normal release after a rail child exits works with identity blocked`, () => {
    const b = box();
    const r = spawnSync(process.execPath, [...preloads, '--input-type=module', '-e', `
      const { spawn } = await import('node:child_process');
      const { lockFile } = await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});
      const lock = lockFile(${JSON.stringify(b.path)});
      const child = spawn('sleep', ['0.1']); lock.holdAlso(child);
      await new Promise(resolve => child.once('exit', resolve)); lock.release();
    `], { env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
    expect(r.status, r.stderr).toBe(0); expect(existsSync(b.path)).toBe(false);
    const next = lockFile(b.path); expect(next.ok).toBe(true); if (next.ok) next.release();
  });
  for (const legacy of [false, true]) {
    it(`${mac ? 'macOS' : 'Linux'}: requires explicit owner recovery after a ${legacy ? '0.3.0' : 'blocked-identity'} write without proven host and boot`, async () => {
      const b = box();
      const writer = spawnSync(process.execPath, [...preloads, '--input-type=module', '-e', `
        const { lockFile } = await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});
        const lock = lockFile(${JSON.stringify(b.path)}); if (!lock.ok) throw new Error('not acquired');
        process.kill(process.pid, 'SIGKILL');
      `], { encoding: 'utf8', timeout: 10000 });
      expect(writer.signal).toBe('SIGKILL');
      const record = JSON.parse(readFileSync(b.path, 'utf8'));
      expect(record.hostname).toBeTypeOf('string'); expect(record.writtenAt).toBeTypeOf('number');
      // ps and Linux btime have one-second resolution. Keep the proof strictly after the recorded write.
      await new Promise(resolve => setTimeout(resolve, 1200));
      const unrelated = spawn('sleep', ['30']);
      try {
        record.pid = unrelated.pid;
        if (legacy) for (const field of ['platform', 'hostname', 'bootId', 'namespace', 'writtenAt', 'hostPid']) delete record[field];
        writeFileSync(b.path, JSON.stringify(record));
        const args = ['--import', terminal, join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'sandbox-op', '--confirm'];
        const env = { ...process.env, SUPERSTABLES_HOME: b.home };
        const inside = spawnSync(process.execPath, [...preloads, ...args], { env, encoding: 'utf8', input: 'sandbox-op\n' });
        expect(inside.status, inside.stderr).toBe(5);
        const outsideEnv = { ...env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '').replace(/--import(?:=|\s+)\S*budget-blocked-identity\.mjs/g, '').replace(/--import(?:=|\s+)\S*budget-macos-identity\.mjs/g, '') };
        const outside = spawnSync(process.execPath, [...(mac ? ['--import', join(root, 'test/helpers/budget-macos-identity.mjs')] : []), ...args], { env: outsideEnv, encoding: 'utf8', input: 'sandbox-op\n' });
        expect(outside.status, outside.stderr + outside.stdout).toBe(5);
        expect(existsSync(b.path)).toBe(true);
        const owner = spawnSync(process.execPath, [...(mac ? ['--import', join(root, 'test/helpers/budget-macos-identity.mjs')] : []), ...args, '--unverified'], { env: outsideEnv, encoding: 'utf8', input: 'sandbox-op unverified\n' });
        expect(owner.status, owner.stderr + owner.stdout).toBe(0); expect(existsSync(b.path)).toBe(false);
        expect(() => process.kill(unrelated.pid ?? 0, 0)).not.toThrow();
      } finally { const done = new Promise(resolve => unrelated.once('exit', resolve)); unrelated.kill('SIGKILL'); await done; }
    });
  }
}
