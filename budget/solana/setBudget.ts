// setBudget(amount): the owner makes the agent the SPL delegate of the owner's own USDC account, up to `amount` in total.
//
// SPL Token ApproveChecked on the owner's USDC associated token account, delegate = the agent key. Native total-cap enforcement,
// any seller. An SPL delegate has no expiry, no period and no seller list on chain, so --expiry, --expiry-seconds, --sellers and
// --period are refused (exit 2) instead of being written to a memo nobody enforces. To stop the agent by a date, revoke by then.
// ApproveChecked overwrites the account's single delegate slot, so this refuses (exit 3) while a delegate with a remaining
// amount, or another delegate, is set: revoke first.
//
// The owner approves it in their own wallet (owner page, owner.ts): the command builds the transaction when the owner presses
// Approve, the wallet signs, the command checks the signed bytes are its own and sends them, then reads the chain: the
// transaction (no error, signed by the owner) and the token account (owner, mint, delegate = agent, delegated amount = cap).
// With --owner-key-file <path> it signs with that key file instead (tests and automation only).
//
// npx tsx budget/solana/setBudget.ts --amount <usdc> [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 set, 1 failed on chain or never landed, 2 bad flags, 3 refused (live delegate, no USDC account, no SOL for the
// fee, the owner rejected or the link expired, the chain shows another delegate or amount), 5 unknown (read the chain).
import { Transaction, sendAndConfirmTransaction, type PublicKey } from "@solana/web3.js";
import { createApproveCheckedInstruction, getAssociatedTokenAddressSync, getAccount, getAccountOrNull } from "./token.mjs";
import { connection, loadOwner, explorerTx, USDC_MINT, USDC_DECIMALS, formatUnits, parseStrict, parseAmountFlag, usageError, readPublic, retryRead, sleep } from "./lib.mjs";
import { OWNER_KEY_FILE, checkOwnerKeyFile } from "../owner-page.ts";
import { mismatchPage, mismatchReason, siteName } from "../site.mjs";
import { MIN_FEE_LAMPORTS, approvalSite, askSolanaIntent, askSolanaTransaction, closeOwnerPage, confirmHosted, confirmSent, emit, endUnapproved, grantTerms, sol, transactionPort } from "./owner.ts";

const USAGE = `Usage: npx tsx budget/solana/setBudget.ts --amount <usdc> [--timeout <s>] [--no-open] [--owner-key-file <path>]

Give the agent a spending budget: an SPL delegate, a total cap that lasts until spent or revoked.
Owner command: the owner approves it in their own wallet on a page this command opens on 127.0.0.1, or on
superstables.com when the chain was set up with --hosted.

  --amount <usdc>          decimal USDC, at most 6 decimals (required)
  --timeout <s>            how long the approval link stays open (default 600)
  --no-open                do not open the approval link in the default browser
  --owner-key-file <path>  tests and automation only: sign with this owner key file (mode 600)
  Not supported, refused with exit 2: --expiry, --expiry-seconds, --sellers, --period.
  The chain has no expiry or seller list for an SPL delegate. Revoke by your deadline.

  -h, --help               show this help`;

const flags = parseStrict(
  process.argv.slice(2),
  { amount: "value", timeout: "value", "no-open": "bool", "owner-key-file": "value", expiry: "value", "expiry-seconds": "value", sellers: "value", period: "value" },
  { usage: USAGE, required: ["amount"] },
);
for (const f of ["expiry", "expiry-seconds", "sellers", "period"]) {
  if (flags[f] !== undefined) usageError(`--${f} is not supported. An SPL delegate has no expiry, period or seller list on chain, and this script will not record one in a memo that nothing enforces. Revoke by your deadline.`, USAGE);
}
const cap: bigint = parseAmountFlag(flags, "amount", USAGE);
if (cap === 0n) usageError("--amount must be greater than zero", USAGE);

const result = (exit: number, o: Record<string, unknown>) => emit("setBudget", exit, o);
function refuse(reason: string, next: string, extra: Record<string, unknown> = {}): never {
  console.log(`REFUSED: ${reason}. Nothing was sent.`);
  process.exit(result(3, { state: "refused_precheck", reason, next, ...extra }));
}

