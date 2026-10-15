// Shared helpers for the Solana superstables budget scripts.
// Never logs a secret key or seed phrase.
//
// Keys (paths from ../paths.mjs):
//   the owner's wallet  holds the owner key. setup, grant, revoke and fund-agent ask it on the owner page (owner.ts).
//   solana-agent.env    agent secret. buy opens only this; setup creates it.
//   public file         public addresses only. Read commands (readBudget, reconcile) and owner commands use it.
//   an owner key file   tests and automation only, named with --owner-key-file <path> (mode 600):
//                       SOLANA_OWNER_SECRET_BASE58. The default path ownerKeyFile("solana") is never read.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ownerKeyFile, agentKeyFile, publicFile, opsDir } from "../paths.mjs";
import { UNSAFE_SECRET_FILE, readSecretFile, replaceSecretFile } from "../secret-file.mjs";
import { DEFAULT_RPC, SOLANA_RPC_MAX_BYTES, cappedRpcFetch, rpcFromEnv } from "../rpc.mjs";
import { markSend } from "../proof.mjs";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";
import { chainGate, chainGateSettings } from "../../src/core/chain-gate.js";
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
process.on("unhandledRejection", async (err) => {
  console.error("\nFailed:", err?.message ?? err);
  if (typeof err?.getLogs === "function") {
    try {
      const logs = await err.getLogs();
      if (logs?.length) console.error("Logs:\n" + logs.join("\n"));
    } catch {
      // ignore, we already printed the message
    }
  } else if (err?.logs?.length) {
    console.error("Logs:\n" + err.logs.join("\n"));
  }
  process.exit(1);
});

// SUPERSTABLES_SOLANA_RPC replaces the devnet RPC URL (tests point it at a local fake; you can point it at your own node).
// https, or http on this computer only (../rpc.mjs): anything else is ignored here with a warning, and the dispatcher refuses
// the command before it runs a script.
export const RPC_URL = (() => {
  const r = rpcFromEnv("SUPERSTABLES_SOLANA_RPC", DEFAULT_RPC.solana);
  if (r.error) process.stderr.write(`warning: ${r.error}; using ${DEFAULT_RPC.solana}\n`);
  return r.url;
})();
export const EXPLORER_CLUSTER = "?cluster=devnet";
/** Solana devnet is a testnet. The chain gate (../../src/core/chain-gate.js) signs on nothing else in this build. */
export const TESTNET = true;
/** The chain gate for this rail's one chain: "" when this build may sign, ask the owner's wallet or send on it, else why not. */
const solanaGate = () => chainGate({ rail: "solana", key: "solana-devnet", testnet: TESTNET }, chainGateSettings());
// No Solana budget script runs on a chain this build does not sign on: it refuses here, as it loads, before it reads a
// key file or asks an RPC anything.
if (solanaGate()) {
  const command = String(process.argv[1] ?? "").split(/[\\/]/).pop().replace(/\.(?:ts|mjs)$/, "") || "solana";
  console.error(`REFUSED: ${solanaGate()}. Nothing was signed or sent.`);
  console.log(`RESULT ${JSON.stringify({ ok: false, command, rail: "solana", chain: "devnet", state: "refused_precheck", reason: solanaGate(), next: "nothing was signed or sent; this build signs on Solana devnet only" })}`);
  process.exit(3);
}
export const USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);
export const USDC_DECIMALS = 6;

export const OWNER_KEY_PATH = ownerKeyFile("solana");
export const AGENT_KEY_PATH = agentKeyFile("solana");
export const PUBLIC_PATH = publicFile("solana", "devnet");
export const OPS_DIR = opsDir("solana", "devnet");

const rpcFetch = cappedRpcFetch(SOLANA_RPC_MAX_BYTES);
export function connection() {
  // a broadcast prints SENDING before it leaves (../proof.mjs); every answer is read through cappedRpcFetch (../rpc.mjs)
  return new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, confirmTransactionInitialTimeout: 15_000, fetch: (url, init) => { markSend(init?.body); return rpcFetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); } });
}

/** The RPC's host, for words: a replacement's path or query can carry an access key, so never the whole URL. */
export const RPC_HOST = (() => { try { return new URL(RPC_URL).host; } catch { return "the Solana RPC"; } })();
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
  let genesis;
  try {
    genesis = await retryRead(() => conn.getGenesisHash());
  } catch (err) {
    return `could not read which Solana cluster ${RPC_HOST} is on (${oneLine(err?.message ?? err, 160)})`;
  }
  if (genesis === SOLANA_DEVNET_GENESIS) return "";
  return `the Solana RPC ${RPC_HOST} is not on Solana devnet (its genesis hash is ${oneLine(genesis, 60)})`;
}

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
 * The agent key file's values for a command that must refuse cleanly rather than throw: `{ env }` ({} when there is no
 * file), or `{ problem }` when the file must not be used (readable by other users, not a regular file). Read once, and
 * checked on the file actually read, so ask again after any wait instead of keeping an earlier answer.
 * @returns {{ env: Record<string, string>, problem?: undefined } | { env?: undefined, problem: string }}
 */
export function agentKeyFileValues() {
  try {
    return { env: parseSecretEnvFile(AGENT_KEY_PATH, "the agent key file") };
  } catch (err) {
    if (err && err.code === "ENOENT") return { env: {} };
    if (err && err.code === UNSAFE_SECRET_FILE) return { problem: err.message };
    throw err;
  }
}

function loadKeypair(path, secretName, addressName, what) {
  requireFile(path, what);
  // Mode 600 is set when the file is written, but a restore, a `cp` without -p or an editor can leave it
  // readable by other users, and every purchase from here on would then be signed with a key this machine
  // no longer keeps to itself. Refuse rather than quietly re-tighten; the check is on the file actually read.
  const env = parseSecretEnvFile(path, what);
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
  const { keypair, env } = loadKeypair(AGENT_KEY_PATH, "SOLANA_AGENT_SECRET_BASE58", "SOLANA_AGENT_ADDRESS", "Agent key file");
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
  mkdirSync(dirname(PUBLIC_PATH), { recursive: true, mode: 0o700 });
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
