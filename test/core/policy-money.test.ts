// Spend limits are compared as whole numbers of the token's smallest unit, and a cap is read as the owner wrote it.
// Floating point turned "exactly at the daily cap" into "over it" (0.2 + 0.1 > 0.3), let a payment one unit over a
// large cap through, and read 0x10 as sixteen dollars. These tests hold the comparison, the cap parser, the daily
// total and the three places that apply the policy (quote, pay and the browser signer) to exact arithmetic.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fromAtomicString, toAtomicExact, usdcRequirement } from "../../src/core/chain.js";
import {
  CAP_DECIMALS,
  DEFAULT_POLICY,
  capUnits,
  evaluatePolicy,
  formatMoney,
  parseMoney,
  parsePolicy,
  loadPaymentPolicy,
  policyAmount,
  policyChecks,
  type Policy,
} from "../../src/core/policy.js";
import * as sdk from "../../src/index.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SignRefused } from "../../src/core/signer/types.js";
import type { PaymentTerms, Receipt } from "../../src/core/types.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { writeFileSync } from "node:fs";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "../helpers/servers.js";

const open: TestServer[] = [];
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SELLER = privateKeyToAccount(generatePrivateKey()).address;

const terms = (amountAtomic: string | undefined, over: Partial<PaymentTerms> = {}): PaymentTerms => {
  const t: PaymentTerms = {
    amountDecimal: amountAtomic !== undefined && /^\d+$/.test(amountAtomic) ? Number(amountAtomic) / 1e6 : (undefined as unknown as number),
    amountAtomic: amountAtomic as string,
    asset: "USDC",
    assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    network: "eip155:84532",
    networkLabel: "Base Sepolia (testnet)",
    recipient: `0x${"22".repeat(20)}`,
    scheme: "exact",
    x402Version: 2,
    ...over,
  };
  if (amountAtomic === undefined) delete (t as Partial<PaymentTerms>).amountAtomic;
  return t;
};

const receipt = (id: string, amountAtomic: string | undefined, over: Partial<Receipt> = {}, termsOver: Partial<PaymentTerms> = {}): Receipt => ({
  id,
  at: new Date().toISOString(),
  quoteId: `q-${id}`,
  attemptId: id,
  url: "http://127.0.0.1:4402/v1/market?asset=BTC",
  terms: terms(amountAtomic, termsOver),
  payer: `0x${"33".repeat(20)}`,
  transaction: `0x${"44".repeat(32)}`,
  transactionKind: "hash",
  transactionUrl: "https://sepolia.basescan.org/tx/0x",
  network: "eip155:84532",
  settlement: { success: true, transaction: `0x${"44".repeat(32)}`, network: "eip155:84532" },
  serviceOutcome: "ok",
  ms: 1,
  ...over,
});

const pay = { domain: "a.example", asset: "USDC" };
const perDayCheck = (p: Policy, a: Parameters<typeof policyChecks>[1]) => policyChecks(p, a).find((c) => c.rule === "caps.per_day");

