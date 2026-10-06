# CLI reference

The `superstables` commands other than budgets, with the text their `--help` prints. The help is written to be enough on its own: what the command does, whether it can move money, who runs it, an example, what it prints and its exit codes. Budgets have their own page: [Budget CLI reference](cli-budget.md).

This page is generated from the help by `npm run docs:cli`, and CI fails when the two differ.

| Command | What it does |
| --- | --- |
| [`superstables setup`](#superstables-setup) | for pay: create the home directory and the policy file, then say what to do next |
| [`superstables wallet init`](#superstables-wallet-init) | create this machine's wallet key, or import one |
| [`superstables wallet serve`](#superstables-wallet-serve) | run the wallet: it asks the owner to approve every payment, in a browser page |
| [`superstables wallet status`](#superstables-wallet-status) | ask the running local wallet what it is doing |
| [`superstables wallet address`](#superstables-wallet-address) | the address that pays, from this machine's wallet key |
| [`superstables find`](#superstables-find) | search for services that charge per request, and say how each could be paid |
| [`superstables quote`](#superstables-quote) | ask a paid endpoint what one call costs, and check it against the spend policy; nothing is paid or signed |
| [`superstables pay`](#superstables-pay) | ask the owner to approve a quote in their wallet, and pay it if they do |
| [`superstables status`](#superstables-status) | where a payment attempt got to, and what to do next |
| [`superstables receipts`](#superstables-receipts) | the payments made from this machine, newest first |
| [`superstables attempts`](#superstables-attempts) | every payment attempt, paid or not, newest first |
| [`superstables demo-service`](#superstables-demo-service) | run the demo paid service, so there is something to buy on this machine |
| [`superstables doctor`](#superstables-doctor) | check everything pay needs, one line at a time |
| [`superstables policy show`](#superstables-policy-show) | print the policy in force |
| [`superstables policy init`](#superstables-policy-init) | write a commented policy.yaml, if there is not one already |

## superstables

```text
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
  help [command]                 display help for command

What this is:
  A client for paying per request with test USDC (pathUSD on Tempo): find a paid service, quote
  it, and pay it.
  The agent can ask for a payment but cannot approve one.

Two ways to pay:
  pay      The owner approves each payment in their own wallet: a browser wallet such as MetaMask
           (Phantom on Solana) on a page `pay` serves on 127.0.0.1 (the default), or the local
           wallet process (--wallet local, EVM chains only). x402 on the EVM chains below and
           Solana devnet, MPP on Tempo Moderato. Use it when the owner is there to approve.
  budget   The owner grants an on-chain budget once, from their wallet; the agent then buys on its
           own until the budget is spent, expires or is revoked. The chain enforces the limit.
           Rails: evm (Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
           Sepolia, Ethereum Sepolia), tempo (Tempo Moderato), solana (Solana devnet). Use it when
           the agent should buy without asking each time.

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
  owner   setup, wallet init, wallet serve, policy init, and every approval
  agent   find, quote, pay, status, receipts, attempts, doctor
  Either may run the read-only commands.

Where state lives:
  SUPERSTABLES_HOME, default ~/.superstables (--home <dir> for one command): policy.yaml,
  records/ (quotes, attempts, receipts, approvals), wallet/ (--wallet local only), keys/budget/
  and budget/ (budget only).

Discovery:
  find reads a built-in catalogue and the public index at https://www.superstables.com/api/v1/services.
  SUPERSTABLES_INDEX_URL points it at another index with the same API (a self-hosted one), or
  switches it off with `off`. Index listings show their payment protocols (rails) and chains, and
  whether pay or a budget rail could pay them. Only testnets are ever payable.

Environment:
  SUPERSTABLES_HOME              where state lives (default ~/.superstables)
  SUPERSTABLES_WALLET            browser (default) or local: who signs pay's payments
  SUPERSTABLES_POLICY            the spend policy file (default $SUPERSTABLES_HOME/policy.yaml)
  SUPERSTABLES_INDEX_URL         the index find reads; `off` to skip it
  SUPERSTABLES_DEMO_SERVICES     on: also list Superstables' testnet services from the hosted catalogue
                                 (most are simulated; the market data service returns live prices)
  SUPERSTABLES_CATALOGUE_URL     where those services are listed; `off` to skip it
  SUPERSTABLES_DEMO_SERVICE_URL  another instance of the demo market-data service
  SUPERSTABLES_RPC_URL           the Base Sepolia RPC for balances, the network MetaMask adds, and the chain
                                 check on a settlement (https, or http on this machine)
  SUPERSTABLES_TEMPO_RPC         the Tempo Moderato RPC for pay's chain checks (https, or http on this machine)
  SUPERSTABLES_SOLANA_RPC        the Solana devnet RPC for pay's chain checks (https, or http on this machine)
  SUPERSTABLES_APPROVE_PORT      a fixed port for pay's approval page; unset, 4412 or a free one when busy
  SUPERSTABLES_WALLET_URL        where the local wallet listens (default http://127.0.0.1:4411)
  SUPERSTABLES_DOCTOR_OFFLINE    1: doctor skips the network checks
  SUPERSTABLES_DEMO_PAY_TO       where demo-service's earnings go

Output:
  find, quote, pay, status, receipts and attempts take --json: one JSON value on stdout, progress
  and notes on stderr. An error under --json is {"error", "exit_code"} on stdout.

Exit codes (the same numbers as `superstables budget`):
  0  done: printed what was asked; for pay, the payment settled (chain: verified, or unchecked until checked
     again) and the service answered
  1  failed: nothing was paid. Includes an approval that expired or was abandoned, and a service or
     wallet that could not be reached
  2  bad input: unknown command or flag, a missing or wrong parameter, an unknown id, or a quote
     that is used or expired. Nothing was done
  3  refused: the owner rejected the payment, or a spend policy refused it. Nothing was paid
  4  paid, not delivered: the payment settled (verified or unchecked) but the service answered with an error,
     or its answer did not arrive in full. Do not pay again
  5  unknown: the payment may or may not have settled. Do not pay again until you have checked
     `superstables receipts` and the payer's account on the explorer
```

## superstables setup

```text
Usage: superstables setup [options]

for pay: create the home directory and the policy file, then say what to do next

Options:
  -h, --help  display help for command

Safe to run again: it never overwrites the policy or a key. With --wallet local it also creates this
machine's wallet key. This is the setup for `pay`; budgets start with `superstables budget setup
--rail evm`.

Moves money: no.
Run by: the owner, once per machine.
Example:
  $ superstables setup
  $ superstables --wallet local setup
Prints: the paths it wrote, how the owner approves payments, and what to run next.
Exit codes: 0 ready, 1 the home directory could not be written (the full table: superstables --help)
```

## superstables wallet

```text
Usage: superstables wallet [options] [command]

the local wallet process, for --wallet local only

Options:
  -h, --help        display help for command

Commands:
  init [options]    create this machine's wallet key, or import one
  serve [options]   run the wallet: it asks the owner to approve every payment,
                    in a browser page
  status [options]  ask the running local wallet what it is doing
  address           the address that pays, from this machine's wallet key
  help [command]    display help for command

Only used with --wallet local (or SUPERSTABLES_WALLET=local). In the default browser mode the
owner's key stays in their browser wallet and none of these commands is needed.

Moves money: only `wallet serve`, and only for payments the owner approves on its page.
Run by: the owner.
Example:
  $ superstables --wallet local wallet serve
Prints: see each subcommand's --help.
Exit codes: 0 done, 1 failed, 2 bad input (the full table: superstables --help)
```

## superstables wallet init

```text
Usage: superstables wallet init [options]

create this machine's wallet key, or import one

Options:
  --import-key-file <path>  import a private key from a file (mode 600)
  --force                   replace an existing key (the old key cannot be
                            recovered)
  -h, --help                display help for command

Moves money: no. The key file it writes can sign payments, so it is created readable by this user
  only.
Run by: the owner.
Example:
  $ superstables wallet init
Prints: the address and the key file's path.
Exit codes: 0 written, 1 a key exists already (pass --force to replace it) or the key could not be
  read, 2 bad input (the full table: superstables --help)
```

## superstables wallet serve

```text
Usage: superstables wallet serve [options]

run the wallet: it asks the owner to approve every payment, in a browser page

Options:
  --port <n>                    port to listen on (default 4411)
  --approval-timeout <seconds>  how long a request waits for the owner before it
                                expires (default 120)
  --no-open                     do not open the approval page in a browser
  -h, --help                    display help for command

Moves money: yes: it signs a payment when, and only when, the owner approves it on its page.
Run by: the owner, in a terminal of their own. Agents never run it.
Example:
  $ superstables --wallet local wallet serve
Prints: where it listens, the page's address, its launcher file and where the owner secret is (never
  the secret itself), then runs until Ctrl-C.
Exit codes: 0 stopped, 1 could not start (a port in use, no key: run `superstables wallet init`)
  (the full table: superstables --help)
```

## superstables wallet status

```text
Usage: superstables wallet status [options]

ask the running local wallet what it is doing

Options:
  --json      print the wallet's answer as JSON
  -h, --help  display help for command

Moves money: no.
Run by: the owner or the agent.
Example:
  $ superstables wallet status --json
Prints: address, network, balance, pending requests and the wallet's policy; the wallet's own JSON
  with --json.
Exit codes: 0 answered, 1 the wallet is not running (the full table: superstables --help)
```

## superstables wallet address

```text
Usage: superstables wallet address [options]

the address that pays, from this machine's wallet key

Options:
  -h, --help  display help for command

Moves money: no.
Run by: the owner or the agent.
Example:
  $ superstables wallet address
Prints: one address.
Exit codes: 0 printed, 1 no key yet (run `superstables wallet init`) (the full table: superstables
  --help)
```

## superstables find

```text
Usage: superstables find [options] [query]

search for services that charge per request, and say how each could be paid

Arguments:
  query        what to look for, in plain words

Options:
  --limit <n>  how many services to ask for (default: 20)
  --budget     show the listings a `superstables budget` rail could pay, instead
               of the ones pay can
  --all        show every listing, including those this client cannot pay, and
               why
  --demo       also list Superstables' testnet services from the hosted
               catalogue: most return prepared sample output and are marked
               simulated; the market data service returns live prices
               (SUPERSTABLES_DEMO_SERVICES=on does the same)
  --json       print {services, warnings} as JSON
  -h, --help   display help for command

Reads a built-in catalogue and the public index (SUPERSTABLES_INDEX_URL; `off` skips it). Columns:
pay is whether `superstables pay` can call the listing as listed (on a chain it pays on, with the
request parameters known); budget names the `superstables budget` rail and chain that could pay it;
simulated is yes when the listing marks the output as prepared sample output, no when it marks it as
not sample output (Superstables' market data service, which returns live prices; no does not verify
that the data is real), and not said when the listing does not say (mock in --json: true, false or
null). Chains are named as the index names them: base and solana are mainnets, and nothing on a
mainnet is payable here. By default only listings pay can call are shown.

Next, per listing: the commands for each way this client could pay it, pay first. pay: `superstables
quote`, then `superstables pay <quote-id>`. A budget on evm: `superstables budget preflight` (signs
nothing; prints the price and payTo), then `superstables budget buy --max <ceiling> --pay-to <payTo>
--op <new id>`. On tempo and solana there is no preflight: `buy` alone. Required parameters are
filled with an example value; index listings do not list theirs, so their URLs end in ?<parameters>.
A mainnet listing gets no command.

Moves money: no. It reads listings and asks each built-in service for its price, unpaid.
Run by: the agent or the owner.
Example:
  $ superstables find "btc price"
  $ superstables find --budget --json
Prints: a table, then the commands to pay each listing with pay, with a budget, or both. With
  --json: {services: [...], warnings: [...]}; each service has rails, chains, routes {pay, budget:
  [{rail, chain}]}, actionable, params, commands [{way: pay|budget, rail, chain, run: [...], note}]
  and next (the first command of commands, or null when this client cannot pay it).
Exit codes: 0 listed (also when nothing matched), 1 failed, 2 bad input (the full table:
  superstables --help)
```

## superstables quote

```text
Usage: superstables quote [options] [url]

ask a paid endpoint what one call costs, and check it against the spend policy;
nothing is paid or signed

Arguments:
  url                  a paid URL to quote directly, query string included

Options:
  --service <id>       quote a service found by `superstables find`
  --param <key=value>  a request parameter for the service (repeatable)
                       (default: [])
  --json               print the quote record, with policy.checks and next
  -h, --help           display help for command

A quote reads the seller's HTTP 402 challenge and records the exact terms the owner will be asked to
approve. It lasts 10 minutes and can start one payment attempt; after that attempt ends, however it
ends, take a new quote.

Moves money: no. Nothing is signed or sent; the seller is asked for its price without payment.
Run by: the agent or the owner.
Example:
  $ superstables quote --service x402-coin-api.vercel.app --param symbol=BTC
  $ superstables quote 'https://www.superstables.com/api/demo/market?asset=ETH'
Prints: the quote id, price, network, recipient, expiry, and each policy rule it was checked
  against. With --json: the quote record, with policy.checks [{rule, ok, detail}] and next.
Exit codes: 0 quoted and allowed, 1 the endpoint could not be quoted (not a paid endpoint,
  unreachable, or no payment this client can make), 2 bad input, 3 quoted but the spend policy
  refuses it (the full table: superstables --help)
```

## superstables pay

```text
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
port the approval link names: ssh -L 4412:127.0.0.1:4412). With --wallet local the request goes to
the wallet process, whose page outlives this command; approving there after pay has stopped pays
nothing, because nothing is left to submit it.

Chains: x402 with test USDC on Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base
Sepolia, Ethereum Sepolia and Solana devnet; MPP with test pathUSD on Tempo Moderato. The wallet
signs on the EVM chains and Solana, and pay submits what it signed. On Tempo the owner's wallet
sends the payment itself: pay records that before the wallet is asked, reads the owner's transaction
on chain, and only then calls the seller. Once the wallet has been asked to send, an attempt that
ends without a transaction report is uncertain, a rejection the page reports from the wallet
included, and `superstables status` searches the chain for it. --wallet local signs on the EVM
chains only.

How long it waits: with no --wait, until the attempt ends: the browser page gives the owner 5
minutes; with --wallet local, pay gives the wallet 130 s (the wallet's own window is 120 s by
default). After the owner approves, settlement takes up to 2 more minutes. --wait N stops waiting
for the owner after N seconds; if nobody has decided by then, the attempt ends `abandoned`, which is
not a rejection. Once the owner has approved, pay waits for the settlement whatever --wait says.

Ports: the page uses port 4412. When another pay on this machine is already waiting there for its
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
unchecked, when it rests on the seller's report until `superstables status` checks again); denied
(the owner rejected it), expired (nobody approved in the window), abandoned (the wait ended before
anyone decided; abandoned_by says whether this process was stopped, --wait ran out or the page
closed), failed (nothing was paid: the payment never left this machine, or chain unpaid, when the
chain shows it was never made and can no longer be); uncertain (the payment may or may not have
settled, including after the seller said it did not, and when the chain shows the seller's
transaction is not this payment: chain mismatch).

Moves money: yes, once, and only after the owner approves it in their own wallet. Calling pay only
  asks; the agent cannot approve.
Run by: the agent (or the owner); the owner approves.
Example:
  $ superstables pay 6f1c9a2e-0000-4000-8000-000000000000
  $ superstables pay <quote-id> --json > pay.json 2> pay.log &
Prints: each state as it happens, the approval link once, the outcome in one sentence, the receipt,
  the service's response and the next command. With --json, one object: attempt_id, quote_id, state,
  final, chain_final, message, next, reason, refusal, receipt (or transaction, for a payment without
  one), service_response, history.
Exit codes: 0 paid and delivered, 1 failed, expired or abandoned; nothing was paid when no
  transaction is reported, or chain is unpaid, 2 bad input (unknown, used or expired quote), 3
  refused (the owner rejected it, or a spend policy refused it), 4 paid but the service failed, 5
  unknown (the full table: superstables --help)
```

## superstables status

```text
Usage: superstables status [options] <attempt-id>

where a payment attempt got to, and what to do next

Arguments:
  attempt-id  the attempt to look up, from `superstables pay` or `superstables
              attempts`

Options:
  --json      print the same object as `pay --json`
  -h, --help  display help for command

Moves money: no. It reads this machine's records, and the chain again for an uncertain attempt, one
  a stopped process left approved or submitting, and a paid one whose chain is unchecked; it never
  starts or repeats a payment.
Run by: the agent or the owner.
Example:
  $ superstables status <attempt-id>
  $ superstables status <attempt-id> --json
Prints: the attempt, its state, the outcome in one sentence, the receipt and the service's response
  when there is one, and the next command. With --json, the same object as `pay --json`.
Exit codes: the attempt's own code, as `pay` would have exited: 0 settled or not final yet, 1
  nothing was paid, 3 refused, 4 paid but the service failed, 5 unknown; 2 when there is no such
  attempt (the full table: superstables --help)
```

## superstables receipts

```text
Usage: superstables receipts [options]

the payments made from this machine, newest first

Options:
  --limit <n>  how many to show (default: 20)
  --json       print the receipt records as a JSON array
  -h, --help   display help for command

One receipt for each payment the seller reported settled, or the chain showed. The chain column says
verified when the client read the transaction on chain and it is this payment. JSON chain_final
reports permanent finality separately. Unchecked means a matching payment has not been established
(`superstables status` checks again). A later check can mark the receipt mismatch and the attempt
uncertain, or unpaid when the chain shows the payment was never made and can no longer be (the
attempt is then failed, and the receipt no longer counts against the daily cap). Do not pay again. A
receipt records the payment and the service's answer separately.

Moves money: no.
Run by: the agent or the owner.
Example:
  $ superstables receipts --limit 5
Prints: a table of receipts. With --json, the receipt records newest first, with transaction,
  transactionUrl and payer only when well formed; the retained settlement fields are under
  untrusted_seller_report.
Exit codes: 0 listed (also when there are none), 2 bad input (the full table: superstables --help)
```

## superstables attempts

```text
Usage: superstables attempts [options]

every payment attempt, paid or not, newest first

Options:
  --limit <n>  how many to show (default: 20)
  --json       print the attempt records as a JSON array
  -h, --help   display help for command

Moves money: no.
Run by: the agent or the owner.
Example:
  $ superstables attempts --json
Prints: a table of attempts and their states. With --json, the attempt records newest first, with
  transaction, transactionUrl and payer only when well formed; the service's answer and reason, and
  anything that did not pass those checks, are under untrusted_seller_data.
Exit codes: 0 listed (also when there are none), 2 bad input (the full table: superstables --help)
```

## superstables demo-service

```text
Usage: superstables demo-service [options]

run the demo paid service, so there is something to buy on this machine

Options:
  --port <n>         port to listen on (default 4402)
  --pay-to <0x>      where the money goes (default: SUPERSTABLES_DEMO_PAY_TO)
  --price <decimal>  price per call in USDC
  -h, --help         display help for command

The seller side of the demo. Point discovery at it with
SUPERSTABLES_DEMO_SERVICE_URL=http://127.0.0.1:4402/v1/market.

Moves money: it receives test USDC; it never pays.
Run by: a developer who wants to see the seller side.
Example:
  $ superstables demo-service --pay-to 0xYourAddress
Prints: where it listens and a line per paid call, until Ctrl-C.
Exit codes: 0 stopped, 1 could not start, 2 bad input (the full table: superstables --help)
```

## superstables doctor

```text
Usage: superstables doctor [options]

check everything pay needs, one line at a time

Options:
  --json      print the checks as JSON
  -h, --help  display help for command

For budgets, run `superstables budget doctor --rail evm` instead.

Moves money: no.
Run by: the agent or the owner.
Example:
  $ superstables doctor
  $ superstables --wallet local doctor --json
Prints: one line per check with ✓ or ✗ and what to do about it. With --json, {ok, checks, mode,
  version, home, offline}.
Exit codes: 0 everything essential is in place, 1 something essential is missing (the full table:
  superstables --help)
```

## superstables policy

```text
Usage: superstables policy [options] [command]

the spend policy this client and the wallet both apply to pay

Options:
  -h, --help      display help for command

Commands:
  show [options]  print the policy in force
  init [options]  write a commented policy.yaml, if there is not one already
  help [command]  display help for command

policy.yaml sets caps per payment and per day, host allow and deny lists, the accepted stablecoins
and a kill switch. It is software policy, checked by this client and again by the wallet; the chain
does not enforce it. Budgets have their own on-chain limits instead.

The per-day cap: a payment counts on the day it ended, and on every day while it is still open
(signed and in flight until its authorization expires, or waiting for the owner within its approval
window). pay reserves the amount before the owner is asked, so two payments started at once cannot
both pass; one that ends unsigned releases it.

Moves money: no.
Run by: the owner writes it; anyone may read it.
Example:
  $ superstables policy show
Prints: see each subcommand's --help.
Exit codes: 0 done, 1 failed, 2 bad input (the full table: superstables --help)
```

## superstables policy show

```text
Usage: superstables policy show [options]

print the policy in force

Options:
  --json      print the parsed policy
  -h, --help  display help for command

Moves money: no.
Run by: the agent or the owner.
Example:
  $ superstables policy show
Prints: the file, a one-line summary and the file's text. With --json, the parsed policy.
Exit codes: 0 printed, 1 the file could not be parsed (the full table: superstables --help)
```

## superstables policy init

```text
Usage: superstables policy init [options]

write a commented policy.yaml, if there is not one already

Options:
  --force     overwrite the existing policy file
  -h, --help  display help for command

Moves money: no.
Run by: the owner. An agent must not change the owner's policy.
Example:
  $ superstables policy init
Prints: the path written and the policy now in force.
Exit codes: 0 written, 1 a policy exists already (pass --force to replace it) (the full table:
  superstables --help)
```
