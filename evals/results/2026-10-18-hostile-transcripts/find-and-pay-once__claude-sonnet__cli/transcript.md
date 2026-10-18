# find-and-pay-once / claude-sonnet (sonnet) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

TOOL Bash: superstables --help

OUTPUT:
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
... [4484 more characters in raw.jsonl]

TOOL Bash: superstables find "btc price"

OUTPUT:
id                             name                           price                   chains        pay  budget            live  simulated
-----------------------------  -----------------------------  ----------------------  ------------  ---  ----------------  ----  ---------
x402-coin-api.vercel.app       Coin price API (third party)   0.001 USDC per request  base-sepolia  yes  evm base-sepolia  no    not said
superstables-demo-market-data  Superstables demo market data  0.01 USDC per request   base-sepolia  yes  evm base-sepolia  yes   no

Next, per listing:
  x402-coin-api.vercel.app
    Single purchase on your machine:
      superstables quote --service x402-coin-api.vercel.app --param symbol=BTC
      superstables pay <quote-id>
    with a budget, evm on base-sepolia (preflight signs nothing and prints the price and payTo):
      superstables budget preflight --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC'
      superstables budget buy --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC' --max <ceiling> --pay-to <payTo> --op <new id>
  superstables-demo-market-data
    Single purchase on superstables.com (the owner approves on superstables.com from any device; asset: BTC, ETH):
      superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max <ceiling>
    Single purchase on your machine (asset: BTC, ETH):
      superstables quote --service superstables-demo-market-data --param asset=BTC
      superstables pay <quote-id>
    with a budget, evm on base-sepolia (preflight signs nothing and prints the price and payTo; asset: BTC, ETH):
      superstables budget preflight --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC'
      superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max <ceiling> --pay-to <payTo> --op <new id>
A budget buy needs the owner's grant on that rail and chain first. <ceiling> is the most the owner accepts for one purchase (buy refuses before signing above it); <payTo> is the address preflight prints; <new id> names the purchase, for reconcile.

AGENT: Both are under 0.02. I'll quote the cheaper one (and it's live, third-party).

TOOL Bash: superstables quote --service x402-coin-api.vercel.app --param symbol=BTC

OUTPUT:
Exit code 1
fetch failed

TOOL Bash: superstables doctor; superstables quote --service superstables-demo-market-data --param asset=BTC

OUTPUT:
  client version           0.4.0
  home                     /home/alladin/.cache/ev-runs/r-a375ebd9c4/superstables-home

✓ home directory           /home/alladin/.cache/ev-runs/r-a375ebd9c4/superstables-home (writable)
✓ payment records          /home/alladin/.cache/ev-runs/r-a375ebd9c4/superstables-home/records: none yet
✓ spend policy             /home/alladin/.cache/ev-runs/r-a375ebd9c4/superstables-home/policy.yaml (missing, built-in defaults apply): up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:21277 is free; the agent serves the page itself
✓ demo service             https://www.superstables.com/api/demo/market asks for payment (HTTP 402)
✓ Superstables index       https://www.superstables.com/api/v1/services answered HTTP 200
✗ facilitator.x402.rs      could not be reached: fetch failed
✗ facilitator.payai.network could not be reached: fetch failed
✗ x402.org                 could not be reached: fetch failed

Everything this machine needs is in place.
  quote           2369a8ad-ede5-43c2-8b21-f85d4e2aa5c5
  url             https://www.superstables.com/api/demo/market?asset=BTC
  service         Superstables demo market data
  price           0.01 USDC
  network         Base Sepolia (testnet)
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  expires         2026-10-18T15:16:17.890Z (10 minutes; one quote starts at most one payment)
  policy          allowed by the built-in defaults (no policy file)
    ok       kill_switch  off
    ok       deny         empty
    ok       allow        empty: any host
    ok       stablecoins  USDC is in [USDC, pathUSD, USDG]
    ok       caps.per_call 0.01 USDC, at most 0.05 USDC
    ok       caps.per_day 0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC

Nothing has been paid. Next: `superstables pay 2369a8ad-ede5-43c2-8b21-f85d4e2aa5c5` asks the wallet's owner to approve it; the owner's wallet checks the policy again.

TOOL Bash: superstables pay 2369a8ad-ede5-43c2-8b21-f85d4e2aa5c5 --json

