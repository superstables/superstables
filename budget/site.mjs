// superstables.com for `superstables budget`: which site, and the requests that need no agent signature. Plain JavaScript with
// Node built-ins only (and response.mjs and ../src/core/owner-settings.js, which have the same), so the dispatcher (cli.mjs), approvals.mjs and the rail scripts share it.
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

import { DEFAULT_SITE, siteFor } from "../src/core/owner-settings.js";
import { readCapped } from "./response.mjs";

export { DEFAULT_SITE };
export const BUDGET_API = "/api/v1/budget";

/**
 * No longer read. SUPERSTABLES_ALLOW_SITE used to let the owner name another approval site in their environment, which an
 * agent shares; the owner now sets one with `superstables owner settings site ORIGIN`. Named here so the dispatcher can warn.
 */
export const ALLOW_SITE_ENV = "SUPERSTABLES_ALLOW_SITE";

/**
 * The site's origin, or { error, ownerCommand? }. https only, except plain http on this computer. No path, query or
 * credentials: every route is under /api/v1/budget/ on that origin. Which origins count is the owner's setting
 * (src/core/owner-settings.js siteFor): for an owner action ("owner", the default) or a verdict ("verdict") only
 * https://www.superstables.com (the apex is the same site) and what the owner allowed in their settings; for a read
 * ("read") also any other https superstables.com host and this computer. An agent told to use another site would otherwise
 * send the owner's approvals there.
 * @param {unknown} value
 * @param {"owner" | "verdict" | "read"} [purpose]
 * @returns {{ origin?: string, error?: string, ownerCommand?: string }}
 */
export function siteOrigin(value, purpose = "owner") {
  const raw = String(value ?? "").trim();
  if (raw === "") return { error: `"" is not a URL (for example ${DEFAULT_SITE})` };
  const site = siteFor(purpose, raw);
  return site.error ? { error: siteText(site.error, 400), ...(site.ownerCommand ? { ownerCommand: site.ownerCommand } : {}) } : { origin: site.origin };
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

/**
 * The site for a command: --site, else SUPERSTABLES_SITE, else the owner's own site (their setting, else
 * superstables.com). { origin } or { error, ownerCommand? }. Either source is a candidate only: it has to be a site the owner
 * allows for `purpose`, and the error names where it came from.
 * @param {string | undefined} flag
 * @param {"owner" | "verdict" | "read"} [purpose]
 * @returns {{ origin?: string, error?: string, ownerCommand?: string }}
 */
export function chosenSite(flag, purpose = "owner") {
  const fromEnv = process.env.SUPERSTABLES_SITE?.trim() || undefined;
  const source = flag !== undefined ? "--site" : fromEnv !== undefined ? "SUPERSTABLES_SITE" : null;
  const candidate = flag ?? fromEnv;
  if (candidate === undefined) {
    const own = siteFor(purpose, undefined);
    return own.error ? { error: siteText(own.error, 400) } : { origin: own.origin };
  }
  const site = siteOrigin(candidate, purpose);
  return site.error ? { ...site, error: `${source}: ${site.error}` } : site;
}

/**
 * Text from the site on one line, at most `max` characters: control characters become spaces; format, bidi and Unicode tag
 * characters are removed. The same rule as untrustedText (src/core/text.ts). It is data, never a command.
 */
export const siteText = (s, max = 300) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064]/gu, "").trim().slice(0, max);

/**
 * The words the site's budget API documents, by kind. The site's own sentences (an error message, a reason) are never
 * repeated in a log, an audit line or a RESULT: only one of these words, or "unexpected", inside this client's sentences.
 * Taken from the website's budget API on its staging at ddb493a8 (lib/budget: errors thrown with
 * budgetError, flow.ts REASONS, proof.ts ProofReason; app/api/v1/budget and app/api/budget routes), October 2026.
 */
