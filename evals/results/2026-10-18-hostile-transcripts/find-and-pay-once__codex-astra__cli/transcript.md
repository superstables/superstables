# find-and-pay-once / codex-astra (gpt-6-astra) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

AGENT: I’ll check the available API payment workflow, find a BTC price endpoint, and pay if the cost is below 0.02 USDC.

TOOL shell: /bin/bash -lc 'superstables --help'
OUTPUT (exit 0):
Usage: superstables [options] [command]

Find services that charge per request, quote them, and pay them with test USDC
from a wallet the owner controls. Testnet only. No real money moves.

Options:
  -V, --version                  print the version of this client and exit
  --home <dir>                   where this client keeps its state (default:
                                 SUPERSTABLES_HOME or ~/.superstables)
  --wallet <mode>                who signs pay's payments: browser (default), a
                                 browser wallet such as MetaMask on an approval
                                 page pay serves; or local, a wallet process
                                 holding a key on this machine. Either way the
                                 owner approves each payment; neither lets an
                                 agent pay alone (choices: "browser", "local",
                                 env: SUPERSTABLES_WALLET)
  -h, --help                     display help for command

Commands:
  setup                          for pay: create the home directory and the
                                 policy file, then say what to do next
  wallet                         the local wallet process, for --wallet local
                                 only
  find [options] [query]         search for services that charge per request,
                                 and say how each could be paid
  quote [options] [url]          ask a paid endpoint what one call costs, and
                                 check it against the spend policy; nothing is
                                 paid or signed
  pay [options] <quote-id>       ask the owner to approve a quote in their
                                 wallet, and pay it if they do
  status [options] <attempt-id>  where a payment attempt got to, and what to do
                                 next
  receipts [options]             the payments made from this machine, newest
                                 first
  attempts [options]             every payment attempt, paid or not, newest
                                 first
  demo-service [options]         run the demo paid service, so there is
                                 something to buy on this machine
  budget [args...]               on-chain budgets (testnets): the owner grants a
                                 budget once, then the agent buys alone. Start
                                 with `superstables budget setup --rail evm`;
                                 `superstables budget --help` lists its commands
  doctor [options]               check everything pay needs, one line at a time
  policy                         the spend policy this client and the wallet
                                 both apply to pay
  owner                          the owner's own settings: the approval site and
                                 the RPCs owner actions trust
  help [command]                 display help for command

What this is:
  A client for paying per request with test USDC (pathUSD on Tempo, USDG on Robinhood Chain
  Testnet): find a paid service, quote it, and pay it.
  The agent can ask for a payment but cannot approve one.

Two ways to pay:
  pay      The owner approves each payment in their own wallet: a browser wallet such as MetaMask
           (Phantom on Solana) on a page `pay` serves on 127.0.0.1 (the default), or the local
           wallet process (--wallet local, EVM chains only). x402 on the EVM chains below and
           Solana devnet, MPP on Tempo Moderato. Use it when the owner is there to approve.
  budget   The owner grants an on-chain budget once, from their wallet; the agent then buys on its
           own until the budget is spent, expires or is revoked. The chain enforces the limit.
           Rails: evm (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
           Sepolia, Ethereum Sepolia, Robinhood Chain Testnet), tempo (Tempo Moderato), solana
           (Solana devnet). Use it when the agent should buy without asking each time.

Start here, pay:
  superstables setup                                   owner, once: home directory and policy (pay only)
  superstables doctor                                  check what a payment needs
  superstables find "btc price"                        what can be bought, and the commands to pay it
  superstables quote --service <id> --param k=v        the price and the policy checks; nothing is signed
  superstables pay <quote-id>                          prints an approval link; the owner approves in their wallet
  superstables status <attempt-id>                     where a payment got to

Start here, budget: superstables budget setup --rail evm
  `superstables setup` is for pay only. Budgets are a separate tool; each subcommand takes --help.
  An owner command prints an approval link: an agent may start it and hand it to the owner,
  but only the owner approves, in their own wallet. Typical evm order: setup, fund-agent, doctor,
  grant, then buy.
    setup       owner  connect the owner's wallet (a free signature) and create the agent key
    fund-agent  owner  send the agent gas (evm) or fee SOL (solana)
    doctor             keys, addresses, RPC and balances; says what to top up
    preflight          a seller's price and address; signs nothing
    status             the budget left, its expiry, whether it is revoked; reads the chain
    grant       owner  grant the budget: an amount, and on tempo an expiry, period and sellers
    buy         agent  one purchase under the budget (--max is required)
    reconcile          read the chain for one purchase whose outcome is unknown
    revoke      owner  end the budget on chain
    recover     owner  evm: stop the allowance and return stranded funds to the owner
    wait               wait for an owner approval an agent started (--id)

Who runs what:
  owner   setup, wallet init, wallet serve, wallet open, policy init, owner settings, a
