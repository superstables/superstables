// The shared vocabulary of the client: what discovery returns, what a quote is, how a
// payment attempt moves through its states, and what a receipt records. Every surface
// (the package exports, the CLI, the wallet) speaks these types; nothing below
// imports from the surfaces.

import type { SettleResponse } from "@x402/core/types";
import type { RailRequirement } from "./rails/types.js";
import type { ChainState } from "./settlement.js";

// ── Discovery ────────────────────────────────────────────────────────────────────────────

export interface ServiceParam {
  name: string;
  in: "query";
  required: boolean;
  description?: string;
  example?: string;
  /** Allowed values, when the service documents a closed set. */
  enum?: string[];
}

export interface ServicePayment {
  rail: "x402" | "mpp";
  scheme: "exact" | "charge";
  /** CAIP-2, e.g. eip155:84532. */
  network: string;
  networkLabel: string;
  asset: string;
  /** Known up front when the listing carries it; the quote is authoritative. */
  price?: { amountDecimal: number; asset: string; display: string };
}

export interface ServiceListing {
  id: string;
  name: string;
  description: string;
  /** The URL to call, without query parameters. */
  endpoint: string;
  method: "GET";
  params: ServiceParam[];
  payment: ServicePayment;
  /** Who runs it, when known. The demo service says so explicitly. */
  operator?: string;
  source: "demo-catalogue" | "superstables-index";
  live?: boolean;
  lastSeenLive?: string;
  testnet: boolean;
  /** True when this client can quote and pay the service as listed. */
  actionable: boolean;
  notActionableReason?: string;
  /** True when the listing marks its output as prepared sample data (most hosted catalogue services); false when it marks it as not sample data. */
  mock?: boolean;
  /** Prompts the seller suggests, when it publishes any. */
  examplePrompts?: string[];
  /** Payment protocols the listing accepts, as its source names them (e.g. ["x402"]). */
  rails?: string[];
  /**
   * Chains the listing accepts, as its source names them (e.g. ["base-sepolia", "solana"]).
   * The names are the source's own: in the public index "base" and "solana" are mainnets.
   */
  chains?: string[];
  /** Which way this client could pay the listing, judged from its rails and chains alone. */
  routes?: PayRoutes;
}

/** A `superstables budget` rail and the chain it would pay on. */
export interface BudgetRoute {
  rail: "evm" | "tempo" | "solana";
  chain: string;
}

/**
 * How a listing could be paid by this client, judged from its rails and chains only. A seller
 * still has to answer with a challenge the payer accepts, and `pay` also needs the request
 * parameters, so `pay: true` means "on the network `pay` supports", not "callable as listed"
 * (that is `actionable`).
 */
export interface PayRoutes {
  /** `superstables pay`: on a chain `pay` supports (x402 on the EVM testnets and Solana devnet, MPP on Tempo Moderato); the owner approves each payment. */
  pay: boolean;
  /** `superstables budget` rails with a chain this listing accepts. Testnets only. */
  budget: BudgetRoute[];
}

export interface ResolvedRequest {
  serviceId?: string;
  method: "GET";
  /** The exact URL that will be quoted and paid, query string included. */
  url: string;
  params: Record<string, string>;
}

// ── Quote ────────────────────────────────────────────────────────────────────────────────

/** The facts of a payment, derived from the seller's requirement — what the owner is shown. */
export interface PaymentTerms {
  amountDecimal: number;
  amountAtomic: string;
  asset: string;
  assetAddress: string;
  network: string;
  networkLabel: string;
  recipient: string;
  /** "exact" for x402, "charge" for MPP. */
  scheme: string;
  /** The x402 wire version. Absent for MPP, which has none. */
  x402Version?: 1 | 2;
}

/** One rule of the spend policy, as it applied to one payment. */
export interface PolicyCheck {
  /** The policy file's name for the rule: kill_switch, deny, allow, stablecoins, caps.per_call, caps.per_day. */
  rule: string;
  ok: boolean;
  /** What was checked against what, in words: "0.01 USDC, at most 0.05 USDC". */
  detail: string;
}

export type QuoteStatus = "open" | "used" | "stale" | "expired";

