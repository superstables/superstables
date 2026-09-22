// The paid route end to end on loopback: a bad request costs nothing, a good one is met with
// a 402 carrying our exact terms, a credential for other terms is refused, and a credential
// the (fake) facilitator verifies and settles unlocks the prepared answer with the receipt
// header. The market data route and the hosted catalogue are checked the same way.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as catalogueGet } from "../../app/api/demo/catalogue/route";
import { GET as servicesGet } from "../../app/api/demo/services/route";
import { GET as marketGet } from "../../app/api/demo/market/route";
import { GET, OPTIONS } from "../../app/api/demo/services/[service]/route";
import { DEMO_SERVICES, atomicUnits, bySlug } from "../../lib/demoServices/registry";

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const PAYER = "0x1111111111111111111111111111111111111111";
const TRANSACTION = `0x${"ab".repeat(32)}`;

// ── A facilitator that answers on loopback ─────────────────────────────────────────────

const facilitator = { url: "", verify: 0, settle: 0, mode: "approve" as "approve" | "invalid" | "unsettled", sent: [] as PaymentRequirements[] };
let server: ReturnType<typeof createServer>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    try {
      const sent = JSON.parse(raw) as { paymentRequirements?: PaymentRequirements };
      if (sent.paymentRequirements) facilitator.sent.push(sent.paymentRequirements);
    } catch {
      // not JSON: the assertion on `sent` will say so
    }
    const reply = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/verify") {
      facilitator.verify += 1;
      return reply(facilitator.mode === "invalid" ? { isValid: false, invalidReason: "insufficient_funds" } : { isValid: true, payer: PAYER });
    }
    if (req.url === "/settle") {
      facilitator.settle += 1;
      return reply(
        facilitator.mode === "unsettled"
          ? { success: false, errorReason: "settlement_reverted", transaction: "", network: "eip155:84532" }
          : { success: true, transaction: TRANSACTION, network: "eip155:84532", payer: PAYER },
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  facilitator.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPERSTABLES_DEMO_FACILITATORS = facilitator.url;
  process.env.SUPERSTABLES_DEMO_PAY_TO = PAY_TO;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.SUPERSTABLES_DEMO_FACILITATORS;
  delete process.env.SUPERSTABLES_DEMO_PAY_TO;
});

afterEach(() => {
  facilitator.mode = "approve";
  facilitator.verify = 0;
  facilitator.settle = 0;
  facilitator.sent = [];
  process.env.SUPERSTABLES_DEMO_PAY_TO = PAY_TO;
});

// ── Calling the route the way Vercel would ─────────────────────────────────────────────

/** The public origin the forwarding headers name; the resource URL in every challenge uses it. */
const ORIGIN = "https://demo.test";

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "demo.test", ...headers },
  });
}

function call(slug: string, query: string, headers: Record<string, string> = {}) {
  return GET(request(`/api/demo/services/${slug}${query ? `?${query}` : ""}`, headers), { params: Promise.resolve({ service: slug }) });
}

function credentialFor(accepted: PaymentRequirements): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: {
      signature: `0x${"cd".repeat(65)}`,
      authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: "9999999999", nonce: `0x${"00".repeat(32)}` },
    },
  });
}

async function termsOf(res: Response): Promise<{ url: string; requirement: PaymentRequirements; body: Record<string, unknown> }> {
  expect(res.status).toBe(402);
  const header = res.headers.get("PAYMENT-REQUIRED");
  expect(header).toBeTruthy();
  const decoded = decodePaymentRequiredHeader(header as string);
  const body = (await res.json()) as { accepts: unknown; resource: { url: string } };
  expect(body.accepts).toEqual(decoded.accepts);
  expect(body.resource.url).toBe(decoded.resource?.url);
  return { url: body.resource.url, requirement: decoded.accepts[0], body };
}

