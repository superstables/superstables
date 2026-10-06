import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { processStart } from './procs.mjs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export const HEARTBEAT_MS = 15_000;
function namespace() {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; }
}
const pidNamespace = namespace();
const host = hostname();
const bootId = (() => {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
})();
const identity = () => ({ pid: process.pid, pidStart: processStart(process.pid) ?? null, namespace: pidNamespace, platform: process.platform, hostname: host, bootId });
function syncDir(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableRecord(path, text) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function liveness(owner) {
  if (owner.platform !== process.platform) return { state: 'unverifiable', why: owner.platform ? 'another OS' : 'missing host identity' };
  if (owner.hostname !== host) return { state: 'unverifiable', why: 'another host' };
  if (!bootId || owner.bootId !== bootId) return { state: 'unverifiable', why: 'another or unknown boot' };
  if (!pidNamespace || owner.namespace !== pidNamespace) return { state: 'unverifiable', why: 'another or unknown container' };
  let unknown = false;
  for (const [pid, start] of [[owner.pid, owner.pidStart], [owner.railPid, owner.railPidStart]]) {
    if (pid === undefined) continue;
    if (!Number.isSafeInteger(pid) || pid <= 0) { unknown = true; continue; }
    const current = processStart(pid);
    if (typeof current === 'string' && typeof start === 'string' && current !== start) continue;
    try { process.kill(pid, 0); return { state: 'alive' }; }
    catch (err) {
      if (err.code === 'EPERM') return { state: 'alive' };
      if (err.code !== 'ESRCH') unknown = true;
    }
  }
  return unknown ? { state: 'unverifiable', why: 'unreadable process identity' } : { state: 'dead' };
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
      return { text, version, pid: owner.pid, owner, ...liveness(owner), directory: stat.isDirectory() };
    }
  } catch {}
  return { text, version, pid: null, owner: null, state: 'unverifiable', why: 'unreadable or unrecognised lock record', directory: stat.isDirectory() };
}
/** @returns {{ ok: false, holder: number | null, path: string, details: string }} */
function busy(path, current = holder(path)) {
  const owner = current?.owner;
  const created = Number.isFinite(owner?.createdAt) ? new Date(owner.createdAt) : null;
  const time = created && !Number.isNaN(created.getTime()) ? created.toISOString() : 'an unknown time';
  const details = current?.state === 'alive'
    ? `held by process ${current.pid} since ${time}; wait for its RESULT or ask the owner to check it`
    : current?.directory
      ? 'unrecognised directory in the lock or takeover mutex; the owner must inspect and remove this directory after stopping all work on this op'
      : `unverifiable holder${current?.pid ? ` process ${current.pid} since ${time}` : ''}: ${current?.why ?? 'lock changed during inspection'}; timestamps cannot prove it has exited; only the owner may override it with unlock --confirm`;
  return { ok: false, holder: current?.pid ?? null, path, details: `${details} (${path})` };
}
function removeBreaker(path, generation) {
  try { unlinkSync(join(path, generation)); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  try { rmdirSync(path); }
  catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
}
function clearDeadBreaker(path, options = {}) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) {
      const record = holder(path);
      if (removable(path, record, options)) unlinkSync(path);
      return;
    }
    const records = readdirSync(path);
    if (records.length === 0) { rmdirSync(path); return; }
    const owners = records.map(name => ({ name, record: holder(join(path, name)) }));
    if (owners.some(({ record }) => record?.state === 'alive' || record?.directory || (record?.state === 'unverifiable' && !options.confirmUnverifiable))) return;
    // Only remove the entries observed here. rmdir refuses a newly published generation.
    for (const { name, record } of owners) {
      const entry = join(path, name);
      const current = holder(entry);
      if (current && current.version === record?.version && current.text === record?.text && removable(entry, current, options)) removeBreaker(path, name);
    }
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EISDIR'].includes(err.code)) throw err;
  }
}
function removable(path, record, options) {
  if (!record || record.directory || record.state === 'alive') return false;
  if (record.state === 'dead') return true;
  if (!options.confirmUnverifiable) return false;
  options.onOverride?.(busy(path, record).details);
  return true;
}
function withBreaker(path, action, options = {}) {
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
      clearDeadBreaker(mutex, options);
      return false;
    }
    action();
    return true;
  } finally {
    try { removeBreaker(published ? mutex : tmp, generation); }
    finally { if (!published) { try { rmdirSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; } } }
  }
}

