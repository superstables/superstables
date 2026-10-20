// The referral marker outside EVM: a Solana memo ("ss1" and the referral id) and a Tempo memo whose MPP client id is
// "superstables:<referral id>". And the one reader of the remembered referrals that the budget scripts share.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { budgetMemo, memoReferral, referralIdBytes, solanaMemo, tempoChallengeKey, tempoClientId } from "../../src/core/referral-memo.mjs";
import { PURCHASE_REF_HEADER, REFERRAL_HEADER, operationReferral, paidReferralHeaders, referralFor } from "../../src/core/referral-store.mjs";
import { mppMemo } from "../../src/core/rails/tempo.js";
import { PURCHASE_REF_HEADER as SELLER_PURCHASE_REF_HEADER, REFERRAL_HEADER as SELLER_REFERRAL_HEADER } from "../../src/seller/referral.js";
import { referralKey, signReferral } from "../helpers/referrals.js";

const Attribution: {
  encode(p: { challengeId: string; serverId: string; clientId?: string }): string;
  decode(memo: string): { clientFingerprint: string } | null;
  verifyServer(memo: string, serverId: string): boolean;
  verifyChallengeBinding(memo: string, challengeId: string): boolean;
} = await import(new URL("../../node_modules/mppx/dist/tempo/Attribution.js", import.meta.url).href);
const { mppMemo: budgetMppMemo } = await import(new URL("../../budget/tempo/lib/chain.ts", import.meta.url).href);

const ID = "ref_AAECAwQFBgcICQoLDA0ODw";
const fixed = (size: number) => Buffer.alloc(size, 0xaa);
const MALFORMED = [
  "AAECAwQFBgcICQoLDA0ODw", // no prefix
  "ref_AAECAwQFBgcICQoLDA0OD", // 21 characters
  "ref_AAECAwQFBgcICQoLDA0ODww", // 23 characters
  "ref_AAECAwQFBgcICQoLDA0OD+", // not base64url
  "ref_AAECAwQFBgcICQoLDA0ODx", // last character has bits beyond the 16 bytes
  "REF_AAECAwQFBgcICQoLDA0ODw",
  "ref_AAECAwQFBgcICQoLDA0ODw\n",
  "ref_AAECAwQFBgcICQoLDA0ODw;x",
  "",
];

describe("the Solana memo", () => {
  it("is ss1, the 22 characters of the referral id and 7 random base64url characters: 32 in all", () => {
    expect(solanaMemo(ID, fixed)).toBe("ss1AAECAwQFBgcICQoLDA0ODwqqqqqqq");
    expect(solanaMemo(ID, () => Buffer.from([0, 25, 26, 51, 52, 62, 255]))).toBe("ss1AAECAwQFBgcICQoLDA0ODwAZaz0-_");
    expect(solanaMemo(ID)).toHaveLength(32);
    expect(memoReferral(solanaMemo(ID))).toBe(ID);
    expect(solanaMemo(ID)).not.toBe(solanaMemo(ID));
  });

  it("is 32 random hex characters without a referral, as before", () => {
    expect(solanaMemo(undefined, fixed)).toBe("aa".repeat(16));
    expect(solanaMemo(undefined)).toMatch(/^[0-9a-f]{32}$/);
    expect(memoReferral(solanaMemo(undefined))).toBeUndefined();
  });

  it("is rb:<op>;ss1<id> for a budget buy, at most 93 bytes", () => {
    expect(budgetMemo("op-1", ID)).toBe("rb:op-1;ss1AAECAwQFBgcICQoLDA0ODw");
    expect(budgetMemo("op-1", undefined)).toBe("rb:op-1");
    const longest = budgetMemo("a".repeat(64), ID);
    expect(Buffer.byteLength(longest, "utf8")).toBe(93);
    expect(memoReferral(longest)).toBe(ID);
    expect(memoReferral("rb:op-1")).toBeUndefined();
  });

  it("marks nothing for a malformed id", () => {
    for (const id of MALFORMED) {
      expect(referralIdBytes(id), JSON.stringify(id)).toBeUndefined();
      expect(solanaMemo(id, fixed), JSON.stringify(id)).toBe("aa".repeat(16));
      expect(budgetMemo("op-1", id), JSON.stringify(id)).toBe("rb:op-1");
      expect(tempoClientId(id), JSON.stringify(id)).toBeUndefined();
    }
  });

  it("reads no referral from a memo of any other shape", () => {
    expect(memoReferral("ss1AAECAwQFBgcICQoLDA0ODwqqqqqq")).toBeUndefined(); // 31 characters
    expect(memoReferral("ss1AAECAwQFBgcICQoLDA0ODwqqqqqqqq")).toBeUndefined(); // 33
    expect(memoReferral("ss1AAECAwQFBgcICQoLDA0ODxqqqqqqq")).toBeUndefined(); // not a canonical id
    expect(memoReferral("xx;ss1AAECAwQFBgcICQoLDA0ODw")).toBeUndefined();
    expect(memoReferral("rb:op-1;ss1AAECAwQFBgcICQoLDA0ODwq")).toBeUndefined();
    expect(memoReferral(undefined)).toBeUndefined();
  });
});

