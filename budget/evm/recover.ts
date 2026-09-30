import "./cli-guard.mjs";
// recover (B4): stop the agent's authority and get stranded USDC back to the owner.
// The agent-side steps are signed by the agent key file (it is on this machine). The owner's steps go through the owner's
// own wallet (owner page, owner.ts), each as its own approval, and only when needed. No owner key file is used unless
// --owner-key-file <path> names one (tests and automation); that file may also hold B4_AGENT_KEY_ESCROW, a copy of the
// agent key, which is used only when there is no agent key file here.
//
// Order (authority first, so nothing can be pulled again while funds are moved):
//   1. STOP AUTHORITY  the agent lowers its own allowance with selfRevoke (transferFrom(owner, owner, remaining), agent key).
//                      If the owner's balance was too low for that, or the agent has no gas, the owner approves 0 in the wallet.
//                      It must read 0 before step 2.
//   2. CANCEL / RETURN every operation of this agent whose pull landed without a settlement is made safe through the routine buy
//                      uses (cancel an open authorization, return the price, journal it). --op <id> limits this to one operation.
//   3. SWEEP           USDC stranded in the agent key that no journal explains goes back by a plain transfer. On a chain where USDC is the
//                      gas token (Arc) the agent keeps its gas reserve (chains.ts gas.reserveMax). Skipped with --op.
//   Steps 2 and 3 need gas in the agent key: if it has too little, the owner sends some first (in the wallet).
// --plan prints these steps for the current chain state and sends nothing (no key file, no page).
//
// npx tsx budget/evm/recover.ts [--chain <name>] [--op <id>] [--plan] [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 recovered (or planned), 1 incomplete or failed, 3 refused before anything was sent (unknown --op, the owner
// rejected or the link expired), 5 an operation is still unknown.
import { existsSync } from "node:fs";
import { encodeFunctionData, type Hex } from "viem";
import { pendingJournalsFor, makeSafe, readJournal, checkOpId, type Journal } from "./ops.ts";
import { SYM, CFG, GAS, AGENT_ENV, OWNER_KEY_FILE, arg, flag, cmd, emit, agentCtx, ownerCtx, escrowCtx, readCtx, allowanceOf, usdcBalance, nativeBalance, usdc, gasFmt, send, sendNative, selfRevokeCore, readUntil, writePublic, erc20Abi, USDC, assertRpcChain, type Wallet, type SelfRevoke } from "./lib.ts";
import { revokeInWallet, fundInWallet } from "./owner.ts";

const plan = flag("plan");
const opId = arg("op") ? checkOpId(arg("op")!) : undefined;
const KEEP = GAS.isUsdc ? GAS.reserveMax! : 0n; // the agent keeps this much USDC (its gas reserve)
const GAS_TOPUP = GAS.topUp;
const MIN_GAS = GAS.minAgent;
const micro = (v?: string) => BigInt(Math.round(Number(v ?? "0") * 1e6));

const pub = readCtx(); // public addresses, no secret
const held = await usdcBalance(pub.agent);
const allowance = await allowanceOf(pub.owner, pub.agent);
const agentNativeBefore = await nativeBalance(pub.agent);
console.log(`${CFG.label}: agent key holds ${usdc(held)} ${SYM} and ${gasFmt(agentNativeBefore)} ${GAS.symbol} (native); allowance ${usdc(allowance)} ${SYM}`);

let pending: Journal[];
if (opId) {
  const j = readJournal(opId);
  if (!j || j.agent.toLowerCase() !== pub.agent.toLowerCase()) {
    console.log(`REFUSED: no journal for operation ${opId} of this agent on ${CFG.label}. Nothing was sent.`);
    process.exit(emit("recover", 3, { op: opId, state: "refused_precheck", reason: `no journal for operation ${opId} of this agent on ${CFG.key}`, next: "check --op and --chain (reconcile.ts --op reads a journal)" }));
  }
  pending = pendingJournalsFor(pub.agent).filter((p) => p.op === opId);
  if (!pending.length) console.log(`operation ${opId} is ${j.state}${j.returned ? ` (returned ${j.returned} ${SYM})` : ""}: nothing stranded for it`);
} else pending = pendingJournalsFor(pub.agent);

