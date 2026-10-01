# Running the demo

A script for showing this to a room. It takes about five minutes and has two halves: a payment
that goes through, and one you refuse. The second half is the point.

Everything is testnet. No real money moves at any stage.

## Before the room

Done once, not on stage.

```bash
npm install && npm run build
npx superstables setup
```

Connect the agent with the demo services switch on, so the prepared demo services are listed
next to the real sellers:

```bash
claude mcp add superstables -e SUPERSTABLES_DEMO_SERVICES=on -- node "$(pwd)/dist/mcp/main.js"
```

In MetaMask: have an account with test USDC on Base Sepolia — 1 USDC is plenty at 0.01 USDC a
call, from <https://faucet.circle.com>. No ETH is needed. If the account has never seen Base
Sepolia, connect it to the approval page once before the room so the network is already added:
the first connection asks MetaMask to add or switch networks, and that is one popup you do not
want to explain while people are watching.

There is nothing to start on the seller's side: the built-in listing points at the demo service
Superstables hosts, so there is already something to buy. Running a seller yourself is an
optional extra at the end.

Check the machine:

```bash
npx superstables doctor
```

Every line should be a ✓ or a "-". "browser wallet: no account connected yet" is normal.

Have two things on screen: the agent, and a browser window you can bring forward. Nothing else
needs to be running — that is worth saying out loud at the start, because the usual version of
this demo has a wallet daemon and a server in two terminals.

| Window | What it shows |
| --- | --- |
| 1 | the agent — the conversation. Claude Code has been run end to end with the MetaMask flow |
| 2 | the browser, where the approval page and MetaMask's popup appear |

## Part one: a payment that goes through

**1. Ask the agent to find something.**

> Find me a paid service for BTC market data.

It calls `find_services` and comes back with the demo market data service: 0.01 USDC per
request, Base Sepolia (testnet), live, actionable. Index listings appear underneath, marked as
not callable with the reason. The hosted catalogue's prepared demo services (simulated answers,
marked as such) show up only when the question matches what they sell.

**2. Ask what it costs.**

> Quote it for BTC. Don't pay yet.

It calls `quote` and reports the price, the network and the recipient address, and that nothing
has been paid. Say the quiet part out loud: reading a price from an x402 service is free, and
this quote has frozen the seller's exact terms, so what you approve is what the agent was
quoted.

**3. Tell it to pay.**

> Go ahead and pay it.

It calls `pay` and answers with a link:

> The owner has been asked to approve 0.01 USDC to 0x… on Base Sepolia (testnet). Open this
> link to review and sign in MetaMask: http://127.0.0.1:4412/approve/… Nothing is signed yet.

The agent has not paid anything. It cannot: all it can do is hand you that link.

**4. Open the link.**

The page shows, in large type:

- **0.01 USDC**
- **To** the full recipient address, in monospace
- **On** Base Sepolia, with a *testnet* tag
- **Expires in** a countdown
- a separate block: **Reported by the agent (not verified)** — the service name, the URL and its
  description

That split is the design. Everything above the line the page worked out for itself, from the
seller's payment requirement. Everything below it is what the agent says the payment is for, and
it changes nothing about what gets signed.

**5. Press "Connect wallet".**

MetaMask asks which account to connect, and — the first time — to add or switch to Base Sepolia.
The page then shows the connected address and prepares the authorization for exactly that
account.

**6. Press "Review in wallet" and sign.**

MetaMask shows the signature request: a `TransferWithAuthorization` with the recipient and the
value in it. Point at the `to` and the `value` before you press sign, and mention the one wart:
MetaMask shows the value in USDC's smallest unit, so `10000` is 0.01 USDC. The page says the
same thing underneath the amount.

Sign. The page says **Signed. You can go back to the agent.** The agent, asked again or
waiting, reports:

> Paid 0.01 USDC on Base Sepolia (testnet); settlement confirmed by the facilitator
> (transaction 0x…). The service answered HTTP 200.

and shows the BTC price it paid for.

**7. Show the receipt.**

```bash
npx superstables receipts --limit 1
```

The amount, the payer, the recipient, the transaction hash and the explorer link. Open the link:
`https://sepolia.basescan.org/tx/<hash>` is a real transfer on a real chain, a few seconds old.
Point out that the payer address is your MetaMask account, that nothing on this machine ever
held its key, and that a facilitator paid the gas.

## Part two: the refusal

**8. Ask for another one.**

> Quote it again for ETH and pay it.

The agent quotes, calls `pay`, and hands you a new link. Open it.

