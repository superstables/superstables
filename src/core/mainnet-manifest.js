// The mainnet manifest: the one place that says whether this build signs on any mainnet, and with which facts and limits.
// It is data only. ./mainnet-policy.js checks it and ./chain-gate.js reads it through that check, so a change here is
// the whole of a later activation: no other file needs editing, and an entry that is incomplete or malformed keeps every
// mainnet closed instead of signing with a guess.
//
//   signing   "off": no mainnet is signed on (this build). "paused": mainnet chains are known, but nothing new is signed
//             or sent on them. "live": approved chains may be signed on, within their caps, once the owner's signed
//             settings enable them and every prerequisite in chain-gate.js passes.
//   chains    one entry per mainnet, by the key a chain table and the owner's settings use for it.
//     status       "candidate": the facts are recorded for review and nothing is signed on the chain, whatever `signing`
//                  says. "approved": reviewed, and then `approval` says who reviewed it (a role, never a name), when, and
//                  where the evidence is.
//     rail         "evm" only: this manifest version opens x402 exact payments (EIP-3009) and nothing else.
//     nativeCurrency  what a browser wallet is told the gas token is.
//     rpc          the public RPC and its source. The owner still chooses an RPC in their signed settings before signing.
//     token        every fact chain tables state (./token-facts.js), with the sources they were read from.
//     permit2      the canonical Permit2 address and how this client treats it. "refused": no offer that names Permit2 is
//                  signed, and no allowance is ever given to it.
//     allowanceSpenders  contracts that may hold a standing token allowance from the owner. Empty: none may.
//     caps         in the token's smallest unit, as decimal strings: perGrantAtomic is the most one signature or one
//                  grant may move, perDayAtomic the most all of them together may in any 24 hours, on this chain. Pending,
//                  retried and unconfirmed signatures count until the 24 hours pass.
//     sources      where each fact comes from. Every mainnet value has one.
//
// Base below is a candidate with its facts read on 29 Oct 2026 (read-only eth_chainId and eth_call against
// mainnet.base.org) and cited from the operators' own documentation. Its caps are a starting proposal. It is not
// approved: no deployment, code hash or rollout scope has been reviewed.

/** @type {import("./mainnet-policy.js").MainnetManifest} */
export const MAINNET_MANIFEST = {
  schema: 1,
  signing: "off",
  chains: {
    base: {
      status: "candidate",
      rail: "evm",
      chainId: 8453,
      label: "Base",
      v1Name: "base",
      explorer: "https://basescan.org",
      blockSeconds: 2,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: {
        url: "https://mainnet.base.org",
        source: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
      },
      token: {
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        domain: { name: "USD Coin", version: "2" },
        approveReset: false,
        source: [
          "https://developers.circle.com/stablecoins/usdc-contract-addresses",
          "https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ],
      },
      permit2: {
        address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
        use: "refused",
        source: "https://docs.uniswap.org/contracts/v4/deployments",
      },
      allowanceSpenders: [],
      caps: { perGrantAtomic: "5000000", perDayAtomic: "25000000" },
      sources: {
        chainId: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
        explorer: "https://docs.base.org/base-chain/quickstart/connecting-to-base",
        domain: "https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913#readProxyContract",
      },
    },
  },
};
