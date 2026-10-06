// Real-process lock fault matrix. Run: node test/helpers/budget-lock-faults.mjs [single|pairs]
// Pair ranges can be bounded with --start=N --end=N, numbered from 1 through 576.
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const script = fileURLToPath(import.meta.url);
const root = resolve(process.env.BUDGET_RACE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));
if (process.argv[2] === 'worker') {
  const [home, action, fault, phase, scope] = process.argv.slice(3);
  const protocolCalls = new Set(['writeFileSync', 'linkSync', 'lstatSync', 'readFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmdirSync']);
  const descriptors = new Map();
  let calls = 0;
  for (const name of ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'linkSync', 'lstatSync', 'readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'closeSync', 'futimesSync']) {
    const real = fs[name];
    fs[name] = function (...args) {
      const path = typeof args[0] === 'number' ? descriptors.get(args[0]) : String(args[0]);
      const relevant = path?.startsWith(home) && (scope !== 'protocol' || protocolCalls.has(name));
      const index = relevant ? ++calls : 0;
      const pause = when => {
        if (relevant && index === Number(fault) && phase === when) {
          process.send({ event: 'paused', index, name, phase });
          process.kill(process.pid, 'SIGSTOP');
        }
      };
      pause('before');
      const result = real.apply(this, args);
      if (name === 'openSync') descriptors.set(result, path);
      if (name === 'closeSync') descriptors.delete(args[0]);
      pause('after');
      return result;
    };
  }
  syncBuiltinESMExports();
  try {
    const { lockFile } = await import(pathToFileURL(join(root, 'budget/op-lock.mjs')));
    const lock = lockFile(join(home, 'op.lock'));
    if (lock.ok) {
      process.send({ event: 'holding' });
      if (action === 'release') { process.send({ event: 'released' }); lock.release(); }
    }
    process.send({ event: 'done', ok: lock.ok, calls });
    if (lock.ok && action === 'hold') setInterval(() => {}, 1000);
    else process.exit(0);
  } catch (err) { process.send({ event: 'error', message: err.stack }); process.exit(1); }
} else {
  const children = new Set();
  const first = Number(process.argv.find(arg => arg.startsWith('--start='))?.split('=')[1] ?? 1);
  const last = Number(process.argv.find(arg => arg.startsWith('--end='))?.split('=')[1] ?? 576);
  assert.ok(Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last <= 576 && first <= last, 'invalid pair range');
  const stopChildren = () => { for (const child of children) child.kill('SIGKILL'); };
  process.once('SIGTERM', () => { stopChildren(); process.exit(143); });
  process.once('SIGINT', () => { stopChildren(); process.exit(130); });
  let cases = 0, stops = 0;
  async function worker(home, action = 'hold', fault = 0, phase = 'before') {
    const p = fork(script, ['worker', home, action, String(fault), phase, process.argv[2] === 'pairs' ? 'protocol' : 'all'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.add(p);
    const state = { p, home, held: false, events: [], error: '', exited: false };
    p.stderr.on('data', chunk => { state.error += chunk; });
    p.on('message', event => {
      state.events.push(event);
      if (event.event === 'holding') state.held = true;
      if (event.event === 'released') state.held = false;
    });
    p.on('exit', () => { state.exited = true; state.held = false; children.delete(p); });
    state.wait = async (names = ['paused', 'done']) => {
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        const event = state.events.find(e => names.includes(e.event) || e.event === 'error');
        if (event?.event === 'error') throw new Error(event.message);
        if (event) return event;
        if (state.exited) throw new Error(`worker exited before ${names}: ${state.error}`);
        await new Promise(r => setTimeout(r, 3));
      }
      throw new Error(`worker timeout: ${JSON.stringify(state.events)} ${state.error}`);
    };
    return state;
  }
  async function kill(state) {
    if (state.exited) return;
    state.p.kill('SIGKILL');
    await new Promise(r => state.p.once('exit', r));
  }
  function oneHolder(states) {
    const holders = states.filter(s => s.held);
    assert.ok(holders.length <= 1, 'two concurrent holders');
    if (holders.length) {
      const owner = JSON.parse(fs.readFileSync(join(holders[0].home, 'op.lock'), 'utf8'));
      assert.ok(owner.pid === holders[0].p.pid || owner.railPid === holders[0].p.pid, 'live holder lost its lock');
    }
  }
  async function box(scenario) {
    const home = fs.mkdtempSync(join(tmpdir(), 'budget-lock-fault-'));
    const states = [];
    if (scenario === 'live' || scenario === 'rail-child') {
      const holder = await worker(home); states.push(holder); assert.equal((await holder.wait(['done'])).ok, true);
      if (scenario === 'rail-child') {
        // The recorded dispatcher is dead but its verifiable rail child remains alive.
        const file = join(home, 'op.lock');
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...rec, pid: 2147483646, pidStart: null, railPid: holder.p.pid, railPidStart: rec.pidStart }));
      }
    } else if (scenario === 'stale') fs.writeFileSync(join(home, 'op.lock'), JSON.stringify({pid:2147483646, platform:process.platform, hostname:hostname(), bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(), namespace:fs.readlinkSync('/proc/self/ns/pid')}));
    return { home, states };
  }
  async function contenders(b) {
    for (let i = 0; i < 2; i++) {
      const next = await worker(b.home); b.states.push(next); await next.wait(['done']); oneHolder(b.states);
    }
  }
  async function finish(b) {
    for (const state of b.states) await kill(state);
    const fresh = await worker(b.home); b.states.push(fresh);
    assert.equal((await fresh.wait(['done'])).ok, true, 'permanent block after killed holders');
    await kill(fresh); fs.rmSync(b.home, { recursive: true, force: true });
    cases++;
    if (cases % 25 === 0) console.log(JSON.stringify({ progress: cases, stops }));
  }
  try {
    if (process.argv[2] !== 'pairs') {
      const selected = process.argv.find(arg => arg.startsWith('--scenario='))?.split('=')[1];
      assert.ok(!selected || ['stale', 'free', 'live', 'rail-child'].includes(selected), 'invalid scenario');
      for (const scenario of selected ? [selected] : ['stale', 'free', 'live', 'rail-child']) {
        for (const action of scenario === 'stale' || scenario === 'free' ? ['hold', 'release'] : ['hold']) {
          const sample = await box(scenario);
          const discovery = await worker(sample.home, action); sample.states.push(discovery);
          const n = (await discovery.wait(['done'])).calls;
          await finish(sample); cases--;
          for (let step = 1; step <= n; step++) for (const phase of ['before', 'after']) for (const crash of [false, true]) {
            const b = await box(scenario);
            const target = await worker(b.home, action, step, phase); b.states.push(target);
            const event = await target.wait();
            if (event.event === 'paused') {
              stops++;
              await contenders(b);
              if (crash) await kill(target);
              else { target.p.kill('SIGCONT'); await target.wait(['done']); }
              oneHolder(b.states);
              await contenders(b);
            }
            await finish(b);
          }
        }
      }
    } else {
      // These 12 calls cover publication, both holder reads, stale unlink, and breaker cleanup.
      // Fsync and descriptor calls are covered exhaustively by the single-fault matrix.
      let ordinal = 0;
      for (let i = 1; i <= 12; i++) for (let j = 1; j <= 12; j++) for (const order of [0, 1]) for (const crash of [false, true]) {
        if (++ordinal < first || ordinal > last) continue;
        const b = await box('stale');
        const a = await worker(b.home, 'hold', i, 'before'); b.states.push(a); await a.wait();
        const second = await worker(b.home, 'hold', j, 'before'); b.states.push(second); await second.wait();
        await contenders(b);
        const ordered = order ? [second, a] : [a, second];
        for (const [index, state] of ordered.entries()) {
          if (state.events.some(e => e.event === 'paused')) {
            stops++;
            if (crash && index === 0) await kill(state);
            else { state.p.kill('SIGCONT'); await state.wait(['done']); }
          }
          oneHolder(b.states);
          await contenders(b);
        }
        await finish(b);
      }
    }
    console.log(JSON.stringify({ cases, stops, ...(process.argv[2] === 'pairs' ? { first, last } : {}), doubleHolders: 0, permanentBlocks: 0, result: 'pass' }));
  } finally { stopChildren(); }
}
