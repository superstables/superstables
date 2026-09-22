import { SITE } from "@/lib/site";
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

- [Browse the index](${SITE}/discover): every indexed service, filterable (also as [markdown](${SITE}/discover.md))
- [Try the demo](${SITE}/demo): watch an agent pay a testnet service with the user's approval in MetaMask, then set it up in Claude Desktop, Codex, Claude Code, Cursor or VS Code (also as [markdown](${SITE}/demo.md))
- [Demo feedback](${SITE}/demo-feedback.md): tell us how the demo went
- [List a service](${SITE}/submit.md): form or POST /api/v1/submit; we probe before listing
- [API reference](${SITE}/docs) (also as [markdown](${SITE}/docs.md))
- [Pricing](${SITE}/pricing.md): free, no key, no account
- [About](${SITE}/about.md): what the index is and how it is built
- [Privacy](${SITE}/privacy.md): what is stored and why
- [Contact](${SITE}/contact.md): how to reach us about the index, a listing or your data
- [Homepage as markdown](${SITE}/index.md) (also served at /?mode=agent)

## For agents and developers

- [OpenAPI 3.1 spec](${SITE}/openapi.json): every endpoint, typed responses and errors
- [Authentication](${SITE}/auth.md): none required
- [MCP server card](${SITE}/.well-known/mcp/server-card.json): preview the tools before connecting
- [ARD catalog](${SITE}/.well-known/ard.json): every agentic resource we publish
- [API catalog (RFC 9727)](${SITE}/.well-known/api-catalog)
- [Agent skills index](${SITE}/.well-known/agent-skills/index.json)
- [Source repository](https://github.com/superstables/superstables): plugin.json and mcp.json (Agent Plugins layout), the skill under skills/
- [Whole index as JSONL](${SITE}/feeds/services.jsonl): one schema.org Service per line ([schema map](${SITE}/schemamap.xml))
- [Demo market data, paid (x402, Base Sepolia testnet)](${SITE}/api/demo): self-description of the paid market data endpoint operated for the demo; GET /api/demo/market?asset=BTC answers 402 with its terms and settles test USDC only
- [Demo catalogue](${SITE}/api/demo/catalogue): every paid demo endpoint operated for the demo, with request parameters and prices; ten prepared services under /api/demo/services/<slug> return simulated output, marked as such, and settle test USDC only
- Scoped indexes: [/docs/llms.txt](${SITE}/docs/llms.txt), [/api/llms.txt](${SITE}/api/llms.txt)

The full index is public JSON. No auth, no key, CORS open:

- [GET /api/v1/services](${SITE}/api/v1/services)
    Query params: rail=x402|mpp|acp, chain=base|solana|tempo|robinhood|..., asset=USDC|EURC|USDT|PYUSD|USDG,
    live=true, q=<free text>, limit (1-500), offset.
    Returns { generated_at, counts: { total, live, dual_rail }, page: { limit, offset, next_offset }, services: [...] }.
    Follow page.next_offset until it is null.
- GET /api/v1/services/:id
    One service plus its last 20 liveness probes.
- POST /api/v1/services/batch with {"ids": [...]} (1-100)
    Bulk lookup in one request: { found: [...], missing: [...] }. Also GET ...?ids=a,b,c.
- [GET /api/v1/stats](${SITE}/api/v1/stats)
    The census counts.

Errors are always JSON: { error: { code, message } }. Rate limit: soft 300 requests per
minute, advertised with RateLimit-Limit and RateLimit-Policy headers.

MCP server (streamable HTTP, no auth): ${SITE}/api/mcp
Tools: find_services, get_service, get_stats.

Natural-language endpoint (NLWeb style): GET ${SITE}/ask?query=...
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

${SITE}/submit - we probe before listing.
Or POST {"endpoint","name","contact"} to ${SITE}/api/v1/submit

Contact: https://x.com/superstables
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
