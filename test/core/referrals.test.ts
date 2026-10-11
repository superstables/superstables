// Referral transport on the buyer's side: a referral the Superstables index gives for a listing is remembered by the
// listing's origin, attached to a quote for that exact origin while it has not expired, and sent to the seller on the
// paid request only, with the attempt id as the purchase reference. The receipt records which referral went, never
// the token. SUPERSTABLES_REFERRALS=off neither remembers nor sends.

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { findServices, getService } from "../../src/core/discovery.js";
import { PaymentEngine, shownReceipt } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { REFERRALS_FILE, referralFor, rememberReferrals } from "../../src/core/referrals.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import type { ServiceListing } from "../../src/core/types.js";
import { attemptView } from "../../src/cli/views.js";
import { startFakeMppSeller, startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { referralKey, signReferral } from "../helpers/referrals.js";
import { sendJson, startFacilitator, startPaidEndpoint, startServer, startWallet, type PaidEndpoint } from "../helpers/servers.js";

const opened: { close(): Promise<void> }[] = [];
const key = referralKey();

afterEach(async () => {
  delete process.env.SUPERSTABLES_INDEX_URL;
  delete process.env.SUPERSTABLES_REFERRALS;
  while (opened.length) await opened.pop()!.close();
});

function records(): Records {
  return new Records(join(mkdtempSync(join(tmpdir(), "superstables-referrals-")), "records"));
}

function inAnHour(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

/** An index that lists `rows`, at SUPERSTABLES_INDEX_URL. */
async function index(rows: Record<string, unknown>[]): Promise<void> {
  const server = await startServer((_req, res) => sendJson(res, 200, { services: rows }));
  opened.push(server);
  process.env.SUPERSTABLES_INDEX_URL = `${server.url}/api/v1/services`;
}

function row(endpoint: string, referral?: Record<string, unknown>, id = new URL(endpoint).host): Record<string, unknown> {
  return {
    id,
    name: `Service at ${id}`,
    description: "A paid endpoint.",
    endpoint,
    rails: ["x402"],
    chains: ["base-sepolia"],
    assets: ["USDC"],
    price: { display: "0.01 USDC", usd: 0.01 },
    live: true,
    ...(referral ? { referral } : {}),
  };
}

function indexListing(endpoint: string, token: string, expiresAt = inAnHour()): ServiceListing {
  return {
    id: new URL(endpoint).host,
    name: "listed",
    description: "",
    endpoint,
    method: "GET",
    params: [],
    payment: { rail: "x402", scheme: "exact", network: "eip155:84532", networkLabel: "Base Sepolia", asset: "USDC" },
    source: "superstables-index",
    testnet: true,
    actionable: false,
    referral: { token, expiresAt, terms: "terms-1" },
  };
}

interface X402Stack {
  seller: PaidEndpoint;
  records: Records;
  engine: PaymentEngine;
  endpoint: string;
}

async function x402Stack(): Promise<X402Stack> {
  const facilitator = await startFacilitator();
  const seller = await startPaidEndpoint(facilitator.url);
  const wallet = await startWallet();
  opened.push(facilitator, seller, wallet);
  const r = records();
  const engine = new PaymentEngine({
    records: r,
    policy: DEFAULT_POLICY,
    signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }),
  });
  return { seller, records: r, engine, endpoint: `${seller.url}/v1/market` };
}

