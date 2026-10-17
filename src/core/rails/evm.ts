// The x402 exact rail on EVM chains. The owner's wallet signs one EIP-3009 TransferWithAuthorization over the chain's
// USDC domain; the seller's facilitator submits it and pays the gas; the chain is then read for that authorization's
// use (settlement.ts). The chains, their USDC and its signing domain are pinned in src/core/chain.ts: a seller whose
// token, chain or domain differs is refused before the owner is asked. Only EIP-3009 offers with known `extra` fields are
// taken, and what is signed lasts ten minutes at most.

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { BASE_SEPOLIA, EVM_NETWORKS, fromAtomic, isSameAddress, isTransactionId, type NetworkInfo } from "../chain.js";
import { checkSettlement, findAuthorization } from "../settlement.js";
import { untrustedText } from "../text.js";
import type { SignResult } from "../signer/types.js";
import type { PaymentTerms } from "../types.js";
import type { Challenge, RawAccept } from "../x402.js";
import type { ChainReadOptions, Judged, Offer, PaymentFacts, SignedFacts, X402Rail } from "./types.js";

/** The EVM chains `pay` signs on: Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia, Ethereum Sepolia. */
const NETWORKS = EVM_NETWORKS;
/**
 * The longest window a seller may offer (as on superstables.com). Until the authorization's validBefore it can still move
 * money, so it counts against the daily cap and cannot be called unpaid: a seller does not get to make that open-ended.
 */
const MAX_TIMEOUT_SECONDS = 3_600;
/**
 * The longest an authorization `pay` signs stays usable, whatever window the seller allows. Offers up to
 * MAX_TIMEOUT_SECONDS are still taken: what is signed is clamped to this, and the requirement sent back to the seller is
 * left as offered (its server matches it exactly; its facilitator checks only that validBefore has not passed).
 */
export const MAX_SIGNED_LIFETIME_S = 600;
/** The `extra` keys an EVM offer may carry: the token's signing domain and decimals (checked against the pinned ones), and the transfer method. */
const EXTRA_KEYS = new Set(["name", "version", "decimals", "assetTransferMethod"]);

