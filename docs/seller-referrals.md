# Seller referrals

When a buyer finds your listing in the Superstables index and pays it with the Superstables
client, the paid request carries a referral token signed by superstables.com. Your service can
verify that token and report what happened to the purchase: delivered, failed or refunded.
`@superstables/client/seller` does both, with Node built-ins only.

**Testnet only.** Purchases, fees and statements are kept by superstables.com. The client carries
the token from the index to your service, and this helper checks it and sends your reports; neither
computes a fee.

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

4. Your service verifies the token and, once the purchase has an outcome, reports it to
   `POST https://www.superstables.com/api/v1/seller/events` with your seller API key.

The token names your listing and your agreement. It carries nothing about the buyer. Index tokens
belong to the listing, not to one purchase, so anyone who reads the index can copy one. A valid
token alone does not prove a purchase; the settlement you report is the evidence of it.

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
import {
  DEFAULT_SITE,
  createReferralReporter,
  fetchReferralKeys,
  readReferral,
  verifyReferral,
} from "@superstables/client/seller";

const reporter = createReferralReporter({ apiKey: process.env.SUPERSTABLES_SELLER_KEY! });

// In the handler of a paid request, alongside checking the payment:
const referral = readReferral(req.headers); // Fetch Headers, Node headers or a plain object
const accepted = referral
  ? verifyReferral(referral.token, {
      keys: await fetchReferralKeys(DEFAULT_SITE),
      issuer: DEFAULT_SITE,
      audience: "https://api.example.com", // your listing's origin
    })
  : undefined;

// After the payment settled and the answer was sent:
if (referral && accepted?.ok) {
  reporter
    .report({
      type: "fulfilled",
      referral: referral.token,
      purchase_ref: referral.purchaseRef,
      settlement: {
        network: "eip155:84532",
        transaction: "0x…",
        payer: "0x…",
        amount: "10000", // atomic units
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        status: "settled",
      },
    })
    .catch((err) => console.error(`referral report failed: ${err.code}`));
}
```

`readReferral` returns `{ token, purchaseRef }`, or `null` when the request has no referral. It
leaves out a purchase reference that breaks the character or length rule.

`verifyReferral` returns `{ ok: true, claims }` or `{ ok: false, reason }`. It never throws on a bad
token. It accepts a token when:

- the header is `alg: EdDSA`, `typ: superstables-referral+jwt`, with a `kid` the published key set has;
- the Ed25519 signature checks against that key;
- `iss` is the site you name in `issuer`;
- `aud` is your origin (`audience`), or `sub` is your listing id (`listingId`);
- `exp` has not passed at the time of the request, and `iat` is not in the future, each with 60
  seconds of clock skew (`skewSeconds`). Pass `now` to check another time.

The reasons are `malformed`, `unsupported_header`, `unknown_key`, `bad_signature`, `wrong_issuer`,
`wrong_audience`, `expired`, `not_yet_valid`, and `no_audience` when you gave neither `audience` nor
`listingId`. Use `listingId` when your service cannot know its public origin, for example behind a
proxy: a request's `Host` header is the caller's to choose.

`claims` holds `iss`, `jti` (the referral id), `sub`, `aud`, `sel` (seller account), `agr`
(agreement), `terms`, `ch` (`directory` for an index token, `hosted` for a purchase made on
superstables.com, which also has `pur`, its purchase id), `iat` and `exp`.

`fetchReferralKeys(site)` reads `/.well-known/superstables-referral-keys.json` from the site and keeps
it in memory for ten minutes. It throws when the keys cannot be read; treat that as a referral you
could not check. Both it and the reporter accept https sites only, or plain http on this machine.

Report after the buyer has its answer, and never let a failed report change that answer.

## Report events

`reporter.report(event)` sends one event and returns the site's answer,
`{ purchase: { id, status, reason, fee }, replayed }`.

| `type` | When |
| --- | --- |
| `acknowledged` | You saw a valid referral on a request. Optional. |
| `fulfilled` | The buyer paid and your service delivered. `settlement` is required. |
| `failed` | Your service did not deliver. |
| `refunded` | You returned the payment. `refund.amount` is required. |

An event also takes `purchase_ref` (the buyer's `Superstables-Purchase-Ref`), `order_id` (your own
id), `occurred_at` (default: now) and `refund: { amount, transaction }`. `settlement.status` is
`settled`, `pending` or `unknown`. The body must be 8 KB or less.

Each request carries an `Idempotency-Key`: the hex SHA-256 of
`type|referral id|purchase_ref|order_id|settlement transaction|refund transaction`, with an empty
string for each part that is absent. The same event sent twice is recorded once, and the second
answer has `replayed: true`. The reporter retries network errors, 5xx and 429 answers, three times
by default (`retries`). It waits 500 ms before the first retry and twice as long before each next one
(`backoffMs`), or longer when the site sends `Retry-After`, up to 30 seconds. Other errors are not
retried. A report that fails is thrown as a `ReferralReportError` whose `code` is the site's error
code, or `network_error`, `invalid_response`, `body_too_large` or `http_<status>`. Its message never
contains the key or the token.

## Try it with the demo seller

`superstables demo-service` takes both parts from the environment. Each is off unless set.

| Variable | Effect |
| --- | --- |
| `SUPERSTABLES_CLAIM_CHALLENGE` | Serves `/.well-known/superstables.txt` and adds `Superstables-Claim` to every 402 |
| `SUPERSTABLES_SELLER_KEY` | Verifies the referral on each paid request and reports the purchase as `fulfilled`, with its settlement, or `failed` |
| `SUPERSTABLES_SELLER_SITE` | The site to verify against and report to. Default `https://www.superstables.com` |
| `SUPERSTABLES_SELLER_LISTING` | Checks the token's `sub` against this listing id, instead of its `aud` against the origin the request was made to |

```bash
SUPERSTABLES_SELLER_KEY=sssk_… superstables demo-service --pay-to 0xYourAddress
```

A failed report is logged with its error code only.

## What the client sends

The client remembers a referral only for a listing the Superstables index returned (`superstables
find`, or `superstables quote --service` with an index listing), by the origin of the listing's
endpoint, in `records/referrals.json` (mode 0600). A quote for a URL with that exact origin carries
the referral while it has not expired. The paid request then sends `Superstables-Referral` and
`Superstables-Purchase-Ref`, whose value is the payment's attempt id. The request that reads the
price never carries them.

The receipt records `discoveredVia: "superstables"` and `referral: { id, listingId, terms }`, never the
token. `SUPERSTABLES_REFERRALS=off` stops the client from remembering and sending referrals.
