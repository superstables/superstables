// The seller helper: a referral token is accepted only when a published key signed it for this service, from the
// expected site, and it has not expired; anything else is a rejection with a reason, never an exception. Reports are
// retried only when the site could not answer, always with the same Idempotency-Key.

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SITE,
  PURCHASE_REF_HEADER,
  REFERRAL_HEADER,
  ReferralReportError,
  clearReferralKeysCache,
  createReferralReporter,
  fetchReferralKeys,
  idempotencyKey,
  readReferral,
  verifyReferral,
  type ReferralEvent,
} from "../../src/seller/index.js";
import { referralKey, signReferral, startFakeReferralSite, type FakeReferralSite } from "../helpers/referrals.js";

const ISSUER = DEFAULT_SITE;
const AUDIENCE = "https://api.example.com";
const API_KEY = `sssk_${"A".repeat(43)}`;

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  clearReferralKeysCache();
  while (opened.length) await opened.pop()!.close();
});

async function site(keys: Parameters<typeof startFakeReferralSite>[0]): Promise<FakeReferralSite> {
  const started = await startFakeReferralSite(keys);
  opened.push(started);
  return started;
}

describe("verifyReferral", () => {
  const key = referralKey();
  const keys = { keys: [key.jwk] };

  it("accepts a token a published key signed for this origin, and returns its claims", () => {
    const { token, claims } = signReferral(key);
    const result = verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE });
    expect(result).toEqual({ ok: true, claims });
  });

  it("accepts the listing id in sub instead of the origin, and a key list instead of a key set", () => {
    const { token } = signReferral(key);
    expect(verifyReferral(token, { keys: [key.jwk], issuer: ISSUER, listingId: "api.example.com" }).ok).toBe(true);
    // An origin given as a URL with a path is compared as its origin.
    expect(verifyReferral(token, { keys, issuer: `${ISSUER}/`, audience: `${AUDIENCE}/v1/market` }).ok).toBe(true);
  });

  it("refuses a signature that does not check", () => {
    const { token } = signReferral(key);
    const [h, p] = token.split(".");
    const other = signReferral(referralKey()).token.split(".")[2];
    expect(verifyReferral(`${h}.${p}.${other}`, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "bad_signature" });
    // A payload changed after signing.
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), aud: "https://evil.example" })).toString("base64url");
    expect(verifyReferral(`${h}.${tampered}.${token.split(".")[2]}`, { keys, issuer: ISSUER, audience: "https://evil.example" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a key id the key set does not have", () => {
    const { token } = signReferral(referralKey());
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses another issuer", () => {
    const { token } = signReferral(key, { iss: "https://staging.superstables.com" });
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("refuses a token for another origin or listing", () => {
    const { token } = signReferral(key, { aud: "https://other.example", sub: "other.example" });
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "wrong_audience" });
    expect(verifyReferral(token, { keys, issuer: ISSUER, listingId: "api.example.com" })).toEqual({ ok: false, reason: "wrong_audience" });
    expect(verifyReferral(token, { keys, issuer: ISSUER })).toEqual({ ok: false, reason: "no_audience" });
  });

  it("refuses an expired token, allowing the clock skew", () => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const { token } = signReferral(key, { iat, exp: iat + 600 });
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "expired" });
    const at = new Date((iat + 600 + 59) * 1000);
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE, now: at }).ok).toBe(true);
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE, now: at, skewSeconds: 0 })).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token issued in the future, and one that ends before it starts", () => {
    const iat = Math.floor(Date.now() / 1000) + 600;
    expect(verifyReferral(signReferral(key, { iat, exp: iat + 600 }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "not_yet_valid" });
    const now = Math.floor(Date.now() / 1000);
    expect(verifyReferral(signReferral(key, { iat: now, exp: now }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses another algorithm or type before looking for a key", () => {
    expect(verifyReferral(signReferral(key, {}, { alg: "none" }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
    expect(verifyReferral(signReferral(key, {}, { typ: "JWT" }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
  });

  it("never throws on malformed input", () => {
    for (const bad of [undefined, null, 42, {}, "", "a.b", "a.b.c", "a.b.c.d", "!!.!!.!!", `${"a".repeat(5000)}.b.c`, "e30.e30.e30"]) {
      const result = verifyReferral(bad, { keys, issuer: ISSUER, audience: AUDIENCE });
      expect(result.ok).toBe(false);
    }
    // Signed, but missing claims a referral always has.
    const { token } = signReferral(key, { jti: undefined as unknown as string });
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "malformed" });
    // A key set that is not one.
    expect(verifyReferral(signReferral(key).token, { keys: { keys: [{ kty: "RSA" } as never] }, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unknown_key" });
  });
});

describe("readReferral", () => {
  const token = signReferral(referralKey()).token;

  it("reads Fetch headers, Node's lowercase headers and a plain object in any case", () => {
    expect(readReferral(new Headers({ "Superstables-Referral": token, "Superstables-Purchase-Ref": "att_123" }))).toEqual({ token, purchaseRef: "att_123" });
    expect(readReferral({ [REFERRAL_HEADER]: token, [PURCHASE_REF_HEADER]: ["9f1c-2b:x.y_z"] })).toEqual({ token, purchaseRef: "9f1c-2b:x.y_z" });
    expect(readReferral({ "Superstables-Referral": token })).toEqual({ token });
  });

  it("drops a purchase reference outside the allowed characters or length, and refuses a value that is not a token", () => {
    expect(readReferral({ [REFERRAL_HEADER]: token, [PURCHASE_REF_HEADER]: "has space" })).toEqual({ token });
    expect(readReferral({ [REFERRAL_HEADER]: token, [PURCHASE_REF_HEADER]: "a".repeat(129) })).toEqual({ token });
    expect(readReferral({ [REFERRAL_HEADER]: token, [PURCHASE_REF_HEADER]: "a".repeat(128) })).toEqual({ token, purchaseRef: "a".repeat(128) });
    expect(readReferral({ [REFERRAL_HEADER]: "not a token" })).toBeNull();
    expect(readReferral({})).toBeNull();
  });
});

describe("fetchReferralKeys", () => {
  it("reads the published keys once per ten minutes, per site", async () => {
    const key = referralKey();
    const s = await site([key.jwk, { kty: "RSA", kid: "x" } as never]);
    const first = await fetchReferralKeys(s.url);
    expect(first.keys).toEqual([key.jwk]);
    await fetchReferralKeys(s.url);
    expect(s.keyReads).toBe(1);
    clearReferralKeysCache();
    await fetchReferralKeys(s.url);
    expect(s.keyReads).toBe(2);
  });

  it("refuses a site that is not https, unless it is this machine", () => {
    expect(() => fetchReferralKeys("http://keys.example.com")).toThrow(/https/);
  });
});

describe("createReferralReporter", () => {
  const token = signReferral(referralKey()).token;
  const fulfilled: ReferralEvent = {
    type: "fulfilled",
    referral: token,
    purchase_ref: "att_1",
    settlement: { network: "eip155:84532", transaction: `0x${"ab".repeat(32)}`, payer: `0x${"11".repeat(20)}`, amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", status: "settled" },
  };

  it("posts the event with the key and a stable Idempotency-Key, and returns the site's answer", async () => {
    const s = await site([]);
    const reporter = createReferralReporter({ apiKey: API_KEY, site: s.url });
    const answer = await reporter.report(fulfilled);
    expect(answer).toEqual({ purchase: { id: "pur_test", status: "held", reason: null, fee: null }, replayed: false });
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(s.events[0]!.headers["idempotency-key"]).toBe(idempotencyKey(fulfilled));
    expect(s.events[0]!.body).toMatchObject({ ...fulfilled, occurred_at: expect.any(String) });
    // The same event again: the same key, and the site says it is a replay.
    expect((await reporter.report({ ...fulfilled, occurred_at: "2026-10-11T23:00:00Z" })).replayed).toBe(true);
  });

  it("derives the key from type, referral id, purchase ref, order id and the two transactions only", () => {
    const base = idempotencyKey(fulfilled);
    expect(idempotencyKey({ ...fulfilled, occurred_at: "2020-01-01T00:00:00Z" })).toBe(base);
    expect(idempotencyKey({ ...fulfilled, settlement: { ...fulfilled.settlement!, payer: "0xother" } })).toBe(base);
    expect(idempotencyKey({ ...fulfilled, type: "failed" })).not.toBe(base);
    expect(idempotencyKey({ ...fulfilled, purchase_ref: "att_2" })).not.toBe(base);
    expect(idempotencyKey({ ...fulfilled, order_id: "o-1" })).not.toBe(base);
    expect(idempotencyKey({ ...fulfilled, settlement: { ...fulfilled.settlement!, transaction: "0x01" } })).not.toBe(base);
    expect(idempotencyKey({ ...fulfilled, refund: { amount: "10000", transaction: "0x02" } })).not.toBe(base);
    expect(idempotencyKey({ ...fulfilled, referral: signReferral(referralKey()).token })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retries a 5xx and a 429 with the same key, then succeeds", async () => {
    const s = await site([]);
    s.failNext.push(503, 429);
    const keys: string[] = [];
    const reporter = createReferralReporter({
      apiKey: API_KEY,
      site: s.url,
      backoffMs: 1,
      fetch: (input, init) => {
        keys.push(String(new Headers(init?.headers).get("idempotency-key")));
        return fetch(input, init);
      },
    });
    expect((await reporter.report(fulfilled)).purchase.id).toBe("pur_test");
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("retries a network error, and gives up after the retries with the error code", async () => {
    let calls = 0;
    const reporter = createReferralReporter({
      apiKey: API_KEY,
      backoffMs: 1,
      retries: 2,
      fetch: async () => {
        calls += 1;
        throw new TypeError("fetch failed");
      },
    });
    const error = await reporter.report(fulfilled).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReferralReportError);
    expect(error).toMatchObject({ code: "network_error" });
    expect(calls).toBe(3);
  });

  it("does not retry a refusal, and carries the site's error code without the key or the token", async () => {
    let calls = 0;
    const reporter = createReferralReporter({
      apiKey: API_KEY,
      backoffMs: 1,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "invalid_event", message: "settlement is required" } }), { status: 400 });
      },
    });
    const error = (await reporter.report(fulfilled).catch((e: unknown) => e)) as ReferralReportError;
    expect(error).toMatchObject({ name: "ReferralReportError", code: "invalid_event", status: 400 });
    expect(calls).toBe(1);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(token);
  });

  it("refuses an API key that is not one, an http site, and an event over 8 KB", async () => {
    expect(() => createReferralReporter({ apiKey: "sk_live_x" })).toThrow(/seller API key/);
    expect(() => createReferralReporter({ apiKey: API_KEY, site: "http://site.example.com" })).toThrow(/https/);
    const reporter = createReferralReporter({ apiKey: API_KEY, fetch: async () => new Response("{}") });
    await expect(reporter.report({ ...fulfilled, order_id: "x".repeat(9000) })).rejects.toMatchObject({ code: "body_too_large" });
  });
});
