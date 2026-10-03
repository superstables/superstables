// A lock across processes on this computer, for a moment only (a check and a write), never while a person decides.
//
// The lock file holds { pid, pidStart, owner }: the holder's pid, that process's start identity, and a random owner id.
// It is written whole to a temporary file and hard-linked into place, so it exists complete or not at all. It is taken
// over only from a holder that is gone (no process with that pid and that start identity runs), never because it is
// old: a live holder may be paused for any time. A dead holder's lock is broken under a mutex, and only if it is still
// the same lock (same text, so the same owner id); a lock is released only by its owner. The mutex follows the same
// rules (whole file, holder identity, taken over only from a gone holder, released only by its owner): Node has no
// flock, and this ownership rule stands in for it. Nothing here is ever taken over because of its age. This is the design of
// the budget's approval record lock (budget/approvals.mjs), which src/ cannot import.

import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";


let bootId: string | undefined;
function linuxBootId(): string {
  if (bootId === undefined) {
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      bootId = "";
    }
  }
  return bootId;
}

/**
 * The start identity of process `pid`: a string, null when no such process exists, or undefined when this system gives
 * no way to tell (then only the pid is checked). Linux only: /proc/<pid>/stat's start time with the boot id.
 */
export function processStart(pid: number): string | null | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform !== "linux") return undefined;
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? null : undefined;
  }
  // the command name (field 2) is in parentheses and may hold spaces or ')': fields are counted after the last ')'
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22, starttime
  return /^\d+$/.test(start ?? "") ? `linux:${linuxBootId()}:${start}` : undefined;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Does `pid` still name the process recorded with start identity `start`? Without one, the pid alone decides. */
function sameProcess(pid: number, start: string | null | undefined): boolean {
  if (!pid) return false;
  if (!start) return pidAlive(pid);
  const now = processStart(pid);
  if (now === undefined) return pidAlive(pid);
  return now === start;
}

/** What a lock or mutex file says about its holder, or null when it cannot be read as one. */
function readHolder(path: string): { text: string | null; holder: { pid?: number; pidStart?: string | null } | null } {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
    const holder = JSON.parse(text) as { pid?: number; pidStart?: string | null } | null;
    return { text, holder: holder && typeof holder === "object" ? holder : null };
  } catch {
    return { text, holder: null };
  }
}

const ownerText = () =>
  JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: randomBytes(8).toString("hex") });

/** A short pause after every attempt that did not get the file, so a waiter never spins and timers keep running. */
const RETRY_MS = 10;

/**
 * Create `path` holding `me`, written whole to a temporary file and hard-linked into place, waiting until `deadline`.
 * A file there whose holder is gone is removed first: by `breakDead` when given (the cap lock, broken under the mutex),
 * otherwise only if it still holds exactly the text judged dead (the mutex itself). Never by age: a holder that cannot be
 * judged (an unreadable file, which the whole-file write does not produce) is waited for, like a live one.
 */
async function acquire(path: string, me: string, deadline: number, breakDead?: (text: string) => Promise<void>): Promise<void> {
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(mine, me, { mode: 0o600, flag: "wx" });
  try {
    for (;;) {
      try {
        linkSync(mine, path);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const { text, holder } = readHolder(path);
      if (text !== null && holder && !sameProcess(Number(holder.pid), holder.pidStart)) {
        if (breakDead) await breakDead(text);
        else removeIfSame(path, text);
      } else if (Date.now() >= deadline) {
        throw new Error(
          holder
            ? `the lock ${path} is held by process ${holder.pid ?? "unknown"}`
            : `the lock ${path} cannot be read; if no payment is being made, remove it`,
        );
      }
      if (Date.now() >= deadline) throw new Error(`the lock ${path} could not be taken in time`);
      await sleep(RETRY_MS);
    }
  } finally {
    try {
      unlinkSync(mine);
    } catch {
      // already gone
    }
  }
}

/** Remove `path` if it still holds exactly `text`. */
function removeIfSame(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text) unlinkSync(path);
  } catch {
    // gone, or someone else removed it
  }
}

/** Take the lock at `path`, waiting up to `timeoutMs`. Returns the text written, which is how its owner knows it. */
async function take(path: string, timeoutMs: number): Promise<string> {
  const me = ownerText();
  const deadline = Date.now() + timeoutMs;
  await acquire(path, me, deadline, (dead) => breakLock(path, dead, deadline));
  return me;
}

/**
 * Remove a dead holder's lock under the break mutex, and only if it is still that same lock. The mutex is taken like the
 * lock (whole file, holder identity) and taken over only from a holder that is gone, so a breaker that is paused while
 * holding it keeps it; when it resumes, it reads the lock again and finds any replacement.
 */
async function breakLock(path: string, dead: string, deadline: number): Promise<void> {
  const mutex = `${path}.break`;
  const me = ownerText();
  await acquire(mutex, me, deadline);
  try {
    breakTestHook.holdingMutex?.();
    await breakTestHook.afterMutex?.();
    removeIfSame(path, dead);
  } finally {
    release(mutex, me);
  }
}

/** Release a lock or mutex only if it is still ours. */
function release(path: string, me: string): void {
  removeIfSame(path, me);
}

/** Run `work` holding the lock at `path`. Throws when a live holder keeps it past `timeoutMs`. */
export async function withFileLock<T>(path: string, work: () => T | Promise<T>, timeoutMs = 10_000): Promise<T> {
  const me = await take(path, timeoutMs);
  try {
    return await work();
  } finally {
    release(path, me);
  }
}

/** Tests only: hooks inside a break, while its mutex is held, to force the interleavings the design is about. */
export const breakTestHook: { holdingMutex?: () => void; afterMutex?: () => Promise<void> } = {};

/** Tests only: the lock's internals. */
export const lockForTests = { take, release, breakLock, removeIfSame };
