// The policy exists to be refused by, so what matters is which rule answers first: the
// reason the owner reads must be the real one, not whichever check happened to run last.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountPolicyPath } from "../../src/core/home.js";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  loadOptionalPolicy,
  loadPaymentPolicy,
  loadPolicy,
  parseMoney,
  parsePolicy,
  policyChecks,
  type Policy,
} from "../../src/core/policy.js";

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

  it("refuses when today's spending is unknown", () => {
    const p = policy({ perDay: { amount: 0.001, asset: "USDC" } });
    expect(evaluatePolicy(p, { domain: "x.example.com", amountDecimal: 0.01, asset: "USDC" })).toEqual({
      allowed: false,
      reason: "could not count today's spending; try again (caps.per_day is 0.001 USDC)",
    });
  });
});

describe("the assets pay pays in", () => {
  const payment = { domain: "api.example.com", amountDecimal: 0.01, spentTodayDecimal: 0 };

  it("allows USDC, pathUSD and USDG by default, and refuses any other asset", () => {
    expect(DEFAULT_POLICY.stablecoins).toEqual(["USDC", "pathUSD", "USDG"]);
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "USDC" })).toEqual({ allowed: true });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "pathUSD" })).toEqual({ allowed: true });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "USDG" })).toEqual({ allowed: true });
    expect(evaluatePolicy(DEFAULT_POLICY, { ...payment, asset: "DAI" })).toEqual({ allowed: false, reason: "DAI is not in the policy's stablecoin list [USDC, pathUSD, USDG]" });
  });

  it("holds pathUSD and USDG to the same caps as USDC, as dollars", () => {
    const capped = { ...DEFAULT_POLICY, perCall: { amount: 0.05, asset: "USDC" }, perDay: { amount: 1, asset: "USDC" } };
    expect(evaluatePolicy(capped, { ...payment, asset: "pathUSD", amountDecimal: 0.06 }).reason).toBe("0.06 pathUSD exceeds caps.per_call (0.05 USDC)");
    expect(evaluatePolicy(capped, { ...payment, asset: "pathUSD", spentTodayDecimal: 0.995 }).reason).toContain("caps.per_day");
    expect(evaluatePolicy(capped, { ...payment, asset: "USDG", amountDecimal: 0.06 }).reason).toBe("0.06 USDG exceeds caps.per_call (0.05 USDC)");
    expect(evaluatePolicy(capped, { ...payment, asset: "USDG", spentTodayDecimal: 0.995 }).reason).toContain("caps.per_day");
  });

  it("refuses pathUSD when the owner's file lists USDC only, and reads the list in any letter case", () => {
    const usdcOnly = parsePolicy("stablecoins: [usdc]\n");
    expect(usdcOnly.stablecoins).toEqual(["USDC"]);
    expect(evaluatePolicy(usdcOnly, { ...payment, asset: "pathUSD" }).reason).toBe("pathUSD is not in the policy's stablecoin list [USDC]");
    expect(parsePolicy("stablecoins: [USDC, PATHUSD, eurc]\n").stablecoins).toEqual(["USDC", "pathUSD", "EURC"]);
    expect(evaluatePolicy(parsePolicy("stablecoins: [usdc, pathusd]\n"), { ...payment, asset: "pathUSD" }).allowed).toBe(true);
    // A file that names no list gets the default.
    expect(parsePolicy("caps:\n  per_call: 0.02 USDC\n").stablecoins).toEqual(["USDC", "pathUSD", "USDG"]);
  });
});

describe("parsePolicy", () => {
  it("reads the documented file", () => {
    const p = parsePolicy(`caps:\n  per_call: 0.02 USDC\n  per_day: 0.5 USDC\ndeny: ["*.example.net"]\n`);
    expect(p.perCall).toEqual({ amount: 0.02, asset: "USDC", atomic: "20000" });
    expect(p.perDay).toEqual({ amount: 0.5, asset: "USDC", atomic: "500000" });
    expect(p.deny).toEqual(["*.example.net"]);
    expect(p.approval).toBe("ask-every-payment");
  });

  it("refuses an approval mode this release does not have", () => {
    expect(() => parsePolicy("approval: auto\n")).toThrow(/not supported in this release/);
  });

  it("reads an amount with or without an asset", () => {
    expect(parseMoney("0.25")).toEqual({ amount: 0.25, asset: "USDC", atomic: "250000" });
    expect(parseMoney("1 EURC")).toEqual({ amount: 1, asset: "EURC", atomic: "1000000" });
    expect(() => parseMoney("free")).toThrow();
  });
});

