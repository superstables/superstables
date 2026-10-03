// How tempo/buy.ts talks to a seller. A tempo.charge credential travels in a header the seller's challenge can choose,
// not only in Authorization, and fetch drops only Authorization and Cookie when it follows a redirect to another host.
// So no request to a seller follows a redirect: the unpaid challenge refuses one before anything is signed, and the
// paid request refuses one rather than carry the credential to a host the owner never chose. A refused paid request
// is not "not sent": buy.ts reads the chain after it, as after any send that got no complete answer.

/** The request init for both requests to the seller: the method, the body if any, and no redirects. */
export function sellerInit(method: string, body?: string): RequestInit {
  return {
    method,
    redirect: 'error',
    ...(body !== undefined ? { body, headers: { 'content-type': 'application/json' } } : {}),
  }
}

/** The options for mppx's prepareRequest: a payment challenge is required, and a redirect is refused, not followed. */
export const CHALLENGE_OPTIONS = { requirePayment: true, maxRedirects: 0 } as const
