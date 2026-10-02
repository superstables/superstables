# Buy once

Use this when the owner is there to approve. The agent finds a paid service and reads its price
without paying. It then asks for one payment, and the owner approves or rejects it in their own
wallet. Nothing is paid without that approval, and every payment needs a new one. For purchases
without an approval each time, see [Budget](budget.md).

**Testnet only.** x402 with the `exact` scheme, test USDC on Base Sepolia (`eip155:84532`, token
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals). No real money moves. If the seller offers no payment option the client supports, it is refused before the owner is asked.

## What you need

- The client, installed and set up: [Install the client](install.md). Commands below use the
  installed `superstables` command.
- A browser wallet for the owner, such as MetaMask, on the computer that runs the client.
- Test USDC on Base Sepolia in that wallet, at least the price: free at
  <https://faucet.circle.com> (pick Base Sepolia). No ETH is needed: the facilitator that settles
  the payment pays the gas.

## 1. Find a service (agent)

The output below comes from separate runs on Base Sepolia, shortened: a browser-wallet approval
request, and a payment approved with the local wallet. Use the quote id, attempt id and approval
link from your own run.

```bash
superstables find "btc price"
```

```
id                             name                           price                   chains        pay  budget            live  simulated
-----------------------------  -----------------------------  ----------------------  ------------  ---  ----------------  ----  ---------
x402-coin-api.vercel.app       Coin price API (third party)   0.001 USDC per request  base-sepolia  yes  evm base-sepolia  yes   not said
superstables-demo-market-data  Superstables demo market data  0.01 USDC per request   base-sepolia  yes  evm base-sepolia  yes   no
```

The Superstables demo market data service is built in. `SUPERSTABLES_DEMO_SERVICES=on` adds
Superstables' simulated demo services to the list. Under the table, `find` prints the commands to pay
each listing, buy once first. `pay yes` means
this way of paying can call it. With `--json`, each service has `commands`; `next` is the first command to run, or `null` when
this client cannot pay the listing.

## 2. Price it without paying (agent)

```bash
superstables quote --service superstables-demo-market-data --param asset=BTC
```

```
  quote           b54cdbae-339a-4c84-965c-2d146ee5a945
  url             https://www.superstables.com/api/demo/market?asset=BTC
  service         Superstables demo market data
  price           0.01 USDC
  network         Base Sepolia (testnet)
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  expires         2026-10-01T23:18:26.048Z (10 minutes; one quote starts at most one payment)
  policy          allowed by /home/you/.superstables/policy.yaml
    ok       kill_switch  off
    ok       deny         empty
    ok       allow        empty: any host
    ok       stablecoins  USDC is in [USDC]
    ok       caps.per_call 0.01 USDC, at most 0.05 USDC
    ok       caps.per_day 0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC

```

A quote reads the seller's HTTP 402 answer and records its exact terms, without signing or paying.
It expires after 10 minutes. To quote a URL directly, run `superstables quote '<url>'` with its
query parameters; the seller must accept GET and offer the payment terms above.

## 3. Ask the owner (agent)

