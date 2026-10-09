import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export function holderRunning(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
    }
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (['ENOENT', 'ESRCH'].includes(err.code)) return false;
    throw err;
  }
}

export async function assertHolderStopped(pid) {
  const until = Date.now() + 5000;
  while (holderRunning(pid) && Date.now() < until) await sleep(10);
  assert.equal(holderRunning(pid), false, `holder ${pid} outlived its test`);
}

export async function stopHolder(child, hostPid = child.pid) {
  const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
  for (const pid of new Set([hostPid, child.pid])) {
    if (!pid) continue;
    try { process.kill(pid, 'SIGKILL'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
  }
  await exited;
  if (hostPid) await assertHolderStopped(hostPid);
  if (child.pid) await assertHolderStopped(child.pid);
}
