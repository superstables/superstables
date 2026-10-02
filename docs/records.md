# Quotes, attempts and receipts

The client records quotes, payment attempts, approval decisions and receipts on this computer. They
are what you read to find out how a payment ended, including when its outcome is uncertain.

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
recipient — so that the owner later approves the same payment the agent was quoted. The payment terms come from that requirement, not from the seller's
self-declared resource URL, which a seller can write anything in.

A quote also carries the local policy's verdict. A refusal is recorded on the quote rather than
thrown, so a caller can show the owner both what was asked for and why this machine would not
pay it.

| Quote status | Meaning |
| --- | --- |
| `open` | Not used or expired yet. Check `policy.allowed`: the policy may refuse it. Quotes last 10 minutes |
| `used` | An attempt started from it. Another is refused, unless the client reopened the quote because it could not ask the owner |
| `stale` | The seller's terms changed between quoting and paying. Quote again |
| `expired` | The 10 minutes ran out. Quote again |

## The duplicate-payment guard

The quote is the guard. The moment an attempt is created, the quote is marked `used` —
synchronously, before anything is awaited, so two calls in the same tick cannot both start.
A second `pay` on the same quote is refused (exit 2) with a message that names the payment
that exists: "A payment for this quote already exists: attempt ATTEMPT_ID, STATE", and
`superstables status ATTEMPT_ID` to follow it.

If the approval page cannot start, or the local wallet cannot be reached, before the owner is asked,
the client reopens the quote: pay it again only when the result says so. To pay the same service
twice, quote it twice. The guard works within one process; it is not a lock across separate
processes that share these files.

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
| `awaiting_approval` | no | The attempt is checking the quote or waiting for the owner. In browser mode, `approvalUrl` appears once the page is ready. **No payment credential has been sent** |
| `approved` | no | The owner signed with their wallet. The payment credential has not been sent to the seller yet |
| `submitting` | no | The request is being replayed with the payment credential attached |
| `denied` | yes | The owner rejected it — on the approval page, or in MetaMask's own popup. No payment credential was sent. The seller was only asked for its terms |
| `expired` | yes | Nobody decided within the approval window: five minutes in browser mode, 120 seconds with the local wallet, by default. Cancel any open wallet prompt before asking again |
| `abandoned` | yes | Nobody decided: whoever was waiting for the owner stopped first (`pay --wait` ran out, `pay` was interrupted, or the process serving the approval page stopped). Not a rejection. Nothing was submitted |
| `failed` | yes | No payment happened, and that is known. See `reason`; `refusal` says which check refused when one did (`policy`, `invalid`, `unavailable`, `approval_page`) |
| `settled` | yes | The facilitator confirmed the transfer and the service answered 2xx. A receipt exists |
| `paid_service_failed` | yes | The money moved, the service then answered a non-2xx status. A receipt exists |
| `uncertain` | yes | The credential may have been sent, and the outcome is unknown. **Never retried automatically** |

A final state is never overwritten. Once an attempt has an ending, that ending is what the
record says.

### Why `failed` and `uncertain` are different

`failed` means the money did not move and we know it: the owner's policy refused before anyone
was asked, the seller's terms changed between the quote and the payment, the approval page
could not be served (or the local wallet could not be reached), the service asked for payment
again, or the facilitator reported that the transfer did not settle. In every one of these the
outcome is established. Quote again and try again, if it makes sense to.

`uncertain` means the outcome is unknown after the owner signed. It comes from an interruption after
approval, or from one of these:

- the service could not be reached after the credential was sent (a timeout, a dropped
  connection);
- the service answered without a readable `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE` header (other
  than an HTTP 402, which is recorded as `failed`), so whether the transfer settled is not known here.

The client does not retry these, ever. Retrying a payment that may already have settled is how
money gets spent twice, and a retry cannot tell you which case you were in.

**What to do with an `uncertain` attempt.** Look, do not retry:

1. `superstables status <attempt-id>` — the `reason` says which of the two cases happened, and
   the history says how far it got.
2. Check the payer address on the block explorer for a transfer of that amount to that
   recipient around that time. Base Sepolia:
   `https://sepolia.basescan.org/address/<the account that paid>` — in browser mode that is the
   MetaMask account you connected, which `~/.superstables/browser-wallet.json` also names.
3. Check the approval record for this attempt in `~/.superstables/records/approvals.jsonl`. A
   `signed` line means the client verified a signature. A missing line does not prove that nothing
   was signed. With the local wallet, `~/.superstables/wallet/audit.jsonl` is the record.
4. If the transfer is on chain, do not pay again; the service owes you an answer, so take it up
   with the service. If it is not there, quote again only once the authorization can no longer be
   used: the chain's time is past its `validBefore`, which is `maxTimeoutSeconds` (300 seconds by
   default) after the typed data was prepared for signing. If you cannot tell, treat it as
   unresolved.

## Approvals

`approvals.jsonl` is the browser signer's own log: one line every time a request the owner was
asked about changes state. It carries the time, the approval id, the status, the reason, the
verified terms, the reported context and the account that connected — and never a signature.

| Approval status | Meaning |
| --- | --- |
| `pending` | The link exists and is waiting for the owner. Nothing is signed |
| `signed` | The owner signed with their browser wallet, and the signature was verified to be theirs |
| `denied` | Rejected on the page, or rejected in MetaMask |
| `expired` | The approval window ended before the client accepted a signature or a rejection; cancel any open wallet prompt |
| `abandoned` | The process serving the page stopped before anyone decided |

A payment the policy refuses never appears here at all: nobody was asked. The same is true of a
requirement this client cannot pay — an unsupported network, the wrong asset — which is refused
before an approval is created.

## Receipts

A receipt is written when the seller's settlement response reports success, for `settled` and for
`paid_service_failed`. Its id is the attempt's id. The client does not check the transfer on chain
itself: the transaction link is how you check it.

It records the terms that were paid, the payer (the account that signed — your MetaMask
account, in the default mode), the transaction and its explorer URL, selected fields of the settlement response (success, payer, transaction, network, error
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
