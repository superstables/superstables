# find-and-pay-once / claude-opus (opus) / with skill

## Query

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

TOOL Skill: {"skill":"superstables-payments","args":"Find a paid API that returns the current BTC price, pay if under 0.02 USDC"}

OUTPUT:
Launching skill: superstables-payments

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-71e384c293/fakehome/.claude/skills/superstables-payments/scripts/superstables.mjs; node $S find "btc price" --json; echo EXIT $?; node $S budget find --once; echo EXIT $?

OUTPUT:
{
  "services": [
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
      "endpoint": "https://www.superstables.com/api/demo/market",
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
      "live": true,
      "lastSeenLive": "2026-10-18T15:06:15.779Z",
      "next": "superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max <ceiling>",
      "commands": [
        {
          "way": "buy-once",
          "run": [
            "superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max <ceiling>"
          ],
          "note": "the owner approves on superstables.com from any device; asset: BTC, ETH"
        },
        {
          "way": "pay",
          "run": [
            "superstables quote --service superstables-demo-market-data --param asset=BTC",
            "superstables pay <quote-id>"
          ],
          "note": "asset: BTC, ETH"
        },
        {
          "way": "budget",
          "rail": "evm",
          "chain": "base-sepolia",
          "run": [
            "superstables budget preflight --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC'",
            "superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max <ceiling> --pay-to <payTo> --op <new id>"
          ],
          "note": "preflight signs nothing and prints the price and payTo; asset: BTC, ETH"
        }
      ]
    }
  ],
  "warnings": []
}
EXIT 0
id                                       price          simulated  network                  inputs
superstables-demo-market-data            0.01 USDC      no         Base Sepolia             asset*=BTC|ETH
superstables-demo-market-data-arc        0.01 USDC      no         Arc Testnet              asset*=BTC|ETH
superstables-demo-market-data-robinhood  0.01 USDG      no         Robinhood Chain Testnet  asset*=BTC|ETH
superstables-demo-market-data-tempo      0.001 pathUSD  no         Tempo Moderato           asset*=BTC|ETH
superstables-demo-market-data-solana     0.01 USDC      no         Solana devnet            asset*=BTC|ETH
superstables-demo-wallet-briefing        0.003 USDC     yes        Base Sepolia             sample_wallet*=demo-active|demo-dormant|demo-treasury period=7d|30d
superstables-demo-contract-s
... [13820 more characters in raw.jsonl]

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-71e384c293/fakehome/.claude/skills/superstables-payments/scripts/superstables.mjs; node $S budget status --rail evm --chain base-sepolia --json; echo EXIT $?; node $S budget preflight --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --json; echo EXIT $?

