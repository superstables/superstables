// buy(url) -- the agent pays one real MPP seller (tempo.charge, TIP-20 transferWithMemo).
//
// Uses the official `mppx` client (https://mpp.dev). A bare transfer() would move funds but not match
// the seller's invoice: MPP binds a payment to its Challenge with a memo, so the payment is a
// `transferWithMemo` built by mppx. The agent's access key is the account, so the AccountKeychain
// precompile enforces the spending limit, expiry and recipient scope on the same call.
//
// Lifecycle (contract rules 1, 5, 6). Nothing below the first three steps is reached if one refuses:
//   1. Parse flags. Bad or missing flags exit 2 before any file is read.
//   2. Open tempo-agent.env only (access key + the owner's PUBLIC address; no owner key).
//   3. Fetch the seller's challenge (an unpaid request) and run the pre-signing checks: price <= --max
//      (required), token is pathUSD on Moderato, whole base units, recipient == --pay-to when given.
//      A refusal exits 3 with RESULT state refused_precheck. Nothing has been signed.
//   4. Write the operation journal (state quoted, with the purchase memo), then sign. In pull mode (the
//      default for an access key) the signed payment is a bearer transaction that expires in 25 s. The
//      memo mppx puts on it is known before signing and is an indexed topic of the on-chain
//      TransferWithMemo event, so this one purchase can be found on chain even if its transaction hash
//      is never learned (a sponsored transaction's final hash exists only after the seller adds the
//      fee payer's signature). The journal is set to `submitted` BEFORE the payment is sent.
//   5. Send it. Whatever the seller answers (200, 402, 500, a dropped connection), the outcome is read
//      from the chain: settled needs the payment's OWN transaction to have succeeded with a pathUSD
//      Transfer owner -> recipient of the price. The seller's HTTP status is recorded separately as
//      `delivered`. A payment is never retried, and a delivery failure never causes a new payment.
//   6. Final line: RESULT {"rail","op","state","tx","debit","remaining","delivered","next"}.
//
// Exit codes: 0 settled and delivered, 1 failed / refused by the chain / not found, 2 bad usage,
// 3 refused before signing (precheck, or the op id is already pending or settled), 4 settled but the
// seller did not deliver, 5 outcome unknown (run reconcile).
//
// Usage:
//   npx tsx budget/tempo/buy.ts --url https://mpp.dev/api/ping/paid --max 0.2
//   npx tsx budget/tempo/buy.ts --url https://mpp.quicknode.com/tempo-testnet --method POST --max 0.01 \
//     --body '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' --pay-to 0xFD24114C3981Aba78aE2441991B1BdB89329c556
//   npx tsx budget/tempo/buy.ts --url <seller> --max 0.2 --agent 2 --op my-op-1

