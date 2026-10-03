// x402 challenge detection and parsing, protocol v1 and v2 shapes. Detection is free:
// a paid endpoint answers HTTP 402 with its requirements, and reading them costs nothing.

import type { PaymentRequirements } from "@x402/core/types";
import { describeNetwork, fromAtomic, isSameAddress, networkFor, toCaip2 } from "./chain.js";
import { untrustedText } from "./text.js";
import type { PaymentTerms } from "./types.js";

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
  resource?: string | { url?: string; description?: string };
  accepts?: RawAccept[];
}

export interface Challenge {
  version: 1 | 2;
  /** The seller's self-declared resource URL. Never use its hostname for policy. */
  resource: string;
  description: string;
  /** The raw requirement objects, in the order offered. */
  accepts: RawAccept[];
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
  const resource = typeof raw.resource === "string" ? raw.resource : (raw.resource?.url ?? "");
  const description = typeof raw.resource === "object" && raw.resource ? (raw.resource.description ?? "") : "";
  return { version: raw.x402Version === 1 ? 1 : 2, resource, description, accepts: raw.accepts };
}

export class NotPaidEndpointError extends Error {
  constructor(readonly url: string, readonly status: number, readonly bodyPreview: string) {
    super(`Expected HTTP 402 from ${url}, got ${status}: not a paid x402 endpoint, or the request is wrong`);
    this.name = "NotPaidEndpointError";
  }
}

/**
 * Fetch the endpoint and read its challenge. Throws NotPaidEndpointError on anything but 402.
 *
 * This is the free leg: no credential is on it, but the endpoint is somebody else's, so it is read
 * under one deadline for the whole exchange, never redirected, and never read past the cap. A 402
 * challenge that does not fit in that cap is not a challenge. The budget half of this client reads
 * the same way (budget/response.mjs): the point is that one side of the product must not be the weak one.
 */
export async function detect(url: string, init: RequestInit = {}, options: { timeoutMs?: number } = {}): Promise<Challenge> {
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError(url, timeoutMs)), timeoutMs);
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const res = await fetch(url, { ...init, redirect: "error", signal });
    const body = await readCapped(res, MAX_CHALLENGE_BYTES, deadline - Date.now(), url);
    if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
    const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
    return parseChallenge({ paymentRequiredHeader: header, body });
  } catch (err) {
    // An abort from our own deadline reads as what it is, not as an AbortError.
    if (controller.signal.aborted && controller.signal.reason instanceof DeadlineError) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** How long the free challenge exchange may take, start to finish, and how much of the answer is read. */
const DETECT_TIMEOUT_MS = 15_000;
export const MAX_CHALLENGE_BYTES = 1_000_000;

/** A service that did not finish answering in time. Its socket has been released. */
export class DeadlineError extends Error {
  constructor(url: string, ms: number) {
    super(`${hostLabel(url)} did not finish answering within ${Math.round(ms / 100) / 10} s`);
    this.name = "DeadlineError";
  }
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the service";
  }
}

/** How a capped read ended: the body's end was seen, the cap or drain limit was reached, the deadline passed, or the read failed. */
export type ReadEnd = "eof" | "cap" | "deadline" | "error";

/**
 * Read a response body as text, keeping no more than `max` bytes and reading no later than `ms` from now, and say how
 * the read ended. With `drainTo`, reading goes on past `max` without keeping anything, up to `drainTo` bytes in all, so
 * that an answer longer than what is kept can still be seen to end ("eof"). The reader is always cancelled afterwards,
 * which releases the socket. Never throws.
 */
export async function readBody(
  res: Response,
  max: number,
  ms: number,
  drainTo = max,
): Promise<{ text: string; end: ReadEnd }> {
  const body = res.body;
  if (!body) return { text: "", end: "eof" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let seen = 0;
  let end: ReadEnd = "eof";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), Math.max(0, ms));
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === "deadline") {
        end = "deadline";
        break;
      }
      if (next.done) break;
      const value = next.value;
      if (!value) continue;
      seen += value.length;
      if (kept < max) {
        chunks.push(value);
        kept += value.length;
      }
      if (seen >= drainTo) {
        end = "cap";
        break;
      }
    }
  } catch {
    end = "error";
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).subarray(0, max).toString("utf8"), end };
}

