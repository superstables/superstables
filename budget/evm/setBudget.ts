import "./cli-guard.mjs";
// setBudget (B4): the owner lets the agent pull up to --cap USDC from the owner's own address: USDC.approve(agent, cap).
// The owner approves it in their own wallet: this script builds the transaction and the terms, opens the owner page
// (owner.ts), waits, and then reads the chain. With --owner-key-file <path> it signs with that key instead (tests and
// automation only). --verify-only sends nothing and checks an approve the owner already sent from ANY wallet.
//
//   The chain has no expiry and no period for a plain approve, and no seller list: the agent can transferFrom the
//   allowance to ANY address. The allowance is the only limit, and only the owner's revoke (approve 0) or a self-revoke by
//   the agent key (recover.ts) lowers it. --expiry-in is advisory: it is recorded in the public state file and enforced only
//   by buy's precheck. A stolen agent key ignores it.
//
// The allowance is read back after the approve. If it is not exactly the requested cap (a wallet that let the owner edit the
// spending cap, an "unlimited" default), the command refuses with exit 3 and does not record the budget.
// approve overwrites in place, and a spender who sees the pending transaction can spend the old and the new amount.
// So a live allowance is never overwritten silently: it refuses (exit 3) until revoked. With --owner-key-file, --replace
// revokes first, waits until the chain reads 0, then approves.
//
// npx tsx budget/evm/setBudget.ts [--chain <name>] --cap <usdc> [--expiry-in <seconds>] [--timeout <s>] [--no-open]
//                                 [--owner-key-file <path> [--replace]] [--verify-only]
// Exit codes: 0 set, 3 refused (live allowance, the owner rejected or the link expired, or the allowance on chain is not
// exactly the cap), 5 the wallet may have sent it but no hash came back, 1 anything else that failed.
import { encodeFunctionData, type Hex } from "viem";
import { SYM, CFG, emit, arg, flag, posInt, toUsdc, usdc, gasFmt, GAS, OWNER_KEY_FILE, ownerCtx, readCtx, allowanceOf, usdcBalance, nativeBalance, readUntil, send, writePublic, erc20Abi, USDC, publicClient, assertRpcChain, tx } from "./lib.ts";
import { askTransaction, endUnapproved, closeOwnerPage, readSent, approvalsIn, findApproval, tokenRow, approveRow, capWords, REVOKE_HINT } from "./owner.ts";

const cap = toUsdc(arg("cap")!);
if (cap === 0n) { console.error("error: --cap must be above 0 (use revoke.ts to end a budget)"); process.exit(2); }
const expiryIn = arg("expiry-in") ? posInt("expiry-in", "1") : undefined;
const verifyOnly = flag("verify-only");
const replace = flag("replace");
if (verifyOnly && replace) { console.error("error: --verify-only sends nothing, so --replace does not apply"); process.exit(2); }
if (replace && !OWNER_KEY_FILE) { console.error("error: --replace needs --owner-key-file. In the wallet flow, revoke first, then grant"); process.exit(2); }

const result = (exit: number, o: Record<string, unknown>) => emit("setBudget", exit, o);
const pub = readCtx();
await assertRpcChain();
const beforeAllow = await allowanceOf(pub.owner, pub.agent);
const ownerBal = await usdcBalance(pub.owner);
const ownerGas = await nativeBalance(pub.owner);
console.log(`owner ${pub.owner} ${SYM} ${usdc(ownerBal)}, ${GAS.symbol} (native) ${gasFmt(ownerGas)}; agent ${pub.agent}; allowance now ${usdc(beforeAllow)} ${SYM}`);
const liveRefusal = () => {
  const reason = `an allowance of ${usdc(beforeAllow)} ${SYM} is already live for this agent. approve overwrites it in place, and an agent that sees the pending transaction can spend the old amount and then the new one. Revoke first, then grant again.`;
  console.log(`REFUSED: ${reason}`);
  process.exit(result(3, { state: "refused_precheck", reason, allowance: usdc(beforeAllow), next: "revoke first (superstables budget revoke --rail evm), then grant again" }));
};

