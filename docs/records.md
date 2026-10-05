# Quotes, attempts and receipts

The client records quotes, payment attempts, approval decisions and receipts on this machine. They
are what you read to find out how a payment ended, including when its outcome is uncertain.

## Check an unresolved outcome

Keep the original identifiers and records. Read `reason`, `next`, payment status and wallet
activity before deciding what to do; approval, payment and delivery are separate facts.

| Flow | Read the original outcome | Follow-up |
| --- | --- | --- |
| Local `pay` or payment MCP | `superstables status <attempt-id>` (`payment_status` with MCP) | For `uncertain`, follow [the chain and authorization checks below](#why-failed-and-uncertain-are-different). Do not start another payment while unresolved |
| Budget purchase, local or hosted owner approvals | `superstables budget reconcile --rail <rail> --chain <chain> --op <op>` | Use the original rail, chain and operation id. It needs the local journal and never pays. Do not replace the purchase with a new id |
| Single purchase on superstables.com | `superstables budget wait --id <id> --shown` | Re-read the same request later when `unknown` has `final: false`. Waiting never approves or retries payment |
| Budget owner transaction | `superstables budget wait --id <id> --shown`, then `budget status` for that rail and chain | Check wallet activity and chain confirmation. An expired link does not cancel a wallet transaction |

`--shown` means the agent wrote the approval link, terms and match code when present in a visible
reply to the owner.
Hosted approval leaves budget journals and the agent key on your runtime; the site account is not
a complete budget purchase ledger. To stop spending, [revoke](budget.md#7-revoke-owner). To return
stranded EVM USDC, use [recovery](budget.md#recovery-and-ending-use), which requires the agent key
and uses local owner approvals even with hosted setup. Preserve these files until unresolved
outcomes and key-held funds are checked, then follow [Uninstalling](install.md#uninstalling).

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
| `approved` | no | The owner signed with their wallet. The payment credential has not been sent to the seller yet. On Tempo Moderato: the owner's wallet was asked to send the payment |
| `submitting` | no | The request is being replayed with the payment credential attached. On Tempo Moderato: the client is checking on chain the transaction the wallet reported, before it calls the seller |
| `denied` | yes | The owner rejected it — on the approval page, or in MetaMask's own popup — before anything was signed or sent. No payment credential was sent. The seller was only asked for its terms |
| `expired` | yes | Nobody decided within the approval window: five minutes in browser mode, 120 seconds with the local wallet, by default. Cancel any open wallet prompt before asking again |
| `abandoned` | yes | Nobody decided: whoever was waiting for the owner stopped first (`pay --wait` ran out, `pay` was interrupted, or the process serving the approval page stopped). Not a rejection. Nothing was submitted |
| `failed` | yes | Nothing was paid: the client stopped before sending a payment, or a later chain check shows the payment was never made and can no longer be (`chain: "unpaid"`). See `reason`; `refusal` says which check refused when one did: `policy`, `invalid`, `unavailable` (the local wallet did not answer), `approval_page`, `cap_check` (the daily cap could not be checked), or `chain` (on Tempo, the chain could not be read before the wallet was asked; nothing was sent) |
| `settled` | yes | The seller reported that settlement succeeded, and the service answered 2xx. A receipt exists. `chain` says whether the client confirmed it on chain |
| `paid_service_failed` | yes | The seller reported that settlement succeeded, and the service answered a non-2xx status or its answer did not arrive in full. A receipt exists. `chain` as for `settled` |
| `uncertain` | yes | The credential may have been sent, or the wallet may have sent the payment, and the outcome is unknown: including when the seller said it was not paid, and when the chain shows the seller's transaction is not this payment (`chain: "mismatch"`). **Never retried automatically** |

`chain` on a paid attempt and its receipt: `verified` when the client read the transaction on the
payment's chain and it is this payment (see [security.md](security.md) for what that means on each
chain); `unchecked` (with `chainReason`) when the chain could not say yet. `superstables status`
reads the chain again for an unchecked attempt: first the transaction the seller named, then the
payment itself, as for an `uncertain` one (below).

A later chain check can change `settled` or `paid_service_failed` to `uncertain` and mark its
receipt `mismatch`, correct the receipt to the transaction that is this payment, or, when the chain
shows the payment was never made and can no longer be, make the attempt `failed` and mark its
receipt `unpaid`. The history retains the earlier state. This never starts another payment.

### Why `failed` and `uncertain` are different

The client records `failed` when nothing was paid: the owner's policy refused before anyone was
asked, the seller's terms changed between the quote and the payment, the approval page could not
be served (or the local wallet could not be reached), or anything else stopped the payment before
the credential left this machine or the wallet was asked to send. A later chain check also records
`failed`, with `chain: "unpaid"`, when it shows that the payment was never made and can no longer
be.

`uncertain` means the outcome is unknown after the owner signed, or after the wallet was asked to
send. It comes from an interruption after approval (a `pay` that was stopped or crashed, which
`superstables status` picks up), or from one of these:

- the service could not be reached after the credential was sent (a timeout, a dropped
  connection);
- the service answered without a readable `PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE` header, or
  asked for payment again (HTTP 402), or reported that the payment did not settle: the seller's
  facilitator may have settled it before the answer, or may settle it later, so the seller's word
  does not end it as unpaid;
- on Tempo Moderato, where the owner's wallet sends the payment itself: the wallet was asked to
  send and the page reported no transaction (the page closed, the window ended, `pay` stopped), or
  reported that the owner rejected it in the wallet (a report the client cannot check), or the
  chain did not show the transaction it reported within 30 seconds, or showed another transfer. The
  service was not called.

The client does not retry these, ever. Retrying a payment that may already have settled is how
money gets spent twice, and a retry cannot tell you which case you were in.

**What to do with an `uncertain` attempt.** Look, do not retry, and do not quote the same request
again:

1. `superstables status <attempt-id>` — the `reason` says which case happened, and the history
   says how far it got. It also searches the chain for the payment, by what ties it to this attempt
   alone, never by a transaction the seller named:
   - on the EVM chains, the authorization the owner signed: the token says whether its nonce was
     used, and its `AuthorizationUsed` log names the transaction;
   - on Tempo Moderato, the transfer with this payment's memo, in a block after the one the chain
     was at when the wallet was asked;
   - on Solana devnet, a transaction carrying the owner's signature among the owner's token
     account's transactions since the payment was built, and, once its blockhash has expired, in
     each of the blocks it could have landed in. The search is limited; when it cannot tell, it
     says so. One status reads those blocks for up to 45 seconds and records on the attempt the
     slot up to which they hold no payment (`searchedToSlot`); the next status reads on from
     there. The public devnet RPC limits how fast blocks can be read, so through it this takes
     several statuses.

   Found, the attempt becomes `paid_service_failed` (or `settled`, when the service had already
   answered and delivered) with a receipt. When final chain evidence shows the payment can no
   longer happen, the attempt becomes `failed` with `chain: "unpaid"`: nothing was paid, and only
   then quote again. On the EVM chains that is a final block (the RPC's `finalized` block; on SKALE
   Base Sepolia, the latest) dated at or past the authorization's `validBefore` with the
   authorization unused, or its cancellation in a block at or below the final block that is still
   the chain's block at that height (the same block hash); without a final block, it stays
   `uncertain`. On Solana devnet it is a blockhash expired by the finalized block height, with every
   block it could have landed in read whole and none holding this payment (a transaction carrying
   the owner's signature that failed on chain is not this payment). Otherwise it stays
   `uncertain`, with the chain's answer. A Tempo transfer has no expiry, so on Tempo only finding
   it resolves the attempt, and until then it counts against the daily cap. If the wallet's
   activity shows it never sent the transfer, and no request is still waiting there, whether to
   pay again is the owner's decision; raising `caps.per_day` in the policy is how to stop the
   attempt from blocking other payments.
2. Check the payer address on the payment chain's block explorer for a transfer of that amount to
   that recipient around that time, for example on Base Sepolia
   `https://sepolia.basescan.org/address/<the account that paid>` — in browser mode that is the
   wallet account you connected, which `~/.superstables/browser-wallet.json` also names.
3. Check the approval record for this attempt in `~/.superstables/records/approvals.jsonl`. A
   `signed` line means the client verified a signature. A missing line does not prove that nothing
   was signed. With the local wallet, `~/.superstables/wallet/audit.jsonl` is the record.
4. If the transfer is on chain, do not pay again; the service owes you an answer, so take it up
   with the service.

## Approvals

`approvals.jsonl` is the browser signer's own log: one line every time a request the owner was
asked about changes state. It carries the time, the approval id, the status, the reason, the
verified terms, the reported context and the account that connected — and never a signature.

| Approval status | Meaning |
| --- | --- |
| `pending` | The approval link exists and is waiting for the owner. Nothing is signed |
| `signed` | The owner signed with their browser wallet, and the signature was verified to be theirs (on Tempo: the wallet sent the payment and the page reported its transaction) |
| `denied` | Rejected on the page, or rejected in MetaMask, before anything was signed or sent |
| `expired` | The approval window ended before the client accepted a signature or a rejection; cancel any open wallet prompt |
| `abandoned` | The process serving the page stopped before anyone decided |
| `refused` | Tempo: the client stopped before the wallet was asked to send, for example because the daily cap now refuses it. Nothing was sent |
| `unknown` | Tempo: the wallet was asked to send, and no transaction came back before the window ended or the process stopped, or the page reported that the owner rejected it in the wallet. It may have been sent |

A payment refused by the policy before an approval is created does not appear in this log. On
Tempo, a later policy refusal before the wallet is asked to send is recorded as `refused`.
Unsupported requirements (an unsupported chain, the wrong asset) are rejected before an approval is
created.

## Receipts

A receipt is written when the seller's settlement response reports success, or when the chain
shows the payment (on Tempo, before the seller is called; or when `superstables status` finds an
`uncertain` payment), for `settled` and for `paid_service_failed`. Its id is the attempt's id, so a
payment has one receipt: a later check corrects it rather than adding another. On Tempo and Solana,
a transaction recorded as one attempt's verified payment is never taken as another's; on EVM chains
one transaction may settle several payments, and each must match its own signed authorization nonce
and exact transfer. A check never turns a receipt the chain verified back into anything else, and
neither does a seller's answer that arrives after `superstables status` decided the payment: on a
verified payment it adds what the service did; on a payment the chain showed was never made, it is
kept as a receipt marked `unpaid`, which counts nowhere. A seller's answer is written under the
same lock as status. When a run cannot take that lock, the answer waits in `pending-answers/` for
the next `superstables status` to record it, and a run still in progress ends `uncertain`. Its
`chain` says whether the client confirmed the transfer on chain
(`verified`), has not confirmed it (`unchecked`: the seller's report), found a mismatch on a later
check (`mismatch`), or found on a later check that the payment was never made and can no longer be
(`unpaid`); the transaction link is how you check it yourself.

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
counts on the day it ended, and on every day while it can still move money (signed or sent and not
resolved, or waiting for the owner within its approval window). So a receipt counts on its own day
(not at all once a later check marked it `unpaid`). A receipt the chain has not confirmed
(`unchecked`, the seller's report) or has contradicted (`mismatch`) leaves its payment unresolved,
unless its attempt is `verified`: it also counts on later days, once a day, on the terms below for
its attempt. An `uncertain`, `approved` or `submitting` attempt counts on every day while it can still move money: on the EVM chains until its signed
authorization expires (`authorizationValidBefore`, and two minutes for a chain clock behind this
machine's; after that, on the day it became uncertain, or was signed); on Tempo Moderato, where a
transfer has no expiry, and on Solana devnet, where only the chain can say a transaction's blockhash
has expired, until `superstables status` resolves it, paid or (Solana) unpaid. An older EVM record
without `authorizationValidBefore` counts every day while `approved` or `submitting`, and on the day
it became uncertain. One waiting for the owner counts until its reservation (`reservedAt`,
`reservedUntil`) ends: the signer's approval window and one minute of grace. A reservation that lapses before the
owner is asked, or before a signature is sent, is checked against the cap again and renewed, or the
payment stops there. Before the owner is asked, `pay` checks the cap and reserves the amount under a lock every
`pay` process on this machine shares, so two payments started at once cannot both pass. A payment
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
