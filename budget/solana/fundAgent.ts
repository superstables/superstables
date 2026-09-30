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
// expired), 5 unknown (read the chain).
import { SystemProgram, Transaction, sendAndConfirmTransaction, type PublicKey } from "@solana/web3.js";
import { connection, loadOwner, explorerTx, parseUnits, parseStrict, usageError, readPublic, retryRead, sleep } from "./lib.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { MIN_FEE_LAMPORTS, askSolanaTransaction, closeOwnerPage, confirmSent, emit, endUnapproved, fundTerms, sol, transactionPort } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/fundAgent.ts [--amount <sol>] [--timeout <s>] [--no-open] [--owner-key-file <path>]

Owner command. Sends the agent SOL for transaction fees (default 0.01, at most 1). Devnet only.
The owner approves it in their own wallet on a page this command opens on 127.0.0.1.

  --amount <sol>           SOL to send, at most 9 decimals
  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the link in the default browser
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
const pub = readPublic();
if (!pub.owner || !pub.agent) refuse("the public file names no owner or no agent", "superstables budget setup --rail solana");
const owner: PublicKey = pub.owner;
const agent: PublicKey = pub.agent;
const ownerHas = BigInt(await retryRead(() => conn.getBalance(owner, "confirmed")));
const agentHas = BigInt(await retryRead(() => conn.getBalance(agent, "confirmed")));
console.log(`owner ${owner.toBase58()} ${sol(ownerHas)} SOL, agent ${agent.toBase58()} ${sol(agentHas)} SOL`);
if (ownerHas < amount + MIN_FEE_LAMPORTS) refuse(`the owner holds ${sol(ownerHas)} SOL, less than ${sol(amount)} plus the fee`, "get devnet SOL (faucet.solana.com), then fund the agent again");

const ix = () => [SystemProgram.transfer({ fromPubkey: owner, toPubkey: agent, lamports: amount })];
let sig: string;
let finish: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null;
let delta: bigint | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  const kp = loadOwner(OWNER_KEY_FILE).keypair;
  if (!kp.publicKey.equals(owner)) refuse(`the key in ${OWNER_KEY_FILE} is for ${kp.publicKey.toBase58()}, not the recorded owner`, "pass the owner key file of the recorded owner");
  sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ix()), [kp], { commitment: "confirmed" });
  console.log(`signature: ${sig}`);
} else {
  const { port, sent } = transactionPort(conn, owner, ix);
  const { handle, outcome } = await askSolanaTransaction("fund-agent", owner.toBase58(), port, fundTerms({ owner: owner.toBase58(), agent: agent.toBase58(), lamports: amount, agentHas }));
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("fundAgent", outcome);
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  finish = handle.finish;
  const s = sent()!;
  sig = s.signature;
  console.log(`sent ${sig}; reading it from the chain`);
  const c = await confirmSent(conn, s);
  console.log(`transaction: ${c.status}${c.slot ? `, slot ${c.slot}` : ""}${c.signer ? `, signer ${c.signer}` : ""}`);
  if (c.status === "unknown") {
    handle.finish({ ok: false, message: "The transaction did not show up on chain yet. The command reports it as unknown.", hash: sig });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: sig, reason: "the transaction was sent but the chain does not show it yet", next: "superstables budget doctor --rail solana: read the agent's SOL" }));
  }
  if (c.status !== "success") {
    handle.finish({ ok: false, message: `The transaction ${c.status === "expired" ? "never landed" : "failed on chain"}. The transfer is not confirmed. Check the command result and wallet activity before retrying.`, hash: sig });
    await closeOwnerPage();
    process.exit(result(1, { state: "failed", tx: sig, reason: c.status === "expired" ? "it was sent but never landed before its blockhash expired" : `it failed on chain (${JSON.stringify(c.err)})`, next: "superstables budget doctor --rail solana" }));
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
if ((delta !== null && delta !== amount) || after < agentHas + amount) {
  const why = delta !== null && delta !== amount ? `the transaction moved ${sol(delta)} SOL to the agent, not ${sol(amount)}` : "the agent's balance did not go up by the amount";
  finish?.({ ok: false, message: `The chain shows something other than planned: ${why}.`, hash: sig });
  await closeOwnerPage();
  process.exit(result(1, { state: "failed", tx: sig, reason: why, next: "superstables budget doctor --rail solana" }));
}
finish?.({ ok: true, message: `Done. Your agent received ${sol(amount)} SOL. You can close this page.`, hash: sig });
await closeOwnerPage();
process.exit(result(0, { state: "ok", tx: sig, sent: sol(amount), agentBefore: sol(agentHas), agentAfter: sol(after), next: "none" }));
