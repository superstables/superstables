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
 * What mainnet signing needs besides the owner's signature, one entry each, all of them still to be built in this build.
 * A chain's `missing` list names the ones it lacks; a stream that builds one removes it here.
 */
export const MAINNET_PREREQUISITES = Object.freeze([
  "an RPC endpoint the owner chose for the chain",
  "the chain's token facts, checked",
  "a finality profile for the chain",
  "agent keys stored other than as plain text",
]);

/**
 * What `chain` still lacks for mainnet signing: one entry per missing item. Every item is missing in this build.
 * @param {string} _chainKey
 * @returns {string[]}
 */
export function chainPrerequisitesMissing(_chainKey) {
  return [...MAINNET_PREREQUISITES];
}

/** @type {() => ChainGateSettings | undefined} */
let settingsSource = () => undefined;

/**
 * Where the gate reads the owner's signed settings. owner-settings.js sets it when it loads, so this file stays free of
 * imports: importing the settings module from here would bring the file system into every bundle that only needs the gate.
 * @param {(() => ChainGateSettings | undefined) | undefined} source
 */
export function setChainGateSource(source) {
  settingsSource = typeof source === "function" ? source : () => undefined;
}

/**
 * The enabled chains in the owner's signed settings, and what each still lacks. Undefined when the settings carry no
 * signature, the signature is not valid, or it has not been checked in this process (`primeSignedSettings`): a chain
 * listed without a valid signature is not enabled.
 * @returns {ChainGateSettings | undefined}
 */
export function chainGateSettings() {
  try {
    return settingsSource();
  } catch {
    return undefined;
  }
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
