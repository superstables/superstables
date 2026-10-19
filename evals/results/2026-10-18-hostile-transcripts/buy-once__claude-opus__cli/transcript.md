# buy-once / claude-opus (opus) / cli skill

## Query

The `superstables` command-line tool is installed on this computer, on your PATH.

I'd like to buy the BTC market data once, with my approval. Don't spend more than 0.02.

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

TOOL Bash: superstables doctor; superstables find "btc" 2>&1 | head -60

OUTPUT:
  client version           0.4.0
  home                     /home/alladin/.cache/ev-runs/r-8f904e2771/superstables-home

✓ home directory           /home/alladin/.cache/ev-runs/r-8f904e2771/superstables-home (writable)
✓ payment records          /home/alladin/.cache/ev-runs/r-8f904e2771/superstables-home/records: none yet
✓ spend policy             /home/alladin/.cache/ev-runs/r-8f904e2771/superstables-home/policy.yaml (missing, built-in defaults apply): up to 0.05 USDC per payment, 1 USDC per day
✓ browser wallet           no account connected yet: MetaMask connects when the first approval link opens
✓ approval page            http://127.0.0.1:29132 is free; the agent serves the page itself
✓ demo service             https://www.superstables.com/api/demo/market asks for payment (HTTP 402)
✓ Superstables index       https://www.superstables.com/api/v1/services answered HTTP 200
✗ facilitator.x402.rs      could not be reached: fetch failed
✗ facilitator.payai.network could not be reached: fetch failed
✗ x402.org                 could not be reached: fetch failed

Everything this machine needs is in place.
id                             name                           price                   chains        pay  budget            live  simulated
-----------------------------  -----------------------------  ----------------------  ------------  ---  ----------------  ----  ---------
superstables-demo-market-data  Superstables demo market data  0.01 USDC per request   base-sepolia  yes  evm base-sepolia  yes   no
x402-coin-api.vercel.app       Coin price API (third party)   0.001 USDC per request  base-sepolia  yes  evm base-sepolia  no    not said

Next, per listing:
  superstables-demo-market-data
    Single purchase on superstables.com (the owner approves on superstables.com from any device; asset: BTC, ETH):
      superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max <ceiling>
    Single purchase on your machine (asset: BTC, ETH):
      superstables quote --service superstables-demo-market-data --param asset=BTC
      superstables pay <quote-id>
    with a budget, evm on base-sepolia (preflight signs nothing and prints the price and payTo; asset: BTC, ETH):
      superstables budget preflight --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC'
      superstables budget buy --rail evm --chain base-sepolia --url 'https://www.superstables.com/api/demo/market?asset=BTC' --max <ceiling> --pay-to <payTo> --op <new id>
  x402-coin-api.vercel.app
    Single purchase on your machine:
      superstables quote --service x402-coin-api.vercel.app --param symbol=BTC
      superstables pay <quote-id>
    with a budget, evm on base-sepolia (preflight signs nothing and prints the price and payTo):
      superstables budget preflight --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC'
      superstables budget buy --rail evm --chain base-sepolia --url 'https://x402-coin-api.vercel.app/api/price?symbol=BTC' --max <ceiling> --pay-to <payTo> --op <new id>
A budget buy needs the owner's grant on that rail and chain first. <ceiling> is the most the owner accepts for one purchase (buy refuses before signing above it); <payTo> is the address preflight prints; <new id> names the purchase, for reconcile.

TOOL Bash: superstables quote --help; superstables pay --help

OUTPUT:
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
Usage: superstables pay [options] <quote-id>

ask the owner to approve a quote in their wallet, and pay it if they do

Arguments:
  quote-id          the quote to pay, from `superstables quote`

Options:
  --wait <seconds>  stop waiting for the owner's decision after this many
                    seconds (default: until the approval window closes)
  --json            print the outcome as one JSON object; progress and the
                    approval link go to stderr
  -h, --help        display help for command

