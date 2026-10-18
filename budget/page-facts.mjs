// What an owner page says about the command that asks: which RPC hosts it reads, and whether the agent address it names was
// signed by the owner at setup. Plain JavaScript with the rpc helpers only, so every rail's owner script shares it.
// Hosts only, never a path or query: an RPC URL may carry an access key.

import { budgetChainKey } from "../src/core/owner-settings.js";
import { endpointSet } from "../src/core/rpc-endpoints.mjs";
import { RPC_ENV, evmEnvNameSet } from "./rpc.mjs";

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * The RPC hosts the owner command reads for `chain` on `rail` ("evm" with the chain key, "tempo" with "moderato", "solana"
 * with "devnet"), the one it asks first leading, and where they come from: "owner node", "owner settings", "environment
 * variable" (a variable the owner allows) or "built-in". undefined when the endpoints cannot be read (the owner script has
 * refused by then): a page shows no row rather than a wrong one.
 * @param {"evm"|"tempo"|"solana"} rail
 * @param {string} chain
 * @returns {{ hosts: string[], source: "owner node"|"owner settings"|"environment variable"|"built-in" } | undefined}
 */
export function rpcFacts(rail, chain) {
  const key = budgetChainKey(rail, chain);
  const envName = rail === "evm" ? (evmEnvNameSet(chain) ?? RPC_ENV.evm) : RPC_ENV[rail];
  const set = endpointSet(key, "verdict", { envUrl: process.env[envName], envName, testnet: true });
  if ("error" in set) return undefined;
  const hosts = [];
  for (const e of [set.primary, ...set.verdict]) {
    const h = host(e.url);
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  if (hosts.length === 0) return undefined;
  const source = set.primary.source === "env" ? "environment variable" : set.primary.source === "settings" ? (set.agreement === "owner-node" ? "owner node" : "owner settings") : "built-in";
  return { hosts, source };
}

let binding;
/**
 * An owner plan (grant, fund-agent, recover) records what it learned about the agent address it names, for the page it
 * opens. Only a signed or a legacy verdict is kept: a refused binding ends the command before any page exists.
 * @param {{ state: string, signedAt?: string }} verdict an `agentBinding` answer
 */
export function noteBinding(verdict) {
  binding = verdict?.state === "signed" ? { state: "signed", signedAt: verdict.signedAt } : verdict?.state === "legacy" ? { state: "legacy" } : undefined;
}
/** @returns {{ state: "signed", signedAt?: string } | { state: "legacy" } | undefined} */
export function bindingFacts() {
  return binding;
}
