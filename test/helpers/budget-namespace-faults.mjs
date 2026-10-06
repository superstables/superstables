// Fault each filesystem boundary of heartbeat and release in a real PID namespace.
// Run: node test/helpers/budget-namespace-faults.mjs [--long-pause]
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.platform !== 'linux') { console.log('skipped: real PID namespace faults require Linux and bwrap'); process.exit(0); }
const root = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === 'worker') {
  const [home, action, step, phase] = process.argv.slice(3);
  const interval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 15000 ? 50 : ms, ...args);
  const send = event => console.log(JSON.stringify(event));
  const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
  const path = join(home, 'budget/ops/solana-devnet/paid-op.json.lock');
  const lock = lockFile(path); assert.equal(lock.ok, true);
  const hostPid = Number(fs.readFileSync(join(home, 'host-proc/self/status'), 'utf8').match(/^Pid:\s+(\d+)/m)[1]);
  send({ event: 'held', hostPid });
  let calls = 0;
  const descriptors = new Map();
  for (const name of ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'fstatSync', 'linkSync', 'lstatSync', 'readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'closeSync', 'futimesSync']) {
    const real = fs[name];
    fs[name] = function (...args) {
      const target = typeof args[0] === 'number' ? descriptors.get(args[0]) : String(args[0]);
      // Heartbeat fd predates instrumentation; futimes and fsync still count.
      const relevant = target?.startsWith(home) || (action === 'heartbeat' && typeof args[0] === 'number') || (action === 'release' && name === 'fstatSync');
      const index = relevant ? ++calls : 0;
      const pause = when => {
        if (relevant && ((Number(step) > 0 && index === Number(step)) || (step === 'unlink' && name === 'unlinkSync' && target === path)) && phase === when) { send({ event: 'paused', name, phase, index }); process.kill(process.pid, 'SIGSTOP'); }
      };
      pause('before'); const result = real.apply(this, args);
      if (name === 'openSync') descriptors.set(result, target);
      if (name === 'closeSync') descriptors.delete(args[0]);
      pause('after');
      if (action === 'heartbeat' && name === 'fsyncSync') send({ event: 'done', calls });
      return result;
    };
  }
  syncBuiltinESMExports();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', command => {
    command = command.trim();
    if (command === 'go') {
      if (action === 'release') { lock.release(); send({ event: 'done', calls }); }

    }
  });
  setInterval(() => {}, 1000);
} else {
  const { lockFile, abandonedBreaker } = await import(join(root, 'budget/op-lock.mjs'));
  const children = new Set();
  const homes = new Set();
  const stop = () => {
    for (const child of children) { if (child.hostPid) { try { process.kill(child.hostPid, 'SIGCONT'); process.kill(child.hostPid, 'SIGKILL'); } catch {} } child.p.kill('SIGKILL'); }
  };
  process.once('SIGTERM', () => { stop(); process.exit(143); });
  process.once('SIGINT', () => { stop(); process.exit(130); });
  let cases = 0, fired = 0;
  function box() {
    const home = fs.mkdtempSync(join(tmpdir(), 'budget-namespace-fault-')); homes.add(home);
    fs.mkdirSync(join(home, 'budget/ops/solana-devnet'), { recursive: true }); fs.mkdirSync(join(home, 'host-proc'));
    return { home, path: join(home, 'budget/ops/solana-devnet/paid-op.json.lock') };
  }
  async function worker(b, action, step, phase) {
    const p = spawn('/usr/bin/bwrap', ['--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--ro-bind', '/proc', join(b.home, 'host-proc'), '--proc', '/proc', process.execPath, script, 'worker', b.home, action, String(step), phase]);
    const state = { p, events: [], hostPid: null, exited: false, error: '' }; children.add(state);
    p.stderr.on('data', c => { state.error += c; });
    let stdout = '';
    p.stdout.on('data', chunk => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const index = stdout.indexOf('\n'); const e = JSON.parse(stdout.slice(0, index)); stdout = stdout.slice(index + 1);
        state.events.push(e); if (e.hostPid) state.hostPid = e.hostPid;
      }
    });
    p.on('exit', () => { state.exited = true; });
    state.wait = async names => {
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        const event = state.events.find(e => names.includes(e.event)); if (event) return event;
        if (state.exited) throw new Error(`bwrap exited: ${state.error}`); await sleep(3);
      }
      throw new Error(`timeout ${JSON.stringify(state.events)} ${state.error}`);
    };
    await state.wait(['held']); return state;
  }
  async function kill(state) {
    if (!state.exited) {
      const done = new Promise(r => state.p.once('exit', r));
      try { process.kill(state.hostPid, 'SIGKILL'); } catch {} state.p.kill('SIGKILL'); await done;
    }
    children.delete(state);
  }
  function confirmed(b) {
    const result = spawnSync(process.execPath, ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'], { env: { ...process.env, SUPERSTABLES_HOME: b.home }, encoding: 'utf8', input: 'paid-op\n' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  }
  function tryBusy(b) {
    const r = lockFile(b.path); assert.equal(r.ok, false, 'automatically took a foreign holder');
  }
  async function run(action, step, phase, crash) {
    const b = box(); const state = await worker(b, action, step, phase);
    try {
      state.p.stdin.write('go\n');
      const event = await state.wait(['paused', 'done']);
      let successor;
      if (event.event === 'paused') {
        fired++;
        // The IPC event precedes SIGSTOP. Wait for the actual kernel state.
        while (!fs.readFileSync(`/proc/${state.hostPid}/stat`, 'utf8').includes(') T ')) await sleep(3);
        if (fs.existsSync(b.path)) { for (let i = 0; i < 3; i++) tryBusy(b); }
        else { successor = lockFile(b.path); assert.equal(successor.ok, true); }
        if (crash) await kill(state);
        else { process.kill(state.hostPid, 'SIGCONT'); await state.wait(['done']); }
      }
      if (successor?.ok) {
        assert.equal(JSON.parse(fs.readFileSync(b.path, 'utf8')).pid, process.pid, 'resumed release deleted successor');
        tryBusy(b);
        if (state.exited) abandonedBreaker(b.path, { confirmUnverifiable: true });
        successor.release();
      }
      await kill(state);
      if (fs.existsSync(b.path)) tryBusy(b);
      if (fs.existsSync(b.path) || fs.existsSync(b.path + '.break')) confirmed(b);
      const next = lockFile(b.path); assert.equal(next.ok, true, 'blocked after confirmed recovery'); if (next.ok) next.release();
      cases++; if (cases % 20 === 0) console.log(JSON.stringify({ cases, fired }));
    } finally { await kill(state); fs.rmSync(b.home, { recursive: true, force: true }); homes.delete(b.home); }
  }
  try {
    if (process.argv.includes('--override-unlock')) {
      const b = box(); const state = await worker(b, 'release', 0, 'before');
      const unlock = spawn(process.execPath, ['--import', join(root, 'test/helpers/budget-owner-terminal.mjs'), '--import', join(root, 'test/helpers/budget-unlock-pause.mjs'), join(root, 'budget/cli.mjs'), 'unlock', '--rail', 'solana', '--op', 'paid-op', '--confirm'], { env: { ...process.env, SUPERSTABLES_HOME: b.home, BUDGET_TEST_PAUSE_LOCK: b.path } });
      let stderr = ''; unlock.stderr.on('data', data => { stderr += data; });
      let stdout = '';
      let successor;
      try {
        const exited = new Promise(resolve => unlock.once('exit', resolve));
        const paused = new Promise((resolve, reject) => {
          unlock.stdout.on('data', data => { stdout += data; if (stdout.includes('unlock-paused')) resolve(); });
          unlock.once('exit', () => { if (!stdout.includes('unlock-paused')) reject(new Error(`unlock exited without pausing: ${stderr}`)); });
        });
        unlock.stdin.end('paid-op\n'); await paused;
        while (!fs.readFileSync(`/proc/${unlock.pid}/stat`, 'utf8').includes(') T ')) await sleep(3);
        // The inspected holder finishes normally, then a new holder publishes before unlock resumes.
        state.p.stdin.write('go\n'); await state.wait(['done']); assert.equal(fs.existsSync(b.path), false);
        successor = lockFile(b.path); assert.equal(successor.ok, true);
        unlock.kill('SIGCONT'); assert.equal(await exited, 0, stderr);
        assert.equal(fs.existsSync(b.path), false, 'documented unlock race changed');
        const third = lockFile(b.path); assert.equal(third.ok, true); if (third.ok) third.release();
        assert.ok(stderr.includes("unlock paused before unlinking can remove a new holder's lock"));
        console.log(JSON.stringify({ result: 'documented-risk-reproduced', unlockRemovedNewHolder: true, thirdAcquired: true }));
      } finally { unlock.kill('SIGCONT'); unlock.kill('SIGKILL'); if (successor?.ok) successor.release(); await kill(state); fs.rmSync(b.home, { recursive: true, force: true }); homes.delete(b.home); }
    } else if (process.argv.includes('--long-release') || process.argv.includes('--override-release')) {
      const b = box(); const state = await worker(b, 'release', 'unlink', 'before');
      try {
        state.p.stdin.write('go\n'); await state.wait(['paused']);
        while (!fs.readFileSync(`/proc/${state.hostPid}/stat`, 'utf8').includes(') T ')) await sleep(3);
        if (process.argv.includes('--override-release')) {
          confirmed(b);
          const successor = lockFile(b.path); assert.equal(successor.ok, true);
          process.kill(state.hostPid, 'SIGCONT'); await state.wait(['done']);
          assert.equal(fs.existsSync(b.path), false, 'documented override race changed');
          console.log(JSON.stringify({ result: 'documented-risk-reproduced', successorLockRemoved: true }));
          if (successor.ok) successor.release();
        } else {
          console.log(JSON.stringify({ event: 'long-release-started', hostPid: state.hostPid }));
          for (let i = 0; i < 31; i++) { await sleep(10000); tryBusy(b); }
          process.kill(state.hostPid, 'SIGCONT'); await state.wait(['done']);
          assert.equal(fs.existsSync(b.path), false);
          const successor = lockFile(b.path); assert.equal(successor.ok, true); tryBusy(b); if (successor.ok) successor.release();
          console.log(JSON.stringify({ result: 'pass', releasePauseMs: 310000, attempts: 31 }));
        }
      } finally { await kill(state); fs.rmSync(b.home, { recursive: true, force: true }); homes.delete(b.home); }
    } else if (process.argv.includes('--long-pause')) {
      const b = box(); const state = await worker(b, 'hold', 0, 'before');
      try {
        process.kill(state.hostPid, 'SIGSTOP'); console.log(JSON.stringify({ event: 'long-pause-started', hostPid: state.hostPid }));
        for (let i = 0; i < 31; i++) { await sleep(10000); tryBusy(b); }
        const text = fs.readFileSync(b.path, 'utf8'); process.kill(state.hostPid, 'SIGCONT'); await sleep(100);
        assert.equal(fs.readFileSync(b.path, 'utf8'), text); tryBusy(b);
        await kill(state); confirmed(b); console.log(JSON.stringify({ result: 'pass', pauseMs: 310000, attempts: 31 }));
      } finally { await kill(state); fs.rmSync(b.home, { recursive: true, force: true }); homes.delete(b.home); }
    } else {
      // Discover release calls, then fault every boundary before/after, pause/kill.
      const b = box(); const sample = await worker(b, 'release', 0, 'before'); sample.p.stdin.write('go\n');
      const { calls } = await sample.wait(['done']); await kill(sample); fs.rmSync(b.home, { recursive: true, force: true }); homes.delete(b.home);
      for (let step = 1; step <= calls; step++) for (const phase of ['before', 'after']) for (const crash of [false, true]) await run('release', step, phase, crash);
      // Fire the real heartbeat callback through a shortened test interval.
      for (let step = 1; step <= 2; step++) for (const phase of ['before', 'after']) for (const crash of [false, true]) await run('heartbeat', step, phase, crash);
      console.log(JSON.stringify({ result: 'pass', cases, fired, doubleHolders: 0, lostSuccessors: 0, automaticForeignTakeovers: 0 }));
    }
  } finally { stop(); for (const home of homes) fs.rmSync(home, { recursive: true, force: true }); }
}
