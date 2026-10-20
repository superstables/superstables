// The local ledger. Everything the client learns is written here as append-only JSONL:
// one file per kind, one JSON object per line, newest line for an id wins. Append-only
// because a payment record must never be quietly rewritten: a correction is a new line,
// and the whole history stays readable with `tail`. The files hold no key and no secret,
// but they do say what was bought and for how much, so they are created 0600.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { networkFor } from "./chain.js";
import { homeDir, recordsDir } from "./home.js";
import { ensurePrivateDir, syncDirectory } from "./private-dir.mjs";
import { CAP_DECIMALS, capUnit, capUnits, policyAmount } from "./policy.js";
import { processRunning, thisProcess, withFileLock } from "./lock.js";
import type { Attempt, Quote, Receipt } from "./types.js";

/** How an approval id is written down: sha256 of the id. It names the approval in approvals.jsonl and an attempt's walletRequestId, and opens nothing. */
export function approvalIdHash(id: string): string {
  return `sha256:${createHash("sha256").update(id).digest("hex")}`;
}

/**
 * The process running an attempt (its pid, that process's start identity where the system gives one, and its machine:
 * hostname, machine and boot ids): while it runs, it carries the attempt on; once it is gone, an attempt it left approved
 * or submitting is for `superstables status` to reconcile from the chain. The attempt's line on disk keeps it for those
 * checks, which read it with attemptRunner; no attempt Records returns carries it.
 */
export type AttemptRunner = ReturnType<typeof thisProcess>;
type StoredAttempt = Attempt & { runner?: AttemptRunner };

/** The process recorded as running attempt `id`, as its newest line on disk says. */
export function attemptRunner(records: Records, id: string): AttemptRunner | undefined {
  return rowsById<StoredAttempt>(join(records.dir, "attempts.jsonl")).get(id)?.runner;
}

/** The newest line of attempt `id`, read once: its state and its runner come from the same line. */
function latestAttempt(records: Records, id: string): { attempt: Attempt; runner: AttemptRunner | undefined } | undefined {
  const row = rowsById<StoredAttempt>(join(records.dir, "attempts.jsonl")).get(id);
  if (!row) return undefined;
  const { runner, ...rest } = row;
  return { attempt: { chainFinal: null, ...rest } as Attempt, runner };
}

/** The lock every reconcile write takes (see recheckChain's commit). */
export const RECONCILE_LOCK = "reconcile.lock";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Is the process recorded as running an attempt verifiably gone? True when no process with that pid and start identity
 * runs, or when it ran in an earlier boot of this machine (its approval page died with it). False when it runs, and also
 * when this machine cannot tell (another host, an unreadable /proc, a process in another PID namespace).
 */
function runnerGone(runner: AttemptRunner | undefined): boolean {
  if (!runner || typeof runner.pid !== "number") return false;
  const here = thisProcess();
  const r = runner as { bootId?: string | null; hostId?: string | null; hostname?: string | null };
  if (
    typeof r.bootId === "string" && typeof here.bootId === "string" && UUID.test(r.bootId) && UUID.test(here.bootId) &&
    r.bootId.toLowerCase() !== here.bootId.toLowerCase()
  ) {
    // Another boot is "gone" only on this same machine, proven by a recorded machine id on both sides. A host name alone
    // proves nothing (cloned machines, a home shared between computers): then the record stays as it is.
    return typeof r.hostId === "string" && typeof here.hostId === "string" && r.hostId === here.hostId;
  }
  return !processRunning(runner);
}

function sameRunner(a: AttemptRunner | undefined, b: AttemptRunner | undefined): boolean {
  return !!a && !!b && a.pid === b.pid && a.start === b.start;
}

/**
 * The newest state of an attempt that was seen waiting for the owner, when its `superstables pay` process is verifiably
 * gone: nobody can decide any more. The order matters: the runner is proven dead first, and only then is the attempt read
 * again, state and runner from one line. A process that advanced the attempt (approved, submitting, uncertain) and then
 * died has written that before it died, so the second read cannot miss it. Returns the newest attempt, and whether it is
 * still awaiting_approval for that same dead runner (stale). Undefined when the attempt was not seen waiting, or its
 * runner is not verifiably gone.
 */
