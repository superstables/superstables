// The local ledger. Everything the client learns is written here as append-only JSONL:
// one file per kind, one JSON object per line, newest line for an id wins. Append-only
// because a payment record must never be quietly rewritten: a correction is a new line,
// and the whole history stays readable with `tail`. The files hold no key and no secret,
// but they do say what was bought and for how much, so they are created 0600.

import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensureDir, recordsDir } from "./home.js";
import { round6 } from "./policy.js";
import type { Attempt, Quote, Receipt } from "./types.js";

/** How long a reservation without a recorded end counts: the longest default approval window, and more. */
const RESERVATION_FALLBACK_MS = 10 * 60_000;

/** Does an attempt without a receipt count toward the cap on `day`, judged at `now`? See Records.spentToday. */
function countsOn(attempt: Attempt, now: Date, day: string): boolean {
  switch (attempt.state) {
    case "approved":
    case "submitting": {
      // Open: counts on every day while the signed authorization can still be settled. After its validBefore it cannot,
      // so it counts on the day it was signed only. Without a recorded validBefore (an older record), every day.
      const validBefore = attempt.authorizationValidBefore ? Date.parse(attempt.authorizationValidBefore) : NaN;
      if (!Number.isFinite(validBefore) || now.getTime() < validBefore) return true;
      const signedAt = attempt.history?.find((h) => h.state === "approved")?.at ?? attempt.updatedAt;
      return typeof signedAt === "string" && signedAt.startsWith(day);
    }
    case "uncertain": {
      const ended = [...(attempt.history ?? [])].reverse().find((h) => h.state === "uncertain")?.at ?? attempt.updatedAt;
      return typeof ended === "string" && ended.startsWith(day);
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
    this.append("attempts.jsonl", attempt);
    return attempt;
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

  // ── Receipts ─────────────────────────────────────────────────────────────────────────

  saveReceipt(receipt: Receipt): Receipt {
    this.append("receipts.jsonl", receipt);
    return receipt;
  }

  getReceipt(id: string): Receipt | undefined {
    return this.byId<Receipt>("receipts.jsonl").get(id);
  }

  listReceipts(limit?: number): Receipt[] {
    return newestFirst(this.byId<Receipt>("receipts.jsonl"), (r) => r.at, limit);
  }

  /**
   * What counts toward the daily cap on the UTC day of `now`, in one asset. One line: a payment counts on the day it
   * ended (a receipt's day, or the day it became uncertain), and on every day while it is still open (signed and in
   * flight, or waiting for the owner within its approval window).
   *
   *   receipt                       on its own day: the seller reported the money moved, and the chain did not contradict it
   *   uncertain, no receipt         on the day it became uncertain: signed, and whether its money moved is unknown
   *   approved / submitting         on every day while its signed authorization can still settle (before validBefore),
   *                                 then on the day it was signed only; every day when validBefore is not recorded
   *   awaiting_approval, reserved   on every day until its reservation ends (reservedUntil): the owner may still sign
   *
   * A reservation left by a process that stopped stops counting when its approval window ends; a signed attempt left in
   * flight stops counting on later days once its authorization has expired. Each payment counts once: an attempt with a receipt counts only through the
   * receipt. Attempts are read before receipts, so a payment that settles between the two reads is still counted, once.
   * `exclude` leaves out one attempt: the one being checked against the cap.
   * This is the number the per-day cap is checked against; it is a local figure, not a
   * chain balance, and it says so wherever it is shown.
   */
  spentToday(asset: string, now: Date = new Date(), options: { exclude?: string } = {}): number {
    const day = now.toISOString().slice(0, 10);
    const wanted = asset.toUpperCase();
    // Attempts first, then receipts: see above.
    const attempts = this.byId<Attempt>("attempts.jsonl");
    const receipts = this.byId<Receipt>("receipts.jsonl");
    let total = 0;
    for (const receipt of receipts.values()) {
      if (!receipt.at?.startsWith(day)) continue;
      if ((receipt.terms?.asset ?? "").toUpperCase() !== wanted) continue;
      total += receipt.terms.amountDecimal;
    }
    for (const attempt of attempts.values()) {
      if (attempt.id === options.exclude) continue;
      if (receipts.has(attempt.id) || (attempt.receiptId && receipts.has(attempt.receiptId))) continue;
      if ((attempt.terms?.asset ?? "").toUpperCase() !== wanted) continue;
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
      if (row && typeof row.id === "string") rows.set(row.id, row);
    }
    return rows;
  }
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
