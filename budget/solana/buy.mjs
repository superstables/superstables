// buy -- the agent, acting as the SPL-Token delegate on the owner's own USDC associated token
// account, pays a real third-party x402 `exact` Solana-devnet offer. The amount and recipient come
// from the seller's live 402 challenge; the caller's policy (--max, optional --pay-to) is checked
// before anything is signed.
//
// What it builds: a v0 transaction, one TransferChecked(ownerAta -> sellerAta, authority = the
// AGENT, the owner's approved delegate), with the compute-unit price and a memo derived from the
// operation id so two different operations never build the same transaction (identical ones
// would collapse into one on chain and the agent would get two deliveries for one payment),
// while a retry of the same operation derives the same values. Fee payer: the facilitator's
// `extra.feePayer` when offered (it completes the signature at /settle), else the agent.
//
// Safety, in order:
//   1. Strict flags (unknown or missing flags exit 2 before any file is read).
//   2. An operation id (--op, or generated and printed). A journal file is written before the
//      payment is submitted. An operation that is submitted or unknown is refused until
//      `reconcile` has read the chain. One process per operation (lock).
//   3. Prechecks on the challenge (price <= --max, devnet USDC mint, 6 decimals, precision,
//      recipient == --pay-to when given). A refusal exits 3 with state refused_precheck. The
//      agent key file is not opened on a refusal.
//   4. Only then the agent key is loaded, the owner's USDC account read, and the budget checked
//      (the agent is the delegate, the delegated amount and the balance cover the price). A
//      refusal exits 3 with state refused_precheck.
//   5. Only then the payment is signed.
//   6. Settled means OUR transaction (found by the agent's signature) succeeded on chain. The
//      seller's HTTP status is recorded separately as `delivered`. A delivery failure never
//      triggers a new payment, and an uncertain outcome is never retried: read it with reconcile.
//
// Exit codes: 0 settled or quoted, 1 failed or refused by the chain, 2 bad flags, 3 refused
// before signing, 4 outcome unknown (run reconcile; do not pay again).
import {
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getMint,
  TokenAccountNotFoundError,
} from "./token.mjs";
import bs58 from "bs58";
import {
  connection,
  loadAgent,
  readPublic,
  explorerTx,
  explorerAddr,
  formatUnits,
  parseStrict,
  parseAmountFlag,
  parsePubkeyFlag,
  usageError,
  retryRead,
  oneLine,
  sleep,
  EXIT,
  USDC_MINT,
  USDC_DECIMALS,
  OPS_DIR,
} from "./lib.mjs";
import { readCapped, saveResponse } from "../response.mjs";
import { newOpId, OP_ID_RE, opIdentity, readOp, updateOp, acquireLock, gateExistingOp, findOwnTx, readTransfer, refusalIsFinal } from "./ops.mjs";
import { selectRequirement, checkOffer, checkDelegation } from "./precheck.mjs";

const USAGE = `Usage: node budget/solana/buy.mjs --url <seller-url> --max <usdc> [options]

Pay an x402 "exact" Solana-devnet offer as the agent (SPL delegate of the owner's USDC account).

Required:
  --url <url>        the seller resource (the unpaid request must answer HTTP 402)
  --max <usdc>       highest price you accept, decimal USDC (e.g. 0.05). No default.
                     Optional only with --check.
Options:
  --pay-to <addr>    refuse unless the offer pays exactly this address
  --op <id>          operation id (letters, digits . _ -; generated and printed if absent)
  --method <verb>    GET (default), POST, PUT, PATCH or DELETE
  --body <json>      request body, sent verbatim on both requests
  --owner <addr>     pay from another owner account that approved this agent
                     (default: owner address from the public file or solana-agent.env)
  --check            quote only: parse and check the offer, sign and pay nothing
  -h, --help         show this help

Files: opens only the agent key file, solana-agent.env (after the prechecks pass).
Journal: $SUPERSTABLES_HOME/budget/ops/solana-devnet/<op>.json
Last stdout line: RESULT {"rail","op","state","tx","debit","remaining","delivered","next"}
Exit: 0 settled/quoted, 1 failed, 2 bad flags, 3 refused before signing, 4 unknown (run reconcile).`;

