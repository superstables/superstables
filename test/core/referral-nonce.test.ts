// The referral marker in an EIP-3009 nonce: "SSRF", the 16 bytes of the referral id, then 12 random bytes.

import { describe, expect, it } from "vitest";
import { nonceReferral, referralIdBytes, referralNonce } from "../../src/core/referral-nonce.js";

const ID = "ref_AAECAwQFBgcICQoLDA0ODw";
const fixed = (size: number) => Buffer.alloc(size, 0xaa);

describe("referralNonce", () => {
  it("lays out the marker, the id's bytes and the randomness, byte for byte", () => {
    expect(referralNonce(ID, fixed)).toBe("0x53535246000102030405060708090a0b0c0d0e0faaaaaaaaaaaaaaaaaaaaaaaa");
    expect(nonceReferral(referralNonce(ID, fixed))).toBe(ID);
  });

  it("takes fresh randomness for every nonce", () => {
    const a = referralNonce(ID);
    const b = referralNonce(ID);
    expect(a.slice(0, 42)).toBe(b.slice(0, 42));
    expect(a).not.toBe(b);
  });

  it("marks nothing for no id or a malformed one: the nonce is 32 random bytes", () => {
    const malformed = [
      "AAECAwQFBgcICQoLDA0ODw", // no prefix
      "ref_AAECAwQFBgcICQoLDA0OD", // 21 characters
      "ref_AAECAwQFBgcICQoLDA0ODww", // 23 characters
      "ref_AAECAwQFBgcICQoLDA0OD+", // not base64url
      "ref_AAECAwQFBgcICQoLDA0OD/",
      "ref_AAECAwQFBgcICQoLDA0ODx", // last character has bits beyond the 16 bytes
      "REF_AAECAwQFBgcICQoLDA0ODw",
      " ref_AAECAwQFBgcICQoLDA0ODw",
      "ref_AAECAwQFBgcICQoLDA0ODw\n",
      "",
    ];
    for (const id of malformed) {
      expect(referralIdBytes(id), JSON.stringify(id)).toBeUndefined();
      expect(referralNonce(id, fixed), JSON.stringify(id)).toBe(`0x${"aa".repeat(32)}`);
    }
    expect(referralNonce(undefined, fixed)).toBe(`0x${"aa".repeat(32)}`);
    expect(referralNonce()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("reads no referral from a nonce without the marker or that is not 32 bytes", () => {
    expect(nonceReferral(`0x${"aa".repeat(32)}`)).toBeUndefined();
    expect(nonceReferral("0x53535246000102030405060708090a0b0c0d0e0f")).toBeUndefined();
    expect(nonceReferral("0x53535246000102030405060708090a0b0c0d0e0faaaaaaaaaaaaaaaaaaaaaaaazz")).toBeUndefined();
    expect(nonceReferral("0x53535246000102030405060708090A0B0C0D0E0FAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(ID);
  });
});
