// superstables budget doctor: key files, the public file, the RPC and balances for one rail. Reads files and the chain,
// sends nothing, signs nothing, and never prints a secret (variable names and public addresses only).
// No rail has an owner key file: the owner approves in their own wallet, so doctor checks the agent file, the public file
// (the owner's address), the RPC and balances. An owner key file on this machine is only noted: nothing reads it unless a
// test passes --owner-key-file.
// Minimum balances are what one grant, a few purchases and a revoke need on each chain.
import { existsSync, readFileSync, statSync } from "node:fs";
import { agentKeyFile, ownerKeyFile, publicFile } from "./paths.mjs";
import { EVM_CHAINS, EVM_DEFAULT_CHAIN } from "./evm/chains.mjs";

// EVM chains come from evm/chains.mjs. Tempo and Solana must match tempo/lib/constants.mjs and solana/lib.mjs (RPC, token). Minimums in whole tokens.

const SOLANA = { rpc: "https://api.devnet.solana.com", usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", minOwnerSol: 0.01, minOwnerUsdc: 0.05, minAgentSol: 0.005 };
const TEMPO = { rpc: "https://rpc.moderato.tempo.xyz", chainId: 42431, pathUsd: "0x20C0000000000000000000000000000000000000", minOwner: 1 };

async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
}
const erc20Balance = async (url, token, addr, decimals = 6) => Number(BigInt(await rpc(url, "eth_call", [{ to: token, data: "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0") }, "latest"]))) / 10 ** decimals;
const nativeBalance = async (url, addr) => Number(BigInt(await rpc(url, "eth_getBalance", [addr, "latest"]))) / 1e18;
const evmKeyAddress = async (v) => (/^0x[0-9a-fA-F]{64}$/.test(v) ? (await import("viem/accounts")).privateKeyToAddress(v) : null);
// A Solana secret key is 64 bytes: the seed, then the public key.
const solanaKeyAddress = async (v) => {
  const bs58 = (await import("bs58")).default;
  const bytes = bs58.decode(v);
  return bytes.length === 64 ? bs58.encode(bytes.slice(32)) : null;
};
const solBalance = async (addr) => (await rpc(SOLANA.rpc, "getBalance", [addr, { commitment: "confirmed" }])).value / 1e9;
const splBalance = async (addr) => {
  const r = await rpc(SOLANA.rpc, "getTokenAccountsByOwner", [addr, { mint: SOLANA.usdcMint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return r.value.reduce((sum, a) => sum + Number(a.account.data.parsed.info.tokenAmount.uiAmountString), 0);
};

// One entry per rail: which variables each file must hold, which names are owner secrets, how to derive an address
// from a key-shaped value, how to check the RPC, and the balances to check.
const RAILS = {
  evm: ({ chain }) => {
    const c = EVM_CHAINS[chain], d = c.doctor, tok = c.token;
    const flag = chain === EVM_DEFAULT_CHAIN ? "" : ` --chain ${chain}`;
    return {
      ownerVars: null, agentVars: ["B4_AGENT_KEY"], ownerSecrets: ["B4_OWNER_KEY"], agentKeyVar: "B4_AGENT_KEY",
      pub: publicFile("evm", chain), ownerAddr: "B4_OWNER_ADDRESS", agentAddr: "B4_AGENT_ADDRESS",
      setup: `superstables budget setup --rail evm${flag}`,
      keyAddress: evmKeyAddress, caseSensitive: false,
      rpc: async () => { const id = Number(await rpc(c.rpc, "eth_chainId")); if (id !== c.chainId) throw new Error(`chain id ${id}, expected ${c.chainId}`); return `chain id ${id}`; },
      balances: async (owner, agent) => [
        { who: "owner", addr: owner, token: tok.symbol, have: await erc20Balance(c.rpc, tok.address, owner, tok.decimals), need: Number(d.minOwnerToken), hint: d.tokenFaucet },
        ...(c.gas.isToken ? [] : [{ who: "owner", addr: owner, token: c.gas.symbol, have: await nativeBalance(c.rpc, owner), need: Number(d.minOwnerGas), hint: d.gasFaucet }]),
        { who: "agent", addr: agent, token: `${c.gas.symbol} (gas)`, have: await nativeBalance(c.rpc, agent), need: Number(d.minAgentGas), hint: `superstables budget fund-agent --rail evm${flag} (you approve it in your wallet), or send ${d.fundAgent} ${c.gas.symbol} to ${agent}` },
      ],
    };
  },
  tempo: ({ agent = "" }) => ({
    ownerVars: null, agentVars: [`AGENT${agent}_PRIVATE_KEY`, "OWNER_ADDRESS"], ownerSecrets: ["OWNER_PRIVATE_KEY"], agentKeyVar: `AGENT${agent}_PRIVATE_KEY`,
    pub: publicFile("tempo", "moderato"), ownerAddr: "OWNER_ADDRESS", agentAddr: `AGENT${agent}_ADDRESS`,
    setup: agent ? `superstables budget setup --rail tempo --agent ${agent}` : "superstables budget setup --rail tempo",
    keyAddress: evmKeyAddress, caseSensitive: false,
    rpc: async () => { const id = Number(await rpc(TEMPO.rpc, "eth_chainId")); if (id !== TEMPO.chainId) throw new Error(`chain id ${id}, expected ${TEMPO.chainId}`); return `chain id ${id}`; },
    // The agent's access key spends the owner's pathUSD and fees come from the owner, so only the owner needs funds.
    balances: async (owner) => [
      { who: "owner", addr: owner, token: "pathUSD", have: await erc20Balance(TEMPO.rpc, TEMPO.pathUsd, owner), need: TEMPO.minOwner, hint: "npx tsx budget/tempo/setup.ts --fund-only uses the Moderato faucet" },
    ],
  }),
  solana: () => ({
    ownerVars: null, agentVars: ["SOLANA_AGENT_SECRET_BASE58", "SOLANA_OWNER_ADDRESS"], ownerSecrets: ["SOLANA_OWNER_SECRET_BASE58"], agentKeyVar: "SOLANA_AGENT_SECRET_BASE58",
    pub: publicFile("solana", "devnet"), ownerAddr: "SOLANA_OWNER_ADDRESS", agentAddr: "SOLANA_AGENT_ADDRESS",
    setup: "superstables budget setup --rail solana",
    keyAddress: solanaKeyAddress, caseSensitive: true,
    rpc: async () => `solana ${(await rpc(SOLANA.rpc, "getVersion"))["solana-core"]}`,
    balances: async (owner, agent) => [
      { who: "owner", addr: owner, token: "SOL", have: await solBalance(owner), need: SOLANA.minOwnerSol, hint: "solana airdrop 1 <address> --url devnet, or faucet.solana.com" },
      { who: "owner", addr: owner, token: "USDC", have: await splBalance(owner), need: SOLANA.minOwnerUsdc, hint: "faucet.circle.com, Solana devnet" },
      { who: "agent", addr: agent, token: "SOL (fees)", have: await solBalance(agent), need: SOLANA.minAgentSol, hint: `superstables budget fund-agent --rail solana (you approve it in your wallet), or send 0.01 SOL to ${agent}` },
    ],
  }),
};

function readEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const keyShaped = (v) => /^0x[0-9a-fA-F]{64}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(v);
const mode = (path) => (statSync(path).mode & 0o777).toString(8);

/** Runs every check for f.rail (and f.chain, f.agent), prints one line per check to stderr, returns the number that failed. */
export async function runDoctor(f) {
  const r = RAILS[f.rail](f);
  let failed = 0;
  const topUps = [];
  const line = (ok, what, detail) => { if (!ok) failed++; process.stderr.write(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}\n`); };
  process.stderr.write(`\nsuperstables budget doctor: ${f.rail} (${f.chain})\n`);

  const owner = readEnv(ownerKeyFile(f.rail)), agent = readEnv(agentKeyFile(f.rail)), pub = readEnv(r.pub);
  const files = [["agent key file", agentKeyFile(f.rail), agent, r.agentVars]];
  if (r.ownerVars) files.unshift(["owner key file", ownerKeyFile(f.rail), owner, r.ownerVars]);
  else if (existsSync(ownerKeyFile(f.rail))) process.stderr.write(`  note  an owner key file is on this machine (${ownerKeyFile(f.rail)}). The ${f.rail} rail never reads it unless you pass --owner-key-file: the owner approves in their own wallet. Keep owner keys off the agent's machine.\n`);
  for (const [label, path, env, vars] of files) {
    if (!existsSync(path)) { line(false, label, `${path} does not exist${r.ownerVars ? "" : ` (run ${r.setup})`}`); continue; }
    const missing = vars.filter((v) => !env[v]);
    const m = mode(path);
    line(m === "600" && !missing.length, `${label} ${path}`, [m !== "600" && `mode is ${m}, must be 600 (chmod 600 ${path})`, missing.length && `missing ${missing.join(", ")}`].filter(Boolean).join("; "));
  }

  const ownerAddress = pub[r.ownerAddr] ?? owner[r.ownerAddr] ?? agent[r.ownerAddr];
  const agentAddress = pub[r.agentAddr] ?? agent[r.agentAddr] ?? owner[r.agentAddr];
  if (existsSync(agentKeyFile(f.rail))) {
    const problems = r.ownerSecrets.filter((n) => agent[n]).map((n) => `defines ${n}`);
    const ownerValues = new Set(r.ownerSecrets.map((n) => owner[n]).filter(Boolean));
    for (const [name, value] of Object.entries(agent)) {
      if (ownerValues.has(value)) problems.push(`${name} holds the owner's secret`);
      else if (ownerAddress && keyShaped(value)) {
        const a = await r.keyAddress(value).catch(() => null);
        if (a && (r.caseSensitive ? a === ownerAddress : a.toLowerCase() === ownerAddress.toLowerCase())) problems.push(`${name} is a key for the owner address`);
      }
    }
    line(!problems.length, "agent key file holds no owner key", problems.join("; "));
    if (r.agentKeyVar && agent[r.agentKeyVar] && agentAddress) {
      const a = await r.keyAddress(agent[r.agentKeyVar]).catch(() => null);
      const match = !!a && (r.caseSensitive ? a === agentAddress : a.toLowerCase() === agentAddress.toLowerCase());
      line(match, "agent key matches the agent address in the public file", a ? (match ? agentAddress : `the key is for ${a}, the public file says ${agentAddress}`) : "the key is not a valid key");
    }
  }

  if (!existsSync(r.pub)) line(false, `public file ${r.pub}`, `does not exist (run ${r.setup})`);
  else {
    const secrets = Object.entries(pub).filter(([, v]) => keyShaped(v)).map(([k]) => k);
    const missing = [r.ownerAddr, r.agentAddr].filter((v) => !pub[v]);
    line(!secrets.length && !missing.length, `public file ${r.pub}`, [secrets.length && `holds key material in ${secrets.join(", ")}`, missing.length && `missing ${missing.join(", ")} (run ${r.setup})`].filter(Boolean).join("; "));
  }

  let rpcOk = false;
  try { line(true, "RPC answers", await r.rpc()); rpcOk = true; } catch (e) { line(false, "RPC answers", e.message); }
  if (rpcOk && ownerAddress && agentAddress) {
    try {
      for (const b of await r.balances(ownerAddress, agentAddress)) {
        const ok = b.have >= b.need;
        line(ok, `${b.who} ${b.token} balance`, `${b.have} at ${b.addr} (need at least ${b.need})`);
        if (!ok) topUps.push(`top up ${b.token} at ${b.addr}: have ${b.have}, need at least ${b.need} (${b.hint})`);
      }
    } catch (e) { line(false, "balances", e.message); }
  } else if (rpcOk) line(false, "balances", "no owner or agent address to read");
  for (const t of topUps) process.stderr.write(`  ${t}\n`);
  return failed;
}
