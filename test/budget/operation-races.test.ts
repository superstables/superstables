import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));
const helper = fileURLToPath(new URL('../helpers/budget-interleaving.mjs', import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
const op = 'same-order';
function sandbox(rail: string) {
  const home = mkdtempSync(join(tmpdir(), 'budget-race-'));
  dirs.push(home);
  const dir = join(home, 'budget/ops', rail === 'solana' ? 'solana-devnet' : rail === 'evm' ? 'evm-base-sepolia' : 'tempo-moderato');
  mkdirSync(dir, { recursive: true });
  return { home, dir };
}
function child(rail: string, action: string, box: ReturnType<typeof sandbox>, marker: string, state?: string) {
  const p = spawn(process.execPath, ['--import', 'tsx', helper], {
    cwd: root, env: { ...process.env, SUPERSTABLES_HOME: box.home, RACE_ROOT: root, RACE_DIR: box.dir,
      RACE_OP: op, RACE_ACTION: action, RACE_RAIL: rail, RACE_MARKER: marker, ...(state ? { RACE_STATE: state } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(p);
  let stdout = '', stderr = '';
  p.stdout?.on('data', b => { stdout += b; });
  p.stderr?.on('data', b => { stderr += b; });
  const done = new Promise<{ stdout: string; stderr: string; code: number | null }>((res, rej) => {
    p.once('error', rej);
    p.once('close', code => res({ stdout, stderr, code }));
  });
  return { p, done };
}
async function untilFile(path: string) {
  const end = Date.now() + 8000;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`child did not reach ${path}`);
    await sleep(10);
  }
}
afterEach(async () => {
  for (const p of children.splice(0)) { p.kill('SIGCONT'); p.kill('SIGKILL'); }
  // Wait for child exit before deleting its directory.
  await sleep(50);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux')('operation ownership under forced process stalls', () => {
  it('dispatcher: recovers an empty breaker left by an interrupted release', async () => {
    const box = sandbox('dispatcher');
    const path = join(box.dir, `${op}.buy.lock`);
    writeFileSync(path, JSON.stringify({ pid: 2147483647, pidStart: null }));
    mkdirSync(`${path}.break`);
    const marker = join(box.home, 'empty-breaker');
    child('dispatcher', 'hold', box, marker);
    await untilFile(marker + '.result');
    expect(JSON.parse(readFileSync(marker + '.result', 'utf8')).ok).toBe(true);
  });
  for (const rail of ['dispatcher', 'solana']) {
    it(`${rail}: an old release cannot delete the next generation in the same clock tick`, async () => {
      const box = sandbox(rail);
      const r = await child(rail, 'generation', box, join(box.home, 'generation')).done;
      expect(r.stderr).not.toContain('Error');
      expect(JSON.parse(r.stdout)).toEqual({ first: true, second: true, third: false });
    });
    it(`${rail}: a paused stale-lock breaker cannot displace a live successor`, async () => {
      const box = sandbox(rail);
      const path = join(box.dir, rail === 'solana' ? `${op}.json.lock` : `${op}.buy.lock`);
      writeFileSync(path, rail === 'solana' ? '2147483647' : JSON.stringify({ pid: 2147483647, pidStart: null }));
      const marker = join(box.home, 'first');
      const first = child(rail, 'break', box, marker);
      await untilFile(marker);
      // The dispatcher's old breaker was stolen after ten seconds, even while SIGSTOP kept its owner alive.
      if (rail === 'dispatcher') await sleep(10_100);
      const secondMarker = join(box.home, 'second');
      child(rail, 'hold', box, secondMarker);
      await untilFile(secondMarker + '.result');
      const second = JSON.parse(readFileSync(secondMarker + '.result', 'utf8'));
      first.p.kill('SIGCONT');
      await untilFile(marker + '.result');
      const acquired = JSON.parse(readFileSync(marker + '.result', 'utf8'));
      expect({ first: acquired.ok, second: second.ok }).toEqual({ first: true, second: false });
      const thirdMarker = join(box.home, 'third');
      child(rail, 'hold', box, thirdMarker);
      await untilFile(thirdMarker + '.result');
      expect(JSON.parse(readFileSync(thirdMarker + '.result', 'utf8')).ok).toBe(false);
    }, 25_000);
  }
});

describe.runIf(process.platform === 'linux')('operation writers share serialization', () => {
  for (const rail of ['solana', 'tempo', 'evm']) {
    for (const state of ['submitted', 'settled']) {
      it(`${rail}: a stalled unsigned reconcile cannot overwrite newer ${state} evidence`, async () => {
        const box = sandbox(rail);
        const path = join(box.dir, `${op}.json`);
        writeFileSync(path, JSON.stringify({ op, rail, kind: 'buy', state: 'quoted', history: [],
          createdAt: new Date().toISOString(), path: 'approve', notes: [], signed: false,
          owner: `0x${'22'.repeat(20)}`, agent: `0x${'33'.repeat(20)}`, delivered: null,
          intent: { amount: '1000', amountDecimal: '0.001',
            recipient: `0x${'11'.repeat(20)}`, owner: `0x${'22'.repeat(20)}`, agent: `0x${'33'.repeat(20)}` } }));
        const first = child(rail, 'reconcile', box, join(box.home, 'read'));
        await untilFile(join(box.home, 'read'));
        const writer = await child(rail, 'write', box, join(box.home, 'write'), state).done;
        first.p.kill('SIGCONT');
        const reconciled = await first.done;
        expect(reconciled.stdout).toContain('RESULT ');
        // On the base this writer succeeds and the stale reconcile changes its new evidence to not_found.
        expect(JSON.parse(writer.stdout).ok, `stale reconcile saved ${readFileSync(path, 'utf8')}`).toBe(false);
        const after = await child(rail, 'write', box, join(box.home, 'after'), state).done;
        expect(JSON.parse(after.stdout).ok).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe(state);
      });
    }
    it(`${rail}: a later negative RPC result preserves settled evidence and delivery`, async () => {
      const box = sandbox(rail);
      const path = join(box.dir, `${op}.json`);
      const tx = `0x${'ab'.repeat(32)}`;
      const rec = { op, rail, kind: 'buy', state: 'settled', history: [], notes: [], path: 'approve',
        tx, settleTx: tx, settleStatus: 'success', delivered: false, debit: '0.001', signed: true,
        agentSig: 'recorded-agent-signature', lastValidBlockHeight: 1, pullTx: tx, pullNonce: 0,
        memo: `0x${'aa'.repeat(32)}`, startBlock: '1', validBefore: 1,
        createdAt: '2026-10-04T23:59:00Z', owner: `0x${'22'.repeat(20)}`, agent: `0x${'33'.repeat(20)}`,
        intent: { amount: '1000', amountDecimal: '0.001', recipient: `0x${'11'.repeat(20)}`,
          owner: `0x${'22'.repeat(20)}`, agent: `0x${'33'.repeat(20)}` } };
      writeFileSync(path, JSON.stringify(rec));
      const marker = join(box.home, 'paid-read');
      const reconcile = child(rail, 'reconcile', box, marker);
      await untilFile(marker);
      reconcile.p.kill('SIGCONT');
      const r = await reconcile.done;
      expect(r.stdout).toContain('RESULT ');
      const line = r.stdout.trim().split('\n').reverse().find(l => l.startsWith('RESULT '));
      if (!line) throw new Error(`reconcile omitted its RESULT: ${r.stderr}`);
      expect(JSON.parse(line.slice(7))).toMatchObject({ state: 'settled', delivered: false });
      if (rail === 'tempo') expect(JSON.parse(line.slice(7)).debit).toBe('0.001');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'settled', tx, settleTx: tx,
        delivered: false, debit: '0.001', createdAt: rec.createdAt });
    });
  }
});
