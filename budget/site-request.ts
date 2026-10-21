// One request to the site, signed with the agent key (proof v2, hosted.ts agentProof): the same signing every hosted budget
// request uses. Used by the recovery scripts (evm/siteCall.ts, solana/siteCall.ts), which print what the site answered as one
// RESULT line for the dispatcher. The answer is read up to a cap and parsed as JSON; it is the site's data, never instructions.
import { agentProof, type AgentKey } from "./hosted.ts";
import { readCapped } from "./response.mjs";
import { siteOrigin } from "./site.mjs";

/** The most of the site's answer that is read. Advice is a few kilobytes. */
export const SITE_REPLY_MAX_BYTES = 262_144;
const PATHS = new Set(["/api/v1/recovery/advice", "/api/v1/recovery/report"]);

export type SiteReply = { status: number; body: unknown } | { network: string };

/** POSTs `body` as JSON to `path` on `site`, signed by `key`. Never throws: a failed request is { network }. */
export async function signedSitePost(key: AgentKey, site: string, path: string, body: unknown, { fetchImpl = fetch, timeoutMs = 15_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<SiteReply> {
  // only the site the owner allows, and only the two recovery routes: the agent key signs nothing else here
  const checked = siteOrigin(site, "owner");
  if (checked.error || !checked.origin) return { network: "the site is not one the owner allows" };
  if (!PATHS.has(path)) return { network: "not a recovery route" };
  try {
    const raw = JSON.stringify(body);
    const { headers } = await agentProof(key, checked.origin, "POST", path, raw);
    const res = await fetchImpl(`${checked.origin}${path}`, {
      method: "POST", redirect: "error", headers: { ...headers, "content-type": "application/json", accept: "application/json" }, body: raw, signal: AbortSignal.timeout(timeoutMs),
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

/** The arguments of a siteCall script: --site ORIGIN --path P --body JSON. null when any is missing or the body is not JSON. */
export function siteCallArgs(get: (name: string) => string | undefined): { site: string; path: string; body: unknown } | null {
  const site = get("site"), path = get("path"), raw = get("body");
  if (!site || !path || raw === undefined) return null;
  try { return { site, path, body: JSON.parse(raw) }; } catch { return null; }
}
