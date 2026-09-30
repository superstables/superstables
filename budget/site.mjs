// superstables.com for `superstables budget`: which site, and the requests that need no agent signature. Plain JavaScript with
// Node built-ins only, so the dispatcher (cli.mjs), approvals.mjs and the rail scripts share it.
//
// Hosted approvals (`setup --hosted`, EVM only) record APPROVALS=hosted and SITE=<origin> in the chain's public file. Every
// later owner command on that chain then asks the owner through the site instead of the page on 127.0.0.1. The site API is
// under /api/v1/budget/ (hosted.ts creates requests, signed by the agent key):
//
//   GET  /api/v1/budget/requests/{id}?wait=0..20     Authorization: Bearer ssbt_...   the request's state
//   POST /api/v1/budget/requests/{id}/cancel          Authorization: Bearer ssbt_...   only while the wallet was not asked
//   GET  /api/v1/budget/services                      no auth                          services a budget can pay (find)
//
// The bearer token is the agent's access to one request. It is kept only in that approval's record (approvals.mjs, mode
// 600) and in memory; nothing here logs it.

export const DEFAULT_SITE = "https://www.superstables.com";
export const BUDGET_API = "/api/v1/budget";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The site's origin, or { error }. https only, except plain http on this computer (a local site for development and tests).
 * No path, query or credentials: every route is under /api/v1/budget/ on that origin.
 */
export function siteOrigin(value) {
  const raw = String(value ?? "").trim();
  let u;
  try { u = new URL(raw); } catch { return { error: `"${raw}" is not a URL (for example ${DEFAULT_SITE})` }; }
  if (u.username || u.password) return { error: "the site URL must not carry a user name or password" };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return { error: `the site must be an https URL (plain http only on 127.0.0.1 or localhost); got "${raw}"` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { error: `the site is an origin only, such as ${DEFAULT_SITE}, with no path (got "${raw}")` };
  return { origin: u.origin };
}

/** The site for a command: --site, else SUPERSTABLES_SITE, else superstables.com. { origin } or { error }. */
export function chosenSite(flag) {
  const v = flag ?? (process.env.SUPERSTABLES_SITE?.trim() || undefined) ?? DEFAULT_SITE;
  return siteOrigin(v);
}

/** Text from the site on one line, without control characters, at most `max` characters. It is data, never a command. */
export const siteText = (s, max = 300) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max);

/** The error the site gave, in one line: { error: "..." }, { error: { message } }, { message }, or the HTTP status. */
export function siteError(status, body) {
  const e = body && typeof body === "object" ? body : {};
  const msg = typeof e.error === "string" ? e.error : typeof e.error?.message === "string" ? e.error.message : typeof e.message === "string" ? e.message : typeof e.reason === "string" ? e.reason : "";
  const code = typeof e.reason_code === "string" ? e.reason_code : typeof e.code === "string" ? e.code : typeof e.error?.code === "string" ? e.error.code : "";
  return siteText(`HTTP ${status}${code ? ` ${code}` : ""}${msg ? `: ${msg}` : ""}`);
}

/** A request id the site made: bl_ (a link) or ba_ (an approval), then letters, digits, _ or -. */
export const isSiteRequestId = (id) => typeof id === "string" && /^b[la]_[A-Za-z0-9_-]{4,128}$/.test(id);
/** An agent access token: ssbt_... */
export const isSiteToken = (t) => typeof t === "string" && /^ssbt_[A-Za-z0-9_-]{8,256}$/.test(t);

async function call(url, init, timeoutMs, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, status: 0, body: null, network: siteText(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err) };
  }
  let body = null;
  try { body = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, body };
}

/**
 * One read of a request: GET /api/v1/budget/requests/{id}?wait=N. { ok: true, view } or { ok: false, status, reason }.
 * status 0: the site did not answer. The view is the site's JSON: id, kind, state, final, owner, tx_hash, reason, next_action.
 */
