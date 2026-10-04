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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalsDir, ownerApprovalsLog } from "./paths.mjs";
import { groupAlive as groupOf, processStart, sameProcess } from "./procs.mjs";
import { cancelSiteRequest, readSiteRequest, siteWord } from "./site.mjs";

/** A lock younger than this is never taken over, whatever its processes look like (startup: the record is being written). */
export const STARTUP_GRACE_MS = 30_000;

/** Set in the worker's environment: the id of the approval it runs. */
export const WORKER_ENV = "SUPERSTABLES_BUDGET_APPROVAL_ID";
/** Set in an owner command's rail script environment: the id of the approval record it may add a hosted request to. */
export const HOLDER_ENV = "SUPERSTABLES_BUDGET_HOLDER";
/** How long the owner page keeps a link open after the wallet was asked to send (owner-approval-server.ts). */
const SENDING_GRACE_S = 120;
/** Reading the chain after the wallet sent: readSent waits up to 180 s, then the allowance reads. */
const VERIFY_S = 420;
/** How long the caller waits for the worker's first link. */
export const LINK_WAIT_MS = 120_000;
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
  mkdirSync(approvalsDir(), { recursive: true, mode: 0o700 });
}

export function readApproval(id) {
  if (!isApprovalId(id)) return null;
  try {
    return JSON.parse(readFileSync(recordFile(id), "utf8"));
  } catch {
    return null;
  }
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
 * the patch (null: no change). A final record changes only by another final result, as with every other write.
 */
export function updateApproval(id, fn) {
  return update(id, fn);
}

/**
 * Finish a record under its lock, deciding from the record as stored now: `decide` gets it (never a final one) and
 * returns { code, result } to store, or null to store nothing. The same as recordFinal otherwise. Returns the record, and
 * whether this call made it final.
 */
export function recordFinalWith(id, decide) {
  let decided = null;
  const record = update(id, (before) => {
    if (before.final) return null;
    decided = decide(before);
    if (!decided) return null;
    return { state: "final", endedAt: new Date().toISOString(), final: { code: decided.code, result: decided.result }, ...(before.hosted ? { hosted: { ...before.hosted, token: undefined } } : {}) };
  });
  if (record && decided) release(record.rail, record.chain, id);
  return { record, stored: Boolean(record && decided) };
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
// start identity and a random owner id, written whole to a temporary file and hard-linked into place, so it exists
// complete or not at all. It is taken over only from a holder that is gone (no process with that pid and start runs),
// never because it is old: a live holder may be paused for any time. A dead holder's lock is broken under a mutex that
// follows the same rules, and only if it is still that exact lock; a lock is released only by its owner. A file that
// cannot be read as a holder (the whole-file write does not make one) is waited for, never taken, and named in the
// error at the deadline. A synchronous wait blocks this process's timers; the locks are held for a read and a write only.

const lockOwnerText = () => JSON.stringify({ pid: process.pid, pidStart: startOf(process.pid), owner: randomBytes(8).toString("hex") });

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

/**
 * Create `path` holding `me` (temp file + hard link), waiting until `deadline`. A file there whose holder is gone is
 * removed first: by `breakDead` (a lock, broken under its mutex), else only if it still holds the text judged dead (the
 * mutex itself). Throws at the deadline, naming the holder or the unreadable file.
 */
function acquireSync(path, me, deadline, breakDead) {
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(mine, me, { mode: 0o600, flag: "wx" });
  try {
    for (;;) {
      try {
        linkSync(mine, path);
        return;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
      const { text, holder } = lockHolder(path);
      if (text !== null && holder && !alive(Number(holder.pid), holder.pidStart)) {
        if (breakDead) breakDead(path, text, deadline);
        else removeIfSame(path, text);
      }
      if (Date.now() >= deadline) {
        throw new Error(holder
          ? `the lock ${path} is held by process ${holder.pid ?? "unknown"}, which is still running`
          : text === null ? `the lock ${path} could not be taken in time`
            : `the lock ${path} cannot be read; if no superstables budget command is running, remove it`);
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

/**
 * Run `fn` holding the record's lock: the worker, the caller, `wait` and `--replace` all change a record by reading it
 * and writing it back, so each change is made whole, one process at a time.
 */
function withRecordLock(id, fn) {
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
  const tmp = `${recordFile(id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, recordFile(id));
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
function writeRecord(id, compute) {
  return withRecordLock(id, () => {
    const stored = readApproval(id);
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
function update(id, patch) {
  if (!isApprovalId(id)) return null;
  return writeRecord(id, (record) => {
    if (!record) return null;
    const p = typeof patch === "function" ? patch(record) : patch;
    if (!p) return null;
    // a final record changes only by another final result (recordFinal), or by more payment evidence (`seen` alone, which
    // only grows): no write makes it not final again
    if (record.final && !p.final && Object.keys(p).some((k) => k !== "seen")) return null;
    return { ...record, ...p };
  });
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
  for (const flag of ["named", "paid", "moved"]) if (prev[flag] && !next[flag]) return false;
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

/** The start identity to record with a pid (procs.mjs), or null when it cannot be read. */
const startOf = (pid) => processStart(pid) ?? null;

/**
 * Whether the process recorded as `pid`, started at `start`, still runs (EPERM: it exists, under another user). A pid now
 * held by a process with another start time is a reused number: not alive.
 */
export const alive = (pid, start) => sameProcess(pid, start);

/**
 * Whether any process is left in the process group `pgid` (a detached worker is its group's leader: pgid = its pid) whose
 * leader was recorded with start identity `start`. A number reused by another process is not that group.
 */
export const groupAlive = (pgid, start) => groupOf(pgid, start);

/**
 * Whether anything this approval started may still run: its worker (or blocking command), the worker's process group
 * (its rail script and the page's process), and a blocking command's rail group.
 */
export const processesAlive = (record) =>
  Boolean(record && (alive(record.pid, record.pidStart) || groupAlive(record.pid, record.pidStart) || groupAlive(record.railPgid, record.railPgidStart)));

/** A record without a final result whose processes may still run: it holds its chain. */
export const isLive = (record) => Boolean(record && !record.final && processesAlive(record));

/**
 * Stop a process group this command started, whose leader was recorded with start identity `start`: SIGTERM, then SIGKILL.
 * Returns true once no process is left in it. A group whose number now belongs to another process is never signalled.
 * @param {number} pgid
 * @param {{ start?: string | null, graceMs?: number }} [options]
 */
export async function stopGroup(pgid, { start, graceMs = 3000 } = {}) {
  const left = () => groupAlive(pgid, start);
  if (!left()) return true;
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  for (let t = 0; t < graceMs && left(); t += 100) await sleep(100);
  if (left()) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  for (let t = 0; t < 2000 && left(); t += 100) await sleep(100);
  return !left();
}

/** Stop everything an approval started: its worker's group and a blocking command's rail group. */
async function stopRecord(record) {
  await stopGroup(record.pid, { start: record.pidStart });
  if (record.railPgid) await stopGroup(record.railPgid, { start: record.railPgidStart });
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
 * is older than STARTUP_GRACE_MS and neither the process that claimed it nor any process of its approval is alive.
 */
function lockHeld(lock) {
  if (lock.unreadable) return true;
  const record = readApproval(lock.id);
  if (record?.final) return false;
  if (alive(lock.pid, lock.pidStart)) return true;
  if (processesAlive(record)) return true;
  return Date.now() - Number(lock.createdAt ?? 0) < STARTUP_GRACE_MS;
}

/** What a refusal can say about the holder: its record, or what the lock alone knows while it starts. */
const holderOf = (lock, rail, chain) => lock.unreadable
  ? { id: "unknown", rail, chain, command: `an unreadable lock (${lock.unreadable}); if no superstables budget command is running, remove that file` }
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
 * exclusive step: the lock is written in full to a private file and hard-linked to its name, so it exists complete or
 * not at all. { ok: false, pending } when another approval holds them.
 */
export function claim(rail, chain, id, { pid = process.pid } = {}) {
  ensureDir();
  const path = activeFile(rail, chain);
  const mine = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(mine, JSON.stringify({ id, pid, pidStart: startOf(pid), createdAt: Date.now() }), { mode: 0o600 });
  try {
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
  saveApproval({ id, command, rail, chain, state: "running", foreground: true, createdAt: new Date().toISOString(), pid: process.pid, pidStart: startOf(process.pid), deadline: null });
}

/** The process group of a blocking command's rail script (its page and chain reads run there). */
export function setRailGroup(id, pgid) {
  return update(id, { railPgid: pgid, railPgidStart: startOf(pgid) });
}

/** The worker records its own pid at start, so its process group is known even if the caller died before writing it. */
export function adoptWorker(id) {
  const record = readApproval(id);
  if (record && !record.final && !record.pid) update(id, { pid: process.pid, pidStart: startOf(process.pid) });
}

// ── the worker's side ──────────────────────────────────────────────────────────────────────────────────

/** A link exists (the rail's APPROVE line): the approval now waits for the owner. A later link replaces it (recover asks twice). */
export function recordLink(id, approve, { wordsLogged = true } = {}) {
  return update(id, (record) => ({
    state: "waiting_owner",
    action: approve.action,
    url: approve.url,
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
  return update(id, (record) => record.final ? null : { hosted: { site: hosted.site, requestId: hosted.requestId, kind: hosted.kind, matchCode: hosted.matchCode, token: hosted.token, ...(hosted.then?.length ? { then: hosted.then } : {}) } });
}

/**
 * The approval ended, whichever way (approved, rejected, expired, cancelled or replaced, stopped by a timeout, or failed):
 * store its RESULT and exit code for every later `wait`, and free the chain. The access token goes. Every final result is
 * recorded here, and only here.
 */
export function recordFinal(id, code, result) {
  // one locked change: the result, and the hosted request without its access token (writeApproval enforces it too)
  const record = update(id, (before) => ({ state: "final", endedAt: new Date().toISOString(), final: { code, result }, ...(before.hosted ? { hosted: { ...before.hosted, token: undefined } } : {}) }));
  if (record) release(record.rail, record.chain, id);
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

/**
 * Start the worker detached and return once it has a link ({ kind: "waiting" }), ended before it needed one
 * ({ kind: "final" }: a refusal before any page, nothing to do), or failed to open a page ({ kind: "failed" }).
 * The caller must hold the chain (claim) first.
 */
export async function startDetached({ id, command, rail, chain, cmd, args, cwd, env = process.env, timeoutS = 600, onLog = null, linkWaitMs = LINK_WAIT_MS }) {
  saveApproval({
    id, command, rail, chain, state: "starting", createdAt: new Date().toISOString(),
    deadline: Date.now() + linkWaitMs + workerDeadlineMs(timeoutS), pid: null,
  });
  const fd = openSync(logFile(id), "a", 0o600);
  let child;
  try {
    child = spawn(cmd, args, { cwd, env: { ...env, [WORKER_ENV]: id }, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  let exited = false;
  let spawnError;
  child.on("exit", () => (exited = true));
  child.on("error", (err) => { exited = true; spawnError = err; });
  const childStart = child.pid ? startOf(child.pid) : null;
  if (child.pid) update(id, { pid: child.pid, pidStart: childStart });
  const until = Date.now() + linkWaitMs;
  const at = { offset: 0, ino: undefined, text: "" };
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
    if (exited) {
      await sleep(100);
      forwardLog(id, at, onLog);
      const last = readApproval(id);
      if (last?.final) return { kind: "final", record: last };
      // no link was ever shown, so no wallet was asked: stop anything left in its group before freeing the chain
      if (!(await stopGroup(child.pid, { start: childStart }))) return { kind: "failed", record: last, reason: `the background approval stopped before it opened a page, but process group ${child.pid} would not stop; the chain stays held` };
      const reason = spawnError ? `the background approval could not start: ${spawnError.message}` : "the background approval stopped before it opened a page";
      // final (recordFinal frees the chain and removes any access token the worker had recorded)
      recordFinal(id, 1, { ok: false, command, rail, chain, state: "failed", id, next: "check wallet activity and budget status before retrying", reason });
      release(rail, chain, id);
      return { kind: "failed", record: readApproval(id), reason };
    }
    if (Date.now() > until) {
      if (!(await stopGroup(child.pid, { start: childStart }))) return { kind: "failed", record: readApproval(id), reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s, and process group ${child.pid} would not stop; the chain stays held` };
      recordFinal(id, 1, { ok: false, command, rail, chain, state: "failed", id, next: "check wallet activity and budget status before retrying", reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s` });
      release(rail, chain, id);
      return { kind: "failed", record: readApproval(id), reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s; the background approval was stopped` };
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
    return r.ok ? { status: `hosted:${siteWord("state", r.view.state)}`, linked, walletAsked: r.view.wallet_asked === true || typeof r.view.tx_hash === "string" || stepAsked } : { status: "hosted:unreachable" };
  }
  return pageState(record?.url);
}

/** The owner page's own view (loopback), or null. Only for words; nothing is decided from it except --replace. */
export async function pageState(url) {
  if (!url) return null;
  try {
    const res = await fetch(`${url}/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
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
      return page.walletAsked ? "the owner's wallet was asked to send; no transaction is reported yet" : "waiting for the owner to open the approval link on superstables.com, signed in with their wallet, and pick the match code";
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
      if (entry.sending || ["sending", "sent", "confirmed", "failed", "unknown"].includes(entry.status)) sending = true;
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
  const base = { command: record.command, rail: record.rail, chain: record.chain };
  const status = `superstables budget status --rail ${record.rail}${record.chain ? ` --chain ${record.chain}` : ""}`;
  // a link moves no funds, unless wallet steps follow it on the same page (setup --hosted --grant/--fund)
  const hostedOpen = Boolean(record.hosted && (record.hosted.kind !== "link" || record.hosted.then?.length) && !hostedCancelled);
  if (hostedOpen && !page.sending) {
    return { code: 5, result: { ok: false, ...base, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason: "the background approval stopped while its request may still be open on superstables.com; the owner may still approve it there" } };
  }
  if (page.sending) {
    return { code: 5, result: { ok: false, ...base, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason: `the background approval stopped after the wallet was asked to send (last page state: ${last})` } };
  }
  return { code: 3, result: { ok: false, ...base, state: "refused_precheck", id: record.id, url: record.url, next: "no submission is recorded. Check wallet activity and budget status; retry only at the owner's request", reason: `the background approval stopped without a recorded submission (last page state: ${last ?? "none"})` } };
}

/**
 * `superstables budget wait`: poll up to `timeoutMs`. Returns null for an unknown id, { final: true, code, result } once
 * the command ended (the same answer every time after that), or { final: false, record, page, orphaned } while it still
 * waits. `orphaned`: the worker is gone but a process of its group (the page, a chain read) still runs, so nothing is
 * final yet. Past the record's deadline, `wait` stops that group itself; only once no process is left does it record
 * the result from what the page logged, and free the chain.
 * A new link during the wait (recover's second owner step) returns at once, so the caller can show it.
 */
export async function waitFor(id, timeoutMs, { poll = 250 } = {}) {
  const first = readApproval(id);
  if (!first) return null;
  const until = Date.now() + timeoutMs;
  for (;;) {
    let record = readApproval(id);
    if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
    if (record.deadline && Date.now() > record.deadline && processesAlive(record)) {
      // past the worker's own backstop: this command started that group, so it stops it
      await stopRecord(record);
      if (processesAlive(record)) {
        // it would not stop: still no final result. Never spin: wait a poll, and answer by the caller's timeout
        const orphaned = !alive(record.pid, record.pidStart);
        if (Date.now() >= until) return { final: false, record, page: await pageStateOf(record), orphaned };
        await sleep(Math.min(poll, Math.max(0, until - Date.now())));
      }
      continue;
    }
    if (!processesAlive(record)) {
      await sleep(100); // a worker that just wrote its RESULT may still be exiting
      record = readApproval(id);
      if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
      if (processesAlive(record)) continue;
      // a hosted request is still on the site: ask it to cancel first (refused once the wallet was asked)
      const h = record.hosted?.token ? record.hosted : null;
      const cancelled = h ? (await cancelSiteRequest({ site: h.site, id: h.requestId, token: h.token }))?.cancelled === true : false;
      const final = abandoned(record, cancelled);
      recordFinal(id, final.code, final.result);
      return { final: true, ...final, record: readApproval(id) };
    }
    const orphaned = !alive(record.pid, record.pidStart);
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
    const body = await res.json().catch(() => ({}));
    return { cancelled: res.ok && body.cancelled === true, status: body.status ?? null, sending: body.sending === true };
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
  if (!readApproval(record.id)?.final) {
    recordFinal(record.id, 3, {
      ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "refused_precheck", id: record.id, url: record.url,
      next: `the previous approval was cancelled before the wallet was asked. Check wallet activity before using the new approval ${byId}`, reason: `replaced by ${byId}: cancelled before the wallet was asked; nothing was sent`,
    });
  }
  release(record.rail, record.chain, record.id);
  return { ok: true };
}
