// The one place that knows chains: every testnet `pay` can pay on, with the token it pays in there and what a browser
// wallet needs to add the chain. Each chain belongs to one rail (src/core/rails/): x402 exact on the EVM chains, MPP
// tempo.charge on Tempo Moderato, x402 exact on Solana devnet. A chain this table does not name is refused before
// anything is signed, and so is every mainnet: this client pays on testnets only.
//
// The six EVM chains are the budget's (budget/evm/chains.mjs, its own program with its own build); a test checks that
// this table agrees with that one field by field.

import { createPublicClient, http } from "viem";
import type { PaymentRequirements } from "@x402/core/types";

export type Rail = "evm" | "tempo" | "solana";

/** What wallet_addEthereumChain is offered for an EVM chain (Tempo included), or what a Solana wallet is asked for. */
export interface WalletChain {
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Solana: the Wallet Standard chain, e.g. "solana:devnet". */
  walletChain?: string;
}

interface NetworkCommon {
  rail: Rail;
  /** The budget's name for the chain (its --chain key), and the name a listing may use for it. */
  key: string;
  /** CAIP-2. */
  caip2: string;
  /** The x402 v1 vernacular name some sellers still speak, or "" when the chain has none. */
  v1Name: string;
  /** The EIP-155 chain id; 0 on Solana. */
  chainId: number;
  label: string;
  testnet: boolean;
  explorer: string;
  /** Added after a transaction or address in an explorer link, e.g. "?cluster=devnet". */
  explorerQuery?: string;
  /** The RPC a browser wallet is offered and balances are read through. */
  rpc: string;
  /** The public RPC a settlement is read through when `rpcEnv` names no other (see chainRpc in src/core/rpc.ts). */
  defaultRpc: string;
  /** The environment variable that replaces this chain's RPC for chain reads, when it has one. */
  rpcEnv?: string;
  /** The token `pay` pays in on this chain. */
  token: { symbol: string; address: string; decimals: number };
  wallet: WalletChain;
}

/** An x402 exact chain on EVM: the owner signs an EIP-3009 authorization over the token's own EIP-712 domain. */
export interface EvmNetwork extends NetworkCommon {
  rail: "evm";
  usdc: { address: `0x${string}`; decimals: number; eip712: { name: string; version: string } };
  /** About how many seconds pass between blocks: where a search for a block by its time starts. Never relied on. */
  blockSeconds: number;
  /** The most blocks one eth_getLogs asks the public RPC for (the budget's logRange where it names one). */
  logRange: number;
  /**
   * How the chain says a block can no longer change: "finalized", the RPC's `finalized` block tag; "instant", every
   * block is final once it is in the chain (BFT finality: SKALE, whose RPC refuses the `finalized` tag), so the latest
   * block is final. A payment is called never made only on a final block.
   */
  finality: "finalized" | "instant";
}

/** Tempo Moderato: MPP tempo.charge, paid by a pathUSD transfer the owner's wallet sends. */
export interface TempoNetwork extends NetworkCommon {
  rail: "tempo";
}

/** Solana devnet: x402 exact on SVM, a token transfer the owner's Solana wallet signs and the seller's fee payer pays for. */
export interface SolanaNetwork extends NetworkCommon {
  rail: "solana";
  /** The cluster's genesis hash: what the CAIP-2 id is the start of. */
  genesisHash: string;
}

export type NetworkInfo = EvmNetwork | TempoNetwork | SolanaNetwork;

const ETHER = { name: "Ether", symbol: "ETH", decimals: 18 };