/** @param {{ site: string, id: string, token: string, wait?: number, fetchImpl?: typeof fetch }} args */
export async function readSiteRequest({ site, id, token, wait = 0, fetchImpl }) {
  if (!isSiteRequestId(id)) return { ok: false, status: 0, reason: "not a request id" };
  const w = Math.max(0, Math.min(20, Math.floor(wait)));
  const r = await call(`${site}${BUDGET_API}/requests/${id}?wait=${w}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, (w + 15) * 1000, fetchImpl);
  if (r.ok && r.body && typeof r.body === "object" && typeof r.body.state === "string") return { ok: true, view: r.body };
  return { ok: false, status: r.status, reason: r.network ? `${site} did not answer (${r.network})` : r.ok ? "the site's answer has no state" : siteError(r.status, r.body) };
}

/**
 * POST /api/v1/budget/requests/{id}/cancel. The site cancels only while the owner's wallet has not been asked.
 * { cancelled: true } when it did, { cancelled: false, walletAsked, state, reason } when it refused, null when it did not answer.
 */
/** @param {{ site: string, id: string, token: string, fetchImpl?: typeof fetch }} args */
export async function cancelSiteRequest({ site, id, token, fetchImpl }) {
  if (!isSiteRequestId(id)) return null;
  const r = await call(`${site}${BUDGET_API}/requests/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: "{}" }, 15_000, fetchImpl);
  if (r.status === 0) return null;
  const state = typeof r.body?.state === "string" ? r.body.state : null;
  if (r.ok && (state === null || state === "cancelled")) return { cancelled: true, state: "cancelled" };
  // refused: the wallet may have been asked, or the request already ended
  const walletAsked = r.body?.wallet_asked === true || typeof r.body?.tx_hash === "string";
  return { cancelled: false, state, walletAsked, reason: siteError(r.status, r.body) };
}

// ---- find: GET /api/v1/budget/services ------------------------------------------------------------------------------

const str = (v) => (typeof v === "string" || typeof v === "number" ? siteText(String(v), 200) : null);

/** One listed service in the CLI's words: name, price, chain (the client's --chain key when known), network, rail, url. */
function serviceOf(s, chainByNetwork) {
  if (!s || typeof s !== "object") return null;
  let url = null;
  try {
    const u = new URL(String(s.url ?? s.resource ?? s.endpoint ?? ""));
    if (u.protocol === "https:" || u.protocol === "http:") url = u.href;
  } catch {}
  if (!url) return null;
  const p = s.price;
  const amount = p && typeof p === "object" ? str(p.amount ?? p.value) : str(p ?? s.amount);
  const asset = p && typeof p === "object" ? str(p.asset ?? p.currency ?? p.symbol) : str(s.asset ?? s.currency) ?? "USDC";
  const network = str(s.network ?? s.chain_id ?? s.chainId);
  const chain = str(s.chain) ?? (network ? chainByNetwork[network] ?? null : null);
  return { name: str(s.name ?? s.title) ?? new URL(url).host, price: amount ? `${amount}${asset ? ` ${asset}` : ""}` : null, chain, network, rail: str(s.rail) ?? (network?.startsWith("eip155:") ? "evm" : null), url };
}

/**
 * The services the site lists for budgets. { ok: true, services } or { ok: false, absent, reason }: `absent` when the
 * site has no such list (404), so the caller can say that any seller URL still works.
 */
/** @param {{ site: string, chainByNetwork?: Record<string, string>, fetchImpl?: typeof fetch }} args */
export async function listSiteServices({ site, chainByNetwork = {}, fetchImpl }) {
  const r = await call(`${site}${BUDGET_API}/services`, { headers: { accept: "application/json" } }, 15_000, fetchImpl);
  if (r.status === 404 || r.status === 405 || r.status === 501) return { ok: false, absent: true, reason: `${site} has no budget service list yet (${siteError(r.status, r.body)})` };
  if (!r.ok) return { ok: false, absent: false, reason: r.network ? `${site} did not answer (${r.network})` : siteError(r.status, r.body) };
  const list = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.services) ? r.body.services : Array.isArray(r.body?.data) ? r.body.data : null;
  if (!list) return { ok: false, absent: false, reason: `${site} answered without a list of services` };
  return { ok: true, services: list.slice(0, 500).map((s) => serviceOf(s, chainByNetwork)).filter(Boolean) };
}
