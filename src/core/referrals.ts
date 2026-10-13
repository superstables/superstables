// Referrals the Superstables index handed out, remembered so the paid request can carry them. A listing whose seller
// opted in comes with a referral token; when this client later pays that seller, the token goes with the paid request,
// so the seller can tell the purchase came through Superstables. Only listings returned by the index are remembered,
// and only by the exact origin of their endpoint. The token carries nothing about the buyer.
//
// One small JSON file next to the other records, mode 0600: origin -> { listingId, token, expiresAt, terms, seenAt }.
// It is the only place the token is kept: a quote records which referral it found, and the paid request reads the
// token from here. Expired entries are dropped whenever it is written, and each write goes to a file of its own that
// is then renamed into place, so two processes writing at once never leave a torn file (the later write wins).
// Every read goes through ./referral-store.mjs, which the budget scripts share. SUPERSTABLES_REFERRALS=off neither
// remembers nor sends.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  REFERRALS_FILE,
  isReferralToken,
  live,
  originOf,
  readReferrals,
  referralFor as rememberedFor,
  referralId,
  referralsEnabled,
  tokenPayload,
} from "./referral-store.mjs";
import { ensureDir, recordsDir } from "./home.js";
import type { ServiceListing } from "./types.js";

export { REFERRALS_FILE, referralId, referralsEnabled };

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

/**
 * When a referral stops being sent: the index's expires_at, but never later than the token's own `exp` (read without
 * verifying it). Undefined for a token without an `exp`, which no seller would accept.
 */
function expiryOf(token: string, expiresAt: string): string | undefined {
  const exp = tokenPayload(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  const listed = Date.parse(expiresAt);
  const until = new Date(Number.isFinite(listed) ? Math.min(listed, exp * 1000) : exp * 1000);
  // An exp past the range of a Date has no ISO form; such a token is skipped, not the whole batch.
  return Number.isFinite(until.getTime()) ? until.toISOString() : undefined;
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
    const kept: Record<string, RememberedReferral> = Object.fromEntries(Object.entries(readReferrals(dir)).filter(([, entry]) => live(entry, now)));
    for (const listing of fresh) {
      try {
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
      } catch {
        // One listing that cannot be remembered does not cost the others.
      }
    }
    ensureDir(dir);
    const path = join(dir, REFERRALS_FILE);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(kept, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    try {
      renameSync(temporary, path);
    } catch (err) {
      try {
        unlinkSync(temporary);
      } catch {
        // already gone
      }
      throw err;
    }
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
  return rememberedFor(url, dir, now);
}
