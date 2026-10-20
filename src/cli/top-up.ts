// The seller's credit: `superstables seller top-up` and `superstables seller credit`.
//
// A top-up is an ordinary x402 payment, so this command pays it through the path every purchase takes
// (src/cli/pay.ts): the same signer, the same spend policy, the same approval in the owner's wallet. What is
// different is what it refuses. This command has just made the top-up, so it knows the id and the amount it
// asked for, and a pay link or a 402 that names another origin, id, amount, chain or token is not paid.
//
// A payment the site calls pending, or whose outcome the site could not confirm, is never paid again from
// here. Only `superstables seller credit` and the site can say what became of it.

import { shownTransaction } from "../core/pay.js";
import { quote as takeQuote } from "../core/quote.js";
import { SellerTextError, untrustedJson, untrustedUrl } from "../core/text.js";
import type { Attempt, Quote } from "../core/types.js";
import { NotPaidEndpointError } from "../core/x402.js";
import {
  TOP_UP_NETWORK,
  createTopUp,
  redactSecret,
  topUpFromAnswer,
  topUpProblem,
  topUpTermsProblem,
  type SellerCredit,
  type TopUp,
  type TopUpAmount,
} from "../seller/top-up.js";
import type { PaymentContext } from "./context.js";
import { field, table, termsMoney } from "./format.js";
import { CliError, EXIT, exitCodeFor, type ExitCode } from "./outcome.js";
import { approveAndPay } from "./pay.js";
import { messageFor } from "./views.js";

/** The command, as the help and every Next line names it. */
export const TOP_UP_COMMAND = "superstables seller top-up";
/** The command that reads the balance, and rechecks pending top-ups on the way. */
export const CREDIT_COMMAND = "superstables seller credit";

/** How a top-up is created and paid. The defaults are the client's own paths; tests replace them. */
export interface TopUpPorts {
  create(options: { site: URL; apiKey: string; amount: string }): Promise<TopUp>;
  quote(url: string): Promise<Quote>;
  pay(quote: Quote, say: (line: string) => void): Promise<Attempt>;
}