function breakStale(path, stale, options) {
  withBreaker(path, () => {
    const current = holder(path);
    if (current && current.version === stale.version && current.text === stale.text && removable(path, current, options)) {
      unlinkSync(path);
      syncDir(dirname(path));
    }
  }, options);
}

export function abandonedBreaker(path, options = {}) {
  clearDeadBreaker(`${path}.break`, options);
  const mutex = `${path}.break`;
  const record = holder(mutex);
  if (record?.directory) {
    try {
      for (const name of readdirSync(mutex)) {
        const entry = join(mutex, name);
        const owner = holder(entry);
        if (owner) return busy(entry, owner);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return record ? busy(mutex, record) : null;
}

/**
 * Complete publication, liveness-checked takeover, and release of this generation only.
 * @returns {{ ok: true, release: () => void, holdAlso: (pid: number | undefined) => void } | { ok: false, holder: number | null, path: string, details: string }}
 */
export function lockFile(path, options = {}) {
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
        if (current.state === 'alive' || current.directory || (current.state === 'unverifiable' && !options.confirmUnverifiable)) return busy(path, current);
        breakStale(path, current, options);
        continue;
      }
      syncDir(dirname(path));
      let fd = openSync(tmp, 'r');
      // Heartbeat the published inode, never a pathname that a successor can
      // own. mtime is the lock record's refreshed timestamp; JSON stays intact.
      const heartbeat = () => {
        const now = new Date(); futimesSync(fd, now, now); fsyncSync(fd);
      };
      const timer = setInterval(() => {
        try { heartbeat(); } catch (err) { console.error(`operation lock heartbeat failed (${path}): ${err.message}`); }
      }, HEARTBEAT_MS);
      timer.unref();
      let closed = false;
      const release = () => {
        if (railOwner && liveness({ ...identity(), pid: railOwner.pid, pidStart: railOwner.pidStart }).state !== 'dead') return;
        if (closed) return;
        const released = withBreaker(path, () => {
          const current = holder(path);
          if (current?.text === text) { unlinkSync(path); syncDir(dirname(path)); }
        });
        if (!released) return;
        clearInterval(timer); closeSync(fd); closed = true;
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
          const updateFd = openSync(update, 'r');
          let adopted = false;
          try {
            const updated = withBreaker(path, () => {
              if (holder(path)?.text !== text) throw new Error('operation lock ownership changed');
              renameSync(update, path);
              text = next;
              closeSync(fd); fd = updateFd; adopted = true;
              syncDir(dirname(path));
            });
            if (!updated) throw new Error('operation lock takeover mutex is busy');
          } finally { if (!adopted) closeSync(updateFd); }
        } finally {
          try { unlinkSync(update); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      };
      process.on('exit', release);
      return { ok: true, release, holdAlso };
    }
    return abandonedBreaker(path, options) ?? busy(path);
  } finally { unlinkSync(tmp); }
}

/** Rail commands hold the journal lock before reading, through their last write. */
export function lockRecord(dir, op, options = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return lockFile(join(dir, `${op}.json.lock`), options);
}
export function lockNext(lock, op, rail, chain) {
  return `${lock.details}. Another process (buy or reconcile) may be working on this op; wait for its RESULT, then superstables budget reconcile --rail ${rail} --chain ${chain} --op ${op}. Ask the owner to check every process, container and host working on this op before running superstables budget unlock --rail ${rail} --chain ${chain} --op ${op} --confirm; live local holders are refused. Overriding an unverifiable holder that is still working can allow a duplicate payment. Never pay again for this op while its outcome is unknown`;
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
