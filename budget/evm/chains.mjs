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
//              limits: the gas limit of each transaction, measured from receipts plus a margin (see FIAT_TOKEN_GAS). Before the
//              agent signs anything it checks it can pay that limit at the current fee, for this transaction and for the ones a
//              failure would need (a pull also needs cancel + return). Doctor sizes its minimums from the same limits.
//              minAgent: a floor under that check (it covers what the limits leave out, such as Base's L1 data fee).
//              topUp: the least recover sends an agent that cannot pay for its steps.
//   logRange   optional: the RPC's eth_getLogs block-range cap, where known (reconcile searches in windows of this size; it also
//              shrinks a window the RPC refuses, so a missing value only costs extra calls).
//   doctor     minimum balances for one grant, a few purchases and a revoke, and where to get them (decimal strings). The
//              token minimum always applies. For gas, doctor asks for DOCTOR_SPIKE times what the steps cost at the current fee,
//              and at least minAgentGas for the agent, which buys alone; minOwnerGas only when it cannot read the fee.
//
// Gas limits of the agent's transactions (pull, cancel, return, selfRevoke) and the owner's (approve, revoke), from receipts read
// back on 30 Sep 2026 (gasUsed, then the limit below with about 20% on top):
//   Circle's FiatToken (Base Sepolia, Ethereum Sepolia): pull 68,380 (Base 0x60202bd6, Sepolia 68,368 0x4196419a), cancel 68,301
//   (Base 0xcc2fe29f; Sepolia 68,281 0x62d3f6cb), return 40,247 (Base 0x37b3520b; Sepolia 40,235 0xa975a022), selfRevoke 40,880
//   (Base 0x4b5ad344), approve 55,425 (Base 0x5b604be9, Sepolia 0xc7ca0d68), revoke 33,501 (Sepolia 0x025ef842).
export const FIAT_TOKEN_GAS = { pull: 85000, cancel: 85000, return: 55000, selfRevoke: 55000, approve: 70000, revoke: 45000 };
/** Doctor wants the agent to afford this many times one purchase and its cleanup at the current fee (fees jump: Amoy's tip went
 *  from 30 to 348 gwei within one run on 30 Sep 2026). */
