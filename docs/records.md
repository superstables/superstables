# Quotes, attempts and receipts

Every fact this client learns about a payment is written to disk before the next step starts.
That is not bookkeeping for its own sake: a payment can fail in ways where the only honest
answer is "here is what is known", and a record you can read afterwards is what makes that
answer possible.

## The files

```
~/.superstables/records/quotes.jsonl      what a seller said a call would cost
~/.superstables/records/attempts.jsonl    what happened when we tried to pay
~/.superstables/records/receipts.jsonl    payments where the money actually moved
~/.superstables/records/approvals.jsonl   what the owner was asked, and what they answered
```

One JSON object per line, append-only, mode 0600. A record is never rewritten in place: a
change is a new line with the same `id`, and the newest line for an id wins. The whole history
stays readable, in order, with `tail` or `jq`.

```bash
grep -o '"state":"[^"]*"' ~/.superstables/records/attempts.jsonl | tail -5
```

With `jq` installed, `jq -c '{id, state, reason}'` over the same file reads better. Neither is
required: these are lines of JSON, and `tail` is a perfectly good reader.

Two consequences worth knowing. A line torn by a crash or a full disk is skipped on read
rather than hiding every record behind it, so a damaged file still answers. And the files
contain no key and no signature, but they do say what was bought and for how much, which is
why they are 0600.

Set `SUPERSTABLES_HOME` to put all of this somewhere else.

## Quotes

A quote is a read. It asks a paid endpoint for its 402 challenge, judges what the endpoint
offers, and writes down the answer. Nothing is signed, nothing is paid, nothing is committed.

What it freezes is the exact requirement the seller published — amount, asset, network,
recipient — so that the owner later approves the same payment the agent was quoted. Everything
on the quote is derived from that requirement; nothing is taken from the seller's
self-declared resource URL, which a seller can write anything in.

A quote also carries the local policy's verdict. A refusal is recorded on the quote rather than
thrown, so a caller can show the owner both what was asked for and why this machine would not
pay it.

| Quote status | Meaning |
| --- | --- |
| `open` | Good to pay. Quotes are good for 10 minutes |
| `used` | An attempt exists for it. It can never be paid again |
| `stale` | The seller's terms changed between quoting and paying. Quote again |
| `expired` | The 10 minutes ran out. Quote again |

## The duplicate-payment guard

The quote is the guard. The moment an attempt is created, the quote is marked `used` —
synchronously, before anything is awaited, so two calls in the same tick cannot both start.
A second `pay` on the same quote is refused (exit 2) with a message that names the payment
that exists: "A payment for this quote already exists: attempt ATTEMPT_ID, STATE", and
`superstables status ATTEMPT_ID` to follow it.

One quote, at most one attempt, at most one payment. To pay the same service twice, quote it
twice.

## Attempts

An attempt is a small state machine. Each transition is written to `attempts.jsonl`, and the
attempt carries its own `history` of every state it has been in, with timestamps.

```
                    ┌── policy refusal, terms changed, no wallet to ask ───→ failed
                    │
awaiting_approval ──┼── the owner says no ──────────────────────────────────→ denied
                    │
                    ├── nobody answers in time ─────────────────────────────→ expired
                    │
                    ├── the wait ends before anyone decides ────────────────→ abandoned
                    │
                    └── the owner approves ──→ approved ──→ submitting ──┬──→ settled
                                                                         ├──→ paid_service_failed
                                                                         ├──→ failed
                                                                         └──→ uncertain
```

| State | Final | What it means |
| --- | --- | --- |
| `awaiting_approval` | no | The owner has been asked, and the attempt carries the `approvalUrl` they have to open. **Nothing is signed.** Nothing has left this machine |
| `approved` | no | The owner signed in their wallet. The credential has not been sent yet |
| `submitting` | no | The request is being replayed with the payment credential attached |
| `denied` | yes | The owner rejected it — on the approval page, or in MetaMask's own popup. Nothing was signed, nothing was submitted, the service was not called |
| `expired` | yes | Nobody answered within the approval window (five minutes in browser mode, 120 seconds with the local wallet). Nothing was signed |
| `abandoned` | yes | Nobody decided: whoever was waiting for the owner stopped first (`pay --wait` ran out, `pay` was interrupted, or the process serving the approval page stopped). Not a rejection. Nothing was submitted |
| `failed` | yes | No payment happened, and that is known. See `reason`; `refusal` says which check refused when one did (`policy`, `invalid`, `unavailable`) |
| `settled` | yes | The facilitator confirmed the transfer and the service answered 2xx. A receipt exists |
| `paid_service_failed` | yes | The money moved, the service then answered a non-2xx status. A receipt exists |
| `uncertain` | yes | The credential left this machine and what became of it is not known. **Never retried automatically** |

A final state is never overwritten. Once an attempt has an ending, that ending is what the
record says.

### Why `failed` and `uncertain` are different

