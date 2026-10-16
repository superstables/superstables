// fundAgent: the owner sends the agent SOL for transaction fees (a seller's facilitator pays most fees; when it does not, the
// agent does). One plain SystemProgram transfer, at most 1 SOL, default 0.01.
//
// The owner approves it in their own wallet (owner page, owner.ts): the command builds the transfer when the owner presses
// Approve, the wallet signs, the command checks the signed bytes are its own and sends them, then reads the chain: no error,
// signed by the owner, and the agent's balance went up by exactly the amount in that transaction. With --owner-key-file <path>
// it signs with that key file instead (tests and automation only).
//
// npx tsx budget/solana/fundAgent.ts [--amount <sol>] [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 sent, 1 failed on chain or never landed, 2 bad flags, 3 refused (too little SOL, the owner rejected or the link
// expired) or a mismatch (the transaction moved another amount), 5 unknown (read the chain).
import { SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CLUSTER_NEXT, clusterProblem, connection, loadOwner, oneLine, explorerTx, parseUnits, parseStrict, usageError, ownerPlanCtx, retryRead, sleep } from "./lib.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { differsFromRequest, mismatchPage, mismatchReason, siteName } from "../site.mjs";
import { MIN_FEE_LAMPORTS, approvalSite, askSolanaIntent, askSolanaTransaction, closeOwnerPage, confirmHosted, confirmSent, emit, endUnapproved, fundTerms, sol, transactionPort } from "./owner.ts";
import type { OwnerVerdict } from "../../src/core/signer/owner-approval-server.ts";

const USAGE = `Usage: npx tsx budget/solana/fundAgent.ts [--amount <sol>] [--timeout <s>] [--no-open] [--owner-key-file <path>]

Owner command. Sends the agent SOL for transaction fees (default 0.01, at most 1). Devnet only.
The owner approves it in their own wallet on a page this command opens on 127.0.0.1, or on
superstables.com when the chain was set up with --hosted.

  --amount <sol>           SOL to send, at most 9 decimals
  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the approval link in the default browser
  --owner-key-file <path>  tests and automation only: sign with this owner key file (mode 600)
  -h, --help               show this help`;

const flags = parseStrict(process.argv.slice(2), { amount: "value", timeout: "value", "no-open": "bool", "owner-key-file": "value" }, { usage: USAGE });
let lamportsToSend: bigint;
try {
  lamportsToSend = parseUnits(flags.amount ?? "0.01", 9);
} catch (e) {
  usageError(`--amount: ${(e as Error).message}`, USAGE);
}
if (lamportsToSend! === 0n || lamportsToSend! > 1_000_000_000n) usageError("--amount must be above 0 and at most 1 SOL", USAGE);
const amount = lamportsToSend!;

const result = (exit: number, o: Record<string, unknown>) => emit("fundAgent", exit, o);
function refuse(reason: string, next: string): never {
  console.log(`REFUSED: ${reason}. Nothing was sent.`);
  process.exit(result(3, { state: "refused_precheck", reason, next }));
}

const conn = connection();
const cluster = await clusterProblem(conn);
if (cluster) refuse(cluster, CLUSTER_NEXT);
const { owner, agent } = await ownerPlanCtx(refuse); // the public addresses, checked against the owner's setup signature
const ownerHas = BigInt(await retryRead(() => conn.getBalance(owner, "confirmed")));
const agentHas = BigInt(await retryRead(() => conn.getBalance(agent, "confirmed")));
console.log(`owner ${owner.toBase58()} ${sol(ownerHas)} SOL, agent ${agent.toBase58()} ${sol(agentHas)} SOL`);
if (ownerHas < amount + MIN_FEE_LAMPORTS) refuse(`the owner holds ${sol(ownerHas)} SOL, less than ${sol(amount)} plus the fee`, "get devnet SOL (faucet.solana.com), then fund the agent again");

