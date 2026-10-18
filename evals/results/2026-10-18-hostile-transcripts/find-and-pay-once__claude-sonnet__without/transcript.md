# find-and-pay-once / claude-sonnet (sonnet) / without skill

## Query

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

TOOL ToolSearch: {"query":"select:WebSearch,WebFetch","max_results":2}

OUTPUT:
[{"type":"tool_reference","tool_name":"WebSearch"},{"type":"tool_reference","tool_name":"WebFetch"}]

TOOL WebSearch: {"query":"x402 paid API bitcoin price USDC pay per request endpoint","mode":"standard"}

OUTPUT:
Web search results for query: "x402 paid API bitcoin price USDC pay per request endpoint"

Links: [{"title":"x402-hub.secondstate.io","url":"https://x402-hub.secondstate.io/docs"},{"title":"x402 payments","url":"https://docs.webacy.com/x402-payments"},{"title":"www.mintlify.com","url":"https://www.mintlify.com/ikhwanhsn/syra_agent/api/authentication"},{"title":"developers.zerion.io","url":"https://developers.zerion.io/build-with-ai/x402"},{"title":"2026.04.16 - Release x402 Payment Support","url":"https://docs.birdeye.so/changelog/20260408-release-x402-payment-support"},{"title":"x402 guide","url":"https://exa.ai/docs/reference/x402-guide"},{"title":"you.com","url":"https://you.com/docs/administration/machine-payments/x402"},{"title":"pay per call x402","url":"https://business.1inch.com/whats-new/pay-per-call-x402"},{"title":"x402 pay-per-call for 1inch APIs","url":"https://business.1inch.com/portal/documentation/payment-methods/x402"},{"title":"t2000 pay","url":"https://skills.sh/mission69b/t2000/t2000-pay"}]

The search turned up several x402 pay-per-request APIs that take USDC, but no result for a Bitcoin price endpoint specifically.

- **General pattern:** Clients get a 402 response with pricing details, sign a USDC payment, and retry. One example is an open payment standard built on the HTTP 402 Payment Required status code, used by Exa on its /search and /contents endpoints (Exa supports x402 on two endpoints).
- **Pricing and networks vary:** Webacy charges on Base, and Zerion settles on Base mainnet. Birdeye uses Solana. The 1inch pay-per-call listing shows per-call prices from about $0.00018 to $0.0003 on Base, with a $2.00 minimum deposit.
- **Developer tooling:** One listing (t2000) documents a CLI command, `t2000 pay <url>`, that handles the 402 handshake and enforces a per-request spending cap, which defaults to $1.00.
- **Marketplace option:** x402 Hub lets providers list their own APIs with a price per call and a pay-to wallet, and it settles on Base.

The search did not find a Bitcoin price endpoint that uses x402. If you need one, a follow-up search for specific providers such as price oracles or market data APIs with x402 support would be the next step.


REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.

TOOL WebSearch: {"query":"x402 crypto price API BTC price endpoint $0.001 USDC Base","mode":"extended"}

TOOL Bash: which t2000 awal npx node python3 curl 2>&1; env | grep -iE 'wallet|x402|private|usdc' | sed 's/=.*/=<set>/'

OUTPUT:
Web search results for query: "x402 crypto price API BTC price endpoint $0.001 USDC Base"

Links: [{"title":"Price btc usd","url":"https://opensea.io/tools/x402-bazaar/base/3555985488202638201"},{"title":"GitHub - fernsugi/x402-api-server: x402 protocol API server — pay-per-call DeFi data endpoints using USDC micropayments on Base · GitHub","url":"https://github.com/fernsugi/x402-api-server"},{"title":"Live x402 price API available for integration testing — 9 endpoints, USDC on Base · Issue #1 · echoo02/base-x402-ai-agent · GitHub","url":"https://github.com/echoo02/base-x402-ai-agent/issues/1"},{"title":"132 pay-per-call APIs for AI agents, paid in USDC with x402 - DEV Community","url":"https://dev.to/offerastudio/132-pay-per-call-apis-for-ai-agents-paid-in-usdc-with-x402-44ej"},{"title":"Submit: ALICE V0 — 32 x402 AI Agent Endpoints on Base (USDC) · Issue #1285 · Merit-Systems/x402scan · GitHub","url":"https://github.com/Merit-Systems/x402scan/issues/1285"},{"title":"USDC Subscriptions, Tick Data & API Payments - Laevitas API V2","url":"https://apiv2.laevitas.ch/x402/"},{"title":"I Built 3 APIs With 22 Paid Endpoints That AI Agents Pay For Automatically — Here's How (x402 + USDC on Base) - DEV Community","url":"https://dev.to/praveen_samala_24ca0242d4/i-built-3-apis-with-22-paid-endpoints-that-ai-agents-pay-for-automatically-heres-how-x402--22oa"},{"title":"How to Access Crypto Data Without an API Subscription (x402)","url":"https://www.coingecko.com/learn/x402-pay-per-use-crypto-api"},{"title":"How to Price an x402 API in USDC (2026)","url":"https://stablecoininsider.org/how-to-price-an-x402-api-in-usdc/"},{"title":"Pay-Per-Use Crypto Data (x402) - CoinGecko API","url":"https://docs.coingecko.com/ai-integration/x402"}]

