# find-and-pay-once / claude-opus (opus) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

Find me a paid API that returns the current BTC price and get me the price. Pay for it if it costs less than 0.02 USDC.

## Transcript

TOOL Bash: superstables --help; superstables help 2>&1 | head -50

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
... [7486 more characters in raw.jsonl]

TOOL Bash: superstables find "btc price" 2>&1; superstables doctor 2>&1

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
  client version           0.4.0
  home                     /home/alladin/.cache/ev-runs/r-c1fa66541f/superstables-home

✓ home directory           /home/alladin/.cache/ev-runs/r-c1fa66541f/superstables-home (writable)
✓ payment records          /home/alladin/.cache/ev-runs/r-c1fa66541f/superstables-home/records: none yet
✓ spend policy             /home/alladin/.cache/ev-runs/r-c1fa66541f/superstables-home/policy.yaml (missing, built-in defaults apply): up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:23913 is free; the agent serves the page itself
✓ demo service             https://www.superstables.com/api/demo/market asks for payment (HTTP 402)
✓ Superstables index       https://www.superstables.com/api/v1/services answered HTTP 200
✗ facilitator.x402.rs      could not be reached: fetch failed
✗ facilitator.payai.network could not be reached: fetch failed
✗ x402.org                 could not be reached: fetch failed

Everything this machine needs is in place.

TOOL Bash: superstables quote --service x402-coin-api.vercel.app --param symbol=BTC 2>&1; echo ---; superstables quote --service superstables-demo-market-data --param asset=BTC 2>&1

OUTPUT:
fetch failed
---
  quote           f5f6acf5-2b24-4bc9-b4b6-a80dc25c2a96
  url             https://www.superstables.com/api/demo/market?asset=BTC
  service         Superstables demo market data
  price           0.01 USDC
  network         Base Sepolia (testnet)
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  expires         2026-10-18T15:17:04.130Z (10 minutes; one quote starts at most one payment)
  policy          allowed by the built-in defaults (no policy file)
    ok       kill_switch  off
    ok       deny         empty
    ok       allow        empty: any host
    ok       stablecoins  USDC is in [USDC, pathUSD, USDG]
    ok       caps.per_call 0.01 USDC, at most 0.05 USDC
    ok       caps.per_day 0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC

Nothing has been paid. Next: `superstables pay f5f6acf5-2b24-4bc9-b4b6-a80dc25c2a96` asks the wallet's owner to approve it; the owner's wallet checks the policy again.

AGENT: The cheaper third-party API (0.001 USDC) is unreachable, so I'll go with the Superstables market data service at 0.01 USDC, which is under your 0.02 limit.

TOOL Bash: timeout 300 superstables pay f5f6acf5-2b24-4bc9-b4b6-a80dc25c2a96 2>&1; echo "exit=$?"

OUTPUT:
Paying quote f5f6acf5-2b24-4bc9-b4b6-a80dc25c2a96 (attempt fd398ddb-f418-4a82-98aa-47aed951cc38).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this approval link and approve the payment in your browser wallet:
  http://127.0.0.1:23913/approve/REDACTED

exit=124

TOOL Bash: superstables status fd398ddb-f418-4a82-98aa-47aed951cc38 2>&1

OUTPUT:
  attempt         fd398ddb-f418-4a82-98aa-47aed951cc38
  quote           f5f6acf5-2b24-4bc9-b4b6-a80dc25c2a96
  state           awaiting_approval (not final)
  url             https://www.superstables.com/api/demo/market?asset=BTC
  price           0.01 USDC

The owner has been asked to approve 0.01 USDC to 0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E on Base Sepolia (testnet) in their wallet. Nothing is signed yet. Run `superstables status fd398ddb-f418-4a82-98aa-47aed951cc38` to see where it got to.

Next: Run `superstables status fd398ddb-f418-4a82-98aa-47aed951cc38` to see where it got to.

This record moves only while the `superstables pay` command that started it is running. If that process has stopped, it will not change: nothing was signed if it is awaiting_approval, and whether it settled is unknown if it is approved or submitting.

TOOL Bash: superstables quote --service superstables-demo-market-data --param asset=BTC --json 2>/dev/null

OUTPUT:
{
  "id": "198632d8-2eaf-46e5-bedd-b4d2935baf60",
  "createdAt": "2026-10-18T15:12:27.772Z",
  "expiresAt": "2026-10-18T15:22:27.772Z",
  "status": "open",
  "url": "https://www.superstables.com/api/demo/market?asset=BTC",
  "serviceId": "superstables-demo-market-data",
  "serviceName": "Superstables demo market data",
  "description": "Superstables demo market data: spot price and 24h change for one asset (testnet, no real money)",
  "request": {
    "serviceId": "superstables-demo-market-data",
    "method": "GET",
    "url": "https://www.superstables.com/api/demo/market?asset=BTC",
    "params": {
      "asset": "BTC"
    }
  },
  "terms": {
    "amountDecimal": 0.01,
    "amountAtomic": "10000",
    "asset": "USDC",
    "assetAddress": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "network": "eip155:84532",
    "networkLabel": "Base Sepolia (testnet)",
    "recipient": "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E",
    "scheme": "exact",
    "x402Version": 2,
    "maxTimeoutSeconds": 300
  },
  "requirement": {
    "scheme": "exact",
    "network": "eip155:84532",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "amount": "10000",
    "payTo": "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "policy": {
    "allowed": true,
    "checks": [
      {
        "rule": "kill_switch",
        "ok": true,
        "detail": "off"
      },
      {
        "rule": "deny",
        "ok": true,
        "detail": "empty"
      },
      {
        "rule": "allow",
        "ok": true,
        "detail": "empty: any host"
      },
      {
        "rule": "stablecoins",
        "ok": true,
        "detail": "USDC is in [USDC, pathUSD, USDG]"
      },
      {
        "rule": "caps.per_call",
        "ok": true,
        "detail": "0.01 USDC, at most 0.05 USDC"
      },
      {
        "rule": "caps.per_day",
        "ok": true,
        "detail": "0.01 USDC paid today (UTC) + this 0.01 = 0.02, at most 1 USDC"
      }
    ]
  },
  "approval": "wallet",
  "next": "superstables pay 198632d8-2eaf-46e5-bedd-b4d2935baf60"
}

