import "./cli-guard.mjs";
// recover (B4): the owner stops the agent's authority and gets stranded USDC back, without the agent.
// Owner command: opens the owner key file only. That file holds B4_AGENT_KEY_ESCROW, a copy of the agent key, so the owner can
// sign as the agent. If the agent key has too little gas the owner sends a little gas token first.
//
// Order (authority first, so nothing can be pulled again while funds are moved):
//   1. STOP AUTHORITY  the allowance is lowered with selfRevoke (transferFrom(owner, owner, remaining), signed by the escrowed key);
//                      if the owner's balance was too low for that, with the owner's own approve(agent, 0). It must read 0 before step 2.
//   2. CANCEL / RETURN every operation of this agent whose pull landed without a settlement is made safe through the routine buy
//                      uses (cancel an open authorization, return the price, journal it). --op <id> limits this to one operation.
//   3. SWEEP           USDC stranded in the agent key that no journal explains goes back by a plain transfer. On a chain where USDC is the
//                      gas token (Arc) the agent keeps its gas reserve (chains.ts gas.reserveMax). Skipped with --op.
// --plan prints these steps for the current chain state and sends nothing (no key file is opened).
//
// npx tsx budget/evm/recover.ts [--chain <name>] [--op <id>] [--plan]
// Exit codes: 0 recovered (or planned), 1 incomplete or failed, 3 refused before anything was sent (unknown --op), 5 an operation is still unknown.
import { encodeFunctionData } from "viem";
import { pendingJournalsFor, makeSafe, readJournal, checkOpId, type Journal } from "./ops.ts";
import { SYM, CFG, GAS, arg, flag, cmd, emit, escrowCtx, readCtx, allowanceOf, usdcBalance, nativeBalance, usdc, gasFmt, send, sendNative, selfRevokeCore, readUntil, writePublic, erc20Abi, USDC } from "./lib.ts";

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
const ownerNativeBefore = await nativeBalance(pub.owner);
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

const needsGas = (held > 0n || allowance > 0n || pending.length > 0) && agentNativeBefore < MIN_GAS;
if (plan) {
  console.log("PLAN (nothing is sent):");
  if (needsGas) console.log(`  0. the agent key has too little gas: the owner sends ${gasFmt(GAS_TOPUP)} ${GAS.symbol}`);
  console.log(allowance > 0n ? `  1. stop authority: lower the allowance ${usdc(allowance)} ${SYM} to 0 (selfRevoke with the escrowed key; owner approve 0 for any rest)` : "  1. stop authority: the allowance is already 0");
  if (pending.length) for (const j of pending) console.log(`  2. operation ${j.op} (${j.state}, pulled ${j.pulled ?? "unknown"} ${SYM}, returned ${j.returned ?? "0"}): cancel the open authorization if any, return the price to the owner`);
  else console.log("  2. no journaled operation has funds stranded");
  console.log(opId ? "  3. sweep: skipped (--op)" : `  3. sweep: whatever the agent key holds above ${usdc(KEEP)} ${SYM} after step 2 goes to the owner (now ${usdc(held)} ${SYM})`);
  process.exit(emit("recover", 0, { state: "planned", op: opId ?? null, plan: { gasTopUp: needsGas ? gasFmt(GAS_TOPUP) : null, allowance: usdc(allowance), pendingOps: pending.map((j) => ({ op: j.op, state: j.state, pulled: j.pulled ?? null, returned: j.returned ?? "0" })), agentHolds: usdc(held), sweep: opId ? false : true }, next: `run ${cmd("recover.ts", `${opId ? `--op ${opId}` : ""}`.trim())} to send these steps` }));
}

const c = await escrowCtx(); // opens the owner file (key + escrowed agent key)
let topUp = 0n;
if (needsGas) {
  console.log(`the agent key has too little gas; the owner sends ${gasFmt(GAS_TOPUP)} ${GAS.symbol}`);
  await sendNative(c.wallet, c.agent, GAS_TOPUP, "gas top-up owner -> agent");
  topUp = GAS_TOPUP;
  await readUntil(() => nativeBalance(c.agent), (v) => v >= MIN_GAS);
}