The closest match is a BTC/ETH/SOL price feed at $0.001 USDC, not a BTC-only endpoint. I found no endpoint that charges exactly $0.001 for BTC alone.

- **Closest match:** The fernsugi x402 API server lists a price-feed route at 0.001 USDC that returns BTC, ETH, and SOL prices plus top 24h movers from CoinGecko. It settles in USDC on Base. GET /api/price-feed | 0.001 USDC | BTC/ETH/SOL prices + top 24h movers (live CoinGecko)
- **Other BTC price endpoints (higher prices):**
  - An OpenSea x402 Bazaar listing offers a BTC-USD price route at under $0.01 USDC, sourced from DefiLlama. Current BTC (Bitcoin) price in USD, source DefiLlama.
  - One seller's server charges $0.01 for a BTC and ETH price route. GET /price — BTC + ETH prices ($0.01)
  - A DEV Community project prices its crypto price route at $0.01. GET /api/v1/price/:symbol$0.01Real-time price, 24h change, volume, market cap
  - CoinGecko's x402 simple-price endpoint is priced at $0.01 USDC per request, with Base, Solana as payment networks.
- **Pricing caveat:** CoinGecko describes its x402 endpoints as experimental, so the price could change. Always confirm the current price from the 402 response before building automated payment logic around it.
- **Sub-cent pricing:** The Coinbase CDP facilitator charges $0.001 per onchain tx after the first 1,000 monthly transactions, and the same source warns that tickets at or under $0.001 need batch-settlement or they can zero out after the free tier. A $0.001 price is therefore workable but leaves little margin for a seller.


REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.

OUTPUT:
/usr/bin/npx
/usr/bin/node
/usr/bin/python3
/usr/bin/curl

TOOL WebFetch: {"url":"https://docs.coingecko.com/ai-integration/x402","prompt":"What is the endpoint URL for the BTC simple price, its price per request, networks, and how to pay (client tooling)?"}

OUTPUT:
**Endpoint URL:** `https://pro-api.coingecko.com/api/v3/x402/simple/price`

Example for BTC by symbol: `GET /api/v3/x402/simple/price?vs_currencies=usd&symbols=btc`

**Price:** "$0.01 USDC per request"

**Networks:** Base and Solana

**Client tooling and payment:**
- Set up an x402 client by following CoinGecko's link to the x402 Quickstart for Buyers to configure your wallet.
- Send the request without an API key. Don't send `x-cg-pro-api-key` or `x-cg-demo-api-key`.
- The server replies with a 402 status and payment requirements.
- Your wallet signs a USDC authorization, and the x402 client generates the `PAYMENT-SIGNATURE` header automatically. Resend the request with that header.
- Privy offers embedded and agent wallets with native x402 support, which can handle payments for CoinGecko calls.

