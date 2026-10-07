import { afterEach, expect, it } from 'vitest';
import { stopHolder } from '../helpers/budget-holder-cleanup.mjs';
import { once } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = resolve(import.meta.dirname, '../..');
const root = resolve(process.env.BUDGET_RACE_ROOT ?? project);
const { createIdentitySource, inspectProcess, inspectLegacyCap } = await import(join(root, 'src/core/process-identity.mjs'));
const { withFileLock } = await import(join(root, 'src/core/lock.ts'));
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const homes: string[] = [];
const children = new Set<ChildProcess>();
const innerPids = new Map<ChildProcess, number>();
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-owner-location-')); homes.push(home);
  const dir = join(home, 'budget/ops/solana-devnet'); mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, 'records')); mkdirSync(join(home, 'budget/approvals'));
  return { home, dir, op: join(dir, 'paid-op.buy.lock'), cap: join(home, 'records/cap.lock') };
}
afterEach(async () => {
  for (const child of children) await stopHolder(child, innerPids.get(child) ?? child.pid);
  children.clear(); innerPids.clear();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const boot = '11111111-2222-3333-4444-555555555555';
const oldBoot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const machine = '0123456789abcdef0123456789abcdef';
const initial = 'pid:[4026531836]';
const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
function source({ hidepid = '0', machineId = machine, nested = false, entries = ['77'], candidatePid = 77, candidateNested = false, elapsed = 100_000, start = `linux:${boot}:200` }: { hidepid?: string; machineId?: string; nested?: boolean; entries?: string[]; candidatePid?: number; candidateNested?: boolean; elapsed?: number; start?: string | null } = {}) {
  return createIdentitySource({ platform: 'linux', host: 'local', bootElapsed: () => elapsed,
    readFile: (path: string) => {
      if (path === '/etc/machine-id' || path === '/var/lib/dbus/machine-id') return machineId;
      if (path === '/proc/sys/kernel/random/boot_id') return boot;
      if (path === '/proc/self/mountinfo') return `1 0 0:1 / /proc rw - proc proc rw,hidepid=${hidepid}\n`;
      if (path === '/proc/self/status') return `NSpid:\t${process.pid}\n`;
      if (path === '/proc/77/status') return `NSpid:\t77${candidateNested ? '\t' + candidatePid : ''}\n`;
      return denied();
    }, readlink: () => nested ? 'pid:[nested]' : initial, readdir: () => entries, start: () => start, probe: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  });
}
it('a cloned machine ID and different boot cannot expire a newly written live holder', () => {
  const src = source(), owner = { ...src.record(), pid: 77, bootId: oldBoot };
  expect(inspectProcess(owner, src)).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('different boots remain possibly alive regardless of record age, heartbeat or hostname', () => {
  const src = source(), old = Date.now() - 40 * 86400_000;
  const owner = { ...src.record(), pid: 77, bootId: oldBoot, writtenAt: old };
  for (const record of [owner, { ...owner, heartbeatAt: old }, { ...owner, hostname: 'clone' }]) {
    expect(inspectProcess(record, src)).toMatchObject({ state: 'alive', possiblyAlive: true });
  }
});
it('equal boot IDs allow dead-holder recovery across UTS hostnames', () => {
  const src = source();
  expect(inspectProcess({ ...src.record(), pid: 77, hostname: 'container-1' }, src)).toEqual({ state: 'dead' });
});
it('matching legacy Linux start with complete proc view is verified alive', () => {
  const owner = { pid: 77, pidStart: `linux:${boot}:200`, owner: 'legacy' };
  expect(inspectLegacyCap(owner, source())).toEqual({ state: 'alive' });
});
it('matching readable boot IDs and PID namespaces permit recovery without a machine ID under the shared-folder assumption', () => {
  const src = source({ machineId: '' });
  expect(inspectProcess({ ...src.record(), pid: 77 }, src)).toEqual({ state: 'dead' });
});
it('legacy cap upgrade proof requires an unrestricted initial namespace and no matching nested PID', () => {
  const owner = { pid: 2, pidStart: `linux:${boot}:100`, owner: 'old-owner' };
  expect(inspectLegacyCap(owner, source())).toEqual({ state: 'dead' });
  for (const src of [source({ nested: true }), source({ hidepid: '2' }), source({ candidateNested: true, candidatePid: 2 })]) {
    expect(inspectLegacyCap(owner, src)).toMatchObject({ state: 'alive', possiblyAlive: true });
  }
  expect(inspectLegacyCap({ ...owner, platform: 'linux', bootId: null }, source())).toMatchObject({ state: 'alive', possiblyAlive: true });
});
it('legacy cap records from another boot cannot locate a holder even with a readable local PID', () => {
  for (const start of [`linux:${boot}:200`, null]) {
    for (const pidStart of [`linux:${oldBoot}:200`, null]) {
      expect(inspectLegacyCap({ pid: 77, pidStart, owner: 'legacy' }, source({ start }))).toMatchObject({ state: 'alive', possiblyAlive: true });
    }
  }
});
for (const hidepid of ['1', '2', 'invisible', 'ptraceable']) {
  it(`hidden-process injection with hidepid=${hidepid} never proves an unlisted nested holder dead`, () => {
    const src = source({ hidepid, entries: [] });
    expect(inspectProcess({ ...src.record(), namespace: 'pid:[child]', pid: 2 }, src)).toMatchObject({ state: 'alive', possiblyAlive: true });
  });
}
function node(home: string, code: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), ...args, '--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8', timeout: 20_000 });
}
async function holder(home: string, code: string, binds: string[] = []) {
  const hostProc = join(home, 'host-proc'); mkdirSync(hostProc, { recursive: true });
  const pidFile = join(home, 'holder.pid');
  const wrapped = `const hostFs=await import('node:fs');hostFs.writeFileSync(${JSON.stringify(pidFile)},hostFs.readFileSync(${JSON.stringify(join(hostProc, 'self/status'))},'utf8').split(String.fromCharCode(10)).find(line=>line.startsWith('Pid:')).slice(4).trim());${code}`;
  const child = spawn('bwrap', ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-user', '--dev-bind', '/', '/', '--ro-bind', '/proc', hostProc, '--proc', '/proc', ...binds, process.execPath, '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', wrapped], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let error = ''; child.stderr?.on('data', chunk => { error += chunk; });
  if (!child.stdout) throw new Error('no stdout');
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(error); })]);
  } finally { if (existsSync(pidFile)) innerPids.set(child, Number(readFileSync(pidFile, 'utf8'))); }
  return child;
}
function clonedBoot(home: string) {
  const path = join(home, 'boot'); writeFileSync(path, oldBoot);
  return ['--ro-bind', path, '/proc/sys/kernel/random/boot_id'];
}
it.runIf(process.platform === 'linux')('automatic operation acquisition preserves a live cloned-kernel holder', async () => {
  const b = box();
  const child = await holder(b.home, `const {lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))}); const l=lockFile(${JSON.stringify(b.op)}); if(!l.ok)process.exit(1); console.log('ready'); setInterval(()=>{},1000);`, clonedBoot(b.home));
  const before = readFileSync(b.op, 'utf8');
  const next = lockFile(b.op); try { expect(next.ok).toBe(false); } finally { if (next.ok) next.release(); }
  expect(readFileSync(b.op, 'utf8')).toBe(before); expect(child.exitCode).toBeNull();
});
it.runIf(process.platform === 'linux')('core cap waits for a live cloned-kernel holder', async () => {
  const b = box();
  await holder(b.home, `const {withFileLock}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))}); setInterval(()=>{},1000);await withFileLock(${JSON.stringify(b.cap)},()=>{console.log('ready');return new Promise(()=>{});});`, clonedBoot(b.home));
  const before = readFileSync(b.cap, 'utf8');
  await expect(withFileLock(b.cap, () => 'acquired', 100)).rejects.toThrow('held by process');
  expect(readFileSync(b.cap, 'utf8')).toBe(before);
});
it.runIf(process.platform === 'linux')('wait preserves a live cloned-kernel approval past its deadline', async () => {
  const b = box();
  const idFile = join(b.home, 'id');
  await holder(b.home, `const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const id=a.newApprovalId();a.startForeground({id,command:'grant',rail:'solana',chain:'devnet'});a.updateApproval(id,()=>({deadline:Date.now()-1000}));(await import('node:fs')).writeFileSync(${JSON.stringify(idFile)},id); console.log('ready');setInterval(()=>{},1000);`, clonedBoot(b.home));
  const id = readFileSync(idFile, 'utf8'), path = join(b.home, `budget/approvals/${id}.json`), before = readFileSync(path, 'utf8');
  const result = node(b.home, `const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const w=await a.waitFor(${JSON.stringify(id)},50);console.log(JSON.stringify({final:w.final,orphaned:w.orphaned}));`);
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ final: false, orphaned: false });
  expect(readFileSync(path, 'utf8')).toBe(before);
});
it.runIf(process.platform === 'linux')('recovers a killed 0.3.0/0.3.1-format cap holder after upgrade', async () => {
  const b = box();
  const child = spawn('sleep', ['60']); children.add(child);
  const identity = createIdentitySource();
  if (!child.pid) throw new Error('no child pid');
  const legacy = JSON.stringify({ pid: child.pid, pidStart: identity.start(child.pid), owner: 'legacy' });
  writeFileSync(b.cap, legacy); writeFileSync(b.cap + '.break', legacy);
  child.kill('SIGKILL'); await once(child, 'exit'); children.delete(child);
  expect(await withFileLock(b.cap, () => 'recovered', 5000)).toBe('recovered');
  writeFileSync(b.cap, legacy); writeFileSync(b.cap + '.break', legacy);
  expect(unlock(b.home, ['--cap'], { unverified: false, answer: 'payment-lock\n' }).status).toBe(0);
});
it.runIf(process.platform === 'linux')('killed holders recover in the same kernel and namespace without machine-id', () => {
  const b = box(), empty = join(b.home, 'empty'); writeFileSync(empty, '');
  const script = `import {spawn} from 'node:child_process';import{once}from'node:events'; const child=spawn(process.execPath,['--import',${JSON.stringify(join(root, 'node_modules/tsx/dist/loader.mjs'))},'--input-type=module','-e',${JSON.stringify(`const{lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const{withFileLock}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});lockFile(${JSON.stringify(b.op)});await withFileLock(${JSON.stringify(b.cap)},()=>{console.log('ready');return new Promise(()=>{});});`)}]);await once(child.stdout,'data');child.kill('SIGKILL');await once(child,'exit');const{lockFile}=await import(${JSON.stringify(join(root, 'budget/op-lock.mjs'))});const{withFileLock}=await import(${JSON.stringify(join(root, 'src/core/lock.ts'))});const l=lockFile(${JSON.stringify(b.op)});if(!l.ok)throw Error('operation blocked');l.release();await withFileLock(${JSON.stringify(b.cap)},()=>console.log('recovered'),100);`;
  const result = spawnSync('bwrap', ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-user', '--dev-bind', '/', '/', '--proc', '/proc', '--ro-bind', empty, '/etc/machine-id', '--tmpfs', '/var/lib/dbus', process.execPath, '--import', join(root, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('recovered');
});
function unlock(home: string, target: string[], { tty = true, confirm = true, unverified = true, answer = 'payment-lock unverified\n' } = {}) {
  return spawnSync(process.execPath, [...(tty ? ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs')] : []), join(root, 'budget/cli.mjs'), 'unlock', ...target, ...(confirm ? ['--confirm'] : []), ...(unverified ? ['--unverified'] : [])], { env: { ...process.env, SUPERSTABLES_HOME: home }, input: answer, encoding: 'utf8' });
}
const unknown = JSON.stringify({ pid: 2, pidStart: null, namespace: null, bootId: null });
for (const kind of ['cap', 'approvals', 'attempt', 'approval'] as const) {
  it(`${kind}: exact owner gate recovers unverifiable ownership and preserves all payment evidence`, () => {
    const b = box(), id = 'oa-20261006200000-01234567';
    const approval = join(b.home, `budget/approvals/${id}.json`), active = join(b.home, 'budget/approvals/active-solana-devnet');
    const evidence = JSON.stringify({ id, rail: 'solana', chain: 'devnet', state: 'waiting_owner', pid: 2, namespace: null, bootId: null, transaction: 'payment-evidence' });
    const ledger = join(b.home, 'records/attempts.jsonl');
    const attempt = { id: 'original-attempt', state: 'submitting', chain: 'unchecked', runner: JSON.parse(unknown), transaction: 'payment-evidence', history: [{ state: 'submitting', at: '2026-10-06T20:00:00Z' }] };
    if (kind === 'cap') { writeFileSync(b.cap, unknown); writeFileSync(b.cap + '.break', unknown); }
    if (kind === 'approvals') { writeFileSync(approval, evidence); writeFileSync(active, JSON.stringify({ ...JSON.parse(unknown), id })); writeFileSync(approval + '.lock', unknown); }
    if (kind === 'approval') writeFileSync(approval + '.lock', unknown);
    if (kind === 'attempt') { writeFileSync(ledger, JSON.stringify(attempt) + '\n'); writeFileSync(join(b.home, 'records/reconcile.lock'), unknown); }
    const target = kind === 'cap' ? ['--cap'] : kind === 'attempt' ? ['--attempt', 'original-attempt'] : kind === 'approval' ? ['--rail', 'solana', '--approval', id] : ['--rail', 'solana', '--approvals'];
    for (const options of [{ tty: false }, { confirm: false }, { answer: 'payment-lock\n' }, { answer: 'payment-lock unverified \n' }]) expect(unlock(b.home, target, options).status).toBe(3);
    expect(unlock(b.home, target, { unverified: false, answer: 'payment-lock\n' }).status).toBe(5);
    const result = unlock(b.home, target); expect(result.status, result.stderr).toBe(0);
    expect(result.stderr.match(/Clearing the payment lock without proof/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('unverified'); expect(JSON.parse(result.stdout.slice(7)).next).not.toContain('unlock');
    if (kind === 'cap') { expect(existsSync(b.cap)).toBe(false); expect(existsSync(b.cap + '.break')).toBe(false); }
    if (kind === 'approvals') { expect(readFileSync(approval, 'utf8')).toBe(evidence); expect(existsSync(active)).toBe(false); expect(existsSync(approval + '.lock')).toBe(false); }
    if (kind === 'approval') expect(existsSync(approval + '.lock')).toBe(false);
    if (kind === 'attempt') {
      const rows = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(2); expect(rows[0]).toEqual(attempt);
      const { runner, ...preserved } = attempt; expect(rows[1]).toEqual(preserved);
    }
  });
  it(`${kind}: even the owner override refuses a verified live holder`, () => {
    const b = box(), id = 'oa-20261006200000-01234567', identity = createIdentitySource().record();
    let path: string, target: string[], record: string;
    if (kind === 'cap') { path = b.cap; target = ['--cap']; record = JSON.stringify(identity); }
    else if (kind === 'attempt') { path = join(b.home, 'records/attempts.jsonl'); target = ['--attempt', 'original']; record = JSON.stringify({ id: 'original', runner: { ...identity, start: identity.pidStart } }) + '\n'; }
    else if (kind === 'approval') { path = join(b.home, `budget/approvals/${id}.json.lock`); target = ['--rail', 'solana', '--approval', id]; record = JSON.stringify(identity); }
    else { path = join(b.home, 'budget/approvals/active-solana-devnet'); target = ['--rail', 'solana', '--approvals']; record = JSON.stringify({ ...identity, id }); }
    writeFileSync(path, record);
    expect(unlock(b.home, target).status).toBe(5); expect(readFileSync(path, 'utf8')).toBe(record);
  });
}

it('prints the operation override notice once for both locks', () => {
  const b = box(); writeFileSync(b.op, unknown); writeFileSync(join(b.dir, 'paid-op.json.lock'), unknown);
  const result = unlock(b.home, ['--rail', 'solana', '--op', 'paid-op'], { answer: 'paid-op unverified\n' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr.match(/Clearing the lock for operation paid-op/g)).toHaveLength(1);
});
it('different macOS boots remain possibly alive even with an old write and cloned platform UUID', () => {
  const src = createIdentitySource({ platform: 'darwin', host: 'mac', start: () => 'darwin:utc:100', probe: () => true,
    run: (command: string) => command === 'ioreg' ? '\"IOPlatformUUID\" = \"11111111-2222-3333-4444-555555555555\"' : boot,
  });
  const owner = { ...src.record(), bootId: oldBoot };
  for (const writtenAt of [Date.now(), Date.now() - 40 * 86400_000]) {
    expect(inspectProcess({ ...owner, writtenAt }, src)).toMatchObject({ state: 'alive', possiblyAlive: true });
  }
});
it('owner recovery preserves a replacement published during its override notice', async () => {
  const b = box(), replacement = JSON.stringify(createIdentitySource().record()); writeFileSync(b.cap, unknown);
  const { recoverCap } = await import(join(root, 'src/core/owner-recovery.mjs'));
  expect(recoverCap(b.home, { unverified: true, onOverride: () => writeFileSync(b.cap, replacement) })).toEqual({ outcome: 'busy' });
  expect(readFileSync(b.cap, 'utf8')).toBe(replacement);
});

it('approval recovery protects a verified live rail child behind an unverifiable chain lock', async () => {
  const b = box(), id = 'oa-20261006200000-01234567';
  const child = spawn('sleep', ['60'], { detached: true }); children.add(child);
  await once(child, 'spawn'); if (!child.pid) throw new Error('no rail pid');
  const identity = createIdentitySource().fields(child.pid);
  const active = join(b.home, 'budget/approvals/active-solana-devnet');
  writeFileSync(active, JSON.stringify({ ...JSON.parse(unknown), id }));
  writeFileSync(join(b.home, `budget/approvals/${id}.json`), JSON.stringify({ ...identity, id, rail: 'solana', chain: 'devnet', pid: 2147483646, railPgid: child.pid, railPgidStart: identity.pidStart, railNamespace: identity.namespace }));
  const before = readFileSync(active, 'utf8');
  const result = unlock(b.home, ['--rail', 'solana', '--approvals']);
  expect(result.status).toBe(5); expect(readFileSync(active, 'utf8')).toBe(before);
});

it('hidepid does not weaken a readable verified live holder in the same PID namespace', () => {
  const base = source({ hidepid: '2' });
  const src = { ...base, probe: () => true };
  expect(inspectProcess({ ...src.record(), pid: 77 }, src)).toEqual({ state: 'alive' });
});

it('explicit approval recovery refuses the wrong rail and preserves its record lock', () => {
  const b = box(), id = 'oa-20261006200000-01234567';
  const path = join(b.home, `budget/approvals/${id}.json.lock`);
  writeFileSync(path, unknown);
  writeFileSync(join(b.home, `budget/approvals/${id}.json`), JSON.stringify({ id, rail: 'evm', chain: 'base-sepolia', ...createIdentitySource().record() }));
  const result = unlock(b.home, ['--rail', 'solana', '--approval', id]);
  expect(result.status).toBe(3); expect(result.stdout).toContain('approval_not_found'); expect(result.stdout).not.toContain('The payment lock is held'); expect(readFileSync(path, 'utf8')).toBe(unknown);
});

it('attempt recovery preserves a torn ledger tail and starts its recovery row on a new line', () => {
  const b = box(), ledger = join(b.home, 'records/attempts.jsonl');
  const attempt = { id: 'original', state: 'submitting', transaction: 'retained-payment', runner: JSON.parse(unknown) };
  const before = JSON.stringify(attempt) + '\n{"id":"torn'; writeFileSync(ledger, before);
  const result = unlock(b.home, ['--attempt', 'original']);
  expect(result.status, result.stderr).toBe(0);
  const expected = { id: 'original', state: 'submitting', transaction: 'retained-payment' };
  expect(readFileSync(ledger, 'utf8')).toBe(before + '\n' + JSON.stringify(expected) + '\n');
});

it('the cap owner can recover unreadable record bytes with the same exact gate and inode checks', () => {
  const b = box(), preload = join(b.home, 'deny-cap.mjs'); writeFileSync(b.cap, unknown);
  writeFileSync(preload, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(String(path)===${JSON.stringify(b.cap)})throw Object.assign(Error('denied'),{code:'EACCES'});return read.call(this,path,...args);};syncBuiltinESMExports();`);
  const run = (unverified: boolean) => spawnSync(process.execPath, ['--import', preload, '--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--cap', '--confirm', ...(unverified ? ['--unverified'] : [])], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, input: unverified ? 'payment-lock unverified\n' : 'payment-lock\n', encoding: 'utf8' });
  expect(run(false).status).toBe(5); expect(readFileSync(b.cap, 'utf8')).toBe(unknown);
  const result = run(true); expect(result.status, result.stderr).toBe(0); expect(existsSync(b.cap)).toBe(false);
});