const flags = parseStrict(
  process.argv.slice(2),
  { url: "value", max: "value", "pay-to": "value", op: "value", method: "value", body: "value", owner: "value", check: "bool" },
  { usage: USAGE, required: ["url"] }
);
const checkOnly = flags.check === true;
if (!checkOnly && flags.max === undefined) usageError("missing required flag --max", USAGE);
const maxBase = parseAmountFlag(flags, "max", USAGE);
const payToFlag = parsePubkeyFlag(flags, "pay-to", USAGE);
const ownerFlag = parsePubkeyFlag(flags, "owner", USAGE);
try {
  new URL(flags.url);
} catch {
  usageError("--url is not a valid URL", USAGE);
}
const url = flags.url;
const method = (flags.method ?? "GET").toUpperCase();
if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) usageError(`unsupported --method ${method}`, USAGE);
const bodyText = flags.body;
const opId = flags.op ?? newOpId();
if (!OP_ID_RE.test(opId)) usageError("--op must be 1-64 characters: letters, digits, '.', '_' or '-'", USAGE);

const SOLANA_MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const b64encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
const b64decodeJson = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

let result = { rail: "solana", op: opId, state: "unknown", tx: null, debit: "0", remaining: null, delivered: null, next: "" };
function finish(state, code, extra = {}) {
  const line = { ...result, state, ...extra };
  console.log("RESULT " + JSON.stringify(line));
  process.exit(code);
}
// Everything the seller sent (its body, its offer, its headers, its errors) is printed through oneLine: one line each.
const refuse = (reasons, extra = {}) => {
  for (const r of [].concat(reasons)) console.error(`Refused (nothing signed): ${oneLine(r, 1000)}`);
  finish("refused_precheck", EXIT.REFUSED, { reason: [].concat(reasons).join("; "), next: "fix the request or pass a new --max/--pay-to; nothing was signed or paid", ...extra });
};

