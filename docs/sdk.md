# SDK payment records

`PaymentEngine` and `Records` return `Attempt` and `Receipt` records. `chain` keeps its 0.3.0 meaning: `verified` means the client read matching landed evidence for this payment. It does not establish permanent finality.

The additive `chainFinal` field reports finality separately:

- `true`: the matching payment meets its chain's finality rule.
- `false`: the matching payment is included but not final.
- `null`: no current matching inclusion is established, or the stored record has no finality observation.

Records loaded from 0.3.0 retain their existing fields and get `chainFinal: null`. A legacy `chain: verified` is matching evidence with unknown finality. Read-only `PaymentEngine.recheckChain(id)` checks it again. It never asks a wallet or sends a payment.

EVM waits for canonical finalized inclusion, except the pinned SKALE instant-finality rule. Solana waits for finalized commitment. Tempo uses canonical committed inclusion under its instant-finality rule. A readable matching canonical Tempo receipt with an unavailable or lagging committed head remains provisional.

Recovery and daily-cap accounting use `chainFinal`, independently of `chain`. Provisional evidence keeps its hold across UTC midnight, including when an EVM authorization's local expiry has passed. Explicit final evidence counts on the receipt's recorded day only. Legacy matching evidence also holds conservatively until a finality read resolves it. A missing or contradictory provisional transaction needs two successful observations followed by a successful identity search before it becomes `uncertain`, `chain: unchecked`, `chainFinal: null`. Read failures preserve earlier evidence. Final evidence never demotes, including when an older read finishes later. A reorg never authorizes payment again.

The CLI maps SDK `chainFinal` to `chain_final` in `pay`, `status`, `attempts` and `receipts`, including nested receipt JSON. The CLI's `final` still describes workflow completion. `FINAL_ATTEMPT_STATES` still includes `uncertain`; a completed workflow can still need read-only recovery.

## Mismatches

A content mismatch is terminal. A transaction hash commits to its payer, recipient, amount, token and signed payment identity. A stored mismatch without metadata, including a 0.3.0 record, also stays terminal. A fresh seller-hash check can search for the original payment before it records a terminal mismatch; every found payment still passes the full identity check.

The additive `chainMismatch` field distinguishes `content`, `provisional_execution` and `final_execution`. Only `provisional_execution` permits rechecking a recorded mismatch. A failed execution below finality can change after a reorg; a later successful read must pass every check used for a fresh payment before it becomes `verified`. `chainFinal` then follows the normal finality rule. A successful transaction with the wrong amount or identity remains a content mismatch. A final execution failure stays terminal. A missing or noncanonical inclusion stays unchecked and recoverable; it is never permanent content proof.

This recovery exception is intended in 0.3.1. It changes which newly marked execution observations can be rechecked; the existing `mismatch` field still means the chain observation does not confirm this payment. It never authorizes a fresh payment.

## Compatibility from 0.3.0 to 0.3.1

Every existing field retains its meaning. The following audit covers the payment records and their CLI projections.

| Field | 0.3.0 meaning | 0.3.1 meaning |
| --- | --- | --- |
| `Attempt.chain`, `Receipt.chain`, CLI `chain` | `verified` for matching landed payment evidence; `unchecked` when the chain cannot establish it; `mismatch` for a named transaction that is not this payment; `unpaid` for proof it never paid and cannot pay | Unchanged |
| `chainReason`, CLI `chain_reason` | The client's explanation of its chain observation | Unchanged; can describe pending finality or removed inclusion |
| `Attempt.state`, CLI `state` | Workflow outcome, with payment and delivery represented separately | Unchanged; matching provisional payment can be `settled` or `paid_service_failed` |
| CLI `final`, `FINAL_ATTEMPT_STATES` | The running workflow has ended, including `uncertain` | Unchanged |
| CLI `exit_code` | Outcome exit code; delivered settled payment is 0, paid service failure is 4, uncertainty is 5 | Unchanged |
| CLI `message`, `next` | Outcome explanation and next action | Unchanged; pending finality can request a later read |
| CLI `reason`, `refusal` | Why the attempt stopped and the check that refused it | Unchanged |
| CLI `receipt`, `transaction` | Recorded payment receipt or transaction identifier | Unchanged |
| CLI `service_response`, `history` | Seller response and attempt transitions | Unchanged |
| `Receipt.serviceOutcome`, `serviceStatus`, `serviceBodyPreview` | Delivery outcome, HTTP status and saved response preview | Unchanged |
| `Receipt.settlement` | The seller's settlement report | Unchanged |
| `Attempt.serviceStatus`, `serviceBody`, `serviceReason` | Seller HTTP status, saved response and seller's reason | Unchanged |
| `Attempt.id`, `quoteId`, `url`, `serviceId`, `serviceName`, `terms`, `payer`, `transaction`, `transactionUrl`, `receiptId` | Payment identity, checked terms, payer, transaction and receipt references | Unchanged |
| `Attempt.createdAt`, `updatedAt`, `history`, `runner` | Workflow timestamps, transitions and runner identity | Unchanged |
| `Attempt.walletRequestId`, `approvalUrl`, `reason`, `refusal`, `abandonedBy` | Owner approval and closure details | Unchanged |
| `Attempt.reservedAt`, `reservedUntil` | Local daily-cap reservation window | Unchanged |
| `Attempt.authorizationValidBefore`, `authorizationNonce`, `paymentMemo`, `ownerSignature`, `lastValidBlockHeight`, `searchFromBlock`, `searchFromSlot`, `searchedToSlot` | Signed payment identity, lifetime and chain search boundaries or progress | Unchanged |
| `Receipt.id`, `at`, `quoteId`, `attemptId`, `url`, `serviceId`, `serviceName`, `terms`, `payer`, `transaction`, `transactionKind`, `transactionUrl`, `network`, `ms` | Receipt identity, accounting day, checked terms, payment references and elapsed time | Unchanged |
| CLI `untrusted_seller_data`, `untrusted_seller_report`, projected `settlement` | Seller claims kept separate from checked payment identifiers | Unchanged |
| SDK `chainMismatch`, CLI `chainMismatch` in record views | Absent | Added mismatch classification; only `provisional_execution` can be rechecked, and success requires the full original payment identity |
| SDK `chainFinal` | Absent | Added with `true`, `false`, `null` semantics above |
| CLI `chain_final` | Absent | Added with the same semantics as SDK `chainFinal` |
| `paymentIncluded` | Absent | Added historical inclusion marker used to prevent repayment after a reorg; does not prove current inclusion or finality |

The SDK declarations are generated from `src/core/types.ts` by `npm run build` and shipped in `dist/core/types.d.ts`, exported through `dist/index.d.ts`. `chainFinal` is optional in the input type so existing callers can construct or save 0.3.0 records; loaded records and new engine attempts supply `null` when finality has not been observed.
