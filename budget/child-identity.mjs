import { spawn } from 'node:child_process';

const starts = new WeakMap();
const preload = 'data:text/javascript;base64,' + Buffer.from(`
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
if (process.ppid === ${process.pid}) {
  const pipe = new Socket({ fd: 3 });
  let acknowledged = false;
  await new Promise(resolve => {
    pipe.once('data', data => { if (String(data) !== '1') process.exit(1); acknowledged = true; resolve(); });
    pipe.once('end', () => { if (!acknowledged) process.exit(1); });
    pipe.once('error', () => { if (!acknowledged) process.exit(1); });
    pipe.write(JSON.stringify({ pid: process.pid, selfStartedAt: performance.timeOrigin }) + '\\n');
  });
  pipe.destroy();
}
`).toString('base64');

export function spawnIdentified(command, args, options, platform = process.platform) {
  if (platform !== 'darwin') return spawn(command, args, options);
  const env = options.env ?? process.env;
  const child = spawn(command, args, { ...options, env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${preload}` }, stdio: [...options.stdio, 'pipe'] });
  const pipe = child.stdio[3];
  if (!pipe) return child;
  let text = '';
  pipe.setEncoding('utf8');
  pipe.on('error', () => {});
  const receive = chunk => {
    text += chunk;
    if (text.length > 1024) { pipe.destroy(); return; }
    if (!text.endsWith('\n')) return;
    pipe.removeListener('data', receive);
    let value;
    try { value = JSON.parse(text); } catch { pipe.destroy(); return; }
    if (value?.pid !== child.pid || typeof value.selfStartedAt !== 'number' || !Number.isFinite(value.selfStartedAt) || value.selfStartedAt <= 0) { pipe.destroy(); return; }
    starts.set(child, value.selfStartedAt);
    child.emit('identity', value.selfStartedAt);
    pipe.end('1');
  };
  pipe.on('data', receive);
  return child;
}

export const childStartedAt = child => starts.get(child);
