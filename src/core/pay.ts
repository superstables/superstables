// Paying. One quote becomes at most one attempt, and an attempt is a small state machine
// whose every step is written down before the next one starts. Two ideas shape this file:
//
//   1. A payment is not a function call that returns money. It is a request to a human that
//      may take a minute, so startPayment() returns immediately with an attempt the caller
//      can watch, and the work continues in the background.
//   2. Uncertainty is a real outcome. If the credential left this machine and we never
//      learned what happened to it, the attempt ends `uncertain` and is never retried
//      automatically — retrying a payment we cannot account for is how money gets spent twice.
//
// The duplicate-payment guard is the quote: it is marked `used` the moment an attempt exists
// for it, and a second attempt on the same quote is refused. The one exception is an attempt
// that could not even ask the owner (no approval page, no wallet to talk to): nothing exists
// that could be signed or submitted, so its quote is handed back.

import { EventEmitter } from "node:events";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { txUrl } from "./chain.js";
import { getQuote } from "./quote.js";
import { NotPaidEndpointError, parseChallenge, sameTerms, termsFor, type Challenge } from "./x402.js";
import { Records } from "./records.js";
import { SignRefused, type Signer } from "./signer/types.js";
import type { Policy } from "./policy.js";
import type { AbandonCause, Attempt, AttemptState, PaymentTerms, Quote, Receipt, ServiceOutcome } from "./types.js";
import { FINAL_ATTEMPT_STATES } from "./types.js";

/** How much of the service's answer is kept on the attempt and the receipt. */
export const SERVICE_BODY_LIMIT = 4_000;
/** The seller settles the payment inside this request, so it may take a while. */
const SUBMIT_TIMEOUT_MS = 120_000;
/** Default ceiling for waitForAttempt: longer than the wallet's own approval timeout. */
const DEFAULT_WAIT_MS = 140_000;

export interface PaymentEngineOptions {
  records: Records;
  /** The agent-side copy of the owner's policy. The wallet applies the owner's copy again. */
  policy: Policy;
  signer: Signer;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
}

/**
 * A second payment on a quote that already started one. The message names the payment that
 * exists, so whoever asked picks that one up instead of starting another.
 */
export class QuoteUsedError extends Error {
  constructor(
    readonly quoteId: string,
    /** The attempt this quote started, when the records still have it. */
    readonly attempt?: Attempt,
  ) {
    super(
      attempt
        ? `A payment for this quote already exists: attempt ${attempt.id}, ${attempt.state}` +
            `${isFinal(attempt.state) ? "" : " (not final)"}. A quote starts at most one payment; ` +
            "do not start another one for it"
        : "This quote has already been used to start a payment; quote again before paying",
    );
    this.name = "QuoteUsedError";
  }
}

export class PaymentEngine {
  /** Emits "transition" with the attempt after every state change, for logs and the CLI. */
  readonly events = new EventEmitter();

  private readonly records: Records;
  private readonly policy: Policy;
  private readonly signer: Signer;
  private readonly fetchImpl: typeof fetch;
  /** Attempts this process is running, so a caller sees the live state without a file read. */
  private readonly live = new Map<string, Attempt>();

  constructor(options: PaymentEngineOptions) {
    this.records = options.records;
    this.policy = options.policy;
    this.signer = options.signer;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  }

  /**
   * Begin paying a quote. Returns the attempt as soon as it exists — the owner has not been
   * asked yet — and carries on in the background. Throws only when there is nothing to start:
   * an unknown, used, stale or expired quote.
   */
  startPayment(quoteId: string): Attempt {
    const quote = getQuote(quoteId, this.records);
    if (!quote) throw new Error(`There is no quote ${quoteId} on this machine`);
    if (quote.status === "used") {
      const existing = this.records.attemptForQuote(quote.id);
      throw new QuoteUsedError(quote.id, existing ? this.getAttempt(existing.id) : undefined);
    }
    if (quote.status === "stale") {
      throw new Error("The seller changed its terms after this quote was taken; quote again before paying");
    }
    if (quote.status === "expired") throw new Error("This quote has expired; quote again before paying");

    const at = new Date().toISOString();
    const attempt: Attempt = {
      id: this.records.newId(),
      quoteId: quote.id,
      createdAt: at,
      updatedAt: at,
      state: "awaiting_approval",
      url: quote.url,
      serviceId: quote.serviceId,
      serviceName: quote.serviceName,
      terms: quote.terms,
      history: [{ at, state: "awaiting_approval" }],
    };
    // Spend the quote before any await: two calls in the same tick must not both start.
    this.records.saveQuote({ ...quote, status: "used" });
    this.records.saveAttempt(attempt);
    this.live.set(attempt.id, attempt);
    this.events.emit("transition", attempt);

    void this.run(attempt, quote).catch((err) => {
      // The background run handles its own failures; this is the last net.
      this.settleState(attempt, "failed", { reason: message(err) });
    });
    return attempt;
  }

