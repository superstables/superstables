// The x402 exact rail on EVM chains. The owner's wallet signs one EIP-3009 TransferWithAuthorization over the chain's
// USDC domain; the seller's facilitator submits it and pays the gas; the chain is then read for that authorization's
// use (settlement.ts). The chains, their USDC and its signing domain are pinned in src/core/chain.ts: a seller whose
// token, chain or domain differs is refused before the owner is asked.

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
 * The longest an authorization the owner signs stays usable (its validBefore), as on superstables.com. Until then it can
 * still move money, so it counts against the daily cap and cannot be called unpaid: a seller does not get to make that
 * open-ended.
 */
const MAX_TIMEOUT_SECONDS = 3_600;

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
    if (!accept.asset || !isSameAddress(accept.asset, network.usdc.address)) {
      return { supported: false, reason: `asset ${untrustedText(accept.extra?.name ?? accept.asset ?? "unknown", 60)} is not USDC on ${network.label}` };
    }
    // The signing domain is USDC's own. An offer that names another one is either wrong or asks the owner's wallet to show
    // a name the seller chose as the signing application; either way the signature would not verify on chain.
    const domain = network.usdc.eip712;
    if ((accept.extra?.name !== undefined && accept.extra.name !== domain.name) || (accept.extra?.version !== undefined && accept.extra.version !== domain.version)) {
      return { supported: false, reason: `the offer's signing domain is not USDC's on ${network.label} (expected name "${domain.name}", version "${domain.version}"), so the signature would not verify` };
    }
    const atomic = accept.amount ?? accept.maxAmountRequired;
    if (!atomic || !/^\d+$/.test(String(atomic))) return { supported: false, reason: "the offered amount is missing or malformed" };
    if (!accept.payTo || !/^0x[0-9a-fA-F]{40}$/.test(accept.payTo)) return { supported: false, reason: "the recipient (payTo) is missing or malformed" };
    const timeout = accept.maxTimeoutSeconds ?? 300;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
      return { supported: false, reason: `the offer's payment window is outside what is signed (at most ${MAX_TIMEOUT_SECONDS} seconds)` };
    }
    const amountAtomic = String(atomic);
    const terms: PaymentTerms = {
      amountDecimal: fromAtomic(amountAtomic, network.usdc.decimals),
      amountAtomic,
      asset: "USDC",
      assetAddress: network.usdc.address,
      network: network.caip2,
      networkLabel: network.label,
      recipient: accept.payTo,
      scheme,
      x402Version: version,
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
    return { kind: "eip3009", requirements: offer.requirement as PaymentRequirements, x402Version, context };
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
      { ...(network && options.rpcUrlFor?.(network) ? { rpcUrl: options.rpcUrlFor(network) } : {}), fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
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
      },
      { ...(network && options.rpcUrlFor?.(network) ? { rpcUrl: options.rpcUrlFor(network) } : {}), fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs },
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
