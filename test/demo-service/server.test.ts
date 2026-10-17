// What the demo service promises its buyers, checked against a facilitator that never
// touches a chain: a bad request costs nothing, a challenge says exactly what is owed, a
// payment that settles is answered, and a payment that does not settle is refused with the
// reason. No network: every server here listens on 127.0.0.1 on a port the OS picks.

import { afterEach, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_SEPOLIA, toAtomic, usdcRequirement } from "../../src/core/chain.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { parseChallenge, termsFor } from "../../src/core/x402.js";
import { percentChange } from "../../src/demo-service/prices.js";
import { startDemoService, SERVICE_NAME, type DemoService } from "../../src/demo-service/server.js";
import { FAKE_INVALID_REASON, startFakeFacilitator, type FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startPaidEndpoint, type PaidEndpoint } from "../helpers/paid-endpoint.js";

const PAY_TO = "0x1234567890AbcdEF1234567890aBcdef12345678";
const PRICE = 0.01;

const PRICES = {
  BTC: { usd: 65000.12, at: "2026-09-16T10:00:00.000Z", change24hPct: 1.25, source: "live" as const },
  ETH: { usd: 3200.5, at: "2026-09-16T10:00:00.000Z", change24hPct: -0.4, source: "live" as const },
};

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function service(opts: Partial<Parameters<typeof startDemoService>[0]> = {}): Promise<DemoService> {
  const started = await startDemoService({
    port: 0,
    payTo: PAY_TO,
    priceDecimal: PRICE,
    quiet: true,
    priceSource: async () => PRICES,
    ...opts,
  });
  closers.push(() => started.close());
  return started;
}

async function facilitator(opts: Parameters<typeof startFakeFacilitator>[0] = {}): Promise<FakeFacilitator> {
  const started = await startFakeFacilitator(opts);
  closers.push(() => started.close());
  return started;
}

async function endpoint(opts: Parameters<typeof startPaidEndpoint>[0]): Promise<PaidEndpoint> {
  const started = await startPaidEndpoint(opts);
  closers.push(() => started.close());
  return started;
}

/** The challenge the service answers with, decoded from its PAYMENT-REQUIRED header. */
async function challengeOf(url: string): Promise<{ status: number; header: string | null; requirement: PaymentRequirements }> {
  const res = await fetch(url);
  const header = res.headers.get("payment-required");
  const decoded = decodePaymentRequiredHeader(header ?? "");
  return { status: res.status, header, requirement: decoded.accepts[0] };
}

/** A real EIP-3009 credential over `requirement`, signed by a throwaway key. */
async function credentialFor(requirement: PaymentRequirements): Promise<{ header: string; payer: string }> {
  const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
  const signed = await signer.sign({ kind: "eip3009", requirements: requirement, x402Version: 2 });
  const header = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: requirement,
    payload: signed.payload as Record<string, unknown>,
  });
  return { header, payer: signed.signer };
}

