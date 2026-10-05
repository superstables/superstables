// The signing seam. The payment code never sees a key: it builds a SignRequest from the
// seller's requirement and hands it to a Signer. Two signers exist:
//   BrowserWalletSigner the default. Holds no key. Serves one approval page on loopback and
//                 waits for the owner to sign in their browser wallet (MetaMask or similar).
//   WalletSigner  the agent side of the local wallet process. Holds no key. Posts the request
//                 to that wallet and waits for the owner's decision there.
//   LocalKeySigner the local wallet's own signer, and the one tests use. Never used by an agent.
//
// What the owner's wallet is asked to do depends on the rail (src/core/rails/):
//   eip3009             x402 exact on an EVM chain: sign one EIP-3009 TransferWithAuthorization (EIP-712).
//   tempo-transfer      MPP tempo.charge on Tempo Moderato: send one pathUSD transferWithMemo, with the memo bound to
//                       the seller's challenge. The wallet moves the money itself.
//   solana-transaction  x402 exact on Solana devnet: partially sign one token transfer whose fee payer is the seller's
//                       facilitator, which completes and sends it.

import type { PaymentRequirements } from "@x402/core/types";
import type { MppChallenge } from "../mpp.js";
import type { PaymentContext } from "../types.js";

/** x402 exact on EVM: an EIP-3009 TransferWithAuthorization over the asset's EIP-712 domain. */
export interface Eip3009SignRequest {
  kind: "eip3009";
  /** The seller's requirement verbatim. The wallet derives everything it shows from this. */
  requirements: PaymentRequirements;
  /** Which x402 wire version the requirement is in. */
  x402Version: 1 | 2;
  /** What the agent says this is for. Displayed as unverified context; never trusted for the terms. */
  context?: PaymentContext;
}

/** MPP tempo.charge on Tempo Moderato, push mode: the owner's wallet sends the transfer. */
export interface TempoSignRequest {
  kind: "tempo-transfer";
  /** The seller's challenge as it was received. The wallet derives everything it shows from this. */
  challenge: MppChallenge;
  context?: PaymentContext;
}

/** x402 exact on Solana: a transfer the owner's Solana wallet signs and the seller's fee payer completes. */
export interface SolanaSignRequest {
  kind: "solana-transaction";
  /** The seller's requirement verbatim. */
  requirements: PaymentRequirements;
  x402Version: 2;
  context?: PaymentContext;
}

export type SignRequest = Eip3009SignRequest | TempoSignRequest | SolanaSignRequest;
export type SignKind = SignRequest["kind"];

export interface Eip3009SignResult {
  kind: "eip3009";
  payload: { signature: string; authorization: Record<string, unknown> };
  /** The address that signed. */
  signer: string;
}

export interface TempoSignResult {
  kind: "tempo-transfer";
  /** The transaction the owner's wallet sent. */
  hash: string;
  /** The memo the transfer carries: bound to the seller's challenge, and what finds the payment on chain. */
  memo: string;
  /** The account that sent it. */
  signer: string;
}

export interface SolanaSignResult {
  kind: "solana-transaction";
  /** The whole transaction, base64, with the owner's signature and the fee payer's slot left empty. */
  transaction: string;
  /** The owner's signature, base58: what finds the payment on chain. */
  signature: string;
  /** The last block height the transaction's blockhash is good for: after it, it can no longer land. */
  lastValidBlockHeight?: number;
  /** The slot devnet had reached when the transaction was built: it can only land in a later one. */
  searchFromSlot?: number;
  /** The owner's address, base58. */
  signer: string;
}

export type SignResult = Eip3009SignResult | TempoSignResult | SolanaSignResult;

/** What the owner's wallet is about to be asked to send: from now on money may move without a reply reaching here. */
export interface WalletSendIntent {
  /** The account that will send. */
  payer: string;
  /** Tempo: the memo the transfer carries, which finds it on chain. */
  memo?: string;
}

export interface SignHooks {
  /**
   * Called right before the owner is asked (the approval page or wallet request is created). It may throw SignRefused
   * ("policy") to stop: then nobody is asked. The payment engine renews its cap reservation here when it has expired.
   */
  beforeAsk?: () => Promise<void>;
  /**
   * Called once the request has been accepted and is waiting for the owner. `approvalUrl` is
   * present when the owner approves on a page this process serves, and must be shown to them.
   */
  onPending?: (walletRequestId: string, approvalUrl?: string) => void;
  /**
   * Called before the owner's wallet is asked to send a payment itself (Tempo), and awaited: the payment engine records
   * that money may move from here on, under its cap check. It may throw SignRefused ("policy") to stop: then the wallet
   * is not asked. Rails whose wallet only signs (EIP-3009, Solana) never call it: nothing moves until the engine sends.
   */
  beforeWalletSends?: (intent: WalletSendIntent) => Promise<void>;
}

export interface Signer {
  readonly kind: "wallet" | "local" | "browser";
  /**
   * The longest this signer waits for the owner before it gives up unsigned. A payment reserves its amount against the
   * daily cap for this long at most (pay.ts); unset, ten minutes.
   */
  readonly approvalWindowMs?: number;
  /** The payer address on a network (CAIP-2). Throws when there is no identity there. */
  address(network: string): Promise<string>;
  /** Sign, or refuse. A refusal throws SignRefused; nothing was signed. */
  sign(req: SignRequest, hooks?: SignHooks): Promise<SignResult>;
}

/**
 * What the local wallet says about a payment it cannot sign, and where the owner approves it instead. The flag is named:
 * leaving --wallet local out is not enough when SUPERSTABLES_WALLET=local is set. The quote the refusal ended is used.
 */
export const LOCAL_WALLET_EVM_ONLY =
  "the local wallet signs x402 payments on EVM chains only; to pay on Tempo Moderato or Solana devnet, take a new quote and pay it in a browser wallet on your machine: `superstables --wallet browser pay <new-quote-id>`";

export type RefusalCode =
  | "denied"
  | "expired"
  | "abandoned"
  | "policy"
  | "invalid"
  | "unavailable"
  | "approval_page"
  /** A chain read the payment needs before the owner's wallet is asked to send failed: the wallet was not asked. */
  | "chain"
  /** The owner's wallet was asked to send the payment and no answer came back: it may have been sent. */
  | "unknown";

/** The signer would not sign: the owner said no, the request expired, the process serving it stopped before anyone decided, the wallet's policy refused, the request was malformed, the wallet is unreachable, or the approval page could not start. "unknown" is the one refusal after which money may have moved: the owner's wallet was asked to send and did not answer. */
export class SignRefused extends Error {
  constructor(readonly code: RefusalCode, reason: string, readonly walletRequestId?: string) {
    super(reason);
    this.name = "SignRefused";
  }
}