export interface Quote {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: QuoteStatus;
  url: string;
  serviceId?: string;
  serviceName?: string;
  /** The seller's own description of the resource, from the challenge. */
  description?: string;
  request?: ResolvedRequest;
  terms: PaymentTerms;
  /** The seller's requirement verbatim (an x402 accept, or an MPP challenge): what the wallet will be asked to act on. */
  requirement: RailRequirement;
  /** The local (software) policy's verdict. The wallet applies the owner's policy again. */
  policy: { allowed: boolean; reason?: string; checks?: PolicyCheck[] };
  /** Who decides: always the owner's wallet in this release. */
  approval: "wallet";
}

// ── Attempt ──────────────────────────────────────────────────────────────────────────────

export type AttemptState =
  | "awaiting_approval"
  | "denied"
  | "expired"
  | "approved"
  | "submitting"
  | "settled"
  | "paid_service_failed"
  | "failed"
  | "uncertain"
  /** Nobody decided: whoever was waiting for the owner stopped first. Nothing was submitted. */
  | "abandoned";

/** States an attempt never leaves. */
export const FINAL_ATTEMPT_STATES: readonly AttemptState[] = [
  "denied", "expired", "abandoned", "settled", "paid_service_failed", "failed", "uncertain",
];

export interface AttemptTransition {
  at: string;
  state: AttemptState;
  note?: string;
}

/** What ended an `abandoned` attempt. Never the owner: the owner's "no" is `denied`. */
export type AbandonCause = "stopped" | "wait" | "page_closed";

export interface Attempt {
  id: string;
  quoteId: string;
  createdAt: string;
  updatedAt: string;
  state: AttemptState;
  url: string;
  serviceId?: string;
  serviceName?: string;
  terms: PaymentTerms;
  /** The wallet's request id, once the wallet has been asked. */
  walletRequestId?: string;
  /** Where the owner approves this payment, when the signer serves a page for it. */
  approvalUrl?: string;
  /** Why it stopped: the wallet's reason, the seller's error, or the network failure. */
  reason?: string;
  /**
   * Why nothing was signed or sent, when a check refused before the owner decided: "policy" for a
   * spend policy (this client's or the wallet's), "invalid" for a request the signer would not
   * take, "unavailable" for a local wallet that did not answer, "approval_page" for an approval page
   * that could not start, "cap_check" for a daily cap that could not be checked, "chain" for a chain
   * read the payment needed before the owner's wallet was asked to send (Tempo). After
   * "unavailable", "approval_page" and "cap_check" the owner was never asked, so the quote can still
   * be paid; after "chain" the owner was asked, and nothing was sent.
   */
  refusal?: "policy" | "invalid" | "unavailable" | "approval_page" | "cap_check" | "chain";
  /**
   * For an `abandoned` attempt, what ended the wait: "stopped" when the process running it was
   * stopped (Ctrl-C, a signal from another program, or the process exiting), "wait" when its
   * --wait ran out, "page_closed" when the approval page closed under it. None is the owner.
   */
  abandonedBy?: AbandonCause;
  payer?: string;
  transaction?: string;
  transactionUrl?: string;
  serviceStatus?: number;
  /** The service's response body, capped, once there is one. */
  serviceBody?: string;
  /** The service's own reason a payment did not settle, as it gave it: the seller's words, never the client's. */
  serviceReason?: string;
  /**
   * When this attempt reserved its amount against the daily cap, before the owner was asked (pay.ts, reserve). While
   * the attempt waits for the owner the reservation counts toward the cap; once signed, the signed states count it;
   * an attempt that ends unsigned releases it.
   */
  reservedAt?: string;
  /** Until when that reservation counts if the attempt is still waiting then: the signer's approval window, and a minute. */
  reservedUntil?: string;
  /**
   * The EIP-3009 validBefore the owner signed, as an ISO time: after it the authorization can no longer be settled, so
   * any money this payment could move has moved by then (the daily cap reads it).
   */
  authorizationValidBefore?: string;
  /** The EIP-3009 nonce the owner signed: what ties a transaction on chain to this payment. */
  authorizationNonce?: string;
  /** Tempo: the memo the owner's transfer carries, bound to the seller's challenge: what finds it on chain. */
  paymentMemo?: string;
  /** Solana: the owner's signature over the transaction that was built (base58): what finds it on chain. */
  ownerSignature?: string;
  /** Solana: the last block height the transaction's blockhash is good for. After it, it can no longer land. */
  lastValidBlockHeight?: number;
  /** Tempo: the chain's head block when the owner's wallet was asked to send. The owner's transfer is in a later block. */
  searchFromBlock?: string;
  /** Solana: the slot devnet had reached when the transaction was built. It can only land in a later slot. */
  searchFromSlot?: number;
  /**
   * Solana: how far `superstables status` has read the blocks the transaction could have landed in, once its blockhash
   * expired: every block up to this slot was read whole, and none holds this payment. The next status reads on from the
   * block after it.
   */
  searchedToSlot?: number;
  /**
   * The process running this attempt (its pid, and that process's start identity where the system gives one): while it
   * runs, it carries the attempt on; once it is gone, an attempt it left approved or submitting is for
   * `superstables status` to reconcile from the chain.
   */
  runner?: { pid: number; start: string | null };
  /**
   * What the chain says about the payment: "verified" (the transaction is this payment), "mismatch" (the transaction the
   * seller named is not; the attempt is then uncertain), "unchecked" (the chain could not say yet), or "unpaid" (a later
   * check found the payment was never made and can no longer be; the attempt is then failed).
   */
  chain?: ChainState;
  /** Why, for mismatch and unchecked. */
  chainReason?: string;
  receiptId?: string;
  history: AttemptTransition[];
}

