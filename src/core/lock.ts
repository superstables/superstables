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


import { createIdentitySource, inspectProcess, preferredProcessStart, sameProcess } from "./process-identity.mjs";
export { processStart } from "./process-identity.mjs";
const identity = createIdentitySource();

export function thisProcess(): { pid: number; start: string | null } & Omit<import("./process-identity.mjs").ProcessRecord, "pid" | "pidStart"> {
  const { pidStart, ...record } = identity.record();
  return { ...record, start: preferredProcessStart(pidStart, record.pidStartUtc) };
}

export function processRunning(runner: { pid?: unknown; start?: unknown; namespace?: string | null; bootId?: string | null; hostId?: string | null; platform?: string; hostname?: string; writtenAt?: number } | undefined): boolean {
  if (!runner || typeof runner.pid !== "number") return false;
  return sameProcess(runner.pid, typeof runner.start === "string" ? runner.start : null, undefined, runner);
}

/** What a lock or mutex file says about its holder, or null when it cannot be read as one. */
function readHolder(path: string): { text: string | null; holder: import("./process-identity.mjs").ProcessRecord | null } {
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
    const holder = JSON.parse(text) as import("./process-identity.mjs").ProcessRecord | null;
    return { text, holder: holder && typeof holder === "object" ? holder : null };
  } catch {
    return { text, holder: null };
  }
}

const ownerText = () =>
  JSON.stringify({ ...identity.record(), owner: randomBytes(8).toString("hex") });

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
      if (text !== null && holder && !sameProcess(Number(holder.pid), holder.pidStart, holder.pidStartUtc, holder)) {
        if (breakDead) await breakDead(text);
        else removeIfSame(path, text);
      } else if (Date.now() >= deadline) {
        throw new Error(
          holder
            ? `the lock ${path} is held by process ${holder.pid ?? "unknown"}${inspectProcess(holder).possiblyAlive ? "; the holder may still be running; stop all work and retry on the host, outside the sandbox, where process identity and the PID namespace can be read" : ""}`
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
