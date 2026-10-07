import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs';
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
  it('does not open an existing traversable but unreadable ancestor', () => {
    const dir = home();
    const ancestor = join(dir, 'locked');
    const journal = join(ancestor, 'home/budget/ops/test.json');
    mkdirSync(join(ancestor, 'home/budget/ops'), { recursive: true });
    chmodSync(ancestor, 0o311);
    try {
      const result = run('budget-journal-permissions.mjs', dir);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual({ state: 'submitted' });
    } finally { chmodSync(ancestor, 0o700); }
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
  utimesSync(join(ops, 'durability-test.json'), 1000, 1000);
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
  it('returns never signed for a durable quoted journal without an invented validity bound', () => {
    const r = reconcile({ journalVersion: 1 }, 'absent');
    expect(r.result).toMatchObject({ state: 'not_found', debit: '0', reason: 'never signed: interrupted before the payment was created' });
    expect(r.calls).not.toContain('eth_getLogs');
  });
  it('a durable quote-only journal still says nothing to reconcile even when RPC fails', () => {
    expect(reconcile({ journalVersion: 1, reason: 'quote_only' }, 'unreadable').result.state).toBe('quoted');
  });
  it('a legacy quoted journal resolves after a complete search past the locked recovery bound', () => {
    expect(reconcile({}, 'absent').result).toMatchObject({ state: 'not_found', debit: '0' });
  });
  it('a legacy quote-only journal resolves to the quote answer after complete absence', () => {
    expect(reconcile({ reason: 'quote_only' }, 'absent').result.state).toBe('quoted');
  });
  it.each(['recent', 'unreadable', 'range-fails', 'short-range', 'lagging-head', 'invalid-head'])('legacy quoted with %s history is unknown for now', scenario => {
    expect(reconcile({}, scenario).result.state).toBe('unknown');
  });
  it.each(['recent', 'unreadable'])('legacy quote-only with %s history retains its recovery identity', scenario => {
    expect(reconcile({ reason: 'quote_only' }, scenario).result).toMatchObject({ state: 'unknown', reason: 'quote_only' });
  });
  it('an already uncertain legacy quote resolves on a later complete search', () => {
    expect(reconcile({ state: 'unknown', legacyQuotedBefore: 1100 }, 'absent').result.state).toBe('not_found');
  });
  it('an already uncertain legacy quote-only resolves back to quoted', () => {
    expect(reconcile({ state: 'unknown', reason: 'quote_only', legacyQuotedBefore: 1100 }, 'absent').result.state).toBe('quoted');
  });
  it.each([undefined, 'quote_only'])('legacy uncertainty resolves on another run with reason %s', reason => {
    const dir = home(); const ops = join(dir, 'budget/ops/tempo-moderato'); mkdirSync(ops, { recursive: true });
    const journal = join(ops, 'durability-test.json');
    writeFileSync(journal, JSON.stringify({ ...op(), reason })); utimesSync(journal, 1000, 1000);
    const first = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: 'recent' });
    expect(first.status, first.stderr + first.stdout).toBe(5);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ state: 'unknown', legacyQuotedBefore: 1000 });
    const second = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: 'absent' });
    expect(second.status, second.stderr + second.stdout).toBe(reason === 'quote_only' ? 0 : 1);
    expect(JSON.parse(readFileSync(journal, 'utf8')).state).toBe(reason === 'quote_only' ? 'quoted' : 'not_found');
  });
  it.each([undefined, 1])('not_found with marker %s is searched again and settles a payment', journalVersion => {
    const r = reconcile({ journalVersion, state: 'not_found', reason: 'never signed: interrupted before the payment was created' }, 'found');
    expect(r.result).toMatchObject({ state: 'settled', debit: '0.001' });
    expect(r.calls).toContain('eth_getLogs');
  });
  it('complete absence preserves a stored not_found answer', () => {
    const r = reconcile({ state: 'not_found', reason: 'never signed: interrupted before the payment was created' }, 'absent');
    expect(r.result).toMatchObject({ state: 'not_found', debit: '0', reason: 'never signed: interrupted before the payment was created' });
    expect(r.calls).toContain('eth_getLogs');
  });
  it('unreadable not_found is unknown for this run and remains searchable on disk', () => {
    const dir = home(); const ops = join(dir, 'budget/ops/tempo-moderato'); mkdirSync(ops, { recursive: true });
    const journal = join(ops, 'durability-test.json');
    const record = { ...op(), state: 'not_found', reason: 'never signed: interrupted before the payment was created' };
    writeFileSync(journal, JSON.stringify(record));
    const failed = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: 'unreadable' });
    expect(failed.status, failed.stderr + failed.stdout).toBe(5);
    expect(failed.stdout).toContain('UNKNOWN: transaction inclusion unreadable');
    expect(failed.stdout).not.toContain('Run reconcile again after its validBefore');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual(record);
    const recovered = run('budget-tempo-reconcile-rpc.mjs', dir, [], { TEMPO_SCENARIO: 'found' });
    expect(recovered.status, recovered.stderr + recovered.stdout).toBe(0);
    expect(JSON.parse(readFileSync(journal, 'utf8')).state).toBe('settled');
  });
  it.each([null, '1', 0, 2])('marker %s takes the legacy path and finds a payment', journalVersion => {
    const r = reconcile({ journalVersion }, 'found');
    expect(r.result.state).toBe('settled');
    expect(r.calls).toContain('eth_getLogs');
  });
  it('an old never-signed result after the recovery-bound write still finds the payment', () => {
    const r = reconcile({ state: 'not_found', legacyQuotedBefore: 1000, reason: 'never signed: interrupted before the payment was created' }, 'found');
    expect(r.result).toMatchObject({ state: 'settled', debit: '0.001' });
  });
  it.each(['push', 'pull'])('%s: a seller hash without a receipt does not block expired absence', mode => {
    const r = reconcile({ state: 'submitted', tx: `0x${'de'.repeat(32)}`, validBefore: 1100, intent: { ...op().intent, mode } }, 'absent');
    expect(r.result.state).toBe('not_found');
  });
  it('a seller hash without a receipt before expiry stays unknown', () => {
    expect(reconcile({ state: 'submitted', tx: `0x${'de'.repeat(32)}`, validBefore: 1250 }, 'absent').result.state).toBe('unknown');
  });
  it('a memo hit with no receipt cannot prove absence', () => {
    expect(reconcile({ state: 'submitted', validBefore: 1100 }, 'missing-receipt').result.state).toBe('unknown');
  });
  it('submitted: absent memo and expired bound proves unpaid', () => {
    const r = reconcile({ state: 'submitted', validBefore: 1100 }, 'absent');
    expect(r.result).toMatchObject({ state: 'not_found', debit: '0', reason: 'signed payment expired unsent; nothing on chain for its memo' });
  });
  it('submitted: absent memo and live bound remains unknown', () => {
    expect(reconcile({ state: 'submitted', validBefore: 1250 }, 'absent').result).toMatchObject({ state: 'unknown', debit: null });
  });
  it.each(['unreadable', 'range-fails', 'short-range', 'lagging-head', 'invalid-head'])('an expired bound with %s history remains unknown', scenario => {
    expect(reconcile({ state: 'submitted', validBefore: 1100 }, scenario).result.state).toBe('unknown');
  });
  it.each(['push', 'pull'])('%s: alternating heads cannot turn a payment beyond the lagging head into not_found', mode => {
    expect(reconcile({ state: 'submitted', validBefore: 1100, intent: { ...op().intent, mode } }, 'alternating-heads').result.state).toBe('unknown');
  });
  it('a multi-range complete search has a small bounded call count and no block scans', () => {
    const r = reconcile({ state: 'submitted', validBefore: 1100 }, 'multi-range');
    expect(r.result.state).toBe('not_found');
    expect(r.calls.filter((x: string) => x === 'eth_getLogs')).toHaveLength(2);
    expect(r.calls.length).toBeLessThanOrEqual(10);
    expect(r.calls).not.toContain('eth_getBlockTransactionCountByHash');
  });
  it('an included push hash cannot expire when later receipt reads are missing', () => {
    expect(reconcile({ state: 'submitted', validBefore: 1100, expectedTx: `0x${'ab'.repeat(32)}` }, 'absent').result.state).toBe('unknown');
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

describe('quoted Tempo operation can be bought after reconciliation', () => {
  it.each(['interrupt', 'quote'])('%s, reconcile, then real buy under the same op', step => {
    const dir = home();
    const first = run('budget-tempo-quoted-flow.mjs', dir, [], { TEMPO_STEP: step });
    if (step === 'interrupt') expect(first.signal, first.stderr + first.stdout).toBe('SIGKILL');
    else expect(first.status, first.stderr + first.stdout).toBe(0);
    const journal = join(dir, 'budget/ops/tempo-moderato/durability-test.json');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ state: 'quoted' });
    const recovered = run('budget-tempo-quoted-flow.mjs', dir, [], { TEMPO_STEP: 'reconcile' });
    expect(recovered.status, recovered.stderr + recovered.stdout).toBe(step === 'quote' ? 0 : 1);
    expect(JSON.parse(readFileSync(journal, 'utf8')).state).toBe(step === 'quote' ? 'quoted' : 'not_found');
    const buy = run('budget-tempo-quoted-flow.mjs', dir, [], { TEMPO_STEP: 'buy' });
    expect(buy.status, buy.stderr + buy.stdout).toBe(0);
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({ state: 'settled', delivered: true });
    expect(JSON.parse(readFileSync(join(dir, 'paid-request.json'), 'utf8')).journal).toMatchObject({ state: 'submitted', journalVersion: 1 });
  });
});