const agentHasGas = agentNativeBefore >= MIN_GAS;
const returnsNeeded = pending.length > 0 || (!opId && held > KEEP);
const owner = OWNER_KEY_FILE ? "the owner (key file)" : "the owner, in their wallet,";
if (plan) {
  console.log("PLAN (nothing is sent):");
  if (allowance === 0n) console.log("  1. stop authority: the allowance is already 0");
  else if (agentHasGas) console.log(`  1. stop authority: the agent lowers the allowance ${usdc(allowance)} ${SYM} to 0 (selfRevoke, agent key); if some is left, ${owner} approves 0`);
  else console.log(`  1. stop authority: the agent has no gas, so ${owner} approves 0 (the allowance is ${usdc(allowance)} ${SYM})`);
  if (returnsNeeded && !agentHasGas) console.log(`  2a. the agent key has too little gas: ${owner} sends it ${gasFmt(GAS_TOPUP)} ${GAS.symbol}`);
  if (pending.length) for (const j of pending) console.log(`  2. operation ${j.op} (${j.state}, pulled ${j.pulled ?? "unknown"} ${SYM}, returned ${j.returned ?? "0"}): cancel the open authorization if any, return the price to the owner (agent key)`);
  else console.log("  2. no journaled operation has funds stranded");
  console.log(opId ? "  3. sweep: skipped (--op)" : `  3. sweep: whatever the agent key holds above ${usdc(KEEP)} ${SYM} after step 2 goes to the owner (agent key; now ${usdc(held)} ${SYM})`);
  process.exit(emit("recover", 0, { state: "planned", op: opId ?? null, plan: { gasTopUp: returnsNeeded && !agentHasGas ? gasFmt(GAS_TOPUP) : null, ownerRevoke: allowance > 0n && !agentHasGas, allowance: usdc(allowance), pendingOps: pending.map((j) => ({ op: j.op, state: j.state, pulled: j.pulled ?? null, returned: j.returned ?? "0" })), agentHolds: usdc(held), sweep: opId ? false : true }, next: `run superstables budget recover --rail evm --chain ${CFG.key}${opId ? ` --op ${opId}` : ""} to send these steps` }));
}

await assertRpcChain();
// The agent's own key signs the agent-side steps. Only without an agent file here, an escrowed copy in the owner key file.
let agentWallet: Wallet;
if (existsSync(AGENT_ENV)) agentWallet = (await agentCtx()).wallet;
else if (OWNER_KEY_FILE) agentWallet = (await escrowCtx()).escrow;
else {
  console.log(`REFUSED: there is no agent key file (${AGENT_ENV}) on this machine, so the agent-side steps cannot be signed. Nothing was sent.`);
  process.exit(emit("recover", 3, { state: "refused_precheck", reason: `no agent key file at ${AGENT_ENV}`, next: "run recover where the agent key is; the owner can still revoke from any machine (superstables budget revoke --rail evm)" }));
}
const ownerKey = OWNER_KEY_FILE ? await ownerCtx() : null;

// 1. STOP AUTHORITY, before anything else moves
console.log("== 1. stop authority");
let sr: SelfRevoke | null = null;
if (allowance > 0n && agentHasGas) {
  sr = await selfRevokeCore(agentWallet, pub.owner);
  console.log(`${sr.state}: ${sr.note}`);
}
let allowanceAfter = await allowanceOf(pub.owner, pub.agent);
let ownerRevokeTx: string | null = null;
if (allowanceAfter > 0n) {
  console.log(`the allowance still reads ${usdc(allowanceAfter)} ${SYM}: the owner closes it (approve 0)`);
  if (ownerKey) ownerRevokeTx = (await send(ownerKey.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pub.agent, 0n] }), "recover: owner approve(agent, 0) for the rest")).hash;
  else ownerRevokeTx = await revokeInWallet("recover", pub.owner, pub.agent, "Revoke before recovering funds");
  allowanceAfter = await readUntil(() => allowanceOf(pub.owner, pub.agent), (v) => v === 0n);
}
if (allowanceAfter !== 0n) {
  console.log(`the allowance still reads ${usdc(allowanceAfter)} ${SYM}; stopping before any funds are moved`);
  process.exit(emit("recover", 1, { state: "failed", op: opId ?? null, allowance: usdc(allowanceAfter), selfRevokeTx: sr?.tx ?? null, ownerRevokeTx, reason: "the allowance could not be lowered to 0", next: "run recover again, or the owner's revoke" }));
}
writePublic({ B4_REVOKED_AT: String(Math.floor(Date.now() / 1000)) }, ["B4_CAP", "B4_EXPIRY", "B4_SET_AT"]);

