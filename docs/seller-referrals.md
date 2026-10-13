# Seller referrals

When a buyer finds your listing in the Superstables index and pays it with the Superstables
client, the paid request carries a referral token signed by superstables.com. Your service can
verify that token with `@superstables/client/seller`, which uses Node built-ins only. You don't
report sales to superstables.com.

**Testnet only.** Purchases, fees and statements are kept by superstables.com. The client carries
the token from the index to your service, and this helper checks it; neither computes a fee.

## How it works

1. You claim your listing on superstables.com and agree to its terms for that listing.
2. The index (`GET /api/v1/services`) then adds a `referral` to your listing: a token, when it
   expires, and the terms version.
3. A buyer whose client found your listing in the index sends two headers with the paid request,
   and only with the paid request:

   | Header | Value |
   | --- | --- |
   | `Superstables-Referral` | The referral token |
   | `Superstables-Purchase-Ref` | An id for this purchase, the same on every retry of it: 1 to 128 characters of `A-Z a-z 0-9 . _ : -` |

4. Your service can verify the token.

The token names your listing and your agreement. It carries nothing about the buyer. Index tokens
belong to the listing, not to one purchase, so anyone who reads the index can copy one. A valid
token alone does not prove a purchase.

## Claim your listing

superstables.com gives you a challenge, `ssc_` followed by 32 characters. Publish it in one of
three ways:

| Method | What you publish |
| --- | --- |
| Well-known file | `https://<host>/.well-known/superstables.txt` containing the line `superstables-claim=<challenge>` |
| DNS | A TXT record on `_superstables.<hostname>` with the value `superstables-claim=<challenge>` |
| Endpoint header | Your listed endpoint answers with `Superstables-Claim: <challenge>`, on any status (a 402 is fine) |

## Verify the referral

```ts
import { checkReferral, readReferral } from "@superstables/client/seller";

// In the handler of a paid request, alongside checking the payment. checkReferral never throws:
// when the site's keys cannot be read, it answers { ok: false, reason: "keys_unavailable" }.
const referral = readReferral(req.headers); // Fetch Headers, Node headers or a plain object
const checked = referral
  ? checkReferral(referral.token, { audience: "https://api.example.com" }) // your listing's origin
  : undefined;

// After the payment settled and the answer was sent:
const result = await checked;
if (result?.ok) console.log(`referred by Superstables: ${result.claims.jti}`);
```

`readReferral` returns `{ token, purchaseRef }`, or `null` when the request has no referral. It
leaves out a purchase reference that breaks the character or length rule.

`checkReferral(token, options)` reads the site's published keys and calls `verifyReferral` with them.
`site` defaults to `https://www.superstables.com`, which is also the expected issuer. It checks its
options, the site and the token's shape before it fetches anything. When a token names a key the
cached set does not have, it reads the keys once more, at most once a minute per site, so a key
rotation is picked up without a request for every unknown key. If that read fails, it keeps the key
set it already holds and answers `unknown_key`; it answers `keys_unavailable` only when no key set
could be read at all. A check whose key is in the held set never waits for a refresh.

`verifyReferral(token, { keys, issuer, ... })` does the check with keys you supply. Both return
`{ ok: true, claims }` or `{ ok: false, reason }` and never throw on a bad token. A token is accepted
when:

- the header is `alg: EdDSA`, `typ: superstables-referral+jwt`, with a `kid` the published key set
  has, and no `crit`;
- the Ed25519 signature checks against that key;
- `iss` is the expected site;
- `aud` is your origin, when you give `audience`, and `sub` is your listing id, when you give
  `listingId`. Give one or both: each one you give must match;
- `exp` has not passed at the time of the request, and `iat` is not in the future, each with 60
  seconds of clock skew (`skewSeconds`). Pass `now` to check another time.

The reasons are `malformed`, `unsupported_header`, `unknown_key`, `bad_signature`, `wrong_issuer`,
`wrong_audience`, `expired`, `not_yet_valid`, `no_audience` when you gave neither `audience` nor
`listingId`, `invalid_options` when `skewSeconds` is not a finite number of 0 or more or `now` is not
a valid `Date` (and, for `checkReferral`, when `site` is not https or plain http on this machine, or
`fetch` is not a function), and, from `checkReferral` only, `keys_unavailable`. Set `audience` and `listingId`
from your own configuration, never from the request: its `Host` header is the caller's to choose.

`claims` holds `iss`, `jti` (the referral id), `sub`, `aud`, `sel` (seller account), `agr`
(agreement), `terms`, `ch` (`directory` for an index token, `hosted` for a purchase made on
superstables.com, which also has `pur`, its purchase id), `iat` and `exp`.

`fetchReferralKeys(site)` reads `/.well-known/superstables-referral-keys.json` from the site and keeps
it in memory for ten minutes. It throws when the keys cannot be read. If you call it yourself, catch
that error and treat the referral as not checked, so a site outage never fails your paid request.
It accepts https sites only, or plain http on this machine.

## Try a claim with the demo seller

`superstables demo-service` publishes a claim challenge when `SUPERSTABLES_CLAIM_CHALLENGE` is set.
It serves `/.well-known/superstables.txt` and adds `Superstables-Claim` to every answer of
`/v1/market`. It is off unless set. The demo seller does not check referral headers.

```bash
SUPERSTABLES_CLAIM_CHALLENGE=ssc_… superstables demo-service --pay-to 0xYourAddress
```

## What the client sends

The client remembers a referral only for a listing the Superstables index returned (`superstables
find`, or `superstables quote --service` with an index listing), by the origin of the listing's
endpoint, in `records/referrals.json` (mode 0600), until the index's `expires_at` or the token's own
`exp`, whichever is earlier. That file is the only place the client keeps the token. A quote for a
URL with that exact origin records which referral applies, when the token names that origin as its
`aud`. The paid request then reads the token from `referrals.json`, if it is still there and has not
expired, and sends `Superstables-Referral` and `Superstables-Purchase-Ref`, whose value is the
payment's attempt id. The request that reads the price never carries them, and a referral that
cannot be recorded is left off rather than holding up the payment.

`superstables find --json` shows a listing's `referral` as `{ expiresAt, terms }`, without the token.
The receipt records `discoveredVia: "superstables"` and `referral: { id, listingId, terms }`.
`SUPERSTABLES_REFERRALS=off` stops the client from remembering and sending referrals.