const conn = connection();
const pub = readPublic();
if (!pub.owner || !pub.agent) refuse("the public file names no owner or no agent", "superstables budget setup --rail solana");
const owner: PublicKey = pub.owner;
const agent: PublicKey = pub.agent;
const ata = getAssociatedTokenAddressSync(USDC_MINT, owner);
const before = await retryRead(() => getAccountOrNull(conn, ata)).catch((err) =>
  refuse(`could not read the owner's USDC account ${ata.toBase58()} (${String(err?.message ?? err).slice(0, 160)})`, "check the devnet RPC (superstables budget doctor --rail solana), then grant again"),
);
if (!before) refuse(`the owner ${owner.toBase58()} has no devnet USDC account yet`, "get devnet USDC from faucet.circle.com (Solana devnet), then grant again");
if (before.amount === 0n) refuse(`the owner's USDC account ${ata.toBase58()} holds no USDC`, "get devnet USDC from faucet.circle.com (Solana devnet), then grant again");
console.log(`Owner ${owner.toBase58()} (USDC account ${ata.toBase58()}, ${formatUnits(before.amount)} USDC), agent ${agent.toBase58()}`);
console.log(`Before: delegate=${before.delegate?.toBase58() ?? "none"} delegatedAmount=${formatUnits(before.delegatedAmount)} USDC`);
if (before.delegate && (before.delegatedAmount > 0n || !before.delegate.equals(agent))) {
  refuse(
    `the owner's USDC account already has delegate ${before.delegate.toBase58()} with ${formatUnits(before.delegatedAmount)} USDC left. ApproveChecked overwrites the single delegate slot, so that would void it`,
    "revoke first (superstables budget revoke --rail solana), then grant again",
  );
}
const lamports = BigInt(await retryRead(() => conn.getBalance(owner, "confirmed")));
if (lamports < MIN_FEE_LAMPORTS) refuse(`the owner holds ${sol(lamports)} SOL, too little for the network fee`, "get devnet SOL (faucet.solana.com), then grant again");
console.log(`ApproveChecked: delegate ${agent.toBase58()}, ${formatUnits(cap)} USDC (${cap} base units). The chain enforces the total cap only.`);

const ix = () => [createApproveCheckedInstruction(ata, USDC_MINT, agent, owner, cap, USDC_DECIMALS)];
let sig: string;
let finish: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null;
if (OWNER_KEY_FILE) {
  checkOwnerKeyFile(OWNER_KEY_FILE);
  const kp = loadOwner(OWNER_KEY_FILE).keypair;
  if (!kp.publicKey.equals(owner)) refuse(`the key in ${OWNER_KEY_FILE} is for ${kp.publicKey.toBase58()}, not the recorded owner`, "pass the owner key file of the recorded owner");
  sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ix()), [kp], { commitment: "confirmed" });
  console.log(`signature: ${sig}`);
} else {
  // hosted: the site builds the ApproveChecked when the owner is ready and sends what their wallet signed; on this computer,
  // the page does, through the port. Either way the command reads the signature from the chain.
  const hosted = approvalSite() !== null;
  const startSlot = hosted ? await retryRead(() => conn.getSlot("confirmed")) : 0;
  const terms = grantTerms({ owner: owner.toBase58(), agent: agent.toBase58(), ata: ata.toBase58(), cap, held: before.amount });
  const local = hosted ? null : transactionPort(conn, owner, ix);
  const { handle, outcome } = local
    ? await askSolanaTransaction("grant", owner.toBase58(), local.port, terms)
    : await askSolanaIntent("grant", owner.toBase58(), { amount_atomic: String(cap) }, terms);
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setBudget", outcome, { requested: formatUnits(cap) });
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  finish = handle.finish;
  sig = local ? local.sent()!.signature : outcome.hash;
  console.log(`${local ? "sent" : `${siteName(approvalSite()!)} reports`} ${sig}; reading it from the chain`);
  const c = local ? { ...(await confirmSent(conn, local.sent()!)), problems: [] as string[] } : await confirmHosted(conn, sig, owner.toBase58(), startSlot, ix(), outcome.siteFailed);
  console.log(`transaction: ${c.status}${c.slot ? `, slot ${c.slot}` : ""}${c.signer ? `, signer ${c.signer}` : ""}`);
  if (c.status === "unknown") {
    handle.finish({ ok: false, message: "The transaction did not show up on chain yet. The command reports it as unknown.", hash: sig });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: sig, reason: "the transaction was sent but the chain does not show it yet", next: "superstables budget status --rail solana: read the delegate before granting again" }));
  }
  if (c.status !== "success") {
    const why = c.status === "expired" ? "it was sent but never landed before its blockhash expired; nothing changed" : `it failed on chain (${JSON.stringify(c.err)}); nothing changed`;
    handle.finish({ ok: false, message: `The transaction ${c.status === "expired" ? "never landed" : "failed on chain"}. The grant is not confirmed. A failed on-chain transaction may still charge a fee.`, hash: sig });
    await closeOwnerPage();
    process.exit(result(1, { state: "failed", tx: sig, reason: why, next: "superstables budget status --rail solana" }));
  }
  if (c.problems.length) {
    const reason = mismatchReason(c.problems, c.siteFailed, sig);
    console.log(`MISMATCH: ${reason}`);
    handle.finish({ ok: false, message: `${mismatchPage(c.problems, c.siteFailed, sig)} Revoke it: superstables budget revoke --rail solana.`, hash: sig });
    await closeOwnerPage();
    process.exit(result(3, { state: "mismatch", tx: sig, reason, next: "revoke (superstables budget revoke --rail solana), then grant again" }));
  }
  if (c.signer !== owner.toBase58()) console.log(`note: signer 0 is ${c.signer}, not the owner`);
}

