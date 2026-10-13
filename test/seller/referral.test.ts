// The seller helper: a referral token is accepted only when a published key signed it for this service, from the
// expected site, and it has not expired; anything else is a rejection with a reason, never an exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SITE,
  PURCHASE_REF_HEADER,
  REFERRAL_HEADER,
  checkReferral,
  clearReferralKeysCache,
  fetchReferralKeys,
  readReferral,
  verifyReferral,
} from "../../src/seller/index.js";
import { referralKey, signReferral, startFakeReferralSite, type FakeReferralSite } from "../helpers/referrals.js";

const ISSUER = DEFAULT_SITE;
const AUDIENCE = "https://api.example.com";

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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

  it("requires both the origin and the listing id when both are given", () => {
    const { token } = signReferral(key);
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE, listingId: "api.example.com" }).ok).toBe(true);
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: AUDIENCE, listingId: "other.example" })).toEqual({ ok: false, reason: "wrong_audience" });
    expect(verifyReferral(token, { keys, issuer: ISSUER, audience: "https://other.example", listingId: "api.example.com" })).toEqual({ ok: false, reason: "wrong_audience" });
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

  it("refuses another algorithm or type, or critical header parameters, before looking for a key", () => {
    expect(verifyReferral(signReferral(key, {}, { alg: "none" }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
    expect(verifyReferral(signReferral(key, {}, { typ: "JWT" }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
    expect(verifyReferral(signReferral(key, {}, { crit: ["b64"], b64: false }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
    expect(verifyReferral(signReferral(key, {}, { crit: [] }).token, { keys, issuer: ISSUER, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
  });

  it("refuses a skew or a time that is not a usable number, so an expired token never passes", () => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const { token: expired } = signReferral(key, { iat, exp: iat + 600 });
    const { token: valid } = signReferral(key);
    for (const skewSeconds of [Number.NaN, -1, Number.POSITIVE_INFINITY, "60" as unknown as number]) {
      expect(verifyReferral(expired, { keys, issuer: ISSUER, audience: AUDIENCE, skewSeconds })).toEqual({ ok: false, reason: "invalid_options" });
      expect(verifyReferral(valid, { keys, issuer: ISSUER, audience: AUDIENCE, skewSeconds })).toEqual({ ok: false, reason: "invalid_options" });
    }
    expect(verifyReferral(expired, { keys, issuer: ISSUER, audience: AUDIENCE, now: new Date("not a date") })).toEqual({ ok: false, reason: "invalid_options" });
    expect(verifyReferral(valid, { keys, issuer: ISSUER, audience: AUDIENCE, now: Date.now() as unknown as Date })).toEqual({ ok: false, reason: "invalid_options" });
    expect(verifyReferral(valid, { keys, issuer: ISSUER, audience: AUDIENCE, skewSeconds: 0 }).ok).toBe(true);
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

describe("checkReferral", () => {
  it("verifies against the site's keys, and reads them again once for a key it does not have, at most once a minute", async () => {
    const first = referralKey();
    const rotated = referralKey();
    const s = await site([first.jwk]);
    const options = { site: s.url, audience: AUDIENCE };
    expect((await checkReferral(signReferral(first, { iss: s.url }).token, options)).ok).toBe(true);
    expect(s.keyReads).toBe(1);

    // The site rotates its key. Within a minute of the last read, an unknown key id does not read the keys again.
    s.keys = [first.jwk, rotated.jwk];
    const token = signReferral(rotated, { iss: s.url }).token;
    expect(await checkReferral(token, options)).toEqual({ ok: false, reason: "unknown_key" });
    expect(s.keyReads).toBe(1);

    // A minute later it does, once, and the token checks.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    expect((await checkReferral(token, options)).ok).toBe(true);
    expect(s.keyReads).toBe(2);
    expect(await checkReferral(signReferral(referralKey(), { iss: s.url }).token, options)).toEqual({ ok: false, reason: "unknown_key" });
    expect(s.keyReads).toBe(2);
  });

  it("keeps the key set it holds when a refresh fails, and answers unknown_key, not keys_unavailable", async () => {
    const key = referralKey();
    const s = await site([key.jwk]);
    const options = { site: s.url, audience: AUDIENCE };
    const known = signReferral(key, { iss: s.url }).token;
    expect((await checkReferral(known, options)).ok).toBe(true);

    // The site goes down; a minute later a token with a key id nobody published asks for a refresh, which fails.
    s.keysStatus = 503;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect(await checkReferral(signReferral(referralKey(), { iss: s.url }).token, options)).toEqual({ ok: false, reason: "unknown_key" });
    expect(s.keyReads).toBe(2);
    // The held set still checks the known key, without another read.
    expect((await checkReferral(known, options)).ok).toBe(true);
    expect(s.keyReads).toBe(2);
  });

  it("does not make a check with a known key wait for a refresh in flight", async () => {
    const key = referralKey();
    const s = await site([key.jwk]);
    const options = { site: s.url, audience: AUDIENCE };
    const known = signReferral(key, { iss: s.url }).token;
    expect((await checkReferral(known, options)).ok).toBe(true);

    s.keysDelayMs = 1_000;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    const refreshing = checkReferral(signReferral(referralKey(), { iss: s.url }).token, options);
    const started = performance.now();
    expect((await checkReferral(known, options)).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    expect(await refreshing).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("answers keys_unavailable only when no key set could be read, and never throws", async () => {
    const key = referralKey();
    const down = await site([]);
    const url = down.url;
    await down.close();
    opened.pop();
    expect(await checkReferral(signReferral(key, { iss: url }).token, { site: url, audience: AUDIENCE })).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("checks its options, the site and the token's shape before fetching anything", async () => {
    const key = referralKey();
    const s = await site([key.jwk]);
    const token = signReferral(key, { iss: s.url }).token;
    expect(await checkReferral(token, null)).toEqual({ ok: false, reason: "no_audience" });
    expect(await checkReferral(token, { site: "not a url", audience: AUDIENCE })).toEqual({ ok: false, reason: "invalid_options" });
    expect(await checkReferral(token, { site: "http://keys.example.com", audience: AUDIENCE })).toEqual({ ok: false, reason: "invalid_options" });
    expect(await checkReferral(token, { site: s.url, audience: AUDIENCE, fetch: "no" as unknown as typeof fetch })).toEqual({ ok: false, reason: "invalid_options" });
    expect(await checkReferral(token, { site: s.url, audience: AUDIENCE, skewSeconds: Number.NaN })).toEqual({ ok: false, reason: "invalid_options" });
    expect(await checkReferral("garbage", { site: s.url, audience: AUDIENCE })).toEqual({ ok: false, reason: "malformed" });
    expect(await checkReferral(signReferral(key, { iss: s.url }, { alg: "none" }).token, { site: s.url, audience: AUDIENCE })).toEqual({ ok: false, reason: "unsupported_header" });
    expect(s.keyReads).toBe(0);
  });
});
