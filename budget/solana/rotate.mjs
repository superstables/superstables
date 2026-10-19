// The Solana steps of `superstables budget rotate` that no other script does (the orchestration is budget/rotate.mjs, run by
// budget/cli.mjs). Devnet only.
//   --address              the address of the agent key file (read only; the key is never printed)
//   --balances             read only: the agent's SOL and USDC, and the operations still open or unreadable. The plan.
//   --sweep                the agent key signs two transfers back to the owner on record: its whole USDC balance (transferChecked
//                          to the owner's USDC account), then its SOL minus the fee. Nothing goes anywhere else.
//                          It reports final: true only once every transfer it sent is finalized (waiting up to a minute); `tx` holds the
//                          signatures, so a later run can read them instead of sending again.
//   --confirm <sigs>       read only: the sweep's signatures (comma-separated) at finalized commitment: state final, pending, failed or
//                          not_found (no endpoint has one of them: it never landed).
//   --clear-agent <addr>   remove that agent from the public file (the owner, the approvals mode and the site stay).
// Exit codes: 0 done, 1 a transfer failed on chain, 2 bad flags, 3 refused before anything was sent, 5 a transfer's outcome is unknown.
import { readdirSync } from "node:fs";
import { SystemProgram, Transaction } from "@solana/web3.js";
import { CLUSTER_NEXT, OPS_DIR, PUBLIC_PATH, USDC_DECIMALS, USDC_MINT, clusterProblem, connection, explorerTx, formatUnits, loadAgent, oneLine, parseEnvFile, parseStrict, readPublic, retryRead, sleep, writePublic } from "./lib.mjs";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccountOrNull } from "./token.mjs";
import { OP_ID_RE } from "./ops.mjs";
import { readRegularFile } from "../secret-file.mjs";
import { SETUP_KEYS } from "../owner-binding.mjs";
import { solanaOpProblem } from "../journal.mjs";

const USAGE = `Usage: node budget/solana/rotate.mjs (--address | --balances | --sweep | --confirm <signatures> | --clear-agent <address>)

Steps of superstables budget rotate. Devnet only.

  --address              print the address of the agent key file (read only)
  --balances             read only: the agent's SOL and USDC, and the operations still open
  --sweep                the agent key returns its USDC and SOL to the owner on record (the only transfers it signs)
  --confirm <sigs>       read only: whether the signatures of an earlier sweep (comma-separated) are finalized
  --clear-agent <addr>   remove that agent from the public file
  -h, --help             show this help`;

/** What a rotated chain forgets about the old agent: its address, the revoke mark and the link that named it. */
export const CLEARED_KEYS = ["SOLANA_AGENT_ADDRESS", "REVOKED_AT", "REVOKED_TX", "REVOKED_SLOT", "GRANT_TX", "GRANT_SLOT", "LINK_ID", "LINK_CODE", ...SETUP_KEYS];
/** A transfer by a key that signs alone: five thousand lamports a signature. */
const FEE_LAMPORTS = 5000n;
/** Operations in these states cannot move money any more. */
const CLOSED = new Set(["settled", "failed", "refused_precheck", "refused_chain"]);

const flags = parseStrict(process.argv.slice(2), { address: "bool", balances: "bool", sweep: "bool", confirm: "value", "clear-agent": "value" }, { usage: USAGE });
if ([flags.address, flags.balances, flags.sweep, flags.confirm !== undefined, flags["clear-agent"] !== undefined].filter(Boolean).length !== 1) {
  console.error(`Error: give exactly one of --address, --balances, --sweep, --confirm and --clear-agent\n\n${USAGE}`);
  process.exit(2);
}

const result = (exit, o) => {
  console.log(`RESULT ${JSON.stringify({ ok: exit === 0, command: "rotate", rail: "solana", chain: "devnet", ...o })}`);
  return exit;
};
const refuse = (reason, next) => {
  console.log(`REFUSED: ${reason}. Nothing was sent.`);
  process.exit(result(3, { state: "refused_precheck", reason, next }));
};

if (flags.address) {
  let agent;
  try {
    agent = loadAgent().keypair.publicKey.toBase58();
  } catch (err) {
    refuse(oneLine(err?.message ?? err, 300), "make the agent key file a regular file only you can read (chmod 600)");
  }
  process.exit(result(0, { state: "ok", agent }));
}

