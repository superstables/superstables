// Reading a chain. Every chain read `pay` makes (a settlement, a recheck) goes through one JSON-RPC call here: one
// request, under a short deadline, never redirected, its answer read no further than a cap. The RPC is the chain's
// public one (src/core/chain.ts), or the one its environment variable names when that is https, or http on this
// machine, without credentials:
//
//   SUPERSTABLES_RPC_URL      Base Sepolia
//   SUPERSTABLES_TEMPO_RPC    Tempo Moderato (the budget's tempo rail reads it too)
//   SUPERSTABLES_SOLANA_RPC   Solana devnet (the budget's solana rail reads it too)

import type { NetworkInfo } from "./chain.js";
import { readCapped } from "./http.js";

const CHECK_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The RPC a chain is read through, or the reason the configured one is refused. */
export function chainRpc(network: Pick<NetworkInfo, "defaultRpc" | "rpcEnv">, env: NodeJS.ProcessEnv = process.env): { url: string } | { error: string } {
  const name = network.rpcEnv;
  const value = name ? env[name]?.trim() : undefined;
  if (!name || !value) return { url: network.defaultRpc };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: `${name} is not a URL` };
  }
  if (url.username || url.password) return { error: `${name} carries a user name or password` };
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return { url: value };
  return { error: `${name} must use HTTPS, or HTTP on this machine` };
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
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Did the RPC say it is limiting this client's requests (HTTP 429, or JSON-RPC error 429)? */
export function rateLimited(err: unknown): err is RpcError {
  return err instanceof RpcError && (err.status === 429 || err.code === 429);
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
    throw new RpcError(`HTTP ${res.status}`, res.status, undefined, retryAfter && /^\d{1,4}$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined);
  }
  const text = await readCapped(res, options.maxBytes ?? 2_000_000, timeoutMs, url);
  const answer = JSON.parse(text) as { result?: T; error?: { code?: unknown } };
  if (answer.error !== undefined) throw new RpcError("the RPC answered with an error", undefined, typeof answer.error?.code === "number" ? answer.error.code : undefined);
  return answer.result as T;
}