let approveTx: string | null = null;
let finishPage: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null;
const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pub.agent, cap] });

if (!verifyOnly && OWNER_KEY_FILE) {
  const c = await ownerCtx();
  if (beforeAllow > 0n) {
    if (!replace) liveRefusal();
    await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "setBudget --replace: approve(agent, 0) first");
    const zero = await readUntil(() => allowanceOf(c.owner, c.agent), (v) => v === 0n);
    if (zero !== 0n) { console.log(`REFUSED: the allowance still reads ${usdc(zero)} after the revoke; not approving on top of it`); process.exit(result(3, { state: "refused_precheck", reason: `the allowance still reads ${usdc(zero)} after the revoke`, allowance: usdc(zero), next: "revoke, then set the budget again" })); }
  }
  approveTx = (await send(c.wallet, USDC, data, `setBudget approve(agent, ${usdc(cap)} ${SYM})`)).hash;
} else if (!verifyOnly) {
  // Refuse here, before any link exists, whatever would make the owner's approval fail or unsafe.
  if (beforeAllow > 0n) liveRefusal();
  if (!GAS.isUsdc && ownerGas === 0n) {
    const reason = `the owner ${pub.owner} has no ${GAS.symbol} to pay the fee for the approval`;
    console.log(`REFUSED: ${reason}`);
    process.exit(result(3, { state: "refused_precheck", reason, next: `fund the owner with ${CFG.label} ${GAS.symbol}, then grant again (superstables budget doctor --rail evm names the faucet)` }));
  }
  const startBlock = await publicClient.getBlockNumber();
  const { handle, outcome } = await askTransaction("grant", pub.owner, { to: USDC, data }, {
    title: "Grant a spending budget",
    amount: usdc(cap),
    unit: SYM,
    summary: `Allow the agent to withdraw up to ${capWords(cap)} from your wallet in total. Purchases within this allowance need no further approval.`,
    rows: [
      { label: "Agent", value: pub.agent, mono: true },
      { label: "From your wallet", value: pub.owner, mono: true },
      tokenRow(),
      { label: "Your balance", value: `${usdc(ownerBal)} ${SYM}` },
      approveRow(pub.agent, cap),
    ],
    enforced: [
      `Withdrawals under this allowance total at most ${capWords(cap)}. Spending the allowance does not recover funds already withdrawn.`,
      "Each withdrawal is limited by your token balance at that time. Later deposits can also be withdrawn while allowance remains.",
    ],
    notEnforced: [
      "No expiry. The budget stays until it is spent or you revoke it.",
      "No seller list or purchase requirement. Whoever holds the agent key can withdraw the allowance to any address.",
      "No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it.",
    ],
    notes: [
      `Check the spending cap: ${capWords(cap)}, or ${cap} in the token's smallest units. Do not choose unlimited. A changed cap can take effect on chain even if the command refuses to record it.`,
      `To end the budget at any time: ${REVOKE_HINT}`,
      "This grants permission; it does not transfer the budget now. You pay a network fee shown in your wallet. Grant only an amount you accept putting at risk.",
    ],
  });
  if (outcome.status === "rejected" || outcome.status === "expired") await endUnapproved("setBudget", outcome, { requested: usdc(cap) });
  if (outcome.status !== "sent") throw new Error(`unexpected owner page outcome ${outcome.status}`);
  finishPage = handle.finish;
  console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`);
  let sent = await readSent(outcome.hash as Hex, { from: pub.owner, to: USDC, data, afterBlock: startBlock });
  if (!sent) {
    // replaced ("speed up") or dropped: look for the approval itself
    const alt = await findApproval(pub.owner, pub.agent, startBlock);
    if (alt) {
      console.log(`the reported transaction is not on chain, but ${alt.hash} approved the agent after this request started; reading that one`);
      sent = await readSent(alt.hash, { from: pub.owner, to: USDC, data, afterBlock: startBlock });
    }
  }
  if (!sent) {
    handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity; the command reports it as unknown.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: outcome.hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)", next: "superstables budget status --rail evm: read the allowance before granting again" }));
  }
  approveTx = sent.hash;
  const events = approvalsIn(sent.logs, pub.owner, pub.agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status !== "success") {
    handle.finish({ ok: false, message: "The transaction reverted. No allowance was granted by it, but a network fee may have been charged.", hash: sent.hash });
    await closeOwnerPage();
    process.exit(result(1, { state: "failed", tx: sent.hash, reason: "the approve reverted on chain", next: "superstables budget status --rail evm" }));
  }
  // Any difference from the plan is a mismatch, whatever the allowance reads now: an edited higher allowance can be spent
  // down to the requested cap before the readback. The wallet already sent it, so the owner has to revoke it.
  if (sent.problems.length) {
    const reason = `the transaction on chain is not the one planned: ${sent.problems.join("; ")}. The budget was not recorded.`;
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(pub.owner, pub.agent).catch(() => null);
    handle.finish({ ok: false, message: `The chain shows a different transaction than planned (${sent.problems.join("; ")}). The budget was not recorded. Revoke it: ${REVOKE_HINT}`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(result(3, { state: "mismatch", tx: sent.hash, reason, requested: usdc(cap), allowance: now === null ? null : usdc(now), next: "revoke (superstables budget revoke --rail evm) to bring the allowance to 0, then grant again" }));
  }
}

const allowance = await readUntil(() => allowanceOf(pub.owner, pub.agent), (v) => v === cap);
console.log(`allowance read back: ${usdc(allowance)} ${SYM} (requested ${usdc(cap)})`);
if (allowance !== cap) {
  const reason = `the allowance on chain is ${usdc(allowance)} ${SYM}, not the requested cap ${usdc(cap)}${allowance > cap ? ": the agent can spend MORE than the cap (the spending cap was changed in the wallet, or another amount was approved)" : ""}. The budget was not recorded.`;
  console.log(`REFUSED: ${reason}`);
  finishPage?.({ ok: false, message: `The chain now shows an allowance of ${usdc(allowance)} ${SYM}, not ${capWords(cap)}. The budget was not recorded. Revoke it: ${REVOKE_HINT}`, hash: approveTx ?? undefined });
  await closeOwnerPage();
  process.exit(result(3, { state: "mismatch", tx: approveTx, reason, requested: usdc(cap), allowance: usdc(allowance), next: "revoke (superstables budget revoke --rail evm) to bring the allowance to 0, then grant again" }));
}

const now = Math.floor(Date.now() / 1000);
const expiry = expiryIn ? now + expiryIn : undefined;
writePublic(
  { B4_CAP: String(cap), B4_SET_AT: String(now), ...(expiry ? { B4_EXPIRY: String(expiry) } : {}) },
  ["B4_REVOKED_AT", ...(expiry ? [] : ["B4_EXPIRY"])],
);
console.log(`budget: ${usdc(cap)} ${SYM}, allowance == cap on chain.${approveTx ? ` ${tx(approveTx)}` : ""}`);
console.log(`no on-chain expiry and no on-chain period: the allowance stays until the agent spends it or someone revokes it${expiry ? `; advisory expiry ${new Date(expiry * 1000).toISOString()} is enforced only by buy's precheck, not by the chain` : ""}.`);
console.log(`maximum that can move: ${usdc(cap < ownerBal ? cap : ownerBal)} ${SYM} (min of the cap and the owner's balance ${usdc(ownerBal)}), to ANY address the agent names, until the owner revokes.`);
finishPage?.({ ok: true, message: `Done. The chain shows a budget of ${capWords(cap)} for your agent. You can close this page. To end it: ${REVOKE_HINT}`, hash: approveTx ?? undefined });
await closeOwnerPage();
process.exit(result(0, { state: "set", tx: approveTx, cap: usdc(cap), allowance: usdc(allowance), maxMovable: usdc(cap < ownerBal ? cap : ownerBal), expiry: expiry ? new Date(expiry * 1000).toISOString() : null, enforcedOnChain: { expiry: false, period: false, sellers: false }, next: "agent: buy" }));