describe("cap spellings", () => {
  it.each(["0x10", "0o10", "1e3", ".5", "+1", "1.", "0.1234567", "1_000"])("refuses per_call: %s, naming the key", (spelling) => {
    const message = (() => {
      try {
        parsePolicy(`caps:\n  per_call: ${spelling}\n`);
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).toMatch(new RegExp(`caps\\.per_call: not an amount: "${spelling.replace(/[.+]/g, "\\$&")}"`));
    expect(message).toMatch(/write it in decimal notation/);
  });

  it.each([
    ["a merged 0x10", "%YAML 1.1\n---\ncaps:\n  <<: {per_call: 0x10}\n", /caps\.per_call/],
    ["a merged 010", "%YAML 1.1\n---\ncaps:\n  <<: {per_call: 010}\n", /caps\.per_call/],
    ["a merged 1_000", "%YAML 1.1\n---\ncaps:\n  <<: {per_call: 1_000}\n", /caps\.per_call/],
    ["a merged 1.0e+3", "%YAML 1.1\n---\ncaps:\n  <<: {per_call: 1.0e+3}\n", /caps\.per_call/],
    ["a merged plain amount", "%YAML 1.1\n---\ncaps:\n  <<: {per_call: 0.05}\n", /caps\.per_call/],
    ["caps merged in at the top", "%YAML 1.1\n---\n<<: {caps: {per_call: 0x10, per_day: 0x20}}\n", /caps\.per_(call|day)/],
    ["a merged anchor", "%YAML 1.1\n---\ncaps:\n  <<: &m {per_day: 0x10}\n  per_call: 0.01\n", /caps\.per_day/],
  ])("refuses a cap merged in with <<: %s", (_name, text, where) => {
    expect(() => parsePolicy(text)).toThrow(where);
    expect(() => parsePolicy(text)).toThrow(/not merged in with <</);
  });

  it("refuses a whole part too long to be a cap, naming the key", () => {
    // Not "every payment is refused as unreadable" later: the file itself is refused, with the way to write it.
    expect(() => parsePolicy(`caps:\n  per_call: 1${"0".repeat(80)}\n`)).toThrow(/caps\.per_call: not an amount: "1000.*write it in decimal notation/);
  });

  it("refuses the same spellings on per_day", () => {
    expect(() => parsePolicy("caps:\n  per_day: 1e3 USDC\n")).toThrow(/caps\.per_day/);
    expect(() => parsePolicy("caps:\n  per_day: 0x10\n")).toThrow(/caps\.per_day/);
  });

  it("reads an alias as what it names", () => {
    expect(() => parsePolicy("caps:\n  per_call: &c 0x10\n  per_day: *c\n")).toThrow(/not an amount/);
    const p = parsePolicy("caps:\n  per_call: &c 0.05\n  per_day: *c\n");
    expect(p.perCall?.atomic).toBe("50000");
    expect(p.perDay?.atomic).toBe("50000");
  });

  it.each([
    ["0.05", "50000", 0.05],
    ["0.05 USDC", "50000", 0.05],
    [`"0.05 USDC"`, "50000", 0.05],
    [`'0.05'`, "50000", 0.05],
    ["0,05 USDC", "50000", 0.05],
    ["1", "1000000", 1],
    ["010", "10000000", 10],
    ["0.050", "50000", 0.05],
    ["1.0", "1000000", 1],
    ["|\n    0.05", "50000", 0.05],
    ["0.000001", "1", 0.000001],
  ])("reads %s as %s millionths", (written, atomic, amount) => {
    const p = parsePolicy(`caps:\n  per_call: ${written}\n`);
    expect(p.perCall?.atomic).toBe(atomic);
    expect(p.perCall?.amount).toBe(amount);
  });

  it("prints a cap as the shortest decimal", () => {
    expect(formatMoney(parsePolicy("caps:\n  per_call: 0.050 USDC\n").perCall)).toBe("0.05 USDC");
  });
});

describe("parseMoney from numbers", () => {
  it("reads a plain number exactly", () => {
    expect(parseMoney(0.05)).toEqual({ amount: 0.05, asset: "USDC", atomic: "50000" });
  });

  it("refuses a float that is not a decimal with six places", () => {
    expect(() => parseMoney(0.1 + 0.2)).toThrow(/not an amount/);
    expect(() => parseMoney(1e21)).toThrow(/not an amount/);
  });
});

describe("exact at the daily cap", () => {
  const p = parsePolicy("caps:\n  per_call: 5\n  per_day: 0.3\n");

  // The two ways a caller passes the same payment: whole units, and the decimals the daemon passes.
  const forms = (spent: bigint, amount: bigint) => [
    { ...pay, amountAtomic: amount, spentTodayAtomic: spent },
    { ...pay, amountDecimal: Number(amount) / 1e6, spentTodayDecimal: Number(spent) / 1e6 },
  ];

  it("allows a payment that brings the day exactly to the cap", () => {
    for (const a of forms(200000n, 100000n)) {
      expect(evaluatePolicy(p, a)).toEqual({ allowed: true });
      expect(perDayCheck(p, a)).toEqual({
        rule: "caps.per_day",
        ok: true,
        detail: "0.2 USDC paid today (UTC) + this 0.1 = 0.3, at most 0.3 USDC",
      });
    }
  });

  it("refuses one unit over, with the exact figures", () => {
    const expected = { allowed: false, reason: "today's payments (0.2 USDC) plus 0.100001 exceed caps.per_day (0.3 USDC)" };
    for (const a of forms(200000n, 100001n)) expect(evaluatePolicy(p, a)).toEqual(expected);
  });

  it.each([
    [200000n, 100000n, "0.3", "0.2 USDC paid today (UTC) + this 0.1 = 0.3, at most 0.3 USDC"],
    [100000n, 200000n, "0.3", "0.1 USDC paid today (UTC) + this 0.2 = 0.3, at most 0.3 USDC"],
    [1100000n, 2200000n, "3.3", "1.1 USDC paid today (UTC) + this 2.2 = 3.3, at most 3.3 USDC"],
    [280000n, 10000n, "0.29", "0.28 USDC paid today (UTC) + this 0.01 = 0.29, at most 0.29 USDC"],
  ])("allows %s + %s against %s, and the check agrees", (spent, amount, cap, detail) => {
    const q = parsePolicy(`caps:\n  per_call: 50\n  per_day: ${cap}\n`);
    for (const a of forms(spent, amount)) {
      expect(evaluatePolicy(q, a)).toEqual({ allowed: true });
      expect(perDayCheck(q, a)).toEqual({ rule: "caps.per_day", ok: true, detail });
    }
  });
});

describe("the daemon's call, exactly", () => {
  const p = parsePolicy("caps:\n  per_call: 5\n  per_day: 0.3\n");

  it("reads decimal fields exactly at six places", () => {
    expect(evaluatePolicy(p, { domain: "", amountDecimal: 0.1, asset: "USDC", spentTodayDecimal: 0.2 })).toEqual({ allowed: true });
  });

  it("refuses an amount with more than six places, or not a number", () => {
    const unknown = "the payment's amount is not a whole number of the token's smallest units, so the caps cannot be checked";
    expect(evaluatePolicy(p, { domain: "", amountDecimal: 0.1000001, asset: "USDC", spentTodayDecimal: 0 })).toEqual({ allowed: false, reason: unknown });
    expect(evaluatePolicy(p, { domain: "", amountDecimal: NaN, asset: "USDC", spentTodayDecimal: 0 }).allowed).toBe(false);
  });
});

describe("the library daily cap", () => {
  const unknownTotal = "today's spending is unknown, so caps.per_day (1 USDC) cannot be checked";

  it("refuses when caps.per_day is set and no total is given", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, { domain: "api.example.com", amountDecimal: 0.01, asset: "USDC" })).toEqual({ allowed: false, reason: unknownTotal });
    expect(evaluatePolicy(DEFAULT_POLICY, { domain: "api.example.com", amountAtomic: 10000n, asset: "USDC" })).toEqual({ allowed: false, reason: unknownTotal });
  });

  it("does not need a total when there is no daily cap", () => {
    expect(evaluatePolicy({ ...DEFAULT_POLICY, perDay: undefined }, { domain: "api.example.com", amountAtomic: 10000n, asset: "USDC" })).toEqual({ allowed: true });
  });

  it("names the account's file when its policy is the one that refuses", () => {
    const dir = tmp("superstables-policy-money-");
    const own = join(dir, "own.yaml");
    const account = join(dir, "account.yaml");
    writeFileSync(own, "caps:\n  per_call: 5\n");
    writeFileSync(account, "caps:\n  per_call: 5\n  per_day: 2\n");
    const combined = loadPaymentPolicy(own, account);
    const verdict = evaluatePolicy({ ...combined, perDay: undefined, also: combined.also }, { domain: "x.example", amountAtomic: 10000n, asset: "USDC" });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("caps.per_day");
    expect(verdict.reason?.endsWith(` (in ${account})`)).toBe(true);
  });
});

