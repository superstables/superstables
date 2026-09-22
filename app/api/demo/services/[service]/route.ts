// The prepared demo services: one route for all of them. Which service is being called comes
// from the path; what it sells, what it accepts and what it answers come from the registry.
// The payment mechanics are the shared seller code, so a purchase here is the same purchase
// as at /api/demo/market: validate, 402, credential check, verify, settle, then answer.
//
// Configuration: SUPERSTABLES_DEMO_PAY_TO (required, the Base Sepolia address that is paid).

import { payTo } from "@/lib/demoService";
import { collectPayment, json, optionsResponse, paidHeaders, requestOrigin, requestUrl } from "@/lib/demoSeller";
import { NETWORK } from "@/lib/demoService";
import { bySlug, describe, envelope, requirementFor, validate } from "@/lib/demoServices/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ service: string }> };

export async function GET(req: Request, context: Context): Promise<Response> {
  const { service: slug } = await context.params;
  const def = bySlug(slug);
  if (!def) return json(404, { error: `no demo service is called "${slug}"`, catalogue: `${requestOrigin(req)}/api/demo/catalogue` });

  // 1. Validate first. A buyer must never be charged for a request we were going to refuse.
  const checked = validate(def, new URL(req.url).searchParams);
  if (!checked.ok) return json(checked.status, { error: checked.error, allowed: checked.allowed });

  const recipient = payTo();
  if (!recipient) {
    return json(503, {
      error: `the ${def.name} demo service is not configured on this deployment`,
      detail:
        "SUPERSTABLES_DEMO_PAY_TO is unset, so there is no address for the payment to go to and nothing may be charged.",
    });
  }

  // 2-4. Terms, credential check, verify and settle; anything short of a settlement stops here.
  const requirement = requirementFor(def, recipient);
  const paid = await collectPayment(req, { resourceUrl: requestUrl(req), description: describe(def), requirement });
  if (paid instanceof Response) return paid;
  const { settled } = paid;

  // 5. Paid. The prepared result never depends on anything that can be down.
  const result = def.resultFor(checked.params);
  const body = envelope(def, result, requestOrigin(req), {
    amount: def.price,
    asset: "USDC",
    network: NETWORK.caip2,
    transaction: settled.transaction,
  });
  return json(200, body, paidHeaders(settled));
}

export function OPTIONS(): Response {
  return optionsResponse();
}
