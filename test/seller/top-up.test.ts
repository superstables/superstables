// The seller API side of `seller top-up` and `seller credit`: the amount a seller can ask for, the key, the site,
// and the checks that tie a top-up's answer and its 402 to what this command asked for. Every refusal here happens
// before anything is signed, so each one is a test of "nothing was paid".

import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
import type { Attempt } from "../../src/core/types.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import {
  MIN_TOP_UP_ATOMIC,
  SELLER_API_KEY_ENV,
  TOP_UP_NETWORK,
  TOP_UPS_PATH,
  SellerApiError,
  createTopUp,
  creditFromAnswer,
  parseTopUpAmount,
  readSellerApiKey,
  earlierTopUpProblem,
  keyGuardedFetch,
  readSellerCredit,
  redactSecret,
  sellerSite,
  topUpFromAnswer,
  topUpPayHref,
  topUpPayPath,
  topUpProblem,
  topUpTermsProblem,
  type TopUp,
} from "../../src/seller/top-up.js";

const KEY = `sssk_${"a".repeat(40)}`;
const SITE = new URL("https://www.superstables.com");
const ID = "3f1c9a2e-0000-4000-8000-000000000000";
const USDC = TOP_UP_NETWORK.token.address;

function topUp(overrides: Partial<TopUp> = {}): TopUp {
  return {
    id: ID,
    amount: "10",
    status: "open",
    payUrl: `${SITE.origin}${topUpPayPath(ID)}`,
    ...overrides,
  };
}

function terms(overrides: Partial<Parameters<typeof topUpTermsProblem>[0]> = {}) {
  return {
    amountAtomic: "10000000",
    asset: "USDC",
    assetAddress: USDC,
    network: BASE_SEPOLIA.caip2,
    scheme: "exact",
    ...overrides,
  };
}

describe("parseTopUpAmount", () => {
  it("takes a plain USD decimal and counts its smallest units exactly", () => {
    expect(parseTopUpAmount("25")).toEqual({ decimal: "25", atomic: "25000000" });
    expect(parseTopUpAmount(" 25.50 ")).toEqual({ decimal: "25.5", atomic: "25500000" });
    expect(parseTopUpAmount("1")).toEqual({ decimal: "1", atomic: String(MIN_TOP_UP_ATOMIC) });
  });

  it("takes the largest top-up the site does, and refuses more", () => {
    expect(parseTopUpAmount("1000")).toEqual({ decimal: "1000", atomic: "1000000000" });
    expect(() => parseTopUpAmount("1000.000001")).toThrow(/largest top-up is 1000 USDC/);
  });

  it("refuses anything that is not a plain decimal at least 1 USDC", () => {
    for (const input of ["", "  ", "-5", "+5", ".5", "1e3", "0x10", "5 USDC", "1,5"]) {
      expect(() => parseTopUpAmount(input), input).toThrow(/not a USD amount/);
    }
    expect(() => parseTopUpAmount("0.99")).toThrow(/smallest top-up is 1 USDC/);
    expect(() => parseTopUpAmount("1.0000001")).toThrow(/more than 6 decimal places/);
  });
});

describe("readSellerApiKey", () => {
  it("reads the key from the environment and never repeats it", () => {
    expect(readSellerApiKey({ [SELLER_API_KEY_ENV]: ` ${KEY} ` })).toBe(KEY);
    expect(() => readSellerApiKey({})).toThrow(SELLER_API_KEY_ENV);
    const wrong = "not-a-key-value";
    try {
      readSellerApiKey({ [SELLER_API_KEY_ENV]: wrong });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(wrong);
    }
  });
});

