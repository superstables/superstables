// Which signer asks the owner to approve a payment: chosen by --wallet, or SUPERSTABLES_WALLET.

import { DEFAULT_APPROVE_PORT, approvePort, approvePortFromEnvironment } from "../core/home.js";
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
  // A port the owner chose is kept as chosen; with none, the port this home uses, or a free port when another payment is
  // already waiting on it.
  const port = approvePortFromEnvironment();
  return new BrowserWalletSigner({ port, preferredPort: port === undefined ? homeApprovePort() : undefined });
}

/** This home's approval port; DEFAULT_APPROVE_PORT, with a note on stderr, when its file cannot be used. */
function homeApprovePort(): number {
  try {
    return approvePort();
  } catch (err) {
    console.error(`note: the approval page's port could not be kept for this home (${(err as Error).message}); using ${DEFAULT_APPROVE_PORT}`);
    return DEFAULT_APPROVE_PORT;
  }
}
