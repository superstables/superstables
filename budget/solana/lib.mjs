// Shared helpers for the Solana superstables budget scripts.
// Never logs a secret key or seed phrase.
//
// Keys (paths from ../paths.mjs):
//   the owner's wallet  holds the owner key. setup, grant, revoke and fund-agent ask it on the owner page (owner.ts).
//   solana-agent.env    agent secret. buy opens only this; setup creates it.
//   public file         public addresses only. Read commands (readBudget, reconcile) and owner commands use it.
//   an owner key file   tests and automation only, named with --owner-key-file <path> (mode 600):
//                       SOLANA_OWNER_SECRET_BASE58. The default path ownerKeyFile("solana") is never read.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { HOME, ensurePrivateDir, ownerKeyFile, agentKeyFile, publicFile, opsDir } from "../paths.mjs";
import { readAgentSecret } from "../os-keychain.mjs";
import { UNSAFE_SECRET_FILE, readSecretFile, replaceSecretFile } from "../secret-file.mjs";
import { DEFAULT_RPC, SOLANA_RPC_MAX_BYTES, budgetCall, cappedRpcFetch, jsonRpc, rpcFromEnv } from "../rpc.mjs";
import { markSend } from "../proof.mjs";
import { agentBinding, hostedFlags, legacyWarning } from "../owner-binding.mjs";
import { noteBinding } from "../page-facts.mjs";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";
import { chainGate, chainGateSettings } from "../../src/core/chain-gate.js";
import { endpointSet } from "../../src/core/rpc-endpoints.mjs";
import { agreeAtFinalSolana, agreementWords, checkIdentity } from "../../src/core/rpc-quorum.mjs";
import { TOKEN_PROGRAM_ID, decodeTokenAccount } from "./token.mjs";
import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";

// Fail loudly but cleanly: print the on-chain/RPC error message (and logs,
// if any) without a full stack trace, then exit non-zero. This is what
// callers of these scripts should see for a refused payment or an
// unfunded fee payer, not a raw JS crash.
// A failed top-level await in an ES module raises uncaughtException (as do synchronous throws and unhandled rejections).
// The owner page's handler (owner-page.ts), once installed, prints and exits itself.
// Every rail's crash handler carries this mark (the EVM library's too). A handler steps aside for any listener that is not
// marked (the owner page's) and, when several marked ones are loaded in one process, for all but the first.
const RAIL_CRASH_HANDLER = Symbol.for("superstables.railCrashHandler");
// A program log is a program's words, never a line of the client's: each entry follows fixed client text, so one that starts
// with RESULT or APPROVE cannot stand at the start of a line.
const logLine = (l) => `RPC log: ${oneLine(l, 500)}`;
const crashHandler = async (err) => {
  const listeners = process.listeners("uncaughtException");
  if (listeners.some((l) => !l[RAIL_CRASH_HANDLER]) || listeners.find((l) => l[RAIL_CRASH_HANDLER]) !== crashHandler) return;
  // the RPC's words and a program's logs are outside text: one line each, no hidden characters (oneLine, below)
  console.error("\nFailed:", oneLine(err?.message ?? err, 1000));
  if (typeof err?.getLogs === "function") {
    try {
      const logs = await err.getLogs();
      if (logs?.length) console.error("Logs:\n" + logs.map(logLine).join("\n"));
    } catch {
      // ignore, we already printed the message
    }
  } else if (err?.logs?.length) {
    console.error("Logs:\n" + err.logs.map(logLine).join("\n"));
  }
  process.exit(1);
};
crashHandler[RAIL_CRASH_HANDLER] = true;
process.on("uncaughtException", crashHandler);

