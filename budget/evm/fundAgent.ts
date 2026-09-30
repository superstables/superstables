import "./cli-guard.mjs";
// fundAgent (B4, any chain): the owner sends the agent some native gas token so it can pay for the pull. One plain transaction,
// capped at 5 units. On Arc the gas token is USDC (18-decimal native units): the amount is in whole USDC. Owner command (owner key file only).
// Prints the owner's native balance before and after and the fee, so the cost is exact.
// npx tsx budget/evm/fundAgent.ts --chain <name> --amount <decimal>
import { parseUnits } from "viem";
import { SYM, CFG, GAS, emit, arg, gasFmt, ownerCtx, nativeBalance, usdcBalance, usdc, readUntil, sendNative, usageError, publicClient, tx } from "./lib.ts";

const amt = arg("amount")!;
if (!/^\d+(\.\d{1,18})?$/.test(amt)) usageError(`--amount "${amt}" is not a decimal amount of ${GAS.symbol}`);
const value = parseUnits(amt, GAS.decimals);
if (value === 0n || value > parseUnits("5", GAS.decimals)) usageError(`--amount must be above 0 and at most 5 ${GAS.symbol}`);
const c = await ownerCtx();
const ob = await nativeBalance(c.owner), ab = await nativeBalance(c.agent);
console.log(`${CFG.label}: owner ${gasFmt(ob)} ${GAS.symbol} (native), agent ${gasFmt(ab)} ${GAS.symbol} (native)`);
if (ob < value) { console.log(`REFUSED: the owner has less than ${amt} ${GAS.symbol}`); process.exit(emit("fundAgent", 3, { state: "refused_precheck", reason: `the owner has less than ${amt} ${GAS.symbol}`, next: "none" })); }
const sent = await sendNative(c.wallet, c.agent, value, `fund agent ${amt} ${GAS.symbol} (owner -> agent, plain transfer)`);
const oa = await readUntil(() => nativeBalance(c.owner), (v) => v < ob), aa = await readUntil(() => nativeBalance(c.agent), (v) => v >= ab + value);
console.log(`owner ${gasFmt(oa)} (paid ${gasFmt(ob - oa)} = ${gasFmt(value)} sent + ${gasFmt(sent.feeWei)} fee), agent ${gasFmt(aa)} ${GAS.symbol}`);
if (GAS.isUsdc) console.log(`agent ERC-20 ${SYM} balance: ${usdc(await usdcBalance(c.agent))} (native / 1e12)`);
process.exit(emit("fundAgent", 0, { state: "ok", tx: sent.hash, explorer: tx(sent.hash), sent: gasFmt(value), ownerFee: gasFmt(sent.feeWei), ownerNativeBefore: gasFmt(ob), ownerNativeAfter: gasFmt(oa), agentNativeAfter: gasFmt(aa), next: "none" }));
void publicClient;
