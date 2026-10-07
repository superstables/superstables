// The rails `pay` pays with. Adding one is a file next to this one implementing RailAdapter (./types.ts), its wallet
// step for the approval page (../signer/steps/), and one line in each list. A chain no registered rail names is
// refused before the owner is asked.

import { describeNetwork, mainnetName, networkFor, shortLabel, type NetworkInfo } from "../chain.js";
import type { MppChallenge } from "../mpp.js";
import type { SignRequest } from "../signer/types.js";
import { untrustedText } from "../text.js";
import type { RawAccept, SellerChallenge } from "../x402.js";
import { evmRail } from "./evm.js";
import { tempoRail } from "./tempo.js";
import { solanaRail } from "./solana.js";
import type { Judged, Offer, PushRail, RailAdapter, X402Rail } from "./types.js";

export const RAILS: readonly RailAdapter[] = [
  evmRail,
  tempoRail,
  solanaRail,
];

/** The chains `pay` pays on, rail by rail. */
export const SUPPORTED_NETWORKS: readonly NetworkInfo[] = RAILS.flatMap((rail) => rail.networks);

/** The rail that pays on this chain, or undefined. */
export function railFor(network: string | NetworkInfo | undefined): RailAdapter | undefined {
  const known = typeof network === "string" ? networkFor(network) : network;
  if (!known) return undefined;
  return RAILS.find((rail) => rail.networks.some((n) => n.caip2 === known.caip2));
}

export function x402RailFor(network: string | NetworkInfo | undefined): X402Rail | undefined {
  const rail = railFor(network);
  return rail?.flow === "x402" ? rail : undefined;
}

function pushRailFor(network: string | NetworkInfo | undefined): PushRail | undefined {
  const rail = railFor(network);
  return rail?.flow === "push" ? rail : undefined;
}

/** The chains `pay` pays on, as people read them. */
export function payableLabels(): string[] {
  return SUPPORTED_NETWORKS.map((n) => n.label.replace(/\s*\(testnet\)\s*/i, "").trim() || n.label);
}

/** Why a chain is refused: a mainnet says so; anything else is simply not one `pay` pays on. */
export function networkRefusal(named: string): string {
  const shown = untrustedText(describeNetwork(named), 60);
  const only = payableLabels().join(", ");
  return mainnetName(named)
    ? `chain ${shown} is not supported: it is a mainnet, and this client pays on testnets only (${only})`
    : `chain ${shown} is not supported (only ${only})`;
}

/**
 * Judge one x402 accept: exact scheme, a chain a registered x402 rail pays on, and that rail's own checks (token,
 * signing domain, amount, recipient). The terms come from the accept alone.
 */
export function judgeAccept(accept: RawAccept, version: 1 | 2): Judged {
  // Every string the seller offers here can end up in a refusal an agent reads, so it is quoted as one bounded line.
  const scheme = accept.scheme ?? "exact";
  if (scheme !== "exact") return { supported: false, reason: `scheme "${untrustedText(scheme, 40)}" is not supported (only exact)` };
  const named = String(accept.network ?? "");
  const network = networkFor(named);
  if (!network) return { supported: false, reason: networkRefusal(named || "unknown") };
  const rail = x402RailFor(network);
  // A chain this client pays on, but not with x402 (Tempo Moderato, where it pays MPP): the protocol is what is refused.
  if (!rail) {
    const paysWith = railFor(network);
    return {
      supported: false,
      reason: paysWith?.flow === "push"
        ? `x402 payments on ${shortLabel(network)} are not supported: this client pays MPP tempo.charge sellers there`
        : networkRefusal(named),
    };
  }
  return rail.judgeAccept(accept, version, network);
}

/** Judge one MPP challenge: a registered push rail for its method and chain, and that rail's own checks. */
export function judgeMppChallenge(challenge: MppChallenge, now: number = Date.now()): Judged {
  const intent = `${untrustedText(challenge.method, 30)}.${untrustedText(challenge.intent, 30)}`;
  const rail = RAILS.find((r): r is PushRail => r.flow === "push");
  if (!rail || challenge.method !== "tempo" || challenge.intent !== "charge") {
    return { supported: false, reason: `MPP ${intent} is not supported${rail ? " (only tempo.charge)" : ""}` };
  }
  return rail.judgeChallenge(challenge, now);
}

