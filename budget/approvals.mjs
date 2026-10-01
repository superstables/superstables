// Detached owner approvals. An agent's shell tool usually shows a command's output only when the command exits, so an
// owner command on evm that waits for the owner's wallet would hide its own approval link. In detached mode the command
// starts itself again as a background worker (the same command, blocking, with its output in a log file), returns as
// soon as the worker has a link, and the caller polls with `superstables budget wait --id <id>`.
//
//   startDetached            the caller's side: register an id, start the worker, return once it has a link or has ended.
//   recordLink, recordFinal  the worker's side: each link as soon as it exists, then the final RESULT and exit code.
//   waitFor                  `superstables budget wait`: the current state, within a timeout. It never signs or sends.
//   findPending, claim       one owner approval at a time on a rail and chain.
//
// Files, under $SUPERSTABLES_HOME/budget/approvals/ (paths.mjs), no key material in any of them:
//   <id>.json               the record (mode 600): command, rail, chain, pid (with its start), link, terms, and the final RESULT once known
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
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalsDir, ownerApprovalsLog } from "./paths.mjs";
import { groupAlive as groupOf, processStart, sameProcess } from "./procs.mjs";

/** A lock younger than this is never taken over, whatever its processes look like (startup: the record is being written). */
export const STARTUP_GRACE_MS = 30_000;
/** A takeover mutex older than this belongs to a process that died while breaking a stale lock. */
const BREAK_STALE_MS = 10_000;

/** Set in the worker's environment: the id of the approval it runs. */
export const WORKER_ENV = "SUPERSTABLES_BUDGET_APPROVAL_ID";
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