  /** Resolves when the attempt is final, or when the timeout passes — with the attempt either way. */
  async waitForAttempt(id: string, timeoutMs: number = DEFAULT_WAIT_MS): Promise<Attempt> {
    const current = this.getAttempt(id);
    if (!current) throw new Error(`There is no payment attempt ${id} on this machine`);
    if (isFinal(current.state)) return current;
    return new Promise<Attempt>((resolve) => {
      const finish = (attempt: Attempt) => {
        clearTimeout(timer);
        this.events.off("transition", onTransition);
        resolve(attempt);
      };
      const onTransition = (attempt: Attempt) => {
        if (attempt.id === id && isFinal(attempt.state)) finish(attempt);
      };
      // Deliberately not unref'd: a caller waiting on a payment is a reason to stay alive.
      const timer = setTimeout(() => finish(this.getAttempt(id) ?? current), timeoutMs);
      this.events.on("transition", onTransition);
    });
  }

  getAttempt(id: string): Attempt | undefined {
    return this.live.get(id) ?? this.records.getAttempt(id);
  }

  /**
   * The caller is going away (a CLI whose wait ran out, an interrupted process) and nobody
   * will be left to carry this attempt on. An attempt still waiting for the owner ends
   * `abandoned`: nothing was submitted, and `cause` records what ended the wait, so nobody
   * mistakes it for the owner's answer. One whose credential may already be on its way ends
   * `uncertain`, because that is what it is. A final attempt is left as it is.
   */
  stop(id: string, reason: string, cause?: AbandonCause): Attempt | undefined {
    const attempt = this.live.get(id);
    if (!attempt) return this.getAttempt(id);
    if (attempt.state === "awaiting_approval") {
      this.settleState(attempt, "abandoned", { reason, ...(cause ? { abandonedBy: cause } : {}) });
    } else if (attempt.state === "approved" || attempt.state === "submitting") {
      this.settleState(attempt, "uncertain", {
        reason: `${reason} after the owner approved, while the payment was being submitted`,
      });
    }
    return attempt;
  }

  listAttempts(limit?: number): Attempt[] {
    return this.records.listAttempts(limit).map((a) => this.live.get(a.id) ?? a);
  }

  getReceipt(id: string): Receipt | undefined {
    return this.records.getReceipt(id);
  }

  listReceipts(limit?: number): Receipt[] {
    return this.records.listReceipts(limit);
  }

  // ── The background run ───────────────────────────────────────────────────────────────