describe("sellerSite", () => {
  // The key and a payment go to this site, so it is held to the trust of an owner action (src/core/owner-settings.js).
  it("takes www.superstables.com, and this machine where the owner allows it", () => {
    expect(sellerSite("https://www.superstables.com").origin).toBe("https://www.superstables.com");
    expect(sellerSite("https://superstables.com").origin).toBe("https://www.superstables.com");
    // The test account allows loopback sites (test/account-guard.mjs).
    expect(sellerSite("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
  });

  it("refuses any other site, which would receive the key", () => {
    for (const site of ["https://evil.example", "http://evil.example", "not a url", "https://evil.superstables.com", "https://staging.superstables.com", "https://www.superstables.com:8443"]) {
      expect(() => sellerSite(site), site).toThrow(/seller API is used only on a site the owner allows|not a URL/);
    }
  });

  it("takes a site the owner has allowed in their settings, and only on the production defaults otherwise", () => {
    const before = process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
    try {
      process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = accountHomeWith({ version: 1, site: { allowStaging: true } });
      expect(sellerSite("https://staging.superstables.com").origin).toBe("https://staging.superstables.com");
      expect(() => sellerSite("http://127.0.0.1:3000")).toThrow(/owner allows/);
      process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = accountHomeWith(null);
      expect(() => sellerSite("https://staging.superstables.com")).toThrow(/owner allows/);
    } finally {
      if (before === undefined) delete process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
      else process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = before;
    }
  });
});

describe("topUpProblem", () => {
  const expected = parseTopUpAmount("10");

  it("accepts the top-up that was just asked for", () => {
    expect(topUpProblem(topUp(), SITE, expected)).toBeUndefined();
  });

  it("refuses a pay link on another origin", () => {
    const problem = topUpProblem(topUp({ payUrl: `https://evil.example${topUpPayPath(ID)}` }), SITE, expected);
    expect(problem).toContain("https://evil.example");
    expect(problem).toContain(SITE.origin);
  });

  it("hands on the pay link as the URL parser writes it, which is what was checked", () => {
    const loud = topUp({ payUrl: `https://WWW.SUPERSTABLES.COM:443${topUpPayPath(ID)}` });
    expect(topUpProblem(loud, SITE, expected)).toBeUndefined();
    expect(topUpPayHref(loud)).toBe(`${SITE.origin}${topUpPayPath(ID)}`);
  });

  it("refuses a top-up the site gives as retired", () => {
    expect(topUpProblem(topUp({ retired: true }), SITE, expected)).toContain("retired");
  });

  it("refuses a pay link for another top-up's id, and any query or fragment", () => {
    const other = "3f1c9a2e-0000-4000-8000-000000000001";
    expect(topUpProblem(topUp({ payUrl: `${SITE.origin}${topUpPayPath(other)}` }), SITE, expected)).toContain("is not this top-up's pay path");
    expect(topUpProblem(topUp({ payUrl: `${SITE.origin}${topUpPayPath(ID)}?amount=1` }), SITE, expected)).toContain("query or fragment");
    expect(topUpProblem(topUp({ payUrl: `${SITE.origin}${topUpPayPath(ID)}#x` }), SITE, expected)).toContain("query or fragment");
  });

  it("refuses an id that is not a UUID, even when the pay link repeats it", () => {
    const id = "not-a-uuid";
    const problem = topUpProblem(topUp({ id, payUrl: `${SITE.origin}${TOP_UPS_PATH}/${id}/pay` }), SITE, expected);
    expect(problem).toContain("not a UUID");
  });

  it("refuses a top-up made for another amount", () => {
    expect(topUpProblem(topUp({ amount: "12.5" }), SITE, expected)).toContain("for 12.5, not 10 USDC");
    expect(topUpProblem(topUp({ amount: "10.000001" }), SITE, expected)).toContain("10.000001");
  });

  it("refuses an unknown status, an open top-up with no pay link, and says nothing about a pay link once paid", () => {
    expect(topUpProblem(topUp({ status: "refunded" }), SITE, expected)).toContain("unknown status");
    expect(topUpProblem(topUp({ payUrl: undefined }), SITE, expected)).toContain("did not give the top-up a pay link");
    expect(topUpProblem(topUp({ status: "paid", payUrl: undefined }), SITE, expected)).toBeUndefined();
  });
});

describe("topUpTermsProblem", () => {
  const expected = parseTopUpAmount("10");

  it("accepts exactly the requested amount, in Base Sepolia test USDC", () => {
    expect(topUpTermsProblem(terms(), expected)).toBeUndefined();
  });

  it("refuses another chain, token, amount or scheme", () => {
    expect(topUpTermsProblem(terms({ network: "eip155:8453" }), expected)).toContain("not Base Sepolia");
    expect(topUpTermsProblem(terms({ assetAddress: `0x${"12".repeat(20)}`, asset: "USDC" }), expected)).toContain("not Base Sepolia test USDC");
    expect(topUpTermsProblem(terms({ amountAtomic: "11000000" }), expected)).toContain("for 11 USDC, not 10 USDC");
    expect(topUpTermsProblem(terms({ amountAtomic: "not-a-number" }), expected)).toContain("not 10 USDC");
    expect(topUpTermsProblem(terms({ scheme: "charge" }), expected)).toContain("not the exact scheme");
  });
});

describe("answers from the seller API", () => {
  it("reads the top-up the site created", () => {
    expect(topUpFromAnswer({ top_up: { id: ID, amount: "10.00", status: "open", pay_url: `${SITE.origin}${topUpPayPath(ID)}`, created_at: "2026-10-20T00:00:00.000Z" } })).toEqual({
      id: ID,
      amount: "10.00",
      status: "open",
      payUrl: `${SITE.origin}${topUpPayPath(ID)}`,
      createdAt: "2026-10-20T00:00:00.000Z",
    });
    expect(() => topUpFromAnswer({ top_up: { amount: "10" } })).toThrow(SellerApiError);
    expect(() => topUpFromAnswer({})).toThrow(/without a top-up/);
  });

  it("reads the balance, top-ups and entries the site lists, in either shape", () => {
    expect(
      creditFromAnswer({
        balance: "12.5",
        top_ups: [{ id: ID, amount: "10", status: "paid", created_at: "2026-10-20T00:00:00.000Z" }],
        entries: [{ at: "2026-10-20T00:00:00.000Z", kind: "fee", amount: "-0.5", reference: "sale-1" }],
      }),
    ).toEqual({
      balance: "12.5",
      asset: "USDC",
      topUps: [{ id: ID, amount: "10", status: "paid", createdAt: "2026-10-20T00:00:00.000Z" }],
      entries: [{ at: "2026-10-20T00:00:00.000Z", kind: "fee", amount: "-0.5", reference: "sale-1" }],
    });
    const nested = creditFromAnswer({ credit: { balance: { amount: "3" }, asset: "USDC", top_ups: [], ledger: [] } });
    expect(nested.balance).toBe("3");
    expect(nested.topUps).toEqual([]);
    expect(nested.entries).toEqual([]);
  });

  it("reads the ledger's reference from source_id, a retired top-up as retired and a negative balance as it is", () => {
    const credit = creditFromAnswer({
      balance: "-0.4",
      top_ups: [{ id: ID, amount: "10", status: "open", retired: true, pay_url: null }],
      entries: [{ id: "entry-1", kind: "fee", source_id: "sale-9", amount: "-0.4", created_at: "2026-10-20T00:00:00.000Z" }],
    });
    expect(credit.balance).toBe("-0.4");
    expect(credit.topUps[0]).toMatchObject({ status: "open", retired: true });
    expect(credit.entries[0]).toEqual({ at: "2026-10-20T00:00:00.000Z", kind: "fee", amount: "-0.4", reference: "sale-9" });
  });

  it("leaves out what the site did not send, rather than guessing", () => {
    const credit = creditFromAnswer({});
    expect(credit).toEqual({ asset: "USDC", topUps: [], entries: [] });
  });
});

describe("the seller API calls", () => {
  it("creates the top-up as one POST, with the key only in the authorization header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ top_up: { id: ID, amount: "10", status: "open", pay_url: `${SITE.origin}${topUpPayPath(ID)}` } }), { status: 201 });
    }) as typeof fetch;

    const created = await createTopUp({ site: SITE, apiKey: KEY, amount: "10", fetch: fetchImpl });

    expect(created.id).toBe(ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${SITE.origin}${TOP_UPS_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ amount: "10", chain: "base-sepolia" });
  });

  it("never retries a create: a second POST would make a second top-up", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "boom", message: "no" } }), { status: 500 })) as unknown as typeof fetch;
    await expect(createTopUp({ site: SITE, apiKey: KEY, amount: "10", fetch: fetchImpl })).rejects.toThrow(/boom/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer that holds the key, whatever field or status it is in, and repeats none of it", async () => {
    const answers: [string, number, unknown][] = [
      ["an error message", 401, { error: { code: "unauthorized", message: `the key ${KEY} is not valid` } }],
      ["an error code", 401, { error: { code: KEY, message: "no" } }],
      ["a top-up field", 201, { top_up: { id: ID, amount: "10", status: KEY } }],
      ["a credit field", 200, { balance: "1", entries: [{ source_id: KEY }] }],
    ];
    for (const [where, status, body] of answers) {
      const fetchImpl = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
      for (const call of [
        () => createTopUp({ site: SITE, apiKey: KEY, amount: "10", fetch: fetchImpl }),
        () => readSellerCredit({ site: SITE, apiKey: KEY, fetch: fetchImpl }),
      ]) {
        const err = await call().catch((e: Error) => e);
        expect(err, where).toBeInstanceOf(SellerApiError);
        expect((err as SellerApiError).code, where).toBe("key_echoed");
        expect(JSON.stringify({ message: (err as Error).message, code: (err as SellerApiError).code }), where).not.toContain(KEY);
      }
    }
  });

  it("strips control characters from the words of an error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "bad\ncode", message: "line one\u001b[31m\nline two" } }), { status: 400 })) as typeof fetch;
    const err = (await createTopUp({ site: SITE, apiKey: KEY, amount: "10", fetch: fetchImpl }).catch((e: Error) => e)) as SellerApiError;
    expect(err.code).toBe("http_400");
    expect(err.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it("reads the credit with a GET", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ balance: "4", top_ups: [], entries: [] }), { status: 200 });
    }) as typeof fetch;
    const credit = await readSellerCredit({ site: SITE, apiKey: KEY, fetch: fetchImpl });
    expect(credit.balance).toBe("4");
    expect(calls[0]!.method).toBe("GET");
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence, and leaves text alone when there is no secret", () => {
    expect(redactSecret(`a ${KEY} b ${KEY}`, KEY)).toBe("a [redacted] b [redacted]");
    expect(redactSecret("nothing here", "")).toBe("nothing here");
  });

  it("finds a key split by invisible characters, and keeps the text that has none", () => {
    const split = `${KEY.slice(0, 5)}\u200b${KEY.slice(5, 9)}\u2060${KEY.slice(9)}`;
    expect(redactSecret(`a ${split} b`, KEY)).toBe("a [redacted] b");
    expect(redactSecret("a\u200bb", KEY)).toBe("a\u200bb");
  });
});

