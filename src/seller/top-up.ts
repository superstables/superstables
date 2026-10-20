// Seller credit: the prepaid balance Superstables takes referral fees from, seen through the seller API.
//
// A top-up is an ordinary x402 payment. The seller API creates one and answers with the URL that asks for it;
// this client then pays that URL like any other purchase. Nothing here signs or sends a payment: these are the
// two reads and the one create that come before it, plus the checks that tie the answer to the request.
//
// The API key travels only to the Superstables origin, in an Authorization header, and never appears in a
// message: an answer that holds it (a site or a proxy echoing it back) is refused before anything is saved or printed.

import { BASE_SEPOLIA, fromAtomicString, toAtomicExact } from "../core/chain.js";
import { readBody, readCapped } from "../core/http.js";
import { siteFor } from "../core/owner-settings.js";
import { mentionsSecret, redactSecret, untrustedJson, untrustedText } from "../core/text.js";
import type { Attempt } from "../core/types.js";

/** The seller API key: a secret the seller portal issues (sssk_ followed by base64url characters). */
export const SELLER_API_KEY_ENV = "SUPERSTABLES_SELLER_API_KEY";
const API_KEY = /^sssk_[A-Za-z0-9_-]+$/;
/** The seller top-ups endpoint, on the same origin as the rest of the Superstables API. */
export const TOP_UPS_PATH = "/api/v1/seller/top-ups";
/** The chain a top-up is paid on: Base Sepolia, in test USDC. */
export const TOP_UP_NETWORK = BASE_SEPOLIA;
const TOP_UP_DECIMALS = TOP_UP_NETWORK.token.decimals;
/** The least and the most the site will take. */
export const MIN_TOP_UP_ATOMIC = 10n ** BigInt(TOP_UP_DECIMALS);
export const MAX_TOP_UP_ATOMIC = 1_000n * MIN_TOP_UP_ATOMIC;
/** The site rechecks a pending payment before answering a read, so a read can take about eight seconds. */
export const SELLER_API_TIMEOUT_MS = 20_000;
const MAX_ANSWER_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TopUpStatus = "open" | "pending" | "paid";

/** One top-up as the site describes it. Every field is the site's; nothing here is inferred. */
export interface TopUp {
  id: string;
  /** A USD decimal string, as the site writes it. */
  amount: string;
  status: TopUpStatus | string;
  payUrl?: string;
  createdAt?: string;
  /** The site no longer takes a payment for it (it was asked for before the fees address changed). */
  retired?: boolean;
}

/** One line of the seller's credit ledger, as the site describes it. */
export interface CreditEntry {
  at?: string;
  kind?: string;
  amount?: string;
  reference?: string;
}

/** What `seller credit` reads: the balance, the top-ups and the latest entries. */
export interface SellerCredit {
  balance?: string;
  asset: string;
  topUps: TopUp[];
  entries: CreditEntry[];
}

/** An amount a seller can top up: the decimal to send and its exact number of smallest units. */
export interface TopUpAmount {
  decimal: string;
  atomic: string;
}

/** The seller API refused or could not answer. `code` is the site's error code, or one this client supplies. */
export class SellerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SellerApiError";
  }
}

export { redactSecret };

/** A USD amount as the site takes it: a plain decimal, at least 1, with at most the token's decimal places. */
export function parseTopUpAmount(input: string): TopUpAmount {
  const text = input.trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`"${input}" is not a USD amount; write it as a plain decimal, such as 25 or 25.50`);
  }
  let atomic: bigint;
  try {
    atomic = toAtomicExact(text, TOP_UP_DECIMALS);
  } catch {
    throw new Error(`"${input}" has more than ${TOP_UP_DECIMALS} decimal places`);
  }
  if (atomic < MIN_TOP_UP_ATOMIC) throw new Error("the smallest top-up is 1 USDC");
  if (atomic > MAX_TOP_UP_ATOMIC) throw new Error("the largest top-up is 1000 USDC");
  return { decimal: fromAtomicString(atomic, TOP_UP_DECIMALS), atomic: atomic.toString() };
}