**9. Refuse.** Either way works, and both are worth showing if there is time:

- press **Reject** on the page — the decision never reaches MetaMask at all; or
- press **Connect wallet**, then **Review in wallet**, and press **Reject** in MetaMask's
  popup. The page says "You rejected this payment in your wallet. Nothing was signed.", and the
  payment ends there.

Either way, the page says the payment was rejected, and the agent reports:

> The owner rejected this payment in their wallet. Nothing was signed or submitted, and the
> service was not called.

Then show that this is true rather than merely stated:

```bash
npx superstables receipts --limit 5                                   # still one receipt
grep -o '"status":"[^"]*"' ~/.superstables/records/approvals.jsonl | tail -3
```

The approvals log has the request going `pending` and then `denied`, and nothing else. No
signature exists, so there was nothing to submit and nothing to revoke — and the seller was
never called, because there was nothing to call it with.

In this flow, the agent asks and the owner decides each payment. A budget, where the owner
approves once and the agent then buys on its own, is a separate tool with its own demo: see
[Budget](budget.md).

## If there is time

- **Let one expire.** Ask for a payment and do nothing. After five minutes the page says so and
  the agent reports `expired`. Nothing was signed.
- **Set a cap it will break.** Put `per_call: 0.005 USDC` in `~/.superstables/policy.yaml` and
  try to pay 0.01. The refusal happens before you are asked: there is no link, because there is
  nothing to approve. Say plainly that this is software policy, not a chain limit — see
  [security.md](security.md).
- **Pay the same quote twice.** Ask the agent to pay the quote it already paid. It is refused:
  one quote, at most one payment. See [records.md](records.md).
- **Run the seller too.** `npx superstables demo-service --pay-to 0xYourSellerAddress` with
  `SUPERSTABLES_DEMO_SERVICE_URL=http://127.0.0.1:4402/v1/market` set for the agent, and the
  seller's side of the payment logs one line per paid call in your terminal.

## Resetting between runs

```bash
rm -f ~/.superstables/records/*.jsonl        # forget quotes, attempts, receipts and approvals
```

Your MetaMask account is untouched by any of this. To rehearse without touching your usual
state, put `--home /tmp/superstables-demo` before every subcommand.

## Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| The page says "MetaMask (or another browser wallet) is needed" | No `window.ethereum` in this browser | Install MetaMask, or open the link in the browser that has it. The Reject button still works |
| MetaMask never opens when you press Connect | Its popup was suppressed, or it is locked | Open the MetaMask extension, unlock it, and press Connect again |
| The value in MetaMask looks a million times too big | It is in USDC's smallest unit | `10000` is 0.01 USDC. The page prints the conversion under the amount |
| The page says "This link is unavailable" | The link was already used, rejected, or expired, or the agent restarted | Ask the agent to quote and pay again |
| Agent: "the approval page could not start" and names a port | `SUPERSTABLES_APPROVE_PORT` fixes a port that is busy, probably with another payment waiting for its owner | Leave that process running. Unset `SUPERSTABLES_APPROVE_PORT`, or set it to a free port, then pay the same quote again |
| The page's countdown runs out while you look at MetaMask | Five minutes passed | Quote and pay again; nothing was signed |
| Payment fails: "the payment did not settle" with an insufficient-funds reason | The connected account has no test USDC | Top it up at <https://faucet.circle.com>; MetaMask shows the balance |
| Payment fails: "No facilitator could be reached" | All three public facilitators are unreachable | Check connectivity, then `superstables doctor`, which reports each facilitator separately. Nothing was signed, so nothing was spent |
| `find_services` shows the demo service with `live: false` | The hosted service did not answer 402 | Check connectivity; or run the seller yourself and set `SUPERSTABLES_DEMO_SERVICE_URL` to it |
| Agent: "Payment settled … but the service answered HTTP 5xx" | The money moved and the service then failed | Do not pay again. The receipt records both facts |
| Agent: "The payment may or may not have settled" | The credential was sent and no answer came back | Do not retry. Follow the steps in [records.md](records.md#why-failed-and-uncertain-are-different) |
| Claude Code `/mcp` does not list superstables | The server is not configured, or it will not start | `claude mcp list`, then run `node dist/mcp/main.js` by hand and read stderr |
| The agent sits for twenty seconds before giving you the link | `pay` waits for a decision before it answers, and you have not made one yet | Nothing is wrong. For a brisker demo, start the agent with `SUPERSTABLES_MCP_WAIT_MS=3000` and call `payment_status` after approving |
