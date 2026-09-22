# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Agent readiness of the site: every content page has a machine-readable twin, the API
documents its errors and limits, and the index is discoverable through the standard files.

### Added

- Ten prepared demo services, paid over x402 with test USDC on Base Sepolia, that sell
  simulated answers (wallet briefing, contract screening, web search, whitepaper extraction,
  specialist research, image creation, audio transcription, product lookup, job search, website
  performance) through one route, `/api/demo/services/<slug>`, on the seller code now shared
  with the market data service (`lib/demoSeller.ts`). Every input is a closed set, every
  output is marked simulated, and a bad request is refused before any payment. The hosted
  catalogue at `/api/demo/catalogue` publishes every paid demo endpoint with its parameters
  for the client's discovery. `npm test` (vitest) covers each service and the route on
  loopback with a fake facilitator.
- Simplified demo feedback presentation with an unframed embedded form.
- Signed Tally webhook for demo feedback: creates a Triage candidate without a
  project, with the exact feedback label, deterministic retry deduplication,
  bounded processing, and no database writes. Requires server-side configuration.
- `/demo-feedback.md`, the markdown twin of the feedback page, with the same `Accept`
  negotiation and `Link` alternate as the other content pages; `GET` on the feedback webhook
  answers a JSON 405; the Privacy page describes demo feedback; `llms.txt` and the API
  catalog list the paid demo endpoint.
- `/demo-feedback`: a feedback form for the testnet payment demo, embedded from Tally with
  an explicit form URL (the page's own query string is never forwarded). Configured in
  `content/demoFeedback.ts`; linked from the footer.
- Markdown twins of the content pages (`/index.md`, `/docs.md`, `/discover.md`, `/submit.md`,
  `/pricing.md`, `/about.md`, `/privacy.md`, `/contact.md`). A client whose `Accept` header
  prefers `text/markdown` is redirected to the twin; `/?mode=agent` serves the markdown
  homepage. Non-browser clients get a short markdown 404 for unknown paths.
- About, Privacy and Contact pages, linked from the footer, the sitemap and `llms.txt`, with
  a short questions-and-answers section that also appears on the homepage.
- `POST /api/v1/services/batch` (and `GET ...?ids=`): read-only lookup of 1-100 services in
  one request, reporting the ids that are missing.
- List responses carry `page { limit, offset, next_offset }`.
- `/feeds/services.jsonl` (the whole index as schema.org `Service` lines), `/schemamap.xml`,
  an Agent Skills index with `/skills/superstables-index/SKILL.md`, scoped `/docs/llms.txt`
  and `/api/llms.txt`, item entries in the RFC 9727 API catalog, and a feed entry in the ARD
  catalog.
- Canonical URLs on content and service pages; structured data for the index as a Dataset
  and a Service, the API as a WebAPI, the questions as an FAQPage, and breadcrumbs on
  service pages.
- `DATABASE_DRIVER=postgres` selects node-postgres for ordinary PostgreSQL (local
  development, private copies). Neon over HTTP stays the default.

### Changed

- Every API error is JSON with the `Error` schema, including database failures (`500`,
  `internal_error`) and `GET` on the submit endpoint (`405`); rate-limit headers are on every
  API response, including 404s. The OpenAPI document describes all of this inline.
- The MCP server returns `instructions`, tolerates absent or wildcard `Accept` headers,
  answers 406 to JSON-only clients, and its manifest and server card carry a display name
  and icon. The manifest is also served at `/.well-known/mcp`, the extensionless path
  agents probe first. `get_stats` takes an optional `rail`.
- `plugin.json`, `mcp.json` and `skills/superstables-index/SKILL.md` in the repository
  (Agent Plugins layout); the served skill is read from that file. ARD entries
  carry a trust manifest; the homepage markdown opens with frontmatter and its structured
  data includes a breadcrumb.
- `robots.txt` is a route handler with the same rules plus the `schemamap:` directive.
- `llms.txt` is a markdown link index; the homepage feature titles are `h2` so the heading
  order is sequential; the pricing page's structured data is a `Service` without an `Offer`.
- Machine-readable surfaces build their absolute URLs from one site origin, which is the
  production domain in production and the deployment's own URL on previews.

## [0.1.0] - 2026-09-18

The first tagged version of the Superstables site: the service index, its API and
read-only MCP server, and, new in this version, a paid demo service that agents can pay on
the Base Sepolia testnet.

### Added

- `/api/demo/market`: a paid x402 endpoint serving spot price and 24h change for BTC or ETH.
  It validates the request before demanding payment, answers 402 with its terms in the
  `PAYMENT-REQUIRED` header and body, checks the buyer's credential against those terms, and
  has a public Base Sepolia facilitator verify and settle the transfer before answering 200
  with a `PAYMENT-RESPONSE` receipt. Test USDC on Base Sepolia only: no real money moves.
- `/api/demo`: free, machine-readable self-description of that service — endpoint, parameters,
  price, network, asset and the address that is paid.
- Configuration: `SUPERSTABLES_DEMO_PAY_TO` (required; the endpoint answers 503 until it is
  set) and `SUPERSTABLES_DEMO_PRICE` (optional, decimal USDC per call, default `0.01`).
