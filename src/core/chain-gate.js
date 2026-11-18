// The chain gate: one check in front of every signature, wallet request and broadcast, in both builds (`pay` and its
// signers here, and every rail of `superstables budget`). A chain its own table marks as a testnet is always signed on.
// Any other chain is refused unless all of these hold: the operator allows mainnet in the environment
// (SUPERSTABLES_ALLOW_MAINNET, off unless set, read by ./mainnet-policy.js), the mainnet manifest (./mainnet-manifest.js)
// is valid and states the same chain and token facts as the chain table, mainnet signing is not paused, and the chain
// has what signing on it correctly needs (MAINNET_PREREQUISITES). The switch opens every mainnet in the manifest at once:
// there is no per-chain approval and no cap beyond the owner's own. Each check only closes: none turns signing on.
//
// Plain JavaScript with JSDoc types, so the budget's .mjs files, its TypeScript and src/ share it; tsc emits it to dist
// with its declaration, and scripts/budget-build.mjs bundles it into dist/budget. It imports only ./token-facts.js,
// ./finality-policy.js and ./mainnet-policy.js (which imports only the manifest and token-facts.js), so it still loads no
// file system code. Two prerequisites need files, so the modules that own those facts register their checks here when
// they load (rpc-endpoints.mjs, budget/os-keychain.mjs). A check no loaded module registered counts as missing.

import { tokenFactsProblem } from "./token-facts.js";
import { finalityProfile } from "./finality-policy.js";
import { MAINNET_ENV, mainnetRefusal, mainnetSwitch, mainnetSwitchRefusal, parseMainnetSwitch } from "./mainnet-policy.js";

export { MAINNET_ENV, mainnetSwitch, mainnetSwitchRefusal, parseMainnetSwitch };

/**
 * @typedef {object} GateChain  A chain as its own table describes it.
 * @property {string} rail       "evm", "tempo" or "solana"
 * @property {string} key        the chain's key in its table, e.g. "base-sepolia" or "base"
 * @property {unknown} testnet   true only for a testnet; anything else is treated as a mainnet
 * @property {unknown} [chainId] the chain's EIP-155 id, when the caller has it; checked against the mainnet manifest
 * @property {unknown} [token]   the token the caller signs with, as its chain table states it (./token-facts.js); a mainnet needs every fact stated
 * @property {boolean} [agentKey] true when an agent key on this computer signs here (the budget rails); `pay` holds no agent key
 */

/**
 * What signing on a mainnet needs besides the operator's switch, one entry each. `chainPrerequisitesMissing` checks each
 * one; the text of each is what a refusal names. The last applies only where an agent key signs.
 */
export const MAINNET_PREREQUISITES = Object.freeze([
  "RPC endpoints that can decide a payment was never made (two operators, or the owner's own node in their settings)",
  "the chain's token facts, checked",
  "a finality profile for the chain",
  "the agent key kept in the OS keychain, not as plain text",
]);

/** @type {{ verdictRpc?: (chainKey: string) => unknown, agentKeyStore?: (rail: string, chainKey: string) => unknown }} */
const checks = {};

/**
 * Registers the check behind a prerequisite that needs files: "verdictRpc" (rpc-endpoints.mjs) or "agentKeyStore"
 * (budget/os-keychain.mjs). undefined removes it. Any other name throws: it is a mistake in this program.
 * @param {"verdictRpc" | "agentKeyStore"} name
 * @param {((arg: string, chainKey: string) => unknown) | undefined} check  verdictRpc gets the chain key; agentKeyStore the rail and the chain key
 */
export function setPrerequisiteCheck(name, check) {
  if (name !== "verdictRpc" && name !== "agentKeyStore") throw new Error(`no prerequisite check is named ${String(name)}`);
  if (typeof check === "function") checks[name] = check;
  else delete checks[name];
}

const passes = (/** @type {() => unknown} */ f) => { try { return f() === true; } catch { return false; } };
/** The chain's name in finality-policy.js: the gate key without a leading "<rail>-" (tempo-moderato: moderato). */
const finalityName = (/** @type {string} */ rail, /** @type {string} */ key) => (key.startsWith(`${rail}-`) ? key.slice(rail.length + 1) : key);

/**
 * What `chain` still lacks for mainnet signing, in MAINNET_PREREQUISITES order: an entry is listed only when its check
 * fails. A check that is not registered, throws, or returns anything but true counts as failed. The agent key is checked
 * only when `chain.agentKey` is true.
 * @param {GateChain} chain
 * @returns {string[]}
 */
export function chainPrerequisitesMissing(chain) {
  const rail = typeof chain?.rail === "string" ? chain.rail : "";
  const key = typeof chain?.key === "string" ? chain.key : "";
  const ok = [
    passes(() => (key && checks.verdictRpc ? checks.verdictRpc(key) : false)),
    passes(() => tokenFactsProblem(chain?.token, /** @type {any} */ (rail)) === ""),
    passes(() => {
      if (!rail || !key) return false;
      const seconds = finalityProfile(rail, finalityName(rail, key)).typicalSeconds;
      return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
    }),
    chain?.agentKey === true ? passes(() => (rail && checks.agentKeyStore ? checks.agentKeyStore(rail, key) : false)) : true,
  ];
  return MAINNET_PREREQUISITES.filter((_, i) => !ok[i]);
}

const chainName = (/** @type {GateChain} */ chain) => `${typeof chain?.rail === "string" ? chain.rail : "an unknown rail"} chain ${typeof chain?.key === "string" && chain.key ? chain.key : "(unnamed)"}`;

/**
 * Why nothing may be signed, offered to a wallet or sent on `chain`, in words, or "" when it may.
 * @param {GateChain} chain
 * @returns {string}
 */
export function chainGate(chain) {
  if (chain?.testnet === true) return "";
  const off = mainnetSwitchRefusal();
  if (off) return `${off}; the ${chainName(chain)} is not marked as a testnet`;
  const refusal = mainnetRefusal(chain);
  if (refusal) return `this client does not sign on the ${chainName(chain)}: ${refusal}`;
  const missing = chainPrerequisitesMissing(chain);
  if (missing.length) return `the ${chainName(chain)} is not ready for mainnet signing: ${missing.join(", ")}`;
  return "";
}
