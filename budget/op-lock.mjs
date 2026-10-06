import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { processStart, sameProcess } from './procs.mjs';
import { dirname, join } from 'node:path';

export const LOCK_GRACE_MS = 5 * 60_000;
export const HEARTBEAT_MS = 15_000;
function namespace() {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}
const pidNamespace = namespace();
const identity = () => ({ pid: process.pid, pidStart: processStart(process.pid) ?? null, namespace: pidNamespace });
function syncDir(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableRecord(path, text) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function live(owner, heartbeat) {
  if (owner.namespace && owner.namespace !== pidNamespace) return Date.now() - heartbeat <= LOCK_GRACE_MS;
  for (const [pid, start] of [[owner.pid, owner.pidStart], [owner.railPid, owner.railPidStart]]) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    // PID liveness protects a SIGSTOPped holder regardless of its heartbeat.
    if (sameProcess(pid, start)) return true;
  }
  return false;
}
function holder(path) {
  let stat;
  try { stat = lstatSync(path); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  let text = null;
  try { text = readFileSync(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; }
  const version = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  try {
    const value = JSON.parse(text);
    const owner = typeof value === 'number' ? { pid: value } : value;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      const heartbeat = Math.max(stat.mtimeMs, Number.isFinite(owner.heartbeatAt) ? owner.heartbeatAt : 0);
      return { text, version, pid: owner.pid, owner, live: live(owner, heartbeat), directory: stat.isDirectory() };
    }
  } catch {}
  return { text, version, pid: null, owner: null, live: Date.now() - stat.mtimeMs <= LOCK_GRACE_MS, directory: stat.isDirectory() };
}
/** @returns {{ ok: false, holder: number | null, path: string, details: string }} */
function busy(path, current = holder(path)) {
  const owner = current?.owner;
  const time = Number.isFinite(owner?.createdAt) ? new Date(owner.createdAt).toISOString() : 'an unknown time';
  const details = owner?.namespace && owner.namespace !== pidNamespace
    ? `held by process ${owner.pid} in another container since ${time}; its heartbeat must be older than five minutes`
    : current?.pid ? `held by process ${current.pid} since ${time}; wait for it to exit`
    : `unreadable or unrecognised lock record; wait five minutes after its last change`;
  return { ok: false, holder: current?.pid ?? null, path, details: `${details} (${path})` };
}
function removeBreaker(path, generation) {
  try { unlinkSync(join(path, generation)); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  try { rmdirSync(path); }
  catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
}
function clearDeadBreaker(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) {
      if (Date.now() - stat.mtimeMs > LOCK_GRACE_MS && !holder(path)?.live) unlinkSync(path);
      return;
    }
    const records = readdirSync(path);
    if (records.length === 0) { rmdirSync(path); return; }
    const owners = records.map(name => ({ name, record: holder(join(path, name)) }));
    if (owners.some(({ record }) => record?.live)) return;
    // Unique owner names cannot belong to a successor. Stray entries are never
    // published by this protocol. rmdir refuses any newly published generation.
    for (const { name, record } of owners) {
      if (!/^[0-9a-f-]+\.owner$/.test(name) && Date.now() - stat.mtimeMs <= LOCK_GRACE_MS) return;
      if (record?.directory) return;
    }
    for (const { name } of owners) removeBreaker(path, name);
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EISDIR'].includes(err.code)) throw err;
  }
}
function withBreaker(path, action) {
  const mutex = `${path}.break`;
  const generation = `${randomUUID()}.owner`;
  const tmp = `${mutex}.${randomUUID()}.tmp`;
  mkdirSync(tmp, { mode: 0o700 });
  let published = false;
  try {
    durableRecord(join(tmp, generation), JSON.stringify(identity()));
    syncDir(tmp);
    try { renameSync(tmp, mutex); published = true; syncDir(dirname(path)); }
    catch (err) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(err.code)) throw err;
      clearDeadBreaker(mutex);
      return;
    }
    action();
  } finally {
    try { removeBreaker(published ? mutex : tmp, generation); }
    finally { if (!published) { try { rmdirSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; } } }
  }
}

