// Shared helpers for B4 (plain ERC-20 approve, pull then pay) on any chain in chains.ts. Never prints keys.
// One implementation for every EVM chain: the chain table (chains.ts), per-chain state files, native gas accounting
// (`nativeBalance`, `gasFmt`), unified RESULT lines (`emit`) and messages that name the chain.
//   owner  approve(agent, cap)               (setBudget), approve(agent, 0) (revokeBudget)
//   agent  USDC.transferFrom(owner, agent, price), then pays the seller with its own EIP-3009 signature
//   agent  USDC.transferFrom(owner, owner, n)  (selfRevoke): lowers its own allowance without moving money
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatUnits, parseUnits, keccak256, isAddress,
  type Address, type Hex, type NonceManager,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { CFG, type GasOp } from "./chains.ts";
import { EVM_CHAINS } from "./chains.mjs";
import { EVM_RPC_MAX_BYTES, cappedRpcFetch, budgetCall, budgetVerdictSet, customRpc, evmEnvNameSet } from "../rpc.mjs";
import { agentKeyFile, publicFile, opsDir } from "../paths.mjs";
import { UNSAFE_SECRET_FILE, readSecretFile } from "../secret-file.mjs";
import { markSend } from "../proof.mjs";
import { agentBinding, hostedFlags, legacyWarning } from "../owner-binding.mjs";
import { chainGate, chainGateSettings } from "../../src/core/chain-gate.js";
import { agreeAtFinalEvm, agreementWords as engineWords, endpointSetErrorWords } from "../../src/core/rpc-quorum.mjs";
import { finalityFor } from "../../src/core/finality-policy.js";

export { CFG, type GasOp };
export const CHAIN_ID = CFG.chainId;
export const RPC = CFG.rpc;
export const EXPLORER = CFG.explorer;
export const USDC: Address = CFG.usdc;
export const USDC_DECIMALS = CFG.decimals;
/** Symbol of the budget token in messages (per chain in chains.mjs). The code calls it USDC throughout. */
export const SYM = CFG.symbol;
export const NETWORK = CFG.network;
export const GAS = CFG.gas;
const chain = CFG.chain;
/** Rail name in every RESULT line (`superstables budget --rail evm`); the chain is `CFG.key` (`--chain`). */
export const RAIL = "evm";
/**
 * Print the last stdout line of a command: `RESULT {json}` (CLI.md). `ok` is true only when `exit` is 0. Returns `exit`, so a
 * script ends with `process.exit(emit(...))`.
 * Exit codes, the same on every rail: 0 done, 1 failed (incl. refused by the chain), 2 bad input, 3 refused before signing,
 * 4 paid but not delivered, 5 outcome unknown.
 */
export function emit(command: string, exit: number, o: Record<string, unknown>): number {
  console.log(`RESULT ${JSON.stringify({ ok: exit === 0, command, rail: RAIL, chain: CFG.key, ...o })}`);
  return exit;
}
/**
 * Seller text (its 402, its answer, its errors) on one log line, at most `max` characters: control characters, newlines
 * included, become spaces; format, bidi and Unicode tag characters are removed. A seller must not be able to start a line of
 * its own on stdout, where the dispatcher reads APPROVE and RESULT lines. The same rule as untrustedText (src/core/text.ts).
 */
export const oneLine = (s: unknown, max = 300): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064]/gu, "").trim().slice(0, max);
/** A command line for a next step, with this chain selected. */
export const cmd = (script: string, rest = "") => `superstables budget ${script.replace(/\.ts$/, "")} --rail evm --chain ${CFG.key}${rest ? ` ${rest}` : ""}`;

