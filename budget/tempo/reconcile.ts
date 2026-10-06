// reconcile(op) -- reads the chain and settles the journal of one purchase. NEVER pays, never signs,
// opens no key file.
//
// For an operation whose state is `submitted` or `unknown` (an interrupted buy, a lost answer, a seller
// HTTP error) it looks for the payment on chain: by the seller's receipt hash if the journal has one,
// and by the purchase memo (an indexed TransferWithMemo topic) from the block the operation started.
//   settled    the payment's own transaction succeeded with a pathUSD Transfer owner -> recipient of the
//              price, signed by the agent key. `delivered` is whatever the seller answered, unchanged.
//   failed     the payment transaction was mined and reverted (nothing moved).
//   not_found  nothing on chain and the signed payment can no longer land (it carried an expiring nonce
//              and the chain clock is past its validBefore). No funds moved.
//   unknown    nothing on chain yet but it still could land, or the chain shows something unexpected.
//              Run again later.
// An operation that never got past `quoted` was never signed: it becomes not_found.
//
// Usage: npx tsx budget/tempo/reconcile.ts --op <id> [--tx <hash>] [--wait <seconds>]
// Exit codes: 0 settled or already final without loss, 1 failed / not_found, 2 bad usage, 5 unknown.

import type { Address } from 'viem'
import { requireRecordLock } from '../op-lock.mjs'
import { hashCheck, intCheck, opIdCheck, parseCli } from './lib/args.mjs'
import { explorerTx, fromBaseUnits, toBaseUnits, oneLine } from './lib/common.ts'
import { readKey } from './lib/chain.ts'
import { judge, lookupOnce, waitForOutcome } from './lib/resolve.ts'
import { OPS_DIR, printResult, readOp, writeOp, type OpState } from './lib/ops.ts'

const { values: args } = parseCli({
  name: 'reconcile.ts',
  summary: 'Read the chain and settle the journal of one purchase (settled, failed, not_found, unknown). Never pays.',
  flags: {
    op: { type: 'string', required: true, metavar: 'id', desc: 'Operation id from buy.ts', check: opIdCheck },
    tx: { type: 'string', metavar: 'hash', desc: 'A transaction hash to check as well (e.g. from the seller)', check: hashCheck },
    wait: { type: 'string', metavar: 'seconds', desc: 'Keep polling up to this long while the outcome is undecided (default: one pass)', check: intCheck(1) },
  },
  examples: ['npx tsx budget/tempo/reconcile.ts --op tempo-20260929120000-a1b2c3'],
})

const opId = args.op as string

async function main() {
  requireRecordLock(OPS_DIR, opId)
  const op = readOp(opId)
  if (!op) {
    console.error(`No journal for operation ${opId} under ${OPS_DIR}`)
    process.exit(2)
  }
  const done = (state: OpState, f: { tx?: string; debit?: bigint | null; reason?: string; next?: string; exit: number }): never => {
    const alreadySettled = op.state === 'settled'
    op.state = state
    if (f.tx) op.tx = f.tx
    if (f.reason) op.reason = f.reason
    if (f.debit != null) op.debit = fromBaseUnits(f.debit)
    if (!alreadySettled) writeOp(op, `reconcile: ${f.reason ?? state}`)
    return readKey(op.intent.owner as Address, op.intent.agent as Address).then(
      (k) => k.remaining,
      () => null,
    ).then((remaining) => {
      printResult({
        op: opId,
        state,
        tx: op.tx ?? null,
        debit: f.debit === undefined || f.debit === null ? null : fromBaseUnits(f.debit),
        remaining: remaining === null ? null : fromBaseUnits(remaining),
        delivered: op.delivered ?? null,
        next: f.next ?? 'none',
        ...(f.reason ? { reason: f.reason } : {}),
      })
      process.exit(f.exit)
    }) as never
  }

  // the reason, recipient and receipt tx may be the seller's text: one line (oneLine)
  console.log(oneLine(`op ${opId} (${op.kind}): journal says ${op.state}${op.reason ? ` (${op.reason})` : ''}; ${op.intent.amountDecimal} pathUSD to ${op.intent.recipient}${op.tx ? `; tx ${op.tx}` : ''}`, 2000))

  if (op.state === 'settled') return done('settled', { tx: op.tx, debit: op.debit == null ? BigInt(op.intent.amount) : toBaseUnits(op.debit), next: op.delivered === false ? 'paid but not delivered; never pay again, contact the seller with the tx hash' : 'none', exit: 0 })

  if (op.state === 'refused_precheck' || op.state === 'refused_chain' || (op.state === 'quoted' && op.reason === 'quote_only')) {
    console.log('Nothing was signed for this operation. Nothing to reconcile.')
    return done(op.state, { reason: op.reason, exit: op.state === 'quoted' ? 0 : 3 })
  }
  if (op.state === 'quoted') {
    console.log('The operation never got past the quote: nothing was signed or sent.')
    return done('not_found', { debit: 0n, reason: 'never signed: interrupted before the payment was created', next: 'no funds moved; safe to retry with a new op id', exit: 1 })
  }

  const extra = typeof args.tx === 'string' ? [args.tx as string] : []
  const maxMs = typeof args.wait === 'string' ? Number(args.wait) * 1000 : 0
  const outcome = maxMs ? await waitForOutcome(op, maxMs, extra) : await lookupOnce(op, extra)
  const splitTotal = (op.intent.splits ?? []).reduce((s, x) => s + BigInt(x.amount), 0n)
  const primary = BigInt(op.intent.amount) - splitTotal

  if (outcome.kind === 'found') {
    const j = judge(op, outcome, primary)
    console.log(`chain: tx ${outcome.hash} ${outcome.receipt.status} in block ${outcome.receipt.blockNumber}; keychain keyId ${outcome.keyId ?? 'n/a'}`)
    console.log(`explorer: ${explorerTx(outcome.hash)}`)
    if (j.state === 'settled') {
      console.log(`SETTLED: ${fromBaseUnits(j.debit)} pathUSD left the owner in the payment's own transaction. delivered stays ${op.delivered ?? 'unrecorded'}.`)
      return done('settled', { tx: outcome.hash, debit: j.debit, next: op.delivered === false ? 'paid but not delivered; never pay again, contact the seller with the tx hash' : 'none', exit: 0 })
    }
    if (j.state === 'failed') {
      console.log('FAILED: mined and reverted. No funds moved.')
      return done('failed', { tx: outcome.hash, debit: 0n, reason: j.note, next: 'safe to retry with a new op id', exit: 1 })
    }
    console.log(`UNKNOWN: ${j.note}`)
    return done('unknown', { tx: outcome.hash, reason: j.note, next: `read ${explorerTx(outcome.hash)}`, exit: 5 })
  }
  if (outcome.kind === 'expired') {
    console.log('NOT FOUND: no transaction with this purchase memo is on chain and the signed payment has expired, so it can never land. No funds moved.')
    return done('not_found', { debit: 0n, reason: 'signed payment expired unsent; nothing on chain for its memo', next: 'no funds moved; safe to retry with a new op id', exit: 1 })
  }
  console.log('UNKNOWN: nothing on chain yet, and the signed payment may still land. Run reconcile again after its validBefore has passed.')
  return done('unknown', { reason: 'not on chain yet', next: `npx tsx budget/tempo/reconcile.ts --op ${opId}`, exit: 5 })
}

main().catch((err) => {
  console.error('reconcile failed:', String(err?.message ?? err).slice(0, 300))
  process.exit(1)
})
