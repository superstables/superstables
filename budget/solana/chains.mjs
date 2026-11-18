// The Solana chains a budget can be on, plain data: Solana devnet, the testnet (default), and Solana mainnet, which the
// table holds only while the operator's switch is on (SUPERSTABLES_ALLOW_MAINNET, ../../src/core/mainnet-policy.js) and
// takes its facts from the mainnet manifest. The dispatcher names the chain in SUPERSTABLES_BUDGET_CHAIN (--chain devnet or
// --chain solana). A chain this table does not hold sets CHAIN_PROBLEM, and every Solana script refuses on it as it loads
// (lib.mjs), before it reads a key or asks an RPC anything. The dispatcher imports this file too, so a bad value never
// stops it here.
import { mainnetChains } from "../../src/core/mainnet-policy.js";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";

/** The variable the dispatcher names the Tempo or Solana budget chain in. */
export const CHAIN_ENV = "SUPERSTABLES_BUDGET_CHAIN";

/**
 * By --chain key. `gateKey` is the chain's key in the chain gate, the RPC tables and the owner settings; `network` the
 * CAIP-2 id sellers name it by and `v1Name` its x402 v1 name; `explorerQuery` what an explorer link adds; `walletChain`
 * the Wallet Standard chain; `faucet` whether free test tokens exist.
 */
export const SOLANA_CHAINS = {
  devnet: {
    key: "devnet", gateKey: "solana-devnet", label: "Solana devnet", testnet: true,
    genesis: SOLANA_DEVNET_GENESIS, network: `solana:${SOLANA_DEVNET_GENESIS.slice(0, 32)}`, v1Name: "solana-devnet",
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", rpc: "https://api.devnet.solana.com",
    explorer: "https://explorer.solana.com", explorerQuery: "?cluster=devnet", walletChain: "solana:devnet", faucet: true,
  },
};
for (const [key, c] of mainnetChains("solana")) {
  SOLANA_CHAINS[key] = {
    key, gateKey: key, label: c.label, testnet: false,
    genesis: /** @type {string} */ (c.genesisHash), network: c.caip2, v1Name: c.v1Name,
    mint: c.token.address, rpc: c.rpc[0].url, explorer: c.explorer, explorerQuery: "", walletChain: /** @type {string} */ (c.walletChain), faucet: false,
  };
}
export const SOLANA_CHAIN_KEYS = Object.keys(SOLANA_CHAINS);
export const SOLANA_DEFAULT_CHAIN = "devnet";

const named = process.env[CHAIN_ENV]?.trim() || SOLANA_DEFAULT_CHAIN;
/** Why this process must not run a Solana script, or "": SUPERSTABLES_BUDGET_CHAIN names a chain the table does not hold. */
export const CHAIN_PROBLEM = Object.hasOwn(SOLANA_CHAINS, named) ? "" : `${CHAIN_ENV} names "${named.slice(0, 40)}", which is not a Solana chain this process holds (${SOLANA_CHAIN_KEYS.join(", ")}); a mainnet is there only while the operator's switch is on`;
/** The chain this process runs on: SUPERSTABLES_BUDGET_CHAIN, or devnet when it is unset. Under CHAIN_PROBLEM, devnet's facts, never used to sign. */
export const CHAIN = CHAIN_PROBLEM ? SOLANA_CHAINS.devnet : SOLANA_CHAINS[named];
