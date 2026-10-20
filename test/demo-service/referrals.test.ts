// The demo service as a seller listed on Superstables: with a claim challenge it publishes the challenge where
// superstables.com looks for it, and it answers a paid request that carries a referral without calling the site.

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { sellerOptionsFromEnvironment, startDemoService, type DemoService } from "../../src/demo-service/server.js";
import { clearReferralKeysCache } from "../../src/seller/referral.js";
import { startFakeFacilitator } from "../helpers/fake-facilitator.js";
import { referralKey, signReferral, startFakeReferralSite, type FakeReferralSite, type TestReferralKey } from "../helpers/referrals.js";

const PAY_TO = "0x1234567890AbcdEF1234567890aBcdef12345678";
const CLAIM = `ssc_${"c".repeat(32)}`;
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

describe("referral headers", () => {
  it("answers a referred paid request without reading the site's keys", async () => {
    const key = referralKey();
    const s = await site(key);
    const fake = await facilitator();
    const service = await demo({ facilitators: [fake.url] });
    const { token } = signReferral(key, { iss: s.url, aud: service.url });
    expect((await paidRequest(`${service.url}/v1/market?asset=BTC`, { "Superstables-Referral": token })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(s.keyReads).toBe(0);
  });
});

describe("sellerOptionsFromEnvironment", () => {
  it("is empty when nothing is set, and reads the claim challenge", () => {
    expect(sellerOptionsFromEnvironment({})).toEqual({});
    expect(sellerOptionsFromEnvironment({ SUPERSTABLES_CLAIM_CHALLENGE: CLAIM })).toEqual({ claimChallenge: CLAIM });
  });

  it("refuses a claim challenge it cannot use", () => {
    expect(() => sellerOptionsFromEnvironment({ SUPERSTABLES_CLAIM_CHALLENGE: "ssc_bad value\r\n" })).toThrow(/SUPERSTABLES_CLAIM_CHALLENGE/);
  });
});