function breakStale(path, stale) {
  withBreaker(path, () => {
    const current = holder(path);
    if (current && current.version === stale.version && current.text === stale.text && !current.live) {
      if (current.directory) rmdirSync(path); else unlinkSync(path);
      syncDir(dirname(path));
    }
  });
}

export function abandonedBreaker(path) {
  clearDeadBreaker(`${path}.break`);
  const mutex = `${path}.break`;
  const record = holder(mutex);
  if (record?.directory) {
    try {
      for (const name of readdirSync(mutex)) {
        const entry = join(mutex, name);
        const owner = holder(entry);
        if (owner?.live) return busy(entry, owner);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return record ? busy(mutex, record) : null;
}

/**
 * Complete publication, liveness-checked takeover, and release of this generation only.
 * @returns {{ ok: true, release: () => void, holdAlso: (pid: number | undefined) => void } | { ok: false, holder: number | null, path: string, details: string }}
 */
export function lockFile(path) {
  const owner = { ...identity(), token: randomUUID(), createdAt: Date.now(), heartbeatAt: Date.now() };
  let railOwner = null;
  let text = JSON.stringify(owner);
  const tmp = `${path}.${owner.token}.tmp`;
  durableRecord(tmp, text);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { linkSync(tmp, path); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const current = holder(path);
        if (!current) continue;
        if (current.live) return busy(path, current);
        breakStale(path, current);
        continue;
      }
      syncDir(dirname(path));
      let fd = openSync(path, 'r');
      // Heartbeat the published inode, never a pathname that a successor can
      // own. mtime is the lock record's refreshed timestamp; JSON stays intact.
      const heartbeat = () => withBreaker(path, () => {
        if (holder(path)?.text !== text) return;
        const now = new Date(); futimesSync(fd, now, now); fsyncSync(fd);
      });
      const timer = setInterval(() => {
        try { heartbeat(); } catch (err) { console.error(`operation lock heartbeat failed (${path}): ${err.message}`); }
      }, HEARTBEAT_MS);
      timer.unref();
      let closed = false;
      const release = () => {
        if (railOwner && sameProcess(railOwner.pid, railOwner.pidStart)) return;
        if (closed) return;
        clearInterval(timer); closeSync(fd); closed = true;
        const current = holder(path);
        if (current?.text === text) { unlinkSync(path); syncDir(dirname(path)); }
        process.removeListener('exit', release);
      };
      const holdAlso = (pid) => {
        if (!pid || holder(path)?.text !== text) return;
        const child = { pid, pidStart: processStart(pid) ?? null };
        // Retain the lock even if publication fails after the child was spawned.
        railOwner = child;
        const next = JSON.stringify({ ...owner, railPid: child.pid, railPidStart: child.pidStart });
        const update = `${path}.${randomUUID()}.tmp`;
        try {
          durableRecord(update, next);
          renameSync(update, path);
          text = next;
          closeSync(fd); fd = openSync(path, 'r');
          syncDir(dirname(path));
        } finally {
          try { unlinkSync(update); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      };
      process.on('exit', release);
      return { ok: true, release, holdAlso };
    }
    return abandonedBreaker(path) ?? busy(path);
  } finally { unlinkSync(tmp); }
}

/** Rail commands hold the journal lock before reading, through their last write. */
export function lockRecord(dir, op) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return lockFile(join(dir, `${op}.json.lock`));
}
export function lockNext(lock, op, rail, chain) {
  return `${lock.details}. Another process (buy or reconcile) may be working on this op; wait for its RESULT, then superstables budget reconcile --rail ${rail} --chain ${chain} --op ${op}. After stopping every process or container working on this op, clear an abandoned lock with superstables budget unlock --rail ${rail} --chain ${chain} --op ${op} --confirm; live holders and fresh heartbeats are refused. Never pay again for this op while its outcome is unknown`;
}
export function requireRecordLock(dir, op) {
  const lock = lockRecord(dir, op);
  if (!lock.ok) {
    const [rail, ...chain] = dirname(lock.path).split('/').pop().split('-');
    console.log('RESULT ' + JSON.stringify({ rail, op, state: 'unknown', paid: null, debit: null, delivered: null, reason: 'op_in_progress', next: lockNext(lock, op, rail, chain.join('-')) }));
    process.exit(5);
  }
  return lock;
}