async function fetchOnce(u, m, body, extraHeaders, timeoutMs = 60_000) {
  const headers = { Accept: "application/json", ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(u, { method: m, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const capped = await readCapped(res);
  return { res, text: capped.bytes.toString("utf8"), capped };
}

console.log(`Operation: ${opId}`);
console.log(`Resource: ${method} ${url}`);

// --- 1. one process per operation; refuse a pending or settled one --------------------------------
let lock = { ok: true };
if (!checkOnly) {
  lock = acquireLock(opId);
  if (!lock.ok) {
    refuse(`operation ${opId} is being worked by another process${lock.holder ? ` (pid ${lock.holder})` : ""}`, { next: `wait, then: node budget/solana/reconcile.mjs --op ${opId}` });
  }
  const gate = gateExistingOp(readOp(opId));
  if (!gate.allow) {
    console.error(`Refused (nothing signed): ${gate.reason}`);
    finish("refused_precheck", EXIT.REFUSED, { tx: gate.tx, reason: gate.reason, next: gate.state === "settled" ? "none: already settled, do not pay again" : `node budget/solana/reconcile.mjs --op ${opId}` });
  }
}

// --- 2. the unpaid request and the challenge -------------------------------------------------------
let initial;
try {
  initial = await fetchOnce(url, method, bodyText);
} catch (e) {
  refuse(`seller unreachable: ${e?.message ?? e}`);
}
console.log(`\nInitial request: HTTP ${initial.res.status}`);
if (initial.res.status !== 402) {
  console.log(oneLine(initial.text, 300));
  refuse(`the seller did not ask for payment (HTTP ${initial.res.status}); nothing to buy`);
}

const paymentRequiredHeader = initial.res.headers.get("payment-required");
let decoded;
let usedHeader;
try {
  if (paymentRequiredHeader) {
    decoded = b64decodeJson(paymentRequiredHeader);
    usedHeader = true;
    console.log("Payment requirements: from `payment-required` response header (v2).");
  } else {
    decoded = JSON.parse(initial.text);
    usedHeader = false;
    console.log("Payment requirements: from response body (v1 fallback, no header present).");
  }
} catch {
  refuse("the 402 has neither a readable payment-required header nor a JSON body");
}

const x402Version = decoded.x402Version ?? (usedHeader ? 2 : 1);
const accepts = decoded.accepts ?? [];
console.log(`\nx402Version: ${x402Version}. ${accepts.length} accept(s) offered:`);
for (const a of accepts) {
  console.log(`  - ${oneLine(`scheme=${a?.scheme} network=${a?.network} amount=${a?.amount ?? a?.maxAmountRequired} asset=${a?.asset} payTo=${a?.payTo}`, 500)}`);
}

// --- 3. prechecks: before any key is opened or anything is signed ---------------------------------
const requirement = selectRequirement(accepts);
const check = checkOffer(requirement, { maxBase, payTo: payToFlag });
if (!check.ok) {
  updateOp(opId, {
    rail: "solana", kind: "buy", state: "refused_precheck", url, method, reasons: check.reasons,
    amount: check.amountBase?.toString() ?? null, payTo: requirement?.payTo ?? null, token: requirement?.asset ?? null,
    createdAt: readOp(opId)?.createdAt ?? new Date().toISOString(),
  });
  refuse(check.reasons);
}
const amountBase = check.amountBase;
const payToPk = check.payTo;
const feePayerStr = requirement.extra?.feePayer;
const amountUi = formatUnits(amountBase);
console.log(`\nSelected offer: ${amountUi} USDC (${amountBase} base units) to ${payToPk.toBase58()}`);
console.log(`Mint: ${USDC_MINT.toBase58()} (${USDC_DECIMALS} decimals)`);
console.log(`Facilitator-sponsored fee payer: ${feePayerStr ? oneLine(feePayerStr, 100) : "(none offered, agent pays its own fee)"}`);
console.log(`Prechecks passed: price <= ${maxBase === null ? "(no --max, --check only)" : formatUnits(maxBase) + " USDC"}, devnet USDC, 6 decimals${payToFlag ? ", recipient matches --pay-to" : ""}.`);

if (checkOnly) {
  console.log("\n--check: stopping before opening any key or signing anything.");
  result = { ...result, next: `node budget/solana/buy.mjs --url ${url} --max ${amountUi}` };
  finish("quoted", EXIT.OK, { price: amountUi, payTo: payToPk.toBase58(), offer: { network: "solana-devnet", feePayer: !!feePayerStr } });
}

// --- 4. the agent key, chain reads, intent journal ------------------------------------------------
const conn = connection();
const agentInfo = loadAgent();
const agent = agentInfo.keypair;
const pub = readPublic();
const ownerPk = ownerFlag ?? pub.owner ?? agentInfo.owner;
if (!ownerPk) {
  updateOp(opId, { state: "refused_precheck", reasons: ["owner address unknown"] });
  refuse("owner address unknown: pass --owner or run superstables budget setup --rail solana");
}
console.log(`Owner (source of funds): ${ownerPk.toBase58()}`);
console.log(`Agent (delegate authority, signs the payment): ${agent.publicKey.toBase58()}`);

const mintInfo = await retryRead(() => getMint(conn, USDC_MINT));
if (mintInfo.decimals !== USDC_DECIMALS) {
  updateOp(opId, { state: "refused_precheck", reasons: [`mint decimals on chain ${mintInfo.decimals}`] });
  refuse(`the USDC mint reports ${mintInfo.decimals} decimals on chain, not ${USDC_DECIMALS}`);
}

const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, ownerPk);
const sellerAta = getAssociatedTokenAddressSync(USDC_MINT, payToPk);
let ownerAtaBefore;
try {
  ownerAtaBefore = await retryRead(() => getAccount(conn, ownerAta));
} catch (e) {
  if (!(e instanceof TokenAccountNotFoundError)) {
    const why = `could not read the owner's USDC account ${ownerAta.toBase58()}: ${e?.message ?? e}`;
    updateOp(opId, { state: "refused_precheck", reasons: [why] });
    refuse(why, { next: "retry later; nothing was signed or paid" });
  }
  ownerAtaBefore = null;
}
console.log(
  `\nOwner ATA before: delegate=${ownerAtaBefore?.delegate?.toBase58() ?? "none"} ` +
    `remaining=${ownerAtaBefore ? formatUnits(ownerAtaBefore.delegatedAmount) : 0} USDC`
);
// The budget itself, before anything is signed: the Token program would refuse this transfer, but
// a signed transfer handed to the seller could still land if the owner re-granted the same agent
// before its blockhash expired.
const delegation = checkDelegation(ownerAtaBefore, { agent: agent.publicKey, amountBase });
if (!delegation.ok) {
  const remainingNow = ownerAtaBefore?.delegate?.equals(agent.publicKey) ? formatUnits(ownerAtaBefore.delegatedAmount) : "0";
  updateOp(opId, {
    rail: "solana", kind: "buy", state: "refused_precheck", url, method, reasons: delegation.reasons,
    amount: amountBase.toString(), payTo: payToPk.toBase58(), token: USDC_MINT.toBase58(),
    owner: ownerPk.toBase58(), agent: agent.publicKey.toBase58(), remaining: remainingNow,
    createdAt: readOp(opId)?.createdAt ?? new Date().toISOString(),
  });
  refuse(delegation.reasons, { remaining: remainingNow, next: "the owner must grant a budget to this agent that covers the price; nothing was signed or paid" });
}
console.log(`Budget precheck passed: the agent is the delegate and ${formatUnits(ownerAtaBefore.delegatedAmount)} USDC >= price ${amountUi} USDC.`);
const sellerAtaBefore = await retryRead(() => getAccount(conn, sellerAta)).catch(() => null);
console.log(
  `Seller ATA (${sellerAta.toBase58()}) before: ` +
    (sellerAtaBefore ? `exists, balance=${formatUnits(sellerAtaBefore.amount)} USDC` : "does not exist")
);

const feePayerPk = feePayerStr ? new PublicKey(feePayerStr) : agent.publicKey;
const identity = opIdentity(opId);
const createdAt = readOp(opId)?.createdAt ?? new Date().toISOString();
updateOp(
  opId,
  {
    rail: "solana", kind: "buy", state: "intent", createdAt, url, method,
    amount: amountBase.toString(), amountUsdc: amountUi, payTo: payToPk.toBase58(), token: USDC_MINT.toBase58(),
    owner: ownerPk.toBase58(), agent: agent.publicKey.toBase58(), ownerAta: ownerAta.toBase58(), sellerAta: sellerAta.toBase58(),
    feePayer: feePayerPk.toBase58(), computeUnitPrice: identity.microLamports, memo: identity.memo,
    agentSig: null, tx: null, delivered: null, reasons: undefined,
  },
  "prechecks passed"
);

// --- 5. build and sign ---------------------------------------------------------------------------
const instructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: identity.microLamports }),
];
if (!sellerAtaBefore) {
  if (feePayerPk.equals(agent.publicKey)) {
    instructions.push(createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, sellerAta, payToPk, USDC_MINT));
    console.log("Seller ATA missing: agent will create it (agent is also the fee payer here).");
  } else {
    console.log("Seller ATA missing and the fee payer is a facilitator key we don't hold: cannot create it. This payment will likely fail for that reason, not for delegate authority.");
  }
}
instructions.push(
  createTransferCheckedInstruction(ownerAta, USDC_MINT, sellerAta, agent.publicKey, amountBase, USDC_DECIMALS)
);
instructions.push(new TransactionInstruction({ programId: SOLANA_MEMO_PROGRAM, keys: [], data: Buffer.from(identity.memo, "utf8") }));