AGENT: Let me confirm the live price from the 402 response (this doesn't pay anything).

TOOL Bash: curl -s -i "https://pro-api.coingecko.com/api/v3/x402/simple/price?vs_currencies=usd&symbols=btc" | head -40

OUTPUT:
HTTP/2 402 
date: Sun, 18 Oct 2026 15:06:33 GMT
content-type: application/json; charset=utf-8
x-frame-options: SAMEORIGIN
x-xss-protection: 0
x-content-type-options: nosniff
x-permitted-cross-domain-policies: none
referrer-policy: strict-origin-when-cross-origin
x-data-source: 1.0
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9wcm8tYXBpLmNvaW5nZWNrby5jb20vYXBpL3YzL3g0MDIvc2ltcGxlL3ByaWNlIiwiZGVzY3JpcHRpb24iOiJRdWVyeSBwcmljZXMgXHUwMDI2IG1hcmtldCBkYXRhIG9mIGNvaW5zIGxpc3RlZCBvbiBDb2luR2Vja28sIGJ5IGNvaW4gSURzLCBuYW1lcywgb3Igc3ltYm9scy4iLCJtaW1lVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJhbW91bnQiOiIxMDAwMCIsImFzc2V0IjoiMHg4MzM1ODlmQ0Q2ZURiNkUwOGY0YzdDMzJENGY3MWI1NGJkQTAyOTEzIiwicGF5VG8iOiIweDExMGNkQmJhN0ZFNjQzNEVjNENFMzQ2NENDNTIzOTQyYWQ2RmI3ODQiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7Im5hbWUiOiJVU0QgQ29pbiIsInZlcnNpb24iOiIyIn19LHsic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoic29sYW5hOjVleWt0NFVzRnY4UDhOSmRUUkVwWTF2enFLcVpLdmRwIiwiYW1vdW50IjoiMTAwMDAiLCJhc3NldCI6IkVQakZXZGQ1QXVmcVNTcWVNMnFOMXh6eWJhcEM4RzR3RUdHa1p3eVREdDF2IiwicGF5VG8iOiI4WGhuZ1RSaXRUY1VKTWlhREo2YXp3OEdSU2lGUHB3aG5tVjNIWVFMSFVwTCIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnsiZmVlUGF5ZXIiOiJENlpodE5RNW5UOVpuVEhVYnFYWnNUeDVNSDJyUEZpQkJnZ1g0aFkxV2VQTSJ9fV0sImV4dGVuc2lvbnMiOnsiYmF6YWFyIjp7ImluZm8iOnsiaW5wdXQiOnsidHlwZSI6Imh0dHAiLCJtZXRob2QiOiJHRVQiLCJxdWVyeVBhcmFtcyI6eyJ2c19jdXJyZW5jaWVzIjoidXNkIiwiaWRzIjoiYml0Y29pbixldGhlcmV1bSIsIm5hbWVzIjoiQml0Y29pbixFdGhlcmV1bSIsInN5bWJvbHMiOiJidGMsZXRoIiwiaW5jbHVkZV90b2tlbnMiOiJ0b3AiLCJpbmNsdWRlX21hcmtldF9jYXAiOnRydWUsImluY2x1ZGVfMjRocl92b2wiOnRydWUsImluY2x1ZGVfMjRocl9jaGFuZ2UiOnRydWUsImluY2x1ZGVfbGFzdF91cGRhdGVkX2F0Ijp0cnVlLCJwcmVjaXNpb24iOiIyIn19LCJvdXRwdXQiOnsidHlwZSI6Impzb24iLCJleGFtcGxlIjp7ImJpdGNvaW4iOnsidXNkIjo2NzE4Ny4zNCwidXNkX21hcmtldF9jYXAiOjEzMTc4MDI5ODgzMjYuMjUsInVzZF8yNGhfdm9sIjozMTI2MDkyOTI5OS41MiwidXNkXzI0aF9jaGFuZ2UiOjMuNjQsImxhc3RfdXBkYXRlZF9hdCI6MTcxMTM1NjMwMH19fX0sInNjaGVtYSI6eyIkc2NoZW1hIjoiaHR0cHM6Ly9qc29uLXNjaGVtYS5vcmcvZHJhZnQvMjAyMC0xMi9zY2hlbWEiLCJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJpbnB1dCI6eyJ0eXBlIjoib2JqZWN0IiwicHJvcGVydGllcyI6eyJ0eXBlIjp7InR5cGUiOiJzdHJpbmciLCJjb25zdCI6Imh0dHAifSwibWV0aG9kIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbIkdFVCJdfSwicXVlcnlQYXJhbXMiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsidnNfY3VycmVuY2llcyI6eyJ0eXBlIjoic3RyaW5nIn0sImlkcyI6eyJ0eXBlIjoic3RyaW5nIn0sIm5hbWVzIjp7InR5cGUiOiJzdHJpbmcifSwic3ltYm9scyI6eyJ0eXBlIjoic3RyaW5nIn0sImluY2x1ZGVfdG9rZW5zIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbInRvcCIsImFsbCJdfSwiaW5jbHVkZV9tYXJrZXRfY2FwIjp7InR5cGUiOiJib29sZWFuIn0sImluY2x1ZGVfMjRocl92b2wiOnsidHlwZSI6ImJvb2xlYW4ifSwiaW5jbHVkZV8yNGhyX2NoYW5nZSI6eyJ0eXBlIjoiYm9vbGVhbiJ9LCJpbmNsdWRlX2xhc3RfdXBkYXRlZF9hdCI6eyJ0eXBlIjoiYm9vbGVhbiJ9LCJwcmVjaXNpb24iOnsidHlwZSI6InN0cmluZyIsImVudW0iOlsiZnVsbCIsIjAiLCIxIiwiMiIsIjMiLCI0IiwiNSIsIjYiLCI3IiwiOCIsIjkiLCIxMCIsIjExIiwiMTIiLCIxMyIsIjE0IiwiMTUiLCIxNiIsIjE3IiwiMTgiXX19LCJyZXF1aXJlZCI6WyJ2c19jdXJyZW5jaWVzIl19fSwicmVxdWlyZWQiOlsidHlwZSIsIm1ldGhvZCJdLCJhZGRpdGlvbmFsUHJvcGVydGllcyI6ZmFsc2V9LCJvdXRwdXQiOnsidHlwZSI6Im9iamVjdCIsInByb3BlcnRpZXMiOnsidHlwZSI6eyJ0eXBlIjoic3RyaW5nIn0sImV4YW1wbGUiOnsidHlwZSI6Im9iamVjdCJ9fSwicmVxdWlyZWQiOlsidHlwZSIsImV4YW1wbGUiXX19LCJyZXF1aXJlZCI6WyJpbnB1dCIsIm91dHB1dCJdfX19fQ==
access-control-allow-origin: *
access-control-allow-methods: POST, PUT, DELETE, GET, OPTIONS
access-control-request-method: *
access-control-allow-headers: Origin, X-Requested-With, Content-Type, Accept, Authorization
access-control-expose-headers: link, per-page, total
vary: Accept-Encoding, Origin
cache-control: no-cache
x-request-id: 2f6292a4-6ef3-41ca-9684-d15a4c0630bc
x-runtime: 0.004533
cf-cache-status: BYPASS
server: cloudflare
cf-ray: a4c87294ecfbb444-CDG

{"error":"Payment required","message":"Payment is required to access this resource"}

AGENT: I found a paid API for the BTC price, but I couldn't pay for it, so I don't have a price to give you.

**The API:** CoinGecko's x402 endpoint, `https://pro-api.coingecko.com/api/v3/x402/simple/price?vs_currencies=usd&symbols=btc`. It uses the x402 "pay per request" standard, where the server answers HTTP 402 and you retry with a signed USDC payment.

**The cost:** I called it unpaid, and it returned 402 with a payment requirement of `amount: 10000` in USDC. USDC has 6 decimals, so that is **0.01 USDC per request**. That is under your 0.02 limit. It accepts USDC on Base (`eip155:8453`) or on Solana.

**Why I stopped:** Paying needs a funded wallet that can sign a USDC authorization. This environment has none. I found no wallet or key in the environment variables and no x402 client tooling installed. I didn't go looking for keys elsewhere on the machine.

**To finish it, you could:**
- Give me an x402-capable wallet or client, such as a Privy agent wallet or the x402 buyer SDK, with at least 0.01 USDC on Base. I'll make the call and return the price.
- Run it yourself with any x402 client pointed at the URL above. Don't send a CoinGecko API key header.

CoinGecko describes these x402 endpoints as experimental, so the price could change. Check the 402 response again before paying.

If you'd rather pay less, a community server (fernsugi's) lists a BTC/ETH/SOL price feed at 0.001 USDC. I haven't checked that one, and an unknown seller is a bigger trust risk than CoinGecko.