/** Solana devnet is a testnet. The chain gate (../../src/core/chain-gate.js) signs on nothing else in this build. */
export const TESTNET = true;
// SUPERSTABLES_SOLANA_RPC replaces the devnet RPC URL for reads (tests point it at a local fake; you can point it at your own node).
// https, or http on this computer only (../rpc.mjs): anything else is ignored here with a warning, and the dispatcher refuses
// the command before it runs a script. Owner commands and the verdicts that let an agent pay again do not take the replacement
// on its word: they use the endpoints the owner set (src/core/rpc-endpoints.mjs), and a replacement that is not one of them is
// refused there (an owner command exits 3; a verdict stays unknown, with that reason).
const envRpc = (() => {
  const r = rpcFromEnv("SUPERSTABLES_SOLANA_RPC", DEFAULT_RPC.solana, "read", "solana-devnet");
  if (r.error) process.stderr.write(`warning: ${r.error}; using ${DEFAULT_RPC.solana}\n`);
  // custom is also true for the owner's own URL (source "settings"): that one is not the variable
  return r.custom && r.source !== "settings" ? r.url : undefined;
})();
/** The endpoints for a purpose: "read" (balances, searches, the primary), "verdict" (what lets an agent pay again) or "owner" (what an owner command reads and sends through). */
export function solanaSet(purpose = "read") {
  return endpointSet("solana-devnet", purpose, { envUrl: envRpc, envName: "SUPERSTABLES_SOLANA_RPC", testnet: TESTNET });
}
/** The URL a connection for `purpose` talks to. Throws (in words) when the owner settings cannot be read. */
export function rpcUrl(purpose = "read") {
  const set = solanaSet(purpose === "owner" ? "owner" : "read");
  if ("error" in set) throw new Error(set.error);
  return set.primary.url;
}
export const RPC_URL = (() => { try { return rpcUrl("read"); } catch { return DEFAULT_RPC.solana; } })();
export const EXPLORER_CLUSTER = "?cluster=devnet";
export const USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);
export const USDC_DECIMALS = 6;
/** The chain gate for this rail's one chain: "" when this build may sign, ask the owner's wallet or send on it, else why not. */
const solanaGate = () => chainGate({ rail: "solana", key: "solana-devnet", testnet: TESTNET, token: { symbol: "USDC", address: USDC_MINT.toBase58(), decimals: USDC_DECIMALS } }, chainGateSettings());
// No Solana budget script runs on a chain this build does not sign on: it refuses here, as it loads, before it reads a
// key file or asks an RPC anything.
if (solanaGate()) {
  const command = String(process.argv[1] ?? "").split(/[\\/]/).pop().replace(/\.(?:ts|mjs)$/, "") || "solana";
  console.error(`REFUSED: ${solanaGate()}. Nothing was signed or sent.`);
  console.log(`RESULT ${JSON.stringify({ ok: false, command, rail: "solana", chain: "devnet", state: "refused_precheck", reason: solanaGate(), next: "nothing was signed or sent; this build signs on Solana devnet only" })}`);
  process.exit(3);
}

export const OWNER_KEY_PATH = ownerKeyFile("solana");
export const AGENT_KEY_PATH = agentKeyFile("solana");
export const PUBLIC_PATH = publicFile("solana", "devnet");
export const OPS_DIR = opsDir("solana", "devnet");

const rpcFetch = cappedRpcFetch(SOLANA_RPC_MAX_BYTES);
/** A connection to `url`: a broadcast prints SENDING before it leaves (../proof.mjs); every answer is read through cappedRpcFetch (../rpc.mjs). */
export function connectionTo(url) {
  return new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true, confirmTransactionInitialTimeout: 15_000, fetch: (u, init) => { markSend(init?.body); return rpcFetch(u, { ...init, signal: AbortSignal.timeout(10_000) }); } });
}
/** The connection for reads (the default) or for an owner command, which reads and sends through the owner's endpoints. */
export function connection(purpose = "read") {
  return connectionTo(rpcUrl(purpose));
}

