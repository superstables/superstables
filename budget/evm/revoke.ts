import "./cli-guard.mjs";
// revoke (B4 revokeBudget): the owner ends the agent's authorization: USDC.approve(agent, 0).
// The owner approves it in their own wallet (owner page, owner.ts); with --owner-key-file <path> it signs with that key
// instead (tests and automation only). This is the kill switch even if the agent key is stolen: the next transferFrom
// reverts. What remains after it: whatever the agent already pulled and holds (0 between purchases), and any pull mined
// before this transaction.
// --plan reads the allowance, prints what would be sent and sends nothing (no key file, no page).
// npx tsx budget/evm/revoke.ts [--chain <name>] [--plan] [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 revoked (or planned), 1 the allowance still reads above 0, 3 the owner rejected or the link expired,
// 5 the wallet may have sent it but no hash came back.
import { encodeFunctionData } from "viem";
import { SYM, flag, emit, readCtx, ownerCtx, OWNER_KEY_FILE, allowanceOf, usdcBalance, usdc, readUntil, send, writePublic, erc20Abi, USDC, assertRpcChain, tx } from "./lib.ts";
import { revokeInWallet } from "./owner.ts";

const p = readCtx();
if (flag("plan")) {
  const a = await allowanceOf(p.owner, p.agent);
  console.log(a === 0n ? "PLAN: the allowance is already 0; nothing would be sent" : `PLAN: the owner sends ${SYM}.approve(agent, 0): the allowance ${usdc(a)} ${SYM} goes to 0. Nothing is sent now.`);
  process.exit(emit("revoke", 0, { state: "planned", allowanceBefore: usdc(a), allowance: usdc(a), next: a === 0n ? "none" : "run revoke to send it (the owner approves in their wallet)" }));
}

await assertRpcChain();
const before = await allowanceOf(p.owner, p.agent);
console.log(`allowance before: ${usdc(before)} ${SYM}`);
let revokeTx: string | null = null;
if (before === 0n) console.log("the allowance is already 0: no transaction sent");
else if (OWNER_KEY_FILE) {
  const c = await ownerCtx();
  revokeTx = (await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "revoke approve(agent, 0)")).hash;
} else revokeTx = await revokeInWallet("revoke", p.owner, p.agent);
const after = before === 0n ? 0n : await readUntil(() => allowanceOf(p.owner, p.agent), (v) => v === 0n);
const held = await usdcBalance(p.agent);
console.log(`allowance now: ${usdc(after)} ${SYM} (0 = revoked)${revokeTx ? ` ${tx(revokeTx)}` : ""}`);
console.log(`agent key holds ${usdc(held)} ${SYM}${held > 0n ? ` (on a gas-in-${SYM} chain this includes its gas reserve; run recover only if a purchase left funds behind)` : ""}`);
if (after === 0n) writePublic({ B4_REVOKED_AT: String(Math.floor(Date.now() / 1000)) }, ["B4_CAP", "B4_EXPIRY", "B4_SET_AT"]);
process.exit(emit("revoke", after === 0n ? 0 : 1, { state: after === 0n ? "revoked" : "not_revoked", allowanceBefore: usdc(before), allowance: usdc(after), tx: revokeTx, agentHolds: usdc(held), next: after !== 0n ? "run revoke again" : held > 0n ? "recover only if a purchase left funds behind" : "none" }));