/** The seller API key from the environment. Throws without ever repeating the value. */
export function readSellerApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env[SELLER_API_KEY_ENV] ?? "").trim();
  if (!raw) {
    throw new Error(
      `set ${SELLER_API_KEY_ENV} to your seller API key from the seller portal; ` +
        "this command sends it only to Superstables",
    );
  }
  if (!API_KEY.test(raw)) throw new Error(`${SELLER_API_KEY_ENV} is not a seller API key (sssk_ followed by base64url characters)`);
  return raw;
}

/**
 * The Superstables origin the seller API is used on: SUPERSTABLES_SITE when set, else the owner's site, else
 * superstables.com. The key and a payment go there, so it is checked like an owner action: www.superstables.com, or a
 * site the owner has allowed in their settings (staging, this machine), and nothing else.
 */
export function sellerSite(site: string | undefined = process.env.SUPERSTABLES_SITE): URL {
  const got = siteFor("owner", site?.trim() || undefined);
  if ("error" in got) {
    throw new Error(`the seller API is used only on a site the owner allows: ${got.error}`);
  }
  const url = new URL(got.origin);
  if (url.username || url.password) throw new Error("the Superstables site must not contain a user name or password");
  return new URL(url.origin);
}

/** The URL a top-up's pay link must have, exactly. */
export function topUpPayPath(id: string): string {
  return `${TOP_UPS_PATH}/${id}/pay`;
}

/**
 * Why this top-up must not be paid, or undefined when it is the one that was just asked for: a UUID id, exactly
 * the requested amount, and a pay link on the same origin with exactly that id's pay path and nothing else.
 */
export function topUpProblem(topUp: TopUp, site: URL, expected: TopUpAmount): string | undefined {
  if (!UUID.test(topUp.id)) return `the site answered with a top-up id that is not a UUID ("${display(topUp.id)}")`;
  const amount = amountProblem(topUp.amount, expected);
  if (amount) return `the site made the top-up for ${amount}, not ${expected.decimal} USDC`;
  if (topUp.status !== "open" && topUp.status !== "pending" && topUp.status !== "paid") {
    return `the site gave the top-up an unknown status ("${display(topUp.status)}")`;
  }
  if (topUp.status !== "open") return undefined;
  if (topUp.retired) return "the site gave the top-up as retired, which it can no longer take a payment for";
  if (!topUp.payUrl) return "the site did not give the top-up a pay link";
  let url: URL;
  try {
    url = new URL(topUp.payUrl);
  } catch {
    return "the top-up's pay link is not a URL";
  }
  if (url.origin !== site.origin) return `the top-up's pay link is on ${url.origin}, not ${site.origin}`;
  if (url.username || url.password) return "the top-up's pay link carries a user name or password";
  if (url.search || url.hash) return "the top-up's pay link carries a query or fragment";
  if (url.pathname !== topUpPayPath(topUp.id)) {
    return `the top-up's pay link is not this top-up's pay path (expected ${topUpPayPath(topUp.id)}, got ${display(url.pathname)})`;
  }
  return undefined;
}

/** The pay link as the URL parser writes it: what topUpProblem checked, and what is quoted and paid. Call it after topUpProblem. */
export function topUpPayHref(topUp: TopUp): string {
  return new URL(topUp.payUrl as string).href;
}

/**
 * Why the 402 for a top-up must not be paid, or undefined when it asks for exactly the requested amount, in the
 * test USDC of Base Sepolia. The recipient is the site's to name: the link was checked to be the site's own.
 */
export function topUpTermsProblem(terms: {
  amountAtomic: string;
  asset: string;
  assetAddress: string;
  network: string;
  scheme?: string;
}, expected: TopUpAmount): string | undefined {
  if (terms.network !== TOP_UP_NETWORK.caip2) return `the payment is on ${terms.network}, not Base Sepolia (${TOP_UP_NETWORK.caip2})`;
  if (terms.assetAddress.toLowerCase() !== TOP_UP_NETWORK.token.address.toLowerCase()) {
    return `the payment is in ${display(terms.asset || terms.assetAddress)}, not Base Sepolia test USDC (${TOP_UP_NETWORK.token.address})`;
  }
  if ((terms.scheme ?? "exact") !== "exact") return `the payment uses ${display(terms.scheme ?? "")}, not the exact scheme`;
  if (terms.amountAtomic !== expected.atomic) {
    let shown = terms.amountAtomic;
    try {
      shown = fromAtomicString(terms.amountAtomic, TOP_UP_DECIMALS);
    } catch {
      // the reason below carries the raw value when it is not a decimal amount
    }
    return `the payment is for ${display(shown)} USDC, not ${expected.decimal} USDC`;
  }
  return undefined;
}

