// The ledger must never lose a record and never silently change one. These tests pin the
// two properties the rest of the client leans on: the newest line for an id wins, and a
// half-written line does not take the rest of the file down with it.

import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Records } from "../../src/core/records.js";
import type { Attempt, PaymentTerms, Quote, Receipt } from "../../src/core/types.js";

const dirs: string[] = [];

function records(): Records {
  const dir = mkdtempSync(join(tmpdir(), "superstables-records-"));
  dirs.push(dir);
  return new Records(dir);
}

const terms = (amountDecimal = 0.01, asset = "USDC"): PaymentTerms => ({
  amountDecimal,
  amountAtomic: String(Math.round(amountDecimal * 1e6)),
  asset,
  assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  network: "eip155:84532",
  networkLabel: "Base Sepolia (testnet)",
  recipient: `0x${"22".repeat(20)}`,
  scheme: "exact",
  x402Version: 2,
});

const quote = (id: string, status: Quote["status"] = "open"): Quote => ({
  id,
  createdAt: "2026-01-01T10:00:00.000Z",
  expiresAt: "2026-01-01T10:10:00.000Z",
  status,
  url: "http://127.0.0.1:4402/v1/market?asset=BTC",
  terms: terms(),
  requirement: { scheme: "exact", network: "eip155:84532", asset: terms().assetAddress, amount: "10000", payTo: terms().recipient, maxTimeoutSeconds: 300, extra: {} },
  policy: { allowed: true },
  approval: "wallet",
});

const receipt = (id: string, at: string, amountDecimal: number, asset = "USDC"): Receipt => ({
  id,
  at,
  quoteId: `q-${id}`,
  attemptId: id,
  url: "http://127.0.0.1:4402/v1/market?asset=BTC",
  terms: terms(amountDecimal, asset),
  payer: `0x${"33".repeat(20)}`,
  transaction: `0x${"44".repeat(32)}`,
  transactionKind: "hash",
  transactionUrl: "https://sepolia.basescan.org/tx/0x",
  network: "eip155:84532",
  settlement: { success: true, transaction: `0x${"44".repeat(32)}`, network: "eip155:84532" },
  serviceOutcome: "ok",
  ms: 1200,
});

afterEach(() => {
  dirs.length = 0;
});

