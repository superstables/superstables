import "./cli-guard.mjs";
// read (B4 readBudget): allowance, owner balance, agent balances and the public expiry. Read only, no secret file.
// npx tsx budget/evm/read.ts [--chain <name>]
import { SYM, CFG, GAS, emit, readCtx, allowanceOf, usdcBalance, nativeBalance, usdc, gasFmt } from "./lib.ts";

const c = readCtx();
const allowance = await allowanceOf(c.owner, c.agent);
const ownerBal = await usdcBalance(c.owner);
const held = await usdcBalance(c.agent);
const now = Math.floor(Date.now() / 1000);
const ownerNative = await nativeBalance(c.owner), agentNative = await nativeBalance(c.agent);
console.log(`owner  ${c.owner}  ${SYM} ${usdc(ownerBal)}  native ${GAS.symbol} ${gasFmt(ownerNative)}`);
console.log(`agent  ${c.agent}  ${SYM} ${usdc(held)}  native ${GAS.symbol} ${gasFmt(agentNative)}`);
console.log(`allowance (owner -> agent): ${usdc(allowance)} ${SYM}  (the agent can move min(allowance, owner balance) = ${usdc(allowance < ownerBal ? allowance : ownerBal)} ${SYM} to any address)`);
console.log(`cap recorded in the public file: ${c.cap !== undefined ? usdc(c.cap) : "none"}${c.cap !== undefined && c.cap !== allowance ? `  (spent or changed: ${usdc(c.cap > allowance ? c.cap - allowance : 0n)} used)` : ""}`);
console.log(`expiry (public file, NOT enforced by the chain): ${c.expiry ? `${new Date(c.expiry * 1000).toISOString()} (${c.expiry > now ? `${c.expiry - now} s left` : "passed: the owner should revoke"})` : "none"}`);
console.log("period: none (a plain approve has no period)");
console.log(`revoked: ${allowance === 0n ? "allowance is 0 (revoked, spent or never set)" : "no"}`);
process.exit(emit("read", 0, {
  state: "ok", allowance: usdc(allowance), ownerUsdc: usdc(ownerBal), agentUsdc: usdc(held), ownerGas: `${gasFmt(ownerNative)} ${GAS.symbol}`, agentGas: `${gasFmt(agentNative)} ${GAS.symbol}`, cap: c.cap !== undefined ? usdc(c.cap) : null,
  maxMovable: usdc(allowance < ownerBal ? allowance : ownerBal), expiry: c.expiry ? new Date(c.expiry * 1000).toISOString() : null, expired: c.expiry ? c.expiry <= now : false,
  revoked: allowance === 0n, enforcedOnChain: { expiry: false, period: false, sellers: false }, next: "none",
}));
