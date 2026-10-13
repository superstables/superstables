// The referral marker in an EIP-3009 nonce. A referred EVM payment carries its referral inside the authorization it
// signs, so the chain itself says which referral a sale came through, whatever the seller does with the token.
//
//   bytes 0-3    the marker, ASCII "SSRF"
//   bytes 4-19   the 16 bytes a referral id names (`ref_` and 22 base64url characters)
//   bytes 20-31  random
//
// A payment without a well-formed referral id gets 32 random bytes.

import { randomBytes } from "node:crypto";
import type { Hex } from "viem";

export const REFERRAL_NONCE_MARKER = Buffer.from("SSRF", "ascii");

const REFERRAL_ID = /^ref_([A-Za-z0-9_-]{22})$/;
const ID_BYTES = 16;
const RANDOM_BYTES = 32 - REFERRAL_NONCE_MARKER.length - ID_BYTES;

/** The 16 bytes a referral id names. Undefined unless it is `ref_` and the canonical base64url of exactly 16 bytes. */
export function referralIdBytes(id: string): Buffer | undefined {
  const encoded = REFERRAL_ID.exec(id)?.[1];
  if (!encoded) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  // 22 characters hold 132 bits; only the encoding whose last 4 bits are zero names these 16 bytes and no others.
  return bytes.length === ID_BYTES && bytes.toString("base64url") === encoded ? bytes : undefined;
}

/** The nonce for one EIP-3009 authorization: marked with the referral when its id is well formed, random otherwise. */
export function referralNonce(id?: string, random: (size: number) => Buffer = randomBytes): Hex {
  const bytes = id === undefined ? undefined : referralIdBytes(id);
  const nonce = bytes ? Buffer.concat([REFERRAL_NONCE_MARKER, bytes, random(RANDOM_BYTES)]) : random(32);
  return `0x${nonce.toString("hex")}`;
}

/** The referral id a nonce carries, or undefined when it carries none. */
export function nonceReferral(nonce: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) return undefined;
  const bytes = Buffer.from(nonce.slice(2), "hex");
  if (!bytes.subarray(0, REFERRAL_NONCE_MARKER.length).equals(REFERRAL_NONCE_MARKER)) return undefined;
  return `ref_${bytes.subarray(REFERRAL_NONCE_MARKER.length, REFERRAL_NONCE_MARKER.length + ID_BYTES).toString("base64url")}`;
}
