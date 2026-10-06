// What a command's result means for whoever runs it next: an exit code a script can branch
// on, and the next command to run. The codes are the ones `superstables budget` uses, so an
// agent that has learned one table can read both:
//
//   0 done   1 failed   2 bad input   3 refused   4 paid, not delivered   5 unknown
//
// They are mapped from the attempt's recorded state, never from what the caller hoped for.

import { networkFor, shortLabel } from "../core/chain.js";
import { policyPath } from "../core/home.js";
import { railFor } from "../core/rails/index.js";
import type { Attempt, Quote } from "../core/types.js";
import { FINAL_ATTEMPT_STATES } from "../core/types.js";

export const EXIT = {
  done: 0,
  failed: 1,
  badInput: 2,
  refused: 3,
  paidNotDelivered: 4,
  unknown: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A refusal with an exit code, printed as one sentence on stderr (and as JSON under --json). */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.failed,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** The input was wrong; nothing was done. */
export function badInput(message: string): CliError {
  return new CliError(message, EXIT.badInput);
}

export function isFinalAttempt(attempt: Attempt): boolean {
  return FINAL_ATTEMPT_STATES.includes(attempt.state);
}

/** The exit code an attempt's state stands for. A state that is not final yet is 0: nothing has gone wrong. */
export function exitCodeFor(attempt: Attempt): ExitCode {
  switch (attempt.state) {
    case "settled":
      return EXIT.done;
    case "paid_service_failed":
      return EXIT.paidNotDelivered;
    case "uncertain":
      return EXIT.unknown;
    case "denied":
      return EXIT.refused;
    case "failed":
      return attempt.refusal === "policy" ? EXIT.refused : EXIT.failed;
    case "expired":
    case "abandoned":
      return EXIT.failed;
    default:
      return EXIT.done;
  }
}

/** The command that takes a fresh quote for the same request, so a retry is one paste away. */
export function requoteCommand(quote: Pick<Quote, "url" | "serviceId" | "request"> | undefined): string {
  if (!quote) return "superstables quote <url>";
  if (quote.serviceId && quote.request) {
    const params = Object.entries(quote.request.params).map(([key, value]) => ` --param ${shellWord(`${key}=${value}`)}`);
    return `superstables quote --service ${shellWord(quote.serviceId)}${params.join("")}`;
  }
  return `superstables quote ${shellWord(quote.url)}`;
}

/** The next thing to run (or not to run) after an attempt, in one sentence. */
export function nextFor(attempt: Attempt, quote?: Quote): string {
  const requote = requoteCommand(quote);
  switch (attempt.state) {
    case "awaiting_approval":
    case "approved":
    case "submitting":
      return `Run \`superstables status ${attempt.id}\` to see where it got to.`;
    case "settled":
      return attempt.chain === "verified"
        ? "Nothing to do: the service's answer is above, and `superstables receipts` lists the payment."
        : attempt.paymentIncluded
        ? `The payment landed and the service's answer is above. It is not final on chain yet; \`superstables status ${attempt.id}\` checks again.`
        : `Nothing to do: the service's answer is above. The seller reported the payment and the chain has not confirmed it yet; \`superstables status ${attempt.id}\` checks again.`;
    case "paid_service_failed":
      return `Do not pay again. \`superstables status ${attempt.id}\` shows the service's answer; report it to the seller.`;
    case "uncertain": {
      // The payment's own chain: its explorer (on the right cluster), and the command that searches that chain for it.
      const network = networkFor(attempt.terms?.network ?? "");
      const search = railFor(network)?.findPayment ? `Run \`superstables status ${attempt.id}\`: it searches the chain for this payment. ` : "";
      const explorer = !network ? "the chain's explorer" : network.explorerQuery ? `${network.explorer}/${network.explorerQuery}` : network.explorer;
      // A Tempo transfer has no expiry: the chain never says it can no longer happen, so the owner decides.
      const tempo = railFor(network)?.flow === "push"
        ? " On Tempo a transfer has no expiry, so only finding it resolves this one: if the owner's wallet shows no transfer and no request waiting, paying again is the owner's decision, and this attempt keeps counting against the daily cap."
        : "";
      return (
        `Do not pay again yet. ${search}Check \`superstables receipts\` and the payer's account on ${explorer}; ` +
        `only quote again once \`superstables status\` says this payment was not made.${tempo}`
      );
    }
    case "denied":
      return `The owner said no. Do not retry unless the owner asks; then \`${requote}\` and \`superstables pay <new-quote-id>\`.`;
    case "expired":
    case "abandoned": {
      const again =
        `To ask again, take a new quote (this one is used): \`${requote}\`, then \`superstables pay <new-quote-id>\` ` +
        "while the owner is ready to approve, with no --wait or a longer one.";
      // The owner never saw a decision to make: the process was ended under them. Say so, so
      // whoever ended it does not read it as the owner's answer and does it again.
      return attempt.state === "abandoned" && attempt.abandonedBy === "stopped"
        ? `The pay process was stopped before the owner decided; leave pay running until it ends. ${again}`
        : again;
    }
    case "failed":
      if (attempt.refusal === "policy") {
        return `A spend policy refused it. \`superstables policy show\` prints the rules; the owner edits ${policyPath()} if they are wrong.`;
      }
      if (attempt.refusal === "approval_page") {
        return (
          "The approval page could not start, so the owner was not asked. Another payment waiting on that " +
          "port must not be stopped: unset SUPERSTABLES_APPROVE_PORT, or set it to a free port, then " +
          payAgain(attempt, quote, requote)
        );
      }
      if (attempt.refusal === "unavailable") {
        // The local wallet, and only it. Each command names its wallet with the flag: the flag wins over
        // SUPERSTABLES_WALLET, and a flag on `wallet serve` does not carry over to the next command.
        const serve = "The local wallet did not answer. The owner starts it with `superstables --wallet local wallet serve`";
        return quote?.status === "open"
          ? `${serve}, then pays the same quote again with \`superstables --wallet local pay ${attempt.quoteId}\`. ` +
              `To approve in a browser wallet instead, run \`superstables --wallet browser pay ${attempt.quoteId}\`.`
          : `${serve}. Take a new quote with \`${requote}\`, then run \`superstables --wallet local pay <new-quote-id>\`. ` +
              "To approve in a browser wallet instead, run `superstables --wallet browser pay <new-quote-id>` after taking the new quote.";
      }
      if (attempt.refusal === "cap_check") {
        return `The daily cap could not be checked, so the owner was not asked and nothing was signed. If another \`pay\` is running, let it finish; then ${payAgain(attempt, quote, requote)}`;
      }
      if (attempt.refusal === "chain") {
        // A chain read before the owner's wallet was asked to send failed: the RPC is what to look at, and the owner was
        // already asked on this quote, so a new one is needed.
        const network = networkFor(attempt.terms?.network ?? "");
        const rpc = network ? ` (${network.rpcEnv ? `\`${network.rpcEnv}\` when it is set, otherwise ` : ""}${network.defaultRpc})` : "";
        return (
          `Nothing was sent: the ${network ? shortLabel(network) : "chain's"} RPC could not be read before the owner's wallet was asked. ` +
          `Check that RPC${rpc}, then take a new quote: \`${requote}\`, then \`superstables --wallet browser pay <new-quote-id>\`.`
        );
      }
      if (attempt.chain === "unpaid") {
        return `Nothing was paid: the chain shows it, and this attempt can no longer settle. To try again, take a new quote: \`${requote}\`, then \`superstables pay <new-quote-id>\`.`;
      }
      // a record that names a transaction is never "nothing was paid" (an earlier version could keep one on a failure)
      if (attempt.transaction) return `Do not pay again yet: this attempt names a transaction${/^0x[0-9a-fA-F]{64}$/.test(attempt.transaction) ? ` (${attempt.transaction})` : ""}. Check it, and \`superstables receipts\`, before taking a new quote.`;
      return `Nothing was paid. To try again, take a new quote: \`${requote}\`, then \`superstables pay <new-quote-id>\`.`;
  }
}

/**
 * `pay` on a quote that already started a payment: name that payment and how to follow it.
 * Whether the process running it is still alive is not on record, so this does not guess at
 * its link; `status` says what the record knows.
 */
export function usedQuoteMessage(refusal: string, attempt: Attempt, quote?: Quote): string {
  const status = `\`superstables status ${attempt.id}\``;
  if (!isFinalAttempt(attempt)) return `${refusal}. Follow that one: ${status}.`;
  return `${refusal}. ${status} shows how it ended. ${nextFor(attempt, quote)}`;
}

/** The quote is handed back when the owner was never asked; otherwise a new one is needed. */
function payAgain(attempt: Attempt, quote: Quote | undefined, requote: string): string {
  return quote?.status === "open"
    ? `pay the same quote again: \`superstables pay ${attempt.quoteId}\`.`
    : `take a new quote: \`${requote}\`, then \`superstables pay <new-quote-id>\`.`;
}

/** Quote a word for a POSIX shell only when it needs it. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
