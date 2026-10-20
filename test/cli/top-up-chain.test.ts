// `seller top-up` through the real chain: the seller API calls, the quote, approveAndPay, the payment engine and its
// signer, with only the network replaced. The unit tests in top-up.test.ts replace the payer, so they cannot see the
// engine's own read of the pay link after the quote, the payment request it sends, or a failure while it follows the
// payment. Here the site is a function that answers as the real one does (its field names and error shape), and a
// wallet that approves every request.
//
// The property: a top-up that may have been paid is never reported as unpaid, never sends the seller to a new
// top-up, and the API key never reaches a record or a line of output.

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientPorts, runTopUp, topUpJson, type TopUpResult } from "../../src/cli/top-up.js";
import type { PaymentContext } from "../../src/cli/context.js";
import { CliError } from "../../src/cli/outcome.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { SellerApiError, TOP_UP_NETWORK, keyGuardedFetch, parseTopUpAmount, topUpPayPath } from "../../src/seller/top-up.js";
import { startWallet, type FakeWallet } from "../helpers/servers.js";

const KEY = `sssk_${"k".repeat(40)}`;
const SITE = new URL("https://www.superstables.com");
const ID = "3f1c9a2e-0000-4000-8000-000000000000";
const PAY_URL = `${SITE.origin}${topUpPayPath(ID)}`;
const AMOUNT = parseTopUpAmount("10");
const REAL_FETCH = globalThis.fetch;
const POLICY = { ...DEFAULT_POLICY, perCall: { amount: 100, asset: "USDC" }, perDay: { amount: 1000, asset: "USDC" } };

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The site's top-up view (lib/sellers/credit.ts topUpView). */
const view = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  status: "open",
  retired: false,
  chain: TOP_UP_NETWORK.caip2,
  asset: TOP_UP_NETWORK.token.address.toLowerCase(),
  pay_to: `0x${"ab".repeat(20)}`,
  amount: "10",
  amount_atomic: "10000000",
  pay_url: PAY_URL,
  transaction: null,
  created_at: "2026-10-20T00:00:00.000Z",
  paid_at: null,
  ...overrides,
});

/** The site's error answer (lib/purchases/http.ts fail): the code, message and money_moved all sit under `error`. */
const failure = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  reply(status, {
    error: { code, message: "a sentence", ...extra, money_moved: extra.money_moved ?? false, retryable: false, doc_url: "https://www.superstables.com/docs", request_id: "req_1" },
  });
const pending = () => failure(409, "payment_pending", { money_moved: "unknown", top_up: view({ status: "pending" }) });

/** The pay link's 402, as the site writes it. */
const challenge = (description = "Superstables seller credit: 10 test USDC on Base Sepolia") =>
  reply(402, {
    x402Version: 2,
    error: "Payment required",
    resource: { url: PAY_URL, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: TOP_UP_NETWORK.caip2,
        asset: TOP_UP_NETWORK.token.address.toLowerCase(),
        amount: AMOUNT.atomic,
        payTo: `0x${"ab".repeat(20)}`,
        maxTimeoutSeconds: 300,
        extra: TOP_UP_NETWORK.usdc.eip712,
      },
    ],
  });

const challengeJson = await challenge().json();
const receiptHeader = (wallet: FakeWallet) =>
  encodePaymentResponseHeader({
    success: true,
    transaction: `0x${"ab".repeat(32)}`,
    network: TOP_UP_NETWORK.caip2,
    payer: wallet.address,
  } as Parameters<typeof encodePaymentResponseHeader>[0]);

const credit = (topUps: unknown[] = []) =>
  reply(200, { balance: "0", balance_atomic: "0", top_ups_available: true, entries: [], top_ups: topUps });

interface Site {
  credit: () => Response;
  create: () => Response;
  /** The nth unpaid read of the pay link (1: the quote, 2: the engine's read before it asks the owner). */
  unpaid: (n: number) => Response;
  /** The request that carries the signed payment. */
  paid: () => Response | Promise<Response>;
}
const defaults: Site = {
  credit: () => credit(),
  create: () => reply(201, { top_up: view() }),
  unpaid: () => challenge(),
  paid: () => failure(500, "internal_error"),
};

let site: Site;
let seen: { credit: number; create: number; unpaid: number; paid: number };
/** The unpaid reads of the pay link made since the current command started: the quote's is the first. */
let unpaidReads = 0;
let wallet: FakeWallet;
let dirs: string[];
const opened: { close(): Promise<void> }[] = [];

