import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.env.BUDGET_RACE_ROOT ?? join(import.meta.dirname, '../..'));
const locks = await import(join(root, 'budget/op-lock.mjs'));
const dirs: string[] = [];
const old = Date.now() - 600_000;
const namespace = readlinkSync('/proc/self/ns/pid');
const dead = { pid: 2147483646, pidStart: 'linux:missing:1', namespace };
function box() {
  const home = mkdtempSync(join(tmpdir(), 'budget-lock-recovery-'));
  dirs.push(home);
  const dir = join(home, 'budget/ops/solana-devnet');
  mkdirSync(dir, { recursive: true });
  return { home, dir, path: join(dir, 'paid-op.json.lock') };
}
function aged(path: string, text = '') {
  writeFileSync(path, text);
  utimesSync(path, old / 1000, old / 1000);
}
function cli(home: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'budget/cli.mjs'), ...args], { env: { ...process.env, SUPERSTABLES_HOME: home }, encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').reverse().find(l => l.startsWith('RESULT '));
  return { ...r, result: line ? JSON.parse(line.slice(7)) : null };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('recovering abandoned operation locks', () => {
  for (const state of ['foreign namespace', 'zero length', 'non JSON', 'unreadable', 'legacy breaker', 'empty owner', 'stray breaker entry']) {
    it(`recovers an old ${state} under the breaker protocol`, () => {
      const b = box();
      aged(b.path, JSON.stringify(dead));
      if (state === 'foreign namespace') aged(b.path, JSON.stringify({ ...dead, namespace: 'pid:[foreign]', heartbeatAt: old }));
      if (state === 'zero length') aged(b.path);
      if (state === 'non JSON') aged(b.path, '{');
      if (state === 'unreadable') { rmSync(b.path); mkdirSync(b.path); utimesSync(b.path, old / 1000, old / 1000); }
      if (state === 'legacy breaker') aged(b.path + '.break');
      if (state === 'empty owner' || state === 'stray breaker entry') {
        mkdirSync(b.path + '.break');
        aged(join(b.path + '.break', state === 'empty owner' ? '0a1b2c3d-0000-4000-8000-000000000000.owner' : '.DS_Store'));
        utimesSync(b.path + '.break', old / 1000, old / 1000);
      }
      const lock = locks.lockFile(b.path);
      expect(lock.ok).toBe(true);
      if (lock.ok) lock.release();
    });
  }
  it('never breaks a fresh foreign heartbeat or fresh damaged record', () => {
    const b = box();
    for (const text of ['', JSON.stringify({ ...dead, namespace: 'pid:[foreign]', heartbeatAt: Date.now() })]) {
      writeFileSync(b.path, text);
      const lock = locks.lockFile(b.path);
      expect(lock.ok).toBe(false);
    }
  });
  it('protects a live same-namespace holder even with an expired heartbeat', () => {
    const b = box();
    aged(b.path, JSON.stringify({ pid: process.pid, namespace, heartbeatAt: old }));
    expect(locks.lockFile(b.path).ok).toBe(false);
  });
  it('unlock requires confirmation, preserves the journal, and refuses live holders', () => {
    const b = box();
    const journal = '{"op":"paid-op","state":"settled","debit":"0.01"}';
    writeFileSync(join(b.dir, 'paid-op.json'), journal);
    aged(b.path, JSON.stringify(dead));
    const args = ['unlock', '--rail', 'solana', '--op', 'paid-op'];
    expect(cli(b.home, args).result).toMatchObject({ state: 'refused_precheck', reason: 'confirmation_required' });
    expect(cli(b.home, [...args, '--confirm']).result).toMatchObject({ state: 'ok', op: 'paid-op' });
    expect(readFileSync(join(b.dir, 'paid-op.json'), 'utf8')).toBe(journal);
    writeFileSync(b.path, String(process.pid));
    expect(cli(b.home, [...args, '--confirm']).result).toMatchObject({ reason: 'op_in_progress' });
    expect(readFileSync(b.path, 'utf8')).toBe(String(process.pid));
  });
  it('busy reconcile reports the op, foreign holder, lock path and safe unlock command', () => {
    const b = box();
    writeFileSync(b.path.replace('.json.lock', '.buy.lock'), JSON.stringify({ ...dead, namespace: 'pid:[foreign]', heartbeatAt: Date.now(), createdAt: Date.now() }));
    const r = cli(b.home, ['reconcile', '--rail', 'solana', '--op', 'paid-op']);
    expect(r.status).toBe(5);
    expect(r.result).toMatchObject({ op: 'paid-op', state: 'unknown', reason: 'op_in_progress' });
    expect(r.result.next).toContain('another container');
    expect(r.result.next).toContain('superstables budget unlock --rail solana --chain devnet --op paid-op --confirm');
    expect(r.result.next).toContain('.buy.lock');
  });
  for (const rail of ['solana', 'evm', 'tempo']) {
    it(`${rail} direct reconcile emits op_in_progress without a stack trace`, () => {
      const b = box();
      const dir = join(b.home, 'budget/ops', rail === 'evm' ? 'evm-base-sepolia' : rail === 'tempo' ? 'tempo-moderato' : 'solana-devnet');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'paid-op.json.lock'), String(process.pid));
      const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, `budget/${rail}/reconcile.${rail === 'solana' ? 'mjs' : 'ts'}`), '--op', 'paid-op'], { cwd: root, env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8' });
      expect(r.status).toBe(5);
      const line = r.stdout.trim().split('\n').reverse().find(l => l.startsWith('RESULT '));
      expect(line && JSON.parse(line.slice(7))).toMatchObject({ op: 'paid-op', state: 'unknown', reason: 'op_in_progress' });
      expect(r.stderr).not.toContain('at ');
    });
  }
});

