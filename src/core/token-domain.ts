// Before pay asks anyone to sign an EIP-3009 authorization on an EVM chain, it checks, once per process, that the token
// contract the chain table names answers DOMAIN_SEPARATOR() with the separator computed from the table's domain (name,
// version), the chain id and that address: the domain every signer here signs over. A different answer, an RPC on
// another chain, or no contract refuses before any page or wallet request. An RPC that cannot be read refuses on a
// chain that is not a testnet; on a testnet the payment goes on and the next payment reads again. The expected value
// comes from the table, so a lying RPC can make pay refuse, never accept another domain.

import { domainSeparator } from "viem";
import type { EvmNetwork } from "./chain.js";
import type { ChainReadOptions } from "./rails/types.js";
import { chainRpc, rpcCall, type RpcOptions } from "./rpc.js";

/** DOMAIN_SEPARATOR(): the first four bytes of keccak256("DOMAIN_SEPARATOR()"). */
export const DOMAIN_SEPARATOR_CALL = "0x3644e515";
/** How long each of the two reads may take before the owner is asked anyway (testnet) or the payment is refused. */
const READ_TIMEOUT_MS = 3_000;

/** The separator the table states for this token: EIP-712 domain (name, version, chainId, verifyingContract). */
export function expectedDomainSeparator(chainId: number, token: { address: string; domain: { name: string; version: string } }): `0x${string}` {
  return domainSeparator({ domain: { name: token.domain.name, version: token.domain.version, chainId, verifyingContract: token.address as `0x${string}` } });
}

/** One endpoint's DOMAIN_SEPARATOR() answer at `blockTag`, as the RPC gave it (a string), or throws what the RPC did. */
export async function domainSeparatorAt(url: string, tokenAddress: string, blockTag: string, options: RpcOptions = {}): Promise<unknown> {
  return rpcCall<unknown>(url, "eth_call", [{ to: tokenAddress, data: DOMAIN_SEPARATOR_CALL }, blockTag], options);
}

export type BelievedDomain = { word: unknown } | { wrongChain: string } | { unreadable: string };

/**
 * What this client believes the token answers. On the payment's RPC (chainRead.rpcUrlFor, else chainRpc), eth_chainId
 * first (another chain: wrongChain, with the id it gave), then domainSeparatorAt(url, token, "latest"). This is the one
 * function that decides what the chain answers: a stronger agreement between several endpoints replaces its body.
 */
export async function believedDomainSeparator(network: EvmNetwork, chainRead: ChainReadOptions): Promise<BelievedDomain> {
  const url = rpcUrlOf(network, chainRead);
  if ("error" in url) return { unreadable: url.error };
  const options: RpcOptions = { timeoutMs: READ_TIMEOUT_MS, fetchImpl: chainRead.fetchImpl };
  try {
    const id = await rpcCall<unknown>(url.url, "eth_chainId", [], options);
    if (typeof id !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(id)) return { unreadable: "the RPC did not say which chain it is on" };
    if (BigInt(id) !== BigInt(network.chainId)) return { wrongChain: String(BigInt(id)) };
    return { word: await domainSeparatorAt(url.url, network.token.address, "latest", options) };
  } catch (err) {
    return { unreadable: err instanceof Error ? err.message : "the RPC could not be read" };
  }
}

function rpcUrlOf(network: EvmNetwork, chainRead: ChainReadOptions): { url: string } | { error: string } {
  const given = chainRead.rpcUrlFor?.(network);
  return given ? { url: given } : chainRpc(network, process.env, "read");
}

const checked = new Map<string, Promise<string>>();

/** "" when pay may ask the owner to sign on this chain, else the refusal (no trailing period). Success is cached per process. */
export async function tokenDomainProblem(network: EvmNetwork, chainRead: ChainReadOptions): Promise<string> {
  const url = rpcUrlOf(network, chainRead);
  const key = `${network.caip2}|${network.token.address.toLowerCase()}|${"url" in url ? url.url : ""}`;
  const cached = checked.get(key);
  if (cached) return cached;
  const pending = judge(network, chainRead).then(({ problem, final }) => {
    // A refusal is never kept, and nor is a pass that is only a testnet's RPC that could not be read.
    if (problem !== "" || !final) checked.delete(key);
    return problem;
  }).catch((): string => {
    checked.delete(key);
    return `the ${network.token.symbol} signing domain on ${network.label} could not be checked`;
  });
  checked.set(key, pending);
  return pending;
}

async function judge(network: EvmNetwork, chainRead: ChainReadOptions): Promise<{ problem: string; final: boolean }> {
  const { symbol, address, domain } = network.token;
  const believed = await believedDomainSeparator(network, chainRead);
  if ("wrongChain" in believed) {
    return { problem: `the ${network.label} RPC answers for chain ${believed.wrongChain}, not ${network.chainId}, so the token's signing domain could not be checked there`, final: true };
  }
  if ("unreadable" in believed) {
    if (network.testnet === true) return { problem: "", final: false };
    return { problem: `the ${symbol} signing domain on ${network.label} could not be checked: its RPC could not be read`, final: true };
  }
  const word = believed.word;
  if (typeof word !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(word)) {
    return { problem: `the ${symbol} contract ${address} on ${network.label} does not answer DOMAIN_SEPARATOR(), so an authorization signed for it would not verify`, final: true };
  }
  if (word.toLowerCase() !== expectedDomainSeparator(network.chainId, network.token).toLowerCase()) {
    return { problem: `the ${symbol} contract on ${network.label} signs under another EIP-712 domain than this client's chain table states (name "${domain.name}", version "${domain.version}"), so an authorization would not verify`, final: true };
  }
  return { problem: "", final: true };
}

/** Forget what this process checked. Tests only. */
export function forgetTokenDomains(): void {
  checked.clear();
}
