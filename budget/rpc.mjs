// The RPC each rail reads, and the environment variables that replace it. Plain JavaScript with Node built-ins only, so the
// dispatcher (cli.mjs), doctor, buy-once and the rail scripts share it.
//
//   B4_RPC                    evm: the selected chain's RPC (buy-once: Base Sepolia's)
//   SUPERSTABLES_TEMPO_RPC    tempo: Moderato's
//   SUPERSTABLES_SOLANA_RPC   solana: devnet's
//
// A replacement must be https, or http(s) on this computer (127.0.0.1, localhost, [::1]): a plain-http RPC elsewhere could
// be read or answered by anyone on the way, and every check the commands make reads the chain through it. The dispatcher
// refuses a command when one of them is set to anything else (exit 2), and every RESULT names a replacement in use (`rpc`).

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
 */
export function rpcFromEnv(name, fallback) {
  const v = process.env[name]?.trim();
  if (!v) return { url: fallback, custom: false };
  const problem = rpcUrlProblem(v);
  if (problem) return { url: fallback, custom: false, error: `${name} is refused: ${problem} (got "${v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 120)}")` };
  return { url: v, custom: true };
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

/** One JSON-RPC call. Throws on a transport error or an RPC error answer. */
export async function jsonRpc(url, method, params = [], timeoutMs = 15_000) {
  const res = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
  return j.result;
}
