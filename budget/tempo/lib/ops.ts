// Operation journal (contract rule 5). One JSON file per operation under
// $SUPERSTABLES_HOME/budget/ops/tempo-moderato/<id>.json (../../paths.mjs), outside the code folder. It is written
// BEFORE anything is signed or submitted (intent) and updated after (tx, state). It holds no key.
import { readJournalFile, tempoOpProblem, writeJournalFile } from '../../journal.mjs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { opsDir } from '../../paths.mjs'

export const OPS_DIR = opsDir('tempo', 'moderato')

export type OpState =
  | 'quoted'
  | 'submitted'
  | 'settled'
  | 'failed'
  | 'refused_precheck'
  | 'refused_chain'
  | 'unknown'
  | 'not_found'

export type Op = {
  op: string
  rail: 'tempo'
  kind: 'buy' | 'pay'
  chain_final?: boolean | null
  state: OpState
  createdAt: string
  updatedAt: string
  intent: {
    url?: string
    method?: string
    bodySha256?: string
    amount: string // base units
    amountDecimal: string
    token: string
    recipient: string
    splits?: { recipient: string; amount: string }[]
    chainId: number
    owner: string
    agent: string
    challengeId?: string
    realm?: string
    mode?: string
    maxDecimal?: string
  }
  startBlock?: string
  memo?: string // the payment memo, known before signing; indexed on chain, finds this purchase without its tx hash
  expectedTx?: string // hash of the signed transaction, when known
  signedHash?: string // buy.ts: hash of the seller-bound signed payload (informational; a sponsored tx's final hash differs)
  validBefore?: number // unix seconds after which the signed payment can no longer land: estimated after signing (pull), read from the signed transaction before it is sent (push)
  tx?: string
  debit?: string
  delivered?: boolean
  httpStatus?: number
  reason?: string
  history: { at: string; state: OpState; note?: string }[]
}

// 64 random bits: an op id names a journal and its locks, and must neither collide nor be guessed
export const newOpId = () => `tempo-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(8).toString('hex')}`

const pathFor = (id: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`bad operation id ${JSON.stringify(id)}`)
  return join(OPS_DIR, `${id}.json`)
}

export function readOp(id: string): Op | undefined {
  return (readJournalFile(pathFor(id), id, tempoOpProblem) ?? undefined) as Op | undefined
}

export function writeOp(op: Op, note?: string): Op {
  const p = pathFor(op.op)
  const now = new Date().toISOString()
  const last = op.history[op.history.length - 1]
  if (!last || last.state !== op.state || note) op.history.push({ at: now, state: op.state, ...(note ? { note } : {}) })
  op.updatedAt = now
  writeJournalFile(p, JSON.stringify(op, null, 2) + '\n')
  return op
}

/** States in which an operation may not be started again under the same id. */
export const BLOCKING: OpState[] = ['submitted', 'unknown', 'settled']

export type ResultLine = {
  op: string
  chain_final?: boolean | null
  state: OpState
  tx: string | null
  debit: string | null
  remaining: string | null
  delivered: boolean | null
  next: string
  reason?: string
}

/** The final, machine-readable line of every purchase command. */
export function printResult(r: ResultLine) {
  console.log('RESULT ' + JSON.stringify({ rail: 'tempo', ...r, chain_final: r.state === 'settled' ? r.chain_final ?? null : null }))
}
