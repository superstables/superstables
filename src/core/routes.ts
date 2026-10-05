// Which way this client could pay a listing. Two ways exist and they cover different ground:
//
//   superstables pay      the chains its rails pay on (src/core/rails/): x402 exact on the EVM
//                         testnets below (and on Solana devnet when that rail is there), MPP
//                         tempo.charge on Tempo Moderato. The owner approves each payment in their
//                         own wallet.
//   superstables budget   the owner grants an on-chain budget once, then the agent buys alone.
//                         Rails and their testnets: evm (x402 on Base Sepolia, Arc Testnet,
//                         Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum
//                         Sepolia), tempo (MPP on Tempo Moderato), solana (x402 on Solana
//                         devnet).
//
// The budget table is written out here rather than read from budget/, which is its own program
// with its own dependencies; the chain keys below are the ones its --chain flag takes. Only
// explicit testnet names count. A listing that says "base", "ethereum" or "solana" is on a
// mainnet, and nothing here claims a mainnet listing can be paid.

import { networkFor, type NetworkInfo } from "./chain.js";
import { SUPPORTED_NETWORKS } from "./rails/index.js";
import type { BudgetRoute, PayRoutes } from "./types.js";

/** budget --rail evm: its --chain keys, each with the names a listing may use for it. */
const EVM_BUDGET_CHAINS: Record<string, string[]> = {
  "base-sepolia": ["base-sepolia", "eip155:84532"],
  "arc-testnet": ["arc-testnet", "eip155:5042002"],
  "arbitrum-sepolia": ["arbitrum-sepolia", "eip155:421614"],
  "polygon-amoy": ["polygon-amoy", "eip155:80002"],
  "skale-base-sepolia": ["skale-base-sepolia", "eip155:324705682"],
  // "sepolia" is x402 v1's name for it; plain "ethereum" is mainnet and never matches.
  "ethereum-sepolia": ["ethereum-sepolia", "sepolia", "eip155:11155111"],
};

/** budget --rail tempo pays MPP sellers on Tempo Moderato. */
const TEMPO_NAMES = new Set(["tempo-moderato", "moderato", "tempo:moderato", "eip155:42431"]);

/** budget --rail solana pays x402 sellers on Solana devnet. Plain "solana" is mainnet. */
const SOLANA_DEVNET_NAMES = new Set(["solana-devnet", "solana:etwtrabzayq6imfeykouru166vu2xqa1"]);

/** The names a listing may give a chain `pay` pays on: its budget key, its CAIP-2 id, its x402 v1 name, and Tempo's and Solana's other names. */
function payNames(network: NetworkInfo): string[] {
  if (network.rail === "tempo") return [...TEMPO_NAMES];
  if (network.rail === "solana") return [...SOLANA_DEVNET_NAMES];
  return EVM_BUDGET_CHAINS[network.key] ?? [network.key, network.caip2];
}

/** The chain `pay` pays on that a listing's chain name stands for, or undefined. */
export function payNetworkFor(name: string): NetworkInfo | undefined {
  const n = name.toLowerCase();
  return SUPPORTED_NETWORKS.find((network) => payNames(network).includes(n));
}

/** The chain name a listing uses for a chain `pay` knows, spelled the way the index spells it (its budget key). */
export function chainName(network: string): string {
  return networkFor(network)?.key ?? network;
}

/**
 * How a listing with these rails and chains could be paid. Rails missing means x402, which is
 * what every source this client reads meant before it said so.
 */
export function routesFor(rails: string[] | undefined, chains: string[]): PayRoutes {
  const protocols = new Set((rails && rails.length > 0 ? rails : ["x402"]).map((r) => r.toLowerCase()));
  const names = chains.map((c) => c.toLowerCase());
  const x402 = protocols.has("x402");
  const mpp = protocols.has("mpp");

  const budget: BudgetRoute[] = [];
  if (x402) {
    for (const [chain, aliases] of Object.entries(EVM_BUDGET_CHAINS)) {
      if (names.some((n) => aliases.includes(n))) budget.push({ rail: "evm", chain });
    }
    if (names.some((n) => SOLANA_DEVNET_NAMES.has(n))) budget.push({ rail: "solana", chain: "devnet" });
  }
  if (mpp && names.some((n) => TEMPO_NAMES.has(n))) budget.push({ rail: "tempo", chain: "moderato" });

  // pay: a chain one of its rails pays on, in the protocol that rail speaks (MPP on Tempo, x402 elsewhere).
  const pay = SUPPORTED_NETWORKS.some((network) => (network.rail === "tempo" ? mpp : x402) && names.some((n) => payNames(network).includes(n)));
  return { pay, budget };
}

/** Mainnet names a listing may use, so a refusal can say which mainnet it is on. */
const MAINNET_NAMES = new Set([
  "base", "ethereum", "solana", "polygon", "arbitrum", "optimism", "avalanche", "bsc", "sei", "iotex", "peaq",
  "xlayer", "abstract", "skale", "tempo", "stellar", "near", "sui", "aptos",
]);

const KNOWN_CHAIN_NAMES = new Set([
  ...Object.values(EVM_BUDGET_CHAINS).flat(),
  ...TEMPO_NAMES,
  ...SOLANA_DEVNET_NAMES,
  ...MAINNET_NAMES,
]);

/**
 * A listing's chain name, when the client knows it: one of the names above, or a CAIP-2 id of the usual shape. The
 * client repeats only these in its own sentences; anything else a listing calls a chain is not repeated.
 */
export function isKnownChainName(name: string): boolean {
  const n = name.toLowerCase();
  return KNOWN_CHAIN_NAMES.has(n) || /^eip155:\d{1,12}$/.test(n) || /^solana:[1-9a-z]{1,44}$/.test(n);
}

/** A listing's rail (protocol) name, when the client knows it. */
export function isKnownRail(name: string): boolean {
  return ["x402", "mpp"].includes(name.toLowerCase());
}

/** "evm base-sepolia, solana devnet", or "no" when no budget rail serves the listing. */
export function describeBudgetRoutes(routes: PayRoutes | undefined): string {
  if (!routes || routes.budget.length === 0) return "no";
  return routes.budget.map((r) => `${r.rail} ${r.chain}`).join(", ");
}
