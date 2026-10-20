// Seller credit: the prepaid balance Superstables takes referral fees from, seen through the seller API.
//
// A top-up is an ordinary x402 payment. The seller API creates one and answers with the URL that asks for it;
// this client then pays that URL like any other purchase. Nothing here signs or sends a payment: these are the
// two reads and the one create that come before it, plus the checks that tie the answer to the request.
//
// The API key travels only to the Superstables origin, in an Authorization header, and never appears in a
// message: a site (or a proxy) that echoes it back has it redacted before anything is printed.

import { BASE_SEPOLIA, fromAtomicString, toAtomicExact } from "../core/chain.js";
import { readCapped } from "../core/http.js";
import { siteFor } from "../core/owner-settings.js";

/** The seller API key: a secret the seller portal issues (sssk_ followed by base64url characters). */
export const SELLER_API_KEY_ENV = "SUPERSTABLES_SELLER_API_KEY";
const API_KEY = /^sssk_[A-Za-z0-9_-]+$/;
/** The seller top-ups endpoint, on the same origin as the rest of the Superstables API. */
export const TOP_UPS_PATH = "/api/v1/seller/top-ups";
/** The chain a top-up is paid on: Base Sepolia, in test USDC. */
export const TOP_UP_NETWORK = BASE_SEPOLIA;
const TOP_UP_DECIMALS = TOP_UP_NETWORK.token.decimals;
/** The least the site will take. */
export const MIN_TOP_UP_ATOMIC = 10n ** BigInt(TOP_UP_DECIMALS);
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

/** Replace a secret with a word, for text that came from somewhere else. */
export function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

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
 * The Superstables origin the seller API is read from: SUPERSTABLES_SITE when set, else the owner's site, else
 * superstables.com. The key travels there, so it is checked like a read of the site: an https superstables.com host, or
 * this machine for local and staging development, and nothing else.
 */
export function sellerSite(site: string | undefined = process.env.SUPERSTABLES_SITE): URL {
  const got = siteFor("read", site?.trim() || undefined);
  if ("error" in got) {
    throw new Error(`the seller API is read only on superstables.com (or on this machine, for development): ${got.error}`);
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
  };
}

/** Make the site's credit answer. A field it does not send is left out rather than guessed. */
export function creditFromAnswer(body: unknown): SellerCredit {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SellerApiError("invalid_response", "the seller API answered without a credit record");
  }
  const record = body as Record<string, unknown>;
  const credit = objectField(record.credit);
  const balance = decimalField(credit?.balance ?? record.balance ?? record.credit_balance);
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
  return creditFromAnswer(answer);
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
  const code = typeof error?.code === "string" && error.code.length <= 120 ? error.code : `http_${res.status}`;
  // The site's words may quote the request back, and this one carries the key: redact before it can be printed.
  const said = typeof error?.message === "string" ? redactSecret(error.message.replace(/\s+/g, " "), apiKey).slice(0, 300) : "";
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
    ...(stringField(record.reference ?? record.id ?? record.top_up_id ?? record.purchase_id) !== undefined
      ? { reference: stringField(record.reference ?? record.id ?? record.top_up_id ?? record.purchase_id) as string }
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
