import "./cli-guard.mjs";
// setBudget (B4): the owner lets the agent pull up to --cap USDC from the owner's own address: USDC.approve(agent, cap).
// Owner command (owner key file only), or --verify-only (no secret file) after the owner approved from ANY wallet.
//
//   The chain has no expiry and no period for a plain approve, and no seller list: the agent can transferFrom the
//   allowance to ANY address. The allowance is the only limit, and only the owner's revoke (approve 0) or a self-revoke by
//   the agent key (recover.ts) lowers it. --expiry-in is advisory: it is recorded in the public state file and enforced only
//   by buy's precheck. A stolen agent key ignores it.
//
// The allowance is read back after the approve. If it is not exactly the requested cap (a wallet's "unlimited" default,
// a different amount), the command refuses with exit 3 and does not record the budget.
// approve overwrites in place, and a spender who sees the pending transaction can spend the old and the new amount.
// So a live allowance is never overwritten silently: it refuses (exit 3) until revoked; --replace revokes first,
// waits until the chain reads 0, then approves.
//
// npx tsx budget/evm/setBudget.ts [--chain <name>] --cap <usdc> [--expiry-in <seconds>] [--replace] [--verify-only]
// Exit codes: 0 set, 3 refused (live allowance, or the allowance on chain is not exactly the cap), 1 anything else that failed.
import { encodeFunctionData } from "viem";
import { emit, arg, flag, posInt, toUsdc, usdc, gasFmt, GAS, ownerCtx, readCtx, allowanceOf, usdcBalance, nativeBalance, readUntil, send, writePublic, erc20Abi, USDC } from "./lib.ts";

const cap = toUsdc(arg("cap")!);
if (cap === 0n) { console.error("error: --cap must be above 0 (use revoke.ts to end a budget)"); process.exit(2); }
const expiryIn = arg("expiry-in") ? posInt("expiry-in", "1") : undefined;
const verifyOnly = flag("verify-only");
const replace = flag("replace");
if (verifyOnly && replace) { console.error("error: --verify-only sends nothing, so --replace does not apply"); process.exit(2); }

const result = (exit: number, o: Record<string, unknown>) => emit("setBudget", exit, o);
const pub = readCtx();
const beforeAllow = await allowanceOf(pub.owner, pub.agent);
const ownerBal = await usdcBalance(pub.owner);
console.log(`owner ${pub.owner} USDC ${usdc(ownerBal)}, agent ${pub.agent}, allowance now ${usdc(beforeAllow)} USDC`);

let approveTx: string | null = null;
if (!verifyOnly) {
  const c = await ownerCtx();
  console.log(`owner ${GAS.symbol} (native) ${gasFmt(await nativeBalance(c.owner))}`);
  if (beforeAllow > 0n) {
    if (!replace) {
      const reason = `an allowance of ${usdc(beforeAllow)} USDC is already live for this agent. approve overwrites it in place, and an agent that sees the pending transaction can spend the old amount and then the new one. Run revoke.ts first, or add --replace (revoke, wait for 0, then approve).`;
      console.log(`REFUSED: ${reason}`);
      process.exit(result(3, { state: "refused_precheck", reason, allowance: usdc(beforeAllow), next: "run revoke.ts, then setBudget again (or use --replace)" }));
    }
    await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "setBudget --replace: approve(agent, 0) first");
    const zero = await readUntil(() => allowanceOf(c.owner, c.agent), (v) => v === 0n);
    if (zero !== 0n) { console.log(`REFUSED: the allowance still reads ${usdc(zero)} after the revoke; not approving on top of it`); process.exit(result(3, { state: "refused_precheck", reason: `the allowance still reads ${usdc(zero)} after the revoke`, allowance: usdc(zero), next: "run revoke.ts, then setBudget again" })); }
  }
  approveTx = (await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, cap] }), `setBudget approve(agent, ${usdc(cap)} USDC)`)).hash;
}

const allowance = await readUntil(() => allowanceOf(pub.owner, pub.agent), (v) => v === cap);
console.log(`allowance read back: ${usdc(allowance)} USDC (requested ${usdc(cap)})`);
if (allowance !== cap) {
  const reason = `the allowance on chain is ${usdc(allowance)} USDC, not the requested cap ${usdc(cap)}${allowance > cap ? ": the agent can spend MORE than the cap (a wallet's unlimited default, or another amount was approved)" : ""}. The budget was not recorded.`;
  console.log(`REFUSED: ${reason}`);
  process.exit(result(3, { state: "mismatch", reason, requested: usdc(cap), allowance: usdc(allowance), next: "run revoke.ts (owner) to bring the allowance to 0, then set the budget again" }));
}

const now = Math.floor(Date.now() / 1000);
const expiry = expiryIn ? now + expiryIn : undefined;
writePublic(
  { B4_CAP: String(cap), B4_SET_AT: String(now), ...(expiry ? { B4_EXPIRY: String(expiry) } : {}) },
  ["B4_REVOKED_AT", ...(expiry ? [] : ["B4_EXPIRY"])],
);
console.log(`budget: ${usdc(cap)} USDC, allowance == cap on chain.`);
console.log(`no on-chain expiry and no on-chain period: the allowance stays until the agent spends it or someone revokes it${expiry ? `; advisory expiry ${new Date(expiry * 1000).toISOString()} is enforced only by buy's precheck, not by the chain` : ""}.`);
console.log(`maximum that can move: ${usdc(cap < ownerBal ? cap : ownerBal)} USDC (min of the cap and the owner's balance ${usdc(ownerBal)}), to ANY address the agent names, until the owner runs revoke.ts.`);
process.exit(result(0, { state: "set", tx: approveTx, cap: usdc(cap), allowance: usdc(allowance), maxMovable: usdc(cap < ownerBal ? cap : ownerBal), expiry: expiry ? new Date(expiry * 1000).toISOString() : null, enforcedOnChain: { expiry: false, period: false, sellers: false }, next: "agent: buy.ts" }));
