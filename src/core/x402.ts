// Payment challenge detection and parsing. Detection is free: a paid endpoint answers HTTP 402 with what it wants, and
// reading that costs nothing. Two protocols are read: x402 (its v1 and v2 shapes, in the PAYMENT-REQUIRED header or the
// body) and MPP (`WWW-Authenticate: Payment` challenges, src/core/mpp.ts). Which offers this client can pay is the rails'
// call (src/core/rails/); termsFor below is the x402 entry to it.

import type { PaymentRequirements } from "@x402/core/types";
import { sameAddressOn, toCaip2 } from "./chain.js";
import { DETECT_TIMEOUT_MS, DeadlineError, MAX_CHALLENGE_BYTES, readCapped } from "./http.js";
import { parseMppChallenges, type MppChallenge } from "./mpp.js";
import { judgeAccept } from "./rails/index.js";
import { untrustedText } from "./text.js";
import type { PaymentTerms } from "./types.js";

export { DeadlineError, MAX_CHALLENGE_BYTES, readBody, readCapped, type ReadEnd } from "./http.js";

export interface RawAccept {
  scheme?: string;
  network?: string;
  amount?: string;
  /** x402 v1 field name. */
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface RawChallenge {
  x402Version?: number;
  error?: string;
  resource?: string | { url?: string; description?: string; mimeType?: string };
  accepts?: RawAccept[];
  extensions?: Record<string, unknown>;
}

export interface Challenge {
  version: 1 | 2;
  /** The seller's self-declared resource URL. Never use its hostname for policy. */
  resource: string;
  description: string;
  /** The raw requirement objects, in the order offered. */
  accepts: RawAccept[];
  /** v2: the challenge's resource object and extensions as received, for a credential that carries them back. */
  resourceInfo?: { url?: string; description?: string; mimeType?: string };
  extensions?: Record<string, unknown>;
}

/** Everything a 402 asked for: an x402 challenge, MPP challenges, or both. */
export interface SellerChallenge {
  x402?: Challenge;
  /** Why an x402 challenge in the 402 was not read (a wire version this client does not read). */
  x402Refusal?: string;
  /** MPP challenges, in the order the seller gave them. */
  mpp: MppChallenge[];
  /** The seller's own description of the resource, from the x402 challenge or the first MPP challenge that has one. */
  description: string;
}

/**
 * An x402 challenge in a wire version this client does not read. Only versions 1 and 2 are read: a seller that names
 * another, or none, is refused before any of its offers is judged, never read as a version it did not name.
 */
export class UnsupportedX402Version extends Error {
  constructor(named: unknown) {
    super(
      named === undefined
        ? "the x402 challenge names no version, and this client reads versions 1 and 2 only"
        : `the x402 challenge is version ${untrustedText(JSON.stringify(named) ?? String(named), 20)}, and this client reads versions 1 and 2 only`,
    );
    this.name = "UnsupportedX402Version";
  }
}

export function parseChallenge(input: { paymentRequiredHeader?: string | null; body?: string }): Challenge {
  const candidates = [
    input.paymentRequiredHeader ? Buffer.from(input.paymentRequiredHeader, "base64").toString("utf8") : undefined,
    input.body,
  ];
  let raw: RawChallenge | undefined;
  for (const text of candidates) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as RawChallenge;
      if (parsed && Array.isArray(parsed.accepts)) {
        raw = parsed;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  if (!raw || !Array.isArray(raw.accepts) || raw.accepts.length === 0) {
    throw new Error("No x402 challenge found in the 402 response (header or body)");
  }
  // The wire version decides how an offer is read and signed (v1 is EVM only: the EVM rail is the one that takes it).
  if (raw.x402Version !== 1 && raw.x402Version !== 2) throw new UnsupportedX402Version(raw.x402Version);
  const version: 1 | 2 = raw.x402Version;
  const resource = typeof raw.resource === "string" ? raw.resource : (raw.resource?.url ?? "");
  const description = typeof raw.resource === "object" && raw.resource ? (raw.resource.description ?? "") : "";
  const resourceInfo = typeof raw.resource === "object" && raw.resource ? raw.resource : undefined;
  const extensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions) ? raw.extensions : undefined;
  return {
    version,
    resource,
    description,
    accepts: raw.accepts,
    ...(resourceInfo ? { resourceInfo } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

/**
 * Read a 402 for every challenge this client understands: x402 (header or body) and MPP (WWW-Authenticate). Throws
 * when there is neither.
 */
export function readSellerChallenge(input: { paymentRequiredHeader?: string | null; wwwAuthenticate?: string | null; body?: string }): SellerChallenge {
  let x402: Challenge | undefined;
  let x402Refusal: string | undefined;
  try {
    x402 = parseChallenge(input);
  } catch (err) {
    x402 = undefined;
    if (err instanceof UnsupportedX402Version) x402Refusal = err.message;
  }
  const mpp = parseMppChallenges(input.wwwAuthenticate);
  if (!x402 && mpp.length === 0) {
    throw new Error(x402Refusal ? `The 402 response offers no payment this client reads: ${x402Refusal}` : "No payment challenge (x402 or MPP) found in the 402 response");
  }
  const description = x402?.description || mpp.find((c) => c.description)?.description || "";
  return { ...(x402 ? { x402 } : {}), ...(x402Refusal ? { x402Refusal } : {}), mpp, description };
}

export class NotPaidEndpointError extends Error {
  constructor(readonly url: string, readonly status: number, readonly bodyPreview: string) {
    super(`Expected HTTP 402 from ${url}, got ${status}: not a paid endpoint (x402 or MPP), or the request is wrong`);
    this.name = "NotPaidEndpointError";
  }
}

/**
 * Fetch the endpoint and read its x402 challenge. Throws NotPaidEndpointError on anything but 402.
 *
 * This is the free leg: no credential is on it, but the endpoint is somebody else's, so it is read
 * under one deadline for the whole exchange, never redirected, and never read past the cap. A 402
 * challenge that does not fit in that cap is not a challenge. The budget half of this client reads
 * the same way (budget/response.mjs): the point is that one side of the product must not be the weak one.
 */
export async function detect(url: string, init: RequestInit = {}, options: { timeoutMs?: number } = {}): Promise<Challenge> {
  const answer = await fetch402(url, init, options);
  return parseChallenge({ paymentRequiredHeader: answer.paymentRequiredHeader, body: answer.body });
}

/** As detect(), for every challenge this client understands: x402 and MPP. */
export async function detectPayment(url: string, init: RequestInit = {}, options: { timeoutMs?: number } = {}): Promise<SellerChallenge> {
  return readSellerChallenge(await fetch402(url, init, options));
}

async function fetch402(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number },
): Promise<{ paymentRequiredHeader: string | null; wwwAuthenticate: string | null; body: string }> {
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError(url, timeoutMs)), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const res = await fetch(url, { ...init, redirect: "error", signal });
    const body = await readCapped(res, MAX_CHALLENGE_BYTES, deadline - Date.now(), url);
    if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
    return {
      paymentRequiredHeader: res.headers.get("payment-required") ?? res.headers.get("x-payment-required"),
      wwwAuthenticate: res.headers.get("www-authenticate"),
      body,
    };
  } catch (err) {
    // An abort from our own deadline reads as what it is, not as an AbortError.
    if (controller.signal.aborted && controller.signal.reason instanceof DeadlineError) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type Unsupported = { supported: false; reason: string };
export type Supported = { supported: true; terms: PaymentTerms; requirement: PaymentRequirements };

/**
 * Judge one offered x402 requirement against what this client can pay: exact scheme, a chain `pay` pays on, that
 * chain's token and signing facts (the rail's own checks, src/core/rails/). Returns the terms the owner will be shown,
 * derived only from the requirement itself.
 */
export function termsFor(accept: RawAccept, version: 1 | 2): Supported | Unsupported {
  const judged = judgeAccept(accept, version);
  if (!judged.supported) return judged;
  return { supported: true, terms: judged.offer.terms, requirement: judged.offer.requirement as PaymentRequirements };
}

/** Two requirements name the same payment when amount, asset, recipient and network agree. */
export function sameTerms(a: PaymentTerms, b: PaymentTerms): boolean {
  const network = toCaip2(a.network);
  return (
    a.amountAtomic === b.amountAtomic &&
    network === toCaip2(b.network) &&
    sameAddressOn(network, a.assetAddress, b.assetAddress) &&
    sameAddressOn(network, a.recipient, b.recipient) &&
    (a.scheme ?? "exact") === (b.scheme ?? "exact")
  );
}
