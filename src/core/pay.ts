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
import { isAddress, txUrl } from "./chain.js";
import { getQuote } from "./quote.js";
import { MAX_CHALLENGE_BYTES, NotPaidEndpointError, parseChallenge, readBody, readCapped, sameTerms, termsFor, type Challenge } from "./x402.js";
import { untrustedText } from "./text.js";
import { checkSettlement, type ChainCheck } from "./settlement.js";
import { Records } from "./records.js";
import { SignRefused, type Signer } from "./signer/types.js";
import { evaluatePolicy, type Policy } from "./policy.js";
import { withFileLock } from "./lock.js";
import { join } from "node:path";
import type { AbandonCause, Attempt, AttemptState, PaymentTerms, Quote, Receipt, ServiceOutcome } from "./types.js";
import { FINAL_ATTEMPT_STATES } from "./types.js";

/** How much of the service's answer is kept on the attempt and the receipt. */
export const SERVICE_BODY_LIMIT = 4_000;
/** The seller settles the payment inside this request, so it may take a while. */
const SUBMIT_TIMEOUT_MS = 120_000;
/** How much of a paid answer is read, kept or not, to see it end: 10 MB. */
const PAID_ANSWER_DRAIN = 10_000_000;
/** Default ceiling for waitForAttempt: longer than the wallet's own approval timeout. */
const DEFAULT_WAIT_MS = 140_000;

export interface PaymentEngineOptions {
  records: Records;
  /** The agent-side copy of the owner's policy. The wallet applies the owner's copy again. */
  policy: Policy;
  signer: Signer;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
  /** How long each exchange with the seller may take, answer included. Shortened in tests; two minutes otherwise. */
  timeoutMs?: number;
  /** The Base Sepolia RPC a settlement is read through. Tests point it at a fake chain; settlementRpc() otherwise. */
  rpcUrl?: string;
  /** The clock the cap reservation reads. Tests move it; Date.now otherwise. */
  now?: () => number;
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
  private readonly timeoutMs: number;
  private readonly rpcUrl?: string;
  private readonly now: () => number;
  /** Attempts this process is running, so a caller sees the live state without a file read. */
  private readonly live = new Map<string, Attempt>();

