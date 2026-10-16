// The RPC each rail reads, and the environment variables that replace it. Plain JavaScript with Node built-ins only (and
// response.mjs, site.mjs and ../src/core/owner-settings.js, which have the same), so the dispatcher (cli.mjs), doctor, buy-once and the rail scripts share it.
//
//   B4_RPC                    evm: the selected chain's RPC (buy-once: Base Sepolia's)
//   SUPERSTABLES_TEMPO_RPC    tempo: Moderato's
//   SUPERSTABLES_SOLANA_RPC   solana: devnet's
//
// A replacement must be https, or http(s) on this computer (127.0.0.1, localhost, [::1]): a plain-http RPC elsewhere could
// be read or answered by anyone on the way, and every check the commands make reads the chain through it. The dispatcher
// refuses a command when one of them is set to anything else (exit 2), and every RESULT names a replacement in use (`rpc`).

import { SETTINGS_COMMAND, budgetChainKey, rpcFor } from "../src/core/owner-settings.js";
import { EVM_CHAINS } from "./evm/chains.mjs";
import { readCapped } from "./response.mjs";
import { siteText } from "./site.mjs";

/** The most read of one answer by jsonRpc and the Tempo rail: far more than a receipt, a block without its transactions or a filtered log search returns. */
export const RPC_MAX_BYTES = 4_000_000;
/** The EVM rail's viem client: viem's own default, since recovery reads whole blocks with their transactions (evm/ops.ts). */
export const EVM_RPC_MAX_BYTES = 10_485_760;
/** The Solana rail's client: a block with its accounts (solana/ops.mjs, the replacement scan) is its largest answer. */
export const SOLANA_RPC_MAX_BYTES = 16_000_000;

export const RPC_ENV = { evm: "B4_RPC", tempo: "SUPERSTABLES_TEMPO_RPC", solana: "SUPERSTABLES_SOLANA_RPC" };
export const DEFAULT_RPC = { tempo: "https://rpc.moderato.tempo.xyz", solana: "https://api.devnet.solana.com" };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why `value` cannot be an RPC URL, or null when it can: https anywhere, http only on this computer, no credentials. */
export function rpcUrlProblem(value) {
  let u;
  try {
    u = new URL(String(value ?? "").trim());
  } catch {
    return "it is not a URL";
  }
  if (u.username || u.password) return "it carries a user name or password";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return u.protocol === "http:" ? "plain http is accepted only on 127.0.0.1 or localhost; use https" : "it is not an https URL";
}

/**
 * The RPC named by environment variable `name`, else `fallback`. { url, custom } when usable; { url: fallback, custom: false,
 * error } when the variable is set to something refused (the caller decides whether to stop or warn).
 *
 * With `chainKey` (the owner settings' key for the chain, budgetChainKey) the owner's settings count too
 * (src/core/owner-settings.js rpcFor): for "read" the variable as given, else the owner's first URL for the chain, else
 * `fallback`; for "owner" and "verdict" a variable only when it names one of the owner's URLs. { url, custom, source }, where
 * custom is true for anything but the built-in `fallback`. Without `chainKey` only "read" works, as the variable alone.
 */
export function rpcFromEnv(name, fallback, purpose = "read", chainKey) {
  const v = process.env[name]?.trim();
  if (v) {
    const problem = rpcUrlProblem(v);
    if (problem) return { url: fallback, custom: false, error: `${name} is refused: ${problem} (got "${v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 120)}")` };
  }
  if (chainKey === undefined) {
    if (purpose !== "read") throw new TypeError(`rpcFromEnv: purpose "${purpose}" needs the chain key`);
    return v ? { url: v, custom: true } : { url: fallback, custom: false };
  }
  const r = rpcFor(chainKey, purpose, v, { fallback, envName: name });
  if (r.error) return { url: fallback, custom: false, error: r.error };
  return { url: r.url, custom: r.source !== "default", source: r.source };
}

/**
 * Why an RPC variable stops an owner action on this rail and chain, in words, or "" when none does: the variable is set to
 * something other than one of the owner's RPCs for the chain (or one on this computer while the owner allows that). The
 * dispatcher checks it before an owner command starts, and each rail's owner.ts before its script does anything.
 */
export function ownerRpcProblem(rail, chain) {
  const name = RPC_ENV[rail];
  if (!name) return "";
  const builtin = rail === "evm" ? EVM_CHAINS[chain]?.rpc : DEFAULT_RPC[rail];
  return rpcFor(budgetChainKey(rail, chain), "owner", process.env[name], { envName: name, fallback: builtin }).error ?? "";
}
/** What to do about it. */
export function ownerRpcNext(rail, chain) {
  return `unset ${RPC_ENV[rail]}, or ask the owner to run ${SETTINGS_COMMAND} rpc ${budgetChainKey(rail, chain)} <url> in their own terminal; nothing was asked or sent`;
}