describe("remembering referrals from the index", () => {
  it("keeps an index listing's referral on the listing and remembers it by origin, in a 0600 file", async () => {
    const r = records();
    const { token } = signReferral(key);
    const expires = inAnHour();
    await index([
      row("https://api.example.com/v1/weather", { token, expires_at: expires, terms: "terms-1" }),
      row("https://plain.example.org/v1/data"),
    ]);
    const { services } = await findServices({ records: r, includeIndex: true });
    const listed = services.find((s) => s.id === "api.example.com");
    expect(listed?.referral).toEqual({ token, expiresAt: expires, terms: "terms-1" });
    expect(services.find((s) => s.id === "plain.example.org")?.referral).toBeUndefined();

    const path = join(r.dir, REFERRALS_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(saved)).toEqual(["https://api.example.com"]);
    expect(saved["https://api.example.com"]).toMatchObject({ listingId: "api.example.com", token, expiresAt: expires, terms: "terms-1", seenAt: expect.any(String) });
  });

  it("remembers what getService finds in the index too", async () => {
    const r = records();
    const { token } = signReferral(key);
    await index([row("https://api.example.com/v1/weather", { token, expires_at: inAnHour(), terms: "terms-1" })]);
    expect((await getService("api.example.com", { records: r }))?.referral?.token).toBe(token);
    expect(referralFor("https://api.example.com/v1/weather?city=Lisbon", r.dir)?.token).toBe(token);
  });

  it("drops a referral that is not a token, or has no expiry, and remembers nothing that is not from the index", async () => {
    const r = records();
    const { token } = signReferral(key);
    await index([
      row("https://a.example.com/x", { token: `${token}\r\nx-evil: 1`, expires_at: inAnHour(), terms: "t" }),
      row("https://b.example.com/x", { token, terms: "t" }),
    ]);
    const { services } = await findServices({ records: r });
    expect(services.filter((s) => s.referral)).toEqual([]);
    rememberReferrals([{ ...indexListing("https://c.example.com/x", token), source: "demo-catalogue" }], r.dir);
    expect(referralFor("https://c.example.com/x", r.dir)).toBeUndefined();
  });

  it("drops expired referrals when it writes, and ignores one that expires after it was written", () => {
    const r = records();
    const { token } = signReferral(key);
    const now = new Date();
    rememberReferrals([indexListing("https://soon.example.com/x", token, new Date(now.getTime() + 1000).toISOString())], r.dir, now);
    expect(referralFor("https://soon.example.com/x", r.dir, now)).toBeDefined();
    expect(referralFor("https://soon.example.com/x", r.dir, new Date(now.getTime() + 2000))).toBeUndefined();
    rememberReferrals([indexListing("https://later.example.com/x", token)], r.dir, new Date(now.getTime() + 2000));
    expect(Object.keys(JSON.parse(readFileSync(join(r.dir, REFERRALS_FILE), "utf8")))).toEqual(["https://later.example.com"]);
    // An already expired referral is never written.
    rememberReferrals([indexListing("https://past.example.com/x", token, new Date(now.getTime() - 1000).toISOString())], r.dir, now);
    expect(referralFor("https://past.example.com/x", r.dir, now)).toBeUndefined();
  });

  it("remembers nothing with SUPERSTABLES_REFERRALS=off", async () => {
    const r = records();
    process.env.SUPERSTABLES_REFERRALS = "off";
    await index([row("https://api.example.com/v1/weather", { token: signReferral(key).token, expires_at: inAnHour(), terms: "t" })]);
    await findServices({ records: r });
    expect(() => statSync(join(r.dir, REFERRALS_FILE))).toThrow();
  });
});

describe("referrals on quotes", () => {
  it("attaches the referral remembered for the quote URL's exact origin, with the referral id from the token", async () => {
    const s = await x402Stack();
    const { token, claims } = signReferral(key);
    await index([row(s.endpoint, { token, expires_at: inAnHour(), terms: "terms-1" })]);
    const { services } = await findServices({ records: s.records });
    const listing = services.find((l) => l.endpoint === s.endpoint)!;

    const byUrl = await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY });
    expect(byUrl.referral).toMatchObject({ id: claims.jti, token, listingId: listing.id, terms: "terms-1" });
    const byService = await quote({ service: listing, params: {} }, { records: s.records, policy: DEFAULT_POLICY });
    expect(byService.referral?.id).toBe(claims.jti);
  });

  it("attaches nothing for another origin, an expired referral, or with referrals off", async () => {
    const s = await x402Stack();
    const { token } = signReferral(key);
    const other = new URL(s.endpoint);
    other.hostname = "localhost";
    rememberReferrals([indexListing(other.toString(), token)], s.records.dir);
    expect((await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY })).referral).toBeUndefined();

    rememberReferrals([indexListing(s.endpoint, token, new Date(Date.now() + 50).toISOString())], s.records.dir);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY })).referral).toBeUndefined();

    rememberReferrals([indexListing(s.endpoint, token)], s.records.dir);
    process.env.SUPERSTABLES_REFERRALS = "off";
    expect((await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY })).referral).toBeUndefined();
  });
});