/** The RPC's host, for words: a replacement's path or query can carry an access key, so never the whole URL. */
export const RPC_HOST = (() => { try { return new URL(RPC_URL).host; } catch { return "the Solana RPC"; } })();
const hostOf = (url) => { try { return new URL(url).host; } catch { return "the Solana RPC"; } };
/** What to do when the RPC is on another cluster. */
export const CLUSTER_NEXT = "unset SUPERSTABLES_SOLANA_RPC, or set it to a Solana devnet RPC, then run the command again";
/**
 * Why `conn` must not be used for a budget transaction, in words, or "" when its RPC answers Solana devnet's genesis
 * hash. Asked before a blockhash is fetched, a transaction is offered to a wallet, signed or sent, and before a read
 * that decides one: a SOL transfer names no cluster, so one built on another cluster's blockhash moves SOL there. A
 * genesis that cannot be read is a reason too.
 */
export async function clusterProblem(conn) {
  const gate = solanaGate();
  if (gate) return gate;
  const host = conn?.rpcEndpoint ? hostOf(conn.rpcEndpoint) : RPC_HOST;
  let genesis;
  try {
    genesis = await retryRead(() => conn.getGenesisHash());
  } catch (err) {
    return `could not read which Solana cluster ${host} is on (${oneLine(err?.message ?? err, 160)})`;
  }
  if (genesis === SOLANA_DEVNET_GENESIS) return "";
  return `the Solana RPC ${host} is not on Solana devnet (its genesis hash is ${oneLine(genesis, 60)})`;
}

/** A JSON-RPC call to `url` for the agreement engine: plain data in and out, with a timeout. */
export const rpcCall = (url, method, params) => budgetCall(url, method, params, 10_000);

/** The confirming endpoints for `purpose` ("read" or "owner"): the engine's verdict set, with the genesis of each checked before it is read. */
export function solanaVerdictSet(purpose = "read") {
  return solanaSet(purpose === "owner" ? "owner" : "verdict");
}

/** A finalized slot a little behind the primary's, for a verdict of absence that has no recorded slot of its own. */
export async function recentFinalizedSlot(conn, behind = 32) {
  const slot = await retryRead(() => conn.getSlot("finalized"));
  return BigInt(Math.max(0, slot - behind));
}

/**
 * The owner's token account read from every confirming endpoint at `finalized`, from one common slot on. Resolves to the
 * engine's answer: { agreed: true, value, slot, agreement } where value is null (the chain says the account does not exist) or
 * { owner, delegate, delegatedAmount, amount } as strings and bigints, else { agreed: false, why, reason }.
 * A verdict of absence (no account, no delegate) must pass `atLeast`: the slot from which it has to hold.
 * @param {string} address the token account
 * @param {{ minSlot?: bigint, atLeast?: bigint, purpose?: "read"|"owner" }} [o]
 */
export function agreedAccount(address, { minSlot, atLeast, purpose = "read" } = {}) {
  return agreeAtFinalSolana({
    set: solanaVerdictSet(purpose),
    call: rpcCall,
    genesis: SOLANA_DEVNET_GENESIS,
    minSlot,
    atLeast,
    read: async (url, slot) => {
      const got = await jsonRpc(url, "getAccountInfo", [address, { commitment: "finalized", minContextSlot: Number(slot), encoding: "base64" }], 10_000);
      const at = got?.context?.slot;
      if (!Number.isSafeInteger(at)) throw new Error("no context slot");
      if (got.value === null) return { slot: at, value: null };
      const info = got.value;
      const data = Array.isArray(info?.data) && info.data[1] === "base64" && typeof info.data[0] === "string" ? Buffer.from(info.data[0], "base64") : null;
      if (info.owner !== TOKEN_PROGRAM_ID.toBase58() || !data || data.length < 165) throw new Error("not a token account");
      const acc = decodeTokenAccount(data);
      return { slot: at, value: { owner: acc.owner.toBase58(), delegate: acc.delegate ? acc.delegate.toBase58() : null, delegatedAmount: acc.delegatedAmount, amount: acc.amount } };
    },
  });
}

