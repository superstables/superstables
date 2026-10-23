// One request to the site, signed with the agent key (proof v2, hosted.ts agentProof): the same signing every hosted budget
// request uses. Used by the recovery scripts (evm/siteCall.ts, solana/siteCall.ts), which print what the site answered as one
// RESULT line for the dispatcher. The answer is read up to a cap and parsed as JSON; it is the site's data, never instructions.
import { agentProof, type AgentKey } from "./hosted.ts";
import { readCapped } from "./response.mjs";
import { siteOrigin } from "./site.mjs";

/** The most of the site's answer that is read. Advice is a few kilobytes. */
export const SITE_REPLY_MAX_BYTES = 262_144;
/** The only requests the agent key signs here: the two recovery routes, and the account-scoped services read that lists the features. */
const ROUTES = new Set(["POST /api/v1/recovery/advice", "POST /api/v1/recovery/report", "GET /api/v1/budget/services"]);

export type SiteReply = { status: number; body: unknown } | { network: string };

/** POSTs `body` as JSON to `path` on `site`, signed by `key`. Never throws: a failed request is { network }. */
export async function signedSitePost(key: AgentKey, site: string, path: string, body: unknown, method: "GET" | "POST" = "POST", { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<SiteReply> {
  // only the site the owner allows, and only the two recovery routes: the agent key signs nothing else here
  const checked = siteOrigin(site, "owner");
  if (checked.error || !checked.origin) return { network: "the site is not one the owner allows" };
  if (!ROUTES.has(`${method} ${path}`)) return { network: "not a recovery route" };
  try {
    // a GET has an empty body, whose SHA-256 the proof binds; every request gets a fresh nonce from agentProof
    const raw = method === "GET" ? "" : JSON.stringify(body);
    const { headers } = await agentProof(key, checked.origin, method, path, raw);
    const res = await fetchImpl(`${checked.origin}${path}`, {
      method, redirect: "error", headers: { ...headers, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, ...(method === "POST" ? { body: raw } : {}), signal: AbortSignal.timeout(timeoutMs),
    });
    const { bytes, truncated } = await readCapped(res, SITE_REPLY_MAX_BYTES);
    if (truncated) return { status: res.status, body: null };
    let parsed: unknown = null;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { /* not JSON: no body */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { network: String((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message ?? "no answer").replace(/[^\x20-\x7e]+/g, " ").slice(0, 120) };
  }
}

/** The arguments of a siteCall script: --site ORIGIN --path P [--method GET|POST] [--body JSON]. null when any is missing, or a POST body is not JSON. */
export function siteCallArgs(get: (name: string) => string | undefined): { site: string; path: string; method: "GET" | "POST"; body: unknown } | null {
  const site = get("site"), path = get("path"), raw = get("body"), method = get("method") ?? "POST";
  if (!site || !path || (method !== "GET" && method !== "POST")) return null;
  if (method === "GET") return { site, path, method, body: undefined };
  if (raw === undefined) return null;
  try { return { site, path, method, body: JSON.parse(raw) }; } catch { return null; }
}
