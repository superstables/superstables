// Quoting is the step that costs nothing, so it is the step that must be honest. These
// tests hold it to that: the numbers come from the seller's requirement, the policy verdict
// is recorded rather than thrown, and a quote that is past its time says so.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { usdcRequirement } from "../../src/core/chain.js";
import { demoService } from "../../src/core/discovery.js";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import { getQuote, quote } from "../../src/core/quote.js";
import type { PaymentRequirements } from "@x402/core/types";
import { startPaidEndpoint, startServer, type TestServer } from "../helpers/servers.js";

const open: TestServer[] = [];

function records(): Records {
  return new Records(mkdtempSync(join(tmpdir(), "superstables-quote-")));
}

const policy = (over: Partial<Policy> = {}): Policy => ({ ...DEFAULT_POLICY, ...over });

/** A seller that offers exactly the requirements given, and never gets paid. */
async function offering(accepts: PaymentRequirements[], version = 2): Promise<TestServer> {
  const server = await startServer((_req, res) => {
    const challenge = {
      x402Version: version,
      error: "payment required",
      resource: { url: "http://seller.example/claimed", description: "A thing worth money" },
      accepts,
    };
    res.writeHead(402, {
      "content-type": "application/json",
      "payment-required": encodePaymentRequiredHeader(challenge),
    });
    res.end(JSON.stringify(challenge));
  });
  open.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("quote", () => {
  it("reads the seller's terms and stores them, without paying anything", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();

    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: policy() });

    expect(q.status).toBe("open");
    expect(q.approval).toBe("wallet");
    expect(q.terms).toMatchObject({
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "USDC",
      network: "eip155:84532",
      recipient: seller.payTo,
      x402Version: 2,
    });
    expect(q.description).toBe("Market data for one asset");
    expect(q.policy).toMatchObject({ allowed: true, reason: undefined });
    // Every rule the payment was held to, in evaluation order, with what was compared.
    expect(q.policy.checks?.map((c) => c.rule)).toEqual([
      "kill_switch", "deny", "allow", "stablecoins", "caps.per_call", "caps.per_day",
    ]);
    expect(q.policy.checks?.every((c) => c.ok)).toBe(true);
    expect(q.policy.checks?.find((c) => c.rule === "caps.per_call")?.detail).toBe("0.01 USDC, at most 0.05 USDC");
    expect(Date.parse(q.expiresAt) - Date.parse(q.createdAt)).toBe(10 * 60 * 1000);
    expect(r.getQuote(q.id)?.terms.amountAtomic).toBe("10000");
  });

  it("records a policy refusal on the quote instead of throwing it", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();

    const q = await quote(
      { url: `${seller.url}/v1/market?asset=BTC` },
      { records: r, policy: policy({ perCall: { amount: 0.001, asset: "USDC" } }) },
    );

    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toContain("caps.per_call");
    expect(r.getQuote(q.id)?.policy.allowed).toBe(false);
    expect(q.policy.checks?.find((c) => c.rule === "caps.per_call")).toEqual({
      rule: "caps.per_call",
      ok: false,
      detail: "0.01 USDC, at most 0.001 USDC",
    });
  });

  it("judges the host it was asked to call, not the one the seller claims", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();
    // The seller's challenge claims seller.example; the deny list names the real host.
    const q = await quote(
      { url: `${seller.url}/v1/market?asset=BTC` },
      { records: r, policy: policy({ deny: ["127.0.0.1"] }) },
    );
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toContain("127.0.0.1");
  });

  it("counts what was already spent today against the daily cap", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();
    r.saveReceipt({
      id: "earlier",
      at: new Date().toISOString(),
      quoteId: "q0",
      attemptId: "earlier",
      url: "http://127.0.0.1/earlier",
      terms: {
        amountDecimal: 0.095,
        amountAtomic: "95000",
        asset: "USDC",
        assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        network: "eip155:84532",
        networkLabel: "Base Sepolia (testnet)",
        recipient: `0x${"22".repeat(20)}`,
        scheme: "exact",
        x402Version: 2,
      },
      payer: `0x${"33".repeat(20)}`,
      transaction: "0xdead",
      transactionKind: "hash",
      transactionUrl: "https://sepolia.basescan.org/tx/0xdead",
      network: "eip155:84532",
      settlement: { success: true, transaction: "0xdead", network: "eip155:84532" },
      serviceOutcome: "ok",
      ms: 900,
    });

    const q = await quote(
      { url: `${seller.url}/v1/market?asset=BTC` },
      { records: r, policy: policy({ perDay: { amount: 0.1, asset: "USDC" } }) },
    );
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toContain("caps.per_day");
  });

  it("quotes a discovered service and remembers which one it was", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();
    const service = { ...demoService(), endpoint: `${seller.url}/v1/market` };

    const q = await quote({ service, params: { asset: "btc" } }, { records: r, policy: policy() });

    expect(q.serviceId).toBe(service.id);
    expect(q.serviceName).toBe("Superstables demo market data");
    expect(q.request).toMatchObject({ method: "GET", params: { asset: "BTC" } });
    expect(q.url).toBe(`${seller.url}/v1/market?asset=BTC`);
  });

  it("takes the first offer it can pay when a seller offers several", async () => {
    const mainnet: PaymentRequirements = {
      ...usdcRequirement(0.25, `0x${"22".repeat(20)}`),
      network: "eip155:8453",
    };
    const seller = await offering([mainnet, usdcRequirement(0.02, `0x${"33".repeat(20)}`)]);
    const q = await quote({ url: seller.url }, { records: records(), policy: policy({ perCall: undefined }) });
    expect(q.terms.amountDecimal).toBe(0.02);
    expect(q.terms.network).toBe("eip155:84532");
  });

  it("explains every offer it had to refuse when none can be paid", async () => {
    const seller = await offering([
      { ...usdcRequirement(0.25, `0x${"22".repeat(20)}`), network: "eip155:8453" },
      { ...usdcRequirement(0.25, `0x${"22".repeat(20)}`), scheme: "upto" },
    ]);
    await expect(quote({ url: seller.url }, { records: records(), policy: policy() })).rejects.toThrow(
      /offers no payment this client can make.*Base \(mainnet\).*only exact/s,
    );
  });

  it("says plainly when a URL is not a paid endpoint", async () => {
    const free = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"free":true}');
    });
    open.push(free);
    await expect(quote({ url: free.url }, { records: records(), policy: policy() })).rejects.toThrow(
      /Expected HTTP 402/,
    );
  });
});

describe("getQuote", () => {
  it("returns a stored quote unchanged while it is good", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: policy() });
    expect(getQuote(q.id, r)?.status).toBe("open");
    expect(getQuote("no-such-quote", r)).toBeUndefined();
  });

  it("marks a quote expired once its time has passed", async () => {
    const seller = await startPaidEndpoint("http://127.0.0.1:1");
    open.push(seller);
    const r = records();
    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records: r, policy: policy() });
    r.saveQuote({ ...q, expiresAt: new Date(Date.now() - 1000).toISOString() });

    expect(getQuote(q.id, r)?.status).toBe("expired");
    // And it stays expired: the state is written back, not recomputed differently later.
    expect(r.getQuote(q.id)?.status).toBe("expired");
  });
});