/** The site as a fetch: the seller API, the pay link, and (for the wallet on this machine) the real network. */
const siteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith(SITE.origin)) return REAL_FETCH(input, init);
  const method = init?.method ?? "GET";
  if (url === `${SITE.origin}/api/v1/seller/top-ups`) {
    if (method === "POST") {
      seen.create += 1;
      return site.create();
    }
    seen.credit += 1;
    return site.credit();
  }
  const headers = Object.keys((init?.headers ?? {}) as Record<string, string>);
  if (headers.some((name) => /^(x-)?payment(-signature)?$/i.test(name))) {
    seen.paid += 1;
    return site.paid();
  }
  seen.unpaid += 1;
  unpaidReads += 1;
  return site.unpaid(unpaidReads);
}) as typeof fetch;

beforeEach(async () => {
  site = { ...defaults };
  seen = { credit: 0, create: 0, unpaid: 0, paid: 0 };
  dirs = [];
  wallet = await startWallet();
  opened.push(wallet);
  vi.stubGlobal("fetch", siteFetch);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((server) => server.close()));
});

/** What `seller top-up` builds: the engine reads through the key guard, the ports are the client's own. */
function context(dir = mkdtempSync(join(tmpdir(), "superstables-top-up-chain-"))): PaymentContext {
  dirs.push(dir);
  unpaidReads = 0;
  const records = new Records(dir);
  const signer = new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 });
  const engine = new PaymentEngine({ records, policy: POLICY, signer, fetchImpl: keyGuardedFetch(KEY, siteFetch) });
  return { records, policy: POLICY, engine, signer };
}

async function topUp(deps: PaymentContext, lines: string[] = []): Promise<TopUpResult> {
  return runTopUp({ site: SITE, apiKey: KEY, amount: AMOUNT, say: (line) => lines.push(line), ports: clientPorts(deps, { apiKey: KEY }) });
}

/** Every byte under a records folder. */
function recorded(dir: string): string {
  let text = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    text += statSync(path).isDirectory() ? recorded(path) : `${name}\n${readFileSync(path, "utf8")}\n`;
  }
  return text;
}

/** What the person or agent sees, in every form this command prints it. */
const shown = (result: TopUpResult, lines: string[] = []) => `${JSON.stringify(topUpJson(result))}\n${lines.join("\n")}`;

/** The result tells the seller to look, never to ask for or pay another top-up, and never says nothing was paid. */
function expectUnknown(result: TopUpResult) {
  expect(result.exitCode).toBe(5);
  expect(result.next).toContain("superstables seller credit");
  expect(result.next).not.toContain("superstables seller top-up");
  expect(result.message).not.toMatch(/nothing was (paid|charged)/i);
  expect(result.next).not.toMatch(/nothing was (paid|charged)/i);
}

