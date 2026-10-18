// The sentences for what a failed or missing Tempo payment cost. A payment the chain refuses (SpendingLimitExceeded, or any
// revert) moves no price to the seller, but the network fee is charged all the same, to the owner's account and against the
// access key's limit when the owner pays it (measured on Moderato, 16 October 2026). So "no funds moved" is not true of it.
import { TOKEN_LABEL, fromBaseUnits } from './common.ts'

/** What a reverted payment cost: its fee when the receipt shows it, and who paid. */
export function feeSentence(fee: bigint | undefined, feePayer: string | undefined, owner: string): string {
  if (feePayer && feePayer.toLowerCase() !== owner.toLowerCase()) return 'the seller\'s fee payer paid the network fee, so the owner was not charged.'
  const amount = fee === undefined ? 'a network fee' : `a network fee of ${fromBaseUnits(fee)} ${TOKEN_LABEL}`
  return `${amount} was still charged to the owner's account and counts against the budget.`
}

/** The `next` for a reverted payment: the same fee facts as feeSentence, for the agent. */
export function failedNext(feePayer: string | undefined, owner: string): string {
  if (feePayer && feePayer.toLowerCase() !== owner.toLowerCase()) return 'read the tx on the explorer; the price was not paid and the seller\'s fee payer paid the network fee; safe to retry with a new op id'
  return 'read the tx on the explorer; the price was not paid, but a network fee was charged to the owner\'s account; safe to retry with a new op id'
}

/** The ending of the not-found sentence: the fall in the budget as a reading when it is known, else what the mode allows. */
export function notFoundFee(budgetFall: bigint, mode?: string): string {
  if (budgetFall > 0n) return `The price was not paid. The budget fell by ${fromBaseUnits(budgetFall)} ${TOKEN_LABEL} while this purchase was open: a payment the chain refused still costs its network fee, and other purchases with this key count too.`
  if (mode === 'push') return 'The price was not paid, and the signed payment can no longer land.'
  return 'The price was not paid. If the seller sent the payment and the chain refused it, a network fee may still have been charged; check the budget.'
}

/** The `next` for a not-found payment, matching notFoundFee. */
export function notFoundNext(budgetFall: bigint, mode?: string): string {
  if (budgetFall > 0n) return `the price was not paid; the budget fell by ${fromBaseUnits(budgetFall)} ${TOKEN_LABEL} while this purchase was open (a refused payment's network fee, or other purchases with this key); safe to retry with a new op id`
  if (mode === 'push') return 'the price was not paid; safe to retry with a new op id'
  return 'the price was not paid; a payment the chain refused can still cost a network fee, so check the budget; safe to retry with a new op id'
}
