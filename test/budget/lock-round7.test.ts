import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stopHolder } from '../helpers/budget-holder-cleanup.mjs';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const { createIdentitySource } = await import(join(root, 'src/core/process-identity.mjs'));
const homes: string[] = [];
const id = 'oa-20261007010000-01234567';
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-round7-')); homes.push(home);
  const approvals = join(home, 'budget/approvals'), records = join(home, 'records'), ops = join(home, 'budget/ops/solana-devnet');
  for (const dir of [approvals, records, ops]) mkdirSync(dir, { recursive: true });
  return { home, approvals, records, ops };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const command = (args: string[]) => ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', ...args, '--confirm'];
function unlock(home: string, args: string[], answer = 'payment-lock') {
  return spawnSync(process.execPath, command(args), { env: { ...process.env, SUPERSTABLES_HOME: home }, input: `${answer}\n`, encoding: 'utf8', timeout: 20_000 });
}
const completed = 'Payment lock recovery is complete. Payment evidence has been preserved. Check the original attempt or approval before doing anything else.';
const unchanged = 'No payment locks needed recovery. Payment evidence is unchanged. Check the original attempt or approval before doing anything else.';
for (const target of ['cap', 'buy-once', 'attempt', 'approval']) {
  for (const locked of [false, true]) {
    it(`${target} prints only the completion line for ${locked ? 'locks_cleared' : 'no_lock'}`, () => {
      const b = box();
      const args = target === 'attempt' ? ['--attempt', 'att-1'] : target === 'approval' ? ['--rail', 'solana', '--approval', id] : [`--${target}`];
      if (target === 'attempt') writeFileSync(join(b.records, 'attempts.jsonl'), '{"id":"att-1","state":"submitting"}\n');
      if (target === 'approval') writeFileSync(join(b.approvals, `${id}.json`), JSON.stringify({ id, rail: 'solana', chain: 'devnet', final: { code: 0 } }));
      const path = target === 'cap' ? join(b.records, 'cap.lock') : target === 'attempt' ? join(b.records, 'reconcile.lock') : join(b.approvals, target === 'buy-once' ? 'active-once-purchase' : `${id}.json.lock`);
      if (locked) writeFileSync(path, JSON.stringify({ ...createIdentitySource().record(), pid: 2147483646, id }));
      const result = unlock(b.home, args);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`"reason":"${locked ? 'locks_cleared' : 'no_lock'}"`);
      expect(result.stderr.split('\n').filter(line => line === (locked ? completed : unchanged))).toHaveLength(1);
      expect(result.stderr).not.toContain(locked ? unchanged : completed);
      expect(existsSync(path)).toBe(false);
    });
  }
}
for (const target of ['operation', 'attempt', 'approval', 'wrong-rail', 'wrong-chain', 'buy-once-rail', 'buy-once-chain']) {
  it(`${target} fails before the prompt and preserves every file`, () => {
    const b = box();
    const record = JSON.stringify({ id, command: 'buy-once', rail: 'evm', chain: 'arc-testnet', pid: null });
    const lock = JSON.stringify({ ...createIdentitySource().record(), id });
    const recordPath = join(b.approvals, `${id}.json`), lockPath = join(b.approvals, `${id}.json.lock`), capPath = join(b.records, 'cap.lock');
    writeFileSync(recordPath, record); writeFileSync(lockPath, lock); writeFileSync(capPath, lock);
    const args = target === 'operation' ? ['--rail', 'solana', '--op', 'missing']
      : target === 'attempt' ? ['--attempt', 'missing']
      : target === 'approval' ? ['--rail', 'evm', '--approval', 'oa-20261007010000-99999999']
      : target === 'wrong-rail' ? ['--rail', 'solana', '--approval', id]
      : target === 'wrong-chain' ? ['--rail', 'evm', '--chain', 'base-sepolia', '--approval', id]
      : target === 'buy-once-rail' ? ['--buy-once', '--rail', 'evm'] : ['--buy-once', '--chain', 'arc-testnet'];
    const result = unlock(b.home, args, 'wrong');
    expect(result.status).toBe(target.startsWith('buy-once-') ? 2 : 3);
    if (!target.startsWith('buy-once-')) expect(result.stdout).toContain(`"reason":"${target === 'operation' ? 'op' : target === 'attempt' ? 'attempt' : 'approval'}_not_found"`);
    else expect(result.stdout).toContain('--buy-once does not take --rail or --chain');
    expect(result.stderr).not.toContain('type ');
    expect(result.stderr).not.toContain('duplicate payments');
    expect(readFileSync(recordPath, 'utf8')).toBe(record);
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
    expect(readFileSync(capPath, 'utf8')).toBe(lock);
  });
}
for (const target of ['operation', 'attempt', 'approval']) {
  it(`${target} vanishing between the precheck and prompt is checked again before recovery`, async () => {
    const b = box();
    const args = target === 'operation' ? ['--rail', 'solana', '--op', 'paid-op'] : target === 'attempt' ? ['--attempt', 'att-1'] : ['--rail', 'solana', '--approval', id];
    const path = target === 'operation' ? join(b.ops, 'paid-op.json') : target === 'attempt' ? join(b.records, 'attempts.jsonl') : join(b.approvals, `${id}.json`);
    writeFileSync(path, target === 'operation' ? '{"state":"submitted"}' : target === 'attempt' ? '{"id":"att-1","state":"submitting"}\n' : JSON.stringify({ id, rail: 'solana', chain: 'devnet', final: { code: 0 } }));
    const untouched = join(b.records, 'cap.lock'); writeFileSync(untouched, 'retained');
    const vanish = join(b.home, 'vanish-before-prompt.mjs');
    writeFileSync(vanish, `import readline from 'node:readline/promises';import {rmSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const create=readline.createInterface;readline.createInterface=(...args)=>{rmSync(${JSON.stringify(path)});return create(...args);};syncBuiltinESMExports();`);
    const child = spawn(process.execPath, ['--import', vanish, ...command(args)], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    const close = once(child, 'close');
    let answered = false, vanishedBeforePrompt = false;
    child.stderr.on('data', data => {
      stderr += data;
      if (!answered && stderr.includes('to confirm:')) {
        answered = true; vanishedBeforePrompt = !existsSync(path); child.stdin.end(`${target === 'operation' ? 'paid-op' : 'payment-lock'}\n`);
      }
    });
    const timer = setTimeout(() => { void stopHolder(child, child.pid); }, 10_000);
    try {
      const [code] = await close;
      expect(answered, stderr).toBe(true); expect(vanishedBeforePrompt).toBe(true); expect(code, stdout + stderr).toBe(3);
      expect(stdout).toContain(`"reason":"${target === 'operation' ? 'op' : target}_not_found"`);
      expect(existsSync(path)).toBe(false); expect(readFileSync(untouched, 'utf8')).toBe('retained');
      expect(stderr).not.toContain(completed); expect(stderr).not.toContain(unchanged);
    } finally { clearTimeout(timer); await stopHolder(child, child.pid); }
  });
}
it.runIf(process.platform === 'linux')('same-boot crash after saveApproval permits plain buy-once recovery and preserves the purchase', async () => {
  const b = box();
  const code = `const a=await import(${JSON.stringify(join(root, 'budget/approvals.mjs'))});const id=${JSON.stringify(id)};const c=a.claim('once','purchase',id);if(!c.ok)throw Error('busy');a.saveApproval({id,command:'buy-once',rail:'evm',chain:'base-sepolia',state:'waiting_owner',createdAt:new Date().toISOString(),pid:null,seen:{paid:true,hashes:['retained-evidence']}});console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { void stopHolder(child, child.pid); }, 10_000);
  try {
    const [ready] = await once(child.stdout, 'data'); expect(String(ready).trim()).toBe('ready');
    const path = join(b.approvals, `${id}.json`), evidence = readFileSync(path, 'utf8');
    await stopHolder(child, child.pid);
    const result = unlock(b.home, ['--buy-once']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('"reason":"locks_cleared"');
    expect(existsSync(join(b.approvals, 'active-once-purchase'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(evidence);
  } finally { clearTimeout(timer); await stopHolder(child, child.pid); }
});
