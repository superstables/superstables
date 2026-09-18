// The hosted demo market data service: a small paid endpoint Superstables operates itself, so
// the x402 payment flow can be shown end to end without depending on somebody else's uptime or
// pricing. It charges test USDC on Base Sepolia, so no real money ever moves.
//
// It is a real x402 seller: it answers 402 with its terms, it checks the credential it is
// handed against those terms, and it has a public facilitator verify and settle the transfer
// before it answers.
//
// Two ordering rules are load bearing:
//   1. the request is validated BEFORE any payment is demanded, so a buyer never pays for a
//      400. A seller that charges first and validates second is a seller that steals.
//   2. the service answers only after the facilitator reports the transfer settled, so the
//      buyer's PAYMENT-RESPONSE header always describes a settlement that actually happened.
//
// Configuration: SUPERSTABLES_DEMO_PAY_TO (required, the Base Sepolia address that is paid)
// and SUPERSTABLES_DEMO_PRICE (optional, decimal USDC per call, default 0.01).

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
import { DEMO_ASSETS, NETWORK, RESOURCE_DESCRIPTION, payTo, priceDecimal, usdcRequirement } from "@/lib/demoService";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Public Base Sepolia facilitators, tried in this order. They submit the transfer and pay the gas. */
const FACILITATORS = [
  "https://facilitator.x402.rs",
  "https://facilitator.payai.network",
  "https://x402.org/facilitator",
] as const;

const FACILITATOR_TIMEOUT_MS = 20_000;
const UPSTREAM_TIMEOUT_MS = 5_000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE, Content-Type",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  "Cache-Control": "no-store",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

function messageOf(err: unknown): string {
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
function requestUrl(req: Request): string {
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

/** Two requirements name the same payment: same scheme, network, amount, asset and recipient. */
function matchesOurTerms(accepted: PaymentRequirements | undefined, ours: PaymentRequirements): boolean {
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
  for (const url of FACILITATORS) {
    try {
      return await call(new HTTPFacilitatorClient({ url, timeoutMs: FACILITATOR_TIMEOUT_MS }));
    } catch (err) {
      failures.push(`${url}: ${messageOf(err)}`);
    }
  }
  throw new Error(`no facilitator could be reached (${failures.join("; ")})`);
}

interface SpotPrice {
  usd: number | null;
  at: string;
  change24hPct: number | null;
  source: "live" | "unavailable";
}

/** Percent change from `previous` to `current`, rounded to two decimals; null when undefined. */
function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/** One read of Coinbase's public, keyless spot endpoint. No key, no account, short timeout. */
async function spot(pair: string, date?: string): Promise<number | null> {
  const base = `https://api.coinbase.com/v2/prices/${pair}/spot`;
  const res = await fetch(date ? `${base}?date=${date}` : base, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstream answered ${res.status}`);
  const body = (await res.json()) as { data?: { amount?: string } };
  const amount = Number(body?.data?.amount);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * The spot price of one asset. The buyer has paid by the time this runs, so a data outage is
 * reported, never thrown: a paid call always gets an answer, even when it is "no price".
 */
async function priceFor(asset: string): Promise<SpotPrice> {
  const now = Date.now();
  const at = new Date(now).toISOString();
  try {
    const usd = await spot(`${asset}-USD`);
    if (usd === null) return { usd: null, at, change24hPct: null, source: "unavailable" };
    // The historical read is a bonus: if it fails, the price is still worth serving.
    const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const before = await spot(`${asset}-USD`, yesterday).catch(() => null);
    return { usd, at, change24hPct: percentChange(usd, before), source: "live" };
  } catch {
    return { usd: null, at, change24hPct: null, source: "unavailable" };
  }
}

function challengeFor(resourceUrl: string, error: string, requirement: PaymentRequirements): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: RESOURCE_DESCRIPTION, mimeType: "application/json" },
    accepts: [requirement],
  };
}

/** The 402: the same terms in the PAYMENT-REQUIRED header and in the body. */
function send402(resourceUrl: string, error: string, requirement: PaymentRequirements): Response {
  const body = challengeFor(resourceUrl, error, requirement);
  return json(402, body, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body) });
}

export async function GET(req: Request): Promise<Response> {
  const resourceUrl = requestUrl(req);

  // 1. Validate first. A buyer must never be charged for a request we were going to refuse.
  const raw = new URL(req.url).searchParams.get("asset");
  const asset = (raw ?? "").trim().toUpperCase();
  if (!raw || !raw.trim()) {
    return json(400, { error: "the asset parameter is required", allowed: [...DEMO_ASSETS] });
  }
  if (!(DEMO_ASSETS as readonly string[]).includes(asset)) {
    return json(400, { error: `unknown asset "${raw}"`, allowed: [...DEMO_ASSETS] });
  }

  const recipient = payTo();
  if (!recipient) {
    return json(503, {
      error: "the demo market data service is not configured on this deployment",
      detail:
        "SUPERSTABLES_DEMO_PAY_TO is unset, so there is no address for the payment to go to and nothing may be charged.",
    });
  }

  const price = priceDecimal();
  const requirement = usdcRequirement(price, recipient);

  // 2. No credential: answer with our terms. Reading them costs nothing.
  const credentialHeader = req.headers.get("payment-signature");
  if (!credentialHeader) return send402(resourceUrl, "Payment required", requirement);

  let credential: PaymentPayload;
  try {
    credential = decodePaymentSignatureHeader(credentialHeader);
  } catch {
    return send402(resourceUrl, "the PAYMENT-SIGNATURE header could not be decoded", requirement);
  }

  // 3. The credential must be for the payment we asked for, not for terms of its own.
  if (!matchesOurTerms(credential.accepted, requirement)) {
    return send402(resourceUrl, "payment does not match this service's terms", requirement);
  }

  // 4. Verify, then settle. Either can say no; only an unreachable facilitator is retried.
  let verified: VerifyResponse;
  try {
    verified = await firstThatWorks((f) => f.verify(credential, requirement));
  } catch (err) {
    return send402(resourceUrl, `payment could not be verified: ${messageOf(err)}; nothing was charged`, requirement);
  }
  if (!verified.isValid) {
    return send402(resourceUrl, verified.invalidReason ?? "the facilitator rejected this payment", requirement);
  }

  let settled: SettleResponse;
  try {
    settled = await firstThatWorks((f) => f.settle(credential, requirement));
  } catch (err) {
    return send402(resourceUrl, `payment could not be settled: ${messageOf(err)}`, requirement);
  }
  if (!settled.success) {
    return send402(resourceUrl, settled.errorReason ?? "the payment did not settle", requirement);
  }

  // 5. Paid. From here the buyer gets an answer whatever the upstream data feed is doing.
  const spotPrice = await priceFor(asset);
  const body: Record<string, unknown> = {
    asset,
    price_usd: spotPrice.usd,
    change_24h_pct: spotPrice.change24hPct,
    as_of: spotPrice.at,
    source: spotPrice.source,
    paid: {
      amount: String(price),
      asset: "USDC",
      network: NETWORK.caip2,
      transaction: settled.transaction,
    },
  };
  if (spotPrice.usd === null) {
    body.note = "the payment settled; the upstream price feed was unavailable, so there is no price for this call";
  }
  return json(200, body, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) });
}

export function OPTIONS(): Response {
  return new Response(null, { headers: CORS });
}
