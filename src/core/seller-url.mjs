// The network boundary for a seller: where a payment request is read, or a credential or a payment is sent. https, or
// plain http on this computer only (127.0.0.1, localhost, [::1]); no user name or password in the URL. On plain http
// anyone on the way can rewrite the price and the recipient, and read the signed payment.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Why `value` may not be called as a seller, in words, or undefined when it may. Callers prefix a subject (`--url`,
 * `the seller URL`, the name of an environment variable). 127.0.0.2 and the rest of 127/8 are not this computer's
 * own names here: only the three above are.
 * @param {string} value
 * @returns {string | undefined}
 */
export function sellerUrlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.username !== "" || url.password !== "") return "carries a user name or password";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:") {
    return LOOPBACK.has(url.hostname)
      ? undefined
      : "is plain http: only https is accepted, or http on this computer (127.0.0.1, localhost or [::1])";
  }
  return "is not an https URL";
}
