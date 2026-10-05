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
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { isAddressOn, isTransactionId, networkFor, shortLabel, txUrl, type NetworkInfo } from "./chain.js";
import { getQuote } from "./quote.js";
import { MAX_CHALLENGE_BYTES, NotPaidEndpointError, readBody, readCapped, readSellerChallenge, sameTerms, type SellerChallenge } from "./x402.js";
import { readMppReceipt } from "./mpp.js";
import { untrustedText } from "./text.js";
import type { ChainCheck } from "./settlement.js";
import { Records } from "./records.js";
import { SignRefused, type SignResult, type Signer } from "./signer/types.js";
import { evaluatePolicy, type Policy } from "./policy.js";
import { processRunning, thisProcess, withFileLock } from "./lock.js";
import { firstPayable, railFor } from "./rails/index.js";
import type { ChainReadOptions, Offer, PaymentFacts, PushRail, RailAdapter, X402Rail } from "./rails/types.js";
import { join } from "node:path";
import type { AbandonCause, Attempt, AttemptState, Quote, Receipt, ServiceOutcome } from "./types.js";
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
  /** The RPC every chain read goes through, whatever the chain. Tests point it at a fake chain; chainRpc() otherwise. */
  rpcUrl?: string;
  /** The RPC of one chain, when tests run several fake ones; rpcUrl, then chainRpc(), otherwise. */
  rpcUrlFor?: (network: NetworkInfo) => string | undefined;
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
  private readonly chainRead: ChainReadOptions;
  private readonly now: () => number;
  /** Attempts this process is running, so a caller sees the live state without a file read. */
  private readonly live = new Map<string, Attempt>();

  constructor(options: PaymentEngineOptions) {
    this.records = options.records;
    this.policy = options.policy;
    this.signer = options.signer;
    this.fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;
    this.chainRead = chainReadOptions(options.rpcUrl, options.rpcUrlFor);
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
      runner: thisProcess(),
      history: [{ at, state: "awaiting_approval" }],
    };
    // Claim the quote before any await, and across processes: another `pay` sharing these records may have
    // read the same open quote. One claim file per quote, created only if none exists, decides which attempt it starts;
    // the other is told about that attempt instead.
    const holder = this.records.claimQuote(quote.id, attempt.id);
    if (holder !== undefined) throw new QuoteUsedError(quote.id, holder ? this.claimedBy(holder) : undefined);
    this.records.saveQuote({ ...quote, status: "used" });
    this.records.saveAttempt(attempt);
    this.live.set(attempt.id, attempt);
    this.events.emit("transition", attempt);

    void this.run(attempt, quote).catch((err) => {
      // The background run handles its own failures; this is the last net. Once the owner approved (the credential may
      // have left, or the wallet may have sent), an error is not "nothing was paid": the chain decides.
      const sent = attempt.state === "approved" || attempt.state === "submitting";
      this.settleState(attempt, sent ? "uncertain" : "failed", {
        reason: sent ? `${message(err)}, after the owner approved, so whether it was paid is unknown` : message(err),
      });
    });
    return attempt;
  }

  /**
   * The attempt that holds a quote's claim. Another process writes it right after claiming, so it is waited for briefly
   * (the claim and the record are microseconds apart); a process that stopped in between leaves no attempt to name.
   */
  private claimedBy(id: string): Attempt | undefined {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let waited = 0; ; waited += CLAIM_POLL_MS) {
      const found = this.getAttempt(id);
      if (found || waited >= CLAIM_WAIT_MS) return found;
      Atomics.wait(pause, 0, 0, CLAIM_POLL_MS);
    }
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
    const updated = await recheckChain(this.records, id, this.chainRead);
    // An attempt this process ran and that has ended is read from the records from now on: what the chain decided is the
    // newer word. One still running keeps its own copy.
    const live = this.live.get(id);
    if (updated && live && isFinal(live.state)) this.live.set(id, updated);
    return updated;
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
        reason: attempt.paymentMemo && !attempt.transaction
          ? `${reason} after the owner's wallet was asked to send the payment, so whether it was sent is unknown`
          : `${reason} after the owner approved, while the payment was being submitted`,
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
    let challenge: SellerChallenge;
    try {
      challenge = await this.challengeFor(quote.url);
    } catch (err) {
      this.settleState(attempt, "failed", { reason: message(err) });
      return;
    }

    const offer = firstPayable(challenge);
    const rail = offer ? railFor(offer.terms.network) : undefined;
    if (!offer || !rail || !sameTerms(quote.terms, offer.terms)) {
      this.markQuote(quote.id, "stale");
      this.settleState(attempt, "failed", { reason: "terms changed, quote again" });
      return;
    }

    // Whoever was waiting may have stopped while the seller was being asked; then nobody
    // is left to show the owner a link, so the owner is not asked.
    if (isFinal(attempt.state)) return;

    // A push payment is found on chain by its memo, which the seller's challenge decides. A seller that hands out the
    // same challenge again would make a second transfer indistinguishable from the first, so a memo an earlier attempt
    // already used is refused before anyone is asked (and again, under the cap lock, right before the wallet is asked).
    if (rail.flow === "push") {
      const reused = this.records.attemptsWithMemo(rail.paymentMemo(offer), attempt.id)[0];
      if (reused) {
        this.settleState(attempt, "failed", { refusal: "invalid", reason: reusedChallenge(reused.id) });
        return;
      }
    }

    // Reserve the amount against the daily cap before anyone is asked. Two `pay` processes asking at
    // once would each pass a cap check that does not see the other, so the check and the reservation happen together
    // under a lock shared by every process on this computer, held only for that moment. The reservation counts until
    // the owner signs (then the signed states count it) or the attempt ends unsigned (then it is released).
    let verdict: { allowed: boolean; reason?: string };
    try {
      verdict = await withFileLock(join(this.records.dir, CAP_LOCK), () => this.reserve(attempt, quote));
    } catch (err) {
      const reopened = this.reopenQuote(quote.id, attempt.id);
      this.settleState(attempt, "failed", {
        refusal: "cap_check",
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
    let signed: SignResult;
    try {
      signed = await this.signer.sign(
        rail.signRequest(offer, challenge.x402?.version ?? 2, {
          target: quote.url,
          serviceId: quote.serviceId,
          serviceName: quote.serviceName,
          description: quote.description,
          quoteId: quote.id,
          attemptId: attempt.id,
        }),
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
          // A rail whose wallet sends the payment itself (Tempo): from the moment the wallet is asked, money may move
          // without a reply reaching here. So the cap is checked (and the reservation renewed) first, and the attempt
          // becomes `approved`, which counts toward the cap and ends `uncertain`, never unpaid, if nothing comes back.
          beforeWalletSends: async (intent) => {
            if (rail.flow !== "push") throw new SignRefused("invalid", "this payment's wallet signs; it does not send");
            if (!intent.memo || intent.memo.toLowerCase() !== rail.paymentMemo(offer).toLowerCase()) {
              throw new SignRefused("invalid", "the wallet was to be asked for another memo than this payment's, so it was not asked");
            }
            // The chain's head before the wallet is asked: the owner's transfer is in a later block, and a search for it
            // never takes an older transfer for it. Without it the wallet is not asked: the payment could not be found.
            let head: string;
            try {
              head = await rail.headBlock(this.chainRead);
            } catch (err) {
              throw new SignRefused("chain", `the ${shortLabel({ label: offer.terms.networkLabel })} RPC could not be read (${message(err)}), so your wallet was not asked to send this payment; nothing was sent`);
            }
            const judged = await withFileLock(join(this.records.dir, CAP_LOCK), () => {
              if (isFinal(attempt.state)) return { allowed: false, final: true };
              if (attempt.state === "approved") return { allowed: attempt.payer === intent.payer && attempt.paymentMemo === intent.memo };
              const reused = this.records.attemptsWithMemo(intent.memo!, attempt.id)[0];
              if (reused) return { allowed: false, reused: reusedChallenge(reused.id) };
              const checked = this.reservationOpen(attempt) ? { allowed: true } : this.reserve(attempt, quote);
              if (checked.allowed) {
                this.transition(attempt, "approved", {
                  payer: intent.payer,
                  paymentMemo: intent.memo,
                  searchFromBlock: head,
                  note: "the owner's wallet was asked to send the payment",
                });
              }
              return checked;
            });
            if ("final" in judged) throw new SignRefused("abandoned", "nobody is waiting for this payment any more; ask the agent for a new approval link");
            if ("reused" in judged && judged.reused) throw new SignRefused("invalid", judged.reused);
            if (!judged.allowed) {
              throw new SignRefused("policy", `the local spend policy refuses this payment: ${"reason" in judged && judged.reason ? judged.reason : "no reason given"}`);
            }
          },
        },
      );
    } catch (err) {
      const refusal = refusalOf(err);
      // Once a wallet that sends was asked to (the attempt is `approved`), nothing the signer says ends it as unpaid: a
      // rejection reported after that is the approval page's word, not the chain's, and the wallet may have sent all the
      // same. It is unknown, and `superstables status` looks for the transfer on chain.
      const sentMaybe = attempt.state === "approved";
      const state = sentMaybe ? "uncertain" : refusalState(err);
      let reason = sentMaybe && !(err instanceof SignRefused && err.code === "unknown")
        ? `${message(err)}, after the owner's wallet was asked to send the payment, so whether it was sent is unknown`
        : message(err);
      // The signer could not reach the owner at all: no page, no wallet request, nothing to
      // sign. Spending the quote on that would only send the agent off to quote again for a
      // fault on this machine, so the quote goes back to being payable.
      if (!asked && (refusal === "approval_page" || refusal === "unavailable") && this.reopenQuote(quote.id, attempt.id)) {
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

    if (signed.kind !== rail.signKind) {
      this.settleState(attempt, rail.flow === "push" ? "uncertain" : "failed", {
        reason: `the wallet answered a ${untrustedText(signed.kind, 30)} request, not the ${rail.signKind} this payment asked for`,
      });
      return;
    }
    if (rail.flow === "push") return this.submitPush(attempt, quote, offer, rail, signed, started);
    return this.submitX402(attempt, quote, offer, rail, challenge, signed, started);
  }

  /**
   * x402: the owner's wallet signed, nothing has moved. The signature is sent to the seller once; the seller's
   * facilitator settles it and names a transaction, which the chain is read for.
   */
  private async submitX402(attempt: Attempt, quote: Quote, offer: Offer, rail: X402Rail, challenge: SellerChallenge, signed: SignResult, started: number): Promise<void> {
    const x402 = challenge.x402;
    if (!x402) {
      this.settleState(attempt, "failed", { reason: "the seller's challenge has no x402 offer to pay" });
      return;
    }
    // What the owner signed, recorded before it leaves: the nonce (EVM) or signature (Solana) ties a transaction on chain
    // to this payment, and validBefore is when the authorization stops being able to move money (the daily cap reads it).
    const facts = rail.signedFacts(signed);
    // The signature is accepted under the cap lock: if the reservation lapsed while the owner decided, the cap is
    // checked again first, and a payment it now refuses is never sent (the signed authorization stays here, unused).
    // Otherwise the attempt becomes `approved` in the same step, and its signed state counts it from then on.
    // Nobody may have been waiting for it any more by the time the lock was free (the caller stopped meanwhile, and was
    // told nothing was submitted): an attempt that has ended is never taken up again, here or below.
    let accepted: { allowed: boolean; reason?: string; final?: boolean; refusal?: "policy" | "invalid" };
    try {
      accepted = await withFileLock(join(this.records.dir, CAP_LOCK), () => {
        if (isFinal(attempt.state)) return { allowed: false, final: true };
        // The same owner's signature is the same transaction: a second attempt for it could only ever be paid by the
        // first one's transfer. Refused, under the lock every attempt records its signature under.
        const twin = facts.ownerSignature ? this.records.attemptsWithOwnerSignature(facts.ownerSignature, attempt.id)[0] : undefined;
        if (twin) {
          return {
            allowed: false,
            refusal: "invalid" as const,
            reason: `the owner's wallet signed a transaction identical to one an earlier payment signed (attempt ${twin.id}), and the chain could not tell the two apart`,
          };
        }
        const judged = this.reservationOpen(attempt) ? { allowed: true } : this.reserve(attempt, quote);
        if (judged.allowed) {
          this.transition(attempt, "approved", { payer: signed.signer, ...facts });
        }
        return judged;
      });
    } catch (err) {
      accepted = { allowed: false, reason: `the daily cap could not be checked (${message(err)})` };
    }
    if (accepted.final) return;
    if (!accepted.allowed) {
      this.settleState(attempt, "failed", {
        payer: signed.signer,
        refusal: accepted.refusal ?? "policy",
        reason: `the owner signed, but the payment was not sent: ${accepted.reason ?? "the local spend policy refuses it"}. Nothing was submitted`,
      });
      return;
    }
    this.transition(attempt, "submitting");
    // Checked again right before the credential leaves: only an attempt this run still carries is ever submitted.
    if (attempt.state !== "submitting") return;

    // 3. Replay the request with the credential. From here on the credential has left this
    //    machine, so every failure is a known-unknown, not a clean failure.
    const header = rail.credentialHeaders(offer, signed, x402);
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
    const settlement = readSettlement(res, x402.version);

    // From here the credential has left this machine, and a seller's "no" is only the seller's word: its facilitator may
    // have settled the payment before it answered, or settle it after. So no answer of the seller's ends the attempt as
    // unpaid. It is uncertain, it keeps its place against the daily cap, and `superstables status` asks the chain (by
    // the nonce or the signature the owner signed) until the chain shows the payment, or shows it can no longer happen.
    if (!settlement) {
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        serviceStatus: res.status,
        serviceBody: body,
        reason:
          res.status === 402
            ? "the service asked for payment again after the payment was sent to it, so whether it settled is unknown until the chain shows it"
            : `the service answered ${res.status} without a payment receipt, so whether the payment settled is unknown`,
      });
      return;
    }

    // A failure that names a transaction is never "nothing was paid": the chain says whether it is this payment.
    const failedWithTx = !settlement.success && rail.isTransaction(settlement.transaction);
    if (!settlement.success && !failedWithTx) {
      // The reason is the service's own text (it relays the facilitator's answer). It is kept apart, in serviceReason,
      // and the client's sentence says only what the client knows.
      const said = settlement.errorReason ?? settlement.errorMessage;
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        serviceStatus: res.status,
        serviceBody: body,
        reason: `the service reported that the payment did not settle${said ? ", and gave a reason of its own" : ""}, after the payment was sent to it, so whether it settled is unknown until the chain shows it`,
        ...(said ? { serviceReason: said } : {}),
      });
      return;
    }

    // 4. The seller reports the money moved. The chain is read to check that the transaction it names is this payment
    //    (the rail's own check); whether the service then did its job is a separate fact.
    const check = attributedCheck(
      this.records,
      attempt,
      rail,
      settlement.transaction,
      await rail.checkPayment({ ...paymentFacts(attempt, signed.signer), transaction: settlement.transaction }, this.chainRead),
    );
    if (failedWithTx && check.chain !== "verified") {
      // The service says the payment did not settle, but names a transaction the chain does not confirm as this payment
      // (yet): not paid and not unpaid. Unknown, never retried.
      const said = settlement.errorReason ?? settlement.errorMessage;
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        transaction: settlement.transaction,
        serviceStatus: res.status,
        serviceBody: body,
        ...facts,
        chain: check.chain,
        chainReason: check.reason,
        reason: `the service reported that the payment did not settle, but named transaction ${settlement.transaction}, and the chain does not confirm it is this payment (${check.reason}), so whether it was paid is unknown`,
        ...(said ? { serviceReason: said } : {}),
      });
      return;
    }
    // From here the money moved: the service says so, or it said not but the chain shows this payment's transaction.
    if (check.chain === "mismatch") {
      // The chain shows that transaction, and it is not this payment. Not paid and not unpaid: unknown, never retried.
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        ...(rail.isTransaction(settlement.transaction) ? { transaction: settlement.transaction } : {}),
        serviceStatus: res.status,
        serviceBody: body,
        ...facts,
        chain: "mismatch",
        chainReason: check.reason,
        reason: `the service reported the payment settled, but the chain does not confirm it (${check.reason}), so whether it was paid is unknown`,
      });
      return;
    }
    // A 2xx whose body never arrived in full is not a delivery: it ends as paid but not delivered, outcome unknown.
    const ok = res.status >= 200 && res.status < 300 && delivered;
    const outcome: ServiceOutcome = !delivered ? "unknown" : ok ? "ok" : "failed";
    const receipt = await this.writeReceipt({
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
    if (!receipt) {
      this.settleState(attempt, "uncertain", {
        payer: signed.signer,
        ...(rail.isTransaction(settlement.transaction) ? { transaction: settlement.transaction } : {}),
        serviceStatus: res.status,
        serviceBody: body,
        ...facts,
        chain: "unchecked",
        reason: UNRECORDED_ANSWER,
      });
      return;
    }
    this.settleState(attempt, ok ? "settled" : "paid_service_failed", {
      payer: receipt.payer,
      transaction: receipt.transaction,
      transactionUrl: receipt.transactionUrl,
      serviceStatus: res.status,
      serviceBody: body,
      receiptId: receipt.id,
      ...facts,
      chain: check.chain,
      ...(check.reason ? { chainReason: check.reason } : {}),
      reason: ok
        ? undefined
        : !delivered
          ? "the service reported the payment settled, but its answer did not arrive in full, so whether it delivered is unknown"
          : `the service reported the payment settled but answered ${res.status}`,
    });
  }

  /**
   * Push (Tempo): the owner's wallet has sent the payment itself and reported its transaction. The attempt has been
   * `approved` since the wallet was asked. The chain is read first: only the owner's own transaction showing exactly this
   * transfer, with this payment's memo, counts. Then the seller is called once with a credential naming it. A
   * transaction the chain does not show (yet), or shows as something else, ends `uncertain` with the seller not called.
   */
  private async submitPush(attempt: Attempt, quote: Quote, offer: Offer, rail: PushRail, signed: SignResult, started: number): Promise<void> {
    if (signed.kind !== "tempo-transfer") return;
    // Compared with what was recorded when the wallet was asked, before anything is overwritten.
    const another = attempt.paymentMemo !== signed.memo || !isAddressOn(offer.terms.network, signed.signer) || attempt.payer !== signed.signer;
    // The transaction is recorded before anything else: whatever happens next, the chain can be read for it. The payer
    // and memo stay those the wallet was asked with.
    this.transition(attempt, "submitting", { transaction: signed.hash });
    if (another) {
      this.settleState(attempt, "uncertain", {
        reason: "the wallet reported a transaction for another payment than the one it was asked to send, so whether this one was paid is unknown; the service was not called",
      });
      return;
    }

    const check = attributedCheck(
      this.records,
      attempt,
      rail,
      signed.hash,
      await this.waitForChain(rail, { ...paymentFacts(attempt, signed.signer), transaction: signed.hash }, rail.confirmWaitMs),
    );
    if (check.chain !== "verified") {
      this.settleState(attempt, "uncertain", {
        chain: check.chain,
        chainReason: check.reason,
        reason:
          check.chain === "mismatch"
            ? `the owner's wallet sent transaction ${signed.hash}, but the chain does not show it as this payment (${check.reason}), so whether it was paid is unknown; the service was not called`
            : `the owner's wallet sent transaction ${signed.hash}, but the chain does not show it yet (${check.reason}), so whether it was paid is unknown; the service was not called`,
      });
      return;
    }

    // The payment is on chain. The seller checks it again and answers once for it.
    let res: Response | undefined;
    let failure = "";
    const deadline = Date.now() + this.timeoutMs;
    try {
      res = await this.fetchImpl(quote.url, {
        method: "GET",
        redirect: "error",
        headers: { ...rail.credentialHeaders(offer, signed), accept: "application/json, */*" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      failure = message(err);
    }
    const read = res ? await readBody(res, SERVICE_BODY_LIMIT * 4, deadline - Date.now(), PAID_ANSWER_DRAIN) : undefined;
    const delivered = read?.end === "eof";
    const body = read ? read.text.slice(0, SERVICE_BODY_LIMIT) : "";
    const ok = !!res && res.status >= 200 && res.status < 300 && delivered;
    const outcome: ServiceOutcome = !res || !delivered ? "unknown" : ok ? "ok" : "failed";
    const said = res ? readMppReceipt(res.headers.get("payment-receipt")) : undefined;
    const settlement = {
      success: said?.status === "success",
      transaction: said?.reference === undefined ? "" : untrustedText(said.reference, 100),
      network: offer.terms.network,
    } as SettleResponse;
    const receipt = await this.writeReceipt({
      check,
      attempt,
      quote,
      settlement,
      payer: signed.signer,
      transaction: signed.hash,
      serviceOutcome: outcome,
      serviceStatus: res?.status,
      body,
      ms: Date.now() - started,
    });
    if (!receipt) {
      this.settleState(attempt, "uncertain", { ...(res ? { serviceStatus: res.status, serviceBody: body } : {}), chain: "unchecked", reason: UNRECORDED_ANSWER });
      return;
    }
    this.settleState(attempt, ok ? "settled" : "paid_service_failed", {
      transaction: receipt.transaction,
      transactionUrl: receipt.transactionUrl,
      ...(res ? { serviceStatus: res.status, serviceBody: body } : {}),
      receiptId: receipt.id,
      chain: check.chain,
      reason: ok
        ? undefined
        : !res
          ? `the payment is on chain, but the service could not be reached: ${failure}`
          : !delivered
            ? "the payment is on chain, but the service's answer did not arrive in full, so whether it delivered is unknown"
            : `the payment is on chain, but the service answered ${res.status}`,
    });
  }

  /** Read the chain for a payment until it shows (verified), shows something else (mismatch), or `waitMs` passes. */
  private async waitForChain(rail: RailAdapter, facts: PaymentFacts, waitMs: number): Promise<ChainCheck> {
    const until = Date.now() + waitMs;
    for (;;) {
      const check = await rail.checkPayment(facts, this.chainRead);
      if (check.chain !== "unchecked" || Date.now() + CHAIN_POLL_MS > until) return check;
      await new Promise((resolve) => setTimeout(resolve, CHAIN_POLL_MS));
    }
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────

  /**
   * Read the seller's current challenge. Mirrors x402.detect(), but through this engine's
   * fetch so a test (or a future proxy) can stand in for the network.
   */
  private async challengeFor(url: string): Promise<SellerChallenge> {
    const deadline = Date.now() + this.timeoutMs;
    const res = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json, */*" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readCapped(res, MAX_CHALLENGE_BYTES, deadline - Date.now(), url);
    if (res.status !== 402) throw new NotPaidEndpointError(url, res.status, body.slice(0, 300));
    return readSellerChallenge({
      paymentRequiredHeader: res.headers.get("payment-required") ?? res.headers.get("x-payment-required"),
      wwwAuthenticate: res.headers.get("www-authenticate"),
      body,
    });
  }

  /**
   * Record the receipt of a payment that moved, as the seller answered for it. A caller that stopped waiting leaves the
   * attempt to `superstables status`, which may have decided it on chain while the seller's answer was still on its way.
   * So the receipt is written only as status writes, under the reconciliation lock (see recordAnswer), held only for the
   * write: the seller and the chain were read before it. When the lock cannot be taken, the answer is kept aside
   * (Records.savePendingAnswer) for the next status to record under the lock, and undefined is returned: nothing is
   * written to the receipts without the lock.
   */
  private async writeReceipt(input: {
    check: ChainCheck;
    attempt: Attempt;
    quote: Quote;
    settlement: SettleResponse;
    payer: string;
    /** The transaction this client knows is the payment (push: the owner's own); otherwise the seller's report decides. */
    transaction?: string;
    serviceOutcome: ServiceOutcome;
    serviceStatus?: number;
    body: string;
    ms: number;
  }): Promise<Receipt | undefined> {
    const fresh = receiptFor({ ...input, at: new Date().toISOString() });
    let locked = false;
    let receipt: Receipt;
    try {
      receipt = await withFileLock(join(this.records.dir, RECONCILE_LOCK), () => {
        locked = true;
        return recordAnswer(this.records, fresh);
      });
    } catch (err) {
      // A write that failed under the lock is not a lock that could not be taken.
      if (locked) throw err;
      this.records.savePendingAnswer(fresh);
      return undefined;
    }
    // An attempt this run has already ended is read from the records from now on: status may have decided it.
    if (isFinal(input.attempt.state)) this.live.set(input.attempt.id, this.records.getAttempt(input.attempt.id) ?? input.attempt);
    return receipt;
  }

  /**
   * Hand a spent quote back, only if this attempt still holds its claim and nothing else has happened to it since. The
   * claim goes first: a process that stops in between leaves the quote used, never open with a claim on it.
   */
  private reopenQuote(id: string, attemptId: string): boolean {
    const quote = this.records.getQuote(id);
    if (!quote || quote.status !== "used") return false;
    if (!this.records.releaseQuote(id, attemptId)) return false;
    this.records.saveQuote({ ...quote, status: "open" });
    return true;
  }

  private markQuote(id: string, status: Quote["status"]): void {
    const quote = this.records.getQuote(id);
    if (quote) this.records.saveQuote({ ...quote, status });
  }

  /**
   * Record a state change: patch the attempt, append to its history, persist, announce. An attempt that has ended never
   * goes back to an active state: whoever ended it (a caller that stopped) was told how it ended, and that stays true.
   */
  private transition(
    attempt: Attempt,
    state: AttemptState,
    patch: Partial<Attempt> & { note?: string } = {},
  ): Attempt {
    if (isFinal(attempt.state) && !isFinal(state)) return attempt;
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

/**
 * A chain check, unless its transaction is already recorded as another attempt's verified payment: one transaction is one
 * payment, and is never counted for a second attempt. On EVM chains the check itself requires the nonce this attempt's
 * owner signed, which no other attempt has, and one transaction may settle several authorizations: it is taken as it is.
 */
function attributedCheck(records: Records, attempt: Attempt, rail: RailAdapter, transaction: string | undefined, check: ChainCheck): ChainCheck {
  if (check.chain !== "verified" || rail.rail === "evm" || !transaction) return check;
  const owner = records.paymentOwner(attempt.terms.network, transaction, attempt.id);
  return owner ? { chain: "mismatch", reason: `transaction ${transaction} is already recorded as the payment of attempt ${owner}` } : check;
}

/** Why a push payment whose memo an earlier attempt used is not sent. */
function reusedChallenge(earlier: string): string {
  return (
    `the seller's payment challenge is one an earlier payment already used (attempt ${earlier}), so a transfer for it ` +
    "could not be told apart from that payment's; nothing was sent. Quote again for a new challenge"
  );
}

function isFinal(state: AttemptState): boolean {
  return FINAL_ATTEMPT_STATES.includes(state);
}

/** The state a refusal from the signer leaves the attempt in. */
function refusalState(err: unknown): AttemptState {
  if (!(err instanceof SignRefused)) return "failed";
  if (err.code === "denied") return "denied";
  if (err.code === "expired") return "expired";
  if (err.code === "abandoned") return "abandoned";
  if (err.code === "unknown") return "uncertain"; // the wallet was asked to send, and nothing came back
  return "failed"; // policy, invalid, unavailable, approval_page, chain: nothing was signed or sent, nothing was paid
}

/** Which check refused, for the refusals that are not the owner's own decision. */
function refusalOf(err: unknown): Attempt["refusal"] {
  if (!(err instanceof SignRefused)) return undefined;
  return err.code === "policy" || err.code === "invalid" || err.code === "unavailable" || err.code === "approval_page" || err.code === "chain"
    ? err.code
    : undefined;
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
 * Read the chain again for an attempt, and record what it says. Reads records and the chain only; never starts or
 * repeats a payment, never calls the seller, and never asks a wallet.
 *
 *   approved, submitting    left so by a process that is gone (it crashed or was killed after the owner approved): it
 *                           becomes `uncertain`, and is reconciled as one below. While its process runs, it is left alone.
 *   uncertain               the payment is looked for by what ties it to this attempt alone (the EVM nonce the owner
 *                           signed, the Tempo memo after the block the wallet was asked at, the owner's Solana
 *                           signature), never by a transaction the seller named. Found: paid (`settled` when the service
 *                           delivered, `paid_service_failed` otherwise), with a receipt, or the existing receipt corrected
 *                           to the transaction found. Final chain evidence shows it can no longer happen (an EVM
 *                           authorization unused, or cancelled, at a final block past its validBefore; every block a
 *                           Solana transaction could land in read without it, past its blockhash): `failed`, chain
 *                           "unpaid", and it stops counting against the daily cap. Otherwise it stays `uncertain`, with
 *                           the chain's answer, and how far a Solana search read those blocks, for the next status to
 *                           read on from. A Tempo transfer has no expiry: only finding it resolves it.
 *   paid, chain unchecked   (`settled` or `paid_service_failed` on the seller's word) the transaction the seller named is
 *                           read: verified, recorded on the attempt and its receipt. Not this payment: the attempt becomes
 *                           `uncertain` and its receipt `mismatch`, then it is reconciled as above. Not shown yet, or no
 *                           transaction named: the payment is looked for as above; found, the receipt is corrected;
 *                           shown never to have happened, the attempt is `failed` and its receipt "unpaid".
 *
 * On Tempo and Solana, a transaction already recorded as another attempt's verified payment is never taken as this one's.
 * Every write goes through commit: concurrent statuses never undo a payment the chain verified. Any other attempt is
 * returned as it is.
 */
export async function recheckChain(records: Records, id: string, rpc?: string | ChainReadOptions): Promise<Attempt | undefined> {
  let attempt = records.getAttempt(id);
  if (!attempt) return undefined;
  const options = typeof rpc === "string" ? chainReadOptions(rpc) : (rpc ?? chainReadOptions());
  const rail = railFor(attempt.terms?.network);
  if (!rail) return attempt;
  // A seller's answer waiting to be recorded is recorded before anything else is decided.
  if (records.pendingAnswer(id)) attempt = await commit(records, attempt, (_records, current) => current);
  if (attempt.state === "approved" || attempt.state === "submitting") {
    if (processRunning(attempt.runner)) return attempt;
    attempt = await commit(records, attempt, orphaned);
  }
  if (attempt.state === "uncertain") return reconcile(records, attempt, rail, options);
  if (attempt.state !== "settled" && attempt.state !== "paid_service_failed") return attempt;
  if (attempt.chain === "verified" || attempt.chain === "mismatch" || attempt.chain === "unpaid") return attempt;

  const named = attributedCheck(
    records,
    attempt,
    rail,
    attempt.transaction,
    await rail.checkPayment({ ...paymentFacts(attempt, attempt.payer ?? ""), transaction: attempt.transaction }, options),
  );
  if (named.chain === "verified") return commit(records, attempt, (r, current) => recordChain(r, current, named));
  if (named.chain === "mismatch") {
    // The seller named a transaction that is not this payment. This payment may still be on chain under another one.
    const contradicted = await commit(records, attempt, (r, current) => recordChain(r, current, named));
    return reconcile(records, contradicted, rail, options);
  }
  return reconcile(records, { ...attempt, chainReason: named.reason }, rail, options, named.reason);
}

/**
 * Write what a chain read decided, under a short lock every status shares: the attempt and its receipt are read again
 * inside it, and the writer applies to them as they are now, not as they were when the chain was read. Writers never
 * undo a newer and stronger word: a payment the chain verified stays verified, whatever an older read says. No chain is
 * read while the lock is held. When the lock cannot be taken, nothing is written, and the attempt is returned as it is.
 * A write that fails under the lock (a full disk) is thrown to the caller; a waiting answer it was recording stays for
 * the next status.
 */
async function commit(records: Records, attempt: Attempt, write: (records: Records, current: Attempt) => Attempt): Promise<Attempt> {
  let locked = false;
  try {
    return await withFileLock(join(records.dir, RECONCILE_LOCK), () => {
      locked = true;
      // A seller's answer a run could not record (it could not take this lock) is recorded first.
      const pending = records.pendingAnswer(attempt.id);
      if (pending) {
        recordAnswer(records, pending);
        records.clearPendingAnswer(attempt.id);
      }
      const current = records.getAttempt(attempt.id) ?? attempt;
      return write(records, current);
    });
  } catch (err) {
    if (locked) throw err;
    return records.getAttempt(attempt.id) ?? attempt;
  }
}

/** Has the chain already verified this attempt's payment (on the attempt, or on its receipt)? Then nothing undoes it. */
function verifiedPayment(records: Records, attempt: Attempt): boolean {
  return attempt.chain === "verified" || receiptOf(records, attempt)?.chain === "verified";
}

/** A paid attempt's chain check, recorded on it and on its receipt; a mismatch makes it uncertain. */
function recordChain(records: Records, attempt: Attempt, check: ChainCheck): Attempt {
  // Decided from a settled attempt whose chain was unchecked: only that attempt is changed by it.
  if ((attempt.state !== "settled" && attempt.state !== "paid_service_failed") || attempt.chain === "mismatch" || attempt.chain === "unpaid") return attempt;
  if (verifiedPayment(records, attempt)) return attempt;
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

/** An attempt left approved or submitting by a process that is gone: whether its payment moved is unknown. */
function orphaned(records: Records, attempt: Attempt): Attempt {
  if ((attempt.state !== "approved" && attempt.state !== "submitting") || processRunning(attempt.runner)) return attempt;
  const at = new Date().toISOString();
  const updated: Attempt = {
    ...attempt,
    state: "uncertain",
    reason:
      attempt.paymentMemo && !attempt.transaction
        ? "the process running this payment stopped after the owner's wallet was asked to send it, so whether it was sent is unknown"
        : "the process running this payment stopped after the owner approved it, while the payment was being submitted, so whether it settled is unknown",
    updatedAt: at,
    history: [...attempt.history, { at, state: "uncertain", note: "the process running this payment had stopped; the chain decides" }],
  };
  records.saveAttempt(updated);
  return updated;
}

/**
 * Look for an attempt's payment by its own identity, and record what the chain says: see recheckChain. `named` is what
 * the transaction a seller named showed, kept as the reason when the search itself could not read the chain.
 */
async function reconcile(records: Records, attempt: Attempt, rail: RailAdapter, options: ChainReadOptions, named?: string): Promise<Attempt> {
  // Another status has already found it.
  if (attempt.chain === "verified") return attempt;
  // A receipt the chain already verified as this payment (a run that went on after its caller stopped, and read the
  // chain): paid, whatever else is unread.
  const receipt = receiptOf(records, attempt);
  if (receipt?.chain === "verified" && rail.isTransaction(receipt.transaction)) {
    const owner = rail.rail === "evm" ? undefined : records.paymentOwner(attempt.terms.network, receipt.transaction, attempt.id);
    if (!owner) return commit(records, attempt, (r, current) => recordFound(r, current, rail, receipt.transaction));
  }
  // Only an attempt that recorded what ties a transaction to it can be looked for: the nonce, the memo, the signature.
  // (An attempt recorded by an earlier version may have none.)
  if (!rail.findPayment || !attempt.payer || (!attempt.authorizationNonce && !attempt.paymentMemo && !attempt.ownerSignature)) {
    return named !== undefined ? commit(records, attempt, (r, current) => recordSearch(r, current, named)) : attempt;
  }
  // The transaction to read first: the one the attempt names, or the one its receipt names.
  const transaction = attempt.transaction ?? (receipt && rail.isTransaction(receipt.transaction) ? receipt.transaction : undefined);
  const found = await rail.findPayment(
    { ...paymentFacts(attempt, attempt.payer), transaction, attributed: records.paymentsOfOthers(attempt.terms.network, attempt.id) },
    options,
  );
  if (found.found) {
    const owner = rail.rail === "evm" ? undefined : records.paymentOwner(attempt.terms.network, found.transaction, attempt.id);
    if (!owner) return commit(records, attempt, (r, current) => recordFound(r, current, rail, found.transaction));
    const reason = `transaction ${found.transaction} is already recorded as the payment of attempt ${owner}`;
    return commit(records, attempt, (r, current) => recordSearch(r, current, reason));
  }
  if (found.never) return commit(records, attempt, (r, current) => recordUnpaid(r, current, found.reason));
  const reason = found.unreadable && named ? named : found.reason;
  return commit(records, attempt, (r, current) => recordSearch(r, current, reason, found.searchedToSlot));
}

/**
 * Not found yet, or the chain could not say: the attempt keeps its state, with the chain's latest answer, and how far a
 * Solana search read the blocks the payment could have landed in (never less far than another search already had).
 */
function recordSearch(records: Records, attempt: Attempt, reason: string, searchedToSlot?: number): Attempt {
  // Resolved meanwhile (found, or shown never paid): an undecided search says nothing new.
  if (verifiedPayment(records, attempt) || attempt.chain === "unpaid" || attempt.state === "failed") return attempt;
  const at = new Date().toISOString();
  // A transaction the seller named that is not this payment stays a mismatch; the reason says what the search found.
  const mismatch = attempt.chain === "mismatch";
  const chainReason = mismatch ? `the transaction the service named is not this payment; ${reason}` : reason;
  const receipt = receiptOf(records, attempt);
  // A receipt the chain contradicted keeps what the chain said: an undecided search does not undo it.
  if (receipt && !mismatch && receipt.chain !== "mismatch") {
    const { chainReason: _old, ...rest } = receipt;
    records.saveReceipt({ ...rest, chain: "unchecked", chainReason });
  }
  const further = searchedToSlot !== undefined && searchedToSlot > (attempt.searchedToSlot ?? -1);
  const updated: Attempt = { ...attempt, chain: mismatch ? "mismatch" : "unchecked", chainReason, ...(further ? { searchedToSlot } : {}), updatedAt: at };
  records.saveAttempt(updated);
  return updated;
}

/**
 * The chain shows this attempt's payment in `transaction`. Paid: with a receipt, or with its receipt corrected to the
 * transaction found (the seller had named another, or none). One payment, one receipt, whatever the seller said. A
 * payment another status already verified is left as it is.
 */
function recordFound(records: Records, attempt: Attempt, rail: RailAdapter, transaction: string): Attempt {
  if (attempt.chain === "verified") return attempt;
  const at = new Date().toISOString();
  const existing = receiptOf(records, attempt);
  let receipt: Receipt;
  if (existing) {
    const { chainReason: _old, ...rest } = existing;
    const network = attempt.terms.network;
    receipt = records.saveReceipt({ ...rest, transaction, transactionKind: "hash", transactionUrl: txUrl(network, transaction), chain: "verified" });
  } else {
    receipt = records.saveReceipt(
      receiptFor({
        check: { chain: "verified" },
        attempt,
        quote: { id: attempt.quoteId },
        settlement: { success: false, transaction: "", network: attempt.terms.network } as unknown as SettleResponse,
        payer: attempt.payer ?? "",
        transaction,
        serviceOutcome: "unknown",
        serviceStatus: attempt.serviceStatus,
        body: attempt.serviceBody ?? "",
        ms: 0,
        at,
      }),
    );
  }
  const { state, reason } = servedOn(existing, attempt, rail.flow);
  const { chainReason: _was, reason: _reason, ...kept } = attempt;
  const updated: Attempt = {
    ...kept,
    state,
    transaction: receipt.transaction,
    transactionUrl: receipt.transactionUrl,
    receiptId: receipt.id,
    chain: "verified",
    ...(reason ? { reason } : {}),
    updatedAt: at,
    history: [...attempt.history, { at, state, note: `the chain shows this payment in transaction ${transaction}` }],
  };
  records.saveAttempt(updated);
  return updated;
}

/**
 * How a payment the chain shows ends, by what the service did with it: `settled` when its receipt says it delivered,
 * otherwise `paid_service_failed`, with why. `receipt` is the seller's answer as recorded, if one was.
 */
function servedOn(receipt: Receipt | undefined, attempt: Attempt, flow: RailAdapter["flow"]): { state: AttemptState; reason?: string } {
  if (receipt?.serviceOutcome === "ok") return { state: "settled" };
  const reason =
    receipt?.serviceOutcome === "failed"
      ? `the chain shows this payment, but the service answered ${receipt.serviceStatus ?? "with an error"}`
      : receipt
        ? "the chain shows this payment, but the service's answer did not arrive in full, so whether it delivered is unknown"
        : attempt.serviceStatus === undefined
          ? flow === "push"
            ? "the chain shows this payment, but the service was never called with it, so it did not deliver"
            : "the chain shows this payment, but the service's answer was not received, so whether it delivered is unknown"
          : `the chain shows this payment, but the service answered ${attempt.serviceStatus} without reporting it settled, so whether it delivered is unknown`;
  return { state: "paid_service_failed", reason };
}

/**
 * Record a seller's answer for a payment (`fresh`, the receipt the run built from it), under the reconciliation lock,
 * against the attempt and its receipt as they are now, read first. What the chain decided stands:
 *
 *   unpaid     the chain shows the payment was never made and can no longer be: the answer is kept as a receipt marked
 *              `unpaid`, with the chain's reason. It is the seller's word, which the chain contradicts; it counts
 *              nowhere, and the attempt stays `failed`.
 *   verified   the payment keeps its verified receipt (see mergedReceipt), and the answer adds what the service did; the
 *              attempt learns whether the service delivered.
 *
 * Otherwise the answer is the receipt, as the run built it.
 */
function recordAnswer(records: Records, fresh: Receipt): Receipt {
  const record = records.getAttempt(fresh.attemptId);
  const current = records.getReceipt(fresh.id);
  if (record?.chain === "unpaid") {
    return records.saveReceipt({ ...fresh, at: current?.at ?? fresh.at, chain: "unpaid", chainReason: record.chainReason ?? "the chain shows this payment was never made, and it can no longer be" });
  }
  const receipt = records.saveReceipt(current?.chain === "verified" ? mergedReceipt(current, fresh) : fresh);
  if (record?.chain === "verified" && (record.state === "settled" || record.state === "paid_service_failed") && (record.receiptId ?? record.id) === receipt.id) {
    const at = new Date().toISOString();
    const { state, reason } = servedOn(receipt, record, railFor(record.terms.network)?.flow ?? "x402");
    const { reason: _was, ...kept } = record;
    records.saveAttempt({
      ...kept,
      state,
      ...(reason ? { reason } : {}),
      ...(receipt.serviceStatus !== undefined ? { serviceStatus: receipt.serviceStatus, serviceBody: receipt.serviceBodyPreview ?? "" } : {}),
      updatedAt: at,
      history: [...record.history, { at, state, note: "the service's answer arrived after the chain showed the payment" }],
    });
  }
  return receipt;
}

/**
 * A receipt the seller's answer writes, over the one already recorded for the payment (status writes one only when it
 * finds the payment on chain): a payment the chain verified keeps that evidence, its transaction and its day, and what
 * the seller answered (its report, the service's outcome and answer) is added.
 */
function mergedReceipt(current: Receipt, fresh: Receipt): Receipt {
  if (current.chain !== "verified") return fresh;
  const { chainReason: _fresh, ...answer } = fresh;
  return {
    ...answer,
    at: current.at,
    transaction: current.transaction,
    transactionKind: current.transactionKind,
    transactionUrl: current.transactionUrl,
    chain: "verified",
  };
}

/**
 * The chain shows this attempt's payment was never made, and can no longer be: nothing was paid. The attempt is `failed`
 * with chain "unpaid", and a receipt the seller's report had written is marked so; neither counts against the cap. Never
 * over a payment the chain has verified meanwhile.
 */
function recordUnpaid(records: Records, attempt: Attempt, chainReason: string): Attempt {
  if (verifiedPayment(records, attempt) || attempt.chain === "unpaid") return attempt;
  const at = new Date().toISOString();
  const receipt = receiptOf(records, attempt);
  if (receipt) records.saveReceipt({ ...receipt, chain: "unpaid", chainReason });
  const updated: Attempt = {
    ...attempt,
    state: "failed",
    chain: "unpaid",
    chainReason,
    reason: receipt
      ? "the service reported this payment settled, but the chain shows it was never made, and it can no longer be"
      : "the chain shows this payment was never made, and it can no longer be",
    updatedAt: at,
    history: [...attempt.history, { at, state: "failed", note: "the chain shows the payment was never made and can no longer be" }],
  };
  records.saveAttempt(updated);
  return updated;
}

/**
 * An attempt's receipt: the one it names, or one written under its id (a run that went on after its caller stopped, and
 * recorded the seller's answer while the attempt was already uncertain). A payment has one receipt.
 */
function receiptOf(records: Records, attempt: Attempt): Receipt | undefined {
  return records.getReceipt(attempt.receiptId ?? attempt.id);
}

/** What the chain is asked about an attempt's payment: from the attempt's own record, never from a seller's report. */
function paymentFacts(attempt: Attempt, payer: string): PaymentFacts {
  const askedAt = attempt.history?.find((h) => h.state === "approved")?.at ?? attempt.reservedAt ?? attempt.createdAt;
  // x402: nothing was signed before the attempt began. Push: nothing was sent before the wallet was asked.
  const since = railFor(attempt.terms.network)?.flow === "push" ? askedAt : attempt.createdAt;
  return {
    network: networkFor(attempt.terms.network)?.caip2 ?? attempt.terms.network,
    payer,
    recipient: attempt.terms.recipient,
    amountAtomic: attempt.terms.amountAtomic,
    ...(attempt.authorizationNonce ? { nonce: attempt.authorizationNonce } : {}),
    ...(attempt.authorizationValidBefore ? { validBefore: attempt.authorizationValidBefore } : {}),
    ...(attempt.paymentMemo ? { memo: attempt.paymentMemo } : {}),
    ...(attempt.searchFromBlock ? { searchFromBlock: attempt.searchFromBlock } : {}),
    ...(attempt.ownerSignature ? { ownerSignature: attempt.ownerSignature } : {}),
    ...(attempt.lastValidBlockHeight !== undefined ? { lastValidBlockHeight: attempt.lastValidBlockHeight } : {}),
    ...(attempt.searchFromSlot !== undefined ? { searchFromSlot: attempt.searchFromSlot } : {}),
    ...(attempt.searchedToSlot !== undefined ? { searchedToSlot: attempt.searchedToSlot } : {}),
    ...(since ? { since } : {}),
  };
}

/** The receipt of a payment the chain or the seller says moved. */
function receiptFor(input: {
  check: ChainCheck;
  attempt: Attempt;
  quote: Pick<Quote, "id">;
  settlement: SettleResponse;
  payer: string;
  transaction?: string;
  serviceOutcome: ServiceOutcome;
  serviceStatus?: number;
  body: string;
  ms: number;
  at: string;
}): Receipt {
  const { attempt, quote, settlement } = input;
  // The network is the one the client checked in the terms, not the one the seller names in its report.
  const network = attempt.terms.network;
  // A facilitator that has a hash gives one; one that has only accepted the transfer gives something else. Only a
  // well-formed transaction id for this chain is kept as the transaction: anything else the seller put there is not
  // repeated as a fact, and stays only in `settlement`, the seller's report as it was received.
  const reported = input.transaction ?? settlement.transaction ?? "";
  const kind = isTransactionId(network, reported) ? "hash" : "pending";
  const transaction = kind === "hash" ? reported : "";
  return {
    id: attempt.id,
    at: input.at,
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
}

/** Chain reads through one RPC for every chain (tests), one per chain, or each chain's own (chainRpc). */
function chainReadOptions(rpcUrl?: string, rpcUrlFor?: (network: NetworkInfo) => string | undefined): ChainReadOptions {
  return { rpcUrlFor: (network) => rpcUrlFor?.(network) ?? rpcUrl };
}

/** Why a payment the seller reported is uncertain when its receipt could not be recorded. */
const UNRECORDED_ANSWER =
  "the service answered for this payment, but its receipt could not be recorded while another process held the records' lock; " +
  "`superstables status` records it and checks the chain";

/** How long a second claim on a quote waits for the first one's attempt record to appear, and how often it looks. */
const CLAIM_WAIT_MS = 250;
const CLAIM_POLL_MS = 10;

/** How often the chain is read while waiting for a payment to show. */
const CHAIN_POLL_MS = 1_500;

/** How long a reservation outlives the signer's approval window: room for the signature to come back. */
const RESERVATION_GRACE_MS = 60_000;

/** How long a reservation counts for a signer that does not say how long it waits for the owner. */
const DEFAULT_APPROVAL_WINDOW_MS = 10 * 60_000;

/** The lock file, in the records directory, under which an attempt checks the daily cap and reserves its amount. */
const CAP_LOCK = "cap.lock";
/** The lock file under which a status writes what a chain read decided (see commit). */
const RECONCILE_LOCK = "reconcile.lock";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A transaction id: an EVM transaction hash (0x and 64 hex digits), or on Solana a base58 signature when the network is
 * given. The only shapes a transaction is repeated in.
 */
export function isTxHash(value: unknown, network?: string): value is string {
  return network === undefined ? typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) : isTransactionId(network, value);
}

/**
 * The transaction of a receipt or an attempt as it may be shown: the hash and its explorer link when it is a well-formed
 * hash, nothing otherwise. Checked when shown as well as when written, because records written by an earlier version
 * kept whatever the seller sent, and the link is rebuilt from the checked network rather than taken from the record.
 */
export function shownTransaction(transaction: string | undefined, network: string): { hash?: string; url?: string } {
  return isTransactionId(network, transaction) ? { hash: transaction, url: txUrl(network, transaction) } : {};
}

/**
 * A payer address as it may be shown, or nothing: 0x and 40 hex digits, or a base58 Solana address when the payment's
 * network is Solana.
 */
export function shownPayer(payer: string | undefined, network?: string): string | undefined {
  if (typeof payer !== "string") return undefined;
  return isAddressOn(network ?? "", payer) ? payer : undefined;
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
  const checkedPayer = shownPayer(payer, attempt.terms.network);
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
  const payer = shownPayer(receipt.payer, receipt.terms.network) ?? "";
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