describe("hand-built caps", () => {
  it("reads a cap with no atomic from its amount, exactly", () => {
    const p: Policy = { ...DEFAULT_POLICY, perCall: { amount: 0.001, asset: "USDC" } };
    expect(evaluatePolicy(p, { ...pay, amountAtomic: 10000n, spentTodayAtomic: 0n })).toEqual({
      allowed: false,
      reason: "0.01 USDC exceeds caps.per_call (0.001 USDC)",
    });
  });

  it("refuses a cap whose amount was changed without its atomic value", () => {
    const mismatch = "caps.per_call (0.01 USDC) does not match its atomic value, so it cannot be checked";
    const lowered: Policy = { ...DEFAULT_POLICY, perCall: { ...DEFAULT_POLICY.perCall!, amount: 0.01 } };
    expect(evaluatePolicy(lowered, { ...pay, amountAtomic: 40000n, spentTodayAtomic: 0n })).toEqual({ allowed: false, reason: mismatch });
    expect(policyChecks(lowered, { ...pay, amountAtomic: 40000n, spentTodayAtomic: 0n }).find((c) => c.rule === "caps.per_call")?.ok).toBe(false);
    // The usual way to lower a loaded cap.
    const loaded = parsePolicy("caps:\n  per_call: 1\n");
    loaded.perCall!.amount = 0.01;
    expect(evaluatePolicy(loaded, { ...pay, amountAtomic: 500000n, spentTodayAtomic: 0n }).reason).toBe(mismatch);
    // Dropping atomic is the way to change a cap by hand: it is then read from amount.
    const redone: Policy = { ...DEFAULT_POLICY, perCall: { amount: 0.01, asset: "USDC" } };
    expect(evaluatePolicy(redone, { ...pay, amountAtomic: 40000n, spentTodayAtomic: 0n }).reason).toBe("0.04 USDC exceeds caps.per_call (0.01 USDC)");
  });

  it("keeps a parsed cap whose amount a float cannot hold", () => {
    const p = parsePolicy("caps:\n  per_call: 99999999999.999999\n  per_day: 100000000000\n");
    expect(evaluatePolicy(p, { ...pay, amountAtomic: 99999999999999999n, spentTodayAtomic: 0n })).toEqual({ allowed: true });
    expect(evaluatePolicy(p, { ...pay, amountAtomic: 100000000000000000n, spentTodayAtomic: 0n }).allowed).toBe(false);
  });

  it("refuses every payment under a cap it cannot read", () => {
    const reason = "caps.per_call (1e-7 USDC) is not an amount with at most 6 decimals, so it cannot be checked";
    const tiny: Policy = { ...DEFAULT_POLICY, perCall: { amount: 0.0000001, asset: "USDC" } };
    expect(evaluatePolicy(tiny, { ...pay, amountAtomic: 1n, spentTodayAtomic: 0n })).toEqual({ allowed: false, reason });
    const bad: Policy = { ...DEFAULT_POLICY, perCall: { amount: 1, asset: "USDC", atomic: "1e3" } };
    expect(evaluatePolicy(bad, { ...pay, amountAtomic: 1n, spentTodayAtomic: 0n }).allowed).toBe(false);
    expect(evaluatePolicy(bad, { ...pay, amountAtomic: 1n, spentTodayAtomic: 0n }).reason).toContain("is not an amount with at most 6 decimals");
  });
});

