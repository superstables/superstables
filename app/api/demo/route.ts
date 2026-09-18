// What the demo market data service is, in machine-readable form: the endpoint, its one
// parameter, what a call costs and how to pay for it. Free to read, as a seller's terms
// should be. The service itself is at /api/demo/market.

import { DEMO_ASSETS, NETWORK, SERVICE_DESCRIPTION, SERVICE_NAME, USDC, payTo, priceDecimal } from "@/lib/demoService";

export const dynamic = "force-dynamic";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE",
  "Cache-Control": "no-store",
};

export function GET(req: Request): Response {
  const price = priceDecimal();
  const recipient = payTo();
  const origin = new URL(req.url).origin;

  const body = {
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    endpoint: `${origin}/api/demo/market`,
    method: "GET",
    params: [
      {
        name: "asset",
        in: "query",
        required: true,
        description: "which asset to price",
        enum: [...DEMO_ASSETS],
        example: "BTC",
      },
    ],
    price: { amountDecimal: price, asset: USDC.symbol, display: `${price} ${USDC.symbol}` },
    payment: {
      rail: "x402",
      scheme: "exact",
      x402Version: 2,
      network: NETWORK.caip2,
      networkLabel: NETWORK.label,
      testnet: NETWORK.testnet,
      // Absent when this deployment has no demo service configured; the endpoint then answers 503.
      ...(recipient ? { payTo: recipient } : { configured: false }),
      asset: { symbol: USDC.symbol, address: USDC.address, decimals: USDC.decimals },
    },
    returns: {
      asset: "string",
      price_usd: "number|null",
      change_24h_pct: "number|null",
      as_of: "ISO 8601",
      source: "string",
    },
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function OPTIONS(): Response {
  return new Response(null, { headers: CORS });
}
