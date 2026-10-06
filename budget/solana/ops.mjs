// Operation journal, lock and chain lookup for purchases (buy.mjs, reconcile.mjs).
//
// One JSON file per operation under $SUPERSTABLES_HOME/budget/ops/solana-devnet/<id>.json (../paths.mjs),
// outside the code folder. It is written BEFORE the payment is submitted (intent: seller URL,
// amount, recipient, token) and updated after (signature, state). It never holds a key.
//
// States in the journal file:
//   intent            prechecks passed, nothing signed yet
//   refused_precheck  refused before signing (retryable with the same id)
//   submitted         signed and handed to the seller / RPC; outcome not yet read from chain
//   unknown           submitted and the chain read was inconclusive (never retry, run reconcile)
//   settled           our own transaction succeeded on chain
//   failed            our own transaction landed and failed, or was refused by the chain
//   refused_chain     the chain refused it (simulation) and it cannot land while that holds
//   not_found         the blockhash expired and no transaction was ever found (safe to retry)
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { OPS_DIR, retryRead, sleep, formatUnits } from "./lib.mjs";
import { lockRecord } from "../op-lock.mjs";

export const OP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function newOpId() {
  return `sol-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

// Deterministic per-operation transaction identity. Two different operations get different
// compute-unit prices and different memos, so two purchases of the same price to the same seller
// can never be byte-identical (Solana would collapse those into one transaction). A retry of the
// same operation derives the same values again.
export function opIdentity(op) {
  const h = createHash("sha256").update(`rail-budgets/solana/${op}`).digest();
  return { microLamports: 1 + (h.readUInt32BE(0) % 9000), memo: `rb:${op}` };
}

const opPath = (op) => join(OPS_DIR, `${op}.json`);

export function readOp(op) {
  const p = opPath(op);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function writeOp(op, record) {
  mkdirSync(OPS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${opPath(op)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, opPath(op));
}

export function updateOp(op, patch, event) {
  const cur = readOp(op) ?? { op };
  const now = new Date().toISOString();
  const next = {
    ...cur,
    ...patch,
    updatedAt: now,
    history: [...(cur.history ?? []), { at: now, state: patch.state ?? cur.state, ...(event ? { note: event } : {}) }],
  };
  writeOp(op, next);
  return next;
}

// Shared with reconcile, including direct rail commands.
export function acquireLock(op) {
  return lockRecord(OPS_DIR, op);
}

// ---------------------------------------------------------------------------
// Chain lookup by the agent's own signature.
// ---------------------------------------------------------------------------

// Find OUR transaction: the one whose signature list contains the agent's signature.
// When the agent pays its own fee the agent signature is the transaction id; when a facilitator
// pays, its signature is first, so the agent's history is scanned for the agent signature.
// The seller's claimed settlement (rec.sellerTx, from its payment-response header) is only a hint: a
// seller can name any old successful transaction. It counts only if that transaction carries the
// agent's signature for this operation; otherwise it is unrelated and the search goes on.
// A failed read throws (never "not found"): the caller keeps the outcome unknown.
const DEVNET_GENESIS = SOLANA_DEVNET_GENESIS;
// As in the core rail, candidate reads must include version 1 transactions found on devnet.
const CANDIDATE_VERSION = 1;
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const ownFeePayer = (rec) => (typeof rec.agent === "string" && rec.feePayer === rec.agent) || rec.tx === rec.agentSig;

async function matchingTransaction(conn, sig, rec, commitment = "finalized") {
  const t = await conn.getTransaction(sig, { commitment, maxSupportedTransactionVersion: CANDIDATE_VERSION });
  if (!t || !Array.isArray(t.transaction?.signatures) || t.transaction.signatures[0] !== sig) throw new Error("transaction inclusion unreadable");
  if (!t.transaction.signatures.includes(rec.agentSig)) return null;
  if (!t.meta || t.meta.err === undefined) throw new Error("transaction execution unreadable");
  return { sig, err: t.meta.err, slot: t.slot, final: commitment === "finalized" };
}

export async function findOwnTx(conn, rec, { discover = true, paceMs = 2000, pause = sleep } = {}) {
  if (!rec.agentSig) return null;
  const known = ownFeePayer(rec) ? [rec.agentSig] : [...new Set([rec.agentSig, rec.tx, rec.sellerTx].filter(Boolean))];
  const st = await conn.getSignatureStatuses(known, { searchTransactionHistory: true });
  if (!Array.isArray(st.value) || st.value.length !== known.length) throw new Error("signature history unreadable");
  for (let i = 0; i < known.length; i++) {
    const status = st.value[i];
    if (!status || !["confirmed", "finalized"].includes(status.confirmationStatus)) continue;
    const final = status.confirmationStatus === "finalized";
    // The agent's signature is the ID only when the agent occupies the first signature slot.
    if (known[i] === rec.agentSig && ownFeePayer(rec)) {
      if (status.err === undefined) throw new Error("transaction execution unreadable");
      return { sig: known[i], err: status.err, slot: status.slot, final };
    }
    const matched = await matchingTransaction(conn, known[i], rec, final ? "finalized" : "confirmed");
    if (matched) return matched;
  }
  if (!discover || ownFeePayer(rec) || !rec.agent) return null;
  const sigs = await conn.getSignaturesForAddress(new PublicKey(rec.agent), { limit: 4 }, "finalized");
  const since = rec.submittedAt ? Date.parse(rec.submittedAt) / 1000 - 120 : 0;
  for (const s of sigs) {
    if (s.blockTime && s.blockTime < since) break;
    await pause(paceMs);
    const matched = await matchingTransaction(conn, s.signature, rec);
    if (matched) return matched;
  }
  return null;
}

/** Establish the oldest usable slot even for older journals that only recorded submission time. */
async function historyBoundary(conn, rec) {
  const first = await conn.getFirstAvailableBlock();
  if (!count(first)) return null;
  if (first === 0) return count(rec.searchFromSlot) ? rec.searchFromSlot : 0;
  if (count(rec.searchFromSlot)) return first <= rec.searchFromSlot ? rec.searchFromSlot : null;
  const since = Date.parse(rec.submittedAt ?? rec.createdAt ?? "") / 1000 - 120;
  if (!Number.isFinite(since)) return first === 0 ? 0 : null;
  const time = await conn.getBlockTime(first);
  return typeof time === "number" && time < since ? { since, first } : null;
}

/** Finalized address history must cross the entire landing window, with every candidate read. */
async function addressHistory(conn, rec, epoch, boundary, options, progress) {
  if (boundary === null || !rec.agent) return { complete: false };
  let before = rec.historyBefore;
  const initialRead = rec.historyRead ?? 0;
  let read = initialRead;
  for (let page = 0; page < 4 && Date.now() < options.deadline; page++) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(rec.agent), { limit: 100, ...(before ? { before } : {}), minContextSlot: epoch.absoluteSlot }, "finalized");
    if (!Array.isArray(sigs) || sigs.length === 0 || !sigs.every((entry, i) => count(entry.slot) && (i === 0 || entry.slot <= sigs[i - 1].slot)) || new Set(sigs.map((entry) => entry.signature)).size !== sigs.length) return { complete: false };
    for (const entry of sigs) {
      if (typeof entry.signature !== "string" || !count(entry.slot) || entry.confirmationStatus !== "finalized") return { complete: false };
      const crossed = typeof boundary === "number" ? entry.slot <= boundary : typeof entry.blockTime === "number" && entry.blockTime < boundary.since;
      if (crossed) return { complete: true };
      if (Date.now() + options.paceMs >= options.deadline || read >= initialRead + 8) return { complete: false };
      await options.pause(options.paceMs);
      const own = await matchingTransaction(conn, entry.signature, rec);
      if (own) return { complete: true, own };
      before = entry.signature;
      read++;
      progress({ historyBefore: before, historyRead: read });
    }
    await options.pause(options.paceMs);
  }
  return { complete: false };
}

/** Pacing and durable progress keep the complete block fallback short, including on public devnet. */
async function landingWindow(conn, rec, options, progress) {
  if (!count(rec.searchFromSlot) || !count(rec.lastValidBlockHeight)) return { complete: false };
  const slots = await conn.getBlocks(rec.searchFromSlot + 1, rec.searchFromSlot + 1000, "finalized");
  if (!Array.isArray(slots) || slots.length < 151) return { complete: false };
  const window = slots.slice(0, 151);
  if (!window.every((slot, i) => count(slot) && slot > (i ? window[i - 1] : rec.searchFromSlot))) return { complete: false };
  const resumed = count(rec.searchedToSlot) ? window.indexOf(rec.searchedToSlot) : -1;
  for (let i = resumed + 1; i < window.length; i++) {
    if (Date.now() + options.paceMs >= options.deadline) return { complete: false };
    await options.pause(options.paceMs);
    let block;
    try {
      block = await conn.getBlock(window[i], { commitment: "finalized", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: CANDIDATE_VERSION });
    } catch {
      // Completed slots are already saved. A 429 ends this run instead of starting web3 retry storms.
      return { complete: false };
    }
    if (!block || block.blockHeight !== rec.lastValidBlockHeight - 149 + i || !Array.isArray(block.transactions)) return { complete: false };
    for (const entry of block.transactions) {
      const signatures = entry.transaction?.signatures;
      if (!Array.isArray(signatures) || typeof signatures[0] !== "string" || !signatures.every((s) => typeof s === "string")) return { complete: false };
      if (signatures.includes(rec.agentSig)) {
        const own = await matchingTransaction(conn, signatures[0], rec);
        if (!own || own.slot !== window[i]) return { complete: false };
        return { complete: true, own };
      }
    }
    progress({ searchedToSlot: window[i] });
  }
  return { complete: true };
}

// Discovery misses preserve uncertainty. Absence requires finalized expiry plus direct history or all landing blocks.
/** @param {{searchMs?: number, paceMs?: number, pause?: (ms: number) => Promise<unknown>, onProgress?: (patch: Record<string, unknown>) => void}} [options] */
export async function assessOp(conn, rec, options = {}) {
  const { searchMs = 15_000, paceMs = 2000, pause = sleep, onProgress } = options;
  const readOptions = { deadline: Date.now() + searchMs, paceMs, pause };
  const progress = (patch) => {
    Object.assign(rec, patch);
    if (onProgress) onProgress(patch);
    else if (rec.op && readOp(rec.op)) updateOp(rec.op, patch, "reconcile: saved completed history reads");
  };
  if (!rec.agentSig) return { verdict: "no_tx" };
  if (await conn.getGenesisHash() !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet");
  const own = await findOwnTx(conn, rec, { discover: false, paceMs, pause });
  const landed = (t) => t.err === null
    ? { verdict: "settled", tx: t.sig, slot: t.slot, final: t.final !== false }
    : t.final === false ? { verdict: "pending", tx: t.sig, reason: "the transaction landed and failed, but is not final on chain yet" } : { verdict: "failed", tx: t.sig, err: t.err, slot: t.slot };
  if (own) return landed(own);
  const epoch = await conn.getEpochInfo("finalized");
  const height = epoch.blockHeight;
  if (!count(height) || !count(epoch.absoluteSlot)) throw new Error("finalized height unreadable");
  const last = rec.lastValidBlockHeight;
  const expired = count(last) && height > last;
  const pending = { verdict: "pending", blockHeight: height, lastValidBlockHeight: last ?? null, blocksLeft: count(last) && !expired ? last - height : null };
  const absent = () => rec.inclusionObserved
    ? { ...pending, reason: "the earlier payment inclusion could not be found; its outcome is unknown. Do not pay again" }
    : { verdict: "not_found", blockHeight: height, lastValidBlockHeight: last };
  if (!expired) {
    const discovered = ownFeePayer(rec) ? null : await findOwnTx(conn, rec, { paceMs, pause });
    return discovered ? landed(discovered) : pending;
  }
  if (ownFeePayer(rec)) {
    // Read history AFTER finalized expiry; a status read error or lagging context is never absence.
    const boundary = await historyBoundary(conn, rec);
    if (boundary === null) return pending;
    const st = await conn.getSignatureStatuses([rec.agentSig], { searchTransactionHistory: true });
    if (!count(st.context?.slot) || st.context.slot < epoch.absoluteSlot || !Array.isArray(st.value) || st.value.length !== 1) return pending;
    const status = st.value[0];
    if (status === null) return absent();
    if (status?.confirmationStatus === "finalized" && status.err !== undefined) return landed({ sig: rec.agentSig, err: status.err, slot: status.slot });
    return pending;
  }
  const boundary = await historyBoundary(conn, rec);
  const history = await addressHistory(conn, rec, epoch, boundary, readOptions, progress);
  if (history.own) return landed(history.own);
  if (history.complete) return absent();
  const window = await landingWindow(conn, rec, readOptions, progress);
  if (window.own) return landed(window.own);
  return window.complete ? absent() : pending;
}

/** A simulation refusal becomes permanent only when finalized reads prove no transaction landed. */
export async function refusalIsFinal(conn, rec) {
  try {
    const result = await assessOp(conn, rec);
    return result.verdict === "not_found";
  } catch {
    return false;
  }
}

// Token movement of a landed transaction: the transferChecked our operation built.
export async function readTransfer(conn, sig) {
  const t = await retryRead(() =>
    conn.getParsedTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: CANDIDATE_VERSION })
  ).catch(() => null);
  if (!t) return null;
  const ix = t.transaction.message.instructions.find((i) => i.parsed?.type === "transferChecked");
  if (!ix) return { signers: signersOf(t) };
  const info = ix.parsed.info;
  return {
    source: info.source,
    destination: info.destination,
    authority: info.authority ?? info.multisigAuthority,
    mint: info.mint,
    amount: info.tokenAmount?.amount,
    signers: signersOf(t),
  };
}
const signersOf = (t) => t.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58());

// Decide whether an existing journal entry lets `buy --op <id>` proceed. Contract: an operation
// that is submitted or unknown is never paid again until `reconcile` has read the chain and set
// it to settled, failed or not_found.
//   {allow:true}                       first use, or provably dead (never signed, failed, not_found)
//   {allow:false, reason, state, tx}   refuse; the caller prints it and exits 3
export function gateExistingOp(rec) {
  if (!rec) return { allow: true };
  const pending = ["submitted", "unknown"].includes(rec.state) || (rec.state === "refused_chain" && !rec.neverBroadcast);
  if (rec.state === "settled") {
    return { allow: false, state: "settled", tx: rec.tx ?? null, reason: `operation ${rec.op} is already settled (${rec.tx ?? "no tx id"}); use a new --op for a new purchase` };
  }
  if (pending) {
    return { allow: false, state: rec.state, tx: rec.tx ?? null, reason: `operation ${rec.op} is ${rec.state}; its transaction may still land. Run: node budget/solana/reconcile.mjs --op ${rec.op}` };
  }
  return { allow: true };
}

export const fmt = formatUnits;
export { sleep };
