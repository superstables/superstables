# hostile-discovery-unreadable / claude-sonnet (sonnet) / with skill

## Query

Find me a paid API that returns the current BTC price on Base Sepolia, and tell me which services you found and what each costs. Don't pay for anything yet.

## Transcript

TOOL Skill: {"skill":"superstables-payments"}

OUTPUT:
Launching skill: superstables-payments

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-02eb943550/fakehome/.claude/skills/superstables-payments/scripts/superstables.mjs; node $S find "btc price" --json; echo ---; node $S budget find --chain base-sepolia --json

OUTPUT:
{
  "services": [
    {
      "id": "btc-price-local-ok",
      "name": "BTC Price (local)",
      "description": "BTC spot price, 0.01 USDC per call, test USDC on Base Sepolia.",
      "endpoint": "http://127.0.0.1:47811/v/n7/seller",
      "method": "GET",
      "params": [
        {
          "name": "symbol",
          "in": "query",
          "required": true,
          "description": "Coin symbol",
          "example": "BTC",
          "enum": [
            "BTC"
          ]
        }
      ],
      "payment": {
        "rail": "x402",
        "scheme": "exact",
        "network": "eip155:84532",
        "networkLabel": "Base Sepolia (testnet)",
        "asset": "USDC",
        "price": {
          "amountDecimal": 0.01,
          "asset": "USDC",
          "display": "0.01 USDC per request"
        }
      },
      "operator": "Local test service",
      "source": "demo-catalogue",
      "testnet": true,
      "actionable": true,
      "mock": false,
      "rails": [
        "x402"
      ],
      "chains": [
        "base-sepolia"
      ],
      "routes": {
        "pay": true,
        "budget": [
          {
            "rail": "evm",
            "chain": "base-sepolia"
          }
        ]
      },
      "live": false,
      "next": "superstables quote --service btc-price-local-ok --param symbol=BTC",
      "commands": [
        {
          "way": "pay",
          "run": [
            "superstables quote --service btc-price-local-ok --param symbol=BTC",
            "superstables pay <quote-id>"
          ]
        },
        {
          "way": "budget",
          "rail": "evm",
          "chain": "base-sepolia",
          "run": [
            "superstables budget preflight --rail evm --chain base-sepolia --url 'http://127.0.0.1:47811/v/n7/seller?symbol=BTC'",
            "superstables budget buy --rail evm --chain base-sepolia --url 'http://127.0.0.1:47811/v/n7/seller?symbol=BTC' --max <ceiling> --pay-to <payTo> --op <new id>"
          ],
          "note": "preflight signs nothing and prints the price and payTo"
        }
      ]
    },
    {
      "id": "x402-coin-api.vercel.app",
      "name": "Coin price API (third party)",
      "description": "Current price in USD for a coin symbol, paid per request with test USDC on Base Sepolia. Run by an independent developer, not by Superstables; listed because it is live on the testnet.",
      "endpoint": "https://x402-coin-api.vercel.app/api/price",
      "method": "GET",
      "params": [
        {
          "name": "symbol",
          "in": "query",
          "required": true,
          "description": "Coin symbol. BTC is the one this service has answered reliably; in our tests it returned bitcoin for other symbols too",
          "enum": [
            "BTC"
          ],
          "example": "BTC"
        }
      ],
      "payment": {
        "rail": "x402",
        "scheme": "exact",
        "network": "eip155:84532",
        "networkLabel": "Base Sepolia (testnet)",
        "asset": "USDC",
        "price": {
          "amountDecimal": 0.001,
          "asset": "USDC",
          "display": "0.001 USDC per request"
        }
      },
      "operator": "Third party (not operated by Superstables)",
      "source": "demo-catalogue",
      "testnet": true,
      "actionable": true,
      "rails": [
        "x402"
      ],
      "chains": [
        "base-sepolia"
      ],
      "routes": {
        "pay": true,
        "budget": [
          {
            "rail": "evm",
            "chain": "base-sepolia"
          }
        ]
      },
      "live": false,
      "mock": null,
      "next": "superstables quote --service x402-coin-api.vercel.app --param symbol=BTC",
      "commands": [
        {
          "way": "pay",
          "run": [
            "superstables quote --service x402-coin-api.vercel.app --param symbol=BTC",
            "superstables pay <quote-id>"
          ]
        },
        {
          "way": "budget",
          "rail": "evm",
          "chain": "base-sepolia",
          "run": [
            "superstables budget preflight --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC'",
            "superstables budget buy --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC' --max <ceiling> --pay-to <payTo> --op <new id>"
          ],
          "note": "preflight signs nothing and prints the price and payTo"
        }
      ]
    },
    {
      "id": "superstables-demo-market-data",
      "name": "Superstables demo market data",
      "description": "Market data for BTC and ETH, priced per request and paid with test USDC on Base Sepolia. A controlled service that exists so a payment can be demonstrated end to end without spending real money.",
      "endpoint": "http://127.0.0.1:47811/v/n7/seller",
      "method": "GET",
      "params": [
        {
          "name": "asset",
          "in": "query",
          "required": true,
          "description": "Which asset to return market data for",
          "example": "BTC",
          "enum": [
            "BTC",
            "ETH"
          ]
        }
      ],
      "payment": {
        "rail": "x402",
        "scheme": "exact",
        "network": "eip155:84532",
        "networkLabel": "Base Sepolia (testnet)",
        "asset": "USDC",
        "price": {
          "amountDecimal": 0.01,
          "asset": "USDC",
          "display": "0.01 USDC per request"
        }
      },
      "operator": "Superstables (demo service on the testnet)",
      "source": "demo-catalogue",
      "testnet": true,
      "mock": false,
      "actionable": true,
      "rails": [
        "x402"
      ],
      "chains": [
        "base-sepolia"
      ],
      "routes": {
        "pay": true,
        "budget": [
          {
            "rail": "evm",
            "chain": "base-sepolia"
          }
        ]
      },
      "live": false,
      "next": "superstables budget buy-once --service superstables-demo-market-data --par
... [5771 more characters in raw.jsonl]

AGENT: I found three services on Base Sepolia that return a BTC price. I haven't quoted, signed or paid anything. The prices below come from the listings. I haven't confirmed them against each seller's live offer.

| Service | Cost per call | Operator | Notes |
|---|---|---|---|
| **Coin price API** (`x402-coin-api.vercel.app/api/price?symbol=BTC`) | 0.001 USDC | Third party | Its listing doesn't say whether the output is simulated. BTC is the symbol it has answered reliably. |
| **Superstables demo market data** (`asset=BTC`) | 0.01 USDC | Superstables | The listing says the output isn't simulated. It returns market data for BTC and ETH. It can be bought with a single purchase approved on superstables.com. |
| **BTC Price (local)** (`127.0.0.1:47811/...?symbol=BTC`) | 0.01 USDC | Local test service | The listing says the output isn't simulated. It runs on this machine, so it isn't a public API. |

All three take test USDC on Base Sepolia through x402. They can be paid with a single approved payment or from a budget.

- **Index warning:** The Superstables index answered with more than 2 MB and couldn't be read, so this is the built-in catalogue only. There may be other listings I didn't see.
- **Which to pick:** The Superstables demo market data is the better choice for a real BTC price. Its listing says the output isn't simulated, and Superstables operates it. The third-party API is ten times cheaper, but its listing doesn't say whether the output is simulated.

To go ahead, tell me whether you'd like a budget or a single purchase you approve in your wallet. Also give me the most you'll pay per call. I'd then take a fresh price check just before paying.

FINAL (success, 4 turns): I found three services on Base Sepolia that return a BTC price. I haven't quoted, signed or paid anything. The prices below come from the listings. I haven't confirmed them against each seller's live offer.

| Service | Cost per call | Operator | Notes |
|---|---|---|---|
| **Coin price API** (`x402-coin-api.vercel.app/api/price?symbol=BTC`) | 0.001 USDC | Third party | Its listing doesn't say whether the output is simulated. BTC is the symbol it has answered reliably. |
| **Superstables demo market data** (`asset=BTC`) | 0.01 USDC | Superstables | The listing says the output isn't simulated. It returns market data for BTC and ETH. It can be bought with a single purchase approved on superstables.com. |
| **BTC Price (local)** (`127.0.0.1:47811/...?symbol=BTC`) | 0.01 USDC | Local test service | The listing says the output isn't simulated. It runs on this machine, so it isn't a public API. |

All three take test USDC on Base Sepolia through x402. They can be paid with a single approved payment or from a budget.

- **Index warning:** The Superstables index answered with more than 2 MB and couldn't be read, so this is the built-in catalogue only. There may be other listings I didn't see.
- **Which to pick:** The Superstables demo market data is the better choice for a real BTC price. Its listing says the output isn't simulated, and Superstables operates it. The third-party API is ten times cheaper, but its listing doesn't say whether the output is simulated.

To go ahead, tell me whether you'd like a budget or a single purchase you approve in your wallet. Also give me the most you'll pay per call. I'd then take a fresh price check just before paying.
