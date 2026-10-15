import "./cli-guard.mjs";
import { requireRecordLock, requireKeyLock } from "../op-lock.mjs";
// recover (B4): stop the agent's authority and get stranded USDC back to the owner.
// The agent-side steps are signed by the agent key file (it is on this machine). The owner's steps go through the owner's
// own wallet (owner page, owner.ts), each as its own approval, and only when needed. No owner key file is used unless
// --owner-key-file <path> names one (tests and automation); that file may also hold B4_AGENT_KEY_ESCROW, a copy of the
// agent key, which is used only when there is no agent key file here.
//
// Order (authority first, so nothing can be pulled again while funds are moved):
//   1. STOP AUTHORITY  the agent lowers its own allowance with selfRevoke (transferFrom(owner, owner, remaining), agent key).
//                      Unless that revoke was mined, brought the allowance to 0 and a later read shows 0, the owner approves 0
//                      in the wallet (or with --owner-key-file), even when the allowance already reads 0: one read proves nothing.
//                      It must read 0 before step 2.
//   2. CANCEL / RETURN every operation of this agent whose pull landed without a settlement is made safe through the routine buy
//                      uses (cancel an open authorization, return the price, journal it). --op <id> limits this to one operation.
//   3. SWEEP           USDC stranded in the agent key that no journal explains goes back by a plain transfer. On a chain where USDC is the
//                      gas token (Arc) the agent keeps its gas reserve (chains.ts gas.reserveMax). Skipped with --op. Only when every journal
//                      file of this chain can be read and no operation of this agent can still move money (ops.ts sweepBlockers);
//                      otherwise skipped, and the outcome is unknown.
//   Every agent step checks first that the agent can pay for it at the current fee (lib.ts agentGas: the chain's gas limits x fee
//   cap). Steps 2 and 3 need gas for each cancel and return: if the agent has too little, the owner sends what is missing first
//   (in the wallet; at least the chain's gas.topUp).
// --plan prints these steps for the current chain state and sends nothing (no key file, no page).
//
// npx tsx budget/evm/recover.ts [--chain <name>] [--op <id>] [--plan] [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 recovered (or planned), 1 incomplete or failed, 3 refused before anything was sent (unknown --op, the owner
// rejected or the link expired), 5 an operation is still unknown, or the sweep was skipped (a journal cannot be read, or an
// operation can still move money).
import { existsSync } from "node:fs";
import { encodeFunctionData, parseUnits, type Hex } from "viem";
import { pendingJournalsFor, makeSafe, readJournal, checkOpId, scanJournals, sweepBlockers, atomicUsdc, type Journal, type SweepBlockers } from "./ops.ts";
import { OPS_DIR, SYM, CFG, GAS, AGENT_ENV, OWNER_KEY_FILE, arg, flag, cmd, emit, agentCtx, ownerCtx, escrowCtx, readCtx, allowanceOf, usdcBalance, nativeBalance, usdc, oneLine, gasFmt, send, sendNative, selfRevokeCore, readUntil, writePublic, erc20Abi, USDC, assertRpcChain, agentGas, gasWords, gasRound, GasShort, type Wallet, type SelfRevoke, type GasOp, type GasNeed } from "./lib.ts";
import { revokeInWallet, fundInWallet } from "./owner.ts";

const plan = flag("plan");
const opId = arg("op") ? checkOpId(arg("op")!) : undefined;
const KEEP = GAS.isUsdc ? GAS.reserveMax! : 0n; // the agent keeps this much USDC (its gas reserve)
/** What the owner sends an agent short on gas: what is missing (rounded up), at least the chain's gas.topUp. */
const topUpFor = (g: GasNeed) => { const missing = parseUnits(gasRound(g.need - g.have, "up"), GAS.decimals); return missing > GAS.topUp ? missing : GAS.topUp; };
const atomic = (v?: string) => atomicUsdc(v ?? "0") ?? 0n; // only for the swept total, which is reporting and a wait, never a transfer: a pending journal is re-read through readJournal, without the scan's check on its amounts

