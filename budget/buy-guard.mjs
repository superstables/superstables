// What keeps the dispatcher (cli.mjs) from paying one purchase twice, on every rail.
//
//   lockOp      one `buy --op ID` at a time: an exclusive lock per operation, taken before the journal is read and held
//               until the command exits (after its RESULT). Two overlapping buys with the same op would otherwise both find
//               no journal, both pay, and overwrite each other's journal.
//   railResult  the rail script's RESULT, from its stdout. For a purchase only the last line counts: a rail prints its
//               RESULT last and exits, so a `RESULT {` line anywhere before it is not the rail's.
//
// The lock is <op>.buy.lock next to the op's journal ({pid, pidStart, createdAt}, mode 600), written in full to a private
// file and hard-linked to its name, so it exists complete or not at all. A lock whose process is gone (procs.mjs: the same
// pid AND start time) is stale and taken over, under a short mutex so two takers never both win. The solana rail's own
// lock (<op>.json.lock, solana/ops.mjs) is a different file: this one never blocks it.
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processStart, sameProcess } from "./procs.mjs";

/** A lock file that cannot be read as a lock is only trusted this long (it is never written half, so this is a backstop). */
const UNREADABLE_GRACE_MS = 30_000;
/** A takeover mutex older than this belongs to a process that died while breaking a stale lock. */
const BREAK_STALE_MS = 10_000;

export const opLockFile = (dir, op) => join(dir, `${op}.buy.lock`);

function readHolder(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // released meanwhile
  }
  try {
    const lock = JSON.parse(text);
    // held while the command that took it runs, or the rail script it started (which may outlive a killed command)
    if (Number.isInteger(lock?.pid)) return { text, pid: lock.pid, live: sameProcess(lock.pid, lock.pidStart) || (Number.isInteger(lock.railPid) && sameProcess(lock.railPid, lock.railPidStart)) };
  } catch {}
  let age = 0;
  try { age = Date.now() - statSync(path).mtimeMs; } catch {}
  return { text, pid: null, live: age < UNREADABLE_GRACE_MS };
}

/** Remove the lock judged stale, and only that one. */
function breakStale(path, staleText) {
  const mutex = `${path}.break`;
  let fd;
  try {
    fd = openSync(mutex, "wx", 0o600);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(mutex).mtimeMs > BREAK_STALE_MS) unlinkSync(mutex);
    } catch {}
    return;
  }
  try {
    const now = readHolder(path);
    if (now && now.text === staleText && !now.live) unlinkSync(path);
  } finally {
    closeSync(fd);
    try { unlinkSync(mutex); } catch {}
  }
}

/**
 * Take the lock for operation `op` in `dir` (the rail and chain's ops folder), held by this process until it exits.
 * { ok: true, release, holdAlso } or { ok: false, holder } (the holder's pid, when known). holdAlso(pid) records the rail
 * script this process started, so the lock stays held if this process is killed while the rail script still runs.
 * @returns {{ ok: true, release: () => void, holdAlso: (pid: number | undefined) => void } | { ok: false, holder: number | null }}
 */
export function lockOp(dir, op) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = opLockFile(dir, op);
  const holder = { pid: process.pid, pidStart: processStart(process.pid) ?? null, createdAt: Date.now() };
  let text = JSON.stringify(holder);
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(mine, text, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, path);
        const release = () => {
          try {
            if (readFileSync(path, "utf8") === text) unlinkSync(path);
          } catch {}
        };
        const holdAlso = (pid) => {
          try {
            if (!pid || readFileSync(path, "utf8") !== text) return;
            const next = JSON.stringify({ ...holder, railPid: pid, railPidStart: processStart(pid) ?? null });
            const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
            writeFileSync(tmp, next, { mode: 0o600, flag: "wx" });
            renameSync(tmp, path); // replaces our own lock in one step: never absent, never half written
            text = next;
          } catch {}
        };
        process.on("exit", release);
        return { ok: true, release, holdAlso };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const holder = readHolder(path);
      if (!holder) continue;
      if (holder.live) return { ok: false, holder: holder.pid };
      breakStale(path, holder.text);
    }
    return { ok: false, holder: readHolder(path)?.pid ?? null };
  } finally {
    try { unlinkSync(mine); } catch {}
  }
}

/**
 * The RESULT object a rail script printed, or null. With `last`, only the last non-empty line of stdout counts (purchases:
 * the rail prints its RESULT last, then exits); otherwise the last line that starts with `RESULT {`.
 */
export function railResult(stdout, { last = false } = {}) {
  const lines = String(stdout ?? "").split("\n").map((l) => l.replace(/\r$/, ""));
  const line = last ? [...lines].reverse().find((l) => l.trim() !== "") : [...lines].reverse().find((l) => /^RESULT \{/.test(l));
  if (!line || !/^RESULT \{/.test(line)) return null;
  try {
    const r = JSON.parse(line.slice(7));
    return r && typeof r === "object" && !Array.isArray(r) ? r : null;
  } catch {
    return null;
  }
}
