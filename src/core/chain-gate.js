// The chain gate: one check in front of every signature, wallet request and broadcast, in both builds (`pay` and its
// signers here, and every rail of `superstables budget`). A chain is signed on only when its own table marks it as a
// testnet. Any other entry is refused unless all three of these hold: the operator allows mainnet in the environment
// (SUPERSTABLES_ALLOW_MAINNET, off unless set; read only by `mainnetSwitch` below), the owner's signed settings enable that
// chain, and the chain has everything mainnet needs. So adding a mainnet to a chain table never turns signing on by itself.
//
// Plain JavaScript with JSDoc types, so the budget's .mjs files, its TypeScript and src/ share it; tsc emits it to dist
// with its declaration, and scripts/budget-build.mjs bundles it into dist/budget. It imports only ./token-facts.js and
// ./finality-policy.js, which import nothing, so it still loads no file system code. Two prerequisites need files, so the
// modules that own those facts register their checks here when they load (rpc-endpoints.mjs, budget/os-keychain.mjs). A
// check no loaded module registered counts as missing: `pay` loads rpc-endpoints.mjs (through its RPC reads) but not
// budget/os-keychain.mjs, so for `pay` the agent-key prerequisite always reads as missing.

import { tokenFactsProblem } from "./token-facts.js";
import { finalityProfile } from "./finality-policy.js";

/** The environment variable that lets this client sign on a chain that is not a testnet. Only the operator sets it. */
export const MAINNET_ENV = "SUPERSTABLES_ALLOW_MAINNET";

/**
 * The one reading of MAINNET_ENV. Exact strings, no trimming and no case folding: "1" or "true" allow mainnet; unset, "",
 * "0" or "false" keep it off; any other value is an error that names the variable. A guess ("yes", "TRUE", " 1") would turn
 * a typo into either a silent no or an unintended yes, and this switch guards money.
 * @param {string | undefined} raw
 * @returns {{ enabled: boolean } | { error: string }}
 */
export function parseMainnetSwitch(raw) {
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") return { enabled: false };
  if (raw === "1" || raw === "true") return { enabled: true };
  const shown = JSON.stringify(raw.length > 24 ? `${raw.slice(0, 24)}...` : raw);
  return { error: `${MAINNET_ENV} is ${shown}, which is not a value: use 1 or true to allow mainnet, or 0, false or unset to keep it off` };
}

/**
 * MAINNET_ENV as the process has it now.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ enabled: boolean } | { error: string }}
 */
export function mainnetSwitch(env = globalThis.process?.env ?? {}) {
  return parseMainnetSwitch(env[MAINNET_ENV]);
}

/**
 * Why mainnet is refused whatever the chain, in words, or "" when the operator has allowed it. Every refusal of a mainnet
 * asks this, so each one names MAINNET_ENV. An invalid value refuses like an off switch.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function mainnetSwitchRefusal(env) {
  const s = mainnetSwitch(env);
  if ("error" in s) return s.error;
  return s.enabled ? "" : `mainnet is off: only the operator turns it on, with ${MAINNET_ENV}=1 in their environment`;
}

/**
 * @typedef {object} GateChain  A chain as its own table describes it.
 * @property {string} rail       "evm", "tempo" or "solana"
 * @property {string} key        the chain's key in its table, e.g. "base-sepolia"
 * @property {unknown} testnet   true only for a testnet; anything else is treated as a mainnet
 * @property {unknown} [token]   the token the caller signs with, as its chain table states it (./token-facts.js); a mainnet needs every fact stated
 */
/**
 * @typedef {object} ChainGateSettings  What the owner's signed settings say about signing (undefined while there are none).
 * @property {readonly string[]} enabledChains  the chain keys the owner enabled for signing
 */

/**
 * What mainnet signing needs besides the owner's signature, one entry each. `chainPrerequisitesMissing` checks each one;
 * the text of each is what a refusal names.
 */