// Key files (contract rule 1), shared by every EVM chain; paths come from ../paths.mjs.
//   agent file: B4_AGENT_KEY, public addresses. The only key on the agent's machine.
//   public file (no secret), one per chain: owner and agent addresses, cap, expiry
//   owner: the owner's own browser wallet, through the owner page (owner.ts). No owner key file by default.
//   owner key file, for tests and automation only: named with --owner-key-file <path> (B4_OWNER_KEY, and optionally
//   B4_AGENT_KEY_ESCROW, a copy of the agent key that recover used before the agent file was the default).
export const AGENT_ENV = agentKeyFile("evm");
/** The owner key file given with --owner-key-file, or undefined (the default: the owner approves in their wallet). */
export const OWNER_KEY_FILE: string | undefined = arg("owner-key-file");
export const PUBLIC_ENV = publicFile("evm", CFG.key);
export const OPS_DIR = opsDir("evm", CFG.key);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const tx = (h: string) => `${EXPLORER}/tx/${h}`;
export const usdc = (v: bigint) => formatUnits(v, USDC_DECIMALS);
/** Native gas token amount (Arc: USDC with 18 decimals; Base: ETH). */
export const gasFmt = (v: bigint) => formatUnits(v, GAS.decimals);
export function usageError(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}
/** A token amount with the token's decimals: refuse anything with more precision instead of rounding it. */
export function toUsdc(s: string): bigint {
  if (!new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`).test(s)) usageError(`"${s}" is not a ${SYM} amount with at most ${USDC_DECIMALS} decimals`);
  return parseUnits(s, USDC_DECIMALS);
}
export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);
export const posInt = (name: string, def: string, max = 3650 * 86400) => {
  const v = arg(name, def)!;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > max) usageError(`--${name} must be a whole number between 1 and ${max}`);
  return Number(v);
};

// ---- env files (parse only what is asked; never print values) ----
function parseText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}
export function parseLines(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseText(readFileSync(path, "utf8"));
}
/**
 * A key file's lines, or {} when it is absent. Refuses (throws) a file other users can read, or anything that is not a
 * regular file, checked on the file actually opened (../secret-file.mjs).
 */
export function parseSecretLines(path: string, what: string): Record<string, string> {
  let text: string;
  try {
    text = readSecretFile(path, what);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseText(text);
}
/**
 * The agent key file's values for a command that must refuse cleanly rather than throw: `{ env }` ({} when there is no
 * file), or `{ problem }` when the file must not be used. Checked on the file actually read; ask again after any wait.
 */
export function agentFileValues(): { env: Record<string, string>; problem?: undefined } | { env?: undefined; problem: string } {
  try {
    return { env: agentEnv() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === UNSAFE_SECRET_FILE) return { problem: (err as Error).message };
    throw err;
  }
}
/** The agent key file. Every reader of the key goes through here, so each one refuses a file other users can read. */
export const agentEnv = () =>
  // Mode 600 is set when the file is written, but that is a fact about that moment: a restore, a `cp` without -p, or
  // an editor can leave it readable by other users, and every signature from here on (a purchase, or a hosted request
  // to the site) would then be made with a key this machine no longer keeps to itself. Refuse rather than re-tighten.
  parseSecretLines(AGENT_ENV, "the agent key file");
export const publicEnv = () => parseLines(PUBLIC_ENV);
export function need(env: Record<string, string>, k: string, file: string): string {
  if (!env[k]) {
    console.error(`error: missing ${k} in ${file} (superstables budget setup --rail evm creates the agent key and the public file)`);
    process.exit(emit(basename(process.argv[1] ?? "unknown").replace(/\.(?:ts|mjs)$/, ""), 1, { state: "failed", reason: `missing ${k} in ${file}`, next: "run superstables budget setup --rail evm" }));
  }
  return env[k];
}
/** Set B4_* keys in the public state file (no secrets), keeping every other line. Atomic. */
export function writePublic(updates: Record<string, string>, drop: string[] = []) {
  mkdirSync(dirname(PUBLIC_ENV), { recursive: true, mode: 0o700 });
  const lines = existsSync(PUBLIC_ENV) ? readFileSync(PUBLIC_ENV, "utf8").split("\n").filter((l) => l !== "") : [`# ${CFG.label} public state (no secrets). B4_* = plain approve path.`];
  const seen = new Set<string>();
  const out = lines
    .map((l) => {
      const m = l.match(/^([A-Z0-9_]+)=/);
      if (m && drop.includes(m[1])) return null;
      if (m && m[1] in updates) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
      return l;
    })
    .filter((l): l is string => l !== null);
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(PUBLIC_ENV + ".tmp", out.join("\n") + "\n", { mode: 0o644 });
  renameSync(PUBLIC_ENV + ".tmp", PUBLIC_ENV);
}
export const newKey = () => generatePrivateKey();

// ---- clients ----
// every request passes markSend: a broadcast prints SENDING before it leaves (../proof.mjs). Every answer is read through
// cappedRpcFetch (../rpc.mjs): at most EVM_RPC_MAX_BYTES, RPC error text as one short line, a non-JSON answer named so.
const rpcFetch = cappedRpcFetch(EVM_RPC_MAX_BYTES);
const transport = () => http(RPC, { retryCount: 5, retryDelay: 400, onFetchRequest: (_request, init) => markSend(init.body), fetchFn: rpcFetch, maxResponseBodySize: EVM_RPC_MAX_BYTES });
export const publicClient = createPublicClient({ chain, transport: transport() });
export const walletFor = (key: Hex, opts?: { nonceManager?: NonceManager }) => {
  const account = privateKeyToAccount(key, opts?.nonceManager ? { nonceManager: opts.nonceManager } : undefined);
  return { account, client: createWalletClient({ account, chain, transport: transport() }) };
};
export type Wallet = ReturnType<typeof walletFor>;

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);

export async function retry<T>(fn: () => Promise<T>, tries = 4, gap = 1500): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(gap); }
  }
  throw last;
}
export const usdcBalance = (a: Address) => retry(() => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as Promise<bigint>;
export const allowanceOf = (owner: Address, spender: Address) => retry(() => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })) as Promise<bigint>;
/** Native balance of the gas token, 18-decimal units (Arc: the same USDC as the ERC-20, ERC-20 balance * 1e12). */
export const nativeBalance = (a: Address) => retry(() => publicClient.getBalance({ address: a }));
/** Read again until `ok` holds (public RPC nodes lag a few seconds behind a block they just confirmed). */
export async function readUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 8, gap = 2000): Promise<T> {
  let v = await read();
  for (let i = 0; i < tries && !ok(v); i++) { await sleep(gap); v = await read(); }
  return v;
}