/** The real ports: the seller API, and a quote and a payment through this machine's wallet and policy. */
export function clientPorts(deps: PaymentContext, wait?: number): TopUpPorts {
  return {
    create: (options) => createTopUp(options),
    quote: (url) =>
      takeQuote({ url }, { records: deps.records, policy: deps.policy, chain: TOP_UP_NETWORK.key }),
    pay: (quote, say) =>
      approveAndPay(deps, quote.id, {
        ...(wait === undefined ? {} : { wait }),
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
 * Every sentence that leaves here is redacted against the key: an error may quote the request back, and
 * this command's output is pasted into bug reports.
 */
export async function runTopUp(input: {
  site: URL;
  apiKey: string;
  amount: TopUpAmount;
  say: (line: string) => void;
  ports: TopUpPorts;
}): Promise<TopUpResult> {
  const result = await topUpSteps(input);
  return {
    ...result,
    message: redactSecret(result.message, input.apiKey),
    next: redactSecret(result.next, input.apiKey),
  };
}

async function topUpSteps(input: {
  site: URL;
  apiKey: string;
  amount: TopUpAmount;
  say: (line: string) => void;
  ports: TopUpPorts;
}): Promise<TopUpResult> {
  const { site, apiKey, amount, say, ports } = input;
  const topUp = await ports.create({ site, apiKey, amount: amount.decimal });

  // The answer is the site's, so it is checked before anything is paid: a wrong id, amount or pay link is
  // a refusal, never something to work around.
  const problem = topUpProblem(topUp, site, amount);
  if (problem) return refusal(topUp, amount, `the site answered with ${problem}. Nothing was paid.`);

  if (topUp.status === "paid") {
    return {
      topUp,
      amount,
      message: `The site already has this top-up paid: ${amount.decimal} USDC.`,
      next: `\`${CREDIT_COMMAND}\` shows the balance and the top-up's status.`,
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
    quote = await ports.quote(topUp.payUrl as string);
  } catch (err) {
    return unreadablePayLink(topUp, amount, err);
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

  let attempt: Attempt;
  try {
    attempt = await ports.pay(quote, say);
  } catch (err) {
    // approveAndPay throws only when nothing started.
    return {
      topUp,
      amount,
      quote,
      message: `The payment was not started: ${messageOf(err)}. Nothing was paid.`,
      next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again when the cause is fixed.`,
      exitCode: err instanceof CliError ? err.exitCode : EXIT.failed,
    };
  }
  return { topUp: latestTopUp(topUp, attempt), amount, quote, attempt, ...paidOutcome(quote, attempt) };
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
        credit.topUps.map((topUp) => [topUp.createdAt ?? "", topUp.id, `${topUp.amount} ${credit.asset}`, topUp.status]),
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

/** The pay link answered something other than a 402: the site says what became of the top-up, and that is the answer. */
function unreadablePayLink(topUp: TopUp, amount: TopUpAmount, err: unknown): TopUpResult {
  if (err instanceof NotPaidEndpointError) {
    const code = errorCodeIn(err.bodyPreview);
    if (err.status === 200) {
      return {
        topUp,
        amount,
        message: "The site says this top-up is already paid, so this command pays nothing more.",
        next: `Do not pay again. \`${CREDIT_COMMAND}\` shows the balance and the top-up's status.`,
        exitCode: EXIT.done,
      };
    }
    if (err.status === 409 || code === "payment_pending") {
      return {
        topUp,
        amount,
        message:
          "The site says a payment for this top-up is still pending (HTTP 409, payment_pending): whether the money " +
          "moved is unknown, so this command pays nothing more.",
        next: `Do not pay again. \`${CREDIT_COMMAND}\` rechecks pending top-ups before it answers; the balance shows the credit once the payment is settled and final.`,
        exitCode: EXIT.unknown,
      };
    }
    if (err.status === 410 || code === "top_up_retired") {
      return {
        topUp,
        amount,
        message: "The site retired this top-up (HTTP 410, top_up_retired), so it can no longer be paid. Nothing was paid.",
        next: `Ask for a new top-up: \`${TOP_UP_COMMAND} ${amount.decimal}\`.`,
        exitCode: EXIT.failed,
      };
    }
    if (err.status === 502) {
      return {
        topUp,
        amount,
        message:
          "The site could not confirm what happened to this top-up (HTTP 502): whether a payment moved is unknown, " +
          "so this command pays nothing more.",
        next: `Do not pay again. \`${CREDIT_COMMAND}\` shows the balance and the top-up's status; check again later.`,
        exitCode: EXIT.unknown,
      };
    }
    return {
      topUp,
      amount,
      message: `The top-up's pay link answered HTTP ${err.status}, not a payment request. Nothing was paid.`,
      next: `Run \`${TOP_UP_COMMAND} ${amount.decimal}\` again for a new top-up, and report the pay link to Superstables.`,
      exitCode: EXIT.failed,
    };
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

/** The client's words for how the payment ended, with what a top-up adds: the credit, and never a second payment. */
function paidOutcome(quote: Quote, attempt: Attempt): { message: string; next: string; exitCode: ExitCode } {
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
    const code = errorCodeIn(attempt.serviceBody);
    if (status === 409 || code === "payment_pending") {
      return {
        message:
          `The payment for ${amount} was sent, but Superstables says it is still pending (HTTP 409, payment_pending): ` +
          "whether the money moved is unknown.",
        next: `Do not pay again. \`${CREDIT_COMMAND}\` rechecks pending top-ups before it answers, and \`superstables status ${attempt.id}\` searches the payment on chain.`,
        exitCode: EXIT.unknown,
      };
    }
    if (status === 502) {
      return {
        message: `The payment for ${amount} was sent, but Superstables could not confirm it (HTTP 502): whether the money moved is unknown.`,
        next: `Do not pay again. \`${CREDIT_COMMAND}\` shows the balance and the top-up's status; check again later.`,
        exitCode: EXIT.unknown,
      };
    }
    if (status === 410 || code === "top_up_retired") {
      return {
        message:
          `The payment for ${amount} was sent, but Superstables retired this top-up (HTTP 410, top_up_retired), so it ` +
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

/** The site's error code in an answer body, if it names one. */
function errorCodeIn(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    const code = parsed?.error?.code ?? parsed?.code;
    return typeof code === "string" && code.length <= 120 ? code : undefined;
  } catch {
    return undefined;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