export const SITE_WORDS = {
  state: new Set(["awaiting_owner", "sending", "linked", "sent", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown", "queued", "skipped"]),
  code: new Set([
    // errors (budgetError codes)
    "agent_mismatch", "agent_not_linked", "agent_proof", "agent_proof_invalid", "agent_proof_missing", "agent_proof_stale", "allowance_live",
    "already_linked", "amount_above_limit", "amount_zero", "blockhash_expired", "body_too_large", "cap_above_limit", "cap_zero", "chain_unavailable",
    "duplicate_request", "ethereum_account_required", "expected_owner_mismatch", "expected_owner_unproven", "expiry_passed", "idempotency_conflict",
    "idempotency_key_expired", "idempotency_key_reused", "internal_error", "invalid_expected_owner", "invalid_idempotency_key", "invalid_json", "invalid_kind",
    "invalid_label", "invalid_request", "invalid_solana", "invalid_solana_owner", "invalid_step", "invalid_then", "invalid_transaction", "invalid_tx_hash",
    "key_live", "linked_elsewhere", "match_code_mismatch", "missing_token", "network_refused", "no_token_account", "not_a_link", "not_a_transaction",
    "not_awaiting_owner", "not_for_solana", "not_found", "not_linked_yet", "not_open", "not_sending", "not_solana", "nothing_to_revoke", "other_account",
    "other_delegate", "owner_frozen", "owner_proof_invalid", "owner_proof_owner_mismatch", "owner_proof_required", "owner_unknown", "owner_wallet_removed",
    "owner_wallet_required", "proof_reused", "rate_limited", "request_open", "sign_in_required", "solana_owner_unproven", "tx_hash_used",
    "unknown_chain", "unknown_parameter", "unlimited_refused", "unsupported_chain", "unsupported_media_type", "unsupported_rail",
    "value_not_zero", "wallet_asked", "wrong_account", "wrong_amount", "wrong_call", "wrong_recipient", "wrong_signer", "wrong_spender", "wrong_target",
    "wallet_changed_transaction", "invalid_owner_proof_version", "token_expired",
    // reasons a request or step ended (flow.ts REASONS)
    "agent_cancelled", "agent_removed", "another_open", "approval_expired", "earlier_step", "link_not_done", "mismatch", "no_start_block",
    "not_landed", "not_requested", "not_signed", "owner_rejected", "owner_stopped", "page_stopped_before_send", "reverted", "stale_tx", "wallet_timeout",
  ]),
  // agent request proof: error.reason of an agent_proof refusal (proof.ts ProofReason)
  proof: new Set(["missing", "malformed", "stale", "nonce", "replayed", "signature", "agent_mismatch"]),
};
/** A value the site sent, as one of the words its API documents for `kind`, or "unexpected". */
export const siteWord = (kind, v) => (typeof v === "string" && SITE_WORDS[kind].has(v) ? v : "unexpected");
const ACCOUNT_REFUSALS = new Map([
  ["ethereum_account_required", "ask the owner to approve from an account that holds an Ethereum wallet (an account admin adds one on the account page), then retry"],
  ["owner_proof_owner_mismatch", "ask the owner to sign the owner-proof message with a wallet their account holds for this chain, then retry"],
  ["owner_wallet_required", "ask an account admin to add this budget's Solana owner wallet to the account on its account page, then request the budget again"],
  ["wrong_account", "ask the owner to pay from a Solana wallet their account holds (an account admin adds one on the account page), then retry"],
]);
/** Recovery for an account refusal, or null for other errors. */
export const accountRefusalNext = (code) => ACCOUNT_REFUSALS.get(code) ?? null;
/** What an open request's reason code says while it still waits for the owner: the site refused an account, not the request. */
const ACCOUNT_WAITING = new Map([
  ["ethereum_account_required", "the owner tried to approve from an account that holds no Ethereum wallet, and this chain needs one; the request is still open"],
]);
/** The words for an open request the site refused an account on, with the recovery step, or null. */
export const accountWaitingWords = (code) => (ACCOUNT_WAITING.has(code) ? `${ACCOUNT_WAITING.get(code)}: ${ACCOUNT_REFUSALS.get(code)}` : null);
/** Anything shaped like an access token (ssbt_, ssba_, sspt_, sspa_) taken out of a text this client prints or stores. */
export const scrub = (text) => String(text ?? "").replace(/ss[bp][ta]_[A-Za-z0-9_-]*/g, "[token]");
/**
 * Text the dispatcher prints, without control characters: newline and tab stay (the dispatcher's own layout), every other C0
 * and C1 character goes, and the Unicode line and paragraph separators become spaces. The characters that hide or reorder
 * text go too, as in siteText: format characters (zero-width, bidi marks and overrides, the soft hyphen, U+2060-2064) and the
 * tag block U+E0000-E007F. A rail's log can quote an RPC's or a library's error text (viem and @solana/web3.js put the RPC's
 * words, revert reasons and program logs in their errors), which must not move the cursor, retitle the terminal, erase what
 * was printed or reorder it. A newline inside such text is flattened where the rail prints the error (oneLine), not here:
 * the dispatcher's own output has lines.
 */
export const terminalText = (text) => String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").replace(/[\u2028\u2029]/g, " ").replace(/[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064]/gu, "");
/**
 * The agent's access tokens (ssbt_, sspt_) taken out of a line the dispatcher prints, after terminalText. An owner's
 * approval link carries its own token (ssba_, sspa_) after # on purpose, so those stay.
 */
export const scrubAgentTokens = (text) => terminalText(text).replace(/ss[bp]t_[A-Za-z0-9_-]*/g, "[token]");

/** The longest run of token characters held back between two chunks; a longer run is a token and is dropped whole. */
const TOKEN_HOLD_MAX = 512;
/**
 * scrubAgentTokens over a stream cut at any point (a pipe's chunks): push() returns what is safe to write now and holds
 * back a tail that could be the start of a token (an "s", "ss", "ssb", "sspt", ... or a token not yet ended), to be read
 * with the next chunk; end() returns the rest. A token split between chunks is still taken out whole.
 */
export function agentTokenScrubber() {
  let held = "";
  let inToken = false;
  return {
    push(text) {
      let s = terminalText(text);
      if (inToken) {
        // the rest of a token already replaced by [token]
        const m = /^[A-Za-z0-9_-]*/.exec(s);
        s = s.slice(m[0].length);
        if (!s) return "";
        inToken = false;
      }
      let buf = held + s;
      held = "";
      const open = /ss[bp]t_[A-Za-z0-9_-]*$/.exec(buf);
      const start = open ? open.index : ["sspt", "ssbt", "ssp", "ssb", "ss", "s"].reduce((at, p) => (at < 0 && buf.endsWith(p) ? buf.length - p.length : at), -1);
      if (start >= 0) {
        held = buf.slice(start);
        buf = buf.slice(0, start);
        if (held.length > TOKEN_HOLD_MAX) {
          held = "";
          inToken = true;
          return scrubAgentTokens(buf) + "[token]";
        }
      }
      return scrubAgentTokens(buf);
    },
    end() {
      const out = scrubAgentTokens(held);
      held = "";
      inToken = false;
      return out;
    },
  };
}

/** A failed answer in this client's words: the HTTP status, and the error code and proof reason when documented. */
export function siteFailure(status, body) {
  if (!status) return "no answer";
  const b = body && typeof body === "object" ? body : {};
  const code = [b.error?.code, b.code, b.reason_code].find((c) => typeof c === "string");
  const why = typeof b.error?.reason === "string" ? b.error.reason : undefined;
  return `HTTP ${Number(status) | 0}${code === undefined ? "" : ` ${siteWord("code", code)}`}${why === undefined ? "" : ` (${siteWord("proof", why)})`}`;
}

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
/**
 * The words for a transaction the site reported as failed (a step in state `failed`, with a hash). The command adds them
 * to the problems it finds on chain, so the step is never settled, whatever the chain shows.
 */
export function siteFailedWords(site, reasonCode) {
  const code = typeof reasonCode === "string" && reasonCode ? siteWord("code", reasonCode) : "";
  return `${site} reported this step as failed${code ? ` (reason: ${code})` : ""}, so it is not counted as done`;
}

/**
 * Why a transaction was not accepted as the planned step, for a RESULT reason. `problems` are the reader's problems, the
 * site's verdict (`siteFailed`) among them when there is one. The verdict alone never claims the chain shows something
 * else: it is said in its own words, with the transaction.
 */
/**
 * Whether the transaction on chain differs from the request itself (another sender, call, amount, block), beyond the site
 * reporting it failed. Only a transaction that matches the request proves anything about it, a revert included.
 */
export const differsFromRequest = (problems, siteFailed) => problems.some((p) => p !== siteFailed);

export function mismatchReason(problems, siteFailed, hash) {
  const chain = problems.filter((p) => p !== siteFailed);
  if (!chain.length && siteFailed) return `${siteFailed} (transaction ${hash})`;
  return `the transaction was not accepted as the planned step: ${problems.join("; ")}`;
}

/**
 * The same for the owner's page, a sentence: "The transaction was not accepted as the planned step: ...". `ended`: how the
 * chain shows it ended, when that is not success ("reverted on chain"), said first.
 */
export function mismatchPage(problems, siteFailed, hash, { what = "transaction", ended } = {}) {
  const chain = problems.filter((p) => p !== siteFailed);
  if (!chain.length && siteFailed) return `${siteFailed} (transaction ${hash}).`;
  if (ended) return `The ${what} ${ended}, but it is not the one this page asked for: ${problems.join("; ")}.`;
  return what === "transfer" ? `The transfer was not confirmed as the planned step: ${problems.join("; ")}.` : `The transaction was not accepted as the planned step: ${problems.join("; ")}.`;
}

export const isSiteRequestId = (id) => typeof id === "string" && /^b[la]_[A-Za-z0-9_-]{4,128}$/.test(id);
/** An agent access token: ssbt_... */
export const isSiteToken = (t) => typeof t === "string" && /^ssbt_[A-Za-z0-9_-]{8,256}$/.test(t);
/** A link with control characters, spaces or invisible characters in it is never shown or recorded. */
export const UNSAFE_URL = /[\u0000-\u0020\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** The part of an approval link after #: the site's code for the owner's page. */
export const LINK_FRAGMENT = /^#[A-Za-z0-9_-]{8,256}$/;
/** A match code as the site gives it, for the owner to pick on the page. */
export const MATCH_CODE = /^[A-Z0-9]{2,8}(-[A-Z0-9]{2,8}){0,3}$/;

/**
 * Why the request id, approval link and match code submit_budget_request returned cannot be the site's own for a request of
 * `kind` on `site`, or "": an id of that kind, the link `site`/approve/budget/<id>#<code>, a match code as the site gives it.
 */
export function siteRequestProblem(site, kind, { requestId, link, matchCode }) {
  const prefix = kind === "link" ? "bl_" : "ba_";
  if (!isSiteRequestId(requestId) || !requestId.startsWith(prefix)) return `the id of a ${kind === "link" ? "request to add an agent" : "wallet approval"} starts with ${prefix}`;
  let url = null;
  try {
    url = typeof link === "string" && !UNSAFE_URL.test(link) ? new URL(link) : null;
  } catch {}
  if (!url || url.origin !== site || url.pathname !== `/approve/budget/${requestId}` || url.search || !LINK_FRAGMENT.test(url.hash)) return `the link is not ${site}/approve/budget/${requestId} with the site's code after #`;
  if (typeof matchCode !== "string" || !MATCH_CODE.test(matchCode)) return "the match code is not one the site gives";
  return "";
}

export const SITE_MAX_BYTES = 1_000_000;

/**
 * One request to the site: { ok, status, body }, and `unread: true` (body null) when there was no answer or it was not read whole
 * and parsed as JSON: cut off, longer than the cap, empty, not JSON, a timeout or a reset. What an unread answer said is unknown.
 */
export async function call(url, init, timeoutMs, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, status: 0, body: null, unread: true, network: siteText(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err) };
  }
  const { bytes, truncated } = await readCapped(res, SITE_MAX_BYTES);
  // an answer cut off or longer than the cap is no answer to act on: never parsed, never ok
  if (truncated) return { ok: false, status: res.status, body: null, unread: true, network: `the answer from ${siteText(new URL(url).host, 80)} was cut off or longer than ${SITE_MAX_BYTES} bytes` };
  try {
    return { ok: res.ok, status: res.status, body: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { ok: res.ok, status: res.status, body: null, unread: true };
  }
}

/**
 * One read of a request: GET /api/v1/budget/requests/{id}?wait=N. { ok: true, view } or { ok: false, status, reason }.
 * status 0: the site did not answer. `asked`: the failed answer itself shows the wallet was asked; `body`: that answer, for
 * walletEvidence; `unread`: there was none to read whole (call). The view is the site's JSON: id, kind, state, final, owner, tx_hash, reason, next_action.
 */
/**
 * `own`: the answer must be about this request, and is checked here, once. A view is ok only when its `id` is this request's;
 * an answer (ok or an error) that names another request, in its own `id` or in `error.id`, is `{ ok: false, foreign: true }`:
 * nothing in it is an answer about this request but its wallet evidence (`asked`, and `body` for walletEvidence: kept). A documented
 * error that names no id is accepted as the site's answer. Without `own` (a first worker, buy-once) the reader is as it was.
 * @param {{ site: string, id: string, token: string, wait?: number, own?: boolean, fetchImpl?: typeof fetch }} args
 */
export async function readSiteRequest({ site, id, token, wait = 0, own = false, fetchImpl }) {
  if (!isSiteRequestId(id)) return { ok: false, status: 0, reason: "not a request id" };
  const w = Math.max(0, Math.min(20, Math.floor(wait)));
  const r = await call(`${site}${BUDGET_API}/requests/${id}?wait=${w}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } }, (w + 15) * 1000, fetchImpl);
  if (own) {
    const named = [r.body?.id, r.body?.error?.id].filter((x) => x !== undefined && x !== null);
    const foreign = named.some((x) => x !== id) || (r.ok && r.body?.id !== id);
    if (foreign && !r.unread) return { ok: false, status: r.status, foreign: true, asked: viewEvidence(r.body), body: r.body, reason: "the site's answer is about another request" };
  }
  if (r.ok && r.body && typeof r.body === "object" && typeof r.body.state === "string") return { ok: true, view: r.body };
  const code = r.body?.error?.code ?? r.body?.code ?? r.body?.reason_code;
  const next = accountRefusalNext(code);
  // an error answer can show the wallet was asked (`error.money_moved`, even on a 429): the caller keeps that
  return { ok: false, status: r.status, own: own || undefined, code: siteWord("code", code), asked: viewEvidence(r.body), body: r.body, unread: r.unread, reason: r.network ? `${site} did not answer (${scrub(r.network)})` : r.unread ? `${siteFailure(r.status, null)}, an answer that is not JSON` : r.ok ? "the site's answer has no state" : `${siteFailure(r.status, r.body)}${next ? `; ${next}` : ""}` };
}

/** Site states that say the owner's wallet was asked, or a transaction exists. */
export const WALLET_STATES = new Set(["sending", "sent", "confirmed", "failed", "unknown"]);
const isObject = (x) => !!x && typeof x === "object";
const named = (x) => x !== undefined && x !== null && x !== "";
/**
 * Every transaction one object of the site's answer names, whatever its type: its own `tx_hash` and `tx_hashes`, and those of
 * its `next_action` (a request's verify_on_chain names `tx_hash`, a link's names `tx_hashes`).
 */
const namedTx = (o) => [o, o.next_action].filter(isObject).flatMap((x) => [x.tx_hash, ...(Array.isArray(x.tx_hashes) ? x.tx_hashes : [x.tx_hashes])]).filter(named);
/**
 * Whether one object of the site's answer (a request, a step, an error) shows that the wallet was asked: wallet_asked, a
 * transaction (namedTx), a state that may have sent, a next step that reads the chain (`verify_on_chain`: the site names it
 * only once something may have been sent), or money that may have moved (`money_moved` anything but false or absent).
 */
export const sentEvidence = (v) =>
  isObject(v) && (v.wallet_asked === true || namedTx(v).length > 0 || WALLET_STATES.has(v.state) || v.next_action?.type === "verify_on_chain" || (v.money_moved !== undefined && v.money_moved !== null && v.money_moved !== false));

/**
 * The one collector of wallet evidence, for any answer of the site about a request, whatever its status or shape (a read, an
 * error, a renewal, an answer about another request): whether the wallet was asked anywhere in it (sentEvidence over the
 * answer, its `error`, and the steps of either), and the transactions it names there that `isTx` takes as this rail's.
 * @param {unknown} v @param {(h: unknown) => boolean} [isTx]
 * @returns {{ walletAsked: boolean, hashes: string[] }}
 */
export function walletEvidence(v, isTx = () => false) {
  if (!isObject(v)) return { walletAsked: false, hashes: [] };
  const objects = [v, v.error].filter(isObject).flatMap((x) => [x, ...(Array.isArray(x.steps) ? x.steps.filter(isObject) : [])]);
  const hashes = [...new Set(objects.flatMap(namedTx).filter((h) => isTx(h)))];
  return { walletAsked: objects.some(sentEvidence), hashes };
}

/** Whether an answer about a request shows that the wallet was asked, anywhere in it (walletEvidence). */
export const viewEvidence = (v) => walletEvidence(v).walletAsked;

/**
 * POST /api/v1/budget/requests/{id}/cancel. The site cancels only while the owner's wallet has not been asked.
 * { cancelled: true } only when the answer is an explicit cancellation of this request with no evidence that the wallet
 * was asked: `200` with this id, state `cancelled` and `final: true`, or `409 { error: { code: "not_open", state: "cancelled",
 * wallet_asked: false, tx_hash: null } }` (the site's answer to a second cancel; a refusal carries its fields under `error`);
 * and no wallet_asked, tx_hash, money_moved or sending/sent/confirmed/failed/unknown state on the request, the refusal or
 * any of their steps, and no request id other than this one. A 409 not_open has neither an id nor `final`, so it is
 * accepted without them, but never with an id that is another request's. Anything else, an empty, unreadable or contradictory answer included,
 * is { cancelled: false, walletAsked, state, reason }: the caller reads it as unknown. null when the site did not answer.
 */
/** @param {{ site: string, id: string, token: string, fetchImpl?: typeof fetch }} args */
export async function cancelSiteRequest({ site, id, token, fetchImpl }) {
  if (!isSiteRequestId(id)) return null;
  const r = await call(`${site}${BUDGET_API}/requests/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: "{}" }, 15_000, fetchImpl);
  if (r.status === 0) return null;
  const b = r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : {};
  // a refusal carries its fields under `error`; an answer with the request has them at the top
  const inner = b.error && typeof b.error === "object" && !Array.isArray(b.error) ? b.error : undefined;
  const e = !r.ok && inner ? inner : b;
  // a documented state, or "unexpected": the site's text is never repeated
  const state = typeof e.state === "string" ? siteWord("state", e.state) : null;
  // a link with steps that is linked answers with the request as it stands, steps included: `view`
  const view = r.ok && Array.isArray(b.steps) ? b : undefined;
  // the wallet may have been asked: this request, its error or any of their steps says so, or names a transaction
  const walletAsked = viewEvidence(b);
  // an id the answer names (itself or in its error) is this request's, or the answer is about another request
  const ownId = [b.id, inner?.id].every((x) => x === undefined || x === null || x === id);
  // an answer with the request, about this request: its states can be taken as the site's word on it
  const same = r.ok && ownId && b.id === id;
  if (!walletAsked && ownId) {
    if (r.ok && b.id === id && b.state === "cancelled" && b.final === true) return { cancelled: true, state: "cancelled", view };
    if (r.status === 409 && e.code === "not_open" && e.state === "cancelled" && e.wallet_asked === false && (e.tx_hash ?? null) === null) return { cancelled: true, state: "cancelled", view };
  }
  const reason = r.ok ? "the site's answer to the cancel does not confirm this request was cancelled before the wallet was asked" : siteFailure(r.status, r.body);
  return { cancelled: false, state, walletAsked, reason, view, same, body: b };
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
  // the client's own key for a network it knows; the listing's own chain and rail words only for one it does not (data)
  const known = network && Object.hasOwn(chainByNetwork, network) ? chainByNetwork[network] : undefined;
  const chain = known ?? str(s.chain);
  const rail = known ? railOf(network) : str(s.rail) ?? railOf(network);
  return { name: str(s.name ?? s.title) ?? new URL(url).host, price: amount ? `${amount}${asset ? ` ${asset}` : ""}` : null, chain, network, rail, simulated: simulatedOf(s), url };
}

/**
 * The services the site lists for budgets. { ok: true, services } or { ok: false, absent, reason }: `absent` when the
 * site has no such list (404), so the caller can say that any seller URL still works.
 */
/** @param {{ site: string, chainByNetwork?: Record<string, string>, fetchImpl?: typeof fetch }} args */
export async function listSiteServices({ site, chainByNetwork = {}, fetchImpl }) {
  const r = await call(`${site}${BUDGET_API}/services`, { headers: { accept: "application/json" } }, 15_000, fetchImpl);
  if (r.status === 404 || r.status === 405 || r.status === 501) return { ok: false, absent: true, reason: `${site} has no budget service list yet (${siteFailure(r.status, r.body)})` };
  if (!r.ok) return { ok: false, absent: false, reason: r.network ? `${site} did not answer (${r.network})` : siteFailure(r.status, r.body) };
  const list = Array.isArray(r.body) ? r.body : Array.isArray(r.body?.services) ? r.body.services : Array.isArray(r.body?.data) ? r.body.data : null;
  if (!list) return { ok: false, absent: false, reason: `${site} answered without a list of services` };
  return { ok: true, services: list.slice(0, 500).map((s) => serviceOf(s, chainByNetwork)).filter(Boolean) };
}
