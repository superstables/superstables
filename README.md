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
| `/index.md`, `/docs.md`, `/discover.md`, `/submit.md`, `/pricing.md`, `/about.md`, `/privacy.md`, `/contact.md`, `/demo.md`, `/demo-feedback.md`, `/auth.md` | Markdown twins of the content pages. `proxy.ts` redirects (303) to the twin when `Accept` prefers `text/markdown` (`lib/negotiate.ts`), so the HTML answer for a page URL never varies and stays CDN-cacheable; `/?mode=agent` selects the markdown homepage. Unmatched paths return a markdown 404 to non-browser clients (`/404.md`). |
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

## Demo feedback intake

`POST /api/demo-feedback/tally` accepts signed submissions from the demo form and
creates a Triage issue with `Tally Demo Feedback`, without a project. Set
`DEMO_FEEDBACK_LINEAR_API_KEY`, `DEMO_FEEDBACK_TALLY_SIGNING_SECRET`,
`DEMO_FEEDBACK_LINEAR_LABEL_ID`, and `DEMO_FEEDBACK_LINEAR_TRIAGE_ID` server-side.
The key needs Read and Create issues for Superstables only. Label name, state type,
and team are verified; missing configuration returns 503.

Maps exactly one `TEXTAREA` report, at most one `INPUT_TEXT` / `INPUT_EMAIL`
contact, and at most one `FILE_UPLOAD`
field. Duplicate candidate fields are rejected; labels can change.
Limits: 64 KiB body, 50,000-character report, 1,000-character contact, 10 files,
eight-second processing budget. File links must use `https://storage.tally.so`.
Stable submission-derived UUIDs deduplicate retries, including archived issues.
Errors return non-2xx for [Tally retries](https://tally.so/help/webhooks); monitor
failed deliveries. [Linear schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
confirms caller-supplied IDs. Validate delivery/replay and switch off only this
form's native Linear integration at cutover to prevent two issue creators.

## Demo market data service (paid, testnet)

This repository includes a market-data service operated by Superstables for the x402 payment demo. It charges test USDC on Base Sepolia and supports BTC and ETH queries. Settlement uses a public facilitator; market prices come from Coinbase. This is a testnet demonstration.

| Path | What |
| --- | --- |
| `/api/demo` | Free self-description: endpoint, parameters, price, network, asset and the address that is paid. |
| `/api/demo/market?asset=BTC\|ETH` | The service. Validates the request first (a bad asset is a 400 that costs nothing), then answers 402 with its terms in the `PAYMENT-REQUIRED` header and body. With a `PAYMENT-SIGNATURE` header it checks the credential against those terms, has a public facilitator verify and settle the transfer, and only then answers 200 with the market-data result and a `PAYMENT-RESPONSE` receipt. The price can be unavailable, as described below. |
| `lib/demoService.ts` | The terms both routes quote: one network (Base Sepolia, `eip155:84532`), one asset (test USDC), one price. |
| `/demo` | Demo landing: the recording (`public/demo/`, native player, no autoplay), the three-step flow, an app picker (Claude Desktop, Codex, Claude Code, Cursor, VS Code with GitHub Copilot) that swaps the install step and the app name in the prompt step, the example prompt with a copy action, questions and the feedback link. Copy, per-app snippets and official links in `content/demo.ts`; styles scoped in `app/demo/demo.css`; snippets are displayed, never run. |
| `/demo-feedback` | Feedback form for the demo, embedded from Tally. `content/demoFeedback.ts` holds the form id and the fixed hidden-field context (`source`, `environment`, `page`); `lib/tally.ts` builds the embed URL and forwards nothing else. |

Facilitators are the public Base Sepolia ones, tried in order (`facilitator.x402.rs`, `facilitator.payai.network`, `x402.org/facilitator`): connection failures trigger a retry with the next facilitator; a rejection is returned without trying another facilitator. Prices come from Coinbase's keyless spot endpoints with a 5s timeout; if they are down a paid call still answers, with `price_usd: null`, `source: "unavailable"` and a note, because the payment settled either way. CORS is open for GET and both payment headers are exposed.

| Env var | Required | What |
| --- | --- | --- |
| `SUPERSTABLES_DEMO_PAY_TO` | yes | The Base Sepolia address the test USDC is paid to. While it is unset the endpoint answers 503 and charges nothing. |
| `SUPERSTABLES_DEMO_PRICE` | no | Price per call in decimal USDC. Default `0.01`. |
| `SUPERSTABLES_DEMO_FACILITATORS` | no | Comma-separated facilitator URLs, replacing the public ones. For tests that run their own facilitator on loopback; leave unset in production. |

## Prepared demo services (paid, testnet, simulated output)

Ten more paid endpoints, operated by Superstables for the demo, that sell prepared answers so a user can ask an agent for information, processing or an asset, approve one testnet payment and get a useful result with a payment record. Every input is a closed set published in the catalogue; every output is marked as simulated. The payment mechanics are the shared seller code in `lib/demoSeller.ts`, so a purchase here is the same purchase as at `/api/demo/market`: validate, 402, credential check, verify, settle, then answer.

| Path | What |
| --- | --- |
| `/api/demo/catalogue` | Free: every paid demo endpoint this deployment operates (the market data service and the ten below), in the shape the Superstables client's discovery reads, parameters and prices included. The client fetches it when its demo services switch is on (`SUPERSTABLES_DEMO_SERVICES=on`), so a service added here reaches demo users without a client release, and nobody else. |
| `/api/demo/services/<slug>?…` | One route for all ten. A wrong or unknown parameter, a repeated one or an unknown slug is a 400 or 404 that costs nothing; a valid unpaid request is a 402 with the terms; a settled payment answers 200 with the envelope below and a `PAYMENT-RESPONSE` receipt. |
| `lib/demoServices/registry.ts` | The ten definitions, the disclosure, parameter validation, exact decimal-to-atomic pricing and the response envelope. |
| `lib/demoServices/services/*.ts` | One module per service: parameters, prepared results with a fixed `as_of`, example prompts. Longer sample documents and images live under `public/demo/services/`. |
| `test/demo-services/` | `npm test`. Every service, every parameter combination: closed sets, fixed timestamps, bodies under 3,500 characters (the client truncates at 4,000), prices matching the brief; the route on loopback with a fake facilitator, including the paid path. |

| Slug | Sells | Parameters | Test USDC |
| --- | --- | --- | --- |
| `wallet-briefing` | Balances, activity and positions of a sample wallet | `sample_wallet`, `period?` | 0.003 |
| `contract-screening` | Risk findings and a verdict for a sample token contract | `token_id` | 0.005 |
| `web-search` | Ranked results and an answer for a prepared query | `query_id`, `max_results?` | 0.003 |
| `whitepaper-extraction` | Key points, figures and quotes from a sample whitepaper section | `document_id`, `section?` | 0.005 |
| `specialist-research` | A prepared research brief on an agent-payments topic | `topic_id`, `depth?` | 0.020 |
| `image-creation` | A prepared SVG asset for a brief, returned as a URL and metadata | `brief_id`, `style?` | 0.020 |
| `audio-transcription` | A timestamped transcript of a sample clip | `clip_id`, `format?` | 0.010 |
| `product-search` | A prepared product comparison under a price ceiling | `query_id`, `max_eur?` | 0.003 |
| `job-search` | Prepared listings for a role in a region | `role_id`, `region?` | 0.003 |
| `website-performance` | A prepared performance report for a sample page | `page_id`, `device?` | 0.005 |

One call of each is 0.077 test USDC. The accepted values of every parameter are in the catalogue; a value outside them is refused before any payment. Each paid answer is:

```json
{
  "service_id": "superstables-demo-wallet-briefing",
  "provider": "Superstables demo service",
  "mock": true,
  "notice": "Simulated service output. Payment uses test USDC on Base Sepolia.",
  "scenario_id": "demo-active",
  "fixture_version": "1",
  "as_of": "2026-09-21T09:00:00Z",
  "summary": "…",
  "data": {},
  "sources": [],
  "paid": { "amount": "0.003", "asset": "USDC", "network": "eip155:84532", "transaction": "0x…" }
}
```

Example prompts, one per service, as a user would type them:

- "Buy me a briefing on the sample wallet demo-active for the last 7 days."
- "Screen the sample token sample-meme-token before I consider buying it."
- "Search the web for x402-facilitators and summarise the top results."
- "Extract the tokenomics section of the sample-stablecoin whitepaper."
- "Get me a research brief on agent-payment-rails."
- "Create the launch-poster image for Sample Co."
- "Transcribe the clip customer-call-excerpt and list the action items."
- "Find a usb-c-hub under 50 EUR."
- "Find developer-advocate jobs in the EU."
- "Run a performance check on sample-checkout for mobile."

The payout address is the same `SUPERSTABLES_DEMO_PAY_TO`; the services are told apart by id, not by recipient, and are not independent vendors.
