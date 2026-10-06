import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const procs = await import(join(root, 'budget/procs.mjs'));
const { createIdentitySource } = await import(join(root, 'budget/lock-identity.mjs'));
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const helper = join(import.meta.dirname, '../helpers/budget-identity-worker.mjs');
const preload = join(root, 'test/helpers/budget-macos-identity.mjs');
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-environment-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  return { home, path: join(dir, 'tz-op.json.lock') };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('parses C-locale ps start dates in UTC, including padded days and leap years', () => {
  expect(procs.parseDarwinStart(' Tue Oct  6 00:01:00 2026\n')).toBe('darwin:utc:1791244860');
  expect(procs.parseDarwinStart('Thu Feb 29 23:59:59 2024')).toBe('darwin:utc:1709251199');
  for (const text of ['Thu Feb 29 23:59:59 2023', 'Tue Oct 32 00:01:00 2026', 'Tue Oct  6 24:01:00 2026', 'Tue Oct  6 00:01:00 2026 junk', 'garbled']) {
    expect(procs.parseDarwinStart(text)).toBeUndefined();
  }
});
it('pins both LC_ALL and TZ when reading ps', () => {
  const start = procs.processStart(42, 'darwin', (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
    expect(options.env.LC_ALL).toBe('C'); expect(options.env.TZ).toBe('UTC0');
    return 'Tue Oct  6 00:01:00 2026';
  });
  expect(start).toBe('darwin:utc:1791244860');
});
it('keeps unzoned legacy macOS starts incomparable, including when the strings happen to match', () => {
  const legacy = 'darwin:Tue Oct  6 00:01:00 2026';
  expect(procs.compareProcessStarts(legacy, 'darwin:utc:1791244860')).toBeUndefined();
  expect(procs.compareProcessStarts(legacy, legacy)).toBeUndefined();
  expect(procs.compareProcessStarts('darwin:utc:1791244860', 'darwin:utc:1791244859')).toBe(false);
});
it('uses the macOS boot-session UUID without reading clock-based boottime', () => {
  const identity = createIdentitySource({ platform: 'darwin', run: (command: string, args: string[]) => {
    expect(command).toBe('sysctl'); expect(args).toEqual(['-n', 'kern.bootsessionuuid']);
    return ' B0AAAEAB-5578-4A8D-BB24-2FA546301F7A\n';
  }, start: () => 'darwin:utc:1791244860' }).record();
  expect(identity.bootId).toBe('b0aaaeab-5578-4a8d-bb24-2fa546301f7a');
});
for (const platform of ['linux', 'darwin']) {
  it(`protects a live ${platform} holder after hostname changes when its boot UUID matches`, () => {
    const b = box();
    const local = createIdentitySource().record();
    const record = { ...local, platform, hostname: 'machine.lan', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', pidStart: platform === 'darwin' ? 'darwin:utc:1791244860' : local.pidStart };
    const identitySource = { record: () => ({ ...record, hostname: 'machine.local' }), start: () => record.pidStart, probe: () => true };
    writeFileSync(b.path, JSON.stringify(record));
    expect(lockFile(b.path, { identitySource, confirmUnverifiable: true }).ok).toBe(false);
    expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
  });
  it(`recovers a dead ${platform} holder after a hostname change on the same boot`, () => {
    const b = box();
    const record = { ...createIdentitySource().record(), platform, hostname: 'machine.lan', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', pid: 42, pidStart: null };
    const identitySource = { record: () => ({ ...record, hostname: 'machine.local', pid: process.pid }), start: () => null, probe: (pid: number) => {
      if (pid === 42) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    } };
    writeFileSync(b.path, JSON.stringify(record));
    const lock = lockFile(b.path, { identitySource });
    try { expect(lock.ok).toBe(true); } finally { if (lock.ok) lock.release(); }
  });
}
it('retains old clock-based macOS boot records and malformed boot-session UUIDs as unverifiable', () => {
  const b = box();
  const record = { platform: 'darwin', hostname: 'mac', bootId: 'darwin:1791234000:0', namespace: null, pid: 42, pidStart: 'darwin:Tue Oct  6 00:01:00 2026' };
  writeFileSync(b.path, JSON.stringify(record));
  for (const boot of ['B0AAAEAB-5578-4A8D-BB24-2FA546301F7A', 'not-a-uuid']) {
    const identitySource = createIdentitySource({ platform: 'darwin', host: 'mac', run: () => boot, start: () => null, probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } });
    expect(lockFile(b.path, { identitySource }).ok).toBe(false); expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
  }
});
it('never automatically clears a legacy macOS start mismatch even with a matching boot UUID', () => {
  const b = box();
  const record = { platform: 'darwin', hostname: 'mac', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', namespace: null, pid: 42, pidStart: 'darwin:Mon Oct  5 17:01:00 2026' };
  writeFileSync(b.path, JSON.stringify(record));
  const identitySource = { record: () => record, start: () => 'darwin:utc:1791244860', probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } };
  expect(lockFile(b.path, { identitySource }).ok).toBe(false);
  expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
});
it('rechecks the lock after the override warning so a normally released holder and its successor survive', () => {
  const b = box();
  const old = lockFile(b.path); expect(old.ok).toBe(true);
  const real = createIdentitySource();
  const foreign = { ...real, record: () => ({ ...real.record(), bootId: 'another-boot' }) };
  let successor: ReturnType<typeof lockFile> | undefined;
  const result = lockFile(b.path, { identitySource: foreign, confirmUnverifiable: true, onOverride: () => {
    if (old.ok) old.release();
    successor = lockFile(b.path); expect(successor.ok).toBe(true);
  } });
  try {
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(b.path, 'utf8')).bootId).toBe(real.record().bootId);
    expect(lockFile(b.path).ok).toBe(false);
  } finally { if (result.ok) result.release(); if (successor?.ok) successor.release(); if (old.ok) old.release(); }
});
for (const [holderTZ, contenderTZ] of [['UTC', 'America/Los_Angeles'], ['Asia/Tokyo', 'UTC'], ['America/Los_Angeles', 'Asia/Tokyo']]) {
  it(`protects the real-ps macOS holder in ${holderTZ} from takeover and unlock in ${contenderTZ}`, async () => {
    const b = box();
    const holder = spawn(process.execPath, ['--import', preload, helper, root, b.path, 'hold'], { env: { ...process.env, TZ: holderTZ }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [data] = await once(holder.stdout, 'data'); expect(JSON.parse(String(data)).ok).toBe(true);
      const original = readFileSync(b.path, 'utf8');
      const env = { ...process.env, TZ: contenderTZ, SUPERSTABLES_HOME: b.home };
      const contender = spawnSync(process.execPath, ['--import', preload, helper, root, b.path, 'try'], { env, encoding: 'utf8' });
      expect(contender.status, contender.stderr).toBe(0); expect(JSON.parse(contender.stdout).ok).toBe(false);
      const unlock = spawnSync(process.execPath, ['--import', preload, '--import', join(import.meta.dirname, '../helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'tz-op', '--confirm'], { env, encoding: 'utf8', input: 'tz-op\n' });
      expect(unlock.status, unlock.stderr).toBe(5); expect(unlock.stdout).toContain('op_in_progress');
      expect(unlock.stderr).not.toContain('overriding unverifiable lock'); expect(readFileSync(b.path, 'utf8')).toBe(original);
    } finally { const exit = once(holder, 'exit'); holder.kill('SIGKILL'); await exit; }
  });
}
it('approval and group readers preserve live legacy starts and stay stable across a timezone change', async () => {
  const r = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', `
    import { processStart, sameProcess, groupAlive } from ${JSON.stringify(join(root, 'budget/procs.mjs'))};
    import { alive, groupAlive as approvalGroup } from ${JSON.stringify(join(root, 'budget/approvals.mjs'))};
    process.env.TZ = 'Asia/Tokyo'; const start = processStart(process.pid);
    process.env.TZ = 'America/Los_Angeles';
    const legacy = 'darwin:Tue Oct  6 00:01:00 2026';
    console.log(JSON.stringify([sameProcess(process.pid, start), alive(process.pid, start), sameProcess(process.pid, legacy), alive(process.pid, legacy), groupAlive(process.pid, legacy), approvalGroup(process.pid, legacy)]));
  `], { env: { ...process.env, SUPERSTABLES_HOME: box().home }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(r, 'exit');
  try {
    const [data] = await once(r.stdout, 'data');
    expect(JSON.parse(String(data))).toEqual([true, true, true, true, true, true]);
    const [status] = await exited; expect(status).toBe(0);
  } finally { if (r.exitCode === null) { r.kill('SIGKILL'); await exited; } }
});
it('prints owner override details without agent instructions and points refusal guidance to installed help', () => {
  const b = box(); writeFileSync(b.path, '{');
  const args = [join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'tz-op', '--confirm'];
  const env = { ...process.env, SUPERSTABLES_HOME: b.home };
  const refused = spawnSync(process.execPath, args, { env, encoding: 'utf8', input: 'tz-op\n' });
  expect(refused.status).toBe(3); expect(refused.stdout).toContain('the owner-only unlock --help section of the installed CLI');
  const confirmed = spawnSync(process.execPath, ['--import', join(import.meta.dirname, '../helpers/budget-owner-terminal.mjs'), ...args], { env, encoding: 'utf8', input: 'tz-op\n' });
  expect(confirmed.status, confirmed.stderr).toBe(0);
  const warning = confirmed.stderr.split('\n').find(line => line.includes('overriding unverifiable lock'));
  expect(warning).toContain("unlock paused before unlinking can remove a new holder's lock");
  expect(warning).not.toContain('stop and ask the owner'); expect(warning).not.toContain('see ');
});