describe("large amounts", () => {
  const p = parsePolicy("caps:\n  per_call: 9007199254.740992\n  per_day: 100000000000\n");

  it("refuses a payment one unit over a cap a float cannot tell apart", () => {
    const verdict = evaluatePolicy(p, { ...pay, amountAtomic: 9007199254740993n, spentTodayAtomic: 0n });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("caps.per_call");
  });

  it("allows the cap itself", () => {
    expect(evaluatePolicy(p, { ...pay, amountAtomic: 9007199254740992n, spentTodayAtomic: 0n })).toEqual({ allowed: true });
  });
});

describe("display unchanged", () => {
  const p2 = parsePolicy("caps:\n  per_call: 0.75 USDC\n  per_day: 13.25\n");
  const rows: Array<[number, number, string, string, boolean, boolean]> = [
    [0, 0.01, "0.01 USDC, at most 0.75 USDC", "0 USDC paid today (UTC) + this 0.01 = 0.01, at most 13.25 USDC", true, true],
    [0.2, 0.1, "0.1 USDC, at most 0.75 USDC", "0.2 USDC paid today (UTC) + this 0.1 = 0.3, at most 13.25 USDC", true, true],
    [0.035, 0.01, "0.01 USDC, at most 0.75 USDC", "0.035 USDC paid today (UTC) + this 0.01 = 0.045, at most 13.25 USDC", true, true],
    [0.999999, 0.000001, "0.000001 USDC, at most 0.75 USDC", "0.999999 USDC paid today (UTC) + this 0.000001 = 1, at most 13.25 USDC", true, true],
    [12.5, 0.75, "0.75 USDC, at most 0.75 USDC", "12.5 USDC paid today (UTC) + this 0.75 = 13.25, at most 13.25 USDC", true, true],
    [13, 0.5, "0.5 USDC, at most 0.75 USDC", "13 USDC paid today (UTC) + this 0.5 = 13.5, at most 13.25 USDC", true, false],
  ];

  it.each(rows)("prints the same checks for %s spent and %s now", (spent, amount, callDetail, dayDetail, callOk, dayOk) => {
    const decimal = { domain: "api.example.com", amountDecimal: amount, asset: "USDC", spentTodayDecimal: spent };
    const atomic = {
      domain: "api.example.com",
      asset: "USDC",
      amountAtomic: BigInt(Math.round(amount * 1e6)),
      spentTodayAtomic: BigInt(Math.round(spent * 1e6)),
    };
    for (const a of [decimal, atomic]) {
      const caps = policyChecks(p2, a)
        .filter((c) => c.rule.startsWith("caps"))
        .map((c) => [c.ok, c.detail]);
      expect(caps).toEqual([
        [callOk, callDetail],
        [dayOk, dayDetail],
      ]);
    }
  });

  it("gives the verdict reason `main` gave", () => {
    const a = { domain: "api.example.com", asset: "USDC", amountAtomic: 500000n, spentTodayAtomic: 13000000n };
    expect(evaluatePolicy(p2, a).reason).toBe("today's payments (13 USDC) plus 0.5 exceed caps.per_day (13.25 USDC)");
  });

  it("prints every check of the default policy as `main` did", () => {
    for (const a of [
      { domain: "api.example.com", amountDecimal: 0.01, asset: "USDC", spentTodayDecimal: 0 },
      { domain: "api.example.com", amountAtomic: 10000n, asset: "USDC", spentTodayAtomic: 0n },
    ]) {
      expect(JSON.stringify(policyChecks(DEFAULT_POLICY, a))).toBe(
        '[{"rule":"kill_switch","ok":true,"detail":"off"},{"rule":"deny","ok":true,"detail":"empty"},{"rule":"allow","ok":true,"detail":"empty: any host"},{"rule":"stablecoins","ok":true,"detail":"USDC is in [USDC, pathUSD, USDG]"},{"rule":"caps.per_call","ok":true,"detail":"0.01 USDC, at most 0.05 USDC"},{"rule":"caps.per_day","ok":true,"detail":"0 USDC paid today (UTC) + this 0.01 = 0.01, at most 1 USDC"}]',
      );
    }
  });

  it("prints the verdicts `main` printed", () => {
    expect(evaluatePolicy(DEFAULT_POLICY, { domain: "api.example.com", amountDecimal: 0.06, asset: "pathUSD", spentTodayDecimal: 0 }).reason).toBe(
      "0.06 pathUSD exceeds caps.per_call (0.05 USDC)",
    );
    expect(evaluatePolicy(DEFAULT_POLICY, { domain: "api.example.com", amountDecimal: 0.01, asset: "USDG", spentTodayDecimal: 0.995 }).reason).toBe(
      "today's payments (0.995 USDG) plus 0.01 exceed caps.per_day (1 USDC)",
    );
  });

  it("keeps the unknown-total line, now as a refusal", () => {
    const check = perDayCheck(DEFAULT_POLICY, { domain: "api.example.com", amountDecimal: 0.01, asset: "USDC" });
    expect(check).toEqual({ rule: "caps.per_day", ok: false, detail: "at most 1 USDC; today's spending unknown" });
  });
});

