// The hosted demo market data service: a small paid endpoint Superstables operates itself, so
// the x402 payment flow can be shown end to end without depending on somebody else's uptime or
// pricing. It charges test USDC on Base Sepolia, so no real money ever moves.
//
// It is a real x402 seller: it answers 402 with its terms, it checks the credential it is
// handed against those terms, and it has a public facilitator verify and settle the transfer
// before it answers. The payment mechanics live in lib/demoSeller.ts and are shared with the
// prepared demo services under /api/demo/services; this file owns only the market data.
//
// Configuration: SUPERSTABLES_DEMO_PAY_TO (required, the Base Sepolia address that is paid)
// and SUPERSTABLES_DEMO_PRICE (optional, decimal USDC per call, default 0.01).

import { DEMO_ASSETS, NETWORK, RESOURCE_DESCRIPTION, payTo, priceDecimal, usdcRequirement } from "@/lib/demoService";
import { collectPayment, json, optionsResponse, paidHeaders, requestUrl } from "@/lib/demoSeller";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UPSTREAM_TIMEOUT_MS = 5_000;

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

  // 2-4. Terms, credential check, verify and settle; anything short of a settlement stops here.
  const paid = await collectPayment(req, { resourceUrl, description: RESOURCE_DESCRIPTION, requirement });
  if (paid instanceof Response) return paid;
  const { settled } = paid;

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
  return json(200, body, paidHeaders(settled));
}

export function OPTIONS(): Response {
  return optionsResponse();
}