describe("parsePolicy, strictly", () => {
  it("reads an empty document as the defaults, never as no limits", () => {
    for (const text of ["", "# only a comment\n", "~\n"]) {
      const p = parsePolicy(text);
      expect(p.perCall, JSON.stringify(text)).toEqual(DEFAULT_POLICY.perCall);
      expect(p.perDay).toEqual(DEFAULT_POLICY.perDay);
      expect(p.killSwitch).toBe(false);
      expect(p.allow).toEqual([]);
      expect(p.stablecoins).toEqual(DEFAULT_POLICY.stablecoins);
    }
  });

  it("fills a cap the file does not set from the defaults", () => {
    const p = parsePolicy("caps:\n  per_call: 0.02\n");
    expect(p.perCall).toEqual({ amount: 0.02, asset: "USDC", atomic: "20000" });
    expect(p.perDay).toEqual(DEFAULT_POLICY.perDay);
    expect(parsePolicy("caps:\n  per_day: 5 USDC\n").perCall).toEqual(DEFAULT_POLICY.perCall);
    expect(parsePolicy("caps:\n  per_call:\n  per_day:\n").perDay).toEqual(DEFAULT_POLICY.perDay);
    expect(parsePolicy("caps:\n").perCall).toEqual(DEFAULT_POLICY.perCall);
  });

  it("refuses what it cannot read as written, and names the key", () => {
    const refused: [string, RegExp][] = [
      ["kill_switch: yes\n", /kill_switch must be true or false/],
      ['kill_switch: "true"\n', /kill_switch must be true or false/],
      ["kill_switch: 1\n", /kill_switch must be true or false/],
      ["kill_switch:\n", /kill_switch must be true or false/],
      ["allow: seller.example\n", /allow must be a list of host names/],
      ["deny: 3\n", /deny must be a list of host names/],
      ["deny: [a, 3]\n", /deny must be a list of host names/],
      ["allow: ['']\n", /allow must be a list of host names/],
      ["stablecoins: USDC\n", /stablecoins must be a list/],
      ["kill_swtich: true\n", /unknown key "kill_swtich"/],
      ["caps:\n  per_week: 1\n", /unknown cap "per_week"/],
      ["caps: 1\n", /caps must be a mapping/],
      ["caps: [1]\n", /caps must be a mapping/],
      ["- a\n", /the policy must be a YAML mapping/],
      ["just words\n", /the policy must be a YAML mapping/],
      ["3\n", /the policy must be a YAML mapping/],
      ["caps:\n  per_call: -1\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_day: 1e3 USDC\n", /caps\.per_day: not an amount/],
      ["caps:\n  per_call: Infinity\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_call: .inf\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_call: 0x10 USDC\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_call: 0.05 USDC extra\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_call: [1]\n", /caps\.per_call: not an amount/],
      ["caps:\n  per_call: true\n", /caps\.per_call: not an amount/],
      ["kill_switch: true\nkill_switch: false\n", /./],
    ];
    for (const [text, message] of refused) {
      expect(() => parsePolicy(text), JSON.stringify(text)).toThrow(message);
    }
  });

  it("keeps the amounts it always read", () => {
    expect(parsePolicy("caps:\n  per_call: 0,02 USDC\n").perCall).toEqual({ amount: 0.02, asset: "USDC", atomic: "20000" });
    expect(parsePolicy("caps:\n  per_call: 0\n").perCall).toEqual({ amount: 0, asset: "USDC", atomic: "0" });
    expect(parsePolicy("kill_switch: true\n").killSwitch).toBe(true);
    expect(parsePolicy("kill_switch: false\n").killSwitch).toBe(false);
  });

  it("rejects an amount that is not an amount", () => {
    for (const bad of ["-1", "1e3", "Infinity", "NaN", "0x10", "0.05 USDC extra", "1 U$DC", "1 TOOLONGASSETNAMES", ""]) {
      expect(() => parseMoney(bad), bad).toThrow(/not an amount/);
    }
  });

  it("does not repeat a hostile key whole", () => {
    expect(() => parsePolicy(`"${"x".repeat(200)}": 1\n`)).toThrow(/unknown key "x{40}"/);
  });
});

describe("host rules and the trailing dot", () => {
  const payment = { amountDecimal: 0.01, asset: "USDC", spentTodayDecimal: 0 };

  it("refuses a name on the deny list however it is written", () => {
    const denied = policy({ deny: ["seller.example"] });
    for (const domain of ["seller.example", "seller.example.", "SELLER.EXAMPLE.", "Seller.Example"]) {
      expect(evaluatePolicy(denied, { ...payment, domain }).allowed, domain).toBe(false);
    }
    expect(evaluatePolicy(policy({ deny: ["seller.example."] }), { ...payment, domain: "seller.example" }).allowed).toBe(false);
    expect(evaluatePolicy(denied, { ...payment, domain: "other.example." }).allowed).toBe(true);
  });

  it("admits a name on the allow list with a trailing dot on the rule", () => {
    const allowed = policy({ allow: ["*.example.com."] });
    expect(evaluatePolicy(allowed, { ...payment, domain: "a.example.com" }).allowed).toBe(true);
    expect(evaluatePolicy(allowed, { ...payment, domain: "a.example.com." }).allowed).toBe(true);
    expect(evaluatePolicy(allowed, { ...payment, domain: "example.com" }).allowed).toBe(true);
    expect(evaluatePolicy(allowed, { ...payment, domain: "a.example.net" }).allowed).toBe(false);
  });
});

