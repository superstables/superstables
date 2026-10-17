// The public RPC endpoints of every supported chain, each with the operator that runs it, and the sets built from them.
// A chain's reads go to one primary endpoint. A verdict that lets an agent pay again ("never paid", "expired", "failed
// on chain") is believed only when the verdict set agrees (src/core/rpc-quorum.mjs): two endpoints run by different
// operators, or the owner's own node, or, on a testnet with a single public RPC, that one. Plain JS, shared by the
// core and the budget build.

import { createHash } from "node:crypto";
import { readOwnerSettings, rpcFor, sameRpcUrl } from "./owner-settings.js";

/** @typedef {{ url: string, operator: string, domains?: string[] }} TableEndpoint */
/** @typedef {{ url: string, operator: string, source: "builtin"|"settings"|"env"|"caller", id: string }} Endpoint */
/** @typedef {{ primary: Endpoint, verdict: Endpoint[], quorum: number,
 *    agreement: "quorum"|"owner-node"|"single"|"caller" } | { error: string }} EndpointSet */
/** @typedef {{ urls: string[], ownNode?: boolean, quorum?: number }} OwnerRpc */

/** Index 0 of each chain is its default endpoint and stays the primary for reads. */
export const RPC_ENDPOINTS = /** @type {Record<string, TableEndpoint[]>} */ ({
  "base-sepolia": [
    { url: "https://sepolia.base.org", operator: "base" },
    { url: "https://base-sepolia-rpc.publicnode.com", operator: "publicnode" },
  ],
  "arc-testnet": [{ url: "https://rpc.testnet.arc.io", operator: "circle", domains: ["arc.network"] }],
  "arbitrum-sepolia": [
    { url: "https://sepolia-rollup.arbitrum.io/rpc", operator: "offchain-labs" },
    { url: "https://arbitrum-sepolia-rpc.publicnode.com", operator: "publicnode" },
  ],
  "polygon-amoy": [
    { url: "https://polygon-amoy-bor-rpc.publicnode.com", operator: "publicnode" },
    { url: "https://polygon-amoy.gateway.tenderly.co", operator: "tenderly" },
  ],
  "skale-base-sepolia": [
    { url: "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha", operator: "skale" },
  ],
  "ethereum-sepolia": [
    { url: "https://ethereum-sepolia-rpc.publicnode.com", operator: "publicnode" },
    { url: "https://sepolia.gateway.tenderly.co", operator: "tenderly" },
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

/**
 * The provider of a URL on a chain, in this order: the table entry whose URL equals it exactly; the table entry that lists
 * its registrable domain (the entry's own URL domain, or one of its `domains` aliases); else its own registrable domain.
 * One provider under several domains (Arc: arc.io and arc.network) is one operator, however many URLs name it.
 * @param {string} chainKey
 * @param {string} url
 */
export function providerOf(chainKey, url) {
  const table = RPC_ENDPOINTS[chainKey] ?? [];
  const exact = table.find((e) => e.url === url);
  if (exact) return exact.operator;
  const domain = operatorOf(url);
  const entry = table.find((e) => [operatorOf(e.url), ...(e.domains ?? [])].includes(domain));
  return entry ? entry.operator : domain;
}

/** @returns {Endpoint} */
function endpoint(url, operator, source) {
  return { url, operator, source, id: endpointId(url) };
}

const distinct = (/** @type {Endpoint[]} */ list) => new Set(list.map((e) => e.operator)).size;

/**
 * The endpoints for a chain and purpose ("read" | "verdict" | "owner").
 *   primary  the environment URL when `rpcFor` accepts it, else owner urls[0], else table[0]
 *   verdict  owner urls when set (ownNode with quorum 1: just urls[0], "owner-node"), else the table;
 *            the environment URL joins only as a member it equals (source "env"), or, when the owner allows this computer's
 *            RPCs for the variable, as one more ordinary endpoint in a quorum set whose own operators already reach the
 *            quorum; never in an owner-node or single set, so it never lowers the quorum, changes the label or decides alone.
 *            It is the primary in every case.
 *   quorum   2 distinct operators (the owner's `quorum` when higher); the owner's `quorum` (default 1) when ownNode;
 *            1 ("single") only for the chain's own table, on a testnet whose table has one operator. Pinned owner URLs
 *            never take the single branch: pinning cannot lower the quorum.
 * The environment URL is judged by `rpcFor` (owner-settings.js): trimming, trailing slashes, host case, loopback and syntax
 * apply. A URL it refuses for "owner" or "verdict" gives { error } (ignoring it would send the owner's transaction through
 * another RPC than the one the agent believes is used). A URL equal to a built-in URL is allowed for every purpose.
 * `testnet` is required (the caller states it; it fails closed to an error, never to "single").
 * Throws nothing: an unreadable settings file gives { error }.
 * @param {string} chainKey
 * @param {"read"|"verdict"|"owner"} purpose
 * @param {{ envUrl?: string, envName?: string, testnet: boolean }} o
 * @returns {EndpointSet}
 */
export function endpointSet(chainKey, purpose, o) {
  const table = RPC_ENDPOINTS[chainKey];
  if (!table) return { error: `no RPC endpoints are known for ${chainKey}` };
  if (typeof o?.testnet !== "boolean") return { error: `it was not stated whether ${chainKey} is a testnet` };
  let settings;
  try {
    settings = readOwnerSettings();
  } catch (err) {
    const words = err instanceof Error ? err.message : String(err);
    return { error: /** @type {any} */ (err)?.code === "OWNER_SETTINGS_UNREADABLE" ? words : `the owner settings could not be read: ${words}` };
  }
  const owner = settings && Object.hasOwn(settings.rpc, chainKey) ? settings.rpc[chainKey] : undefined;
  const testnet = o.testnet;
  const pinned = owner ? owner.urls.map((u) => endpoint(u, providerOf(chainKey, u), "settings")) : table.map((e) => endpoint(e.url, e.operator, "builtin"));
  const ownerQuorum = Number.isInteger(owner?.quorum) && /** @type {number} */ (owner?.quorum) >= 1 ? /** @type {number} */ (owner?.quorum) : undefined;
  const ownNode = owner?.ownNode === true && (ownerQuorum ?? 1) === 1;
  const verdict = ownNode ? [pinned[0]] : pinned;
  let quorum;
  let agreement;
  if (ownNode) [quorum, agreement] = [1, "owner-node"];
  else if (!owner && testnet && distinct(verdict) < 2) [quorum, agreement] = [1, "single"];
  else [quorum, agreement] = [Math.max(owner?.ownNode === true ? 1 : 2, ownerQuorum ?? 2), "quorum"];
  let primary = pinned[0];
  const members = [...verdict];
  const env = typeof o.envUrl === "string" && o.envUrl.trim() !== "" ? o.envUrl.trim() : undefined;
  if (env) {
    const chosen = rpcFor(chainKey, purpose, env, { fallback: table[0].url, builtin: table.map((e) => e.url), envName: o.envName, settings });
    if ("error" in chosen) return { error: chosen.error };
    const member = members.find((e) => sameRpcUrl(e.url, env));
    const builtin = table.find((e) => sameRpcUrl(e.url, env));
    const ownerUrl = owner?.urls.find((u) => sameRpcUrl(u, env));
    if (member) primary = { ...member, source: "env" };
    else if (builtin) primary = endpoint(builtin.url, builtin.operator, "env");
    else if (ownerUrl) primary = endpoint(ownerUrl, providerOf(chainKey, ownerUrl), "env");
    else {
      primary = endpoint(env, providerOf(chainKey, env), "env");
      // a loopback variable is one more endpoint only where it cannot stand in for the decider (distinct is counted before the push)
      if (chosen.allowedBy === "loopback" && purpose !== "read" && agreement === "quorum" && distinct(members) >= quorum) members.push(primary);
    }
  }
  return { primary, verdict: members, quorum, agreement: /** @type {any} */ (agreement) };
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
