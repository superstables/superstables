// `superstables seller top-up` as a whole, with the seller API and the payer replaced: what it pays, and above all
// what it refuses. The property under test is that a top-up which is not exactly the one this command asked for is
// never paid, and that a payment the site calls pending, retired or unconfirmable is never paid a second time.

import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
import type { PaymentTerms, Attempt, Quote } from "../../src/core/types.js";
import { NotPaidEndpointError } from "../../src/core/x402.js";
import { printTopUp, runTopUp, topUpJson, type TopUpPorts } from "../../src/cli/top-up.js";
import { TOP_UP_NETWORK, parseTopUpAmount, topUpPayPath, type TopUp } from "../../src/seller/top-up.js";

const KEY = `sssk_${"a".repeat(40)}`;
const SITE = new URL("https://www.superstables.com");
const AMOUNT = parseTopUpAmount("10");
const ID = "3f1c9a2e-0000-4000-8000-000000000000";
const PAY_URL = `${SITE.origin}${topUpPayPath(ID)}`;

function topUp(overrides: Partial<TopUp> = {}): TopUp {
  return { id: ID, amount: "10", status: "open", payUrl: PAY_URL, ...overrides };
}

function terms(overrides: Partial<PaymentTerms> = {}): PaymentTerms {
  return {
    amountDecimal: 10,
    amountAtomic: "10000000",
    asset: "USDC",
    assetAddress: TOP_UP_NETWORK.token.address,
    network: BASE_SEPOLIA.caip2,
    networkLabel: BASE_SEPOLIA.label,
    recipient: `0x${"ab".repeat(20)}`,
    scheme: "exact",
    x402Version: 2,
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}, allowed = true): Quote {
  return {
    id: "q-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    expiresAt: "2026-10-20T00:10:00.000Z",
    status: "open",
    url: PAY_URL,
    terms: terms(),
    requirement: {} as Quote["requirement"],
    policy: allowed ? { allowed: true } : { allowed: false, reason: "up to 0.05 USDC per payment" },
    approval: "wallet",
    ...overrides,
  };
}

function attempt(state: Attempt["state"], overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: "a-1",
    quoteId: "q-1",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    state,
    url: PAY_URL,
    terms: terms(),
    history: [{ at: "2026-10-20T00:00:00.000Z", state }],
    ...overrides,
  };
}

/** The three ways this command acts, so a test can see which of them ran, and how often. */
function ports(options: { created?: TopUp; quote?: () => Promise<Quote>; pay?: () => Promise<Attempt> } = {}) {
  const made: TopUpPorts = {
    create: vi.fn(async () => options.created ?? topUp()),
    quote: vi.fn(options.quote ?? (async () => quote())),
    pay: vi.fn(options.pay ?? (async () => attempt("settled", { chain: "verified", chainFinal: true }))),
  };
  return made;
}

async function run(made: TopUpPorts) {
  return runTopUp({ site: SITE, apiKey: KEY, amount: AMOUNT, say: () => {}, ports: made });
}