// gas for the agent-side returns
let topUp = 0n;
let gasTx: Hex | null = null;
if (returnsNeeded && (await nativeBalance(pub.agent)) < MIN_GAS) {
  console.log(`the agent key has too little gas to return funds; the owner sends ${gasFmt(GAS_TOPUP)} ${GAS.symbol}`);
  if (ownerKey) gasTx = (await sendNative(ownerKey.wallet, pub.agent, GAS_TOPUP, "gas top-up owner -> agent")).hash;
  else gasTx = await fundInWallet("recover", pub.owner, pub.agent, GAS_TOPUP, gasFmt(GAS_TOPUP), await nativeBalance(pub.agent));
  topUp = GAS_TOPUP;
  await readUntil(() => nativeBalance(pub.agent), (v) => v >= MIN_GAS);
}

// 2. CANCEL / RETURN journaled pulls
console.log("== 2. cancel open authorizations and return journaled pulls");
const madeSafe: { op: string; state: string; returned: string | null; returnTx: string | null }[] = [];
let returnedNow = 0n;
for (const j of pending) {
  const had = micro(j.returned);
  console.log(`operation ${j.op} (journal ${j.state}): the pull landed without a settlement; making it safe with the agent key`);
  const after = await makeSafe(j, agentWallet);
  returnedNow += micro(after.returned) - had;
  madeSafe.push({ op: after.op, state: after.state, returned: after.returned ?? null, returnTx: after.returnTx ?? null });
  console.log(`  -> ${after.state}${after.returned ? `, returned ${after.returned} ${SYM} (${after.returnTx})` : ""}${after.state === "failed" || after.state === "unknown" ? ` -- ${after.reason ?? ""}` : ""}`);
}
const heldNow = returnedNow > 0n ? await readUntil(() => usdcBalance(pub.agent), (v) => v <= held - returnedNow) : await usdcBalance(pub.agent);

// 3. SWEEP what no journal explains
let sweepTx: string | null = null;
let sweptNow = 0n;
if (!opId) {
  console.log("== 3. sweep");
  if (heldNow > KEEP) {
    const sweep = heldNow - KEEP;
    sweptNow = sweep;
    const sent = await send(agentWallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [pub.owner, sweep] }), `recover: transfer ${usdc(sweep)} ${SYM} agent -> owner (agent key)`);
    sweepTx = sent.hash;
  } else console.log(`nothing above ${usdc(KEEP)} ${SYM} to sweep`);
}
const heldAfter = await readUntil(() => usdcBalance(pub.agent), (v) => !!opId || v <= KEEP);
console.log(`agent key ${SYM} ${usdc(heldAfter)}, allowance ${usdc(allowanceAfter)}; agent gas spent ${gasFmt(agentNativeBefore + topUp - (await nativeBalance(pub.agent)))} ${GAS.symbol}${topUp ? ` (after ${gasFmt(topUp)} from the owner)` : ""}`);

const unknownOp = madeSafe.some((m) => m.state === "unknown" || m.state === "submitted");
const unreturned = madeSafe.some((m) => m.state === "failed" && !m.returned);
const stillHeld = !opId && heldAfter > KEEP;
const done = !unknownOp && !unreturned && !stillHeld;
const exit = done ? 0 : unknownOp && !unreturned && !stillHeld ? 5 : 1;
const state = done ? "ok" : exit === 5 ? "unknown" : "failed";
const next = done ? "none" : unknownOp ? `an operation is still undecided: run ${cmd("reconcile.ts", "--op <id>")} (read only) and, once the chain decides, recover again` : "run recover again";
console.log(`recover: ${state}`);
process.exit(emit("recover", exit, {
  state, op: opId ?? null, swept: usdc(returnedNow + sweptNow), // journaled returns plus the plain sweep (on a gas-in-USDC chain the reserve is not swept)
  sweepTx: sweepTx ?? madeSafe.find((m) => m.returnTx)?.returnTx ?? null, sweepBy: sweepTx ? "transfer" : madeSafe.some((m) => m.returnTx) ? "journaled return" : "none",
  madeSafe, selfRevokeTx: sr?.tx ?? null, ownerRevokeTx, gasTx, agentHolds: usdc(heldAfter), allowance: usdc(allowanceAfter), next,
}));
