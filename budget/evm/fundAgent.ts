import "./cli-guard.mjs";
// fundAgent (B4, any chain): the owner sends the agent some native gas token so it can pay for the pull. One plain transfer,
// capped at 5 units. On Arc the gas token is USDC (18-decimal native units): the amount is in whole USDC.
// The owner approves it in their own wallet (owner page, owner.ts); with --owner-key-file <path> it signs with that key instead
// (tests and automation only). --amount defaults to the chain's doctor.fundAgent in chains.mjs.
// Prints the agent's native balance before and after, so the cost is exact.
// npx tsx budget/evm/fundAgent.ts [--chain <name>] [--amount <decimal>] [--timeout <s>] [--no-open] [--owner-key-file <path>]
import { type Hex } from "viem";
import { SYM, CFG, GAS, emit, arg, gasFmt, OWNER_KEY_FILE, ownerCtx, readCtx, nativeBalance, usdcBalance, usdc, readUntil, sendNative, usageError, assertRpcChain, tx } from "./lib.ts";
import { fundInWallet, fundingTx, approvalSite, fundValue, DEFAULT_FUND_AMOUNT } from "./owner.ts";

const amt = arg("amount") ?? DEFAULT_FUND_AMOUNT;
let value = 0n;
try { value = fundValue(amt); } catch (e) { usageError((e as Error).message); }
if (!OWNER_KEY_FILE && approvalSite() !== null) {
  try { fundingTx("0x0000000000000000000000000000000000000001", value, true); } catch (e) { usageError((e as Error).message); }
}
const p = readCtx();
await assertRpcChain();
const ob = await nativeBalance(p.owner), ab = await nativeBalance(p.agent);
console.log(`${CFG.label}: owner ${gasFmt(ob)} ${GAS.symbol} (native), agent ${gasFmt(ab)} ${GAS.symbol} (native)`);
if (ob < value) {
  console.log(`REFUSED: the owner has less than ${amt} ${GAS.symbol}`);
  process.exit(emit("fundAgent", 3, { state: "refused_precheck", reason: `the owner ${p.owner} has less than ${amt} ${GAS.symbol}`, next: `fund the owner first (superstables budget doctor --rail evm names the faucet)` }));
}

let hash: Hex;
if (OWNER_KEY_FILE) {
  const c = await ownerCtx();
  hash = (await sendNative(c.wallet, c.agent, value, `fund agent ${amt} ${GAS.symbol} (owner -> agent, plain transfer)`)).hash;
} else {
  hash = await fundInWallet("fundAgent", p.owner, p.agent, value, amt, ab);
}
const aa = await readUntil(() => nativeBalance(p.agent), (v) => v >= ab + value);
console.log(`agent ${gasFmt(aa)} ${GAS.symbol} ${tx(hash)}`);
if (GAS.isUsdc) console.log(`agent ERC-20 ${SYM} balance: ${usdc(await usdcBalance(p.agent))} (native / 1e12)`);
process.exit(emit("fundAgent", 0, { state: "ok", tx: hash, explorer: tx(hash), sent: gasFmt(value), agentNativeBefore: gasFmt(ab), agentNativeAfter: gasFmt(aa), next: "none" }));
