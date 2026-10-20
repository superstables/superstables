// One challenge, one purchase. A claim file per challenge under ops/tempo-moderato/claims/, created only if none exists
// (O_EXCL), before the agent key signs. The challenge is named by its payment memo (mppx's, from the challenge's realm and id)
// with the referral's slot zeroed: the same challenge paid under another referral, or none, is the same challenge. The memo
// is what binds a payment on chain to one purchase: two operations with one memo would both match one payment. Claims are
// never removed. Builds before the referral slot was zeroed named a claim by the whole memo, so a referred purchase left a
// file under another name: the key of each existing name is compared as well.
import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tempoChallengeKey } from '../../../src/core/referral-memo.mjs'
import { durableDirectory } from '../../journal.mjs'
import { OPS_DIR } from './ops.ts'

export const CLAIMS_DIR = join(OPS_DIR, 'claims')
const OP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** '' when `op` holds the claim on `memo` (now, or from an earlier run of the same op); otherwise who holds it, for words. */
export function claimChallenge(memo: string, op: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) throw new Error('the payment memo is not 32 bytes of hex')
  durableDirectory(CLAIMS_DIR)
  const name = tempoChallengeKey(memo).slice(2)
  // Names under the whole memo are only ever written by older builds, so looking for them before the exclusive create is enough
  // once those builds have stopped. An older build still buying from the same home looks only for its own names: no check here
  // can hold it back, so don't run one alongside.
  const held = readdirSync(CLAIMS_DIR).filter((n) => /^[0-9a-fA-F]{64}$/.test(n) && tempoChallengeKey(`0x${n}`).slice(2) === name)
  for (const n of held) {
    const verdict = against(claimHolder(join(CLAIMS_DIR, n)), op)
    if (verdict) return verdict
  }
  if (held.length) return ''
  const path = join(CLAIMS_DIR, name)
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return against(claimHolder(path), op)
  }
  try { writeSync(fd, `${op}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  const dir = openSync(CLAIMS_DIR, 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
  return ''
}

/** '' when `holder` is `op`; otherwise who holds the claim, for words ('' holder: the file is unreadable). */
function against(holder: string, op: string): string {
  return holder === op ? '' : holder === '' ? 'another operation' : `operation ${holder}`
}

/** The op id a claim file names, or '' (cut short, edited, a link or not a plain file). Never follows a link, never blocks. */
function claimHolder(path: string): string {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return ''
    const buf = Buffer.alloc(80)
    const text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8').trim()
    return OP_ID.test(text) ? text : ''
  } catch { return '' } finally { if (fd !== undefined) closeSync(fd) }
}