/**
 * Read a response body as text, no further than `max` bytes and no later than `ms` from now. Past the cap the transfer
 * stops; past the deadline the read is cancelled and this throws DeadlineError. A service that sends a byte at a time
 * forever is the case the deadline is for: a timeout on the request alone does not end a body that keeps arriving.
 */
export async function readCapped(res: Response, max: number, ms = DETECT_TIMEOUT_MS, url = res.url): Promise<string> {
  const { text, end } = await readBody(res, max, ms);
  if (end === "deadline") throw new DeadlineError(url, ms);
  if (end === "error") throw new Error(`the answer from ${hostLabel(url)} broke off`);
  return text;
}

export type Unsupported = { supported: false; reason: string };
export type Supported = { supported: true; terms: PaymentTerms; requirement: PaymentRequirements };

/**
 * Judge one offered requirement against what this client can pay: exact scheme, a supported
 * network, that network's USDC. Returns the terms the owner will be shown, derived only from
 * the requirement itself.
 */
export function termsFor(accept: RawAccept, version: 1 | 2): Supported | Unsupported {
  // Every string the seller offers here can end up in a refusal an agent reads, so it is quoted as one bounded line.
  const scheme = accept.scheme ?? "exact";
  if (scheme !== "exact") return { supported: false, reason: `scheme "${untrustedText(scheme, 40)}" is not supported (only exact)` };
  const network = networkFor(accept.network ?? "");
  if (!network) return { supported: false, reason: `network ${untrustedText(describeNetwork(String(accept.network ?? "unknown")), 60)} is not supported (only ${describeNetwork("eip155:84532")})` };
  if (!accept.asset || !isSameAddress(accept.asset, network.usdc.address)) {
    return { supported: false, reason: `asset ${untrustedText(accept.extra?.name ?? accept.asset ?? "unknown", 60)} is not USDC on ${network.label}` };
  }
  // The signing domain is USDC's own. An offer that names another one is either wrong or asks the owner's wallet to show
  // a name the seller chose as the signing application; either way the signature would not verify on chain.
  const domain = network.usdc.eip712;
  if ((accept.extra?.name !== undefined && accept.extra.name !== domain.name) || (accept.extra?.version !== undefined && accept.extra.version !== domain.version)) {
    return { supported: false, reason: `the offer's signing domain is not USDC's on ${network.label} (expected name "${domain.name}", version "${domain.version}"), so the signature would not verify` };
  }
  const atomic = accept.amount ?? accept.maxAmountRequired;
  if (!atomic || !/^\d+$/.test(String(atomic))) return { supported: false, reason: "the offered amount is missing or malformed" };
  if (!accept.payTo || !/^0x[0-9a-fA-F]{40}$/.test(accept.payTo)) return { supported: false, reason: "the recipient (payTo) is missing or malformed" };
  const amountAtomic = String(atomic);
  const terms: PaymentTerms = {
    amountDecimal: fromAtomic(amountAtomic, network.usdc.decimals),
    amountAtomic,
    asset: "USDC",
    assetAddress: network.usdc.address,
    network: network.caip2,
    networkLabel: network.label,
    recipient: accept.payTo,
    scheme,
    x402Version: version,
  };
  const requirement: PaymentRequirements = {
    scheme,
    network: (accept.network ?? network.caip2) as PaymentRequirements["network"],
    asset: accept.asset,
    amount: amountAtomic,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 300,
    extra: (accept.extra ?? {}) as Record<string, unknown>,
  };
  // v1 requirements keep their wire shape (maxAmountRequired, vernacular network) for the signer.
  if (version === 1) Object.assign(requirement, { maxAmountRequired: amountAtomic });
  return { supported: true, terms, requirement };
}

/** Two requirements name the same payment when amount, asset, recipient and network agree. */
export function sameTerms(a: PaymentTerms, b: PaymentTerms): boolean {
  return (
    a.amountAtomic === b.amountAtomic &&
    isSameAddress(a.assetAddress, b.assetAddress) &&
    isSameAddress(a.recipient, b.recipient) &&
    toCaip2(a.network) === toCaip2(b.network)
  );
}