describe("seller top-up", () => {
  it("creates the top-up for the amount, checks its pay link and the 402, and pays once", async () => {
    const made = ports();
    const result = await run(made);

    expect(made.create).toHaveBeenCalledWith({ site: SITE, apiKey: KEY, amount: "10" });
    expect(made.quote).toHaveBeenCalledWith(PAY_URL);
    expect(made.pay).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Paid 10 USDC");
    expect(result.message).toContain("final on chain");
    expect(result.next).toContain("superstables seller credit");
    expect(topUpJson(result)).toMatchObject({
      top_up: { id: ID, amount: "10", status: "open", pay_url: PAY_URL },
      quote_id: "q-1",
      attempt_id: "a-1",
      state: "settled",
      exit_code: 0,
    });
  });

  it("prints the top-up, the payment and the next step, one fact per line", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      printTopUp(await run(ports()));
    } finally {
      spy.mockRestore();
    }
    const text = lines.join("\n");
    expect(text).toContain(`top-up          ${ID}`);
    expect(text).toContain("amount          10 USDC");
    expect(text).toContain("Base Sepolia");
    expect(text).toContain("settled");
    expect(text).toMatch(/Next: `superstables seller credit`/);
    expect(text).not.toContain(KEY);
  });

  it("refuses a paid or pending top-up without quoting or paying again", async () => {
    for (const status of ["paid", "pending"]) {
      const made = ports({ created: topUp({ status }) });
      const result = await run(made);
      expect(made.quote, status).not.toHaveBeenCalled();
      expect(made.pay, status).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(status === "paid" ? 0 : 5);
      expect(result.next).not.toContain("seller top-up");
    }
  });

  it("does not pay an answer whose id, amount, status or pay link is not the one it asked for", async () => {
    const answers: [string, TopUp][] = [
      ["another origin", topUp({ payUrl: `https://evil.example${topUpPayPath(ID)}` })],
      ["another id's path", topUp({ payUrl: `${SITE.origin}${topUpPayPath("3f1c9a2e-0000-4000-8000-000000000009")}` })],
      ["a non-UUID id", topUp({ id: "not-a-uuid", payUrl: `${SITE.origin}/api/v1/seller/top-ups/not-a-uuid/pay` })],
      ["another amount", topUp({ amount: "11" })],
      ["an unknown status", topUp({ status: "refunded" })],
      ["a query on the pay link", topUp({ payUrl: `${PAY_URL}?x=1` })],
    ];
    for (const [why, created] of answers) {
      const made = ports({ created });
      const result = await run(made);
      expect(made.quote, why).not.toHaveBeenCalled();
      expect(made.pay, why).not.toHaveBeenCalled();
      expect(result.exitCode, why).toBe(3);
      expect(result.message, why).toContain("Nothing was paid");
    }
  });

  it("does not pay a 402 on another chain, in another token, for another amount or under another scheme", async () => {
    const answers: [string, PaymentTerms][] = [
      ["another chain", terms({ network: "eip155:8453" })],
      ["another token", terms({ assetAddress: `0x${"12".repeat(20)}` })],
      ["another amount", terms({ amountAtomic: "11000000", amountDecimal: 11 })],
      ["another scheme", terms({ scheme: "charge" })],
    ];
    for (const [why, termsNow] of answers) {
      const made = ports({ quote: async () => quote({ terms: termsNow }) });
      const result = await run(made);
      expect(made.pay, why).not.toHaveBeenCalled();
      expect(result.exitCode, why).toBe(3);
      expect(result.message, why).toContain("not the one this command asked for");
    }
  });

  it("does not pay when the spend policy refuses the top-up, and says which command shows the rules", async () => {
    const made = ports({ quote: async () => quote({}, false) });
    const result = await run(made);
    expect(made.pay).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("spend policy refused");
    expect(result.next).toContain("superstables policy show");
  });

  it("never pays the same top-up again when its pay link says the payment is pending or unconfirmed", async () => {
    for (const status of [409, 502]) {
      const made = ports({
        quote: async () => {
          throw new NotPaidEndpointError(PAY_URL, status, JSON.stringify({ error: { code: "payment_pending", money_moved: "unknown" } }));
        },
      });
      const result = await run(made);
      expect(made.pay, String(status)).not.toHaveBeenCalled();
      expect(result.exitCode, String(status)).toBe(5);
      expect(result.message, String(status)).toContain("unknown");
      // The next step must not be to make and pay another top-up: this one may already have moved money.
      expect(result.next, String(status)).not.toContain("seller top-up");
      expect(result.next, String(status)).toContain("superstables seller credit");
    }
  });

  it("asks for a new top-up when the site retired this one, and paid nothing", async () => {
    const made = ports({
      quote: async () => {
        throw new NotPaidEndpointError(PAY_URL, 410, JSON.stringify({ error: { code: "top_up_retired" } }));
      },
    });
    const result = await run(made);
    expect(made.pay).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("retired this top-up");
    expect(result.next).toContain("superstables seller top-up 10");
  });

  it("says a top-up is already paid when the pay link answers 200", async () => {
    const made = ports({
      quote: async () => {
        throw new NotPaidEndpointError(PAY_URL, 200, JSON.stringify({ top_up: { id: ID, amount: "10", status: "paid" } }));
      },
    });
    const result = await run(made);
    expect(made.pay).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.next).not.toContain("seller top-up");
  });

  it("never pays again when the payment went out and the site said pending, unconfirmed or retired", async () => {
    const cases: [number, string][] = [
      [409, "payment_pending"],
      [502, "bad_gateway"],
      [410, "top_up_retired"],
    ];
    for (const [status, code] of cases) {
      const made = ports({
        pay: async () => attempt("paid_service_failed", { serviceStatus: status, serviceBody: JSON.stringify({ error: { code } }) }),
      });
      const result = await run(made);
      expect(made.pay, String(status)).toHaveBeenCalledTimes(1);
      expect(result.exitCode, String(status)).toBe(5);
      expect(result.message, String(status)).toContain("unknown");
      if (status !== 410) {
        // Only a retired top-up may be asked for again: it can no longer be credited.
        expect(result.next, String(status)).not.toContain("seller top-up");
      }
      expect(result.next, String(status)).toContain("superstables seller credit");
    }
  });

  it("reports a paid-but-failed top-up as unpaid credit, not as a reason to pay again", async () => {
    const made = ports({ pay: async () => attempt("paid_service_failed", { serviceStatus: 500 }) });
    const result = await run(made);
    expect(result.exitCode).toBe(4);
    expect(result.message).toContain("not confirmed");
    expect(result.next).toContain("Do not pay again");
  });

  it("says nothing was paid when the owner rejects it, and no second payment is started", async () => {
    const made = ports({ pay: async () => attempt("denied") });
    const result = await run(made);
    expect(made.pay).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(3);
    expect(result.message).toContain("rejected");
    expect(result.next).toContain("Nothing was charged");
  });

  it("never prints the key, whatever happened", async () => {
    const said: string[] = [];
    const made = ports({
      quote: async () => {
        throw new Error(`could not read the answer from a site that said ${KEY}`);
      },
    });
    const result = await runTopUp({ site: SITE, apiKey: KEY, amount: AMOUNT, say: (line) => said.push(line), ports: made });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(said.join("\n")).not.toContain(KEY);
  });
});
