// Shared helpers for B4 (plain ERC-20 approve, pull then pay) on any chain in chains.ts. Never prints keys.
// One implementation for every EVM chain: the chain table (chains.ts), per-chain state files, native gas accounting
// (`nativeBalance`, `gasFmt`), unified RESULT lines (`emit`) and messages that name the chain.
//   owner  approve(agent, cap)               (setBudget), approve(agent, 0) (revokeBudget)
//   agent  USDC.transferFrom(owner, agent, price), then pays the seller with its own EIP-3009 signature
//   agent  USDC.transferFrom(owner, owner, n)  (selfRevoke): lowers its own allowance without moving money
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, formatUnits, parseUnits, keccak256, isAddress,
  type Address, type Hex, type NonceManager,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { CFG } from "./chains.ts";
import { agentKeyFile, publicFile, opsDir } from "../paths.mjs";

export { CFG };
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
 * Seller text (its 402, its answer, its errors) on one log line: control characters, newlines included, become spaces. A seller
 * must not be able to start a line of its own on stdout, where the dispatcher reads APPROVE and RESULT lines.
 */
export const oneLine = (s: unknown, max = 300): string => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max);
/** A command line for a next step, with this chain selected. */
export const cmd = (script: string, rest = "") => `npx tsx budget/evm/${script}${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`}${rest ? ` ${rest}` : ""}`;

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
/** USDC has 6 decimals on both chains: refuse anything with more precision instead of rounding it. */
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
export function parseLines(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}
export const agentEnv = () => parseLines(AGENT_ENV);
export const publicEnv = () => parseLines(PUBLIC_ENV);
export function need(env: Record<string, string>, k: string, file: string): string {
  if (!env[k]) {
    console.error(`error: missing ${k} in ${file} (superstables budget setup --rail evm creates the agent key and the public file)`);
    process.exit(emit(basename(process.argv[1] ?? "unknown").replace(/\.(?:ts|mjs)$/, ""), 1, { state: "failed", reason: `missing ${k} in ${file}`, next: "run superstables budget setup --rail evm" }));
  }
  return env[k];
}
/** Append KEY=VALUE lines to a key file (created mode 600) for keys that are not there yet. Never prints. */
export function appendEnvTo(path: string, pairs: Record<string, string>) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const cur = parseLines(path);
  let add = "";
  for (const [k, v] of Object.entries(pairs)) if (!cur[k]) add += `${k}=${v}\n`;
  if (!add) return;
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  const text = readFileSync(path, "utf8");
  appendFileSync(path, (text === "" || text.endsWith("\n") ? "" : "\n") + add, { mode: 0o600 });
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
export const publicClient = createPublicClient({ chain, transport: http(RPC, { retryCount: 5, retryDelay: 400 }) });
export const walletFor = (key: Hex, opts?: { nonceManager?: NonceManager }) => {
  const account = privateKeyToAccount(key, opts?.nonceManager ? { nonceManager: opts.nonceManager } : undefined);
  return { account, client: createWalletClient({ account, chain, transport: http(RPC, { retryCount: 5, retryDelay: 400 }) }) };
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
  return m.replace(/\s+/g, " ").slice(0, 400);
}

// ---- sending ----
/** Refuse to sign anything when the RPC does not answer for the chain in chains.ts (a mainnet RPC behind a testnet name, a wrong URL). Read once. */
let rpcChecked = false;
export async function assertRpcChain() {
  if (rpcChecked) return;
  const id = Number(await retry(() => publicClient.request({ method: "eth_chainId" })));
  if (id !== CFG.chainId) {
    console.error(`REFUSED: the RPC ${RPC} answers chain id ${id}, not ${CFG.chainId} (${CFG.label}). Nothing was signed or sent.`);
    process.exit(3);
  }
  rpcChecked = true;
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
  if (r.status !== "success") throw new Error(`${label} reverted on chain: ${hash}`);
  return { hash, feeWei: feeOf(r) };
}
export async function send(w: Wallet, to: Address, data: Hex, label: string) {
  await assertRpcChain();
  const hash = await w.client.sendTransaction({ to, data, value: 0n, chain, account: w.account });
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
 * `gas` skips the gas estimation (used only to force a transaction that the chain will revert, to read its refusal).
 */
export async function sendJournaled(
  w: Wallet, to: Address, data: Hex, label: string,
  onHash: (h: { hash: Hex; nonce: number }) => void | Promise<void>,
  opts: { gas?: bigint } = {},
) {
  await assertRpcChain();
  const nm = (w.account as any).nonceManager;
  const nonce = nm ? await nm.consume({ address: w.account.address, chainId: CHAIN_ID, client: publicClient }) : undefined;
  const req: any = await w.client.prepareTransactionRequest({ to, data, value: 0n, chain, account: w.account, ...(nonce !== undefined ? { nonce } : {}), ...(opts.gas ? { gas: opts.gas } : {}) } as any);
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
    console.error(`error: no B4 addresses in ${PUBLIC_ENV} (run superstables budget setup --rail evm${CFG.key === "base-sepolia" ? "" : ` --chain ${CFG.key}`} first)`);
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
  const env = agentEnv();
  const key = need(env, "B4_AGENT_KEY", AGENT_ENV) as Hex;
  const agent = walletFor(key);
  if (agent.account.address.toLowerCase() !== pub.agent.toLowerCase()) throw new Error(`the agent key in ${AGENT_ENV} does not match the B4 agent address ${pub.agent}`);
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
  return parseLines(path);
}
export async function ownerCtx() {
  const pub = readCtx();
  const key = need(ownerKeyEnv(), "B4_OWNER_KEY", OWNER_KEY_FILE!) as Hex;
  const owner = walletFor(key);
  if (owner.account.address.toLowerCase() !== pub.owner.toLowerCase()) throw new Error(`the owner key in ${OWNER_KEY_FILE} does not match the B4 owner address ${pub.owner}`);
  return { ...pub, wallet: owner };
}
export type OwnerCtx = Awaited<ReturnType<typeof ownerCtx>>;
/** The owner key file with an escrowed agent key: the owner acts as the agent (recover without an agent file). */
export async function escrowCtx() {
  const o = await ownerCtx();
  const key = need(ownerKeyEnv(), "B4_AGENT_KEY_ESCROW", OWNER_KEY_FILE!) as Hex;
  const agent = walletFor(key);
  if (agent.account.address.toLowerCase() !== o.agent.toLowerCase()) throw new Error(`the escrowed agent key in ${OWNER_KEY_FILE} does not match the B4 agent address ${o.agent}`);
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
  const sent = await send(w, USDC, data, "selfRevoke transferFrom(owner, owner)");
  const after = await readUntil(() => allowanceOf(owner, agent), (v) => v === before - n);
  return {
    state: after === 0n ? "revoked" : "partial", before, after, used: n, ownerBalance, tx: sent.hash,
    note: after === 0n ? "allowance is 0" : `owner balance covered only ${usdc(n)} ${SYM}; ${usdc(after)} ${SYM} of allowance remains. The owner revokes the rest`,
  };
}