describe("a payment that may be in flight, read before the owner is asked", () => {
  const answers: [string, () => Response][] = [
    ["409 payment_pending", pending],
    ["429 with money_moved unknown", () => failure(429, "rate_limited", { money_moved: "unknown" })],
    ["502 payment_outcome_unknown", () => failure(502, "payment_outcome_unknown", { money_moved: "unknown" })],
    ["500 with money_moved unknown", () => failure(500, "payment_outcome_unknown", { money_moved: "unknown" })],
    ["409 payment_already_used", () => failure(409, "payment_already_used", { money_moved: "unknown" })],
  ];

  it.each(answers)("%s on the quote's read is unknown, and nothing is signed", async (_name, answer) => {
    site.unpaid = answer;
    const deps = context();
    const result = await topUp(deps);
    expectUnknown(result);
    expect(seen.unpaid).toBe(1);
    expect(deps.records.listAttempts()).toEqual([]);
  });

  it.each(answers)("%s on the engine's own read after the quote is unknown, and nothing is signed", async (_name, answer) => {
    site.unpaid = (n) => (n === 1 ? challenge() : answer());
    const deps = context();
    const result = await topUp(deps);
    expect(seen.unpaid).toBe(2);
    expect(seen.paid).toBe(0);
    expect(result.attempt?.state).toBe("failed");
    expect(result.attempt?.serviceStatus).toBeGreaterThan(0);
    expectUnknown(result);
  });

  it("honours money_moved on a status the client has no other reason to read (an unexpected 418)", async () => {
    site.unpaid = (n) => (n === 1 ? challenge() : failure(418, "teapot", { money_moved: "unknown" }));
    expectUnknown(await topUp(context()));
  });

  it("reads a truncated body that still says money_moved is not false", async () => {
    const cut = '{"error":{"code":"x","money_moved":"unknown","message":"' + "a".repeat(5_000);
    site.unpaid = (n) => (n === 1 ? challenge() : new Response(cut, { status: 503 }));
    expectUnknown(await topUp(context()));
  });

  it("treats a 200 'already paid' as paid, on either read", async () => {
    for (const read of [1, 2]) {
      site.unpaid = (n) => (n === read ? reply(200, { top_up: view({ status: "paid", pay_url: null }) }) : challenge());
      seen = { credit: 0, create: 0, unpaid: 0, paid: 0 };
      const result = await topUp(context());
      expect(result.exitCode, `read ${read}`).toBe(0);
      expect(result.next).toContain("superstables seller credit");
      expect(result.next).not.toContain("superstables seller top-up");
      expect(result.message).toContain("already paid");
      expect(result.message).toContain("did not pay it");
      expect(result.next).toContain("Confirm with `superstables seller credit`");
      expect(seen.paid).toBe(0);
    }
  });

  it("sends a 410 to a new top-up, and says nothing was paid", async () => {
    for (const read of [1, 2]) {
      site.unpaid = (n) => (n === read ? failure(410, "top_up_retired") : challenge());
      const result = await topUp(context());
      expect(result.exitCode, `read ${read}`).toBe(1);
      expect(result.message).toContain("retired");
      expect(result.next).toContain("superstables seller top-up 10");
    }
  });

  it("says a plain refusal signed nothing, and lets the seller look at the top-up before asking again", async () => {
    site.unpaid = (n) => (n === 1 ? challenge() : failure(429, "rate_limited"));
    const result = await topUp(context());
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("signed nothing");
    expect(result.next).toContain("superstables seller credit");
  });
});

describe("a payment the owner approved", () => {
  it("settles through the real engine, and shows the site's latest word on the top-up", async () => {
    site.paid = () => reply(200, { top_up: view({ status: "pending" }) }, { "payment-response": receiptHeader(wallet) });
    const lines: string[] = [];
    const deps = context();
    const result = await topUp(deps, lines);
    expect(seen).toMatchObject({ create: 1, paid: 1 });
    expect(result.attempt?.state).toBe("settled");
    expect(result.exitCode).toBe(0);
    // The site made it open; its answer to the payment says pending, and that is what is shown.
    expect(result.topUp.status).toBe("pending");
    expect(result.message).toContain("Paid 10");
    expect(topUpJson(result)).toMatchObject({ state: "settled", exit_code: 0, top_up: { id: ID, status: "pending" } });
    expect(shown(result, lines)).not.toContain(KEY);
  });

  it("is unknown when the site answers the payment with 409, 429 or 502 and money_moved unknown", async () => {
    for (const answer of [pending, () => failure(429, "rate_limited", { money_moved: "unknown" }), () => failure(502, "payment_outcome_unknown", { money_moved: "unknown" })]) {
      site.paid = answer;
      const deps = context();
      const result = await topUp(deps);
      expect(seen.paid).toBeGreaterThan(0);
      expect(result.attempt?.state).toBe("uncertain");
      expectUnknown(result);
      seen = { credit: 0, create: 0, unpaid: 0, paid: 0 };
    }
  });

  it("is unknown when the command throws while following it, from the attempt's record and not as 'not started'", async () => {
    let release: (res: Response) => void = () => undefined;
    site.paid = () => new Promise<Response>((resolve) => (release = resolve));
    const deps = context();
    vi.spyOn(deps.engine, "waitForAttempt").mockImplementationOnce(async (id) => {
      for (let i = 0; i < 500 && deps.engine.getAttempt(id)?.state !== "submitting"; i += 1) await new Promise((r) => setTimeout(r, 10));
      throw new Error("the disk is full");
    });
    const result = await topUp(deps);
    release(failure(500, "internal_error"));
    expect(result.attempt?.state).toBe("uncertain");
    expectUnknown(result);
    expect(result.message).not.toContain("not started");
    expect(deps.records.listAttempts()[0]?.state).toBe("uncertain");
  });
});

