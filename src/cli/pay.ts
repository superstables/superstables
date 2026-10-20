// The part `pay` and `seller top-up` share: start one payment for a quote, print the approval link once, wait for
// the owner, and return the attempt however it ended. Nothing here signs or approves: the signer asks the owner's
// wallet, and the attempt's record says what the owner decided.
//
// Both commands pay through this one function so a second payment path cannot grow beside the first. The caller
// prints the outcome: what `settled` means differs between a purchase and a top-up.

import { getQuote } from "../core/quote.js";
import { QuoteUsedError } from "../core/pay.js";
import type { Signer } from "../core/signer/types.js";
import { BrowserWalletSigner } from "../core/signer/browser.js";
import { untrustedText } from "../core/text.js";
import type { Attempt } from "../core/types.js";
import type { PaymentContext } from "./context.js";
import { badInput, isFinalAttempt, requoteCommand, usedQuoteMessage } from "./outcome.js";

/**
 * How long a command with no --wait waits. The signers' own windows end the attempt well before this; the
 * ceiling only guards against a wallet that never answers at all.
 */
export const PAY_CEILING_MS = 15 * 60_000;
/** After the owner approved, how long the command keeps waiting for the payment to settle and the site to answer. */
export const SUBMIT_GRACE_MS = 150_000;

export interface ApproveAndPayOptions {
  /** Stop waiting for the owner's decision after this many seconds. */
  wait?: number;
  /** Where progress and the approval link go: stdout, or stderr under --json. */
  say: (line: string) => void;
  /** What the first line names: "quote <id>" by default. */
  label?: string;
  /** The command that owned the attempt, for the sentence a stop writes. Default `superstables pay`. */
  command?: string;
}

