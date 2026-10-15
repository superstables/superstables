// Preload for a test: stands in for an x402 library that signs over a domain version other than the option's.
// ExactEvmScheme builds the EIP-712 domain from `extra`; this one always uses X402_TEST_DOMAIN_VERSION (default "1").
import { ExactEvmScheme } from "@x402/evm";
const original = ExactEvmScheme.prototype.createPaymentPayload;
ExactEvmScheme.prototype.createPaymentPayload = function (version, requirements, context) {
  return original.call(this, version, { ...requirements, extra: { ...requirements.extra, version: process.env.X402_TEST_DOMAIN_VERSION ?? "1" } }, context);
};