/** How an agreement is said in a line: the label when agreed, else the reason in words. */
export const agreementLine = (a) => (a.agreed ? a.agreement : agreementWords(a));
export { checkIdentity };

// Exact decimal parse. Throws on anything that is not a plain non-negative
// decimal or that has more than `decimals` fractional digits (no rounding).
export function parseUnits(text, decimals = USDC_DECIMALS) {
  const s = String(text).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`'${s}' is not a plain decimal amount`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    throw new Error(`'${s}' has ${frac.length} decimals; USDC allows ${decimals}`);
  }
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(baseUnits, decimals = USDC_DECIMALS) {
  const v = BigInt(baseUnits);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function toBaseUnits(uiAmount) {
  return parseUnits(String(uiAmount));
}

export function fromBaseUnits(baseUnits) {
  return Number(BigInt(baseUnits)) / 10 ** USDC_DECIMALS;
}

export function explorerTx(sig) {
  return `https://explorer.solana.com/tx/${sig}${EXPLORER_CLUSTER}`;
}

export function explorerAddr(addr) {
  return `https://explorer.solana.com/address/${addr}${EXPLORER_CLUSTER}`;
}

export function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnvText(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Key files. Each loader opens exactly one file.
// ---------------------------------------------------------------------------
function requireFile(path, what, hint) {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}${hint ? ` (${hint})` : ""}`);
}

export function parseEnvText(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A key file's values. Refuses (throws) a file other users can read, or anything that is not a regular file. */
export function parseSecretEnvFile(path, what) {
  return parseEnvText(readSecretFile(path, what));
}

/**
 * The agent key file's values, with the key put in when the file names the OS keychain instead of holding it (setup
 * --key-store os-keychain): then SOLANA_AGENT_SECRET_BASE58 is what the keychain returns. Refuses (UNSAFE_SECRET_FILE) a file that
 * names the keychain and also holds a key, an unknown store, or an entry that is missing.
 */
function agentFileEnv(path, what) {
  const env = parseSecretEnvFile(path, what);
  const store = env.SOLANA_AGENT_KEY_STORE;
  if (store === undefined) return env;
  const refuse = (message) => Object.assign(new Error(message), { code: UNSAFE_SECRET_FILE });
  if (store !== "os-keychain") throw refuse(`${what} ${path} names an unknown key store "${String(store).slice(0, 40)}"`);
  if (env.SOLANA_AGENT_SECRET_BASE58) throw refuse(`${what} ${path} names the keychain and also holds a key`);
  if (!env.SOLANA_AGENT_ADDRESS) throw refuse(`${what} ${path} names the keychain but no agent address`);
  try {
    env.SOLANA_AGENT_SECRET_BASE58 = readAgentSecret("solana", env.SOLANA_AGENT_ADDRESS);
  } catch (err) {
    throw refuse(`${err.message} (${what} ${path} says it is there)`);
  }
  return env;
}

/**
 * The agent key file's values for a command that must refuse cleanly rather than throw: `{ env }` ({} when there is no
 * file), or `{ problem }` when the file must not be used (readable by other users, not a regular file). Read once, and
 * checked on the file actually read, so ask again after any wait instead of keeping an earlier answer.
 * @returns {{ env: Record<string, string>, problem?: undefined } | { env?: undefined, problem: string }}
 */
export function agentKeyFileValues() {
  try {
    return { env: agentFileEnv(AGENT_KEY_PATH, "the agent key file") };
  } catch (err) {
    if (err && err.code === "ENOENT") return { env: {} };
    if (err && err.code === UNSAFE_SECRET_FILE) return { problem: err.message };
    throw err;
  }
}

function loadKeypair(path, secretName, addressName, what, read = parseSecretEnvFile) {
  requireFile(path, what);
  // Mode 600 is set when the file is written, but a restore, a `cp` without -p or an editor can leave it
  // readable by other users, and every purchase from here on would then be signed with a key this machine
  // no longer keeps to itself. Refuse rather than quietly re-tighten; the check is on the file actually read.
  const env = read(path, what);
  const secret = env[secretName];
  if (!secret) throw new Error(`${secretName} missing from ${path}`);
  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  if (env[addressName] && keypair.publicKey.toBase58() !== env[addressName]) {
    throw new Error(`${secretName} does not match ${addressName} in ${path}`);
  }
  return { keypair, env };
}

const pk = (env, name) => (env[name] ? new PublicKey(env[name]) : null);

// Tests and automation only: the owner key file named with --owner-key-file (the caller checks its mode).
export function loadOwner(path) {
  const { keypair } = loadKeypair(path, "SOLANA_OWNER_SECRET_BASE58", "SOLANA_OWNER_ADDRESS", "Owner key file");
  return { keypair };
}

// Agent commands only. Opens solana-agent.env, never the owner file.
export function loadAgent() {
  const { keypair, env } = loadKeypair(AGENT_KEY_PATH, "SOLANA_AGENT_SECRET_BASE58", "SOLANA_AGENT_ADDRESS", "Agent key file", agentFileEnv);
  return { keypair, owner: pk(env, "SOLANA_OWNER_ADDRESS") };
}

// Public addresses (no secret file). Null fields when the file is absent.
export function readPublic() {
  const env = existsSync(PUBLIC_PATH) ? parseEnvFile(PUBLIC_PATH) : {};
  return {
    owner: pk(env, "SOLANA_OWNER_ADDRESS"),
    agent: pk(env, "SOLANA_AGENT_ADDRESS"),
  };
}

// Merge-writes public values into the public state file (no secrets). `drop` names keys to remove (setup on this computer
// drops APPROVALS and SITE).
export function writePublic(pairs, drop = []) {
  const env = existsSync(PUBLIC_PATH) ? parseEnvFile(PUBLIC_PATH) : {};
  Object.assign(env, pairs);
  for (const k of drop) delete env[k];
  ensurePrivateDir(dirname(PUBLIC_PATH), { root: HOME });
  const body =
    "# Solana devnet public addresses only. Read commands use this file. No secrets.\n" +
    Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join("");
  writeFileSync(PUBLIC_PATH, body);
}

export async function getSolBalance(conn, pubkey) {
  const lamports = await conn.getBalance(pubkey, "confirmed");
  return lamports / 1e9;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Replace a file that holds the only copy of a key: write a new file (mode 600, never an existing one) next to it and
// rename it over the old in one step, so a crash or a full disk leaves the old file or the new one, never a truncated one.
export function replaceKeyFile(path, text) {
  replaceSecretFile(path, text);
}

// Seller text (its 402, its answer, its headers, its errors) on one log line, at most `max` characters: control characters,
// newlines included, become spaces; format, bidi and Unicode tag characters are removed. A seller must not be able to start a
// line of its own on stdout, where the dispatcher reads APPROVE and RESULT lines. The same rule as untrustedText
// (src/core/text.ts).
export function oneLine(s, max = 300) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064]/gu, "").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Strict CLI parsing (rule 6). Runs before any env file is read or any RPC
// call is made. --help / -h prints usage and exits 0; an unknown flag, a
// positional argument, a flag missing its value or a missing required flag
// prints the problem plus usage on stderr and exits 2.
//   spec: { flagName: "value" | "bool" }
// ---------------------------------------------------------------------------
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, REFUSED: 3, UNCERTAIN: 4 };

export function usageError(message, usage) {
  console.error(`Error: ${message}\n`);
  console.error(usage);
  process.exit(EXIT.USAGE);
}

export function parseStrict(argv, spec, { usage, required = [], allowPositional = 0 } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    process.exit(EXIT.OK);
  }
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) usageError(`unknown option ${a}`, usage);
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (!Object.hasOwn(spec, name)) usageError(`unknown flag --${name}`, usage);
    if (spec[name] === "bool") {
      if (eq !== -1) {
        const v = a.slice(eq + 1);
        if (v !== "true" && v !== "false") usageError(`--${name} takes no value`, usage);
        flags[name] = v === "true";
      } else flags[name] = true;
    } else if (eq !== -1) {
      flags[name] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) usageError(`--${name} needs a value`, usage);
      flags[name] = next;
      i++;
    }
    if (flags[name] === "") usageError(`--${name} needs a value`, usage);
  }
  if (positional.length > allowPositional) usageError(`unexpected argument '${positional[allowPositional]}'`, usage);
  for (const r of required) if (flags[r] === undefined) usageError(`missing required flag --${r}`, usage);
  flags._ = positional;
  return flags;
}

export function parsePubkeyFlag(flags, name, usage) {
  if (flags[name] === undefined) return null;
  try {
    return new PublicKey(flags[name]);
  } catch {
    return usageError(`--${name} is not a valid address`, usage);
  }
}

export function parseAmountFlag(flags, name, usage) {
  if (flags[name] === undefined) return null;
  try {
    return parseUnits(flags[name]);
  } catch (e) {
    return usageError(`--${name}: ${e.message}`, usage);
  }
}

// Reads (never payments) retry with backoff: the public devnet RPC answers 429 under load.
export async function retryRead(fn, tries = 6) {
  let delay = 700;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const rate = /429|Too Many|rate/i.test(String(e?.message ?? e));
      if (!rate || i >= tries) throw e;
      await sleep(delay);
      delay *= 1.7;
    }
  }
}

/**
 * The owner and agent of an owner plan (grant, fund-agent), as PublicKeys. Before it returns, the owner's setup signature in the
 * public file must name this agent address for the owner on record, the address must be the agent key on this machine when that
 * key file is here, and it must not be retired (../owner-binding.mjs). Otherwise `refuse(reason, next)` ends the command (exit 3)
 * before any page or send. A public file from before the signature was kept goes on, with one warning line on stderr.
 */
export async function ownerPlanCtx(refuse) {
  const env = existsSync(PUBLIC_PATH) ? parseEnvFile(PUBLIC_PATH) : {};
  const owner = pk(env, "SOLANA_OWNER_ADDRESS");
  const agent = pk(env, "SOLANA_AGENT_ADDRESS");
  if (!owner || !agent) return refuse("the public file names no owner or no agent", "superstables budget setup --rail solana");
  const next = `check the public file: run superstables budget setup --rail solana${hostedFlags(env)} where the agent key is, to record the owner's signature again. The owner can still end the delegation from any machine: superstables budget revoke --rail solana`;
  let keyAgent = null;
  if (existsSync(AGENT_KEY_PATH)) {
    const file = agentKeyFileValues();
    if (file.problem !== undefined) return refuse(file.problem, next);
    try {
      keyAgent = Keypair.fromSecretKey(bs58.decode(file.env.SOLANA_AGENT_SECRET_BASE58 ?? "")).publicKey.toBase58();
    } catch {
      return refuse(`${AGENT_KEY_PATH} has no usable SOLANA_AGENT_SECRET_BASE58`, next);
    }
  }
  const b = await agentBinding("solana", { owner: owner.toBase58(), agent: agent.toBase58(), lines: env }, { keyAgent, file: PUBLIC_PATH, testnet: TESTNET === true });
  if (b.state === "refused") return refuse(b.problem, next);
  noteBinding(b); // the page this plan opens says whether the owner signed this agent
  if (b.state === "legacy") console.error(legacyWarning("solana", PUBLIC_PATH, agent.toBase58(), hostedFlags(env)));
  return { owner, agent };
}
