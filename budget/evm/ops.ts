// Operation journal and chain reconciliation for B4 (plain ERC-20 approve, pull then pay), any chain in chains.ts. Contract rule 5.
// Per-chain journal directory, `rail` from the chain table, the CancelAuthorization domain from the chain table, next-step
// commands carry --chain, and the journal records the agent's USDC balance before the pull.
// Reconcile is read only: it reads the chain and the journal file and writes the journal file, nothing else. Returning stranded
// funds (cancel, return) is `makeSafe`, called by buy and by recover.ts (both with the agent key).
//
// One JSON file per operation under $SUPERSTABLES_HOME/budget/ops/evm-<chain>/<id>.json (../paths.mjs; outside the code folder,
// mode 600, `path: "approve"`, ids start with "b4-"). Written BEFORE the pull is sent (intent) and again after each step:
//   pull:        transferFrom(owner, agent, price) is signed locally; its hash is written before it is broadcast
//   payment:     the EIP-3009 authorization (nonce, validBefore) is written before the signature leaves the process
//   cancel:      cancelAuthorization (kills an unsettled authorization) is journaled the same way
//   return:      transfer(owner, price) (stranded funds go back to the owner) is journaled the same way
//   settlement:  read back from the chain (USDC AuthorizationUsed + Transfer), never from the seller
// A purchase has two transactions that matter: the pull (agent) and the settlement (the seller's facilitator).
import { finalityFor } from "../../src/core/finality-policy.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseEventLogs, encodeFunctionData, parseSignature, parseAbi, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import {
  SYM,
  OPS_DIR, USDC, CFG, RAIL, cmd, erc20Abi, publicClient, usdc, sleep, tx, retry, allowanceOf, usdcBalance, readUntil, feeOf, sendJournaled, receiptOf,
  GasShort, gasWords,
  type Wallet,
} from "./lib.ts";

export type OpState = "quoted" | "submitted" | "settled" | "failed" | "refused_precheck" | "refused_chain" | "unknown" | "not_found"; // not_found: reconcile only

export type Journal = {
  op: string;
  rail: string;
  path: "approve";
  state: OpState;
  /** false keeps a landed result reconcilable; omitted on older permanent records. */
  final?: boolean;
  inclusionObserved?: true;
  replacementSearchTo?: string;
  createdAt: string;
  updatedAt: string;
  // intent
  url: string;
  owner: Address;
  agent: Address;
  token: Address;
  max: string; // decimal USDC
  expectPayTo?: string;
  price?: string; // decimal USDC
  payTo?: Address;
  // pull (transaction 1, sent by the agent)
  pullTx?: Hex;
  pullNonce?: number;
  pullBlock?: string;
  pullStatus?: "success" | "reverted";
  pulled?: string; // decimal USDC that left the owner
  pullRefusal?: string;
  // payment (transaction 2, sent by the seller's facilitator)
  signed: boolean;
  auth?: { nonce: Hex; validBefore: number; validAfter: number; value: string; to: Address; from: Address };
  settleTx?: Hex;
  settleStatus?: "success" | "reverted";
  // an unsettled authorization is cancelled on chain before the pulled price is returned
  cancelTx?: Hex;
  cancelNonce?: number;
  cancelStatus?: "success" | "reverted";
  // stranded funds returned to the owner
  returnTx?: Hex;
  returnNonce?: number;
  returnStatus?: "success" | "reverted";
  returned?: string; // decimal USDC that went back to the owner
  // gas the agent paid, wei (pull + cancel + return; the settlement is paid by the facilitator)
  agentFeeWei?: string;
  // agent USDC (ERC-20 units, decimal) right before the pull. On a chain where USDC is the gas token the agent always holds a
  // reserve, so "back to 0" is "back to this balance minus gas"
  agentUsdcBefore?: string;
  // delivery is separate from settlement
  httpStatus?: number;
  delivered: boolean | null;
  reason?: string;
  next?: string;
  notes: string[];
};

export const PENDING: OpState[] = ["submitted", "unknown"];
/** An operation id may be reused only while nothing was signed or sent under it. */
export const REUSABLE: OpState[] = ["quoted", "refused_precheck"];

