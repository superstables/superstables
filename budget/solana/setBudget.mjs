// setBudget(amount) -- owner signs. Opens only the owner key file (solana-owner.env).
//
// SPL Token Program `ApproveChecked` on the owner's own USDC associated token account, with the agent key
// as delegate. Native total-cap enforcement, any seller. What it does NOT have: no expiry, no period reset
// and no seller list exist on chain for an SPL delegate, so --expiry, --expiry-seconds, --sellers and
// --period are REFUSED (exit 2) instead of being written to a memo nobody enforces. To stop the agent by
// a date, revoke by then (revokeBudget.mjs).
// ApproveChecked OVERWRITES the token account's single delegate slot: any previous delegate (or remaining
// amount) is void the moment this transaction lands. Because that would silently discard a live budget,
// this script refuses while a delegation with a remaining amount, or a different delegate, exists, unless
// --replace is given. The output states the true maximum.
import { Transaction, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { createApproveCheckedInstruction, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import {
  connection,
  loadOwner,
  explorerTx,
  USDC_MINT,
  USDC_DECIMALS,
  formatUnits,
  fromBaseUnits,
  parseStrict,
  parseAmountFlag,
  usageError,
  EXIT,
} from "./lib.mjs";

const USAGE = `Usage: node budget/solana/setBudget.mjs --amount <usdc> [--agent <address>] [--replace]

Give the agent a spending budget: an SPL delegate, a total cap that lasts until spent or revoked.
Owner command. Opens only the owner key file.

  --amount <usdc>          decimal USDC, at most 6 decimals (required)
  --agent <address>        agent to approve (default: the agent address in solana-owner.env)
  --replace                overwrite a live delegation (ApproveChecked replaces the single
                           delegate slot: the previous delegate and its remaining amount are void)
  Not supported, refused with exit 2: --expiry, --expiry-seconds, --sellers, --period.
  The chain has no expiry or seller list for an SPL delegate. Revoke by your deadline.

  -h, --help               show this help`;

const flags = parseStrict(
  process.argv.slice(2),
  { amount: "value", agent: "value", replace: "bool", expiry: "value", "expiry-seconds": "value", sellers: "value", period: "value" },
  { usage: USAGE, required: ["amount"] }
);
const amountBase = parseAmountFlag(flags, "amount", USAGE);
if (amountBase === 0n) usageError("--amount must be greater than zero", USAGE);
const amountUi = formatUnits(amountBase);

for (const f of ["expiry", "expiry-seconds", "sellers", "period"]) {
  if (flags[f] !== undefined) {
    usageError(
      `--${f} is not supported. An SPL delegate has no expiry, period or seller list on chain, ` +
        `and this script will not record one in a memo that nothing enforces. Revoke by your deadline (revokeBudget.mjs).`,
      USAGE
    );
  }
}
let delegateAgentPk = null;
if (flags.agent !== undefined) {
  try {
    delegateAgentPk = new PublicKey(flags.agent);
  } catch {
    usageError("--agent is not a valid address", USAGE);
  }
}

const conn = connection();

const ownerInfo = loadOwner();
const owner = ownerInfo.keypair;
const agentPk = delegateAgentPk ?? ownerInfo.agent;
if (!agentPk) {
  console.error("Agent address unknown: pass --agent <address> or run generate-keys.mjs.");
  process.exit(EXIT.FAILED);
}
const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
const before = await getAccount(conn, ownerAta).catch(() => null);

console.log("SPL Token ApproveChecked (delegate)");
console.log(`Owner: ${owner.publicKey.toBase58()}`);
console.log(`Agent (delegate): ${agentPk.toBase58()}`);
console.log(`Amount: ${amountUi} USDC (${amountBase} base units)`);
console.log(
  `\nOwner ATA before: delegate=${before?.delegate?.toBase58() ?? "none"} ` +
    `delegatedAmount=${before ? fromBaseUnits(before.delegatedAmount) : 0} USDC`
);

const live = before?.delegate && (before.delegatedAmount > 0n || !before.delegate.equals(agentPk));
if (live && !flags.replace) {
  console.error(
    `\nRefused (nothing signed): this token account already has delegate ${before.delegate.toBase58()} ` +
      `with ${formatUnits(before.delegatedAmount)} USDC remaining. ApproveChecked overwrites the single delegate slot, ` +
      `so that delegate and its remaining amount would be void the moment this lands. ` +
      `Run revokeBudget.mjs first, or pass --replace to overwrite it on purpose.`
  );
  process.exit(EXIT.REFUSED);
}
if (live) {
  console.log(
    `\n--replace: this OVERWRITES delegate ${before.delegate.toBase58()} (${formatUnits(before.delegatedAmount)} USDC remaining). ` +
      "Its allowance is void as soon as the transaction lands."
  );
}

const tx = new Transaction();
tx.add(
  createApproveCheckedInstruction(
    ownerAta,
    USDC_MINT,
    agentPk,
    owner.publicKey,
    amountBase,
    USDC_DECIMALS
  )
);

const sig = await sendAndConfirmTransaction(conn, tx, [owner], {
  commitment: "confirmed",
});
console.log(`\nsetBudget (delegate) signature: ${sig}`);
console.log(`Explorer: ${explorerTx(sig)}`);

const after = await getAccount(conn, ownerAta);
console.log(
  `Owner ATA after: delegate=${after.delegate?.toBase58()} ` +
    `delegatedAmount=${fromBaseUnits(after.delegatedAmount)} USDC`
);
const effective = after.delegatedAmount < after.amount ? after.delegatedAmount : after.amount;
console.log(
  `\nTrue maximum: the agent can move at most ${formatUnits(effective)} USDC in total under this budget ` +
    `(approved ${formatUnits(after.delegatedAmount)}, owner balance ${formatUnits(after.amount)}; the Token program never lets a transfer exceed either). ` +
    "It never resets and it does not expire: it lasts until it is spent or you run revokeBudget.mjs. " +
    "Any seller can be paid; no seller list exists on chain."
);
console.log(
  "ApproveChecked overwrites the previous delegate: this token account now has exactly one delegate, the agent above."
);