  constructor(options: PaymentEngineOptions) {
    this.records = options.records;
    this.policy = options.policy;
    this.signer = options.signer;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;
    this.rpcUrl = options.rpcUrl;
    this.now = options.now ?? Date.now;
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

  /** Is this attempt's cap reservation still running? */
  private reservationOpen(attempt: Attempt): boolean {
    const until = attempt.reservedUntil ? Date.parse(attempt.reservedUntil) : NaN;
    return Number.isFinite(until) && this.now() < until;
  }

  /**
   * Check the cap for this attempt and, if it allows it, reserve (or renew) the amount until the signer's approval
   * window and a minute have passed. Call it holding the cap lock.
   */
  private reserve(attempt: Attempt, quote: Quote): { allowed: boolean; reason?: string } {
    const now = this.now();
    const judged = evaluatePolicy(this.policy, {
      domain: hostOf(quote.url),
      amountDecimal: quote.terms.amountDecimal,
      asset: quote.terms.asset,
      spentTodayDecimal: this.records.spentToday(quote.terms.asset, new Date(now), { exclude: attempt.id }),
    });
    if (judged.allowed) {
      attempt.reservedAt = new Date(now).toISOString();
      attempt.reservedUntil = new Date(now + (this.signer.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS) + RESERVATION_GRACE_MS).toISOString();
      this.records.saveAttempt(attempt);
    }
    return judged;
  }

  /** Read the chain again for a paid attempt whose settlement is not yet checked: see recheckChain below. */
  async recheckChain(id: string): Promise<Attempt | undefined> {
    return recheckChain(this.records, id, this.rpcUrl);
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

    // Reserve the amount against the daily cap before anyone is asked. Two `pay` processes (or MCP servers) asking at
    // once would each pass a cap check that does not see the other, so the check and the reservation happen together
    // under a lock shared by every process on this computer, held only for that moment. The reservation counts until
    // the owner signs (then the signed states count it) or the attempt ends unsigned (then it is released).
    let verdict: { allowed: boolean; reason?: string };
    try {
      verdict = await withFileLock(join(this.records.dir, CAP_LOCK), () => this.reserve(attempt, quote));
    } catch (err) {
      const reopened = this.reopenQuote(quote.id);
      this.settleState(attempt, "failed", {
        refusal: "unavailable",
        reason: `the daily cap could not be checked (${message(err)}). Nothing was signed${reopened ? `, and quote ${quote.id} can still be paid` : ""}`,
      });
      return;
    }
    if (!verdict.allowed) {
      this.settleState(attempt, "failed", {
        refusal: "policy",
        reason: `the local spend policy refuses this payment: ${verdict.reason ?? "no reason given"}`,
      });
      return;
    }
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
          // Right before the owner is asked: a reservation that lapsed while the signer started (a slow page start, a
          // slow wallet) is checked against the cap again and renewed, or the payment stops with nobody asked.
          beforeAsk: async () => {
            const renewed = await withFileLock(join(this.records.dir, CAP_LOCK), () =>
              this.reservationOpen(attempt) ? { allowed: true } : this.reserve(attempt, quote),
            );
            if (!renewed.allowed) {
              throw new SignRefused("policy", `the local spend policy refuses this payment: ${renewed.reason ?? "no reason given"}`);
            }
          },
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

    // What the owner signed, recorded before it leaves: the nonce ties a transaction on chain to this payment, and
    // validBefore is when the authorization stops being able to move money (the daily cap reads it).
    const signedNonce = authorizationNonce(signed.payload);
    const validBefore = authorizationValidBefore(signed.payload);
    // The signature is accepted under the cap lock: if the reservation lapsed while the owner decided, the cap is
    // checked again first, and a payment it now refuses is never sent (the signed authorization stays here, unused).
    // Otherwise the attempt becomes `approved` in the same step, and its signed state counts it from then on.
    let accepted: { allowed: boolean; reason?: string };
    try {
      accepted = await withFileLock(join(this.records.dir, CAP_LOCK), () => {
        const judged = this.reservationOpen(attempt) ? { allowed: true } : this.reserve(attempt, quote);
        if (judged.allowed) {
          this.transition(attempt, "approved", {
            payer: signed.signer,
            ...(signedNonce ? { authorizationNonce: signedNonce } : {}),
            ...(validBefore ? { authorizationValidBefore: validBefore } : {}),
          });
        }
        return judged;
      });
    } catch (err) {
      accepted = { allowed: false, reason: `the daily cap could not be checked (${message(err)})` };
    }
    if (!accepted.allowed) {
      this.settleState(attempt, "failed", {
        payer: signed.signer,
        refusal: "policy",
        reason: `the owner signed, but the payment was not sent: ${accepted.reason ?? "the local spend policy refuses it"}. Nothing was submitted`,
      });
      return;
    }
    this.transition(attempt, "submitting");

    // 3. Replay the request with the credential. From here on the credential has left this
    //    machine, so every failure is a known-unknown, not a clean failure.
    const header = credentialHeader(challenge.version, offer.requirement, signed.payload);
    let res: Response;
    const deadline = Date.now() + this.timeoutMs;
    try {
      res = await this.fetchImpl(quote.url, {
        method: "GET",
        // The credential is on this request, so it goes to the seller this quote named and nowhere else:
        // a redirect would carry it to a host the operator never chose.
        redirect: "error",
        headers: { ...header, accept: "application/json, */*" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // A redirect is refused rather than followed, so this is also where a seller that answers with one lands:
      // the credential may never have left. Say that, and stay `uncertain`, because nothing here can tell.
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        reason: `the payment could not be completed with this service: ${message(err)}`,
      });
      return;
    }

    // Read no further than what is kept: a seller's answer is bounded before it is in memory, not after, and under
    // the same deadline as the request. An answer that drips forever or breaks off is cut off: the settlement header,
    // which has already arrived, still decides the payment, but whether the service delivered is then unknown.
    // Only an answer seen to its end counts as delivered. A longer answer than is kept is read on, without keeping it,
    // up to PAID_ANSWER_DRAIN bytes; one that is still arriving past that, or past the deadline, or that breaks off,
    // is not a delivery.
    const read = await readBody(res, SERVICE_BODY_LIMIT * 4, deadline - Date.now(), PAID_ANSWER_DRAIN);
    const delivered = read.end === "eof";
    const body = read.text.slice(0, SERVICE_BODY_LIMIT);
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
      // The reason is the service's own text (it relays the facilitator's answer). It is kept apart, in serviceReason,
      // and the client's sentence says only what the client knows.
      const said = settlement.errorReason ?? settlement.errorMessage;
      this.settleState(attempt, "failed", {
        payer: signed.signer,
        serviceStatus: res.status,
        serviceBody: body,
        reason: said ? "the service reported that the payment did not settle, and gave a reason of its own" : "the service reported that the payment did not settle, and gave no reason",
        ...(said ? { serviceReason: said } : {}),
      });
      return;
    }

    // 4. The seller reports the money moved. The chain is read to check that the transaction it names is this payment
    //    (settlement.ts); whether the service then did its job is a separate fact.
    const nonce = authorizationNonce(signed.payload);
    const check = await checkSettlement(
      {
        transaction: settlement.transaction,
        payer: signed.signer,
        recipient: quote.terms.recipient,
        amountAtomic: quote.terms.amountAtomic,
        nonce,
      },
      { rpcUrl: this.rpcUrl },
    );
    if (check.chain === "mismatch") {
      // The chain shows that transaction, and it is not this payment. Not paid and not unpaid: unknown, never retried.
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        ...(isTxHash(settlement.transaction) ? { transaction: settlement.transaction } : {}),
        serviceStatus: res.status,
        serviceBody: body,
        authorizationNonce: nonce,
        chain: "mismatch",
        chainReason: check.reason,
        reason: `the service reported the payment settled, but the chain does not confirm it (${check.reason}), so whether it was paid is unknown`,
      });
      return;
    }
    // A 2xx whose body never arrived in full is not a delivery: it ends as paid but not delivered, outcome unknown.
    const ok = res.status >= 200 && res.status < 300 && delivered;
    const outcome: ServiceOutcome = !delivered ? "unknown" : ok ? "ok" : "failed";
    const receipt = this.writeReceipt({
      check,
      attempt,
      quote,
      settlement,
      // The address that signed is this client's own fact; the seller's `payer` is only its claim.
      payer: signed.signer,
      serviceOutcome: outcome,
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
      authorizationNonce: nonce,
      chain: check.chain,
      ...(check.reason ? { chainReason: check.reason } : {}),
      reason: ok
        ? undefined
        : !delivered
          ? "the service reported the payment settled, but its answer did not arrive in full, so whether it delivered is unknown"
          : `the service reported the payment settled but answered ${res.status}`,
    });
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────

