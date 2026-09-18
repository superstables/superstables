# Superstables

Superstables is the payment router for AI agents. This repo is the site at [superstables.com](https://www.superstables.com): the marketing pages, the live index of payable services (Phase 0), and a password-gated product preview. Next.js (App Router) + TypeScript, no CSS framework.

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build (also applies pending DB migrations)
npm run lint
```

## Where things live

| Path | What |
| --- | --- |
| `app/layout.tsx` | Fonts (`next/font`: Bricolage Grotesque, Figtree, JetBrains Mono), metadata / Open Graph |
| `app/globals.css` | The whole design system: dark tokens in `:root`, light tokens under `[data-theme="light"]` / `prefers-color-scheme: light`; code surfaces stay dark in both |
| `app/page.tsx` | Landing section order |
| `components/` | One component per section; `Logo` exports `LogoMark` (dark / light / auto) |
| `content/site.ts` | Editable copy and data: rails, roadmap phases, stats, links |

## The index (Phase 0, live)

`/discover` is a liveness-probed index of every service an AI agent can pay with stablecoins, across x402, MPP and ACP.

| Path | What |
| --- | --- |
| `lib/directory/sources.ts` | One fetcher per source: x402 Bazaar (CDP, offset-paginated), x402-list.com, mpp.dev, MPPScan (no feed yet), Binance B402 (no feed yet). Raw blobs always kept in `service_sources.raw`. |
| `lib/directory/normalize.ts` | Chain aliases (CAIP-2), asset map by contract address, price from atomic units, host-level dedupe (dual-rail count comes from this). |
| `lib/directory/probe.ts` | GET with honest UA, 8s timeout. Live = HTTP 402 OR payment-challenge header (x402 v2) OR challenge body. acp:// never marked dead. |
| `lib/directory/pipeline.ts` | crawl(): ingest -> dedupe -> chunked upserts -> delist-after-7-days. probeBatch(): stalest N, bounded concurrency, probe history rows. |
| `/api/cron/crawl` | Full pipeline; `?probe=only&batch=N&conc=N` for probe-only runs. Auth: `CRON_SECRET` (Vercel env + GH secret). Vercel cron runs it twice daily; `.github/workflows/crawl.yml` pings it every 6 hours. |
| `/api/v1/services`, `/api/v1/services/:id`, `/api/v1/stats`, `/api/v1/submit` | Public JSON, CORS *, no auth. Field names are a contract; spec at `/openapi.json`. |
| `/api/mcp` | Read-only MCP server: `find_services`, `get_service`, `get_stats`. |
| `/ask` | Natural-language queries (NLWeb style), JSON or SSE. |
| `/discover`, `/s/[id]`, `/submit` | Census hero + filterable table (ISR 300s), service detail with probe history + JSON-LD, vendor self-submit into `submissions` (approve by setting approved=true; joins next crawl). |
| `/llms.txt`, `/docs.md`, `/auth.md`, `/pricing.md`, `/.well-known/*` | Plain-text and machine-readable surfaces for AI crawlers and agents. |

## Product preview (review build)

| Path | What |
| --- | --- |
| `/start` | Password gate for the team review. Password comes from `REVIEW_PASSWORD` (set on Vercel; the gate stays closed when unset). `proxy.ts` protects `/app` and `/onboarding` with a signed cookie. |
| `/onboarding` | Sign in, consent, welcome, workspace + first key, connect a wallet, source, done. `components/onboarding/Wizard.tsx`. |
| `/app/*` | Dashboard: overview, API keys, policies, wallets, routing, discovery, earn, settings and the rest. |
| `lib/store.tsx` | Client state persisted to `localStorage`; "Load sample activity" seeds demo transactions. |

Nothing in the review build moves money or talks to a backend; every action is local to the browser.

## Early access

- `/early-access`: email plus five qualifying questions (`content/earlyAccess.ts`) and an optional free text. `app/api/early-access/route.ts` upserts one row per email into Postgres.
- After submitting, applicants see their place in line and a personal referral link; position is computed in `lib/line.ts`.
- `/app/applicants` (behind the review gate) lists every submission and exports CSV.
- `/start`, `/onboarding`, `/app`, `/api` and `/brand` are excluded in `robots.txt` and served with `X-Robots-Tag: noindex` by `proxy.ts`.

## Demo market data service (paid, testnet)

A small x402 seller we run ourselves, so the payment flow can be demonstrated end to end without depending on anybody else's uptime or pricing. It charges test USDC on Base Sepolia: no real money moves.

| Path | What |
| --- | --- |
| `/api/demo` | Free self-description: endpoint, parameters, price, network, asset and the address that is paid. |
| `/api/demo/market?asset=BTC\|ETH` | The service. Validates the request first (a bad asset is a 400 that costs nothing), then answers 402 with its terms in the `PAYMENT-REQUIRED` header and body. With a `PAYMENT-SIGNATURE` header it checks the credential against those terms, has a public facilitator verify and settle the transfer, and only then answers 200 with the price and a `PAYMENT-RESPONSE` receipt. |
| `lib/demoService.ts` | The terms both routes quote: one network (Base Sepolia, `eip155:84532`), one asset (test USDC), one price. |

Facilitators are the public Base Sepolia ones, tried in order (`facilitator.x402.rs`, `facilitator.payai.network`, `x402.org/facilitator`): one that cannot be reached is skipped, one that answers "no" has decided. Prices come from Coinbase's keyless spot endpoints with a 5s timeout; if they are down a paid call still answers, with `price_usd: null`, `source: "unavailable"` and a note, because the payment settled either way. CORS is open for GET and both payment headers are exposed.

| Env var | Required | What |
| --- | --- | --- |
| `SUPERSTABLES_DEMO_PAY_TO` | yes | The Base Sepolia address the test USDC is paid to. While it is unset the endpoint answers 503 and charges nothing. |
| `SUPERSTABLES_DEMO_PRICE` | no | Price per call in decimal USDC. Default `0.01`. |

## Database

Neon Postgres via the Vercel Marketplace; `DATABASE_URL` is injected by Vercel. Drizzle ORM over the Neon HTTP driver (`lib/db/`). Migrations live in `drizzle/` and are applied by `scripts/migrate.mjs` at the start of every build.

Workflow: edit `lib/db/schema.ts`, `npm run db:generate`, commit the new file in `drizzle/`, push. `vercel env pull .env.local` gives you the local connection string; `npm run db:studio` opens a browser for the data.

## Analytics

Google Analytics 4 via `@next/third-parties`, loaded only on public pages (`components/Analytics.tsx`). Set `NEXT_PUBLIC_GA_ID` in Vercel env.

## Brand

Social card is generated by `app/opengraph-image.tsx` (brand fonts bundled in `assets/fonts/`, all SIL Open Font License). Favicon is `app/icon.svg`; brand assets live in `public/brand/` and are previewed at `/brand`.