function evm(input: {
  key: string;
  chainId: number;
  label: string;
  v1Name?: string;
  rpc: string;
  defaultRpc?: string;
  rpcEnv?: string;
  explorer: string;
  usdc: `0x${string}`;
  eip712: { name: string; version: string };
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockSeconds: number;
  logRange?: number;
  finality?: "finalized" | "instant";
}): EvmNetwork {
  return {
    rail: "evm",
    key: input.key,
    caip2: `eip155:${input.chainId}`,
    v1Name: input.v1Name ?? "",
    chainId: input.chainId,
    label: input.label,
    testnet: true,
    explorer: input.explorer,
    rpc: input.rpc,
    defaultRpc: input.defaultRpc ?? input.rpc,
    ...(input.rpcEnv ? { rpcEnv: input.rpcEnv } : {}),
    token: { symbol: "USDC", address: input.usdc, decimals: 6 },
    usdc: { address: input.usdc, decimals: 6, eip712: input.eip712 },
    wallet: { chainName: input.chainName, nativeCurrency: input.nativeCurrency },
    blockSeconds: input.blockSeconds,
    logRange: input.logRange ?? 1_000,
    finality: input.finality ?? "finalized",
  };
}

export const BASE_SEPOLIA: EvmNetwork = evm({
  key: "base-sepolia",
  chainId: 84532,
  label: "Base Sepolia (testnet)",
  v1Name: "base-sepolia",
  rpc: process.env.SUPERSTABLES_RPC_URL ?? "https://sepolia.base.org",
  defaultRpc: "https://sepolia.base.org",
  rpcEnv: "SUPERSTABLES_RPC_URL",
  explorer: "https://sepolia.basescan.org",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  eip712: { name: "USDC", version: "2" },
  chainName: "Base Sepolia",
  nativeCurrency: ETHER,
  blockSeconds: 2,
  logRange: 1_000,
});

/** Circle's Arc Testnet: USDC is also the gas token there, with 18 decimals natively (the ERC-20 interface has 6). */
export const ARC_TESTNET: EvmNetwork = evm({
  key: "arc-testnet",
  chainId: 5042002,
  label: "Arc Testnet",
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000",
  eip712: { name: "USDC", version: "2" },
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  blockSeconds: 0.5,
});

export const ARBITRUM_SEPOLIA: EvmNetwork = evm({
  key: "arbitrum-sepolia",
  chainId: 421614,
  label: "Arbitrum Sepolia (testnet)",
  rpc: "https://sepolia-rollup.arbitrum.io/rpc",
  explorer: "https://sepolia.arbiscan.io",
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  eip712: { name: "USD Coin", version: "2" },
  chainName: "Arbitrum Sepolia",
  nativeCurrency: ETHER,
  blockSeconds: 0.25,
});

export const POLYGON_AMOY: EvmNetwork = evm({
  key: "polygon-amoy",
  chainId: 80002,
  label: "Polygon Amoy (testnet)",
  v1Name: "polygon-amoy",
  rpc: "https://polygon-amoy-bor-rpc.publicnode.com",
  explorer: "https://amoy.polygonscan.com",
  usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
  eip712: { name: "USDC", version: "2" },
  chainName: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  blockSeconds: 2,
  logRange: 10_000,
});

export const SKALE_BASE_SEPOLIA: EvmNetwork = evm({
  key: "skale-base-sepolia",
  chainId: 324705682,
  label: "SKALE Base Sepolia (testnet)",
  v1Name: "skale-base-sepolia",
  rpc: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
  explorer: "https://base-sepolia-testnet-explorer.skalenodes.com",
  usdc: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",
  eip712: { name: "Bridged USDC (SKALE Bridge)", version: "2" },
  chainName: "SKALE Base Sepolia",
  nativeCurrency: { name: "CREDIT", symbol: "CREDIT", decimals: 18 },
  blockSeconds: 1,
  logRange: 2_000,
  // SKALE chains have instant (BFT) finality, and their RPC answers the `finalized` tag with INVALID_PARAMS.
  finality: "instant",
});

export const ETHEREUM_SEPOLIA: EvmNetwork = evm({
  key: "ethereum-sepolia",
  chainId: 11155111,
  label: "Ethereum Sepolia (testnet)",
  v1Name: "sepolia",
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  explorer: "https://sepolia.etherscan.io",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  eip712: { name: "USDC", version: "2" },
  chainName: "Ethereum Sepolia",
  nativeCurrency: ETHER,
  blockSeconds: 12,
  logRange: 50_000,
});

