// setBudget(amount, expiry, sellers?) -- owner signs.
//
// On-chain primitive: AccountKeychain.authorizeKey (precompile
// 0xaAAAaaAA00000000000000000000000000000000), called via the owner's root
// key. Sets a per-token spending limit (pathUSD), an expiry, and an optional
// recipient allowlist (TIP-1011 call scoping on the transfer/transferWithMemo/
// approve selectors) for the agent's access key.
//
// What can move by expiry (contract rule 2), as measured on Moderato:
//   * no --period-seconds: one-time limit. Exactly `amount` in total, ever.
//   * --period-seconds P: the remaining amount resets to the full `amount` whenever the chain time
//     reaches periodEnd, and the first window starts at authorization. Every window that starts
//     before expiry can be spent in full, so the total by expiry is
//         amount x ceil(expirySeconds / P).
//     This script prints that number before it sends, and again from chain reads afterwards. With P >=
//     expirySeconds there is exactly one window and the total is `amount`.
//   * Fees paid in pathUSD by the owner count against the same limit, so principal is at most this.
// The script refuses (exit 3) if the agent key is already authorized or revoked: authorizeKey on a live
// key reverts with KeyAlreadyExists and a revoked key can never be authorized again. To change a
// budget, revoke it and grant a fresh key. Nothing is overwritten.
//
// Usage:
//   npx tsx budget/tempo/setBudget.ts --agent 2 --amount 1 --expiry-seconds 86400
//   npx tsx budget/tempo/setBudget.ts --agent 2 --amount 1 --expiry-seconds 86400 --sellers <addrA>,<addrB>
//   npx tsx budget/tempo/setBudget.ts --agent 2 --amount 0.1 --period-seconds 3600 --expiry-seconds 7200   # recurring: max 0.2

import { Scopes } from 'viem/tempo'
import type { Address } from 'viem'
import { addressListCheck, decimalCheck, intCheck, labelCheck, parseCli } from './lib/args.mjs'
import {
  TOKEN_ADDRESS,
  TOKEN_LABEL,
  explorerTx,
  fromBaseUnits,
  loadOwnerEnv,
  makeClient,
  ownerAccount,
  resolveAgentAddress,
  toBaseUnits,
} from './lib/common.ts'
import { chainHead, readKey } from './lib/chain.ts'

const { values: args } = parseCli({
  name: 'setBudget.ts',
  summary: `Authorize an agent access key with a ${TOKEN_LABEL} limit and an expiry (owner signs). Prints the most that can move by expiry.`,
  flags: {
    amount: { type: 'string', required: true, metavar: 'amount', desc: `Limit in ${TOKEN_LABEL} (per period with --period-seconds, in total without)`, check: decimalCheck(6) },
    'expiry-seconds': { type: 'string', required: true, metavar: 'seconds', desc: 'Key lifetime from now', check: intCheck(1) },
    'period-seconds': { type: 'string', metavar: 'seconds', desc: 'Recurring limit: the amount resets every period', check: intCheck(1) },
    sellers: { type: 'string', metavar: 'a,b', desc: 'Only these recipients (transfer and transferWithMemo)', check: addressListCheck },
    agent: { type: 'string', metavar: 'label', desc: 'Agent label (AGENT<label>_ADDRESS); omit for the primary agent', check: labelCheck },
  },
  examples: ['npx tsx budget/tempo/setBudget.ts --agent 2 --amount 1 --expiry-seconds 86400'],
})

async function main() {
  const amount = args.amount as string
  const expirySeconds = Number(args['expiry-seconds'])
  const periodSeconds = args['period-seconds'] ? Number(args['period-seconds']) : undefined
  const agentLabel = typeof args.agent === 'string' ? args.agent : ''
  const sellers = typeof args.sellers === 'string' ? args.sellers.split(',').map((s) => s.trim()) : undefined

  const env = loadOwnerEnv()
  const owner = ownerAccount(env)
  const agentAddress = resolveAgentAddress(env, agentLabel)
  const limit = toBaseUnits(amount)

  // Refuse before signing if the key is already authorized or burned.
  const key = await readKey(owner.address, agentAddress)
  if (key.exists || key.revoked) {
    console.log(`REFUSED: agent key ${agentAddress} is already ${key.revoked ? 'revoked (a revoked key can never be authorized again; create a new agent label with setup.ts --extra-agent)' : 'authorized (expiry ' + new Date(key.expiry * 1000).toISOString() + ', remaining ' + fromBaseUnits(key.remaining) + '). Revoke it first, then grant a fresh key'}. Nothing was sent.`)
    process.exit(3)
  }

  const head = await chainHead()
  const expiry = head.timestamp + expirySeconds
  const windows = periodSeconds ? Math.ceil(expirySeconds / periodSeconds) : 1
  const maxByExpiry = limit * BigInt(windows)

  console.log(`Authorizing agent access key ${agentAddress} on owner ${owner.address}`)
  console.log(`  limit: ${amount} ${TOKEN_LABEL} (${limit} base units)${periodSeconds ? `, resets every ${periodSeconds}s` : ' (one-time, no reset)'}`)
  console.log(`  expiry: ${new Date(expiry * 1000).toISOString()} (unix ${expiry}, chain time + ${expirySeconds}s)`)
  console.log(`  sellers: ${sellers ? sellers.join(', ') : 'any (allowAnyCalls)'}`)
  console.log(`  MAXIMUM THAT CAN MOVE BY EXPIRY: ${fromBaseUnits(maxByExpiry)} ${TOKEN_LABEL} (${windows} window${windows === 1 ? '' : 's'} x ${amount})`)

  // Scope both plain transfer() and transferWithMemo() (what MPP's tempo.charge sends) to the allowlist.
  const scopes = sellers
    ? [
        Scopes.tip20(TOKEN_ADDRESS).transfer({ recipients: sellers as Address[] }),
        Scopes.tip20(TOKEN_ADDRESS).transferWithMemo({ recipients: sellers as Address[] }),
      ]
    : undefined

  const client = makeClient(owner)
  const { receipt } = await client.accessKey.authorizeSync({
    accessKey: { address: agentAddress, type: 'secp256k1' },
    expiry,
    limits: [{ token: TOKEN_ADDRESS, limit, period: periodSeconds }],
    scopes,
  })

  console.log(`\ntx hash: ${receipt.transactionHash}`)
  console.log(`explorer: ${explorerTx(receipt.transactionHash)}`)
  console.log(`status: ${receipt.status}`)

  // Read back what the chain stored and recompute the maximum from it.
  const after = await readKey(owner.address, agentAddress)
  console.log(`readback: remaining ${fromBaseUnits(after.remaining)}, expiry ${after.expiry}, periodEnd ${after.periodEnd || 'none (one-time)'}`)
  if (periodSeconds && after.periodEnd) {
    const start = after.periodEnd - periodSeconds
    const trueWindows = Math.ceil((after.expiry - start) / periodSeconds)
    console.log(`readback maximum by expiry: ${fromBaseUnits(limit * BigInt(trueWindows))} ${TOKEN_LABEL} (first window started at ${start}, ${trueWindows} window${trueWindows === 1 ? '' : 's'})`)
  } else if (!periodSeconds) {
    console.log(`readback maximum by expiry: ${fromBaseUnits(after.remaining)} ${TOKEN_LABEL} (one-time)`)
  }
}

main().catch((err) => {
  console.error('setBudget failed:', err?.shortMessage ?? err?.message ?? err)
  process.exit(1)
})
