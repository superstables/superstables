import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { PROBE_ROOT: root, PROBE_HOME: home, PROBE_ACTION: action } = process.env;
const path = join(home, 'budget/ops/solana-devnet/paid-op.json.lock');
const interval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 15000 ? 100 : ms, ...args);
if (process.env.PROBE_SKEW) { const now = Date.now; Date.now = () => now() + Number(process.env.PROBE_SKEW); }
syncBuiltinESMExports();
const { lockFile } = await import(join(root, 'budget/op-lock.mjs'));
const lock = lockFile(path);
const hostPid = process.platform === 'linux' && process.env.HOST_PROC ? Number(fs.readFileSync(join(process.env.HOST_PROC, 'self/status'), 'utf8').match(/^Pid:\s+(\d+)/m)[1]) : process.pid;
console.log(JSON.stringify({ ok: lock.ok, pid: hostPid }));
if (action === 'hold' && lock.ok) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', command => {
    if (command.trim() === 'release') { lock.release(); console.log('released'); }
    if (command.trim() === 'exit') process.exit(0);
  });
  interval(() => {}, 1000);
} else { if (lock.ok) lock.release(); process.exit(0); }