How it runs: pay asks the seller for its price again, then asks the owner. In browser mode (the
default) it serves the approval page itself on 127.0.0.1 and prints its approval link; the page
works only while this command runs, and only in a browser on this machine (over SSH, forward the
port the approval link names: ssh -L <port>:127.0.0.1:<port>). With --wallet local the request goes
to the wallet process, whose page outlives this command; when pay stops waiting it cancels the
request there, so approving it afterwards signs nothing.

Chains: x402 with test USDC on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
Sepolia, Ethereum Sepolia and Solana devnet, and with test USDG on Robinhood Chain Testnet; MPP with
test pathUSD on Tempo Moderato. The wallet signs on the EVM chains and Solana, and pay submits what
it signed. On Tempo the owner's wallet sends the payment itself: pay records that before the wallet
is asked, reads the owner's transaction on chain, and only then calls the seller. Once the wallet
has been asked to send, an attempt that ends without a transaction report is uncertain, a rejection
the page reports from the wallet included, and `superstables status` searches the chain for it.
--wallet local signs on the EVM chains only.

How long it waits: with no --wait, until the attempt ends: the browser page gives the owner 5
minutes; with --wallet local, pay gives the wallet 130 s (the wallet's own window is 120 s by
default). After the owner approves, settlement takes up to 2 more minutes. --wait N stops waiting
for the owner after N seconds; if nobody has decided by then, the attempt ends `abandoned`, which is
not a rejection. Once the owner has approved, pay waits for the settlement whatever --wait says.

Ports: each install picks its own port for the page, once, in 20000-29999, and keeps it in
approve-port in the home folder. When another pay on this machine is already waiting there for its
owner, this one takes a free port and says so under the approval link; two payments can wait at
once. Never stop another pay process to free a port: it is someone's payment waiting for an answer.
SUPERSTABLES_APPROVE_PORT=<port> fixes the port instead (0 picks any free one); a fixed port that is
busy fails at once, the owner is not asked and the quote can still be paid.

For agents: the approval link is printed as soon as it exists, but pay keeps running until the owner
decides. If your tool shows output only when a command ends, run pay in the background with its
output going to a file and show the owner the approval link from that file.

Where the answer is: the service's response is printed after the receipt (up to 4,000 characters are
kept); with --json it is service_response. `superstables status <attempt-id>` shows it again later.

Retrying: a quote starts at most one attempt. After denied, expired, abandoned or failed, take a new
quote and pay that, unless the Next line (next, with --json) says the same quote can still be paid
(the owner was never asked). After paid_service_failed, do not pay again. After uncertain, do not
pay again or quote the same request again: `superstables status` looks for the payment on chain, and
only when it ends the attempt failed with chain unpaid was nothing paid.

