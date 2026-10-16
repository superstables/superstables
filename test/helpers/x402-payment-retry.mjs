// Preload for a test: stands in for an x402 library whose payment-result hook asks for a fresh payment once.
import { x402HTTPClient } from "@x402/core/client";
const original = x402HTTPClient.prototype.processPaymentResult;
let once = false;
x402HTTPClient.prototype.processPaymentResult = async function (...args) {
  const result = await original.apply(this, args);
  if (once) return result;
  once = true;
  return { ...result, recovered: true };
};
