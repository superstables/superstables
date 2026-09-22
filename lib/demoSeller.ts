// The x402 seller mechanics every paid demo endpoint shares: the request's public URL, the
// 402 challenge, the credential check against our own terms, and the verify-then-settle
// dance with a public facilitator. Written once so that the market data service and the
// prepared demo services cannot drift apart on the part that handles money.
//
// Two ordering rules are load bearing for every caller:
//   1. validate the request BEFORE demanding payment, so a buyer never pays for a 400.
//   2. answer only after the facilitator reports the transfer settled, so the buyer's
//      PAYMENT-RESPONSE header always describes a settlement that actually happened.
//
// Everything here is testnet: test USDC on Base Sepolia, so no real money ever moves.

import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

/** Public Base Sepolia facilitators, tried in this order. They submit the transfer and pay the gas. */
export const DEFAULT_FACILITATORS = [
  "https://facilitator.x402.rs",
  "https://facilitator.payai.network",
  "https://x402.org/facilitator",
] as const;

const FACILITATOR_TIMEOUT_MS = 20_000;

/**
 * The facilitators to use: the public ones, unless SUPERSTABLES_DEMO_FACILITATORS names
 * others (comma separated). The override exists so a test can stand up its own facilitator
 * on loopback; production leaves it unset.
 */
export function facilitators(): readonly string[] {
  const raw = process.env.SUPERSTABLES_DEMO_FACILITATORS?.trim();
  if (!raw) return DEFAULT_FACILITATORS;
  // Only https, or plain http on this machine: a stray value cannot reroute settlement elsewhere.
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter((u) => /^https:\/\//i.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(u));
  return urls.length > 0 ? urls : DEFAULT_FACILITATORS;
}

export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  "Cache-Control": "no-store",
};

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The absolute URL of this request as the buyer called it. Behind Vercel's proxy the request
 * that reaches this function is plain HTTP, so the scheme and host come from the forwarding
 * headers: the resource URL inside the challenge has to be the URL the buyer actually called.
 */
export function requestUrl(req: Request): string {
  const url = new URL(req.url);
  const forwardedProto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim();
  const forwardedHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0]?.trim();
  const scheme =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : url.protocol.replace(":", "");
  // The forwarded authority carries its own port, or none at all, so the whole origin is
  // rebuilt rather than patched: assigning `host` alone would keep this process's port.
  try {
    return new URL(`${url.pathname}${url.search}`, `${scheme}://${forwardedHost || url.host}`).toString();
  } catch {
    return url.toString();
  }
}

/** The public origin of this request, derived the same way as requestUrl. */
export function requestOrigin(req: Request): string {
  return new URL(requestUrl(req)).origin;
}

/** Two requirements name the same payment: same scheme, network, amount, asset and recipient. */
export function matchesOurTerms(accepted: PaymentRequirements | undefined, ours: PaymentRequirements): boolean {
  if (!accepted || typeof accepted !== "object") return false;
  return (
    accepted.scheme === ours.scheme &&
    String(accepted.network ?? "") === String(ours.network) &&
    String(accepted.amount ?? "") === ours.amount &&
    typeof accepted.asset === "string" &&
    isSameAddress(accepted.asset, ours.asset) &&
    typeof accepted.payTo === "string" &&
    isSameAddress(accepted.payTo, ours.payTo)
  );
}

/**
 * Runs `call` against each facilitator in turn and returns the first ANSWER, not the first
 * success: a facilitator that cannot be reached is skipped, but one that answers "no" has
 * decided, and its answer is returned. Failover is for outages, never for shopping around
 * until some facilitator says yes.
 */
async function firstThatWorks<T>(call: (client: HTTPFacilitatorClient) => Promise<T>): Promise<T> {
  const failures: string[] = [];
  for (const url of facilitators()) {
    try {
      return await call(new HTTPFacilitatorClient({ url, timeoutMs: FACILITATOR_TIMEOUT_MS }));
    } catch (err) {
      failures.push(`${url}: ${messageOf(err)}`);
    }
  }
  throw new Error(`no facilitator could be reached (${failures.join("; ")})`);
}

export interface ChallengeTerms {
  /** The URL the buyer called, query string included. */
  resourceUrl: string;
  /** One line describing what is being sold; shown in the challenge, not in the wallet. */
  description: string;
  requirement: PaymentRequirements;
}

function challengeFor(terms: ChallengeTerms, error: string): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url: terms.resourceUrl, description: terms.description, mimeType: "application/json" },
    accepts: [terms.requirement],
  };
}

/** The 402: the same terms in the PAYMENT-REQUIRED header and in the body. */
export function send402(terms: ChallengeTerms, error: string): Response {
  const body = challengeFor(terms, error);
  return json(402, body, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) });
}

/**
 * Collect the payment for an already-validated request. Returns a Response (the 402, or a
 * 402 explaining why the credential was refused) when the caller must stop, or the settlement
 * once the facilitator has moved the money. Only after a settlement may the caller answer
 * with the purchased result.
 */
export async function collectPayment(req: Request, terms: ChallengeTerms): Promise<Response | { settled: SettleResponse }> {
  // A HEAD never settles: Next answers HEAD with the GET handler, and a body-less 200 after a
  // settlement would charge the buyer for nothing. The 402 keeps liveness probes working.
  if (req.method === "HEAD") return send402(terms, "Payment required");

  // No credential: answer with our terms. Reading them costs nothing.
  const credentialHeader = req.headers.get("payment-signature");
  if (!credentialHeader) return send402(terms, "Payment required");

  let credential: PaymentPayload;
  try {
    credential = decodePaymentSignatureHeader(credentialHeader);
  } catch {
    return send402(terms, "the PAYMENT-SIGNATURE header could not be decoded");
  }
  // The decoder checks the encoding, not the shape: a header that decodes to null or a list
  // is not a credential either.
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    return send402(terms, "the PAYMENT-SIGNATURE header could not be decoded");
  }

  // The credential must be for the payment we asked for, not for terms of its own.
  if (!matchesOurTerms(credential.accepted, terms.requirement)) {
    return send402(terms, "payment does not match this service's terms");
  }

  // Verify, then settle. Either can say no; only an unreachable facilitator is retried.
  let verified: VerifyResponse;
  try {
    verified = await firstThatWorks((f) => f.verify(credential, terms.requirement));
  } catch (err) {
    return send402(terms, `payment could not be verified: ${messageOf(err)}; nothing was charged`);
  }
  if (!verified.isValid) {
    return send402(terms, verified.invalidReason ?? "the facilitator rejected this payment");
  }

  let settled: SettleResponse;
  try {
    settled = await firstThatWorks((f) => f.settle(credential, terms.requirement));
  } catch (err) {
    return send402(terms, `payment could not be settled: ${messageOf(err)}`);
  }
  if (!settled.success) {
    return send402(terms, settled.errorReason ?? "the payment did not settle");
  }
  return { settled };
}

/** The headers a paid 200 carries: the settlement, encoded for the buyer's records. */
export function paidHeaders(settled: SettleResponse): Record<string, string> {
  return { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) };
}

export function optionsResponse(): Response {
  return new Response(null, { headers: CORS });
}
