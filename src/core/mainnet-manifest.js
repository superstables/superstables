// The mainnet manifest: every mainnet this client knows, one entry per testnet pair it already pays on, with the facts
// signing and reading need and where each fact comes from. It is data only. ./mainnet-policy.js checks it whole, and
// the chain tables (src/core/chain.ts, budget/evm/chains.mjs) and the RPC table (./rpc-endpoints.mjs) build their
// mainnet entries from it unless the run is testnet-only (--testnet, ./mainnet-policy.js). In a testnet-only run no
// table holds a mainnet and every mainnet is refused, as in a build without this file.
//
//   rail         "evm" (x402 exact, EIP-3009), "tempo" (MPP tempo.charge) or "solana" (x402 exact on SVM)
//   chainId      the EIP-155 id; 0 on Solana, whose cluster is its genesis hash
//   caip2        the CAIP-2 id sellers name the chain by
//   v1Name       the x402 v1 name @x402/evm (or @x402/svm) maps to this chain, or "" when it maps none
//   rpc          the public RPCs, first one the default, each with its operator and its source. A verdict that lets an
//                agent pay again needs two operators to agree (./rpc-endpoints.mjs); a chain with one public operator
//                needs the owner's own node for those verdicts.
//   stateRpc     where state at the finalized block is read, when the default RPC keeps only recent state
//   token        the token the testnet pair pays in, on this chain: every fact ./token-facts.js asks for, read on chain
//   finality     kind: "finalized" (the RPC's finalized tag) or "instant" (every block is final; the RPC refuses the tag).
//                typicalSeconds: how far finalized trailed the head. maxSpread: how far apart two RPCs' finalized
//                heads may be, in blocks. Both measured on 18 Nov 2026 from the Superstables VPS; typicalSeconds of Base,
//                Arbitrum One, Robinhood Chain and Ethereum again on 19 Nov 2026 (RECHECKED), as the website's table.
//   sources      where each fact comes from
//
// Facts read on 18 Nov 2026 with read-only calls (eth_chainId, eth_call of name, symbol, decimals, version and
// DOMAIN_SEPARATOR, recomputed from the stated domain; getGenesisHash and getTokenSupply on Solana). Nothing was signed
// or sent. Arc and Tempo use the same token address on mainnet as on their testnets: the chain id tells them apart.

const MEASURED = "measured 18 Nov 2026 (latest minus finalized timestamp, finalized jumps over two minutes)";
const RECHECKED = "measured 19 Nov 2026 (latest minus finalized block time on both endpoints, every 20 s for 10 minutes)";