export const DOCTOR_SPIKE = 2;
export const EVM_CHAINS = {
  "base-sepolia": {
    label: "Base Sepolia", chainId: 84532, viem: "baseSepolia",
    rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
    token: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: ["base-sepolia"], logRange: 1000,
    gas: { symbol: "ETH", decimals: 18, isToken: false, limits: FIAT_TOKEN_GAS, minAgent: "0.000002", topUp: "0.00003" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.00003", minAgentGas: "0.00003", fundAgent: "0.0001", tokenFaucet: "faucet.circle.com, Base Sepolia", gasFaucet: "a Base Sepolia ETH faucet" },
  },
  // Circle's Arc Testnet. USDC is the native gas token: the native balance has 18 decimals, the ERC-20 at 0x3600... shows the
  // same balance in 6-decimal units (native / 1e12, rounded down; checked by preflight). Gas: a pull used 55,514 (0x2a19bdf7);
  // the other limits are FiatToken's (not measured here).
  "arc-testnet": {
    label: "Arc Testnet", chainId: 5042002, viem: "arcTestnet",
    rpc: "https://rpc.testnet.arc.network", explorer: "https://explorer.testnet.arc.io",
    token: { address: "0x3600000000000000000000000000000000000000", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: [],
    gas: { symbol: "USDC", decimals: 18, isToken: true, limits: FIAT_TOKEN_GAS, minAgent: "0.01", topUp: "0.1", reserveMax: "2" },
    doctor: { minOwnerToken: "0.2", minOwnerGas: null, minAgentGas: "0.01", fundAgent: "0.1", tokenFaucet: "faucet.circle.com, Arc Testnet", gasFaucet: "faucet.circle.com, Arc Testnet" },
  },
  // Arbitrum counts its L1 cost in gasUsed, and that part moves with L1 prices (40 to 5,176 gas seen): pull 72,281 with 3,901 for
  // L1 (0xdcb34619), selfRevoke 46,056 with 5,176 (0x477114b5), return 44,658 with 4,411 (0x3364e1f0), approve 55,459
  // (0xe8ab5e08). FiatToken's limits plus 30,000 for the L1 part; gas here costs about 0.03 gwei.
  "arbitrum-sepolia": {
    label: "Arbitrum Sepolia", chainId: 421614, viem: "arbitrumSepolia",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io",
    token: { address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6, domain: { name: "USD Coin", version: "2" } },
    legacy: [],
    gas: { symbol: "ETH", decimals: 18, isToken: false, limits: { pull: 115000, cancel: 115000, return: 85000, selfRevoke: 85000, approve: 100000, revoke: 75000 }, minAgent: "0.000005", topUp: "0.00003" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.00003", minAgentGas: "0.00003", fundAgent: "0.0001", tokenFaucet: "faucet.circle.com, Arbitrum Sepolia", gasFaucet: "an Arbitrum Sepolia ETH faucet" },
  },
  // Amoy's USDC costs about 1.27 times FiatToken's gas: pull 86,860 (0x54d66858, 0x36fbbf2d), selfRevoke 61,040 (0xd4dfffc6), return
  // 56,207 (0x02c85b2a), approve 66,345 (0x54dd6ebc), revoke 44,421 (0x6781bcaf). No cancel was ever sent here: its limit assumes
  // the same ratio (68,281 x 1.27). The tip is 30 gwei at least and jumped to 348 gwei during one run (30 Sep 2026): at that fee one
  // purchase and its cleanup (280,000 gas) cost about 0.1 POL. The minimums below cover about 180 gwei; doctor and buy read the
  // current fee on top.
  "polygon-amoy": {
    label: "Polygon Amoy", chainId: 80002, viem: "polygonAmoy",
    rpc: "https://polygon-amoy-bor-rpc.publicnode.com", explorer: "https://amoy.polygonscan.com",
    token: { address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: ["polygon-amoy"], logRange: 10000,
    gas: { symbol: "POL", decimals: 18, isToken: false, limits: { pull: 105000, cancel: 105000, return: 70000, selfRevoke: 75000, approve: 80000, revoke: 55000 }, minAgent: "0.01", topUp: "0.05" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.03", minAgentGas: "0.05", fundAgent: "0.05", tokenFaucet: "faucet.circle.com, Polygon PoS Amoy", gasFaucet: "a Polygon Amoy POL faucet" },
  },
  // SKALE's bridged USDC: pull 67,780 (0xc7fbef04), return 29,347 (0x3702dd07), approve 47,525 (0x74ee7ce5). FiatToken's limits cover it.
  "skale-base-sepolia": {
    label: "SKALE Base Sepolia", chainId: 324705682, viem: "skaleBaseSepoliaTestnet",
    rpc: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha", explorer: "https://base-sepolia-testnet-explorer.skalenodes.com",
    token: { address: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD", symbol: "USDC", decimals: 6, domain: { name: "Bridged USDC (SKALE Bridge)", version: "2" } },
    legacy: ["skale-base-sepolia"], logRange: 2000,
    gas: { symbol: "CREDIT", decimals: 18, isToken: false, limits: FIAT_TOKEN_GAS, minAgent: "0.0001", topUp: "0.001" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.001", minAgentGas: "0.001", fundAgent: "0.002", tokenFaucet: "Base Sepolia USDC over the SKALE bridge", gasFaucet: "base-sepolia-faucet.skale.space" },
  },
  // L1 gas (FiatToken's limits). The base fee sat near 1 to 1.4 gwei in late September 2026: a pull cost about 0.00009 ETH, and a
  // purchase that fails after the pull costs three agent transactions (pull + cancel + return, 176,884 gas, 0.00023 ETH at 1.3 gwei).
  // minAgent covers those three at their limits (225,000 gas) up to about 2.2 gwei; doctor's minimum covers about 4.4 gwei.
  "ethereum-sepolia": {
    label: "Ethereum Sepolia", chainId: 11155111, viem: "sepolia",
    rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    token: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
    legacy: ["sepolia"], logRange: 50000,
    gas: { symbol: "ETH", decimals: 18, isToken: false, limits: FIAT_TOKEN_GAS, minAgent: "0.0005", topUp: "0.001" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.0005", minAgentGas: "0.001", fundAgent: "0.002", tokenFaucet: "faucet.circle.com, Ethereum Sepolia", gasFaucet: "a Sepolia ETH faucet" },
  },
};

export const EVM_CHAIN_KEYS = Object.keys(EVM_CHAINS);
export const EVM_DEFAULT_CHAIN = "base-sepolia";