// Read the token account back: it must be exactly the plan.
let after = await retryRead(() => getAccount(conn, ata));
const problems = () => [
  !after.owner.equals(owner) && `the account's owner is ${after.owner.toBase58()}`,
  !after.mint.equals(USDC_MINT) && `the account's mint is ${after.mint.toBase58()}`,
  !after.delegate?.equals(agent) && `the delegate is ${after.delegate?.toBase58() ?? "none"}, not the agent`,
  after.delegatedAmount !== cap && `the delegated amount is ${formatUnits(after.delegatedAmount)} USDC, not ${formatUnits(cap)}`,
].filter(Boolean) as string[];
for (let i = 0; i < 8 && problems().length; i++) {
  await sleep(2000);
  after = await retryRead(() => getAccount(conn, ata));
}
console.log(`After: owner=${after.owner.toBase58()} mint=${after.mint.toBase58()} delegate=${after.delegate?.toBase58() ?? "none"} delegatedAmount=${formatUnits(after.delegatedAmount)} USDC`);
console.log(`explorer: ${explorerTx(sig)}`);
if (problems().length) {
  const reason = `the chain does not show the planned budget: ${problems().join("; ")}`;
  console.log(`REFUSED: ${reason}`);
  finish?.({ ok: false, message: `The chain shows something other than planned (${problems().join("; ")}). Revoke it: superstables budget revoke --rail solana.`, hash: sig });
  await closeOwnerPage();
  process.exit(result(3, { state: "mismatch", tx: sig, reason, next: "revoke (superstables budget revoke --rail solana), then grant again" }));
}
const most = after.delegatedAmount < after.amount ? after.delegatedAmount : after.amount;
console.log(`True maximum: ${formatUnits(most)} USDC in total (the smaller of the cap and the owner's balance ${formatUnits(after.amount)}). No expiry, no seller list: it lasts until spent or revoked.`);
finish?.({ ok: true, message: `Done. The chain shows a budget of ${formatUnits(cap)} USDC for your agent. You can close this page. To end it: superstables budget revoke --rail solana. You approve that in your wallet too.`, hash: sig });
await closeOwnerPage();
process.exit(result(0, { state: "set", tx: sig, cap: formatUnits(cap), remaining: formatUnits(after.delegatedAmount), maxMovable: formatUnits(most), enforcedOnChain: { expiry: false, period: false, sellers: false }, next: "agent: buy" }));
