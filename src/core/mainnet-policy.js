// What the mainnet manifest (./mainnet-manifest.js) says, checked, and the network mode that decides which kind of chain a
// run uses. Mainnet is the default: every mainnet in the manifest is open together. SUPERSTABLES_TESTNET=1 (the CLI's
// --testnet sets it) makes the run testnet-only: no mainnet is offered or signed on, and only test tokens move. Without
// it, a testnet is refused. The manifest is read once, frozen and checked whole: one malformed fact closes every mainnet,
// so a half-written entry never signs. On top of both sits the pause, read on every call: SUPERSTABLES_MAINNET_PAUSE in
// the environment, or the pause file that ./mainnet-spend.ts registers when it loads. Either stops every new mainnet
// signature and send at once. A pause can only stop: nothing here turns signing on, and a pause check no loaded module
// registered reads as paused.
//
// What a pause cannot do: take back what was already signed. An EIP-3009 authorization signed before the pause stays
// valid on chain until its validBefore time (ten minutes at most here), and anyone who holds it can still submit it; an
// allowance granted before the pause stays live until the owner revokes it on chain. The pause only makes sure this
// client signs and sends nothing new.
//
// Plain JavaScript with JSDoc types, like ./chain-gate.js, and like it free of file system code: it imports only the
// manifest and ./token-facts.js.

import { MAINNET_MANIFEST } from "./mainnet-manifest.js";
import { tokenFactsProblem } from "./token-facts.js";

/**
 * @typedef {object} ManifestRpc
 * @property {string} url
 * @property {string} operator
 * @property {string} source
 */
/**
 * @typedef {object} MainnetChain
 * @property {"evm" | "tempo" | "solana"} rail
 * @property {number} chainId           0 on Solana
 * @property {string} caip2
 * @property {string} [genesisHash]     Solana only
 * @property {string} [walletChain]     Solana only: the Wallet Standard chain
 * @property {string} label
 * @property {string} v1Name
 * @property {string} explorer
 * @property {number} [blockSeconds]    EVM and Tempo
 * @property {number} [logRange]        EVM and Tempo
 * @property {{ name: string, symbol: string, decimals: number }} nativeCurrency
 * @property {ManifestRpc[]} rpc
 * @property {ManifestRpc[]} [stateRpc]
 * @property {{ symbol: string, address: string, decimals: number, domain?: { name: string, version: string }, approveReset?: boolean, source: string[] }} token
 * @property {{ kind: "finalized" | "instant", typicalSeconds: number, maxSpread: number, measured: string }} finality
 * @property {Record<string, string>} sources
 */
/**
 * @typedef {object} MainnetManifest
 * @property {2} schema
 * @property {Record<string, MainnetChain>} chains
 */

/** The environment variable that makes a run testnet-only. The CLI's --testnet flag sets it for the run. */
export const TESTNET_ENV = "SUPERSTABLES_TESTNET";
/** The flag that sets TESTNET_ENV, as the CLI and every message name it. */
export const TESTNET_FLAG = "--testnet";
/** What a mainnet's name carries where the client names the network, as a testnet's label carries " (testnet)". One string, so its wording changes here only. */
export const MAINNET_MARK = " (mainnet)";
const PAUSE_ENV = "SUPERSTABLES_MAINNET_PAUSE";
const RAILS = ["evm", "tempo", "solana"];

/**
 * The one reading of TESTNET_ENV. Exact strings, no trimming and no case folding: "1" or "true" make the run
 * testnet-only; unset, "", "0" or "false" keep the default, mainnet; any other value is an error that names the variable
 * and closes both kinds of chain. A guess ("yes", "TRUE", " 1") would turn a typo into real money or into test tokens the
 * owner did not mean, and this setting decides which.
 * @param {string | undefined} raw
 * @returns {{ testnet: boolean } | { error: string }}
 */
