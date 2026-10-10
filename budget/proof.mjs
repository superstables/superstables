// Once an owner command may have sent a transaction, it answers `failed` only when the chain proves the transaction changed
// nothing, and its RESULT names that fact in `proof`. Any other end after that point (a crash, a missing RESULT, an exit
// code nobody expects, a read-back that throws or disagrees, a refusal of a later step) is `unknown`, exit 5. Before that
// point nothing changes.
//
// The command may have sent once its wallet or page was asked, or reported sending (the page log, superstables.com's
// wallet_asked or transaction hash), or once its rail script is about to broadcast. The rail says so with one stdout line,
// `SENDING {...}`, written synchronously before the broadcast leaves: the dispatcher reads it even when the script then
// crashes before its RESULT. Under an owner approval it also writes `sending: true` on the approval's record first, which
// every other process that answers for the approval reads (approvals.mjs recordMayHaveSent). The RPC clients in evm/lib.ts, tempo/lib/common.ts and solana/lib.mjs mark every broadcast
// that goes through them (markSend), so a new send path through them is covered.
import { writeSync } from "node:fs";
import { HOLDER_ENV, recordSending } from "./approvals.mjs";

/** The chain facts that prove a sent transaction changed nothing. The only values a `proof` may take. */
export const PROOFS = Object.freeze({
  reverted: "the transaction landed and failed on chain, so it changed nothing (its network fee may still be charged)",
  blockhash_expired: "solana: the chain is past the transaction's last valid block height and has no status for its signature, so it can never land",
});

/** The marker line a rail prints right before it broadcasts. */
export const SENDING_LINE = /^SENDING \{/;

let began = false;
/** Whether this process was about to broadcast a transaction (sendBegins ran). */
export const sendBegan = () => began;

/**
 * Print the marker, synchronously: a crash right after the broadcast must still find it on stdout. Under an owner approval
 * (HOLDER_ENV) it is also kept on the approval's record before the broadcast leaves, so a process that stops this one, or
 * reads the record after both are gone, still sees it. A write that fails throws, and the broadcast does not leave.
 */
export function sendBegins(method) {
  began = true;
  writeSync(1, `SENDING ${JSON.stringify({ method })}\n`);
  const holder = process.env[HOLDER_ENV];
  if (holder) recordSending(holder);
}

const BROADCAST = /"method":\s*"(eth_sendRawTransaction\w*|eth_sendTransaction|sendTransaction)"/;
/** For an RPC client's request hook: mark the request body if it broadcasts a transaction (EVM, Tempo or Solana). */
export function markSend(body) {
  const m = typeof body === "string" ? BROADCAST.exec(body) : null;
  if (m) sendBegins(m[1]);
}

/** A failed answer the chain proved: `state` failed or not_revoked with a known `proof`. */
export const proven = (o) => ["failed", "not_revoked"].includes(o?.state) && Object.hasOwn(PROOFS, o?.proof ?? "");

/** What an owner command may still say once it may have sent: done, unknown, or a failure the chain proved. */
const STANDS = new Set(["settled", "ok", "unknown"]);

/**
 * The answer an owner command gives once it may have sent. `fields` is its RESULT as built; `check` the read-only command
 * that shows whether it landed. Any end other than done, unknown or a proven failure becomes unknown, exit 5, keeping the
 * reason; its next step is to read the chain, unless the rail already said unknown or refused and named its own way out.
 * A setup step that says failed without a proof becomes unknown too, and a proven failure of the request stands only when
 * no other step may have moved funds: else it is unknown, reason `partly_done`, and each step keeps its own state.
 */
export function afterSend(code, fields, check) {
  const steps = Array.isArray(fields.steps) ? fields.steps.map((s) => (s?.state === "failed" && !proven(s) ? { ...s, state: "unknown" } : s)) : fields.steps;
  const keep = { ...fields, ...(steps ? { steps } : {}) };
  // a step that may have moved funds: any but one that sent nothing (a refusal) or that the chain proved changed nothing
  const moved = (steps ?? []).filter((s) => s && s.state !== "refused_precheck" && !proven(s));
  if (STANDS.has(fields.state) || (proven(fields) && !moved.length)) return { code, fields: keep };
  const ownWay = fields.state === "refused_precheck" && typeof fields.next === "string" && fields.next !== "" && fields.next !== "none";
  const { proof: _unproven, ...rest } = keep;
  if (proven(fields)) {
    // the chain proved a later step failed, after another step may have moved funds: the request as a whole is partly done
    const named = (list) => list.map((s) => `${s.kind ?? "a step"} ${s.state}${s.proof ? ` (${s.proof})` : ""}`).join(", ");
    return { code: 5, fields: { ...rest, ok: false, state: "unknown", next: fields.next ?? `${check}: read what landed before running this again`, reason: `partly_done: ${named(moved)} before ${named(steps.filter(proven))}; ${fields.reason ?? ""}` } };
  }
  return { code: 5, fields: { ...rest, ok: false, state: "unknown", next: ownWay ? fields.next : `${check}: read whether it landed before running this again`, reason: fields.reason ?? `the ${fields.command} script ended without a result the chain proves` } };
}