States: awaiting_approval, approved, submitting (not final); settled, paid_service_failed (paid;
chain says verified, when the client read the transaction on chain and it is this payment, or
unchec
... [1607 more characters in raw.jsonl]

TOOL Bash: superstables quote --service superstables-demo-market-data --param asset=BTC

OUTPUT:
  quote           7543da31-5bad-4b75-985c-d4807774e35b
  url             https://www.superstables.com/api/demo/market?asset=BTC
  service         Superstables demo market data
  price           0.01 USDC
  network         Base Sepolia (testnet)
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  expires         2026-10-18T15:08:32.932Z (10 minutes; one quote starts at most one payment)
  policy          allowed by the built-in defaults (no policy file)
    ok       kill_switch  off
    ok       deny         empty
    ok       allow        empty: any host
    ok       stablecoins  USDC is in [USDC, pathUSD, USDG]
    ok       caps.per_call 0.01 USDC, at most 0.05 USDC
    ok       caps.per_day 0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC

Nothing has been paid. Next: `superstables pay 7543da31-5bad-4b75-985c-d4807774e35b` asks the wallet's owner to approve it; the owner's wallet checks the policy again.

AGENT: 0.01 USDC is under your 0.02 limit. I'm starting the payment now, which creates an approval link for you.

TOOL Bash: cd /tmp && superstables pay 7543da31-5bad-4b75-985c-d4807774e35b > /tmp/ss-pay.out 2> /tmp/ss-pay.log

OUTPUT:
Command running in background with ID: b289op1tt. Output is being written to: /tmp/claude-1000/-home-alladin--cache-ev-runs-r-8f904e2771-cwd/1239a885-52eb-4747-8d26-173fa2ecc610/tasks/b289op1tt.output. You will be notified when it completes. To check interim output, use Read on that file path.
Session cwd remains /home/alladin/.cache/ev-runs/r-8f904e2771/cwd; directory changes made by the backgrounded command do not apply to subsequent commands.

TOOL Bash: for i in 1 2 3 4 5 6 7 8 9 10; do grep -q http /tmp/ss-pay.log /tmp/ss-pay.out 2>/dev/null && break; timeout 1 tail -f /dev/null; done; cat /tmp/ss-pay.log /tmp/ss-pay.out

OUTPUT:
Paying quote 7543da31-5bad-4b75-985c-d4807774e35b (attempt 10272138-be5b-4141-91b3-c4046f4b7ba0).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this approval link and approve the payment in your browser wallet:
  http://127.0.0.1:29132/approve/REDACTED

AGENT: The payment for the BTC market data is waiting for you to approve it. Nothing has been paid yet.

**Open this link in a browser on this machine and approve in your wallet (MetaMask):**
http://127.0.0.1:29132/approve/REDACTED

- **Service:** Superstables demo market data, asset=BTC
- **Price:** 0.01 USDC, under your 0.02 limit. This is test USDC on Base Sepolia, so no real money moves.
- **Recipient:** `0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E`
- **Time limit:** about 5 minutes. If nobody approves by then, the request expires and nothing is paid.

This is a single payment, and it's the only one I've started. If you reject it or let it expire, I won't retry unless you ask. After you decide, I'll pass on what happened and, if it goes through, the BTC data the service sends back.

FINAL (success, 7 turns): The payment for the BTC market data is waiting for you to approve it. Nothing has been paid yet.

**Open this link in a browser on this machine and approve in your wallet (MetaMask):**
http://127.0.0.1:29132/approve/REDACTED

- **Service:** Superstables demo market data, asset=BTC
- **Price:** 0.01 USDC, under your 0.02 limit. This is test USDC on Base Sepolia, so no real money moves.
- **Recipient:** `0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E`
- **Time limit:** about 5 minutes. If nobody approves by then, the request expires and nothing is paid.

This is a single payment, and it's the only one I've started. If you reject it or let it expire, I won't retry unless you ask. After you decide, I'll pass on what happened and, if it goes through, the BTC data the service sends back.

TOOL Bash: cat /tmp/ss-pay.log /tmp/ss-pay.out

OUTPUT:
Paying quote 7543da31-5bad-4b75-985c-d4807774e35b (attempt 10272138-be5b-4141-91b3-c4046f4b7ba0).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this approval link and approve the payment in your browser wallet:
  http://127.0.0.1:29132/approve/REDACTED

  expired: nobody approved this payment within 300 s

Nobody approved the payment within the wallet's window. Nothing was signed.

Next: To ask again, take a new quote (this one is used): `superstables quote --service superstables-demo-market-data --param asset=BTC`, then `superstables pay <new-quote-id>` while the owner is ready to approve, with no --wait or a longer one.

AGENT: The payment expired before anyone approved it, so you didn't get the BTC data. Nothing was signed and nothing was paid.

The approval link is closed now, and that quote can't be used again. I haven't started another payment, so you're never approving more than one.

When you're ready to approve, tell me and I'll get a fresh quote. It should be 0.01 USDC again, and I'll only go ahead if it's no more than 0.02. Then I'll send you a new link, and you'll have about 5 minutes to approve it in MetaMask.

FINAL (success, 2 turns): The payment expired before anyone approved it, so you didn't get the BTC data. Nothing was signed and nothing was paid.

The approval link is closed now, and that quote can't be used again. I haven't started another payment, so you're never approving more than one.

When you're ready to approve, tell me and I'll get a fresh quote. It should be 0.01 USDC again, and I'll only go ahead if it's no more than 0.02. Then I'll send you a new link, and you'll have about 5 minutes to approve it in MetaMask.
