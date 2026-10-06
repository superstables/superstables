// Process identity shared by core locks, budget locks and approval workers.
// Foreign PIDs are resolved only from the initial Linux namespace; nested readers refuse unverifiable holders.
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, readdirSync } from "node:fs";

import { hostname, uptime } from 'node:os';

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
 * no way to tell. A PID probe still requires verified location.
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
  }, probe = pid => process.kill(pid, 0), bootElapsed = () => uptime() * 1000 } = {}) {
  let bootId = null, namespace = null, hostId = null;
  if (platform === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try { const id = readFile(path, 'utf8').trim(); if (/^[0-9a-f]{32}$/i.test(id)) { hostId = id.toLowerCase(); break; } } catch {}
    }
  } else if (platform === 'darwin') {
    try {
      const out = run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
      const id = out.match(/"IOPlatformUUID"\s*=\s*"([0-9a-f-]+)"/i)?.[1];
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) hostId = id.toLowerCase();
    } catch {}
  }
  if (platform === 'linux') {
    try { bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch {}
    try { namespace = readlink('/proc/self/ns/pid'); } catch {}
  } else if (platform === 'darwin') {
    try {
      const out = run('sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(out)) bootId = out.toLowerCase();
    } catch {}
  }
  const bootStartedAt = () => {
    if (platform !== 'darwin') return Date.now() - bootElapsed();
    try {
      const out = run('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 5000 });
      const seconds = out.match(/sec\s*=\s*(\d+)/)?.[1];
      return seconds ? Number(seconds) * 1000 : undefined;
    } catch { return undefined; }
  };
  const starts = pid => processStartFields(pid, platform, run, start);
  const pids = pid => {
    try { return readFile(`/proc/${pid}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number) ?? []; } catch { return []; }
  };
  // Linux reserves 0xEFFFFFFC for the initial PID namespace (include/uapi/linux/nsfs.h).
  // NSpid alone cannot identify nesting after a sandbox remounts /proc.
  const nested = () => platform === 'linux' && (!namespace || pids('self').length !== 1 || namespace !== 'pid:[4026531836]');
  const fields = pid => {
    const target = pid === process.pid ? 'self' : pid;
    if (platform === 'linux' && target !== 'self' && pids('self').length > 1) return { platform, hostname: host, hostId, bootId, namespace: null, hostPid: null, pidStart: null, writtenAt: Date.now(), bootElapsedMs: bootElapsed() };
    let ns = namespace;
    if (platform === 'linux') { try { ns = readlink(`/proc/${target}/ns/pid`); } catch { ns = null; } }
    const ids = platform === 'linux' ? pids(target) : [];
    return { platform, hostname: host, hostId, bootId, namespace: ns, hostPid: ns === 'pid:[4026531836]' || ids.length > 1 ? ids[0] ?? null : null, ...starts(pid), writtenAt: Date.now(), bootElapsedMs: bootElapsed() };
  };
  let ownFields;
  return { record: () => ({ pid: process.pid, ...(ownFields ??= fields(process.pid)), writtenAt: Date.now(), bootElapsedMs: bootElapsed() }), starts, fields, start, probe, nested, readFile, readlink, readdir, pids, run, bootElapsed, bootStartedAt };
}

/**
 * @typedef {object} ProcessRecord
 * @property {number} [pid]
 * @property {string|null} [pidStart]
 * @property {number|null} [pidStartUtc]
 * @property {string|null} [namespace]
 * @property {string|null} [bootId]
 * @property {string} [hostname]
 * @property {string|null} [hostId]
 * @property {number} [bootElapsedMs]
 * @property {string} [platform]
 * @property {number|string} [createdAt]
 * @property {number} [writtenAt]
 * @property {number|null} [hostPid]
 * @property {number} [mtimeMs]
 * @property {number} [heartbeatAt]
 */

const systemIdentity = createIdentitySource();
const uuid = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? '');
const absent = err => ['ENOENT', 'ESRCH'].includes(err.code);
const statFields = text => text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
function zombie(pid, source) {
  try { return ['Z', 'X'].includes(statFields(source.readFile(`/proc/${pid}/stat`, 'utf8'))[0]); } catch { return false; }
}

/** A restricted proc mount cannot prove that an unlisted process is absent. */
export function completeProcView(source = systemIdentity) {
  try {
    const mounts = source.readFile('/proc/self/mountinfo', 'utf8').trim().split('\n');
    const proc = mounts.filter(line => line.split(' ')[4] === '/proc');
    if (!proc.length) return false;
    return proc.every(line => {
      const [mount, superblock] = line.split(' - ');
      if (!superblock?.startsWith('proc ')) return false;
      const options = [...mount.split(' ')[5].split(','), ...superblock.split(' ').slice(2).join(',').split(',')];
      return !options.some(option => option.startsWith('hidepid=') && !['hidepid=0', 'hidepid=off'].includes(option));
    });
  } catch { return false; }
}

/** Only short-lived legacy cap locks may use this initial-namespace upgrade proof. */
export function inspectLegacyCap(owner, source = systemIdentity) {
  const possible = { state: 'alive', possiblyAlive: true, why: 'unverifiable legacy payment lock' };
  if (Object.keys(owner).some(key => !['pid', 'pidStart', 'owner'].includes(key)) || typeof owner.owner !== 'string') return possible;
  const local = source.record();
  if (local.platform !== 'linux' || source.nested() || !completeProcView(source) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return possible;
  let entries;
  try { entries = source.readdir('/proc'); } catch { return possible; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const numbers = source.readFile(`/proc/${entry}/status`, 'utf8').match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
      if (!numbers?.length || (numbers.length > 1 && numbers.slice(1).includes(owner.pid))) return possible;
    } catch (err) { if (!absent(err)) return possible; }
  }
  const current = source.start(owner.pid);
  if (current === null || (typeof current === 'string' && typeof owner.pidStart === 'string' && compareProcessStarts(owner.pidStart, current) === false)) return { state: 'dead' };
  return possible;
}

/** Map an inner PID (or group) only from a readable initial namespace. */
export function visiblePid(owner, source = systemIdentity, group = false) {
  const local = source.record();
  if (local.platform === 'darwin') return owner.pid;
  if (local.platform !== 'linux' || !local.namespace || source.pids?.('self').length !== 1) return undefined;
  if (!completeProcView(source)) return undefined;
  if (owner.namespace && owner.namespace === local.namespace) return owner.pid;
  if (source.nested?.() || !owner.namespace || local.namespace !== 'pid:[4026531836]') return undefined;
  let entries;
  try { entries = source.readdir('/proc'); } catch { return undefined; }
  let incomplete = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = source.readFile(`/proc/${entry}/status`, 'utf8');
      const numbers = status.match(group ? /^NSpgid:\s+(.+)$/m : /^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/).map(Number);
      if (!numbers?.length) { incomplete = true; continue; }
      // A single namespace PID on the initial proc mount is already proven to be on the host.
      if (numbers.length === 1 || numbers.at(-1) !== owner.pid) continue;
      // Read namespace links only for matching inner PIDs. Unreadable unrelated links cannot block recovery.
      if (source.readlink(`/proc/${entry}/ns/pid`) !== owner.namespace) continue;
      if (zombie(Number(entry), source)) continue;
      return group ? Number(statFields(source.readFile(`/proc/${entry}/stat`, 'utf8'))[2]) : Number(entry);
    } catch (err) { if (!absent(err)) incomplete = true; }
  }
  return incomplete ? undefined : null;
}

function sameHost(owner, local) {
  return typeof owner.hostId === 'string' && owner.hostId.length > 0 && owner.hostId === local.hostId;
}
function sameBoot(owner, local) {
  return uuid(owner.bootId) && uuid(local.bootId) && owner.bootId.toLowerCase() === local.bootId.toLowerCase();
}
function startAfterWrite(current, owner, source) {
  const local = source.record();
  if (!sameHost(owner, local) || !sameBoot(owner, local)) return false;
  const written = owner.writtenAt ?? (typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : owner.createdAt);
  if (!Number.isFinite(written) || written > Date.now() || !Number.isFinite(owner.bootElapsedMs)) return false;
  // A recorded boot-relative time also detects wall-clock steps since publication.
  if (Number.isFinite(owner.bootElapsedMs)) {
    const elapsed = source.bootElapsed?.();
    if (!Number.isFinite(elapsed) || elapsed < owner.bootElapsedMs || Math.abs((Date.now() - written) - (elapsed - owner.bootElapsedMs)) > 1000) return false;
  }
  if (typeof current === 'string' && /^darwin:utc:\d+$/.test(current)) return Number(current.slice(11)) * 1000 >= written + 60_000;
  if (typeof current !== 'string' || !/^linux:[^:]+:\d+$/.test(current)) return false;
  try {
    const bootSeconds = Number(source.readFile('/proc/stat', 'utf8').match(/^btime (\d+)$/m)?.[1]);
    const ticks = Number(source.run('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5000 }));
    if (!(ticks > 0) || !Number.isFinite(bootSeconds)) return false;
    const started = Number(current.split(':').at(-1)) / ticks * 1000;
    if (Number.isFinite(owner.bootElapsedMs) && started < owner.bootElapsedMs + 60_000) return false;
    return bootSeconds * 1000 + started >= written + 60_000;
  } catch { return false; }
}

/**
 * @typedef {object} ProcessInspection
 * @property {'alive'|'dead'} state
 * @property {boolean} [possiblyAlive]
 * @property {number} [pid]
 * @property {string} [why]
 */

/**
 * A holder is dead only with positive proof; a failed local probe never establishes its location.
 * @returns {ProcessInspection}
 */
export function inspectProcess(owner, source = systemIdentity, group = false) {
  const local = source.record();
  /** @type {(why: string) => ProcessInspection} */
  const possible = why => ({ state: 'alive', possiblyAlive: true, pid: owner.pid, why });
  if (owner.platform && owner.platform !== local.platform) return possible('another OS');
  if (owner.hostname && local.hostname && owner.hostname !== local.hostname) return possible('another hostname');
  if (!uuid(owner.bootId) || !uuid(local.bootId)) return possible('unreadable boot identity');
  if (!sameBoot(owner, local)) {
    const bootStart = source.bootStartedAt?.();
    const predates = time => Number.isFinite(time) && Number.isFinite(bootStart) && time < bootStart - 60_000;
    if (sameHost(owner, local) && predates(owner.writtenAt) && (owner.mtimeMs === undefined || (predates(owner.mtimeMs) && (owner.heartbeatAt === undefined || predates(owner.heartbeatAt))))) return { state: 'dead' };
    return possible('another boot without proof that the record predates this boot');
  }
  // Equal boot UUIDs prove a common kernel without a machine-id. Foreign namespace scans still require host evidence.
  if (!(local.platform === 'linux' && owner.namespace && owner.namespace === local.namespace) && !sameHost(owner, local)) return possible('unreadable or different host identity');
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return possible('unrecognised process identity');
  const pid = visiblePid(owner, source, group);
  if (pid === undefined) return possible(!local.namespace && local.platform === 'linux'
    ? 'unreadable PID namespace identity'
    : source.nested?.() ? 'holder in another PID namespace that is unverifiable from here' : 'unreadable PID namespace inspection');
  if (pid === null) return { state: 'dead' };
  const start = preferredProcessStart(owner.pidStart, owner.pidStartUtc);
  const current = source.start(pid);
  const comparable = typeof start === 'string' && typeof current === 'string' ? compareProcessStarts(start, current) : undefined;
  if (comparable === false || (comparable === undefined && startAfterWrite(current, owner, source))) return { state: 'dead' };
  if (!group && local.platform === 'linux' && zombie(pid, source)) return { state: 'dead' };
  try { source.probe(group ? -pid : pid); }
  catch (err) {
    if (err.code === 'ESRCH') return { state: 'dead' };
    if (err.code !== 'EPERM') return possible('unreadable process identity or PID probe');
  }
  return comparable === true ? { state: 'alive' } : possible('unreadable process identity');
}

export function sameProcess(pid, start, startUtc, location = {}) {
  if (!pid) return false;
  return inspectProcess({ ...location, pid, pidStart: start, pidStartUtc: startUtc }).state !== 'dead';
}

export function groupAlive(pgid, start, startUtc, location = {}) {
  if (!pgid) return false;
  return inspectProcess({ ...location, pid: pgid, pidStart: start, pidStartUtc: startUtc }, systemIdentity, true).state !== 'dead';
}
