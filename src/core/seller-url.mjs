// The network boundary for a seller: where a payment request is read, or a credential or a payment is sent. https, or
// plain http on this computer only (127.0.0.1, localhost, [::1]); no user name or password in the URL. On plain http
// anyone on the way can rewrite the price and the recipient, and read the signed payment.

import { SETTINGS_COMMAND, loopbackSellersAllowed } from "./owner-settings.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Why `value` may not be called as a seller, in words, or undefined when it may. Callers prefix a subject (`--url`,
 * `the seller URL`, the name of an environment variable). 127.0.0.2 and the rest of 127/8 are not this computer's
 * own names here: only the three above are.
 * A seller on this computer is also refused for a payment on a chain that is not a testnet (`chain.testnet !== true`) unless
 * the owner allows it in their settings (sellers.allowLoopback); without `chain`, nothing more is checked.
 * @param {string} value
 * @param {{ testnet?: unknown }} [chain]
 * @returns {string | undefined}
 */
export function sellerUrlProblem(value, chain) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.username !== "" || url.password !== "") return "carries a user name or password";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "is not an https URL";
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    return "is plain http: only https is accepted, or http on this computer (127.0.0.1, localhost or [::1])";
  }
  if (LOOPBACK.has(url.hostname) && chain !== undefined && chain.testnet !== true && !loopbackSellersAllowed()) {
    return `is on this computer, and the chain is not a testnet: the owner allows that with ${SETTINGS_COMMAND} allow-loopback sellers on`;
  }
  return undefined;
}
