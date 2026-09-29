// revokeBudget() -- owner signs. This is the kill switch.
//
// SPL Token `Revoke`: clears the token account's delegate and zeroes delegatedAmount. It takes effect
// when the transaction lands: the very next instruction that uses the old delegate authority is checked
// against the *current* on-chain state and fails (Token program 0x4 OwnerMismatch), whether it was signed
// before or after, and even if the agent key was stolen. Exposure after it lands: none. Before it lands:
// up to the delegated amount. Opens only solana-owner.env.
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createRevokeInstruction, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { connection, loadOwner, explorerTx, USDC_MINT, fromBaseUnits, parseStrict } from "./lib.mjs";

const USAGE = `Usage: node budget/solana/revokeBudget.mjs

Revoke the agent's budget. Owner command; this is the kill switch under a stolen agent key.
Opens only the owner key file.

  -h, --help                show this help`;

parseStrict(process.argv.slice(2), {}, { usage: USAGE });

const conn = connection();

const owner = loadOwner().keypair;
const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, owner.publicKey);
const before = await getAccount(conn, ownerAta);
console.log(
  `Before: delegate=${before.delegate?.toBase58() ?? "none"} ` +
    `remaining=${fromBaseUnits(before.delegatedAmount)} USDC`
);

const tx = new Transaction().add(
  createRevokeInstruction(ownerAta, owner.publicKey)
);
const sig = await sendAndConfirmTransaction(conn, tx, [owner], {
  commitment: "confirmed",
});
console.log(`\nrevokeBudget (delegate) signature: ${sig}`);
console.log(`Explorer: ${explorerTx(sig)}`);

const after = await getAccount(conn, ownerAta);
console.log(
  `After: delegate=${after.delegate?.toBase58() ?? "none"} ` +
    `remaining=${fromBaseUnits(after.delegatedAmount)} USDC`
);
console.log(
  after.delegate === null
    ? "Exposure left: none. The agent has no allowance any more; a payment signed earlier and submitted now is refused by the Token program."
    : "Warning: a delegate is still set."
);
