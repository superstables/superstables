import "./cli-guard.mjs";
// revoke (B4 revokeBudget): the owner ends the agent's authorization: USDC.approve(agent, 0). Owner command (owner key file only).
// This is the kill switch even if the agent key is stolen: the next transferFrom reverts. What remains after it: whatever the
// agent already pulled and holds (0 between purchases), and any pull mined before this transaction.
// --plan reads the allowance, prints what would be sent and sends nothing (no key file is opened).
// npx tsx budget/evm/revoke.ts [--chain <name>] [--plan]
// Exit codes: 0 revoked (or planned), 1 the allowance still reads above 0.
import { encodeFunctionData } from "viem";
import { flag, emit, cmd, readCtx, ownerCtx, allowanceOf, usdcBalance, usdc, readUntil, send, writePublic, erc20Abi, USDC } from "./lib.ts";

if (flag("plan")) {
  const p = readCtx();
  const a = await allowanceOf(p.owner, p.agent);
  console.log(a === 0n ? "PLAN: the allowance is already 0; nothing would be sent" : `PLAN: the owner sends USDC.approve(agent, 0): the allowance ${usdc(a)} USDC goes to 0. Nothing is sent now.`);
  process.exit(emit("revoke", 0, { state: "planned", allowanceBefore: usdc(a), allowance: usdc(a), next: a === 0n ? "none" : `run ${cmd("revoke.ts")} to send it` }));
}
const c = await ownerCtx();
const before = await allowanceOf(c.owner, c.agent);
console.log(`allowance before: ${usdc(before)} USDC`);
let revokeTx: string | null = null;
if (before === 0n) console.log("the allowance is already 0: no transaction sent");
else revokeTx = (await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "revoke approve(agent, 0)")).hash;
const after = before === 0n ? 0n : await readUntil(() => allowanceOf(c.owner, c.agent), (v) => v === 0n);
const held = await usdcBalance(c.agent);
console.log(`allowance now: ${usdc(after)} USDC (0 = revoked)`);
console.log(`agent key holds ${usdc(held)} USDC${held > 0n ? " (on a gas-in-USDC chain this includes its gas reserve; run recover.ts only if a purchase left funds behind)" : ""}`);
if (after === 0n) writePublic({ B4_REVOKED_AT: String(Math.floor(Date.now() / 1000)) }, ["B4_CAP", "B4_EXPIRY", "B4_SET_AT"]);
process.exit(emit("revoke", after === 0n ? 0 : 1, { state: after === 0n ? "revoked" : "not_revoked", allowanceBefore: usdc(before), allowance: usdc(after), tx: revokeTx, agentHolds: usdc(held), next: after !== 0n ? `run ${cmd("revoke.ts")} again` : held > 0n ? "recover.ts only if a purchase left funds behind" : "none" }));
