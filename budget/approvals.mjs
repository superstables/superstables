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
//   <id>.json               the record (mode 600): command, rail, chain, pid, link, terms, and the final RESULT once known
//   <id>.log                the worker's stdout and stderr: the plan, the page, the chain reads
//   active-<rail>-<chain>   the id of the approval that holds that chain
//
// The worker is detached (its own session), so it outlives the caller, and it ends on its own: the owner page expires
// its link, the command reads the chain for a bounded time, and a backstop in the worker (workerDeadlineMs) stops it
// if anything hangs. Nothing here kills a process it did not start, except `--replace`, which stops a pending worker
// whose page has not asked the wallet for anything yet.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalsDir, ownerApprovalsLog } from "./paths.mjs";

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

/** A record whose worker is still running and has not ended: it holds its chain. */
export const isLive = (record) => Boolean(record && !record.final && alive(record.pid) && Date.now() < record.deadline);

// ── one approval at a time per rail and chain ──────────────────────────────────────────────────────────

/** The live approval that holds this rail and chain, or null. */
export function findPending(rail, chain) {
  let id;
  try {
    id = readFileSync(activeFile(rail, chain), "utf8").trim();
  } catch {
    return null;
  }
  const record = readApproval(id);
  return isLive(record) ? record : null;
}

/** Take the rail and chain for `id`. { ok: false, pending } when a live approval holds them. */
export function claim(rail, chain, id) {
  ensureDir();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(activeFile(rail, chain), "wx", 0o600);
      writeFileSync(fd, id);
      closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pending = findPending(rail, chain);
      if (pending) return { ok: false, pending };
      try {
        unlinkSync(activeFile(rail, chain)); // the holder ended or its process is gone
      } catch {}
    }
  }
  return { ok: false, pending: findPending(rail, chain) };
}

function release(rail, chain, id) {
  try {
    if (readFileSync(activeFile(rail, chain), "utf8").trim() === id) unlinkSync(activeFile(rail, chain));
  } catch {}
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
      release(rail, chain, id);
      return { kind: "failed", record: last, reason: spawnError ? `the background approval could not start: ${spawnError.message}` : "the background approval stopped before it opened a page" };
    }
    if (Date.now() > until) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      release(rail, chain, id);
      update(id, { state: "final", final: { code: 1, result: { ok: false, command, rail, chain, state: "failed", id, next: "nothing was sent; try again later", reason: `no approval page within ${Math.round(linkWaitMs / 1000)} s` } } });
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

/** What the page's status means for a caller who is waiting. */
export function pageWords(page) {
  switch (page?.status) {
    case "pending": return "waiting for the owner to open the link and connect their wallet";
    case "ready": return "the owner connected their wallet; waiting for them to approve in it";
    case "sending": return "the wallet was asked to send; waiting for the owner to confirm in it";
    case "sent": return "the wallet sent the transaction; the command is reading it from the chain";
    case "connected": return "the owner connected and signed; the command is finishing";
    case undefined: case null: return "waiting for the owner";
    default: return "the owner page has ended; the command is finishing";
  }
}

/** The last state the owner page logged for the page id in `url` (owner-approvals.jsonl). */
function lastPageStatus(url) {
  const pageId = /\/owner\/([0-9a-f]{32})/.exec(url ?? "")?.[1];
  if (!pageId || !existsSync(ownerApprovalsLog())) return null;
  let status = null;
  for (const line of readFileSync(ownerApprovalsLog(), "utf8").split("\n")) {
    if (!line.includes(pageId)) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id === pageId) status = entry.status;
    } catch {}
  }
  return status;
}

/** The worker is gone without a RESULT (killed, crashed, machine restarted): say what can be known. */
function abandoned(record) {
  const page = lastPageStatus(record.url);
  const mayHaveSent = ["sending", "sent", "confirmed", "failed"].includes(page);
  const base = { command: record.command, rail: record.rail, chain: record.chain };
  const status = `superstables budget status --rail ${record.rail}${record.chain ? ` --chain ${record.chain}` : ""}`;
  if (mayHaveSent) {
    return { code: 5, result: { ok: false, ...base, state: "unknown", id: record.id, url: record.url, next: `${status}: read whether it landed before running this again`, reason: `the background approval stopped after the wallet was asked to send (last page state: ${page})` } };
  }
  return { code: 3, result: { ok: false, ...base, state: "refused_precheck", id: record.id, url: record.url, next: "nothing was sent. Run the command again only if the owner asks", reason: `the background approval stopped before anything was sent (last page state: ${page ?? "none"})` } };
}

/**
 * `superstables budget wait`: poll up to `timeoutMs`. Returns null for an unknown id, { final: true, code, result } once
 * the command ended (the same answer every time after that), or { final: false, record, page } while it still waits.
 * A new link during the wait (recover's second owner step) returns at once, so the caller can show it.
 */
export async function waitFor(id, timeoutMs, { poll = 250 } = {}) {
  const first = readApproval(id);
  if (!first) return null;
  const until = Date.now() + timeoutMs;
  for (;;) {
    let record = readApproval(id);
    if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
    if (!isLive(record)) {
      await sleep(100); // a worker that just wrote its RESULT may still be exiting
      record = readApproval(id);
      if (record.final) return { final: true, code: record.final.code, result: record.final.result, record };
      const final = abandoned(record);
      recordFinal(id, final.code, final.result);
      return { final: true, ...final, record: readApproval(id) };
    }
    if (record.url && record.url !== first.url) return { final: false, record, page: await pageState(record.url) };
    if (Date.now() >= until) return { final: false, record, page: await pageState(record.url) };
    await sleep(Math.min(poll, Math.max(0, until - Date.now())));
  }
}

/**
 * `--replace`: stop a pending approval whose page has not asked the wallet for anything, and record it as replaced.
 * Returns { ok: true } or { ok: false, reason } (the wallet may be sending: never stop that).
 */
export async function replacePending(record, byId) {
  const page = await pageState(record.url);
  if (!page || !["pending", "ready"].includes(page.status)) {
    return { ok: false, reason: `the pending approval ${record.id} is ${page?.status ?? "not answering"}: the wallet may be sending it, so it is not replaced` };
  }
  try { process.kill(-record.pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 50 && alive(record.pid); i++) await sleep(100);
  if (alive(record.pid)) { try { process.kill(-record.pid, "SIGKILL"); } catch {} }
  const result = {
    ok: false, command: record.command, rail: record.rail, chain: record.chain, state: "refused_precheck", id: record.id, url: record.url,
    next: `nothing was sent. The new approval is ${byId}`, reason: `replaced by ${byId} before the owner approved; nothing was sent`,
  };
  recordFinal(record.id, 3, result);
  return { ok: true };
}