import { createHash } from 'node:crypto'
import { Mppx, tempo } from 'mppx/client'
import { Credential, Receipt } from 'mppx'
import { keccak256, type Address, type Hex } from 'viem'
import { addressCheck, decimalCheck, labelCheck, opIdCheck, parseCli, urlCheck } from './lib/args.mjs'
import {
  CHAIN_ID,
  TOKEN_ADDRESS,
  TOKEN_LABEL,
  agentAccessKeyAccount,
  describeError,
  explorerTx,
  fromBaseUnits,
  isChainRefusal,
  loadAgentEnv,
  oneLine,
  toBaseUnits,
} from './lib/common.ts'
import { chainHead, getTxSigner, mppMemo, readKey, readScope } from './lib/chain.ts'
import { judge, waitForOutcome } from './lib/resolve.ts'
import { BLOCKING, OPS_DIR, newOpId, printResult, readOp, writeOp, type Op, type OpState } from './lib/ops.ts'
import { readCapped, saveResponse } from '../response.mjs'
import { budgetShortfall, precheckCharge, recipientsOutsideScope } from './lib/precheck.ts'
import { CHALLENGE_OPTIONS, sellerInit } from './lib/seller.ts'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const { values: args } = parseCli({
  name: 'buy.ts',
  summary: `Pay one MPP seller (tempo.charge, ${TOKEN_LABEL}) from the owner's budget with the agent's access key. Refuses before signing when the price is above --max, the token is not ${TOKEN_LABEL}, or the recipient is not --pay-to.`,
  flags: {
    url: { type: 'string', required: true, metavar: 'seller url', desc: 'Seller URL', check: urlCheck },
    max: { type: 'string', required: true, metavar: 'amount', desc: `Highest price you accept, in ${TOKEN_LABEL} (decimal, at most 6 places). No default.`, check: decimalCheck(6) },
    'pay-to': { type: 'string', metavar: 'address', desc: 'Refuse unless the seller pays to this address', check: addressCheck },
    method: { type: 'string', metavar: 'verb', desc: `HTTP method, default GET (${METHODS.join('|')})`, check: (v) => (METHODS.includes(v.toUpperCase()) ? undefined : `must be one of ${METHODS.join('|')}`) },
    body: { type: 'string', metavar: 'text', desc: 'Request body (sent as application/json)' },
    op: { type: 'string', metavar: 'id', desc: 'Operation id (generated and printed when absent). Reusing a pending or settled id is refused.', check: opIdCheck },
    agent: { type: 'string', metavar: 'label', desc: 'Named agent key (AGENT<label>_* in tempo-agent.env); omit for the primary agent', check: labelCheck },
    quote: { type: 'boolean', desc: 'Fetch the challenge and run the checks, sign nothing (RESULT state quoted)' },
  },
  examples: ['npx tsx budget/tempo/buy.ts --url https://mpp.dev/api/ping/paid --max 0.2', 'npx tsx budget/tempo/reconcile.ts --op <id>'],
})

const url = args.url as string
const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
const body = typeof args.body === 'string' ? args.body : undefined
const agentLabel = typeof args.agent === 'string' ? args.agent : ''
const payTo = typeof args['pay-to'] === 'string' ? (args['pay-to'] as string) : undefined
const maxBase = toBaseUnits(args.max as string)
const opId = typeof args.op === 'string' ? args.op : newOpId()

const nowIso = () => new Date().toISOString()
const exitFor = (state: OpState, delivered: boolean | null): number => {
  if (state === 'settled') return delivered ? 0 : 4
  if (state === 'refused_precheck') return 3
  if (state === 'unknown' || state === 'submitted') return 5
  if (state === 'quoted') return 0
  return 1
}

let op: Op | undefined
/** The seller's answer to the paid request, once saved (RESULT responseFile, ...). */
let saved: Record<string, unknown> | null = null

function finish(state: OpState, f: { tx?: string | null; debit?: bigint | null; remaining?: bigint | null; delivered?: boolean | null; next?: string; reason?: string }): never {
  if (op) {
    op.state = state
    if (f.tx) op.tx = f.tx
    if (f.delivered !== undefined && f.delivered !== null) op.delivered = f.delivered
    if (f.reason) op.reason = f.reason
    writeOp(op, f.reason)
  }
  const delivered = f.delivered ?? null
  printResult({
    op: opId,
    state,
    tx: f.tx ?? null,
    debit: f.debit === undefined || f.debit === null ? null : fromBaseUnits(f.debit),
    remaining: f.remaining === undefined || f.remaining === null ? null : fromBaseUnits(f.remaining),
    delivered,
    ...(saved ?? {}),
    next: f.next ?? 'none',
    ...(f.reason ? { reason: f.reason } : {}),
  })
  process.exit(exitFor(state, delivered))
}

