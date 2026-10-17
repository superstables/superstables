// Base58 and ed25519 checks with Node's own crypto, for Solana addresses and message signatures. Shared by the owner page
// (a sign-in) and the owner's signed settings, so both read a Solana wallet's signature the same way. Imports nothing but
// node:crypto.
import { createPublicKey, verify as verifySignature } from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Bytes of a base58 string (Solana addresses), or undefined if it is not base58.
 * @param {unknown} text
 * @returns {Uint8Array | undefined}
 */
export function base58Decode(text) {
  if (typeof text !== "string" || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) return undefined;
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(BASE58.indexOf(ch));
  /** @type {number[]} */
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * A Solana address: base58 of 32 bytes.
 * @param {unknown} text
 * @returns {text is string}
 */
export function isSolanaAddress(text) {
  return typeof text === "string" && text.length >= 32 && text.length <= 44 && base58Decode(text)?.length === 32;
}

/**
 * Whether `signature` (64 bytes) is `address`'s ed25519 signature over `message`.
 * @param {string} address
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
export function verifyEd25519(address, message, signature) {
  const key = base58Decode(address);
  if (key?.length !== 32 || signature.length !== 64) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") }, format: "jwk" });
    return verifySignature(null, message, publicKey, signature);
  } catch {
    return false;
  }
}