export function parseNetworkMode(raw) {
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") return { testnet: false };
  if (raw === "1" || raw === "true") return { testnet: true };
  const shown = JSON.stringify(raw.length > 24 ? `${raw.slice(0, 24)}...` : raw);
  return { error: `${TESTNET_ENV} is ${shown}, a value it does not take, so no chain is open; unset it, or set it to 1 for testnets` };
}

/**
 * TESTNET_ENV as the process has it now.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ testnet: boolean } | { error: string }}
 */
export function networkMode(env = globalThis.process?.env ?? {}) {
  return parseNetworkMode(env[TESTNET_ENV]);
}

/** True only when the run is testnet-only. An invalid TESTNET_ENV is not testnet-only (and closes both kinds of chain). */
export function testnetRun(env) {
  const m = networkMode(env);
  return !("error" in m) && m.testnet;
}

/** What a printed command adds so it runs on the same kind of chain as this run: " --testnet" in a testnet-only run, else "". */
export function testnetArg(env) {
  return testnetRun(env) ? " --testnet" : "";
}

/**
 * Why mainnet is refused whatever the chain, in words, or "" when it is open (the default). Every refusal of a mainnet
 * asks this. An invalid TESTNET_ENV refuses too.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function mainnetOffReason(env) {
  const m = networkMode(env);
  if ("error" in m) return m.error;
  return m.testnet ? `this run is testnet-only (${TESTNET_FLAG}), so mainnets are off` : "";
}

/**
 * Why a testnet is refused, in words, or "" when the run is testnet-only. Every refusal of a testnet asks this, so each
 * one names the flag. An invalid TESTNET_ENV refuses too.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function testnetOffReason(env) {
  const m = networkMode(env);
  if ("error" in m) return m.error;
  return m.testnet ? "" : `testnets need ${TESTNET_FLAG} (or ${TESTNET_ENV}=1)`;
}

const isObject = (/** @type {unknown} */ v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isHttps = (/** @type {unknown} */ v) => {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
};
const isWord = (/** @type {unknown} */ v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);
const sameAddress = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase() === b.toLowerCase();
const rpcList = (/** @type {unknown} */ v) => Array.isArray(v) && v.length > 0 && v.every((e) => isObject(e) && isHttps(e.url) && isWord(e.operator) && isHttps(e.source));

/** @param {unknown} v */
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const inner of Object.values(v)) deepFreeze(inner);
  }
  return v;
}

/**
 * Why `chain` (one manifest entry, under `key`) cannot be used, one entry per problem; [] when it can.
 * @param {string} key
 * @param {unknown} chain
 * @returns {string[]}
 */
