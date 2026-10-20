// The seller's credit: `superstables seller top-up` and `superstables seller credit`.
//
// A top-up is an ordinary x402 payment, so this command pays it through the path every purchase takes
// (src/cli/pay.ts): the same signer, the same spend policy, the same approval in the owner's wallet. What is
// different is what it refuses. This command has just made the top-up, so it knows the id and the amount it
// asked for, and a pay link or a 402 that names another origin, id, amount, chain or token is not paid.
//
// A payment the site calls pending, or whose outcome the site could not confirm, is never paid again from
// here, and no new top-up is created while an earlier one may have been paid. Only `superstables seller credit`
// and the site can say what became of it. "Nothing was charged" is said only when nothing was signed.

import { join } from "node:path";
import { withFileLock } from "../core/lock.js";
import { shownTransaction } from "../core/pay.js";
import { SecretEchoedError, quote as takeQuote } from "../core/quote.js";
import { SellerTextError, untrustedJson, untrustedText, untrustedUrl } from "../core/text.js";
import type { Attempt, Quote } from "../core/types.js";
import { NotPaidEndpointError } from "../core/x402.js";
import {
  KEY_ECHOED_MESSAGE,
  SellerApiError,
  TOP_UP_NETWORK,
  createTopUp,
  earlierTopUpProblem,
  holdsSecret,
  readSellerCredit,
  redactSecret,
  scrubbed,
  topUpFromAnswer,
  topUpPayHref,
  topUpProblem,
  topUpTermsProblem,
  type SellerCredit,
  type TopUp,
  type TopUpAmount,
} from "../seller/top-up.js";
import type { PaymentContext } from "./context.js";
import { field, table, termsMoney } from "./format.js";
import { CliError, EXIT, exitCodeFor, isFinalAttempt, type ExitCode } from "./outcome.js";
import { PaymentStartedError, approveAndPay } from "./pay.js";
import { messageFor } from "./views.js";

/** The command, as the help and every Next line names it. */
export const TOP_UP_COMMAND = "superstables seller top-up";
/** The command that reads the balance, and rechecks pending top-ups on the way. */
export const CREDIT_COMMAND = "superstables seller credit";

/** The lock file in the records folder, and how long a second command waits for it: a create and a quote take seconds. */
const TOP_UP_LOCK = "top-up.lock";
const TOP_UP_LOCK_WAIT_MS = 120_000;

/** How a top-up is created and paid. The defaults are the client's own paths; tests replace them. */
export interface TopUpPorts {
  /** Run the check, the create and the quote while holding the lock that keeps two top-up commands from both passing the check. */
  locked<T>(work: () => Promise<T>): Promise<T>;
  /** The seller's credit, as the site lists it now (and after it rechecked its pending top-ups). */
  credit(options: { site: URL; apiKey: string }): Promise<SellerCredit>;
  /** The payments this machine has recorded, newest first. */
  attempts(): Attempt[];
  create(options: { site: URL; apiKey: string; amount: string }): Promise<TopUp>;
  quote(url: string): Promise<Quote>;
  /** Pay the quote and return its attempt as it ended. Throws PaymentStartedError once a payment exists. */
  pay(quote: Quote, say: (line: string) => void): Promise<Attempt>;
}

/**
 * The real ports: the seller API, and a quote and a payment through this machine's wallet and policy. `deps` was built
 * with the key-guarded fetch (keyGuardedFetch), so the payment's own reads refuse an answer that echoes the key; the
 * quote refuses one by itself.
 */
export function clientPorts(deps: PaymentContext, options: { apiKey: string; wait?: number }): TopUpPorts {
  return {
    locked: (work) => withFileLock(join(deps.records.ensureDir(), TOP_UP_LOCK), work, TOP_UP_LOCK_WAIT_MS),
    credit: (read) => readSellerCredit(read),
    attempts: () => deps.records.listAttempts(),
    create: (made) => createTopUp(made),
    quote: (url) =>
      takeQuote({ url }, { records: deps.records, policy: deps.policy, chain: TOP_UP_NETWORK.key, secret: options.apiKey }),
    pay: (quote, say) =>
      approveAndPay(deps, quote.id, {
        ...(options.wait === undefined ? {} : { wait: options.wait }),
        say,
        command: TOP_UP_COMMAND,
        label: `the top-up of ${termsMoney(quote.terms)}`,
      }),
  };
}

