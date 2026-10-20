// Reading a chain. Every chain read `pay` makes (a settlement, a recheck) goes through one JSON-RPC call here: one
// request, under a short deadline, never redirected, its answer read no further than a cap. The RPC is the chain's
// public one (src/core/chain.ts), the owner's own RPC for the chain when they set one (src/core/owner-settings.js), or the one
// its environment variable names when that is https, or http on this machine, without credentials:
//
//   SUPERSTABLES_RPC_URL      Base Sepolia
//   SUPERSTABLES_TEMPO_RPC    Tempo Moderato (the budget's tempo rail reads it too)
//   SUPERSTABLES_SOLANA_RPC   Solana devnet (the budget's solana rail reads it too)

import type { NetworkInfo } from "./chain.js";
import { readCapped } from "./http.js";
import { rangeRefusal, rateRefusal } from "./log-windows.mjs";
import { rpcFor } from "./owner-settings.js";
import { callerSet, endpointSet, type EndpointSet } from "./rpc-endpoints.mjs";
import { checkIdentity, type Identity } from "./rpc-quorum.mjs";

const CHECK_TIMEOUT_MS = 10_000;
/** How much of an error answer is read to find the RPC's error code: 64 KB. */
const ERROR_BODY_BYTES = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type RpcPurpose = "owner" | "verdict" | "read";

/**
 * The RPC a chain is read through, or the reason the configured one is refused. `purpose` is "read" unless the call decides an
 * owner action or a verdict (never paid, allowance 0, revoked): then an environment variable counts only when it names one of
 * the owner's RPCs (src/core/owner-settings.js rpcFor).
 */
export function chainRpc(network: Pick<NetworkInfo, "key" | "defaultRpc" | "rpcEnv">, env: NodeJS.ProcessEnv = process.env, purpose: RpcPurpose = "read"): { url: string; source: "env" | "settings" | "default" } | { error: string } {
  const name = network.rpcEnv;
  const value = name ? env[name]?.trim() : undefined;
  if (name && value) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { error: `${name} is not a URL` };
    }
    if (url.username || url.password) return { error: `${name} carries a user name or password` };
    if (!(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)))) return { error: `${name} must use HTTPS, or HTTP on this machine` };
  }
  const chosen = rpcFor(network.key, purpose, value, { fallback: network.defaultRpc, envName: name });
  if ("error" in chosen) return { error: chosen.error };
  return { url: chosen.url ?? network.defaultRpc, source: chosen.source };
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The most of an answer that is read, in bytes. */
  maxBytes?: number;
}

/**
 * An RPC that answered, but not with a result: its HTTP status, or its JSON-RPC error code (429: too many requests), and
 * how long it asked to be left alone (Retry-After, in seconds), when it said.
 */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly retryAfterMs?: number,
    /** The RPC refused the block range asked for (log-windows.mjs, rangeRefusal). Its own words are not kept. */
    readonly rangeRefused?: boolean,
    /** The RPC said it is limiting how often this client asks (a 429, or words that say so): wait rather than narrow. */
    readonly rateLimited?: boolean,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Did the RPC say it is limiting this client's requests (HTTP 429, or JSON-RPC error 429)? */
export function rateLimited(err: unknown): err is RpcError {
  return err instanceof RpcError && (err.status === 429 || err.code === 429 || err.rateLimited === true);
}

/** One JSON-RPC call. Throws on a transport error, a non-2xx answer, an RPC error or an unreadable answer. */
export async function rpcCall<T>(url: string, method: string, params: unknown[], options: RpcOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const res = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after")?.trim();
    const retryAfterMs = retryAfter && /^\d{1,4}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
    // A JSON-RPC error often rides in a 4xx answer (Base's -32614 does): read it, as far as a cap, and keep its code, never its words.
    let code: number | undefined;
    let message: unknown;
    try {
      const body = JSON.parse(await readCapped(res, ERROR_BODY_BYTES, timeoutMs, url)) as { error?: { code?: unknown; message?: unknown } };
      code = typeof body?.error?.code === "number" ? body.error.code : undefined;
      message = body?.error?.message;
    } catch {
      /* not JSON, or cut short: the status alone says what happened */
    }
    throw new RpcError(code === undefined ? `HTTP ${res.status}` : "the RPC answered with an error", res.status, code, retryAfterMs, rangeRefusal(code, message), rateRefusal(code, message) || res.status === 429);
  }
  const text = await readCapped(res, options.maxBytes ?? 2_000_000, timeoutMs, url);
  const answer = JSON.parse(text) as { result?: T; error?: { code?: unknown; message?: unknown } };
  if (answer.error !== undefined) {
    const code = typeof answer.error?.code === "number" ? answer.error.code : undefined;
    throw new RpcError("the RPC answered with an error", undefined, code, undefined, rangeRefusal(code, answer.error?.message), rateRefusal(code, answer.error?.message));
  }
  return answer.result as T;
}