/** @type {import("./mainnet-policy.js").MainnetManifest} */
export const MAINNET_MANIFEST = {
  schema: 2,
  chains: {
    base: {
      rail: "evm",
      chainId: 8453,
      caip2: "eip155:8453",
      label: "Base",
      v1Name: "base",
      explorer: "https://basescan.org",
      blockSeconds: 2,
      // mainnet.base.org rate-limits eth_getLogs; Base Sepolia's public RPC takes 200 blocks at most.
      logRange: 200,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: [
        { url: "https://mainnet.base.org", operator: "base", source: "https://docs.base.org/base-chain/quickstart/connecting-to-base" },
        { url: "https://base-rpc.publicnode.com", operator: "publicnode", source: "https://base.publicnode.com" },
      ],
      token: {
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        domain: { name: "USD Coin", version: "2" },
        approveReset: false,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses"],
      },
      finality: { kind: "finalized", typicalSeconds: 1200, maxSpread: 5000, measured: `863 to 1,521 s; ${RECHECKED}; 866 s and finalized jumped 1,768 blocks, ${MEASURED}` },
      sources: {
        chainId: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
        explorer: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
      },
    },
    arc: {
      rail: "evm",
      chainId: 5042,
      caip2: "eip155:5042",
      label: "Arc",
      v1Name: "",
      explorer: "https://explorer.arc.io",
      blockSeconds: 0.5,
      logRange: 1000,
      // USDC is the gas token, 18 decimals natively; the ERC-20 at 0x3600... has 6.
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpc: [
        { url: "https://rpc.mainnet.arc.io", operator: "circle", source: "https://docs.arc.io/arc/references/connect-to-arc" },
        { url: "https://rpc.drpc.mainnet.arc.io", operator: "drpc", source: "https://docs.arc.io/arc/references/rpc-endpoints" },
        { url: "https://rpc.blockdaemon.mainnet.arc.io", operator: "blockdaemon", source: "https://docs.arc.io/arc/references/rpc-endpoints" },
      ],
      token: {
        symbol: "USDC",
        address: "0x3600000000000000000000000000000000000000",
        decimals: 6,
        domain: { name: "USDC", version: "2" },
        approveReset: false,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses", "https://docs.arc.io/integrate/infrastructure"],
      },
      finality: { kind: "finalized", typicalSeconds: 1, maxSpread: 1000, measured: `0 s; finalized jumped 20 blocks; ${MEASURED}` },
      sources: {
        chainId: "https://docs.arc.io/arc/references/connect-to-arc",
        explorer: "https://docs.arc.io/arc/references/connect-to-arc",
      },
    },
    arbitrum: {
      rail: "evm",
      chainId: 42161,
      caip2: "eip155:42161",
      label: "Arbitrum One",
      v1Name: "",
      explorer: "https://arbiscan.io",
      blockSeconds: 0.25,
      logRange: 50000,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      // PublicNode refuses state reads at `finalized` without a key; Offchain Labs and Tenderly answer them.
      rpc: [
        { url: "https://arb1.arbitrum.io/rpc", operator: "offchain-labs", source: "https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers" },
        { url: "https://arbitrum.gateway.tenderly.co", operator: "tenderly", source: "https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers" },
      ],
      token: {
        symbol: "USDC",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        decimals: 6,
        domain: { name: "USD Coin", version: "2" },
        approveReset: false,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses"],
      },
      finality: { kind: "finalized", typicalSeconds: 1020, maxSpread: 5000, measured: `820 to 1,190 s; ${RECHECKED}; 882 s and finalized jumped 1,338 blocks, ${MEASURED}` },
      sources: {
        chainId: "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info",
        explorer: "https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info",
      },
    },
    polygon: {
      rail: "evm",
      chainId: 137,
      caip2: "eip155:137",
      label: "Polygon",
      v1Name: "polygon",
      explorer: "https://polygonscan.com",
      blockSeconds: 2,
      logRange: 10000,
      nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
      rpc: [
        { url: "https://polygon-bor-rpc.publicnode.com", operator: "publicnode", source: "https://docs.polygon.technology/pos/reference/rpc-endpoints/" },
        { url: "https://polygon.gateway.tenderly.co", operator: "tenderly", source: "https://docs.polygon.technology/pos/reference/rpc-endpoints/" },
      ],
      token: {
        symbol: "USDC",
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        decimals: 6,
        domain: { name: "USD Coin", version: "2" },
        approveReset: false,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses"],
      },
      finality: { kind: "finalized", typicalSeconds: 5, maxSpread: 1000, measured: `2 to 5 s; finalized jumped 7 blocks; ${MEASURED}` },
      sources: {
        chainId: "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
        explorer: "https://docs.polygon.technology/pos/reference/rpc-endpoints/",
      },
    },
    "skale-base": {
      rail: "evm",
      chainId: 1187947933,
      caip2: "eip155:1187947933",
      label: "SKALE Base",
      v1Name: "",
      explorer: "https://skale-base-explorer.skalenodes.com",
      blockSeconds: 1,
      logRange: 2000,
      nativeCurrency: { name: "CREDIT", symbol: "CREDIT", decimals: 18 },
      // SKALE runs the only public RPC: a verdict that lets an agent pay again needs the owner's own node here.
      rpc: [
        { url: "https://skale-base.skalenodes.com/v1/base", operator: "skale", source: "https://docs.skale.space/get-started/quick-start/skale-on-base" },
      ],
      // Bridged USDC; its symbol() says "USDC.e". It is labelled USDC here, as on SKALE Base Sepolia.
      token: {
        symbol: "USDC",
        address: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
        decimals: 6,
        domain: { name: "Bridged USDC (SKALE Bridge)", version: "2" },
        approveReset: false,
        source: ["https://docs.skale.space/get-started/quick-start/skale-on-base"],
      },
      finality: { kind: "instant", typicalSeconds: 0, maxSpread: 1000, measured: `the RPC refuses the finalized tag (BFT finality); ${MEASURED}` },
      sources: {
        chainId: "https://docs.skale.space/get-started/quick-start/skale-on-base",
        explorer: "https://docs.skale.space/get-started/quick-start/skale-on-base",
      },
    },
    ethereum: {
      rail: "evm",
      chainId: 1,
      caip2: "eip155:1",
      label: "Ethereum",
      v1Name: "ethereum",
      explorer: "https://etherscan.io",
      blockSeconds: 12,
      logRange: 10000,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: [
        { url: "https://ethereum-rpc.publicnode.com", operator: "publicnode", source: "https://ethereum.org/developers/docs/networks/" },
        { url: "https://mainnet.gateway.tenderly.co", operator: "tenderly", source: "https://ethereum.org/developers/docs/networks/" },
      ],
      token: {
        symbol: "USDC",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        decimals: 6,
        domain: { name: "USD Coin", version: "2" },
        approveReset: false,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses"],
      },
      finality: { kind: "finalized", typicalSeconds: 960, maxSpread: 1000, measured: `780 to 1,140 s; ${RECHECKED}; 840 s and finalized jumped 32 blocks, ${MEASURED}` },
      sources: {
        chainId: "https://ethereum.org/developers/docs/networks/",
        explorer: "https://ethereum.org/developers/docs/networks/",
      },
    },
    robinhood: {
      rail: "evm",
      chainId: 4663,
      caip2: "eip155:4663",
      label: "Robinhood Chain",
      v1Name: "",
      explorer: "https://robinhoodchain.blockscout.com",
      blockSeconds: 0.15,
      logRange: 100000,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: [
        { url: "https://rpc.mainnet.chain.robinhood.com", operator: "robinhood", source: "https://docs.robinhood.com/chain/connecting" },
        { url: "https://robinhood.drpc.org", operator: "drpc", source: "https://docs.robinhood.com/chain/connecting" },
      ],
      // The official RPC refuses state reads at `finalized` ("historical state ... is not available"); dRPC answers them.
      stateRpc: [{ url: "https://robinhood.drpc.org", operator: "drpc", source: "https://docs.robinhood.com/chain/connecting" }],
      // Paxos's USDG. It has no version() (it reverts): its DOMAIN_SEPARATOR() is the one for version "1".
      token: {
        symbol: "USDG",
        address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
        decimals: 6,
        domain: { name: "Global Dollar", version: "1" },
        approveReset: false,
        source: ["https://docs.paxos.com/guides/stablecoin/usdg/mainnet"],
      },
      finality: { kind: "finalized", typicalSeconds: 1020, maxSpread: 10000, measured: `815 to 1,184 s; ${RECHECKED}; 862 s and finalized jumped 3,335 blocks, ${MEASURED}` },
      sources: {
        chainId: "https://docs.robinhood.com/chain/add-network-to-wallet",
        explorer: "https://docs.robinhood.com/chain/add-network-to-wallet",
      },
    },
    tempo: {
      rail: "tempo",
      chainId: 4217,
      caip2: "eip155:4217",
      label: "Tempo",
      v1Name: "",
      explorer: "https://explore.tempo.xyz",
      blockSeconds: 0.5,
      logRange: 100000,
      // There is no native token: fees are paid in USD stablecoins. MetaMask requires 18 decimals here.
      nativeCurrency: { name: "USD", symbol: "USD", decimals: 18 },
      rpc: [
        { url: "https://rpc.tempo.xyz", operator: "tempo", source: "https://tempo.com/developers/docs/quickstart/connection-details" },
        { url: "https://tempo-rpc.publicnode.com", operator: "publicnode", source: "https://tempo.publicnode.com" },
      ],
      // OUSD (TIP-20, quote token pathUSD), read on both endpoints at the finalized block on 19 November 2026: symbol() OUSD,
      // decimals() 6, currency() USD. Not pathUSD: "For balances and payments, most integrations should use OUSD" and
      // "The user and merchant never hold pathUSD directly".
      token: {
        symbol: "OUSD",
        address: "0x20c0000000000000000000006a37DA5C996874BE",
        decimals: 6,
        source: ["https://tempo.com/developers/docs/guide/ousd", "https://tempo.com/developers/docs/protocol/exchange/quote-tokens"],
      },
      finality: { kind: "finalized", typicalSeconds: 1, maxSpread: 1000, measured: `0 s; finalized jumped 18 blocks; ${MEASURED}` },
      sources: {
        chainId: "https://tempo.com/developers/docs/quickstart/connection-details",
        explorer: "https://tempo.com/developers/docs/quickstart/connection-details",
      },
    },
    solana: {
      rail: "solana",
      chainId: 0,
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      walletChain: "solana:mainnet",
      label: "Solana",
      v1Name: "solana",
      explorer: "https://explorer.solana.com",
      nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
      rpc: [
        { url: "https://api.mainnet-beta.solana.com", operator: "solana-foundation", source: "https://solana.com/docs/references/clusters" },
        { url: "https://solana-rpc.publicnode.com", operator: "publicnode", source: "https://solana.publicnode.com" },
      ],
      // Circle's USDC mint, a classic SPL token (owner TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
      token: {
        symbol: "USDC",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        source: ["https://developers.circle.com/stablecoins/usdc-contract-addresses"],
      },
      finality: { kind: "finalized", typicalSeconds: 1, maxSpread: 0, measured: `the finalized block was about 1 s old, 0 to 2 slots behind confirmed; ${MEASURED}` },
      sources: {
        chainId: "https://solana.com/docs/references/clusters",
        explorer: "https://solana.com/docs/references/clusters",
      },
    },
  },
};