/** What happened to one top-up, in the client's words: the sentence to print, the next command, and the exit code. */
export interface TopUpResult {
  topUp: TopUp;
  amount: TopUpAmount;
  quote?: Quote;
  attempt?: Attempt;
  message: string;
  next: string;
  exitCode: ExitCode;
}

/**
 * Create a top-up, check it is the one that was asked for, and pay it. Nothing is paid when the site's
 * answer, the pay link or the 402 does not name exactly this top-up on Base Sepolia in test USDC.
 *
 * Nothing is created while an earlier top-up may have been paid. The site's answers that hold the key are refused
 * where they are read; every line, field and sentence that leaves here is redacted against it as well, because this
 * command's output is pasted into bug reports.
 */
export async function runTopUp(input: {
  site: URL;
  apiKey: string;
  amount: TopUpAmount;
  say: (line: string) => void;
  ports: TopUpPorts;
}): Promise<TopUpResult> {
  const { apiKey } = input;
  const result = await topUpSteps({ ...input, say: (line) => input.say(redactSecret(line, apiKey)) });
  return {
    ...result,
    topUp: scrubbed(result.topUp, apiKey),
    message: untrustedText(redactSecret(result.message, apiKey), 2_000),
    next: untrustedText(redactSecret(result.next, apiKey), 2_000),
  };
}

async function topUpSteps(input: {
  site: URL;
  apiKey: string;
  amount: TopUpAmount;
  say: (line: string) => void;
  ports: TopUpPorts;
}): Promise<TopUpResult> {
  const { apiKey, amount, say, ports } = input;

  // The check, the create and the quote are one step under a lock, so two commands cannot both pass the check. The
  // owner's decision is not: the payment starts after the lock is released, and its attempt is what a later check sees.
  const prepared = await ports.locked(() => prepare(input));
  if ("message" in prepared) return prepared;
  const { topUp, quote } = prepared;

  let attempt: Attempt;
  try {
    attempt = await ports.pay(quote, say);
  } catch (err) {
    if (err instanceof PaymentStartedError) return startedPayment(topUp, amount, quote, err, apiKey);
    // Any other throw is from before the payment started.
    return {
      topUp,
      amount,
      quote,
      message: `The payment was not started: ${messageOf(err)}. Nothing was paid.`,
      next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again when the cause is fixed.`,
      exitCode: err instanceof CliError ? err.exitCode : EXIT.failed,
    };
  }
  return { topUp: latestTopUp(topUp, attempt), amount, quote, attempt, ...paidOutcome(quote, attempt, apiKey) };
}

/**
 * Everything before the payment: refuse while an earlier top-up is in doubt, create the top-up, check it, and take the
 * quote of its pay link. A result is an answer that ends the command; otherwise the top-up and the quote to pay.
 */
async function prepare(input: {
  site: URL;
  apiKey: string;
  amount: TopUpAmount;
  ports: TopUpPorts;
}): Promise<TopUpResult | { topUp: TopUp; quote: Quote }> {
  const { site, apiKey, amount, ports } = input;

  // A top-up already in doubt comes first: another one now could pay twice. Reading the credit also makes the site
  // recheck its pending payments, so a payment that has since been settled stops being in doubt.
  const earlier = earlierTopUpProblem({ site, credit: await ports.credit({ site, apiKey }), attempts: ports.attempts() });
  if (earlier) throw new CliError(`${capitalised(earlier)}.`, EXIT.refused);

  const topUp = await ports.create({ site, apiKey, amount: amount.decimal });

  // The answer is the site's, so it is checked before anything is paid: a wrong id, amount or pay link is
  // a refusal, never something to work around.
  const problem = topUpProblem(topUp, site, amount);
  if (problem) return refusal(topUp, amount, `the site answered with ${problem}. Nothing was paid.`);

  if (topUp.status === "paid") {
    return {
      topUp,
      amount,
      message: `The site gave this top-up as already paid (${amount.decimal} USDC). This command did not pay it.`,
      next: `Confirm with \`${CREDIT_COMMAND}\`, which shows the balance and the top-up's status.`,
      exitCode: EXIT.done,
    };
  }
  if (topUp.status === "pending") {
    return {
      topUp,
      amount,
      message:
        "The site already has a payment for this top-up in flight (pending), so this command pays nothing more: " +
        "a second payment could move the money twice.",
      next: `Do not pay again. \`${CREDIT_COMMAND}\` rechecks pending top-ups before it answers, and the balance shows the credit once the payment is settled and final.`,
      exitCode: EXIT.unknown,
    };
  }

  // The pay link was checked above to be this site's own, this top-up's own and carry nothing else, so
  // its answer can be read like any seller's 402.
  let quote: Quote;
  try {
    quote = await ports.quote(topUpPayHref(topUp));
  } catch (err) {
    return unreadablePayLink(topUp, amount, err, apiKey);
  }

  // What the 402 asks for, against what was asked for here: the chain, the token, the exact amount, the
  // scheme. The recipient is the site's to name; the link was checked to be the site's own.
  const termsProblem = topUpTermsProblem(
    {
      amountAtomic: quote.terms.amountAtomic,
      asset: quote.terms.asset,
      assetAddress: quote.terms.assetAddress,
      network: quote.terms.network,
      scheme: quote.terms.scheme,
    },
    amount,
  );
  if (termsProblem) {
    return {
      topUp,
      amount,
      quote,
      message: `The top-up's payment is not the one this command asked for: ${termsProblem}. Nothing was paid.`,
      next: `Do not pay it. Run \`${TOP_UP_COMMAND} <amount>\` again for a new top-up, and report the pay link to Superstables.`,
      exitCode: EXIT.refused,
    };
  }

  if (!quote.policy.allowed) {
    return {
      topUp,
      amount,
      quote,
      message: `The top-up's payment was quoted, but a spend policy refused it: ${quote.policy.reason ?? "no reason given"}. Nothing was paid.`,
      next: `\`superstables policy show\` prints the rules; the owner raises the cap in the policy file if a top-up of ${amount.decimal} USDC should be allowed.`,
      exitCode: EXIT.refused,
    };
  }

  return { topUp, quote };
}