/** The first RPC variable that is set to something refused, as { name, error }, or null. Only the rail's own when given. */
export function refusedRpcEnv(rail) {
  for (const [r, name] of Object.entries(RPC_ENV)) {
    if (rail && r !== rail) continue;
    const e = rpcFromEnv(name, "").error;
    if (e) return { name, error: e };
  }
  return null;
}

/** The replacement RPC this rail uses, for the RESULT (`rpc`), or undefined on the default one. */
export function customRpc(rail) {
  const name = RPC_ENV[rail];
  if (!name) return undefined;
  const r = rpcFromEnv(name, "");
  return r.custom ? r.url : undefined;
}

/**
 * The JSON-RPC answer in `res`, read up to `cap` bytes: { result }, or { error: { message, reverted } } when the RPC
 * answered with an error. `message` is the RPC's error text as one short line (siteText, 200 characters); `reverted`
 * says whether the full text names a revert. Throws in this client's words, never with the RPC's text: an answer longer
 * than `cap` (the error has `overCap: true`) or cut off, not JSON, or not one JSON-RPC answer object.
 */
export async function readRpcAnswer(res, cap = RPC_MAX_BYTES) {
  const { bytes, truncated } = await readCapped(res, cap);
  if (truncated) throw Object.assign(new Error(`the RPC answer was cut off or longer than ${cap} bytes`), { overCap: bytes.length >= cap });
  let j;
  try { j = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`the RPC answer is not JSON${res.ok ? "" : ` (HTTP ${res.status})`}`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("the RPC answer is not a JSON-RPC answer");
  if (!j.error) return { result: j.result };
  const raw = typeof j.error?.message === "string" ? j.error.message : JSON.stringify(j.error);
  return { error: { message: siteText(raw, 200) || "the RPC answered with an error", reverted: /revert/i.test(String(raw)) } };
}

/** One JSON-RPC call. Throws on a transport error or an RPC error answer. */
export async function jsonRpc(url, method, params = [], timeoutMs = 15_000) {
  const res = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const answer = await readRpcAnswer(res);
  if (answer.error) throw new Error(answer.error.message);
  return answer.result;
}

/** Statuses whose Response carries no body. */
const NO_BODY = new Set([204, 205, 304]);
/** Every JSON-RPC error message in a parsed answer (one object, or a batch) as one short line; true when one changed. */
function shortenRpcErrors(json) {
  let changed = false;
  for (const one of Array.isArray(json) ? json : [json]) {
    const error = one && typeof one === "object" ? one.error : undefined;
    if (!error || typeof error !== "object" || typeof error.message !== "string") continue;
    const short = siteText(error.message, 200);
    if (short !== error.message) { error.message = short; changed = true; }
  }
  return changed;
}
/**
 * A fetch for an RPC library (viem's fetchFn, @solana/web3.js's fetch). The answer is read here, up to `cap` bytes, and
 * the library gets a new Response with the same status, status text and headers:
 *   - longer than `cap` or cut off: throws "the RPC answer was cut off or longer than <cap> bytes";
 *   - a 2xx answer that is not JSON: throws "the RPC answer is not JSON" (the library would quote its text);
 *   - each JSON-RPC error message becomes one short line, since the libraries put it in their own errors;
 *   - a failed (non-2xx) answer that is not JSON, or longer than 1,000 bytes, becomes one short line of it.
 * `inner` is looked up at each call, so a test can replace the global fetch.
 */
export function cappedRpcFetch(cap, inner = (input, init) => fetch(input, init)) {
  return async (input, init) => {
    const res = await inner(input, init);
    const { bytes, truncated } = await readCapped(res, cap);
    if (truncated) throw new Error(`the RPC answer was cut off or longer than ${cap} bytes`);
    const text = bytes.toString("utf8");
    let json;
    let parsed = true;
    try { json = JSON.parse(text); } catch { parsed = false; }
    if (res.ok && !parsed) throw new Error("the RPC answer is not JSON");
    let body = bytes;
    if (parsed && shortenRpcErrors(json)) body = Buffer.from(JSON.stringify(json));
    const rewritten = !res.ok && (!parsed || body.length > 1000);
    if (rewritten) body = Buffer.from(siteText(text, 1000));
    const headers = new Headers(res.headers);
    if (rewritten) headers.set("content-type", "text/plain"); // one short line of text now, not the JSON it was cut from
    headers.delete("content-length");   // the body above is not the one that length was for
    headers.delete("content-encoding"); // fetch already decoded it
    return new Response(NO_BODY.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers });
  };
}