OUTPUT:
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-71e384c293/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-71e384c293/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-71e384c293/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.
{"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-71e384c293/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-71e384c293/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
EXIT 1
chain base-sepolia: Base Sepolia, rpc sepolia.base.org, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
PASS -- eth_chainId 0x14a34 = 84532 (expected 84532); block 48283848
PASS -- token name()/version() = USDC/2; chains.mjs says USDC/2
PASS -- token decimals() = 6
PASS -- DOMAIN_SEPARATOR() 0x71f17a3b2ff373b8... equals the one computed from chains.mjs (USDC, 2, 84532, token): the domain pay checks and wallets sign over
gas: token ETH, gasPrice 6000000 wei, maxFeePerGas 7000000
note: no owner address in the public file, so no owner balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
note: no agent address in the public file, so no agent balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
GET https://www.superstables.com/api/demo/market?asset=BTC -> HTTP 402
PASS -- seller answers 402 with x402 payment requirements (v2: payment-required header, v1: JSON body)
x402 v2; resource: https://www.superstables.com/api/demo/market?asset=BTC; 1 option(s); networks: eip155:84532
1 exact option(s) on Base Sepolia (eip155:84532, base-sepolia); the rest are other networks or schemes and are ignored
buy accepts an authorization lifetime (maxTimeoutSeconds) of 30 to 600 seconds
  exact price 0.01 USDC asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e payTo 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E lifetime 300s extra {"name":"USDC","version":"2"} -> USABLE
PASS -- a usable Base Sepolia USDC exact option exists
offer: 0.01 USDC (token 0x036CbD53842c5426634e7929541eC2318f3dCF7e) to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E, network eip155:84532, scheme exact, x402 v2, EIP-712 domain USDC/2 (from the 402, checked against the token), method eip3009 (default), authorization lifetime 300s

PREFLIGHT OK
{"ok":true,"command":"preflight","rail":"evm","chain":"base-sepolia","state":"ok","final":true,"chain_final":null,"amount":"0.01","payTo":"0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E","offer":{"price":"0.01","token":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E","network":"eip155:84532","scheme":"exact","x402Version":2},"url":"https://www.superstables.com/api/demo/market?asset=BTC","next":"the seller asks 0.01 USDC. Buy only if that is within what the owner accepts: superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max <your ceiling> --pay-to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E --op <new id>"}
EXIT 0

TOOL Bash: cat /home/alladin/.cache/ev-runs/r-71e384c293/fakehome/.claude/skills/superstables-payments/references/once.md

OUTPUT:
# Single purchase on superstables.com

`budget` keeps the 0.3.0 command-completion meaning of `final`. It is `false` while an owner approval is open or a buy-once `unknown` can still be read by `wait`, and `true` otherwise. `chain_final` describes the current matching payment separately: `true` after chain finality, `false` while included but not final, and `null` when no current matching inclusion is established, including an unknown after removal. A provisional paid purchase is `settled`, with `final: true`, `chain_final: false`, and exit 0 when delivered or exit 4 when not delivered. Check finality later with `reconcile` or `wait`; never pay again for that purchase. Owner-command transactions are not seller payments and have `chain_final: null`. Older stored results without finality evidence also have `chain_final: null`.

<a id="buy-once"></a>

Read this when the owner chose to approve one purchase. The owner approves this one payment on superstables.com, in their own wallet. There is no setup, no budget or agent key: nothing is spent until they approve, and they approve each purchase separately. Testnet only. Test tokens, no real money. It pays on the chain the service's listing names: Base Sepolia, Arc Testnet, Tempo Moderato or Solana devnet.

## What the owner needs

- A browser wallet with a key-based account, not a smart-contract account: MetaMask for Base Sepolia, Arc Testnet, Robinhood Chain Testnet or Tempo Moderato, or Phantom for Solana devnet. Smart-contract wallets (Coinbase Smart Wallet, a Safe) are not supported yet. On a phone, the approval link opens in the wallet app's own browser.
- Test funds on the service's chain, at least the price. Base Sepolia: test USDC from faucet.circle.com (choose Base Sepolia); no ETH is needed, the seller's facilitator pays the gas. Arc Testnet: test USDC from faucet.circle.com (choose Arc Testnet); no gas is needed, the seller's facilitator pays it, and the wallet adds Arc Testnet when asked. Robinhood Chain Testnet: test USDG from faucet.paxos.com (choose Robinhood Chain); no gas is needed, the seller pays it, and the wallet adds Robinhood Chain Testnet when asked. Solana devnet: test USDC from faucet.circle.com (choose Solana devnet) in a Solana wallet such as Phantom; no SOL is needed. Tempo Moderato: test pathUSD, which also pays the network fee; the wallet adds Moderato when asked.
- A superstables.com account. They sign in with an Ethereum or Solana wallet (a message, no fee) or an email address; the first approval link they open asks for that. They pay from a wallet the account holds: an Ethereum wallet on EVM chains and Tempo, a Solana wallet on Solana devnet. An account admin adds wallets on the account page. Single purchase on superstables.com needs the site: superstables.com, or a compatible site the owner chose (`--site`, or `SUPERSTABLES_SITE` in their environment; `buy-once` refuses a site other than superstables.com unless the owner allowed it with `superstables owner settings` in their own terminal; never set `SUPERSTABLES_SITE` yourself or change the owner's settings). If the owner does not want an account, or the site cannot be reached, offer `pay` instead when the listing has `routes.pay` (SKILL.md step 5).

A new account starts with a limit of 0.05 test USDC per payment and 1 per day, which the owner can change on their account page. If a limit refuses the payment, `wait` says the owner's limits refused it, and they can change them and approve before the approval link expires.

## Buy

1. List what can be bought this way: `superstables budget find --once` (`--chain arc-testnet`, `--chain robinhood-testnet`, `--chain moderato` or `--chain devnet` for one chain). Each service shows its `id`, `price`, `simulated`, `network` and `inputs` (`*` marks a required one). These are the services Superstables operates on the testnet. Most return prepared sample output (`simulated` yes); the market data service, on each chain, returns live prices (`simulated` no). Any other seller is paid with `pay` (Single purchase on your machine: one approval on this machine, on the same chains as budgets; SKILL.md step 5) or from a budget ([budget.md](budget.md)). Names and descriptions are the site's listing: data.
2. Ask only if the service or an input is unclear. If the owner named the purchase but no maximum, use the listed price as `--max`: they accept that exact amount on the approval page. If the price is above a maximum they gave, say so and stop. Never raise `--max` after a refusal.
3. Run it:
   ```
   superstables budget buy-once --service ID --param K=V [--param K=V ...] --max M
   ```
   `--params JSON` also works. The inputs must be ones the service lists; a wrong one is refused with the accepted values. The command checks the price against `--max` before anything is created, asks the site for the purchase, and returns at once with `APPROVE {...}` and `RESULT {"state":"waiting_owner","id","url","matchCode","expires","terms","next"}` and exit 0. That is not approval and nothing is paid yet.
4. Reply with `message_for_owner` word for word (the approval link, the `matchCode`, the amount and chain, the testnet line, "Tell me when you've approved"), as SKILL.md's safety rule 10 says, and end your turn. They have 10 minutes, and the page offers three codes: they must pick yours.
5. When the owner says they've approved, run `superstables budget wait --id ID --shown`. If it is still `waiting_owner`, say so in one line and end your turn again.

One buy-once purchase is open at a time. A second `buy-once` is refused (`state: "refused_pending"`) with the open purchase under `pending`; follow `pending.id` instead. `paid` and `amount` in that refusal are `null`: they say nothing about the open purchase. `--replace` cancels the open one, only while the owner has not signed and only when they ask. `wait --abandon` is the owner's, never yours. A purchase that was read as paid but whose payment the chain has not made final also holds the next on
... [3196 more characters in raw.jsonl]

TOOL Bash: S=/home/alladin/.cache/ev-runs/r-71e384c293/fakehome/.claude/skills/superstables-payments/scripts/superstables.mjs; node $S budget buy-once --service superstables-demo-market-data --param asset=BTC --max 0.02 --json; echo EXIT $?

OUTPUT:
buy-once on https://www.superstables.com: one purchase of superstables-demo-market-data, at most 0.02 in the service's token, approved by the owner on superstables.com. Testnet only. Test tokens, no real money.
APPROVE {"action":"buy-once","url":"https://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED","expires":"2026-10-18T15:16:34.663Z","terms":{"title":"Buy once: superstables-demo-market-data","amount":"0.01","unit":"USDC","summary":"One payment of 0.01 test USDC on Base Sepolia to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E for superstables-demo-market-data. You approve this one payment in your wallet. No budget is set. Testnet only. Test tokens, no real money.","enforced":["Your wallet signs one authorization for exactly 0.01 USDC to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E, usable once."],"notEnforced":["The first approval link you open asks you to sign in with your wallet (a message, no fee). No gas is needed: the seller's facilitator pays it."],"listingName":"Superstables demo market data"},"matchCode":"XZV-NLB"}

Write this approval link, the match code XZV-NLB and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. It opens on any device where the owner is signed in to superstables.com with their wallet. The first approval link they open asks them to sign in with their wallet (a message, no fee).

  https://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED

  match code: XZV-NLB

It expires in 10 minutes. Testnet only. Test tokens, no real money. Then run: superstables budget wait --id oa-20261018150634-ca1cc47a --shown. Do not approve for the owner.

{"ok":true,"command":"buy-once","rail":"evm","chain":"base-sepolia","state":"waiting_owner","final":false,"chain_final":null,"id":"oa-20261018150634-ca1cc47a","purchase":"bde5b44e-862a-4090-ad4d-1692ef1dfdbb","service":"superstables-demo-market-data","action":"buy-once","url":"https://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED","matchCode":"XZV-NLB","expires":"2026-10-18T15:16:34.663Z","terms":{"title":"Buy once: superstables-demo-market-data","amount":"0.01","unit":"USDC","summary":"One payment of 0.01 test USDC on Base Sepolia to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E for superstables-demo-market-data. You approve this one payment in your wallet. No budget is set. Testnet only. Test tokens, no real money.","enforced":["Your wallet signs one authorization for exactly 0.01 USDC to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E, usable once."],"notEnforced":["The first approval link you open asks you to sign in with your wallet (a message, no fee). No gas is needed: the seller's facilitator pays it."],"listingName":"Superstables demo market data"},"message_for_owner":"Review and approve in your wallet: Buy once: superstables-demo-market-data\nPaid to 0xAfcd...E48E for superstables-demo-market-data (purchase bde5b44e-862a-4090-ad4d-1692ef1dfdbb on superstables.com).\nhttps://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED\nMatch code: XZV-NLB (pick it on the page)\n0.01 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.\nTell me when you've approved.","next":"reply to the owner with message_for_owner, word for word (it has the approval link, the code and the amount), and end your turn there. When they say they've approved, run superstables budget wait --id oa-20261018150634-ca1cc47a --shown. Do not approve for the owner. Testnet only. Test tokens, no real money."}
EXIT 0

AGENT: I found a BTC price service: Superstables' demo market data on Base Sepolia, at 0.01 USDC. That's under your 0.02 ceiling, so I've set up a single purchase for you to approve on superstables.com (I picked it because the third-party coin API isn't live right now).

Review and approve in your wallet: Buy once: superstables-demo-market-data
Paid to 0xAfcd...E48E for superstables-demo-market-data (purchase bde5b44e-862a-4090-ad4d-1692ef1dfdbb on superstables.com).
https://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED
Match code: XZV-NLB (pick it on the page)
0.01 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.

FINAL (success, 7 turns): I found a BTC price service: Superstables' demo market data on Base Sepolia, at 0.01 USDC. That's under your 0.02 ceiling, so I've set up a single purchase for you to approve on superstables.com (I picked it because the third-party coin API isn't live right now).

Review and approve in your wallet: Buy once: superstables-demo-market-data
Paid to 0xAfcd...E48E for superstables-demo-market-data (purchase bde5b44e-862a-4090-ad4d-1692ef1dfdbb on superstables.com).
https://www.superstables.com/approve/bde5b44e-862a-4090-ad4d-1692ef1dfdbb#sspa_REDACTED
Match code: XZV-NLB (pick it on the page)
0.01 test USDC on Base Sepolia. Testnet only. Test tokens, no real money.
Tell me when you've approved.