/**
 * The site's own latest word on the top-up, from a 200 answer to the payment, when that answer names this
 * top-up. Anything else keeps what creation said: the status is printed, and this command never pays from it.
 */
function latestTopUp(created: TopUp, attempt: Attempt): TopUp {
  if (attempt.serviceStatus !== 200 || !attempt.serviceBody) return created;
  try {
    const body = JSON.parse(attempt.serviceBody) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return created;
    const answer = "top_up" in (body as Record<string, unknown>) ? body : { top_up: body };
    const site = topUpFromAnswer(answer);
    return site.id === created.id && site.status ? { ...created, status: site.status } : created;
  } catch {
    return created;
  }
}

/** The top-up as this command prints it: one field per fact, then what happened and what to run next. */
export function printTopUp(result: TopUpResult): void {
  console.log(field("top-up", result.topUp.id));
  console.log(field("amount", `${result.amount.decimal} ${TOP_UP_NETWORK.token.symbol}`));
  console.log(field("chain", `${TOP_UP_NETWORK.label}, in test USDC`));
  console.log(field("status", result.topUp.status));
  if (result.attempt) {
    const attempt = result.attempt;
    const chain = attempt.chain ? `, chain ${attempt.chain === "verified" ? "verified" : attempt.chain}` : "";
    console.log(field("payment", `${attempt.state}${chain} (attempt ${attempt.id})`));
    const hash = shownTransaction(attempt.transaction, attempt.terms.network);
    if (hash.url ?? hash.hash) console.log(field("transaction", hash.url ?? hash.hash));
  }
  console.log("");
  console.log(result.message);
  console.log("");
  console.log(`Next: ${result.next}`);
}

/** The same, as one JSON value. Every field the site wrote is marked as its words, not the client's. */
export function topUpJson(result: TopUpResult): Record<string, unknown> {
  return untrustedJson({
    top_up: {
      id: result.topUp.id,
      amount: result.amount.decimal,
      status: result.topUp.status,
      ...(result.topUp.payUrl ? { pay_url: untrustedUrl(result.topUp.payUrl) } : {}),
    },
    ...(result.quote ? { quote_id: result.quote.id } : {}),
    ...(result.attempt
      ? {
          attempt_id: result.attempt.id,
          state: result.attempt.state,
          chain: result.attempt.chain ?? null,
          chain_final: result.attempt.chainFinal ?? null,
        }
      : {}),
    message: result.message,
    next: result.next,
    exit_code: result.exitCode,
  });
}