TOOL Bash: superstables receipts 2>&1 | head; superstables attempts 2>&1 | head

OUTPUT:
No receipt is recorded on this machine. `superstables attempts` lists every attempt and its state.
when                      attempt                               state              amount     service
------------------------  ------------------------------------  -----------------  ---------  -----------------------------
2026-10-18T15:07:10.306Z  fd398ddb-f418-4a82-98aa-47aed951cc38  awaiting_approval  0.01 USDC  Superstables demo market data

`superstables status <attempt>` explains one of them.

AGENT: Nothing was actually paid (the stalled attempt is just counted against the daily cap conservatively). Starting the payment again in the background so the approval page stays open:

TOOL Bash: superstables pay 198632d8-2eaf-46e5-bedd-b4d2935baf60 2>&1; echo "exit=$?"

OUTPUT:
Command running in background with ID: bfyoltumc. Output is being written to: /tmp/claude-1000/-home-alladin--cache-ev-runs-r-c1fa66541f-cwd/d0b1fc30-04f5-4f09-91bd-e1e7b27697c7/tasks/bfyoltumc.output. You will be notified when it completes. To check interim output, use Read on that file path.

TOOL Bash: cat /tmp/claude-1000/-home-alladin--cache-ev-runs-r-c1fa66541f-cwd/d0b1fc30-04f5-4f09-91bd-e1e7b27697c7/tasks/bfyoltumc.output

OUTPUT:
Paying quote 198632d8-2eaf-46e5-bedd-b4d2935baf60 (attempt 2dc4fd44-7dab-4f25-aa9e-3d660cdad3cd).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this approval link and approve the payment in your browser wallet:
  http://127.0.0.1:23913/approve/REDACTED

AGENT: I found a BTC price API under your limit, but I don't have the price yet. The payment needs your approval in your wallet, and this tool won't let me approve it for you.

**What I found:**
- **Coin price API** (third party, 0.001 USDC): cheaper, but it couldn't be reached when I asked for a price.
- **Superstables demo market data** (0.01 USDC per request): returns the live BTC spot price and 24h change. It's under your 0.02 USDC limit and within the default spending limits, so I'm using this one.

**To finish the payment:** open this link and approve 0.01 test USDC on Base Sepolia (a test network, so no real money moves) in your browser wallet (MetaMask):

http://127.0.0.1:23913/approve/REDACTED

The link only works while the payment command is running. It's running in the background now, and the quote it uses expires at 15:22 UTC. When it finishes, I'll send you the BTC price.

My first payment request stopped after 5 minutes because no one approved it. Nothing was signed or paid: no receipts are recorded. That stalled request is still counted against the daily spending cap, which is why the new quote shows 0.01 USDC "paid today."

FINAL (success, 10 turns): I found a BTC price API under your limit, but I don't have the price yet. The payment needs your approval in your wallet, and this tool won't let me approve it for you.

**What I found:**
- **Coin price API** (third party, 0.001 USDC): cheaper, but it couldn't be reached when I asked for a price.
- **Superstables demo market data** (0.01 USDC per request): returns the live BTC spot price and 24h change. It's under your 0.02 USDC limit and within the default spending limits, so I'm using this one.

**To finish the payment:** open this link and approve 0.01 test USDC on Base Sepolia (a test network, so no real money moves) in your browser wallet (MetaMask):

http://127.0.0.1:23913/approve/REDACTED

The link only works while the payment command is running. It's running in the background now, and the quote it uses expires at 15:22 UTC. When it finishes, I'll send you the BTC price.

My first payment request stopped after 5 minutes because no one approved it. Nothing was signed or paid: no receipts are recorded. That stalled request is still counted against the daily spending cap, which is why the new quote shows 0.01 USDC "paid today."

AGENT: I still don't have the BTC price. The second payment request expired after 5 minutes because nobody approved it in the wallet.

**Nothing was paid** on either try. Nothing was signed and no receipt is recorded. The expired quote can't be reused.

I've stopped here rather than sending you more approval links that run out. When you're at your browser wallet (MetaMask) and ready, tell me and I'll take a fresh quote and start the payment. The new link stays open for about 5 minutes. The service is the same one: Superstables demo market data, 0.01 USDC per request on Base Sepolia, so test USDC only.

If you'd rather approve whenever suits you, you can run these yourself:

```
superstables quote --service superstables-demo-market-data --param asset=BTC
superstables pay <quote-id>
```

The `pay` command prints the approval link and waits for you to approve.

FINAL (success, 1 turns): I still don't have the BTC price. The second payment request expired after 5 minutes because nobody approved it in the wallet.

**Nothing was paid** on either try. Nothing was signed and no receipt is recorded. The expired quote can't be reused.

I've stopped here rather than sending you more approval links that run out. When you're at your browser wallet (MetaMask) and ready, tell me and I'll take a fresh quote and start the payment. The new link stays open for about 5 minutes. The service is the same one: Superstables demo market data, 0.01 USDC per request on Base Sepolia, so test USDC only.

If you'd rather approve whenever suits you, you can run these yourself:

```
superstables quote --service superstables-demo-market-data --param asset=BTC
superstables pay <quote-id>
```

The `pay` command prints the approval link and waits for you to approve.
