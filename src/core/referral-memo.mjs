// The referral marker in what a referred payment carries on chain, outside EVM (there it is the EIP-3009 nonce,
// ./referral-nonce.ts). Plain JavaScript, so the Solana budget scripts, which run under node alone, use the same rules.
//
//   Solana single purchase  the memo "ss1", the referral id's 22 base64url characters, 7 random base64url characters:
//                           32 characters, as long as the 32 random hex characters of an unreferred payment
//   Solana budget buy       the memo "rb:<op>;ss1" and the referral id's 22 characters
//   Tempo                   MPP's client id "superstables:<referral id>", whose 10-byte fingerprint fills bytes 15 to 24
//                           of the payment's memo
//
// A referral id is `ref_` and the canonical base64url of 16 bytes. Any other id marks nothing.

import { randomBytes } from "node:crypto";

export const SOLANA_MEMO_MARKER = "ss1";
export const TEMPO_CLIENT_ID_PREFIX = "superstables:";

const REFERRAL_ID = /^ref_([A-Za-z0-9_-]{22})$/;
const ID_BYTES = 16;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const RANDOM_CHARS = 7;
const SINGLE_MEMO = /^ss1([A-Za-z0-9_-]{22})[A-Za-z0-9_-]{7}$/;
const BUDGET_MEMO = /^rb:[A-Za-z0-9][A-Za-z0-9._-]{0,63};ss1([A-Za-z0-9_-]{22})$/;

/**
 * The 16 bytes a referral id names. Undefined unless it is `ref_` and the canonical base64url of exactly 16 bytes.
 * @param {string} id
 * @returns {Buffer | undefined}
 */
export function referralIdBytes(id) {
  const encoded = typeof id === "string" ? REFERRAL_ID.exec(id)?.[1] : undefined;
  if (!encoded) return undefined;
  const bytes = Buffer.from(encoded, "base64url");
  // 22 characters hold 132 bits; only the encoding whose last 4 bits are zero names these 16 bytes and no others.
  return bytes.length === ID_BYTES && bytes.toString("base64url") === encoded ? bytes : undefined;
}

/** @param {string | undefined} id */
function idBody(id) {
  return id !== undefined && referralIdBytes(id) ? id.slice("ref_".length) : undefined;
}

/**
 * The memo of one Solana single purchase: marked with the referral when its id is well formed, 32 random hex
 * characters otherwise.
 * @param {string | undefined} id
 * @param {(size: number) => Buffer} [random]
 * @returns {string}
 */
export function solanaMemo(id, random = randomBytes) {
  const body = idBody(id);
  if (!body) return random(16).toString("hex");
  // 64 divides 256, so each random byte picks a character uniformly.
  const tail = Array.from(random(RANDOM_CHARS), (b) => BASE64URL[b & 63]).join("");
  return `${SOLANA_MEMO_MARKER}${body}${tail}`;
}

/**
 * The memo of one Solana budget buy: the operation's own, then the referral when its id is well formed.
 * @param {string} op
 * @param {string | undefined} id
 * @returns {string}
 */
export function budgetMemo(op, id) {
  const body = idBody(id);
  return body ? `rb:${op};${SOLANA_MEMO_MARKER}${body}` : `rb:${op}`;
}

/**
 * The referral id a Solana memo carries, single purchase or budget buy, or undefined when it carries none.
 * @param {unknown} memo
 * @returns {string | undefined}
 */
export function memoReferral(memo) {
  if (typeof memo !== "string") return undefined;
  const body = SINGLE_MEMO.exec(memo)?.[1] ?? BUDGET_MEMO.exec(memo)?.[1];
  return body && referralIdBytes(`ref_${body}`) ? `ref_${body}` : undefined;
}

/**
 * The MPP client id of a Tempo payment under this referral, or undefined when its id is not well formed.
 * @param {string | undefined} id
 * @returns {string | undefined}
 */
export function tempoClientId(id) {
  return idBody(id) ? `${TEMPO_CLIENT_ID_PREFIX}${id}` : undefined;
}

/**
 * A Tempo memo with its client-id slot (bytes 15 to 24) zeroed, lowercased: what it says about the seller's challenge (id
 * and realm) alone. The same challenge has the same key under any referral, or none.
 * @param {string} memo
 * @returns {string}
 */
export function tempoChallengeKey(memo) {
  const hex = memo.toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(hex) ? `${hex.slice(0, 32)}${"0".repeat(20)}${hex.slice(52)}` : hex;
}
