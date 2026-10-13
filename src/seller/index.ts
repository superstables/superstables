// @superstables/client/seller: what a seller needs to accept Superstables referrals. Read the referral a paid request
// carries and verify it against the site's published keys. Node built-ins only.

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