/** The seller's balance, latest top-ups and credit entries, one fact per line and one table each. */
export function printCredit(credit: SellerCredit): void {
  console.log(field("balance", `${credit.balance ?? "unknown"} ${credit.asset}`));
  console.log(field("chain", `${TOP_UP_NETWORK.label}, in test USDC`));
  console.log("");
  if (credit.topUps.length === 0) {
    console.log("No top-up is listed.");
  } else {
    console.log(
      table(
        ["when", "id", "amount", "status"],
        credit.topUps.map((topUp) => [topUp.createdAt ?? "", topUp.id, `${topUp.amount} ${credit.asset}`, topUp.retired ? "retired" : topUp.status]),
      ),
    );
  }
  console.log("");
  if (credit.entries.length === 0) {
    console.log("No credit entry is listed.");
  } else {
    console.log(
      table(
        ["when", "kind", "amount", "reference"],
        credit.entries.map((entry) => [
          entry.at ?? "",
          entry.kind ?? "",
          entry.amount === undefined ? "" : `${entry.amount} ${credit.asset}`,
          entry.reference ?? "",
        ]),
      ),
    );
  }
  console.log("");
  console.log(`A referred sale's fee comes out of this balance. \`${TOP_UP_COMMAND} <amount>\` adds to it.`);
}

/** The same, as one JSON value, with the site's fields marked as its words. */
export function creditJson(credit: SellerCredit): Record<string, unknown> {
  return untrustedJson({
    balance: credit.balance ?? null,
    asset: credit.asset,
    network: TOP_UP_NETWORK.caip2,
    top_ups: credit.topUps.map((topUp) => ({
      id: topUp.id,
      amount: topUp.amount,
      status: topUp.status,
      ...(topUp.retired ? { retired: true } : {}),
      ...(topUp.createdAt ? { created_at: topUp.createdAt } : {}),
    })),
    entries: credit.entries,
    next: TOP_UP_COMMAND,
  });
}

// ── Internals ───────────────────────────────────────────────────────────────────────────

function refusal(topUp: TopUp, amount: TopUpAmount, message: string): TopUpResult {
  return {
    topUp,
    amount,
    message,
    next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again for a new top-up, or \`${CREDIT_COMMAND}\` to see the balance.`,
    exitCode: EXIT.refused,
  };
}

/** What the site said about a top-up in an answer that was not a payment request, or not a paid one. */
type SiteWord =
  /** It counts the top-up as paid. */
  | "paid"
  /** A payment holds it, or the site could not tell: whether money moved is unknown. */
  | "in_flight"
  /** It can no longer be paid. */
  | "retired"
  /** The answer held the API key and was not read. */
  | "echo"
  | "other";

/** Codes the site gives while a payment holds a top-up or its outcome is unknown. */
const IN_FLIGHT_CODES = new Set(["payment_pending", "payment_already_used", "payment_outcome_unknown"]);

/**
 * What an answer from the pay link means for the money, from its status and body. `money_moved` counts on any status:
 * anything but a plain false (the site's "unknown", or true) is a payment that may have moved, whatever else the
 * answer says. Only the words this client knows are taken from the body; none of it is repeated.
 */
function siteWord(status: number | undefined, body: string | undefined, apiKey: string): SiteWord {
  if (body && holdsSecret(body, apiKey)) return "echo";
  const seen = answerFields(body);
  if (seen.moneyMoved !== undefined && seen.moneyMoved !== false) return "in_flight";
  if (status === 409 || status === 502 || (seen.code !== undefined && IN_FLIGHT_CODES.has(seen.code))) return "in_flight";
  if (status === 410 || seen.code === "top_up_retired") return "retired";
  if (status === 200) {
    if (seen.topUpStatus === "paid") return "paid";
    if (seen.topUpStatus === "pending") return "in_flight";
  }
  return "other";
}