export function chainProblems(key, chain) {
  const out = [];
  const at = (/** @type {string} */ what) => out.push(`${key}: ${what}`);
  if (!isWord(key)) at("the key is not lower-case letters, digits and dashes");
  if (!isObject(chain)) {
    at("the entry is not an object");
    return out;
  }
  const c = /** @type {Record<string, any>} */ (chain);
  if (!RAILS.includes(c.rail)) at(`rail must be one of ${RAILS.join(", ")}`);
  if (c.rail === "solana") {
    if (c.chainId !== 0) at("chainId must be 0 on Solana");
    if (typeof c.genesisHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.genesisHash)) at("genesisHash is missing or malformed");
    else if (c.caip2 !== `solana:${c.genesisHash.slice(0, 32)}`) at("caip2 is not solana: and the first 32 characters of the genesis hash");
    if (typeof c.walletChain !== "string" || !/^solana:[a-z]+$/.test(c.walletChain)) at("walletChain is missing or malformed");
  } else {
    if (!Number.isInteger(c.chainId) || c.chainId <= 0) at("chainId is not a positive whole number");
    else if (c.caip2 !== `eip155:${c.chainId}`) at("caip2 is not eip155:<chainId>");
    if (typeof c.blockSeconds !== "number" || !(c.blockSeconds > 0)) at("blockSeconds is not a positive number");
    if (!Number.isInteger(c.logRange) || c.logRange <= 0) at("logRange is not a positive whole number");
  }
  if (typeof c.label !== "string" || !c.label.trim() || /test|sepolia|devnet|amoy|moderato/i.test(c.label)) at("label is missing or names a testnet");
  if (typeof c.v1Name !== "string" || !/^[a-z0-9-]{0,40}$/.test(c.v1Name)) at("v1Name is malformed");
  if (!isHttps(c.explorer)) at("explorer is not an https URL");
  const n = c.nativeCurrency;
  if (!isObject(n) || typeof n.name !== "string" || !n.name || typeof n.symbol !== "string" || !n.symbol || !Number.isInteger(n.decimals) || n.decimals < 0 || n.decimals > 36) at("nativeCurrency needs a name, a symbol and whole-number decimals");
  if (!rpcList(c.rpc)) at("rpc needs at least one { url (https), operator, source (https) }");
  if (c.stateRpc !== undefined && !rpcList(c.stateRpc)) at("stateRpc, when given, needs { url (https), operator, source (https) } entries");
  const token = c.token;
  const tokenProblem = RAILS.includes(c.rail) ? tokenFactsProblem(token, c.rail) : "";
  if (tokenProblem) at(tokenProblem);
  if (!isObject(token) || !Array.isArray(token.source) || token.source.length === 0 || !token.source.every(isHttps)) at("token needs at least one https source");
  const f = c.finality;
  if (!isObject(f) || !["finalized", "instant"].includes(f.kind) || typeof f.typicalSeconds !== "number" || !Number.isFinite(f.typicalSeconds) || f.typicalSeconds < 0
    || !Number.isInteger(f.maxSpread) || f.maxSpread < 0 || typeof f.measured !== "string" || !f.measured.trim()) {
    at("finality needs kind (finalized or instant), typicalSeconds, maxSpread and what it was measured from");
  }
  if (!isObject(c.sources) || !isHttps(c.sources.chainId) || !isHttps(c.sources.explorer) || !Object.values(c.sources).every(isHttps)) {
    at("sources need https links for chainId and explorer, and every source must be an https link");
  }
  return out;
}

/**
 * Why `manifest` cannot be used, one entry per problem; [] when it can. A manifest is used whole or not at all.
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestProblems(manifest) {
  if (!isObject(manifest)) return ["the manifest is not an object"];
  const m = /** @type {Record<string, any>} */ (manifest);
  const out = [];
  if (m.schema !== 2) out.push("schema must be 2");
  if (!isObject(m.chains)) return [...out, "chains is not an object"];
  const ids = new Set();
  for (const [key, chain] of Object.entries(m.chains)) {
    out.push(...chainProblems(key, chain));
    const id = /** @type {any} */ (chain)?.caip2;
    if (ids.has(id)) out.push(`${key}: ${id} appears twice`);
    ids.add(id);
  }
  return out;
}

/** The shipped manifest, frozen: nothing in this process can change it after it loads. */
const SHIPPED = /** @type {MainnetManifest} */ (deepFreeze(MAINNET_MANIFEST));
const SHIPPED_PROBLEMS = manifestProblems(SHIPPED);

/** The manifest this build ships, frozen. */
export function shippedManifest() {
  return SHIPPED;
}

/**
 * Why the manifest cannot be used, in words, or "" when it can.
 * @param {MainnetManifest} [manifest]
 * @returns {string}
 */
export function manifestRefusal(manifest = SHIPPED) {
  const problems = manifest === SHIPPED ? SHIPPED_PROBLEMS : manifestProblems(manifest);
  return problems.length ? `the mainnet manifest is not valid (${problems.join("; ")})` : "";
}

/**
 * The mainnets the chain tables hold right now: every manifest entry unless the run is testnet-only or the manifest is
 * invalid, none otherwise. Chain tables read it once, as they load, so a testnet-only process never names a mainnet as
 * one it pays on. The gate (./chain-gate.js) still checks the mode on every signature.
 * @param {"evm" | "tempo" | "solana"} [rail]  only that rail's
 * @param {Record<string, string | undefined>} [env]
 * @param {MainnetManifest} [manifest]
 * @returns {[string, MainnetChain][]}
 */
