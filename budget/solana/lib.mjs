// Shared helpers for the Solana superstables budget scripts.
// Never logs a secret key or seed phrase.
//
// Keys (paths from ../paths.mjs):
//   the owner's wallet  holds the owner key. setup, grant, revoke and fund-agent ask it on the owner page (owner.ts).
//   solana-agent.env    agent secret. buy opens only this; setup creates it.
//   public file         public addresses only. Read commands (readBudget, reconcile) and owner commands use it.
//   an owner key file   tests and automation only, named with --owner-key-file <path> (mode 600):
//                       SOLANA_OWNER_SECRET_BASE58. The default path ownerKeyFile("solana") is never read.
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { ownerKeyFile, agentKeyFile, publicFile, opsDir } from "../paths.mjs";
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

export const RPC_URL = "https://api.devnet.solana.com";
export const EXPLORER_CLUSTER = "?cluster=devnet";
export const USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
);
export const USDC_DECIMALS = 6;

export const OWNER_KEY_PATH = ownerKeyFile("solana");
export const AGENT_KEY_PATH = agentKeyFile("solana");
export const PUBLIC_PATH = publicFile("solana", "devnet");
export const OPS_DIR = opsDir("solana", "devnet");

export function connection() {
  return new Connection(RPC_URL, "confirmed");
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
  const out = {};
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key files. Each loader opens exactly one file.
// ---------------------------------------------------------------------------
function requireFile(path, what, hint) {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}${hint ? ` (${hint})` : ""}`);
}

function loadKeypair(path, secretName, addressName, what) {
  requireFile(path, what);
  const env = parseEnvFile(path);
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

// Merge-writes public values into the public state file (no secrets).
export function writePublic(pairs) {
  const env = existsSync(PUBLIC_PATH) ? parseEnvFile(PUBLIC_PATH) : {};
  Object.assign(env, pairs);
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
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Seller text (its 402, its answer, its headers, its errors) on one log line: control characters, newlines included, and
// the Unicode line separators become spaces. A seller must not be able to start a line of its own on stdout, where the
// dispatcher reads APPROVE and RESULT lines. The same rule as evm's oneLine.
export function oneLine(s, max = 300) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max);
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
