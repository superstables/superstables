// readBudget() -- anyone can read, because reading needs no signature. This script opens no secret
// file: the owner address comes from --owner or the public address file.
//
// Reads the owner's USDC associated token account and prints its `delegate` and `delegatedAmount`
// (both on chain). An SPL delegate has NO expiry and NO seller list on chain, so none is shown: the
// budget lasts until it is spent or the owner revokes it. The maximum the agent can still move is
// min(delegatedAmount, the account's real balance).
import { getAssociatedTokenAddressSync, getAccountOrNull } from "./token.mjs";
import {
  connection,
  readPublic,
  PUBLIC_PATH,
  USDC_MINT,
  formatUnits,
  fromBaseUnits,
  parseEnvFile,
  parseStrict,
  parsePubkeyFlag,
  clusterProblem,
  oneLine,
  agreedAccount,
  agreementLine,
  recentFinalizedSlot,
} from "./lib.mjs";
import { agreementWords } from "../../src/core/rpc-quorum.mjs";

const USAGE = `Usage: node budget/solana/readBudget.mjs [--owner <address>]

Read the budget from the chain. No secret file is opened; no signature is made.

  --owner <address>         owner account to read (default: the public address file)
  -h, --help                show this help`;

const flags = parseStrict(process.argv.slice(2), { owner: "value" }, { usage: USAGE });
const ownerFlag = parsePubkeyFlag(flags, "owner", USAGE);

const conn = connection();
const cluster = await clusterProblem(conn);
if (cluster) {
  console.error(`${cluster}: the budget is not read from another cluster.`);
  process.exit(1);
}

const ownerPk = ownerFlag ?? readPublic().owner;
if (!ownerPk) {
  console.error(`Owner address unknown: pass --owner <address> or create ${PUBLIC_PATH} (superstables budget setup --rail solana writes it).`);
  process.exit(1);
}
// A revoke this machine recorded (revokeBudget writes REVOKED_AT in the public file), for the owner that file records only.
const pubEnv = parseEnvFile(PUBLIC_PATH);
const revokedAt = pubEnv.SOLANA_OWNER_ADDRESS === ownerPk.toBase58() && /^\d+$/.test(pubEnv.REVOKED_AT ?? "") ? Number(pubEnv.REVOKED_AT) : undefined;
const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, ownerPk);
// The slot the recorded revoke landed in (REVOKED_SLOT, when the revoke recorded it): the endpoints must read from there on.
const revokedSlot = revokedAt !== undefined && /^\d+$/.test(pubEnv.REVOKED_SLOT ?? "") ? BigInt(pubEnv.REVOKED_SLOT) : undefined;
let acc;
try {
  acc = await getAccountOrNull(conn, ownerAta);
} catch (e) {
  // could not read is not "no budget": fail, so status says it could not read the budget
  console.error(`Could not read the owner's USDC account ${ownerAta.toBase58()}: ${oneLine(e?.message ?? e, 300)}`);
  process.exit(1);
}
/**
 * "No delegate" and "no account" are verdicts of absence, so they are believed when every confirming endpoint, at finalized
 * commitment from one common slot on, reads the same. The slot the absence has to hold from is the recorded revoke's; with none
 * recorded it is a little behind the finalized slot now (for a revoke recorded by time only, as far behind as that revoke is old,
 * at one slot a second, which is slower than the chain runs).
 */
