// The policy exists to be refused by, so what matters is which rule answers first: the
// reason the owner reads must be the real one, not whichever check happened to run last.

import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy, parseMoney, parsePolicy, type Policy } from "../../src/core/policy.js";

const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

describe("evaluatePolicy", () => {
  const payment = { domain: "api.example.com", amountDecimal: 0.01, asset: "USDC", spentTodayDecimal: 0 };

  it("allows an ordinary payment under the caps", () => {
    expect(evaluatePolicy(policy(), payment)).toEqual({ allowed: true });
  });

  it("answers with the first rule that refuses, in order", () => {
    // kill switch beats everything, including a deny list that would also refuse.
    const everything = policy({
      killSwitch: true,
      deny: ["api.example.com"],
      allow: ["other.example.com"],
      stablecoins: ["EURC"],
      perCall: { amount: 0, asset: "USDC" },
    });
    expect(evaluatePolicy(everything, payment).reason).toBe("kill_switch is on");

    const denied = policy({ ...everything, killSwitch: false });
    expect(evaluatePolicy(denied, payment).reason).toContain("deny list");

    const notAllowed = policy({ allow: ["other.example.com"], stablecoins: ["EURC"] });
    expect(evaluatePolicy(notAllowed, payment).reason).toContain("not on the allow list");

    const wrongAsset = policy({ stablecoins: ["EURC"], perCall: { amount: 0, asset: "USDC" } });
    expect(evaluatePolicy(wrongAsset, payment).reason).toContain("stablecoin list");

    const tooBig = policy({ perCall: { amount: 0.005, asset: "USDC" } });
    expect(evaluatePolicy(tooBig, payment).reason).toContain("caps.per_call");
  });

  it("matches a wildcard against the domain and its subdomains", () => {
    const denied = policy({ deny: ["*.example.com"] });
    expect(evaluatePolicy(denied, payment).allowed).toBe(false);
    expect(evaluatePolicy(denied, { ...payment, domain: "example.com" }).allowed).toBe(false);
    expect(evaluatePolicy(denied, { ...payment, domain: "example.net" }).allowed).toBe(true);
  });

  it("refuses when today's spending plus this payment passes the daily cap", () => {
    const p = policy({ perDay: { amount: 1, asset: "USDC" } });
    expect(evaluatePolicy(p, { ...payment, spentTodayDecimal: 0.98 }).allowed).toBe(true);
    const verdict = evaluatePolicy(p, { ...payment, spentTodayDecimal: 0.995 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("caps.per_day");
  });

  it("does not guess at the daily total when it is unknown", () => {
    const p = policy({ perDay: { amount: 0.001, asset: "USDC" } });
    expect(evaluatePolicy(p, { domain: "x.example.com", amountDecimal: 0.01, asset: "USDC" }).allowed).toBe(true);
  });
});

describe("the assets pay pays in", () => {
  const payment = { domain: "api.example.com", amountDecimal: 0.01, spentTodayDecimal: 0 };

  it("allows USDC and pathUSD by default, and refuses any other asset", () => {
    expect(DEFAULT_POLICY.stablecoins).toEqual(["USDC", "pathUSD"]);
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "USDC" })).toEqual({ allowed: true });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "pathUSD" })).toEqual({ allowed: true });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "DAI" })).toEqual({ allowed: false, reason: "DAI is not in the policy's stablecoin list [USDC, pathUSD]" });
  });

  it("holds pathUSD to the same caps as USDC, as dollars", () => {
    const capped = { ...DEFAULT_POLICY, perCall: { amount: 0.05, asset: "USDC" }, perDay: { amount: 1, asset: "USDC" } };
    expect(evaluatePolicy(capped, { ...payment, asset: "pathUSD", amountDecimal: 0.06 }).reason).toBe("0.06 pathUSD exceeds caps.per_call (0.05 USDC)");
    expect(evaluatePolicy(capped, { ...payment, asset: "pathUSD", spentTodayDecimal: 0.995 }).reason).toContain("caps.per_day");
  });

  it("refuses pathUSD when the owner's file lists USDC only, and reads the list in any letter case", () => {
    const usdcOnly = parsePolicy("stablecoins: [usdc]\n");
    expect(usdcOnly.stablecoins).toEqual(["USDC"]);
    expect(evaluatePolicy(usdcOnly, { ...payment, asset: "pathUSD" }).reason).toBe("pathUSD is not in the policy's stablecoin list [USDC]");
    expect(parsePolicy("stablecoins: [USDC, PATHUSD, eurc]\n").stablecoins).toEqual(["USDC", "pathUSD", "EURC"]);
    expect(evaluatePolicy(parsePolicy("stablecoins: [usdc, pathusd]\n"), { ...payment, asset: "pathUSD" }).allowed).toBe(true);
    // A file that names no list gets the default.
    expect(parsePolicy("caps:\n  per_call: 0.02 USDC\n").stablecoins).toEqual(["USDC", "pathUSD"]);
  });
});

describe("parsePolicy", () => {
  it("reads the documented file", () => {
    const p = parsePolicy(`caps:\n  per_call: 0.02 USDC\n  per_day: 0.5 USDC\ndeny: ["*.example.net"]\n`);
    expect(p.perCall).toEqual({ amount: 0.02, asset: "USDC" });
    expect(p.perDay).toEqual({ amount: 0.5, asset: "USDC" });
    expect(p.deny).toEqual(["*.example.net"]);
    expect(p.approval).toBe("ask-every-payment");
  });

  it("refuses an approval mode this release does not have", () => {
    expect(() => parsePolicy("approval: auto\n")).toThrow(/not supported in this release/);
  });

  it("reads an amount with or without an asset", () => {
    expect(parseMoney("0.25")).toEqual({ amount: 0.25, asset: "USDC" });
    expect(parseMoney("1 EURC")).toEqual({ amount: 1, asset: "EURC" });
    expect(() => parseMoney("free")).toThrow();
  });
});