describe("a prepared demo service route", () => {
  const def = bySlug("wallet-briefing")!;
  const good = "sample_wallet=demo-active&period=30d";

  it("answers 404 for a service that does not exist, and charges nothing", async () => {
    const res = await call("nothing-here", "");
    expect(res.status).toBe(404);
    expect((await res.json()).catalogue).toBe(`${ORIGIN}/api/demo/catalogue`);
  });

  it("answers 400 with the allowed values when the request is wrong, before any challenge", async () => {
    for (const query of ["", "sample_wallet=nope", "sample_wallet=demo-active&period=1y", "sample_wallet=demo-active&extra=1", "sample_wallet=demo-active&sample_wallet=demo-dormant"]) {
      const res = await call("wallet-briefing", query);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
      const body = await res.json();
      expect(body.error, query).toBeTruthy();
      expect(body.allowed.sample_wallet, query).toContain("demo-active");
    }
    expect(facilitator.verify + facilitator.settle).toBe(0);
  });

  it("answers 503 and charges nothing when no payout address is configured", async () => {
    delete process.env.SUPERSTABLES_DEMO_PAY_TO;
    const res = await call("wallet-briefing", good);
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("answers a valid unpaid request with 402 and our exact terms, and no data", async () => {
    const res = await call("wallet-briefing", good);
    const { url, requirement, body } = await termsOf(res);
    expect(url).toBe(`${ORIGIN}/api/demo/services/wallet-briefing?${good}`);
    expect(requirement).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: atomicUnits(def.price), payTo: PAY_TO });
    const text = JSON.stringify(body);
    expect(text).not.toContain('"data"');
    expect(text).not.toContain('"summary"');
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("PAYMENT-REQUIRED");
  });

  it("refuses a credential for different terms without asking a facilitator", async () => {
    const { requirement } = await termsOf(await call("wallet-briefing", good));
    const cheaper = { ...requirement, amount: "1" };
    const res = await call("wallet-briefing", good, { "payment-signature": credentialFor(cheaper) });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/does not match/);
    expect(facilitator.verify).toBe(0);
    const garbage = await call("wallet-briefing", good, { "payment-signature": "not base64 json" });
    expect(garbage.status).toBe(402);
    expect((await garbage.json()).error).toMatch(/decoded/);
  });

  it("delivers the prepared answer with the receipt header once the facilitator settles", async () => {
    const { requirement } = await termsOf(await call("wallet-briefing", good));
    const res = await call("wallet-briefing", good, { "payment-signature": credentialFor(requirement) });
    expect(res.status).toBe(200);
    expect(facilitator.verify).toBe(1);
    expect(facilitator.settle).toBe(1);
    // The seller hands the facilitator its own quoted terms, never the credential's copy.
    expect(facilitator.sent).toHaveLength(2);
    for (const sent of facilitator.sent) expect(sent).toEqual(requirement);
    const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") as string);
    expect(receipt).toMatchObject({ success: true, transaction: TRANSACTION });
    const body = await res.json();
    expect(body).toMatchObject({
      service_id: "superstables-demo-wallet-briefing",
      provider: "Superstables demo service",
      mock: true,
      notice: "Simulated service output. Payment uses test USDC on Base Sepolia.",
      scenario_id: "demo-active",
      fixture_version: "1",
      as_of: "2026-09-21T09:00:00Z",
      paid: { amount: "0.003", asset: "USDC", network: "eip155:84532", transaction: TRANSACTION },
    });
    expect(body.data.period).toBe("30d");
    expect(body.summary).toMatch(/30 days/);
    expect(JSON.stringify(body, null, 2).length).toBeLessThanOrEqual(3_500);
  });

  it("does not deliver when verification fails, and never settles", async () => {
    facilitator.mode = "invalid";
    const { requirement } = await termsOf(await call("wallet-briefing", good));
    const res = await call("wallet-briefing", good, { "payment-signature": credentialFor(requirement) });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("insufficient_funds");
    expect(facilitator.settle).toBe(0);
  });

  it("does not deliver when settlement fails", async () => {
    facilitator.mode = "unsettled";
    const { requirement } = await termsOf(await call("wallet-briefing", good));
    const res = await call("wallet-briefing", good, { "payment-signature": credentialFor(requirement) });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("settlement_reverted");
  });

  it("applies defaults, so the quoted and paid URL can omit optional parameters", async () => {
    const { url, requirement } = await termsOf(await call("wallet-briefing", "sample_wallet=demo-dormant"));
    expect(url).toBe(`${ORIGIN}/api/demo/services/wallet-briefing?sample_wallet=demo-dormant`);
    const res = await call("wallet-briefing", "sample_wallet=demo-dormant", { "payment-signature": credentialFor(requirement) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.period).toBe("7d");
  });

  it("answers OPTIONS with the CORS headers a browser buyer needs", () => {
    const res = OPTIONS();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("PAYMENT-SIGNATURE");
  });

  it("treats a header that decodes to something other than an object as undecodable", async () => {
    for (const header of [Buffer.from("null").toString("base64"), Buffer.from("[]").toString("base64"), Buffer.from('"x"').toString("base64")]) {
      const res = await call("wallet-briefing", good, { "payment-signature": header });
      expect(res.status, header).toBe(402);
      expect((await res.json()).error).toMatch(/decoded/);
    }
    expect(facilitator.verify).toBe(0);
  });

  it("never settles on HEAD, even with a valid credential", async () => {
    const { requirement } = await termsOf(await call("wallet-briefing", good));
    const head = new Request(`http://127.0.0.1:3000/api/demo/services/wallet-briefing?${good}`, {
      method: "HEAD",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "demo.test", "payment-signature": credentialFor(requirement) },
    });
    const res = await GET(head, { params: Promise.resolve({ service: "wallet-briefing" }) });
    expect(res.status).toBe(402);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(facilitator.verify + facilitator.settle).toBe(0);
  });

  it("makes a sample asset path in the data absolute, like the sources", async () => {
    const query = "brief_id=product-icon";
    const { requirement } = await termsOf(await call("image-creation", query));
    const res = await call("image-creation", query, { "payment-signature": credentialFor(requirement) });
    const body = await res.json();
    expect(body.data.asset_url).toBe(`${ORIGIN}/demo/services/image-product-icon.svg`);
    expect(body.sources[0].url).toBe(body.data.asset_url);
  });
});