export function mainnetChains(rail, env, manifest = SHIPPED) {
  if (mainnetOffReason(env) || manifestRefusal(manifest)) return [];
  return Object.entries(manifest.chains).filter(([, c]) => rail === undefined || c.rail === rail);
}

/**
 * The manifest entry for `key`, or undefined.
 * @param {string} key
 * @param {MainnetManifest} [manifest]
 * @returns {MainnetChain | undefined}
 */
export function mainnetEntry(key, manifest = SHIPPED) {
  return typeof key === "string" && Object.hasOwn(manifest.chains, key) ? manifest.chains[key] : undefined;
}

/** @type {(() => unknown) | undefined} */
let pauseSource;

/**
 * Registers the pause check that needs files (./mainnet-spend.ts: the pause file). It returns a reason when paused,
 * "" when not. undefined removes it, and then every mainnet reads as paused.
 * @param {(() => unknown) | undefined} source
 */
export function setMainnetPauseSource(source) {
  pauseSource = typeof source === "function" ? source : undefined;
}

/**
 * Why mainnet signing is paused right now, or "" when it is not. Read on every call, never cached: a pause set a moment
 * ago stops the next signature.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function mainnetPauseReason(env = globalThis.process?.env ?? {}) {
  const flag = env[PAUSE_ENV];
  if (typeof flag === "string" && flag.trim() !== "") return `${PAUSE_ENV} is set`;
  if (!pauseSource) return "the pause check is not loaded in this program, so it counts as paused";
  try {
    const r = pauseSource();
    if (r === "") return "";
    return typeof r === "string" && r ? r : "the pause check gave no clear answer, so it counts as paused";
  } catch {
    return "the pause check failed, so it counts as paused";
  }
}

/**
 * Why nothing new may be signed or sent on the mainnet `chain` (a chain table's entry), or "" when the network mode,
 * the manifest and the pause allow it. The prerequisites are chain-gate.js's to check. The chain table's rail, chain id
 * and token must be the manifest's own, fact for fact.
 * @param {{ rail?: unknown, key?: unknown, chainId?: unknown, token?: unknown }} chain
 * @param {MainnetManifest} [manifest]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function mainnetRefusal(chain, manifest = SHIPPED, env) {
  const off = mainnetOffReason(env);
  if (off) return off;
  const invalid = manifestRefusal(manifest);
  if (invalid) return invalid;
  const paused = mainnetPauseReason(env);
  if (paused) return `mainnet signing is paused: ${paused}`;
  const key = typeof chain?.key === "string" ? chain.key : "";
  const entry = mainnetEntry(key, manifest);
  if (!entry) return `the mainnet manifest does not list ${key || "this chain"}`;
  if (chain.rail !== entry.rail) return `${key} is on the ${String(chain.rail)} rail here, and on ${entry.rail} in the mainnet manifest`;
  if (chain.chainId !== undefined && chain.chainId !== entry.chainId) return `${key} has chain id ${String(chain.chainId)} here, and ${entry.chainId} in the mainnet manifest`;
  const t = /** @type {Record<string, any> | undefined} */ (isObject(chain.token) ? chain.token : undefined);
  const m = entry.token;
  const evmSame = entry.rail !== "evm" || (t?.domain?.name === m.domain?.name && t?.domain?.version === m.domain?.version && t?.approveReset === m.approveReset);
  const addressSame = t && typeof t.address === "string" && (entry.rail === "solana" ? t.address === m.address : sameAddress(t.address, m.address));
  if (!t || !addressSame || t.decimals !== m.decimals || t.symbol !== m.symbol || !evmSame) {
    return `${key}'s token here is not the one the mainnet manifest states`;
  }
  return "";
}