/** How long the authorization signed for a requirement lasts, in seconds: the seller's window, at most MAX_SIGNED_LIFETIME_S. */
export function signedLifetime(maxTimeoutSeconds: unknown): number {
  const offered = typeof maxTimeoutSeconds === "number" && Number.isInteger(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? maxTimeoutSeconds : 300;
  return Math.min(offered, MAX_SIGNED_LIFETIME_S);
}

export const evmRail: X402Rail = {
  rail: "evm",
  flow: "x402",
  signKind: "eip3009",
  networks: NETWORKS,

  judgeAccept(accept: RawAccept, version: 1 | 2, network: NetworkInfo): Judged {
    if (network.rail !== "evm" || !NETWORKS.some((n) => n.caip2 === network.caip2)) {
      return { supported: false, reason: `${network.label} is not an EVM chain this client signs x402 payments on` };
    }
    const scheme = accept.scheme ?? "exact";
    if (!accept.asset || !isSameAddress(accept.asset, network.token.address)) {
      return { supported: false, reason: `asset ${untrustedText(accept.extra?.name ?? accept.asset ?? "unknown", 60)} is not ${network.token.symbol} on ${network.label}` };
    }
    const extra: unknown = accept.extra;
    if (extra !== undefined && (extra === null || typeof extra !== "object" || Array.isArray(extra))) {
      return { supported: false, reason: "the offer's extra fields are malformed" };
    }
    // The x402 SDK signs Permit2 instead when the offer asks for it: nothing this client finds, reconciles or cancels.
    const method = accept.extra?.assetTransferMethod;
    if (method !== undefined && method !== "eip3009") {
      return { supported: false, reason: `this client signs EIP-3009 transfers only, and the offer asks for ${untrustedText(String(method), 30)}` };
    }
    if (accept.extra?.decimals !== undefined && Number(accept.extra.decimals) !== network.token.decimals) {
      return { supported: false, reason: `the offer's token decimals are not ${network.token.symbol}'s (${network.token.decimals})` };
    }
    const unknown = Object.keys(accept.extra ?? {}).filter((key) => !EXTRA_KEYS.has(key));
    if (unknown.length > 0) {
      return { supported: false, reason: `the offer carries signing fields this client does not use (${unknown.slice(0, 3).map((key) => untrustedText(key, 30)).join(", ")}${unknown.length > 3 ? ", and more" : ""})` };
    }
    // The signing domain is the token's own. An offer that names another one is either wrong or asks the owner's wallet to show
    // a name the seller chose as the signing application; either way the signature would not verify on chain.
    const domain = network.token.domain;
    if ((accept.extra?.name !== undefined && accept.extra.name !== domain.name) || (accept.extra?.version !== undefined && accept.extra.version !== domain.version)) {
      return { supported: false, reason: `the offer's signing domain is not ${network.token.symbol}'s on ${network.label} (expected name "${domain.name}", version "${domain.version}"), so the signature would not verify` };
    }
    const atomic = accept.amount ?? accept.maxAmountRequired;
    if (typeof atomic !== "string" || !/^[1-9]\d*$/.test(atomic) || BigInt(atomic) >= 2n ** 256n) {
      return { supported: false, reason: "the offered amount is missing, zero, not a canonical whole number of base units, or too large" };
    }
    if (typeof accept.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accept.payTo)) return { supported: false, reason: "the recipient (payTo) is missing or malformed" };
    if (/^0x0{40}$/i.test(accept.payTo)) return { supported: false, reason: "the recipient is the zero address" };
    if (isSameAddress(accept.payTo, network.token.address)) return { supported: false, reason: `the recipient is the ${network.token.symbol} contract itself` };
    const timeout = accept.maxTimeoutSeconds ?? 300;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
      return { supported: false, reason: `the offer's payment window is outside what is signed (at most ${MAX_TIMEOUT_SECONDS} seconds)` };
    }
    const amountAtomic = atomic;
    const terms: PaymentTerms = {
      amountDecimal: fromAtomic(amountAtomic, network.token.decimals),
      amountAtomic,
      asset: network.token.symbol,
      assetAddress: network.token.address,
      network: network.caip2,
      networkLabel: network.label,
      recipient: accept.payTo,
      scheme,
      x402Version: version,
      maxTimeoutSeconds: timeout,
    };
    const requirement: PaymentRequirements = {
      scheme,
      network: (accept.network ?? network.caip2) as PaymentRequirements["network"],
      asset: accept.asset,
      amount: amountAtomic,
      payTo: accept.payTo,
      maxTimeoutSeconds: timeout,
      extra: (accept.extra ?? {}) as Record<string, unknown>,
    };
    // v1 requirements keep their wire shape (maxAmountRequired, vernacular network) for the signer.
    if (version === 1) Object.assign(requirement, { maxAmountRequired: amountAtomic });
    return { supported: true, offer: { rail: "evm", terms, requirement } };
  },

  signRequest(offer, x402Version, context) {
    // What the wallet signs lasts at most MAX_SIGNED_LIFETIME_S: the local wallet's x402 signer takes validBefore from this
    // field, and the page's typed data clamps it again. The seller is sent its requirement as offered (credentialHeaders).
    const offered = offer.requirement as PaymentRequirements;
    const requirements = { ...offered, maxTimeoutSeconds: signedLifetime(offered.maxTimeoutSeconds) } as PaymentRequirements;
    return { kind: "eip3009", requirements, x402Version, context };
  },

  signedFacts(signed: SignResult): SignedFacts {
    if (signed.kind !== "eip3009") return {};
    const nonce = authorizationNonce(signed.payload);
    const validBefore = authorizationValidBefore(signed.payload);
    return { ...(nonce ? { authorizationNonce: nonce } : {}), ...(validBefore ? { authorizationValidBefore: validBefore } : {}) };
  },

  credentialHeaders(offer: Offer, signed: SignResult, challenge: Challenge): Record<string, string> {
    if (signed.kind !== "eip3009") throw new Error("an EVM x402 payment carries an EIP-3009 signature");
    return credentialHeader(challenge.version, offer.requirement as PaymentRequirements, signed.payload);
  },

  isTransaction(value: unknown): value is string {
    return isTransactionId(BASE_SEPOLIA.caip2, value);
  },

  checkPayment(facts: PaymentFacts, options: ChainReadOptions) {
    const network = NETWORKS.find((n) => n.caip2 === facts.network);
    return checkSettlement(
      {
        transaction: facts.transaction,
        payer: facts.payer,
        recipient: facts.recipient,
        amountAtomic: facts.amountAtomic,
        nonce: facts.nonce,
        network: facts.network,
      },
      { ...(network && options.rpcUrlFor?.(network) ? { rpcUrl: options.rpcUrlFor(network) } : {}), ...(options.endpointsFor ? { endpointsFor: options.endpointsFor } : {}), fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
    );
  },

  // The nonce is this payment's alone (32 random bytes, chosen when the page built the typed data), so a transaction that
  // used it is this payment, whichever attempt's seller named it.
  findPayment(facts: PaymentFacts, options: ChainReadOptions) {
    const network = NETWORKS.find((n) => n.caip2 === facts.network);
    return findAuthorization(
      {
        network: facts.network,
        payer: facts.payer,
        recipient: facts.recipient,
        amountAtomic: facts.amountAtomic,
        nonce: facts.nonce,
        validBefore: facts.validBefore,
        since: facts.since,
        transaction: facts.transaction,
        paymentBlock: facts.paymentBlock,
      },
      { ...(network && options.rpcUrlFor?.(network) ? { rpcUrl: options.rpcUrlFor(network) } : {}), ...(options.endpointsFor ? { endpointsFor: options.endpointsFor } : {}), fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
    );
  },
};

/** Where the credential goes on the wire, which differs between the two protocol versions. */
function credentialHeader(
  version: 1 | 2,
  requirement: PaymentRequirements,
  payload: { signature: string; authorization: Record<string, unknown> },
): Record<string, string> {
  if (version === 1) {
    const v1 = { x402Version: 1, scheme: requirement.scheme, network: requirement.network, payload };
    return { "X-PAYMENT": Buffer.from(JSON.stringify(v1), "utf8").toString("base64") };
  }
  return {
    "PAYMENT-SIGNATURE": encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: requirement,
      payload: payload as unknown as Record<string, unknown>,
    }),
  };
}

/** The EIP-3009 nonce in a signed payload, when it is a bytes32. */
function authorizationNonce(payload: { authorization: Record<string, unknown> }): string | undefined {
  const nonce = payload.authorization?.nonce;
  return typeof nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(nonce) ? nonce : undefined;
}

/** The EIP-3009 validBefore in a signed payload (unix seconds), as an ISO time, when it is a plain number. */
function authorizationValidBefore(payload: { authorization: Record<string, unknown> }): string | undefined {
  const raw = payload.authorization?.validBefore;
  const seconds = typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