// ---- errors ----
/** Best-effort text of why a chain call failed (revert reason of the USDC contract, or the RPC error). */
export function chainReason(e: any): string {
  const parts: string[] = [];
  let cur = e;
  for (let i = 0; i < 8 && cur; i++, cur = cur.cause) {
    for (const k of ["reason", "shortMessage", "details"]) if (typeof cur?.[k] === "string" && !parts.includes(cur[k])) parts.push(cur[k]);
  }
  const m = parts.join(" | ") || String(e?.message ?? e);
  // the revert reason an RPC sent as ABI data is decoded into viem's `reason` and message: outside text, on one line and
  // without hidden characters like any other (oneLine). The structured data (`revertData`) is not touched.
  return oneLine(m.replace(/\s+/g, " "), 400);
}

// A crash prints the library's error, which can carry an RPC's words (viem decodes revert data into its message and
// reason): one line, no hidden characters, like any outside text. The owner page's handler (owner-page.ts), once
// installed, prints and exits itself.
// The RPC's own words ("details") come first: they are what names the failure (the answer was not JSON, the call reverted),
// and the dispatcher takes the first words after "error:" as the command's reason.
function crashText(err: any): string {
  const parts: string[] = [];
  let cur = err;
  for (let i = 0; i < 8 && cur; i++, cur = cur.cause) {
    for (const k of ["details", "reason", "shortMessage"]) if (typeof cur?.[k] === "string" && !parts.includes(cur[k])) parts.push(cur[k]);
  }
  return oneLine((parts.join(" | ") || String(err?.message ?? err)).replace(/\s+/g, " "), 400);
}
// Every rail's crash handler carries this mark (the Solana library's too). A handler steps aside for any listener that is
// not marked (the owner page's) and, when several marked ones are loaded in one process, for all but the first.
const RAIL_CRASH_HANDLER = Symbol.for("superstables.railCrashHandler");
const crashHandler = Object.assign(
  (err: unknown) => {
    const listeners = process.listeners("uncaughtException") as ((...a: unknown[]) => unknown)[];
    if (listeners.some((l) => !(l as any)[RAIL_CRASH_HANDLER]) || listeners.find((l) => (l as any)[RAIL_CRASH_HANDLER]) !== crashHandler) return;
    process.stderr.write(`error: ${crashText(err)}\n`);
    process.exit(1);
  },
  { [RAIL_CRASH_HANDLER]: true },
);
process.on("uncaughtException", crashHandler);

// ---- gas the agent can pay ----
// Before the agent signs anything (pull, cancel, return, selfRevoke) it checks it can pay: the chain's gas limit for that
// transaction (chains.mjs `gas.limits`) plus the limits of what a failure would need next, times the current fee cap. A node
// refuses a transaction when the balance is below gas x fee cap, and caps eth_estimateGas at balance / fee cap, so the fee cap
// (not the smaller fee a transaction ends up paying) is the price to check. Fees jump: on Polygon Amoy the tip went from 30 to
// 348 gwei within one run, and an agent that had been fine was suddenly short.

/** The fee fields the next transaction carries: EIP-1559 where the chain has it, else a legacy gas price. */
export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint };
export const feeCap = (f: Fees): bigint => ("gasPrice" in f ? f.gasPrice : f.maxFeePerGas);
/** The fees viem would put on the next transaction (the chain's own fee rules, base fee x 1.2 plus the tip by default). */
export async function currentFees(client = publicClient): Promise<Fees> {
  try {
    const f = await client.estimateFeesPerGas();
    if (f.maxFeePerGas !== undefined && f.maxPriorityFeePerGas !== undefined) return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  } catch {}
  return { gasPrice: await client.getGasPrice() };
}

export type GasNeed = { ok: boolean; have: bigint; need: bigint; gas: bigint; fee: bigint; ops: GasOp[] };
/**
 * Can `agent` pay for `ops` (the next transaction first, then what a failure would need) at the current fee cap?
 * need = the larger of the chain's floor (gas.minAgent) and the sum of the ops' gas limits x fee cap. `first` replaces the
 * first op's limit when its gas is already known.
 */
export async function agentGas(agent: Address, ops: GasOp[], o: { client?: typeof publicClient; fees?: Fees; first?: bigint } = {}): Promise<GasNeed> {
  const client = o.client ?? publicClient;
  const fee = feeCap(o.fees ?? (await currentFees(client)));
  const gas = ops.reduce((sum, op, i) => sum + (i === 0 && o.first !== undefined ? o.first : GAS.limits[op]), 0n);
  const need = gas * fee > GAS.minAgent ? gas * fee : GAS.minAgent;
  const have = await retry(() => client.getBalance({ address: agent }));
  return { ok: have >= need, have, need, gas, fee, ops };
}