describe("Records", () => {
  it("round-trips quotes, attempts and receipts", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    r.saveAttempt({
      id: "a1",
      quoteId: "q1",
      createdAt: "2026-01-01T10:00:01.000Z",
      updatedAt: "2026-01-01T10:00:01.000Z",
      state: "awaiting_approval",
      url: "http://127.0.0.1/x",
      terms: terms(),
      history: [{ at: "2026-01-01T10:00:01.000Z", state: "awaiting_approval" }],
    });
    r.saveReceipt(receipt("a1", "2026-01-01T10:00:09.000Z", 0.01));

    expect(r.getQuote("q1")?.status).toBe("open");
    expect(r.getAttempt("a1")?.state).toBe("awaiting_approval");
    expect(r.getReceipt("a1")?.terms.amountDecimal).toBe(0.01);
    expect(r.listQuotes()).toHaveLength(1);
    expect(r.listAttempts()).toHaveLength(1);
    expect(r.listReceipts(1)).toHaveLength(1);
    expect(r.getQuote("nope")).toBeUndefined();
  });

  it("keeps every line but answers with the latest one for an id", () => {
    const r = records();
    r.saveQuote(quote("q1", "open"));
    r.saveQuote(quote("q1", "used"));
    r.saveQuote(quote("q2", "open"));

    expect(r.getQuote("q1")?.status).toBe("used");
    expect(r.listQuotes()).toHaveLength(2);
    // Append-only: the superseded line is still on disk.
    const lines = readFileSync(join(r.dir, "quotes.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("creates its files readable by their owner only", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    expect(statSync(join(r.dir, "quotes.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("skips a torn line instead of failing the whole read", () => {
    const r = records();
    r.saveQuote(quote("q1"));
    appendFileSync(join(r.dir, "quotes.jsonl"), '{"id":"q2","status":"op');
    r.saveQuote(quote("q3"));

    expect(r.listQuotes().map((q) => q.id).sort()).toEqual(["q1", "q3"]);
  });

  it("sums today's payments per asset, ignoring other days and other assets", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:00.000Z", 0.01));
    r.saveReceipt(receipt("r2", "2026-03-04T09:30:00.000Z", 0.025));
    r.saveReceipt(receipt("r3", "2026-03-03T23:59:59.000Z", 5)); // yesterday
    r.saveReceipt(receipt("r4", "2026-03-04T10:00:00.000Z", 7, "EURC")); // another asset

    expect(r.spentToday("USDC", now)).toBe(0.035);
    expect(r.spentToday("usdc", now)).toBe(0.035);
    expect(r.spentToday("EURC", now)).toBe(7);
    expect(r.spentToday("USDC", new Date("2026-03-05T00:00:01.000Z"))).toBe(0);
  });

  it("counts a corrected receipt once", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:00.000Z", 0.01));
    r.saveReceipt(receipt("r1", "2026-03-04T08:00:05.000Z", 0.02));
    expect(r.spentToday("USDC", now)).toBe(0.02);
  });

  it("counts an uncertain attempt without a receipt at the time the owner approved it, and one with a receipt once", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    const uncertain = (id: string, approvedAt: string, extra: Partial<Attempt> = {}): Attempt => ({
      id,
      quoteId: `q-${id}`,
      createdAt: approvedAt,
      updatedAt: approvedAt,
      state: "uncertain",
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [
        { at: approvedAt, state: "awaiting_approval" },
        { at: approvedAt, state: "approved" },
        { at: approvedAt, state: "uncertain" },
      ],
      ...extra,
    });
    r.saveAttempt(uncertain("a1", "2026-03-04T08:00:00.000Z"));
    r.saveAttempt(uncertain("a2", "2026-03-03T08:00:00.000Z")); // yesterday
    r.saveAttempt(uncertain("a3", "2026-03-04T09:00:00.000Z", { receiptId: "a3" }));
    r.saveReceipt(receipt("a3", "2026-03-04T09:00:01.000Z", 0.01));
    r.saveAttempt({ ...uncertain("a4", "2026-03-04T10:00:00.000Z"), state: "failed" }); // nothing signed or sent

    expect(r.spentToday("USDC", now)).toBe(0.02);
  });

  it("counts a signed attempt once as it moves approved, submitting, then settled with a receipt", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    const at = "2026-03-04T08:00:00.000Z";
    const base: Attempt = {
      id: "a1",
      quoteId: "q1",
      createdAt: at,
      updatedAt: at,
      state: "awaiting_approval",
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [{ at, state: "awaiting_approval" }],
    };
    r.saveAttempt(base);
    expect(r.spentToday("USDC", now)).toBe(0); // not signed yet
    const approved = { ...base, state: "approved" as const, history: [...base.history, { at, state: "approved" as const }] };
    r.saveAttempt(approved);
    expect(r.spentToday("USDC", now)).toBe(0.01);
    const submitting = { ...approved, state: "submitting" as const, history: [...approved.history, { at, state: "submitting" as const }] };
    r.saveAttempt(submitting);
    expect(r.spentToday("USDC", now)).toBe(0.01);
    // The receipt is written before the attempt's final state: counted through the receipt, never twice.
    r.saveReceipt(receipt("a1", "2026-03-04T08:00:02.000Z", 0.01));
    expect(r.spentToday("USDC", now)).toBe(0.01);
    r.saveAttempt({ ...submitting, state: "settled", receiptId: "a1" });
    expect(r.spentToday("USDC", now)).toBe(0.01);
    // A record left in flight counts only on the day it was signed.
    expect(r.spentToday("USDC", new Date("2026-03-05T12:00:00.000Z"))).toBe(0);
  });

  it("counts a reservation while its approval window is open, and never with the attempt's signed states", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    const waiting = (id: string, reservedAt?: string, reservedUntil?: string): Attempt => ({
      id,
      quoteId: `q-${id}`,
      createdAt: "2026-03-04T11:59:00.000Z",
      updatedAt: "2026-03-04T11:59:00.000Z",
      state: "awaiting_approval",
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [{ at: "2026-03-04T11:59:00.000Z", state: "awaiting_approval" }],
      ...(reservedAt ? { reservedAt } : {}),
      ...(reservedUntil ? { reservedUntil } : {}),
    });
    r.saveAttempt(waiting("open", "2026-03-04T11:59:00.000Z", "2026-03-04T12:05:00.000Z"));
    r.saveAttempt(waiting("lapsed", "2026-03-04T07:00:00.000Z", "2026-03-04T07:06:00.000Z")); // its process stopped
    r.saveAttempt(waiting("unreserved")); // never got past the gate
    expect(r.spentToday("USDC", now)).toBe(0.01);
    expect(r.spentToday("USDC", now, { exclude: "open" })).toBe(0);
    expect(r.spentToday("USDC", new Date("2026-03-04T12:06:00.000Z"))).toBe(0); // its window ended
    // Signed: counted by its signed state, once.
    const at = "2026-03-04T12:00:30.000Z";
    r.saveAttempt({ ...waiting("open", "2026-03-04T11:59:00.000Z", "2026-03-04T12:05:00.000Z"), state: "approved", history: [{ at, state: "approved" }] });
    expect(r.spentToday("USDC", now)).toBe(0.01);
    // Ended unsigned: released.
    r.saveAttempt({ ...waiting("open", "2026-03-04T11:59:00.000Z", "2026-03-04T12:05:00.000Z"), state: "expired" });
    expect(r.spentToday("USDC", now)).toBe(0);
  });

  it("keeps counting open payments across UTC midnight, and an ended one on the day it ended", () => {
    const r = records();
    const beforeMidnight = new Date("2026-03-04T23:59:00.000Z");
    const afterMidnight = new Date("2026-03-05T00:01:00.000Z");
    const later = new Date("2026-03-07T09:00:00.000Z");
    const base = (id: string, state: Attempt["state"], extra: Partial<Attempt> = {}): Attempt => ({
      id,
      quoteId: `q-${id}`,
      createdAt: "2026-03-04T23:58:00.000Z",
      updatedAt: "2026-03-04T23:58:30.000Z",
      state,
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [
        { at: "2026-03-04T23:58:00.000Z", state: "awaiting_approval" },
        ...(state !== "awaiting_approval" ? [{ at: "2026-03-04T23:58:30.000Z", state: "approved" as const }] : []),
        ...(state === "uncertain" ? [{ at: "2026-03-04T23:58:40.000Z", state: "uncertain" as const }] : []),
      ],
      ...extra,
    });

    // A reservation made at 23:58 with a five-minute window still counts at 00:01, and not once the window has ended.
    r.saveAttempt(base("waiting", "awaiting_approval", { reservedAt: "2026-03-04T23:58:00.000Z", reservedUntil: "2026-03-05T00:04:00.000Z" }));
    expect(r.spentToday("USDC", beforeMidnight)).toBe(0.01);
    expect(r.spentToday("USDC", afterMidnight)).toBe(0.01);
    expect(r.spentToday("USDC", new Date("2026-03-05T00:05:00.000Z"))).toBe(0);
    r.saveAttempt({ ...base("waiting", "expired") });

    // A signed payment still in flight counts on every day until it ends, even if its process stopped.
    r.saveAttempt(base("inflight", "submitting"));
    expect(r.spentToday("USDC", beforeMidnight)).toBe(0.01);
    expect(r.spentToday("USDC", afterMidnight)).toBe(0.01);
    expect(r.spentToday("USDC", later)).toBe(0.01);

    // Once it ends uncertain, it counts on the day it ended only.
    r.saveAttempt(base("inflight", "uncertain"));
    expect(r.spentToday("USDC", beforeMidnight)).toBe(0.01);
    expect(r.spentToday("USDC", afterMidnight)).toBe(0);
  });

  it("counts a signed payment in flight on every day until its authorization expires, then on the day it was signed", () => {
    const r = records();
    const signedAt = "2026-03-04T23:58:00.000Z";
    const inflight = (validBefore?: string): Attempt => ({
      id: "a1",
      quoteId: "q1",
      createdAt: signedAt,
      updatedAt: signedAt,
      state: "submitting",
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [
        { at: signedAt, state: "approved" },
        { at: signedAt, state: "submitting" },
      ],
      ...(validBefore ? { authorizationValidBefore: validBefore } : {}),
    });
    // Signed at 23:58, settleable until 00:03: it counts across midnight while it can still move money.
    r.saveAttempt(inflight("2026-03-05T00:03:00.000Z"));
    expect(r.spentToday("USDC", new Date("2026-03-04T23:59:00.000Z"))).toBe(0.01);
    expect(r.spentToday("USDC", new Date("2026-03-05T00:01:00.000Z"))).toBe(0.01);
    // After validBefore, any money it could move has moved: it counts on the day it was signed only.
    expect(r.spentToday("USDC", new Date("2026-03-05T00:04:00.000Z"))).toBe(0);
    expect(r.spentToday("USDC", new Date("2026-03-04T23:59:30.000Z"))).toBe(0.01);
    expect(r.spentToday("USDC", new Date("2026-03-09T12:00:00.000Z"))).toBe(0);
    // Signed early in a day and expired the same day: still that day.
    r.saveAttempt({ ...inflight("2026-03-05T00:03:00.000Z"), history: [{ at: "2026-03-05T00:00:30.000Z", state: "approved" }] });
    expect(r.spentToday("USDC", new Date("2026-03-05T18:00:00.000Z"))).toBe(0.01);
    // An older record without validBefore keeps counting every day.
    r.saveAttempt(inflight());
    expect(r.spentToday("USDC", new Date("2026-03-09T12:00:00.000Z"))).toBe(0.01);
  });

  it("counts a payment that settles between reading the attempts and reading the receipts, once", () => {
    const r = records();
    const now = new Date("2026-03-04T12:00:00.000Z");
    const at = "2026-03-04T11:00:00.000Z";
    r.saveAttempt({
      id: "a1",
      quoteId: "q1",
      createdAt: at,
      updatedAt: at,
      state: "submitting",
      url: "https://seller.example/x",
      terms: terms(0.01),
      history: [{ at, state: "approved" }, { at, state: "submitting" }],
    });
    // The settlement lands right after the attempts file is read (the receipt is written, then the attempt's end).
    const realRead = (r as unknown as { byId: (file: string) => Map<string, unknown> }).byId.bind(r);
    let settled = false;
    (r as unknown as { byId: (file: string) => Map<string, unknown> }).byId = (file: string) => {
      const rows = realRead(file);
      if (file === "attempts.jsonl" && !settled) {
        settled = true;
        r.saveReceipt(receipt("a1", "2026-03-04T11:00:02.000Z", 0.01));
        r.saveAttempt({ ...(rows.get("a1") as Attempt), state: "settled", receiptId: "a1" });
      }
      return rows;
    };
    expect(r.spentToday("USDC", now)).toBe(0.01);
  });

  it("gives out ids that do not repeat", () => {
    const r = records();
    expect(r.newId()).not.toBe(r.newId());
    expect(r.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