  /**
   * Read the seller's current challenge. Mirrors x402.detect(), but through this engine's
   * fetch so a test (or a future proxy) can stand in for the network.
   */
  private async challengeFor(url: string): Promise<Challenge> {
    const deadline = Date.now() + this.timeoutMs;
    const res = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json, */*" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readCapped(res, MAX_CHALLENGE_BYTES, deadline - Date.now(), url);
    if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
    const header = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
    return parseChallenge({ paymentRequiredHeader: header, body });
  }

  private writeReceipt(input: {
    check: ChainCheck;
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
    // The network is the one the client checked in the terms, not the one the seller names in its report.
    const network = attempt.terms.network;
    // A facilitator that has a hash gives one; one that has only accepted the transfer gives something else. Only a
    // well-formed transaction hash is kept as the transaction: anything else the seller put there is not repeated as
    // a fact, and stays only in `settlement`, the seller's report as it was received.
    const reported = settlement.transaction ?? "";
    const kind = isTxHash(reported) ? "hash" : "pending";
    const transaction = kind === "hash" ? reported : "";
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
      chain: input.check.chain,
      ...(input.check.reason ? { chainReason: input.check.reason } : {}),
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
  let decoded: SettleResponse;
  try {
    decoded = decodePaymentResponseHeader(header);
  } catch {
    return undefined;
  }
  // The header is the service's claim about what its facilitator did; settlement.ts reads the chain to check it.
  // Its strings are kept, displayed and repeated to an agent, so each is one bounded line.
  const text = (value: unknown, max: number) => (value === undefined || value === null ? undefined : untrustedText(value, max));
  return {
    ...decoded,
    success: decoded.success === true,
    transaction: text(decoded.transaction, 100) ?? "",
    network: text(decoded.network, 60) as SettleResponse["network"],
    payer: text(decoded.payer, 100),
    errorReason: text(decoded.errorReason, 200),
    errorMessage: text(decoded.errorMessage, 200),
  } as SettleResponse;
}

/**
 * Read the chain again for a paid attempt whose settlement is not yet checked (`chain` "unchecked", or a record from
 * before the chain was read). Verified: recorded on the attempt and its receipt. Mismatch: the attempt becomes
 * `uncertain`, since the transaction the seller named is not this payment. Still unchecked: the new reason is recorded.
 * Any other attempt is returned as it is. Reads records and the chain only; never starts or repeats a payment.
 */
export async function recheckChain(records: Records, id: string, rpcUrl?: string): Promise<Attempt | undefined> {
  const attempt = records.getAttempt(id);
  if (!attempt) return undefined;
  if (attempt.state !== "settled" && attempt.state !== "paid_service_failed") return attempt;
  if (attempt.chain === "verified" || attempt.chain === "mismatch") return attempt;
  const check = await checkSettlement(
    {
      transaction: attempt.transaction,
      payer: attempt.payer ?? "",
      recipient: attempt.terms.recipient,
      amountAtomic: attempt.terms.amountAtomic,
      nonce: attempt.authorizationNonce,
    },
    { rpcUrl },
  );
  const receipt = attempt.receiptId ? records.getReceipt(attempt.receiptId) : undefined;
  if (receipt) {
    const { chainReason: _old, ...rest } = receipt;
    records.saveReceipt({ ...rest, chain: check.chain, ...(check.reason ? { chainReason: check.reason } : {}) });
  }
  const { chainReason: _was, ...kept } = attempt;
  const updated: Attempt = { ...kept, chain: check.chain, ...(check.reason ? { chainReason: check.reason } : {}), updatedAt: new Date().toISOString() };
  if (check.chain === "mismatch") {
    updated.state = "uncertain";
    updated.reason = `the service reported the payment settled, but the chain does not confirm it (${check.reason}), so whether it was paid is unknown`;
    updated.history = [...attempt.history, { at: updated.updatedAt, state: "uncertain", note: "the chain does not confirm the settlement the service reported" }];
  }
  records.saveAttempt(updated);
  return updated;
}

/** How long a reservation outlives the signer's approval window: room for the signature to come back. */
const RESERVATION_GRACE_MS = 60_000;

/** How long a reservation counts for a signer that does not say how long it waits for the owner. */
const DEFAULT_APPROVAL_WINDOW_MS = 10 * 60_000;

/** The lock file, in the records directory, under which an attempt checks the daily cap and reserves its amount. */
const CAP_LOCK = "cap.lock";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The EIP-3009 nonce in a signed payload, when it is a bytes32. */
function authorizationNonce(payload: { authorization: Record<string, unknown> }): string | undefined {
  const nonce = payload.authorization?.nonce;
  return typeof nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(nonce) ? nonce : undefined;
}

/** The EIP-3009 validBefore in a signed payload (unix seconds), as an ISO time, when it is a plain number. */
function authorizationValidBefore(payload: { authorization: Record<string, unknown> }): string | undefined {
  const raw = payload.authorization?.validBefore;
  const seconds = typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** An EVM transaction hash: 0x and 64 hex digits. The only shape a transaction is repeated in. */
export function isTxHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * The transaction of a receipt or an attempt as it may be shown: the hash and its explorer link when it is a well-formed
 * hash, nothing otherwise. Checked when shown as well as when written, because records written by an earlier version
 * kept whatever the seller sent, and the link is rebuilt from the checked network rather than taken from the record.
 */
export function shownTransaction(transaction: string | undefined, network: string): { hash?: string; url?: string } {
  return isTxHash(transaction) ? { hash: transaction, url: txUrl(network, transaction) } : {};
}

/** A payer address as it may be shown: 0x and 40 hex digits, or nothing. */
export function shownPayer(payer: string | undefined): string | undefined {
  return typeof payer === "string" && isAddress(payer) ? payer : undefined;
}

/**
 * An attempt as it may be printed as JSON: the transaction, its link and the payer checked as for a receipt, and the
 * seller's own text (its answer and its reason) moved under `untrusted_seller_data`, together with any transaction,
 * link or payer the record holds that did not pass the check (a record from an earlier version may).
 */
export function shownAttempt(attempt: Attempt): Omit<Attempt, "serviceBody" | "serviceReason"> & {
  untrusted_seller_data?: { serviceBody?: string; serviceReason?: string; transaction?: string; transactionUrl?: string; payer?: string };
} {
  const { serviceBody, serviceReason, transaction, transactionUrl, payer, ...rest } = attempt;
  const tx = shownTransaction(transaction, attempt.terms.network);
  const checkedPayer = shownPayer(payer);
  const untrusted = {
    ...(serviceBody !== undefined ? { serviceBody } : {}),
    ...(serviceReason !== undefined ? { serviceReason } : {}),
    ...(transaction && !tx.hash ? { transaction } : {}),
    ...(transactionUrl && transactionUrl !== tx.url ? { transactionUrl } : {}),
    ...(payer && !checkedPayer ? { payer } : {}),
  };
  return {
    ...rest,
    ...(tx.hash ? { transaction: tx.hash, transactionUrl: tx.url } : {}),
    ...(checkedPayer ? { payer: checkedPayer } : {}),
    ...(Object.keys(untrusted).length > 0 ? { untrusted_seller_data: untrusted } : {}),
  };
}

/**
 * A receipt as it may be shown or printed as JSON: the transaction, its link and the payer checked as above (the link
 * rebuilt from the checked network), and the network the client checked. The seller's settlement report, as it was
 * received, is kept under `untrusted_seller_report`, so nothing a seller wrote sits in a field that reads as checked.
 */
export function shownReceipt(receipt: Receipt): Omit<Receipt, "settlement"> & {
  settlement: { success: boolean; transaction: string; payer: string; network: string };
  untrusted_seller_report: Receipt["settlement"];
} {
  const { settlement, ...rest } = receipt;
  const tx = shownTransaction(receipt.transaction, receipt.terms.network);
  const payer = shownPayer(receipt.payer) ?? "";
  return {
    ...rest,
    transaction: tx.hash ?? "",
    transactionKind: tx.hash ? "hash" : "pending",
    transactionUrl: tx.url ?? "",
    payer,
    network: receipt.terms.network,
    settlement: { success: settlement?.success === true, transaction: tx.hash ?? "", payer, network: receipt.terms.network },
    untrusted_seller_report: settlement,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