it('Solana check with a local refusing seller never downgrades an existing settled journal', async () => {
  const b = box();
  const journal = JSON.stringify({ op: 'paid-op', rail: 'solana', kind: 'buy', state: 'settled', tx: '5sig', agentSig: '5sig', debit: '0.01', delivered: true, history: [] });
  writeFileSync(join(b.dir, 'paid-op.json'), journal);
  const seller = createServer((_q, r) => { r.writeHead(402, { 'content-type': 'application/json' }); r.end('{"x402Version":1,"accepts":[]}'); });
  await new Promise<void>(done => seller.listen(0, '127.0.0.1', done));
  try {
    const address = seller.address();
    if (!address || typeof address === 'string') throw new Error('no seller port');
    const child = spawn(process.execPath, [join(root, 'budget/solana/buy.mjs'), '--check', '--op', 'paid-op', '--url', `http://127.0.0.1:${address.port}/x`], { env: { ...process.env, SUPERSTABLES_HOME: b.home } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume();
    const code = await new Promise<number | null>((done, fail) => { child.once('close', done); child.once('error', fail); });
    expect(readFileSync(join(b.dir, 'paid-op.json'), 'utf8')).toBe(journal);
    expect(code).toBe(3);
    const result = output.split('\n').find(line => line.startsWith('RESULT '));
    expect(result && JSON.parse(result.slice(7))).toMatchObject({ reason: 'op_already_exists' });
  } finally { seller.close(); }
});

async function probe(b: ReturnType<typeof box>, action: string) {
  const p = spawn(process.execPath, [join(import.meta.dirname, '../helpers/budget-lock-probe.mjs')], {
    env: { ...process.env, PROBE_ROOT: root, PROBE_PATH: b.path, PROBE_ACTION: action },
  });
  let text = '';
  p.stderr.on('data', chunk => { text += chunk; });
  const ready = await new Promise<string>((done, fail) => {
    p.stdout.once('data', chunk => done(String(chunk).trim()));
    p.once('error', fail);
    p.once('exit', () => fail(new Error(text)));
  });
  return { p, ready };
}
it('refreshes the lock inode heartbeat while working and protects a SIGSTOPped local holder', async () => {
  const b = box();
  const { p } = await probe(b, 'heartbeat');
  try {
    const text = readFileSync(b.path, 'utf8');
    const before = statSync(b.path).mtimeMs;
    await sleep(16_000);
    expect(statSync(b.path).mtimeMs).toBeGreaterThan(before);
    expect(readFileSync(b.path, 'utf8')).toBe(text);
    p.kill('SIGSTOP');
    writeFileSync(b.path, JSON.stringify({ ...JSON.parse(text), heartbeatAt: old }));
    utimesSync(b.path, old / 1000, old / 1000);
    expect(locks.lockFile(b.path).ok).toBe(false);
  } finally { p.kill('SIGCONT'); p.kill('SIGKILL'); await new Promise<void>(done => p.once('close', () => done())); }
}, 25_000);
it('retains the dispatcher lock after a rail-child record write fails until that child exits', async () => {
  const b = box();
  const { p, ready } = await probe(b, 'failed-child-write');
  try {
    expect(JSON.parse(ready).retained).toBe(true);
    expect(locks.lockFile(b.path).ok).toBe(false);
    p.stdin.end('exit');
    await new Promise<void>(done => p.once('close', () => done()));
    const lock = locks.lockFile(b.path);
    expect(lock.ok).toBe(true);
    if (lock.ok) lock.release();
  } finally { p.kill('SIGKILL'); }
});

it('recovers an old permission-denied lock file without reading it', () => {
  const b = box();
  aged(b.path, '{');
  chmodSync(b.path, 0);
  const lock = locks.lockFile(b.path);
  expect(lock.ok).toBe(true);
  if (lock.ok) lock.release();
});
for (const entry of ['legacy file', 'empty owner', 'stray entry']) {
  it(`unlock clears an abandoned ${entry} breaker even without a main lock`, () => {
    const b = box();
    const mutex = b.path + '.break';
    if (entry === 'legacy file') aged(mutex);
    else { mkdirSync(mutex); aged(join(mutex, entry === 'empty owner' ? '0a1b2c3d-0000-4000-8000-000000000000.owner' : '.DS_Store')); utimesSync(mutex, old / 1000, old / 1000); }
    expect(cli(b.home, ['unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm']).result).toMatchObject({ state: 'ok', reason: 'locks_cleared' });
    expect(existsSync(mutex)).toBe(false);
  });
}
it('reconcile names the live breaker owner that prevents dead-lock recovery', () => {
  const b = box();
  const path = b.path.replace('.json.lock', '.buy.lock');
  aged(path, JSON.stringify(dead));
  mkdirSync(path + '.break');
  const ownerPath = join(path + '.break', '0a1b2c3d-0000-4000-8000-000000000000.owner');
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, namespace }));
  const r = cli(b.home, ['reconcile', '--rail', 'solana', '--op', 'paid-op']);
  expect(r.result).toMatchObject({ reason: 'op_in_progress' });
  expect(r.result.next).toContain(`held by process ${process.pid}`);
  expect(r.result.next).toContain(ownerPath);
});

it('does not clear an old regular-file breaker with a verifiable live owner', () => {
  const b = box();
  aged(b.path, JSON.stringify(dead));
  aged(b.path + '.break', JSON.stringify({ pid: process.pid, namespace, heartbeatAt: old }));
  expect(locks.lockFile(b.path).ok).toBe(false);
  expect(existsSync(b.path + '.break')).toBe(true);
});
