// One challenge, one purchase. A claim file per payment memo under ops/tempo-moderato/claims/, created only if none exists
// (O_EXCL), before the agent key signs. The memo (mppx's, from the challenge's realm and id) is what binds a payment on chain
// to one purchase: two operations with one memo would both match one payment. Claims are never removed.
import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { durableDirectory } from '../../journal.mjs'
import { OPS_DIR } from './ops.ts'

export const CLAIMS_DIR = join(OPS_DIR, 'claims')
const OP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** '' when `op` holds the claim on `memo` (now, or from an earlier run of the same op); otherwise who holds it, for words. */
export function claimChallenge(memo: string, op: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(memo)) throw new Error('the payment memo is not 32 bytes of hex')
  durableDirectory(CLAIMS_DIR)
  const path = join(CLAIMS_DIR, memo.slice(2).toLowerCase())
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const holder = claimHolder(path)
    return holder === op ? '' : holder === '' ? 'another operation' : `operation ${holder}`
  }
  try { writeSync(fd, `${op}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  const dir = openSync(CLAIMS_DIR, 'r')
  try { fsyncSync(dir) } finally { closeSync(dir) }
  return ''
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
