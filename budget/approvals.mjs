// Detached owner approvals. An agent's shell tool usually shows a command's output only when the command exits, so an
// owner command on evm that waits for the owner's wallet would hide its own approval link. In detached mode the command
// starts itself again as a background worker (the same command, blocking, with its output in a log file), returns as
// soon as the worker has a link, and the caller polls with `superstables budget wait --id <id> --shown`.
//
//   startDetached            the caller's side: register an id, start the worker, return once it has a link or has ended.
//   recordLink, recordFinal  the worker's side: each link once its words for the owner are logged (linkGate), then the final RESULT and exit code.
//   waitFor                  `superstables budget wait`: the current state, within a timeout. It never signs or sends.
//   findPending, claim       one owner approval at a time on a rail and chain.
//
// Hosted approvals (`setup --hosted`, every rail): the request lives on superstables.com. The rail script stores the site's request
// id and the agent's access token for it in the record (recordHosted); `wait` reads the request's state from the site, and
// `--replace` asks the site to cancel it. The token is removed from the record once the approval is final.
//
// A host may end every process a command started when that command ends (Codex does), so the worker can be gone before the
// owner approves. A hosted request the site still holds is then finished by the next `wait`: restartWorker starts the same worker
// command again with RESUME_ENV set, and the rail script takes the recorded request over (hosted.ts) instead of creating one,
// then does what the first worker would have done. Until that finishes, the record holds the chain (lockHeld): no second
// request starts before the first is reconciled. A setup retry can also retire a link the site confirms finally expired,
// with no send evidence. Not wait, not a startup that failed, not a count of failed restarts. Only the owner can end it otherwise
// (--replace, which the site must confirm, or the owner's terminal unlock of the chain, which does not reconcile the request).
//
// Files, under $SUPERSTABLES_HOME/budget/approvals/ (paths.mjs), no key material in any of them:
//   <id>.json               the record (mode 600): command, rail, chain, pid (with its start), link, terms, and the final RESULT once known;
//                           for a hosted approval also the site, its request id and, until final, the access token
//   <id>.log                the worker's stdout and stderr: the plan, the page, the chain reads
//   active-<rail>-<chain>   the lock: {id, pid, pidStart, createdAt} of the approval (or blocking command) that holds that chain,
//                           created in one exclusive step (a temp file hard-linked to this name), never half written
//
// The worker is detached (its own session and process group: its rail script and the page's process are in that group
// too), so it outlives the caller, and it ends on its own: the owner page expires its link, the command reads the chain
// for a bounded time, and a backstop in the worker (workerDeadlineMs) stops the whole group if anything hangs.
// Liveness is the group's, never one pid's: a dead worker whose page process still runs holds its chain, and `wait` says
// it has no final result, until every process in the group is gone (or `wait` stops the group after its deadline).
// A command in a terminal (blocking) holds the same lock, with its own pid and its rail script's process group.
// Every pid is recorded with its process's start time (procs.mjs), and a pid whose process has a different start time is
// a new process that reused the number: it is treated as gone, and never signalled.
// Nothing here kills a process group it did not start. `--replace` first asks the running page to cancel
// (POST /cancel): only a page that confirms the wallet was never asked is stopped.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HOME, approvalsDir, ensurePrivateDir, ownerApprovalsLog } from "./paths.mjs";
import { writeJournalFile } from "./journal.mjs";
import { spawnIdentified } from './child-identity.mjs';
import { createIdentitySource, inspectProcess, visiblePid } from '../src/core/process-identity.mjs';
import { clearFileLock, inspectLockText, recoveryResult, paymentBusy } from '../src/core/owner-recovery.mjs';
import { groupAlive as groupOf, sameProcess } from "./procs.mjs";
import { accountWaitingWords, cancelSiteRequest, readSiteRequest, siteText, siteWord, viewEvidence } from "./site.mjs";
import { readCapped } from "./response.mjs";

/** A lock younger than this is never taken over, whatever its processes look like (startup: the record is being written). */
export const STARTUP_GRACE_MS = 30_000;

/** Set in the worker's environment: the id of the approval it runs. */
export const WORKER_ENV = "SUPERSTABLES_BUDGET_APPROVAL_ID";
/** Set in an owner command's rail script environment: the id of the approval record it may add a hosted request to. */
export const HOLDER_ENV = "SUPERSTABLES_BUDGET_HOLDER";
/** Set in a worker that finishes an approval an earlier worker began: the id of that approval. */
export const RESUME_ENV = "SUPERSTABLES_BUDGET_RESUME";
/** The restart a worker is: the record's `resumes` as it was when this worker was started. Only the newest restart marks or relies on a takeover. */
export const RESUME_GENERATION_ENV = "SUPERSTABLES_BUDGET_RESUME_GENERATION";
/** Set in the rail script environment of an owner command run with --sign-only: the id of the approval that keeps the signed request. */
export const SIGN_ONLY_ENV = "SUPERSTABLES_BUDGET_SIGN_ONLY";
/** Set in the owner command that `wait --site-request` runs to check a site request against a signed approval: that approval's id. */
export const ADOPT_ENV = "SUPERSTABLES_BUDGET_ADOPT";
/** With ADOPT_ENV: the request id, link and match code the connector returned, as JSON { requestId, link, matchCode }. */
export const ADOPT_REQUEST_ENV = "SUPERSTABLES_BUDGET_ADOPT_REQUEST";
/** The site takes an agent proof only within 300 seconds of its timestamp: a signed request is sendable that long after signing. */
export const SIGNED_WINDOW_MS = 300_000;
/** How long the owner page keeps a link open after the wallet was asked to send (owner-approval-server.ts). */
const SENDING_GRACE_S = 120;
/** Reading the chain after the wallet sent: readSent waits up to 180 s, then the allowance reads. */
const VERIFY_S = 420;
/** How long the caller waits for the worker's first link. */
export const LINK_WAIT_MS = 120_000;
/** After `wait` started a worker again, and the owner had already acted, the most it keeps reading for that worker to finish. */
export const RESUME_WAIT_MS = 150_000;
/** The worker's backstop: after this, it stops its rail script and reports unknown. */
export const workerDeadlineMs = (timeoutS) => (Number(timeoutS) + SENDING_GRACE_S + VERIFY_S) * 1000;

const ID_RE = /^oa-\d{14}-[0-9a-f]{8}$/;
export const isApprovalId = (id) => typeof id === "string" && ID_RE.test(id);
export const newApprovalId = () => `oa-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;

const recordFile = (id) => join(approvalsDir(), `${id}.json`);
export const logFile = (id) => join(approvalsDir(), `${id}.log`);
const activeFile = (rail, chain) => join(approvalsDir(), `active-${rail}-${chain}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir() {
  ensurePrivateDir(approvalsDir(), { root: HOME });
}

/**
 * The approval record file of `id`, read so that a bad file is never taken for no approval: { kind: "none" } when there is no
 * file (or `id` is no approval id), { kind: "undecodable" } when a file is there but does not decode to a record (broken JSON,
 * `null`, `false`, `0`, an empty file, `{}`, an array, a record filed under another id, a file that cannot be read),
 * { kind: "record", record } otherwise.
 */
const existsAsLink = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";
const absentOr = (v, ok) => v === undefined || v === null || ok(v);

/**
 * Whether `s` is payment evidence as budget/once.mjs writes it (unionSeen): `hashes` a list of text, `payers` an object of text or null,
 * `payer`, `nonce` and `order` text or null, `validBefore` a number or null, and the flags true or false. Older records may lack any of
 * them. The merge (unionSeen) and the check that evidence only grows (seenGrows) read these, so evidence of another shape is damage.
 */
const isEvidence = (s) => isObject(s)
  && absentOr(s.hashes, (h) => Array.isArray(h) && h.every((t) => typeof t === "string"))
  && absentOr(s.payers, (p) => isObject(p) && Object.values(p).every((w) => w === null || typeof w === "string"))
  && ["payer", "nonce", "order"].every((k) => absentOr(s[k], (v) => typeof v === "string"))
  && absentOr(s.validBefore, Number.isFinite)
  && ["named", "paid", "stepOver", "moved"].every((k) => absentOr(s[k], (v) => typeof v === "boolean"));

/**
 * Whether a record that carries its own id is one `wait` can answer from, as every writer makes one: the command, rail and chain are
 * text, a stored final is { code: integer, result: { state: text } }, payment evidence has its shape (isEvidence), and the other fields
 * wait goes through (hosted, pid, deadline, workerArgs, timeoutS) have their own. A purchase that is not over is read back from its site, so it needs one. `{ "id": ... }`
 * alone, `final: true` or a site that is not text make an approval wait cannot read, not one to act on.
 */
function usableRecord(value) {
  return isText(value.command) && isText(value.rail) && isText(value.chain)
    && absentOr(value.final, (f) => isObject(f) && Number.isInteger(f.code) && isObject(f.result) && isText(f.result.state))
    && absentOr(value.hosted, (h) => isObject(h) && absentOr(h.site, (x) => typeof x === "string"))
    && (value.command !== "buy-once" || value.final || (isObject(value.hosted) && isText(value.hosted.site)))
    && absentOr(value.seen, isEvidence)
    && absentOr(value.pid, Number.isInteger)
    && absentOr(value.deadline, Number.isFinite)
    && absentOr(value.workerArgs, Array.isArray)
    && absentOr(value.timeoutS, Number.isFinite);
}

/**
 * The approval record file of `id`, read so that a bad file is never taken for no approval: { kind: "none" } when there is no
 * file (or `id` is no approval id), { kind: "undecodable" } when a file is there but does not decode to an object carrying `id` (broken JSON,
 * `null`, `false`, `0`, an empty file, `{}`, an array, a record filed under another id, a dangling link, a file that cannot be read),
 * { kind: "damaged", record } when it carries `id` but is not a record `wait` can answer from (see usableRecord), and
 * { kind: "record", record } otherwise. A damaged record is still an approval that holds its chain: readApproval returns it.
 */
export function readApprovalFile(id) {
  if (!isApprovalId(id)) return { kind: "none" };
  let text;
  try {
    text = readFileSync(recordFile(id), "utf8");
  } catch (err) {
    // a dangling link in the record's place is there, and is not a record
    return err?.code === "ENOENT" && !existsAsLink(recordFile(id)) ? { kind: "none" } : { kind: "undecodable" };
  }
  try {
    const value = JSON.parse(text);
    // a record is an object that carries its own id: `{}`, an array, a number, a string, or a record filed under another id is not one
    if (!(value && typeof value === "object" && !Array.isArray(value) && value.id === id)) {
      // an object that carries another id (a record filed under the wrong name) is not this approval's record; readApproval, which lock
      // recovery reads, still returns what it holds, as it always has: it may name a live process or a token that holds the chain
      return value && typeof value === "object" && !Array.isArray(value) ? { kind: "undecodable", value } : { kind: "undecodable" };
    }
    return { kind: usableRecord(value) ? "record" : "damaged", record: value };
  } catch {
    return { kind: "undecodable" };
  }
}

