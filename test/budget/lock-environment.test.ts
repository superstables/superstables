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
const psReadable = typeof procs.processStart(process.pid, 'darwin') === 'string';
if (!psReadable && process.env.BUDGET_TEST_SANDBOX !== '1') throw new Error('ps start identity is unavailable outside the sandbox simulation; install procps or check ps permissions');
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
    if (command === 'ioreg') return '"IOPlatformUUID" = "11111111-2222-3333-4444-555555555555"';
    expect(command).toBe('sysctl'); expect(args).toEqual(['-n', 'kern.bootsessionuuid']);
    return ' B0AAAEAB-5578-4A8D-BB24-2FA546301F7A\n';
  }, start: () => 'darwin:utc:1791244860' }).record();
  expect(identity.bootId).toBe('b0aaaeab-5578-4a8d-bb24-2fa546301f7a');
});
for (const platform of ['linux', 'darwin']) {
  it(`protects a live ${platform} holder after hostname changes when its boot UUID matches`, () => {
    const b = box();
    const local = createIdentitySource().record();
    const record = { ...local, platform, hostname: 'machine.lan', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', pidStart: platform === 'darwin' ? 'darwin:utc:1791244860' : local.pidStart, pidStartUtc: platform === 'darwin' ? 1791244860 : null, namespace: platform === 'linux' ? 'pid:[test]' : null };
    const identitySource = { pids: () => [process.pid], record: () => ({ ...record, hostname: 'machine.local' }), start: () => record.pidStart, probe: () => true };
    writeFileSync(b.path, JSON.stringify(record));
    expect(lockFile(b.path, { identitySource, confirmUnverifiable: true }).ok).toBe(false);
    expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
  });
  it(`recovers a dead ${platform} holder after a hostname change on the same boot`, () => {
    const b = box();
    const record = { ...createIdentitySource().record(), platform, hostname: 'machine.lan', bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', pid: 42, pidStart: null, pidStartUtc: null, namespace: platform === 'linux' ? 'pid:[test]' : null };
    const identitySource = { pids: () => [process.pid], record: () => ({ ...record, hostname: 'machine.local', pid: process.pid }), start: () => null, probe: (pid: number) => {
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
  const identitySource = { pids: () => [process.pid], record: () => record, start: () => 'darwin:utc:1791244860', probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } };
  expect(lockFile(b.path, { identitySource }).ok).toBe(false);
  expect(readFileSync(b.path, 'utf8')).toBe(JSON.stringify(record));
});
it('rechecks the lock after the override warning so a normally released holder and its successor survive', () => {
  const b = box();
  const system = createIdentitySource();
  const real = { ...system, record: () => ({ ...system.record(), bootId: 'b0aaaeab-5578-4a8d-bb24-2fa546301f7a', namespace: 'pid:[test]' }) };
  const old = lockFile(b.path, { identitySource: real }); expect(old.ok).toBe(true);
  const foreign = { ...real, record: () => ({ ...real.record(), hostId: 'another-host' }) };
  let successor: ReturnType<typeof lockFile> | undefined;
  const result = lockFile(b.path, { identitySource: foreign, confirmUnverifiable: true, confirmPossiblyAlive: true, onOverride: () => {
    if (old.ok) old.release();
    successor = lockFile(b.path, { identitySource: real }); expect(successor.ok).toBe(true);
  } });
  try {
    expect(result.ok).toBe(false);
    expect(successor?.ok).toBe(true);
    expect(JSON.parse(readFileSync(b.path, 'utf8')).bootId).toBe(real.record().bootId);
    expect(lockFile(b.path, { identitySource: real }).ok).toBe(false);
  } finally { if (result.ok) result.release(); if (successor?.ok) successor.release(); if (old.ok) old.release(); }
});
for (const [holderTZ, contenderTZ] of [['UTC', 'America/Los_Angeles'], ['Asia/Tokyo', 'UTC'], ['America/Los_Angeles', 'Asia/Tokyo']]) {
  it(`protects the real-ps macOS holder in ${holderTZ} from takeover and unlock in ${contenderTZ}`, async (context) => {
    if (!psReadable && process.env.BUDGET_TEST_SANDBOX === '1') context.skip('mixed-time-zone identity requires ps; blocked-identity safety still runs in lock-sandbox.test.ts');
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
    const recovered = spawnSync(process.execPath, ['--import', preload, helper, root, b.path, 'try'], { env: { ...process.env, TZ: contenderTZ }, encoding: 'utf8' });
    expect(recovered.status, recovered.stderr).toBe(0); expect(JSON.parse(recovered.stdout).ok).toBe(true);
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
it('prints the owner override notice and keeps refusal output free of recovery instructions', () => {
  const b = box(); writeFileSync(b.path, '{');
  const args = [join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'tz-op', '--confirm', '--unverified'];
  const env = { ...process.env, SUPERSTABLES_HOME: b.home };
  const refused = spawnSync(process.execPath, args, { env, encoding: 'utf8', input: 'tz-op\n' });
  expect(refused.status).toBe(3); expect(refused.stdout).toContain("outside the agent's sandbox");
  const confirmed = spawnSync(process.execPath, ['--import', join(import.meta.dirname, '../helpers/budget-owner-terminal.mjs'), ...args], { env, encoding: 'utf8', input: 'tz-op unverified\n' });
  expect(confirmed.status, confirmed.stderr).toBe(0);
  const warning = confirmed.stderr.split('\n').find(line => line.includes('Clearing the lock for operation'));
  expect(confirmed.stderr).toContain("unlock paused before unlinking can remove a new holder's lock");
  expect(warning).not.toContain('stop and ask the owner'); expect(warning).not.toContain('see ');
});

it.each(['record', 'inode'])('preserves a replacement %s published during the final process inspection', (change) => {
  const b = box(); writeFileSync(b.path, '{"pid":42,"platform":"foreign"}');
  const real = createIdentitySource();
  let warned = false;
  let replacement = '';
  const identitySource = { ...real, record: () => {
    if (warned && !replacement) {
      replacement = change === 'inode' ? readFileSync(b.path, 'utf8') : JSON.stringify({ ...real.record(), token: 'successor' });
      rmSync(b.path); writeFileSync(b.path, replacement);
    }
    return real.record();
  } };
  const result = lockFile(b.path, { identitySource, confirmUnverifiable: true, confirmPossiblyAlive: true, onOverride: () => { warned = true; } });
  try {
    expect(result.ok).toBe(false);
    expect(readFileSync(b.path, 'utf8')).toBe(replacement);
  } finally { if (result.ok) result.release(); }
});

it('approval and group readers prefer numeric UTC seconds over the legacy start field', async (context) => {
  if (!psReadable && process.env.BUDGET_TEST_SANDBOX === '1') context.skip('numeric UTC start identity requires ps; blocked-identity readers still run in lock-sandbox.test.ts');
  const r = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', `
    import { processStartFields, sameProcess, groupAlive } from ${JSON.stringify(join(root, 'budget/procs.mjs'))};
    import { alive, groupAlive as approvalGroup, processesAlive } from ${JSON.stringify(join(root, 'budget/approvals.mjs'))};
    const { createIdentitySource } = await import(${JSON.stringify(join(root, 'budget/lock-identity.mjs'))});
    const location = createIdentitySource().record();
    process.env.TZ = 'Asia/Kathmandu';
    const starts = processStartFields(process.pid);
    process.env.TZ = 'America/Los_Angeles';
    const wrong = 'darwin:Tue Oct  6 00:01:00 2000';
    const pid = process.pid, utc = starts.pidStartUtc;
    console.log(JSON.stringify([
      typeof utc,
      sameProcess(pid, wrong, utc, location), alive(pid, wrong, utc, location),
      groupAlive(pid, wrong, utc, location), approvalGroup(pid, wrong, utc, location),
      sameProcess(pid, starts.pidStart, utc + 1, location), alive(pid, starts.pidStart, utc + 1, location),
      groupAlive(pid, starts.pidStart, utc + 1, location), approvalGroup(pid, starts.pidStart, utc + 1, location),
      processesAlive({ ...location, pid: null, railPgid: pid, railPgidStart: wrong, railPgidStartUtc: utc }),
      processesAlive({ ...location, pid: null, railPgid: pid, railPgidStart: starts.pidStart, railPgidStartUtc: utc + 1 }),
    ]));
  `], { env: { ...process.env, SUPERSTABLES_HOME: box().home }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(r, 'exit');
  try {
    const [data] = await once(r.stdout, 'data');
    expect(JSON.parse(String(data))).toEqual(['number', true, true, true, true, false, false, false, false, true, false]);
    const [status] = await exited; expect(status).toBe(0);
  } finally { if (r.exitCode === null) { r.kill('SIGKILL'); await exited; } }
});
