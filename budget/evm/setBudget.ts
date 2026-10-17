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
// A grant is asked for only when the endpoints agree, at a final block, that the allowance is 0: a revoke that landed but is not final
// yet does not count. After the approve it reports set, final: true only once the approve's block is final and the endpoints agree
// that the allowance is the cap there; before that it reports landed (exit 0, final: false).
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
import { type Hex } from "viem";
import { SYM, CFG, emit, arg, flag, posInt, toUsdc, usdc, gasFmt, GAS, OWNER_KEY_FILE, ownerCtx, ownerPlanCtx, allowanceOf, usdcBalance, nativeBalance, readUntil, send, writePublic, USDC, publicClient, assertRpcChain, tx, allowanceAgreed, agreementWords, finalityOf, usuallyWords, sleep } from "./lib.ts";
import { askTransaction, endUnapproved, closeOwnerPage, readSent, approvalsIn, findApproval, grantMismatchSteps, tokenRow, approveRow, capWords, REVOKE_HINT, grantTx, grantSteps, approveResetHostedProblem, grantEnforced, GRANT_NOT_ENFORCED, landedGrant, chainFlag } from "./owner.ts";
import { differsFromRequest, mismatchPage, mismatchReason } from "../site.mjs";
import type { OwnerVerdict } from "../../src/core/signer/owner-approval-server.ts";

const cap = toUsdc(arg("cap")!);
if (cap === 0n) { console.error("error: --cap must be above 0 (use revoke.ts to end a budget)"); process.exit(2); }
const expiryIn = arg("expiry-in") ? posInt("expiry-in", "1") : undefined;
const verifyOnly = flag("verify-only");
const replace = flag("replace");
if (verifyOnly && replace) { console.error("error: --verify-only sends nothing, so --replace does not apply"); process.exit(2); }
if (replace && !OWNER_KEY_FILE) { console.error("error: --replace needs --owner-key-file. In the wallet flow, revoke first, then grant"); process.exit(2); }

const result = (exit: number, o: Record<string, unknown>) => emit("setBudget", exit, o);
const pub = await ownerPlanCtx(); // public addresses, checked against the owner's setup signature
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

// The grant needs the allowance at 0 at the chain's final block, not only on the first endpoint: a revoke still short of final could be
// undone by the chain, and an approve over a live allowance is what this command never does. --replace revokes first itself.
if (!verifyOnly && !(replace && OWNER_KEY_FILE && beforeAllow > 0n) && !(!OWNER_KEY_FILE && approveResetHostedProblem())) {
  const atFinal = await allowanceAgreed(pub.owner, pub.agent);
  if (!atFinal.agreed) {
    const reason = `the allowance at the chain's final block could not be confirmed (${agreementWords(atFinal)})`;
    console.log(`REFUSED: ${reason}. Nothing was sent.`);
    process.exit(result(3, { state: "refused_precheck", reason, allowance: usdc(beforeAllow), next: `superstables budget doctor --rail evm${chainFlag}, then grant again` }));
  }
  if (atFinal.value !== 0n && beforeAllow === 0n) {
    const reason = `the previous revoke is not final yet: the allowance reads 0 at the latest block but ${usdc(atFinal.value as bigint)} ${SYM} at the final block. Grant again once it is final${usuallyWords()}`;
    console.log(`REFUSED: ${reason}. Nothing was sent.`);
    process.exit(result(3, { state: "refused_precheck", reason, allowance: usdc(beforeAllow), next: `superstables budget status --rail evm${chainFlag}, then grant again once the revoke is final` }));
  }
}

let approveTx: string | null = null;
let approveBlock: { blockNumber: bigint; blockHash?: string; final?: boolean } | null = null;
let finishPage: ((v: OwnerVerdict) => void) | null = null;
const { data } = grantTx(pub.agent, cap);

