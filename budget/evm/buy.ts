import "./cli-guard.mjs";
// buy (B4): the agent pays a real x402 `exact` (EIP-3009) seller under a plain ERC-20 approve. Agent command: opens the agent key file only. Chain from --chain / B4_CHAIN (chains.ts): base-sepolia (default) or arc-testnet.
//   1. GET the seller (free) -> 402 with the price.
//   2. Prechecks before anything is signed or sent (rule 4): --max, token = the chain's USDC (6 decimals) and its EIP-712 domain, no Circle Gateway option, precision,
//      --pay-to, budget expiry (public file), allowance and owner balance cover the price, agent holds 0 USDC and has gas.
//      A refusal exits 3 with RESULT state "refused_precheck".
//   3. Journal the intent (rule 5), then the agent pulls exactly the price: USDC.transferFrom(owner, agent, price).
//   4. The agent signs a normal EIP-3009 authorization (from = agent) and the seller's facilitator settles it.
//   5. Settlement is read back from the chain. Delivery (seller HTTP status) is reported separately.
//   6. Pull landed but no settlement: the open authorization is cancelled on chain and the price goes back to the owner
//      (after a fresh chain read). It never pays again.
//
// npx tsx budget/evm/buy.ts [--chain <name>] --url <seller url> --max <usdc> [--pay-to <address>] [--op <id>] [--quote-only] [--http-timeout <seconds>]
// Exit codes (same on every rail): 0 settled and delivered (or quoted), 1 failed or refused by the chain, 2 bad usage,
// 3 refused before anything was signed, 4 paid but not delivered, 5 outcome unknown (reconcile; never pay again).
import { isAddress } from "viem";
import { arg, flag, agentCtx, toUsdc, usdc, usdcBalance, nativeBalance, gasFmt, tx, usageError, posInt, CFG, GAS } from "./lib.ts";
import { purchase } from "./purchase.ts";
import { checkOpId, newOpId, resultLine } from "./ops.ts";

const url = arg("url")!;
try { new URL(url); } catch { usageError(`--url "${url}" is not a URL`); }
const maxStr = arg("max");
if (!maxStr) usageError("--max <usdc> is required (no default)");
const max = toUsdc(maxStr!);
const payTo = arg("pay-to");
if (payTo && !isAddress(payTo)) usageError(`--pay-to "${payTo}" is not an address`);
const op = checkOpId(arg("op") ?? newOpId());
const httpTimeoutMs = posInt("http-timeout", "60", 600) * 1000;

const sym = GAS.symbol;
const c = await agentCtx();
console.log(`chain: ${CFG.label} (${CFG.chainId}), USDC ${CFG.usdc}`);
const bal = async () => ({ owner: await usdcBalance(c.owner), agent: await usdcBalance(c.agent), agentEth: await nativeBalance(c.agent) });
const before = await bal();
console.log(`operation: ${op}`);
console.log(`before: owner ${usdc(before.owner)} USDC, agent ${usdc(before.agent)} USDC, agent native ${GAS.symbol} ${gasFmt(before.agentEth)}`);
const r = await purchase({ url, c, op, max, payTo, quoteOnly: flag("quote-only"), httpTimeoutMs });
const j = r.journal;

await new Promise((res) => setTimeout(res, 3000)); // let the public RPC catch up before the closing balance read
const after = await bal();
console.log(`after:  owner ${usdc(after.owner)} USDC (net debit ${usdc(before.owner - after.owner)}), agent ${usdc(after.agent)} USDC (${GAS.isUsdc ? "was " + usdc(before.agent) + ", the difference is the gas it spent" : "held 0 before and after"}), agent gas spent ${gasFmt(before.agentEth - after.agentEth)} ${sym} (native balance, before minus after)`);
if (r.status !== undefined) console.log(`final HTTP status: ${r.status}${r.settle ? `, seller reports success=${r.settle.success}` : ""}`);
if (j.pullTx) console.log(`pull:        ${tx(j.pullTx)}`);
if (j.settleTx) console.log(`settlement:  ${tx(j.settleTx)}`);
if (j.cancelTx) console.log(`cancel auth: ${tx(j.cancelTx)}`);
if (j.returnTx) console.log(`return:      ${tx(j.returnTx)}`);
if (!r.settle && r.status === 402 && r.sellerError) console.log(`seller error: ${r.sellerError}`);
if (r.body !== undefined) console.log(`body: ${r.body}`);
if (j.reason) console.log(`reason: ${j.reason}`);

if (j.state === "settled" && j.delivered) console.log("PURCHASE OK.");
else if (j.state === "settled") console.log("PURCHASE SETTLED ON CHAIN BUT THE SELLER DID NOT DELIVER. Not paying again.");
else if (j.state === "quoted") console.log("QUOTE OK. Nothing was signed or sent.");
else if (j.state === "refused_precheck" || j.state === "refused_chain") console.log("PURCHASE REFUSED. Nothing was paid.");
else if (j.state === "failed" && j.returned) console.log(`PURCHASE DID NOT SETTLE. The pulled ${j.returned} USDC was returned to the owner. Never re-paid.`);
else console.log("PURCHASE OUTCOME NOT CONFIRMED (or it failed). Not retrying. Read the RESULT line, then reconcile.ts.");
if (j.next && j.next !== "none") console.log(`next: ${j.next}`);
console.log(await resultLine(j, "buy"));
process.exit(r.exitCode);
