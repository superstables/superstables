// What a rail is. `pay` knows three: x402 exact on EVM chains (rails/evm.ts), MPP tempo.charge on Tempo Moderato
// (rails/tempo.ts) and x402 exact on Solana devnet (rails/solana.ts). Each is one adapter implementing the interface
// below, registered with one line in rails/index.ts; the payment engine (pay.ts), the browser signer and the approval
// page ask the adapter for everything that differs between them, and keep everything that does not (the quote, the
// cap reservation, the attempt's states, the receipt) to themselves.
//
// Two flows exist, and they differ in when money moves:
//
//   x402   the owner's wallet only signs. The engine sends the credential to the seller, whose facilitator settles it
//          and names a transaction; the chain is then read to check that transaction is this payment.
//   push   the owner's wallet sends the payment itself (Tempo). Money may move before any reply reaches the engine, so
//          the engine records that the wallet was asked before it is asked, reads the chain for the owner's own
//          transaction, and only then calls the seller with a credential naming it.

import type { PaymentRequirements } from "@x402/core/types";
import type { NetworkInfo, Rail } from "../chain.js";
import type { MppChallenge } from "../mpp.js";
import type { ChainCheck } from "../settlement.js";
import type { SignKind, SignRequest, SignResult } from "../signer/types.js";
import type { Attempt, PaymentContext, PaymentTerms } from "../types.js";
import type { Challenge, RawAccept } from "../x402.js";

/** The seller's requirement as this client acts on it: an x402 accept object, or an MPP challenge. */
export type RailRequirement = PaymentRequirements | MppChallenge;

/** One way to pay that a seller offered, judged payable: the facts the owner is shown, and what the wallet acts on. */
export interface Offer {
  rail: Rail;
  terms: PaymentTerms;
  requirement: RailRequirement;
}

export type Judged = { supported: true; offer: Offer } | { supported: false; reason: string };

/** Where a rail reads its chain: tests point a network at a fake one; otherwise chainRpc (src/core/rpc.ts). */
export interface ChainReadOptions {
  rpcUrlFor?: (network: NetworkInfo) => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * How long one search may spend reading the blocks a Solana payment could have landed in (45 seconds when not given):
   * what it has read whole is kept, and the next search reads the rest.
   */
  searchMs?: number;
}

/** Everything the chain is asked about one payment: from the attempt, never from the seller's report. */
export interface PaymentFacts {
  network: string;
  payer: string;
  recipient: string;
  amountAtomic: string;
  /** The transaction to read: the one the seller named (x402) or the owner's wallet sent (push). */
  transaction?: string;
  /** EVM x402: the EIP-3009 nonce the owner signed. */
  nonce?: string;
  /** Tempo: the memo bound to the seller's challenge. */
  memo?: string;
  /** Solana: the owner's signature over the transaction that was built. */
  ownerSignature?: string;
  /** Solana: after this block height the transaction can no longer land. */
  lastValidBlockHeight?: number;
  /** EVM x402: the signed validBefore (ISO): from the chain's time past it, an unused authorization can never be used. */
  validBefore?: string;
  /**
   * When the payment could first have happened: a search looks no earlier. x402: when the attempt began, before anything
   * was signed. Tempo: when the owner's wallet was asked to send.
   */
  since?: string;
  /** Tempo: the chain's head block when the wallet was asked to send. The owner's transfer is in a later block. */
  searchFromBlock?: string;
  /** Solana: the slot devnet had reached when the transaction was built. It lands in a later slot, if it lands. */
  searchFromSlot?: number;
  /** Solana: an earlier search read the blocks the payment could have landed in up to this slot, none holding it. */
  searchedToSlot?: number;
  /** Transactions already recorded as the payment of another attempt: never this one's, whatever they show. */
  attributed?: readonly string[];
}

/**
 * A search for a payment nobody reported (or that a seller reported without a transaction the chain confirms): found
 * (and verified); not found, and `never` when the chain shows it can no longer happen either (an EVM authorization
 * unused past its validBefore, a Solana blockhash expired with no transaction carrying the owner's signature);
 * otherwise not found yet, or the chain could not say (`unreadable`). A Solana search that read only part of the blocks
 * the payment could have landed in says how far it got (`searchedToSlot`), for the next search to read on from.
 */
export type FoundPayment =
  | { found: true; transaction: string; final?: false }
  | { found: false; reason: string; unreadable?: boolean; never?: boolean; searchedToSlot?: number };

/** What a signed result records on the attempt before anything leaves this machine. */
export type SignedFacts = Pick<Attempt, "authorizationNonce" | "authorizationValidBefore" | "paymentMemo" | "ownerSignature" | "lastValidBlockHeight" | "searchFromSlot">;

interface RailCommon {
  readonly rail: Rail;
  /** The SignRequest kind this rail's wallet step answers. */
  readonly signKind: SignKind;
  /** The chains this rail pays on. */
  readonly networks: readonly NetworkInfo[];
  /** The owner's wallet request for an offer of this rail. */
  signRequest(offer: Offer, x402Version: 1 | 2, context: PaymentContext): SignRequest;
  /** What a signed result records on the attempt, before anything leaves this machine. */
  signedFacts(signed: SignResult): SignedFacts;
  /** A transaction id in this rail's shape (a 0x hash, a base58 signature): the only shape one is repeated in. */
  isTransaction(value: unknown): value is string;
  /** Read the chain for this payment's transaction and say whether it is this payment. Never throws. */
  checkPayment(facts: PaymentFacts, options: ChainReadOptions): Promise<ChainCheck>;
  /** Look for a payment whose transaction nobody reported (an uncertain attempt), when the rail can. Never throws. */
  findPayment?(facts: PaymentFacts, options: ChainReadOptions): Promise<FoundPayment>;
}

export interface X402Rail extends RailCommon {
  readonly flow: "x402";
  /** Judge one x402 accept on a chain of this rail: terms derived from it alone, or the reason it cannot be paid. */
  judgeAccept(accept: RawAccept, version: 1 | 2, network: NetworkInfo): Judged;
  /** The headers that carry the signed credential to the seller. */
  credentialHeaders(offer: Offer, signed: SignResult, challenge: Challenge): Record<string, string>;
}

export interface PushRail extends RailCommon {
  readonly flow: "push";
  /**
   * The chain's head block, read right before the owner's wallet is asked to send: the owner's transfer can only be in a
   * later block, so a search for it starts after this one and an older transfer with the same memo is never taken for it.
   */
  headBlock(options: ChainReadOptions): Promise<string>;
  /** Judge one MPP challenge: terms derived from it alone, or the reason it cannot be paid. */
  judgeChallenge(challenge: MppChallenge, now?: number): Judged;
  /** The headers that carry the credential naming the owner's transaction to the seller. */
  credentialHeaders(offer: Offer, signed: SignResult): Record<string, string>;
  /** The memo the owner's transfer for this offer carries: what finds it on chain, decided by the seller's challenge. */
  paymentMemo(offer: Offer): string;
  /** How long to wait for the owner's transaction to show on chain before the seller is called. */
  readonly confirmWaitMs: number;
}

export type RailAdapter = X402Rail | PushRail;