describe("referrals on x402 payments", () => {
  it("sends the token and the attempt id on the paid request only, and records the referral without the token", async () => {
    const s = await x402Stack();
    const { token, claims } = signReferral(key);
    rememberReferrals([indexListing(s.endpoint, token)], s.records.dir);
    const q = await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY });
    const done = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);
    expect(done.state).toBe("settled");

    const paid = s.seller.seen.filter((r) => r.paid);
    const unpaid = s.seller.seen.filter((r) => !r.paid);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.headers["superstables-referral"]).toBe(token);
    expect(paid[0]!.headers["superstables-purchase-ref"]).toBe(done.id);
    // The quote's probe and the engine's fresh challenge: neither carries the referral.
    expect(unpaid.length).toBeGreaterThanOrEqual(2);
    for (const request of unpaid) {
      expect(request.headers["superstables-referral"]).toBeUndefined();
      expect(request.headers["superstables-purchase-ref"]).toBeUndefined();
    }

    const record = { id: claims.jti, listingId: new URL(s.endpoint).host, terms: "terms-1" };
    expect(done).toMatchObject({ discoveredVia: "superstables", referral: record });
    const receipt = s.records.getReceipt(done.receiptId!)!;
    expect(receipt).toMatchObject({ discoveredVia: "superstables", referral: record });
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(shownReceipt(receipt)).toMatchObject({ discoveredVia: "superstables", referral: record });
    expect(attemptView({ records: s.records }, done).receipt).toMatchObject({ discovered_via: "superstables", referral: record });
  });

  it("sends nothing when the quote has no referral, when it expired before the paid request, or with referrals off", async () => {
    const s = await x402Stack();
    const plain = await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY });
    const first = await s.engine.waitForAttempt(s.engine.startPayment(plain.id).id, 10_000);
    expect(first.state).toBe("settled");
    expect(first.referral).toBeUndefined();
    expect(s.records.getReceipt(first.receiptId!)?.discoveredVia).toBeUndefined();

    const { token } = signReferral(key);
    rememberReferrals([indexListing(s.endpoint, token)], s.records.dir);
    const lapsed = await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY });
    expect(lapsed.referral).toBeDefined();
    s.records.saveQuote({ ...lapsed, referral: { ...lapsed.referral!, expiresAt: new Date(Date.now() - 1000).toISOString() } });
    const second = await s.engine.waitForAttempt(s.engine.startPayment(lapsed.id).id, 10_000);
    expect(second.state).toBe("settled");
    expect(second.referral).toBeUndefined();

    const off = await quote({ url: `${s.endpoint}?asset=BTC` }, { records: s.records, policy: DEFAULT_POLICY });
    expect(off.referral).toBeDefined();
    process.env.SUPERSTABLES_REFERRALS = "off";
    const third = await s.engine.waitForAttempt(s.engine.startPayment(off.id).id, 10_000);
    expect(third.state).toBe("settled");
    expect(third.discoveredVia).toBeUndefined();

    expect(s.seller.seen.filter((r) => r.paid)).toHaveLength(3);
    for (const request of s.seller.seen) expect(request.headers["superstables-referral"]).toBeUndefined();
  });
});

describe("referrals on Tempo payments", () => {
  it("sends the token and the attempt id on the paid request only", async () => {
    const chain = await startFakeTempoPay();
    const seller = await startFakeMppSeller(chain, { recipient: "0x2222222222222222222222222222222222222222" });
    const dir = mkdtempSync(join(tmpdir(), "superstables-referrals-tempo-"));
    const signer = new BrowserWalletSigner({ port: 0, home: dir, policy: DEFAULT_POLICY, timeoutMs: 10_000, balance: false });
    const r = new Records(join(dir, "records"));
    const engine = new PaymentEngine({ records: r, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url });
    opened.push(chain, seller, { close: () => signer.close() });

    const { token, claims } = signReferral(key);
    rememberReferrals([indexListing(`${seller.url}/paid`, token)], r.dir);
    const q = await quote({ url: `${seller.url}/paid` }, { records: r, policy: DEFAULT_POLICY });
    expect(q.referral?.id).toBe(claims.jti);
    const attempt = engine.startPayment(q.id);
    const link = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no approval link")), 10_000);
      const check = () => {
        const url = engine.getAttempt(attempt.id)?.approvalUrl;
        if (url) {
          clearTimeout(timer);
          resolve(url);
        }
      };
      engine.events.on("transition", check);
      check();
    });
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${link}/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(link).origin }, body: JSON.stringify(body) });
      return (await res.json()) as Record<string, any>;
    };
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const call = (await post("account", { address: owner })).transaction;
    await post("sending", { address: owner });
    const hash = chain.send(owner, call);
    await post("sent", { address: owner, hash });
    const done = await engine.waitForAttempt(attempt.id, 15_000);
    expect(done.state).toBe("settled");

    const paid = seller.seen.filter((x) => x.paid);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.headers["superstables-referral"]).toBe(token);
    expect(paid[0]!.headers["superstables-purchase-ref"]).toBe(done.id);
    for (const request of seller.seen.filter((x) => !x.paid)) expect(request.headers["superstables-referral"]).toBeUndefined();
    expect(r.getReceipt(done.receiptId!)).toMatchObject({ discoveredVia: "superstables", referral: { id: claims.jti } });
  }, 30_000);
});
