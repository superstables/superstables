// What the hosted demo market data service is: one network, one asset, one price. Kept out of
// the route files because both the service (`/api/demo/market`) and its self-description
// (`/api/demo`) have to quote exactly the same terms, and a route file may only export the
// handlers Next.js recognises.
//
// Everything here is testnet: test USDC on Base Sepolia, so no real money ever moves.

import type { PaymentRequirements } from "@x402/core/types";

export const SERVICE_NAME = "Superstables demo market data";
export const SERVICE_DESCRIPTION =
  "a controlled test service operated for the Superstables demo; it charges test USDC on Base Sepolia and moves no real money";
export const RESOURCE_DESCRIPTION =
  "Superstables demo market data: spot price and 24h change for one asset (testnet, no real money)";

/** The assets the demo will price. Anything else is a 400, before any payment is demanded. */
export const DEMO_ASSETS = ["BTC", "ETH"] as const;

/** The one network this demo settles on, and the one asset it charges in. */
export const NETWORK = { caip2: "eip155:84532", label: "Base Sepolia (testnet)", testnet: true } as const;
export const USDC = {
  address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  decimals: 6,
  symbol: "USDC",
  eip712: { name: "USDC", version: "2" },
} as const;

/** What a call costs unless the operator says otherwise. */
export const DEFAULT_PRICE_DECIMAL = 0.01;

/** The decimal price of one call, from the environment, falling back to the default. */
export function priceDecimal(): number {
  const raw = Number(process.env.SUPERSTABLES_DEMO_PRICE);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRICE_DECIMAL;
}

/** Where the test USDC goes, or undefined when this deployment has no demo service configured. */
export function payTo(): string | undefined {
  const value = process.env.SUPERSTABLES_DEMO_PAY_TO?.trim();
  return value ? value : undefined;
}

/** "This much USDC to this address" as an exact x402 v2 requirement any facilitator can settle. */
export function usdcRequirement(amountDecimal: number, recipient: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK.caip2 as PaymentRequirements["network"],
    asset: USDC.address,
    amount: String(Math.round(amountDecimal * 10 ** USDC.decimals)),
    payTo: recipient,
    maxTimeoutSeconds: 300,
    extra: { name: USDC.eip712.name, version: USDC.eip712.version },
  };
}
