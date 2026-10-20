// The one reader of the referrals this client remembered from the Superstables index: records/referrals.json, origin ->
// { listingId, token, expiresAt, terms, seenAt }. ./referrals.ts writes the file and reads it through here, and so do the
// budget scripts, including the Solana ones that run under node alone. Plain JavaScript for that reason.
//
// SUPERSTABLES_REFERRALS=off neither remembers nor sends.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REFERRALS_FILE = "referrals.json";
/** The seller-facing header names, as `@superstables/client/seller` reads them (src/seller/referral.ts). */
export const REFERRAL_HEADER = "superstables-referral";
export const PURCHASE_REF_HEADER = "superstables-purchase-ref";

const MAX_TOKEN_LENGTH = 4_096;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * @typedef {{ listingId: string, token: string, expiresAt: string, terms: string, seenAt: string }} RememberedReferral
 * @typedef {{ id: string, token: string, listingId: string, terms: string, expiresAt: string }} ActiveReferral
 * @typedef {{ id: string, listingId: string, terms: string, token: string }} JournalReferral
 */

/** Is remembering and sending referrals switched on? On unless SUPERSTABLES_REFERRALS is off (or 0, false, no). */
export function referralsEnabled() {
  const raw = (process.env.SUPERSTABLES_REFERRALS ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isReferralToken(value) {
  return typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && COMPACT_JWS.test(value);
}

/** @param {string} segment */
function part(segment) {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A token's payload, read WITHOUT checking the signature: for the referral id and expiry, never for trust.
 * @param {unknown} token
 * @returns {Record<string, unknown> | undefined}
 */
export function tokenPayload(token) {
  if (!isReferralToken(token)) return undefined;
  const [h, p] = token.split(".");
  return part(h) && part(p);
}

/**
 * The referral id of a token, read without verifying it. Undefined when it has none.
 * @param {string} token
 * @returns {string | undefined}
 */
export function referralId(token) {
  const jti = tokenPayload(token)?.jti;
  return typeof jti === "string" && jti.length > 0 && jti.length <= 200 ? jti : undefined;
}

/**
 * @param {string} url
 * @returns {string | undefined}
 */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {RememberedReferral} entry
 * @param {Date} now
 */
export function live(entry, now) {
  return Date.parse(entry.expiresAt) > now.getTime();
}

/**
 * The well-formed entries of the referrals file in `dir`, by origin. A missing or unreadable file has none.
 * @param {string} dir
 * @returns {Record<string, RememberedReferral>}
 */
export function readReferrals(dir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(dir, REFERRALS_FILE), "utf8"));
  } catch {
    return {};
  }
  /** @type {Record<string, RememberedReferral>} */
  const out = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [origin, e] of Object.entries(parsed)) {
    if (
      e &&
      typeof e.listingId === "string" &&
      isReferralToken(e.token) &&
      typeof e.expiresAt === "string" &&
      Number.isFinite(Date.parse(e.expiresAt)) &&
      typeof e.terms === "string" &&
      typeof e.seenAt === "string"
    ) {
      out[origin] = e;
    }
  }
  return out;
}

/**
 * The referral remembered in `dir` for this URL's exact origin, when referrals are on and there is one that has not
 * expired and whose token names that origin as its audience (read without verifying it: a token for another seller is
 * never sent to this one).
 * @param {string} url
 * @param {string} dir
 * @param {Date} [now]
 * @returns {ActiveReferral | undefined}
 */
export function referralFor(url, dir, now = new Date()) {
  if (!referralsEnabled()) return undefined;
  const origin = originOf(url);
  const entry = origin ? readReferrals(dir)[origin] : undefined;
  if (!entry || !live(entry, now)) return undefined;
  const id = referralId(entry.token);
  if (!id || tokenPayload(entry.token)?.aud !== origin) return undefined;
  return { id, token: entry.token, listingId: entry.listingId, terms: entry.terms, expiresAt: entry.expiresAt };
}

/**
 * The referral a budget operation pays under. The first run decides it and its journal keeps it (`null` for none), so
 * every later run under the same operation id uses the same one. A referral that cannot be read is none: it is never
 * worth a payment.
 * @param {{ referral?: JournalReferral | null } | null | undefined} prior the operation's journal before this run
 * @param {string} url
 * @param {string} dir the records directory
 * @param {(url: string, dir: string) => ActiveReferral | undefined} [lookup]
 * @returns {JournalReferral | null}
 */
export function operationReferral(prior, url, dir, lookup = referralFor) {
  if (prior && prior.referral !== undefined) return prior.referral;
  try {
    const found = lookup(url, dir);
    return found ? { id: found.id, listingId: found.listingId, terms: found.terms, token: found.token } : null;
  } catch {
    return null;
  }
}

/**
 * The referral headers of a paid request: the token and the purchase reference. None unless the payment carries this
 * same referral on chain (`carried`, the id its memo or client id names), so the token never names another referral
 * than the payment.
 * @param {JournalReferral | null | undefined} referral
 * @param {string} purchaseRef
 * @param {string | undefined} carried
 * @returns {Record<string, string>}
 */
export function paidReferralHeaders(referral, purchaseRef, carried) {
  return referral && carried === referral.id ? { [REFERRAL_HEADER]: referral.token, [PURCHASE_REF_HEADER]: purchaseRef } : {};
}
