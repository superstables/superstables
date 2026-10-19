// Today's spending, summed from the wallet's audit log text: pure, so it is tested without a server.

import { describe, expect, it } from "vitest";
import { spentTodayFromAudit } from "../../src/wallet/audit-total.js";

const TODAY = "2026-10-16";
const BASE = "eip155:84532";
const decimalsOf = (caip2: string): number | undefined => (caip2 === BASE ? 6 : caip2 === "eip155:18" ? 18 : undefined);

const line = (id: string, status: string, over: Record<string, unknown> = {}, at = `${TODAY}T10:00:00.000Z`): string =>
  JSON.stringify({ at, id, status, verified: { asset: "USDC", amountAtomic: "40000", network: BASE, ...over } });
const log = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("spentTodayFromAudit", () => {
  it("counts an approved then signed request once", () => {
    expect(spentTodayFromAudit(log(line("a", "pending"), line("a", "approved"), line("a", "signed")), "USDC", TODAY, decimalsOf)).toEqual({ total: 40000n });
  });

  it("does not count pending lines", () => {
    expect(spentTodayFromAudit(log(line("a", "pending")), "USDC", TODAY, decimalsOf)).toEqual({ total: 0n });
  });

  it("does not count yesterday's lines", () => {
    expect(spentTodayFromAudit(log(line("a", "signed", {}, "2026-10-15T23:59:59.000Z")), "USDC", TODAY, decimalsOf)).toEqual({ total: 0n });
  });

  it("counts USDC and USDG together, and an unknown asset on its own", () => {
    const text = log(line("a", "signed"), line("b", "signed", { asset: "USDG" }), line("c", "signed", { asset: "FOO" }));
    expect(spentTodayFromAudit(text, "USDC", TODAY, decimalsOf)).toEqual({ total: 80000n });
    expect(spentTodayFromAudit(text, "FOO", TODAY, decimalsOf)).toEqual({ total: 40000n });
  });

  it("treats a line that is not JSON as an unknown total", () => {
    const out = spentTodayFromAudit(`${line("a", "signed")}\n{nope\n`, "USDC", TODAY, decimalsOf);
    expect(out).toMatchObject({ problem: expect.stringMatching(/line 2 .*not JSON/) });
  });

  it("treats a counted line with an amount it cannot read as an unknown total", () => {
    expect(spentTodayFromAudit(log(line("a", "signed", { amountAtomic: "1e3" })), "USDC", TODAY, decimalsOf)).toHaveProperty("problem");
    expect(spentTodayFromAudit(log(line("a", "signed", { network: "eip155:1" })), "USDC", TODAY, decimalsOf)).toHaveProperty("problem");
  });

  it("rounds a high-decimal token up into millionths", () => {
    expect(spentTodayFromAudit(log(line("a", "signed", { network: "eip155:18", amountAtomic: "1000000000000000001" })), "USDC", TODAY, decimalsOf)).toEqual({ total: 1000001n });
  });

  it("does not count an id whose last line is a refusal, even after it was approved", () => {
    expect(spentTodayFromAudit(log(line("a", "approved"), line("a", "rejected")), "USDC", TODAY, decimalsOf)).toEqual({ total: 0n });
  });

  it("sums an amount above 2^53 exactly", () => {
    expect(spentTodayFromAudit(log(line("a", "signed", { amountAtomic: "9007199254740993" })), "USDC", TODAY, decimalsOf)).toEqual({ total: 9007199254740993n });
  });
});