/** A gas-token amount rounded to two significant digits (up for what is needed, down for what is there), for messages. */
export function gasRound(v: bigint, dir: "up" | "down"): string {
  const digits = v.toString().length;
  if (v <= 0n || digits <= 2) return gasFmt(v);
  const step = 10n ** BigInt(digits - 2);
  return gasFmt(dir === "up" ? ((v + step - 1n) / step) * step : (v / step) * step);
}
/** A fee cap in gwei, short. */
export function gwei(fee: bigint): string {
  const g = Number(formatUnits(fee, 9));
  return g >= 10 ? g.toFixed(0) : g >= 1 ? String(Number(g.toFixed(1))) : String(Number(g.toPrecision(2)));
}
/** "the agent key has X POL; <what> needs about Y POL at the current fee (Z gwei)<extra>" */
export function gasWords(g: GasNeed, what: string, extra = ""): string {
  return `the agent key has ${gasRound(g.have, "down")} ${GAS.symbol}; ${what} needs about ${gasRound(g.need, "up")} ${GAS.symbol} at the current fee (${gwei(g.fee)} gwei)${extra}`;
}
/** The owner's next step for an agent short on gas. Names an amount only when the chain's default top-up is not enough. */
export function fundAgentNext(g: GasNeed): string {
  const byDefault = parseUnits((EVM_CHAINS as Record<string, any>)[CFG.key].doctor.fundAgent, GAS.decimals);
  const short = g.need - g.have;
  return `owner: superstables budget fund-agent --rail evm --chain ${CFG.key}${short > byDefault ? ` --amount ${gasRound(short, "up")}` : ""}`;
}

/** The agent cannot pay for this transaction and what a failure would need after it. Nothing was signed. */
export class GasShort extends Error {
  constructor(public g: GasNeed) { super(`not enough gas: ${gasWords(g, "this")}`); }
}
/** The chain refuses the call itself: it reverts with enough gas, or with the contract's own revert data. Nothing was signed. */
export class ChainRefused extends Error {
  constructor(public reason: string) { super(reason); }
}