export function newOpId(): string {
  return `b4-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
}
export function checkOpId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    console.error(`error: --op must be 1-64 characters of letters, digits, dot, dash or underscore`);
    process.exit(2);
  }
  return id;
}
export const journalPath = (op: string) => join(OPS_DIR, `${op}.json`);
export function readJournal(op: string): Journal | null {
  const p = journalPath(op);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.path !== "approve") {
    console.error(`error: operation ${op} is not an evm budget purchase; reconcile it on the rail that made it`);
    process.exit(2);
  }
  return j as Journal;
}
export function writeJournal(j: Journal) {
  mkdirSync(OPS_DIR, { recursive: true, mode: 0o700 });
  j.updatedAt = new Date().toISOString();
  const p = journalPath(j.op);
  writeFileSync(p + ".tmp", JSON.stringify(j, null, 2), { mode: 0o600 });
  renameSync(p + ".tmp", p);
}
/** Another operation that already recorded this exact transaction hash (two processes that signed the same nonce and bytes). */
export function otherOpWithTx(field: "pullTx" | "cancelTx" | "returnTx", hash: string, op: string): string | null {
  if (!existsSync(OPS_DIR)) return null;
  for (const f of readdirSync(OPS_DIR)) {
    if (!f.endsWith(".json") || f === `${op}.json`) continue;
    try {
      const j = JSON.parse(readFileSync(join(OPS_DIR, f), "utf8")) as Journal;
      if (j.path === "approve" && j[field]?.toLowerCase() === hash.toLowerCase()) return j.op;
    } catch {}
  }
  return null;
}
export function newJournal(f: Pick<Journal, "op" | "url" | "owner" | "agent" | "token" | "max" | "expectPayTo">): Journal {
  const now = new Date().toISOString();
  return { rail: CFG.rail, path: "approve", state: "quoted", createdAt: now, updatedAt: now, signed: false, delivered: null, notes: [], ...f };
}
const addFee = (j: Journal, wei: bigint) => { j.agentFeeWei = String(BigInt(j.agentFeeWei ?? 0) + wei); };

/** State names of the unified CLI (CLI.md). The journal keeps its own names ("quoted", "submitted"); RESULT lines use these. */
export const outState = (s: OpState): string => (s === "quoted" ? "planned" : s === "submitted" ? "sent" : s);
/**
 * One exit code per operation state, the same for buy and reconcile:
 *   0 settled and delivered (or a quote)   1 failed, not_found, or refused by the chain   3 refused before anything was signed
 *   4 settled on chain but delivery is not confirmed (paid, not delivered)   5 outcome unknown (never pay again, reconcile)
 */
export function exitCodeFor(state: OpState, delivered: boolean | null): number {
  if (state === "quoted") return 0;
  if (state === "settled") return delivered === true ? 0 : 4;
  if (state === "refused_precheck") return 3;
  if (state === "unknown" || state === "submitted") return 5;
  return 1; // failed, refused_chain, not_found
}

/**
 * The final line every buy and reconcile prints (CLI.md shape). `tx` holds every transaction of the operation. `paid` is true when
 * the settlement is on chain, null while it is undecided. `debit` is the owner's NET debit (pulled minus returned); amounts that
 * are not known are null, never "0". `ok` is true only when the exit code is 0.
 */
/** The seller's saved answer to a paid request (buy.ts): the file, its content type, its size, and whether it was cut. */
export type ResponseInfo = { responseFile: string; responseType: string | null; responseBytes: number; responseTruncated: boolean };

export async function resultLine(j: Journal, command: "buy" | "reconcile", extra: { remaining?: string } & Partial<ResponseInfo> = {}): Promise<string> {
  let rem = extra.remaining;
  if (rem === undefined) {
    try { rem = usdc(await allowanceOf(j.owner, j.agent)); } catch {}
  }
  const pulledKnown = j.pulled !== undefined || !j.pullTx; // a recorded pull whose amount the chain has not confirmed yet is unknown
  const pulled = j.pulled ? BigInt(Math.round(Number(j.pulled) * 1e6)) : 0n;
  const returned = j.returned ? BigInt(Math.round(Number(j.returned) * 1e6)) : 0n;
  const line: any = {
    ok: exitCodeFor(j.state, j.delivered) === 0,
    command,
    rail: RAIL,
    chain: CFG.key,
    path: "approve",
    op: j.op,
    state: outState(j.state),
    ...(j.final === false ? { final: false } : {}),
    paid: j.state === "settled" ? true : j.state === "unknown" || j.state === "submitted" ? null : false,
    delivered: j.delivered,
    amount: j.price ?? null,
    remaining: rem ?? null,
    tx: { pull: j.pullTx ?? null, settle: j.settleTx ?? null, cancel: j.cancelTx ?? null, return: j.returnTx ?? null },
    debit: pulledKnown ? usdc(pulled - returned) : null,
    pulled: pulledKnown ? (j.pulled ?? "0") : null,
    returned: j.returned ?? "0",
    ...(extra.responseFile ? { responseFile: extra.responseFile, responseType: extra.responseType ?? null, responseBytes: extra.responseBytes, responseTruncated: extra.responseTruncated } : {}),
    next: j.next ?? "none",
  };
  if (j.agentFeeWei) line.agentFeeWei = j.agentFeeWei;
  if (j.reason) line.reason = j.reason;
  return `RESULT ${JSON.stringify(line)}`;
}

/** SKALE's pinned BFT configuration is the only EVM budget network with instant finality. */
async function finalHead() {
  return publicClient.getBlock({ blockTag: finalityFor("evm", CFG.key) === "instant" ? "latest" : "finalized" });
}

type Receipt = Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
async function canonicalReceipt(receipt: Receipt, head?: Awaited<ReturnType<typeof finalHead>>): Promise<boolean> {
  try {
    const final = head ?? await finalHead();
    if (receipt.blockNumber === null || !receipt.blockHash || final.number === null || receipt.blockNumber > final.number || receipt.logs.some((l) => l.removed)) return false;
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return block.number === receipt.blockNumber && block.hash?.toLowerCase() === receipt.blockHash.toLowerCase();
  } catch {
    return false;
  }
}

export type PullRead =
  | { found: true; status: "success" | "reverted"; block: bigint; moved: bigint; final: boolean }
  | { found: false; unknown?: boolean; pendingInPool?: boolean };

/** Receipt errors and provisional inclusion preserve uncertainty. Only a readable absence permits nonce investigation. */
export async function readPull(j: Journal, options: { final?: boolean } = {}): Promise<PullRead> {
  if (!j.pullTx) return { found: false };
  let receipt: Receipt | null;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: j.pullTx });
  } catch (e) {
    if (!(e instanceof TransactionReceiptNotFoundError)) return { found: false, unknown: true };
    receipt = null;
  }
  if (!receipt) {
    let inPool = false;
    try { inPool = !!(await publicClient.getTransaction({ hash: j.pullTx })); } catch {}
    return { found: false, pendingInPool: inPool };
  }
  try {
    const head = await publicClient.getBlock({ blockTag: "latest" });
    if (receipt.transactionHash.toLowerCase() !== j.pullTx.toLowerCase() || !(await canonicalReceipt(receipt, head))) return { found: false, unknown: true };
  } catch {
    return { found: false, unknown: true };
  }
  let moved = 0n;
  if (receipt.status === "success") {
    for (const l of parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })) {
      if (l.address.toLowerCase() === USDC.toLowerCase() && l.args.from.toLowerCase() === j.owner.toLowerCase() && l.args.to.toLowerCase() === j.agent.toLowerCase()) moved += l.args.value;
    }
  }
  return { found: true, status: receipt.status, block: receipt.blockNumber, moved, final: await canonicalReceipt(receipt) };
}

/** Timestamp searches read blocks, never pruned historical account state. */
async function operationStart(j: Journal, head: Awaited<ReturnType<typeof finalHead>>): Promise<bigint> {
  if (j.pullBlock) return BigInt(j.pullBlock);
  const since = Date.parse(j.createdAt) / 1000 - 600;
  if (!Number.isFinite(since) || head.number === null) throw new Error("operation start unavailable");
  let lo = 0n, hi = head.number;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await publicClient.getBlock({ blockNumber: mid });
    if (Number(block.timestamp) < since) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/** Identify the nonce-consuming transaction from token logs, then verify its sender, nonce and final receipt. */
async function differentFinalNonceTransaction(j: Journal): Promise<Hex | undefined> {
  if (j.pullNonce === undefined || !j.pullTx || j.inclusionObserved) return undefined;
  try {
    const head = await finalHead();
    if (head.number === null || await publicClient.getTransactionCount({ address: j.agent, blockNumber: head.number }) <= j.pullNonce) return undefined;
    const start = await operationStart(j, head);
    const candidate = async (hash: Hex): Promise<Hex | undefined> => {
      if (hash.toLowerCase() === j.pullTx?.toLowerCase()) return undefined;
      const transaction = await publicClient.getTransaction({ hash });
      if (transaction.from.toLowerCase() !== j.agent.toLowerCase() || transaction.nonce !== j.pullNonce) return undefined;
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return receipt.transactionHash.toLowerCase() === hash.toLowerCase() && await canonicalReceipt(receipt, head) ? hash : undefined;
    };
    const [transfer, used] = parseAbi([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
    ]);
    const filters = [
      (fromBlock: bigint, toBlock: bigint) => publicClient.getLogs({ address: USDC, event: transfer, args: { from: j.agent }, fromBlock, toBlock }),
      (fromBlock: bigint, toBlock: bigint) => publicClient.getLogs({ address: USDC, event: transfer, args: { to: j.agent }, fromBlock, toBlock }),
      (fromBlock: bigint, toBlock: bigint) => publicClient.getLogs({ address: USDC, event: used, args: { authorizer: j.agent, ...(j.auth ? { nonce: j.auth.nonce } : {}) }, fromBlock, toBlock }),
    ];
    for (const filter of filters) {
      let step = BigInt(CFG.logRange ?? 1000);
      for (let from = start, pages = 0; from <= head.number && pages < 50; pages++) {
        const to = from + step - 1n < head.number ? from + step - 1n : head.number;
        let logs;
        try { logs = await filter(from, to); }
        catch (e) { if (step <= 100n) throw e; step /= 10n; continue; }
        for (const log of logs) {
          if (log.removed || !log.transactionHash || log.blockNumber === null || log.blockNumber > head.number) continue;
          const identified = await candidate(log.transactionHash);
          if (identified) return identified;
        }
        from = to + 1n;
      }
    }
    // A replacement can be a native transfer with no token logs. Resume a bounded block scan for that case.
    const from = j.replacementSearchTo ? BigInt(j.replacementSearchTo) + 1n : start;
    for (let n = from, read = 0; n <= head.number && read < 8; n++, read++) {
      const block = await publicClient.getBlock({ blockNumber: n, includeTransactions: true });
      if (block.number !== n || !block.hash) return undefined;
      for (const transaction of block.transactions) {
        if (typeof transaction === "string" || transaction.from.toLowerCase() !== j.agent.toLowerCase() || transaction.nonce !== j.pullNonce) continue;
        const identified = await candidate(transaction.hash);
        if (identified) return identified;
      }
      j.replacementSearchTo = String(n);
      writeJournal(j);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** A return is recorded as completed only after it is final on chain. */
async function readReturn(j: Journal): Promise<{ found: boolean; status?: "success" | "reverted"; moved: bigint }> {
  if (!j.returnTx) return { found: false, moved: 0n };
  let receipt: Receipt;
  try { receipt = await publicClient.getTransactionReceipt({ hash: j.returnTx }); } catch { return { found: false, moved: 0n }; }
  if (!receipt || receipt.transactionHash.toLowerCase() !== j.returnTx.toLowerCase() || !(await canonicalReceipt(receipt))) return { found: false, moved: 0n };
  let moved = 0n;
  if (receipt.status === "success") {
    for (const l of parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" })) {
      if (l.address.toLowerCase() === USDC.toLowerCase() && l.args.from.toLowerCase() === j.agent.toLowerCase() && l.args.to.toLowerCase() === j.owner.toLowerCase()) moved += l.args.value;
    }
  }
  return { found: true, status: receipt.status, moved };
}

export type Settlement =
  | { kind: "unused"; used: false; canceled: false }
  | { kind: "unread"; used: false; canceled: false; reason: string }
  | { kind: "pending"; used: false; canceled: false; reason: string }
  | { kind: "canceled"; used: false; canceled: boolean; final: boolean }
  | { kind: "used"; used: true; canceled: false; settleTx: Hex; status: "success"; transferOk: boolean; final: boolean };

/** Latest use, canonical inclusion, and finality are separate observations. Read errors never imply use. */
export async function readSettlement(j: Journal): Promise<Settlement> {
  const auth = j.auth;
  if (!auth) return { kind: "unused", used: false, canceled: false };
  try {
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    if (latest.number === null) throw new Error("latest block unavailable");
    const done = await retry(() => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "authorizationState", args: [j.agent, auth.nonce], blockNumber: latest.number }));
    if (!done) return { kind: "unused", used: false, canceled: false };
    const head = await finalHead().catch(() => null);
    const events = parseAbi([
      "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
      "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
    ]);
    const inspect = async (hash: Hex): Promise<Settlement | undefined> => {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (!receipt || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.status !== "success" || !(await canonicalReceipt(receipt, latest))) return undefined;
      const final = head !== null && await canonicalReceipt(receipt, head);
      const matches = (name: "AuthorizationUsed" | "AuthorizationCanceled") => parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: name }).some((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.args.authorizer.toLowerCase() === j.agent.toLowerCase() && l.args.nonce.toLowerCase() === auth.nonce.toLowerCase());
      if (matches("AuthorizationCanceled")) {
        const finalCanceled = final && head !== null && await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "authorizationState", args: [j.agent, auth.nonce], blockNumber: head.number ?? undefined }).catch(() => false);
        return { kind: "canceled", used: false, canceled: finalCanceled, final: finalCanceled };
      }
      if (!matches("AuthorizationUsed")) return undefined;
      const transferOk = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).some((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.args.from.toLowerCase() === auth.from.toLowerCase() && l.args.to.toLowerCase() === auth.to.toLowerCase() && l.args.value === BigInt(auth.value));
      return { kind: "used", used: true, canceled: false, settleTx: hash, status: "success", transferOk, final };
    };
    for (const hash of [j.settleTx, j.cancelTx]) {
      if (!hash) continue;
      const found = await inspect(hash);
      if (found) return found;
    }
    const fromBlock = j.pullBlock ? BigInt(j.pullBlock) : latest.number > 3000n ? latest.number - 3000n : 0n;
    for (const event of events) {
      let step = BigInt(CFG.logRange ?? 10_000);
      for (let from = fromBlock; from <= latest.number;) {
        const to = from + step - 1n < latest.number ? from + step - 1n : latest.number;
        let logs;
        try {
          logs = await publicClient.getLogs({ address: USDC, event, args: { authorizer: j.agent, nonce: auth.nonce }, fromBlock: from, toBlock: to });
        } catch (e) {
          if (step <= 100n) throw e;
          step /= 10n;
          continue;
        }
        for (const log of logs) {
          if (log.removed || log.blockNumber === null || log.blockNumber > latest.number || !log.blockHash || !log.transactionHash) continue;
          const found = await inspect(log.transactionHash);
          if (found) return found;
        }
        from = to + 1n;
      }
    }
    return { kind: "pending", used: false, canceled: false, reason: "the nonce is used, but its payment or cancellation could not be identified" };
  } catch {
    return { kind: "unread", used: false, canceled: false, reason: "the payment or cancellation could not be read from the chain" };
  }
}

/** Signed expiry requires a final block and an unused nonce read at that exact block. */
export async function authDead(j: Journal, s: Settlement): Promise<boolean> {
  const auth = j.auth;
  if (!auth) return true;
  if (s.canceled) return true;
  if (s.kind !== "unused") return false;
  try {
    const b = await finalHead();
    if (b.number === null || Number(b.timestamp) < auth.validBefore) return false;
    return !(await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "authorizationState", args: [j.agent, auth.nonce], blockNumber: b.number }));
  } catch {
    return false;
  }
}

/**
 * Decide the state of an operation from the chain alone. Never sends anything.
 *   settled   the pull landed and this operation's own authorization was used by a successful transaction that paid the recipient
 *   failed    the pull reverted; or the pull landed and no settlement can ever happen: the authorization was never signed,
 *             was cancelled on chain, or is expired by the chain's own clock (`authDead`).
 *             `returned` says whether the pulled price is back with the owner; if not, `next` names the safe step
 *   unknown   the authorization may still be settled by the seller (before validBefore), or the pull is not proven either way:
 *             a signed pull that is not on chain stays unknown until a DIFFERENT transaction used the agent's nonce at that position
 *   not_found nothing can land for this operation: no pull was ever signed, or the agent's nonce at the pull's position was used
 *             by a different transaction while this pull is not on chain
 */
export async function reconcileJournal(j: Journal, opts: { quiet?: boolean } = {}): Promise<{ j: Journal; verdict: "settled" | "failed" | "unknown" | "not_found" }> {
  if (j.state === "settled") return { j, verdict: "settled" };
  const log = (s: string) => { if (!opts.quiet) console.log(s); };
  const save = (state: OpState, reason: string | undefined, next: string, note: string) => {
    j.state = state; if (state !== "settled") delete j.final; j.reason = reason; j.next = next; j.notes.push(`reconcile: ${note}`); writeJournal(j);
  };
  if (!j.pullTx) {
    save("not_found", "no pull transaction was recorded: the process stopped before anything was signed", "nothing moved for this op. A new purchase needs a new --op.", "not_found (no pull hash in the journal)");
    return { j, verdict: "not_found" };
  }
  const pull = await readPull(j);
  if (!pull.found) {
    const replacement = !pull.unknown && !pull.pendingInPool ? await differentFinalNonceTransaction(j) : undefined;
    if (replacement) {
      save("not_found", `a different final transaction ${replacement} consumed the pull nonce ${j.pullNonce}`, "nothing moved for this op. A new purchase needs a new --op.", "not_found (different final nonce-consuming transaction identified)");
      return { j, verdict: "not_found" };
    }
    save("unknown", pull.pendingInPool ? "the signed pull is still in the pool" : "the signed pull is missing or unreadable; no different final transaction consuming its nonce was identified", `run "${cmd("reconcile.ts", `--op ${j.op}`)}" again later. Do not pay again.`, "unknown (pull unresolved)");
    return { j, verdict: "unknown" };
  }
  j.pullBlock = String(pull.block);
  j.pullStatus = pull.status;
  if (pull.status === "reverted" && !pull.final) {
    save("unknown", "the pull landed and failed, but is not final on chain yet", cmd("reconcile.ts", `--op ${j.op}`), "pull failure not final");
    return { j, verdict: "unknown" };
  }
  if (pull.status === "reverted") {
    j.pulled = "0";
    save("failed", `the pull reverted on chain (${tx(j.pullTx)}); no funds moved`, "nothing moved. A new purchase needs a new --op.", "failed (pull reverted)");
    return { j, verdict: "failed" };
  }
  j.pulled = usdc(pull.moved ?? 0n);

  const s = await readSettlement(j);
  if (s.used) {
    j.settleTx = s.settleTx;
    j.settleStatus = s.status;
    if (s.status === "success" && s.transferOk) {
      j.inclusionObserved = true;
      j.final = pull.final && s.final;
      save("settled", j.final ? undefined : "the payment landed, but is not final on chain yet", j.final ? "none" : `run "${cmd("reconcile.ts", `--op ${j.op}`)}" later to check finality. Do not pay again for this op.`, `settled (pull ${j.pullTx}, settlement ${j.settleTx})`);
      return { j, verdict: "settled" };
    }
    save("unknown", "the authorization was used but the settlement transfer does not match the recorded recipient and amount", `read ${s.settleTx ? tx(s.settleTx) : `the ${SYM} AuthorizationUsed log`} by hand. Do not pay again.`, "unknown (authorization used, transfer mismatch)");
    return { j, verdict: "unknown" };
  }

  if (s.kind === "unread" || s.kind === "pending" || (s.kind === "canceled" && !s.final) || !pull.final) {
    const reason = s.kind === "unread" || s.kind === "pending" ? s.reason : s.kind === "canceled" ? "the cancellation landed, but is not final on chain yet" : "the pull landed, but is not final on chain yet";
    save("unknown", reason, `run "${cmd("reconcile.ts", `--op ${j.op}`)}" again later. Do not pay again.`, "chain read unresolved");
    return { j, verdict: "unknown" };
  }

  if (j.inclusionObserved) {
    save("unknown", "the earlier payment inclusion was removed; outcome unknown. Do not pay again.", cmd("reconcile.ts", `--op ${j.op}`), "earlier inclusion missing");
    return { j, verdict: "unknown" };
  }

  // Not settled. Has the price already gone back to the owner?
  const ret = await readReturn(j);
  if (ret.found) {
    j.returnStatus = ret.status;
    if (ret.status === "success") j.returned = usdc(ret.moved);
  }
  const returned = ret.found && ret.status === "success" && ret.moved >= pull.moved!;
  if (s.canceled && j.cancelTx && !j.cancelStatus) {
    try { j.cancelStatus = (await publicClient.getTransactionReceipt({ hash: j.cancelTx })).status; } catch {}
  }
  const why = !j.auth ? "the pull landed but no payment was ever signed" : s.canceled ? "the pull landed; the payment authorization was cancelled on chain before it settled" : "the pull landed; the payment authorization is expired on chain (block time past validBefore) and was never used";
  if (await authDead(j, s)) {
    if (returned) {
      save("failed", `${why}; the price ${j.pulled} ${SYM} was returned to the owner (${tx(j.returnTx!)})`, "none", "failed (funds returned)");
      return { j, verdict: "failed" };
    }
    const held = await usdcBalance(j.agent);
    const next = held > 0n
      ? `${usdc(held)} ${SYM} is in the agent key (on a gas-in-${SYM} chain that includes its gas reserve). Owner: "superstables budget recover --rail evm --chain ${CFG.key} --op ${j.op}" (stops the allowance first, cancels the authorization if it is still open, then returns the price to the owner). Never pay again for this op.`
      : `the agent key holds 0 ${SYM}; check the owner balance by hand. Never pay again for this op.`;
    save("failed", why, next, "failed (pull landed, not settled, not returned)");
    return { j, verdict: "failed" };
  }
  const until = new Date(j.auth!.validBefore * 1000).toISOString();
  save("unknown", `the pull landed and a signed payment may still be settled by the seller until ${until} (chain time)`, `run "${cmd("reconcile.ts", `--op ${j.op}`)}" again after ${until}, or the owner runs "superstables budget recover --rail evm --chain ${CFG.key} --op ${j.op}" to stop the allowance, cancel the authorization and return the price now. Never pay again for this op.`, "unknown (authorization still valid)");
  return { j, verdict: "unknown" };
}

/** Why an agent step was not sent for lack of gas, and the way out (recover sends the agent gas before its own steps). */
const gasShortNote = (e: GasShort, what: string) =>
  `${gasWords(e.g, what)}. Nothing was signed. The owner runs "superstables budget recover --rail evm --chain ${CFG.key}": it sends the agent gas first, then finishes this`;

/** Agent signs CancelAuthorization for this op's nonce (EIP-712, USDC domain) and returns v, r, s. */
async function signCancel(w: Wallet, nonce: Hex) {
  const sig = await w.account.signTypedData({
    domain: { name: CFG.domain.name, version: CFG.domain.version, chainId: CFG.chainId, verifyingContract: USDC },
    types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "CancelAuthorization",
    message: { authorizer: w.account.address, nonce },
  });
  const { v, r, s } = parseSignature(sig);
  return { v: Number(v), r, s };
}

/**
 * The pull landed and the purchase is not settled: make the pulled price safe.
 *   1. Read the chain. Settled? Then nothing is returned (the seller was paid).
 *   2. A signed authorization that is still open could be settled later with someone else's money. Cancel it on chain
 *      (`cancelAuthorization`, signed by the agent). Settlement and cancel race on chain; whichever mines first wins. If the
 *      cancel reverts because the authorization was used, the purchase settled.
 *   3. Only when the authorization is provably dead (never signed, cancelled, expired) return the price to the owner:
 *      USDC.transfer(owner, price) from the agent key, journaled before broadcast, confirmed from the chain.
 * Never pays a seller. `w` is the agent wallet (the agent file; an escrowed copy only when recover runs with --owner-key-file and no agent file).
 * Only the states the chain has decided are touched: a pull that is not on chain yet, or an authorization that may still settle and
 * cannot be cancelled, are left as they are.
 */
export async function makeSafe(j: Journal, w: Wallet, o: { log?: (s: string) => void } = {}): Promise<Journal> {
  const log = o.log ?? console.log;
  let { verdict } = await reconcileJournal(j, { quiet: true });
  if (verdict === "settled" || verdict === "not_found") return j;
  if (verdict === "failed" && j.returned) return j; // already returned
  if (j.pullStatus !== "success") return j; // pull reverted or not visible: nothing to make safe

  let s = await readSettlement(j);
  if (s.used || s.kind === "unread" || s.kind === "pending") return (await reconcileJournal(j, { quiet: true })).j;

  if (j.auth && s.kind !== "canceled" && !(await authDead(j, s))) {
    log(`the signed authorization ${j.auth.nonce} is still open (validBefore ${new Date(j.auth.validBefore * 1000).toISOString()}); cancelling it on chain before returning the price`);
    try {
      const { v, r, s: sg } = await signCancel(w, j.auth.nonce);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "cancelAuthorization", args: [j.agent, j.auth.nonce, v, r, sg] });
      const sent = await sendJournaled(w, USDC, data, "cancelAuthorization (agent)", ({ hash, nonce }) => { j.cancelTx = hash; j.cancelNonce = nonce; writeJournal(j); }, { op: "cancel", then: ["return"] });
      j.cancelStatus = "success";
      addFee(j, sent.feeWei);
      writeJournal(j);
    } catch (e: any) {
      if (e?.txHash) { j.cancelStatus = "reverted"; if (e.feeWei) addFee(j, e.feeWei); }
      if (e instanceof GasShort) log(`cancelAuthorization not sent: ${gasShortNote(e, "the cancel and the return after it")}`);
      j.notes.push(e instanceof GasShort ? `cancelAuthorization not sent: ${gasShortNote(e, "the cancel and the return after it")}` : `cancelAuthorization did not land: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
      writeJournal(j);
      // the seller may have settled first: the chain decides
      s = await readSettlement(j);
      if (s.used) return (await reconcileJournal(j, { quiet: true })).j;
      log("the cancel could not be verified; the outcome stays unknown, nothing is returned");
      return (await reconcileJournal(j, { quiet: true })).j;
    }
    s = await readUntil(() => readSettlement(j), (x) => x.kind === "canceled" || x.used, 6, 2000);
    if (s.used) return (await reconcileJournal(j, { quiet: true })).j;
    if (s.kind !== "canceled") { log("the cancel is not visible on chain yet; nothing is returned. Run recover.ts --op again."); return (await reconcileJournal(j, { quiet: true })).j; }
  }

  // the authorization is dead (never signed, cancelled or expired unused): the price is stranded in the agent key
  const pulled = BigInt(Math.round(Number(j.pulled ?? "0") * 1e6));
  const held = await usdcBalance(j.agent);
  const amount = held < pulled ? held : pulled;
  if (amount === 0n) {
    j.notes.push("makeSafe: agent balance is 0, nothing to return");
    writeJournal(j);
    return (await reconcileJournal(j, { quiet: true })).j;
  }
  if (j.returnTx) {
    const prior = await readReturn(j);
    if (!prior.found || prior.status === "success") {
      j.notes.push(`makeSafe: an earlier return ${j.returnTx} is ${prior.found ? "on chain" : "not on chain yet"}; not sending another`);
      writeJournal(j);
      return (await reconcileJournal(j, { quiet: true })).j;
    }
  }
  log(`returning ${usdc(amount)} ${SYM} from the agent to the owner ${j.owner}`);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [j.owner, amount] });
  try {
    const sent = await sendJournaled(w, USDC, data, "return price to owner (agent)", ({ hash, nonce }) => { j.returnTx = hash; j.returnNonce = nonce; writeJournal(j); }, { op: "return" });
    j.returnStatus = "success";
    addFee(j, sent.feeWei);
    j.returned = usdc(amount);
    writeJournal(j);
  } catch (e: any) {
    if (e?.txHash) { j.returnStatus = "reverted"; if (e.feeWei) addFee(j, e.feeWei); }
    if (e instanceof GasShort) log(`return not sent: ${gasShortNote(e, "the return")}`);
    j.notes.push(e instanceof GasShort ? `return not sent: ${gasShortNote(e, "the return")}` : `return transfer failed: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`);
    writeJournal(j);
  }
  return (await reconcileJournal(j, { quiet: true })).j;
}

/** Journals of this agent whose pulled price may still be stranded: the pull landed (or may have), no settlement, nothing returned. */
export function pendingJournalsFor(agent: string): Journal[] {
  const out: Journal[] = [];
  if (!existsSync(OPS_DIR)) return out;
  for (const f of readdirSync(OPS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(OPS_DIR, f), "utf8")) as Journal;
      if (j.path !== "approve" || !j.pullTx || j.agent.toLowerCase() !== agent.toLowerCase()) continue;
      if (j.state === "settled" || j.state === "refused_precheck" || j.state === "refused_chain" || j.state === "quoted" || j.state === "not_found") continue;
      if (j.state === "failed" && j.returned) continue;
      if (j.pulled === "0" || j.pullStatus === "reverted") continue; // the pull moved nothing: no price to return
      out.push(j);
    } catch {}
  }
  return out;
}

export { addFee };
