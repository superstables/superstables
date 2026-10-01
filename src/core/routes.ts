// Which way this client could pay a listing. Two ways exist and they cover different ground:
//
//   superstables pay      x402, the exact scheme, USDC on Base Sepolia. The owner approves each
//                         payment in their own wallet.
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

import type { BudgetRoute, PayRoutes } from "./types.js";

/** The chain `superstables pay` pays on, and the names a listing may give it. */
const PAY_CHAIN_NAMES = new Set(["base-sepolia", "eip155:84532"]);

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

/** The chain name a listing uses for Base Sepolia, spelled the way the index spells it. */
export function chainName(network: string): string {
  return network === "eip155:84532" ? "base-sepolia" : network;
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

  return { pay: x402 && names.some((n) => PAY_CHAIN_NAMES.has(n)), budget };
}

/** "evm base-sepolia, solana devnet", or "no" when no budget rail serves the listing. */
export function describeBudgetRoutes(routes: PayRoutes | undefined): string {
  if (!routes || routes.budget.length === 0) return "no";
  return routes.budget.map((r) => `${r.rail} ${r.chain}`).join(", ");
}
