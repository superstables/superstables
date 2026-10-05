import "./cli-guard.mjs";
// reconcile (B4): READ ONLY. Reads an operation's journal and the chain, then sets settled / failed / unknown / not_found in the
// journal file. It opens no key file and never signs, sends or pays. (Returning stranded funds is recover.ts --op <id>, an owner command.)
//   settled    the pull landed and this operation's own authorization was used by a successful transaction that paid the recipient
//   failed     the pull reverted, or it landed and the authorization can never settle (never signed, cancelled, expired by chain time)
//   unknown    the authorization may still settle, or the signed pull is not proven either way (never pay again; run this again)
//   not_found  nothing can land: no pull was signed, or the agent's nonce at the pull's position was used by a different transaction
// npx tsx budget/evm/reconcile.ts [--chain <name>] --op <id>
// Exit codes: 0 settled and delivered, 1 failed or not_found, 4 settled on chain but delivery not confirmed, 5 unknown.
import { SYM, CFG, tx, usdc, usdcBalance, emit } from "./lib.ts";
import { checkOpId, readJournal, reconcileJournal, resultLine, exitCodeFor, journalPath } from "./ops.ts";

const op = checkOpId(process.argv[process.argv.indexOf("--op") + 1]);
const j = readJournal(op);
if (!j) {
  console.log(`no journal for operation ${op} at ${journalPath(op)}`);
  process.exit(emit("reconcile", 1, { path: "approve", op, state: "not_found", paid: false, delivered: null, amount: null, remaining: null, tx: { pull: null, settle: null, cancel: null, return: null }, debit: null, next: "no such operation on this chain; check --chain and --op. Nothing to reconcile" }));
}
console.log(`operation ${op}: journal says ${j.state} (${j.url}) on ${CFG.label}`);
const { j: after, verdict } = await reconcileJournal(j);
console.log(`pull:        ${after.pullTx ? `${after.pullStatus ?? "?"} ${tx(after.pullTx)}` : "none recorded"}`);
console.log(`settlement:  ${after.settleTx ? `${after.settleStatus} ${tx(after.settleTx)}` : "none on chain"}`);
if (after.cancelTx) console.log(`cancel auth: ${after.cancelStatus ?? "?"} ${tx(after.cancelTx)}`);
if (after.returnTx) console.log(`return:      ${after.returnStatus ?? "?"} ${tx(after.returnTx)}`);
console.log(`pulled from the owner: ${after.pulled ?? "unknown"} ${SYM}, returned: ${after.returned ?? "0"} ${SYM}, agent key holds now: ${usdc(await usdcBalance(after.agent))} ${SYM}`);
console.log(`verdict: ${verdict}${after.reason ? ` -- ${after.reason}` : ""}`);
if (after.next && after.next !== "none") console.log(`next: ${after.next}`);
console.log(await resultLine(after, "reconcile"));
process.exit(exitCodeFor(after.state, after.delivered));