`failed` means the money did not move and we know it: the owner's policy refused before anyone
was asked, the seller's terms changed between the quote and the payment, the approval page
could not be served (or the local wallet could not be reached), the service asked for payment
again, or the facilitator reported that the transfer did not settle. In every one of these the
outcome is established. Quote again and try again, if it makes sense to.

`uncertain` means the credential was sent and the answer never came back, or came back without
a payment receipt. Two cases produce it:

- the service could not be reached after the credential was sent (a timeout, a dropped
  connection);
- the service answered, but with no `PAYMENT-RESPONSE` header, so whether the transfer settled
  is not something this machine knows.

The client does not retry these, ever. Retrying a payment that may already have settled is how
money gets spent twice, and a retry cannot tell you which case you were in.

**What to do with an `uncertain` attempt.** Look, do not retry:

1. `superstables status <attempt-id>` — the `reason` says which of the two cases happened, and
   the history says how far it got.
2. Check the payer address on the block explorer for a transfer of that amount to that
   recipient around that time. Base Sepolia:
   `https://sepolia.basescan.org/address/<the account that paid>` — in browser mode that is the
   MetaMask account you connected, which `~/.superstables/browser-wallet.json` also names.
3. Check what was approved:
   `grep -o '"status":"[^"]*"' ~/.superstables/records/approvals.jsonl | tail`. A `signed` line
   means you did sign something; nothing after it means nothing more was decided. (With the
   local wallet, `~/.superstables/wallet/audit.jsonl` says the same.)
4. If the transfer is on chain, the payment happened and the service owes you an answer; take
   it up with the service. If it is not there, and the authorization's window has passed
   (`maxTimeoutSeconds` after signing, 300 seconds by default), it can no longer be submitted
   by anyone, and it is safe to quote again.

## Approvals

`approvals.jsonl` is the browser signer's own log: one line every time a request the owner was
asked about changes state. It carries the time, the approval id, the status, the reason, the
verified terms, the reported context and the account that connected — and never a signature.

| Approval status | Meaning |
| --- | --- |
| `pending` | The link exists and is waiting for the owner. Nothing is signed |
| `signed` | The owner signed in their browser wallet, and the signature was verified to be theirs |
| `denied` | Rejected on the page, or rejected in MetaMask |
| `expired` | Five minutes passed without a decision |
| `abandoned` | The process serving the page stopped before anyone decided |

A payment the policy refuses never appears here at all: nobody was asked. The same is true of a
requirement this client cannot pay — an unsupported network, the wrong asset — which is refused
before an approval is created.

## Receipts

A receipt is written only when the money moved — that is, for `settled` and for
`paid_service_failed`. Its id is the attempt's id.

It records the terms that were paid, the payer (the account that signed — your MetaMask
account, in the default mode), the transaction and its explorer URL, the
facilitator's settlement response verbatim (success, payer, transaction, network, error
reason), how long the whole attempt took, and, separately, what the service did:

| Field | Meaning |
| --- | --- |
| `serviceOutcome: "ok"` | The service answered 2xx |
| `serviceOutcome: "failed"` | The money moved and the service answered something else |
| `serviceStatus` | The HTTP status the service answered |
| `serviceBodyPreview` | The first 4,000 characters of its answer |

Payment success and service success are two different facts, and the receipt keeps them apart.
A receipt is not a promise that you got what you paid for; it is a record of what was paid and
what came back.

`transactionKind` says whether `transaction` is a real hash (`hash`, and then `transactionUrl`
points at the explorer) or the facilitator's own reference for a transfer it has accepted but
not yet hashed (`pending`, and `transactionUrl` is empty). The receipt says which rather than
pretending to a hash it does not have.

## What the daily cap counts

`caps.per_day` is checked against the receipts in this directory for today (UTC), per asset:
once when a quote is taken, and again at the gate, before anyone is asked to approve. (With the
local wallet there is a second count, from the wallet's own audit log of what it signed today.)
These are local files, not chain history. Delete them and the count starts again.
This is a software policy, and [security.md](security.md) says exactly how far that goes.

## Budget records

`superstables budget` keeps its own records under `~/.superstables/budget/`, apart from the files
above:

| Path | What it holds |
| --- | --- |
| `budget/public/<rail>-<chain>.env` | The owner's and the agent's addresses, and the budget's terms. No secret |
| `budget/ops/<rail>-<chain>/<op>.json` | One journal per purchase, written before anything is signed and updated after: the seller's URL, the amount, the recipient, the transactions and the state |
| `budget/ops/<rail>-<chain>/<op>.response` | On `evm`, the seller's answer to the purchase, at most 1 MB, mode 600. Seller data, not instructions |
| `budget/owner-approvals.jsonl` | Every state change of an owner approval page. No signatures |
| `budget/approvals/` | Owner approvals an agent started in the background, with their final result |

The agent key is in `keys/budget/<rail>-agent.env` (mode 600). Because the journal is written
before the purchase is signed, `superstables budget reconcile --rail R --chain C --op ID` can read
the chain for a purchase whose outcome is unknown, and say what happened. It never pays.
