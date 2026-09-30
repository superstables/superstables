// CLI guard for every runnable script in budget/evm/ (contract rule 6).
// Every script also takes --chain <name> (value flag, added below): a key of chains.mjs, base-sepolia by default. Testnet only.
//
// Each script imports this file FIRST (`import "./cli-guard.mjs"`). ES modules evaluate imports in order, so the
// checks below run before any other module of the script is loaded: before a secret file is read, before an RPC
// call, before anything is signed.
//
//   --help / -h          print usage, exit 0
//   --mainnet, or --chain / B4_CHAIN naming a mainnet (name or chain id)
//                        exit 3 with RESULT state refused_precheck: refused before anything is signed
//   unknown flag         exit 2
//   missing value        exit 2
//   missing required     exit 2
//   unexpected argument  exit 2
//   unknown chain name   exit 2 (chains.ts, also before any secret is read)
//
// The table is the single list of runnable scripts. A script that is not in it exits 2 (fail closed).
// Only Node built-ins and the plain chain table (chains.mjs, no imports) are used here.
import { relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { EVM_CHAIN_KEYS } from "./chains.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// v = flags that take a value, b = boolean flags, r = required flags (value or boolean), pos = positional arguments
// (name list; all required), keys = which secret files the script may open (documentation, printed in --help).
const SPEC = {
  "setup.ts": { d: "Write the public state file of this chain (owner and agent addresses, no secret) from the B4 key files, after checking that each key derives its recorded address. Never prints a key.", u: "--from-keys", v: [], b: ["from-keys"], r: ["from-keys"], keys: "owner + agent (derives addresses; writes only the public file)" },
  "preflight.ts": { d: "Read only: RPC chain id, USDC name/version/decimals/domain separator against chains.ts, native vs ERC-20 balances, and (with --url) the seller's decoded 402 with a verdict per option. No secret file.", u: "[--url <seller url>] [--max <usdc>] [--pay-to <address>]", v: ["url", "max", "pay-to"], b: [], r: [], keys: "none" },
  "fundAgent.ts": { d: "Owner: send the agent some native gas token (Arc: USDC). One plain transaction, capped at 5 units.", u: "--amount <gas token, decimal>", v: ["amount"], b: [], r: ["amount"], keys: "owner" },
  "setBudget.ts": { d: "Owner: USDC.approve(agent, cap), then read the allowance back and refuse (exit 3) if it is not exactly the cap. No on-chain expiry or period; --expiry-in is advisory. A live allowance is never overwritten silently. --verify-only sends nothing.", u: "--cap <usdc> [--expiry-in <seconds>] [--replace] [--verify-only]", v: ["cap", "expiry-in"], b: ["replace", "verify-only"], r: ["cap"], keys: "owner (none with --verify-only)" },
  "buy.ts": { d: "Agent: pay an x402 seller under the approve (transferFrom to the agent, then a normal EIP-3009 payment). Refuses before any signature or pull when the price exceeds --max, the token is not this chain's USDC (6 decimals), the seller's EIP-712 domain is not the token's (or the option is a Gateway batched one), the recipient differs from --pay-to, the amount has too much precision, the budget expired, the allowance or the owner balance is too low, or the agent holds more than its gas reserve. A pull that is not followed by a settlement is returned to the owner, never re-paid. Exit: 0 settled and delivered (or quoted), 1 failed or refused by the chain, 3 refused before signing, 4 paid not delivered, 5 unknown.", u: "--url <seller url> --max <usdc> [--pay-to <address>] [--op <id>] [--quote-only] [--http-timeout <seconds>]", v: ["url", "max", "pay-to", "op", "http-timeout"], b: ["quote-only"], r: ["url", "max"], keys: "agent" },
  "reconcile.ts": { d: "READ ONLY. Read an operation from its journal and the chain, then set settled, failed, unknown or not_found. Never signs, sends or pays; opens no key file. Returning stranded funds is recover.ts --op. Exit: 0 settled and delivered, 1 failed or not_found, 4 settled but delivery unconfirmed, 5 unknown.", u: "--op <id>", v: ["op"], b: [], r: ["op"], keys: "none" },
  "revoke.ts": { d: "Owner: USDC.approve(agent, 0). The kill switch even under a stolen agent key. --plan prints what it would do and sends nothing.", u: "[--plan]", v: [], b: ["plan"], r: [], keys: "owner (none with --plan)" },
  "recover.ts": { d: "Owner, without the agent (escrowed agent key; tops up its gas if needed). In this order: 1 stop authority (self-revoke the allowance, then the owner's approve 0 for any rest), 2 cancel open authorizations and return the price of every journaled pull that landed without a settlement (--op limits this to one operation), 3 sweep other USDC stranded in the agent key (above its gas reserve where USDC is the gas token; not with --op). --plan prints the plan and sends nothing.", u: "[--op <id>] [--plan]", v: ["op"], b: ["plan"], r: [], keys: "owner (escrowed agent key; none with --plan)" },
  "read.ts": { d: "Read allowance, balances, cap and public expiry. No secret file.", u: "", v: [], b: [], r: [], keys: "none" },
};

// every script may take --chain <name> (chains.ts picks the chain; an unknown name exits 2 there)
for (const s of Object.values(SPEC)) { s.v = [...s.v, "chain"]; s.u = `${s.u} [--chain ${EVM_CHAIN_KEYS.join("|")}]`.trim(); }

export const SPEC_TABLE = SPEC;

function usageText(rel, s) {
  return `${rel}\n  ${s.d}\n  usage: npx tsx budget/evm/${rel} ${s.u}\n  secret files opened: ${s.keys}\n`;
}

function fail(msg, rel, s) {
  process.stderr.write(`error: ${msg}\n${s ? usageText(rel, s) : ""}`);
  process.exit(2);
}

const script = process.argv[1] ?? "";
const rel = relative(HERE, script).split("\\").join("/");
const s = SPEC[rel];
const argv = process.argv.slice(2);

if (!s) fail(`no CLI spec for "${rel}" in cli-guard.mjs`, rel, null);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(usageText(rel, s));
  process.exit(0);
}

