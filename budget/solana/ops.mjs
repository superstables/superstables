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
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { OPS_DIR, retryRead, sleep, formatUnits } from "./lib.mjs";

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

// Exclusive lock so two processes never work the same operation at once. The pid is written to a
// private file first and then hard-linked to the lock name, so the lock either exists with its pid
// or does not exist (no window where a second process sees an empty lock). A lock whose process is
// gone is stale and is taken over.
export function acquireLock(op) {
  mkdirSync(OPS_DIR, { recursive: true, mode: 0o700 });
  const path = `${opPath(op)}.lock`;
  const mine = `${path}.${process.pid}.tmp`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, path);
        const release = () => {
          try {
            unlinkSync(path);
          } catch {}
        };
        process.on("exit", release);
        return { ok: true, release };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let holder = NaN;
        try {
          holder = Number(readFileSync(path, "utf8"));
        } catch {}
        let alive = false;
        if (Number.isInteger(holder) && holder > 0) {
          try {
            process.kill(holder, 0);
            alive = true;
          } catch (err) {
            alive = err.code === "EPERM";
          }
        }
        if (alive) return { ok: false, holder };
        try {
          unlinkSync(path);
        } catch {}
      }
    }
    return { ok: false, holder: null };
  } finally {
    try {
      unlinkSync(mine);
    } catch {}
  }
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
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const ownFeePayer = (rec) => (typeof rec.agent === "string" && rec.feePayer === rec.agent) || rec.tx === rec.agentSig;

async function matchingTransaction(conn, sig, rec) {
  const t = await retryRead(() => conn.getTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 1 }));
  if (!t || !Array.isArray(t.transaction?.signatures) || t.transaction.signatures[0] !== sig) throw new Error("transaction inclusion unreadable");
  if (!t.transaction.signatures.includes(rec.agentSig)) return null;
  if (!t.meta || t.meta.err === undefined) throw new Error("transaction execution unreadable");
  return { sig, err: t.meta.err, slot: t.slot };
}

export async function findOwnTx(conn, rec) {
  if (!rec.agentSig) return null;
  const known = ownFeePayer(rec) ? [rec.agentSig] : [...new Set([rec.agentSig, rec.tx, rec.sellerTx].filter(Boolean))];
  const st = await retryRead(() => conn.getSignatureStatuses(known, { searchTransactionHistory: true }));
  if (!Array.isArray(st.value) || st.value.length !== known.length) throw new Error("signature history unreadable");
  for (let i = 0; i < known.length; i++) {
    const status = st.value[i];
    if (!status || status.confirmationStatus !== "finalized") continue;
    // The agent's signature is the ID only when the agent occupies the first signature slot.
    if (known[i] === rec.agentSig && ownFeePayer(rec)) {
      if (status.err === undefined) throw new Error("transaction execution unreadable");
      return { sig: known[i], err: status.err, slot: status.slot };
    }
    const matched = await matchingTransaction(conn, known[i], rec);
    if (matched) return matched;
  }
  if (ownFeePayer(rec) || !rec.agent) return null;
  const sigs = await retryRead(() => conn.getSignaturesForAddress(new PublicKey(rec.agent), { limit: 40 }, "finalized"));
  const since = rec.submittedAt ? Date.parse(rec.submittedAt) / 1000 - 120 : 0;
  for (const s of sigs) {
    if (s.blockTime && s.blockTime < since) break;
    const matched = await matchingTransaction(conn, s.signature, rec);
    if (matched) return matched;
  }
  return null;
}

/** All produced finalized blocks in the signed blockhash's landing window, with every matching candidate readable. */
async function landingWindow(conn, rec) {
  if (!count(rec.searchFromSlot) || !count(rec.lastValidBlockHeight)) return { complete: false };
  const slots = await retryRead(() => conn.getBlocks(rec.searchFromSlot + 1, rec.searchFromSlot + 1000, "finalized"));
  if (!Array.isArray(slots) || slots.length < 151) return { complete: false };
  const window = slots.slice(0, 151);
  let previous = rec.searchFromSlot;
  for (let i = 0; i < window.length; i++) {
    const slot = window[i];
    if (!count(slot) || slot <= previous) return { complete: false };
    const block = await retryRead(() => conn.getBlock(slot, { commitment: "finalized", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 1 }));
    if (!block || block.blockHeight !== rec.lastValidBlockHeight - 149 + i || !Array.isArray(block.transactions)) return { complete: false };
    for (const entry of block.transactions) {
      const signatures = entry.transaction?.signatures;
      if (!Array.isArray(signatures) || typeof signatures[0] !== "string" || !signatures.every((s) => typeof s === "string")) return { complete: false };
      if (signatures.includes(rec.agentSig)) {
        const own = await matchingTransaction(conn, signatures[0], rec);
        if (!own || own.slot !== slot) return { complete: false };
        return { complete: true, own };
      }
    }
    previous = slot;
  }
  return { complete: true };
}

// Discovery misses preserve uncertainty. Absence requires finalized expiry plus direct history or all landing blocks.
export async function assessOp(conn, rec) {
  if (!rec.agentSig) return { verdict: "no_tx" };
  if (await retryRead(() => conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet");
  const own = await findOwnTx(conn, rec);
  const landed = (t) => t.err === null
    ? { verdict: "settled", tx: t.sig, slot: t.slot }
    : { verdict: "failed", tx: t.sig, err: t.err, slot: t.slot };
  if (own) return landed(own);
  const epoch = await retryRead(() => conn.getEpochInfo("finalized"));
  const height = epoch.blockHeight;
  if (!count(height) || !count(epoch.absoluteSlot)) throw new Error("finalized height unreadable");
  const last = rec.lastValidBlockHeight;
  const expired = count(last) && height > last;
  const pending = { verdict: "pending", blockHeight: height, lastValidBlockHeight: last ?? null, blocksLeft: count(last) && !expired ? last - height : null };
  if (!expired) return pending;
  if (ownFeePayer(rec)) {
    // Read history AFTER finalized expiry; a status read error or lagging context is never absence.
    const first = await retryRead(() => conn.getFirstAvailableBlock());
    if (!count(first) || (count(rec.searchFromSlot) ? first > rec.searchFromSlot : first !== 0)) return pending;
    const st = await retryRead(() => conn.getSignatureStatuses([rec.agentSig], { searchTransactionHistory: true }));
    if (!count(st.context?.slot) || st.context.slot < epoch.absoluteSlot || !Array.isArray(st.value) || st.value.length !== 1) return pending;
    const status = st.value[0];
    if (status === null) return { verdict: "not_found", blockHeight: height, lastValidBlockHeight: last };
    if (status?.confirmationStatus === "finalized" && status.err !== undefined) return landed({ sig: rec.agentSig, err: status.err, slot: status.slot });
    return pending;
  }
  const window = await landingWindow(conn, rec);
  if (window.own) return landed(window.own);
  return window.complete ? { verdict: "not_found", blockHeight: height, lastValidBlockHeight: last } : pending;
}

/** A simulation refusal becomes permanent only with the same final absence or execution-failure proof as reconcile. */
export async function refusalIsFinal(conn, rec) {
  try {
    const result = await assessOp(conn, rec);
    return result.verdict === "not_found" || result.verdict === "failed";
  } catch {
    return false;
  }
}

// Token movement of a landed transaction: the transferChecked our operation built.
export async function readTransfer(conn, sig) {
  const t = await retryRead(() =>
    conn.getParsedTransaction(sig, { commitment: "finalized", maxSupportedTransactionVersion: 0 })
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
