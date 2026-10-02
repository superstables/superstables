// preflight(url) -- anyone (read-only): the seller's price and recipient for a tempo.charge on Moderato, from its unpaid 402.
// Opens no key file and signs nothing, so it works before setup. The same checks as buy before it signs: pathUSD on Moderato,
// whole base units, a valid recipient, no seller-chosen memo. The price is the seller's ask: --max for buy stays the caller's.
//
// Usage:
//   npx tsx budget/tempo/preflight.ts --url https://mpp.quicknode.com/tempo-testnet --method POST \
//     --body '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

import { parseCli, urlCheck } from './lib/args.mjs'
import { CHAIN_ID, TOKEN_LABEL, fromBaseUnits, oneLine } from './lib/common.ts'
import { precheckCharge, tempoChargeChallenges } from './lib/precheck.ts'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const { values: args } = parseCli({
  name: 'preflight.ts',
  summary: `Read a seller's tempo.charge price and recipient on Moderato from its unpaid 402. Opens no key file and signs nothing.`,
  flags: {
    url: { type: 'string', required: true, metavar: 'seller url', desc: 'Seller URL', check: urlCheck },
    method: { type: 'string', metavar: 'verb', desc: `HTTP method, default GET (${METHODS.join('|')})`, check: (v) => (METHODS.includes(v.toUpperCase()) ? undefined : `must be one of ${METHODS.join('|')}`) },
    body: { type: 'string', metavar: 'text', desc: 'Request body (sent as application/json)' },
  },
  examples: ['npx tsx budget/tempo/preflight.ts --url https://mpp.dev/api/ping/paid'],
})

const url = args.url as string
const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET'
const body = typeof args.body === 'string' ? args.body : undefined

function result(state: 'ok' | 'failed', o: Record<string, unknown>): never {
  console.log(`RESULT ${JSON.stringify({ rail: 'tempo', state, ...o })}`)
  process.exit(state === 'ok' ? 0 : 1)
}

async function main() {
  let res: Response
  try {
    res = await fetch(url, { method, ...(body !== undefined ? { body, headers: { 'content-type': 'application/json' } } : {}), redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  } catch (err) {
    result('failed', { reason: `seller unreachable: ${oneLine((err as Error)?.message ?? err, 200)}`, next: 'check the seller URL' })
  }
  console.error(`unpaid request: HTTP ${res.status}`)
  if (res.status !== 402) result('failed', { reason: `the seller did not ask for payment (HTTP ${res.status})`, next: 'check the URL, the method and the body: a paid call answers 402 first' })
  const header = res.headers.get('www-authenticate') ?? ''
  const offers = tempoChargeChallenges(header)
  // every value here is the seller's: one line each
  for (const o of offers) console.error(`  offer: ${oneLine(`tempo.charge amount=${o.amount} currency=${o.currency} chainId=${o.methodDetails?.chainId} recipient=${o.recipient}`, 300)}`)
  const onModerato = offers.filter((o) => Number(o?.methodDetails?.chainId) === CHAIN_ID)
  if (!onModerato.length) {
    const other = /method="tempo"/.test(header) ? 'tempo offers only on another chain or another intent (a session or mainnet)' : 'no MPP tempo offer at all'
    result('failed', { reason: `no tempo.charge offer on Moderato (chain ${CHAIN_ID}): ${other}`, next: 'this seller cannot be paid from a tempo budget' })
  }
  // the buy's own checks, with no ceiling: only the seller's terms are judged here
  const checked = onModerato.map((o) => ({ o, c: precheckCharge(o, { maxBase: 2n ** 255n }) }))
  const good = checked.find((x) => x.c.ok)
  if (!good || !good.c.ok) {
    const why = checked.map((x) => (x.c.ok ? '' : x.c.reason)).filter(Boolean).join('; ')
    result('failed', { reason: `the seller's Moderato offer cannot be paid: ${why}`, next: 'this seller cannot be paid from a tempo budget' })
  }
  const price = fromBaseUnits(good.c.amount)
  const feePayer = good.o.methodDetails?.feePayer === true
  console.error(`price ${price} ${TOKEN_LABEL} to ${good.c.recipient}${feePayer ? '; the seller pays the network fee' : '; the fee is paid from the budget too'}`)
  result('ok', { price, payTo: good.c.recipient, offer: { token: TOKEN_LABEL, network: 'tempo-moderato', intent: 'charge', feePayer } })
}

main().catch((err) => result('failed', { reason: oneLine((err as Error)?.message ?? err, 300), next: 'read the output above' }))
