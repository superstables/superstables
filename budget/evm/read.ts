import "./cli-guard.mjs";
// read (B4 readBudget): allowance, owner balance, agent balances and the public expiry. Read only, no secret file.
// npx tsx budget/evm/read.ts [--chain <name>]
import { SYM, CFG, GAS, emit, readCtx, allowanceOf, usdcBalance, nativeBalance, usdc, gasFmt, assertReadChain, allowanceAgreed, agreementWords, receiptAgreed, publicEnv } from "./lib.ts";

const c = readCtx();
await assertReadChain("read");
const allowance = await allowanceOf(c.owner, c.agent);
const ownerBal = await usdcBalance(c.owner);
const held = await usdcBalance(c.agent);
const now = Math.floor(Date.now() / 1000);
const ownerNative = await nativeBalance(c.owner), agentNative = await nativeBalance(c.agent);
// revoked only for a revoke this machine recorded (B4_REVOKED_AT, written by revoke and recover) that the chain still shows:
// an allowance of 0 alone is also what a spent, never granted or wrongly read budget looks like.
const recorded = c.revokedAt !== undefined && Number.isFinite(c.revokedAt);
// An allowance of 0 is believed as a revoke only when the configured endpoints agree on it at a final block that is not older than
// the recorded revoke (the record holds a time, so the agreed block's own time is the bound an absence has to meet).
// (without a record, revoked is false whatever the endpoints say, so nobody else is asked)
// When the revoke recorded its block (B4_REVOKED_BLOCK), the agreement has to hold at a final block at or after it; a revoke that
// landed but is not final yet is then "not final yet", never "revoked". Without a block (an older record), the time bound above.
const pe = publicEnv();
const revokedBlock = /^\d+$/.test(pe.B4_REVOKED_BLOCK ?? "") ? BigInt(pe.B4_REVOKED_BLOCK) : undefined;
const agreed = allowance === 0n && recorded ? await allowanceAgreed(c.owner, c.agent, revokedBlock) : null;
const agreedZero = agreed !== null && agreed.agreed === true && agreed.value === 0n && (!recorded || revokedBlock !== undefined || agreed.block.timestamp >= c.revokedAt!);
// The owner's last recorded action (the later of a revoke and a grant, as the files record them: a grant drops B4_REVOKED_AT and a
// revoke drops B4_SET_AT) and whether its transaction is final: seen at or below the agreed final block, in the block named.
const isHash = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const last = recorded && isHash(pe.B4_REVOKED_TX) ? { action: "revoke", tx: pe.B4_REVOKED_TX } : /^\d+$/.test(pe.B4_SET_AT ?? "") && isHash(pe.B4_SET_TX) ? { action: "grant", tx: pe.B4_SET_TX } : null;
let lastOwnerAction: { action: string; tx: string; final: boolean } | null = null;
if (last) {
  const got = await receiptAgreed(last.tx as `0x${string}`);
  const v: any = got.agreed ? got.value : null;
  lastOwnerAction = { action: last.action, tx: last.tx, final: v !== null && typeof v === "object" && v.state === undefined && v.status === "0x1" };
}
const revokeFinal = lastOwnerAction?.action !== "revoke" || lastOwnerAction.final;
const revoked = allowance === 0n && recorded && agreedZero && revokeFinal;
const agreement = agreed === null ? null : agreed.agreed ? (agreedZero && revokeFinal ? agreed.agreement : "it is not final on chain yet") : agreementWords(agreed);
console.log(`owner  ${c.owner}  ${SYM} ${usdc(ownerBal)}  native ${GAS.symbol} ${gasFmt(ownerNative)}`);
console.log(`agent  ${c.agent}  ${SYM} ${usdc(held)}  native ${GAS.symbol} ${gasFmt(agentNative)}`);
console.log(`allowance (owner -> agent): ${usdc(allowance)} ${SYM}  (the agent can move min(allowance, owner balance) = ${usdc(allowance < ownerBal ? allowance : ownerBal)} ${SYM} to any address)`);
console.log(`cap recorded in the public file: ${c.cap !== undefined ? usdc(c.cap) : "none"}${c.cap !== undefined && c.cap !== allowance ? `  (spent or changed: ${usdc(c.cap > allowance ? c.cap - allowance : 0n)} used)` : ""}`);
console.log(`expiry (public file, NOT enforced by the chain): ${c.expiry ? `${new Date(c.expiry * 1000).toISOString()} (${c.expiry > now ? `${c.expiry - now} s left` : "passed: the owner should revoke"})` : "none"}`);
console.log("period: none (a plain approve has no period)");
if (lastOwnerAction) console.log(`last owner action: ${lastOwnerAction.action} ${lastOwnerAction.tx} (${lastOwnerAction.final ? "final" : "landed, not final yet"})`);
console.log(`revoked: ${revoked ? `yes: this machine recorded a revoke at ${new Date(c.revokedAt! * 1000).toISOString()}, and the allowance reads 0` : recorded && allowance === 0n ? `no: the allowance reads 0 on this RPC, but ${agreement}` : allowance === 0n ? "no record of a revoke on this machine; the allowance reads 0 (spent, never granted, or revoked)" : "no"}`);
process.exit(emit("read", 0, {
  state: "ok", allowance: usdc(allowance), ownerUsdc: usdc(ownerBal), agentUsdc: usdc(held), ownerGas: `${gasFmt(ownerNative)} ${GAS.symbol}`, agentGas: `${gasFmt(agentNative)} ${GAS.symbol}`, cap: c.cap !== undefined ? usdc(c.cap) : null,
  maxMovable: usdc(allowance < ownerBal ? allowance : ownerBal), expiry: c.expiry ? new Date(c.expiry * 1000).toISOString() : null, expired: c.expiry ? c.expiry <= now : false,
  revoked, allowanceZero: allowance === 0n, agreement, lastOwnerAction, revokedAt: recorded ? new Date(c.revokedAt! * 1000).toISOString() : null, enforcedOnChain: { expiry: false, period: false, sellers: false }, next: "none",
}));
