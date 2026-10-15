// The chain gate: one check in front of every signature, wallet request and broadcast, in both builds (`pay` and its
// signers here, and every rail of `superstables budget`). A chain is signed on only when its own table marks it as a
// testnet. Any other entry is refused unless all three of these hold: this build allows mainnet signing
// (MAINNET_SIGNING, false in this build), the owner's signed settings enable that chain, and the chain has everything
// mainnet needs. So adding a mainnet to a chain table never turns signing on by itself.
//
// Plain JavaScript with JSDoc types, so the budget's .mjs files, its TypeScript and src/ share it; tsc emits it to dist
// with its declaration, and scripts/budget-build.mjs bundles it into dist/budget. It imports nothing.

/** Whether this build signs on any chain that is not a testnet. False in this build: nothing is. */
export const MAINNET_SIGNING = false;

/**
 * @typedef {object} GateChain  A chain as its own table describes it.
 * @property {string} rail       "evm", "tempo" or "solana"
 * @property {string} key        the chain's key in its table, e.g. "base-sepolia"
 * @property {unknown} testnet   true only for a testnet; anything else is treated as a mainnet
 */
/**
 * @typedef {object} ChainGateSettings  What the owner's signed settings say about signing (undefined while there are none).
 * @property {readonly string[]} enabledChains           the chain keys the owner enabled for signing
 * @property {Readonly<Record<string, readonly string[]>>} missing  per chain key, what it still lacks for mainnet; [] when nothing
 */

/**
 * The owner's signed settings for the gate. There are none in this build, so this is undefined; signed owner settings
 * will be its source.
 * @returns {ChainGateSettings | undefined}
 */
export function chainGateSettings() {
  return undefined;
}

/**
 * Why nothing may be signed, offered to a wallet or sent on `chain`, in words, or "" when it may.
 * @param {GateChain} chain
 * @param {ChainGateSettings | undefined} settings
 * @returns {string}
 */
export function chainGate(chain, settings) {
  if (chain?.testnet === true) return "";
  const named = `${typeof chain?.rail === "string" ? chain.rail : "an unknown rail"} chain ${typeof chain?.key === "string" && chain.key ? chain.key : "(unnamed)"}`;
  if (!MAINNET_SIGNING) return `this client does not sign on mainnet chains: the ${named} is not marked as a testnet, and this build signs on testnets only`;
  if (!settings || !Array.isArray(settings.enabledChains) || !settings.enabledChains.includes(chain.key)) {
    return `the ${named} is not a testnet, and the owner's signed settings do not enable signing on it`;
  }
  const missing = settings.missing?.[chain.key];
  if (!Array.isArray(missing)) return `the ${named} is not a testnet, and what it needs for mainnet could not be checked`;
  if (missing.length) return `the ${named} is not ready for mainnet signing: ${missing.join(", ")}`;
  return "";
}