export function readApproval(id) {
  const file = readApprovalFile(id);
  return file.record ?? file.value ?? null;
}

/** The code of the error a strict change throws when the record's file is gone, or is not a record `wait` can answer from, once the command has read it. */
export const RECORD_GONE = "RECORD_GONE";
const recordGone = (id) => Object.assign(new Error(`the record of ${id} is gone, is not a record any more, or is no longer the approval this command read`), { code: RECORD_GONE });

/**
 * Whether `now` is still the approval a command saw as `seen`: the same id, command, rail and chain, made at the same moment, on the same
 * site, and still holding a hosted request once it held one (no writer removes it). The request id itself may change: a command that
 * asks the owner twice records a second request. A decision about one request (asking the site to cancel it, a restart that takes it
 * over) compares its id as well.
 */
export function sameApproval(seen, now) {
  if (!isObject(seen) || !isObject(now)) return false;
  for (const k of ["id", "command", "rail", "chain", "createdAt"]) if (seen[k] !== undefined && now[k] !== seen[k]) return false;
  if (isObject(seen.hosted) && !(isObject(now.hosted) && now.hosted.site === seen.hosted.site)) return false;
  // a buy-once purchase is one request on the site from start to end: a record of another request is another purchase
  if (seen.command === "buy-once" && isObject(seen.hosted) && now.hosted.requestId !== seen.hosted.requestId) return false;
  return true;
}

/**
 * The one strict read: the record of `id` when its file holds a record `wait` can answer from and, when `strict` is a record (what the
 * command saw before), it is still that approval (sameApproval); null otherwise. Every read and change `wait` makes after its first read of
 * a record goes through here, and a change under the record's lock too (writeRecord): `strict` is true, or the record seen before.
 */
export function readStrict(id, strict = true) {
  const file = readApprovalFile(id);
  if (file.kind !== "record") return null;
  return strict === true || sameApproval(strict, file.record) ? file.record : null;
}

/**
 * Store a record (mode 600). A buy-once purchase has no worker: its record is made here (once.mjs). A final record stays
 * final: a whole new record that is not final does not replace it. Through writeRecord, like every write.
 */
export function saveApproval(record) {
  return writeRecord(record.id, (now) => (now?.final && !record.final ? null : structuredClone(record)));
}

/**
 * Change a record under its lock, read, decided and written in one step: `fn` gets the record as stored now and returns
 * the patch (null: no change). A final record changes only by another final result, as with every other write. `strict` (every change
 * `wait` makes): true, or the record the command read before; the record under the lock must pass readStrict, or the change throws
 * RECORD_GONE and nothing is written.
 */
export function updateApproval(id, fn, { strict = false } = {}) {
  return update(id, fn, { strict });
}

/**
 * Finish a record under its lock, deciding from the record as stored now: `decide` gets it (never a final one) and
 * returns { code, result, record? } to store (`record`: more fields for the record itself), or null to store nothing. The same as
 * recordFinal otherwise. Returns the record, and
 * whether this call made it final.
 */
export function recordFinalWith(id, decide, { strict = false } = {}) {
  let decided = null;
  const endedAt = new Date().toISOString();
  const record = update(id, (before) => {
    if (before.final) return null;
    decided = decide(before);
    if (!decided) return null;
    return { ...(decided.record ?? {}), state: "final", endedAt, final: { code: decided.code, result: decided.result }, ...(before.hosted ? { hosted: { ...before.hosted, token: undefined } } : {}) };
  }, { strict });
  // stored only when the write was accepted: a refused one (a record filed under another id) returns the record as it was
  const stored = Boolean(record && decided && record.final && record.endedAt === endedAt);
  if (stored) release(record.rail, record.chain, id);
  return { record, stored };
}

/**
 * Tests only: a function called inside a record's lock, before the write (to force an interleaving).
 * @type {{ inLock: null | ((id: string) => void) }}
 */
export const recordTestHook = { inLock: null };

const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** The record's lock file. */
export const recordLockFile = (id) => `${recordFile(id)}.lock`;
/** How long a change to a record waits for its lock before it fails with a clear error. Tests may shorten it. */
export const recordLockOptions = { timeoutMs: 15_000 };
/** A short pause after every attempt that did not get a lock file, so a waiter never spins. */
const LOCK_RETRY_MS = 10;

// ── locks held for a moment (a record's read and write, the break of a dead holder's lock) ──────────────────
// The design of src/core/lock.ts, synchronous here because every caller writes a record synchronously (a RESULT is
// recorded and the process exits). A lock or mutex file holds { pid, pidStart, owner }: the holder's pid, that process's
// start identity and a random owner id, written whole to a temporary file, flushed to disk and hard-linked into place, so
// it exists complete or not at all. It is taken over only from a holder that is gone (no process with that pid and start runs),
// never because it is old: a live holder may be paused for any time. A dead holder's lock is broken under a mutex that
// follows the same rules, and only if it is still that exact lock; a lock is released only by its owner. A file that
// cannot be read as a holder (the whole-file write does not make one) is waited for, never taken, and named in the
// error at the deadline. A synchronous wait blocks this process's timers; the locks are held for a read and a write only.

const lockOwnerText = () => JSON.stringify({ pid: process.pid, ...startOf(process.pid), owner: randomBytes(8).toString("hex") });

/** What a lock or mutex file says about its holder. */
function lockHolder(path) {
  let text = null;
  try {
    text = readFileSync(path, "utf8");
    const holder = JSON.parse(text);
    return { text, holder: holder && typeof holder === "object" ? holder : null };
  } catch {
    return { text, holder: null };
  }
}

/** Remove `path` if it still holds exactly `text`. */
function removeIfSame(path, text) {
  try {
    if (readFileSync(path, "utf8") === text) unlinkSync(path);
  } catch {}
}