describe("chain helpers", () => {
  it.each([
    ["0.1", 6, 100000n],
    ["1", 6, 1000000n],
    ["0.000001", 6, 1n],
    ["12", 0, 12n],
    ["0.000000000000000001", 18, 1n],
  ] as const)("toAtomicExact(%s, %s) is %s", (text, decimals, expected) => {
    expect(toAtomicExact(text, decimals)).toBe(expected);
  });

  it.each([["0.0000001", 6], ["1.5", 0], ["1e3", 6], ["0x10", 6], [".5", 6], ["1.", 6], ["-1", 6], ["+1", 6], [" 1", 6], ["", 6], ["0,5", 6]] as const)(
    "toAtomicExact(%j, %s) throws",
    (text, decimals) => {
      expect(() => toAtomicExact(text, decimals)).toThrow(/not a decimal amount|more than \d+ decimal places/);
    },
  );

  it.each([
    [100000n, 6, "0.1"],
    [0n, 6, "0"],
    [1000000n, 6, "1"],
    [1n, 6, "0.000001"],
    ["1500000", 6, "1.5"],
    [123n, 0, "123"],
  ] as const)("fromAtomicString(%s, %s) is %s", (atomic, decimals, expected) => {
    expect(fromAtomicString(atomic, decimals)).toBe(expected);
  });

  it("refuses a negative or non-numeric amount", () => {
    expect(() => fromAtomicString(-1n, 6)).toThrow(/not a whole number of base units/);
    expect(() => fromAtomicString("abc", 6)).toThrow(/not a whole number of base units/);
  });

  it("round-trips, and prints what the float printed", () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 10_000; i++) {
      const n = (BigInt(next()) * BigInt(next() % 400_000) + BigInt(next() % 1000)) % 10n ** 15n;
      const text = fromAtomicString(n, 6);
      expect(toAtomicExact(text, 6)).toBe(n);
      expect(String(Number(n) / 1e6)).toBe(text);
    }
  });

  it("is exported from the SDK entry point", () => {
    expect(sdk.toAtomicExact).toBe(toAtomicExact);
    expect(sdk.fromAtomicString).toBe(fromAtomicString);
    expect(sdk.capUnits).toBe(capUnits);
    expect(sdk.policyAmount).toBe(policyAmount);
    expect(sdk.CAP_DECIMALS).toBe(6);
  });
});