... [4486 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'superstables quote --help'
OUTPUT (exit 0):
Usage: superstables quote [options] [url]

ask a paid endpoint what one call costs, and check it against the spend policy;
nothing is paid or signed

Arguments:
  url                  a paid URL to quote directly, query string included

Options:
  --service <id>       quote a service found by `superstables find`
  --param <key=value>  a request parameter for the service (repeatable)
                       (default: [])
  --chain <chain>      when the seller offers several chains, take its offer on
                       this one (e.g. robinhood-testnet)
  --json               print the quote record, with policy.checks and next
  -h, --help           display help for command

A quote reads the seller's HTTP 402 challenge and records the exact terms the owner will be asked to
approve. It lasts 10 minutes and can start one payment attempt; after that attempt ends, however it
ends, take a new quote.

A seller may offer the same thing on several chains. Without --chain, quote takes the first offer
this client can pay, in the seller's order, and names the other chains under `also on` (otherChains
with --json): to pay on one of those, quote again with --chain. A new quote suggested after a
payment keeps the quote's chain.

Moves money: no. Nothing is signed or sent; the seller is asked for its price without payment.
Run by: the agent or the owner.
Example:
  $ superstables quote --service x402-coin-api.vercel.app --param symbol=BTC
  $ superstables quote 'https://www.superstables.com/api/demo/market?asset=ETH'
Prints: the quote id, price, network, the seller's other chains (also on), recipient, expiry, and
  each policy rule it was checked against. With --json: the quote record, with policy.checks [{rule,
  ok, detail}], otherChains and next.
Exit codes: 0 quoted and allowed, 1 the endpoint could not be quoted (not a paid endpoint,
  unreachable, or no payment this client can make), 2 bad input, 3 quoted but the spend policy
  refuses it (the full table: superstables --help)


TOOL shell: /bin/bash -lc 'superstables budget --help'
OUTPUT (exit 0):
superstables budget: on-chain budgets for an agent. The owner grants a budget once, from their own wallet; the
agent then buys on its own, purchase by purchase, until the budget is spent or revoked. The chain enforces the limit.
Testnet only. No real money moves.

Start here, the owner (once per rail and chain; each step prints an approval link; the owner approves in their own
wallet):
  superstables budget setup --rail evm              connect the owner's wallet (a free signature); creates the agent key
                                                    (--hosted: the owner approves on superstables.com, on any device)
  superstables budget setup --rail evm --hosted --grant 5 --fund
                                                    all of it with one approval link on superstables.com: add agent,
                                                    gas, budget
  superstables budget fund-agent --rail evm         send the agent key gas for its own transactions (evm and solana)
  superstables budget doctor --rail evm             check keys, addresses and balances; says what to top up
  superstables budget grant --rail evm --amount 5   an allowance of 5 USDC from the owner's wallet; the USDC stays there
An agent may run these to start them and hand the owner the approval link. Only the owner approves.

Start here, the agent:
  superstables budget status --rail evm             is there a budget here, and how much is left
  superstables budget preflight --rail evm --url U  the seller's price and payee; signs nothing
  superstables budget buy --rail evm --url U --max 0.02 --pay-to ADDR
                                                    one purchase of at most 0.02 USDC, signed by the agent key
  superstables budget reconcile --rail evm --op ID  after exit 5: what happened to that purchase
If status says no budget has been set up here (exit 1), or remaining is 0, do not buy, and do not switch to another way
of paying on your own: stop and ask. The owner can take the steps above, or approve this one payment with superstables pay
(x402 sellers on Base Sepolia), or with superstables budget buy-once for a service find --once lists. preflight still
works without a budget, so the answer can say whether the price fits.

Single purchase on superstables.com, no budget (no setup; the chain comes from the listing):
  superstables budget find --once                   the services available for Single purchase on superstables.com
  superstables budget buy-once --service ID --max M one purchase the owner approves on superstables.com

Rails and chains (--chain; the default is marked):
  evm     base-sepolia (Base Sepolia, default), arc-testnet (Arc Testnet), arbitrum-sepolia (Arbitrum Sepolia),
          polygon-amoy (Polygon Amoy), skale-base-sepolia (SKALE Base Sepolia),
          ethereum-sepolia (Ethereum Sepolia), robinhood-testnet (Robinhood Chain Testnet)
          The budget is USDC (USDG on robinhood-testnet). Sellers: x402.
  tempo   moderato (Tempo Moderato, default; the only chain). The budget is pathUSD. Sellers: MPP (tempo.charge).
  solana  devnet (Solana devnet, default; the only chain). The budget is USDC. Sellers: x402.
  Chain to rail: Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia and Robinhood Chain Testnet are evm;
  Tempo Moderato is tempo; Solana devnet is solana. superstables find --budget names the rail and chain for a listing,
  and prints the commands to buy it.