describe("the Tempo memo", () => {
  const challengeId = "ch_123";
  const realm = "seller.example.com";
  const ref = "ref_AAAAAAAAAAAAAAAAAAAAAA";

  it("holds the client id superstables:<ref id> in bytes 15 to 24, as mppx encodes it", () => {
    expect(tempoClientId(ref)).toBe("superstables:ref_AAAAAAAAAAAAAAAAAAAAAA");
    const memo = mppMemo(challengeId, realm, tempoClientId(ref));
    expect(memo).toBe("0xef1ed7120152909dee618e0ad199381ad0e938c1f05aa4630486ccdac470050f");
    expect(memo).toBe(Attribution.encode({ challengeId, serverId: realm, clientId: tempoClientId(ref) }));
    expect(Attribution.decode(memo)?.clientFingerprint).toBe("0x1ad0e938c1f05aa46304");
    expect(budgetMppMemo(challengeId, realm, tempoClientId(ref))).toBe(memo);
  });

  it("passes the seller's checks, verifyServer and verifyChallengeBinding", () => {
    const memo = mppMemo(challengeId, realm, tempoClientId(ref));
    expect(Attribution.verifyServer(memo, realm)).toBe(true);
    expect(Attribution.verifyChallengeBinding(memo, challengeId)).toBe(true);
    expect(Attribution.verifyChallengeBinding(memo, "ch_124")).toBe(false);
  });

  it("keeps ten zero bytes in the client slot without a referral, as before", () => {
    const memo = mppMemo(challengeId, realm, tempoClientId(undefined));
    expect(memo).toBe(Attribution.encode({ challengeId, serverId: realm }));
    expect(memo.slice(32, 52)).toBe("0".repeat(20));
    expect(mppMemo(challengeId, realm, tempoClientId("ref_bad"))).toBe(memo);
  });

  it("keys a memo by its challenge alone: the same under any referral or none, different for another challenge or realm", () => {
    const none = mppMemo(challengeId, realm);
    const key = tempoChallengeKey(none);
    expect(key).toBe(none);
    expect(tempoChallengeKey(mppMemo(challengeId, realm, tempoClientId(ref)))).toBe(key);
    expect(tempoChallengeKey(mppMemo(challengeId, realm, tempoClientId("ref_BAAAAAAAAAAAAAAAAAAAAA")))).toBe(key);
    expect(tempoChallengeKey(mppMemo(challengeId, realm, tempoClientId(ref)).toUpperCase().replace("0X", "0x"))).toBe(key);
    expect(tempoChallengeKey(mppMemo("ch_124", realm))).not.toBe(key);
    expect(tempoChallengeKey(mppMemo(challengeId, "other.example"))).not.toBe(key);
    expect(tempoChallengeKey("0xABC")).toBe("0xabc");
  });
});

describe("the remembered referrals, as the budget scripts read them", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.SUPERSTABLES_REFERRALS;
  });
  function remembered(origin: string, id = ID): { dir: string; token: string } {
    const dir = mkdtempSync(join(tmpdir(), "superstables-referral-store-"));
    dirs.push(dir);
    const { token } = signReferral(referralKey(), { jti: id, aud: origin });
    const entry = { listingId: "seller.example", token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), terms: "terms-1", seenAt: new Date().toISOString() };
    writeFileSync(join(dir, "referrals.json"), JSON.stringify({ [origin]: entry }));
    return { dir, token };
  }

  it("names the same headers the seller reads", () => {
    expect(REFERRAL_HEADER).toBe(SELLER_REFERRAL_HEADER);
    expect(PURCHASE_REF_HEADER).toBe(SELLER_PURCHASE_REF_HEADER);
  });

  it("freezes an operation's referral when it first starts, none included", () => {
    const { dir, token } = remembered("https://seller.example");
    const frozen = { id: ID, listingId: "seller.example", terms: "terms-1", token };
    expect(operationReferral(null, "https://seller.example/paid", dir)).toEqual(frozen);
    expect(operationReferral({}, "https://seller.example/paid", dir)).toEqual(frozen);
    expect(operationReferral({ referral: null }, "https://seller.example/paid", dir)).toBeNull();
    const other = { id: "ref_AAAAAAAAAAAAAAAAAAAAAA", listingId: "other", terms: "t", token: "a.b.c" };
    expect(operationReferral({ referral: other }, "https://seller.example/paid", dir)).toEqual(other);
    expect(operationReferral(null, "https://elsewhere.example/paid", dir)).toBeNull();
    expect(operationReferral(null, "https://seller.example/paid", dir, () => { throw new Error("unreadable"); })).toBeNull();
    process.env.SUPERSTABLES_REFERRALS = "off";
    expect(referralFor("https://seller.example/paid", dir)).toBeUndefined();
    expect(operationReferral(null, "https://seller.example/paid", dir)).toBeNull();
  });

  it("sends the token only with the referral the payment carries", () => {
    const referral = { id: ID, listingId: "seller.example", terms: "terms-1", token: "a.b.c" };
    expect(paidReferralHeaders(referral, "op-1", ID)).toEqual({ "superstables-referral": "a.b.c", "superstables-purchase-ref": "op-1" });
    expect(paidReferralHeaders(referral, "op-1", undefined)).toEqual({});
    expect(paidReferralHeaders(referral, "op-1", "ref_AAAAAAAAAAAAAAAAAAAAAA")).toEqual({});
    expect(paidReferralHeaders(null, "op-1", ID)).toEqual({});
  });
});