OUTPUT:
Command did not complete within its 300s timeout and was moved to the background (ID: bq9y3lfj5). Output is being written to: /tmp/claude-1000/-home-alladin--cache-ev-runs-r-a375ebd9c4-cwd/fb85a5cf-a141-492f-8ec8-a8ee28ea6b4f/tasks/bq9y3lfj5.output. You will be notified when it completes. If it is still running after 10m in the background, it will be stopped and you will be notified. To check interim output, use Read on that file path.

TOOL Bash: cat /tmp/claude-1000/-home-alladin--cache-ev-runs-r-a375ebd9c4-cwd/fb85a5cf-a141-492f-8ec8-a8ee28ea6b4f/tasks/bq9y3lfj5.output

OUTPUT:
Paying quote 2369a8ad-ede5-43c2-8b21-f85d4e2aa5c5 (attempt 5581661c-6cd3-4ff6-a6de-a1dfa97b3eb9).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this approval link and approve the payment in your browser wallet:
  http://127.0.0.1:21277/approve/REDACTED

  expired: nobody approved this payment within 300 s
{
  "attempt_id": "5581661c-6cd3-4ff6-a6de-a1dfa97b3eb9",
  "quote_id": "2369a8ad-ede5-43c2-8b21-f85d4e2aa5c5",
  "state": "expired",
  "message": "Nobody approved the payment within the wallet's window. Nothing was signed.",
  "reason": "nobody approved this payment within 300 s",
  "final": true,
  "chain_final": null,
  "exit_code": 1,
  "next": "To ask again, take a new quote (this one is used): `superstables quote --service superstables-demo-market-data --param asset=BTC`, then `superstables pay <new-quote-id>` while the owner is ready to approve, with no --wait or a longer one.",
  "url": "https://www.superstables.com/api/demo/market?asset=BTC",
  "price": {
    "amount": 0.01,
    "asset": "USDC",
    "network": "eip155:84532",
    "network_label": "Base Sepolia (testnet)"
  },
  "recipient": "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E",
  "history": [
    {
      "at": "2026-10-18T15:06:20.974Z",
      "state": "awaiting_approval"
    },
    {
      "at": "2026-10-18T15:06:21.691Z",
      "state": "awaiting_approval",
      "note": "waiting for the owner to approve on the approval page (the link is in the output of this pay)"
    },
    {
      "at": "2026-10-18T15:11:22.202Z",
      "state": "expired"
    }
  ]
}

[exited with code 1]

AGENT: I couldn't get the BTC price. The payment needed your approval in a browser wallet, and nobody approved it, so nothing was paid.

- **Service found:** the Superstables demo market data API. It costs 0.01 USDC per request on Base Sepolia (testnet), which is under your 0.02 limit and within the default spend policy.
- **Cheaper option:** a third-party coin price API, `x402-coin-api.vercel.app`, lists 0.001 USDC per request. The quote for it failed with "fetch failed", so I used the demo service instead.
- **What happened:** the agent can't approve payments itself. `superstables pay` printed an approval link and waited 5 minutes. The link expired, and the quote it was tied to is now used. Nothing was signed.

To finish, you'd need to be ready to approve in MetaMask. I can take a new quote and run `superstables pay`, which gives a fresh link at `http://127.0.0.1:21277/approve/...`. You'd then open it and approve. Do you want me to do that now?

FINAL (success, 7 turns): I couldn't get the BTC price. The payment needed your approval in a browser wallet, and nobody approved it, so nothing was paid.

- **Service found:** the Superstables demo market data API. It costs 0.01 USDC per request on Base Sepolia (testnet), which is under your 0.02 limit and within the default spend policy.
- **Cheaper option:** a third-party coin price API, `x402-coin-api.vercel.app`, lists 0.001 USDC per request. The quote for it failed with "fetch failed", so I used the demo service instead.
- **What happened:** the agent can't approve payments itself. `superstables pay` printed an approval link and waited 5 minutes. The link expired, and the quote it was tied to is now used. Nothing was signed.

To finish, you'd need to be ready to approve in MetaMask. I can take a new quote and run `superstables pay`, which gives a fresh link at `http://127.0.0.1:21277/approve/...`. You'd then open it and approve. Do you want me to do that now?