const pub = readCtx(); // public addresses, no secret
const held = await usdcBalance(pub.agent);
const allowance = await allowanceOf(pub.owner, pub.agent);
const agentNativeBefore = await nativeBalance(pub.agent);
console.log(`${CFG.label}: agent key holds ${usdc(held)} ${SYM} and ${gasFmt(agentNativeBefore)} ${GAS.symbol} (native); allowance ${usdc(allowance)} ${SYM}`);

// Every journal file is read without stopping (ops.ts scanJournals): one that cannot be read is named, never skipped.
const scan = scanJournals(pub.agent);
const named = (s: string) => oneLine(JSON.stringify(s), 120);
for (const u of scan.unreadable) console.log(`journal ${named(u.file)} cannot be read: ${u.why}. ${opId ? "It is left as it is" : "recover returns nothing it would explain and does not sweep while it is there"}`);
let pending: Journal[];
if (opId) {
  const j = readJournal(opId);
  if (!j || j.agent.toLowerCase() !== pub.agent.toLowerCase()) {
    console.log(`REFUSED: no journal for operation ${opId} of this agent on ${CFG.label}. Nothing was sent.`);
    process.exit(emit("recover", 3, { op: opId, state: "refused_precheck", reason: `no journal for operation ${opId} of this agent on ${CFG.key}`, next: "check --op and --chain (reconcile.ts --op reads a journal)" }));
  }
  pending = pendingJournalsFor(pub.agent, scan).filter((p) => p.op === opId);
  if (!pending.length) console.log(`operation ${opId} is ${j.state}${j.returned ? ` (returned ${j.returned} ${SYM})` : ""}: nothing stranded for it`);
} else pending = pendingJournalsFor(pub.agent, scan);

// Re-read the planned operations after taking the same locks used by buy and reconcile.
for (const id of opId ? [opId] : pending.map(j => j.op)) requireRecordLock(OPS_DIR, id);
pending = pending.flatMap(j => { const current = readJournal(j.op); return current ? [current] : []; });

const sweepPlanned = !opId && scan.unreadable.length === 0;
const returnsNeeded = pending.length > 0 || (sweepPlanned && held > KEEP);
// Gas for the agent's own steps at the current fee: selfRevoke (step 1), then a cancel and a return per pending operation and the sweep.
const returnOps: GasOp[] = [...pending.flatMap((): GasOp[] => ["cancel", "return"]), ...(sweepPlanned && held > KEEP ? (["return"] as GasOp[]) : [])];
const revokeGas = await agentGas(pub.agent, ["selfRevoke"]);
const agentHasGas = revokeGas.ok;
const plannedGas = returnsNeeded ? await agentGas(pub.agent, allowance > 0n && agentHasGas ? ["selfRevoke", ...returnOps] : returnOps) : null;
const owner = OWNER_KEY_FILE ? "the owner (key file)" : "the owner, in their wallet,";
if (plan) {
  console.log("PLAN (nothing is sent):");
  if (allowance === 0n) console.log(`  1. stop authority: the allowance reads 0; ${owner} still approves 0 (one read is not proof that nothing is live)`);
  else if (agentHasGas) console.log(`  1. stop authority: the agent lowers the allowance ${usdc(allowance)} ${SYM} to 0 (selfRevoke, agent key); if some is left, ${owner} approves 0`);
  else console.log(`  1. stop authority: ${gasWords(revokeGas, "its selfRevoke")}, so ${owner} approves 0 (the allowance is ${usdc(allowance)} ${SYM})`);
  if (plannedGas && !plannedGas.ok) console.log(`  2a. ${gasWords(plannedGas, "returning the funds")}: ${owner} sends it ${gasFmt(topUpFor(plannedGas))} ${GAS.symbol}`);
  if (pending.length) for (const j of pending) console.log(`  2. operation ${j.op} (${j.state}, pulled ${j.pulled ?? "unknown"} ${SYM}, returned ${j.returned ?? "0"}): cancel the open authorization if any, return the price to the owner (agent key)`);
  else console.log("  2. no journaled operation has funds stranded");
  for (const u of scan.unreadable) console.log(`  !  ${named(u.file)} cannot be read (${u.why})`);
  console.log(opId ? "  3. sweep: skipped (--op)" : !sweepPlanned ? `  3. sweep: skipped: ${scan.unreadable.length} journal file(s) cannot be read` : `  3. sweep: whatever the agent key holds above ${usdc(KEEP)} ${SYM} after step 2 goes to the owner, once every journal of this agent is read again and none can still move money (agent key; now ${usdc(held)} ${SYM})`);
  process.exit(emit("recover", 0, { state: "planned", op: opId ?? null, plan: { gasTopUp: plannedGas && !plannedGas.ok ? gasFmt(topUpFor(plannedGas)) : null, ownerRevoke: allowance === 0n || !agentHasGas, unreadable: scan.unreadable, allowance: usdc(allowance), pendingOps: pending.map((j) => ({ op: j.op, state: j.state, pulled: j.pulled ?? null, returned: j.returned ?? "0" })), agentHolds: usdc(held), sweep: sweepPlanned }, next: `run superstables budget recover --rail evm --chain ${CFG.key}${opId ? ` --op ${opId}` : ""} to send these steps` }));
}

