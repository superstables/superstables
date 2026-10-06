import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, futimesSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createIdentitySource } from './lock-identity.mjs';
import { inspectProcess } from '../src/core/process-identity.mjs';
import { basename, dirname, join } from 'node:path';

export const HEARTBEAT_MS = 15_000;
const systemIdentity = createIdentitySource();
const source = options => options.identitySource ?? systemIdentity;
const identity = options => source(options).record();
function syncDir(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableRecord(path, text) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
function liveness(owner, options = {}) {
  const results = [inspectProcess(owner, source(options))];
  if (owner.railPid !== undefined) results.push(inspectProcess({ ...owner, pid: owner.railPid, pidStart: owner.railPidStart, pidStartUtc: owner.railPidStartUtc, namespace: 'railNamespace' in owner ? owner.railNamespace : owner.namespace, hostPid: owner.railHostPid, writtenAt: owner.railWrittenAt, bootElapsedMs: owner.railBootElapsedMs, createdAt: undefined }, source(options)));
  return results.find(result => result.state === 'alive' && !result.possiblyAlive) ?? results.find(result => result.state === 'alive') ?? results.find(result => result.state === 'unverifiable') ?? { state: 'dead' };
}

const fileVersion = stat => `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
function holder(path, options = {}) {
  let stat;
  try { stat = lstatSync(path); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  let text = null;
  try { text = readFileSync(path, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; }
  const version = fileVersion(stat);
  try {
    const value = JSON.parse(text);
    const owner = typeof value === 'number' ? { pid: value } : value;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      return { text, version, pid: owner.pid, owner, ...liveness(owner, options), directory: stat.isDirectory() };
    }
  } catch {}
  return { text, version, pid: null, owner: null, state: 'unverifiable', why: 'unreadable or unrecognised lock record', directory: stat.isDirectory() };
}
export const operationBusy = op => `Operation ${op} is locked. Its process may still be running. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear operation locks.`;
/** @returns {{ ok: false, holder: number | null, path: string, details: string, possiblyAlive: boolean }} */
function busy(path, current = holder(path), agent = true, operationPath = path) {
  const owner = current?.owner;
  const possiblyAlive = Boolean(current?.possiblyAlive || (current?.state === 'unverifiable' && !current.directory));
  const created = Number.isFinite(owner?.createdAt) ? new Date(owner.createdAt) : null;
  const time = created && !Number.isNaN(created.getTime()) ? created.toISOString() : 'an unknown time';
  const details = possiblyAlive && agent
    ? operationBusy(basename(operationPath).replace(/\.(?:buy|json)\.lock(?:\..*)?$|\.lock(?:\..*)?$/, ''))
    : current?.state === 'alive'
    ? `held by process ${current.pid} since ${time}; wait for its RESULT or ask the owner to check it`
    : current?.directory
      ? 'unrecognised directory in the lock or takeover mutex; the owner must inspect and remove this directory after stopping all work on this op'
      : `unverifiable holder${current?.pid ? ` process ${current.pid} since ${time}` : ''}: ${current?.why ?? 'lock changed during inspection'}; timestamps cannot prove it has exited${agent ? "; stop and ask the owner to check it in their own terminal, outside the agent's sandbox" : ""}`;
  return { ok: false, holder: current?.pid ?? null, path, possiblyAlive, details: possiblyAlive && agent ? details : `${details} (${path})` };
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
      const record = holder(path, options);
      if (removable(path, record, options)) unlinkSync(path);
      return;
    }
    const records = readdirSync(path);
    if (records.length === 0) { rmdirSync(path); return; }
    const owners = records.map(name => ({ name, record: holder(join(path, name), options) }));
    if (owners.some(({ record }) => (record?.state === 'alive' && !(record.possiblyAlive && options.confirmPossiblyAlive)) || record?.directory || (record?.state === 'unverifiable' && !options.confirmUnverifiable))) return;
    // Only remove the entries observed here. rmdir refuses a newly published generation.
    for (const { name, record } of owners) {
      const entry = join(path, name);
      const current = holder(entry, options);
      if (current && current.version === record?.version && current.text === record?.text && removable(entry, current, options)) removeBreaker(path, name);
    }
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST', 'EISDIR'].includes(err.code)) throw err;
  }
}
function removable(path, record, options) {
  if (!record || record.directory) return false;
  if (record.state === 'alive' && !(record.possiblyAlive && options.confirmPossiblyAlive)) return false;
  if (record.state === 'dead') return true;
  if (record.state === 'unverifiable' && !options.confirmUnverifiable) return false;
  options.onOverride?.(busy(path, record, false).details);
  return true;
}
function withBreaker(path, action, options = {}) {
  const mutex = `${path}.break`;
  const generation = `${randomUUID()}.owner`;
  const tmp = `${mutex}.${randomUUID()}.tmp`;
  mkdirSync(tmp, { mode: 0o700 });
  let published = false;
  try {
    durableRecord(join(tmp, generation), JSON.stringify(identity(options)));
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
  let changed = false;
  withBreaker(path, () => {
    const current = holder(path, options);
    if (current && current.version === stale.version && current.text === stale.text && removable(path, current, options)) {
      // The warning can block on terminal output while the old holder releases and a new one publishes.
      const afterWarning = holder(path, options);
      if (!afterWarning || afterWarning.version !== current.version || afterWarning.text !== current.text) { changed = true; return; }
      if (afterWarning.state === 'alive' && !(afterWarning.possiblyAlive && options.confirmPossiblyAlive)) { changed = true; return; }
      // Process inspection may spawn ps. Recheck the file after that work, immediately before unlink.
      try {
        if ((afterWarning.text !== null && readFileSync(path, 'utf8') !== afterWarning.text) || fileVersion(lstatSync(path)) !== afterWarning.version) { changed = true; return; }
      } catch (err) { if (err.code !== 'ENOENT') throw err; changed = true; return; }
      unlinkSync(path);
      syncDir(dirname(path));
    }
  }, options);
  return changed;
}

export function abandonedBreaker(path, options = {}) {
  clearDeadBreaker(`${path}.break`, options);
  const mutex = `${path}.break`;
  const record = holder(mutex, options);
  if (record?.directory) {
    try {
      for (const name of readdirSync(mutex)) {
        const entry = join(mutex, name);
        const owner = holder(entry, options);
        if (owner) return busy(entry, owner, true, path);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return record ? busy(mutex, record) : null;
}

/**
 * Complete publication and liveness-checked takeover. Owner override requires stopping all holders.
 * @returns {{ ok: true, release: () => void, holdAlso: (child: number | import("node:child_process").ChildProcess | undefined) => void } | { ok: false, holder: number | null, path: string, details: string }}
 */
export function lockFile(path, options = {}) {
  const owner = { ...identity(options), token: randomUUID(), createdAt: Date.now() };
  let railOwner = null;
  let text = JSON.stringify(owner);
  const tmp = `${path}.${owner.token}.tmp`;
  durableRecord(tmp, text);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { linkSync(tmp, path); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const current = holder(path, options);
        if (!current) continue;
        if ((current.state === 'alive' && !(current.possiblyAlive && options.confirmPossiblyAlive)) || current.directory || (current.state === 'unverifiable' && !options.confirmUnverifiable)) return busy(path, current);
        if (breakStale(path, current, options)) return busy(path, holder(path, options));
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
        if (railOwner) {
          try { source(options).probe(railOwner.pid); return; }
          catch (err) { if (err.code !== 'ESRCH') return; }
        }
        if (closed) return;
        // A live holder cannot be taken over automatically. Release its inode
        // without the breaker, which may belong to an unverifiable namespace.
        // Owner overrides require stopping the holder: stat + unlink is not atomic.
        const current = holder(path, options);
        if (current?.text === text) {
          const owned = fstatSync(fd);
          try {
            const published = lstatSync(path);
            if (owned.dev === published.dev && owned.ino === published.ino) { unlinkSync(path); syncDir(dirname(path)); }
          } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        clearInterval(timer); closeSync(fd); closed = true;
        process.removeListener('exit', release);
      };
      const holdAlso = (processOrPid) => {
        const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
        if (!pid || holder(path, options)?.text !== text) return;
        const child = { pid, ...(source(options).fields?.(pid) ?? source(options).starts?.(pid) ?? { pidStart: source(options).start(pid) ?? null }), writtenAt: Date.now() };
        // Retain the lock even if publication fails after the child was spawned.
        railOwner = child;
        if (typeof processOrPid === 'object') {
          const exited = () => { if (railOwner === child) railOwner = null; };
          if (processOrPid.exitCode !== null || processOrPid.signalCode !== null) exited();
          else processOrPid.once('exit', exited);
        }
        const next = JSON.stringify({ ...owner, railPid: child.pid, railPidStart: child.pidStart, railWrittenAt: child.writtenAt, railBootElapsedMs: child.bootElapsedMs, railNamespace: child.namespace, railHostPid: child.hostPid ?? null, ...(child.pidStartUtc !== undefined ? { railPidStartUtc: child.pidStartUtc } : {}) });
        const update = `${path}.${randomUUID()}.tmp`;
        try {
          durableRecord(update, next);
          const updateFd = openSync(update, 'r');
          let adopted = false;
          try {
            const updated = withBreaker(path, () => {
              if (holder(path, options)?.text !== text) throw new Error('operation lock ownership changed');
              renameSync(update, path);
              text = next;
              closeSync(fd); fd = updateFd; adopted = true;
              syncDir(dirname(path));
            }, options);
            if (!updated) throw new Error('operation lock takeover mutex is busy');
          } finally { if (!adopted) closeSync(updateFd); }
        } finally {
          try { unlinkSync(update); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
      };
      process.on('exit', release);
      return { ok: true, release, holdAlso };
    }
    return abandonedBreaker(path, options) ?? busy(path, holder(path, options));
  } finally { unlinkSync(tmp); }
}

/** Rail commands hold the journal lock before reading, through their last write. */
export function lockRecord(dir, op, options = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return lockFile(join(dir, `${op}.json.lock`), options);
}
export function lockNext(lock, op, rail, chain) {
  if (lock.possiblyAlive) return operationBusy(op);
  return `${lock.details}. Another process (buy or reconcile) may be working on this op; wait for its RESULT, then superstables budget reconcile --rail ${rail} --chain ${chain} --op ${op}. Stop and ask the owner to check it in their own terminal, outside the agent's sandbox. Agents must not clear operation locks. Never pay again for this op while its outcome is unknown`;
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
