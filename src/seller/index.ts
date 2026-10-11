// @superstables/client/seller: what a seller needs to accept Superstables referrals. Read the referral a paid request
// carries, verify it against the site's published keys, and report what happened to the purchase. Node built-ins only.

export {
  CLAIM_HEADER,
  DEFAULT_SITE,
  PURCHASE_REF_HEADER,
  REFERRAL_HEADER,
  REFERRAL_TYPE,
  checkReferral,
  clearReferralKeysCache,
  decodeReferral,
  fetchReferralKeys,
  isPurchaseRef,
  isReferralToken,
  readReferral,
  verifyReferral,
} from "./referral.js";
export type {
  CheckReferralOptions,
  HeaderSource,
  ReferralClaims,
  ReferralJwk,
  ReferralKeySet,
  ReferralRejection,
  ReferralVerification,
  VerifyReferralOptions,
} from "./referral.js";

export { ReferralReportError, createReferralReporter, idempotencyKey } from "./reporter.js";
export type {
  ReferralEvent,
  ReferralEventType,
  ReferralRefund,
  ReferralReporter,
  ReferralReporterOptions,
  ReferralSettlement,
  ReportAnswer,
  ReportedPurchase,
} from "./reporter.js";