/** Write a new holder file whole and flush it, before it can be linked into place as a lock: a lock that survives a crash must hold its holder in full. */
function writeHolderFile(path, text) {
  const fd = openSync(path, "wx", 0o600);
  try {
    const bytes = Buffer.from(text);
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create `path` holding `me` (temp file + hard link), waiting until `deadline`. A file there whose holder is gone is
 * removed first: by `breakDead` (a lock, broken under its mutex), else only if it still holds the text judged dead (the
 * mutex itself). Throws at the deadline, naming the holder or the unreadable file.
 */
function acquireSync(path, me, deadline, breakDead) {
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeHolderFile(mine, me);
    for (;;) {
      try {
        linkSync(mine, path);
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const { text, holder } = lockHolder(path);
      if (text !== null && holder && !alive(Number(holder.pid), holder.pidStart, holder.pidStartUtc, holder)) {
        if (breakDead) breakDead(path, text, deadline);
        else removeIfSame(path, text);
      }
      if (Date.now() >= deadline) {
        throw new Error(holder
          ? `the lock ${path} is held by process ${holder.pid ?? "unknown"}${inspectProcess(holder).possiblyAlive ? ". " + paymentBusy : ", which is still running"}`
          : text === null ? `the lock ${path} could not be taken in time`
            : `the lock ${path} cannot be read. ${paymentBusy}`);
      }
      pauseSync(LOCK_RETRY_MS);
    }
  } finally {
    try { unlinkSync(mine); } catch {}
  }
}

/** Tests only: called while a break holds its mutex, before it reads the lock again (to force the interleavings). */
export const breakTestHook = { holdingMutex: null };

/** Remove a dead holder's lock under the break mutex, and only if it is still that same lock. */
function breakDeadLock(path, dead, deadline) {
  const mutex = `${path}.break`;
  const me = lockOwnerText();
  acquireSync(mutex, me, deadline);
  try {
    breakTestHook.holdingMutex?.(path);
    removeIfSame(path, dead);
  } finally {
    removeIfSame(mutex, me);
  }
}

/** The records whose lock this process holds across asynchronous work (holdingRecordLock). */
const heldRecordLocks = new Set();

/**
 * Hold the record's lock from before `fn` reads the record until it is done, across its awaits: no other process changes the
 * record, starts a worker or a rail script for it (spawnRail, restartWorker), or ends it in between. This process's own record
 * writes under `fn` run under it, as one step each.
 */
async function holdingRecordLock(id, fn) {
  ensureDir();
  const path = recordLockFile(id);
  const me = lockOwnerText();
  try {
    acquireSync(path, me, Date.now() + recordLockOptions.timeoutMs, breakDeadLock);
  } catch (err) {
    // the lock is held by a process that is still running: the caller can say so and ask to be run again
    // only the deadline's error says "busy" (a file system error already carries its own code, EACCES or ENOSPC for instance)
    if (err && typeof err === "object" && !err.code) err.code = "RECORD_BUSY";
    throw err;
  }
  heldRecordLocks.add(id);
  try {
    return await fn();
  } finally {
    heldRecordLocks.delete(id);
    removeIfSame(path, me);
  }
}

/**
 * Run `fn` holding the record's lock: the worker, the caller, `wait` and `--replace` all change a record by reading it
 * and writing it back, so each change is made whole, one process at a time.
 */
function withRecordLock(id, fn) {
  // abandonApproval holds the record's lock across its stop (holdingRecordLock): its own writes in that span are made under it
  if (heldRecordLocks.has(id)) return fn();
  ensureDir();
  const path = recordLockFile(id);
  const me = lockOwnerText();
  acquireSync(path, me, Date.now() + recordLockOptions.timeoutMs, breakDeadLock);
  try {
    return fn();
  } finally {
    removeIfSame(path, me);
  }
}

/**
 * Write a record whole to the file of `id`, the record whose lock the caller holds: the destination is never taken from the
 * record itself. A final record never keeps an access token, whoever wrote it.
 */
function writeApproval(id, record) {
  ensureDir();
  const out = record.final && record.hosted?.token ? { ...record, hosted: { ...record.hosted, token: undefined } } : record;
  // a temp file with a random name, opened exclusively so a planted symlink is never followed, synced, then renamed (journal.mjs)
  writeJournalFile(recordFile(id), JSON.stringify(out, null, 2) + "\n");
  return JSON.parse(JSON.stringify(out));
}

/**
 * The one way a record is written; saveApproval and update (with updateApproval, recordFinal and recordFinalWith on top of
 * it) all go through here. Under the record's lock it loads the record as stored and takes a deep copy of its payment
 * evidence (`seen`) as the baseline, before anything else runs. `compute` gets its own deep copy of the stored record (or
 * null), so nothing it does can change that baseline, and returns the whole record to write, or null for no change. The
 * result is refused, and the stored record returned unchanged, unless its `seen` keeps all of the baseline (seenGrows): a
 * result with no `seen`, or `seen: undefined`, counts as removing it. Refusing, rather than quietly unioning the stored
 * evidence back in, keeps this module free of how evidence merges (once.mjs owns that), and the caller's own record is
 * never stored altered behind its back. The result must be the locked record (`id` unchanged), and it is written to that
 * record's file only.
 */
function writeRecord(id, compute, { strict = false } = {}) {
  return withRecordLock(id, () => {
    // strict (wait's changes, after its first read): the record as stored under the lock must still be one wait can answer from, and (given
    // the record the command read) still that approval (readStrict); a file that went, turned bad or changed since the command read it ends
    // the change, with nothing written and no answer made of what is left
    const stored = strict ? readStrict(id, strict) : readApproval(id);
    if (strict && !stored) throw recordGone(id);
    const baseline = stored && stored.seen !== undefined ? structuredClone(stored.seen) : undefined;
    const next = compute(stored ? structuredClone(stored) : null);
    if (!next) return stored;
    // a write stays on the record it locked: a result that names another record is refused
    if (next.id !== id) return stored;
    // payment evidence only grows, whoever writes and whatever record they pass
    if (baseline !== undefined && !seenGrows(baseline, next.seen)) return stored;
    recordTestHook.inLock?.(id);
    return writeApproval(id, next);
  });
}

/** Change a record under its lock: `patch`, or a function of the record that returns the patch (null: no change). */
function update(id, patch, { strict = false } = {}) {
  if (!isApprovalId(id)) return null;
  return writeRecord(id, (record) => {
    if (!record) return null;
    const p = typeof patch === "function" ? patch(record) : patch;
    if (!p) return null;
    // a final record changes only by another final result (recordFinal), or by more payment evidence (`seen` alone, which
    // only grows): no write makes it not final again
    if (record.final && !p.final && Object.keys(p).some((k) => k !== "seen")) return null;
    return { ...record, ...p };
  }, { strict });
}

/**
 * Whether `next` keeps everything `prev` holds of a purchase's payment evidence (`seen`, budget/once.mjs): every hash, every
 * flag that was set, and every payer, which may only stay the same or become null (a conflict). EVM hashes and addresses are
 * compared in any letter case (one key per transaction), so writing a record's keys in their canonical form passes.
 */
export function seenGrows(prev, next) {
  if (!prev) return true;
  if (!next || typeof next !== "object") return false;
  const tx = (t) => (typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? t.toLowerCase() : t);
  const addr = (a) => (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);
  const hashes = new Set((next.hashes ?? []).map(tx));
  if (!(prev.hashes ?? []).every((h) => hashes.has(tx(h)))) return false;
  // every flag that was set stays set (named, paid, moved, stepOver, and any added later)
  for (const [flag, v] of Object.entries(prev)) if (v === true && next[flag] !== true) return false;
  // payers by canonical key; two spellings of one transaction with two payers are a conflict (null), as in once.mjs
  const merged = (payers) => {
    const out = {};
    for (const [h, who] of Object.entries(payers ?? {})) {
      const k = tx(h);
      const w = who === null ? null : addr(who);
      out[k] = out[k] === undefined ? w : out[k] === w ? w : null;
    }
    return out;
  };
  const before = merged(prev.payers);
  const after = merged(next.payers);
  for (const [k, who] of Object.entries(before)) {
    if (!(k in after)) return false;
    // a payer stays, or becomes null (a conflict); null never becomes an address again
    if (after[k] !== null && after[k] !== who) return false;
  }
  return true;
}

/** Compatible local start and, on macOS, separate UTC seconds for new readers. */
const identity = createIdentitySource();
const startOf = (pid) => identity.fields(pid);

/**
 * Whether the process recorded as `pid`, started at `start`, still runs (EPERM: it exists, under another user). A pid now
 * held by a process with another start time is a reused number: not alive.
 */
export const alive = (pid, start, startUtc, location) => sameProcess(pid, start, startUtc, location);

/**
 * Whether any process is left in the process group `pgid` (a detached worker is its group's leader: pgid = its pid) whose
 * leader was recorded with start identity `start`. A number reused by another process is not that group.
 */
export const groupAlive = (pgid, start, startUtc, location) => groupOf(pgid, start, startUtc, location);

/**
 * Whether anything this approval started may still run: its worker (or blocking command), the worker's process group
 * (its rail script and the page's process), and a blocking command's rail group.
 */
export const processesAlive = (record) =>
  Boolean(record && (alive(record.pid, record.pidStart, record.pidStartUtc, { ...record, createdAt: record.foreground ? record.createdAt : undefined }) || groupAlive(record.pid, record.pidStart, record.pidStartUtc, { ...record, createdAt: record.foreground ? record.createdAt : undefined }) || groupAlive(record.railPgid, record.railPgidStart, record.railPgidStartUtc, { ...record, selfStartedAt: record.railSelfStartedAt, namespace: 'railNamespace' in record ? record.railNamespace : record.namespace, writtenAt: record.railWrittenAt, bootElapsedMs: record.railBootElapsedMs, createdAt: undefined })));

/** A record without a final result whose processes may still run: it holds its chain. */
export const isLive = (record) => Boolean(record && !record.final && processesAlive(record));

/**
 * Stop a process group this command started, whose leader was recorded with start identity `start`: SIGTERM, then SIGKILL.
 * Returns true once no process is left in it. A group whose number now belongs to another process is never signalled.
 * @param {number} pgid
 * @param {{ start?: string | null, startUtc?: number | null, location?: import("../src/core/process-identity.mjs").ProcessRecord, graceMs?: number }} [options]
 */
export async function stopGroup(pgid, { start, startUtc, location = {}, graceMs = 3000 } = {}) {
  const left = () => groupAlive(pgid, start, startUtc, location);
  if (!left()) return true;
  // The startup window may refuse recovery, but cannot authorize signalling a group.
  const checked = inspectProcess({ ...location, selfStartedAt: undefined, pid: pgid, pidStart: start, pidStartUtc: startUtc }, undefined, true);
  if (checked.possiblyAlive) return false;
  const target = visiblePid({ ...location, pid: pgid }, undefined, true);
  if (!target) return false;
  try { process.kill(-target, "SIGTERM"); } catch {}
  for (let t = 0; t < graceMs && left(); t += 100) await sleep(100);
  if (left()) { try { process.kill(-target, "SIGKILL"); } catch {} }
  for (let t = 0; t < 2000 && left(); t += 100) await sleep(100);
  return !left();
}

/** Stop everything an approval started: its worker's group and a blocking command's rail group. */
async function stopRecord(record) {
  await stopGroup(record.pid, { start: record.pidStart, startUtc: record.pidStartUtc, location: { ...record, createdAt: record.foreground ? record.createdAt : undefined } });
  if (record.railPgid) await stopGroup(record.railPgid, { start: record.railPgidStart, startUtc: record.railPgidStartUtc, location: { ...record, selfStartedAt: record.railSelfStartedAt, namespace: 'railNamespace' in record ? record.railNamespace : record.namespace, writtenAt: record.railWrittenAt, bootElapsedMs: record.railBootElapsedMs, createdAt: undefined } });
}

/**
 * Whether something of an approval was started a moment ago and is not in the record yet: its worker (startDetached saves the
 * record, spawns the worker, then publishes its pid) or its rail script (spawnRail marks the record before it starts one). It
 * may be running unseen, so nothing ends the approval yet.
 */
export const startingUp = (record) => Boolean(record && !record.final && !record.foreground
  && ((record.pid == null && !(Date.now() - Date.parse(record.createdAt) >= STARTUP_GRACE_MS))
    || (record.railSpawning && Date.now() - record.railSpawning < STARTUP_GRACE_MS)));

/**
 * The owner gives up an approval no later `wait` can settle (their own terminal asks for it, never an agent call): stop
 * everything it started, then end it with the result `build` returns, only if no process of it runs, its worker is not still
 * being launched, and no result was stored first. The record's lock is held from the first read to the write, so what the
 * record names is all there is: a rail script is started and named in one locked step (spawnRail), a restart is one locked
 * step too, and neither can happen between the stop and the write. A worker's own final, a restart and this give-up cannot
 * both happen: whichever the lock admits first stands, and a restart finds the record final. The record keeps everything it holds (its
 * evidence, the request id and site, its log) except the access token. Nothing is asked of the site.
 * Every read of the record is strict (a file that is there and is not a record wait can answer from is no record, a stored final included):
 * `gone` (record null) when the file is missing, unusable or another approval (`seen`, sameApproval) at the first read or under the lock
 * when the give-up would be stored. Nothing
 * is stored then and the file is left as found, though the processes it named may have been stopped.
 * @returns {Promise<{ kind: "abandoned" | "ended" | "running" | "starting" | "gone", record: any }>} `ended`: a result was already
 * stored (the record is returned); `running`: a process of the approval could not be stopped; `starting`: its worker is
 * still being launched. Nothing was stored in the last two.
 */
export async function abandonApproval(id, build, { stop = stopRecord, attempts = 3, seen = true } = {}) {
  if (!isApprovalId(id)) return { kind: "ended", record: null };
  return holdingRecordLock(id, async () => {
    // `seen`: the record the command read before it asked the owner; one that is no longer that approval is not given up
    let record = readStrict(id, seen);
    if (!record) return { kind: "gone", record: null };
    for (let attempt = 0; !record.final && attempt < attempts; attempt++) {
      await stop(record);
      let out;
      try {
        out = recordFinalWith(id, (before) => (processesAlive(before) || startingUp(before) ? null : build(before)), { strict: record });
      } catch (err) {
        if (err?.code === RECORD_GONE) return { kind: "gone", record: null };
        throw err;
      }
      record = out.record;
      if (out.stored) return { kind: "abandoned", record };
    }
    return { kind: record.final ? "ended" : startingUp(record) ? "starting" : "running", record };
  });
}

// ── one approval at a time per rail and chain ──────────────────────────────────────────────────────────

function readLock(rail, chain) {
  let text;
  try {
    text = readFileSync(activeFile(rail, chain), "utf8");
  } catch {
    return null;
  }
  try {
    const lock = JSON.parse(text);
    if (lock && typeof lock.id === "string") return { ...lock, text };
  } catch {}
  // an older plain-id lock: its approval's record says whether it is held; its age comes from the file
  let createdAt = Date.now();
  try { createdAt = statSync(activeFile(rail, chain)).mtimeMs; } catch {}
  if (isApprovalId(text.trim())) return { id: text.trim(), pid: null, createdAt, text };
  // anything else cannot be read as a lock: it is held, never taken over, and named so a person can remove it
  return { id: "unreadable", pid: null, createdAt, text, unreadable: activeFile(rail, chain) };
}

/**
 * Whether a lock still holds its chain. The stale rule: the lock is free when its approval has a final result, or when it
 * is older than STARTUP_GRACE_MS, neither the process that claimed it nor any process of its approval is alive, and its
 * approval holds no hosted request that may still be open.
 */
function lockHeld(lock) {
  if (lock.unreadable) return true;
  const record = readApproval(lock.id);
  if (record?.final) return false;
  if (alive(lock.pid, lock.pidStart, lock.pidStartUtc, lock)) return true;
  if (processesAlive(record)) return true;
  // A hosted owner request the site may still hold (its token is in the record until the approval is final) keeps the chain: the
  // owner may approve it after its worker is gone, so nothing new is asked until `wait` or --replace has settled it. A
  // single purchase is its own record, read by buy-once itself.
  if (record?.hosted?.token && record.command !== "buy-once") return true;
  // so does a request signed here whose site request was given and is not adopted yet (unsettledRequest): the owner may approve that one too
  if (unsettledRequest(record)) return true;
  return Date.now() - Number(lock.createdAt ?? 0) < STARTUP_GRACE_MS;
}

/** What a refusal can say about the holder: its record, or what the lock alone knows while it starts. */
const holderOf = (lock, rail, chain) => lock.unreadable
  ? { id: "unknown", rail, chain, command: `an unreadable lock (${lock.unreadable}). ${paymentBusy}` }
  : readApproval(lock.id) ?? { id: lock.id, rail, chain, command: "an owner command (starting)" };

/** The approval that holds this rail and chain, or null. */
export function findPending(rail, chain) {
  const lock = readLock(rail, chain);
  if (!lock || !lockHeld(lock)) return null;
  return holderOf(lock, rail, chain);
}

/**
 * Remove a stale lock, but only the one judged stale, under the takeover mutex. The mutex follows the record lock's rules
 * (acquireSync: whole file, holder identity, taken over only from a holder that is gone, never by age). Returns false
 * when the mutex could not be had within a moment (another claimer is breaking it): the caller reports the holder.
 */
function breakStale(rail, chain, stale) {
  const mutex = `${activeFile(rail, chain)}.break`;
  const me = lockOwnerText();
  try {
    acquireSync(mutex, me, Date.now() + 2_000);
  } catch {
    return false;
  }
  try {
    const now = readLock(rail, chain);
    if (now && now.text === stale.text && !lockHeld(now)) unlinkSync(activeFile(rail, chain));
    return true;
  } finally {
    removeIfSame(mutex, me);
  }
}

/**
 * Take the rail and chain for `id`, held by `pid` (the claiming process) until the approval's own processes run. One
 * exclusive step: the lock is written in full to a private file, flushed to disk and hard-linked to its name, so it
 * exists complete or not at all. { ok: false, pending } when another approval holds them.
 */
export function claim(rail, chain, id, { pid = process.pid } = {}) {
  ensureDir();
  const path = activeFile(rail, chain);
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeHolderFile(mine, JSON.stringify({ id, pid, ...startOf(pid), createdAt: Date.now() }));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, path);
        return { ok: true };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const lock = readLock(rail, chain);
      if (lock) {
        if (lockHeld(lock)) return { ok: false, pending: holderOf(lock, rail, chain) };
        if (!breakStale(rail, chain, lock)) return { ok: false, pending: holderOf(lock, rail, chain) };
      }
      // released or broken meanwhile: a short pause before the next attempt, never a spin
      pauseSync(LOCK_RETRY_MS);
    }
    const lock = readLock(rail, chain);
    return { ok: false, pending: lock ? holderOf(lock, rail, chain) : { id: "unknown", rail, chain, command: "an owner command" } };
  } finally {
    try { unlinkSync(mine); } catch {}
  }
}

