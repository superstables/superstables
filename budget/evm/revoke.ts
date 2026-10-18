import "./cli-guard.mjs";
// revoke (B4 revokeBudget): the owner ends the agent's authorization: USDC.approve(agent, 0).
// The owner approves it in their own wallet (owner page, owner.ts); with --owner-key-file <path> it signs with that key
// instead (tests and automation only). This is the kill switch even if the agent key is stolen: the next transferFrom
// reverts. What remains after it: whatever the agent already pulled and holds (0 between purchases), and any pull mined
// before this transaction.
// It reports revoked, final: true only once the revoke's block is final on the chain and the endpoints agree that the allowance
// reads 0 at a final block at or after it. Before that it reports landed (exit 0, final: false): the allowance reads 0 but the
// chain could still undo it, so status stays the check. The hash and block are recorded (B4_REVOKED_TX, B4_REVOKED_BLOCK).
// It always sends approve(agent, 0), even when the allowance reads 0 first: one RPC's read is not proof that nothing is live
// (a stale or wrong answer would otherwise report "revoked" with an allowance still live). It reports revoked only after its
// own transaction was mined as planned and a later read shows 0.
// --plan reads the allowance, prints what would be sent and sends nothing (no key file, no page).
// npx tsx budget/evm/revoke.ts [--chain <name>] [--plan] [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 revoked or landed (or planned), 1 the allowance still reads above 0, 3 the owner rejected or the link expired,
// 5 the wallet may have sent it but no hash came back.
import { encodeFunctionData } from "viem";
import { SYM, flag, emit, readCtx, ownerCtx, OWNER_KEY_FILE, allowanceOf, usdcBalance, usdc, readUntil, send, writePublic, erc20Abi, USDC, assertRpcChain, assertReadChain, tx, allowanceAgreed, finalityOf, thatTakes, usuallyWords } from "./lib.ts";
import { revokeInWallet, chainFlag } from "./owner.ts";

const p = readCtx();
if (flag("plan")) {
  await assertReadChain("revoke");
  const a = await allowanceOf(p.owner, p.agent);
  console.log(a === 0n ? `PLAN: the allowance reads 0; revoke still sends ${SYM}.approve(agent, 0), because one read is not proof that nothing is live. Nothing is sent now.` : `PLAN: the owner sends ${SYM}.approve(agent, 0): the allowance ${usdc(a)} ${SYM} goes to 0. Nothing is sent now.`);
  process.exit(emit("revoke", 0, { state: "planned", allowanceBefore: usdc(a), allowance: usdc(a), next: "run revoke to send it (the owner approves in their wallet)" }));
}

await assertRpcChain();
const before = await allowanceOf(p.owner, p.agent);
console.log(`allowance before: ${usdc(before)} ${SYM}`);
if (before === 0n) console.log(`the allowance reads 0 on this RPC; sending approve(agent, 0) anyway: one read is not proof that nothing is live`);
let revokeTx: string;
let revokeBlock: bigint;
let final: boolean;
if (OWNER_KEY_FILE) {
  const c = await ownerCtx();
  const sent = await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "revoke approve(agent, 0)");
  revokeTx = sent.hash;
  revokeBlock = sent.blockNumber;
  // final: this block is final and the endpoints agree the allowance is 0 at a final block at or after it
  const fin = await finalityOf(sent.hash, { blockNumber: sent.blockNumber, blockHash: sent.blockHash });
  const at = await allowanceAgreed(p.owner, p.agent, sent.blockNumber);
  // an agreed value above 0 at a final block at or after the revoke is not a revoke (as the page path says)
  if (at.agreed && at.value !== 0n) {
    console.log(`the endpoints agree that the allowance reads ${usdc(at.value as bigint)} ${SYM} at a final block at or after the revoke; it is not revoked`);
    process.exit(emit("revoke", 1, { state: "not_revoked", allowanceBefore: usdc(before), allowance: usdc(at.value as bigint), tx: revokeTx, reason: "the allowance still reads above 0", next: "run revoke again" }));
  }
  final = fin.final && at.agreed && at.value === 0n;
} else {
  const sent = await revokeInWallet("revoke", p.owner, p.agent);
  revokeTx = sent.hash;
  revokeBlock = sent.block;
  final = sent.final;
}
const after = await readUntil(() => allowanceOf(p.owner, p.agent), (v) => v === 0n);
const held = await usdcBalance(p.agent);
console.log(`allowance now: ${usdc(after)} ${SYM} (0 = revoked) ${tx(revokeTx)}`);
console.log(`agent key holds ${usdc(held)} ${SYM}${held > 0n ? ` (on a gas-in-${SYM} chain this includes its gas reserve; run recover only if a purchase left funds behind)` : ""}`);
if (after === 0n) writePublic({ B4_REVOKED_AT: String(Math.floor(Date.now() / 1000)), B4_REVOKED_TX: revokeTx, B4_REVOKED_BLOCK: String(revokeBlock), B4_REVOKED_BY: "owner" }, ["B4_CAP", "B4_EXPIRY", "B4_SET_AT", "B4_SET_TX", "B4_SET_BLOCK"]);
if (after === 0n && !final) console.log(`the revoke is in block ${revokeBlock} and the allowance reads 0, but the chain has not made it final yet${thatTakes()}. Until then, check superstables budget status before you rely on it.`);
const landedNext = `superstables budget status --rail evm${chainFlag} later: the revoke is final when status says so${usuallyWords()}`;
process.exit(emit("revoke", after === 0n ? 0 : 1, { state: after === 0n ? (final ? "revoked" : "landed") : "not_revoked", ...(after === 0n ? { final } : {}), allowanceBefore: usdc(before), allowance: usdc(after), tx: revokeTx, block: String(revokeBlock), agentHolds: usdc(held), next: after !== 0n ? "run revoke again" : !final ? landedNext : held > 0n ? "recover only if a purchase left funds behind" : "none" }));