/** Make the site's top-up answer, checking only its shape. Fields it omits are reported by topUpProblem. */
export function topUpFromAnswer(body: unknown): TopUp {
  const raw = (body as { top_up?: unknown } | null | undefined)?.top_up;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SellerApiError("invalid_response", "the seller API answered without a top-up");
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const amount = decimalField(record.amount);
  const status = typeof record.status === "string" ? record.status : "";
  if (!id || amount === undefined || !status) {
    throw new SellerApiError("invalid_response", "the seller API's top-up is missing its id, amount or status");
  }
  return {
    id,
    amount,
    status,
    ...(typeof record.pay_url === "string" ? { payUrl: record.pay_url } : {}),
    ...(typeof record.created_at === "string" ? { createdAt: record.created_at } : {}),
    ...(record.retired === true ? { retired: true } : {}),
  };
}

/** Make the site's credit answer. A field it does not send is left out rather than guessed. */
export function creditFromAnswer(body: unknown): SellerCredit {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SellerApiError("invalid_response", "the seller API answered without a credit record");
  }
  const record = body as Record<string, unknown>;
  const credit = objectField(record.credit);
  const balance = signedDecimalField(credit?.balance ?? record.balance ?? record.credit_balance);
  const asset = stringField(credit?.asset ?? record.asset) ?? TOP_UP_NETWORK.token.symbol;
  const topUps = listField(record.top_ups ?? record.topUps ?? credit?.top_ups ?? credit?.topUps).map((entry) => topUpRecord(entry));
  const entries = listField(record.entries ?? record.ledger ?? credit?.entries ?? credit?.ledger).map((entry) => entryRecord(entry));
  return { ...(balance !== undefined ? { balance } : {}), asset, topUps, entries };
}