describe("a second top-up while an earlier one may have been paid", () => {
  it("does not create another when this machine's record of the earlier payment is uncertain", async () => {
    site.paid = pending;
    const deps = context();
    expect((await topUp(deps)).attempt?.state).toBe("uncertain");
    expect(seen.create).toBe(1);

    // The site no longer lists the top-up (it fell off the recent list), so only the record speaks.
    const refusal = await topUp(context(dirs[0])).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(CliError);
    expect((refusal as CliError).exitCode).toBe(3);
    expect((refusal as CliError).message).toMatch(/earlier top-up is not settled.*a new top-up could pay twice.*created and paid nothing.*seller credit.*status <attempt>/is);
    expect(seen.create).toBe(1);
  });

  it("is released by the site's word on a top-up it lists, and by nothing else", async () => {
    site.paid = pending;
    expect((await topUp(context())).attempt?.state).toBe("uncertain");
    site.credit = () => credit([view()]);
    expect((await topUp(context(dirs[0]))).exitCode).toBe(5);
    expect(seen.create).toBe(2);
  });

  it("does not create another while the site lists a top-up as pending", async () => {
    site.credit = () => credit([view({ status: "pending" })]);
    await expect(topUp(context())).rejects.toThrow(/pending on the site/);
    expect(seen.create).toBe(0);
  });

  it("creates the next one once the site lists the earlier top-up as paid", async () => {
    site.paid = pending;
    expect((await topUp(context())).attempt?.state).toBe("uncertain");
    site.credit = () => credit([view({ status: "paid", pay_url: null })]);
    site.unpaid = pending;
    const result = await topUp(context(dirs[0]));
    expect(seen.create).toBe(2);
    expect(result.exitCode).toBe(5);
  });

  it("is released once `status` has the chain confirm a paid attempt, though the site no longer lists its top-up", async () => {
    site.paid = () => new Response("{}", { status: 500, headers: { "payment-response": receiptHeader(wallet) } });
    const first = context();
    const paid = (await topUp(first)).attempt;
    expect(paid?.state).toBe("paid_service_failed");
    await expect(topUp(context(dirs[0]))).rejects.toThrow(/status <attempt>/);
    expect(seen.create).toBe(1);
    // What `superstables status` records once the chain shows the payment.
    first.records.saveAttempt({ ...(paid as NonNullable<typeof paid>), chain: "verified" });
    expect((await topUp(context(dirs[0]))).exitCode).toBe(4);
    expect(seen.create).toBe(2);
  });

  it("is not stopped by an earlier top-up that was refused before anything was signed", async () => {
    site.unpaid = (n) => (n === 1 ? challenge() : failure(429, "rate_limited"));
    expect((await topUp(context())).exitCode).toBe(1);
    expect((await topUp(context(dirs[0]))).exitCode).toBe(1);
    expect(seen.create).toBe(2);
  });
});