/** Revert data in a viem error chain (the JSON-RPC error's `data`), if there is any. */
export function revertData(e: any): Hex | undefined {
  for (let c = e, i = 0; c && i < 10; c = c.cause, i++) {
    const d = typeof c.data === "string" ? c.data : typeof c.data?.data === "string" ? c.data.data : undefined;
    if (d && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
  }
  return undefined;
}
/**
 * Why a gas estimate failed: the chain refusing the call, or the sender short on gas. The words alone do not tell: a node that
 * caps the estimate at balance / fee cap says "gas required exceeds allowance", or, when the cap lands inside a token behind a
 * proxy (Amoy's USDC), "execution reverted" with empty data, which viem shows as "Execution reverted for an unknown reason".
 * Revert data (the contract said why) is a refusal. "gas required exceeds allowance" or "insufficient funds" is a shortage.
 * Empty data is a shortage when the balance is below limit x fee cap, and a refusal when the call had that much gas.
 * Anything that is not a revert at all (the RPC failed, timed out, or answered something else) is "other": neither.
 */
export function estimateFailure(e: any, o: { have: bigint; limit: bigint; fee: bigint }): "refused" | "short" | "other" {
  const data = revertData(e);
  if (data && data !== "0x") return "refused";
  const text = chainReason(e) + " " + String(e?.message ?? "");
  if (/gas required exceeds allowance|insufficient funds/i.test(text)) return "short";
  let reverted = data !== undefined || /execution reverted|out of gas/i.test(text);
  for (let c = e, i = 0; c && i < 10 && !reverted; c = c.cause, i++) if (c.code === 3) reverted = true;
  if (!reverted) return "other";
  return o.have < o.limit * o.fee ? "short" : "refused";
}

/**
 * Gas and fees for one agent transaction, checked before anything is signed. The estimate carries no fee fields (a node caps an
 * estimate at balance / fee cap only when a fee is given), so a revert here is the chain refusing the call; `estimateFailure`
 * still sorts a capped answer from a node that caps anyway. Gas = the larger of the chain's limit for `op` and the estimate plus
 * 20%. The agent must afford that plus the limits of `then` at the fee cap it will sign with, else GasShort. A refusal throws
 * ChainRefused. An estimate that failed without reverting (the RPC) throws its own error: it is neither. The caller signs with
 * exactly these gas and fees.
 */
export async function agentGasFor(from: Address, to: Address, data: Hex, op: GasOp, then: GasOp[] = [], client = publicClient): Promise<{ gas: bigint; fees: Fees; g: GasNeed }> {
  const fees = await currentFees(client);
  const limit = GAS.limits[op];
  let est: bigint;
  try {
    est = await client.estimateGas({ account: from, to, data, prepare: false } as any);
  } catch (e: any) {
    const have = await retry(() => client.getBalance({ address: from }));
    const why = estimateFailure(e, { have, limit, fee: feeCap(fees) });
    if (why === "short") throw new GasShort(await agentGas(from, [op, ...then], { client, fees }));
    if (why === "refused") throw new ChainRefused(chainReason(e));
    throw e;
  }
  const gas = (est * 12n) / 10n > limit ? (est * 12n) / 10n : limit;
  const g = await agentGas(from, [op, ...then], { client, fees, first: gas });
  if (!g.ok) throw new GasShort(g);
  return { gas, fees, g };
}

// ---- sending ----
/** Refuse to sign anything when the RPC does not answer for the chain in chains.ts (a mainnet RPC behind a testnet name, a wrong URL). Read once. */
let rpcChecked = false;
/** An RPC URL as an agent may see it: the host only. The path, query and credentials of a URL can hold an access key. */
export const rpcHost = (url: string): string => { try { return new URL(url).host; } catch { return "(unreadable URL)"; } };
export async function assertRpcChain() {
  const gate = chainGate({ rail: "evm", key: CFG.key, testnet: (EVM_CHAINS as Record<string, { testnet?: unknown }>)[CFG.key]?.testnet }, chainGateSettings());
  if (gate) {
    console.error(`REFUSED: ${gate}. Nothing was signed or sent.`);
    process.exit(3);
  }
  if (rpcChecked) return;
  const id = Number(await retry(() => publicClient.request({ method: "eth_chainId" })));
  if (id !== CFG.chainId) {
    console.error(`REFUSED: the RPC ${rpcHost(RPC)} answers chain id ${id}, not ${CFG.chainId} (${CFG.label}). Nothing was signed or sent.`);
    process.exit(3);
  }
  rpcChecked = true;
}

/**
 * The chain-id check of a command that only reads (read, reconcile): the same as assertRpcChain without the chain gate, which the
 * load-time gate already ran. A wrong chain exits 3 with nothing read from it.
 */
let readChainChecked = false;
/**
 * Why the RPC read cannot be used for this chain, in words, or "" when it answers the pinned chain id or does not answer at all
 * (one attempt, no retries: an RPC that does not answer is not a wrong chain, and no verdict rests on this endpoint without the
 * engine's own identity check). Only a 0x quantity equal to the pinned id passes; anything else that answered ("zz", "0x", a
 * decimal string) is not this chain.
 */
export async function readChainProblem(): Promise<string> {
  let raw: unknown;
  try { raw = await budgetCall(RPC, "eth_chainId", []); } catch { return ""; }
  const id = typeof raw === "string" && /^0x[0-9a-f]+$/i.test(raw) ? Number(BigInt(raw)) : NaN;
  if (id === CFG.chainId) return "";
  const shown = Number.isNaN(id) ? "an unreadable chain id" : `chain id ${id}`;
  return `the RPC ${rpcHost(RPC)} answers ${shown}, not ${CFG.chainId} (${CFG.label}). Nothing was read from another chain`;
}
/** What to do about a wrong-chain RPC: name the variable that is actually set, or the owner's settings when the RPC is the owner's. */
export function wrongChainNext(): string {
  const set = evmEnvNameSet(CFG.key);
  return set ? `check ${set}, or unset it` : `the owner's RPC for ${CFG.key} answers another chain: ask the owner to fix it with \`superstables owner settings rpc ${CFG.key} <url>\` in the owner's own terminal`;
}
export async function assertReadChain(command: string) {
  if (readChainChecked || rpcChecked) return;
  const reason = await readChainProblem();
  if (reason) {
    console.error(`REFUSED: ${reason}.`);
    process.exit(emit(command, 3, { state: "refused_precheck", reason, next: wrongChainNext() }));
  }
  readChainChecked = true;
}

// ---- verdicts that need agreement ----
// A verdict that lets the agent pay again or reads as "revoked" is believed only when the configured endpoints, run by different
// operators, show the same final block and the same value there (src/core/rpc-quorum.mjs). Every read below is bound to the
// compared block by its hash, and none of them throws: a failure is the engine's { agreed: false } with the reason in words.
/**
 * The engine's words for a failed agreement. A set that could not be built at all (an RPC variable the owner's settings do not
 * allow, an unreadable settings file) says why in the refusal's own words, which the engine keeps as `reason`.
 */
export const agreementWords = (failed: Parameters<typeof engineWords>[0] & { reason?: string }): string =>
  failed.why === "unreadable" && failed.reason && !failed.left?.length ? endpointSetErrorWords(failed.reason, evmEnvNameSet(CFG.key) ?? undefined) : engineWords(failed);
/** The endpoints that decide a verdict on this chain. */
export const verdictSet = () => budgetVerdictSet(CFG.key, customRpc("evm", CFG.key));
type Agreed<T> = Awaited<ReturnType<typeof agreeAtFinalEvm>> & { value?: T };
const agree = (read: (url: string, hexF: string, hash: string) => Promise<unknown>, atLeast?: bigint) =>
  agreeAtFinalEvm({ set: verdictSet(), call: budgetCall, chainId: CFG.chainId, finality: finalityFor("evm", CFG.key), read, atLeast });
const callAt = (data: Hex) => (url: string, _hexF: string, hash: string) => budgetCall(url, "eth_call", [{ to: USDC, data }, { blockHash: hash }]);

/** allowance(owner, spender) at an agreed final block. `atLeast`: the block an allowance of 0 has to be proven at or after. */
export async function allowanceAgreed(owner: Address, spender: Address, atLeast?: bigint): Promise<Agreed<bigint>> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  return agree(async (...a) => BigInt(String(await callAt(data)(...a))), atLeast);
}
/** authorizationState(authorizer, nonce) at an agreed final block (true: used or cancelled). `atLeast` for an "unused". */
export async function authorizationStateAgreed(authorizer: Address, nonce: Hex, atLeast?: bigint): Promise<Agreed<boolean>> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "authorizationState", args: [authorizer, nonce] });
  return agree(async (...a) => BigInt(String(await callAt(data)(...a))) !== 0n, atLeast);
}