describe("every prepared service, over the route", () => {
  for (const def of DEMO_SERVICES) {
    it(`${def.slug}: 402 on the example request, then a sized 200 once paid`, async () => {
      const query = new URLSearchParams(Object.fromEntries(def.params.filter((p) => p.required).map((p) => [p.name, p.example]))).toString();
      const { requirement } = await termsOf(await call(def.slug, query));
      expect(requirement.amount).toBe(atomicUnits(def.price));
      const res = await call(def.slug, query, { "payment-signature": credentialFor(requirement) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.service_id).toBe(`superstables-demo-${def.slug}`);
      expect(body.mock).toBe(true);
      for (const source of body.sources ?? []) expect(source.url).toMatch(/^https:\/\//);
      expect(JSON.stringify(body.data)).not.toMatch(/"\/demo\/services\//);
      expect(JSON.stringify(body, null, 2).length).toBeLessThanOrEqual(3_500);
    });
  }
});

describe("the market data route on the shared seller code", () => {
  it("delivers the price with the receipt header once settled, with the upstream stubbed", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.coinbase.com")) return new Response(JSON.stringify({ data: { amount: url.includes("date=") ? "2000" : "2100" } }), { headers: { "content-type": "application/json" } });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const { requirement } = await termsOf(await marketGet(request("/api/demo/market?asset=BTC")));
      const res = await marketGet(request("/api/demo/market?asset=BTC", { "payment-signature": credentialFor(requirement) }));
      expect(res.status).toBe(200);
      expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") as string)).toMatchObject({ success: true, transaction: TRANSACTION });
      expect(await res.json()).toMatchObject({ asset: "BTC", price_usd: 2100, change_24h_pct: 5, source: "live", paid: { amount: "0.01", transaction: TRANSACTION } });
      for (const sent of facilitator.sent) expect(sent).toEqual(requirement);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("still validates first and answers 402 with its terms", async () => {
    const bad = await marketGet(request("/api/demo/market?asset=SOL"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).allowed).toEqual(["BTC", "ETH"]);
    const { url, requirement } = await termsOf(await marketGet(request("/api/demo/market?asset=eth")));
    expect(url).toBe(`${ORIGIN}/api/demo/market?asset=eth`);
    expect(requirement).toMatchObject({ amount: "10000", payTo: PAY_TO });
  });
});

describe("the hosted catalogue", () => {
  it("lists the market service and every prepared service with absolute endpoints and closed parameters", async () => {
    const res = catalogueGet(request("/api/demo/catalogue"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toHaveLength(DEMO_SERVICES.length + 1);
    expect(body.services[0]).toMatchObject({ id: "superstables-demo-market-data", endpoint: `${ORIGIN}/api/demo/market`, mock: false });
    for (const entry of body.services.slice(1)) {
      expect(entry.endpoint).toMatch(new RegExp(`^${ORIGIN}/api/demo/services/[a-z0-9-]+$`));
      expect(entry.description).toContain("Simulated service output");
      expect(entry.payment).toMatchObject({ rail: "x402", scheme: "exact", network: "eip155:84532", asset: "USDC", payTo: PAY_TO });
      expect(entry.payment.price.amountDecimal).toBeGreaterThan(0);
      expect(entry.params.length).toBeGreaterThanOrEqual(1);
      for (const p of entry.params) {
        expect(p.in).toBe("query");
        expect(p.enum.length).toBeGreaterThanOrEqual(2);
        expect(p.enum).toContain(p.example);
      }
      expect(entry.example_prompts.length).toBeGreaterThanOrEqual(1);
      expect(entry.mock).toBe(true);
    }
  });

  it("is also served at /api/demo/services, the API catalog's anchor", async () => {
    const a = await catalogueGet(request("/api/demo/catalogue")).json();
    const b = await servicesGet(request("/api/demo/services")).json();
    expect(b.services.map((s: { id: string }) => s.id)).toEqual(a.services.map((s: { id: string }) => s.id));
  });

  it("says when no payout address is configured instead of inventing one", async () => {
    delete process.env.SUPERSTABLES_DEMO_PAY_TO;
    const body = await catalogueGet(request("/api/demo/catalogue")).json();
    for (const entry of body.services) expect(entry.payment).toMatchObject({ configured: false });
  });
});
