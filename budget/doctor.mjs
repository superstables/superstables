// superstables budget doctor: key files, the public file, the RPC and balances for one rail. Reads files and the chain,
// sends nothing, signs nothing, and never prints a secret (variable names and public addresses only).
// Minimum balances are what one grant, a few purchases and a revoke need on each chain.
import { existsSync, readFileSync, statSync } from "node:fs";
import { agentKeyFile, ownerKeyFile, publicFile } from "./paths.mjs";

// Must match evm/chains.ts and tempo/lib/constants.mjs (RPC, token). Minimums in whole tokens.
const EVM = {
  "base-sepolia": { rpc: "https://sepolia.base.org", chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", gas: "ETH", minOwnerUsdc: 0.01, minOwnerGas: 0.00003, minAgentGas: 0.00003, fundAgent: "0.0001" },
  "arc-testnet": { rpc: "https://rpc.testnet.arc.network", chainId: 5042002, usdc: "0x3600000000000000000000000000000000000000", gas: "USDC", minOwnerUsdc: 0.2, minOwnerGas: 0.2, minAgentGas: 0.01, fundAgent: "0.1" },
};

const TEMPO = { rpc: "https://rpc.moderato.tempo.xyz", chainId: 42431, pathUsd: "0x20C0000000000000000000000000000000000000", minOwner: 1 };

async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
}
const erc20Balance = async (url, token, addr) => Number(BigInt(await rpc(url, "eth_call", [{ to: token, data: "0x70a08231" + addr.slice(2).toLowerCase().padStart(64, "0") }, "latest"]))) / 1e6;
const nativeBalance = async (url, addr) => Number(BigInt(await rpc(url, "eth_getBalance", [addr, "latest"]))) / 1e18;
const evmKeyAddress = async (v) => (/^0x[0-9a-fA-F]{64}$/.test(v) ? (await import("viem/accounts")).privateKeyToAddress(v) : null);

// One entry per rail: which variables each file must hold, which names are owner secrets, how to derive an address
// from a key-shaped value, how to check the RPC, and the balances to check.
const RAILS = {
  evm: ({ chain }) => {
    const c = EVM[chain];
    const flag = chain === "base-sepolia" ? "" : ` --chain ${chain}`;
    return {
      ownerVars: ["B4_OWNER_KEY", "B4_AGENT_KEY_ESCROW"], agentVars: ["B4_AGENT_KEY"], ownerSecrets: ["B4_OWNER_KEY"],
      pub: publicFile("evm", chain), ownerAddr: "B4_OWNER_ADDRESS", agentAddr: "B4_AGENT_ADDRESS",
      setup: `npx tsx budget/evm/setup.ts --from-keys${flag}`,
      keyAddress: evmKeyAddress,
      rpc: async () => { const id = Number(await rpc(c.rpc, "eth_chainId")); if (id !== c.chainId) throw new Error(`chain id ${id}, expected ${c.chainId}`); return `chain id ${id}`; },
      balances: async (owner, agent) => [
        { who: "owner", addr: owner, token: "USDC", have: await erc20Balance(c.rpc, c.usdc, owner), need: c.minOwnerUsdc, hint: "faucet.circle.com" },
        ...(c.gas === "USDC" ? [] : [{ who: "owner", addr: owner, token: c.gas, have: await nativeBalance(c.rpc, owner), need: c.minOwnerGas, hint: "a Base Sepolia ETH faucet" }]),
        { who: "agent", addr: agent, token: `${c.gas} (gas)`, have: await nativeBalance(c.rpc, agent), need: c.minAgentGas, hint: `npx tsx budget/evm/fundAgent.ts${flag} --amount ${c.fundAgent}` },
      ],
    };
  },
  tempo: ({ agent = "" }) => ({
    ownerVars: ["OWNER_PRIVATE_KEY", "OWNER_ADDRESS"], agentVars: [`AGENT${agent}_PRIVATE_KEY`, "OWNER_ADDRESS"], ownerSecrets: ["OWNER_PRIVATE_KEY"],
    pub: publicFile("tempo", "moderato"), ownerAddr: "OWNER_ADDRESS", agentAddr: `AGENT${agent}_ADDRESS`,
    setup: agent ? `npx tsx budget/tempo/setup.ts --extra-agent ${agent}` : "npx tsx budget/tempo/setup.ts",
    keyAddress: evmKeyAddress,
    rpc: async () => { const id = Number(await rpc(TEMPO.rpc, "eth_chainId")); if (id !== TEMPO.chainId) throw new Error(`chain id ${id}, expected ${TEMPO.chainId}`); return `chain id ${id}`; },
    // The agent's access key spends the owner's pathUSD and fees come from the owner, so only the owner needs funds.
    balances: async (owner) => [
      { who: "owner", addr: owner, token: "pathUSD", have: await erc20Balance(TEMPO.rpc, TEMPO.pathUsd, owner), need: TEMPO.minOwner, hint: "npx tsx budget/tempo/setup.ts --fund-only" },
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
  for (const [label, path, env, vars] of [["owner key file", ownerKeyFile(f.rail), owner, r.ownerVars], ["agent key file", agentKeyFile(f.rail), agent, r.agentVars]]) {
    if (!existsSync(path)) { line(false, label, `${path} does not exist`); continue; }
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
        if (a && a.toLowerCase() === ownerAddress.toLowerCase()) problems.push(`${name} is a key for the owner address`);
      }
    }
    line(!problems.length, "agent key file holds no owner key", problems.join("; "));
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
