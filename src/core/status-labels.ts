// The words a person sees for a status. Code keeps its own values ("denied", "rejected", ...); a page that shows a
// status shows these. superstables.com uses the same labels for the same states, so a payment reads the same wherever
// the owner looks at it. Add a label here rather than in a page.

import type { WalletRequestStatus } from "./types.js";

/** The local wallet's requests (src/wallet). "rejected" is the wallet refusing a request it could not pay or sign. */
export const WALLET_STATUS_LABELS: Record<WalletRequestStatus, string> = {
  pending: "Waiting for approval",
  approved: "Signing",
  signed: "Signed",
  denied: "Rejected by you",
  expired: "Expired",
  rejected: "Refused by the wallet",
};
