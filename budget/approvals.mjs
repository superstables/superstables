// Detached owner approvals. An agent's shell tool usually shows a command's output only when the command exits, so an
// owner command on evm that waits for the owner's wallet would hide its own approval link. In detached mode the command
// starts itself again as a background worker (the same command, blocking, with its output in a log file), returns as
// soon as the worker has a link, and the caller polls with `superstables budget wait --id <id> --shown`.
//
//   startDetached            the caller's side: register an id, start the worker, return once it has a link or has ended.
//   recordLink, recordFinal  the worker's side: each link as soon as it exists, then the final RESULT and exit code.
//   waitFor                  `superstables budget wait`: the current state, within a timeout. It never signs or sends.
//   findPending, claim       one owner approval at a time on a rail and chain.
//
// Hosted approvals (evm, `setup --hosted`): the request lives on superstables.com. The rail script stores the site's request
// id and the agent's access token for it in the record (recordHosted); `wait` reads the request's state from the site, and
// `--replace` asks the site to cancel it. The token is removed from the record once the approval is final.
//
// Files, under $SUPERSTABLES_HOME/budget/approvals/ (paths.mjs), no key material in any of them:
//   <id>.json               the record (mode 600): command, rail, chain, pid, link, terms, and the final RESULT once known;
//                           for a hosted approval also the site, its request id and, until final, the access token
//   <id>.log                the worker's stdout and stderr: the plan, the page, the chain reads
//   active-<rail>-<chain>   the lock: {id, pid, createdAt} of the approval (or blocking command) that holds that chain,
//                           created in one exclusive step (a temp file hard-linked to this name), never half written
//
// The worker is detached (its own session and process group: its rail script and the page's process are in that group
// too), so it outlives the caller, and it ends on its own: the owner page expires its link, the command reads the chain
// for a bounded time, and a backstop in the worker (workerDeadlineMs) stops the whole group if anything hangs.
// Liveness is the group's, never one pid's: a dead worker whose page process still runs holds its chain, and `wait` says
// it has no final result, until every process in the group is gone (or `wait` stops the group after its deadline).
// A command in a terminal (blocking) holds the same lock, with its own pid and its rail script's process group.
// Nothing here kills a process group it did not start. `--replace` first asks the running page to cancel
// (POST /cancel): only a page that confirms the wallet was never asked is stopped.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalsDir, ownerApprovalsLog } from "./paths.mjs";
import { cancelSiteRequest, readSiteRequest } from "./site.mjs";

/** A lock younger than this is never taken over, whatever its processes look like (startup: the record is being written). */
export const STARTUP_GRACE_MS = 30_000;
/** A takeover mutex older than this belongs to a process that died while breaking a stale lock. */
const BREAK_STALE_MS = 10_000;

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