describe("capUnits and policyAmount", () => {
  it.each([
    [7n, 6, 7n],
    [1n, 18, 1n],
    [10n ** 12n, 18, 1n],
    [10n ** 12n + 1n, 18, 2n],
    [1n, 2, 10000n],
  ] as const)("capUnits(%s, %s) is %s", (amount, decimals, expected) => {
    expect(capUnits(amount, decimals)).toBe(expected);
  });

  it("refuses a negative amount", () => {
    expect(() => capUnits(-1n, 6)).toThrow();
  });

  it("reads a record's terms", () => {
    expect(policyAmount({ amountAtomic: "10000", network: "eip155:84532" })).toEqual({ amountAtomic: 10000n, decimals: 6 });
    expect(policyAmount({ amountAtomic: "1e3", network: "eip155:84532" })).toEqual({});
    expect(policyAmount({ amountAtomic: "10000", network: "eip155:1" })).toEqual({});
  });
});

describe("records", () => {
  const records = () => new Records(tmp("superstables-money-records-"));

  it("adds whole units across receipts and attempts that can still move money", () => {
    const r = records();
    r.saveReceipt(receipt("a", "100000"));
    r.saveReceipt(receipt("b", "100000"));
    const now = new Date();
    r.saveAttempt({
      id: "c",
      quoteId: "q-c",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      state: "approved",
      url: "http://127.0.0.1/x",
      terms: terms("100000"),
      authorizationValidBefore: new Date(now.getTime() + 3_600_000).toISOString(),
      history: [{ at: now.toISOString(), state: "approved" }],
    });
    expect(r.spentTodayAtomic("USDC")).toBe(300000n);
    expect(r.spentToday("USDC")).toBe(0.3);
  });

  it("counts the dollar stablecoins together", () => {
    const r = records();
    r.saveReceipt(receipt("t", "20000", { network: "eip155:42431" }, { asset: "pathUSD", network: "eip155:42431" }));
    r.saveReceipt(receipt("u", "10000"));
    expect(r.spentTodayAtomic("USDC")).toBe(30000n);
  });

  it("leaves out the excluded attempt", () => {
    const r = records();
    const now = new Date();
    const attempt = (id: string) => ({
      id,
      quoteId: `q-${id}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      state: "awaiting_approval" as const,
      url: "http://127.0.0.1/x",
      terms: terms("50000"),
      reservedAt: now.toISOString(),
      reservedUntil: new Date(now.getTime() + 600_000).toISOString(),
      history: [{ at: now.toISOString(), state: "awaiting_approval" as const }],
    });
    r.saveAttempt(attempt("x"));
    r.saveAttempt(attempt("y"));
    expect(r.spentTodayAtomic("USDC")).toBe(100000n);
    expect(r.spentTodayAtomic("USDC", new Date(), { exclude: "x" })).toBe(50000n);
  });

  it.each([
    ["a fraction", "1e5"],
    ["a missing amount", undefined],
    ["an empty amount", ""],
  ])("cannot read a total with a damaged receipt today: %s", (_name, atomic) => {
    const r = records();
    r.saveReceipt(receipt("ok", "10000"));
    r.saveReceipt(receipt("bad", atomic as string | undefined));
    expect(r.spentTodayAtomic("USDC")).toBeUndefined();
    expect(r.spentToday("USDC")).toBeNaN();
  });

  it.each([
    ["a fraction", "1e5"],
    ["a missing amount", undefined],
  ])("cannot read a total with a damaged attempt that can still move money: %s", (_name, atomic) => {
    const r = records();
    r.saveReceipt(receipt("ok", "10000"));
    const now = new Date();
    r.saveAttempt({
      id: "damaged",
      quoteId: "q-damaged",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      state: "approved",
      url: "http://127.0.0.1/x",
      terms: terms(atomic),
      authorizationValidBefore: new Date(now.getTime() + 3_600_000).toISOString(),
      history: [{ at: now.toISOString(), state: "approved" }],
    });
    expect(r.spentTodayAtomic("USDC")).toBeUndefined();
    expect(r.spentToday("USDC")).toBeNaN();
  });

  it("is not troubled by a damaged record that does not count", () => {
    const r = records();
    r.saveReceipt(receipt("old", "1e5", { at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
    r.saveReceipt(receipt("other", "1e5", {}, { asset: "EURC" }));
    r.saveReceipt(receipt("ok", "10000"));
    expect(r.spentTodayAtomic("USDC")).toBe(10000n);
  });
});

describe("a damaged record refuses", () => {
  it("quote refuses when today's total cannot be read", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = new Records(tmp("superstables-money-quote-"));
    r.saveReceipt(receipt("bad", "", {}, { amountDecimal: undefined as unknown as number }));
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: DEFAULT_POLICY });
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toBe("today's spending is unknown, so caps.per_day (1 USDC) cannot be checked");
  });
});

describe("quote at the cap", () => {
  const capped = parsePolicy("caps:\n  per_call: 1\n  per_day: 0.29\n");

  it("allows a payment that reaches the daily cap exactly", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = new Records(tmp("superstables-money-quote-"));
    r.saveReceipt(receipt("spent", "280000"));
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: capped });
    expect(q.policy.allowed).toBe(true);
    expect(q.policy.checks?.find((c) => c.rule === "caps.per_day")?.detail).toBe("0.28 USDC paid today (UTC) + this 0.01 = 0.29, at most 0.29 USDC");
  });

  it("refuses one unit more", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = new Records(tmp("superstables-money-quote-"));
    r.saveReceipt(receipt("spent", "280001"));
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: capped });
    expect(q.policy.allowed).toBe(false);
  });
});

describe("pay at the cap", () => {
  it("settles a payment that reaches the daily cap exactly", async () => {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    const wallet = await startWallet();
    open.push(facilitator, seller, wallet);
    const records = new Records(tmp("superstables-money-pay-"));
    const policy: Policy = { ...DEFAULT_POLICY, ...parsePolicy("caps:\n  per_call: 1\n  per_day: 0.29\n") };
    const engine = new PaymentEngine({
      records,
      policy,
      signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }),
    });
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records, policy });
    expect(q.policy.allowed).toBe(true);
    records.saveReceipt(receipt("spent", "280000"));
    const started = engine.startPayment(q.id);
    const final = await engine.waitForAttempt(started.id, 10_000);
    expect(final.reason).toBeUndefined();
    expect(final.state).toBe("settled");
  });
});

describe("the browser gate at the cap", () => {
  const capped = parsePolicy("caps:\n  per_call: 1\n  per_day: 0.29\n");

  async function sign(spent: string) {
    const home = tmp("superstables-money-browser-");
    new Records(join(home, "records")).saveReceipt(receipt("spent", spent));
    const signer = new BrowserWalletSigner({ home, port: 0, policy: capped, timeoutMs: 300, balance: false });
    let link: string | undefined;
    try {
      const refusal = await signer
        .sign({ kind: "eip3009", requirements: usdcRequirement(0.01, SELLER), x402Version: 2 }, { onPending: (_id, url) => (link = url) })
        .catch((err: unknown) => err);
      return { refusal, link, url: signer.url };
    } finally {
      await signer.close();
    }
  }

  it("opens an approval for a payment that reaches the cap exactly", async () => {
    const { refusal, link } = await sign("280000");
    // Nobody answers the page: the request expires, which is after the policy let it through.
    expect(refusal).toBeInstanceOf(SignRefused);
    expect((refusal as SignRefused).code).toBe("expired");
    expect(link).toBeTruthy();
  });

  it("refuses one unit more before any page exists", async () => {
    const { refusal, link, url } = await sign("280001");
    expect((refusal as SignRefused).code).toBe("policy");
    expect(link).toBeUndefined();
    expect(url).toBe("");
  });
});

describe("the cap constant", () => {
  it("is six places", () => {
    expect(CAP_DECIMALS).toBe(6);
  });
});