The owner's steps, in order, once per rail and chain:
  evm     setup, fund-agent, doctor, grant.
          setup: the owner connects their wallet and signs a free message; this machine gets an agent key.
          fund-agent: the owner sends the agent key a little of the chain's gas token (ETH on Base Sepolia, Arbitrum
          Sepolia, Ethereum Sepolia and Robinhood Chain Testnet, USDC on Arc Testnet, POL on Polygon Amoy, CREDIT on
          SKALE Base Sepolia) so it can pay for its own transactions. On Arc, that gas transfer is USDC, separate from the
          budget allowance.
          grant: an allowance (USDC approve; USDG on Robinhood Chain Testnet) from the owner's wallet to the agent key.
          The token stays in the owner's wallet until a purchase: each buy pulls exactly its price, then pays the seller.
  tempo   setup, grant. grant authorizes the agent's access key to spend the owner's pathUSD up to a limit, until an
          expiry (default 24 hours). The agent needs no gas: fees come from the owner.
  solana  setup, fund-agent, doctor, grant. fund-agent sends the agent SOL for fees (default 0.01). grant makes the agent
          the delegate of the owner's USDC account, up to the amount; the USDC stays in the owner's account until a purchase.

Commands (each takes --help):
  setup       owner   connect the owner's wallet, create the agent key (--hosted)        moves no money
  fund-agent  owner   gas for the agent key (evm, solana)                                moves gas to the agent
  doctor      anyone  keys, addresses, RPC, balances; what to top up                     read only
  grant       owner   the budget: an amount (tempo: also expiry, period, sellers)         lets the agent spend
  status      anyone  whether a budget is set up, what is left, expiry, revoked           read only
  preflight   anyone  a seller's price and payee                                         read only
  buy         agent   one purchase under the budget; --max is required                   moves money
  reconcile   anyone  read the chain for one purchase whose outcome is unknown           read only
  unlock      owner   clear abandoned operation locks after stopping their processes     moves no money
  revoke      owner   end the budget on chain                                            moves no money
  recover     owner   evm: stop the allowance, return stranded USDC to the owner          moves money back
  rotate      owner   evm, solana: replace the agent key, retir
... [6499 more characters in raw.jsonl]

TOOL shell: /bin/bash -lc 'superstables find "btc price" --json'
OUTPUT (exit 0):
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
      "lastSeenLive": "2026-10-18T15:08:02.991Z",
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


TOOL shell: /bin/bash -lc 'superstables budget status --rail evm --chain base-sepolia --json'
OUTPUT (exit 1):
{"ok":false,"command":"status","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"remaining":null,"home":"/home/alladin/.cache/ev-runs/r-9cce881314/superstables-home","next":"no budget yet in /home/alladin/.cache/ev-runs/r-9cce881314/superstables-home: the owner runs superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund. An agent may start each one and hand the owner the approval link. If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included","reason":"no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet"}
superstables budget: no budget has been set up here for evm on base-sepolia: no agent key on this machine; no owner has connected a wallet.
  Checked the home /home/alladin/.cache/ev-runs/r-9cce881314/superstables-home (SUPERSTABLES_HOME), chain base-sepolia.
  Looked for: /home/alladin/.cache/ev-runs/r-9cce881314/superstables-home/keys/budget/evm-agent.env and /home/alladin/.cache/ev-runs/r-9cce881314/superstables-home/budget/public/evm-base-sepolia.env.
  If the budget is elsewhere, ask the user for the path; do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included.
  The owner sets one up, in this order: superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A; or, with one approval link on superstables.com (the owner needs an account there): superstables budget setup --rail evm --hosted --grant A --fund.


TOOL shell: /bin/bash -lc "superstables budget preflight --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC' --json"
OUTPUT (exit 1):
chain base-sepolia: Base Sepolia, rpc sepolia.base.org, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
PASS -- eth_chainId 0x14a34 = 84532 (expected 84532); block 48283900
PASS -- token name()/version() = USDC/2; chains.mjs says USDC/2
PASS -- token decimals() = 6
PASS -- DOMAIN_SEPARATOR() 0x71f17a3b2ff373b8... equals the one computed from chains.mjs (USDC, 2, 84532, token): the domain pay checks and wallets sign over
gas: token ETH, gasPrice 6000000 wei, maxFeePerGas 7000000
note: no owner address in the public file, so no owner balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
note: no agent address in the public file, so no agent balance to show. Not an error: preflight needs no setup; a budget starts with superstables budget setup --rail evm
FAIL -- GET https://x402-coin-api.vercel.app/api/price?symbol=BTC: fetch failed

1 check(s) FAILED
{"ok":false,"command":"preflight","rail":"evm","chain":"base-sepolia","state":"failed","final":true,"chain_final":null,"amount":null,"payTo":null,"url":"https://x402-coin-api.vercel.app/api/price?symbol=BTC","next":"fix the failed checks above","reason":"1 preflight check(s) failed"}


TOOL shell: /bin/bash -lc "superstables budget preflight --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --json"
OUTPUT (exit 0):
chain base-sepolia: Base Sepolia, rpc sepolia.base.org, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e
PASS -- eth_chainId 0x14a34 = 84532 (expected 84532); block 48283900
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


AGENT: Found [Superstables’ live BTC price API](https://www.superstables.com/api/demo/market?asset=BTC), quoting **0.01 test USDC**—below your limit.

I couldn’t pay or retrieve the price: `superstables` reports no connected wallet or spending budget and requires owner approval to proceed. This installation supports testnet payments only.

Would you like to approve a single purchase through Superstables?