describe("demo service: what costs nothing", () => {
  it("describes itself, its parameters and its price at /", async () => {
    await facilitator();
    const demo = await service();
    const res = await fetch(demo.url);
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.name).toBe(SERVICE_NAME);
    expect(body.description).toContain("no real money");
    expect(body.endpoint).toBe(`${demo.url}/v1/market`);
    expect(body.params[0]).toMatchObject({ name: "asset", required: true, enum: ["BTC", "ETH"] });
    expect(body.price).toMatchObject({ amountDecimal: PRICE, asset: "USDC" });
    expect(body.payment).toMatchObject({ network: BASE_SEPOLIA.caip2, scheme: "exact", payTo: PAY_TO });
    expect(body.payment.asset.address).toBe(BASE_SEPOLIA.usdc.address);
  });

  it("answers /health", async () => {
    const demo = await service();
    const res = await fetch(`${demo.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses a request with no asset with 400, before asking for any payment", async () => {
    const fake = await facilitator();
    const demo = await service({ facilitators: [fake.url] });
    const res = await fetch(`${demo.url}/v1/market`);

    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(await res.json()).toEqual({ error: "the asset parameter is required", allowed: ["BTC", "ETH"] });
    expect(fake.calls).toMatchObject({ verify: 0, settle: 0 });
  });

  it("refuses an unknown asset with 400, before asking for any payment", async () => {
    const fake = await facilitator();
    const demo = await service({ facilitators: [fake.url] });
    const res = await fetch(`${demo.url}/v1/market?asset=DOGE`);
    const body = (await res.json()) as { error: string; allowed: string[] };

    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(body.error).toContain("DOGE");
    expect(body.allowed).toEqual(["BTC", "ETH"]);
    expect(fake.calls).toMatchObject({ verify: 0, settle: 0 });
  });

  it("answers 402 with terms that say exactly what is owed, in the header and the body", async () => {
    const demo = await service();
    const res = await fetch(`${demo.url}/v1/market?asset=BTC`);
    const header = res.headers.get("payment-required");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expect(header).toBeTruthy();
    const decoded = decodePaymentRequiredHeader(header!);
    expect(decoded).toEqual(body);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.error).toBe("Payment required");
    expect(decoded.resource.url).toBe(`${demo.url}/v1/market?asset=BTC`);
    expect(decoded.resource.description).toContain("spot price and 24h change");
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]).toEqual(usdcRequirement(PRICE, PAY_TO));
  });
});

describe("demo service: paying for a call", () => {
  it("verifies, settles and answers with the data and the receipt", async () => {
    const fake = await facilitator();
    const demo = await service({ facilitators: [fake.url] });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=BTC`);
    const { header, payer } = await credentialFor(requirement);

    const res = await fetch(`${demo.url}/v1/market?asset=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    const receipt = decodePaymentResponseHeader(res.headers.get("payment-response") ?? "");
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe(fake.transaction);
    expect(receipt.payer).toBe(payer);

    expect(body.asset).toBe("BTC");
    expect(body.price_usd).toBe(PRICES.BTC.usd);
    expect(body.change_24h_pct).toBe(PRICES.BTC.change24hPct);
    expect(body.as_of).toBe(PRICES.BTC.at);
    expect(body.source).toBe("live");
    expect(body.paid).toEqual({
      amount: "0.01",
      asset: "USDC",
      network: BASE_SEPOLIA.caip2,
      transaction: fake.transaction,
    });

    expect(fake.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(fake.lastSettle?.requirements.amount).toBe(toAtomic(PRICE, BASE_SEPOLIA.token.decimals));
    expect(fake.lastSettle?.requirements.payTo).toBe(PAY_TO);
  });

  it("still answers a paid call when the price feed is down, and says so", async () => {
    const fake = await facilitator();
    const demo = await service({
      facilitators: [fake.url],
      priceSource: async () => {
        throw new Error("upstream is down");
      },
    });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=ETH`);
    const { header } = await credentialFor(requirement);

    const res = await fetch(`${demo.url}/v1/market?asset=ETH`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.price_usd).toBeNull();
    expect(body.source).toBe("unavailable");
    expect(body.note).toContain("the payment settled");
    expect(body.paid.transaction).toBe(fake.transaction);
  });

  it("refuses a credential written for different terms, without asking a facilitator", async () => {
    const fake = await facilitator();
    const demo = await service({ facilitators: [fake.url] });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=BTC`);
    const cheaper: PaymentRequirements = { ...requirement, amount: toAtomic(PRICE / 2, BASE_SEPOLIA.token.decimals) };
    const { header } = await credentialFor(cheaper);

    const res = await fetch(`${demo.url}/v1/market?asset=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as { error: string; accepts: PaymentRequirements[] };

    expect(res.status).toBe(402);
    expect(body.error).toContain("does not match");
    expect(body.accepts[0]).toEqual(usdcRequirement(PRICE, PAY_TO));
    expect(fake.calls).toMatchObject({ verify: 0, settle: 0 });
  });

  it("falls over to the next facilitator when the first one is down", async () => {
    const dead = await facilitator({ failWith: 503 });
    const alive = await facilitator();
    const demo = await service({ facilitators: [dead.url, alive.url] });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=BTC`);
    const { header } = await credentialFor(requirement);

    const res = await fetch(`${demo.url}/v1/market?asset=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as Record<string, any>;

    expect(res.status).toBe(200);
    expect(body.paid.transaction).toBe(alive.transaction);
    expect(dead.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(alive.calls).toMatchObject({ verify: 1, settle: 1 });
  });

  it("refuses with the facilitator's reason when verification fails, and never settles", async () => {
    const fake = await facilitator({ verifyOk: false });
    const demo = await service({ facilitators: [fake.url] });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=BTC`);
    const { header } = await credentialFor(requirement);

    const res = await fetch(`${demo.url}/v1/market?asset=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe(FAKE_INVALID_REASON);
    expect(fake.calls).toMatchObject({ verify: 1, settle: 0 });
  });

  it("refuses when the facilitator reports the transfer failed", async () => {
    const fake = await facilitator({ settleOk: false });
    const demo = await service({ facilitators: [fake.url] });
    const { requirement } = await challengeOf(`${demo.url}/v1/market?asset=BTC`);
    const { header } = await credentialFor(requirement);

    const res = await fetch(`${demo.url}/v1/market?asset=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(402);
    expect(body.error).toBe("settlement_failed");
    expect(fake.calls).toMatchObject({ verify: 1, settle: 1 });
  });
});

describe("the test helpers themselves", () => {
  it("the fake facilitator advertises the one kind this release pays in", async () => {
    const fake = await facilitator();
    const res = await fetch(`${fake.url}/supported`);
    const body = (await res.json()) as { kinds: Array<Record<string, unknown>>; extensions: string[] };

    expect(res.status).toBe(200);
    expect(body.kinds[0]).toEqual({ x402Version: 2, scheme: "exact", network: BASE_SEPOLIA.caip2 });
    expect(body.extensions).toEqual([]);
    expect(fake.calls.supported).toBe(1);
  });

  it("the paid endpoint speaks v1: a body-only challenge the client can read and pay", async () => {
    const fake = await facilitator();
    const seller = await endpoint({ priceDecimal: PRICE, payTo: PAY_TO, facilitatorUrl: fake.url, version: 1 });

    const res = await fetch(seller.url);
    expect(res.status).toBe(402);
    const challenge = parseChallenge({ body: await res.text() });
    expect(challenge.version).toBe(1);
    const judged = termsFor(challenge.accepts[0], 1);
    expect(judged.supported).toBe(true);
    if (!judged.supported) return;
    expect(judged.terms.amountAtomic).toBe(toAtomic(PRICE, BASE_SEPOLIA.token.decimals));
    expect(judged.terms.recipient).toBe(PAY_TO);
    expect(judged.terms.network).toBe(BASE_SEPOLIA.caip2);

    const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
    const signed = await signer.sign({ kind: "eip3009", requirements: judged.requirement, x402Version: 1 });
    const credential = Buffer.from(
      JSON.stringify({ x402Version: 1, scheme: "exact", network: BASE_SEPOLIA.v1Name, payload: signed.payload }),
      "utf8",
    ).toString("base64");

    const paid = await fetch(seller.url, { headers: { "X-PAYMENT": credential } });
    expect(paid.status).toBe(200);
    const receipt = decodePaymentResponseHeader(paid.headers.get("x-payment-response") ?? "");
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe(fake.transaction);
    expect(seller.hits.paid).toBe(1);
  });

  it("the paid endpoint can take the money and then fail, receipt header and all", async () => {
    const fake = await facilitator();
    const seller = await endpoint({
      priceDecimal: PRICE,
      payTo: PAY_TO,
      facilitatorUrl: fake.url,
      behaviour: "service-500-after-payment",
    });

    const challenged = await fetch(seller.url);
    const requirement = decodePaymentRequiredHeader(challenged.headers.get("payment-required") ?? "").accepts[0];
    const { header } = await credentialFor(requirement);

    const res = await fetch(seller.url, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(res.status).toBe(500);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response") ?? "").success).toBe(true);
    expect(seller.hits.paid).toBe(1);
    expect(fake.calls.settle).toBe(1);
  });

  it("the paid endpoint can raise its price after the first challenge", async () => {
    const fake = await facilitator();
    const seller = await endpoint({
      priceDecimal: PRICE,
      payTo: PAY_TO,
      facilitatorUrl: fake.url,
      behaviour: "change-price-after-first-402",
    });

    const first = decodePaymentRequiredHeader((await fetch(seller.url)).headers.get("payment-required") ?? "");
    const second = decodePaymentRequiredHeader((await fetch(seller.url)).headers.get("payment-required") ?? "");

    expect(first.accepts[0].amount).toBe(toAtomic(PRICE, BASE_SEPOLIA.token.decimals));
    expect(second.accepts[0].amount).toBe(toAtomic(PRICE * 2, BASE_SEPOLIA.token.decimals));
  });
});

describe("the price feed's arithmetic", () => {
  it("reports the 24h change in percent, and says nothing when it cannot", () => {
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(99.5, 100)).toBe(-0.5);
    expect(percentChange(65432.1, 64000)).toBe(2.24);
    expect(percentChange(100, null)).toBeNull();
    expect(percentChange(null, 100)).toBeNull();
    expect(percentChange(100, 0)).toBeNull();
  });
});
