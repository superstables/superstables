# SDK payment records

`PaymentEngine` and `Records` return `Attempt` and `Receipt` records. As in 0.3.0, `chain: verified` means the client read matching landed evidence for this payment. It does not establish permanent finality.

The additive `chainFinal` field reports finality separately:

- `true`: the matching payment meets its chain's finality rule.
- `false`: the matching payment is included but not final.
- `null`: no current matching inclusion is established, or the stored record has no finality observation.

EVM requires canonical finalized inclusion, except the pinned SKALE instant-finality rule. Solana requires finalized commitment. Tempo requires canonical committed inclusion under its instant-finality rule. A matching canonical receipt with an unavailable final head remains provisional.

0.3.0 records load with their existing fields and `chainFinal: null`. Read-only `PaymentEngine.recheckChain(id)` checks legacy and provisional matching evidence again, until finality is established. It never asks a wallet or sends a payment. `attempts` and `receipts` list stored observations without chain reads. Starting another `pay` serially rechecks earlier-day `settled` and `paid_service_failed` attempts that are neither `verified`, previously included, nor `unpaid`. This includes unchecked seller reports that no longer reserve today's cap.

Included payments count once, on their receipt's paid day, including legacy records and payments whose finality RPC never succeeds. Pending finality does not reserve every later day's cap. An attempt whose previously observed inclusion was positively removed becomes uncertain and holds its approved amount until recovery, as specified for removed inclusions. This paid-day rule follows the website's accounting rule and the distinction between included payment and pending finality.

A missing receipt, pruned block, unavailable final head, or used authorization with an unreadable transaction does not prove removal. Two successful reads must positively contradict the earlier effect, or show the authorization unused at a final head past the observed payment block. EVM records keep `paymentBlock` for that comparison. Legacy records without that block need positive contradictory effect evidence or final unused expiry. A confirmed removal changes `settled` or `paid_service_failed` to `uncertain`, `chain: unchecked`, and `chainFinal: null`. Final evidence never demotes, including when an older read finishes later. A reorg never authorizes payment again.

## Mismatch recovery

As in 0.3.0, a mismatch makes the attempt `uncertain`. The next `status` searches by the payment's own authorization nonce, Tempo memo, or signed Solana message. This includes the uncertain mismatch records 0.3.0 actually wrote, which have no mismatch classification and normally no receipt.

The rejected transaction hash never becomes this payment through a later matching-looking answer. A different transaction found by the original identity must pass the full identity and effect checks. It then produces a receipt and becomes `settled` or `paid_service_failed`, with `chainFinal: false` for provisional inclusion or `true` for final inclusion. If final evidence proves the authorization expired unused, an attempt with no prior matching inclusion becomes `failed`, `chain: unpaid`. Otherwise it remains uncertain. The initial `pay` records uncertainty exactly as 0.3.0 did; recovery is a read, not another submission.

`chainMismatch` classifies the rejected transaction as `content`, `provisional_execution`, or `final_execution`. A provisional execution can change after a reorg, so its hash can be checked again with every check required for a fresh payment. A non-final EVM receipt without payment effect logs is provisional execution evidence. A transaction carrying a different payment identity or explicit wrong transfer remains a content mismatch. Content, final execution, and legacy rejected hashes are excluded from acceptance, while their attempts still allow the identity search above.

The CLI maps `chainFinal` to `chain_final` in `pay --json`, `status --json`, their nested receipts, and record listings. `chainMismatch` appears as `chain_mismatch` in `attempts --json` and `receipts --json` listings; `pay --json` and `status --json` omit that classification. Existing fields such as `chainReason` and `paymentIncluded` in record listings keep their existing spelling. `final` remains workflow completion; `FINAL_ATTEMPT_STATES` still includes `uncertain`.

## Compatibility audit from 0.3.0 to 0.3.1

The baseline is `46469a5`, the `v0.3.0` release. The following behavior differences are deliberate. They include payment identity checks for single purchases on superstables.com and journal locking.

