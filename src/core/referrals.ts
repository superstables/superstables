// Referrals the Superstables index handed out, remembered so the paid request can carry them. A listing whose seller
// opted in comes with a referral token; when this client later pays that seller, the token goes with the paid request,
// so the seller can tell the purchase came through Superstables. Only listings returned by the index are remembered,
// and only by the exact origin of their endpoint. The token carries nothing about the buyer.
//
// One small JSON file next to the other records, mode 0600: origin -> { listingId, token, expiresAt, terms, seenAt }.
// It is the only place the token is kept: a quote records which referral it found, and the paid request reads the
// token from here. Expired entries are dropped whenever it is written, and each write goes to a file of its own that
// is then renamed into place, so two processes writing at once never leave a torn file (the later write wins).
// SUPERSTABLES_REFERRALS=off neither remembers nor sends.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { decodeReferral, isReferralToken } from "../seller/referral.js";
import { ensureDir, recordsDir } from "./home.js";
import type { ServiceListing } from "./types.js";

export const REFERRALS_FILE = "referrals.json";

export interface RememberedReferral {
  listingId: string;
  token: string;
  expiresAt: string;
  terms: string;
  seenAt: string;
}

/** A remembered referral that applies to a URL now, with its referral id. */
export interface ActiveReferral {
  id: string;
  token: string;
  listingId: string;
  terms: string;
  expiresAt: string;
}

/** Is remembering and sending referrals switched on? On unless SUPERSTABLES_REFERRALS is off (or 0, false, no). */
export function referralsEnabled(): boolean {
  const raw = (process.env.SUPERSTABLES_REFERRALS ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

/** The referral id of a token, read without verifying it. Undefined when it has none. */
export function referralId(token: string): string | undefined {
  const jti = decodeReferral(token)?.payload.jti;
  return typeof jti === "string" && jti.length > 0 && jti.length <= 200 ? jti : undefined;
}

/**
 * When a referral stops being sent: the index's expires_at, but never later than the token's own `exp` (read without
 * verifying it). Undefined for a token without an `exp`, which no seller would accept.
 */
function expiryOf(token: string, expiresAt: string): string | undefined {
  const exp = decodeReferral(token)?.payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  const listed = Date.parse(expiresAt);
  const until = Number.isFinite(listed) ? Math.min(listed, exp * 1000) : exp * 1000;
  return Number.isFinite(until) ? new Date(until).toISOString() : undefined;
}

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function live(entry: RememberedReferral, now: Date): boolean {
  return Date.parse(entry.expiresAt) > now.getTime();
}

function read(dir: string): Record<string, RememberedReferral> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, REFERRALS_FILE), "utf8"));
  } catch {
    return {};
  }
  const out: Record<string, RememberedReferral> = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [origin, value] of Object.entries(parsed as Record<string, unknown>)) {
    const e = value as Partial<RememberedReferral> | null;
    if (
      e &&
      typeof e.listingId === "string" &&
      isReferralToken(e.token) &&
      typeof e.expiresAt === "string" &&
      Number.isFinite(Date.parse(e.expiresAt)) &&
      typeof e.terms === "string" &&
      typeof e.seenAt === "string"
    ) {
      out[origin] = e as RememberedReferral;
    }
  }
  return out;
}

/**
 * Remember the referrals of index listings, by the origin of each listing's endpoint. Listings from anywhere but the
 * Superstables index, without a referral, or with one that has expired are skipped. Never throws: a referral that
 * could not be written is simply not sent later.
 */
export function rememberReferrals(listings: readonly ServiceListing[], dir: string = recordsDir(), now: Date = new Date()): void {
  if (!referralsEnabled()) return;
  const fresh = listings.filter(
    (l) => l.source === "superstables-index" && l.referral && isReferralToken(l.referral.token) && referralId(l.referral.token) && originOf(l.endpoint),
  );
  if (fresh.length === 0) return;
  try {
    const kept = Object.fromEntries(Object.entries(read(dir)).filter(([, entry]) => live(entry, now)));
    for (const listing of fresh) {
      const expiresAt = expiryOf(listing.referral!.token, listing.referral!.expiresAt);
      if (!expiresAt) continue;
      const entry: RememberedReferral = {
        listingId: listing.id,
        token: listing.referral!.token,
        expiresAt,
        terms: listing.referral!.terms,
        seenAt: now.toISOString(),
      };
      if (live(entry, now)) kept[originOf(listing.endpoint)!] = entry;
    }
    ensureDir(dir);
    const path = join(dir, REFERRALS_FILE);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(kept, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Discovery goes on without it.
  }
}

/**
 * The referral remembered for this URL's exact origin, when referrals are on and there is one that has not expired
 * and whose token names that origin as its audience (read without verifying it: a token for another seller is never
 * sent to this one).
 */
export function referralFor(url: string, dir: string = recordsDir(), now: Date = new Date()): ActiveReferral | undefined {
  if (!referralsEnabled()) return undefined;
  const origin = originOf(url);
  const entry = origin ? read(dir)[origin] : undefined;
  if (!entry || !live(entry, now)) return undefined;
  const payload = decodeReferral(entry.token)?.payload;
  const id = referralId(entry.token);
  if (!id || payload?.aud !== origin) return undefined;
  return { id, token: entry.token, listingId: entry.listingId, terms: entry.terms, expiresAt: entry.expiresAt };
}