/** Free the chain if `id` holds it. */
export function release(rail, chain, id) {
  const lock = readLock(rail, chain);
  if (lock?.id === id) {
    try { unlinkSync(activeFile(rail, chain)); } catch {}
  }
}

/**
 * A command in a terminal (blocking) takes the chain like a worker: a record with its own pid, so a second owner command
 * is refused and can point at its link. `railPgid` is added when its rail script starts (setRailGroup).
 */
export function startForeground({ id, command, rail, chain }) {
  saveApproval({ id, command, rail, chain, state: "running", foreground: true, createdAt: new Date().toISOString(), pid: process.pid, ...startOf(process.pid), deadline: null });
}

/** The record fields that name a rail script's process group. */
function railFields(pgid, selfStartedAt) {
  const starts = startOf(pgid);
  if (process.platform === 'darwin' && selfStartedAt !== undefined) starts.selfStartedAt = selfStartedAt;
  return { railPgid: pgid, railPgidStart: starts.pidStart, ...(starts.selfStartedAt !== undefined ? { railSelfStartedAt: starts.selfStartedAt } : {}), railWrittenAt: starts.writtenAt, railBootElapsedMs: starts.bootElapsedMs, railNamespace: starts.namespace, ...(starts.pidStartUtc !== undefined ? { railPgidStartUtc: starts.pidStartUtc } : {}) };
}

/** The process group of a blocking command's rail script (its page and chain reads run there). */
export function setRailGroup(id, pgid, selfStartedAt) {
  return update(id, railFields(pgid, selfStartedAt));
}

/**
 * Start an approval's rail script and record its process group in one step, under the record's lock: whoever gives the
 * approval up (abandonApproval) or restarts it decides under the same lock, so it sees the rail script with its group named,
 * or finds the approval ended and nothing started. `spawn` returns the child. A record that is not there is not a reason to
 * stop (the rail starts, unrecorded, as it always did); one that has a result is: nothing is started.
 * @returns {{ child: any, ended: boolean }}
 */
export function spawnRail(id, spawn) {
  let child = null;
  let ended = false;
  // A worker that dies between starting the rail script and recording it leaves this mark and no group: for 30 seconds nothing
  // ends the approval (startingUp), because a rail script may be running that the record does not name.
  const marked = update(id, (before) => (before.final ? null : { railSpawning: Date.now() }));
  if (marked?.final) return { child: null, ended: true };
  let record;
  try {
    record = update(id, (before) => {
      if (before.final) { ended = true; return null; }
      child = spawn();
      return { ...(child?.pid ? railFields(child.pid) : {}), railSpawning: undefined };
    });
  } catch (err) {
    // the rail script may have started and not been recorded: it would run unseen, so it is stopped
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } }
    throw err;
  }
  if (!record && !child) child = spawn();
  return { child, ended };
}

/** The worker records its own pid at start, so its process group is known even if the caller died before writing it. */
export function adoptWorker(id) {
  const record = readApproval(id);
  if (record && !record.final && (!record.pid || (process.platform === 'darwin' && record.pid === process.pid))) update(id, { pid: process.pid, ...startOf(process.pid) });
}

// ── the worker's side ──────────────────────────────────────────────────────────────────────────────────

/** A link exists (the rail's APPROVE line): the approval now waits for the owner. A later link replaces it (recover asks twice). */
export function recordLink(id, approve, { wordsLogged = true } = {}) {
  return update(id, (record) => ({
    state: "waiting_owner",
    action: approve.action,
    url: approve.url,
    // recover asks on a second page: whether the wallet was asked is read from every page this approval had
    earlierUrls: record.url && record.url !== approve.url ? [...(record.earlierUrls ?? []), record.url] : record.earlierUrls,
    expires: approve.expires,
    terms: approve.terms,
    matchCode: typeof approve.matchCode === "string" ? approve.matchCode : undefined,
    // a later local link (recover on a hosted chain) is not the hosted request any more
    hosted: record.hosted && approve.matchCode ? record.hosted : undefined,
    links: (record.links ?? 0) + 1,
    // the rail's words for the owner did not reach the log with this link (linkGate): the caller must say so
    wordsMissing: wordsLogged ? undefined : true,
  }));
}

/**
 * The most a worker waits for the rail's words for the owner before it records a link without them (a rail that printed
 * a link and no words is a fault). Below LINK_WAIT_MS, so the caller still gets the link, marked wordsMissing.
 */
export const LINK_TEXT_WAIT_MS = 60_000;

/**
 * The worker's side of a link: record it (recordLink) only once the rail's words for the owner, which carry the link's
 * URL on stderr, have been written to this process's stderr (the worker's log). The caller returns as soon as the record
 * has a link and copies the log once more first, so the words are in what it copies. stdout and stderr are separate
 * pipes: the words may come before the APPROVE line, or after it. If the rail ends (`flush()`) or `waitMs` passes without
 * them, the link is recorded with wordsMissing, and the caller says so instead of returning without them.
 */
/**
 * Whether `text` names `url` as a whole token: preceded by the start, whitespace or a quote, and followed by the end,
 * whitespace or a quote, never by more URL characters (so neither a longer URL nor the URL with a suffix counts).
 */
