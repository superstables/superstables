---
name: superstables-index
description: "When to use: an agent needs to find a service it can pay with stablecoins (x402, MPP, ACP), check that a payable endpoint is live before calling it, compare rails, chains or prices, or get census numbers on agent payments. Free Superstables index over REST or MCP; not for executing payments."
---

# Superstables index

Superstables is the neutral, liveness-probed index of services an AI agent can pay with
stablecoins (USDC, EURC, USDT, PYUSD, USDG) over x402, MPP or ACP. It indexes and probes; it
never executes payments. No key, no account, CORS open.

## When to use this skill

- The task needs an API, data feed, GPU or compute provider, tool or agent that can be paid
  programmatically with stablecoins.
- You have a payable endpoint and want to know whether it is actually alive before calling it.
- You need to compare rails (x402 vs MPP vs ACP), chains or prices across providers.
- You need census numbers on the agent-payments ecosystem.

Do not use it to execute or settle a payment.

## REST

    GET https://www.superstables.com/api/v1/services?rail=x402&live=true&q=compute&limit=20

Filters: rail (x402|mpp|acp), chain, asset, live=true, q (free text), limit (1-500), offset.
Response: { generated_at, counts, page: { limit, offset, next_offset }, services: [...] }.
Follow page.next_offset until it is null.

    GET https://www.superstables.com/api/v1/services/{id}      one service plus its last 20 probes
    POST https://www.superstables.com/api/v1/services/batch    {"ids": [...]} up to 100 ids -> { found, missing }
    GET https://www.superstables.com/api/v1/stats              census counts

Errors are JSON: { error: { code, message } }. Soft limit 300 requests per minute
(RateLimit-Limit, RateLimit-Policy headers). Spec: https://www.superstables.com/openapi.json

## MCP

Streamable HTTP, no auth: https://www.superstables.com/api/mcp
Tools: find_services (q, rail, chain, asset, live_only, limit), get_service (id), get_stats (rail, optional).
Server card: https://www.superstables.com/.well-known/mcp/server-card.json

## Reading a service record

- live: true = answered a valid payment challenge on the last probe; false = did not;
  null = not yet probed (non-HTTP entries such as acp://).
- rails, chains, assets tell you how it can be paid; price.usd is the advertised price when known.
- endpoint is the URL that answers the payment challenge.

More: https://www.superstables.com/llms.txt and https://www.superstables.com/docs.md
