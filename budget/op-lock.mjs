import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { processStart, sameProcess } from './procs.mjs';
import { join } from 'node:path';

function namespace() {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}
const pidNamespace = namespace();
const identity = () => ({ pid: process.pid, pidStart: processStart(process.pid) ?? null, namespace: pidNamespace });
function live(owner) {
  if (owner.namespace && owner.namespace !== pidNamespace) return true;
  return sameProcess(owner.pid, owner.pidStart)
    || (Number.isSafeInteger(owner.railPid) && owner.railPid > 0 && sameProcess(owner.railPid, owner.railPidStart));
}
function holder(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const value = JSON.parse(text);
    // Older Solana locks contain only a PID. Keep their conservative PID check.
    const owner = typeof value === 'number' ? { pid: value } : value;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return { text, pid: owner.pid, live: live(owner) };
  } catch {}
  // No clock can prove an unrecognised lock's owner dead.
  return { text, pid: null, live: true };
}

function removeBreaker(path, generation) {
  // Only the process that removes this generation may remove the directory.
  // A cleaner paused before unlink cannot remove a successor's unique record.
  try { unlinkSync(join(path, generation)); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  try { rmdirSync(path); }
  catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
}
function clearDeadBreaker(path) {
  try {
    const records = readdirSync(path);
    // Publication always installs a populated directory. An empty directory is
    // a release interrupted after its generation was removed. rmdir is atomic
    // and refuses a successor that has since published its owner record.
    if (records.length === 0) { rmdirSync(path); return; }
    if (records.length !== 1 || !/^[0-9a-f-]+\.owner$/.test(records[0])) return;
    const owner = holder(join(path, records[0]));
    if (owner && !owner.live) removeBreaker(path, records[0]);
  } catch (err) {
    // Legacy, ownerless mutex files cannot be proven dead. Leave them busy.
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
  }
}
function breakStale(path, staleText) {
  const mutex = `${path}.break`;
  const generation = `${randomUUID()}.owner`;
  const tmp = `${mutex}.${randomUUID()}.tmp`;
  mkdirSync(tmp, { mode: 0o700 });
  writeFileSync(join(tmp, generation), JSON.stringify(identity()), { mode: 0o600, flag: 'wx' });
  let published = false;
  try {
    try { renameSync(tmp, mutex); published = true; }
    catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(err.code)) throw err;
      clearDeadBreaker(mutex);
      return;
    }
    const current = holder(path);
    if (current && current.text === staleText && !current.live) unlinkSync(path);
  } finally {
    removeBreaker(published ? mutex : tmp, generation);
  }
}

/**
 * Complete-file publication, liveness-checked takeover, and release of only this generation.
 * @returns {{ ok: true, release: () => void, holdAlso: (pid: number | undefined) => void } | { ok: false, holder: number | null }}
 */
export function lockFile(path) {
  const owner = { ...identity(), token: randomUUID(), createdAt: Date.now() };
  let railOwner = null;
  let text = JSON.stringify(owner);
  const tmp = `${path}.${owner.token}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { linkSync(tmp, path); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const current = holder(path);
        if (!current) continue;
        if (current.live) return { ok: false, holder: current.pid };
        breakStale(path, current.text);
        continue;
      }
      const release = () => {
        if (railOwner && sameProcess(railOwner.pid, railOwner.pidStart)) return;
        const current = holder(path);
        // A live releaser cannot be taken over between this comparison and unlink.
        if (current?.text === text) unlinkSync(path);
        process.removeListener('exit', release);
      };
      const holdAlso = (pid) => {
        if (!pid || holder(path)?.text !== text) return;
        const child = { pid, pidStart: processStart(pid) ?? null };
        const next = JSON.stringify({ ...owner, railPid: child.pid, railPidStart: child.pidStart });
        const update = `${path}.${randomUUID()}.tmp`;
        try {
          writeFileSync(update, next, { mode: 0o600, flag: 'wx' });
          renameSync(update, path);
          text = next;
          railOwner = child;
        } finally {
          try { unlinkSync(update); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      };
      process.on('exit', release);
      return { ok: true, release, holdAlso };
    }
    return { ok: false, holder: holder(path)?.pid ?? null };
  } finally {
    unlinkSync(tmp);
  }
}

/** Rail commands hold the journal lock before reading, through their last write. */
export function lockRecord(dir, op) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return lockFile(join(dir, `${op}.json.lock`));
}

export function requireRecordLock(dir, op) {
  const lock = lockRecord(dir, op);
  if (!lock.ok) throw Object.assign(new Error(`operation ${op} is being worked by another process${lock.holder ? ` (pid ${lock.holder})` : ''}`), { code: 'OP_IN_PROGRESS' });
  return lock;
}
