// Chain config for the evm rail (plain ERC-20 approve, pull then pay), built from the table in chains.mjs. The only
// chain-specific facts live in that table; nothing else in budget/evm/ names a chain.
// Pick the chain with `--chain <key>` or the B4_CHAIN environment variable; the default is base-sepolia.
//
// domain: the EIP-712 domain (name, version) of the token itself. The x402 client reads the domain from the seller's 402
//   (`extra.name`, `extra.version`); buy refuses any option whose domain differs from this table, and `preflight` checks this
//   table against the chain (DOMAIN_SEPARATOR()). It also signs `cancelAuthorization`, which has no 402.
// gas: the token that pays fees. `isUsdc` = the gas token IS the budget token (Arc). Then the agent's USDC balance can never
//   be 0, so "agent holds nothing between purchases" becomes "agent holds no more than `reserveMax` USDC".
import { defineChain, parseUnits, type Address, type Chain } from "viem";
import * as viemChains from "viem/chains";
import { EVM_CHAINS, EVM_DEFAULT_CHAIN } from "./chains.mjs";

export type ChainCfg = {
  key: string;
  label: string; // used in messages ("is not <label> USDC")
  rail: string; // "rail" field of journals: the chain key (journals written before 30 Sep 2026 say "base" or "arc"; nothing reads the field)
  chain: Chain;
  chainId: number;
  rpc: string;
  explorer: string;
  usdc: Address; // the budget token (USDC on every chain so far)
  symbol: string; // its symbol
  decimals: number; // decimals of the ERC-20 interface
  network: string; // x402 network id, eip155:<chainId>
  legacyNetworks: string[]; // x402 v1 names to accept as the same chain
  domain: { name: string; version: string };
  gas: { symbol: string; decimals: number; isUsdc: boolean; minAgent: bigint; topUp: bigint; reserveMax?: bigint };
  logRange?: number; // the RPC's eth_getLogs block-range cap, when it has one
};

function build(key: string, rpcOverride?: string): ChainCfg {
  const t = { ...(EVM_CHAINS as Record<string, any>)[key], ...(rpcOverride ? { rpc: rpcOverride } : {}) };
  const preset = (viemChains as Record<string, Chain>)[t.viem];
  if (!preset || preset.id !== t.chainId) throw new Error(`chains.mjs: viem preset ${t.viem} is not chain ${t.chainId}`);
  const g = t.gas;
  // the RPC in the table wins over the preset's; where the gas token is the budget token its native unit has 18 decimals
  const chain = defineChain({
    ...preset,
    rpcUrls: { default: { http: [t.rpc] } },
    ...(g.isToken ? { nativeCurrency: { name: g.symbol, symbol: g.symbol, decimals: g.decimals } } : {}),
  });
  return {
    key, label: t.label, rail: key, chain, chainId: t.chainId, rpc: t.rpc, explorer: t.explorer,
    usdc: t.token.address, symbol: t.token.symbol, decimals: t.token.decimals, network: `eip155:${t.chainId}`,
    legacyNetworks: t.legacy, domain: t.token.domain, ...(t.logRange ? { logRange: t.logRange } : {}),
    gas: {
      symbol: g.symbol, decimals: g.decimals, isUsdc: g.isToken,
      minAgent: parseUnits(g.minAgent, g.decimals), topUp: parseUnits(g.topUp, g.decimals),
      ...(g.reserveMax ? { reserveMax: parseUnits(g.reserveMax, t.token.decimals) } : {}),
    },
  };
}

export const CHAINS: Record<string, ChainCfg> = Object.fromEntries(Object.keys(EVM_CHAINS).map((k) => [k, build(k)]));

/** `--chain <key>` or B4_CHAIN, default base-sepolia. Unknown name: exit 2 (before any secret is read). */
export function selectedChainKey(): string {
  const i = process.argv.indexOf("--chain");
  const v = i >= 0 ? process.argv[i + 1] : process.env.B4_CHAIN;
  const key = v && !v.startsWith("--") ? v : EVM_DEFAULT_CHAIN;
  if (!CHAINS[key]) {
    console.error(`error: unknown chain "${key}" (known: ${Object.keys(CHAINS).join(", ")})`);
    process.exit(2);
  }
  return key;
}
/**
 * B4_RPC replaces the selected chain's RPC URL (tests point it at a local fake; you can point it at your own node). Every
 * script that signs still checks the chain id it answers with first (lib.ts assertRpcChain).
 */
function rpcOverride(): string | undefined {
  const v = process.env.B4_RPC?.trim();
  if (!v) return undefined;
  let ok = false;
  try { ok = /^https?:$/.test(new URL(v).protocol); } catch {}
  if (!ok) {
    console.error(`error: B4_RPC must be an http(s) URL (got "${v}")`);
    process.exit(2);
  }
  return v;
}
const KEY = selectedChainKey();
const OVERRIDE = rpcOverride();
export const CFG: ChainCfg = OVERRIDE ? build(KEY, OVERRIDE) : CHAINS[KEY];
