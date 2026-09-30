// Reads the chain to decide what happened to a journaled purchase. Never sends anything.
import type { Address, Hex } from 'viem'
import { chainHead, findByMemo, getReceipt, getTxSigner, settlementOf, sleep, type ChainReceipt } from './chain.ts'
import type { Op } from './ops.ts'

export type Lookup =
  | { kind: 'found'; hash: Hex; receipt: ChainReceipt; keyId?: string; from?: string }
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
  // our own signed hash (push mode) is bound by itself; anything else must carry the memo
  if (op.memo) {
    const memoHits = await findByMemo(op.intent.owner as Address, op.intent.recipient as Address, op.memo as Hex, BigInt(op.startBlock ?? 0)).catch(() => [])
    for (const h of memoHits) hashes.add(h)
  }
  // Prefer, in order: a successful payment bound to this operation, any bound one, then anything found (judge calls an
  // unbound one unknown). A seller's reference to an unrelated transaction never hides the memo hit.
  let firstBound: Lookup | undefined
  let firstFound: Lookup | undefined
  for (const h of hashes) {
    const receipt = await getReceipt(h).catch(() => null)
    if (!receipt) continue
    const signer = await getTxSigner(h).catch(() => null)
    const found = { kind: 'found' as const, hash: h as Hex, receipt, keyId: signer?.keyId, from: signer?.from }
    const bound = bindingProblems(op, found).length === 0
    if (bound && receipt.status === 'success') return found
    if (bound) firstBound ??= found
    firstFound ??= found
  }
  if (firstBound) return firstBound
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
    // an unbound transaction (for example a seller's reference to an older payment) is not an answer: keep looking
    const decided = r.kind === 'expired' || (r.kind === 'found' && bindingProblems(op, r).length === 0)
    if (decided || Date.now() > deadline) return r
    await sleep(1000)
  }
}

/**
 * What binds a found transaction to THIS operation. A hash can come from the seller (its receipt
 * reference) or from --tx, so it is only a pointer: an old payment of the same amount to the same
 * seller must never count as this purchase. Empty means bound.
 *   - mined at or after the block this operation recorded before signing (op.startBlock)
 *   - carries this purchase's memo on a TransferWithMemo owner -> recipient (op.memo)
 *   - sent from the owner's account and signed by the agent's access key (keyId), both read from the chain
 */
export function bindingProblems(op: Op, found: Extract<Lookup, { kind: 'found' }>): string[] {
  const out: string[] = []
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
  if (op.startBlock === undefined) out.push('the journal has no starting block for this operation')
  else if (found.receipt.blockNumber < BigInt(op.startBlock)) out.push(`mined in block ${found.receipt.blockNumber}, before this operation started (block ${op.startBlock})`)
  // our own signed hash (push mode) is bound by itself; anything else must carry the memo
  if (op.memo && !same(found.hash, op.expectedTx)) {
    const memo = op.memo.toLowerCase()
    const hit = found.receipt.memos.some((m) => m.memo.toLowerCase() === memo && same(m.from, op.intent.owner) && same(m.to, op.intent.recipient))
    if (!hit) out.push("it does not carry this purchase's memo")
  } else if (!same(found.hash, op.expectedTx)) out.push('this operation has no memo, and the hash is not the one it signed')
  if (!found.keyId) out.push('the chain names no access key for it')
  else if (!same(found.keyId, op.intent.agent)) out.push(`signed by keychain key ${found.keyId}, not the agent key`)
  if (!same(found.from, op.intent.owner)) out.push(`sent from ${found.from ?? 'an unknown account'}, not the owner ${op.intent.owner}`)
  return out
}

/** settled / failed / unknown for a found payment. */
export function judge(op: Op, found: Extract<Lookup, { kind: 'found' }>, primaryAmount: bigint) {
  const unbound = bindingProblems(op, found)
  if (unbound.length) return { state: 'unknown' as const, debit: 0n, note: `transaction ${found.hash} is not bound to this purchase: ${unbound.join('; ')}` }
  const s = settlementOf(found.receipt, { owner: op.intent.owner, recipient: op.intent.recipient, amount: primaryAmount })
  if (s.settled) return { state: 'settled' as const, debit: s.debit, note: 'matched' }
  if (found.receipt.status === 'reverted') return { state: 'failed' as const, debit: 0n, note: 'payment transaction reverted on chain' }
  return { state: 'unknown' as const, debit: s.debit, note: s.note }
}
