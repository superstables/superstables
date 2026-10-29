// What the mainnet manifest (./mainnet-manifest.js) allows, checked. The manifest is read once, frozen, and checked
// whole: one malformed fact closes every mainnet, so a half-written activation never signs. On top of the manifest sits
// the pause, read on every call: SUPERSTABLES_MAINNET_PAUSE in the environment, or the pause file that
// ./mainnet-spend.ts registers when it loads. Either stops every new mainnet signature, reservation and send at once.
// A pause can only stop: nothing here turns signing on, and a pause check no loaded module registered reads as paused.
//
// What a pause cannot do: take back what was already signed. An EIP-3009 authorization signed before the pause stays
// valid on chain until its validBefore time (ten minutes at most here), and anyone who holds it can still submit it; an
// allowance granted before the pause stays live until the owner revokes it on chain. The pause only makes sure this
// client signs, reserves and sends nothing new.
//
// Plain JavaScript with JSDoc types, like ./chain-gate.js, and like it free of file system code: it imports only the
// manifest and ./token-facts.js.

import { MAINNET_MANIFEST } from "./mainnet-manifest.js";
import { tokenFactsProblem } from "./token-facts.js";

/**
 * @typedef {object} MainnetChain
 * @property {"candidate" | "approved"} status
 * @property {"evm"} rail
 * @property {number} chainId
 * @property {string} label
 * @property {string} [v1Name]
 * @property {string} explorer
 * @property {number} blockSeconds
 * @property {{ name: string, symbol: string, decimals: number }} nativeCurrency
 * @property {{ url: string, source: string }} rpc
 * @property {{ symbol: string, address: string, decimals: number, domain: { name: string, version: string }, approveReset: boolean, source: string[] }} token
 * @property {{ address: string, use: "refused", source: string }} permit2
 * @property {{ address: string, source: string }[]} allowanceSpenders
 * @property {{ perGrantAtomic: string, perDayAtomic: string }} caps
 * @property {Record<string, string>} sources
 * @property {{ by: string, date: string, evidence: string }} [approval]
 */
/**
 * @typedef {object} MainnetManifest
 * @property {1} schema
 * @property {"off" | "paused" | "live"} signing
 * @property {Record<string, MainnetChain>} chains
 */
/** @typedef {{ chainId: number, tokenAddress: string }} TestnetFact */

const SIGNING = ["off", "paused", "live"];
const STATUS = ["candidate", "approved"];
const PAUSE_ENV = "SUPERSTABLES_MAINNET_PAUSE";

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
const isEvmAddress = (/** @type {unknown} */ v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isAtomic = (/** @type {unknown} */ v) => typeof v === "string" && /^[1-9][0-9]{0,40}$/.test(v);
const sameAddress = (/** @type {string} */ a, /** @type {string} */ b) => a.toLowerCase() === b.toLowerCase();

/** @param {unknown} v */
function deepFreeze(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const inner of Object.values(v)) deepFreeze(inner);
  }
  return v;
}

/** @type {TestnetFact[]} */
const testnetFacts = [];

/**
 * Chain tables register the chain id and token of each of their testnets as they load (src/core/chain.ts,
 * budget/evm/chains.ts), so the manifest can be checked against them: a mainnet entry never carries a testnet's chain
 * id or token address.
 * @param {readonly TestnetFact[]} facts
 */
export function registerTestnetFacts(facts) {
  for (const f of facts) testnetFacts.push({ chainId: f.chainId, tokenAddress: f.tokenAddress });
}

/**
 * Why `chain` (one manifest entry, under `key`) cannot be used, one entry per problem; [] when it can.
 * @param {string} key
 * @param {unknown} chain
 * @param {readonly TestnetFact[]} testnets
 * @returns {string[]}
 */
