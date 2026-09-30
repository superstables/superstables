// reconcile -- read the chain for one operation and set its state. It never pays and never signs,
// and it opens no key file: everything it needs (agent address, agent signature, blockhash window)
// is in the operation's journal.
//
// How it finds the transaction: by the agent's signature recorded in the journal before the payment
// was submitted. When the agent paid its own fee that signature is the transaction id; when a
// facilitator paid, the agent's address history is scanned for the transaction that carries the
// agent signature. Then:
//   settled    the transaction landed and succeeded (debit = the transferred amount)
//   failed     it landed and failed on chain (nothing moved)
//   not_found  no transaction, and the signed blockhash has expired, so it can never land
//   unknown    no transaction yet and the blockhash may still be valid: run reconcile again
// `delivered` (the seller's answer) is left as recorded; after an interrupted run it stays null.
//
// Exit: 0 when the chain gave an answer (settled, failed or not_found; read the RESULT state),
// 1 for a missing journal, 2 bad flags, 4 unknown (still pending).
import { connection, parseStrict, formatUnits, retryRead, EXIT } from "./lib.mjs";
import { getAssociatedTokenAddressSync, getAccount } from "./token.mjs";
import { PublicKey } from "@solana/web3.js";
import { OP_ID_RE, readOp, updateOp, assessOp, readTransfer } from "./ops.mjs";
import { USDC_MINT, explorerTx } from "./lib.mjs";

const USAGE = `Usage: node budget/solana/reconcile.mjs --op <id>

Read the chain for operation <id> and set its journal state to settled, failed or not_found
(or leave it unknown while its transaction may still land). Never pays, never signs.

  --op <id>    the operation id printed by buy.mjs
  -h, --help   show this help

Journal: $SUPERSTABLES_HOME/budget/ops/solana-devnet/<id>.json
Last stdout line: RESULT {"rail","op","state","tx","debit","remaining","delivered","next"}
Exit: 0 answered (settled, failed or not_found: read RESULT state), 1 no journal, 2 bad flags, 4 still unknown.`;

const flags = parseStrict(process.argv.slice(2), { op: "value" }, { usage: USAGE, required: ["op"] });
const opId = flags.op;
if (!OP_ID_RE.test(opId)) {
  console.error("Error: --op must be 1-64 characters: letters, digits, '.', '_' or '-'\n\n" + USAGE);
  process.exit(EXIT.USAGE);
}

const rec = readOp(opId);
if (!rec) {
  console.error(`No journal for operation ${opId}. Nothing to reconcile.`);
  console.log("RESULT " + JSON.stringify({ rail: "solana", op: opId, state: "unknown", tx: null, debit: "0", remaining: null, delivered: null, next: "check the operation id; nothing was recorded for it", reason: "no journal" }));
  process.exit(EXIT.FAILED);
}

const conn = connection();
console.log(`Operation: ${opId} (${rec.kind ?? "purchase"}), recorded state: ${rec.state}`);
console.log(`  ${rec.amountUsdc ?? "?"} USDC to ${rec.payTo ?? "?"}; agent ${rec.agent ?? "?"}; signature ${rec.agentSig ?? "(none: never signed)"}`);

let remaining = null;
if (rec.ownerAta) {
  const a = await retryRead(() => getAccount(conn, new PublicKey(rec.ownerAta))).catch(() => null);
  remaining = a ? formatUnits(a.delegatedAmount) : null;
}
const result = (state, extra = {}) => ({ rail: "solana", op: opId, state, tx: rec.tx ?? null, debit: "0", remaining, delivered: rec.delivered ?? null, next: "", ...extra });
const emit = (r, code) => {
  console.log("RESULT " + JSON.stringify(r));
  process.exit(code);
};

let a;
try {
  a = await assessOp(conn, rec);
} catch (e) {
  // a failed read is never "not found": the operation stays unknown
  console.log(`Could not read the chain: ${e?.message ?? e}. Do not pay again.`);
  emit(result("unknown", { reason: `could not read the chain: ${String(e?.message ?? e).slice(0, 160)}`, next: `node budget/solana/reconcile.mjs --op ${opId}` }), EXIT.UNCERTAIN);
}
console.log(`Chain read: ${a.verdict}${a.tx ? ` ${explorerTx(a.tx)}` : ""}`);

if (a.verdict === "no_tx") {
  updateOp(opId, { state: "not_found" }, "reconcile: nothing was ever signed for this operation");
  console.log("Nothing was signed for this operation, so nothing was paid.");
  emit(result("not_found", { reason: "never signed", delivered: false, next: `nothing was paid; buy again (this --op may be reused)` }), EXIT.OK);
} else if (a.verdict === "settled") {
  const movement = await readTransfer(conn, a.tx);
  const debit = movement?.amount ? formatUnits(movement.amount) : (rec.amountUsdc ?? "0");
  const moved = movement?.amount && rec.amount && movement.amount !== rec.amount ? ` (journal expected ${rec.amount})` : "";
  updateOp(opId, { state: "settled", tx: a.tx, debit, movement }, "reconcile: own transaction succeeded");
  console.log(`Settled: our transaction succeeded on chain, debit ${debit} USDC${moved}.`);
  console.log(`Delivered: ${rec.delivered ?? "unknown (the seller's answer was not recorded)"}. A delivery problem never triggers a new payment.`);
  emit(result("settled", { tx: a.tx, debit, next: rec.delivered === false ? `settled but not delivered: do not pay again; contact the seller with tx ${a.tx}` : "none" }), EXIT.OK);
} else if (a.verdict === "failed") {
  updateOp(opId, { state: "failed", tx: a.tx, error: a.err }, "reconcile: own transaction failed on chain");
  console.log(`Failed on chain: ${JSON.stringify(a.err)}. Nothing moved.`);
  emit(result("failed", { tx: a.tx, delivered: false, reason: JSON.stringify(a.err), next: "nothing moved; buy again with a new --op" }), EXIT.OK);
} else if (a.verdict === "not_found") {
  updateOp(opId, { state: "not_found" }, `reconcile: no transaction and the blockhash expired (height ${a.blockHeight} > ${a.lastValidBlockHeight})`);
  console.log(`Not found: block height ${a.blockHeight} is past ${a.lastValidBlockHeight} (+ margin), so the signed transaction can no longer land. Nothing was paid.`);
  emit(result("not_found", { reason: "blockhash expired", delivered: false, next: `nothing was paid; safe to buy again (this --op may be reused)` }), EXIT.OK);
} else {
  updateOp(opId, { state: "unknown" }, `reconcile: pending, ${a.blocksLeft ?? "?"} blocks until the blockhash is provably dead`);
  console.log(`Still pending: no transaction found yet and the blockhash may be valid for about ${a.blocksLeft ?? "?"} more blocks (about ${Math.ceil((a.blocksLeft ?? 0) * 0.4)} s). Do not pay again.`);
  emit(result("unknown", { next: `wait about ${Math.ceil((a.blocksLeft ?? 0) * 0.4) + 5} s, then: node budget/solana/reconcile.mjs --op ${opId}` }), EXIT.UNCERTAIN);
}