export const MAINNET_PREREQUISITES = Object.freeze([
  "an RPC endpoint the owner chose for the chain",
  "the chain's token facts, checked",
  "a finality profile for the chain",
  "agent keys stored other than as plain text",
]);

/** @type {{ ownerRpc?: (chainKey: string) => unknown, agentKeyStore?: (rail: string) => unknown }} */
const checks = {};

/**
 * Registers the check behind a prerequisite that needs files: "ownerRpc" (rpc-endpoints.mjs) or "agentKeyStore"
 * (budget/os-keychain.mjs). undefined removes it. Any other name throws: it is a mistake in this program.
 * @param {"ownerRpc" | "agentKeyStore"} name
 * @param {((arg: string) => unknown) | undefined} check
 */
export function setPrerequisiteCheck(name, check) {
  if (name !== "ownerRpc" && name !== "agentKeyStore") throw new Error(`no prerequisite check is named ${String(name)}`);
  if (typeof check === "function") checks[name] = check;
  else delete checks[name];
}

const passes = (/** @type {() => unknown} */ f) => { try { return f() === true; } catch { return false; } };
/** The chain's name in finality-policy.js: the gate key without a leading "<rail>-" (tempo-moderato: moderato). */
const finalityName = (/** @type {string} */ rail, /** @type {string} */ key) => (key.startsWith(`${rail}-`) ? key.slice(rail.length + 1) : key);

/**
 * What `chain` still lacks for mainnet signing, in MAINNET_PREREQUISITES order: an entry is listed only when its check
 * fails. A check that is not registered, throws, or returns anything but true counts as failed.
 * @param {GateChain} chain
 * @returns {string[]}
 */
export function chainPrerequisitesMissing(chain) {
  const rail = typeof chain?.rail === "string" ? chain.rail : "";
  const key = typeof chain?.key === "string" ? chain.key : "";
  const ok = [
    passes(() => (key && checks.ownerRpc ? checks.ownerRpc(key) : false)),
    passes(() => tokenFactsProblem(chain?.token, /** @type {any} */ (rail)) === ""),
    passes(() => {
      if (!rail || !key) return false;
      const seconds = finalityProfile(rail, finalityName(rail, key)).typicalSeconds;
      return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;
    }),
    passes(() => (rail && checks.agentKeyStore ? checks.agentKeyStore(rail) : false)),
  ];
  return MAINNET_PREREQUISITES.filter((_, i) => !ok[i]);
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
 * The enabled chains in the owner's signed settings. Undefined when the settings carry no
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

const chainName = (/** @type {GateChain} */ chain) => `${typeof chain?.rail === "string" ? chain.rail : "an unknown rail"} chain ${typeof chain?.key === "string" && chain.key ? chain.key : "(unnamed)"}`;

/**
 * Why nothing may be signed, offered to a wallet or sent on `chain`, in words, or "" when it may.
 * @param {GateChain} chain
 * @param {ChainGateSettings | undefined} settings
 * @returns {string}
 */
export function chainGate(chain, settings) {
  if (chain?.testnet === true) return "";
  const off = mainnetSwitchRefusal();
  if (off) return `${off}; the ${chainName(chain)} is not marked as a testnet`;
  return mainnetGate(chain, settings);
}

/**
 * The gate for a chain that is not a testnet, once the operator allows mainnet: chainGate calls it only then, and
 * tests call it directly.
 * @param {GateChain} chain
 * @param {ChainGateSettings | undefined} settings
 * @returns {string}
 */
export function mainnetGate(chain, settings) {
  const named = chainName(chain);
  if (!settings || !Array.isArray(settings.enabledChains) || !settings.enabledChains.includes(chain.key)) {
    return `the ${named} is not a testnet, and the owner's signed settings do not enable signing on it`;
  }
  const missing = chainPrerequisitesMissing(chain);
  if (missing.length) return `the ${named} is not ready for mainnet signing: ${missing.join(", ")}`;
  return "";
}