async function confirmAbsence(recordedRevoke = true) {
  let atLeast = recordedRevoke ? revokedSlot : undefined;
  if (atLeast === undefined) {
    const behind = recordedRevoke && revokedAt !== undefined ? Math.max(32, Math.min(Math.floor(Date.now() / 1000) - revokedAt, 100_000)) : 32;
    atLeast = await recentFinalizedSlot(conn, behind).catch(() => undefined);
  }
  if (atLeast === undefined) return { agreed: false, why: "unreadable", reason: "the finalized slot could not be read" };
  return agreedAccount(ownerAta.toBase58(), { minSlot: recordedRevoke ? revokedSlot : undefined, atLeast });
}
if (!acc) {
  const agreed = await confirmAbsence();
  if (!agreed.agreed || agreed.value !== null) {
    console.error(`The owner's USDC account reads as absent on one RPC, but ${agreed.agreed ? "the confirming RPC endpoints read it" : agreementWords(agreed)}: nothing is said about the budget.`);
    process.exit(1);
  }
  console.log("Owner USDC account not found (the chain says it does not exist): no delegate, nothing can move.");
  console.log(`  agreement: ${agreementLine(agreed)}`);
  console.log("  delegatedAmount (remaining): 0 USDC");
  console.log("  maximum the delegate can still move: 0 USDC");
  process.exit(0);
}
// No delegate on the primary: a revoke, a spent delegation, or one never granted. A delegate that can move 0 is the same kind of
// verdict (nothing left to spend). Each ends the budget, so each is believed only when the endpoints agree on it.
const noDelegate = acc.delegate === null;
const effective = acc.delegatedAmount < acc.amount ? acc.delegatedAmount : acc.amount;
const zero = !noDelegate && effective === 0n;
const agreed = noDelegate ? await confirmAbsence() : zero ? await confirmAbsence(false) : undefined;
const confirmedNone = noDelegate && agreed?.agreed === true && (agreed.value?.delegate ?? null) === null;
const confirmedZero = zero && agreed?.agreed === true && agreed.value !== null && agreed.value.delegate === acc.delegate.toBase58() && agreed.value.delegatedAmount === acc.delegatedAmount && agreed.value.amount === acc.amount;
const confirmed = confirmedNone || confirmedZero;
// revoked only for a revoke recorded here that the chain still shows: no delegate also reads once a delegation is spent
// (SPL Token clears the delegate when the delegated amount reaches 0), and when none was ever granted.
const revoked = noDelegate && revokedAt !== undefined && confirmedNone;
const unconfirmed = (noDelegate || zero) && !confirmed;
const why = !agreed ? "" : agreed.agreed ? (noDelegate ? "the confirming RPC endpoints read a delegate" : "the confirming RPC endpoints read a different amount") : agreementWords(agreed);
// The owner's last recorded action (the revoke when REVOKED_AT is recorded, else the grant: a grant drops REVOKED_AT) and whether its
// signature is finalized. Only for the owner the public file records.
const sigLike = (v) => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v);
const lastAction = pubEnv.SOLANA_OWNER_ADDRESS === ownerPk.toBase58()
  ? revokedAt !== undefined && sigLike(pubEnv.REVOKED_TX) ? { action: "revoke", tx: pubEnv.REVOKED_TX } : sigLike(pubEnv.GRANT_TX) ? { action: "grant", tx: pubEnv.GRANT_TX } : null
  : null;
let lastFinal = false;
if (lastAction) {
  try {
    const st = (await conn.getSignatureStatuses([lastAction.tx], { searchTransactionHistory: true })).value[0];
    lastFinal = st?.confirmationStatus === "finalized" && !st.err;
  } catch { /* not read: not final */ }
}
console.log("On-chain (owner USDC token account):");
console.log(`  owner: ${ownerPk.toBase58()}`);
console.log(`  delegate: ${acc.delegate?.toBase58() ?? "none"}`);
if (agreed) console.log(`  agreement: ${confirmed ? agreed.agreement : why}`);
console.log(`  delegatedAmount (remaining): ${unconfirmed ? `unknown (${why})` : `${fromBaseUnits(acc.delegatedAmount)} USDC`}`);
console.log(`  revoked: ${revoked}${revoked ? ` (this machine recorded a revoke at ${new Date(revokedAt * 1000).toISOString()})` : unconfirmed ? ` (not confirmed: ${why})` : acc.delegate === null ? " (no delegate reads: spent, never granted, or revoked without a record on this machine)" : ""}`);
if (lastAction) console.log(`  last owner action: ${lastAction.action} ${lastAction.tx} (${lastFinal ? "final" : "landed, not final yet"})`);
console.log(`  owner token balance (informational, not the budget): ${fromBaseUnits(acc.amount)} USDC`);
console.log(`  maximum the delegate can still move: ${unconfirmed ? `unknown (${why})` : `${formatUnits(effective)} USDC (the smaller of the two above)`}`);
console.log("\nNo expiry and no seller list exist on this rail. The budget lasts until it is spent or revoked.");