/** Every offer in a 402, judged, in the seller's order: x402 accepts first, then MPP challenges. */
export function judgeOffers(challenge: SellerChallenge, now: number = Date.now()): { offered: string; judged: Judged }[] {
  const out: { offered: string; judged: Judged }[] = [];
  if (challenge.x402Refusal) out.push({ offered: "an x402 challenge", judged: { supported: false, reason: challenge.x402Refusal } });
  for (const accept of challenge.x402?.accepts ?? []) {
    out.push({ offered: describeAccept(accept), judged: judgeAccept(accept, challenge.x402!.version) });
  }
  for (const mpp of challenge.mpp) {
    out.push({ offered: describeMpp(mpp), judged: judgeMppChallenge(mpp, now) });
  }
  return out;
}

/** The first offer in a 402 this client can pay, or undefined. */
export function firstPayable(challenge: SellerChallenge, now: number = Date.now()): Offer | undefined {
  for (const { judged } of judgeOffers(challenge, now)) if (judged.supported) return judged.offer;
  return undefined;
}

/**
 * Judge a sign request again, as a signer must before it asks anyone: the terms the owner is shown come from here,
 * never from the caller. The request's kind must be the wallet step of the rail its chain belongs to.
 */
export function judgeSignRequest(req: SignRequest): Judged {
  if (req.kind === "tempo-transfer") {
    if (!req.challenge || typeof req.challenge !== "object") return { supported: false, reason: "the request carried no payment challenge to check" };
    const judged = judgeMppChallenge(req.challenge);
    return judged.supported && railFor(judged.offer.terms.network)?.signKind !== req.kind
      ? { supported: false, reason: `a ${req.kind} request cannot pay on ${judged.offer.terms.networkLabel}` }
      : judged;
  }
  if (req.kind !== "eip3009" && req.kind !== "solana-transaction") {
    return { supported: false, reason: `this signer does not know requests of kind "${untrustedText(String((req as { kind?: unknown }).kind), 40)}"` };
  }
  if (!req.requirements || typeof req.requirements !== "object") return { supported: false, reason: "the request carried no payment requirement to check" };
  const version: unknown = req.x402Version;
  if (version !== 1 && version !== 2) return { supported: false, reason: `x402 version ${untrustedText(String(version), 20)} is not supported (only 1 and 2)` };
  const judged = judgeAccept(req.requirements as RawAccept, version);
  if (!judged.supported) return judged;
  if (railFor(judged.offer.terms.network)?.signKind !== req.kind) {
    return { supported: false, reason: `a ${req.kind} request cannot pay on ${judged.offer.terms.networkLabel}` };
  }
  return judged;
}

/** An x402 accept as one bounded line of the seller's own words: "exact USDC on Base Sepolia (testnet)". */
export function describeAccept(accept: RawAccept): string {
  const scheme = untrustedText(accept.scheme ?? "exact", 40);
  const network = untrustedText(describeNetwork(String(accept.network ?? "an unnamed chain")), 60);
  const asset = untrustedText(accept.extra?.name ?? accept.asset ?? "an unnamed asset", 60);
  return `${scheme} ${asset} on ${network}`;
}

/** An MPP challenge as one bounded line: "MPP tempo.charge on chain 42431". */
function describeMpp(challenge: MppChallenge): string {
  const details = (challenge.request?.methodDetails ?? {}) as Record<string, unknown>;
  const chain = details.chainId === undefined ? "" : ` on ${untrustedText(describeNetwork(`eip155:${String(details.chainId)}`), 60)}`;
  return `MPP ${untrustedText(challenge.method, 30)}.${untrustedText(challenge.intent, 30)}${chain}`;
}

export { pushRailFor };