function answerFields(body: string | undefined): { code?: string; moneyMoved?: unknown; topUpStatus?: string } {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { error?: Record<string, unknown>; code?: unknown; money_moved?: unknown; top_up?: { status?: unknown } };
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : undefined;
    const code = error?.code ?? parsed?.code;
    const status = parsed?.top_up?.status ?? (error?.top_up as { status?: unknown } | undefined)?.status;
    return {
      ...(typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code) ? { code } : {}),
      ...((error?.money_moved ?? parsed?.money_moved) !== undefined ? { moneyMoved: error?.money_moved ?? parsed?.money_moved } : {}),
      ...(typeof status === "string" ? { topUpStatus: status } : {}),
    };
  } catch {
    // Cut off or not JSON: a money_moved that is not false is still seen.
    return /"money_moved"\s*:\s*(?!false\b)\S/.test(body) ? { moneyMoved: "unknown" } : {};
  }
}

/** What an answer from the pay link, read before anything is signed, means for the top-up and the next step. */
function readOutcome(word: SiteWord, status: number | undefined, amount: string): { message: string; next: string; exitCode: ExitCode } {
  const http = status === undefined ? "" : ` (HTTP ${status})`;
  switch (word) {
    case "paid":
      return {
        message: `The site says this top-up is already paid${http}. This command did not pay it, and pays nothing more.`,
        next: `Do not pay again. Confirm with \`${CREDIT_COMMAND}\`, which shows the balance and the top-up's status.`,
        exitCode: EXIT.done,
      };
    case "in_flight":
    case "echo":
      return {
        message:
          word === "echo"
            ? `${capitalised(KEY_ECHOED_MESSAGE)}. This command signed nothing, but whether a payment for this top-up is in flight or paid is unknown, so it pays nothing more.`
            : `The site says a payment for this top-up may be in flight or could not be confirmed${http}: whether the money ` +
              "moved is unknown, so this command pays nothing more.",
        next: `Do not pay again, and do not ask for another top-up until \`${CREDIT_COMMAND}\` shows this one as paid or retired. It rechecks pending top-ups before it answers; the balance shows the credit once the payment is settled and final.`,
        exitCode: EXIT.unknown,
      };
    case "retired":
      return {
        message: `The site retired this top-up${http}, so it can no longer be paid. Nothing was paid.`,
        next: `Ask for a new top-up: \`${TOP_UP_COMMAND} ${amount}\`.`,
        exitCode: EXIT.failed,
      };
    default:
      return {
        message: `The top-up's pay link answered${status === undefined ? "" : ` HTTP ${status}`}, not a payment request. This command signed nothing.`,
        next: `\`${CREDIT_COMMAND}\` shows this top-up. If it is still open, run \`${TOP_UP_COMMAND} ${amount}\` again, and report the pay link to Superstables if it stays so.`,
        exitCode: EXIT.failed,
      };
  }
}