const isHash = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
/** What one endpoint says about the block a transaction is in, as plain data: null (not mined), pending, later than F, or off the chain. */
async function placed(url: string, number: unknown, hash: unknown, hexF: string): Promise<"ok" | { state: "pending" | "later" | "off-chain" }> {
  if (number === null || number === undefined || hash === null || hash === undefined) return { state: "pending" };
  if (typeof number !== "string" || !/^0x[0-9a-fA-F]+$/.test(number) || !isHash(hash)) throw new Error("not a placement");
  if (BigInt(number) > BigInt(hexF)) return { state: "later" };
  const b: any = await budgetCall(url, "eth_getBlockByNumber", [number, false]);
  if (!b || typeof b.hash !== "string" || b.hash.toLowerCase() !== String(hash).toLowerCase()) return { state: "off-chain" };
  return "ok";
}

/**
 * A transaction receipt at an agreed final block: null when no endpoint has one, { state } when it is pending, later than the
 * agreed block or in a block that is not the chain's, else { status, blockNumber, blockHash, from, to, logs } with the token's
 * own logs. `atLeast` for a "no receipt" verdict.
 */
export async function receiptAgreed(hash: Hex, atLeast?: bigint): Promise<Agreed<any>> {
  return agree(async (url, hexF) => {
    const r: any = await budgetCall(url, "eth_getTransactionReceipt", [hash]);
    if (r === null || r === undefined) return null;
    if (typeof r !== "object" || typeof r.transactionHash !== "string" || r.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("not this receipt");
    const where = await placed(url, r.blockNumber, r.blockHash, hexF);
    if (where !== "ok") return where;
    const logs = (Array.isArray(r.logs) ? r.logs : []).filter((l: any) => typeof l?.address === "string" && l.address.toLowerCase() === USDC.toLowerCase()).map((l: any) => ({ topics: l.topics, data: l.data }));
    return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, from: r.from, to: r.to, logs };
  }, atLeast);
}
/** A transaction (its sender and nonce) at an agreed final block: null, { state } as for a receipt, or { from, nonce, blockNumber, blockHash }. */
export async function txAgreed(hash: Hex, atLeast?: bigint): Promise<Agreed<any>> {
  return agree(async (url, hexF) => {
    const t: any = await budgetCall(url, "eth_getTransactionByHash", [hash]);
    if (t === null || t === undefined) return null;
    if (typeof t !== "object" || typeof t.hash !== "string" || t.hash.toLowerCase() !== hash.toLowerCase()) throw new Error("not this transaction");
    const where = await placed(url, t.blockNumber, t.blockHash, hexF);
    if (where !== "ok") return where;
    return { from: t.from, nonce: t.nonce, blockNumber: t.blockNumber, blockHash: t.blockHash };
  }, atLeast);
}

