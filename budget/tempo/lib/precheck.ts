// Types for precheck.mjs (the logic lives there so the plain .mjs helpers can use it too).
import { precheckCharge as check, precheckChallenge as checkChallenge } from './precheck.mjs'

export type ChargeRequest = Record<string, any>
export type Precheck =
  | { ok: true; amount: bigint; recipient: string; splits: { recipient: string; amount: string }[] }
  | { ok: false; code: string; reason: string }
export const precheckCharge = check as (request: ChargeRequest, opts: { maxBase: bigint; payTo?: string; agent?: string; owner?: string }) => Precheck
export const precheckChallenge = checkChallenge as (challenge: { id?: unknown; realm?: unknown; expires?: unknown }, nowMs?: number) => { ok: true } | { ok: false; code: string; reason: string }
export { tempoChargeChallenges, MAX_CHALLENGE_LIFETIME_S } from './precheck.mjs'
export { budgetShortfall, recipientsOutsideScope, TRANSFER_WITH_MEMO_SELECTOR } from './precheck.mjs'
