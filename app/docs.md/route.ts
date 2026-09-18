export const dynamic = "force-static";

/** Markdown mirror of /docs for agents that prefer text over HTML. Opens with frontmatter (title, description, canonical, last-updated). */
const BODY = `---
title: Superstables Index API
description: Public JSON API and MCP server for the neutral, liveness-probed index of services AI agents can pay with stablecoins (x402, MPP, ACP). No key, CORS open.
canonical: https://www.superstables.com/docs
last-updated: 2026-09-18
---

# Superstables Index API

Everything on https://www.superstables.com/discover is served by a public JSON API.
No key, no account, CORS open, cached five minutes. Field names are a stable contract.
Machine-readable spec: https://www.superstables.com/openapi.json

## Endpoints

- \`GET /api/v1/services\` - list services. Filters: rail (x402|mpp|acp), chain, asset, live=true, q (free text), limit (1-500), offset.
- \`GET /api/v1/services/:id\` - one service plus its last 20 liveness probes.
- \`POST /api/v1/services/batch\` - bulk lookup: {"ids": [...]} (1-100) returns { found: [...], missing: [...] }. Also \`GET ...?ids=a,b,c\`.
- \`GET /api/v1/stats\` - census counts: total, live, probed, dual-rail, rails.
- \`POST /api/v1/submit\` - submit a service: {"endpoint","name","contact"}. We probe before listing.

## Example

    curl "https://www.superstables.com/api/v1/services?rail=x402&live=true&q=compute&limit=20"

Returns { generated_at, counts: { total, live, dual_rail }, page: { limit, offset, next_offset }, services: [...] }
where each service has id, name, description, rails, chains, assets, price {display, usd},
endpoint, facilitator, live, last_seen_live, sources.

## Batch lookup

    curl -X POST https://www.superstables.com/api/v1/services/batch \\
      -H "Content-Type: application/json" -d '{"ids":["10x402.com","example.invalid"]}'

Read-only. Up to 100 ids per request; ids are case-insensitive and duplicates are ignored.
The response lists the records found (same shape as the list endpoint, without probe history)
and the ids that are not in the index, so a list of endpoints reconciles in one round trip.

## Whole index as a feed

    curl https://www.superstables.com/feeds/services.jsonl

Newline-delimited JSON, one schema.org Service object per line for every indexed service
(payment rails, chains, assets, liveness and price in additionalProperty). Listed in the
schema map at https://www.superstables.com/schemamap.xml, referenced from robots.txt.

## Pagination

Offset-based. Pass \`limit\` (1-500, default 100) and \`offset\` (default 0). Every list
response includes \`page.next_offset\`: pass it as the next \`offset\`, and stop when it is null.

## Errors

Every 4xx/5xx is JSON, never HTML: \`{ "error": { "code": "...", "message": "..." } }\`.
Codes are stable: not_found, invalid_endpoint, invalid_json, invalid_ids, missing_query, rate_limited,
internal_error. Unknown API paths return 404 with the list of paths that do exist.

## Rate limits

Soft advisory limit of 300 requests per minute per client, advertised on every response
with \`RateLimit-Limit: 300\` and \`RateLimit-Policy: 300;w=60\`. A 429 carries Retry-After.
Responses are CDN-cached for 300 seconds, so polling faster returns the same data.

## Testing safely

The catalogue list, detail, batch lookup, stats, JSONL feed, /ask endpoint and MCP tools only read
the index. They do not make payments or probe the listed endpoints.

POST /api/v1/submit writes to the moderation queue and immediately probes the submitted URL.
Nothing is published automatically; repeated submissions of the same endpoint within 24 hours
are deduplicated. Do not use submission, early-access forms or administrative crawl jobs as
read-only checks. Use a disposable private environment to test write operations.

## Versioning

The version is the path prefix (/api/v1). Within a version fields are only added, never
renamed or removed. Nothing is deprecated today.

## Ask in natural language

    curl "https://www.superstables.com/ask?query=live%20gpu%20compute%20on%20solana"

NLWeb-style: returns { query, interpreted, summary, results[] } with schema.org
objects. Add streaming=true for server-sent events.

## MCP server

Streamable HTTP, no auth: https://www.superstables.com/api/mcp
For POST requests, use \`Accept: application/json, text/event-stream\` and handle either response
format. An absent Accept header or \`*/*\` permits both formats. JSON-only clients are not supported;
unsupported Accept headers receive HTTP 406.
Tools: find_services, get_service, get_stats.
Server card: https://www.superstables.com/.well-known/mcp/server-card.json

## What "live" means

We GET every listed HTTP endpoint on a rolling schedule. A service is live when it answers
with HTTP 402, a payment-challenge response header (x402 v2 style), or a challenge body.
Non-HTTP entries (acp://) are listed but never marked dead. Probe history is kept forever.

## Authentication

None required. See https://www.superstables.com/auth.md

Contact: https://x.com/superstables
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