const { blockhash, lastValidBlockHeight } = await retryRead(() => conn.getLatestBlockhash("confirmed"));
const message = new TransactionMessage({ payerKey: feePayerPk, recentBlockhash: blockhash, instructions }).compileToV0Message();
const tx = new VersionedTransaction(message);
tx.sign([agent]); // partial when the fee payer is a facilitator key: it adds its signature at /settle
const agentSig = bs58.encode(tx.signatures[message.staticAccountKeys.findIndex((k) => k.equals(agent.publicKey))]);
const base64Tx = Buffer.from(tx.serialize()).toString("base64");

// The intent is on disk with the signature BEFORE the payment leaves this process.
let rec = updateOp(
  opId,
  { state: "submitted", agentSig, blockhash, lastValidBlockHeight, submittedAt: new Date().toISOString(), tx: feePayerPk.equals(agent.publicKey) ? agentSig : null },
  "signed; sending the payment to the seller"
);
console.log(`Agent signature (our transaction's id in the journal): ${agentSig}`);

// --- 6. send the payment ------------------------------------------------------------------------
let paymentHeaderName, paymentHeaderValue;
if (x402Version === 2) {
  paymentHeaderValue = b64encode({
    x402Version: 2,
    resource: decoded.resource ?? { url },
    accepted: requirement,
    payload: { transaction: base64Tx },
    ...(decoded.extensions !== undefined ? { extensions: decoded.extensions } : {}),
  });
  paymentHeaderName = "PAYMENT-SIGNATURE";
} else {
  paymentHeaderValue = b64encode({ x402Version: 1, scheme: requirement.scheme, network: requirement.network, payload: { transaction: base64Tx } });
  paymentHeaderName = "X-PAYMENT";
}

