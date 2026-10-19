// What the agent key signed for a purchase, read back from the signed transaction before it leaves this process: exactly the
// quoted pathUSD transfers, and an expiry at most MAX_SIGNED_LIFETIME_S away. mppx builds the transaction; this checks it.
import { decodeFunctionData, isHex, type Hex } from 'viem'
import { Abis, Transaction } from 'viem/tempo'
import { TOKEN_ADDRESS, TOKEN_LABEL } from './common.ts'

/** The longest a signed purchase payment may stay valid, in seconds. mppx signs for 25. */
export const MAX_SIGNED_LIFETIME_S = 600

export type Quoted = { recipient: string; primary: bigint; memo: string; splits: { recipient: string; amount: string; memo?: string }[] }

/** `problem` is '' when `raw` is the quoted payment, with its signed expiry; otherwise it says what differs. Pure. */
export function signedPayment(raw: unknown, quoted: Quoted, nowS = Math.floor(Date.now() / 1000)): { problem: string; validBefore?: number } {
  let tx: { calls?: readonly { to?: string | null; data?: Hex; value?: bigint }[]; validBefore?: number | bigint }
  try {
    if (typeof raw !== 'string' || !isHex(raw)) throw new Error()
    tx = Transaction.deserialize(raw as Hex) as typeof tx
  } catch {
    return { problem: 'the signed payment could not be read' }
  }
  const want = [{ to: quoted.recipient, amount: quoted.primary, memo: quoted.memo }, ...quoted.splits.map((s) => ({ to: s.recipient, amount: BigInt(s.amount), memo: s.memo }))]
  const calls = tx.calls ?? []
  if (calls.length !== want.length) return { problem: `it makes ${calls.length} calls, not the ${want.length} ${TOKEN_LABEL} transfer${want.length === 1 ? '' : 's'} quoted` }
  for (const [i, c] of calls.entries()) {
    const w = want[i]
    let d: { functionName: string; args?: readonly unknown[] } | undefined
    try { d = c.data ? decodeFunctionData({ abi: Abis.tip20, data: c.data }) : undefined } catch {}
    const [to, amount, memo] = (d?.args ?? []) as [string?, bigint?, string?]
    const plain = d?.functionName === (w.memo ? 'transferWithMemo' : 'transfer')
    if (String(c.to).toLowerCase() !== TOKEN_ADDRESS.toLowerCase() || (c.value ?? 0n) !== 0n || !plain
      || String(to).toLowerCase() !== w.to.toLowerCase() || amount !== w.amount || (w.memo && String(memo).toLowerCase() !== w.memo.toLowerCase())) {
      return { problem: `call ${i + 1} is not the quoted ${TOKEN_LABEL} transfer` }
    }
  }
  const vb = Number(tx.validBefore ?? 0)
  if (!vb) return { problem: 'it has no expiry' }
  if (vb - nowS > MAX_SIGNED_LIFETIME_S) return { problem: `it stays valid for ${vb - nowS} s; this client signs payments valid for at most ${MAX_SIGNED_LIFETIME_S} s` }
  return { problem: '', validBefore: vb }
}