describe("keyGuardedFetch", () => {
  const guarded = (response: () => Response) => keyGuardedFetch(KEY, (async () => response()) as typeof fetch);

  it("passes an answer without the key on, whole and readable", async () => {
    const res = await guarded(() => new Response('{"ok":true}', { status: 402, headers: { "payment-required": "e30=" } }))("https://www.superstables.com/x");
    expect(res.status).toBe(402);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("refuses an answer with the key in its body or in a header, plain or base64", async () => {
    const escaped = `{"x":"\\u0073${KEY.slice(1)}"}`;
    const split = `{"x":"${KEY.slice(0, 5)}\u200b${KEY.slice(5)}"}`;
    const answers = [
      () => new Response(`{"x":"${KEY}"}`),
      () => new Response(escaped),
      () => new Response(split),
      () => new Response("{}", { headers: { "payment-response": Buffer.from(escaped).toString("base64url") } }),
      () => new Response("{}", { headers: { "x-echo": KEY } }),
      () => new Response("{}", { headers: { "payment-required": Buffer.from(`{"x":"${KEY}"}`).toString("base64") } }),
    ];
    for (const answer of answers) {
      const err = await guarded(answer)("https://www.superstables.com/x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(SellerApiError);
      expect((err as SellerApiError).message).not.toContain(KEY);
    }
  });
});

describe("earlierTopUpProblem", () => {
  const credit = (topUps: TopUp[]) => ({ asset: "USDC", topUps, entries: [] });
  const attempt = (state: string, overrides: Record<string, unknown> = {}) =>
    ({ id: "a-1", url: `${SITE.origin}${topUpPayPath(ID)}`, state, ...overrides }) as unknown as Attempt;

  it("is silent when nothing is in doubt", () => {
    expect(earlierTopUpProblem({ site: SITE, credit: credit([topUp({ status: "paid" })]), attempts: [attempt("settled"), attempt("denied"), attempt("failed")] })).toBeUndefined();
  });

  it("names a top-up the site lists as pending", () => {
    expect(earlierTopUpProblem({ site: SITE, credit: credit([topUp({ status: "pending" })]), attempts: [] })).toContain(`top-up ${ID} is pending`);
  });

  it("holds a new top-up back while a payment is under way, whatever the site lists", () => {
    for (const state of ["awaiting_approval", "approved", "submitting"]) {
      for (const listed of [[], [topUp()], [topUp({ status: "paid" })]]) {
        expect(earlierTopUpProblem({ site: SITE, credit: credit(listed), attempts: [attempt(state)] }), state).toContain("attempt a-1");
      }
    }
  });

  it("holds back a payment that ended in doubt for a top-up the site does not list, and lets the site's word release it", () => {
    for (const state of ["uncertain", "paid_service_failed"]) {
      expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt(state)] }), state).toContain("attempt a-1");
      for (const listed of [topUp(), topUp({ status: "paid" }), topUp({ retired: true })]) {
        expect(earlierTopUpProblem({ site: SITE, credit: credit([listed]), attempts: [attempt(state)] }), state).toBeUndefined();
      }
    }
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("uncertain", { transaction: "0x1" })] })).toContain("attempt a-1");
  });

  it("names the way out: the credit read and the status of the attempt", () => {
    const refusal = earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("uncertain")] });
    expect(refusal).toContain("created and paid nothing");
    expect(refusal).toContain("`superstables seller credit`");
    expect(refusal).toContain("`superstables status <attempt>`");
  });

  it("lets a paid attempt go once the chain confirmed it, though the site no longer lists its top-up", () => {
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("paid_service_failed", { chain: "verified" })] })).toBeUndefined();
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("paid_service_failed", { chain: "unchecked" })] })).toContain("attempt a-1");
  });

  it("counts a failed attempt only when it names a transaction the chain has not called unpaid", () => {
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("failed", { transaction: "0x1" })] })).toContain("attempt a-1");
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: [attempt("failed", { transaction: "0x1", chain: "unpaid" })] })).toBeUndefined();
  });

  it("ignores payments for anything but this site's top-up pay links", () => {
    const other = [attempt("uncertain", { url: `https://staging.superstables.com${topUpPayPath(ID)}` }), attempt("uncertain", { url: `${SITE.origin}/api/v1/purchases/x` })];
    expect(earlierTopUpProblem({ site: SITE, credit: credit([]), attempts: other })).toBeUndefined();
  });
});
