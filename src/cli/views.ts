// How a payment attempt is reported: the sentence `pay` and `status` say it with, and the object
// `pay --json` and `status --json` print.
//
// A sentence never claims more than happened. `pay` does not mean "paid": it means the owner was
// asked. Only the states `settled` and `paid_service_failed` mean a payment was made (`chain` says
// whether the chain confirmed it), and every view carries a `message` that says so in words an
// agent can repeat to the owner verbatim.

import { paymentOutput, SERVICE_BODY_LIMIT, shownPayer, shownTransaction } from "../core/pay.js";
import { railFor } from "../core/rails/index.js";
import type { Records } from "../core/records.js";
import type { Attempt, Receipt } from "../core/types.js";

/** Everything there is to say about an attempt, including the sentence to say it with. */
export function attemptView(deps: { records: Records }, attempt: Attempt): Record<string, unknown> {
  const receipt = attempt.receiptId ? deps.records.getReceipt(attempt.receiptId) : undefined;
  const body = serviceResponse(attempt.serviceBody);
  // a transaction the attempt names without a receipt (an uncertain payment): the hash to check, never "nothing was paid"
  const tx = !receipt && attempt.transaction ? shownTransaction(attempt.transaction, attempt.terms.network) : undefined;
  return {
    attempt_id: attempt.id,
    quote_id: attempt.quoteId,
    state: attempt.state,
    message: messageFor(attempt, receipt),
    ...(attempt.approvalUrl ? { approval_url: attempt.approvalUrl } : {}),
    ...(body === undefined ? {} : { service_response: body }),
    ...(attempt.serviceReason ? { service_reason: attempt.serviceReason } : {}),
    ...chainView(attempt),
    ...(receipt ? { receipt: receiptView(receipt) } : {}),
    ...(tx?.hash ? { transaction: tx.hash, ...(tx.url ? { transaction_url: tx.url } : {}) } : {}),
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(attempt.refusal ? { refusal: attempt.refusal } : {}),
    ...(attempt.abandonedBy ? { abandoned_by: attempt.abandonedBy } : {}),
    history: attempt.history,
  };
}

/** chain and chain_reason for a paid attempt (or one the chain contradicted); nothing for any other. */
function chainView(attempt: Attempt) {
  const paid = attempt.state === "settled" || attempt.state === "paid_service_failed";
  if (!paid && !attempt.chain) return {};
  const output = paymentOutput(attempt);
  const chain = output.chain ?? "unchecked";
  const reason = chain === "verified" ? undefined : (attempt.chainReason ?? "it was not read");
  return { ...output, chain, ...(reason ? { chain_reason: reason } : {}) };
}

function receiptView(receipt: Receipt): object {
  const tx = shownTransaction(receipt.transaction, receipt.terms.network);
  const output = paymentOutput(receipt);
  return {
    ...output,
    chain: output.chain ?? "unchecked",
    transaction: tx.hash ?? "",
    transaction_url: tx.url ?? "",
    amount: receipt.terms.amountDecimal,
    asset: receipt.terms.asset,
    network: receipt.terms.network,
    network_label: receipt.terms.networkLabel,
    payer: shownPayer(receipt.payer, receipt.terms.network) ?? "",
    recipient: receipt.terms.recipient,
    service_outcome: receipt.serviceOutcome,
    service_status: receipt.serviceStatus,
  };
}

/**
 * One sentence per state, written so an agent can repeat it to the owner without adding
 * anything. The wording is deliberate: "asked", "rejected", "settled" and "may or may not"
 * are not interchangeable, and the difference is the whole point of this file. The next step
 * is `superstables status <attempt>`. `pay` prints the approval link once on its own line, so
 * the sentence does not repeat it.
 */