If your shell tool cannot show output while a command runs, use the detached command in
[From an agent](#from-an-agent) instead of the one below.

```bash
superstables pay b54cdbae-339a-4c84-965c-2d146ee5a945
```

```
Paying quote b54cdbae-339a-4c84-965c-2d146ee5a945 (attempt b65773de-a08b-4c91-b5c9-0729b4675a3a).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this link and approve the payment in your browser wallet:
  http://127.0.0.1:4412/approve/324a415688aa0b48d2ee25a8a1e9326e
```

`pay` asks the seller for its terms again and refuses if they changed. The client checks the spend
policy again before it serves the approval page.
Then it waits until the owner decides, for up to 5 minutes. The page works only while `pay` runs.

## 4. Approve or reject (owner)

Open the link in the browser that has your wallet, on the same computer. The page shows the
amount, the recipient and the network, worked out from the seller's payment terms, not from what
the agent says. What the agent says the payment is for is shown apart, under "Reported by the agent
(not verified)".

1. Press **Connect wallet**. The first time, the wallet asks to add or switch to Base Sepolia.
2. Press **Review in wallet**, and check the recipient and the amount in the wallet before you
   sign. If the wallet shows USDC's smallest unit, `10000` means 0.01 USDC.
3. Sign with your wallet, or reject the request on the page or in the wallet. Rejecting before
   signing produces no signature and no payment, and the client sends nothing more to the service.

## 5. Read the outcome (agent)

After the owner signs, the client sends the request again with the signed payment authorization.
The seller has a facilitator settle the payment and answers. On success, `pay` prints the receipt
and the service's response:

```
  approved
  submitting
  settled

Paid 0.01 USDC on Base Sepolia (testnet); settlement confirmed by the facilitator (transaction 0x12e62de0d1c67278c2a181a04df63a883671d648eeecf4be60e4e368c7def0e6). The service answered HTTP 200.

  receipt         b65773de-a08b-4c91-b5c9-0729b4675a3a
  paid            0.01 USDC
  transaction     https://sepolia.basescan.org/tx/0x12e62de0d1c67278c2a181a04df63a883671d648eeecf4be60e4e368c7def0e6
  payer           0x37DeDeEa845A7772BD4decfe573EaaBf660ad537
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  service         HTTP 200 (ok)

Service response (HTTP 200):
{
  "asset": "BTC",
  "price_usd": 84662.235,
  ...
}
```

It exits 0. Later, `status` shows the same for one attempt, and `receipts` lists the payments made
from this machine:

```bash
superstables status b65773de-a08b-4c91-b5c9-0729b4675a3a
superstables receipts --limit 5
```

## Outcomes

| State | What happened | Exit | What next |
| --- | --- | --- | --- |
| `settled` | Paid, and the service answered | 0 | Use the answer |
| `denied` | The owner rejected it; the client submitted no payment | 3 | Ask again only if the owner wants to |
| `expired` | Nobody decided within 5 minutes. Nothing was paid | 1 | A new quote, then `pay` |
| `abandoned` | `pay` stopped before anyone decided (it was stopped, or `--wait` ran out). Not a rejection. Nothing was paid | 1 | A new quote, then `pay`, with no short `--wait` |
| `failed` | Nothing was paid, and that is known: the policy refused it, the terms changed, or the payment did not settle. `reason` says which | 1 or 3 | Read `reason` and `next` |
| `paid_service_failed` | Paid, but the service answered with an error | 4 | Do not pay again. Report the receipt |
| `uncertain` | The payment may or may not have settled | 5 | Do not pay again. Follow [Quotes, attempts and receipts](records.md#why-failed-and-uncertain-are-different) |

`pay` on a used quote is refused (exit 2) and names the attempt it started; follow it with
`superstables status <attempt-id>`. If the approval page could not start or the local wallet was
not running, `next` says the same quote can still be paid.

## Or approve on superstables.com

With `superstables budget buy-once`, the owner approves the payment on superstables.com instead of a
page on this computer, from any device where they sign in with their wallet. It needs no setup, no
gas and no agent key. It pays on the network the service's listing names (Base Sepolia, Tempo
Moderato or Solana devnet), for the services the site lists. It needs a superstables.com account
(made by signing in with the wallet), or a compatible deployment the owner names with `--site` or
`SUPERSTABLES_SITE` (see [budget/CLI.md](../budget/CLI.md#hosted-approvals-what-a-compatible-site-must-do));
`pay`, above, needs neither:

```bash
superstables budget find --once
superstables budget buy-once --service superstables-demo-market-data --param asset=BTC --max 0.01
```

`--max` is the most you accept, in the service's token (USDC, or pathUSD on Tempo): a service that costs more is refused before anything is
created. The command prints an `APPROVE` line with the link and a match code. Run by an agent (stdout is not
a terminal), or with `--detach`, it then returns with `state: "waiting_owner"` and an approval `id`; in
a terminal it waits for the purchase to end. Send the `RESULT`'s `message_for_owner` (the link, the
code and the price) as a reply the owner can read, and end your turn there. The owner opens the link, signs in with their wallet the
first time (a message, no fee), picks the same code on the page and approves the payment in their
wallet. When they say they have, run:

```bash
superstables budget wait --id <id> --shown
```

`--shown` says you wrote the link in a reply; without it, `wait` refuses. While the owner has not
decided, it answers `waiting_owner` again. The final `RESULT` reports `paid` and `delivered`, the transaction when there is one, and
`responseFile` when the seller's answer was saved. Read `reason` and `next` before anything else, and
do not pay again if it was paid or its outcome is unknown. The site's side of this purchase
is the [HTTP purchase API](https://www.superstables.com/docs/purchase).

## From an agent

An agent's shell tool often shows output only when a command ends, and stops long commands. `pay`
must keep running until the owner decides, so start it detached and read the link from its log:

```bash
nohup superstables pay <quote-id> --json > pay.json 2> pay.log < /dev/null &
```

Read `pay.log` for the attempt id (its first line) and the approval link. Write the link exactly
as printed, with the price and the recipient, in a reply to the owner, and end your turn there:
some agent hosts show the owner nothing of a turn until it ends, and `pay` keeps the page open in
the background. When the owner says they have approved or rejected it, run
`superstables status <attempt-id> --json` and follow the outcomes table above; if `final` is
still `false`, say so in one line and end your turn again. `pay.json` holds the same result once
`pay` ends. Do not use a short `--wait`:
it ends the attempt as `abandoned` before the owner can act.

With MCP, the `pay` tool returns the link at once and the server keeps the page open;
`payment_status` reports the outcome. The `superstables-payments` skill covers both ways.

## Limits

- The spend policy (`policy.yaml`) caps each payment and each UTC day, and can allow or deny hosts.
  It is a check in this client, not a limit the chain enforces. See the
  [security model](security.md).
- The approval page is on `127.0.0.1`. Over SSH, forward the port in the link first:
  `ssh -L PORT:127.0.0.1:PORT user@host`.
- With no browser on the machine, `--wallet local` signs with a key in a file instead, and the
  owner still approves each payment, on that wallet's own page. See
  [Install the client](install.md#the-local-wallet-for-a-machine-with-no-browser).

Every command and flag: [CLI reference](cli.md).