if (flags["clear-agent"] !== undefined) {
  const named = parseEnvFile(PUBLIC_PATH).SOLANA_AGENT_ADDRESS;
  if (named !== flags["clear-agent"]) {
    console.log(`REFUSED: ${PUBLIC_PATH} ${named ? `names another agent (${named})` : "names no agent"}, not ${flags["clear-agent"]}. Nothing was changed.`);
    process.exit(result(3, { state: "refused_precheck", reason: named ? `the public file names another agent (${named})` : "the public file names no agent", next: "nothing was changed on this chain" }));
  }
  writePublic({}, CLEARED_KEYS);
  console.log(`removed agent ${flags["clear-agent"]} from ${PUBLIC_PATH}; the owner and the approvals mode stay.`);
  process.exit(result(0, { state: "cleared", agent: flags["clear-agent"] }));
}

const conn = connection();
const cluster = await clusterProblem(conn);
if (cluster) refuse(cluster, CLUSTER_NEXT);

/**
 * Where these signatures stand at finalized commitment, polled for up to `waitMs`: "final" when every one is finalized without an
 * error, "failed" when one failed on chain and every other one is finalized, "not_found" when the chain has none of one of them (a transfer that never landed), else
 * "pending". A lost poll is a pending one, never a verdict.
 */
async function standing(signatures, waitMs = 60_000) {
  const until = Date.now() + waitMs;
  for (;;) {
    let seen = [];
    try {
      seen = (await retryRead(() => conn.getSignatureStatuses(signatures, { searchTransactionHistory: true }))).value;
    } catch { seen = []; }
    if (seen.length === signatures.length) {
      // a failed transfer moved nothing, but one that landed beside it may still be reorganised away: "failed" only once every
      // transfer, the failed one too, is finalized, so the funds are not counted as returned (or swept again) before that
      if (seen.some((st) => st?.err)) { if (seen.every((st) => st?.confirmationStatus === "finalized")) return "failed"; }
      else if (seen.every((st) => st?.confirmationStatus === "finalized")) return "final";
      if (seen.some((st) => !st) && Date.now() >= until) return "not_found";
    }
    if (Date.now() >= until) return "pending";
    await sleep(2000);
  }
}

/** The journals under the ops folder: the ids still open, and the files that cannot be read. */
function operations() {
  let names;
  try { names = readdirSync(OPS_DIR); } catch (err) { if (err?.code === "ENOENT") return { open: [], unreadable: [] }; throw err; }
  const open = [];
  const unreadable = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const id = name.slice(0, -".json".length);
    try {
      if (!OP_ID_RE.test(id)) throw new Error("its name is not an operation id");
      const j = JSON.parse(readRegularFile(`${OPS_DIR}/${name}`, "the journal"));
      const why = !j || typeof j !== "object" || Array.isArray(j) ? "it does not hold a journal" : solanaOpProblem(j, id);
      if (why) throw new Error(why);
      if (!CLOSED.has(j.state)) open.push(id);
    } catch (err) {
      unreadable.push({ file: name, why: oneLine(err?.message ?? err, 120) });
    }
  }
  return { open, unreadable };
}

if (flags.confirm !== undefined) {
  const sigs = flags.confirm.split(",").filter(Boolean);
  if (!sigs.length || sigs.some((x) => !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(x))) refuse("--confirm takes the signatures of an earlier sweep, comma-separated", "pass the signatures the sweep reported");
  const state = await standing(sigs, 30_000);
  console.log(`sweep transfers: ${state}`);
  process.exit(result(0, { state, final: state === "final", tx: sigs, next: state === "final" ? "none" : state === "pending" ? "superstables budget rotate --rail solana again once they are finalized" : "superstables budget rotate --rail solana again" }));
}

const pub = readPublic();
if (!pub.owner || !pub.agent) refuse("the public file names no owner or no agent", "superstables budget setup --rail solana");
const agentPk = pub.agent;
const ownerAta = getAssociatedTokenAddressSync(USDC_MINT, pub.owner);
const agentAta = getAssociatedTokenAddressSync(USDC_MINT, agentPk);
const lamportsOf = async () => BigInt(await retryRead(() => conn.getBalance(agentPk, "confirmed")));
const usdcOf = async () => (await retryRead(() => getAccountOrNull(conn, agentAta)))?.amount ?? 0n;

if (flags.balances) {
  const lamports = await lamportsOf();
  const usdc = await usdcOf();
  const { open, unreadable } = operations();
  console.log(`agent ${agentPk.toBase58()} holds ${formatUnits(lamports, 9)} SOL and ${formatUnits(usdc)} USDC; owner ${pub.owner.toBase58()}`);
  for (const id of open) console.log(`operation ${id} is not decided: reconcile reads it before the agent's funds move`);
  for (const u of unreadable) console.log(`journal ${u.file} cannot be read: ${u.why}`);
  process.exit(result(0, { state: "planned", plan: { agent: agentPk.toBase58(), owner: pub.owner.toBase58(), lamports: String(lamports), usdc: String(usdc), openOps: open, unreadable }, next: "superstables budget rotate --rail solana" }));
}

