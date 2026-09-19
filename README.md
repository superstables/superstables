# Superstables

Superstables connects service discovery and payments for AI agents. This repository contains the website at [superstables.com](https://www.superstables.com), the service index and its APIs, and an x402 market-data demo.

The index helps developers and agents find services and inspect their payment terms. The demo shows the seller side of a paid request using test USDC on Base Sepolia. A separate, password-gated product preview illustrates planned workflows; it is not a working payment router.

Built with Next.js App Router and TypeScript, without a CSS framework.

## Development

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (also applies pending DB migrations)
npm run lint
```

The build applies pending migrations against `DATABASE_URL` (Neon over HTTP by default). Set `DATABASE_DRIVER=postgres` to run the site and the migrator against an ordinary PostgreSQL instead; the switch is explicit and never inferred from the URL.

## Where things live

| Path | What |
| --- | --- |
| `app/layout.tsx` | Fonts (`next/font`: Bricolage Grotesque, Figtree, JetBrains Mono), metadata / Open Graph |
| `app/globals.css` | The whole design system: dark tokens in `:root`, light tokens under `[data-theme="light"]` / `prefers-color-scheme: light`; code surfaces stay dark in both |
| `app/page.tsx` | Landing section order |
| `components/` | One component per section; `Logo` exports `LogoMark` (dark / light / auto) |
| `content/site.ts` | Editable copy and data: rails, roadmap phases, stats, links |

## Service index

`/discover` collects service listings across x402, MPP and ACP sources. HTTP probes check for payment challenges and record the results. A listing or successful probe does not establish that a service can be paid through the Superstables client.

The JSON API and read-only MCP server expose discovery data. They do not initiate payments.

| Path | What |
| --- | --- |
| `lib/directory/sources.ts` | One fetcher per source: x402 Bazaar (CDP, offset-paginated), x402-list.com, mpp.dev, MPPScan (no feed yet), Binance B402 (no feed yet). Raw blobs always kept in `service_sources.raw`. |
| `lib/directory/normalize.ts` | Chain aliases (CAIP-2), asset map by contract address, price from atomic units, host-level dedupe (dual-rail count comes from this). |
| `lib/directory/probe.ts` | HTTP GET with a crawler User-Agent and an 8s timeout. A successful probe detects HTTP 402, a payment-challenge header or a matching body. Non-HTTP endpoints, including `acp://`, are not probed. |
| `lib/directory/pipeline.ts` | crawl(): ingest -> dedupe -> chunked upserts -> delist-after-7-days. probeBatch(): stalest N, bounded concurrency, probe history rows. |
| `/api/cron/crawl` | Full pipeline; `?probe=only&batch=N&conc=N` for probe-only runs. Auth: `CRON_SECRET` (Vercel env + GH secret). Vercel cron runs it twice daily; `.github/workflows/crawl.yml` pings it every 6 hours. |
| `/api/v1/services`, `/api/v1/services/:id`, `/api/v1/services/batch`, `/api/v1/stats`, `/api/v1/submit` | Public JSON, CORS *, no auth. Field names are a contract; spec at `/openapi.json`. List responses carry `page.next_offset`; batch looks up 1-100 ids. Errors are always `{ error: { code, message } }`. |
| `/api/mcp` | Read-only MCP server: `find_services`, `get_service`, `get_stats`. |
| `/ask` | Natural-language queries (NLWeb style), JSON or SSE. |
| `/discover`, `/s/[id]`, `/submit` | Census hero + filterable table (ISR 300s), service detail with probe history + JSON-LD, vendor self-submit into `submissions` (approve by setting approved=true; joins next crawl). |
| `/about`, `/privacy`, `/contact` | Trust pages rendered from `content/trust.ts`, also served as markdown twins. |
| `/llms.txt`, `/docs/llms.txt`, `/api/llms.txt` | Markdown link index for AI crawlers, plus scoped indexes. |
| `/index.md`, `/docs.md`, `/discover.md`, `/submit.md`, `/pricing.md`, `/about.md`, `/privacy.md`, `/contact.md`, `/auth.md` | Markdown twins of the content pages. `proxy.ts` redirects (303) to the twin when `Accept` prefers `text/markdown` (`lib/negotiate.ts`), so the HTML answer for a page URL never varies and stays CDN-cacheable; `/?mode=agent` selects the markdown homepage. Unmatched paths return a markdown 404 to non-browser clients (`/404.md`). |
| `/feeds/services.jsonl`, `/schemamap.xml` | Whole index as schema.org Service objects, one per line; schema map referenced from `robots.txt` (a route handler, so it can carry the `schemamap:` directive). |
| `plugin.json`, `mcp.json`, `skills/` | Agent Plugins layout: the skill served at `/skills/superstables-index/SKILL.md` is read from `skills/`. |
| `/.well-known/*` | `ard.json`, `api-catalog` (RFC 9727), `mcp` and `mcp.json` (same manifest), `mcp/server-card.json`, `agent-skills/index.json` (digest of `/skills/superstables-index/SKILL.md`). |

## Product preview (review build)

| Path | What |
| --- | --- |
| `/start` | Password gate for the team review. Password comes from `REVIEW_PASSWORD` (set on Vercel; the gate stays closed when unset). `proxy.ts` protects `/app` and `/onboarding` with a signed cookie. |
| `/onboarding` | Sign in, consent, welcome, workspace + first key, connect a wallet, source, done. `components/onboarding/Wizard.tsx`. |
| `/app/*` | Dashboard: overview, API keys, policies, wallets, routing, discovery, earn, settings and the rest. |
| `lib/store.tsx` | Client state persisted to `localStorage`; "Load sample activity" seeds demo transactions. |

The payment workflows in this preview use browser-local state and sample activity. They do not move money. Early-access submissions and the applicants view use a database.

## Early access

- `/early-access`: email plus five qualifying questions (`content/earlyAccess.ts`) and an optional free text. `app/api/early-access/route.ts` upserts one row per email into Postgres.
- After submitting, applicants see their place in line and a personal referral link; position is computed in `lib/line.ts`.
- `/app/applicants` (behind the review gate) lists every submission and exports CSV.
- `/start`, `/onboarding`, `/app`, `/api` and `/brand` are excluded in `robots.txt` and served with `X-Robots-Tag: noindex` by `proxy.ts`.

## Demo market data service (paid, testnet)

This repository includes a market-data service operated by Superstables for the x402 payment demo. It charges test USDC on Base Sepolia and supports BTC and ETH queries. Settlement uses a public facilitator; market prices come from Coinbase. This is a testnet demonstration.

| Path | What |
| --- | --- |
| `/api/demo` | Free self-description: endpoint, parameters, price, network, asset and the address that is paid. |
| `/api/demo/market?asset=BTC\|ETH` | The service. Validates the request first (a bad asset is a 400 that costs nothing), then answers 402 with its terms in the `PAYMENT-REQUIRED` header and body. With a `PAYMENT-SIGNATURE` header it checks the credential against those terms, has a public facilitator verify and settle the transfer, and only then answers 200 with the market-data result and a `PAYMENT-RESPONSE` receipt. The price can be unavailable, as described below. |
| `lib/demoService.ts` | The terms both routes quote: one network (Base Sepolia, `eip155:84532`), one asset (test USDC), one price. |
| `/demo-feedback` | Feedback form for the demo, embedded from Tally. `content/demoFeedback.ts` holds the form id and the fixed hidden-field context (`source`, `environment`, `page`); `lib/tally.ts` builds the embed URL and forwards nothing else. |

Facilitators are the public Base Sepolia ones, tried in order (`facilitator.x402.rs`, `facilitator.payai.network`, `x402.org/facilitator`): connection failures trigger a retry with the next facilitator; a rejection is returned without trying another facilitator. Prices come from Coinbase's keyless spot endpoints with a 5s timeout; if they are down a paid call still answers, with `price_usd: null`, `source: "unavailable"` and a note, because the payment settled either way. CORS is open for GET and both payment headers are exposed.

| Env var | Required | What |
| --- | --- | --- |
| `SUPERSTABLES_DEMO_PAY_TO` | yes | The Base Sepolia address the test USDC is paid to. While it is unset the endpoint answers 503 and charges nothing. |
| `SUPERSTABLES_DEMO_PRICE` | no | Price per call in decimal USDC. Default `0.01`. |
