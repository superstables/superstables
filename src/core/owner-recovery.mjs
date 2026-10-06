import { appendFileSync, existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createIdentitySource, inspectProcess, inspectLegacyCap } from './process-identity.mjs';

const identity = createIdentitySource();
export const paymentBusy = "The payment lock is held. Its process may still be running. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear payment locks.";
const snapshot = path => {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { file: false, text: null, version: null };
    let text = null;
    try { text = readFileSync(path, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; if (!['EACCES', 'EPERM'].includes(err.code)) throw err; }
    return { file: true, text, version: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}` };
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};
const unchanged = (path, before) => {
  const now = snapshot(path);
  return now?.version === before.version && now?.text === before.text;
};
export function inspectLockText(text, legacyCap = false) {
  try {
    const holder = JSON.parse(text);
    if (!holder || typeof holder !== 'object') return { state: 'alive', possiblyAlive: true };
    return legacyCap && !holder.bootId ? inspectLegacyCap(holder) : inspectProcess(holder);
  } catch { return { state: 'alive', possiblyAlive: true }; }
}
function permitted(check, options) {
  if (check.state === 'dead') return true;
  if (!check.possiblyAlive || !options.unverified) { options.onBlocked?.(check); return false; }
  options.onOverride?.();
  return true;
}

/** Distinguish missing targets, absent locks and the proof behind a refusal at the CLI boundary. */
export function recoveryResult(options, work) {
  let cleared = false, blocked = 'busy';
  const result = work({ ...options,
    onCleared: () => { cleared = true; },
    onBlocked: check => { blocked = check.possiblyAlive ? 'unverifiable' : 'busy'; },
  });
  return { outcome: result === 'not_found' ? 'not_found' : result ? (cleared ? 'locks_cleared' : 'no_lock') : blocked };
}

/** Owner recovery only, after the CLI's terminal confirmation. Keep the existing file-mutex protocol. */
export function withRecoveryMutex(path, work, options) {
  const me = JSON.stringify({ ...identity.record(), owner: randomUUID() });
  const mine = `${path}.${randomUUID()}.tmp`;
  const inspect = text => inspectLockText(text, path.endsWith('cap.lock.break'));
  writeFileSync(mine, me, { mode: 0o600, flag: 'wx' });
  try {
    try { linkSync(mine, path); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const before = snapshot(path);
      if (!before || !before.file || !permitted(inspect(before.text), options) || !unchanged(path, before)) return false;
      // Recheck liveness after a notice that may block, then check the generation immediately before unlink.
      if (!permitted(inspect(before.text), options) || !unchanged(path, before)) return false;
      unlinkSync(path);
      options.onCleared?.();
      try { linkSync(mine, path); } catch (err) { if (err.code === 'EEXIST') return false; throw err; }
    }
    return work();
  } finally {
    try { if (readFileSync(path, 'utf8') === me) unlinkSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    unlinkSync(mine);
  }
}
export function clearFileLock(path, options, inspect = inspectLockText) {
  if (!existsSync(path) && !existsSync(`${path}.break`)) return true;
  return withRecoveryMutex(`${path}.break`, () => {
    const before = snapshot(path);
    if (!before) return true;
    if (!before.file || !permitted(inspect(before.text), options) || !unchanged(path, before)) return false;
    if (!permitted(inspect(before.text), options) || !unchanged(path, before)) return false;
    unlinkSync(path);
    options.onCleared?.();
    return true;
  }, options);
}

export function recoverCap(home, options) {
  const path = join(home, 'records/cap.lock');
  return recoveryResult(options, recovery => clearFileLock(path, recovery, text => inspectLockText(text, true)));
}
export function recoverAttempt(home, id, options) {
  const dir = join(home, 'records'), ledger = join(dir, 'attempts.jsonl');
  if (!existsSync(ledger)) return { outcome: 'not_found' };
  const latest = () => {
    let found;
    for (const line of readFileSync(ledger, 'utf8').split('\n').filter(Boolean)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.id === id) found = row;
    }
    return found;
  };
  if (!latest()) return { outcome: 'not_found' };
  return recoveryResult(options, options => {
    if (!clearFileLock(join(dir, 'reconcile.lock'), options)) return false;
    return withRecoveryMutex(join(dir, 'reconcile.lock'), () => {
      const attempt = latest();
      if (!attempt) return 'not_found';
      if (!attempt.runner) return true;
      const inspect = () => inspectProcess({ ...attempt.runner, pidStart: attempt.runner.start });
      if (!permitted(inspect(), options)) return false;
      if (!permitted(inspect(), options) || JSON.stringify(latest()) !== JSON.stringify(attempt)) return false;
      // Append a new row. All payment, reservation, receipt and history evidence stays intact.
      const { runner, ...recovered } = attempt;
      const prefix = readFileSync(ledger, 'utf8').endsWith('\n') ? '' : '\n';
      appendFileSync(ledger, prefix + JSON.stringify(recovered) + '\n', { mode: 0o600 });
      options.onCleared?.();
      return true;
    }, options);
  });
}
