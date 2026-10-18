# find-and-pay-once / claude-opus (opus) / without skill

## Query

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

TOOL Bash: ls -la; ls ~; env | grep -iE 'x402|wallet|key|usdc|private|rpc' | sed 's/=.*/=<redacted>/'; which x402 cdp node python3 2>/dev/null

OUTPUT:
Exit code 1
total 8
drwxrwxr-x 2 alladin alladin 4096 Oct 18 15:06 .
drwxrwxr-x 7 alladin alladin 4096 Oct 18 15:06 ..
/usr/bin/node
/usr/bin/python3

TOOL Bash: ls -a ~ ~/.claude 2>/dev/null; ls ~/.config 2>/dev/null; npm ls -g 2>/dev/null | head -30; pip list 2>/dev/null | grep -iE 'x402|web3|eth|cdp'

TOOL ToolSearch: {"query":"select:WebSearch,WebFetch","max_results":2}

OUTPUT:
/home/alladin/.cache/ev-runs/r-a706ecc28a/fakehome:
.
..
.cache
.claude
.claude.json

/home/alladin/.cache/ev-runs/r-a706ecc28a/fakehome/.claude:
.
..
.claude.json
.credentials.json
.last-cleanup
backups
plugins
projects
session-env
sessions
settings.json
shell-snapshots
skills
/usr/local/lib
└── (empty)

OUTPUT:
[{"type":"tool_reference","tool_name":"WebSearch"},{"type":"tool_reference","tool_name":"WebFetch"}]

TOOL WebSearch: {"query":"x402 paid API bitcoin price endpoint USDC","mode":"standard"}

OUTPUT:
Web search results for query: "x402 paid API bitcoin price endpoint USDC"

Links: [{"title":"x402 Payment API","url":"https://robtex.com/en/x402"},{"title":"x402 Payment API","url":"https://rbls.org/en/x402"},{"title":"pay for service","url":"https://docs.cdp.coinbase.com/agentic-wallet/skills/pay-for-service"},{"title":"> ## Documentation Index","url":"https://docs.base.org/agents/guides/x402-payments.md"},{"title":"> ## Documentation Index","url":"https://docs.cdp.coinbase.com/agentic-wallet/cli/skills/pay-for-service.md"},{"title":"simmer x402","url":"https://skills.cat/skills/spartanlabsxyz/simmer-sdk/simmer-x402"},{"title":"www.mintlify.com","url":"https://www.mintlify.com/ikhwanhsn/syra_agent/api/authentication"},{"title":"x402 Payment API","url":"https://rtsak.com/en/x402"},{"title":"x402 Payment API","url":"https://dns.ninja/en/x402"}]

The search didn't turn up a dedicated x402 bitcoin price endpoint from an official provider, but it did surface a few relevant pieces.

- **CoinGecko via x402:** A third-party agent skill lists a CoinGecko price call for bitcoin, priced at $0.01 per request, on a CoinGecko Pro API x402 route. The URL is cut off in the result, so check CoinGecko's own docs for the exact path and current pricing. Fetch CoinGecko price data ($0.01 via x402)
- **How the payment flow works:** The generic x402 pattern is that a server answers an unpaid request with HTTP 402 and payment requirements. The client signs a USDC payment on Base, attaches it as an X-Payment header, and retries — the server verifies, delivers data, and settles the payment.
- **Other USDC-priced x402 APIs:** Robtex runs an x402 API on Base with per-query pricing, mostly $0.001 to $0.005, and no minimums, no subscriptions. This is a DNS and network data service, not a price feed, but it shows the pattern.
- **Coinbase tooling:** Coinbase's CDP agentic wallet CLI can pay x402 endpoints automatically. It takes a --max-amount cap in USDC atomic units, where 1000000 equals $1.00. Wallet must have sufficient USDC balance.
- **Base's MCP flow:** Base's guide describes a two-step flow in which the request is prepared first, then the payment is approved through a link before completion. It passes the HTTPS URL, HTTP method, optional JSON body or headers, and a `maxPayment` cap in USDC.

Suggested next step: search for the CoinGecko x402 documentation directly to confirm the endpoint path, network (Base or Solana), and price.


REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.

TOOL WebSearch: {"query":"CoinGecko x402 simple price endpoint pro-api x402","mode":"standard"}

OUTPUT:
Web search results for query: "CoinGecko x402 simple price endpoint pro-api x402"

Links: [{"title":"docs.coingecko.com","url":"https://docs.coingecko.com/ai-integration/x402"},{"title":"> ## Documentation Index","url":"https://docs.coingecko.com/ai-integration/x402.md"},{"title":"CoinGecko turns crypto market data into an onchain, pay‑per‑use utility with x402","url":"https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402"},{"title":"Instant Access to Crypto Prices & Market Data with x402","url":"https://coingecko.com/en/api/x402"},{"title":"docs.coingecko.com","url":"https://docs.coingecko.com/docs/x402"},{"title":"docs.coingecko.com","url":"https://docs.coingecko.com/docs/ai-agent-hub/x402"},{"title":"Power AI Agents with","url":"https://coinmarketcap.com/api/it/x402/"},{"title":"Power AI Agents with","url":"https://coinmarketcap.com/api/ko/x402/"},{"title":"Power AI Agents with","url":"https://coinmarketcap.com/api/ar/x402/"},{"title":"Power AI Agents with","url":"https://coinmarketcap.com/api/nl/x402/"}]

The CoinGecko docs list Simple Price as an x402-enabled endpoint at `/x402/simple/price`, so the full URL is `https://pro-api.coingecko.com/api/v3/x402/simple/price`. All parameters from the Pro API are supported, and each endpoint's reference page covers the details.

