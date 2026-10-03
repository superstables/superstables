// The signing seam. The payment code never sees a key: it builds a SignRequest from the
// seller's requirement and hands it to a Signer. Two signers exist:
//   BrowserWalletSigner the default. Holds no key. Serves one approval page on loopback and
//                 waits for the owner to sign in their browser wallet (MetaMask or similar).
//   WalletSigner  the agent side of the local wallet process. Holds no key. Posts the request
//                 to that wallet and waits for the owner's decision there.
//   LocalKeySigner the local wallet's own signer, and the one tests use. Never used by an agent.

import type { PaymentRequirements } from "@x402/core/types";
import type { PaymentContext } from "../types.js";

export interface SignRequest {
  /** x402 exact on EVM: an EIP-3009 TransferWithAuthorization over the asset's EIP-712 domain. */
  kind: "eip3009";
  /** The seller's requirement verbatim. The wallet derives everything it shows from this. */
  requirements: PaymentRequirements;
  /** Which x402 wire version the requirement is in. */
  x402Version: 1 | 2;
  /** What the agent says this is for. Displayed as unverified context; never trusted for the terms. */
  context?: PaymentContext;
}

export interface SignResult {
  kind: "eip3009";
  payload: { signature: string; authorization: Record<string, unknown> };
  /** The address that signed. */
  signer: string;
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

export type RefusalCode =
  | "denied"
  | "expired"
  | "abandoned"
  | "policy"
  | "invalid"
  | "unavailable"
  | "approval_page";

/** The signer would not sign: the owner said no, the request expired, the process serving it stopped before anyone decided, the wallet's policy refused, the request was malformed, the wallet is unreachable, or the approval page could not start. */
export class SignRefused extends Error {
  constructor(readonly code: RefusalCode, reason: string, readonly walletRequestId?: string) {
    super(reason);
    this.name = "SignRefused";
  }
}
