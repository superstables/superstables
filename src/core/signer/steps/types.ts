// A wallet step: what the approval page asks the owner's wallet to do for one rail, and how the approval server checks
// the answer. The server (../approval-server.ts) keeps everything the rails share: the link, the Host and Origin
// checks, expiry, the audit log, rejection. A step adds its own routes after /approve/<id> and, when the main page
// script's EVM path is not what its wallet does, a script of its own (../approval-page.ts runs it first).
//
//   eip3009             ./eip3009.ts  /account then /signature: the wallet signs typed data the server built
//   tempo-transfer      ./tempo.ts    /account, /sending, /sent: the wallet sends a call the server built
//   solana-transaction  ./solana.ts   the wallet signs a transaction the server built

import type { NetworkInfo } from "../../chain.js";
import type { RailRequirement } from "../../rails/types.js";
import type { VerifiedTerms } from "../../types.js";
import type { SignKind, SignResult, WalletSendIntent } from "../types.js";

/** One pending approval, as a step sees it. */
export interface StepRecord {
  id: string;
  kind: SignKind;
  network: NetworkInfo;
  verified: VerifiedTerms;
  /** The seller's requirement as it was judged: what the wallet's request is built from. */
  requirement: RailRequirement;
  x402Version: 1 | 2;
  expiresAt: number;
  /** The account the page connected, once it has. */
  account?: string;
  /** What the step prepared for that account: typed data, a call, a transaction. */
  prepared?: unknown;
  /** Push: the wallet was asked to send. From then on only a hash, or the owner's "no" in the wallet, ends it as known. */
  walletAsked?: boolean;
}

/** A step's answer to one POST: the JSON for the page, and the signed result when this answer finishes the approval. */
export interface StepAnswer {
  http: number;
  body: Record<string, unknown>;
  signed?: SignResult;
}

export interface StepContext {
  /** Push: the payment engine's go-ahead, awaited before the wallet is asked to send. Throws SignRefused to stop. */
  beforeWalletSends(intent: WalletSendIntent): Promise<void>;
}

/** What a step adds to the page's facts: the chain the wallet is switched to, and how the page words the wallet step. */
export interface StepPageFacts {
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Solana: the Wallet Standard chain. */
  walletChain?: string;
}

export interface WalletStep {
  readonly kind: SignKind;
  /** The POST routes after /approve/<id> this step answers, besides /reject. */
  readonly routes: readonly string[];
  /** The account address this step takes from the page, normalised, or undefined when it is not one. */
  account(value: unknown): string | undefined;
  /** POST /account: prepare what the wallet will be asked for, for this account. Sets record.prepared. */
  prepare(record: StepRecord, account: string): Promise<StepAnswer>;
  /** Any other POST route of this step. */
  answer(record: StepRecord, leaf: string, body: Record<string, unknown>, context: StepContext): Promise<StepAnswer>;
  /** True when an approval that ends unanswered may have moved money (the wallet was asked to send). */
  mayHaveSent?(record: StepRecord): boolean;
  /**
   * The latest time (ms) the owner may still approve, when the requirement itself sets one sooner than the approval
   * window (a seller's challenge that expires): the approval ends then.
   */
  deadline?(record: StepRecord): number | undefined;
  /** The chain facts the page needs. */
  pageFacts(record: StepRecord): StepPageFacts;
  /** How the page words this step: the lede, the button's prompt, the small print. Literal strings only. */
  readonly words: { lede: string; fineprint: (facts: { amountAtomic: string; amountDecimal: number; asset: string }) => string };
  /** The step's own page script, run before the main one, or "" when the main script's EVM path does it. */
  readonly script: string;
}
