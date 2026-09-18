export const dynamic = "force-static";

const BODY = `# Superstables

> The neutral index of payable services for AI agents: every service an agent can pay
> with stablecoins, across every payment rail (x402, MPP, ACP), merged into one
> directory, deduplicated, and independently probed for liveness every few hours.

## When to use Superstables

Use it when an agent (or a person building one) needs to:
- find an API, data feed, GPU/compute provider, tool or another agent that can be PAID
  programmatically with stablecoins (USDC, EURC, USDT, PYUSD, USDG);
- check whether a specific payable endpoint is actually alive before calling it;
- find on-chain places for idle balances: RWA yield vaults, tokenized stocks and
  stablecoin yield, including Robinhood Chain instruments and the Robinhood-backed
  USDG stablecoin;
- compare rails (x402 vs MPP vs ACP), chains and prices across providers;
- get census numbers on the agent-payments ecosystem.

Do not use it to execute payments; Superstables indexes and probes, it does not settle.

## For humans

- [Browse the index](https://www.superstables.com/discover): every indexed service, filterable (also as [markdown](https://www.superstables.com/discover.md))
- [List a service](https://www.superstables.com/submit.md): form or POST /api/v1/submit; we probe before listing
- [API reference](https://www.superstables.com/docs) (also as [markdown](https://www.superstables.com/docs.md))
- [Pricing](https://www.superstables.com/pricing.md): free, no key, no account
- [About](https://www.superstables.com/about.md): what the index is and how it is built
- [Privacy](https://www.superstables.com/privacy.md): what is stored and why
- [Homepage as markdown](https://www.superstables.com/index.md) (also served at /?mode=agent)

## For agents and developers

- [OpenAPI 3.1 spec](https://www.superstables.com/openapi.json): every endpoint, typed responses and errors
- [Authentication](https://www.superstables.com/auth.md): none required
- [MCP server card](https://www.superstables.com/.well-known/mcp/server-card.json): preview the tools before connecting
- [ARD catalog](https://www.superstables.com/.well-known/ard.json): every agentic resource we publish
- [API catalog (RFC 9727)](https://www.superstables.com/.well-known/api-catalog)
- [Agent skills index](https://www.superstables.com/.well-known/agent-skills/index.json)
- [Whole index as JSONL](https://www.superstables.com/feeds/services.jsonl): one schema.org Service per line ([schema map](https://www.superstables.com/schemamap.xml))
- Scoped indexes: [/docs/llms.txt](https://www.superstables.com/docs/llms.txt), [/api/llms.txt](https://www.superstables.com/api/llms.txt)

The full index is public JSON. No auth, no key, CORS open:

- [GET /api/v1/services](https://www.superstables.com/api/v1/services)
    Query params: rail=x402|mpp|acp, chain=base|solana|tempo|robinhood|..., asset=USDC|EURC|USDT|PYUSD|USDG,
    live=true, q=<free text>, limit (1-500), offset.
    Returns { generated_at, counts: { total, live, dual_rail }, page: { limit, offset, next_offset }, services: [...] }.
    Follow page.next_offset until it is null.
- GET /api/v1/services/:id
    One service plus its last 20 liveness probes.
- POST /api/v1/services/batch with {"ids": [...]} (1-100)
    Bulk lookup in one request: { found: [...], missing: [...] }. Also GET ...?ids=a,b,c.
- [GET /api/v1/stats](https://www.superstables.com/api/v1/stats)
    The census counts.

Errors are always JSON: { error: { code, message } }. Rate limit: soft 300 requests per
minute, advertised with RateLimit-Limit and RateLimit-Policy headers.

MCP server (streamable HTTP, no auth): https://www.superstables.com/api/mcp
Tools: find_services, get_service, get_stats.

Natural-language endpoint (NLWeb style): GET https://www.superstables.com/ask?query=...
e.g. /ask?query=live gpu compute on solana - returns schema.org-shaped results.
Add streaming=true for server-sent events. WebMCP in-page tools are registered on
every page for browsers that support navigator.modelContext.

Field names are stable; treat them as a contract. Versioning is in the path (/api/v1);
within a version fields are only added, never renamed or removed.

## What "live" means

We send a GET to every listed HTTP endpoint on a rolling schedule. A service is live when
it answers with HTTP 402, a payment-challenge response header (x402 v2 style), or an
x402/MPP challenge body. Non-HTTP entries (acp://) are listed but marked "not yet probed",
never dead.

## Listing a service

https://www.superstables.com/submit - we probe before listing.
Or POST {"endpoint","name","contact"} to https://www.superstables.com/api/v1/submit

Contact: https://x.com/superstables
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
