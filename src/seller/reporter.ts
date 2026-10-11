// Reporting what happened to a referred purchase: POST /api/v1/seller/events on superstables.com, with the seller's API
// key. The same event sent twice is the same purchase on the site, so a report is safe to retry; this client retries
// only when the site could not answer (a network error, a 5xx, or a 429), and sends the same Idempotency-Key each time.

import { createHash } from "node:crypto";
import { DEFAULT_SITE, decodeReferral, siteUrl } from "./referral.js";

export type ReferralEventType = "acknowledged" | "fulfilled" | "failed" | "refunded";

export interface ReferralSettlement {
  /** CAIP-2, e.g. eip155:84532. */
  network: string;
  transaction: string;
  payer?: string;
  /** Atomic units of the asset, as a decimal string. */
  amount: string;
  /** The token's address. */
  asset: string;
  status: "settled" | "pending" | "unknown";
}

export interface ReferralRefund {
  /** Atomic units, as a decimal string. */
  amount: string;
  transaction?: string;
}

/** One event, in the shape the seller events API takes. */
export interface ReferralEvent {
  type: ReferralEventType;
  /** The referral token the buyer's request carried. */
  referral: string;
  /** The buyer's Superstables-Purchase-Ref, when it sent one. */
  purchase_ref?: string;
  /** The seller's own order id. */
  order_id?: string;
  /** When it happened. Default: when report() is called. */
  occurred_at?: string;
  /** Required for `fulfilled`. */
  settlement?: ReferralSettlement;
  /** Required for `refunded`. */
  refund?: ReferralRefund;
}

export interface ReportedPurchase {
  id: string;
  status: string;
  reason: string | null;
  fee: { amount: string; asset: string } | null;
}

/** The site's answer: the purchase the event was recorded against, and whether this exact event was already recorded. */
export interface ReportAnswer {
  purchase: ReportedPurchase;
  replayed: boolean;
}

export interface ReferralReporterOptions {
  /** The seller API key from the seller portal (sssk_…). */
  apiKey: string;
  /** Default: DEFAULT_SITE. */
  site?: string;
  fetch?: typeof fetch;
  /** Retries after the first try, for network errors, 5xx and 429 only. Default 3. */
  retries?: number;
  /** The wait before the first retry; it doubles each time. Default 500 ms. */
  backoffMs?: number;
  /** How long one request may take. Default 10 s. */
  timeoutMs?: number;
}

export interface ReferralReporter {
  report(event: ReferralEvent): Promise<ReportAnswer>;
}

/**
 * A report the site did not record. `code` is the site's error code when it sent one (for example `invalid_event`), or
 * `network_error`, `invalid_response`, `body_too_large` or `http_<status>`. The message never contains the API key or
 * the token.
 */
export class ReferralReportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ReferralReportError";
  }
}

const EVENT_TYPES: readonly string[] = ["acknowledged", "fulfilled", "failed", "refunded"];
const MAX_BODY_BYTES = 8 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;
const API_KEY = /^sssk_[A-Za-z0-9_-]+$/;

/**
 * The Idempotency-Key for an event: hex SHA-256 of `type|referral id|purchase_ref|order_id|settlement transaction|refund
 * transaction`, an empty string for each part that is absent. The referral id is read from the token without checking it.
 */
export function idempotencyKey(event: ReferralEvent): string {
  const jti = decodeReferral(event.referral)?.payload.jti;
  const parts = [
    event.type,
    typeof jti === "string" ? jti : "",
    event.purchase_ref ?? "",
    event.order_id ?? "",
    event.settlement?.transaction ?? "",
    event.refund?.transaction ?? "",
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** A reporter for one seller API key. Throws at once when the key or the site is not usable. */
export function createReferralReporter(options: ReferralReporterOptions): ReferralReporter {
  if (typeof options.apiKey !== "string" || !API_KEY.test(options.apiKey)) {
    throw new TypeError("apiKey is not a seller API key (sssk_ followed by base64url characters)");
  }
  const endpoint = new URL("/api/v1/seller/events", siteUrl(options.site ?? DEFAULT_SITE)).toString();
  const doFetch = options.fetch ?? fetch;
  const retries = Math.max(0, options.retries ?? 3);
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const authorization = `Bearer ${options.apiKey}`;

  return {
    async report(event: ReferralEvent): Promise<ReportAnswer> {
      if (!event || !EVENT_TYPES.includes(event.type)) {
        throw new ReferralReportError("invalid_event", "the event type is not one of acknowledged, fulfilled, failed or refunded");
      }
      const body = JSON.stringify({ ...event, occurred_at: event.occurred_at ?? new Date().toISOString() });
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        throw new ReferralReportError("body_too_large", "the event is larger than the 8 KB the site accepts");
      }
      const headers = {
        authorization,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": idempotencyKey(event),
      };

      for (let attempt = 0; ; attempt += 1) {
        const last = attempt >= retries;
        let res: Response;
        try {
          res = await doFetch(endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          if (last) throw new ReferralReportError("network_error", "the seller events API could not be reached");
          await pause(backoffMs * 2 ** attempt);
          continue;
        }

        if (res.ok) {
          const answer = (await res.json().catch(() => undefined)) as Partial<ReportAnswer> | undefined;
          if (!answer || typeof answer.purchase !== "object" || answer.purchase === null) {
            throw new ReferralReportError("invalid_response", "the seller events API answered without a purchase", res.status);
          }
          return { purchase: answer.purchase as ReportedPurchase, replayed: answer.replayed === true };
        }

        const error = (await res.json().catch(() => undefined)) as { error?: { code?: unknown; message?: unknown; retry_after?: unknown } } | undefined;
        const code = typeof error?.error?.code === "string" ? error.error.code : `http_${res.status}`;
        const retryAfter = retryAfterSeconds(res.headers.get("retry-after"), error?.error?.retry_after);
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || last) {
          throw new ReferralReportError(code, `the seller events API did not record the event (HTTP ${res.status}, ${code})`, res.status, retryAfter);
        }
        const wait = backoffMs * 2 ** attempt;
        await pause(retryAfter === undefined ? wait : Math.min(Math.max(wait, retryAfter * 1000), MAX_RETRY_AFTER_MS));
      }
    },
  };
}

function retryAfterSeconds(header: string | null, field: unknown): number | undefined {
  const fromField = typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined;
  const fromHeader = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  return fromHeader ?? fromField;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
