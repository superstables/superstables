// The seller API side of `seller top-up` and `seller credit`: the amount a seller can ask for, the key, the site,
// and the checks that tie a top-up's answer and its 402 to what this command asked for. Every refusal here happens
// before anything is signed, so each one is a test of "nothing was paid".

import { describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
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
  readSellerCredit,
  redactSecret,
  sellerSite,
  topUpFromAnswer,
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
  it("takes superstables.com, a Superstables host, and this machine", () => {
    expect(sellerSite("https://www.superstables.com").origin).toBe("https://www.superstables.com");
    expect(sellerSite("https://staging.superstables.com").origin).toBe("https://staging.superstables.com");
    expect(sellerSite("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
  });

  it("refuses another site, which would receive the key", () => {
    for (const site of ["https://evil.example", "http://evil.example", "not a url"]) {
      expect(() => sellerSite(site), site).toThrow(/seller API is read only on superstables.com/);
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

  it("redacts the key when the site echoes it back in an error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: `the key ${KEY} is not valid` } }), { status: 401 })) as typeof fetch;
    const err = await createTopUp({ site: SITE, apiKey: KEY, amount: "10", fetch: fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SellerApiError);
    expect((err as Error).message).toContain("[redacted]");
    expect((err as Error).message).not.toContain(KEY);
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
});
