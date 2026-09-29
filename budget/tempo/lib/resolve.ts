// Reads the chain to decide what happened to a journaled purchase. Never sends anything.
import type { Address, Hex } from 'viem'
import { chainHead, findByMemo, getReceipt, getTxSigner, settlementOf, sleep, type ChainReceipt } from './chain.ts'
import type { Op } from './ops.ts'

export type Lookup =
  | { kind: 'found'; hash: Hex; receipt: ChainReceipt; keyId?: string }
  | { kind: 'expired' } // the signed payment can no longer land and none is on chain
  | { kind: 'pending' } // nothing on chain yet and it may still land

/** Slack after validBefore before a missing payment is called expired (block time and clock skew). */
export const EXPIRY_SLACK_S = 10

/**
 * One pass. Candidates: the seller's receipt hash, the hash we knew before sending, and every
 * transaction on chain carrying this purchase's memo (an indexed event topic). A payment can only be
 * `expired` (no funds moved, ever) when it was signed with an expiring nonce and the chain clock is
 * past its validBefore.
 */
export async function lookupOnce(op: Op, extraHashes: string[] = []): Promise<Lookup> {
  const hashes = new Set<string>([...extraHashes, op.tx, op.expectedTx].filter(Boolean) as string[])
  if (op.memo) {
    const memoHits = await findByMemo(op.intent.owner as Address, op.intent.recipient as Address, op.memo as Hex, BigInt(op.startBlock ?? 0)).catch(() => [])
    for (const h of memoHits) hashes.add(h)
  }
  let firstFound: Lookup | undefined
  for (const h of hashes) {
    const receipt = await getReceipt(h).catch(() => null)
    if (!receipt) continue
    const signer = await getTxSigner(h).catch(() => null)
    const found: Lookup = { kind: 'found', hash: h as Hex, receipt, keyId: signer?.keyId }
    // prefer a successful payment over a reverted duplicate
    if (receipt.status === 'success') return found
    firstFound ??= found
  }
  if (firstFound) return firstFound
  if (op.validBefore) {
    const head = await chainHead().catch(() => null)
    if (head && head.timestamp > op.validBefore + EXPIRY_SLACK_S) {
      // last read: a payment mined in the final blocks must not be called expired
      if (op.memo) {
        const again = await findByMemo(op.intent.owner as Address, op.intent.recipient as Address, op.memo as Hex, BigInt(op.startBlock ?? 0)).catch(() => null)
        if (again === null) return { kind: 'pending' } // could not read: never claim "expired" on a failed read
        if (again.length) return lookupOnce(op, extraHashes)
      }
      return { kind: 'expired' }
    }
  }
  return { kind: 'pending' }
}

/** Polls `lookupOnce` every second until it is decided or `maxMs` passes. */
export async function waitForOutcome(op: Op, maxMs: number, extraHashes: string[] = []): Promise<Lookup> {
  const deadline = Date.now() + maxMs
  for (;;) {
    const r = await lookupOnce(op, extraHashes)
    if (r.kind !== 'pending' || Date.now() > deadline) return r
    await sleep(1000)
  }
}

/** settled / failed / unknown for a found payment. */
export function judge(op: Op, found: Extract<Lookup, { kind: 'found' }>, primaryAmount: bigint) {
  const s = settlementOf(found.receipt, { owner: op.intent.owner, recipient: op.intent.recipient, amount: primaryAmount })
  const byAgent = !found.keyId || found.keyId.toLowerCase() === op.intent.agent.toLowerCase()
  if (s.settled && byAgent) return { state: 'settled' as const, debit: s.debit, note: 'matched' }
  if (s.settled && !byAgent) return { state: 'unknown' as const, debit: s.debit, note: `matching transfer, but signed by keychain key ${found.keyId}, not the agent key` }
  if (found.receipt.status === 'reverted') return { state: 'failed' as const, debit: 0n, note: 'payment transaction reverted on chain' }
  return { state: 'unknown' as const, debit: s.debit, note: s.note }
}
