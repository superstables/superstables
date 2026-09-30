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
export async function findOwnTx(conn, rec) {
  if (!rec.agentSig) return null;
  const known = [...new Set([rec.agentSig, rec.tx, rec.sellerTx].filter(Boolean))];
  const st = await retryRead(() => conn.getSignatureStatuses(known, { searchTransactionHistory: true }));
  for (let i = 0; i < known.length; i++) {
    const s = st.value[i];
    if (!(s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" || s.err))) continue;
    if (known[i] === rec.agentSig) return { sig: known[i], err: s.err ?? null, slot: s.slot };
    const t = await retryRead(() =>
      conn.getTransaction(known[i], { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    );
    if (t?.transaction.signatures.includes(rec.agentSig)) return { sig: known[i], err: t.meta?.err ?? s.err ?? null, slot: t.slot ?? s.slot };
    // unrelated to this operation: not our settlement
  }
  if (!rec.agent) return null;
  const sigs = await retryRead(() =>
    conn.getSignaturesForAddress(new PublicKey(rec.agent), { limit: 40 }, "confirmed")
  );
  const since = rec.submittedAt ? Date.parse(rec.submittedAt) / 1000 - 120 : 0;
  for (const s of sigs) {
    if (s.blockTime && s.blockTime < since) break;
    const t = await retryRead(() =>
      conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
    );
    if (t?.transaction.signatures.includes(rec.agentSig)) {
      return { sig: s.signature, err: t.meta?.err ?? s.err ?? null, slot: t.slot };
    }
  }
  return null;
}

// What the chain says about an operation. Never pays.
//   settled    our transaction landed and succeeded
//   failed     our transaction landed and failed
//   not_found  no transaction, and its blockhash has expired so it can no longer land
//   pending    no transaction yet and the blockhash may still be valid
//   no_tx      nothing was ever signed for this operation
const EXPIRY_MARGIN_BLOCKS = 30;
export async function assessOp(conn, rec) {
  if (!rec.agentSig) return { verdict: "no_tx" };
  const own = await findOwnTx(conn, rec);
  if (own) {
    if (own.err) return { verdict: "failed", tx: own.sig, err: own.err, slot: own.slot };
    return { verdict: "settled", tx: own.sig, slot: own.slot };
  }
  const height = await retryRead(() => conn.getBlockHeight("confirmed"));
  const last = rec.lastValidBlockHeight;
  if (typeof last === "number" && height > last + EXPIRY_MARGIN_BLOCKS) {
    return { verdict: "not_found", blockHeight: height, lastValidBlockHeight: last };
  }
  return {
    verdict: "pending",
    blockHeight: height,
    lastValidBlockHeight: last ?? null,
    blocksLeft: typeof last === "number" ? Math.max(0, last + EXPIRY_MARGIN_BLOCKS - height) : null,
  };
}

// Token movement of a landed transaction: the transferChecked our operation built.
export async function readTransfer(conn, sig) {
  const t = await retryRead(() =>
    conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
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
