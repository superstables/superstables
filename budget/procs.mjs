// Which process a recorded pid names. A pid alone is not an identity: once its process ends, the number is free and the
// system gives it to the next process that starts. So every pid this tool records to act on later (an approval's worker,
// its rail script's process group, a lock's holder) is recorded with the start time of that process, and a later check
// believes the pid only while a process with that number AND that start time exists.
//
//   Linux  the start time in /proc/<pid>/stat (clock ticks since boot), with the boot id: unique for the machine's uptime
//   macOS  a UTC identity for new readers, plus the original local ps string for 0.3.0 readers
//
// When neither can be read (another system, or no ps), the identity is null and the checks fall back to the pid alone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let bootId;
function linuxBootId() {
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
export function processStart(pid, platform = process.platform, run = execFileSync, utc = true) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (err) {
      return err.code === "ENOENT" || err.code === "ESRCH" ? null : undefined;
    }
    // the command name (field 2) is in parentheses and may hold spaces or ')': fields are counted after the last ')'
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19]; // field 22, starttime
    return /^\d+$/.test(start ?? "") ? `linux:${linuxBootId()}:${start}` : undefined;
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
    return err.code === "EPERM";
  }
}

/**
 * Whether `pid` still names the process recorded with start identity `start`. A record without one (older records, or a
 * system where it cannot be read) is judged by the pid alone, as before.
 */
export function sameProcess(pid, start, startUtc) {
  start = preferredProcessStart(start, startUtc);
  if (!pid) return false;
  if (!start) return pidAlive(pid);
  const now = processStart(pid);
  if (now === undefined) return pidAlive(pid);
  return compareProcessStarts(start, now) ?? pidAlive(pid);
}

/** Whether any process is left in process group `pgid` (EPERM: there is one, under another user). */
function anyInGroup(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Whether process group `pgid`, whose leader was recorded with start identity `start`, still has a process in it. While a
 * group exists its number cannot be given to a new process, so: when a process with that pid exists, the group is ours only
 * if that process is the recorded leader (otherwise the number was reused after our group ended); when none exists, a group
 * with that number can only be ours, its leader gone and other members left.
 */
export function groupAlive(pgid, start, startUtc) {
  start = preferredProcessStart(start, startUtc);
  if (!pgid) return false;
  if (start) {
    const now = processStart(pgid);
    if (now !== undefined && now !== null && compareProcessStarts(start, now) === false) return false;
  }
  return anyInGroup(pgid);
}