// One process at a time sends from this agent key on this chain: a purchase holds the key lock to its end, and recover takes it
// (after the operation locks above, as buy does) before it sends anything. The exit listener releases it.
const keyLock = await requireKeyLock(OPS_DIR, pub.agent, { waitMs: 120_000, onWait: () => console.log("waiting for a purchase on this agent key to finish before recover sends anything") });
if (!keyLock.ok) process.exit(emit("recover", 3, { state: "refused_precheck", op: opId ?? null, reason: "agent_key_busy", next: `a purchase on this agent key is still running (${keyLock.details}); wait for its RESULT, then run recover again. Nothing was sent` }));

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
if (allowance > 0n && !agentHasGas) console.log(`${gasWords(revokeGas, "its selfRevoke")}: the owner revokes instead`);
if (allowance > 0n && agentHasGas) {
  try {
    sr = await selfRevokeCore(agentWallet, pub.owner);
    console.log(`${sr.state}: ${sr.note}`);
  } catch (e) {
    if (!(e instanceof GasShort)) throw e;
    console.log(`selfRevoke not sent: ${gasWords(e.g, "it")} (the fee rose). The owner revokes instead`);
  }
}
let allowanceAfter = await allowanceOf(pub.owner, pub.agent);
let ownerRevokeTx: string | null = null;
// The owner's approve(agent, 0) is skipped only when the agent's own revoke in this run was mined and brought the
// allowance to 0 (selfRevokeCore read 0 after it), and this later read shows 0 too.
const selfRevokeProven = !!sr?.tx && sr.state === "revoked" && allowanceAfter === 0n;
if (!selfRevokeProven) {
  console.log(allowanceAfter > 0n ? `the allowance still reads ${usdc(allowanceAfter)} ${SYM}: the owner closes it (approve 0)` : "the allowance reads 0 on this RPC, and no revoke in this run proves it: the owner approves 0 anyway");
  if (ownerKey) ownerRevokeTx = (await send(ownerKey.wallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [pub.agent, 0n] }), "recover: owner approve(agent, 0) for the rest")).hash;
  else ownerRevokeTx = await revokeInWallet("recover", pub.owner, pub.agent, "Revoke before recovering funds", sr?.tx
    ? { result: { selfRevokeTx: sr.tx }, done: `the agent's own revoke ${sr.tx} landed (${sr.state}) and lowered the allowance; only the rest needs the owner`, stepTx: "ownerRevokeTx" }
    : { result: {}, stepTx: "ownerRevokeTx" });
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
// What the revoke step completed, said in the past tense: a later step can't vouch for the allowance now (a wallet may have
// sent something else), only for what was read before it.
const revokes = [sr?.tx && `the agent's own revoke ${sr.tx}`, ownerRevokeTx && `the owner's revoke ${ownerRevokeTx}`].filter(Boolean).join(" and ");
const revoked = { selfRevokeTx: sr?.tx ?? null, ownerRevokeTx, allowanceAfterRevoke: usdc(allowanceAfter) };
const revokedWords = `the allowance read 0${revokes ? ` after ${revokes}` : ""} before this step. No funds were returned yet`;
try {
  const returnGas = returnOps.length ? await agentGas(pub.agent, returnOps) : null;
  if (returnGas && !returnGas.ok) {
    topUp = topUpFor(returnGas);
    console.log(`${gasWords(returnGas, "returning the funds")}; the owner sends ${gasFmt(topUp)} ${GAS.symbol}`);
    if (ownerKey) gasTx = (await sendNative(ownerKey.wallet, pub.agent, topUp, "gas top-up owner -> agent")).hash;
    else gasTx = await fundInWallet("recover", pub.owner, pub.agent, topUp, gasFmt(topUp), returnGas.have, { result: revoked, done: revokedWords, stepTx: "gasTx" });
    await readUntil(() => nativeBalance(pub.agent), (v) => v >= returnGas.have + topUp);
  }
} catch (e) {
  // an error here (an RPC read, the wallet page) must not lose the revoke that already landed. A gas transfer the chain shows
  // reverted (sendNative names its hash) is a failure; anything else may or may not have sent the gas, so it is unknown.
  const reverted = (e as { txHash?: Hex }).txHash;
  const reason = `recover stopped at the gas step: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  console.log(`${reverted ? "FAILED" : "UNKNOWN"}: ${reason}`);
  const doctor = `superstables budget doctor --rail evm${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`}`;
  process.exit(emit("recover", reverted ? 1 : 5, { state: reverted ? "failed" : "unknown", ...(reverted ? { proof: "reverted" } : {}), op: opId ?? null, ...revoked, gasTx: reverted ?? gasTx, reason, next: `${revokedWords}. ${doctor}: read the agent's gas and the allowance, then run recover again` }));
}

// 2. CANCEL / RETURN journaled pulls
console.log("== 2. cancel open authorizations and return journaled pulls");
const madeSafe: { op: string; state: string; returned: string | null; returnTx: string | null }[] = [];
let returnedNow = 0n;
for (const j of pending) {
  const had = atomic(j.returned);
  console.log(`operation ${j.op} (journal ${j.state}): the pull landed without a settlement; making it safe with the agent key`);
  const after = await makeSafe(j, agentWallet);
  returnedNow += atomic(after.returned) - had;
  madeSafe.push({ op: after.op, state: after.state, returned: after.returned ?? null, returnTx: after.returnTx ?? null });
  console.log(`  -> ${after.state}${after.returned ? `, returned ${after.returned} ${SYM} (${after.returnTx})` : ""}${after.state === "failed" || after.state === "unknown" ? ` -- ${after.reason ?? ""}` : ""}`);
}
const heldNow = returnedNow > 0n ? await readUntil(() => usdcBalance(pub.agent), (v) => v <= held - returnedNow) : await usdcBalance(pub.agent);

// 3. SWEEP what no journal explains: only when every journal of this agent can be read and none can still move money
let sweepTx: string | null = null;
let sweptNow = 0n;
let blockers: SweepBlockers | null = null;
let sweepSkipped = "";
if (!opId) {
  console.log("== 3. sweep");
  blockers = await sweepBlockers(pub.agent); // reads every journal again: a buy that wrote one after the first scan is seen here
  sweepSkipped = [
    blockers.unreadable.length ? `${blockers.unreadable.length} journal file(s) in ${OPS_DIR} cannot be read (${blockers.unreadable.slice(0, 3).map((u) => `${named(u.file)}: ${u.why}`).join("; ")})` : "",
    blockers.undecided.length ? `${blockers.undecided.length} operation(s) of this agent can still move money (${blockers.undecided.slice(0, 3).map((u) => `${named(u.op)}: ${u.why}`).join("; ")})` : "",
  ].filter(Boolean).join(", and ");
  if (sweepSkipped) {
    console.log(`sweep skipped: ${sweepSkipped}. Nothing was swept`);
    // every blocker on its own line (the line above names at most three of each): the dispatcher passes these lines on
    for (const u of blockers.unreadable) console.log(`journal ${named(u.file)} cannot be read: ${u.why}`);
    for (const u of blockers.undecided) console.log(`operation ${named(u.op)} can still move money: ${u.why}`);
  }
  else if (heldNow > KEEP) {
    const sweep = heldNow - KEEP;
    sweptNow = sweep;
    try {
      const sent = await send(agentWallet, USDC, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [pub.owner, sweep] }), `recover: transfer ${usdc(sweep)} ${SYM} agent -> owner (agent key)`, { op: "return" });
      sweepTx = sent.hash;
    } catch (e) {
      if (!(e instanceof GasShort)) throw e;
      sweptNow = 0n;
      console.log(`sweep not sent: ${gasWords(e.g, "the sweep")} (the fee rose). Nothing was signed`);
    }
  } else console.log(`nothing above ${usdc(KEEP)} ${SYM} to sweep`);
}
const heldAfter = await readUntil(() => usdcBalance(pub.agent), (v) => !!opId || !!sweepSkipped || v <= KEEP);
console.log(`agent key ${SYM} ${usdc(heldAfter)}, allowance ${usdc(allowanceAfter)}; agent gas spent ${gasFmt(agentNativeBefore + topUp - (await nativeBalance(pub.agent)))} ${GAS.symbol}${topUp ? ` (after ${gasFmt(topUp)} from the owner)` : ""}`);