/** Total fee a receipt paid: execution fee plus the L1 data fee Base adds (not in gasUsed; Arc has none). */
export function feeOf(r: any): bigint {
  return BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) + BigInt(r.l1Fee ?? 0);
}
/** Poll for the receipt of exactly this hash. No replacement detection: a transaction that was replaced or dropped never reports. */
export async function receiptOf(hash: Hex, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { return await publicClient.getTransactionReceipt({ hash }); } catch {}
    if (Date.now() > until) throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000}s (still pending, replaced or dropped)`);
    await sleep(1200);
  }
}
/** Send native gas token (Base: ETH; Arc: USDC in 18-decimal units). */
export async function sendNative(w: Wallet, to: Address, value: bigint, label: string) {
  await assertRpcChain();
  const hash = await w.client.sendTransaction({ to, value, chain, account: w.account });
  const r = await receiptOf(hash);
  console.log(`${label}: ${r.status} ${tx(hash)}`);
  if (r.status !== "success") throw Object.assign(new Error(`${label} reverted on chain: ${hash}`), { txHash: hash, blockNumber: r.blockNumber });
  return { hash, feeWei: feeOf(r) };
}
/** `agent`: an agent transaction (selfRevoke, sweep): its gas is checked first (agentGasFor), and it is signed with that gas and fee. */
export async function send(w: Wallet, to: Address, data: Hex, label: string, agent?: { op: GasOp; then?: GasOp[] }) {
  await assertRpcChain();
  const pre = agent ? await agentGasFor(w.account.address, to, data, agent.op, agent.then) : null;
  const hash = await w.client.sendTransaction({ to, data, value: 0n, chain, account: w.account, ...(pre ? { gas: pre.gas, ...pre.fees } : {}) } as any);
  const r = await receiptOf(hash);
  console.log(`${label}: ${r.status} ${tx(hash)}`);
  await sleep(3500);
  if (r.status !== "success") throw Object.assign(new Error(`${label} reverted on chain: ${hash}`), { txHash: hash, blockNumber: r.blockNumber });
  return { hash, blockNumber: r.blockNumber, feeWei: feeOf(r) };
}
/**
 * Sign the transaction locally, hand its hash to `onHash` (the caller writes it to the operation journal), and only
 * then broadcast it. A process killed at any point leaves a journal that names the exact transaction to look for.
 * With a nonce manager the nonce comes from it (parallel purchases in one process must not sign the same nonce).
 * Every journaled transaction is the agent's: `gasFor` names it and what a failure would need after it. Its gas is checked
 * (agentGasFor) before the nonce is taken or anything is signed: GasShort or ChainRefused means nothing was signed.
 */
export async function sendJournaled(
  w: Wallet, to: Address, data: Hex, label: string,
  onHash: (h: { hash: Hex; nonce: number }) => void | Promise<void>,
  gasFor: { op: GasOp; then?: GasOp[] },
) {
  await assertRpcChain();
  const pre = await agentGasFor(w.account.address, to, data, gasFor.op, gasFor.then);
  const nm = (w.account as any).nonceManager;
  const nonce = nm ? await nm.consume({ address: w.account.address, chainId: CHAIN_ID, client: publicClient }) : undefined;
  const req: any = await w.client.prepareTransactionRequest({ to, data, value: 0n, chain, account: w.account, gas: pre.gas, ...pre.fees, ...(nonce !== undefined ? { nonce } : {}) } as any);
  const serializedTransaction = await w.client.signTransaction(req);
  const hash = keccak256(serializedTransaction);
  await onHash({ hash, nonce: Number(req.nonce) });
  await publicClient.sendRawTransaction({ serializedTransaction });
  const r = await receiptOf(hash);
  console.log(`${label}: ${r.status} ${tx(hash)}`);
  await sleep(3500);
  if (r.status !== "success") throw Object.assign(new Error(`${label} reverted on chain: ${hash}`), { txHash: hash, blockNumber: r.blockNumber, feeWei: feeOf(r) });
  return { hash, blockNumber: r.blockNumber, feeWei: feeOf(r) };
}

// ---- contexts (contract rule 1) ----
//   readCtx    no secret file: public addresses and expiry (public file, falling back to nothing else)
//   agentCtx   the agent key file only (buy, and the agent's own steps of recover)
//   ownerCtx   the owner key file named with --owner-key-file (tests and automation only)
//   escrowCtx  that owner key file, acting as the agent with an escrowed agent key (recover, when no agent file is here)
export type Pub = { owner: Address; agent: Address; cap?: bigint; expiry?: number; setAt?: number; revokedAt?: number };
export function readCtx(): Pub {
  const p = publicEnv();
  const owner = p.B4_OWNER_ADDRESS, agent = p.B4_AGENT_ADDRESS;
  if (!owner || !agent || !isAddress(owner) || !isAddress(agent)) {
    console.error(`error: no budget has been set up here for ${CFG.label}: ${PUBLIC_ENV} records no owner and agent (the owner runs superstables budget setup --rail evm${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`} first)`);
    process.exit(1);
  }
  return {
    owner: owner as Address, agent: agent as Address,
    cap: p.B4_CAP ? BigInt(p.B4_CAP) : undefined,
    expiry: p.B4_EXPIRY ? Number(p.B4_EXPIRY) : undefined,
    setAt: p.B4_SET_AT ? Number(p.B4_SET_AT) : undefined,
    revokedAt: p.B4_REVOKED_AT ? Number(p.B4_REVOKED_AT) : undefined,
  };
}
export async function agentCtx() {
  const pub = readCtx();
  const env = agentEnv(); // refuses a key file other users can read
  const key = need(env, "B4_AGENT_KEY", AGENT_ENV) as Hex;
  const agent = walletFor(key);
  if (agent.account.address.toLowerCase() !== pub.agent.toLowerCase()) throw new Error(`the agent key in ${AGENT_ENV} does not match the agent address in the public file, ${pub.agent}`);
  if (env.B4_OWNER_ADDRESS && env.B4_OWNER_ADDRESS.toLowerCase() !== pub.owner.toLowerCase()) throw new Error(`owner address in ${AGENT_ENV} differs from the public state`);
  return { ...pub, wallet: agent, agentKey: key };
}
export type AgentCtx = Awaited<ReturnType<typeof agentCtx>>;
/** The owner key file given with --owner-key-file (mode 600). Refuses a file others can read. */
export function ownerKeyEnv(): Record<string, string> {
  const path = OWNER_KEY_FILE;
  if (!path) usageError("this step needs the owner: approve it in your wallet (the default), or pass --owner-key-file <path> for tests and automation");
  if (!existsSync(path)) usageError(`--owner-key-file ${path} does not exist`);
  if ((statSync(path).mode & 0o077) !== 0) usageError(`--owner-key-file ${path} can be read by other users: chmod 600 ${path}`);
  try {
    return parseSecretLines(path, "--owner-key-file");
  } catch (err) {
    usageError((err as Error).message);
  }
}
export async function ownerCtx() {
  const pub = readCtx();
  const key = need(ownerKeyEnv(), "B4_OWNER_KEY", OWNER_KEY_FILE!) as Hex;
  const owner = walletFor(key);
  if (owner.account.address.toLowerCase() !== pub.owner.toLowerCase()) throw new Error(`the owner key in ${OWNER_KEY_FILE} does not match the owner address in the public file, ${pub.owner}`);
  return { ...pub, wallet: owner };
}
export type OwnerCtx = Awaited<ReturnType<typeof ownerCtx>>;
/** The owner key file with an escrowed agent key: the owner acts as the agent (recover without an agent file). */
export async function escrowCtx() {
  const o = await ownerCtx();
  const key = need(ownerKeyEnv(), "B4_AGENT_KEY_ESCROW", OWNER_KEY_FILE!) as Hex;
  const agent = walletFor(key);
  if (agent.account.address.toLowerCase() !== o.agent.toLowerCase()) throw new Error(`the escrowed agent key in ${OWNER_KEY_FILE} does not match the agent address in the public file, ${o.agent}`);
  return { ...o, escrow: agent };
}

