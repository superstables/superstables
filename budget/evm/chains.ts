// Chain table for the evm rail (plain ERC-20 approve, pull then pay). The only chain-specific facts live here.
// Pick the chain with `--chain <key>` or the B4_CHAIN environment variable; the default is base-sepolia.
// Nothing else in budget/evm/ names a chain. A new EVM chain is a new entry (chainId, RPC, USDC, EIP-712 domain, gas token).
//
// domain: the EIP-712 domain (name, version) of the token itself. The x402 client reads the domain from the seller's 402
//   (`extra.name`, `extra.version`); buy refuses any option whose domain differs from this table, and `preflight` checks this
//   table against the chain (name(), version(), DOMAIN_SEPARATOR()). It also signs `cancelAuthorization`, which has no 402.
// gas: the token that pays fees. `isUsdc` = the gas token IS the budget token (Arc). Then the agent's USDC balance can never
//   be 0, so "agent holds nothing between purchases" becomes "agent holds no more than `reserveMax` USDC".
import { defineChain, type Address, type Chain } from "viem";
import { baseSepolia, arcTestnet } from "viem/chains";

export type ChainCfg = {
  key: string;
  label: string; // used in messages ("is not <label> USDC")
  rail: string; // "rail" field of journals and RESULT lines
  chain: Chain;
  chainId: number;
  rpc: string;
  explorer: string;
  usdc: Address;
  decimals: number; // decimals of the ERC-20 interface
  network: string; // x402 network id, eip155:<chainId>
  legacyNetworks: string[]; // x402 v1 names to accept as the same chain
  domain: { name: string; version: string };
  gas: { symbol: string; decimals: number; isUsdc: boolean; minAgent: bigint; topUp: bigint; reserveMax?: bigint };
};

const cfg = (c: Omit<ChainCfg, "chainId" | "network"> & { chainId: number }): ChainCfg => ({ ...c, network: `eip155:${c.chainId}` });

export const CHAINS: Record<string, ChainCfg> = {
  "base-sepolia": cfg({
    key: "base-sepolia", label: "Base Sepolia", rail: "base", chain: baseSepolia, chainId: 84532,
    rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, legacyNetworks: ["base-sepolia"],
    domain: { name: "USDC", version: "2" },
    gas: { symbol: "ETH", decimals: 18, isUsdc: false, minAgent: 2_000_000_000_000n, topUp: 30_000_000_000_000n },
  }),
  // Circle's Arc Testnet. USDC is the native gas token: the native balance has 18 decimals, the ERC-20 at 0x3600...
  // shows the same balance in 6-decimal units (native / 1e12, rounded down, = erc20; checked by preflight. Fees have 18 decimals, so the native balance carries sub-micro dust the ERC-20 cannot show).
  "arc-testnet": cfg({
    key: "arc-testnet", label: "Arc Testnet", rail: "arc", chain: defineChain({ ...arcTestnet, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } }), chainId: 5042002,
    rpc: "https://rpc.testnet.arc.network", explorer: "https://explorer.testnet.arc.io",
    usdc: "0x3600000000000000000000000000000000000000", decimals: 6, legacyNetworks: [],
    domain: { name: "USDC", version: "2" },
    gas: { symbol: "USDC", decimals: 18, isUsdc: true, minAgent: 10_000_000_000_000_000n /* 0.01 USDC */, topUp: 100_000_000_000_000_000n /* 0.1 USDC */, reserveMax: 2_000_000n /* 2 USDC, ERC-20 units */ },
  }),
};

/** `--chain <key>` or B4_CHAIN, default base-sepolia. Unknown name: exit 2 (before any secret is read). */
export function selectedChainKey(): string {
  const i = process.argv.indexOf("--chain");
  const v = i >= 0 ? process.argv[i + 1] : process.env.B4_CHAIN;
  const key = v && !v.startsWith("--") ? v : "base-sepolia";
  if (!CHAINS[key]) {
    console.error(`error: unknown chain "${key}" (known: ${Object.keys(CHAINS).join(", ")})`);
    process.exit(2);
  }
  return key;
}
export const CFG: ChainCfg = CHAINS[selectedChainKey()];