export function messageFor(attempt: Attempt, receipt?: Receipt): string {
  const terms = attempt.terms;
  const amount = `${terms.amountDecimal} ${terms.asset}`;
  // Only a well-formed hash is ever kept as the transaction (pay.ts), so this repeats nothing the seller wrote.
  // Checked here too, not only when written: a record from an earlier version may hold whatever a seller sent.
  const hash = shownTransaction(attempt.transaction, terms.network).hash ?? shownTransaction(receipt?.transaction, terms.network).hash;
  const transaction = hash ? `transaction ${hash}` : "no transaction hash was given";
  const status = attempt.serviceStatus ?? "no status";
  const check = `Run \`superstables status ${attempt.id}\` to see where it got to`;
  switch (attempt.state) {
    case "awaiting_approval":
      return (
        `The owner has been asked to approve ${amount} to ${terms.recipient} on ${terms.networkLabel} ` +
        `in their wallet. Nothing is signed yet. ${check}.`
      );
    case "approved":
      // On Tempo the owner's wallet sends the payment itself: approved means it was asked to, not that it did.
      return pushes(attempt)
        ? `The owner's wallet has been asked to send ${amount} on ${terms.networkLabel}; whether it has sent it is not known yet. ${check}.`
        : `The owner approved ${amount} and the payment is being prepared. Nothing has settled yet. ${check}.`;
    case "submitting":
      return pushes(attempt)
        ? `The owner's wallet sent ${amount} (${transaction}). The client is checking that transfer on chain before it calls the service. ${check}.`
        : `The payment has been sent to the service and the facilitator is settling it. ${check}.`;
    case "denied":
      return "The owner rejected this payment. Nothing was signed or submitted, and the service was not called.";
    case "expired":
      return "Nobody approved the payment within the wallet's window. Nothing was signed.";
    case "abandoned":
      return (
        `Nobody decided: ${attempt.reason ?? "the wait for the owner ended before they approved or rejected this payment"}. ` +
        "This is not a rejection. Nothing was submitted and nothing was paid, and approving through the old approval link now pays nothing."
      );
    case "settled":
      return `${paidSentence(attempt, amount, transaction)} The service answered HTTP ${status}.`;
    case "paid_service_failed":
      if (receipt?.serviceOutcome === "unknown") {
        return (
          `${paidSentence(attempt, amount, transaction)} ` +
          "But the service's answer did not arrive in full, so whether it delivered is unknown. " +
          "Do not pay again for this request; report this."
        );
      }
      return `${paidSentence(attempt, amount, transaction)} But the service answered HTTP ${status}. Do not pay again; report this.`;
    case "failed":
      // The chain shows it was never paid and can no longer be: that is the chain's word, not the seller's.
      if (attempt.chain === "unpaid") {
        return `Payment did not happen: ${attempt.reason ?? "the chain shows this payment was never made"} (${attempt.chainReason ?? "the chain was read"}). Nothing was paid, and nothing can be for this attempt.`;
      }
      // a record that names a transaction is never "did not happen" (an earlier version could keep one on a failure)
      if (hash) return `Whether the payment settled is unknown: ${attempt.reason ?? "no reason was recorded"}, but it names ${transaction}. It was not retried. Check the transaction before trying again.`;
      return `Payment did not happen: ${attempt.reason ?? "no reason was recorded"}.`;
    case "uncertain":
      return (
        `The payment may or may not have settled: ${attempt.reason ?? "no reason was recorded"}. ` +
        `It was not retried. \`superstables status ${attempt.id}\` looks for it on chain; ` +
        "do not pay again for this request until it says this payment was not made."
      );
  }
}

/** Does the owner's wallet send this payment itself (Tempo), rather than sign it for the seller to submit? */
function pushes(attempt: Attempt): boolean {
  return railFor(attempt.terms?.network)?.flow === "push";
}

/**
 * A paid attempt, in the client's words. Only a payment the chain verified is called paid; anything else is the seller's
 * report, said as such, with why the chain has not confirmed it yet and how to check again.
 */
function paidSentence(attempt: Attempt, amount: string, transaction: string): string {
  const network = attempt.terms.networkLabel;
  if (attempt.paymentIncluded && attempt.chain === "unchecked") return `Paid ${amount} on ${network} (${transaction}). The payment landed, but is not final on chain yet; \`superstables status ${attempt.id}\` checks again.`;
  if (attempt.chain === "verified") return `Paid ${amount} on ${network} (${transaction}); checked on chain: the transaction is this payment.`;
  return (
    `The seller reported it paid: ${amount} on ${network} (${transaction}). ` +
    `The chain has not confirmed it yet (${attempt.chainReason ?? "it was not read"}); \`superstables status ${attempt.id}\` checks again.`
  );
}

/** The service's own answer: parsed when it is JSON, the raw text when it is not. */
function serviceResponse(body?: string): unknown {
  if (body === undefined || body === "") return undefined;
  const text = body.slice(0, SERVICE_BODY_LIMIT);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