function writeApproval(record) {
  ensureDir();
  const tmp = `${recordFile(record.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, recordFile(record.id));
  return record;
}

function update(id, patch) {
  const record = readApproval(id);
  return record ? writeApproval({ ...record, ...patch }) : null;
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
  // an older plain-id lock, or something unreadable: its age comes from the file
  let createdAt = Date.now();
  try { createdAt = statSync(activeFile(rail, chain)).mtimeMs; } catch {}
  return { id: text.trim(), pid: null, createdAt, text };
}

/**
 * Whether a lock still holds its chain. The stale rule: the lock is free when its approval has a final result, or when it
 * is older than STARTUP_GRACE_MS and neither the process that claimed it nor any process of its approval is alive.
 */
function lockHeld(lock) {
  const record = readApproval(lock.id);
  if (record?.final) return false;
  if (alive(lock.pid, lock.pidStart)) return true;
  if (processesAlive(record)) return true;
  return Date.now() - Number(lock.createdAt ?? 0) < STARTUP_GRACE_MS;
}

/** What a refusal can say about the holder: its record, or what the lock alone knows while it starts. */
const holderOf = (lock, rail, chain) => readApproval(lock.id) ?? { id: lock.id, rail, chain, command: "an owner command (starting)" };

/** The approval that holds this rail and chain, or null. */
export function findPending(rail, chain) {
  const lock = readLock(rail, chain);
  if (!lock || !lockHeld(lock)) return null;
  return holderOf(lock, rail, chain);
}

/** Remove a stale lock, but only the one judged stale: a takeover mutex keeps two claimers from removing a fresh lock. */
function breakStale(rail, chain, stale) {
  const mutex = `${activeFile(rail, chain)}.break`;
  let fd;
  try {
    fd = openSync(mutex, "wx", 0o600);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(mutex).mtimeMs > BREAK_STALE_MS) unlinkSync(mutex);
    } catch {}
    return false;
  }
  try {
    const now = readLock(rail, chain);
    if (now && now.text === stale.text && !lockHeld(now)) unlinkSync(activeFile(rail, chain));
    return true;
  } finally {
    closeSync(fd);
    try { unlinkSync(mutex); } catch {}
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
      if (!lock) continue; // released meanwhile
      if (lockHeld(lock)) return { ok: false, pending: holderOf(lock, rail, chain) };
      if (!breakStale(rail, chain, lock)) return { ok: false, pending: holderOf(lock, rail, chain) };
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
  writeApproval({ id, command, rail, chain, state: "running", foreground: true, createdAt: new Date().toISOString(), pid: process.pid, pidStart: startOf(process.pid), deadline: null });
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
export function recordLink(id, approve) {
  const record = readApproval(id);
  if (!record) return null;
  return writeApproval({
    ...record,
    state: "waiting_owner",
    action: approve.action,
    url: approve.url,
    expires: approve.expires,
    terms: approve.terms,
    links: (record.links ?? 0) + 1,
  });
}

/** The command ended: store its RESULT and exit code for every later `wait`, and free the chain. */
export function recordFinal(id, code, result) {
  const record = update(id, { state: "final", endedAt: new Date().toISOString(), final: { code, result } });
  if (record) release(record.rail, record.chain, id);
  return record;
}

// ── the caller's side ──────────────────────────────────────────────────────────────────────────────────

/** Copy what the worker logged since `offset` to `onLog`; returns the new offset. */
function forwardLog(id, offset, onLog) {
  if (!onLog) return offset;
  let fd;
  try {
    fd = openSync(logFile(id), "r");
  } catch {
    return offset;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      onLog(buf.subarray(0, n).toString("utf8"));
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  return offset;
}

/**
 * Start the worker detached and return once it has a link ({ kind: "waiting" }), ended before it needed one
 * ({ kind: "final" }: a refusal before any page, nothing to do), or failed to open a page ({ kind: "failed" }).
 * The caller must hold the chain (claim) first.
 */
export async function startDetached({ id, command, rail, chain, cmd, args, cwd, env = process.env, timeoutS = 600, onLog = null, linkWaitMs = LINK_WAIT_MS }) {
  writeApproval({
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
  let offset = 0;
  for (;;) {
    offset = forwardLog(id, offset, onLog);
    const record = readApproval(id);
    if (record?.final) { child.unref(); return { kind: "final", record }; }
    if (record?.url) { child.unref(); return { kind: "waiting", record }; }
    if (exited) {
      await sleep(100);
      forwardLog(id, offset, onLog);
      const last = readApproval(id);
      if (last?.final) return { kind: "final", record: last };
      // no link was ever shown, so no wallet was asked: stop anything left in its group before freeing the chain
      if (!(await stopGroup(child.pid, { start: childStart }))) return { kind: "failed", record: last, reason: `the background approval stopped before it opened a page, but process group ${child.pid} would not stop; the chain stays held` };
      release(rail, chain, id);
      return { kind: "failed", record: last, reason: spawnError ? `the background approval could not start: ${spawnError.message}` : "the background approval stopped before it opened a page" };
    }
    if (Date.now() > until) {
      if (!(await stopGroup(child.pid, { start: childStart }))) return { kind: "failed", record: readApproval(id), reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s, and process group ${child.pid} would not stop; the chain stays held` };
      release(rail, chain, id);
      update(id, { state: "final", final: { code: 1, result: { ok: false, command, rail, chain, state: "failed", id, next: "check wallet activity and budget status before retrying", reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s` } } });
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
    case "pending": return "waiting for the owner to open the link and connect their wallet";
    case "ready": return "the owner account is selected; waiting for wallet approval";
    case "sending": return rail === "solana" ? "the owner signed in the wallet; the command is sending it" : "a wallet transaction was requested; submission is not confirmed yet";
    case "sent": return "a transaction id is available; the command is checking it on chain";
    case "connected": return "the owner connected and signed; the command is finishing";
    case undefined: case null: return "waiting for the owner";
    default: return "the owner page has ended; the command is finishing";
  }
}

/** The last state the owner page logged for the page id in `url` (owner-approvals.jsonl), and whether the wallet was ever asked. */
function lastPageStatus(url) {
  const pageId = /\/owner\/([0-9a-f]{32})/.exec(url ?? "")?.[1];
  if (!pageId || !existsSync(ownerApprovalsLog())) return { status: null, sending: false };
  let status = null;
  let sending = false;
  for (const line of readFileSync(ownerApprovalsLog(), "utf8").split("\n")) {
    if (!line.includes(pageId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id !== pageId) continue;
      status = entry.status;
      if (entry.sending || ["sending", "sent", "confirmed", "failed"].includes(entry.status)) sending = true;
    } catch {}
  }
  return { status, sending };
}

/** Every process is gone without a RESULT (killed, crashed, machine restarted): say what can be known, from the chain next. */
function abandoned(record) {
  const page = lastPageStatus(record.url);
  const base = { command: record.command, rail: record.rail, chain: record.chain };
  const status = `superstables budget status --rail ${record.rail}${record.chain ? ` --chain ${record.chain}` : ""}`;
  if (page.sending) {
    return { code: 5, result: { ok: false, ...base, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason: `the background approval stopped after the wallet was asked to send (last page state: ${page.status})` } };
  }
  return { code: 3, result: { ok: false, ...base, state: "refused_precheck", id: record.id, url: record.url, next: "no submission is recorded. Check wallet activity and budget status; retry only at the owner's request", reason: `the background approval stopped without a recorded submission (last page state: ${page.status ?? "none"})` } };
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
        if (Date.now() >= until) return { final: false, record, page: await pageState(record.url), orphaned };
        await sleep(Math.min(poll, Math.max(0, until - Date.now())));
      }
      continue;
    }
    if (!processesAlive(record)) {
      await sleep(100); // a worker that just wrote its RESULT may still be exiting
      record = readApproval(id);
      if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
      if (processesAlive(record)) continue;
      const final = abandoned(record);
      recordFinal(id, final.code, final.result);
      return { final: true, ...final, record: readApproval(id) };
    }
    const orphaned = !alive(record.pid, record.pidStart);
    if (record.url && record.url !== first.url) return { final: false, record, page: await pageState(record.url), orphaned };
    if (Date.now() >= until) return { final: false, record, page: await pageState(record.url), orphaned };
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
  const answer = await cancelPage(record.url, byId);
  if (!answer?.cancelled) {
    const why = !record.url ? "has no page yet" : !answer ? "is not answering" : answer.sending ? "already asked the wallet to send" : `is ${answer.status}`;
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
