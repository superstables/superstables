import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const helper = join(import.meta.dirname, '../helpers/budget-namespace-probe.mjs');
const locks = await import(join(root, 'budget/op-lock.mjs'));
const children: { p: ChildProcess; pid: number }[] = [];
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-namespaces-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  const hostProc = join(home, 'host-proc'); mkdirSync(hostProc);
  return { home, dir, hostProc, path: join(dir, 'paid-op.json.lock') };
}
async function hold(b: ReturnType<typeof box>) {
  const p = spawn('bwrap', ['--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--ro-bind', '/proc', b.hostProc, '--proc', '/proc', process.execPath, helper], {
    env: { ...process.env, PROBE_ROOT: root, PROBE_HOME: b.home, PROBE_ACTION: 'hold', HOST_PROC: b.hostProc },
  });
  let error = ''; p.stderr.on('data', c => { error += c; });
  const ready = await new Promise<{ ok: boolean; pid: number }>((resolveReady, reject) => {
    p.stdout.once('data', c => resolveReady(JSON.parse(String(c)))); p.once('error', reject);
    p.once('exit', code => reject(new Error(`bwrap exited ${code}: ${error}`)));
  });
  children.push({ p, pid: ready.pid }); expect(ready.ok).toBe(true);
  return { p, pid: ready.pid };
}
function tryLock(b: ReturnType<typeof box>, skew = 0) {
  const r = spawnSync(process.execPath, [helper], { env: { ...process.env, PROBE_ROOT: root, PROBE_HOME: b.home, PROBE_ACTION: 'try', PROBE_SKEW: String(skew) }, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout).ok;
}
function unlock(b: ReturnType<typeof box>) {
  return spawnSync(process.execPath, ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', input: 'paid-op\n' });
}
async function waitFor(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('probe did not reach expected state'); await sleep(10); }
}
afterEach(async () => {
  for (const { p, pid } of children.splice(0)) {
    try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGKILL'); } catch {}
    if (p.exitCode === null) { const done = new Promise<void>(resolveDone => p.once('close', () => resolveDone())); p.kill('SIGKILL'); await done; }
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
describe.runIf(process.platform === 'linux')('real PID namespace ownership', () => {
  it('never takes a running foreign holder after a forward or backward clock jump', async () => {
    const b = box(); await hold(b);
    for (const skew of [0, 330000, 86400000, -86400000]) expect(tryLock(b, skew)).toBe(false);
  });
  it('never takes a paused foreign holder regardless of its old heartbeat', async () => {
    const b = box(); const holder = await hold(b); process.kill(holder.pid, 'SIGSTOP');
    await waitFor(() => readFileSync(`/proc/${holder.pid}/stat`, 'utf8').includes(') T '));
    const past = Date.now() - 86400000; utimesSync(b.path, past / 1000, past / 1000);
    expect(tryLock(b, 86400000)).toBe(false);
  });
  it('refreshes its inode despite a dead breaker in the host namespace', async () => {
    const b = box(); mkdirSync(b.path + '.break');
    // The host publishes a real generation, then dies. The foreign holder cannot verify that death.
    const host = spawnSync(process.execPath, ['-e', `const fs=require('fs'); const os=require('os'); fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid,namespace:fs.readlinkSync('/proc/self/ns/pid'),platform:process.platform,hostname:os.hostname(),bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}))`, join(b.path + '.break', '0a1b2c3d-0000-4000-8000-000000000000.owner')]);
    expect(host.status).toBe(0);
    const holder = await hold(b); const before = statSync(b.path).mtimeMs; await sleep(350);
    expect(statSync(b.path).mtimeMs).toBeGreaterThan(before);
    expect(tryLock(b, 86400000)).toBe(false);
    holder.p.stdin?.write('release\n');
    await waitFor(() => !existsSync(b.path));
    expect(tryLock(b)).toBe(true);
  });
  it('requires confirmed owner override for a foreign holder and preserves its successor on release', async () => {
    const b = box(); const old = await hold(b);
    writeFileSync(join(b.dir, 'paid-op.json'), '{"state":"settled"}');
    const r = unlock(b); expect(r.status, r.stderr).toBe(0); expect(r.stderr).toContain('overriding unverifiable lock');
    const successor = locks.lockFile(b.path); expect(successor.ok).toBe(true);
    const text = readFileSync(b.path, 'utf8');
    old.p.stdin?.write('release\n'); await sleep(200);
    expect(readFileSync(b.path, 'utf8')).toBe(text); expect(tryLock(b)).toBe(false);
    if (successor.ok) successor.release();
  });
  it('does not infer foreign death after the namespace holder exits', async () => {
    const b = box(); const holder = await hold(b); process.kill(holder.pid, 'SIGKILL'); await sleep(100);
    expect(tryLock(b, 86400000)).toBe(false); expect(unlock(b).status).toBe(0); expect(existsSync(b.path)).toBe(false);
  });
});