function inspectAwaiting(records: Records, attempt: Attempt): { latest: Attempt; stale: boolean } | undefined {
  if (attempt.state !== "awaiting_approval") return undefined;
  const first = latestAttempt(records, attempt.id);
  if (!first || !runnerGone(first.runner)) return undefined;
  const again = latestAttempt(records, attempt.id);
  if (!again) return undefined;
  return { latest: again.attempt, stale: again.attempt.state === "awaiting_approval" && sameRunner(first.runner, again.runner) };
}

/**
 * An attempt still waiting for the owner whose `superstables pay` process is verifiably gone: nobody can decide any more,
 * and nothing was submitted. Unverifiable identity is not stale: the record then stays as it is.
 */
export function staleAwaiting(records: Records, attempt: Attempt): boolean {
  return inspectAwaiting(records, attempt)?.stale === true;
}

/** The reason recorded on an attempt whose pay process is gone. */
export const STALE_AWAITING_REASON =
  "the `superstables pay` process that served the approval page is no longer running; nobody decided and nothing was submitted";

/**
 * End a stale awaiting_approval attempt as `abandoned` (by "stopped"), once; any other attempt is returned as it is, as
 * its newest line says. The check and the write happen under the reconcile lock, the one recheckChain's writes take, and
 * only if the newest line is still awaiting_approval for the runner proven dead.
 */
export async function settleStaleAwaiting(records: Records, attempt: Attempt): Promise<Attempt> {
  if (attempt.state !== "awaiting_approval") return attempt;
  const settle = (): Attempt => {
    const inspected = inspectAwaiting(records, attempt);
    if (!inspected) return records.getAttempt(attempt.id) ?? attempt;
    const { latest, stale } = inspected;
    if (!stale) return latest;
    const at = new Date().toISOString();
    const updated: Attempt = {
      ...latest,
      state: "abandoned",
      abandonedBy: "stopped",
      reason: STALE_AWAITING_REASON,
      updatedAt: at,
      history: [...latest.history, { at, state: "abandoned", note: STALE_AWAITING_REASON }],
    };
    records.saveAttempt(updated);
    return updated;
  };
  // Cheap exit without the lock: a live or unverifiable runner is left alone.
  if (!inspectAwaiting(records, attempt)) return records.getAttempt(attempt.id) ?? attempt;
  let locked = false;
  try {
    return await withFileLock(join(records.dir, RECONCILE_LOCK), () => {
      locked = true;
      return settle();
    });
  } catch (err) {
    if (locked) throw err;
    return records.getAttempt(attempt.id) ?? attempt;
  }
}

/** How long a reservation without a recorded end counts: the longest default approval window, and more. */
const RESERVATION_FALLBACK_MS = 10 * 60_000;
/** An EVM authorization counts this long past its validBefore: the chain's clock may lag this machine's. */
const VALID_BEFORE_MARGIN_MS = 120_000;

/**
 * Can this signed (or sent) attempt still move money at `now`, as far as this machine knows without reading a chain?
 * An EVM authorization: until its validBefore. A Tempo transfer the owner's wallet was asked to send has no expiry, and a
 * Solana transaction expires at a block height only the chain can say has passed: both can, until `superstables status`
 * reads the chain and records what it found. Undefined for an EVM record without a validBefore (an older record).
 */
function mayStillMove(attempt: Attempt, now: Date): boolean | undefined {
  if (attempt.paymentIncluded && attempt.state === "uncertain" && attempt.chain !== "unpaid") return true;
  const rail = networkFor(attempt.terms?.network ?? "")?.rail;
  if (rail === "tempo" || rail === "solana") return true;
  const validBefore = attempt.authorizationValidBefore ? Date.parse(attempt.authorizationValidBefore) : NaN;
  return Number.isFinite(validBefore) ? now.getTime() < validBefore + VALID_BEFORE_MARGIN_MS : undefined;
}