export function namesUrl(text, url) {
  if (typeof text !== "string" || typeof url !== "string" || !url) return false;
  for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + url.length] ?? "";
    if ((before === "" || /[\s"'`<(]/.test(before)) && (after === "" || /[\s"'`>]/.test(after))) return true;
  }
  return false;
}

export function linkGate(id, { waitMs = LINK_TEXT_WAIT_MS, record = recordLink } = {}) {
  let pending = null;
  let seen = "";
  let timer = null;
  const commit = (wordsLogged) => {
    if (!pending) return;
    clearTimeout(timer);
    timer = null;
    const approve = pending;
    pending = null;
    seen = "";
    record(id, approve, { wordsLogged });
  };
  return {
    /** The rail printed an APPROVE line. */
    link(approve) {
      commit(false);
      pending = approve;
      if (typeof approve?.url !== "string") return commit(false);
      if (namesUrl(seen, approve.url)) return commit(true);
      timer = setTimeout(() => commit(false), waitMs);
    },
    /** The rail wrote `text` to stderr, and this process has written it on. */
    shown(text) {
      seen = (seen + text).slice(-32_000);
      if (pending && namesUrl(seen, pending.url)) commit(true);
    },
    /** The rail ended: record any link still waiting, as without its words. */
    flush: () => commit(false),
  };
}

/**
 * A hosted request exists for this approval (the rail script, before it prints the link): the site, the request id, the
 * match code and the agent's access token. Mode 600, like every record; the token never goes to a log.
 */
export function recordHosted(id, hosted) {
  if (!isApprovalId(id)) return null;
  // a final approval keeps no access token: checked and written under the record's lock, in one step
  return update(id, (record) => record.final ? null : { hosted: { site: hosted.site, requestId: hosted.requestId, kind: hosted.kind, matchCode: hosted.matchCode, token: hosted.token, ...(hosted.then?.length ? { then: hosted.then } : {}), ...(hosted.resumable ? { resumable: true, intent: hosted.intent, expiresAt: hosted.expiresAt, deadline: hosted.deadline, ...(hosted.proofVersion ? { proofVersion: hosted.proofVersion } : {}) } : {}), ...(hosted.signed ? { signed: hosted.signed } : {}) } });
}

// ── requests signed here and sent by the connector (--sign-only, then wait --site-request) ──────────────────────────────────
// The owner command signs its request and keeps it in an approval record that has no request id, token or match code yet, then
// exits; nothing holds the chain. `wait --site-request` checks the site request made from it (hosted.ts adopt) and records it here,
// after which the record is an ordinary resumable hosted approval: wait starts its worker again, and the worker takes it over.

/**
 * An owner command run with --sign-only: its record, made like a background approval's (startDetached), so that once a request is
 * adopted a later wait can start the same worker from `workerArgs`. This process holds the chain until it ends.
 */
export function startSigning({ id, command, rail, chain, workerArgs, timeoutS }) {
  saveApproval({ id, command, rail, chain, state: "signing", createdAt: new Date().toISOString(), pid: process.pid, ...startOf(process.pid), deadline: null, workerArgs, timeoutS });
}

/** The rail script signed the request (hosted.ts SignedRecord): kept with the approval, mode 600, before it is shown. */
export function recordSigned(id, s) {
  const stored = update(id, (record) => (record.final || record.hosted ? null : { state: "signed", hosted: { site: s.site, kind: s.kind, ...(s.then?.length ? { then: s.then } : {}), resumable: true, intent: s.intent, ...(s.proofVersion ? { proofVersion: s.proofVersion } : {}), signed: s.signed } }));
  if (stored?.hosted?.signed?.nonce !== s.signed.nonce) throw new Error(`approval ${id} could not keep the signed request; nothing was sent`);
}

/** A request signed here that no site request has been adopted for yet. */
export const awaitingAdoption = (record) => Boolean(record && !record.final && isObject(record.hosted?.signed) && !record.hosted.requestId);

/**
 * A site request given for this signed request and not adopted (yet): kept by `wait --site-request` before it asks the site or checks
 * anything, and dropped only on an answer of the site that gives it up (dropUnsettled). It may be this request,
 * open on the site, so the record holds the chain and reads unknown until a later wait adopts it.
 */
export const unsettledRequest = (record) => (awaitingAdoption(record) && isObject(record.hosted.signed.submitted) ? record.hosted.signed.submitted : null);

/** A signed request past the site's window that no site request was given for: the site no longer takes it, and nothing here sent it. */
export const signedExpired = (record, now = Date.now()) => awaitingAdoption(record) && !unsettledRequest(record) && now - Number(record.hosted.signed.signedAt) * 1000 > SIGNED_WINDOW_MS;

/**
 * The site request made from the signed request `nonce` passed every check (hosted.ts adopt): record it, its token included, in one
 * locked step, only while the record still holds that signed request with nothing adopted (or with this request unsettled). `shown`
 * is what the owner was given (the link, its expiry, the terms) and the action, for message_for_owner. The evidence mergeEvidence
 * kept stays with the signed request, so every later reader reports the outcome unknown until it is final. Throws when nothing was
 * recorded.
 */
export function adoptSigned(id, nonce, hosted, shown) {
  let taken = false;
  update(id, (before) => {
    if (!awaitingAdoption(before) || before.hosted.signed.nonce !== nonce) return null;
    const unsettled = unsettledRequest(before);
    if (unsettled && unsettled.requestId !== hosted.requestId) return null;
    taken = true;
    const { submitted: _adopted, ...signed } = before.hosted.signed;
    return {
      state: "waiting_owner", action: shown.action, url: shown.url, expires: new Date(shown.expires).toISOString(), terms: shown.terms, matchCode: hosted.matchCode,
      hosted: { ...before.hosted, requestId: hosted.requestId, token: hosted.token, matchCode: hosted.matchCode, expiresAt: hosted.expiresAt, deadline: hosted.deadline, signed },
    };
  });
  if (!taken) throw new Error(`approval ${id} no longer holds that signed request unadopted; nothing was recorded`);
}

/**
 * The one way anything about a site request given for the signed request `nonce` reaches its record: the request itself
 * (unsettledRequest), kept before anything is checked, and then what every answer about it showed, merged under the record's lock
 * before the next contact. Evidence only grows: a request already kept stays, the wallet once seen asked stays asked, hashes are
 * added to, and an answer without them changes nothing. Throws when nothing was kept.
 * @param {{ requestId: string, link: string, matchCode: string, walletAsked?: boolean, hashes?: string[] }} e
 */
export function mergeEvidence(id, nonce, e) {
  let kept = false;
  update(id, (before) => {
    if (!awaitingAdoption(before) || before.hosted.signed.nonce !== nonce) return null;
    const earlier = unsettledRequest(before);
    if (earlier && earlier.requestId !== e.requestId) return null;
    kept = true;
    const hashes = [...new Set([...(before.hosted.signed.hashes ?? []), ...(e.hashes ?? [])])];
    const walletAsked = before.hosted.signed.walletAsked === true || e.walletAsked === true || hashes.length > 0;
    return { hosted: { ...before.hosted, signed: { ...before.hosted.signed, submitted: earlier ?? { requestId: e.requestId, link: e.link, matchCode: e.matchCode }, ...(walletAsked ? { walletAsked: true } : {}), ...(hashes.length ? { hashes } : {}) } } };
  });
  if (!kept) throw new Error(`approval ${id} could not keep ${e.requestId}; whether the owner's wallet was asked for it is unknown`);
}

/**
 * The site gave up `requestId`, kept for the signed request `nonce` (hosted.ts givesUp): dropped under the record's lock, unless
 * the merged record holds any evidence that the wallet was asked. Whether it was dropped.
 */
export function dropUnsettled(id, nonce, requestId) {
  let dropped = false;
  update(id, (before) => {
    if (!awaitingAdoption(before) || before.hosted.signed.nonce !== nonce || unsettledRequest(before)?.requestId !== requestId || before.hosted.signed.walletAsked || before.hosted.signed.hashes?.length) return null;
    dropped = true;
    const { submitted: _dropped, ...signed } = before.hosted.signed;
    return { hosted: { ...before.hosted, signed } };
  });
  return dropped;
}

const bigintOut = (_key, value) => (typeof value === "bigint" ? { $bigint: value.toString() } : value);
const bigintIn = (_key, value) => (value && typeof value === "object" && typeof value.$bigint === "string" ? BigInt(value.$bigint) : value);

/**
 * What a rail script read from the chain before it asked the site (the block it asks from, a balance before): kept with the
 * approval, so the worker that finishes the request later checks the owner's transaction against the same facts.
 * Stored before the request exists. BigInts are kept whole.
 */
export function saveRequestFact(id, key, value) {
  return update(id, (record) => record.final ? null : { resume: { ...record.resume, facts: { ...record.resume?.facts, [key]: JSON.parse(JSON.stringify(value, bigintOut)) } } });
}

/** A fact saveRequestFact kept: { found: true, value }, or { found: false }. */
export function readRequestFact(id, key) {
  const facts = readApproval(id)?.resume?.facts;
  return facts && Object.hasOwn(facts, key) ? { found: true, value: JSON.parse(JSON.stringify(facts[key]), bigintIn) } : { found: false };
}

/** The resumed worker took the site's request over: from now on its result may be stored as the approval's final one. */
export function recordTakenOver(id, generation) {
  return update(id, (record) => {
    if (record.final) return null;
    // a worker that does not know its restart (no number), or that a newer restart replaced, marks nothing: only the restart that read the
    // request has taken it over
    if (!Number.isInteger(generation) || generation !== (record.resumes ?? 0)) return null;
    return { resume: { ...record.resume, takenOver: generation } };
  });
}

/** The restart number a restarted worker was given (RESUME_GENERATION_ENV): a positive whole number as written, else NaN, which matches no restart. */
export const resumeGeneration = (env = process.env) => (/^[1-9]\d*$/.test(env[RESUME_GENERATION_ENV] ?? "") ? Number(env[RESUME_GENERATION_ENV]) : Number.NaN);

/** Whether the worker that finishes approval `id` has taken the request over (set by recordTakenOver, once per restart). */
/** Whether `record` says the restart numbered `generation` is the newest and is the one that took the request over. */
export const takeoverHolds = (record, generation) => Boolean(record && generation === (record.resumes ?? 0) && record.resume?.takenOver === generation);

// the worker's own restart must still be the newest, and must be the one that took the request over
export const hasTakenOver = (id, generation) => takeoverHolds(readApproval(id), generation);

/**
 * End the approval for a restarted worker: stored only if, under the record's lock, no result stands and the worker is still the
 * newest restart and has taken the request over (takeoverHolds). A worker that was paused after it checked, and replaced by a
 * newer restart meanwhile, therefore stores nothing. Returns { record, stored } as recordFinalWith does.
 */
export function recordFinalAsRestart(id, generation, code, result) {
  return recordFinalWith(id, (before) => (takeoverHolds(before, generation) ? { code, result } : null));
}

/**
 * The approval ended, whichever way (approved, rejected, expired, cancelled or replaced, stopped by a timeout, or failed):
 * store its RESULT and exit code for every later `wait`, and free the chain. The access token goes. Every final result is
 * recorded here, and only here.
 */
export function recordFinal(id, code, result, { strict = false } = {}) {
  // one locked change: the result, and the hosted request without its access token (writeApproval enforces it too). A result
  // already stored stays: whatever ended the approval first (a worker, a give-up) is the answer every later wait gives.
  const endedAt = new Date().toISOString();
  let decided = false;
  const record = update(id, (before) => {
    if (before.final) return null;
    decided = true;
    return { state: "final", endedAt, final: { code, result }, ...(before.hosted ? { hosted: { ...before.hosted, token: undefined } } : {}) };
  }, { strict });
  // stored only when the write was accepted (see recordFinalWith)
  if (decided && record?.final && record.endedAt === endedAt) release(record.rail, record.chain, id);
  return record;
}

// ── the caller's side ──────────────────────────────────────────────────────────────────────────────────

/**
 * Copy what the worker logged since `at.offset` to `onLog`, and keep the tail of it in `at.text`. A log file that was
 * replaced (another inode) or truncated (shorter than the offset) is read again from its start; nothing follows a rotation.
 */
function forwardLog(id, at, onLog) {
  if (!onLog) return;
  let fd;
  try {
    fd = openSync(logFile(id), "r");
  } catch {
    return;
  }
  try {
    const st = fstatSync(fd);
    if ((at.ino !== undefined && st.ino !== at.ino) || st.size < at.offset) at.offset = 0;
    at.ino = st.ino;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, at.offset);
      if (n <= 0) break;
      const text = buf.subarray(0, n).toString("utf8");
      onLog(text);
      at.text = (at.text + text).slice(-256 * 1024);
      at.offset += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** Start a worker for approval `id`: detached (its own session and process group), its output in the approval's log. */
function launchWorker(id, { cmd, args, cwd, env = process.env }) {
  const fd = openSync(logFile(id), "a", 0o600);
  let child;
  try {
    child = spawnIdentified(cmd, args, { cwd, env: { ...env, [WORKER_ENV]: id }, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const state = { exited: false, error: undefined };
  child.on("exit", () => (state.exited = true));
  child.on("error", (err) => { state.exited = true; state.error = err; });
  return { child, state };
}

/**
 * Whether a later command can finish this approval: a hosted request of a rail script that stored what it needs to be run again
 * (`resumable`), whose worker command was recorded, and that no result has ended. However many restarts failed and however
 * long ago the request expired: only a worker that read the request on the site decides what became of it.
 */
export const canResume = (record) => Boolean(record && !record.final && !record.foreground && record.hosted?.token && record.hosted.resumable === true && Array.isArray(record.workerArgs));

/**
 * Start the worker of approval `id` again, to finish a hosted request whose first worker was ended (the host stopped every
 * process of the command that started it). Read, decided and written under the record's lock: only when the approval is
 * still open, resumable and no process of it runs, so two commands cannot start two workers. `script` is the dispatcher's
 * path; the arguments are the first worker's. The worker gets RESUME_ENV: its rail script takes the recorded request over
 * and creates none.
 * Every read is strict (readStrict): `seen` is the record `wait` decided to restart from. A record that is gone, is not one wait can answer
 * from, is no longer that approval, or holds another request than the one `seen` names, before or under the lock, starts nothing,
 * claims no chain and writes nothing: { started: false, gone: true }. The chain is claimed under the record's lock, right before the
 * launch, and the worker's identity, deadline and restart count are written in that same locked step.
 * @returns {{ started: boolean, record: any, gone?: boolean, blockedBy?: any }}
 */
export function restartWorker(id, { cmd, script, cwd, env = process.env, seen = true }) {
  const sameRequest = (r) => seen === true || (r.hosted?.requestId ?? null) === (seen.hosted?.requestId ?? null);
  const open = readStrict(id, seen);
  if (!open || !sameRequest(open)) return { started: false, record: null, gone: true };
  let launched = null;
  let blockedBy = null;
  let record;
  try {
    record = restartLocked(id, { cmd, script, cwd, env }, open, {
      request: sameRequest,
      // The chain is this approval's, or free for it: an owner who cleared the chain's lock by hand (unlock) and started another
      // approval since must not get two open requests from a restart.
      chain: (before) => {
        if (readLock(before.rail, before.chain)?.id === id) return true;
        const taken = claim(before.rail, before.chain, id);
        if (!taken.ok) blockedBy = taken.pending;
        return taken.ok;
      },
      remember: (l) => (launched = l),
    });
  } catch (err) {
    // the worker may have started and not been recorded: it would run unseen, so it is stopped
    try { if (launched?.child.pid) process.kill(-launched.child.pid, "SIGKILL"); } catch {}
    if (err?.code === RECORD_GONE && !launched) return { started: false, record: null, gone: true };
    throw err;
  }
  if (blockedBy) return { started: false, record: open, blockedBy };
  const child = launched?.child;
  if (!child?.pid || !record || record.pid !== child.pid) return { started: false, record };
  child.once("identity", (selfStartedAt) => {
    // strict as well: a record that went or changed since the restart is left as it is, and wait's next read answers that
    try { updateApproval(id, (r) => (r.pid === child.pid && !r.final ? { selfStartedAt } : {}), { strict: record }); } catch (err) { if (err?.code !== RECORD_GONE) throw err; }
  });
  child.unref();
  return { started: true, record };
}

/** The locked step of restartWorker: the strict read under the lock, the request check, the chain, the launch and its record, in that order. */
function restartLocked(id, { cmd, script, cwd, env }, open, { request, chain, remember }) {
  return update(id, (before) => {
    if (!canResume(before) || processesAlive(before)) return null;
    // a record that holds another request than the one wait decided to restart is not taken over
    if (!request(before)) throw recordGone(id);
    if (!chain(before)) return null;
    // the site this approval was made on is the one the restarted command asks: a command that took it from its environment
    // (SUPERSTABLES_SITE) must not take another from the environment `wait` runs in
    const launched = launchWorker(id, { cmd, args: [script, ...before.workerArgs], cwd, env: { ...env, [RESUME_ENV]: id, [RESUME_GENERATION_ENV]: String((before.resumes ?? 0) + 1), SUPERSTABLES_SITE: before.hosted.site } });
    remember(launched);
    // a worker that could not start counts as a restart that never took the request over
    if (!launched.child.pid) return { resumes: (before.resumes ?? 0) + 1 };
    return {
      pidStartUtc: undefined, selfStartedAt: undefined,
      ...startOf(launched.child.pid),
      pid: launched.child.pid,
      // nothing of the first worker's rail script is left to name
      railPgid: undefined, railPgidStart: undefined, railPgidStartUtc: undefined, railSelfStartedAt: undefined, railWrittenAt: undefined, railBootElapsedMs: undefined, railNamespace: undefined,
      deadline: Date.now() + workerDeadlineMs(before.timeoutS ?? 600),
      resumes: (before.resumes ?? 0) + 1,
    };
  }, { strict: open });
}

/**
 * Start the worker detached and return once it has a link ({ kind: "waiting" }), ended before it needed one
 * ({ kind: "final" }: a refusal before any page, nothing to do, or a stop after its command may have sent, unknown),
 * failed to open a page before it was about to send anything ({ kind: "failed" }), or opened none and its process group
 * would not stop, so a command in it may still send ({ kind: "unstopped" }: no final is stored, and the chain stays held).
 * @returns {Promise<{ kind: "waiting" | "final" | "failed" | "unstopped", record: any, reason?: string }>}
 * The caller must hold the chain (claim) first.
 */
export async function startDetached({ id, command, rail, chain, cmd, args, cwd, env = process.env, timeoutS = 600, onLog = null, linkWaitMs = LINK_WAIT_MS }) {
  // `workerArgs` (the worker's arguments after the script's path) and `timeoutS` let a later `wait` start the same worker again
  // (restartWorker) when the host ended this one before the owner approved.
  saveApproval({
    id, command, rail, chain, state: "starting", createdAt: new Date().toISOString(),
    deadline: Date.now() + linkWaitMs + workerDeadlineMs(timeoutS), pid: null, workerArgs: args.slice(1), timeoutS,
  });
  const { child, state: launched } = launchWorker(id, { cmd, args, cwd, env });
  const childStart = startOf(child.pid);
  if (child.pid) {
    updateApproval(id, record => ({ pid: child.pid, ...childStart, ...(process.platform === 'darwin' && record.pid === child.pid && Number.isFinite(record.selfStartedAt) ? { selfStartedAt: record.selfStartedAt } : {}) }));
    child.once('identity', selfStartedAt => updateApproval(id, record => record.pid === child.pid && !record.final ? { selfStartedAt } : {}));
  }
  const until = Date.now() + linkWaitMs;
  const at = { offset: 0, ino: undefined, text: "" };
  // The worker is stopped and never showed a link. A final it stored stands; one that may have sent is unknown; only one
  // that never was about to send fails. recordFinalWith frees the chain and removes any access token the worker recorded.
  // A hosted request the site may hold (the rail recorded it before the worker went) is never ended here: the owner can still
  // approve it. Everything the approval started is stopped, and its record and chain stay for `wait`.
  const holdOpen = async () => {
    const open = readApproval(id);
    if (!canResume(open)) return null;
    await stopRecord(open);
    return processesAlive(readApproval(id)) ? { kind: "unstopped", record: readApproval(id), reason: "the background approval stopped after it asked the site, but its processes would not stop; the chain stays held" } : { kind: "open", record: readApproval(id) };
  };
  const endWithoutLink = async (reason, failedReason) => {
    const held = await holdOpen();
    if (held) return held;
    const { record, stored } = recordFinalWith(id, (before) => recordMayHaveSent(before)
      ? sentUnknown(before, `${reason}, after its command was about to broadcast a transaction`)
      : { code: 1, result: { ok: false, command, rail, chain, state: "failed", id, next: "check wallet activity and budget status before retrying", reason } });
    release(rail, chain, id);
    return stored && !recordMayHaveSent(record) ? { kind: "failed", record, reason: failedReason } : { kind: "final", record: record ?? readApproval(id) };
  };
  for (;;) {
    forwardLog(id, at, onLog);
    const record = readApproval(id);
    // the worker writes the record and its log separately: once the record is there, forward what the log gained
    // meanwhile (the words for the owner come with the link), so the caller never returns without them
    if (record?.final) { forwardLog(id, at, onLog); child.unref(); return { kind: "final", record }; }
    if (record?.url) {
      forwardLog(id, at, onLog);
      child.unref();
      // the words for the owner name the link (the APPROVE line does not count); if what was forwarded does not (a log cut
      // short or replaced), say so
      const words = at.text.split("\n").filter((l) => !/^(APPROVE|RESULT) \{/.test(l)).join("\n");
      if (onLog && !record.wordsMissing && !namesUrl(words, record.url)) return { kind: "waiting", record: update(id, { wordsMissing: true }) ?? { ...record, wordsMissing: true } };
      return { kind: "waiting", record };
    }
    if (launched.exited) {
      await sleep(100);
      forwardLog(id, at, onLog);
      const last = readApproval(id);
      if (last?.final) return { kind: "final", record: last };
      // no page asked a wallet, but the command may have sent with its own key (recover's revoke): stop anything left in
      // its group before freeing the chain
      if (!(await stopGroup(child.pid, { start: childStart.pidStart, startUtc: childStart.pidStartUtc, location: childStart }))) return { kind: "unstopped", record: last, reason: `the background approval stopped before it opened a page, but process group ${child.pid} would not stop; the chain stays held` };
      const reason = launched.error ? `the background approval could not start: ${launched.error.message}` : "the background approval stopped before it opened a page";
      return endWithoutLink(reason, reason);
    }
    if (Date.now() > until) {
      if (!(await stopGroup(child.pid, { start: childStart.pidStart, startUtc: childStart.pidStartUtc, location: childStart }))) return { kind: "unstopped", record: readApproval(id), reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s, and process group ${child.pid} would not stop; the chain stays held` };
      return endWithoutLink(`no approval page within ${Math.round(linkWaitMs / 1000)} s`, `no approval page within ${Math.round(linkWaitMs / 1000)} s; the background approval was stopped`);
    }
    await sleep(150);
  }
}

/** Remove the files of an approval that never needed a link (it ended before asking the owner). */
export function forget(id) {
  for (const p of [recordFile(id), logFile(id)]) {
    try { unlinkSync(p); } catch {}
  }
}

/** The approval's page state for words: the site's request state when hosted, else the loopback page's own view. */
export async function pageStateOf(record) {
  const h = record?.hosted;
  if (h?.token) {
    const r = await readSiteRequest({ site: h.site, id: h.requestId, token: h.token, wait: 0 });
    // a link with wallet steps: once linked, the request's state is its current step's
    const linked = Array.isArray(r.view?.steps) && typeof r.view.owner === "string";
    const stepAsked = linked && r.view.steps.some((s) => s?.wallet_asked === true || typeof s?.tx_hash === "string");
    // the reason an open request is still waiting, as a documented word only
    const reasonCode = typeof r.view?.reason_code === "string" ? siteWord("code", r.view.reason_code) : null;
    return r.ok ? { status: `hosted:${siteWord("state", r.view.state)}`, linked, walletAsked: r.view.wallet_asked === true || typeof r.view.tx_hash === "string" || stepAsked, reasonCode } : { status: "hosted:unreachable" };
  }
  return pageState(record?.url);
}

/** The most read of one answer from an owner page on this computer: its /state and /cancel answers are a few hundred bytes. */
const PAGE_MAX_BYTES = 65_536;
/** An owner page's JSON answer, read up to PAGE_MAX_BYTES; null when it is longer, cut off or not JSON. */
async function pageJson(res) {
  const { bytes, truncated } = await readCapped(res, PAGE_MAX_BYTES);
  if (truncated) return null;
  try { return JSON.parse(bytes.toString("utf8")); } catch { return null; }
}

/** The owner page's own view (loopback), or null. Only for words; nothing is decided from it except --replace. */
export async function pageState(url) {
  if (!url) return null;
  try {
    const res = await fetch(`${url}/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await pageJson(res) : null;
  } catch {
    return null;
  }
}

/** What the page's status means for a caller who is waiting. On solana the wallet only signs and the command sends. */
export function pageWords(page, rail) {
  switch (page?.status) {
    case "pending": return "waiting for the owner to open the approval link and connect their wallet";
    case "ready": return "the owner account is selected; waiting for wallet approval";
    case "sending": return rail === "solana" ? "the owner signed in the wallet; the command is sending it" : "a wallet transaction was requested; submission is not confirmed yet";
    case "sent": return "a transaction id is available; the command is checking it on chain";
    case "connected": return "the owner connected and signed; the command is finishing";
    case "hosted:awaiting_owner": if (page.linked) return "the owner added this agent to their account; waiting for them to approve the next transaction in their wallet, on the same page";
      if (page.walletAsked) return "the owner's wallet was asked to send; no transaction is reported yet";
      return accountWaitingWords(page.reasonCode) ?? "waiting for the owner to open the approval link on superstables.com, signed in with their wallet, and pick the match code";
    case "hosted:sending": return "the owner's wallet was asked to send; no transaction is reported yet";
    case "hosted:unknown": return "superstables.com cannot tell whether the wallet sent it; the command is finishing and the chain must be checked";
    case "hosted:linked": return "the owner added this agent to their account; the command is finishing";
    case "hosted:queued": return "the owner added this agent to their account; the next wallet step has not been asked yet";
    case "hosted:sent": case "hosted:confirmed": case "hosted:failed": return "a transaction hash was reported; the command is checking it on chain";
    case "hosted:unreachable": return "waiting for the owner (superstables.com did not answer just now)";
    case undefined: case null: return "waiting for the owner";
    default: return "the owner page has ended; the command is finishing";
  }
}

/**
 * The approval's command is about to broadcast a transaction (its rail printed SENDING, ../proof.mjs). Kept on the record,
 * so every later reader, in any process, knows the command may have sent, with or without a page.
 */
export function recordSending(id) {
  const record = update(id, (r) => (r.sending ? null : { sending: true }));
  // with no record, no later reader would know this approval may have sent: none leaves
  if (!record) throw new Error(`approval ${id} has no record on this machine to keep this send on; this transaction is not sent`);
  // an approval that another process already ended (the link wait, wait, --replace) answered without a send: none leaves now
  if (record.final && !record.sending) throw new Error(`approval ${id} has already ended (${record.final.result?.state}); this transaction is not sent`);
  return record;
}

/** Whether this approval may have sent: its command was about to broadcast (recordSending), or its wallet was asked. */
export function recordMayHaveSent(record, page = null) {
  return record?.sending === true || walletWasAsked(record, page);
}

/**
 * Whether the owner's wallet was asked to send for this approval: the page's state (pageStateOf) says so, or the page log
 * did earlier, on this page or an earlier one of the same approval. Without `page`, the record and the log decide, and nothing is
 * read over the network.
 */
export function walletWasAsked(record, page = null) {
  // an answer while adopting a request signed here (wait --site-request) showed it, before or after it was adopted (mergeEvidence)
  if (record?.hosted?.signed?.walletAsked === true) return true;
  if (page?.walletAsked === true || page?.sending === true) return true;
  if (["sending", "sent", "hosted:sending", "hosted:unknown", "hosted:sent", "hosted:confirmed", "hosted:failed"].includes(page?.status)) return true;
  return [record?.url, ...(record?.earlierUrls ?? [])].some((url) => lastPageStatus(url).sending);
}

/** The page id in a link: the loopback page's 32 hex digits, or a hosted request id (bl_..., ba_...). */
const pageIdOf = (url) => /\/owner\/([0-9a-f]{32})/.exec(url ?? "")?.[1] ?? /\/approve\/budget\/(b[la]_[A-Za-z0-9_-]+)/.exec(url ?? "")?.[1];

/** The last state the owner page logged for the page id in `url` (owner-approvals.jsonl), and whether the wallet was ever asked. */
function lastPageStatus(url) {
  const pageId = pageIdOf(url);
  if (!pageId || !existsSync(ownerApprovalsLog())) return { status: null, sending: false };
  let status = null;
  let sending = false;
  for (const line of readFileSync(ownerApprovalsLog(), "utf8").split("\n")) {
    if (!line.includes(pageId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id !== pageId) continue;
      status = entry.status;
      // a sign-in (the loopback page's connect, a link on superstables.com) asks the wallet for a message, never to send
      const signIn = entry.kind === "connect" || entry.kind === "link";
      if (entry.sending || (!signIn && ["sending", "sent", "confirmed", "failed", "unknown"].includes(entry.status))) sending = true;
    } catch {}
  }
  return { status, sending };
}

/**
 * Every process is gone without a RESULT (killed, crashed, machine restarted): say what can be known, from the chain next.
 * A hosted request outlives the command on the site, so it counts as sent unless the site confirms it cancelled it
 * (`hostedCancelled`) or it was a link, which moves no funds.
 */
function abandoned(record, hostedCancelled = false) {
  const page = lastPageStatus(record.url);
  // the logged value stays as written (`connected`, `linked`); the reason says what it means for this approval
  const last = page.status === "connected" ? (record.hosted ? "agent added" : "owner connected") : page.status === "linked" ? "agent added" : page.status;
  // a link moves no funds, unless wallet steps follow it on the same page (setup --hosted --grant/--fund)
  const hostedOpen = Boolean(record.hosted && (record.hosted.kind !== "link" || record.hosted.then?.length) && !hostedCancelled);
  if (walletWasAsked(record)) return sentUnknown(record, `the background approval stopped after the wallet was asked to send (last page state: ${last})`);
  if (record.sending) return sentUnknown(record, `the background approval stopped after its command was about to broadcast a transaction (last page state: ${last ?? "none"})`);
  if (hostedOpen) return sentUnknown(record, "the background approval stopped while its request may still be open on superstables.com; the owner may still approve it there");
  return { code: 3, result: { ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "refused_precheck", id: record.id, url: record.url, next: "no submission is recorded. Check wallet activity and budget status; retry only at the owner's request", reason: `the background approval stopped without a recorded submission (last page state: ${last ?? "none"})` } };
}

/** The final answer for an approval that may have sent and has no RESULT of its own: unknown, exit 5, read the chain next. */
function sentUnknown(record, reason) {
  const status = `superstables budget status --rail ${record.rail}${record.chain ? ` --chain ${record.chain}` : ""}`;
  return { code: 5, result: { ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason } };
}

/**
 * `superstables budget wait`: poll up to `timeoutMs`. Returns null for an unknown id, { final: true, code, result } once
 * the command ended (the same answer every time after that), or { final: false, record, page, orphaned } while it still
 * waits. `orphaned`: the worker is gone but a process of its group (the page, a chain read) still runs, so nothing is
 * final yet. Past the record's deadline, `wait` stops that group itself; only once no process is left does it record
 * the result from what the page logged, and free the chain.
 * A new link during the wait (recover's second owner step) returns at once, so the caller can show it.
 * A hosted request whose worker is gone and that a later command can finish (canResume) returns { final: false, resume: true }
 * instead of being ended, every time: the caller starts the worker again (restartWorker), and a worker that ends with no
 * result leaves the approval open for the next `wait`. Only an approval that cannot be finished (not resumable) ends the way an
 * approval whose worker is gone always has: the site is asked to cancel it, else unknown.
 */
export async function waitFor(id, timeoutMs, { poll = 250, seen = false } = {}) {
  // null only for an approval this home never had: a caller that already read the record (`seen`: true, or the record it read) is told it
  // is gone, and a file that is there and is not a record wait can answer from, or (given the record) is another approval, is never "no
  // such approval"
  const file = readApprovalFile(id);
  if (file.kind === "none") return seen ? { final: false, gone: true, record: isObject(seen) ? seen : null } : null;
  if (file.kind !== "record" || (isObject(seen) && !sameApproval(seen, file.record))) return { final: false, gone: true, record: isObject(seen) ? seen : null };
  const first = file.record;
  const until = Date.now() + timeoutMs;
  let last = first;
  for (;;) {
    let record = readStrict(id, first);
    // the file went (or is not a record any more, or is another approval) after this command read it: no answer is made of what is left
    if (!record) return { final: false, gone: true, record: last };
    last = record;
    if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
    if (record.deadline && Date.now() > record.deadline && processesAlive(record)) {
      // past the worker's own backstop: this command started that group, so it stops it
      await stopRecord(record);
      if (processesAlive(record)) {
        // it would not stop: still no final result. Never spin: wait a poll, and answer by the caller's timeout
        const orphaned = !alive(record.pid, record.pidStart, record.pidStartUtc, { ...record, createdAt: record.foreground ? record.createdAt : undefined });
        if (Date.now() >= until) return { final: false, record, page: await pageStateOf(record), orphaned };
        await sleep(Math.min(poll, Math.max(0, until - Date.now())));
      }
      continue;
    }
    if (!processesAlive(record)) {
      await sleep(100); // a worker that just wrote its RESULT may still be exiting
      record = readStrict(id, first);
      if (!record) return { final: false, gone: true, record: last };
      if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
      if (processesAlive(record)) continue;
      if (canResume(record)) return { final: false, resume: true, record };
      // a hosted request is still on the site: ask it to cancel first (refused once the wallet was asked)
      const h = record.hosted?.token ? record.hosted : null;
      const cancelled = h ? (await cancelSiteRequest({ site: h.site, id: h.requestId, token: h.token }))?.cancelled === true : false;
      // decided from the record as stored under its lock: a final another process stored meanwhile stands, and a worker another command started meanwhile keeps the approval open
      // strict: the record under the lock must still be one wait can answer from, or nothing is decided from what is left
      // and it must still be the approval this command asked the site about: a record that turned into another request while the site was
      // asked is not decided from what that answer was about
      let ended;
      try {
        ({ record: ended } = recordFinalWith(id, (before) => {
          if ((before.hosted?.requestId ?? null) !== (record.hosted?.requestId ?? null)) throw Object.assign(new Error(`the request of ${id} changed while the site was asked to cancel it`), { code: RECORD_GONE });
          return processesAlive(before) || canResume(before) ? null : abandoned(before, cancelled);
        }, { strict: record }));
      } catch (err) {
        if (err?.code === RECORD_GONE) return { final: false, gone: true, record: last };
        throw err;
      }
      if (!ended?.final) continue;
      return { final: true, code: ended.final.code, result: ended.final.result, record: ended };
    }
    const orphaned = !alive(record.pid, record.pidStart, record.pidStartUtc, { ...record, createdAt: record.foreground ? record.createdAt : undefined });
    if (record.url && record.url !== first.url) return { final: false, record, page: await pageStateOf(record), orphaned };
    if (Date.now() >= until) return { final: false, record, page: await pageStateOf(record), orphaned };
    await sleep(Math.min(poll, Math.max(0, until - Date.now())));
  }
}

/** Ask a running owner page to cancel. { cancelled: true } only when the page confirms the wallet was never asked. */
export async function cancelPage(url, byId) {
  if (!url) return null;
  try {
    const res = await fetch(`${url}/cancel`, {
      method: "POST",
      // the page's own origin and a JSON body: the server's CSRF checks (not authentication) require both
      headers: { "content-type": "application/json", origin: new URL(url).origin },
      body: JSON.stringify({ replacedBy: byId }),
      signal: AbortSignal.timeout(3000),
    });
    const body = await pageJson(res);
    // an answer longer than a page's, cut off or not JSON is no answer: the pending approval is not replaced
    if (!body || typeof body !== "object") return null;
    return { cancelled: res.ok && body.cancelled === true, status: typeof body.status === "string" ? siteText(body.status, 40) : null, sending: body.sending === true };
  } catch {
    return null;
  }
}

/**
 * `--replace`: ask the pending approval's page to cancel. The page answers in one step, so this cannot interleave with
 * the owner pressing send: either it confirms the wallet was never asked (then its command ends with a refusal, and
 * whatever is left of its process group is stopped), or the replacement is refused and the old approval stays as it
 * is, uncertain until its own result. Returns { ok: true } or { ok: false, reason }.
 */
export async function replacePending(record, byId) {
  // hosted: the site cancels only while the wallet was not asked, in one step, like the loopback page
  const h = record.hosted?.token ? record.hosted : null;
  const answer = h
    ? await cancelSiteRequest({ site: h.site, id: h.requestId, token: h.token }).then((c) => c && { cancelled: c.cancelled, status: siteWord("state", c.state), sending: c.walletAsked === true })
    : await cancelPage(record.url, byId);
  if (!answer?.cancelled) {
    const why = !record.url ? "has no page yet" : !answer ? (h ? `is not answering on ${h.site}` : "is not answering") : answer.sending ? "already asked the wallet to send" : `is ${answer.status}`;
    return { ok: false, reason: `the pending approval ${record.id} ${why}: the wallet may be sending it, so it is not replaced` };
  }
  // cancelled: the command behind the page ends on its own with a refusal; give it a moment, then stop what is left
  for (let i = 0; i < 100 && processesAlive(record); i++) await sleep(100);
  if (processesAlive(record)) await stopRecord(record);
  if (processesAlive(record)) return { ok: false, reason: `the pending approval ${record.id} was cancelled on its page, but its processes would not stop` };
  // its page never asked the wallet, but its command may have sent before that page (recover's own revoke)
  recordFinalWith(record.id, (before) => recordMayHaveSent(before)
    ? sentUnknown(before, `replaced by ${byId}: its page was cancelled before the wallet was asked, after its command was about to broadcast a transaction`)
    : { code: 3, result: {
      ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "refused_precheck", id: record.id, url: record.url,
      next: `the previous approval was cancelled before the wallet was asked. Check wallet activity before using the new approval ${byId}`, reason: `replaced by ${byId}: cancelled before the wallet was asked; nothing was sent`,
    } });
  release(record.rail, record.chain, record.id);
  return { ok: true };
}

/** Retire a setup only when its own site confirms final expiry and neither the site nor the local record holds a send. */
export async function finishExpiredSetup(record) {
  const h = record.hosted;
  if (record.command !== "setup" || h?.kind !== "link" || !h.token || recordMayHaveSent(record)) return false;
  try {
    const answer = await readSiteRequest({ site: h.site, id: h.requestId, token: h.token, own: true });
    if (answer.asked || (answer.ok && viewEvidence(answer.view))) {
      // Evidence from this read must survive a later clean answer, just as the worker's page log does.
      update(record.id, (before) => before.hosted?.requestId === h.requestId ? { sending: true } : null, { strict: record });
      return false;
    }
    if (!answer.ok || answer.view.state !== "expired" || answer.view.final !== true) return false;
    const current = readStrict(record.id, record);
    if (!current || current.final || current.hosted?.requestId !== h.requestId || recordMayHaveSent(current)) return false;
    // A worker may still be reading the expired link. Stop its identified processes before freeing the chain.
    await stopRecord(current);
    const { stored } = recordFinalWith(record.id, (before) =>
      before.hosted?.requestId !== h.requestId || recordMayHaveSent(before) || processesAlive(before) || startingUp(before) ? null : {
        code: 3, result: {
          ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "refused_precheck", id: record.id, url: record.url,
          reason: "the approval link expired on the site without a completed approval", next: `superstables budget setup --rail ${record.rail}${record.rail === "evm" ? ` --chain ${record.chain}` : ""} --hosted --site ${h.site}`,
        },
      }, { strict: record });
    return stored;
  } catch (err) {
    if (err.code === RECORD_GONE) return false;
    throw err;
  }
}

/** Owner recovery preserves approvals and submitted-payment evidence. Never fabricates a final RESULT. */
export function approvalRecoveryTargetExists(rail, chain, id) {
  if (!id) return true;
  const selected = readApproval(id);
  return selected ? selected.rail === rail && selected.chain === chain
    : existsSync(recordLockFile(id)) || existsSync(recordLockFile(id) + '.break');
}

export function recoverApprovalLocks(rail, chain, options, id) {
  if (!approvalRecoveryTargetExists(rail, chain, id)) return { outcome: 'not_found' };
  return recoveryResult(options, options => {
    if (!existsSync(approvalsDir())) return true;
    const records = readdirSync(approvalsDir()).filter(name => /^oa-.*\.json$/.test(name)).map(name => readApproval(name.slice(0, -5))).filter(record => record?.rail === rail && record.chain === chain);
    const recordChecks = record => {
      if (!record || record.final || (record.command === "buy-once" && record.pid === null)) return [];
      const checks = [inspectProcess(record), inspectProcess(record, undefined, true)];
      if (record.railPgid) checks.push(inspectProcess({ ...record, pid: record.railPgid, pidStart: record.railPgidStart, pidStartUtc: record.railPgidStartUtc, selfStartedAt: record.railSelfStartedAt, namespace: 'railNamespace' in record ? record.railNamespace : record.namespace, writtenAt: record.railWrittenAt, bootElapsedMs: record.railBootElapsedMs }, undefined, true));
      return checks;
    };
    // A verified live worker or rail child protects even an unverifiable lock in its approval.
    const live = records.flatMap(recordChecks).find(check => check.state === 'alive' && !check.possiblyAlive);
    if (live) { options.onBlocked?.(live); return false; }
    const inspectApproval = text => {
      let lock;
      try { lock = JSON.parse(text); } catch { return inspectLockText(text); }
      const checks = [inspectLockText(text), ...recordChecks(readApproval(lock?.id))];
      return checks.find(check => check.state === 'alive' && !check.possiblyAlive) ?? checks.find(check => check.state === 'alive') ?? { state: 'dead' };
    };
    const inspectRecordLock = id => text => {
      const checks = [inspectLockText(text), ...recordChecks(readApproval(id))];
      return checks.find(check => check.state === 'alive' && !check.possiblyAlive) ?? checks.find(check => check.state === 'alive') ?? { state: 'dead' };
    };
    if (id && !clearFileLock(recordLockFile(id), options, inspectRecordLock(id))) return false;
    for (const record of records) {
      if (!clearFileLock(recordLockFile(record.id), options, inspectRecordLock(record.id))) return false;
    }
    return clearFileLock(activeFile(rail, chain), options, inspectApproval);
  });
}
