import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const project = fileURLToPath(new URL('../..', import.meta.url));
const root = resolve(process.env.BUDGET_DURABILITY_ROOT ?? project);
const homes: string[] = [];
beforeEach(() => new Promise<void>(resolve => setImmediate(resolve)));
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'budget-journal-')); homes.push(dir); return dir; };
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (helper: string, dir: string, args: string[] = [], extra = {}) => spawnSync(process.execPath, ['--import', 'tsx', join(project, 'test/helpers', helper), ...args], {
  cwd: project, env: { ...process.env, SUPERSTABLES_HOME: dir, BUDGET_DURABILITY_ROOT: root, ...extra }, encoding: 'utf8', timeout: 15_000,
});
const checkpoints = [
  ['evm', 'pull-intent'], ['evm', 'pull-hash'], ['evm', 'authorization'],
  ['tempo', 'quote'], ['tempo', 'push-intent'], ['tempo', 'pull-submitted'],
  ['solana', 'intent'], ['solana', 'signature'],
];
const cuts = ['file-open', 'write', 'file-fsync', 'file-close', 'rename', 'directory-open', 'directory-fsync', 'directory-close', 'returned', 'none'];

describe('rail journal power loss', () => {
  for (const [rail, checkpoint] of checkpoints) {
    it.each(cuts)(`${rail} ${checkpoint}: power cut after %s`, cut => {
      const result = run('budget-journal-fault.mjs', home(), [rail, checkpoint, cut]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
      // Only a completed durable write may enable the next signing or sending step.
      if (report.mayPay || report.events.includes('directory-fsync') || cut === 'returned') {
        expect(report.recovered.checkpoint, JSON.stringify(report)).toBe(checkpoint);
      } else {
        expect(report.killed, JSON.stringify(report)).toBe(true);
        expect(report.recovered.checkpoint).toBeUndefined();
      }
      if (cut === 'none') expect(report.events).toEqual(['file-open', 'write', 'file-fsync', 'file-close', 'rename', 'directory-open', 'directory-fsync', 'directory-close', 'returned']);
    });
  }
  it('persists newly created directory entries and writes private journals', async () => {
    const { writeJournalFile } = await import('../../budget/journal.mjs');
    const dir = home();
    const path = join(dir, 'new/budget/ops/test.json');
    writeJournalFile(path, '{"state":"submitted"}');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'submitted' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'new/budget/ops')).mode & 0o777).toBe(0o700);
  });
});

const owner = '0x1111111111111111111111111111111111111111';
const agent = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const memo = `0x${'ef'.repeat(32)}`;
const op = () => ({ op: 'durability-test', rail: 'tempo', kind: 'buy', state: 'quoted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  memo, startBlock: '10', intent: { amount: '1000', amountDecimal: '0.001', token: '0x20C0000000000000000000000000000000000000', recipient, chainId: 42431, owner, agent, mode: 'push' }, history: [] });
const reconcile = (patch: object, scenario: string) => {
  const dir = home(); const ops = join(dir, 'budget/ops/tempo-moderato'); mkdirSync(ops, { recursive: true });
  writeFileSync(join(ops, 'durability-test.json'), JSON.stringify({ ...op(), ...patch }));
  const result = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: scenario });
  const line = result.stdout.split('\n').find(x => x.startsWith('RESULT '));
  expect(line, result.stderr + result.stdout).toBeTruthy();
  return { result: JSON.parse(line!.slice(7)), code: result.status, calls: JSON.parse(readFileSync(join(ops, 'calls.json'), 'utf8')) };
};

describe('Tempo memo recovery and push expiry', () => {
  it.each([undefined, 10, 200])('real push buyer survives broadcast then SIGKILL with expiry %s', expires => {
    const dir = home();
    const killed = run('budget-tempo-push-crash.mjs', dir, [], { PUSH_EXPIRES: expires === undefined ? '' : String(expires) });
    expect(killed.signal, killed.stderr + killed.stdout).toBe('SIGKILL');
    const broadcast = JSON.parse(readFileSync(join(dir, 'broadcast.json'), 'utf8'));
    expect(broadcast.recorded.state).toBe('submitted');
    expect(broadcast.durable).toEqual(broadcast.recorded);
    expect(broadcast.recorded.validBefore).toBe(Math.floor(broadcast.now / 1000) + (expires === 10 ? 10 : 25));
    expect(broadcast.validBefore).toBe(broadcast.recorded.validBefore);
    // The RPC accepted payment, but the buyer never saved the returned hash.
    expect(broadcast.recorded.expectedTx).toBeUndefined();
    const recovered = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: 'found' });
    const line = recovered.stdout.split('\n').find(x => x.startsWith('RESULT '));
    expect(line, recovered.stderr + recovered.stdout).toBeTruthy();
    expect(JSON.parse(line!.slice(7))).toMatchObject({ state: 'settled', tx: `0x${'ab'.repeat(32)}` });
  });
  it('finds a payment by memo in a quoted journal after submitted was lost', () => {
    const r = reconcile({}, 'found');
    expect(r.result).toMatchObject({ state: 'settled', tx: `0x${'ab'.repeat(32)}`, debit: '0.001', delivered: null });
    expect(r.calls).toContain('eth_getLogs');
  });
  it('keeps a quoted memo without a validity bound unknown', () => {
    expect(reconcile({}, 'absent').result).toMatchObject({ state: 'unknown', debit: null });
  });
  it.each(['quoted', 'submitted'])("%s: absent memo and expired bound proves unpaid", state => {
    const r = reconcile({ state, validBefore: 1100 }, 'absent');
    expect(r.result).toMatchObject({ state: 'not_found', debit: '0', reason: 'signed payment expired unsent; nothing on chain for its memo' });
    expect(r.calls.filter((x: string) => x === 'eth_getLogs')).toHaveLength(2);
  });
  it.each(['quoted', 'submitted'])("%s: absent memo and live bound remains unknown", state => {
    expect(reconcile({ state, validBefore: 1250 }, 'absent').result).toMatchObject({ state: 'unknown', debit: null });
  });
  it.each(['unreadable', 'last-search-fails'])("an expired bound with %s history remains unknown", scenario => {
    expect(reconcile({ validBefore: 1100 }, scenario).result.state).toBe('unknown');
  });
  it('does not expire a wallet-initiated pay even if an old record carries a bound', () => {
    expect(reconcile({ kind: 'pay', state: 'submitted', validBefore: 1100 }, 'absent').result.state).toBe('unknown');
  });
  it.each(['quoted', 'refused_precheck', 'refused_chain'])("old unsigned %s records without a memo keep their meaning", state => {
    const r = reconcile({ state, memo: undefined }, 'absent');
    expect(r.result.state).toBe(state === 'quoted' ? 'not_found' : state);
    expect(r.calls).not.toContain('eth_getLogs');
  });
  it('a quote-only memo cannot suppress payment search', () => {
    expect(reconcile({ reason: 'quote_only' }, 'found').result.state).toBe('settled');
  });
  it('an old push submitted record without expiry remains unknown', () => {
    expect(reconcile({ state: 'submitted' }, 'absent').result.state).toBe('unknown');
  });
  it('an old pull transaction still resolves by memo', () => {
    expect(reconcile({ state: 'submitted', intent: { ...op().intent, mode: 'pull' }, signedHash: `0x${'12'.repeat(32)}`, validBefore: 1250 }, 'found').result.state).toBe('settled');
  });
});
