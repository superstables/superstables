import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/**
 * Markdown twin of the homepage: /index.md, and what "/" serves when a client asks for
 * Accept: text/markdown (rewrite in proxy.ts). Starts with the H1, no frontmatter,
 * so it reads as a plain document for the simplest clients.
 */
const BODY = `# Superstables

> The neutral index of payable services for AI agents: every service an agent can pay
> with stablecoins, across every payment rail (x402, MPP, ACP), merged into one
> directory, deduplicated, and independently probed for liveness every few hours.

## What it is

Superstables indexes services (APIs, data feeds, GPU and compute providers, tools and
other agents) that accept programmatic stablecoin payments in USDC, EURC, USDT, PYUSD or
USDG, and on-chain places for idle balances (RWA yield vaults, tokenized stocks and
stablecoin yield) listed next to them. Each HTTP endpoint is probed on a rolling schedule;
a service is live when it answers a valid payment challenge (HTTP 402, a payment-challenge
header, or a challenge body). Superstables indexes and probes; it does not execute or
settle payments.

## Where to start

- [Browse the index](${SITE}/discover)
- [API reference](${SITE}/docs) and its [markdown twin](${SITE}/docs.md)
- [OpenAPI 3.1 spec](${SITE}/openapi.json)
- [llms.txt](${SITE}/llms.txt): the agent-facing index of this site
- [Authentication](${SITE}/auth.md): none required
- [Pricing](${SITE}/pricing.md): free
- [MCP server card](${SITE}/.well-known/mcp/server-card.json)
- [List a service](${SITE}/submit)
- [About](${SITE}/about.md) and [Privacy](${SITE}/privacy.md)

## Endpoints

- \`GET /api/v1/services\`: list services; filters rail, chain, asset, live=true, q, limit, offset
- \`GET /api/v1/services/:id\`: one service plus its last 20 liveness probes
- \`POST /api/v1/services/batch\`: bulk lookup of up to 100 ids in one request
- \`GET /api/v1/stats\`: census counts
- \`POST /api/v1/submit\`: suggest a service for listing (probed before it appears)
- \`GET /ask?query=...\`: natural-language queries, NLWeb style, with optional SSE streaming
- MCP over streamable HTTP at \`/api/mcp\`: tools find_services, get_service, get_stats

No key, no account, CORS open. Soft limit of 300 requests per minute; responses are
CDN-cached for 300 seconds.

## When to use it

Use Superstables when an agent, or a person building one, needs to find something it can
pay for programmatically, check that a payable endpoint is actually alive before calling
it, compare rails, chains and prices across providers, or get census numbers on the
agent-payments ecosystem. Do not use it to execute payments.
`;

export function GET() {
  return new Response(BODY, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "s-maxage=3600",
      Vary: "Accept",
      Link: '<${SITE}/>; rel="canonical`, <${SITE}/>; rel=`alternate"; type="text/html"',
    },
  });
}