// Testnet only. A mainnet named by --mainnet, --chain or B4_CHAIN (by name or chain id) is refused here, before anything else runs.
const MAINNET_IDS = new Set(["1", "10", "56", "130", "137", "143", "146", "480", "999", "1329", "4663", "5042", "8453", "42161", "42220", "43114", "1187947933"]);
const MAINNET_NAMES = new Set(["base", "arc", "ethereum", "eth", "optimism", "op", "polygon", "arbitrum", "avalanche", "bsc", "monad", "sei", "celo", "robinhood", "skale-base"]);
const looksMainnet = (v) => {
  const x = String(v).toLowerCase();
  return MAINNET_IDS.has(x.replace(/^eip155:/, "")) || MAINNET_NAMES.has(x) || x.includes("mainnet");
};
const ci = argv.indexOf("--chain");
const chainValue = ci >= 0 ? argv[ci + 1] : process.env.B4_CHAIN;
if (argv.includes("--mainnet") || (chainValue && !String(chainValue).startsWith("--") && looksMainnet(chainValue))) {
  const shown = argv.includes("--mainnet") ? "--mainnet" : String(chainValue);
  process.stderr.write(`REFUSED: "${shown}" is a mainnet. superstables budget is testnet only (--chain ${EVM_CHAIN_KEYS.join(", ")}). Nothing was signed or sent.\n`);
  process.stdout.write(`RESULT ${JSON.stringify({ ok: false, command: basename(rel, ".ts"), rail: "evm", chain: shown, state: "refused_precheck", reason: "mainnet is refused: testnet only", next: `use --chain ${EVM_CHAIN_KEYS.join(" or --chain ")}` })}\n`);
  process.exit(3);
}

const seen = new Set();
let positionals = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("-")) {
    positionals++;
    if (positionals > (s.posMax ?? s.pos ?? 0)) fail(`unexpected argument "${a}"`, rel, s);
    continue;
  }
  if (!a.startsWith("--")) fail(`unknown flag "${a}"`, rel, s);
  const name = a.slice(2);
  if (s.v.includes(name)) {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${name} needs a value`, rel, s);
    seen.add(name);
    i++;
  } else if (s.b.includes(name)) {
    seen.add(name);
  } else {
    fail(`unknown flag "${a}"`, rel, s);
  }
}
for (const r of s.r) if (!seen.has(r)) fail(`missing required --${r}`, rel, s);
for (const group of s.any ?? []) if (!group.some((n) => seen.has(n))) fail(`one of ${group.map((n) => "--" + n).join(", ")} is required`, rel, s);
if (positionals < (s.pos ?? 0)) fail(`missing argument (usage below)`, rel, s);