/** Store a record (mode 600). A buy-once purchase has no worker: its record is made here (once.mjs). */
export function saveApproval(record) {
  return writeApproval(record);
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

/** Whether a process with this pid exists (EPERM: it exists, under another user). */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Whether any process is left in the process group `pgid` (a detached worker is its group's leader: pgid = its pid). */
export function groupAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Whether anything this approval started may still run: its worker (or blocking command), the worker's process group
 * (its rail script and the page's process), and a blocking command's rail group.
 */
export const processesAlive = (record) => Boolean(record && (alive(record.pid) || groupAlive(record.pid) || groupAlive(record.railPgid)));

/** A record without a final result whose processes may still run: it holds its chain. */
export const isLive = (record) => Boolean(record && !record.final && processesAlive(record));

/** Stop a process group this command started: SIGTERM, then SIGKILL. Returns true once no process is left in it. */
export async function stopGroup(pgid, { graceMs = 3000 } = {}) {
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  for (let t = 0; t < graceMs && groupAlive(pgid); t += 100) await sleep(100);
  if (groupAlive(pgid)) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  for (let t = 0; t < 2000 && groupAlive(pgid); t += 100) await sleep(100);
  return !groupAlive(pgid);
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
  if (alive(lock.pid)) return true;
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
  writeFileSync(mine, JSON.stringify({ id, pid, createdAt: Date.now() }), { mode: 0o600 });
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
  writeApproval({ id, command, rail, chain, state: "running", foreground: true, createdAt: new Date().toISOString(), pid: process.pid, deadline: null });
}

/** The process group of a blocking command's rail script (its page and chain reads run there). */
export function setRailGroup(id, pgid) {
  return update(id, { railPgid: pgid });
}

/** The worker records its own pid at start, so its process group is known even if the caller died before writing it. */
export function adoptWorker(id) {
  const record = readApproval(id);
  if (record && !record.final && !record.pid) update(id, { pid: process.pid });
}

// ── the worker's side ──────────────────────────────────────────────────────────────────────────────────

/** A link exists (the rail's APPROVE line): the approval now waits for the owner. A later link replaces it (recover asks twice). */
export function recordLink(id, approve) {
  const record = readApproval(id);
  if (!record) return null;
  // a later local link (recover on a hosted chain) is not the hosted request any more
  const hosted = record.hosted && approve.matchCode ? record.hosted : undefined;
  return writeApproval({
    ...record,
    state: "waiting_owner",
    action: approve.action,
    url: approve.url,
    expires: approve.expires,
    terms: approve.terms,
    matchCode: typeof approve.matchCode === "string" ? approve.matchCode : undefined,
    hosted,
    links: (record.links ?? 0) + 1,
  });
}

/**
 * A hosted request exists for this approval (the rail script, before it prints the link): the site, the request id, the
 * match code and the agent's access token. Mode 600, like every record; the token never goes to a log.
 */
export function recordHosted(id, hosted) {
  if (!isApprovalId(id)) return null;
  return update(id, { hosted: { site: hosted.site, requestId: hosted.requestId, kind: hosted.kind, matchCode: hosted.matchCode, token: hosted.token } });
}

/** The command ended: store its RESULT and exit code for every later `wait`, and free the chain. The access token goes. */
export function recordFinal(id, code, result) {
  const before = readApproval(id);
  const hosted = before?.hosted ? { ...before.hosted, token: undefined } : undefined;
  const record = update(id, { state: "final", endedAt: new Date().toISOString(), final: { code, result }, ...(hosted ? { hosted } : {}) });
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
  if (child.pid) update(id, { pid: child.pid });
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
      if (!(await stopGroup(child.pid))) return { kind: "failed", record: last, reason: `the background approval stopped before it opened a page, but process group ${child.pid} would not stop; the chain stays held` };
      release(rail, chain, id);
      return { kind: "failed", record: last, reason: spawnError ? `the background approval could not start: ${spawnError.message}` : "the background approval stopped before it opened a page" };
    }
    if (Date.now() > until) {
      if (!(await stopGroup(child.pid))) return { kind: "failed", record: readApproval(id), reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s, and process group ${child.pid} would not stop; the chain stays held` };
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

/** The approval's page state for words: the site's request state when hosted, else the loopback page's own view. */
export async function pageStateOf(record) {
  const h = record?.hosted;
  if (h?.token) {
    const r = await readSiteRequest({ site: h.site, id: h.requestId, token: h.token, wait: 0 });
    return r.ok ? { status: `hosted:${r.view.state}`, walletAsked: r.view.wallet_asked === true || typeof r.view.tx_hash === "string" } : { status: "hosted:unreachable" };
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
    case "pending": return "waiting for the owner to open the link and connect their wallet";
    case "ready": return "the owner account is selected; waiting for wallet approval";
    case "sending": return rail === "solana" ? "the owner signed in the wallet; the command is sending it" : "a wallet transaction was requested; submission is not confirmed yet";
    case "sent": return "a transaction id is available; the command is checking it on chain";
    case "connected": return "the owner connected and signed; the command is finishing";
    case "hosted:awaiting_owner": return page.walletAsked ? "the owner's wallet was asked to send; no transaction is reported yet" : "waiting for the owner to open the link on superstables.com, signed in with their wallet, and pick the match code";
    case "hosted:sending": return "the owner's wallet was asked to send; no transaction is reported yet";
    case "hosted:unknown": return "superstables.com cannot tell whether the wallet sent it; the command is finishing and the chain must be checked";
    case "hosted:linked": return "the owner linked this agent; the command is finishing";
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
  const base = { command: record.command, rail: record.rail, chain: record.chain };
  const status = `superstables budget status --rail ${record.rail}${record.chain ? ` --chain ${record.chain}` : ""}`;
  const hostedOpen = Boolean(record.hosted && record.hosted.kind !== "link" && !hostedCancelled);
  if (hostedOpen && !page.sending) {
    return { code: 5, result: { ok: false, ...base, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason: "the background approval stopped while its request may still be open on superstables.com; the owner may still approve it there" } };
  }
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
      await stopGroup(record.pid);
      if (record.railPgid) await stopGroup(record.railPgid);
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
    const orphaned = !alive(record.pid);
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
    ? await cancelSiteRequest({ site: h.site, id: h.requestId, token: h.token }).then((c) => c && { cancelled: c.cancelled, status: c.state, sending: c.walletAsked === true })
    : await cancelPage(record.url, byId);
  if (!answer?.cancelled) {
    const why = !record.url ? "has no page yet" : !answer ? (h ? `is not answering on ${h.site}` : "is not answering") : answer.sending ? "already asked the wallet to send" : `is ${answer.status}`;
    return { ok: false, reason: `the pending approval ${record.id} ${why}: the wallet may be sending it, so it is not replaced` };
  }
  // cancelled: the command behind the page ends on its own with a refusal; give it a moment, then stop what is left
  for (let i = 0; i < 100 && processesAlive(record); i++) await sleep(100);
  if (processesAlive(record)) {
    await stopGroup(record.pid);
    if (record.railPgid) await stopGroup(record.railPgid);
  }
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