/** Does an attempt without a receipt count toward the cap on `day`, judged at `now`? See Records.spentToday. */
function countsOn(attempt: Attempt, now: Date, day: string): boolean {
  switch (attempt.state) {
    case "approved":
    case "submitting": {
      // Open: counts on every day while it can still move money; after that (an EVM authorization past its validBefore),
      // on the day it was signed only. Without a recorded validBefore (an older EVM record), every day.
      if (mayStillMove(attempt, now) !== false) return true;
      const signedAt = attempt.history?.find((h) => h.state === "approved")?.at ?? attempt.updatedAt;
      return typeof signedAt === "string" && signedAt.startsWith(day);
    }
    case "uncertain": {
      // On the day it became uncertain, and on every day while it can still move money. An older EVM record without a
      // validBefore counts on the day it became uncertain only, as it always did.
      const ended = [...(attempt.history ?? [])].reverse().find((h) => h.state === "uncertain")?.at ?? attempt.updatedAt;
      if (typeof ended === "string" && ended.startsWith(day)) return true;
      return mayStillMove(attempt, now) === true;
    }
    case "awaiting_approval": {
      if (typeof attempt.reservedAt !== "string") return false;
      const until = attempt.reservedUntil ? Date.parse(attempt.reservedUntil) : Date.parse(attempt.reservedAt) + RESERVATION_FALLBACK_MS;
      return Number.isFinite(until) && now.getTime() < until;
    }
    default:
      return false;
  }
}

/** A transaction id as it is compared: EVM hashes ignore case, Solana signatures do not. */
function txKey(network: string, transaction: string): string {
  return networkFor(network)?.rail === "solana" ? transaction : transaction.toLowerCase();
}

/** 0600: only the owner of the machine reads their own payment history. */
const FILE_MODE = 0o600;

/** The three files the records live in, for the count of lines that could not be read. */
const RECORD_FILES = ["quotes.jsonl", "attempts.jsonl", "receipts.jsonl"] as const;

interface Identified {
  id: string;
}

export class Records {
  readonly dir: string;

  constructor(dir: string = recordsDir()) {
    this.dir = dir;
  }

  /** A fresh record id. Random, never derived from anything the seller controls. */
  static newId(): string {
    return randomUUID();
  }

  newId(): string {
    return randomUUID();
  }

  // ── Quotes ───────────────────────────────────────────────────────────────────────────

  saveQuote(quote: Quote): Quote {
    this.append("quotes.jsonl", quote);
    return quote;
  }

  getQuote(id: string): Quote | undefined {
    return this.byId<Quote>("quotes.jsonl").get(id);
  }

  listQuotes(limit?: number): Quote[] {
    return newestFirst(this.byId<Quote>("quotes.jsonl"), (q) => q.createdAt, limit);
  }

  // ── Attempts ─────────────────────────────────────────────────────────────────────────

  /**
   * The process running the attempt saves it with its runner (see PaymentEngine). Any other save keeps the one the newest
   * line has (none, once `superstables budget unlock --attempt` released it).
   */
  saveAttempt(attempt: Attempt): Attempt {
    const { runner = attemptRunner(this, attempt.id), ...normalized }: StoredAttempt = { ...attempt, chainFinal: attempt.chainFinal ?? null };
    // the approval link works only in the process serving it, and its id is a capability: never on disk
    const { approvalUrl: _link, ...stored } = normalized;
    const row: StoredAttempt = runner ? { ...stored, runner } : stored;
    this.append("attempts.jsonl", row);
    return normalized;
  }

  getAttempt(id: string): Attempt | undefined {
    return this.byId<Attempt>("attempts.jsonl").get(id);
  }

  listAttempts(limit?: number): Attempt[] {
    return newestFirst(this.byId<Attempt>("attempts.jsonl"), (a) => a.createdAt, limit);
  }