/** The pay link could not be read as a payment request: the site's own word on the top-up is the answer, whatever its status. */
function unreadablePayLink(topUp: TopUp, amount: TopUpAmount, err: unknown, apiKey: string): TopUpResult {
  if (err instanceof NotPaidEndpointError) return { topUp, amount, ...readOutcome(siteWord(err.status, err.body, apiKey), err.status, amount.decimal) };
  if (err instanceof SecretEchoedError || (err instanceof SellerApiError && err.code === "key_echoed")) {
    return { topUp, amount, ...readOutcome("echo", undefined, amount.decimal) };
  }
  if (err instanceof SellerTextError) {
    // The seller's offers, labelled as its words: the client's own sentence is in err.message.
    return {
      topUp,
      amount,
      message: `${err.message}. Nothing was paid; this command pays only Base Sepolia test USDC for the amount it asked for.`,
      next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again for a new top-up, and report the pay link to Superstables.`,
      exitCode: EXIT.failed,
    };
  }
  return {
    topUp,
    amount,
    message: `The top-up's pay link could not be read (${messageOf(err)}). Nothing was paid.`,
    next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again for a new top-up, and report the pay link to Superstables.`,
    exitCode: EXIT.failed,
  };
}

/**
 * The payment exists, and the command failed while following it. What the records say about the attempt decides: an
 * attempt that ended is reported as it ended, and one that did not is unknown.
 */
function startedPayment(topUp: TopUp, amount: TopUpAmount, quote: Quote, err: PaymentStartedError, apiKey: string): TopUpResult {
  const attempt = err.attempt;
  if (attempt && isFinalAttempt(attempt)) {
    return { topUp: latestTopUp(topUp, attempt), amount, quote, attempt, ...paidOutcome(quote, attempt, apiKey) };
  }
  return {
    topUp,
    amount,
    quote,
    ...(attempt ? { attempt } : {}),
    message:
      `The payment (attempt ${err.attemptId}) had started, and this command could not follow it (${untrustedText(messageOf(err.cause), 300)}): ` +
      "whether it was paid is unknown.",
    next: `Do not pay again. \`superstables status ${err.attemptId}\` searches the payment on chain, and \`${CREDIT_COMMAND}\` shows the balance.`,
    exitCode: EXIT.unknown,
  };
}

/** The client's words for how the payment ended, with what a top-up adds: the credit, and never a second payment. */
function paidOutcome(quote: Quote, attempt: Attempt, apiKey: string): { message: string; next: string; exitCode: ExitCode } {
  const amount = termsMoney(quote.terms);
  if (attempt.state === "settled") {
    const final = attempt.chain === "verified" && attempt.chainFinal !== false;
    return {
      message:
        `Paid ${amount} to Superstables on ${quote.terms.networkLabel}.` +
        (final
          ? " The payment is final on chain, so the credit is on the seller's balance."
          : " Superstables adds the credit once the payment's block is final on chain, which this command does not wait for."),
      next: `\`${CREDIT_COMMAND}\` shows the balance and the top-up's status.`,
      exitCode: EXIT.done,
    };
  }
  if (attempt.state === "paid_service_failed") {
    const status = attempt.serviceStatus;
    const word = siteWord(status, attempt.serviceBody, apiKey);
    if (word === "in_flight" || word === "echo") {
      return {
        message:
          `The payment for ${amount} was sent, but Superstables says it is still pending or could not confirm it` +
          `${status === undefined ? "" : ` (HTTP ${status})`}: whether the money moved is unknown.`,
        next: `Do not pay again. \`${CREDIT_COMMAND}\` rechecks pending top-ups before it answers, and \`superstables status ${attempt.id}\` searches the payment on chain.`,
        exitCode: EXIT.unknown,
      };
    }
    if (word === "retired") {
      return {
        message:
          `The payment for ${amount} was sent, but Superstables retired this top-up (HTTP ${status ?? "an error"}), so it ` +
          "will not be credited. Whether the money moved is unknown.",
        next: `Do not pay this top-up again. \`${CREDIT_COMMAND}\` shows the balance; ask for a new top-up with \`${TOP_UP_COMMAND} <amount>\` once this one is clear.`,
        exitCode: EXIT.unknown,
      };
    }
    return {
      message: `The payment for ${amount} was sent, but Superstables answered HTTP ${status ?? "an error"}, so the credit is not confirmed.`,
      next: `Do not pay again. \`superstables status ${attempt.id}\` shows the site's answer, and \`${CREDIT_COMMAND}\` shows the balance.`,
      exitCode: EXIT.paidNotDelivered,
    };
  }
  if (attempt.state === "uncertain") {
    return {
      message: messageFor(attempt),
      next: `Do not pay again until \`superstables status ${attempt.id}\` says this payment was not made; \`${CREDIT_COMMAND}\` shows the balance.`,
      exitCode: EXIT.unknown,
    };
  }
  // The payment stopped at the engine's read of the pay link, before anything was signed: the site's word on the
  // top-up decides, as it did when the quote was read.
  if (attempt.state === "failed" && !attempt.transaction && (attempt.serviceStatus !== undefined || attempt.reason?.includes(KEY_ECHOED_MESSAGE))) {
    const word = attempt.reason?.includes(KEY_ECHOED_MESSAGE) ? "echo" : siteWord(attempt.serviceStatus, attempt.serviceBody, apiKey);
    return readOutcome(word, attempt.serviceStatus, quote.terms.amountDecimal.toString());
  }
  // denied, expired, abandoned or failed: nothing was paid.
  const refusal = attempt.refusal === "policy";
  return {
    message: messageFor(attempt),
    next: refusal
      ? `\`superstables policy show\` prints the rules; the owner edits the policy file if a top-up of ${quote.terms.amountDecimal} USDC should be allowed.`
      : attempt.transaction
        ? `Do not pay again yet: \`superstables status ${attempt.id}\` looks for this payment.`
        : `Nothing was charged. Run \`${TOP_UP_COMMAND} <amount>\` again to ask for another top-up, or \`${CREDIT_COMMAND}\` to see this one.`,
    exitCode: exitCodeFor(attempt),
  };
}

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