// --sweep: only the agent key on file, and only to the owner on record
let agent;
try {
  agent = loadAgent().keypair;
} catch (err) {
  refuse(oneLine(err?.message ?? err, 300), "make the agent key file a regular file only you can read (chmod 600)");
}
if (!agent.publicKey.equals(agentPk)) refuse(`the agent key file holds ${agent.publicKey.toBase58()}, and the public file names ${agentPk.toBase58()}`, "the two files must name the same agent; run superstables budget doctor --rail solana");

const sent = { usdc: null, sol: null };
/** Signs with the agent key, sends, and reads the status until it is confirmed, failed or expired. `kind` names the signature in `tx`. */
async function send(tx, what, kind) {
  const latest = await retryRead(() => conn.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = latest.blockhash;
  tx.lastValidBlockHeight = latest.lastValidBlockHeight;
  tx.feePayer = agent.publicKey;
  tx.sign(agent);
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log(`${what}: sent ${sig}`);
  sent[kind] = sig;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const st = (await retryRead(() => conn.getSignatureStatuses([sig], { searchTransactionHistory: true }))).value[0];
    if (st?.err) {
      console.log(`${what}: failed on chain (${oneLine(JSON.stringify(st.err), 200)})`);
      process.exit(result(1, { state: "failed", proof: "reverted", tx: { ...sent }, reason: `the ${what} failed on chain (${oneLine(JSON.stringify(st.err), 200)})`, next: "superstables budget rotate --rail solana again" }));
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    await sleep(1000);
  }
  console.log(`${what}: ${sig} did not show up on chain in time`);
  process.exit(result(5, { state: "unknown", tx: { ...sent }, reason: `the ${what} was sent but the chain does not show it yet`, next: `superstables budget doctor --rail solana reads the agent's balances; then superstables budget rotate --rail solana again (${explorerTx(sig)})` }));
}

const tx = sent;
const usdcBefore = await usdcOf();
if (usdcBefore > 0n) {
  const destination = await retryRead(() => getAccountOrNull(conn, ownerAta));
  if (!destination) refuse(`the owner ${pub.owner.toBase58()} has no USDC account to return ${formatUnits(usdcBefore)} USDC to`, "the owner creates the USDC account (any USDC deposit does), then runs rotate again");
  tx.usdc = await send(new Transaction().add(createTransferCheckedInstruction(agentAta, USDC_MINT, ownerAta, agent.publicKey, usdcBefore, USDC_DECIMALS)), `return of ${formatUnits(usdcBefore)} USDC to the owner`, "usdc");
}
const usdcAfter = await usdcOf();
if (usdcAfter > 0n) {
  console.log(`the agent still holds ${formatUnits(usdcAfter)} USDC`);
  process.exit(result(5, { state: "unknown", tx: { ...tx }, reason: `the agent still holds ${formatUnits(usdcAfter)} USDC after the return`, next: "superstables budget doctor --rail solana, then rotate again" }));
}
const lamports = await lamportsOf();
let sol = 0n;
if (lamports > FEE_LAMPORTS) {
  sol = lamports - FEE_LAMPORTS;
  tx.sol = await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: pub.owner, lamports: sol })), `return of ${formatUnits(sol, 9)} SOL to the owner`, "sol");
} else console.log(`the agent holds ${formatUnits(lamports, 9)} SOL, too little to move`);
console.log(`agent ${agentPk.toBase58()} now holds ${formatUnits(await lamportsOf(), 9)} SOL and ${formatUnits(await usdcOf())} USDC`);
// final only once every transfer this run sent is finalized (a run that sent nothing has nothing to wait for)
const sigs = Object.values(tx).filter(Boolean);
const where = sigs.length ? await standing(sigs) : "final";
console.log(`transfers: ${where}`);
process.exit(result(0, { state: "ok", final: where === "final", tx, returnedUsdc: formatUnits(usdcBefore), returnedSol: formatUnits(sol, 9), ...(sigs.length ? {} : { reason: "the sweep sent nothing: the agent held no USDC and too little SOL to move" }), next: where === "final" ? "none" : "superstables budget rotate --rail solana again once they are finalized" }));