Key points:
- **Access:** You request the x402 path, and the server replies with a 402 and payment requirements. Your wallet then signs a USDC authorization and resends the request with a PAYMENT-SIGNATURE header. No API key is required for x402 requests, and you should not send the pro or demo key headers.
- **Pricing:** The price is $0.01 USDC per request for all supported endpoints, on Base and Solana. The docs warn that you should check the latest pricing in the 402 response when generating the payment header.
- **Stability:** CoinGecko labels these endpoints experimental, and features, pricing, and availability may change without notice. For production systems, the docs recommend the standard subscription endpoints.

I did not find the Simple Price parameter list or a sample response for this specific endpoint in these results. The reference page for that endpoint would have them.


REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.

AGENT: Found one. Let me probe it to see the actual payment requirements.

TOOL Bash: curl -s -i "https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=bitcoin&vs_currencies=usd" | head -40

OUTPUT:
HTTP/2 402 
date: Sun, 18 Oct 2026 15:07:16 GMT
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
x-request-id: 6f3059a5-263e-42da-b284-da06b678c67f
x-runtime: 0.004802
cf-cache-status: BYPASS
server: cloudflare
cf-ray: a4c873a56bb001c7-CDG

{"error":"Payment required","message":"Payment is required to access this resource"}

TOOL Bash: curl -s -D - -o /dev/null "https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=bitcoin&vs_currencies=usd" | grep -i '^payment-required' | cut -d' ' -f2 | tr -d '\r' | base64 -d | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(a["network"],a["amount"],a["asset"],a["payTo"]) for a in d["accepts"]]'

OUTPUT:
eip155:8453 10000 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784
solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp 10000 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 8XhngTRitTcUJMiaDJ6azw8GRSiFPpwhnmV3HYQLHUpL

AGENT: I found a paid API that fits your limit, but I couldn't pay for it, so I don't have the BTC price for you.

**The API:** CoinGecko's x402 Simple Price endpoint:
`https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=bitcoin&vs_currencies=usd`

I called it without paying, and it answered with "402 Payment Required" and its price. That response asks for:
- **0.01 USDC** per request (amount `10000` at 6 decimals), which is under your 0.02 USDC limit.
- Payment on **Base** in USDC to `0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784`, or on **Solana** in USDC to `8XhngTRitTcUJMiaDJ6azw8GRSiFPpwhnmV3HYQLHUpL`.

**Why I couldn't pay:** This environment has no wallet. To pay, I'd need a private key holding USDC on Base or Solana, which I'd use to sign a USDC payment authorization (no on-chain transaction from me) and send it in the request's `PAYMENT-SIGNATURE` header. I looked for one and found nothing: no key in the environment variables, no wallet files or settings, and no x402 or wallet tools installed. I didn't fetch the price from a free source instead, because you asked for the paid one.

**To finish this, either:**
- Give me access to a funded wallet, such as a key in an environment variable or a tool like Coinbase's CDP agentic wallet. I'll then pay the 0.01 USDC and get the price, capping the payment at 0.02 USDC.
- Or tell me a free source like CoinGecko's public API is fine, and I'll get the price without paying.

CoinGecko calls these x402 endpoints experimental and says the price can change, so I'd check the 402 response again right before paying.

Sources:
- [CoinGecko x402 docs](https://docs.coingecko.com/ai-integration/x402)
- [CoinGecko x402 overview](https://coingecko.com/en/api/x402)
- [Coinbase: CoinGecko x402 launch](https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402)
- [CDP agentic wallet: pay for service](https://docs.cdp.coinbase.com/agentic-wallet/skills/pay-for-service)

FINAL (success, 8 turns): I found a paid API that fits your limit, but I couldn't pay for it, so I don't have the BTC price for you.

**The API:** CoinGecko's x402 Simple Price endpoint:
`https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=bitcoin&vs_currencies=usd`

I called it without paying, and it answered with "402 Payment Required" and its price. That response asks for:
- **0.01 USDC** per request (amount `10000` at 6 decimals), which is under your 0.02 USDC limit.
- Payment on **Base** in USDC to `0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784`, or on **Solana** in USDC to `8XhngTRitTcUJMiaDJ6azw8GRSiFPpwhnmV3HYQLHUpL`.

**Why I couldn't pay:** This environment has no wallet. To pay, I'd need a private key holding USDC on Base or Solana, which I'd use to sign a USDC payment authorization (no on-chain transaction from me) and send it in the request's `PAYMENT-SIGNATURE` header. I looked for one and found nothing: no key in the environment variables, no wallet files or settings, and no x402 or wallet tools installed. I didn't fetch the price from a free source instead, because you asked for the paid one.

**To finish this, either:**
- Give me access to a funded wallet, such as a key in an environment variable or a tool like Coinbase's CDP agentic wallet. I'll then pay the 0.01 USDC and get the price, capping the payment at 0.02 USDC.
- Or tell me a free source like CoinGecko's public API is fine, and I'll get the price without paying.

CoinGecko calls these x402 endpoints experimental and says the price can change, so I'd check the 402 response again right before paying.

Sources:
- [CoinGecko x402 docs](https://docs.coingecko.com/ai-integration/x402)
- [CoinGecko x402 overview](https://coingecko.com/en/api/x402)
- [Coinbase: CoinGecko x402 launch](https://www.coinbase.com/developer-platform/discover/launches/coingecko-x402)
- [CDP agentic wallet: pay for service](https://docs.cdp.coinbase.com/agentic-wallet/skills/pay-for-service)