export function chainProblems(key, chain, testnets = testnetFacts) {
  const out = [];
  const at = (/** @type {string} */ what) => out.push(`${key}: ${what}`);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key)) at("the key is not lower-case letters, digits and dashes");
  if (!isObject(chain)) {
    at("the entry is not an object");
    return out;
  }
  const c = /** @type {Record<string, any>} */ (chain);
  if (!STATUS.includes(c.status)) at(`status must be one of ${STATUS.join(", ")}`);
  if (c.rail !== "evm") at("rail must be evm: this manifest version opens EIP-3009 payments on EVM chains only");
  if (!Number.isInteger(c.chainId) || c.chainId <= 0) at("chainId is not a positive whole number");
  if (typeof c.label !== "string" || !c.label.trim() || /test|sepolia|devnet/i.test(c.label)) at("label is missing or names a testnet");
  if (c.v1Name !== undefined && (typeof c.v1Name !== "string" || !/^[a-z0-9-]{1,40}$/.test(c.v1Name))) at("v1Name is malformed");
  if (!isHttps(c.explorer)) at("explorer is not an https URL");
  if (typeof c.blockSeconds !== "number" || !(c.blockSeconds > 0)) at("blockSeconds is not a positive number");
  const n = c.nativeCurrency;
  if (!isObject(n) || typeof n.name !== "string" || !n.name || typeof n.symbol !== "string" || !n.symbol || !Number.isInteger(n.decimals) || n.decimals < 0 || n.decimals > 36) at("nativeCurrency needs a name, a symbol and whole-number decimals");
  if (!isObject(c.rpc) || !isHttps(c.rpc.url) || !isHttps(c.rpc.source)) at("rpc needs an https url and an https source");
  const token = c.token;
  const tokenProblem = tokenFactsProblem(token, "evm");
  if (tokenProblem) at(tokenProblem);
  if (!isObject(token) || !Array.isArray(token.source) || token.source.length === 0 || !token.source.every(isHttps)) at("token needs at least one https source");
  if (!isObject(c.permit2) || !isEvmAddress(c.permit2.address) || c.permit2.use !== "refused" || !isHttps(c.permit2.source)) {
    at("permit2 needs an address, use \"refused\" and an https source");
  }
  if (!Array.isArray(c.allowanceSpenders) || !c.allowanceSpenders.every((/** @type {any} */ s) => isObject(s) && isEvmAddress(s.address) && isHttps(s.source))) {
    at("allowanceSpenders must list { address, source } entries (empty when none may hold an allowance)");
  }
  if (!isObject(c.caps) || !isAtomic(c.caps.perGrantAtomic) || !isAtomic(c.caps.perDayAtomic)) {
    at("caps need perGrantAtomic and perDayAtomic as whole numbers above 0, in the token's smallest unit");
  } else if (BigInt(c.caps.perGrantAtomic) > BigInt(c.caps.perDayAtomic)) {
    at("caps.perGrantAtomic is above caps.perDayAtomic");
  }
  if (!isObject(c.sources) || !isHttps(c.sources.chainId) || !isHttps(c.sources.explorer) || !Object.values(c.sources).every(isHttps)) {
    at("sources need https links for chainId and explorer, and every source must be an https link");
  }
  if (c.status === "approved") {
    const a = c.approval;
    if (!isObject(a) || typeof a.by !== "string" || !a.by.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(a.date)) || typeof a.evidence !== "string" || !a.evidence.trim()) {
      at("an approved chain needs approval { by, date (YYYY-MM-DD), evidence }");
    }
  }
  for (const t of testnets) {
    if (Number.isInteger(c.chainId) && t.chainId === c.chainId) at(`chainId ${c.chainId} is a testnet's: testnet facts are never reused for a mainnet`);
    if (isObject(token) && typeof token.address === "string" && sameAddress(t.tokenAddress, token.address)) at("the token address is a testnet's: testnet facts are never reused for a mainnet");
  }
  return out;
}

/**
 * Why `manifest` cannot be used, one entry per problem; [] when it can. Every chain is checked, approved or not: a
 * manifest is used whole or not at all.
 * @param {unknown} manifest
 * @param {readonly TestnetFact[]} testnets
 * @returns {string[]}
 */
export function manifestProblems(manifest, testnets = testnetFacts) {
  if (!isObject(manifest)) return ["the manifest is not an object"];
  const m = /** @type {Record<string, any>} */ (manifest);
  const out = [];
  if (m.schema !== 1) out.push("schema must be 1");
  if (!SIGNING.includes(m.signing)) out.push(`signing must be one of ${SIGNING.join(", ")}`);
  if (!isObject(m.chains)) return [...out, "chains is not an object"];
  const ids = new Set();
  for (const [key, chain] of Object.entries(m.chains)) {
    out.push(...chainProblems(key, chain, testnets));
    const id = /** @type {any} */ (chain)?.chainId;
    if (ids.has(id)) out.push(`${key}: chainId ${id} appears twice`);
    ids.add(id);
  }
  if (m.signing === "live" && testnets.length === 0) out.push("no chain table registered its testnets, so the manifest cannot be checked against them");
  return out;
}

