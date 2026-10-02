// Types for precheck.mjs (the logic lives there so the plain .mjs helpers can use it too).
import { precheckCharge as check } from './precheck.mjs'

export type ChargeRequest = Record<string, any>
export type Precheck =
  | { ok: true; amount: bigint; recipient: string; splits: { recipient: string; amount: string }[] }
  | { ok: false; code: string; reason: string }
export const precheckCharge = check as (request: ChargeRequest, opts: { maxBase: bigint; payTo?: string }) => Precheck
export { tempoChargeChallenges } from './precheck.mjs'
export { budgetShortfall, recipientsOutsideScope, TRANSFER_WITH_MEMO_SELECTOR } from './precheck.mjs'