describe("two top-up commands at once", () => {
  it("let only one pass the check: the other waits for the lock and then finds the first one's payment", async () => {
    let release: (res: Response) => void = () => undefined;
    site.paid = () => new Promise<Response>((resolve) => (release = resolve));
    const first = context();
    const second = context(dirs[0]);
    const both = Promise.allSettled([topUp(first), topUp(second)]);
    // The one that got the lock pays and waits for the site; the other is refused when it takes the lock.
    for (let i = 0; i < 500 && seen.paid === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(seen.paid).toBe(1);
    release(failure(500, "internal_error"));
    const outcomes = await both;
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(CliError);
    expect((refused.reason as CliError).exitCode).toBe(3);
    expect(seen.create).toBe(1);
  });
});

describe("a site that echoes the API key", () => {
  const key = (text: string) => text.replaceAll("{key}", KEY);

  async function expectClean(deps: PaymentContext, output: string) {
    expect(output).not.toContain(KEY);
    expect(recorded(deps.records.dir)).not.toContain(KEY);
  }

  it("is not saved or printed from a 402's description: the quote is refused", async () => {
    site.unpaid = () => challenge(key("pay with {key}"));
    const deps = context();
    const lines: string[] = [];
    const result = await topUp(deps, lines);
    expectUnknown(result);
    expect(deps.records.listAttempts()).toEqual([]);
    await expectClean(deps, shown(result, lines));
  });

  it("is not printed from the error code, the message or any field of an answer to the pay link", async () => {
    for (const answer of [
      failure(409, KEY, { money_moved: "unknown" }),
      reply(409, { error: { code: "payment_pending", message: key("see {key}"), money_moved: "unknown" } }),
      reply(410, { error: { code: "top_up_retired", extra: key("{key}") } }),
    ]) {
      site.unpaid = () => answer.clone();
      const deps = context();
      const result = await topUp(deps);
      expectUnknown(result);
      await expectClean(deps, shown(result));
    }
  });

  it("is refused on the engine's own read, before the engine keeps it", async () => {
    site.unpaid = (n) => (n === 1 ? challenge() : failure(409, KEY, { money_moved: "unknown" }));
    const deps = context();
    const result = await topUp(deps);
    expect(result.attempt?.state).toBe("failed");
    expectUnknown(result);
    await expectClean(deps, shown(result));
  });

  it("is refused in a header of the 402, plain or as base64", async () => {
    for (const header of [KEY, Buffer.from(JSON.stringify({ x: KEY })).toString("base64")]) {
      const answer = failure(409, "payment_pending", { money_moved: "unknown" });
      answer.headers.set("x-echo", header);
      site.unpaid = (n) => (n === 1 ? challenge() : answer.clone());
      const deps = context();
      const result = await topUp(deps);
      expectUnknown(result);
      await expectClean(deps, shown(result));
    }
  });

  it("is refused in the answer to the payment, which is then unknown and records nothing of it", async () => {
    site.paid = () => failure(402, key("{key}"));
    const deps = context();
    const result = await topUp(deps);
    expect(seen.paid).toBe(1);
    expect(result.attempt?.state).toBe("uncertain");
    expectUnknown(result);
    await expectClean(deps, shown(result));
  });

  it("is refused in the answer that creates the top-up, before anything is quoted or saved", async () => {
    site.create = () => reply(201, { top_up: view({ status: KEY }) });
    const deps = context();
    const err = await topUp(deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SellerApiError);
    expect((err as SellerApiError).code).toBe("key_echoed");
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(seen.unpaid).toBe(0);
    await expectClean(deps, "");
  });

  it("is refused in the credit read that comes before a create, so nothing is created", async () => {
    site.credit = () => reply(200, { balance: "1", entries: [{ source_id: KEY }], top_ups: [] });
    const err = await topUp(context()).catch((e: unknown) => e);
    expect((err as SellerApiError).code).toBe("key_echoed");
    expect(seen.create).toBe(0);
  });

  it("is refused in the quote's own 402 header, plain, as base64 or base64url, escaped in the JSON, or split by an invisible character", async () => {
    const asked = (description: string) => JSON.stringify({ ...(challengeJson as object), resource: { url: PAY_URL, description } });
    const texts = [
      asked(`pay with ${KEY}`),
      asked(`pay with ${KEY}`).replace(KEY, `\\u0073${KEY.slice(1)}`),
      asked(`pay with ${KEY.slice(0, 5)}\u200b${KEY.slice(5)}`),
    ];
    for (const text of texts) {
      for (const encoded of [Buffer.from(text).toString("base64"), Buffer.from(text).toString("base64url")]) {
        site.unpaid = () => new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": encoded } });
        const deps = context();
        const result = await topUp(deps);
        expectUnknown(result);
        expect(deps.records.listAttempts()).toEqual([]);
        await expectClean(deps, shown(result));
      }
    }
  });

  it("is refused in the engine's read when the JSON writes it with escapes, and in a field split by an invisible character", async () => {
    const escaped = `{"error":{"code":"payment_pending","message":"see \\u0073${KEY.slice(1)}","money_moved":"unknown"}}`;
    site.unpaid = (n) => (n === 1 ? challenge() : new Response(escaped, { status: 409, headers: { "content-type": "application/json" } }));
    const deps = context();
    const result = await topUp(deps);
    expectUnknown(result);
    await expectClean(deps, shown(result));

    const split = `${KEY.slice(0, 5)}\u200b${KEY.slice(5)}`;
    site.create = () => reply(201, { top_up: view({ status: split }) });
    const created = context();
    const err = await topUp(created).catch((e: unknown) => e);
    expect((err as SellerApiError).code).toBe("key_echoed");
    await expectClean(created, String(err));
  });
});
