import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const { createIdentitySource, inspectProcess } = await import(join(root, 'src/core/process-identity.mjs'));
const { inspectLockText } = await import(join(root, 'src/core/owner-recovery.mjs'));
const homes: string[] = [];
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-legacy-live-')); homes.push(home);
  const approvals = join(home, 'budget/approvals'), records = join(home, 'records'), ops = join(home, 'budget/ops/solana-devnet');
  for (const dir of [approvals, records, ops]) mkdirSync(dir, { recursive: true });
  return { home, approvals, records, ops };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function unlock(home: string, target: string[], unverified = false, answer = `payment-lock${unverified ? ' unverified' : ''}`, tty = true, confirm = true) {
  return spawnSync(process.execPath, [...(tty ? ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs')] : []), join(root, 'budget/cli.mjs'), 'unlock', ...target, ...(confirm ? ['--confirm'] : []), ...(unverified ? ['--unverified'] : [])], {
    env: { ...process.env, SUPERSTABLES_HOME: home }, input: `${answer}\n`, encoding: 'utf8', timeout: 20_000,
  });
}
const id = 'oa-20261007010000-01234567';
it('buy-once start lock after reboot requires exact owner recovery and preserves purchase evidence', () => {
  const b = box(), path = join(b.approvals, 'active-once-purchase');
  const bytes = JSON.stringify({ ...createIdentitySource().record(), id, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  const evidence = '{"id":"' + id + '","command":"buy-once","rail":"evm","chain":"base-sepolia","pid":null,"seen":{"paid":true,"hashes":["retained-evidence"]}}';
  writeFileSync(path, bytes); writeFileSync(join(b.approvals, `${id}.json`), evidence);
  for (const [tty, confirm, answer] of [[false, true, 'payment-lock unverified'], [true, false, 'payment-lock unverified'], [true, true, 'payment-lock']] satisfies [boolean, boolean, string][]) {
    const refused = unlock(b.home, ['--buy-once'], true, answer, tty, confirm);
    expect(refused.status).toBe(3); expect(readFileSync(path, 'utf8')).toBe(bytes);
  }
  const plain = unlock(b.home, ['--buy-once']);
  expect(plain.status).toBe(5); expect(plain.stderr).toContain('Cannot clear'); expect(readFileSync(path, 'utf8')).toBe(bytes);
  const recovered = unlock(b.home, ['--buy-once'], true);
  expect(recovered.status, recovered.stderr).toBe(0); expect(recovered.stdout).toContain('"reason":"locks_cleared"');
  expect(recovered.stderr).toContain('may allow a second payment'); expect(recovered.stderr.match(/Clearing the payment lock without proof/g)).toHaveLength(1);
  expect(existsSync(path)).toBe(false); expect(readFileSync(join(b.approvals, `${id}.json`), 'utf8')).toBe(evidence);
  const claim = spawnSync(process.execPath, ['--input-type=module', '-e', `const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const id=a.newApprovalId();const c=a.claim('once','purchase',id);console.log(c.ok);if(c.ok)a.release('once','purchase',id);`], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8' });
  expect(claim.status, claim.stderr).toBe(0); expect(claim.stdout.trim()).toBe('true');
});
for (const shape of ['core', 'chain', 'createdAt-only', 'operation', 'approval-worker', 'pid-only']) {
  it.runIf(process.platform === 'linux')(`legacy ${shape} live proof and cap-only death proof`, () => {
    const me = createIdentitySource().record();
    const record = { pid: me.pid, ...(shape === 'pid-only' || shape === 'createdAt-only' ? {} : { pidStart: me.pidStart }), ...(shape === 'core' ? { owner: 'released-owner' } : { createdAt: Date.now() }), ...(shape === 'chain' || shape === 'approval-worker' ? { id, rail: 'solana', chain: 'devnet' } : {}) };
    const check = inspectLockText(JSON.stringify(record));
    expect(check.state).toBe('alive'); expect(Boolean(check.possiblyAlive)).toBe(shape === 'pid-only' || shape === 'createdAt-only');
    expect(inspectProcess(record).possiblyAlive).toBe(shape === 'pid-only' || shape === 'createdAt-only' ? true : undefined);
    const absent = { ...record, pid: 2147483646 };
    expect(inspectLockText(JSON.stringify(absent)).possiblyAlive).toBe(true);
    if (shape === 'core') expect(inspectLockText(JSON.stringify(absent), true).state).toBe('dead');
  });
}
for (const target of ['reconcile', 'chain', 'record', 'operation', 'buy-once', 'rail-child']) {
  it.runIf(process.platform === 'linux')(`verified-live legacy ${target} refuses both owner recovery modes`, () => {
    const b = box(), me = createIdentitySource().record(), legacy = { pid: me.pid, pidStart: me.pidStart, createdAt: Date.now() };
    let path: string, args: string[], token = 'payment-lock';
    if (target === 'reconcile') {
      path = join(b.records, 'reconcile.lock'); args = ['--attempt', 'att-1'];
      writeFileSync(join(b.records, 'attempts.jsonl'), '{"id":"att-1","state":"submitting"}\n');
    } else if (target === 'operation' || target === 'rail-child') {
      path = join(b.ops, 'paid-op.buy.lock'); args = ['--rail', 'solana', '--op', 'paid-op']; token = 'paid-op';
    } else {
      path = join(b.approvals, target === 'record' ? `${id}.json.lock` : `active-${target === 'buy-once' ? 'once-purchase' : 'solana-devnet'}`);
      args = target === 'buy-once' ? ['--buy-once'] : ['--rail', 'solana', '--approvals'];
      writeFileSync(join(b.approvals, `${id}.json`), JSON.stringify({ ...legacy, id, rail: target === 'buy-once' ? 'once' : 'solana', chain: target === 'buy-once' ? 'purchase' : 'devnet' }));
    }
    const bytes = JSON.stringify(target === 'rail-child' ? { ...legacy, pid: 2147483646, railPid: me.pid, railPidStart: me.pidStart } : { ...legacy, id });
    writeFileSync(path, bytes);
    for (const unverified of [false, true]) {
      const refused = unlock(b.home, args, unverified, `${token}${unverified ? ' unverified' : ''}`);
      expect(refused.status, refused.stderr).toBe(5); expect(refused.stdout).toContain('"reason":"op_in_progress"'); expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(refused.stderr).not.toContain('Cannot clear'); expect(refused.stderr).not.toContain('Clearing the payment lock without proof'); expect(refused.stderr).not.toContain('Clearing the lock for operation');
    }
  });
}
for (const fault of ['none', 'other-boot', 'nested-reader', 'hidden-proc', 'unreadable-mount', 'nested-match', 'unreadable-candidate', 'different-start', 'missing-start']) {
  it(`legacy live proof requires all location and start gates: ${fault}`, () => {
    const boot = '11111111-2222-3333-4444-555555555555', start = `linux:${boot}:100`;
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const source = createIdentitySource({ platform: 'linux', host: 'host', bootElapsed: () => 1000,
      readFile: (path: string) => {
        if (path === '/proc/sys/kernel/random/boot_id') return boot;
        if (path === '/proc/self/status') return `NSpid:\t${process.pid}\n`;
        if (path === '/proc/self/mountinfo') return fault === 'unreadable-mount' ? denied() : `1 0 0:1 / /proc rw${fault === 'hidden-proc' ? ',hidepid=2' : ''} - proc proc rw\n`;
        if (path === '/proc/44/status') return fault === 'unreadable-candidate' ? denied() : `NSpid:\t44${fault === 'nested-match' ? '\t44' : ''}\n`;
        return denied();
      }, readlink: () => fault === 'nested-reader' ? 'pid:[child]' : 'pid:[4026531836]', readdir: () => ['44'],
      start: () => fault === 'different-start' ? `linux:${boot}:101` : start,
    });
    const owner = { pid: 44, pidStart: fault === 'missing-start' ? null : fault === 'other-boot' ? 'linux:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:100' : start, createdAt: '2026-10-07T00:00:00.000Z' };
    expect(inspectProcess(owner, source)).toMatchObject(fault === 'none' ? { state: 'alive' } : { state: 'alive', possiblyAlive: true });
    expect(Boolean(inspectProcess(owner, source).possiblyAlive)).toBe(fault !== 'none');
  });
}
