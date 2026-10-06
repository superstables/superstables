// The local ledger. Everything the client learns is written here as append-only JSONL:
// one file per kind, one JSON object per line, newest line for an id wins. Append-only
// because a payment record must never be quietly rewritten: a correction is a new line,
// and the whole history stays readable with `tail`. The files hold no key and no secret,
// but they do say what was bought and for how much, so they are created 0600.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { networkFor } from "./chain.js";
import { ensureDir, recordsDir } from "./home.js";
import { capUnit, round6 } from "./policy.js";
import type { Attempt, Quote, Receipt } from "./types.js";

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
  if ((attempt.paymentIncluded || attempt.chain === "verified") && attempt.chainFinal !== true && attempt.chain !== "unpaid") return true;
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

  saveAttempt(attempt: Attempt): Attempt {
    const normalized = { ...attempt, chainFinal: attempt.chainFinal ?? null };
    this.append("attempts.jsonl", normalized);
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, claimName(quoteId));
    try {
      writeFileSync(path, attemptId, { flag: "wx", mode: FILE_MODE });
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return "";
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

  /** Other attempts that recorded this Tempo memo: each may have paid with it, or still may. */
  attemptsWithMemo(memo: string, exclude?: string): Attempt[] {
    const wanted = memo.toLowerCase();
    return [...this.byId<Attempt>("attempts.jsonl").values()].filter((a) => a.id !== exclude && a.paymentMemo?.toLowerCase() === wanted);
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${claimName(receipt.id)}.json`);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { flag: "wx", mode: FILE_MODE });
    renameSync(temporary, path);
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
   * What counts toward the daily cap on the UTC day of `now`, in one asset's unit: the US dollar stablecoins (USDC on
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
   */
  spentToday(asset: string, now: Date = new Date(), options: { exclude?: string } = {}): number {
    const day = now.toISOString().slice(0, 10);
    const wanted = capUnit(asset);
    // Attempts first, then receipts: see above.
    const attempts = this.byId<Attempt>("attempts.jsonl");
    const receipts = this.byId<Receipt>("receipts.jsonl");
    let total = 0;
    for (const receipt of receipts.values()) {
      if (!receipt.at?.startsWith(day)) continue;
      // The chain showed the seller's report was wrong: nothing was paid, and nothing can be.
      if (receipt.chain === "unpaid") continue;
      if (capUnit(receipt.terms?.asset ?? "") !== wanted) continue;
      total += receipt.terms.amountDecimal;
    }
    for (const attempt of attempts.values()) {
      if (attempt.id === options.exclude) continue;
      if (capUnit(attempt.terms?.asset ?? "") !== wanted) continue;
      const receipt = receipts.get(attempt.receiptId ?? attempt.id) ?? receipts.get(attempt.id);
      if (receipt) {
        // One payment: counted through its receipt on the receipt's day. A receipt the chain has not confirmed (the
        // seller's word) or has contradicted leaves the payment unresolved: it keeps counting on later days, once, while it
        // can still move money, as an unresolved attempt without a receipt would. An attempt with final chain evidence is resolved,
        // whatever an older receipt line says.
        if (receipt.at?.startsWith(day) || attempt.chainFinal === true || receipt.chainFinal === true || receipt.chain === "unpaid") continue;
        if (attempt.state !== "failed" && mayStillMove(attempt, now) === true) total += attempt.terms.amountDecimal;
        continue;
      }
      if (countsOn(attempt, now, day)) total += attempt.terms.amountDecimal;
    }
    return round6(total);
  }

  // ── The append-only file itself ──────────────────────────────────────────────────────

  private path(file: string): string {
    return join(this.dir, file);
  }

  private append(file: string, row: Identified): void {
    ensureDir(this.dir);
    const path = this.path(file);
    // If the last write was cut short (a crash, a full disk), start a new line rather than
    // gluing this record onto the broken one — then only the torn line is ever lost.
    const prefix = endsWithNewline(path) ? "" : "\n";
    appendFileSync(path, `${prefix}${JSON.stringify(row)}\n`, { mode: FILE_MODE });
  }

  /**
   * Reads a file into "latest row per id". A half-written last line (a crash mid-append,
   * a truncated copy) is skipped rather than allowed to hide every record behind it.
   */
  private byId<T extends Identified>(file: string): Map<string, T> {
    const rows = new Map<string, T>();
    let text: string;
    try {
      text = readFileSync(this.path(file), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return rows;
      throw err;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: T;
      try {
        row = JSON.parse(line) as T;
      } catch {
        continue; // a torn line: skip it, keep reading
      }
      if (row && typeof row.id === "string") {
        if (file === "attempts.jsonl" || file === "receipts.jsonl") {
          row = { chainFinal: null, ...row };
        }
        rows.set(row.id, row);
      }
    }
    return rows;
  }
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