async function main() {
  // 1. An operation that is pending or settled is never started again under the same id.
  const existing = readOp(opId)
  if (existing && BLOCKING.includes(existing.state)) {
    console.log(`Operation ${opId} is already ${existing.state}${existing.tx ? ` (tx ${oneLine(existing.tx, 100)})` : ''}. Not paying again.`)
    console.log(`Run: npx tsx budget/tempo/reconcile.ts --op ${opId}`)
    printResult({
      op: opId,
      state: existing.state,
      tx: existing.tx ?? null,
      debit: null,
      remaining: null,
      delivered: existing.delivered ?? null,
      next: `npx tsx budget/tempo/reconcile.ts --op ${opId}`,
      reason: `op_already_${existing.state}`,
    })
    process.exit(3)
  }

  // 2. Agent file only.
  const env = loadAgentEnv()
  const agent = agentAccessKeyAccount(env, agentLabel)
  const ownerAddress = agent.address as Address
  const agentKey = agent.accessKeyAddress as Address
  console.log(`op ${opId}`)
  console.log(`Agent access key ${agentKey} buying from ${url} (owner ${ownerAddress} funds it, chain ${CHAIN_ID}, max ${args.max} ${TOKEN_LABEL})`)

  // tempo.charge only: a seller that offers a session (a deposit of its choosing) is never selected.
  const mppx = Mppx.create({
    methods: [tempo.charge({ account: agent, expectedChainId: CHAIN_ID, ...(payTo ? { expectedRecipients: [payTo as Address] } : {}) })],
    polyfill: false,
  })
  // no redirects on either request to the seller (lib/seller.ts says why)
  const reqInit = (): RequestInit => sellerInit(method, body)

  // 3. Quote: an unpaid request. Nothing is signed.
  let prepared: Awaited<ReturnType<typeof mppx.prepareRequest>>
  try {
    prepared = await mppx.prepareRequest(url, { ...reqInit(), signal: AbortSignal.timeout(30_000) }, CHALLENGE_OPTIONS)
  } catch (err) {
    const msg = oneLine((err as Error)?.message ?? err)
    console.log(`\nREFUSED before signing: could not get a usable ${TOKEN_LABEL} tempo.charge challenge: ${msg}`)
    op = baseOp({ amount: '0', amountDecimal: '0', recipient: '', chainId: CHAIN_ID }, ownerAddress, agentKey)
    finish('refused_precheck', { reason: `no_usable_challenge: ${msg}`, next: 'check the seller URL; nothing was signed' })
  }
  const payment = prepared.payment!
  const challenge = payment.challenge
  const req = challenge.request as Record<string, any>
  const details = (req.methodDetails ?? {}) as Record<string, any>
  // every value here is the seller's: one line each (oneLine), so none can start a line of its own
  console.log(`  challenge: ${oneLine(`${challenge.method}.${challenge.intent} realm=${challenge.realm}`, 500)}`)
  console.log(`    ${oneLine(`amount=${req.amount} currency=${req.currency} chainId=${details.chainId} recipient=${req.recipient}`, 500)}`)
  console.log(`    ${oneLine(`feePayer=${details.feePayer ?? false} supportedModes=${JSON.stringify(details.supportedModes ?? ['pull', 'push'])} expires=${challenge.expires ?? 'n/a'}`, 500)}`)

  const check = challenge.intent !== 'charge' || challenge.method !== 'tempo'
    ? ({ ok: false, code: 'unsupported_intent', reason: `challenge is ${challenge.method}.${challenge.intent}, only tempo.charge is bought here` } as const)
    : precheckCharge(req, { maxBase, payTo })

  op = baseOp(
    {
      amount: /^\d+$/.test(String(req.amount)) ? String(req.amount) : '0',
      amountDecimal: /^\d+$/.test(String(req.amount)) ? fromBaseUnits(BigInt(req.amount)) : String(req.amount),
      recipient: String(req.recipient ?? ''),
      chainId: Number(details.chainId ?? 0),
      challengeId: challenge.id,
      realm: challenge.realm,
      splits: Array.isArray(details.splits) ? details.splits : undefined,
    },
    ownerAddress,
    agentKey,
  )
  if (!check.ok) {
    console.log(`\nREFUSED before signing (${check.code}): ${oneLine(check.reason, 1000)}`)
    console.log('Nothing was signed or sent.')
    finish('refused_precheck', { reason: `${check.code}: ${check.reason}`, next: 'nothing was signed; pick another seller or raise --max' })
  }

  // 4. Journal the intent before signing.
  const supportedModes: string[] = details.supportedModes ?? ['pull', 'push']
  const mode = supportedModes.includes('pull') ? 'pull' : supportedModes[0]
  op.intent.mode = mode
  const head0 = await chainHead()
  op.startBlock = head0.number.toString()
  writeOp(op, 'quoted')
  const amount = check.amount
  const splitTotal = check.splits.reduce((s, x) => s + BigInt(x.amount), 0n)
  const primary = amount - splitTotal

  let remainingBefore: bigint | null = null
  let noBudget: string | undefined
  let overBudget: string | undefined
  let outsideScope: string[] = []
  try {
    const k = await readKey(ownerAddress, agentKey)
    remainingBefore = k.remaining
    console.log(`  key: ${k.exists ? 'active' : k.revoked ? 'REVOKED' : 'not authorized'}, remaining ${fromBaseUnits(k.remaining)} ${TOKEN_LABEL}, expiry ${k.expiry ? new Date(k.expiry * 1000).toISOString() : 'n/a'}`)
    // No budget on chain for this key: the chain would refuse the payment, so nothing is signed. (A read that failed
    // proves nothing: then the chain does the refusing, as before.)
    if (k.revoked) noBudget = 'the agent access key is revoked (a revoked key can never be granted again)'
    else if (!k.exists) noBudget = 'the agent access key is not authorized: the owner has not granted a budget'
    else if (k.expiry && k.expiry * 1000 <= Date.now()) noBudget = `the budget expired at ${new Date(k.expiry * 1000).toISOString()}`
    // The chain would refuse a payment above what is left (SpendingLimitExceeded): say so before signing, as evm does.
    // When the seller pays the fee, the payment takes exactly the price from the limit. How an unsponsored payment's fee
    // affects the limit has not been verified yet; the chain still checks the limit either way.
    else overBudget = budgetShortfall(k, amount) ?? undefined
  } catch (err) {
    console.log(`  (could not read the key state: ${String((err as Error).message).slice(0, 120)})`)
  }

  // A key granted with a seller list may pay only those recipients (the chain answers CallNotAllowed otherwise). A read
  // that failed proves nothing: then the chain does the refusing.
  if (!noBudget) {
    const recipients = [String(req.recipient), ...check.splits.map((x) => x.recipient)]
    try {
      outsideScope = recipientsOutsideScope(await readScope(ownerAddress, agentKey), recipients)
    } catch (err) {
      console.log(`  (could not read the key's seller list: ${String((err as Error).message).slice(0, 120)})`)
    }
  }

  if (args.quote) {
    console.log(`\nQuoted: ${fromBaseUnits(amount)} ${TOKEN_LABEL} to ${oneLine(req.recipient)}. Nothing was signed.`)
    finish('quoted', { reason: 'quote_only', next: 'run the same command again without --quote to buy' })
  }
  if (noBudget) {
    console.log(`\nREFUSED before signing: ${noBudget}. Nothing was signed or sent.`)
    const newKey = /revoked|expired/.test(noBudget)
    finish('refused_precheck', {
      reason: `no_budget: ${noBudget}`,
      next: newKey
        ? `the owner makes a new key with superstables budget setup --rail tempo --agent LABEL, then superstables budget grant --rail tempo --agent LABEL --amount A; nothing was signed`
        : `the owner grants a budget: superstables budget grant --rail tempo${agentLabel ? ` --agent ${agentLabel}` : ''} --amount A; nothing was signed`,
    })
  }

  if (outsideScope.length) {
    const who = outsideScope.join(', ')
    console.log(`\nREFUSED before signing: the budget's seller list does not include ${who}. Nothing was signed or sent.`)
    finish('refused_precheck', {
      reason: `seller_not_allowed: the budget's seller list does not include ${who}`,
      remaining: remainingBefore,
      next: 'this budget can pay only the sellers the owner listed in the grant; buy from one of them, or tell the owner; nothing was signed',
    })
  }
  if (overBudget) {
    console.log(`\nREFUSED before signing: ${overBudget}. Nothing was signed or sent.`)
    finish('refused_precheck', {
      reason: `budget_too_low: ${overBudget}`,
      remaining: remainingBefore,
      next: /period ends at/.test(overBudget)
        ? `the budget left cannot cover this purchase until ${overBudget.replace(/^.*; the current period ends at (\S+?),.*$/, '$1')}, when the limit refills; nothing was signed`
        : 'the budget left is less than the price; nothing was signed',
    })
  }

  // 5. Sign. Push mode broadcasts inside createCredential, so the intent is already `submitted`.
  if (mode === 'push') {
    op.state = 'submitted'
    writeOp(op, 'push mode: createCredential broadcasts')
  }
  let credential: string
  try {
    credential = await payment.createCredential()
  } catch (err) {
    const desc = oneLine(describeError(err), 1000)
    if (isChainRefusal(desc)) {
      console.log(`\nREFUSED by the chain before anything was signed or sent: ${desc}`)
      finish('refused_chain', { reason: desc, remaining: remainingBefore, next: 'nothing was signed; check the budget with readBudget' })
    }
    if (mode === 'push') {
      console.log(`\nUNKNOWN: push-mode broadcast raised an error: ${desc}`)
      finish('unknown', { reason: desc, next: `npx tsx budget/tempo/reconcile.ts --op ${opId}` })
    }
    console.log(`\nFAILED before signing: ${desc}`)
    finish('failed', { reason: `signing_failed: ${desc}`, remaining: remainingBefore, next: 'nothing was sent; safe to retry with a new op id' })
  }
  const payload = Credential.deserialize(credential).payload as { type?: string; signature?: Hex; hash?: Hex }
  console.log(`  credential created: mode=${payload.type === 'hash' ? 'push (client-broadcast)' : payload.type === 'transaction' ? 'pull (relay-broadcast)' : payload.type}`)
  if (payload.type === 'hash' && payload.hash) op.expectedTx = payload.hash // push: already broadcast, this IS the tx hash
  if (payload.type === 'transaction' && payload.signature) {
    op.signedHash = keccak256(payload.signature) // informational: a sponsored tx's final hash differs (the seller adds the fee payer signature)
    op.validBefore = Math.floor(Date.now() / 1000) + 26 // mppx signs with validBefore = now + 25 s at most; after it the payment can never land
  }
  op.state = 'submitted'
  writeOp(op, 'signed; about to send to the seller')
  console.log(`  journal state submitted; purchase memo ${op.memo}${op.validBefore ? `; the signed payment expires at unix ${op.validBefore}` : ''}`)

  // 6. Send. The payment is never resent, whatever comes back.
  let httpStatus: number | undefined
  let receiptTx: string | undefined
  let bodyText = ''
  let sendError: string | undefined
  try {
    const res = await mppx.rawFetch(url, payment.setCredential({ ...reqInit(), signal: AbortSignal.timeout(60_000) }, credential))
    httpStatus = res.status
    console.log(`\nHTTP status: ${res.status}`)
    try {
      receiptTx = Receipt.fromResponse(res).reference
    } catch {
      /* no Payment-Receipt header */
    }
    const body = await readCapped(res)
    bodyText = body.bytes.toString('utf8')
    // seller text: a one-line preview only; the whole answer is saved next to the journal
    console.log(`response (${oneLine(res.headers.get('content-type') ?? '', 100)}): ${oneLine(bodyText, 500)}`)
    if (res.status !== 402) saved = saveResponse(OPS_DIR, opId, body, res.headers.get('content-type'))
  } catch (err) {
    sendError = oneLine((err as Error)?.message ?? err, 200)
    console.log(`\nNo complete answer from the seller (${sendError}). Reading the chain, not resending.`)
  }
  const delivered = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300
  op.httpStatus = httpStatus
  if (receiptTx) op.tx = receiptTx
  writeOp(op)

  // 7. The chain decides.
  const outcome = await waitForOutcome(op, delivered && receiptTx ? 30_000 : 55_000)
  const remainingAfter = await readKey(ownerAddress, agentKey).then((k) => k.remaining, () => null)
  if (outcome.kind === 'found') {
    const j = judge(op, outcome, primary)
    const r = outcome.receipt
    console.log(`chain: tx ${r.transactionHash} ${r.status} in block ${r.blockNumber}`)
    console.log(`explorer: ${explorerTx(r.transactionHash)}`)
    console.log(`signer: keychain keyId ${outcome.keyId ?? 'n/a'} (agent key ${agentKey})`)
    if (op.tx && op.tx.toLowerCase() !== r.transactionHash.toLowerCase()) console.log(`note: the seller's receipt named ${oneLine(op.tx, 100)}, the chain search by memo found ${r.transactionHash}`)
    if (j.state === 'settled') {
      console.log(`SETTLED: ${fromBaseUnits(j.debit)} ${TOKEN_LABEL} left the owner. Seller delivery: ${delivered ? 'yes' : `NO (HTTP ${httpStatus ?? 'none'})`}. Not retried.`)
      finish('settled', { tx: r.transactionHash, debit: j.debit, remaining: remainingAfter, delivered, next: delivered ? 'none' : 'paid but not delivered; do not pay again, contact the seller with the tx hash' })
    }
    if (j.state === 'failed') {
      console.log('FAILED: the payment transaction was mined and reverted. No funds moved.')
      finish('failed', { tx: r.transactionHash, debit: 0n, remaining: remainingAfter, delivered, reason: j.note, next: 'read the tx on the explorer; safe to retry with a new op id' })
    }
    console.log(`UNKNOWN: ${j.note}`)
    finish('unknown', { tx: r.transactionHash, remaining: remainingAfter, delivered, reason: j.note, next: `npx tsx budget/tempo/reconcile.ts --op ${opId}` })
  }
  if (outcome.kind === 'expired') {
    console.log('NOT FOUND: the signed payment expired without landing on chain. No funds moved.')
    finish('not_found', { debit: 0n, remaining: remainingAfter, delivered, reason: 'signed payment expired unsent; no transfer with this purchase memo on chain', next: 'no funds moved; safe to retry with a new op id' })
  }
  console.log('UNKNOWN: the chain does not show the payment yet and it may still land.')
  finish('unknown', { remaining: remainingAfter, delivered, reason: sendError ?? 'not visible on chain yet', next: `npx tsx budget/tempo/reconcile.ts --op ${opId}` })
}