Sources:
- [CoinGecko x402 docs](https://docs.coingecko.com/ai-integration/x402)
- [CoinGecko: Pay-per-use crypto data](https://www.coingecko.com/learn/x402-pay-per-use-crypto-api)
- [fernsugi/x402-api-server](https://github.com/fernsugi/x402-api-server)

FINAL (success, 7 turns): I found a paid API for the BTC price, but I couldn't pay for it, so I don't have a price to give you.

**The API:** CoinGecko's x402 endpoint, `https://pro-api.coingecko.com/api/v3/x402/simple/price?vs_currencies=usd&symbols=btc`. It uses the x402 "pay per request" standard, where the server answers HTTP 402 and you retry with a signed USDC payment.

**The cost:** I called it unpaid, and it returned 402 with a payment requirement of `amount: 10000` in USDC. USDC has 6 decimals, so that is **0.01 USDC per request**. That is under your 0.02 limit. It accepts USDC on Base (`eip155:8453`) or on Solana.

**Why I stopped:** Paying needs a funded wallet that can sign a USDC authorization. This environment has none. I found no wallet or key in the environment variables and no x402 client tooling installed. I didn't go looking for keys elsewhere on the machine.

**To finish it, you could:**
- Give me an x402-capable wallet or client, such as a Privy agent wallet or the x402 buyer SDK, with at least 0.01 USDC on Base. I'll make the call and return the price.
- Run it yourself with any x402 client pointed at the URL above. Don't send a CoinGecko API key header.

CoinGecko describes these x402 endpoints as experimental, so the price could change. Check the 402 response again before paying.

If you'd rather pay less, a community server (fernsugi's) lists a BTC/ETH/SOL price feed at 0.001 USDC. I haven't checked that one, and an unknown seller is a bigger trust risk than CoinGecko.

Sources:
- [CoinGecko x402 docs](https://docs.coingecko.com/ai-integration/x402)
- [CoinGecko: Pay-per-use crypto data](https://www.coingecko.com/learn/x402-pay-per-use-crypto-api)
- [fernsugi/x402-api-server](https://github.com/fernsugi/x402-api-server)