if (!verifyOnly && OWNER_KEY_FILE) {
  const c = await ownerCtx();
  const steps = grantSteps(c.agent, cap, beforeAllow);
  if (steps.length > 1) {
    if (!replace) liveRefusal();
    const first = await send(c.wallet, steps[0].to, steps[0].data, "setBudget --replace: approve(agent, 0) first");
    const zero = await readUntil(() => allowanceOf(c.owner, c.agent), (v) => v === 0n);
    if (zero !== 0n) { console.log(`REFUSED: the allowance still reads ${usdc(zero)} after the revoke; not approving on top of it`); process.exit(result(3, { state: "refused_precheck", reason: `the allowance still reads ${usdc(zero)} after the revoke`, allowance: usdc(zero), next: "revoke, then set the budget again" })); }
    // the new approve waits until the endpoints agree the revoke is final: up to two minutes
    const until = Date.now() + 120_000;
    let at = await allowanceAgreed(c.owner, c.agent, first.blockNumber);
    while (!(at.agreed && at.value === 0n) && Date.now() < until) { await sleep(4000); at = await allowanceAgreed(c.owner, c.agent, first.blockNumber); }
    if (!(at.agreed && at.value === 0n)) {
      const reason = `the revoke ${first.hash} landed; grant again once it is final${usuallyWords()}`;
      console.log(`REFUSED: ${reason}. Nothing more was sent.`);
      process.exit(result(3, { state: "refused_precheck", reason, allowance: usdc(zero), tx: first.hash, next: `superstables budget status --rail evm${chainFlag}, then grant again once the revoke is final` }));
    }
  }
  const sent = await send(c.wallet, USDC, data, `setBudget approve(agent, ${usdc(cap)} ${SYM})`);
  approveTx = sent.hash;
  approveBlock = { blockNumber: sent.blockNumber, blockHash: sent.blockHash };
} else if (!verifyOnly) {
  // Refuse here, before any link exists, whatever would make the owner's approval fail or unsafe.
  if (beforeAllow > 0n) liveRefusal();
  const reset = approveResetHostedProblem();
  if (reset) {
    console.log(`REFUSED: ${reset}. Nothing was requested.`);
    process.exit(result(3, { state: "refused_precheck", reason: reset, next: "this token's budgets are approved on this computer only: ask the owner to set this chain up without --hosted" }));
  }
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
    enforced: grantEnforced(cap),
    notEnforced: GRANT_NOT_ENFORCED,
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
  let sent = await readSent(outcome.hash as Hex, { from: pub.owner, to: USDC, data, afterBlock: startBlock, siteFailed: outcome.siteFailed });
  if (!sent) {
    // replaced ("speed up") or dropped: look for the approval itself
    const alt = await findApproval(pub.owner, pub.agent, startBlock);
    if (alt) {
      console.log(`the reported transaction is not on chain, but ${alt.hash} approved the agent after this request started; reading that one`);
      sent = await readSent(alt.hash, { from: pub.owner, to: USDC, data, afterBlock: startBlock, siteFailed: outcome.siteFailed });
    }
  }
  if (!sent) {
    handle.finish({ outcome: "unknown", message: "The transaction did not show up on chain. Check your wallet's activity; the command reports it as unknown.", hash: outcome.hash });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: outcome.hash, reason: "the wallet reported a transaction the chain does not show (replaced, dropped or still pending)", next: "superstables budget status --rail evm: read the allowance before granting again" }));
  }
  approveTx = sent.hash;
  approveBlock = { blockNumber: sent.blockNumber, blockHash: sent.blockHash, final: sent.final };
  const events = approvalsIn(sent.logs, pub.owner, pub.agent);
  console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, Approval events: ${events.map((v) => usdc(v)).join(", ") || "none"} ${SYM}`);
  if (sent.status !== "success" && !differsFromRequest(sent.problems, sent.siteFailed)) {
    handle.finish({ outcome: "failed", proof: "reverted", message: "The transaction reverted. No allowance was granted by it, but a network fee may have been charged.", hash: sent.hash });
    await closeOwnerPage();
    process.exit(result(1, { state: "failed", proof: "reverted", tx: sent.hash, reason: "the approve reverted on chain", next: "superstables budget status --rail evm" }));
  }
  // Any difference from the plan is a mismatch, whatever the allowance reads now: an edited higher allowance can be spent
  // down to the requested cap before the readback. The wallet already sent it, so the owner has to revoke it.
  if (sent.problems.length) {
    const reason = `${mismatchReason(sent.problems, sent.siteFailed, sent.hash)}${sent.status !== "success" ? "; it reverted on chain" : ""}. The budget was not recorded.`;
    console.log(`MISMATCH: ${reason}`);
    const now = await allowanceOf(pub.owner, pub.agent).catch(() => null);
    const steps = grantMismatchSteps(sent.logs, pub.owner, pub.agent, sent.hash);
    handle.finish({ outcome: "unknown", message: `${mismatchPage(sent.problems, sent.siteFailed, sent.hash, { ended: sent.status !== "success" ? "reverted on chain" : undefined })} The budget was not recorded. ${steps?.page ?? `Revoke it: ${REVOKE_HINT}`}`, hash: sent.hash });
    await closeOwnerPage();
    process.exit(result(3, { state: "mismatch", tx: sent.hash, reason, requested: usdc(cap), allowance: now === null ? null : usdc(now), next: steps?.next ?? "revoke (superstables budget revoke --rail evm) to bring the allowance to 0, then grant again" }));
  }
  if (sent.unresolved) {
    const reason = `the transaction is on chain, but whether it set the allowance is not known yet: ${sent.unresolved}. The budget was not recorded.`;
    console.log(`UNKNOWN: ${reason}`);
    handle.finish({ outcome: "unknown", message: "The transaction is on chain, but the command could not yet confirm what it did. The budget was not recorded; the command reports it as unknown.", hash: sent.hash });
    await closeOwnerPage();
    process.exit(result(5, { state: "unknown", tx: sent.hash, reason, requested: usdc(cap), next: "superstables budget status --rail evm: read the allowance before granting again" }));
  }
}

const allowance = await readUntil(() => allowanceOf(pub.owner, pub.agent), (v) => v === cap);
console.log(`allowance read back: ${usdc(allowance)} ${SYM} (requested ${usdc(cap)})`);
if (allowance !== cap) {
  const reason = `the allowance on chain is ${usdc(allowance)} ${SYM}, not the requested cap ${usdc(cap)}${allowance > cap ? ": the agent can spend MORE than the cap (the spending cap was changed in the wallet, or another amount was approved)" : ""}. The budget was not recorded.`;
  console.log(`REFUSED: ${reason}`);
  finishPage?.({ outcome: "unknown", message: `The chain now shows an allowance of ${usdc(allowance)} ${SYM}, not ${capWords(cap)}. The budget was not recorded. Revoke it: ${REVOKE_HINT}`, hash: approveTx ?? undefined });
  await closeOwnerPage();
  process.exit(result(3, { state: "mismatch", tx: approveTx, reason, requested: usdc(cap), allowance: usdc(allowance), next: "revoke (superstables budget revoke --rail evm) to bring the allowance to 0, then grant again" }));
}

// Final only when this approve's block is final and the endpoints agree the allowance is the cap at a final block at or after it
// (for --verify-only, which names no transaction, when they agree it is the cap at their final block).
let final = false;
if (approveTx && approveBlock) {
  const fin = approveBlock.final ?? (await finalityOf(approveTx as Hex, approveBlock)).final;
  const at = fin ? await allowanceAgreed(pub.owner, pub.agent, approveBlock.blockNumber) : null;
  final = fin && at !== null && at.agreed && at.value === cap;
} else {
  const at = await allowanceAgreed(pub.owner, pub.agent);
  final = at.agreed && at.value === cap;
}
const now = Math.floor(Date.now() / 1000);
const expiry = expiryIn ? now + expiryIn : undefined;
writePublic(
  { B4_CAP: String(cap), B4_SET_AT: String(now), ...(approveTx && approveBlock ? { B4_SET_TX: approveTx, B4_SET_BLOCK: String(approveBlock.blockNumber) } : {}), ...(expiry ? { B4_EXPIRY: String(expiry) } : {}) },
  ["B4_REVOKED_AT", "B4_REVOKED_TX", "B4_REVOKED_BLOCK", "B4_REVOKED_BY", ...(expiry ? [] : ["B4_EXPIRY"])],
);
console.log(`budget: ${usdc(cap)} ${SYM}, allowance == cap on chain.${approveTx ? ` ${tx(approveTx)}` : ""}`);
console.log(`no on-chain expiry and no on-chain period: the allowance stays until the agent spends it or someone revokes it${expiry ? `; advisory expiry ${new Date(expiry * 1000).toISOString()} is enforced only by buy's precheck, not by the chain` : ""}.`);
console.log(`maximum that can move: ${usdc(cap < ownerBal ? cap : ownerBal)} ${SYM} (min of the cap and the owner's balance ${usdc(ownerBal)}), to ANY address the agent names, until the owner revokes.`);
if (!final) console.log(`the approve is in a block and the allowance reads ${usdc(cap)} ${SYM}, but the chain has not made it final yet${usuallyWords()}`);
finishPage?.({ outcome: "confirmed", message: final ? `Done. The chain shows a budget of ${capWords(cap)} for your agent. You can close this page. To end it: ${REVOKE_HINT}` : landedGrant(cap), hash: approveTx ?? undefined });
await closeOwnerPage();
process.exit(result(0, { state: final ? "set" : "landed", final, tx: approveTx, cap: usdc(cap), allowance: usdc(allowance), maxMovable: usdc(cap < ownerBal ? cap : ownerBal), expiry: expiry ? new Date(expiry * 1000).toISOString() : null, enforcedOnChain: { expiry: false, period: false, sellers: false }, next: final ? "agent: buy" : `superstables budget status --rail evm${chainFlag} later: the grant is final when status says so${usuallyWords()}` }));