console.log(`\nSending payment via ${paymentHeaderName} header (payload ${paymentHeaderValue.length} bytes, base64)...`);
let paid = null;
let paidError = null;
try {
  paid = await fetchOnce(url, method, bodyText, { [paymentHeaderName]: paymentHeaderValue }, 90_000);
  console.log(`Paid request: HTTP ${paid.res.status}`);
} catch (e) {
  paidError = oneLine(e?.message ?? e);
  console.log(`Paid request did not complete: ${paidError} (outcome uncertain; reading the chain, never resending)`);
}

let settlementSig = null;
let responseNote = null;
if (paid) {
  for (const hname of ["payment-response", "x-payment-response"]) {
    const h = paid.res.headers.get(hname);
    if (h) {
      try {
        const settleInfo = b64decodeJson(h);
        console.log(`${hname} header: ${oneLine(JSON.stringify(settleInfo), 1000)}`);
        settlementSig = settleInfo.transaction ?? settleInfo.signature ?? settlementSig;
        responseNote = settleInfo.errorReason ?? settleInfo.error ?? responseNote;
      } catch {
        console.log(`${hname} header (undecoded): ${oneLine(h, 1000)}`);
      }
    }
  }
  console.log("\nResponse body (one-line preview):");
  console.log(oneLine(paid.text, 800));
  // what was bought, saved next to the journal for the caller to read as seller data
  if (paid.res.status !== 402) {
    const saved = saveResponse(OPS_DIR, opId, paid.capped, paid.res.headers.get("content-type"));
    if (saved) result = { ...result, ...saved };
  }
}
const httpStatus = paid?.res.status ?? null;
const deliveredHttp = paid ? paid.res.status >= 200 && paid.res.status < 300 : null;
// The seller's settlement id is a claim, kept apart from our own tx: findOwnTx accepts it only if that
// transaction carries the agent's signature for this operation.
rec = updateOp(opId, { httpStatus, delivered: deliveredHttp, sellerTx: settlementSig ?? undefined, sellerNote: responseNote ?? undefined }, "seller answered");

// --- 7. read the chain: our own transaction decides, not the seller's response -------------------
console.log("\nVerifying against chain (our own transaction, found by the agent signature)...");
let own = null;
let readError = null; // the last chain read failed: nothing below may claim "not on chain"
const attempts = deliveredHttp ? 10 : 3;
for (let i = 0; i < attempts && !own; i++) {
  try {
    own = await findOwnTx(conn, rec);
    readError = null;
  } catch (e) {
    readError = e?.message ?? String(e);
    console.log(`chain read failed (${String(readError).slice(0, 160)}); trying again`);
  }
  if (!own) await sleep(3000);
}

const ownerAtaAfter = await retryRead(() => getAccount(conn, ownerAta)).catch(() => null);
const sellerAtaAfter = await retryRead(() => getAccount(conn, sellerAta)).catch(() => null);
const remaining = ownerAtaAfter ? formatUnits(ownerAtaAfter.delegatedAmount) : null;
console.log(`Owner ATA after: remaining=${remaining ?? "?"} USDC`);
console.log(`Seller ATA after: balance=${sellerAtaAfter ? formatUnits(sellerAtaAfter.amount) : 0} USDC (was ${sellerAtaBefore ? formatUnits(sellerAtaBefore.amount) : 0}; other buyers may also pay this seller)`);
console.log(`Seller ATA: ${explorerAddr(sellerAta.toBase58())}`);