// ---- self revoke (the agent lowers its own allowance without moving money) ----
// transferFrom(owner, owner, n) spends n of the agent's allowance and moves n from the owner to the owner. It needs the owner's
// balance to be at least n, so n = min(remaining allowance, owner balance); whatever is left is reported.
export type SelfRevoke = { state: "nothing" | "revoked" | "partial" | "blocked"; before: bigint; after: bigint; used: bigint; ownerBalance: bigint; tx?: Hex; note: string };
export async function selfRevokeCore(w: Wallet, owner: Address, log: (s: string) => void = console.log): Promise<SelfRevoke> {
  const agent = w.account.address;
  const before = await allowanceOf(owner, agent);
  const ownerBalance = await usdcBalance(owner);
  if (before === 0n) return { state: "nothing", before, after: 0n, used: 0n, ownerBalance, note: "allowance is already 0" };
  const n = before < ownerBalance ? before : ownerBalance;
  if (n === 0n) return { state: "blocked", before, after: before, used: 0n, ownerBalance, note: `owner ${SYM} balance is 0, so transferFrom cannot lower the allowance (${usdc(before)} ${SYM} stays). The owner must revoke` };
  log(`selfRevoke: transferFrom(owner, owner, ${usdc(n)} ${SYM}) by the agent (allowance ${usdc(before)}, owner balance ${usdc(ownerBalance)})`);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [owner, owner, n] });
  const sent = await send(w, USDC, data, "selfRevoke transferFrom(owner, owner)", { op: "selfRevoke" });
  const after = await readUntil(() => allowanceOf(owner, agent), (v) => v === before - n);
  return {
    state: after === 0n ? "revoked" : "partial", before, after, used: n, ownerBalance, tx: sent.hash,
    note: after === 0n ? "allowance is 0" : `owner balance covered only ${usdc(n)} ${SYM}; ${usdc(after)} ${SYM} of allowance remains. The owner revokes the rest`,
  };
}

// ---- the owner plans: grant, fund-agent, recover ----
/**
 * The public addresses for a command that builds an owner plan (grant, fund-agent, recover). Before it returns, the owner's setup
 * signature in the public file must name this agent address for the owner on record, the address must be the agent key on this
 * machine when that key file is here, and it must not be retired (../owner-binding.mjs). Otherwise the command ends here with exit 3,
 * before any page, request or send. A public file from before the signature was kept goes on, with one warning line on stderr, on a
 * testnet only. `retiredOk` skips the retired list: only recover sets it, because returning a retired key's funds to the signed owner is
 * what `budget rotate` needs; the key file and signature checks still apply.
 */
export async function ownerPlanCtx({ retiredOk = false }: { retiredOk?: boolean } = {}): Promise<Pub> {
  const pub = readCtx();
  let keyAgent: string | null = null;
  if (existsSync(AGENT_ENV)) {
    const file = agentFileValues();
    if (file.problem !== undefined) return refusePlan(pub, file.problem);
    const key = file.env.B4_AGENT_KEY;
    if (!key) return refusePlan(pub, `${AGENT_ENV} has no B4_AGENT_KEY`);
    try { keyAgent = privateKeyToAccount(key as Hex).address; } catch { return refusePlan(pub, `${AGENT_ENV} holds a B4_AGENT_KEY that is not a key`); }
  }
  const b = await agentBinding("evm", { owner: pub.owner, agent: pub.agent, lines: publicEnv() }, { keyAgent, file: PUBLIC_ENV, retiredOk, testnet: (EVM_CHAINS as Record<string, { testnet?: unknown }>)[CFG.key]?.testnet === true });
  if (b.state === "refused") return refusePlan(pub, b.problem);
  if (b.state === "legacy") console.error(legacyWarning("evm", PUBLIC_ENV, pub.agent, `${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`}${hostedFlags(publicEnv())}`));
  return pub;
}
function refusePlan(pub: Pub, problem: string): never {
  console.log(`REFUSED: ${problem}. Nothing was asked or sent.`);
  const chainFlag = CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`;
  process.exit(emit(basename(process.argv[1] ?? "unknown").replace(/\.(?:ts|mjs)$/, ""), 3, { state: "refused_precheck", reason: problem, agent: pub.agent, next: `check ${PUBLIC_ENV}: run superstables budget setup --rail evm${chainFlag}${hostedFlags(publicEnv())} where the agent key is, to record the owner's signature again. The owner can still end the allowance from any machine: superstables budget revoke --rail evm${chainFlag}` }));
}