| Behavior or field | 0.3.0 | 0.3.1 and justification |
| --- | --- | --- |
| Matching `chain: verified` and paid `state` | Matching landed evidence, retained permanently | Same initial paid meaning. Provisional and legacy evidence can later become `uncertain` and `unchecked` after proven removal, to prevent stale payment conclusions after a reorg |
| Status of an earlier `verified` record | No new chain read | Rereads only while finality is unknown or false. This includes legacy records, to establish finality or identify a reorg. RPC errors and pruning retain earlier evidence |
| Prior payments before another `pay` | No chain rechecks before admission | Serially rechecks earlier-day `settled` and `paid_service_failed` attempts without `verified`, prior inclusion, or `unpaid` evidence, even if they no longer hold today's cap. Included and legacy `verified` records are skipped |
| Spend policy at `pay` admission | Refuses a quote whose saved policy verdict denied payment; also rechecks the current engine policy under `cap.lock` before asking the owner | Same saved refusal and locked admission check. An additional current-policy check before refreshing the seller's terms can only refuse an otherwise allowed quote |
| Daily cap for included or legacy paid receipts | Counts on paid day | Same. Pending or unreadable finality does not charge later days. Proven removed inclusions hold across days to prevent an unknown late debit from releasing admission room |
| `chainFinal`, CLI `chain_final` | Absent | Additive true, false, or null. Separates final payment proof from matching inclusion and command completion |
| `paymentIncluded` | Absent | Historical inclusion marker. Keeps removed inclusions uncertain even after expiry, to prevent an automatic repayment conclusion |
| `paymentBlock` | Absent | Observed EVM inclusion height. Supports block-pinned final negative recovery without treating a null receipt as removal |
| `chainReason` on `verified` SDK records and `attempts --json` | Normally absent | Explains pending finality on matching included records. Final verification removes that provisional explanation |
| `chainMismatch`, CLI `chain_mismatch` | Absent | Classifies content and execution observations. Permits a provisional execution recheck with full identity and effect checks; the SDK also exports the `ChainMismatch` type |
| Uncertain content or legacy mismatch | Searches by original identity and can resolve paid or final unpaid | Same recovery. The rejected hash itself cannot be accepted. A different found payment uses explicit finality metadata |
| Failed or empty-effect execution below finality | Treated as a mismatch | Explicitly provisional. Execution may change after a reorg, so a later full matching check can establish payment |
| Core `final` and exit codes | Command ended, including uncertainty. Paid service failure exits 4, uncertainty 5, final unpaid 1 | Same initial mapping. A later proven reorg changes state and exit to uncertainty, as required by the recovery rule |
| Core `message`, `next`, receipt label and help | Matching inclusion called verified without a separate finality fact | Explain pending finality and read-only status, or proven removal and no repayment. Prevents command completion from implying permanent payment |
| Payment identity for single purchases on superstables.com | Independent amount and recipient sanity check | Also checks the purchase nonce, memo or signed message and prevents cross-purchase attribution. Prevents a different same-price transfer from counting as this purchase |
| Older saved paid results for single purchases on superstables.com | Returned as stored | Retains paid and command completion, with unknown finality and an explicit older-version attribution note. Explicit conflicting payer evidence still invalidates the cache. Never invents identity or finality evidence |
| Linking payments to single purchases on superstables.com and saving results | No durable cross-purchase claim or later identity revalidation | Publishes a durable payment claim before saving paid, then validates new cached identity and payer evidence. Prevents duplicate attribution across purchases and stale paid answers after conflicting evidence |
| Paid provisional buy-once | Stored as completed and never reread | Still `final: true` and exit 0 or 4, but retains its read token. Later `wait` can establish finality or detect removal |
| Buy-once failed execution below finality | Permanent unknown, `final: true` | Rereadable unknown, `final: false`, token retained. `wait` genuinely rereads the chain and can observe successful execution or final failure. A final failure is permanent unknown again |
| Removed buy-once inclusion | Earlier paid cache never reread | Becomes unknown, `final: false`, with token retained. It may stay open indefinitely, matching 0.3.0's existing site-paid/chain-unreadable unknown behavior. `wait --abandon` ends local waiting without proving unpaid or permitting repayment |
| Budget dispatcher `final`, `paid`, `delivered` and exit codes | Command completion, payment and delivery separate | Same. Paid provisional RESULTs stay `final: true`. `chain_final` is additive, and `next` names a published reconciliation command |
| Budget `reconcile` without a rail RESULT | Failed with `paid: false` | Unknown with `paid: null`, exit 5. A crashed or interrupted reader cannot prove no payment |
| EVM budget settlement, cancellation and pull recovery | Some decisions used latest receipts or nonce counts | Permanent decisions require canonical final evidence. Missing pulls need a different identified final nonce-consuming transaction. Prevents false unpaid or premature return conclusions |
| Solana budget negative recovery | Confirmed expiry or a limited address index could conclude absence | Uses finalized history and the complete landing window when the final ID is unknown. Progress is bounded and resumable. An address index alone never proves absence |
| Tempo chain checks for budget payments and single purchases on superstables.com | Receipt success without complete canonical inclusion checks | Require canonical committed inclusion. Unreadable evidence preserves uncertainty |
| Budget reconciliation writers | Could race buys and overwrite newer journal evidence | Share operation locks and preserve final evidence. A busy operation returns unknown with `op_in_progress`, exit 5. Prevents stale recovery from admitting another payment |
| Concurrent core writers | Preserved all matching verification permanently | Preserve final matching proof permanently. Provisional proof can change only with positive removal evidence. Late seller answers enrich delivery without accepting a rejected hash |
| Recovery logs, progress and docs | Some commands named source scripts | Name published `superstables budget reconcile` commands and show resumable scan progress, so recovery works from an installed package |

Other payment identity fields, checked terms, seller reports, service responses, approval facts, receipt accounting timestamps, and quote reuse rules are unchanged. No automatic payment retry is added.

## Reading newer records with 0.3.0

0.3.0 ignores finality metadata and reads a provisional `verified` record as paid under its own inclusion meaning. It can reread a provisional buy-once and store it as permanently completed. A removed core inclusion read by 0.3.0 can become `failed`, `chain: unpaid`, exit 1 after final unused expiry. That conclusion has final negative evidence, but differs from 0.3.1's historical-inclusion rule that keeps it uncertain and says "Do not pay again". Downgrading therefore loses the new reorg and finality recovery rules.

SDK declarations are generated by `npm run build` and shipped in `dist/core/types.d.ts`, exported through `dist/index.d.ts`. The additive fields are optional on input so existing callers can construct or save 0.3.0 records. Loaded records and new attempts supply `chainFinal: null` when no finality observation exists.
