// superstables.com for `superstables budget`: which site, and the requests that need no agent signature. Plain JavaScript with
// Node built-ins only, so the dispatcher (cli.mjs), approvals.mjs and the rail scripts share it.
//
// Hosted approvals (`setup --hosted`, every rail) record APPROVALS=hosted and SITE=<origin> in the chain's public file. Every
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

/**
 * The owner's opt-in for a site outside superstables.com: the exact origin (or a comma list of origins), set by the owner in
 * their own environment. An agent never sets it. Without it, only superstables.com, its subdomains and this computer count.
 */
export const ALLOW_SITE_ENV = "SUPERSTABLES_ALLOW_SITE";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** superstables.com itself or one of its subdomains (www.superstables.com, staging.superstables.com). */
const isSuperstables = (host) => host === "superstables.com" || host.endsWith(".superstables.com");

/**
 * The site's origin, or { error }. https only, except plain http on this computer (a local site for development and tests).
 * No path, query or credentials: every route is under /api/v1/budget/ on that origin. Only superstables.com, its subdomains
 * and this computer are accepted, unless the owner named that exact origin in SUPERSTABLES_ALLOW_SITE: an agent told to use
 * another site would otherwise send the owner's approvals there.
 */
export function siteOrigin(value) {
  const raw = String(value ?? "").trim();
  const shown = siteText(raw, 120);
  let u;
  try { u = new URL(raw); } catch { return { error: `"${shown}" is not a URL (for example ${DEFAULT_SITE})` }; }
  if (u.username || u.password) return { error: "the site URL must not carry a user name or password" };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) return { error: `the site must be an https URL (plain http only on 127.0.0.1 or localhost); got "${shown}"` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { error: `the site is an origin only, such as ${DEFAULT_SITE}, with no path (got "${shown}")` };
  if (!LOOPBACK.has(u.hostname) && !isSuperstables(u.hostname) && !ownerAllowed(u.origin)) {
    return { error: `${u.origin} is not superstables.com: only https://superstables.com, its subdomains and 127.0.0.1 are used, unless the owner sets ${ALLOW_SITE_ENV}=${u.origin} in their own environment (an agent never sets it)` };
  }
  return { origin: u.origin };
}

/** The owner named this exact https origin in SUPERSTABLES_ALLOW_SITE. */
function ownerAllowed(origin) {
  const v = process.env[ALLOW_SITE_ENV]?.trim();
  if (!v) return false;
  return v.split(",").some((s) => {
    try {
      const u = new URL(s.trim());
      return u.protocol === "https:" && !u.username && !u.password && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && u.origin === origin;
    } catch {
      return false;
    }
  });
}

/**
 * The site in words: "superstables.com" for the default site, else its host (and port), so the owner always sees which site
 * a link, a refusal or a log line is about when it is not www.superstables.com.
 */
export function siteName(origin) {
  try {
    const u = new URL(origin);
    return u.origin === DEFAULT_SITE ? "superstables.com" : u.host;
  } catch {
    return siteText(origin, 80);
  }
}
/** The site is not www.superstables.com: its host is named to the owner wherever the link is. */
export const isOtherSite = (origin) => {
  try {
    return new URL(origin).origin !== DEFAULT_SITE;
  } catch {
    return true;
  }
};

/** The site for a command: --site, else SUPERSTABLES_SITE, else superstables.com. { origin } or { error }. */
export function chosenSite(flag) {
  const v = flag ?? (process.env.SUPERSTABLES_SITE?.trim() || undefined) ?? DEFAULT_SITE;
  return siteOrigin(v);
}

/**
 * Text from the site on one line, without control characters and without the invisible characters that reorder or hide
 * text (zero-width, bidi embeddings and isolates), at most `max` characters. It is data, never a command.
 */
export const siteText = (s, max = 300) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "").trim().slice(0, max);

/** The error the site gave, in one line: { error: "..." }, { error: { message } }, { message }, or the HTTP status. */
export function siteError(status, body) {
  const e = body && typeof body === "object" ? body : {};
  const msg = typeof e.error === "string" ? e.error : typeof e.error?.message === "string" ? e.error.message : typeof e.message === "string" ? e.message : typeof e.reason === "string" ? e.reason : "";
  const code = typeof e.reason_code === "string" ? e.reason_code : typeof e.code === "string" ? e.code : typeof e.error?.code === "string" ? e.error.code : "";
  // { error: { code: "agent_proof", reason: "replayed", message } }: the reason too
  const why = typeof e.error?.reason === "string" ? e.error.reason : "";
  return siteText(`HTTP ${status}${code ? ` ${code}` : ""}${why ? ` (${why})` : ""}${msg ? `: ${msg}` : ""}`);
}

/** A request id the site made: bl_ (a link) or ba_ (an approval), then letters, digits, _ or -. */
export const isSiteRequestId = (id) => typeof id === "string" && /^b[la]_[A-Za-z0-9_-]{4,128}$/.test(id);
/** An agent access token: ssbt_... */
export const isSiteToken = (t) => typeof t === "string" && /^ssbt_[A-Za-z0-9_-]{8,256}$/.test(t);

export async function call(url, init, timeoutMs, fetchImpl = fetch) {
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
  // a link with steps that is linked answers with the request as it stands, steps included: `view`
  const view = r.ok && Array.isArray(r.body?.steps) ? r.body : undefined;
  if (r.ok && (state === null || state === "cancelled")) return { cancelled: true, state: "cancelled", view };
  // refused (the wallet may have been asked, or the request already ended), or steps the wallet was already asked for
  const walletAsked = r.body?.wallet_asked === true || typeof r.body?.tx_hash === "string";
  return { cancelled: false, state, walletAsked, reason: siteError(r.status, r.body), view };
}

// ---- find: GET /api/v1/budget/services ------------------------------------------------------------------------------

const str = (v) => (typeof v === "string" || typeof v === "number" ? siteText(String(v), 200) : null);

/** The rail that pays a CAIP-2 network: Tempo Moderato is tempo, Solana is solana, any other eip155 chain evm. */
const railOf = (network) => (network === "eip155:42431" ? "tempo" : network?.startsWith("solana:") ? "solana" : network?.startsWith("eip155:") ? "evm" : null);

/**
 * Whether the listing says its output is prepared sample data: true or false as the site gives it (`simulated`, or `mock`
 * or `sample`, the names other lists use), null when it does not say.
 */
const simulatedOf = (s) => [s.simulated, s.mock, s.sample].find((v) => typeof v === "boolean") ?? null;

/**
 * One listed service in the CLI's words: name, price, chain (the client's --chain key when known), network, rail,
 * simulated (true, false, or null when the listing does not say), url.
 */
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
  return { name: str(s.name ?? s.title) ?? new URL(url).host, price: amount ? `${amount}${asset ? ` ${asset}` : ""}` : null, chain, network, rail: str(s.rail) ?? railOf(network), simulated: simulatedOf(s), url };
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