/** Create a top-up on the site. No retry: a repeated POST would make a second top-up. */
export async function createTopUp(options: {
  site: URL;
  apiKey: string;
  amount: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<TopUp> {
  const endpoint = new URL(TOP_UPS_PATH, options.site).toString();
  const answer = await call({
    url: endpoint,
    method: "POST",
    apiKey: options.apiKey,
    // Pinned to the one chain this client pays a top-up on, so the answer is never for another.
    body: JSON.stringify({ amount: options.amount, chain: TOP_UP_NETWORK.key }),
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return topUpFromAnswer(answer);
}

/** Read the seller's credit balance and recent top-ups. The site rechecks pending payments first. */
export async function readSellerCredit(options: {
  site: URL;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<SellerCredit> {
  const endpoint = new URL(TOP_UPS_PATH, options.site).toString();
  const answer = await call({
    url: endpoint,
    method: "GET",
    apiKey: options.apiKey,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return scrubbed(creditFromAnswer(answer), options.apiKey);
}

/** What is said when an answer held the key. It never repeats the answer. */
export const KEY_ECHOED_MESSAGE = "the site's answer contained the API key, so it was discarded unread";

/** The text of every string in a value, with the key redacted and the characters a terminal must not get removed. */
export function scrubbed<T>(value: T, secret: string): T {
  return untrustedJson(JSON.parse(redactSecret(JSON.stringify(value), secret)) as T);
}

/**
 * `fetch`, except that an answer holding the key (in its body, or in a header, plain or as base64) is refused with a
 * SellerApiError before the caller reads it. The caller keeps reading the answer itself, under its own cap and
 * deadline: this reads a copy of it, up to MAX_ANSWER_BYTES * 16.
 */
export function keyGuardedFetch(apiKey: string, inner: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const copy = res.clone();
    const { text } = await readBody(copy, MAX_ANSWER_BYTES * 16, SELLER_API_TIMEOUT_MS);
    if (holdsSecret(text, apiKey, res.headers)) {
      res.body?.cancel().catch(() => undefined);
      throw new SellerApiError("key_echoed", KEY_ECHOED_MESSAGE, res.status);
    }
    return res;
  };
}

/**
 * Whether an answer holds the key: in its body or a header, plain or as base64, as written, with its JSON escapes
 * read (a key spelled \u0073ssk_... is the key), or split by invisible characters.
 */
export function holdsSecret(text: string, secret: string, headers?: Headers): boolean {
  if (!secret) return false;
  const texts = [text];
  // A header such as PAYMENT-REQUIRED carries its JSON as base64.
  headers?.forEach((value) => texts.push(value, Buffer.from(value, "base64").toString("utf8")));
  return texts.some((one) => mentionsSecret(one, secret) || mentionsSecret(jsonText(one), secret));
}

/** The text of a JSON document with its escapes read, or an empty text when it is not JSON. */
function jsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return "";
  }
}

/** The id of the top-up whose pay link a URL is on this site, or undefined for any other URL. */
export function topUpIdFromPayUrl(url: string, site: URL): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== site.origin) return undefined;
    const match = new RegExp(`^${TOP_UPS_PATH}/([^/]+)/pay$`).exec(parsed.pathname);
    return match && UUID.test(match[1] as string) ? (match[1] as string).toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** An attempt that is not over: its payment may still be on its way. */
const LIVE_STATES = ["awaiting_approval", "approved", "submitting"];

/**
 * An attempt whose payment may have moved and is not settled: it is not over, it ended unknown, a paid one the chain
 * has not confirmed, or one that failed after naming a transaction the chain has not called unpaid.
 */
function mayHavePaid(attempt: Attempt): boolean {
  if (LIVE_STATES.includes(attempt.state) || attempt.state === "uncertain") return true;
  if (attempt.state === "paid_service_failed") return attempt.chain !== "verified";
  return attempt.state === "failed" && attempt.chain !== "unpaid" && attempt.transaction !== undefined;
}

/**
 * Why another top-up must not be created yet, or undefined when none is in doubt. A top-up is in doubt when the site
 * lists one as pending, when a payment on this machine is still under way, or when one that ended in doubt (and is not
 * confirmed on chain) is for a top-up the site does not list. The site's word on a top-up it lists settles an ended
 * payment: a payment that claims a top-up turns it pending, so a top-up it lists as anything else was not claimed, and
 * a retired top-up cannot be paid. Creating and paying another while one is in doubt could pay twice.
 */
export function earlierTopUpProblem(input: { site: URL; credit: SellerCredit; attempts: Attempt[] }): string | undefined {
  const listed = new Set(input.credit.topUps.map((topUp) => topUp.id.toLowerCase()));
  const doubts: string[] = [];
  for (const topUp of input.credit.topUps) {
    if (topUp.status === "pending") doubts.push(`top-up ${display(topUp.id)} is pending on the site`);
  }
  for (const attempt of input.attempts) {
    const id = topUpIdFromPayUrl(attempt.url, input.site);
    if (!id || !mayHavePaid(attempt)) continue;
    if (listed.has(id) && !LIVE_STATES.includes(attempt.state)) continue;
    doubts.push(`top-up ${id} has a payment (attempt ${attempt.id}, ${attempt.state}) that may have moved money`);
  }
  if (doubts.length === 0) return undefined;
  const shown = doubts.slice(0, 3).join("; ") + (doubts.length > 3 ? `; and ${doubts.length - 3} more` : "");
  return (
    `an earlier top-up is not settled: ${shown}. A new top-up could pay twice, so this command created and paid nothing. It clears when \`superstables seller credit\` ` +
    "(it rechecks pending top-ups) lists the top-up as anything but pending, or when `superstables status <attempt>` ends the " +
    "attempt: paid and confirmed on chain, or failed with the chain saying it was never made"
  );
}

// ── Internals ───────────────────────────────────────────────────────────────────────────

async function call(options: {
  url: string;
  method: "GET" | "POST";
  apiKey: string;
  body?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? SELLER_API_TIMEOUT_MS;
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(options.url, {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SellerApiError("network_error", `the seller API could not be reached (${redactSecret(messageOf(err), options.apiKey)})`);
  }

  let text: string;
  try {
    text = await readCapped(res, MAX_ANSWER_BYTES, timeoutMs, options.url);
  } catch (err) {
    throw new SellerApiError("invalid_response", `the seller API's answer could not be read (${messageOf(err)})`, res.status);
  }
  // An answer that holds the key is not read at all: nothing of it is parsed, kept or repeated.
  if (holdsSecret(text, options.apiKey, res.headers)) throw new SellerApiError("key_echoed", KEY_ECHOED_MESSAGE, res.status);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }

  if (!res.ok) throw errorFrom(res, body, options.apiKey);
  if (body === undefined) throw new SellerApiError("invalid_response", "the seller API did not answer with JSON", res.status);
  return body;
}

/** The site's `{ error: { code, message, money_moved } }`, bounded and with the key redacted. */
function errorFrom(res: Response, body: unknown, apiKey: string): SellerApiError {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : `http_${res.status}`;
  // The site's words may quote the request back, and this one carries the key: redact before it can be printed.
  const said = typeof error?.message === "string" ? untrustedText(redactSecret(error.message, apiKey), 300) : "";
  const detail = said ? `: ${said}` : "";
  return new SellerApiError(
    code,
    `${code === `http_${res.status}` ? `the seller API answered HTTP ${res.status}` : `the seller API refused it (${code}, HTTP ${res.status})`}${detail}`,
    res.status,
  );
}

function amountProblem(amount: string | undefined, expected: TopUpAmount): string | undefined {
  if (!amount) return undefined;
  if (amount === expected.decimal) return undefined;
  try {
    const atomic = toAtomicExact(amount, TOP_UP_DECIMALS).toString();
    return atomic === expected.atomic ? undefined : fromAtomicString(atomic, TOP_UP_DECIMALS);
  } catch {
    return display(amount);
  }
}

function topUpRecord(entry: unknown): TopUp {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    id: stringField(record.id) ?? "",
    amount: decimalField(record.amount) ?? "",
    status: stringField(record.status) ?? "",
    ...(stringField(record.pay_url) !== undefined ? { payUrl: stringField(record.pay_url) as string } : {}),
    ...(stringField(record.created_at) !== undefined ? { createdAt: stringField(record.created_at) as string } : {}),
    ...(record.retired === true ? { retired: true } : {}),
  };
}

function entryRecord(entry: unknown): CreditEntry {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    ...(stringField(record.created_at ?? record.at ?? record.occurred_at ?? record.date) !== undefined
      ? { at: stringField(record.created_at ?? record.at ?? record.occurred_at ?? record.date) as string }
      : {}),
    ...(stringField(record.kind ?? record.type ?? record.reason ?? record.description) !== undefined
      ? { kind: stringField(record.kind ?? record.type ?? record.reason ?? record.description) as string }
      : {}),
    ...(signedDecimalField(record.amount) !== undefined ? { amount: signedDecimalField(record.amount) as string } : {}),
    // The ledger entry's own id is no reference; `source_id` is what it was made for: a top-up, a sale, a refund.
    ...(stringField(record.source_id ?? record.reference ?? record.top_up_id ?? record.purchase_id) !== undefined
      ? { reference: stringField(record.source_id ?? record.reference ?? record.top_up_id ?? record.purchase_id) as string }
      : {}),
  };
}

function decimalField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return /^\d+(?:\.\d+)?$/.test(text) ? text : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).amount;
    if (nested !== undefined && nested !== value) return decimalField(nested);
  }
  return undefined;
}

/** A credit entry's amount: a fee comes out of the balance, so a ledger amount may be negative. */
function signedDecimalField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return /^-?\d+(?:\.\d+)?$/.test(text) ? text : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nested = (value as Record<string, unknown>).amount;
    if (nested !== undefined && nested !== value) return signedDecimalField(nested);
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function listField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Somebody else's short text in a refusal: one bounded line. */
function display(value: string): string {
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
