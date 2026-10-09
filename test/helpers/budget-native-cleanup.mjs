import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { holderRunning } from './budget-holder-cleanup.mjs';

export function nativeExecutable(command) {
  const located = command.includes('/') ? command : spawnSync('which', [command], { encoding: 'utf8' }).stdout?.trim();
  assert.ok(located, `cannot find executable ${command}`);
  const path = realpathSync(located);
  const fd = openSync(path, 'r');
  const prefix = Buffer.alloc(2);
  try { readSync(fd, prefix, 0, 2, 0); } finally { closeSync(fd); }
  assert.notEqual(prefix.toString(), '#!', `CODEX_BIN is a script launcher (${path}); set CODEX_BIN to the real vendor/*/bin/codex binary`);
  return path;
}

export function matchingProcesses(marker) {
  const result = spawnSync('ps', ['axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match || !match[2].includes(marker)) return [];
    const pid = Number(match[1]);
    return pid !== process.pid && holderRunning(pid) ? [pid] : [];
  });
}

export function assertNoMatchingProcesses(marker) {
  assert.deepEqual(matchingProcesses(marker), [], `processes outlived fixture ${marker}`);
}

export async function stopMatchingProcesses(marker) {
  const until = Date.now() + 5000;
  for (;;) {
    const pids = matchingProcesses(marker);
    if (!pids.length) return;
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
    if (Date.now() >= until) break;
    await sleep(20);
  }
  assertNoMatchingProcesses(marker);
}
