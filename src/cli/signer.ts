// Which signer asks the owner to approve a payment: chosen by --wallet, or SUPERSTABLES_WALLET.

import { approvePortFromEnvironment } from "../core/home.js";
import { BrowserWalletSigner } from "../core/signer/browser.js";
import type { Signer } from "../core/signer/types.js";
import { WalletSigner } from "../core/signer/wallet.js";
import type { WalletStatus } from "../core/types.js";

/** Which signer asks the owner. Browser by default: it needs no process of the owner's own. */
export type WalletMode = "browser" | "local";

export function walletModeFromEnvironment(): WalletMode {
  return process.env.SUPERSTABLES_WALLET === "local" ? "local" : "browser";
}

/**
 * The signer this machine is configured for. Neither of them holds a key: the browser signer
 * serves an approval page this process owns and waits for a browser wallet to sign; the local
 * one posts to the wallet process and waits for the owner there.
 */
export function signerFor(mode: WalletMode = walletModeFromEnvironment()): Signer & { status(): Promise<WalletStatus> } {
  if (mode === "local") return new WalletSigner();
  // A port the owner chose is kept as chosen; with none, the default, or a free port when
  // another payment is already waiting on the default.
  return new BrowserWalletSigner({ port: approvePortFromEnvironment() });
}