  private async run(attempt: Attempt, quote: Quote): Promise<void> {
    const started = Date.now();

    // The local policy already judged this at quote time. Honour it here rather than
    // bothering the owner with something this machine has already decided against.
    if (!quote.policy.allowed) {
      this.settleState(attempt, "failed", {
        refusal: "policy",
        reason: `the local spend policy refuses this payment: ${quote.policy.reason ?? "no reason given"}`,
      });
      return;
    }

    // 1. Ask again. The quote may be minutes old and the price is the seller's to change.
    let challenge: Challenge;
    try {
      challenge = await this.challengeFor(quote.url);
    } catch (err) {
      this.settleState(attempt, "failed", { reason: message(err) });
      return;
    }

    const offer = firstSupported(challenge);
    if (!offer || !sameTerms(quote.terms, offer.terms)) {
      this.markQuote(quote.id, "stale");
      this.settleState(attempt, "failed", { reason: "terms changed, quote again" });
      return;
    }

    // Whoever was waiting may have stopped while the seller was being asked; then nobody
    // is left to show the owner a link, so the owner is not asked.
    if (isFinal(attempt.state)) return;

    // 2. Ask the owner. Nothing has left this machine yet.
    let asked = false;
    let signed;
    try {
      signed = await this.signer.sign(
        {
          kind: "eip3009",
          requirements: offer.requirement,
          x402Version: challenge.version,
          context: {
            target: quote.url,
            serviceId: quote.serviceId,
            serviceName: quote.serviceName,
            description: quote.description,
            quoteId: quote.id,
            attemptId: attempt.id,
          },
        },
        {
          onPending: (walletRequestId, approvalUrl) => {
            asked = true;
            this.transition(attempt, "awaiting_approval", {
              walletRequestId,
              // Present when the signer serves the approval page itself; the surfaces pass it
              // on to the person, because without the link nobody can approve anything.
              ...(approvalUrl ? { approvalUrl } : {}),
              note: approvalUrl
                ? `waiting for the owner to approve at ${approvalUrl}`
                : "waiting for the owner to approve in the wallet",
            });
          },
        },
      );
    } catch (err) {
      const refusal = refusalOf(err);
      const state = refusalState(err);
      let reason = message(err);
      // The signer could not reach the owner at all: no page, no wallet request, nothing to
      // sign. Spending the quote on that would only send the agent off to quote again for a
      // fault on this machine, so the quote goes back to being payable.
      if (!asked && (refusal === "approval_page" || refusal === "unavailable") && this.reopenQuote(quote.id)) {
        reason = `${reason}. Nothing was signed, and quote ${quote.id} can still be paid`;
      }
      this.settleState(attempt, state, {
        reason,
        ...(refusal ? { refusal } : {}),
        // A signer that gave up with nobody deciding did so because its page went away.
        ...(state === "abandoned" ? { abandonedBy: "page_closed" as const } : {}),
      });
      return;
    }

    // A signature that arrives after the attempt was abandoned is never sent: the caller has
    // already been told nothing was submitted, and that has to stay true.
    if (isFinal(attempt.state)) return;

    this.transition(attempt, "approved", { payer: signed.signer });
    this.transition(attempt, "submitting");

    // 3. Replay the request with the credential. From here on the credential has left this
    //    machine, so every failure is a known-unknown, not a clean failure.
    const header = credentialHeader(challenge.version, offer.requirement, signed.payload);
    let res: Response;
    try {
      res = await this.fetchImpl(quote.url, {
        method: "GET",
        headers: { ...header, accept: "application/json, */*" },
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
    } catch (err) {
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        reason: `the payment credential was sent but the service could not be reached: ${message(err)}`,
      });
      return;
    }

    const body = (await res.text().catch(() => "")).slice(0, SERVICE_BODY_LIMIT);
    const settlement = readSettlement(res, challenge.version);

    if (!settlement) {
      if (res.status === 402) {
        this.settleState(attempt, "failed", {
          payer: signed.signer,
          serviceStatus: res.status,
          serviceBody: body,
          reason: "the payment did not settle: the service asked for payment again",
        });
        return;
      }
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        serviceStatus: res.status,
        serviceBody: body,
        reason: `the service answered ${res.status} without a payment receipt, so whether the payment settled is unknown`,
      });
      return;
    }

    if (!settlement.success) {
      this.settleState(attempt, "failed", {
        payer: settlement.payer ?? signed.signer,
        serviceStatus: res.status,
        serviceBody: body,
        reason: `the payment did not settle: ${settlement.errorReason ?? settlement.errorMessage ?? "the facilitator gave no reason"}`,
      });
      return;
    }

    // 4. The money moved. Whether the service then did its job is a separate fact.
    const ok = res.status >= 200 && res.status < 300;
    const receipt = this.writeReceipt({
      attempt,
      quote,
      settlement,
      payer: settlement.payer ?? signed.signer,
      serviceOutcome: ok ? "ok" : "failed",
      serviceStatus: res.status,
      body,
      ms: Date.now() - started,
    });
    this.settleState(attempt, ok ? "settled" : "paid_service_failed", {
      payer: receipt.payer,
      transaction: receipt.transaction,
      transactionUrl: receipt.transactionUrl,
      serviceStatus: res.status,
      serviceBody: body,
      receiptId: receipt.id,
      reason: ok ? undefined : `the payment settled but the service answered ${res.status}`,
    });
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────

  /**
   * Read the seller's current challenge. Mirrors x402.detect(), but through this engine's
   * fetch so a test (or a future proxy) can stand in for the network.
   */
  private async challengeFor(url: string): Promise<Challenge> {
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json, */*" },
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    const body = await res.text();
    if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
    const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
    return parseChallenge({ paymentRequiredHeader: header, body });
  }

  private writeReceipt(input: {
    attempt: Attempt;
    quote: Quote;
    settlement: SettleResponse;
    payer: string;
    serviceOutcome: ServiceOutcome;
    serviceStatus: number;
    body: string;
    ms: number;
  }): Receipt {
    const { attempt, quote, settlement } = input;
    const network = settlement.network ?? attempt.terms.network;
    const transaction = settlement.transaction ?? "";
    // A facilitator that has a hash gives one; one that has only accepted the transfer
    // gives something else. The receipt says which, rather than pretending to a hash.
    const kind = /^0x[0-9a-fA-F]+$/.test(transaction) ? "hash" : "pending";
    const receipt: Receipt = {
      id: attempt.id,
      at: new Date().toISOString(),
      quoteId: quote.id,
      attemptId: attempt.id,
      url: attempt.url,
      serviceId: attempt.serviceId,
      serviceName: attempt.serviceName,
      terms: attempt.terms,
      payer: input.payer,
      transaction,
      transactionKind: kind,
      transactionUrl: kind === "hash" ? txUrl(network, transaction) : "",
      network,
      settlement: {
        success: settlement.success,
        payer: settlement.payer,
        transaction: settlement.transaction,
        network: settlement.network,
        errorReason: settlement.errorReason,
      },
      serviceOutcome: input.serviceOutcome,
      serviceStatus: input.serviceStatus,
      serviceBodyPreview: input.body || undefined,
      ms: input.ms,
    };
    return this.records.saveReceipt(receipt);
  }

  /** Hand a spent quote back, only if nothing else has happened to it since it was spent. */
  private reopenQuote(id: string): boolean {
    const quote = this.records.getQuote(id);
    if (!quote || quote.status !== "used") return false;
    this.records.saveQuote({ ...quote, status: "open" });
    return true;
  }

  private markQuote(id: string, status: Quote["status"]): void {
    const quote = this.records.getQuote(id);
    if (quote) this.records.saveQuote({ ...quote, status });
  }

  /** Record a state change: patch the attempt, append to its history, persist, announce. */
  private transition(
    attempt: Attempt,
    state: AttemptState,
    patch: Partial<Attempt> & { note?: string } = {},
  ): Attempt {
    const { note, ...fields } = patch;
    Object.assign(attempt, fields);
    attempt.state = state;
    attempt.updatedAt = new Date().toISOString();
    attempt.history.push({ at: attempt.updatedAt, state, ...(note ? { note } : {}) });
    this.records.saveAttempt(attempt);
    this.events.emit("transition", attempt);
    return attempt;
  }

  /** A final transition: after this the attempt is history, so it stops being "live". */
  private settleState(attempt: Attempt, state: AttemptState, patch: Partial<Attempt> & { note?: string } = {}): void {
    if (isFinal(attempt.state)) return; // never overwrite a recorded ending
    this.transition(attempt, state, patch);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────

function isFinal(state: AttemptState): boolean {
  return FINAL_ATTEMPT_STATES.includes(state);
}

/** The state a refusal from the signer leaves the attempt in. */
function refusalState(err: unknown): AttemptState {
  if (!(err instanceof SignRefused)) return "failed";
  if (err.code === "denied") return "denied";
  if (err.code === "expired") return "expired";
  if (err.code === "abandoned") return "abandoned";
  return "failed"; // policy, invalid, unavailable: nothing was signed, nothing was paid
}

/** Which check refused, for the refusals that are not the owner's own decision. */
function refusalOf(err: unknown): Attempt["refusal"] {
  if (!(err instanceof SignRefused)) return undefined;
  return err.code === "policy" || err.code === "invalid" || err.code === "unavailable" || err.code === "approval_page"
    ? err.code
    : undefined;
}

function firstSupported(challenge: Challenge): { terms: PaymentTerms; requirement: PaymentRequirements } | undefined {
  for (const accept of challenge.accepts) {
    const judged = termsFor(accept, challenge.version);
    if (judged.supported) return judged;
  }
  return undefined;
}

/** Where the credential goes on the wire, which differs between the two protocol versions. */
function credentialHeader(
  version: 1 | 2,
  requirement: PaymentRequirements,
  payload: { signature: string; authorization: Record<string, unknown> },
): Record<string, string> {
  if (version === 1) {
    const v1 = { x402Version: 1, scheme: requirement.scheme, network: requirement.network, payload };
    return { "X-PAYMENT": Buffer.from(JSON.stringify(v1), "utf8").toString("base64") };
  }
  return {
    "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: requirement,
      payload: payload as unknown as Record<string, unknown>,
    }),
  };
}

/** The seller's report of what the facilitator did, when it sent one. */
function readSettlement(res: Response, version: 1 | 2): SettleResponse | undefined {
  const header =
    res.headers.get(version === 1 ? "x-payment-response" : "payment-response") ??
    res.headers.get(version === 1 ? "payment-response" : "x-payment-response");
  if (!header) return undefined;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
