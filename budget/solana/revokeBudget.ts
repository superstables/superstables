// revokeBudget(): the owner clears the delegate of their USDC account. This is the kill switch.
//
// SPL Token Revoke: clears the token account's delegate and zeroes delegatedAmount. From the slot it lands in, the very next
// instruction that uses the old delegate authority fails (Token program OwnerMismatch), whether it was signed before or after,
// and even with a stolen agent key.
//
// The owner approves it in their own wallet (owner page, owner.ts): the command builds the transaction when the owner presses
// Approve, the wallet signs, the command checks the signed bytes are its own and sends them, then reads the chain: the
// transaction (no error, signed by the owner) and the token account (no delegate, delegated amount 0). With --owner-key-file
// <path> it signs with that key file instead (tests and automation only).
//
// npx tsx budget/solana/revokeBudget.ts [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 revoked (or nothing to revoke), 1 failed on chain, never landed, or a delegate still reads, 3 refused (the
// owner rejected or the link expired, no SOL for the fee), 5 unknown (read the chain).
import { Transaction, sendAndConfirmTransaction, type PublicKey } from "@solana/web3.js";
import { createRevokeInstruction, getAssociatedTokenAddressSync, getAccount } from "./token.mjs";
import { connection, loadOwner, explorerTx, USDC_MINT, formatUnits, parseStrict, readPublic, retryRead, sleep } from "./lib.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { MIN_FEE_LAMPORTS, askSolanaTransaction, closeOwnerPage, confirmSent, emit, endUnapproved, revokeTerms, sol, transactionPort } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/revokeBudget.ts [--timeout <s>] [--no-open] [--owner-key-file <path>]

Revoke the agent's budget. Owner command; this is the kill switch under a stolen agent key.
The owner approves it in their own wallet on a page this command opens on 127.0.0.1.

  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the link in the default browser
  --owner-key-file <path>  tests and automation only: sign with this owner key file (mode 600)
  -h, --help               show this help`;

parseStrict(process.argv.slice(2), { timeout: "value", "no-open": "bool", "owner-key-file": "value" }, { usage: USAGE });
const result = (exit: number, o: Record<string, unknown>) => emit("revokeBudget", exit, o);
function refuse(reason: string, next: string): never {
  console.log(`REFUSED: ${reason}. Nothing was sent.`);
  process.exit(result(3, { state: "refused_precheck", reason, next }));
}

const conn = connection();
const pub = readPublic();
if (!pub.owner) refuse("the public file names no owner", "superstables budget setup --rail solana");
const owner: PublicKey = pub.owner;
const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
const before = await retryRead(() => getAccount(conn, ata)).catch(() => null);
console.log(`Before: delegate=${before?.delegate?.toBase58() ?? "none"} remaining=${before ? formatUnits(before.delegatedAmount) : "0"} USDC`);
if (!before || !before.delegate) {
  console.log("There is no delegate on the owner's USDC account: nothing to revoke. Nothing was sent.");
  process.exit(result(0, { state: "revoked", tx: null, remaining: "0", reason: "no delegate is set; nothing to send", next: "none" }));
}
const lamports = BigInt(await retryRead(() => conn.getBalance(owner, "confirmed")));
if (lamports < MIN_FEE_LAMPORTS) refuse(`the owner holds ${sol(lamports)} SOL, too little for the network fee`, "get devnet SOL (faucet.solana.com), then revoke again");

const ix = () => [createRevokeInstruction(ata, owner)];
let sig: string;
let finish: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  const kp = loadOwner(OWNER_KEY_FILE).keypair;
  if (!kp.publicKey.equals(owner)) refuse(`the key in ${OWNER_KEY_FILE} is for ${kp.publicKey.toBase58()}, not the recorded owner`, "pass the owner key file of the recorded owner");
  sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ix()), [kp], { commitment: "confirmed" });
  console.log(`signature: ${sig}`);
} else {
  const { port, sent } = transactionPort(conn, owner, ix);
  const { handle, outcome } = await askSolanaTransaction("revoke", owner.toBase58(), port, revokeTerms({ owner: owner.toBase58(), agent: before.delegate.toBase58(), ata: ata.toBase58(), remaining: before.delegatedAmount }));
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("revokeBudget", outcome, { remaining: formatUnits(before.delegatedAmount) });
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
    process.exit(result(5, { state: "unknown", tx: sig, reason: "the transaction was sent but the chain does not show it yet", next: "superstables budget status --rail solana" }));
  }
  if (c.status !== "success") {
    handle.finish({ ok: false, message: `The transaction ${c.status === "expired" ? "never landed" : "failed on chain"}. The budget is still live: run the revoke again.`, hash: sig });
    await closeOwnerPage();
    process.exit(result(1, { state: "not_revoked", tx: sig, reason: c.status === "expired" ? "it was sent but never landed before its blockhash expired" : `it failed on chain (${JSON.stringify(c.err)})`, next: "run revoke again" }));
  }
}

let after = await retryRead(() => getAccount(conn, ata));
for (let i = 0; i < 8 && (after.delegate || after.delegatedAmount !== 0n); i++) {
  await sleep(2000);
  after = await retryRead(() => getAccount(conn, ata));
}
console.log(`After: delegate=${after.delegate?.toBase58() ?? "none"} remaining=${formatUnits(after.delegatedAmount)} USDC`);
console.log(`explorer: ${explorerTx(sig)}`);
if (after.delegate || after.delegatedAmount !== 0n) {
  finish?.({ ok: false, message: `The chain still shows delegate ${after.delegate?.toBase58() ?? "none"} with ${formatUnits(after.delegatedAmount)} USDC. Run the revoke again.`, hash: sig });
  await closeOwnerPage();
  process.exit(result(1, { state: "not_revoked", tx: sig, remaining: formatUnits(after.delegatedAmount), reason: "a delegate still reads on chain", next: "run revoke again" }));
}
console.log("Exposure left: none. A payment signed earlier and submitted now is refused by the Token program.");
finish?.({ ok: true, message: "Done. The chain shows no delegate on your USDC account: your agent can move nothing more. You can close this page.", hash: sig });
await closeOwnerPage();
process.exit(result(0, { state: "revoked", tx: sig, remaining: "0", next: "none" }));