function baseOp(
  q: { amount: string; amountDecimal: string; recipient: string; chainId: number; challengeId?: string; realm?: string; splits?: { recipient: string; amount: string }[] },
  owner: string,
  agent: string,
): Op {
  const previous = readOp(opId)
  return {
    op: opId,
    rail: 'tempo',
    kind: 'buy',
    state: 'quoted',
    createdAt: previous?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    intent: {
      url,
      method,
      ...(body !== undefined ? { bodySha256: createHash('sha256').update(body).digest('hex') } : {}),
      amount: q.amount,
      amountDecimal: q.amountDecimal,
      token: TOKEN_ADDRESS,
      recipient: q.recipient,
      ...(q.splits ? { splits: q.splits } : {}),
      chainId: q.chainId,
      owner,
      agent,
      ...(q.challengeId ? { challengeId: q.challengeId } : {}),
      ...(q.realm ? { realm: q.realm } : {}),
      maxDecimal: args.max as string,
    },
    ...(q.challengeId && q.realm ? { memo: mppMemo(q.challengeId, q.realm) } : {}),
    history: previous?.history ?? [],
  }
}

main().catch((err) => {
  // Anything unexpected after the payment was signed is an unknown outcome, never "no transfer sent".
  const msg = oneLine((err as Error)?.message ?? err)
  console.error('buy failed:', msg)
  if (op && (op.state === 'submitted')) {
    finish('unknown', { reason: msg, next: `npx tsx budget/tempo/reconcile.ts --op ${opId}` })
  }
  if (op) finish('failed', { reason: `error before signing: ${msg}`, next: 'nothing was signed; safe to retry with a new op id' })
  process.exit(1)
})