/** The six x402 EVM chains, in the budget's order. */
export const EVM_NETWORKS: readonly EvmNetwork[] = [BASE_SEPOLIA, ARC_TESTNET, ARBITRUM_SEPOLIA, POLYGON_AMOY, SKALE_BASE_SEPOLIA, ETHEREUM_SEPOLIA];

/**
 * Tempo Moderato. pathUSD is Tempo's reference USD stablecoin, a TIP-20 token at a fixed address with 6 decimals; the
 * owner pays the network fee in it too. A wallet is offered 18 decimals for the native currency, as MetaMask requires.
 */
export const TEMPO_MODERATO: TempoNetwork = {
  rail: "tempo",
  key: "tempo-moderato",
  caip2: "eip155:42431",
  v1Name: "",
  chainId: 42431,
  label: "Tempo Moderato (testnet)",
  testnet: true,
  explorer: "https://explore.testnet.tempo.xyz",
  rpc: "https://rpc.moderato.tempo.xyz",
  defaultRpc: "https://rpc.moderato.tempo.xyz",
  // The same variable the budget's tempo rail reads.
  rpcEnv: "SUPERSTABLES_TEMPO_RPC",
  token: { symbol: "pathUSD", address: "0x20C0000000000000000000000000000000000000", decimals: 6 },
  wallet: { chainName: "Tempo Testnet (Moderato)", nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 } },
};

/** Solana devnet and Circle's devnet USDC mint. */
export const SOLANA_DEVNET: SolanaNetwork = {
  rail: "solana",
  key: "solana-devnet",
  caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  v1Name: "solana-devnet",
  chainId: 0,
  label: "Solana devnet (testnet)",
  testnet: true,
  explorer: "https://explorer.solana.com",
  explorerQuery: "?cluster=devnet",
  rpc: "https://api.devnet.solana.com",
  defaultRpc: "https://api.devnet.solana.com",
  // The same variable the budget's solana rail reads.
  rpcEnv: "SUPERSTABLES_SOLANA_RPC",
  genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  token: { symbol: "USDC", address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 },
  wallet: { chainName: "Solana devnet", nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 }, walletChain: "solana:devnet" },
};

/**
 * Every chain this client knows. Whether `pay` pays on one is up to the rails that are registered (src/core/rails/):
 * SUPPORTED_NETWORKS there is the list it pays on.
 */
export const KNOWN_NETWORKS: readonly NetworkInfo[] = [...EVM_NETWORKS, TEMPO_MODERATO, SOLANA_DEVNET];

export const DEFAULT_NETWORK = BASE_SEPOLIA;

/**
 * Mainnets a seller may name, so a refusal says what it is. None of them is ever paid on: the table above is the only
 * list of chains `pay` signs for, and it holds testnets only.
 */
const MAINNETS: Record<string, string> = {
  "eip155:8453": "Base (mainnet)",
  base: "Base (mainnet)",
  "eip155:1": "Ethereum (mainnet)",
  ethereum: "Ethereum (mainnet)",
  "eip155:42161": "Arbitrum One (mainnet)",
  arbitrum: "Arbitrum One (mainnet)",
  "eip155:137": "Polygon (mainnet)",
  polygon: "Polygon (mainnet)",
  "eip155:5042": "Arc (mainnet)",
  "eip155:1187947933": "SKALE Base (mainnet)",
  "skale-base": "SKALE Base (mainnet)",
  "eip155:4217": "Tempo (mainnet)",
  tempo: "Tempo (mainnet)",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana (mainnet)",
  solana: "Solana (mainnet)",
};

/** The mainnet a network name or CAIP-2 id names, or undefined. */
export function mainnetName(name: string): string | undefined {
  return MAINNETS[name] ?? MAINNETS[name.toLowerCase()];
}

