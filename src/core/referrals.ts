// Referrals the Superstables index handed out, remembered so the paid request can carry them. A listing whose seller
// opted in comes with a referral token; when this client later pays that seller, the token goes with the paid request,
// so the seller can tell the purchase came through Superstables. Only listings returned by the index are remembered,
// and only by the exact origin of their endpoint. The token carries nothing about the buyer.
//
// One small JSON file next to the other records, mode 0600: origin -> { listingId, token, expiresAt, terms, seenAt }.
// Expired entries are dropped whenever it is written. SUPERSTABLES_REFERRALS=off neither remembers nor sends.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { decodeReferral, isReferralToken } from "../seller/referral.js";
import { ensureDir, recordsDir } from "./home.js";
import type { QuoteReferral, ServiceListing } from "./types.js";

export const REFERRALS_FILE = "referrals.json";

export interface RememberedReferral {
  listingId: string;
  token: string;
  expiresAt: string;
  terms: string;
  seenAt: string;
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
      const entry: RememberedReferral = {
        listingId: listing.id,
        token: listing.referral!.token,
        expiresAt: listing.referral!.expiresAt,
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

/** The referral remembered for this URL's exact origin, when there is one that has not expired and referrals are on. */
export function referralFor(url: string, dir: string = recordsDir(), now: Date = new Date()): QuoteReferral | undefined {
  if (!referralsEnabled()) return undefined;
  const origin = originOf(url);
  const entry = origin ? read(dir)[origin] : undefined;
  if (!entry || !live(entry, now)) return undefined;
  const id = referralId(entry.token);
  if (!id) return undefined;
  return { id, token: entry.token, listingId: entry.listingId, terms: entry.terms, expiresAt: entry.expiresAt };
}