const ix = () => [SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports: amount })];
let sig: string;
let finish: ((v: OwnerVerdict) => void) | null = null;
let delta: bigint | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  const kp = loadOwner(OWNER_KEY_FILE).keypair;
  if (!kp.publicKey.equals(owner)) refuse(`the key in ${OWNER_KEY_FILE} is for ${kp.publicKey.toBase58()}, not the recorded owner`, "pass the owner key file of the recorded owner");
  sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ix()), [kp], { commitment: "confirmed" });
  console.log(`signature: ${sig}`);
} else {
  // hosted: the site builds the transfer when the owner is ready and sends what their wallet signed
  const hosted = approvalSite() !== null;
  const startSlot = hosted ? await retryRead(() => conn.getSlot("confirmed")) : 0;
  const terms = fundTerms({ owner: owner.toBase58(), agent: agent.toBase58(), lamports: amount, agentHas });
  const local = hosted ? null : transactionPort(conn, owner, ix);
  const { handle, outcome } = local
    ? await askSolanaTransaction("fund-agent", owner.toBase58(), local.port, terms)
    : await askSolanaIntent("fund-agent", owner.toBase58(), { amount_atomic: String(amount) }, terms);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("fundAgent", outcome);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  finish = handle.finish;
  sig = local ? local.sent()!.signature : outcome.hash;
  console.log(`${local ? "sent" : `${siteName(approvalSite()!)} reports`} ${sig}; reading it from the chain`);
  const c = local ? { ...(await confirmSent(conn, local.sent()!)), problems: [] as string[] } : await confirmHosted(conn, sig, owner.toBase58(), startSlot, ix(), outcome.siteFailed);
  console.log(`transaction: ${c.status}${c.slot ? `, slot ${c.slot}` : ""}${c.signer ? `, signer ${c.signer}` : ""}`);
  if (c.status === "unknown") {
    handle.finish({ outcome: "unknown", message: "The transaction did not show up on chain yet. The command reports it as unknown.", hash: sig });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: sig, reason: "the transaction was sent but the chain does not show it yet", next: "superstables budget doctor --rail solana: read the agent's SOL" }));
  }
  if (c.status !== "success" && !differsFromRequest(c.problems, c.siteFailed)) {
    const proof = c.status === "expired" ? "blockhash_expired" : "reverted";
    handle.finish({ outcome: "failed", proof, message: `The transaction ${c.status === "expired" ? "never landed" : "failed on chain"}. The transfer is not confirmed. Check the command result and wallet activity before retrying.`, hash: sig });
    await closeOwnerPage();
    process.exit(result(1, { state: "failed", proof, tx: sig, reason: c.status === "expired" ? "it was sent but never landed before its blockhash expired" : `it failed on chain (${oneLine(JSON.stringify(c.err), 300)})`, next: "superstables budget doctor --rail solana" }));
  }
  if (c.problems.length) {
    const reason = mismatchReason(c.problems, c.siteFailed, sig);
    console.log(`MISMATCH: ${reason}`);
    handle.finish({ outcome: "unknown", message: mismatchPage(c.problems, c.siteFailed, sig, { what: "transfer", ended: c.status === "failed" ? "failed on chain" : undefined }), hash: sig });
    await closeOwnerPage();
    process.exit(result(3, { state: "mismatch", tx: sig, reason, next: "check the owner's wallet activity, then superstables budget doctor --rail solana" }));
  }
  const i = c.accountKeys!.indexOf(agent.toBase58());
  if (i >= 0) delta = BigInt(c.meta.postBalances[i]) - BigInt(c.meta.preBalances[i]);
}

let after = BigInt(await retryRead(() => conn.getBalance(agent, "confirmed")));
for (let i = 0; i < 8 && after < agentHas + amount; i++) {
  await sleep(2000);
  after = BigInt(await retryRead(() => conn.getBalance(agent, "confirmed")));
}
console.log(`agent ${sol(after)} SOL${delta !== null ? ` (this transaction added ${sol(delta)})` : ""}. explorer: ${explorerTx(sig)}`);
// The transaction's own balance change is the chain's answer: the planned amount is a confirmed transfer, whatever the
// balance reads later (the agent may spend, or the node lag). Only without it does the balance decide, and then a short
// one leaves the transfer unknown.
if (delta !== null && delta !== amount) {
  const why = `the transaction moved ${sol(delta)} SOL to the agent, not ${sol(amount)}`;
  console.log(`MISMATCH: ${why}`);
  finish?.({ outcome: "unknown", message: `The transfer was not confirmed as the planned step: ${why}.`, hash: sig });
  await closeOwnerPage();
  process.exit(result(3, { state: "mismatch", tx: sig, reason: why, next: "check the owner's wallet activity, then superstables budget doctor --rail solana" }));
}
if (delta === null && after < agentHas + amount) {
  const why = `the transaction landed, but the agent's balance reads ${sol(after)} SOL, not at least ${sol(agentHas + amount)} SOL (the node may lag behind, or the agent spent some meanwhile)`;
  console.log(`UNKNOWN: ${why}`);
  finish?.({ outcome: "unknown", message: "The command could not confirm this transfer on chain yet. Check your wallet's activity.", hash: sig });
  await closeOwnerPage();
  process.exit(result(5, { state: "unknown", tx: sig, reason: why, next: "superstables budget doctor --rail solana: read the agent's SOL" }));
}
if (after < agentHas + amount) console.log(`the agent's balance reads ${sol(after)} SOL now, less than ${sol(agentHas + amount)}: it spent some, or the node lags behind; the transaction itself moved ${sol(amount)} SOL`);
finish?.({ outcome: "confirmed", message: `Done. Your agent received ${sol(amount)} SOL. You can close this page.`, hash: sig });
await closeOwnerPage();
process.exit(result(0, { state: "ok", tx: sig, sent: sol(amount), agentBefore: sol(agentHas), agentAfter: sol(after), next: "none" }));
