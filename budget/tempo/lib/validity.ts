import type { agentAccessKeyAccount } from './common.ts'

type SignTransaction = ReturnType<typeof agentAccessKeyAccount>['signTransaction']

/** mppx's local expiring-nonce payment lifetime, captured before credential creation. */
export function pushValidityBound(expires?: string, now = Date.now()): number {
  const defaultExpiry = Math.floor(now / 1000) + 25
  return expires ? Math.min(defaultExpiry, Math.floor(Date.parse(expires) / 1000)) : defaultExpiry
}

/** Preparation may stall. The local signer must not extend the already journaled lifetime. */
export function boundedSignTransaction(sign: SignTransaction, bound: () => number | undefined): SignTransaction {
  return (transaction, options) => {
    const limit = bound()
    if (limit === undefined) return sign(transaction, options)
    const expiry = 'validBefore' in transaction && typeof transaction.validBefore === 'number'
      ? Math.min(transaction.validBefore, limit) : limit
    return sign({ ...transaction, validBefore: expiry }, options)
  }
}
