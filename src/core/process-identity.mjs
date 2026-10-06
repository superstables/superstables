// Process identity shared by core locks, budget locks and approval workers.
// Foreign PIDs are resolved only from the initial Linux namespace; nested readers refuse unverifiable holders.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";

import { hostname } from 'node:os';

let bootId;
function linuxBootId(readFile = readFileSync) {
  if (readFile !== readFileSync) {
    try { return readFile("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return ""; }
  }
  if (bootId === undefined) {
    try { bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { bootId = ""; }
  }
  return bootId;
}

/** Parse only the C-locale ps date read with TZ=UTC0. Legacy unzoned dates cannot be converted safely. */
export function parseDarwinStart(text) {
  const match = text.trim().match(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (!match) return undefined;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[2]);
  const [day, hour, minute, second, year] = match.slice(3).map(Number);
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return undefined;
  return `darwin:utc:${date.getTime() / 1000}`;
}

/** Undefined means at least one macOS record has no zone, so a mismatch cannot prove PID reuse. */
export function compareProcessStarts(recorded, current) {
  if ([recorded, current].some(start => typeof start === 'string' && start.startsWith('darwin:') && !/^darwin:utc:\d+$/.test(start))) return undefined;
  return recorded === current;
}

/**
 * The start identity of process `pid`: a string, or null when no such process exists, or undefined when this system gives
 * no way to tell (then only the pid can be checked).
 */
export function processStart(pid, platform = process.platform, run = execFileSync, utc = true, readFile = readFileSync) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") {
    let stat;
    try {
      stat = readFile(`/proc/${pid}/stat`, "utf8");
    } catch (err) {
      return err.code === "ENOENT" || err.code === "ESRCH" ? null : undefined;
    }
    // the command name (field 2) is in parentheses and may hold spaces or ')': fields are counted after the last ')'
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19]; // field 22, starttime
    const boot = linuxBootId(readFile);
    return boot && /^\d+$/.test(start ?? "") ? `linux:${boot}:${start}` : undefined;
  }
  if (platform === "darwin") {
    try {
      const out = run("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, env: { ...process.env, LC_ALL: "C", ...(utc ? { TZ: "UTC0" } : {}) } }).trim();
      return out ? (utc ? parseDarwinStart(out) : `darwin:${out}`) : null;
    } catch (err) {
      // ps exits 1 when no process matches; any other failure means this cannot tell
      return err.status === 1 ? null : undefined;
    }
  }
  return undefined;
}

/** Original 0.3.0 field format, including the caller's local time zone on macOS. */
export const legacyProcessStart = (pid, platform = process.platform, run = execFileSync) => processStart(pid, platform, run, false);

/** Keep existing fields readable by 0.3.0; new readers prefer separate UTC seconds on macOS. */
export function processStartFields(pid, platform = process.platform, run = execFileSync, start = value => processStart(value, platform, run)) {
  const current = start(pid);
  if (platform !== 'darwin') return { pidStart: current ?? null };
  return {
    pidStart: legacyProcessStart(pid, platform, run) ?? null,
    pidStartUtc: typeof current === 'string' && /^darwin:utc:\d+$/.test(current) ? Number(current.slice('darwin:utc:'.length)) : null,
  };
}

export const preferredProcessStart = (start, utc) => Number.isSafeInteger(utc) && utc >= 0 ? `darwin:utc:${utc}` : start;

/** Whether a process with this pid exists (EPERM: it exists, under another user). The pid alone: see sameProcess. */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

// Inject the OS reads together so tests can exercise the macOS path on Linux.
export function createIdentitySource({ platform = process.platform, host = hostname(), readFile = (path, encoding) => readFileSync(path, encoding).toString(), readlink = path => readlinkSync(path, 'utf8'), readdir = path => readdirSync(path), run = (command, args, options) => execFileSync(command, args, options), start = pid => {
    let procPid = pid;
    if (platform === 'linux' && pid === process.pid) {
      try { procPid = Number(readFile('/proc/self/status', 'utf8').match(/^NSpid:\s+(\d+)/m)?.[1]) || pid; } catch {}
    }
    return processStart(procPid, platform, run, true, readFile);
  }, probe = pid => process.kill(pid, 0) } = {}) {
  let bootId = null, namespace = null;
  if (platform === 'linux') {
    try { bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch {}
    try { namespace = readlink('/proc/self/ns/pid'); } catch {}
  } else if (platform === 'darwin') {
    try {
      const out = run('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(out)) bootId = out.toLowerCase();
    } catch {}
  }
  const starts = pid => processStartFields(pid, platform, run, start);
  const pids = pid => {
    try { return readFile(`/proc/${pid}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) ?? []; } catch { return []; }
  };
  // Linux reserves 0xEFFFFFFC for the initial PID namespace (include/uapi/linux/nsfs.h).
  // NSpid alone cannot identify nesting after a sandbox remounts /proc.
  const nested = () => platform === 'linux' && (pids('self').length > 1 || (namespace !== null && namespace !== 'pid:[4026531836]'));
  const fields = pid => {
    const target = pid === process.pid ? 'self' : pid;
    if (platform === 'linux' && target !== 'self' && pids('self').length > 1) return { platform, hostname: host, bootId, namespace, hostPid: null, pidStart: null, writtenAt: Date.now() };
    let ns = namespace;
    if (platform === 'linux') { try { ns = readlink(`/proc/${target}/ns/pid`); } catch {} }
    const ids = platform === 'linux' ? pids(target) : [];
    return { platform, hostname: host, bootId, namespace: ns, hostPid: ns === 'pid:[4026531836]' || ids.length > 1 ? ids[0] ?? null : null, ...starts(pid), writtenAt: Date.now() };
  };
  let ownFields;
  return { record: () => ({ pid: process.pid, ...(ownFields ??= fields(process.pid)), writtenAt: Date.now() }), starts, fields, start, probe, nested, readFile, readlink, readdir, pids, run };
}

/**
 * @typedef {object} ProcessRecord
 * @property {number} [pid]
 * @property {string|null} [pidStart]
 * @property {number|null} [pidStartUtc]
 * @property {string|null} [namespace]
 * @property {string|null} [bootId]
 * @property {string} [hostname]
 * @property {string} [platform]
 * @property {number|string} [createdAt]
 * @property {number} [writtenAt]
 * @property {number|null} [hostPid]
 */

const systemIdentity = createIdentitySource();
const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '');
const absent = err => ['ENOENT', 'ESRCH'].includes(err.code);
const statFields = text => text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
function zombie(pid, source) {
  try { return ['Z', 'X'].includes(statFields(source.readFile(`/proc/${pid}/stat`, 'utf8'))[0]); } catch { return false; }
}

/** Map an inner PID (or group) only from the initial namespace. Undefined means inspection was incomplete. */
export function visiblePid(owner, source = systemIdentity, group = false) {
  const local = source.record();
  if (local.platform !== 'linux') return owner.pid;
  if (source.pids?.('self').length > 1) return undefined;
  if (owner.namespace && owner.namespace === local.namespace) return owner.pid;
  if (source.nested?.()) return undefined;
  if (!local.namespace) return owner.pid;
  if (local.namespace !== 'pid:[4026531836]') return undefined;
  let entries;
  try { entries = source.readdir('/proc'); } catch { return undefined; }
  let incomplete = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = source.readFile(`/proc/${entry}/status`, 'utf8');
      const ids = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
      // On a host-mounted proc, one NSpid entry excludes a foreign namespace even if its ns link is denied.
      if (ids?.length === 1) continue;
      if (owner.namespace && source.readlink(`/proc/${entry}/ns/pid`) !== owner.namespace) continue;
      const numbers = group ? status.match(/^NSpgid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) : ids;
      if (!numbers?.length) { incomplete = true; continue; }
      if (numbers.at(-1) === owner.pid) {
        if (zombie(Number(entry), source)) continue;
        const candidate = group ? Number(statFields(source.readFile(`/proc/${entry}/stat`, 'utf8'))[2]) : Number(entry);
        if (!owner.namespace) {
          const recorded = preferredProcessStart(owner.pidStart, owner.pidStartUtc);
          const current = source.start(candidate);
          if (typeof recorded === 'string' && typeof current === 'string' && compareProcessStarts(recorded, current) === false) continue;
          if (!recorded && startAfterWrite(candidate, current, owner, source)) continue;
        }
        return candidate;
      }
    } catch (err) { if (!absent(err)) incomplete = true; }
  }
  return incomplete ? undefined : owner.namespace ? null : owner.pid;
}

let clockTicks;
function startAfterWrite(pid, current, owner, source) {
  const written = owner.writtenAt ?? (typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : owner.createdAt);
  if (!Number.isFinite(written)) return false;
  if (owner.hostname && owner.hostname !== source.record().hostname) return false;
  if (typeof current === 'string' && /^darwin:utc:\d+$/.test(current)) return Number(current.slice(11)) * 1000 > written;
  if (typeof current !== 'string' || !/^linux:[^:]+:\d+$/.test(current)) return false;
  try {
    const bootSeconds = Number(source.readFile('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    const ticks = clockTicks ??= Number(source.run('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }));
    if (!(ticks > 0) || !Number.isFinite(bootSeconds)) return false;
    return (bootSeconds + Number(current.split(':').at(-1)) / ticks) * 1000 > written;
  } catch { return false; }
}

/** @param {ProcessRecord} owner */
export function inspectProcess(owner, source = systemIdentity) {
  const local = source.record();
  if (owner.platform && owner.platform !== local.platform) return { state: 'unverifiable', why: 'another OS' };
  if (uuid(local.bootId) && uuid(owner.bootId) && owner.bootId.toLowerCase() !== local.bootId.toLowerCase()) {
    return { state: 'unverifiable', why: owner.hostname && owner.hostname !== local.hostname ? 'another host' : 'another boot' };
  }
  // Positive local evidence already suffices to refuse a legacy holder. Scan only when absence or reuse is possible.
  if (local.platform === 'linux' && !owner.namespace && !source.nested?.()) {
    const recorded = preferredProcessStart(owner.pidStart, owner.pidStartUtc);
    const current = source.start(owner.pid);
    if (typeof recorded === 'string' && typeof current === 'string' && compareProcessStarts(recorded, current) === true) {
      const live = { state: 'alive', possiblyAlive: true, pid: owner.pid, why: owner.platform ? 'unreadable PID namespace identity' : '0.3.0 record without host identity', guidance: 'stop the recorded process; a readable start mismatch or a process started after the record was written permits recovery' };
      try { source.probe(owner.pid); return live; }
      catch (err) { if (err.code === 'EPERM') return live; }
    }
  }
  const pid = visiblePid(owner, source);
  if (pid === undefined) return source.nested?.() || local.namespace !== 'pid:[4026531836]'
    ? { state: 'alive', possiblyAlive: true, pid: owner.pid, why: owner.namespace === local.namespace ? 'process identity is unverifiable from this PID namespace proc view' : 'holder in another PID namespace that is unverifiable from here', guidance: 'run unlock on the host (the initial PID namespace), outside the sandbox' }
    : { state: 'alive', possiblyAlive: true, pid: owner.pid, why: 'unreadable PID namespace inspection', guidance: 'run unlock on the host with permission to inspect the holder namespace' };
  if (pid === null) return { state: 'dead' };
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unverifiable', why: 'unrecognised process identity' };
  if (local.platform === 'linux' && zombie(pid, source)) return { state: 'dead' };
  const start = preferredProcessStart(owner.pidStart, owner.pidStartUtc);
  const current = source.start(pid);
  const comparable = typeof current === 'string' && typeof start === 'string' ? compareProcessStarts(start, current) : undefined;
  if (comparable === false || (comparable === undefined && startAfterWrite(pid, current, owner, source))) return { state: 'dead' };
  let why;
  if (!owner.platform) why = '0.3.0 record without host identity';
  else if (!uuid(local.bootId) || !uuid(owner.bootId)) why = 'unreadable boot identity';
  const locationWhy = why;
  if (comparable === undefined) why ??= 'unreadable process identity';
  const possible = () => ({ state: 'alive', ...(why ? { possiblyAlive: true, pid: owner.pid, why, guidance: why.startsWith('0.3.0') ? 'stop the recorded process; a readable start mismatch or a process started after the record was written permits recovery' : 'stop that process or run unlock outside the sandbox where process identity can be read' } : {}) });
  try { source.probe(pid); return possible(); }
  catch (err) {
    if (err.code === 'EPERM') return possible();
    if (err.code !== 'ESRCH') return { ...possible(), possiblyAlive: true, why: 'unreadable process identity or PID probe' };
  }
  return locationWhy || (typeof start === 'string' && typeof current === 'string' && comparable === undefined) ? { state: 'unverifiable', why } : { state: 'dead' };
}

/** Readers without location fields must not trust a local ESRCH from a nested namespace. */
export function sameProcess(pid, start, startUtc, location = {}) {
  if (!pid) return false;
  const record = { ...location, pid, pidStart: start, pidStartUtc: startUtc };
  const checked = inspectProcess(record);
  if (checked.state === 'alive') return true;
  if (checked.state === 'dead') return false;
  return !(visiblePid(record) === pid && !pidAlive(pid));
}

export function groupAlive(pgid, start, startUtc, location = {}) {
  if (!pgid) return false;
  const owner = { ...location, pid: pgid, pidStart: start, pidStartUtc: startUtc };
  const visible = visiblePid(owner, systemIdentity, true);
  if (visible === undefined) return true;
  if (visible === null) return false;
  const current = processStart(visible);
  const recorded = preferredProcessStart(start, startUtc);
  if (typeof current === 'string' && ((typeof recorded === 'string' && compareProcessStarts(recorded, current) === false) || (!recorded && startAfterWrite(visible, current, owner, systemIdentity)))) return false;
  try { process.kill(-visible, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}