// ── Receipt ──────────────────────────────────────────────────────────────────────────────

export type ServiceOutcome = "ok" | "failed" | "unknown";

export interface Receipt {
  /** Same as the attempt id. */
  id: string;
  at: string;
  quoteId: string;
  attemptId: string;
  url: string;
  serviceId?: string;
  serviceName?: string;
  terms: PaymentTerms;
  payer: string;
  transaction: string;
  transactionKind: "hash" | "pending";
  transactionUrl: string;
  network: string;
  /** What the facilitator reported, verbatim minus nothing: success, payer, transaction, network. */
  settlement: Pick<SettleResponse, "success" | "payer" | "transaction" | "network" | "errorReason">;
  /** What the chain says about the settlement: see Attempt.chain. Absent on receipts written before it was read. */
  chain?: ChainState;
  chainReason?: string;
  /** Payment success and service success are two different facts. */
  serviceOutcome: ServiceOutcome;
  serviceStatus?: number;
  serviceBodyPreview?: string;
  ms: number;
}

// ── Wallet wire types (daemon ⇄ client) ──────────────────────────────────────────────────

/** What the agent says the payment is for. Displayed to the owner as unverified context. */
export interface PaymentContext {
  target: string;
  serviceId?: string;
  serviceName?: string;
  description?: string;
  quoteId?: string;
  attemptId?: string;
}

export type WalletRequestStatus = "pending" | "approved" | "signed" | "denied" | "expired" | "rejected";

/** The facts the wallet derived from the requirement it will sign. Never agent-supplied. */
export interface VerifiedTerms extends PaymentTerms {
  payer: string;
}

export interface WalletRequestView {
  id: string;
  status: WalletRequestStatus;
  createdAt: number;
  expiresAt: number;
  verified: VerifiedTerms;
  reported?: PaymentContext;
  reason?: string;
  /** Present only once signed; returned to the agent-token caller that created the request. The local wallet signs EIP-3009 only. */
  result?: { kind: "eip3009"; payload: { signature: string; authorization: Record<string, unknown> }; signer: string };
}

export interface WalletStatus {
  /** Which signer answered: the local wallet process, or a browser wallet on the approval page. */
  mode?: "local" | "browser";
  /** Who pays. A browser wallet has no address until someone has connected one. */
  address?: string;
  network: string;
  networkLabel: string;
  asset: string;
  /** USDC balance on the wallet's network, when the RPC answered. */
  balanceDecimal?: number;
  approvalMode: "ask-every-payment";
  pending: number;
  policy: { perCall?: string; perDay?: string; allow: string[]; deny: string[]; stablecoins: string[]; killSwitch: boolean };
}