/** Resolves a CAIP-2 id or a v1 vernacular name to a known testnet, or undefined. */
export function networkFor(name: string): NetworkInfo | undefined {
  if (!name) return undefined;
  return KNOWN_NETWORKS.find((n) => n.caip2 === name || (n.v1Name !== "" && n.v1Name === name));
}

/** The x402 EVM chain a name resolves to, or undefined (Tempo is EVM too, but not an x402 chain). */
export function evmNetworkFor(name: string): EvmNetwork | undefined {
  const found = networkFor(name);
  return found?.rail === "evm" ? found : undefined;
}

export function toCaip2(name: string): string {
  return networkFor(name)?.caip2 ?? name;
}

export function describeNetwork(name: string): string {
  const known = networkFor(name);
  if (known) return known.label;
  const mainnet = mainnetName(name);
  if (mainnet) return mainnet;
  if (name.startsWith("solana:") || name.startsWith("solana-")) return "Solana";
  return name;
}

/** The chain's name for people, without the "(testnet)" a label carries. */
export function shortLabel(network: Pick<NetworkInfo, "label">): string {
  return network.label.replace(/\s*\(testnet\)\s*/i, "").trim() || network.label;
}

export function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export const isAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s);

/** A Solana address as text: base58 of 32 bytes (32 to 44 characters; the bytes are checked where it matters). */
export const isSolanaAddressText = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** An address on this network's rail: 0x and 40 hex digits on EVM chains (Tempo included), base58 on Solana. */
export function isAddressOn(network: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return networkFor(network)?.rail === "solana" ? isSolanaAddressText(value) : isAddress(value);
}

/** A transaction id on this network's rail: a 0x hash of 32 bytes on EVM chains, a base58 signature on Solana. */
export function isTransactionId(network: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return networkFor(network)?.rail === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value) : /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Two addresses on this network are the same account: EVM addresses ignore case, Solana's do not. */
export function sameAddressOn(network: string, a: string, b: string): boolean {
  return networkFor(network)?.rail === "solana" ? a === b : isSameAddress(a, b);
}

export function txUrl(network: string, tx: string): string {
  const known = networkFor(network);
  return known ? `${known.explorer}/tx/${tx}${known.explorerQuery ?? ""}` : tx;
}

export function addressUrl(network: string, address: string): string {
  const known = networkFor(network);
  return known ? `${known.explorer}/address/${address}${known.explorerQuery ?? ""}` : address;
}

export function toAtomic(amountDecimal: number, decimals = 6): string {
  return String(Math.round(amountDecimal * 10 ** decimals));
}

export function fromAtomic(amountAtomic: string, decimals = 6): number {
  return Number(amountAtomic) / 10 ** decimals;
}

const ERC20_BALANCE_OF = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * A wallet's balance of the token `pay` pays in on an EVM chain (USDC, or pathUSD on Tempo): a public RPC read, no key,
 * no gas. Solana balances are not read here.
 */
export async function usdcBalance(address: string, network: NetworkInfo = DEFAULT_NETWORK): Promise<number> {
  if (network.rail === "solana") throw new Error("balances on Solana are not read by this function");
  const client = createPublicClient({ transport: http(network.rpc) });
  const raw = await client.readContract({
    address: network.token.address as `0x${string}`,
    abi: ERC20_BALANCE_OF,
    functionName: "balanceOf",
    args: [address as `0x${string}`],
  });
  return Number(raw) / 10 ** network.token.decimals;
}

/** "This much USDC to this address" as an exact x402 v2 requirement any facilitator can settle. */
export function usdcRequirement(amountDecimal: number, payTo: string, network: EvmNetwork = DEFAULT_NETWORK): PaymentRequirements {
  return {
    scheme: "exact",
    network: network.caip2 as PaymentRequirements["network"],
    asset: network.usdc.address,
    amount: toAtomic(amountDecimal, network.usdc.decimals),
    payTo,
    maxTimeoutSeconds: 300,
    extra: { name: network.usdc.eip712.name, version: network.usdc.eip712.version },
  };
}