// 1. STOP AUTHORITY, before anything else moves
console.log("== 1. stop authority");
const sr = await selfRevokeCore(c.escrow, c.owner);
console.log(`${sr.state}: ${sr.note}`);
let allowanceAfter = await allowanceOf(c.owner, c.agent);
let ownerRevokeTx: string | null = null;
if (allowanceAfter > 0n) {
  const sent = await send(c.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [c.agent, 0n] }), "recover: owner approve(agent, 0) for the rest");
  ownerRevokeTx = sent.hash;
  allowanceAfter = await readUntil(() => allowanceOf(c.owner, c.agent), (v) => v === 0n);
}
if (allowanceAfter !== 0n) {
  console.log(`the allowance still reads ${usdc(allowanceAfter)} ${SYM}; stopping before any funds are moved`);
  process.exit(emit("recover", 1, { state: "failed", op: opId ?? null, allowance: usdc(allowanceAfter), selfRevokeTx: sr.tx ?? null, ownerRevokeTx, reason: "the allowance could not be lowered to 0", next: `run ${cmd("recover.ts")} again, or the owner's revoke.ts` }));
}
writePublic({ B4_REVOKED_AT: String(Math.floor(Date.now() / 1000)) }, ["B4_CAP", "B4_EXPIRY", "B4_SET_AT"]);

// 2. CANCEL / RETURN journaled pulls
console.log("== 2. cancel open authorizations and return journaled pulls");
const madeSafe: { op: string; state: string; returned: string | null; returnTx: string | null }[] = [];
let returnedNow = 0n;
for (const j of pending) {
  const had = micro(j.returned);
  console.log(`operation ${j.op} (journal ${j.state}): the pull landed without a settlement; making it safe with the escrowed key`);
  const after = await makeSafe(j, c.escrow);
  returnedNow += micro(after.returned) - had;
  madeSafe.push({ op: after.op, state: after.state, returned: after.returned ?? null, returnTx: after.returnTx ?? null });
  console.log(`  -> ${after.state}${after.returned ? `, returned ${after.returned} ${SYM} (${after.returnTx})` : ""}${after.state === "failed" || after.state === "unknown" ? ` -- ${after.reason ?? ""}` : ""}`);
}
const heldNow = returnedNow > 0n ? await readUntil(() => usdcBalance(c.agent), (v) => v <= held - returnedNow) : await usdcBalance(c.agent);

// 3. SWEEP what no journal explains
let sweepTx: string | null = null;
let sweptNow = 0n;
if (!opId) {
  console.log("== 3. sweep");
  if (heldNow > KEEP) {
    const sweep = heldNow - KEEP;
    sweptNow = sweep;
    const sent = await send(c.escrow, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [c.owner, sweep] }), `recover: transfer ${usdc(sweep)} ${SYM} agent -> owner (escrowed key)`);
    sweepTx = sent.hash;
  } else console.log(`nothing above ${usdc(KEEP)} ${SYM} to sweep`);
}
const heldAfter = await readUntil(() => usdcBalance(c.agent), (v) => !!opId || v <= KEEP);
console.log(`agent key ${SYM} ${usdc(heldAfter)}, allowance ${usdc(allowanceAfter)}; owner gas spent ${gasFmt(ownerNativeBefore - (await nativeBalance(c.owner)))} ${GAS.symbol} (incl. ${gasFmt(topUp)} sent to the agent), agent gas spent ${gasFmt(agentNativeBefore + topUp - (await nativeBalance(c.agent)))} ${GAS.symbol}`);

const unknownOp = madeSafe.some((m) => m.state === "unknown" || m.state === "submitted");
const unreturned = madeSafe.some((m) => m.state === "failed" && !m.returned);
const stillHeld = !opId && heldAfter > KEEP;
const done = !unknownOp && !unreturned && !stillHeld;
const exit = done ? 0 : unknownOp && !unreturned && !stillHeld ? 5 : 1;
const state = done ? "ok" : exit === 5 ? "unknown" : "failed";
const next = done ? "none" : unknownOp ? `an operation is still undecided: run ${cmd("reconcile.ts", "--op <id>")} (read only) and, once the chain decides, ${cmd("recover.ts")} again` : `run ${cmd("recover.ts")} again`;
console.log(`recover: ${state}`);
process.exit(emit("recover", exit, {
  state, op: opId ?? null, swept: usdc(returnedNow + sweptNow), // journaled returns plus the plain sweep (on a gas-in-USDC chain the reserve is not swept)
  sweepTx: sweepTx ?? madeSafe.find((m) => m.returnTx)?.returnTx ?? null, sweepBy: sweepTx ? "transfer" : madeSafe.some((m) => m.returnTx) ? "journaled return" : "none",
  madeSafe, selfRevokeTx: sr.tx ?? null, ownerRevokeTx, agentHolds: usdc(heldAfter), allowance: usdc(allowanceAfter), next,
}));
