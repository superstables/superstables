// The package surface. Everything an SDK user needs to discover a paid service, quote it,
// pay it from the owner's wallet and read the receipt — and nothing more.
//
// LocalKeySigner is deliberately absent. It holds a private key in memory, and the only
// legitimate users of one are the wallet process itself and tests; both import it directly
// from "./core/signer/local.js". Keeping it off the package root means no agent reaches for
// it by accident.

// ── The vocabulary ─────────────────────────────────────────────────────────────────────
export type {
  AbandonCause,
  Attempt,
  AttemptState,
  AttemptTransition,
  PaymentContext,
  PaymentTerms,
  Quote,
  QuoteStatus,
  Receipt,
  ResolvedRequest,
  ServiceListing,
  ServiceOutcome,
  ServiceParam,
  ServicePayment,
  VerifiedTerms,
  WalletRequestStatus,
  WalletRequestView,
  WalletStatus,
} from "./core/types.js";
export { FINAL_ATTEMPT_STATES } from "./core/types.js";

// ── Chain and protocol ─────────────────────────────────────────────────────────────────
export {
  ARBITRUM_SEPOLIA,
  ARC_TESTNET,
  BASE_SEPOLIA,
  DEFAULT_NETWORK,
  ETHEREUM_SEPOLIA,
  EVM_NETWORKS,
  KNOWN_NETWORKS,
  POLYGON_AMOY,
  SKALE_BASE_SEPOLIA,
  SOLANA_DEVNET,
  TEMPO_MODERATO,
  addressUrl,
  describeNetwork,
  fromAtomic,
  isAddress,
  isSameAddress,
  networkFor,
  toAtomic,
  toCaip2,
  txUrl,
  usdcBalance,
  usdcRequirement,
} from "./core/chain.js";
export type { EvmNetwork, NetworkInfo, Rail, SolanaNetwork, TempoNetwork } from "./core/chain.js";
export { SUPPORTED_NETWORKS } from "./core/rails/index.js";

export { NotPaidEndpointError, detect, parseChallenge, sameTerms, termsFor } from "./core/x402.js";
export type { Challenge, RawAccept, Supported, Unsupported } from "./core/x402.js";

// ── Policy ─────────────────────────────────────────────────────────────────────────────
export {
  DEFAULT_POLICY,
  POLICY_EXAMPLE,
  evaluatePolicy,
  formatMoney,
  loadPolicy,
  parseMoney,
  parsePolicy,
  round6,
} from "./core/policy.js";
// The policy engine's own input type. Named for what it is here, so it cannot be mistaken
// for the payment Attempt above.
export type { Attempt as PolicyAttempt, Money, Policy, Verdict } from "./core/policy.js";

// ── Records, discovery, facilitators ───────────────────────────────────────────────────
export { Records } from "./core/records.js";

export { DEMO_SERVICE_ID, HOSTED_DEMO_SERVICE_URL, HOSTED_CATALOGUE_URL, INDEX_URL, DEFAULT_INDEX_URL, indexUrl, demoService, externalCoinPriceService, catalogue, allListings, fetchHostedCatalogue, hostedCatalogueUrl, clearHostedCatalogueCache, demoServicesEnabled, EXTERNAL_COIN_PRICE_ID, findServices, getService, resolveRequest } from "./core/discovery.js";
export type { DiscoveryResult, FindServicesOptions } from "./core/discovery.js";

export { FACILITATORS, FACILITATOR_TIMEOUT_MS, facilitatorClient, firstThatWorks, settleWith, verifyWith } from "./core/facilitator.js";
export type { Via } from "./core/facilitator.js";

// ── Quoting and paying ─────────────────────────────────────────────────────────────────
export { QUOTE_TTL_MS, getQuote, quote } from "./core/quote.js";
export type { QuoteDeps, QuoteInput } from "./core/quote.js";

export { PaymentEngine, SERVICE_BODY_LIMIT } from "./core/pay.js";
export type { PaymentEngineOptions } from "./core/pay.js";

// ── Signing ────────────────────────────────────────────────────────────────────────────
export { SignRefused } from "./core/signer/types.js";
export type { RefusalCode, SignHooks, SignRequest, SignResult, Signer } from "./core/signer/types.js";
export { WalletSigner, isWalletUp, walletStatus } from "./core/signer/wallet.js";
export type { WalletSignerOptions } from "./core/signer/wallet.js";
export { BrowserWalletSigner } from "./core/signer/browser.js";
export type { BrowserWalletSignerOptions } from "./core/signer/browser.js";
export { ApprovalPortBusy, ApprovalServer } from "./core/signer/approval-server.js";
export type {
  ApprovalHandle,
  ApprovalOutcome,
  ApprovalRequestInput,
  ApprovalServerOptions,
  ApprovalStatus,
  ApprovalTypedData,
} from "./core/signer/approval-server.js";

// ── Where state lives ──────────────────────────────────────────────────────────────────
export {
  DEFAULT_APPROVE_PORT,
  DEFAULT_DEMO_SERVICE_PORT,
  DEFAULT_WALLET_PORT,
  agentTokenPath,
  approvalsPath,
  approvePortFromEnvironment,
  browserWalletPath,
  ensureDir,
  homeDir,
  policyPath,
  recordsDir,
  walletDir,
  walletUrl,
} from "./core/home.js";
