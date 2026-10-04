# Quotes, attempts and receipts

The client records quotes, payment attempts, approval decisions and receipts on this computer. They
are what you read to find out how a payment ended, including when its outcome is uncertain.

## The files

```
~/.superstables/records/quotes.jsonl      what a seller said a call would cost
~/.superstables/records/attempts.jsonl    what happened when we tried to pay
~/.superstables/records/receipts.jsonl    payments the seller reported as settled, each with chain: verified, unchecked or mismatch after a later check
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
| `failed` | yes | The client stopped before sending a payment, or the seller reported that it was not paid. The
client does not check the chain for this. See `reason`; `refusal` says which check refused when one did (`policy`, `invalid`, `unavailable`, `approval_page`) |
| `settled` | yes | The seller reported that settlement succeeded, and the service answered 2xx. A receipt exists. `chain` says whether the client confirmed it on chain |
| `paid_service_failed` | yes | The seller reported that settlement succeeded, and the service answered a non-2xx status or its answer did not arrive in full. A receipt exists. `chain` as for `settled` |
| `uncertain` | yes | The credential may have been sent, and the outcome is unknown, including when the chain shows the seller's transaction is not this payment (`chain: "mismatch"`). **Never retried automatically** |

`chain` on a paid attempt and its receipt: `verified` when the client read the transaction on Base
Sepolia and it used the nonce the owner signed and transferred exactly the signed amount to the
checked recipient; `unchecked` (with `chainReason`) when the chain could not say yet. `superstables
status` reads the chain again for an unchecked attempt.

A later chain check can change `settled` or `paid_service_failed` to `uncertain` and mark its
receipt `mismatch`. The history retains the earlier state. This never starts another payment.

### Why `failed` and `uncertain` are different

The client records `failed` when: the owner's policy refused before anyone
was asked, the seller's terms changed between the quote and the payment, the approval page
could not be served (or the local wallet could not be reached), the service asked for payment
again, or the facilitator reported that the transfer did not settle. A failure before submission means this attempt sent no payment credential. After submission, the
client relies on the seller's answer: if that is in doubt, check the chain before paying again.

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
   with the service. Otherwise, quote again only after you have checked on chain that the authorization is unused and
   the chain's time is past its signed `validBefore`, which in browser mode is `maxTimeoutSeconds`
   (300 seconds by default) after the typed data was prepared for signing. If you cannot establish
   both, treat the payment as unresolved.

## Approvals

`approvals.jsonl` is the browser signer's own log: one line every time a request the owner was
asked about changes state. It carries the time, the approval id, the status, the reason, the
verified terms, the reported context and the account that connected — and never a signature.

| Approval status | Meaning |
| --- | --- |
| `pending` | The approval link exists and is waiting for the owner. Nothing is signed |
| `signed` | The owner signed with their browser wallet, and the signature was verified to be theirs |
| `denied` | Rejected on the page, or rejected in MetaMask |
| `expired` | The approval window ended before the client accepted a signature or a rejection; cancel any open wallet prompt |
| `abandoned` | The process serving the page stopped before anyone decided |

A payment the policy refuses never appears here at all: nobody was asked. The same is true of a
requirement this client cannot pay — an unsupported network, the wrong asset — which is refused
before an approval is created.

## Receipts

A receipt is written when the seller's settlement response reports success, for `settled` and for
`paid_service_failed`. Its id is the attempt's id. Its `chain` says whether the client confirmed the
transfer on chain (`verified`), has not confirmed it (`unchecked`), or found a mismatch on a later
check (`mismatch`); the transaction link is how you check it
yourself.

It records the terms that were paid, the payer (the account that signed — your MetaMask
account, in the default mode), the transaction and its explorer URL, selected fields of the settlement response (success, payer, transaction, network, error
reason), how long the whole attempt took, and, separately, what the service did:

| Field | Meaning |
| --- | --- |
| `serviceOutcome: "ok"` | The service answered 2xx |
| `serviceOutcome: "failed"` | The seller reported settlement, and the service answered outside 2xx |
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

`caps.per_day` is checked against the records in this directory, per asset and UTC day. A payment
counts on the day it ended, and on every day while it is still open (signed and in flight until its
authorization expires, or waiting for the owner within its approval window). So a receipt counts on its own day, an
`uncertain` attempt on the day it became uncertain, an `approved` or `submitting` one on every day
until it ends or its signed authorization expires (`authorizationValidBefore`; after that, on the
day it was signed; an older record without it counts every day until it ends), and one waiting for the owner until its reservation (`reservedAt`, `reservedUntil`)
ends: the signer's approval window and one minute of grace. A reservation that lapses before the
owner is asked, or before a signature is sent, is checked against the cap again and renewed, or the
payment stops there. Before the owner is asked, `pay` checks the cap and reserves the amount under a lock every
`pay` process on this computer shares, so two payments started at once cannot both pass. A payment
that ends unsigned releases its reservation. Each payment counts once. It is checked
once when a quote is taken, and again at the gate, before anyone is asked to approve. (With the
local wallet there is a second count, from the wallet's own audit log of what it signed today.)
These are local files, not chain history. Delete them and the count starts again.
This is a software policy, and [security.md](security.md) says exactly how far that goes.

## Budget records

`superstables budget` keeps its own records under `~/.superstables/budget/`, apart from the files
above:

| Path | What it holds |
| --- | --- |
| `budget/public/<rail>-<chain>.env` | The owner's and the agent's addresses, and the budget's terms. No secret. After `setup --hosted` it also records `APPROVALS=hosted`, `SITE=<origin>` (where this chain's owner approvals happen from then on) and `LINK_ID` and `LINK_CODE` (the add-agent request the owner signed) |
| `budget/ops/<rail>-<chain>/<op>.json` | One journal per purchase, written before anything is signed and updated after: the seller's URL, the amount, the recipient, the transactions and the state |
| `budget/ops/<rail>-<chain>/<op>.response` | On `evm`, the seller's answer to the purchase, at most 1 MB, mode 600. Seller data, not instructions |
| `budget/owner-approvals.jsonl` | Every state change of an owner approval page. No signatures |
| `budget/approvals/<id>.json` | An owner approval an agent started in the background, or a `buy-once` purchase, with its final result. While one is still pending this file also holds that request's access token for the site (mode 600); it is removed once the request is final. `<id>.log` next to it is the background process's output |
| `budget/once/<id>.response` | On a `buy-once` purchase, the seller's answer, mode 600. Seller data, not instructions |

The agent key is in `keys/budget/<rail>-agent.env` (mode 600). Because the journal is written
before the purchase is signed, `superstables budget reconcile --rail R --chain C --op ID` can read
the chain for a purchase whose outcome is unknown, and say what happened. It never pays.