  /** The newest attempt started from a quote, if there is one. */
  attemptForQuote(quoteId: string): Attempt | undefined {
    return this.listAttempts().find((attempt) => attempt.quoteId === quoteId);
  }

  /**
   * Claim a quote for one attempt, atomically across every process sharing these records: a claim file created only if
   * none exists (O_EXCL). Returns undefined when this attempt holds the claim now, or the attempt id the existing claim
   * names (empty when its process stopped before writing it). A claim outlives a crash between writes: the quote then
   * stays claimed, and nothing was signed for it.
   */
  claimQuote(quoteId: string, attemptId: string): string | undefined {
    const dir = join(this.dir, "claims");
    privateDir(dir);
    const path = join(dir, claimName(quoteId));
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (fd !== undefined) {
      // on disk, name included, before anything is signed for this quote
      try {
        writeAllSync(fd, attemptId);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncDirectory(dir);
      return undefined;
    }
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
    }
  }

  /** The attempt id a quote's claim names, without claiming: undefined with no claim, empty if it is unreadable. */
  claimHolder(quoteId: string): string | undefined {
    try {
      return readFileSync(join(this.dir, "claims", claimName(quoteId)), "utf8").trim();
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "";
    }
  }

  /** Give a claimed quote back, only if `attemptId` holds the claim. */
  releaseQuote(quoteId: string, attemptId: string): boolean {
    const path = join(this.dir, "claims", claimName(quoteId));
    try {
      if (readFileSync(path, "utf8").trim() !== attemptId) return false;
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Other attempts that recorded this Tempo memo: each may have paid with it, or still may. With `key`, memos are
   * compared by what it makes of them (a rail's challengeKey), not as they are.
   */
  attemptsWithMemo(memo: string, exclude?: string, key: (memo: string) => string = (m) => m.toLowerCase()): Attempt[] {
    const wanted = key(memo);
    return [...this.byId<Attempt>("attempts.jsonl").values()].filter((a) => a.id !== exclude && a.paymentMemo !== undefined && key(a.paymentMemo) === wanted);
  }

  /** Other attempts that recorded this owner's signature (Solana): the same signature is the same transaction. */
  attemptsWithOwnerSignature(signature: string, exclude?: string): Attempt[] {
    return [...this.byId<Attempt>("attempts.jsonl").values()].filter((a) => a.id !== exclude && a.ownerSignature === signature);
  }

  /**
   * The transactions on `network` that the chain verified as some other attempt's payment: one transaction is one
   * payment, and is never counted as a second one.
   */
  paymentsOfOthers(network: string, exclude: string): string[] {
    const out: string[] = [];
    for (const receipt of this.byId<Receipt>("receipts.jsonl").values()) {
      if (receipt.attemptId === exclude || receipt.id === exclude || (receipt.chain !== "verified" && !receipt.paymentIncluded) || !receipt.transaction) continue;
      if (networkFor(receipt.terms?.network ?? "")?.caip2 !== networkFor(network)?.caip2) continue;
      out.push(receipt.transaction);
    }
    return out;
  }

  /** The attempt whose verified payment `transaction` is, other than `exclude`, if there is one. */
  paymentOwner(network: string, transaction: string, exclude: string): string | undefined {
    const wanted = txKey(network, transaction);
    for (const receipt of this.byId<Receipt>("receipts.jsonl").values()) {
      if (receipt.attemptId === exclude || receipt.id === exclude || (receipt.chain !== "verified" && !receipt.paymentIncluded) || !receipt.transaction) continue;
      if (networkFor(receipt.terms?.network ?? "")?.caip2 !== networkFor(network)?.caip2) continue;
      if (txKey(network, receipt.transaction) === wanted) return receipt.attemptId;
    }
    return undefined;
  }

  // ── Answers waiting to be recorded ──────────────────────────────────────────────────

  /**
   * Keep a seller's answer (the receipt a payment run built from it) that could not be recorded because another process
   * held the reconciliation lock: one file per attempt, written whole and renamed into place, so it is there complete or
   * not at all. Nothing is read or merged here; the next status records it under the lock. A new answer replaces the
   * one waiting: this is not a queue, and needs none while a run gives at most one answer for its attempt.
   */
  savePendingAnswer(receipt: Receipt): void {
    const dir = join(this.dir, "pending-answers");
    privateDir(dir);
    const path = join(dir, `${claimName(receipt.id)}.json`);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(temporary, "wx", FILE_MODE);
    try {
      writeAllSync(fd, JSON.stringify(receipt));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dir);
  }

  /** The seller's answer waiting to be recorded for an attempt, if there is one. */
  pendingAnswer(attemptId: string): Receipt | undefined {
    try {
      const receipt = JSON.parse(readFileSync(join(this.dir, "pending-answers", `${claimName(attemptId)}.json`), "utf8")) as Receipt;
      return receipt && typeof receipt === "object" && receipt.id === attemptId ? receipt : undefined;
    } catch {
      return undefined;
    }
  }

  /** Remove an attempt's waiting answer once it is recorded. */
  clearPendingAnswer(attemptId: string): void {
    try {
      unlinkSync(join(this.dir, "pending-answers", `${claimName(attemptId)}.json`));
    } catch {
      // already gone
    }
  }

  // ── Receipts ─────────────────────────────────────────────────────────────────────────

  saveReceipt(receipt: Receipt): Receipt {
    const normalized = { ...receipt, chainFinal: receipt.chainFinal ?? null };
    this.append("receipts.jsonl", normalized);
    return normalized;
  }

  getReceipt(id: string): Receipt | undefined {
    return this.byId<Receipt>("receipts.jsonl").get(id);
  }

  listReceipts(limit?: number): Receipt[] {
    return newestFirst(this.byId<Receipt>("receipts.jsonl"), (r) => r.at, limit);
  }

  /**
   * What counts toward the daily cap on the UTC day of `now`, in millionths of one asset's cap unit (CAP_DECIMALS): the US dollar stablecoins (USDC on
   * every chain, pathUSD on Tempo) count together, one for one, whatever the rail. One line: a payment counts on the day it
   * ended (a receipt's day, or the day it became uncertain), and on every day while it can still move money (signed or
   * sent and not resolved, or waiting for the owner within its approval window).
   *
   *   receipt                       on its own day, unless a later chain check found it unpaid (the seller's report was
   *                                 wrong, and the authorization can no longer be used). Without explicit finality it
   *                                 also counts on later days while its payment can still move money, as below. Matching
   *                                 provisional evidence keeps that hold even after local authorization expiry.
   *   uncertain, no receipt         on the day it became uncertain, and on every day while it can still move money: an
   *                                 EVM authorization until its validBefore; a Tempo send or a Solana transaction until
   *                                 `superstables status` reads the chain and records it paid, or (Solana) unpaid
   *   approved / submitting         likewise on every day while it can still move money, then on the day it was signed
   *                                 only; every day when an EVM record has no validBefore
   *   awaiting_approval, reserved   on every day until its reservation ends (reservedUntil): the owner may still sign
   *
   * A reservation left by a process that stopped stops counting when its approval window ends. A failed attempt counts
   * nowhere: nothing left this machine, or the chain showed it was never paid and can no longer be. Each payment counts
   * once: an attempt with a receipt counts only through the receipt. Attempts are read before receipts, so a payment that
   * settles between the two reads is still counted, once. `exclude` leaves out one attempt: the one being checked
   * against the cap. This is the number the per-day cap is checked against; it is a local figure, not a chain balance,
   * and it says so wherever it is shown.
   *
   * Each amount is the record's `terms.amountAtomic`, a whole number, read at its chain's token decimals (capUnits);
   * nothing is added as a decimal. Undefined when a record that counts has no whole-number amountAtomic: a total that
   * cannot be read is not zero, and the daily cap then refuses (evaluatePolicy).
   */
  spentTodayAtomic(asset: string, now: Date = new Date(), options: { exclude?: string } = {}): bigint | undefined {
    return this.spentTodayCounted(asset, now, options).total;
  }

  /**
   * Whether the total spentTodayAtomic gives includes an attempt that is not resolved (waiting for the owner, signed or
   * sent and not confirmed, uncertain), so the word "paid" would claim more than the records know.
   */
  spentTodayHasOpen(asset: string, now: Date = new Date(), options: { exclude?: string } = {}): boolean {
    return this.spentTodayCounted(asset, now, options).open;
  }

  private spentTodayCounted(asset: string, now: Date, options: { exclude?: string }): { total: bigint | undefined; open: boolean } {
    // An attempt seen waiting whose runner is dead may have moved on before it died: when that shows, count again from
    // fresh reads, so the newer state and its receipt are what is counted. A dead runner writes nothing more: this settles.
    for (let pass = 0; ; pass++) {
      const counted = this.countSpent(asset, now, options, pass < 3);
      if (counted !== "again") return counted;
    }
  }

  private countSpent(asset: string, now: Date, options: { exclude?: string }, mayRetry: boolean): { total: bigint | undefined; open: boolean } | "again" {
    const day = now.toISOString().slice(0, 10);
    const wanted = capUnit(asset);
    // Attempts first, then receipts: see above.
    const attempts = this.byId<Attempt>("attempts.jsonl");
    const receipts = this.byId<Receipt>("receipts.jsonl");
    let total = 0n;
    let open = false;
    /** Adds one record's amount; false when it has none that can be read. */
    const add = (terms: Receipt["terms"] | undefined): boolean => {
      const { amountAtomic, decimals } = policyAmount(terms ?? {});
      if (amountAtomic === undefined) return false;
      total += capUnits(amountAtomic, decimals ?? CAP_DECIMALS);
      return true;
    };
    for (const receipt of receipts.values()) {
      if (!receipt.at?.startsWith(day)) continue;
      // The chain showed the seller's report was wrong: nothing was paid, and nothing can be.
      if (receipt.chain === "unpaid") continue;
      if (capUnit(receipt.terms?.asset ?? "") !== wanted) continue;
      if (!add(receipt.terms)) return { total: undefined, open };
    }
    for (const attempt of attempts.values()) {
      if (attempt.id === options.exclude) continue;
      if (capUnit(attempt.terms?.asset ?? "") !== wanted) continue;
      // Waiting for an owner who can no longer decide: its pay process is gone, so nothing will be signed.
      if (attempt.state === "awaiting_approval") {
        const inspected = inspectAwaiting(this, attempt);
        if (inspected?.stale) continue;
        if (inspected) {
          // The newest line is no longer the awaiting one counted from. Out of retries, the snapshot is obsolete and
          // counting it could drop a payment: the total is unknown, and every reader fails closed on that.
          if (mayRetry) return "again";
          return { total: undefined, open: true };
        }
      }
      const receipt = receipts.get(attempt.receiptId ?? attempt.id) ?? receipts.get(attempt.id);
      if (receipt) {
        // One payment: counted through its receipt on the receipt's day. A receipt the chain has not confirmed (the
        // seller's word) or has contradicted leaves the payment unresolved: it keeps counting on later days, once, while it
        // can still move money, as an unresolved attempt without a receipt would. An attempt with matching inclusion is paid on its recorded day,
        // whatever an older receipt line says.
        if (receipt.at?.startsWith(day) || attempt.chain === "verified" || receipt.chain === "verified" || attempt.chainFinal === true || receipt.chainFinal === true || receipt.chain === "unpaid") continue;
        if (attempt.state !== "failed" && mayStillMove(attempt, now) === true) {
          open = true;
          if (!add(attempt.terms)) return { total: undefined, open };
        }
        continue;
      }
      if (countsOn(attempt, now, day)) {
        open ||= attempt.state === "awaiting_approval" || attempt.state === "approved" || attempt.state === "submitting" || attempt.state === "uncertain";
        if (!add(attempt.terms)) return { total: undefined, open };
      }
    }
    return { total, open };
  }

  /**
   * spentTodayAtomic as a decimal number, for display (NaN when the total cannot be read). No cap compares it: quote, pay
   * and the browser signer pass spentTodayAtomic.
   */
  spentToday(asset: string, now: Date = new Date(), options: { exclude?: string } = {}): number {
    const total = this.spentTodayAtomic(asset, now, options);
    return total === undefined ? NaN : Number(total) / 10 ** CAP_DECIMALS;
  }

  // ── The append-only file itself ──────────────────────────────────────────────────────

  private path(file: string): string {
    return join(this.dir, file);
  }

  private append(file: string, row: Identified): void {
    privateDir(this.dir);
    const path = this.path(file);
    // If the last write was cut short (a crash, a full disk), start a new line rather than
    // gluing this record onto the broken one — then only the torn line is ever lost.
    const prefix = endsWithNewline(path) ? "" : "\n";
    const created = !existsSync(path);
    const fd = openSync(path, "a", FILE_MODE);
    // the line is on disk before the caller goes on: a payment's `submitting` line before its credential leaves
    try {
      writeAllSync(fd, `${prefix}${JSON.stringify(row)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) syncDirectory(this.dir);
  }

  /** Latest row per id. Attempts and receipts read without a runner (see attemptRunner), and chainFinal null if unset. */
  private byId<T extends Identified>(file: string): Map<string, T> {
    const rows = rowsById<T>(this.path(file));
    if (file !== "attempts.jsonl" && file !== "receipts.jsonl") return rows;
    for (const [id, row] of rows) {
      const shown = { chainFinal: null, ...row };
      delete (shown as { runner?: unknown }).runner;
      rows.set(id, shown);
    }
    return rows;
  }

  /** Lines in the record files that could not be read, per file. Reading skips them; `superstables doctor` reports them. */
  skippedLines(): { file: string; lines: number }[] {
    return RECORD_FILES.map((file) => ({ file, lines: readRows(this.path(file)).skipped })).filter((f) => f.lines > 0);
  }
}

/**
 * Reads a file into "latest row per id". A half-written last line (a crash mid-append,
 * a truncated copy) is skipped rather than allowed to hide every record behind it, and counted (skippedLines).
 */
function readRows<T extends Identified>(path: string): { rows: Map<string, T>; skipped: number } {
  const rows = new Map<string, T>();
  let skipped = 0;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rows, skipped };
    throw err;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: T;
    try {
      row = JSON.parse(line) as T;
    } catch {
      skipped++; // a torn line: skip it, keep reading
      continue;
    }
    if (row && typeof row.id === "string") rows.set(row.id, row);
    else skipped++;
  }
  return { rows, skipped };
}

function rowsById<T extends Identified>(path: string): Map<string, T> {
  return readRows<T>(path).rows;
}

/** A claim's file name: a hash of the quote id, so no id can name a path. */
/** A file name for a record id: its hash, so no id can name a path. */
function claimName(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** True for an empty or missing file too: there is nothing to continue. */
function endsWithNewline(path: string): boolean {
  let fd: number | undefined;
  try {
    const { size } = statSync(path);
    if (size === 0) return true;
    fd = openSync(path, "r");
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function newestFirst<T>(rows: Map<string, T>, at: (row: T) => string | undefined, limit?: number): T[] {
  const all = [...rows.values()].sort((a, b) => (at(b) ?? "").localeCompare(at(a) ?? ""));
  return limit === undefined ? all : all.slice(0, Math.max(0, limit));
}

/** Makes a records folder private; a folder created now is flushed into its parent. */
function privateDir(path: string): void {
  for (const made of ensurePrivateDir(path, { root: homeDir() })) syncDirectory(dirname(made));
}

/** writeSync may write less than asked; keep going, and throw when no progress is made. */
function writeAllSync(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length; ) {
    const n = writeSync(fd, bytes, at, bytes.length - at);
    if (!(n > 0)) throw new Error(`short write: ${at} of ${bytes.length} bytes`);
    at += n;
  }
}