/** Start the quote's one payment, wait for it, and return the attempt as it ended. Throws only when nothing started. */
export async function approveAndPay(deps: PaymentContext, quoteId: string, options: ApproveAndPayOptions): Promise<Attempt> {
  const { records, engine, signer } = deps;
  const command = options.command ?? "superstables pay";
  let linkShown = false;

  // Subscribe first: the first transition is emitted inside startPayment().
  const onTransition = (attempt: Attempt) => {
    if (attempt.quoteId !== quoteId) return;
    const last = attempt.history[attempt.history.length - 1];
    // The creation of the attempt says nothing the next line will not say better.
    if (attempt.state === "awaiting_approval" && !last?.note) return;
    if (attempt.approvalUrl && !linkShown) {
      // The link is the approval in browser mode: printed once, on its own line, unmissable.
      linkShown = true;
      options.say(`  awaiting_approval: waiting for the owner on the approval page (it closes when this command stops)`);
      options.say("");
      options.say("Open this approval link and approve the payment in your browser wallet:");
      options.say(`  ${attempt.approvalUrl}`);
      const movedFrom = signer instanceof BrowserWalletSigner ? signer.movedFrom : undefined;
      if (movedFrom !== undefined) {
        // Another payment is most likely waiting on the usual port. Saying so here is what
        // keeps an agent from going looking for that process and stopping it.
        options.say(
          `  (port ${movedFrom}, the one this install uses, is busy, probably with another payment waiting for its owner; leave it running. ` +
            `This page is on port ${new URL(attempt.approvalUrl).port}.)`,
        );
      }
      options.say("");
      return;
    }
    options.say(`  ${attempt.state}${lastNote(attempt)}`);
  };
  engine.events.on("transition", onTransition);

  let started: Attempt;
  try {
    started = engine.startPayment(quoteId);
  } catch (err) {
    engine.events.off("transition", onTransition);
    await closeSigner(signer);
    const quote = records.getQuote(quoteId);
    if (err instanceof QuoteUsedError && (err.attempt || err.attemptId)) {
      // The payment exists already: point at it, so nobody starts a second one to get a link.
      throw badInput(err.attempt ? usedQuoteMessage(err.message, err.attempt, quote) : `${err.message}.`);
    }
    throw badInput(
      quote
        ? `${messageOf(err)}: \`${requoteCommand(quote)}\`, then \`${command} <new-quote-id>\`.`
        : `${messageOf(err)}; \`superstables quote --service <id>\` or \`superstables quote <url>\` takes one.`,
    );
  }
  // From here a payment exists. Whatever goes wrong next, the attempt's record says how far it got: a throw is never
  // "not started", and an attempt that is not over is stopped as unknown, never reported as unpaid.
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted = true;
    engine.stop(
      started.id,
      `this \`${command}\` process was stopped (${signal}) before the owner decided, and its ` +
        "approval page closed with it; the owner did not reject the payment",
      "stopped",
    );
  };
  // Records are written synchronously, so even an exit nobody planned leaves the truth behind.
  const onExit = () => {
    engine.stop(
      started.id,
      `this \`${command}\` process exited before the owner decided, and its approval page closed ` +
        "with it; the owner did not reject the payment",
      "stopped",
    );
  };
  try {
    options.say(`Paying ${options.label ?? `quote ${quoteId}`} (attempt ${started.id}).`);

    // Ctrl-C, or an agent's tool killing the command, is the end of the wait: the page goes
    // away with this process, and the record has to say so rather than stay "awaiting". The
    // reason names the process, not the owner, so whoever stopped it can tell.
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("exit", onExit);

    const waitMs = options.wait === undefined ? PAY_CEILING_MS : options.wait * 1000;
    let attempt = await engine.waitForAttempt(started.id, waitMs);
    if (!isFinalAttempt(attempt) && !interrupted) {
      if (attempt.state === "awaiting_approval") {
        attempt =
          engine.stop(
            started.id,
            options.wait === undefined
              ? `\`${command}\` stopped waiting before the owner decided`
              : `\`${command}\` stopped waiting after --wait ${options.wait} s, before the owner decided`,
            "wait",
          ) ?? attempt;
      } else {
        // Approved: the credential may be on its way, so this is not the moment to walk away.
        attempt = await engine.waitForAttempt(started.id, SUBMIT_GRACE_MS);
        if (!isFinalAttempt(attempt)) attempt = engine.stop(started.id, `\`${command}\` stopped waiting`) ?? attempt;
      }
    }
    return engine.getAttempt(started.id) ?? attempt;
  } catch (err) {
    let recorded = engine.getAttempt(started.id);
    try {
      recorded = engine.stop(started.id, `\`${command}\` failed while waiting: ${messageOf(err)}`) ?? recorded;
    } catch {
      // the record keeps what it has
    }
    throw new PaymentStartedError(started.id, err, recorded);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", onExit);
    engine.events.off("transition", onTransition);
    // The browser signer listens on loopback for as long as it exists; let the command exit.
    await closeSigner(signer);
  }
}

/**
 * The payment was started, and the command failed while following it. `attempt` is what the records say about it now;
 * what became of the money is that attempt's state, and unknown when it is not final.
 */
export class PaymentStartedError extends Error {
  constructor(
    readonly attemptId: string,
    cause: unknown,
    readonly attempt?: Attempt,
  ) {
    super(`${messageOf(cause)}. The payment (attempt ${attemptId}) had started: \`superstables status ${attemptId}\` says where it got to`, { cause });
    this.name = "PaymentStartedError";
  }
}

/** A signer that binds a port has to give it back before the command exits. */
async function closeSigner(signer: Signer): Promise<void> {
  const closable = signer as Signer & { close?: () => Promise<void> };
  if (typeof closable.close === "function") await closable.close().catch(() => undefined);
}

function lastNote(attempt: Attempt): string {
  const last = attempt.history[attempt.history.length - 1];
  const note = last?.note ?? attempt.reason;
  return note ? `: ${untrustedText(note, 1_000)}` : "";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
