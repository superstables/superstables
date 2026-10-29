// One process that reserves a mainnet amount and says how it went, for test/core/mainnet-boundary.test.ts. The manifest
// is the test's made-up "testmain", handed in directly: a child process cannot share the test's mock. Arguments: what
// the reservation is for, and the amount. SUPERSTABLES_HOME is the parent's, so every child shares one ledger and one lock.

import "../../src/core/chain.js";
import { reserveMainnetSpend } from "../../src/core/mainnet-spend.js";
import type { MainnetManifest } from "../../src/core/mainnet-policy.js";

const manifest = {
  schema: 1,
  signing: "live",
  chains: {
    testmain: {
      status: "approved", rail: "evm", chainId: 990001, label: "Example Main", explorer: "https://explorer.testmain.example", blockSeconds: 2,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpc: { url: "https://rpc.testmain.example", source: "https://docs.testmain.example/rpc" },
      token: { symbol: "USDC", address: "0xabababababababababababababababababababab", decimals: 6, domain: { name: "USD Coin", version: "2" }, approveReset: false, source: ["https://docs.testmain.example/usdc"] },
      permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", use: "refused", source: "https://docs.testmain.example/permit2" },
      allowanceSpenders: [],
      caps: { perGrantAtomic: "1000000", perDayAtomic: "2500000" },
      sources: { chainId: "https://docs.testmain.example/chain", explorer: "https://docs.testmain.example/explorer" },
      approval: { by: "a human", date: "2026-10-29", evidence: "https://example.com/review" },
    },
  },
} as MainnetManifest;

const [what, amount] = process.argv.slice(2);
const chain = { rail: "evm", key: "testmain", chainId: 990001, testnet: false, token: manifest.chains.testmain.token };
reserveMainnetSpend(chain, BigInt(amount), what, { manifest, env: {} }).then(
  (r) => process.stdout.write(r.held ? "held" : "none"),
  (e: Error) => process.stdout.write(`refused: ${e.message}`),
);