// ── Which endpoint a read goes to, and that it is the right chain ────────────────────────────────────────────

/** What a read is told about where to go: tests and the SDK pin an RPC (believed alone, labelled "caller") or give a whole set. */
export interface EndpointChoice {
  /** An RPC the calling code pinned for this chain. The environment never sets this. */
  rpcUrlFor?: (network: NetworkInfo) => string | undefined;
  /** The endpoints of a chain, primary and verdict set (the SDK and tests). */
  endpointsFor?: (network: NetworkInfo) => EndpointSet | undefined;
}

/** The identity a chain's endpoints must answer: its chain id (EVM, Tempo) or its genesis hash (Solana). */
export function identityOf(network: NetworkInfo): Identity {
  return network.rail === "solana" ? { kind: "solana", genesis: network.genesisHash } : { kind: "evm", chainId: network.chainId };
}

/** One JSON-RPC call in the shape the agreement engine calls. */
export const rpcCaller = (options: RpcOptions) => (url: string, method: string, params: unknown[]) => rpcCall<unknown>(url, method, params, options);

/**
 * The endpoints whose agreement lets a payment be called never made: what the calling code gave (`endpointsFor`), else the one
 * RPC it pinned (`caller`), else the chain's table, or the owner's own RPCs, plus an environment variable only where the engine
 * allows it. The environment never yields `caller`.
 */
export function verdictSet(network: NetworkInfo, options: EndpointChoice = {}): EndpointSet {
  const given = options.endpointsFor?.(network);
  if (given) return given;
  const pinned = options.rpcUrlFor?.(network);
  if (pinned) return callerSet(pinned);
  const name = network.rpcEnv;
  return endpointSet(network.key, "verdict", { envUrl: name ? process.env[name] : undefined, envName: name, testnet: network.testnet });
}

/**
 * The RPC this chain is read through, after asking it which chain it is on (once per process): no read is made from an
 * endpoint that answers another chain. An `error` says why nothing was read; `wrongChain` marks an endpoint that answered
 * another chain, or another genesis. `state`: the endpoint for reads of state at the final block (the set's `state`), which
 * on a chain whose RPC keeps only recent state is not the primary.
 */
export async function verifiedRpc(network: NetworkInfo, options: EndpointChoice & RpcOptions & { state?: boolean } = {}): Promise<{ url: string } | { error: string; wrongChain?: true }> {
  let url: string;
  const given = options.endpointsFor?.(network);
  const pinned = options.rpcUrlFor?.(network);
  if (given) {
    if ("error" in given) return { error: `the chain was not read: ${given.error}` };
    url = ((options.state && given.state) || given.primary).url;
  } else if (pinned) {
    url = pinned;
  } else {
    const chosen = chainRpc(network);
    if ("error" in chosen) return { error: `the chain was not read: ${chosen.error}` };
    // The table's own first endpoint is the default; a table that names another one (a copy in a test) is followed.
    const set = endpointSet(network.key, "read", { envUrl: network.rpcEnv ? process.env[network.rpcEnv] : undefined, envName: network.rpcEnv, testnet: network.testnet });
    url = "error" in set ? chosen.url : ((options.state && set.state) || set.primary).url;
  }
  const words = await checkIdentity(url, identityOf(network), rpcCaller(options));
  if (words === "") return { url };
  return { error: `the chain was not read: ${words}`, ...(/ answers /.test(words) ? { wrongChain: true as const } : {}) };
}