/** The shipped manifest, frozen: nothing in this process can change it after it loads. */
const SHIPPED = /** @type {MainnetManifest} */ (deepFreeze(MAINNET_MANIFEST));

/** The manifest this build ships, frozen. */
export function shippedManifest() {
  return SHIPPED;
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
 * The manifest's state for signing: "off", "paused", "live", or "invalid" when the manifest has a problem.
 * @param {MainnetManifest} [manifest]
 * @returns {{ state: "off" | "paused" | "live" | "invalid", reason: string }}
 */
export function manifestState(manifest = SHIPPED) {
  const problems = manifestProblems(manifest);
  if (problems.length) return { state: "invalid", reason: `the mainnet manifest is not valid (${problems.join("; ")})` };
  if (manifest.signing === "off") return { state: "off", reason: "this build signs on testnets only (the mainnet manifest says signing is off)" };
  if (manifest.signing === "paused") return { state: "paused", reason: "mainnet signing is paused in the mainnet manifest" };
  return { state: "live", reason: "" };
}

/**
 * The approved chains of a manifest that is valid and not off, as chain tables add them; [] otherwise. A paused
 * manifest still lists them, so reads, status and revokes keep working on chains that were live.
 * @param {MainnetManifest} [manifest]
 * @returns {[string, MainnetChain][]}
 */
export function approvedMainnetChains(manifest = SHIPPED) {
  const { state } = manifestState(manifest);
  if (state !== "live" && state !== "paused") return [];
  return Object.entries(manifest.chains).filter(([, c]) => c.status === "approved");
}

/**
 * The caps of an approved chain, as whole numbers in the token's smallest unit, or undefined.
 * @param {string} key
 * @param {MainnetManifest} [manifest]
 * @returns {{ perGrant: bigint, perDay: bigint } | undefined}
 */
export function mainnetCaps(key, manifest = SHIPPED) {
  const found = approvedMainnetChains(manifest).find(([k]) => k === key);
  if (!found) return undefined;
  return { perGrant: BigInt(found[1].caps.perGrantAtomic), perDay: BigInt(found[1].caps.perDayAtomic) };
}

/**
 * Why nothing new may be signed, reserved or sent on the mainnet `chain` (a chain table's entry), or "" when the
 * manifest and the pause allow it. The owner's signed settings and the prerequisites are chain-gate.js's to check.
 * The chain table's chain id and token must be the manifest's own, fact for fact.
 * @param {{ rail?: unknown, key?: unknown, chainId?: unknown, token?: unknown }} chain
 * @param {MainnetManifest} [manifest]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function mainnetRefusal(chain, manifest = SHIPPED, env) {
  const { state, reason } = manifestState(manifest);
  if (state !== "live") return reason;
  const paused = mainnetPauseReason(env);
  if (paused) return `mainnet signing is paused: ${paused}`;
  const key = typeof chain?.key === "string" ? chain.key : "";
  const entry = key && Object.hasOwn(manifest.chains, key) ? manifest.chains[key] : undefined;
  if (!entry) return `the mainnet manifest does not list ${key || "this chain"}`;
  if (entry.status !== "approved") return `${key} is a candidate in the mainnet manifest, not approved`;
  if (chain.rail !== entry.rail) return `${key} is on the ${String(chain.rail)} rail here, and on ${entry.rail} in the mainnet manifest`;
  if (chain.chainId !== undefined && chain.chainId !== entry.chainId) return `${key} has chain id ${String(chain.chainId)} here, and ${entry.chainId} in the mainnet manifest`;
  const t = /** @type {Record<string, any> | undefined} */ (isObject(chain.token) ? chain.token : undefined);
  const m = entry.token;
  if (!t || typeof t.address !== "string" || !sameAddress(t.address, m.address) || t.decimals !== m.decimals || t.symbol !== m.symbol
    || t.domain?.name !== m.domain.name || t.domain?.version !== m.domain.version || t.approveReset !== m.approveReset) {
    return `${key}'s token here is not the one the mainnet manifest states`;
  }
  return "";
}