result = { ...result, remaining, delivered: deliveredHttp };

if (own && !own.err) {
  const movement = await readTransfer(conn, own.sig);
  updateOp(opId, { state: "settled", tx: own.sig, debit: amountUi, delivered: deliveredHttp, movement }, "own transaction succeeded");
  console.log(`\n=> Our transfer LANDED: ${explorerTx(own.sig)}`);
  console.log(`   ${deliveredHttp ? "Delivered (seller answered 2xx)." : `NOT delivered (seller answered ${httpStatus ?? paidError}). The payment is settled; do not pay again, ask the seller to honour tx ${own.sig}.`}`);
  result = { ...result, tx: own.sig, debit: amountUi, next: deliveredHttp ? "none" : `settled but not delivered: do not pay again; contact the seller with tx ${own.sig}` };
  finish("settled", EXIT.OK);
}
if (own && own.err) {
  updateOp(opId, { state: "failed", tx: own.sig, error: own.err, delivered: false }, "own transaction failed on chain");
  console.log(`\n=> Our transfer FAILED on chain: ${JSON.stringify(own.err)}  ${explorerTx(own.sig)}`);
  finish("failed", EXIT.FAILED, { tx: own.sig, delivered: false, next: "nothing moved; fix the cause, then buy again with a new --op" });
}

// Not found. If the seller did not accept the payment, ask a node what happens if our transaction
// were submitted now (read-only simulation). A program error means the chain refuses it.
let sim = null;
if (!deliveredHttp && !readError) {
  sim = await conn
    .simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
    .catch((e) => ({ value: { err: `simulation unavailable: ${e?.message ?? e}`, logs: [] } }));
}
if (sim?.value?.err && !String(sim.value.err).startsWith("simulation unavailable")) {
  const failLine = (sim.value.logs ?? []).filter((l) => /failed|error|insufficient/i.test(l)).slice(-1)[0] ?? null;
  console.log(`\n=> The chain refuses this payment now: ${JSON.stringify(sim.value.err)}${failLine ? ` | ${failLine}` : ""}`);
  console.log("   Our transaction was not found on chain.");
  // refused for good only once the signed transaction can no longer land (refusalIsFinal); until then it is unknown
  if (await refusalIsFinal(conn, rec)) {
    updateOp(opId, { state: "refused_chain", chainError: sim.value.err, chainLog: failLine, delivered: false }, "chain refuses the transaction (simulation), and its blockhash has expired");
    finish("refused_chain", EXIT.FAILED, { delivered: false, chainError: sim.value.err, next: `run reconcile before reusing this --op: node budget/solana/reconcile.mjs --op ${opId}` });
  }
  updateOp(opId, { state: "unknown", chainError: sim.value.err, chainLog: failLine, delivered: deliveredHttp }, `chain refuses the transaction now (simulation), but it can land until block height ${lastValidBlockHeight}`);
  console.log(`   The seller holds the signed transaction, which stays valid until block height ${lastValidBlockHeight}: a later grant or deposit could still let it land. Outcome unknown. Do not pay again.`);
  finish("unknown", EXIT.UNCERTAIN, { delivered: deliveredHttp, chainError: sim.value.err, reason: `the chain refuses this payment now (simulation), but the signed transaction can land until block height ${lastValidBlockHeight}`, next: `node budget/solana/reconcile.mjs --op ${opId} once the block height is past ${lastValidBlockHeight}` });
}
updateOp(opId, { state: "unknown", delivered: deliveredHttp }, readError ? `could not read the chain: ${readError}` : "own transaction not found yet");
console.log(readError ? `\n=> Could not read the chain (${readError}). Outcome unknown; it may land. Do not pay again.` : "\n=> Our transaction was NOT found on chain yet. Outcome unknown; it may still land. Do not pay again.");
finish("unknown", EXIT.UNCERTAIN, { next: `node budget/solana/reconcile.mjs --op ${opId}`, ...(readError ? { reason: `could not read the chain: ${String(readError).slice(0, 160)}` } : {}) });
