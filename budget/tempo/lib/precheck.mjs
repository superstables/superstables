// Pre-signing checks for a purchase (contract rule 4). Pure: no network, no keys. A refusal here means
// nothing was signed, pulled or sent.
import { CHAIN_ID, TOKEN_ADDRESS, TOKEN_DECIMALS, TOKEN_LABEL } from './constants.mjs'

/** mppx's payment-memo tag: the first 4 bytes of keccak256("mpp"). Every purchase memo starts with it (chain.ts mppMemo). */
export const MPP_MEMO_TAG = '0xef1ed712'

const fromBase = (n) => {
  const whole = n / 10n ** BigInt(TOKEN_DECIMALS)
  const frac = (n % 10n ** BigInt(TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '')
  return `${whole}${frac ? '.' + frac : ''}`
}
const refuse = (code, reason) => ({ ok: false, code, reason })
const isAddr = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** The words to refuse a recipient that a purchase must never pay, or null. `who` is "the recipient" or "a split recipient". */
function badRecipient(who, to, opts) {
  const a = to.toLowerCase()
  if (/^0x0{40}$/.test(a)) return `${who} is the zero address`
  if (a === TOKEN_ADDRESS.toLowerCase()) return `${who} is the ${TOKEN_LABEL} token contract itself`
  if (opts.agent && a === opts.agent.toLowerCase()) return `${who} is this agent's own key`
  if (opts.owner && a === opts.owner.toLowerCase()) return `${who} is the owner's wallet, which funds this budget`
  return null
}

/**
 * The seller's tempo.charge challenge request must be: pathUSD on Moderato, whole base units (no more
 * precision than the token has), at most `maxBase`, paid to `payTo` when one is given, and never to the zero address,
 * the token itself, the agent or the owner (the same for each split). `request.amount`
 * is in base units on the wire; any `decimals` field must match the token.
 * @param {Record<string, any>} request
 * @param {{ maxBase: bigint, payTo?: string, agent?: string, owner?: string }} opts
 * @returns {{ ok: true, amount: bigint, recipient: string, splits: { recipient: string, amount: string }[] } | { ok: false, code: string, reason: string }}
 */
export function precheckCharge(request, opts) {
  if (!request || typeof request !== 'object') return refuse('bad_challenge', 'the challenge has no request body')
  const details = request.methodDetails ?? {}

  if (request.decimals !== undefined && Number(request.decimals) !== TOKEN_DECIMALS) {
    return refuse('wrong_decimals', `the seller quotes ${request.decimals} decimals; ${TOKEN_LABEL} has ${TOKEN_DECIMALS}`)
  }
  const rawAmount = request.amount
  if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') return refuse('bad_challenge', 'the challenge has no amount')
  const amountText = String(rawAmount)
  if (!/^\d+$/.test(amountText)) {
    return refuse('bad_precision', `amount ${JSON.stringify(amountText)} is not a whole number of base units; ${TOKEN_LABEL} has ${TOKEN_DECIMALS} decimals`)
  }
  const amount = BigInt(amountText)
  if (amount === 0n) return refuse('bad_challenge', 'the challenge amount is 0')

  if (typeof request.currency !== 'string' || request.currency.toLowerCase() !== TOKEN_ADDRESS.toLowerCase()) {
    return refuse('wrong_token', `currency ${request.currency} is not ${TOKEN_LABEL} (${TOKEN_ADDRESS})`)
  }
  if (Number(details.chainId) !== CHAIN_ID) {
    return refuse('wrong_chain', `chainId ${details.chainId} is not Tempo Moderato (${CHAIN_ID})`)
  }
  if (!isAddr(request.recipient)) return refuse('bad_challenge', 'the challenge has no valid recipient address')
  const badTo = badRecipient('the recipient', request.recipient, opts)
  if (badTo) return refuse('bad_recipient', badTo)
  const splits = Array.isArray(details.splits) ? details.splits : []
  for (const s of splits) {
    if (!isAddr(s?.recipient) || !/^\d+$/.test(String(s?.amount))) return refuse('bad_challenge', 'a payment split is malformed')
    const badSplit = badRecipient('a split recipient', s.recipient, opts)
    if (badSplit) return refuse('bad_recipient', badSplit)
  }
  // mppx's machine-token route (methodDetails.machineTokenEnabled) pays through a swap contract, not a plain pathUSD
  // transfer: the owner's machine token is approved to the swapper and swapped into the price. mppx takes it on its own when
  // the owner holds enough of that token. Nothing in this client checks that route, so a challenge that asks for it is refused.
  if (details.machineTokenEnabled != null && details.machineTokenEnabled !== false) {
    return refuse('machine_token', "the seller's challenge turns on mppx's machine-token route, which pays through a swap contract instead of a plain " + TOKEN_LABEL + ' transfer; this client pays only by plain transfer')
  }
  // A seller that names its own payment memo runs an MPP server from before challenge-bound memos: current clients (mppx)
  // always send the memo bound to the challenge, so such a seller answers "Transfer memo does not match the challenge memo"
  // after the payment was signed. Refuse before signing.
  if (details.memo !== undefined && details.memo !== null) {
    return refuse('seller_memo', `the seller requires a payment memo of its own (${String(details.memo).slice(0, 20)}...) in its challenge; this client does not support that, so nothing was signed`)
  }
  // The splits as mppx pays them. Its client throws (getTransfers) when they add up to the price or more, or are not a list;
  // an mppx seller's charge schema refuses a split of 0, more than 10, or a split memo that is not 32 bytes of hex (viem
  // would pad a shorter one and pay it). mppx finds the first two only while it creates the payment, so they are refused here.
  if (details.splits != null && !Array.isArray(details.splits)) return refuse('bad_split', "the challenge's payment splits are not a list")
  if (splits.length > 10) return refuse('bad_split', `the challenge splits the price ${splits.length} ways; at most 10 are allowed`)
  let splitTotal = 0n
  for (const s of splits) {
    if (BigInt(s.amount) === 0n) return refuse('bad_split', `the payment split to ${s.recipient} is 0`)
    if (s.memo != null && !/^0x[0-9a-fA-F]{64}$/.test(String(s.memo))) return refuse('bad_split', `the payment split to ${s.recipient} names a memo that is not 32 bytes of hex`)
    // A split memo in mppx's own format could be another purchase's memo: a transfer carrying it would read as that purchase's
    // payment. This client's purchases never ask for one, so a seller's split never names one.
    if (s.memo != null && String(s.memo).slice(0, 10).toLowerCase() === MPP_MEMO_TAG) return refuse('bad_split', `the payment split to ${s.recipient} carries a payment memo in the format this client uses to find purchases, so it could be counted as another purchase's payment`)
    splitTotal += BigInt(s.amount)
  }
  if (splitTotal >= amount) return refuse('bad_split', `the payment splits add up to ${fromBase(splitTotal)} ${TOKEN_LABEL}, not less than the price ${fromBase(amount)} ${TOKEN_LABEL}`)
  if (opts.payTo) {
    if (request.recipient.toLowerCase() !== opts.payTo.toLowerCase()) {
      return refuse('recipient_mismatch', `recipient ${request.recipient} is not the expected --pay-to ${opts.payTo}`)
    }
    const stray = splits.find((s) => s.recipient.toLowerCase() !== opts.payTo.toLowerCase())
    if (stray) return refuse('recipient_mismatch', `the price is split to ${stray.recipient}, which is not --pay-to ${opts.payTo}`)
  }
  if (amount > opts.maxBase) {
    return refuse('price_exceeds_max', `price ${fromBase(amount)} ${TOKEN_LABEL} is above --max ${fromBase(opts.maxBase)}`)
  }
  return { ok: true, amount, recipient: request.recipient, splits }
}

/** The longest a seller's challenge may stay open, in seconds. mppx sellers default to 300. */
export const MAX_CHALLENGE_LIFETIME_S = 600

/**
 * The challenge around the request: a realm (the payment memo is built from it and the challenge id, so without one a payment
 * cannot be found on chain as this purchase's) and an expiry at most MAX_CHALLENGE_LIFETIME_S away. A challenge with no expiry
 * is accepted: the payment mppx signs expires on its own (checked after signing). Pure.
 * @param {{ id?: unknown, realm?: unknown, expires?: unknown }} challenge
 * @param {number} [nowMs]
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function precheckChallenge(challenge, nowMs = Date.now()) {
  if (!challenge || typeof challenge !== 'object') return refuse('bad_challenge', 'there is no challenge')
  if (typeof challenge.id !== 'string' || challenge.id === '') return refuse('bad_challenge', 'the challenge has no id')
  if (typeof challenge.realm !== 'string' || challenge.realm === '') return refuse('bad_challenge', 'the challenge names no realm, so its payment could not be found on chain as this purchase')
  if (challenge.expires !== undefined && challenge.expires !== null) {
    const at = typeof challenge.expires === 'string' ? Date.parse(challenge.expires) : NaN
    if (!Number.isFinite(at)) return refuse('bad_challenge', 'the challenge has an expiry that is not a date')
    const open = Math.ceil((at - nowMs) / 1000)
    if (open > MAX_CHALLENGE_LIFETIME_S) return refuse('challenge_too_long', `the challenge stays open for ${open} s; this client accepts at most ${MAX_CHALLENGE_LIFETIME_S} s`)
  }
  return { ok: true }
}

/**
 * Whether an access key can cover `amount`, read before signing. Null when it can (or has no limit); otherwise the words for the
 * refusal, with the end of the current period when the limit refills before the key expires. Pure: `key` is what readKey returned.
 * @param {{ spendPolicy: string, remaining: bigint, periodEnd: number, expiry?: number }} key
 * @param {bigint} amount
 * @param {number} [nowMs]
 * @returns {string | null}
 */
export function budgetShortfall(key, amount, nowMs = Date.now()) {
  if (key.spendPolicy === 'unlimited' || key.remaining >= amount) return null
  const refills = key.periodEnd && key.periodEnd * 1000 > nowMs && (!key.expiry || key.periodEnd < key.expiry)
  const refill = refills ? `; the current period ends at ${new Date(key.periodEnd * 1000).toISOString()}, when the limit refills` : ''
  return `price ${fromBase(amount)} ${TOKEN_LABEL} exceeds the remaining budget ${fromBase(key.remaining)} ${TOKEN_LABEL}${refill}`
}

/** transferWithMemo(address,uint256,bytes32): what an MPP tempo.charge payment calls on the token. */
export const TRANSFER_WITH_MEMO_SELECTOR = '0x95777d59'

/**
 * The recipients of a payment that a scoped key may NOT pay with transferWithMemo on pathUSD. Empty when the key is
 * unscoped or every recipient is allowed. A rule with no recipients allows any recipient. Pure: `scope` is what readScope read.
 * @param {{ scoped: boolean, scopes: { target: string, selectorRules: { selector: string, recipients: string[] }[] }[] }} scope
 * @param {string[]} recipients
 * @returns {string[]}
 */
export function recipientsOutsideScope(scope, recipients) {
  if (!scope.scoped) return []
  const rules = scope.scopes
    .filter((s) => s.target.toLowerCase() === TOKEN_ADDRESS.toLowerCase())
    .flatMap((s) => s.selectorRules)
    .filter((r) => r.selector.toLowerCase() === TRANSFER_WITH_MEMO_SELECTOR)
  return recipients.filter((to) => !rules.some((r) => r.recipients.length === 0 || r.recipients.some((x) => x.toLowerCase() === to.toLowerCase())))
}

/**
 * All tempo.charge challenges in a WWW-Authenticate header value, decoded. For helpers that read the
 * header by hand (the header may carry several challenges: other chains, other methods).
 * @param {string} header
 */
export function tempoChargeChallenges(header) {
  const out = []
  for (const part of header.split(/,\s*(?=Payment\s)/)) {
    if (!/method="tempo"/.test(part) || !/intent="charge"/.test(part)) continue
    const m = part.match(/request="([^"]+)"/)
    if (!m) continue
    try {
      out.push(JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')))
    } catch {
      /* skip a malformed challenge */
    }
  }
  return out
}
