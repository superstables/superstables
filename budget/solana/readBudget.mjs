// readBudget() -- anyone can read, because reading needs no signature. This script opens no secret
// file: the owner address comes from --owner or the public address file.
//
// Reads the owner's USDC associated token account and prints its `delegate` and `delegatedAmount`
// (both on chain). An SPL delegate has NO expiry and NO seller list on chain, so none is shown: the
// budget lasts until it is spent or the owner revokes it. The maximum the agent can still move is
// min(delegatedAmount, the account's real balance).
import { getAssociatedTokenAddressSync, getAccount } from "./token.mjs";
import {
  connection,
  readPublic,
  PUBLIC_PATH,
  USDC_MINT,
  formatUnits,
  fromBaseUnits,
  parseStrict,
  parsePubkeyFlag,
} from "./lib.mjs";

const USAGE = `Usage: node budget/solana/readBudget.mjs [--owner <address>]

Read the budget from the chain. No secret file is opened; no signature is made.

  --owner <address>         owner account to read (default: the public address file)
  -h, --help                show this help`;

const flags = parseStrict(process.argv.slice(2), { owner: "value" }, { usage: USAGE });
const ownerFlag = parsePubkeyFlag(flags, "owner", USAGE);

const conn = connection();

const ownerPk = ownerFlag ?? readPublic().owner;
if (!ownerPk) {
  console.error(`Owner address unknown: pass --owner <address> or create ${PUBLIC_PATH} (generate-keys.mjs writes it).`);
  process.exit(1);
}
const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, ownerPk);
const acc = await getAccount(conn, ownerAta).catch(() => null);
if (!acc) {
  console.log("Owner USDC account not found.");
  process.exit(0);
}
const revoked = acc.delegate === null;
const effective = acc.delegatedAmount < acc.amount ? acc.delegatedAmount : acc.amount;
console.log("On-chain (owner USDC token account):");
console.log(`  owner: ${ownerPk.toBase58()}`);
console.log(`  delegate: ${acc.delegate?.toBase58() ?? "none"}`);
console.log(`  delegatedAmount (remaining): ${fromBaseUnits(acc.delegatedAmount)} USDC`);
console.log(`  revoked: ${revoked}`);
console.log(`  owner token balance (informational, not the budget): ${fromBaseUnits(acc.amount)} USDC`);
console.log(`  maximum the delegate can still move: ${formatUnits(effective)} USDC (the smaller of the two above)`);
console.log("\nNo expiry and no seller list exist on this rail. The budget lasts until it is spent or revoked.");
