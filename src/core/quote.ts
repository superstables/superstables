// Quoting: find out what a paid endpoint charges, and say so, without paying anything.
// A 402 challenge is free to ask for, so a quote is a read: it costs nothing, signs
// nothing and commits to nothing. What it does do is freeze the facts — the amount, the
// asset, the recipient, the network — so the owner approves the same payment the agent saw.
// Everything a quote records comes from the seller's own requirement; nothing is inferred
// from the seller's self-declared resource URL, which the seller could write anything in.

import { detectPayment, type SellerChallenge } from "./x402.js";
import { judgeOffers } from "./rails/index.js";
import type { Offer } from "./rails/types.js";
import { SellerTextError } from "./text.js";
import { evaluatePolicy, policyChecks, type Policy } from "./policy.js";
import { resolveRequest } from "./discovery.js";
import { Records } from "./records.js";
import type { Quote, ResolvedRequest, ServiceListing } from "./types.js";

/** How long a quote is good for. Long enough to ask a human, short enough to re-check. */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

/** Quote a bare URL, or a discovered service plus the parameters to call it with. */
export type QuoteInput = { url: string } | { service: ServiceListing; params: Record<string, string> };

export interface QuoteDeps {
  records: Records;
  /** The agent-side copy of the owner's policy: an early, advisory verdict. */
  policy: Policy;
}

/**
 * Ask a paid endpoint what it wants, judge it, and write the answer down.
 * Throws when the endpoint is not a paid endpoint (x402 or MPP), or when nothing it offers can be
 * paid by this client. A policy refusal is not a throw: it is recorded on the quote, so a
 * caller can show the owner what was asked for and why it was refused.
 */
export async function quote(input: QuoteInput, deps: QuoteDeps): Promise<Quote> {
  const { url, request, service } = resolveTarget(input);

  const challenge: SellerChallenge = await detectPayment(url);
  const chosen = firstSupported(challenge, url);

  const asset = chosen.terms.asset;
  const payment = {
    // The host we chose to call, never the one the seller claims in its challenge.
    domain: hostOf(url),
    amountDecimal: chosen.terms.amountDecimal,
    asset,
    spentTodayDecimal: deps.records.spentToday(asset),
  };
  const verdict = evaluatePolicy(deps.policy, payment);

  const now = Date.now();
  const record: Quote = {
    id: deps.records.newId(),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    status: "open",
    url,
    serviceId: service?.id,
    serviceName: service?.name,
    description: challenge.description || undefined,
    request,
    terms: chosen.terms,
    requirement: chosen.requirement,
    policy: { allowed: verdict.allowed, reason: verdict.reason, checks: policyChecks(deps.policy, payment) },
    approval: "wallet",
  };
  return deps.records.saveQuote(record);
}

/**
 * A stored quote, with its clock applied: an open quote whose time has passed is expired,
 * and says so from then on.
 */
export function getQuote(id: string, records: Records): Quote | undefined {
  const found = records.getQuote(id);
  if (!found) return undefined;
  if (found.status === "open" && Date.parse(found.expiresAt) <= Date.now()) {
    return records.saveQuote({ ...found, status: "expired" });
  }
  return found;
}

// ── Internals ──────────────────────────────────────────────────────────────────────────

function resolveTarget(input: QuoteInput): { url: string; request?: ResolvedRequest; service?: ServiceListing } {
  if ("url" in input) return { url: input.url };
  const request = resolveRequest(input.service, input.params);
  return { url: request.url, request, service: input.service };
}

/**
 * Sellers may offer several ways to pay. Take the first one this client can actually pay;
 * when none of them work, say what was offered and why each was refused, because "payment
 * failed" is useless and "it wants mainnet USDC" is actionable.
 */
function firstSupported(challenge: SellerChallenge, url: string): Offer {
  const refusals: string[] = [];
  // The seller's own words in each description are quoted as one bounded line: this sentence reaches an agent as the
  // client's refusal (rails/index.ts, describeAccept).
  for (const { offered, judged } of judgeOffers(challenge)) {
    if (judged.supported) return judged.offer;
    refusals.push(`${offered}: ${judged.reason}`);
  }
  // A challenge can list any number of offers; the first few say enough.
  const shown = refusals.slice(0, 5).join("; ") + (refusals.length > 5 ? `; and ${refusals.length - 5} more` : "");
  // The host is the one this client called; the offers are the seller's words, kept apart as the detail.
  throw new SellerTextError(`${hostOf(url)} offers no payment this client can make`, shown);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
