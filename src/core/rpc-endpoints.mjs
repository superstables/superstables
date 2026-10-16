// The public RPC endpoints of every supported chain, each with the operator that runs it, and the sets built from them.
// A chain's reads go to one primary endpoint. A verdict that lets an agent pay again ("never paid", "expired", "failed
// on chain") is believed only when the verdict set agrees (src/core/rpc-quorum.mjs): two endpoints run by different
// operators, or the owner's own node, or, on a testnet with a single public RPC, that one. Plain JS, shared by the
// core and the budget build.

import { createHash } from "node:crypto";

/** @typedef {{ url: string, operator: string }} TableEndpoint */
/** @typedef {{ url: string, operator: string, source: "builtin"|"settings"|"env"|"caller", id: string }} Endpoint */
/** @typedef {{ primary: Endpoint, verdict: Endpoint[], quorum: number,
 *    agreement: "quorum"|"owner-node"|"single"|"caller", note?: string } | { error: string }} EndpointSet */
/** @typedef {{ urls: string[], ownNode?: boolean, quorum?: number }} OwnerRpc */

/** Index 0 of each chain is its default endpoint and stays the primary for reads. */
export const RPC_ENDPOINTS = /** @type {Record<string, TableEndpoint[]>} */ ({
  "base-sepolia": [
    { url: "https://sepolia.base.org", operator: "base" },
    { url: "https://base-sepolia-rpc.publicnode.com", operator: "publicnode" },
  ],
  "arc-testnet": [{ url: "https://rpc.testnet.arc.network", operator: "circle" }],
  "arbitrum-sepolia": [
    { url: "https://sepolia-rollup.arbitrum.io/rpc", operator: "offchain-labs" },
    { url: "https://arbitrum-sepolia-rpc.publicnode.com", operator: "publicnode" },
  ],
  "polygon-amoy": [
    { url: "https://polygon-amoy-bor-rpc.publicnode.com", operator: "publicnode" },
    { url: "https://rpc-amoy.polygon.technology", operator: "polygon-labs" },
  ],
  "skale-base-sepolia": [
    { url: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha", operator: "skale" },
  ],
  "ethereum-sepolia": [
    { url: "https://ethereum-sepolia-rpc.publicnode.com", operator: "publicnode" },
    { url: "https://sepolia.drpc.org", operator: "drpc" },
  ],
  "robinhood-testnet": [{ url: "https://rpc.testnet.chain.robinhood.com", operator: "robinhood" }],
  "tempo-moderato": [{ url: "https://rpc.moderato.tempo.xyz", operator: "tempo" }],
  "solana-devnet": [{ url: "https://api.devnet.solana.com", operator: "solana-foundation" }],
});

/**
 * The chains that are testnets, listed one by one. Never derived from the table: a mainnet added to the table must not
 * become a "single" testnet by default. The tests check this list against src/core/chain.ts and budget/evm/chains.mjs.
 */
export const RPC_TESTNETS = new Set([
  "base-sepolia",
  "arc-testnet",
  "arbitrum-sepolia",
  "polygon-amoy",
  "skale-base-sepolia",
  "ethereum-sepolia",
  "robinhood-testnet",
  "tempo-moderato",
  "solana-devnet",
]);

/** 12 hex chars of sha256(url): names an endpoint in records without the URL (which may carry a key). */
export function endpointId(url) {
  return createHash("sha256").update(String(url)).digest("hex").slice(0, 12);
}

/**
 * The operator of a URL that did not come from the table: the registrable domain of its host
 * (`a.publicnode.com` and `b.publicnode.com` are one operator); an IP address or `localhost` counts as itself.
 * @param {string} url
 */
export function operatorOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return endpointId(url); // never the raw text: it may carry a key
  }
  if (host === "localhost" || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const [tld, second] = [labels[labels.length - 1], labels[labels.length - 2]];
  const keep = tld.length === 2 && ["co", "com", "org", "net", "gov", "ac"].includes(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** @type {(chainKey: string) => OwnerRpc | undefined} */
let ownerReader = () => undefined;

// TODO(rebase onto T1): delete `useOwnerSettings` and `ownerReader`. Import `readOwnerSettings`, `rpcFor` and
// `sameRpcUrl` from "./owner-settings.js" instead and read the owner's set with
//   ownerRpcSet(k) { const s = readOwnerSettings(); return Object.hasOwn(s.rpc, k) ? s.rpc[k] : undefined; }
// Tests then mock owner-settings.js, or use SUPERSTABLES_TEST_ACCOUNT_HOME for spawned scripts. T2b and T2c never call
// `useOwnerSettings`.
/**
 * The one place the owner settings reach this module. The owner-settings module installs its reader here (it returns
 * `{ urls, ownNode, quorum? }` for a chain key or undefined, and throws when the settings are unreadable).
 * @param {(chainKey: string) => OwnerRpc | undefined} reader
 */
export function useOwnerSettings(reader) {
  ownerReader = reader;
}

/** The owner's pinned endpoints for a chain, or undefined. May throw when the settings are unreadable. */
export function ownerRpcSet(chainKey) {
  const own = ownerReader(chainKey);
  return own && Array.isArray(own.urls) && own.urls.length > 0 ? own : undefined;
}

/** @returns {Endpoint} */
function endpoint(url, operator, source) {
  return { url, operator, source, id: endpointId(url) };
}

const distinct = (/** @type {Endpoint[]} */ list) => new Set(list.map((e) => e.operator)).size;

/**
 * The endpoints for a chain and purpose ("read" | "verdict" | "owner").
 *   primary  env override (read, or when it equals a member of the set or a built-in URL), else owner urls[0], else table[0]
 *   verdict  owner urls when set (ownNode with quorum 1: just urls[0], "owner-node"), else the table;
 *            an env URL joins only when it equals one of them; one that is neither a member nor a built-in URL is not used,
 *            and `note` says so. An env URL equal to a built-in table URL is allowed for every purpose: built-in URLs
 *            are already trusted.
 *   quorum   2 distinct operators (the owner's `quorum` when higher); the owner's `quorum` (default 1) when ownNode;
 *            1 ("single") only for the chain's own table, on a testnet whose table has one operator. Pinned owner URLs
 *            never take the single branch: pinning cannot lower the quorum.
 * `testnet` is required (the caller states it; it fails closed to an error, never to "single").
 * Throws nothing: a malformed settings file gives { error }.
 * TODO(rebase onto T1): judge `envUrl` with T1's `rpcFor(chainKey, purpose, envUrl, { fallback, envName })` instead of
 * string equality (trailing slash, blank values, loopback, and a refusal as { error } for "owner" and "verdict");
 * `envName` is for its words and is unused until then.
 * @param {string} chainKey
 * @param {"read"|"verdict"|"owner"} purpose
 * @param {{ envUrl?: string, envName?: string, testnet: boolean }} o
 * @returns {EndpointSet}
 */
export function endpointSet(chainKey, purpose, o) {
  const table = RPC_ENDPOINTS[chainKey];
  if (!table) return { error: `no RPC endpoints are known for ${chainKey}` };
  if (typeof o?.testnet !== "boolean") return { error: `it was not stated whether ${chainKey} is a testnet` };
  let owner;
  try {
    owner = ownerRpcSet(chainKey);
  } catch (err) {
    return { error: `the owner settings could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const testnet = o.testnet;
  const pinned = owner ? owner.urls.map((u) => endpoint(u, operatorOf(u), "settings")) : table.map((e) => endpoint(e.url, e.operator, "builtin"));
  const ownerQuorum = Number.isInteger(owner?.quorum) && /** @type {number} */ (owner?.quorum) >= 1 ? /** @type {number} */ (owner?.quorum) : undefined;
  const ownNode = owner?.ownNode === true && (ownerQuorum ?? 1) === 1;
  const verdict = ownNode ? [pinned[0]] : pinned;
  const env = typeof o.envUrl === "string" && o.envUrl.trim() !== "" ? o.envUrl.trim() : undefined;
  const envMatch = env ? verdict.find((e) => e.url === env) : undefined;
  const builtin = env ? table.find((e) => e.url === env) : undefined;
  let note;
  if (env && !envMatch && !builtin && purpose !== "read") note = "the RPC set in the environment is not one of the confirming endpoints, so it was not used to confirm";
  const primary = envMatch
    ? { ...envMatch, source: /** @type {const} */ ("env") }
    : env && (purpose === "read" || builtin)
      ? endpoint(env, builtin ? builtin.operator : operatorOf(env), "env")
      : pinned[0];
  let quorum;
  let agreement;
  if (ownNode) [quorum, agreement] = [1, "owner-node"];
  else if (!owner && testnet && distinct(verdict) < 2) [quorum, agreement] = [1, "single"];
  else [quorum, agreement] = [Math.max(owner?.ownNode === true ? 1 : 2, ownerQuorum ?? 2), "quorum"];
  return { primary, verdict, quorum, agreement: /** @type {any} */ (agreement), ...(note ? { note } : {}) };
}

/** A caller-pinned set (SDK rpcUrl, tests): one endpoint, quorum 1, "caller". */
export function callerSet(url) {
  const ep = endpoint(url, operatorOf(url), "caller");
  return { primary: ep, verdict: [ep], quorum: 1, agreement: /** @type {const} */ ("caller") };
}

/** Whether a chain could leave testnet as far as RPCs go: an owner node, or two operators. */
export function mainnetRpcReady(chainKey) {
  const set = endpointSet(chainKey, "verdict", { testnet: false });
  return !("error" in set) && (set.agreement === "owner-node" || distinct(set.verdict) >= 2);
}
