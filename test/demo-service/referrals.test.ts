// The demo service as a seller that takes Superstables referrals: with a claim challenge it publishes the challenge where
// superstables.com looks for it; with a seller key it verifies the referral a paid request carries and reports what
// happened to the purchase, after the buyer has its answer and without ever changing it. Everything is off by default.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA, toAtomic } from "../../src/core/chain.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { sellerOptionsFromEnvironment, startDemoService, type DemoService } from "../../src/demo-service/server.js";
import { clearReferralKeysCache } from "../../src/seller/referral.js";
import { startFakeFacilitator } from "../helpers/fake-facilitator.js";
import { referralKey, signReferral, startFakeReferralSite, type FakeReferralSite, type TestReferralKey } from "../helpers/referrals.js";

const PAY_TO = "0x1234567890AbcdEF1234567890aBcdef12345678";
const API_KEY = `sssk_${"B".repeat(43)}`;
const CLAIM = `ssc_${"c".repeat(32)}`;
/** The public origin the demo is told it serves; tokens name it as their audience. */
const ORIGIN = "https://api.example.com";
const PRICES = { BTC: { usd: 65000, at: "2026-10-11T10:00:00.000Z", change24hPct: 1, source: "live" as const } };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  clearReferralKeysCache();
  while (closers.length) await closers.pop()!();
});

async function demo(opts: Partial<Parameters<typeof startDemoService>[0]> = {}): Promise<DemoService> {
  const started = await startDemoService({ port: 0, payTo: PAY_TO, priceDecimal: 0.01, quiet: true, priceSource: async () => PRICES, ...opts });
  closers.push(() => started.close());
  return started;
}

async function facilitator(opts: Parameters<typeof startFakeFacilitator>[0] = {}) {
  const started = await startFakeFacilitator(opts);
  closers.push(() => started.close());
  return started;
}

async function site(key: TestReferralKey): Promise<FakeReferralSite> {
  const started = await startFakeReferralSite([key.jwk]);
  closers.push(() => started.close());
  return started;
}

/** A paid request to `url`: a real credential over the service's own terms, plus `headers`. */
async function paidRequest(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const challenge = await fetch(url);
  const requirement = decodePaymentRequiredHeader(challenge.headers.get("payment-required") ?? "").accepts[0] as PaymentRequirements;
  const signed = await new LocalKeySigner(privateKeyToAccount(generatePrivateKey())).sign({ kind: "eip3009", requirements: requirement, x402Version: 2 });
  const credential = encodePaymentSignatureHeader({ x402Version: 2, accepted: requirement, payload: signed.payload as Record<string, unknown> });
  return fetch(url, { headers: { "PAYMENT-SIGNATURE": credential, ...headers } });
}