describe("loadPolicy and loadPaymentPolicy", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superstables-policy-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const payment = { domain: "api.example.com", amountDecimal: 1, asset: "USDC", spentTodayDecimal: 0 };

  it("says which file cannot be used, and that nothing is paid until it is fixed", () => {
    const bad = file("bad.yaml", "kill_switch: yes\n");
    expect(() => loadPolicy(bad)).toThrow(`the spend policy ${bad} cannot be used: kill_switch must be true or false. Fix the file; until then nothing is paid`);
    expect(loadPolicy(join(dir, "missing.yaml"))).toEqual(DEFAULT_POLICY);
    expect(() => loadPolicy(dir)).toThrow(/cannot be used/);
  });

  it("applies the account's kill switch whatever the selected policy says", () => {
    const account = file("account.yaml", "kill_switch: true\n");
    const selected = file("selected.yaml", "");
    const loaded = loadPaymentPolicy(selected, account);
    expect(loaded.also?.file).toBe(account);
    const verdict = evaluatePolicy(loaded, { ...payment, amountDecimal: 0.01 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe(`kill_switch is on (in ${account})`);
    const checks = policyChecks(loaded, { ...payment, amountDecimal: 0.01 });
    expect(checks.some((c) => c.rule === "kill_switch" && !c.ok && c.detail.startsWith(`${account}: `))).toBe(true);
  });

  it("holds a payment to the tighter of the two files", () => {
    const account = file("account.yaml", "caps:\n  per_call: 0.05 USDC\n");
    const selected = file("selected.yaml", "caps:\n  per_call: 100 USDC\n  per_day: 100 USDC\n");
    const loaded = loadPaymentPolicy(selected, account);
    expect(evaluatePolicy(loaded, payment).reason).toBe(`1 USDC exceeds caps.per_call (0.05 USDC) (in ${account})`);
    expect(evaluatePolicy(loaded, { ...payment, amountDecimal: 0.01 }).allowed).toBe(true);
    expect(evaluatePolicy(policy({ perCall: { amount: 0.005, asset: "USDC" }, also: loaded.also }), { ...payment, amountDecimal: 0.01 }).allowed).toBe(false);
  });

  it("has no second file when the account's is the selected one or does not exist", () => {
    const account = file("account.yaml", "kill_switch: true\n");
    expect(loadPaymentPolicy(account, account).also).toBeUndefined();
    expect(loadPaymentPolicy(join(dir, "./account.yaml"), account).also).toBeUndefined();
    expect(loadPaymentPolicy(account, join(dir, "missing.yaml")).also).toBeUndefined();
  });

  it("refuses everything when the account's file cannot be used", () => {
    const account = file("account.yaml", "kill_switch: maybe\n");
    const selected = file("selected.yaml", "");
    expect(() => loadPaymentPolicy(selected, account)).toThrow(/cannot be used: kill_switch must be true or false/);
  });

  // Root bypasses file modes, so the closed directory cannot be shown there.
  it.skipIf(process.getuid?.() === 0)("refuses everything when the account's file is behind a directory this process may not enter", () => {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    const account = join(closed, "policy.yaml");
    writeFileSync(account, "kill_switch: true\n");
    const selected = file("selected.yaml", "caps:\n  per_call: 100 USDC\n  per_day: 100 USDC\n");
    chmodSync(closed, 0o000);
    try {
      expect(() => loadPaymentPolicy(selected, account)).toThrow(/cannot be used: EACCES/);
      expect(() => loadPaymentPolicy(selected, account)).toThrow(/until then nothing is paid/);
      expect(() => loadOptionalPolicy(account)).toThrow(/cannot be used/);
    } finally {
      chmodSync(closed, 0o700);
    }
  });

  it("skips an account file only when it is genuinely absent, and refuses on a path through a file", () => {
    const selected = file("selected.yaml", "");
    expect(loadOptionalPolicy(join(dir, "missing.yaml"))).toBeUndefined();
    expect(loadPaymentPolicy(selected, join(dir, "no-dir", "policy.yaml")).also).toBeUndefined();
    // ~/.superstables replaced by a file: not taken for "no account policy".
    const blocker = file("blocker", "not a directory");
    expect(() => loadPaymentPolicy(selected, join(blocker, "policy.yaml"))).toThrow(/cannot be used: ENOTDIR/);
  });

  it("finds the account's file from the system's record of the home, not from $HOME", () => {
    const before = process.env.HOME;
    try {
      process.env.HOME = join(dir, "elsewhere");
      expect(accountPolicyPath()).not.toContain("elsewhere");
      expect(accountPolicyPath().endsWith(join(".superstables", "policy.yaml"))).toBe(true);
    } finally {
      if (before === undefined) delete process.env.HOME;
      else process.env.HOME = before;
    }
  });
});