const unknownOp = madeSafe.some((m) => m.state === "unknown" || m.state === "submitted");
const unreturned = madeSafe.some((m) => m.state === "failed" && !m.returned);
const stillHeld = !opId && !sweepSkipped && heldAfter > KEEP;
const done = !unknownOp && !unreturned && !stillHeld && !sweepSkipped;
const exit = done ? 0 : (unknownOp || !!sweepSkipped) && !unreturned && !stillHeld ? 5 : 1;
const state = done ? "ok" : exit === 5 ? "unknown" : "failed";
const next = done ? "none"
  : sweepSkipped ? `${[
      blockers!.unreadable.length ? `the owner checks each journal file listed above as one that cannot be read: recover sweeps only when every journal in ${OPS_DIR} can be read` : "",
      blockers!.undecided.length ? `run ${cmd("reconcile.ts", "--op <id>")} (read only) for each operation listed above as able to move money and, once the chain decides it, recover again` : "",
    ].filter(Boolean).join("; ")}. Nothing was swept. Never pay again for these operations`
  : unknownOp ? `an operation is still undecided: run ${cmd("reconcile.ts", "--op <id>")} (read only) and, once the chain decides, recover again` : "run recover again";
console.log(`recover: ${state}`);
process.exit(emit("recover", exit, {
  state, op: opId ?? null, swept: usdc(returnedNow + sweptNow), // journaled returns plus the plain sweep (on a gas-in-USDC chain the reserve is not swept)
  sweepTx: sweepTx ?? madeSafe.find((m) => m.returnTx)?.returnTx ?? null, sweepBy: sweepTx ? "transfer" : madeSafe.some((m) => m.returnTx) ? "journaled return" : "none",
  madeSafe, selfRevokeTx: sr?.tx ?? null, ownerRevokeTx, gasTx, agentHolds: usdc(heldAfter), allowance: usdc(allowanceAfter),
  unreadable: (blockers ?? scan).unreadable, undecided: blockers?.undecided ?? [], ...(sweepSkipped ? { reason: `sweep skipped: ${sweepSkipped}` } : {}), next,
}));