/** The demo's log lines, while it runs with quiet off. */
function logLines(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("claim challenge", () => {
  it("serves /.well-known/superstables.txt and adds Superstables-Claim to every answer of the endpoint", async () => {
    const fake = await facilitator();
    const service = await demo({ claimChallenge: CLAIM, facilitators: [fake.url] });
    const txt = await fetch(`${service.url}/.well-known/superstables.txt`);
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toContain("text/plain");
    expect(await txt.text()).toBe(`superstables-claim=${CLAIM}\n`);
    const challenge = await fetch(`${service.url}/v1/market?asset=BTC`);
    expect(challenge.status).toBe(402);
    expect(challenge.headers.get("superstables-claim")).toBe(CLAIM);
    const refused = await fetch(`${service.url}/v1/market`);
    expect(refused.status).toBe(400);
    expect(refused.headers.get("superstables-claim")).toBe(CLAIM);
    const paid = await paidRequest(`${service.url}/v1/market?asset=BTC`);
    expect(paid.status).toBe(200);
    expect(paid.headers.get("superstables-claim")).toBe(CLAIM);
  });

  it("is off by default", async () => {
    const service = await demo();
    expect((await fetch(`${service.url}/.well-known/superstables.txt`)).status).toBe(404);
    expect((await fetch(`${service.url}/v1/market?asset=BTC`)).headers.get("superstables-claim")).toBeNull();
  });
});

describe("referral reporting", () => {
  it("verifies the referral and reports the purchase fulfilled with its settlement, after answering the buyer", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const service = await demo({ facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN } });
    const { token } = signReferral(key, { iss: s.url, aud: ORIGIN });

    const res = await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token, "Superstables-Purchase-Ref": "att-1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { asset: string }).asset).toBe("BTC");

    await until(() => s.events.length === 1);
    const [event] = s.events;
    expect(event!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(event!.headers["idempotency-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(event!.body).toMatchObject({
      type: "fulfilled",
      referral: token,
      purchase_ref: "att-1",
      occurred_at: expect.any(String),
      settlement: {
        network: BASE_SEPOLIA.caip2,
        transaction: fake.transaction,
        payer: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        amount: toAtomic(0.01),
        asset: BASE_SEPOLIA.usdc.address,
        status: "settled",
      },
    });
  });

  it("checks the listing id instead of the origin when one is configured", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const service = await demo({ facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, listingId: "api.example.com" } });
    const { token } = signReferral(key, { iss: s.url });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    await until(() => s.events.length === 1);
    expect(s.events[0]!.body.purchase_ref).toBeUndefined();
  });

  it("reports a settlement that failed as failed, and the buyer still gets the 402", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator({ settleOk: false });
    const service = await demo({ facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN } });
    const { token } = signReferral(key, { iss: s.url, aud: ORIGIN });
    const res = await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token, "Superstables-Purchase-Ref": "att-2" });
    expect(res.status).toBe(402);
    await until(() => s.events.length === 1);
    expect(s.events[0]!.body).toMatchObject({ type: "failed", purchase_ref: "att-2" });
    expect(s.events[0]!.body.settlement).toBeUndefined();
  });

  it("reports nothing for a referral it does not accept, and never takes the audience from the request", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const lines = logLines();
    const service = await demo({ quiet: false, facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN } });
    // A token for the origin the request was made to (its Host header), which is not the configured origin.
    const { token } = signReferral(key, { iss: s.url, aud: service.url, sub: new URL(service.url).host });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    await until(() => lines.some((l) => l.includes("referral not accepted: wrong_audience")));
    expect(s.events).toHaveLength(0);
  });

  it("requires both the listing id and the origin when both are configured", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const lines = logLines();
    const service = await demo({ quiet: false, facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN, listingId: "api.example.com" } });
    const wrongListing = signReferral(key, { iss: s.url, aud: ORIGIN, sub: "other.example" }).token;
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": wrongListing })).status).toBe(200);
    await until(() => lines.some((l) => l.includes("referral not accepted: wrong_audience")));
    const both = signReferral(key, { iss: s.url, aud: ORIGIN, sub: "api.example.com" }).token;
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": both })).status).toBe(200);
    await until(() => s.events.length === 1);
  });

  it("does not check a referral on a payment the facilitator rejects", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator({ verifyOk: false });
    const service = await demo({ facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN } });
    const { token } = signReferral(key, { iss: s.url, aud: ORIGIN });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(402);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.keyReads).toBe(0);
    expect(s.events).toHaveLength(0);
  });

  it("checks and reports nothing without a listing id or an origin, and says why once", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const lines = logLines();
    const service = await demo({ quiet: false, facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url } });
    const { token } = signReferral(key, { iss: s.url, aud: service.url });
    for (let i = 0; i < 2; i += 1) {
      expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines.filter((l) => l.includes("referrals are not checked or reported"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("verified and reported"))).toBe(false);
    expect(s.keyReads).toBe(0);
    expect(s.events).toHaveLength(0);
  });

  it("logs a report the site refused by its error code only, never the key or the token", async () => {
    const key = referralKey();
    const s = await site(key);
    s.failNext.push(503, 503, 503, 503);
    const fake = await facilitator();
    const lines = logLines();
    const service = await demo({ quiet: false, facilitators: [fake.url], referrals: { apiKey: API_KEY, site: s.url, origin: ORIGIN } });
    const { token } = signReferral(key, { iss: s.url, aud: ORIGIN });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    await until(() => lines.some((l) => l.includes("referral fulfilled not reported: internal_error")), 15_000);
    expect(lines.join("\n")).not.toContain(API_KEY);
    expect(lines.join("\n")).not.toContain(token);
  }, 20_000);

  it("ignores the referral headers when reporting is off", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const service = await demo({ facilitators: [fake.url] });
    const { token } = signReferral(key, { iss: s.url, aud: service.url });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.keyReads).toBe(0);
    expect(s.events).toHaveLength(0);
  });
});

describe("sellerOptionsFromEnvironment", () => {
  it("is empty when nothing is set, and reads the five variables", () => {
    expect(sellerOptionsFromEnvironment({})).toEqual({});
    expect(
      sellerOptionsFromEnvironment({
        SUPERSTABLES_CLAIM_CHALLENGE: CLAIM,
        SUPERSTABLES_SELLER_KEY: API_KEY,
        SUPERSTABLES_SELLER_SITE: "http://127.0.0.1:3000",
        SUPERSTABLES_SELLER_LISTING: "127.0.0.1:4402",
        SUPERSTABLES_SELLER_ORIGIN: "http://127.0.0.1:4402/v1/market",
      }),
    ).toEqual({
      claimChallenge: CLAIM,
      referrals: { apiKey: API_KEY, site: "http://127.0.0.1:3000", listingId: "127.0.0.1:4402", origin: "http://127.0.0.1:4402" },
    });
    expect(sellerOptionsFromEnvironment({ SUPERSTABLES_SELLER_KEY: API_KEY }).referrals?.site).toBe("https://www.superstables.com");
  });

  it("refuses values it cannot use, without repeating the key", () => {
    expect(() => sellerOptionsFromEnvironment({ SUPERSTABLES_CLAIM_CHALLENGE: "ssc_bad value\r\n" })).toThrow(/SUPERSTABLES_CLAIM_CHALLENGE/);
    expect(() => sellerOptionsFromEnvironment({ SUPERSTABLES_SELLER_ORIGIN: "api.example.com" })).toThrow(/SUPERSTABLES_SELLER_ORIGIN/);
    const bad = "not-a-seller-key-but-secret";
    let message = "";
    try {
      sellerOptionsFromEnvironment({ SUPERSTABLES_SELLER_KEY: bad });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/SUPERSTABLES_SELLER_KEY/);
    expect(message).not.toContain(bad);
    expect(() => sellerOptionsFromEnvironment({ SUPERSTABLES_SELLER_KEY: API_KEY, SUPERSTABLES_SELLER_SITE: "http://site.example.com" })).toThrow(/https/);
  });
});
