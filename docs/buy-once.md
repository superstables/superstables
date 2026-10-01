# Buy once

Use this when the owner is there to approve. The agent finds a paid service and reads its price
without paying. It then asks for one payment, and the owner approves or rejects it in their own
wallet. Nothing is paid without that approval, and every payment needs a new one. For purchases
without an approval each time, see [Budget](budget.md).

**Testnet only.** x402 with the `exact` scheme, test USDC on Base Sepolia (`eip155:84532`, token
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, 6 decimals). No real money moves. A seller that asks
for another network, asset or scheme is refused before the owner is asked.

## What you need

- The client, installed and set up: [Install the client](install.md). Commands below run from a
  checkout as `npx superstables`; use `superstables` if it is on your PATH.
- A browser wallet for the owner, such as MetaMask, on the computer that runs the client.
- Test USDC on Base Sepolia in that wallet, at least the price: free at
  <https://faucet.circle.com> (pick Base Sepolia). No ETH is needed: the facilitator that settles
  the payment pays the gas.

## 1. Find a service (agent)

```bash
npx superstables find "btc price"
```

```
id                             name                           price                   chains        pay  budget            live  simulated
-----------------------------  -----------------------------  ----------------------  ------------  ---  ----------------  ----  ---------
x402-coin-api.vercel.app       Coin price API (third party)   0.001 USDC per request  base-sepolia  yes  evm base-sepolia  yes   not said
superstables-demo-market-data  Superstables demo market data  0.01 USDC per request   base-sepolia  yes  evm base-sepolia  yes   no
```

Under the table, `find` prints the commands to pay each listing, buy once first. `pay yes` means
this way of paying can call it. With `--json`, each service has `commands`, and `next` is the first
one.

## 2. Price it without paying (agent)

```bash
npx superstables quote --service superstables-demo-market-data --param asset=BTC
```

```
  quote           b54cdbae-339a-4c84-965c-2d146ee5a945
  url             https://www.superstables.com/api/demo/market?asset=BTC
  service         Superstables demo market data
  price           0.01 USDC
  network         Base Sepolia (testnet)
  recipient       0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E
  expires         2026-10-01T23:04:26.243Z (10 minutes; one quote starts at most one payment)
  policy          allowed by /home/you/.superstables/policy.yaml
    ok       kill_switch  off
    ok       deny         empty
    ok       allow        empty: any host
    ok       stablecoins  USDC is in [USDC]
    ok       caps.per_call 0.01 USDC, at most 0.05 USDC
    ok       caps.per_day 0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC

Nothing has been paid. Next: `superstables pay b54cdbae-339a-4c84-965c-2d146ee5a945` asks the wallet's owner to approve it; the owner's wallet checks the policy again.
```

A quote reads the seller's HTTP 402 answer and records its exact terms. Nothing is signed. It is
good for 10 minutes, and it can start one payment. `quote <url>` works for any x402 URL.

## 3. Ask the owner (agent)

```bash
npx superstables pay b54cdbae-339a-4c84-965c-2d146ee5a945
```

```
Paying quote b54cdbae-339a-4c84-965c-2d146ee5a945 (attempt b65773de-a08b-4c91-b5c9-0729b4675a3a).
  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)

Open this link and approve the payment in your browser wallet:
  http://127.0.0.1:4412/approve/324a415688aa0b48d2ee25a8a1e9326e
```

`pay` asks the seller for its terms again, refuses if they changed, and serves the approval page.
Then it waits until the owner decides, for up to 5 minutes. The page works only while `pay` runs.

## 4. Approve or reject (owner)

Open the link in the browser that has your wallet, on the same computer. The page shows the
amount, the recipient and the network, worked out from the seller's payment terms, not from what
the agent says. What the agent says the payment is for is shown apart, under "Reported by the agent
(not verified)".

1. Press **Connect wallet**. The first time, the wallet asks to add or switch to Base Sepolia.
2. Press **Review in wallet**, and check the recipient and the amount in the wallet before you
   sign. The wallet shows the amount in USDC's smallest unit: `10000` is 0.01 USDC.
3. Sign, or press **Reject** on the page or in the wallet. A rejection signs nothing and pays
   nothing, and the service is not called.

## 5. Read the outcome (agent)

When the owner signs, a facilitator settles the payment, the client calls the service and `pay`
prints the result:

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
npx superstables status b65773de-a08b-4c91-b5c9-0729b4675a3a
npx superstables receipts --limit 5
```

## Outcomes

| State | What happened | Exit | What next |
| --- | --- | --- | --- |
| `settled` | Paid, and the service answered | 0 | Use the answer |
| `denied` | The owner rejected it. Nothing was signed or paid | 3 | Ask again only if the owner wants to |
| `expired` | Nobody decided within 5 minutes. Nothing was paid | 1 | A new quote, then `pay` |
| `abandoned` | `pay` stopped before anyone decided (it was stopped, or `--wait` ran out). Not a rejection. Nothing was paid | 1 | A new quote, then `pay`, with no short `--wait` |
| `failed` | Nothing was paid, and that is known: the policy refused it, the terms changed, or the payment did not settle. `reason` says which | 1 or 3 | Read `reason` and `next` |
| `paid_service_failed` | Paid, but the service answered with an error | 4 | Do not pay again. Report the receipt |
| `uncertain` | The payment left this machine and its outcome is not known | 5 | Do not pay again. Follow [Quotes, attempts and receipts](records.md#why-failed-and-uncertain-are-different) |

A quote starts at most one payment. `pay` on a used quote is refused (exit 2) and names the
payment it started; follow that one with `superstables status <attempt-id>`.

## From an agent

An agent's shell tool often shows output only when a command ends, and stops long commands. `pay`
must keep running until the owner decides, so start it detached and read the link from its log:

```bash
nohup npx superstables pay <quote-id> --json > pay.json 2> pay.log < /dev/null &
```

Show the owner the link exactly as printed, with the price and the recipient, then poll
`npx superstables status <attempt-id> --json` until `final` is `true`. Do not use a short `--wait`:
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
