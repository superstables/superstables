// The hosted catalogue: every paid demo endpoint this deployment operates, in the shape the
// Superstables client's discovery uses, so a new service here reaches agents without a client
// release. Free to read, as a seller's terms should be. Each entry carries its closed
// parameter sets, its price and the address that is paid.

import { DEMO_ASSETS, NETWORK, SERVICE_DESCRIPTION, SERVICE_NAME, USDC, payTo, priceDecimal } from "@/lib/demoService";
import { json, optionsResponse, requestOrigin } from "@/lib/demoSeller";
import { DEMO_SERVICES, listing } from "@/lib/demoServices/registry";

export const dynamic = "force-dynamic";

/** The market data service, described the same way as the prepared services. */
function marketListing(origin: string, recipient: string | undefined) {
  const price = priceDecimal();
  return {
    id: "superstables-demo-market-data",
    name: SERVICE_NAME,
    description: `Market data for BTC and ETH, priced per request and paid with test USDC on Base Sepolia: ${SERVICE_DESCRIPTION}.`,
    endpoint: `${origin}/api/demo/market`,
    method: "GET" as const,
    params: [
      { name: "asset", in: "query" as const, required: true, description: "Which asset to return market data for", enum: [...DEMO_ASSETS], example: "BTC" },
    ],
    payment: {
      rail: "x402" as const,
      scheme: "exact" as const,
      network: NETWORK.caip2,
      networkLabel: NETWORK.label,
      asset: USDC.symbol,
      price: { amountDecimal: price, asset: USDC.symbol, display: `${price} ${USDC.symbol} per request` },
      ...(recipient ? { payTo: recipient } : { configured: false }),
    },
    operator: "Superstables (demo service on the testnet)",
    testnet: true,
    mock: false,
    returns: { asset: "string", price_usd: "number|null", change_24h_pct: "number|null", as_of: "ISO 8601", source: "string" },
    example_prompts: ["Find a paid BTC market-data service on Base Sepolia that you can call. Show me its price before I approve any payment."],
  };
}

export function GET(req: Request): Response {
  const origin = requestOrigin(req);
  const recipient = payTo();
  return json(200, {
    generated_at: new Date().toISOString(),
    provider: "Superstables",
    notice:
      "Every service here is operated by Superstables for the demo and paid with test USDC on Base Sepolia; no real money moves. Services marked mock return prepared, simulated output.",
    services: [marketListing(origin, recipient), ...DEMO_SERVICES.map((def) => listing(def, origin, recipient))],
  });
}

export function OPTIONS(): Response {
  return optionsResponse();
}
