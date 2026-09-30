// The EVM chain table. The only place that names a chain: chains.ts (the rail), doctor.mjs and cli.mjs read it.
// Plain data, no imports, so the CLI and doctor load it without the rail's dependencies.
// Adding a chain is one entry here, after grant, buy, reconcile and revoke were proven on its testnet
// against a third-party seller.
//
//   viem       name of the chain preset exported by viem/chains (its fee formatters; the rpc below replaces the preset's)
//   token      the budget token: its ERC-20 address, symbol, decimals and EIP-712 domain (name, version). The x402 client
//              signs with the seller's extra.name / extra.version; buy refuses a seller whose domain differs from this one,
//              and preflight checks it against the chain (DOMAIN_SEPARATOR()).
//   legacy     x402 v1 network names accepted as this chain. Only names that @x402/evm maps to this chain id.
//   gas        the token that pays fees. isToken: the gas token IS the budget token (Arc): the agent's token balance is never 0,
//              so "the agent holds nothing between purchases" becomes "holds no more than reserveMax". Decimal strings.
//              minAgent: the least the agent needs for a pull. topUp: what recover sends an agent that has less.
//   logRange   optional: the RPC's eth_getLogs block-range cap, where known (reconcile searches in windows of this size; it also
//              shrinks a window the RPC refuses, so a missing value only costs extra calls).
//   doctor     minimum balances for one grant, a few purchases and a revoke, and where to get them (decimal strings).
export const EVM_CHAINS = {
  "base-sepolia": {
    label: "Base Sepolia", chainId: 84532, viem: "baseSepolia",
    rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
    token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: ["base-sepolia"], logRange: 1000,
    gas: { symbol: "ETH", decimals: 18, isToken: false, minAgent: "0.000002", topUp: "0.00003" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.00003", minAgentGas: "0.00003", fundAgent: "0.0001", tokenFaucet: "faucet.circle.com, Base Sepolia", gasFaucet: "a Base Sepolia ETH faucet" },
  },
  // Circle's Arc Testnet. USDC is the native gas token: the native balance has 18 decimals, the ERC-20 at 0x3600... shows the
  // same balance in 6-decimal units (native / 1e12, rounded down; checked by preflight).
  "arc-testnet": {
    label: "Arc Testnet", chainId: 5042002, viem: "arcTestnet",
    rpc: "https://rpc.testnet.arc.network", explorer: "https://explorer.testnet.arc.io",
    token: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: [],
    gas: { symbol: "USDC", decimals: 18, isToken: true, minAgent: "0.01", topUp: "0.1", reserveMax: "2" },
    doctor: { minOwnerToken: "0.2", minOwnerGas: null, minAgentGas: "0.01", fundAgent: "0.1", tokenFaucet: "faucet.circle.com, Arc Testnet", gasFaucet: "faucet.circle.com, Arc Testnet" },
  },
};

export const EVM_CHAIN_KEYS = Object.keys(EVM_CHAINS);
export const EVM_DEFAULT_CHAIN = "base-sepolia";
