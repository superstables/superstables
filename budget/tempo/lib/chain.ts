// Chain reads for the Tempo scripts. Reads retry with backoff; nothing here sends a transaction, so
// a retry can never pay twice.
import { finalityFor } from "../../../src/core/finality-policy.js";
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { CHAIN_ID, RPC_URL, TOKEN_ADDRESS, fromBaseUnits, makeClient, oneLine } from './common.ts'
import { readRpcAnswer } from '../../rpc.mjs'
import { TRANSFER_WITH_MEMO_SELECTOR, maxFeeUnits } from './precheck.mjs'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const topicOf = (a: string) => ('0x' + a.toLowerCase().replace('0x', '').padStart(64, '0')) as Hex

/**
 * One JSON-RPC exchange with RPC_URL, its answer read through readRpcAnswer (../../rpc.mjs): at most RPC_MAX_BYTES, and
 * the RPC's error text only as one short line. An HTTP error status, or an answer longer than the cap, cut off, or not
 * JSON, throws an error marked `answer` in this client's words (`overCap` when it was longer than the cap).
 */
async function exchange(method: string, params: unknown[], timeoutMs: number): Promise<{ result?: any; error?: { message: string; reverted: boolean } }> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    res.body?.cancel().catch(() => {})
    throw Object.assign(new Error(`HTTP ${res.status}`), { answer: true })
  }
  try {
    return await readRpcAnswer(res)
  } catch (e) {
    throw Object.assign(e as Error, { answer: true })
  }
}

/** JSON-RPC read with up to 4 attempts. Throws on transport errors and on JSON-RPC errors. */
export async function rpcRead(method: string, params: unknown[]): Promise<any> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const answer = await exchange(method, params, 15_000)
      if (!answer.error) return answer.result
      const err = new Error(`${method}: ${answer.error.message}`) as Error & { rpcError?: boolean }
      err.rpcError = true
      // a revert is a definite answer from the chain: do not retry it. Anything else (lag, gateway) is retried.
      if (answer.error.reverted) throw err
      last = err
    } catch (e) {
      if ((e as any)?.rpcError) throw e
      const named = (e as any)?.answer ? new Error(`${method}: ${(e as Error).message}`) : e
      // an answer longer than the cap would be read in full again: refuse it at once
      if ((e as any)?.overCap) throw named
      last = named
    }
    await sleep(400 * 2 ** attempt)
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** The RPC's host, for words: a replacement's path or query can carry an access key, so never the whole URL. */
const RPC_HOST = (() => { try { return new URL(RPC_URL).host } catch { return 'the Tempo RPC' } })()
/** What to do when the RPC is on another chain. */
export const RPC_CHAIN_NEXT = 'unset SUPERSTABLES_TEMPO_RPC, or set it to a Tempo Moderato RPC'
/**
 * Why RPC_URL must not be used for a purchase, in words, or '' when it answers Tempo Moderato's chain id. A payment is signed
 * for Moderato whatever the RPC is: viem and mppx never ask the RPC its chain before a push-mode broadcast, so one on another
 * chain would be handed the signed payment, and every outcome read there would be another chain's. Unreadable is a reason too.
 */
export async function rpcChainProblem(): Promise<string> {
  const id = await rpcRead('eth_chainId', []).catch((err: Error) => err)
  if (id instanceof Error) return `could not read which chain the Tempo RPC ${RPC_HOST} is on (${oneLine(id.message, 160)})`
  return Number(id) === CHAIN_ID ? '' : `the Tempo RPC ${RPC_HOST} is not on Tempo Moderato (its chain id is ${oneLine(String(id), 40)}, expected ${CHAIN_ID})`
}

export type ChainReceipt = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  transactionHash: Hex
  feePayer?: Address
  from?: Address
  /** The network fee the transaction was charged, in base units: ceil(gasUsed * effectiveGasPrice / 1e12), as measured. Undefined when the receipt lacks either field. */
  fee?: bigint
  transfers: { token: Address; from: Address; to: Address; value: bigint }[]
  /** TIP-20 TransferWithMemo events: the memo binds a payment to one purchase. */
  memos: { token: Address; from: Address; to: Address; memo: Hex }[]
}

/** The fee a receipt shows, in base units of the 6-decimal fee token (1e12 attodollars each), rounded up. Undefined when unreadable. */
export function feeOf(r: { gasUsed?: unknown; effectiveGasPrice?: unknown }): bigint | undefined {
  const q = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)
  if (!q(r.gasUsed) || !q(r.effectiveGasPrice)) return undefined
  const n = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)
  return (n + 10n ** 12n - 1n) / 10n ** 12n
}

/** Tempo has instant BFT finality. A receipt still needs canonical committed inclusion. */
export async function getReceipt(hash: string): Promise<ChainReceipt | null> {
  const r = await rpcRead('eth_getTransactionReceipt', [hash])
  if (!r) return null
  const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)
  const blockHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
  if (!blockHash(r.transactionHash) || r.transactionHash.toLowerCase() !== hash.toLowerCase() || !quantity(r.blockNumber) || !blockHash(r.blockHash) || !Array.isArray(r.logs) || r.logs.some((l: { removed?: boolean }) => l?.removed) || !['0x0', '0x1'].includes(r.status)) throw new Error('transaction inclusion unreadable')
  const head = await rpcRead('eth_getBlockByNumber', [finalityFor('tempo', 'moderato') === 'instant' ? 'latest' : 'finalized', false])
  if (!quantity(head?.number) || BigInt(r.blockNumber) > BigInt(head.number)) throw new Error('transaction is not in a committed block')
  const block = await rpcRead('eth_getBlockByNumber', [r.blockNumber, false])
  if (!quantity(block?.number) || BigInt(block.number) !== BigInt(r.blockNumber) || !blockHash(block?.hash) || block.hash.toLowerCase() !== r.blockHash.toLowerCase()) throw new Error('transaction canonical inclusion unreadable')
  return {
    status: r.status === '0x1' ? 'success' : 'reverted',
    blockNumber: BigInt(r.blockNumber),
    transactionHash: r.transactionHash,
    feePayer: r.feePayer,
    from: r.from,
    fee: feeOf(r),
    transfers: (r.logs ?? [])
      .filter((l: any) => l.topics?.[0] === TRANSFER_TOPIC && l.topics.length === 3)
      .map((l: any) => ({
        token: l.address,
        from: ('0x' + l.topics[1].slice(26)) as Address,
        to: ('0x' + l.topics[2].slice(26)) as Address,
        value: BigInt(l.data.slice(0, 66)),
      })),
    memos: (r.logs ?? [])
      .filter((l: any) => l.topics?.[0] === TRANSFER_WITH_MEMO_TOPIC && l.topics.length === 4)
      .map((l: any) => ({
        token: l.address,
        from: ('0x' + l.topics[1].slice(26)) as Address,
        to: ('0x' + l.topics[2].slice(26)) as Address,
        memo: l.topics[3] as Hex,
      })),
  }
}

/** The transaction's signer facts: `from` (the owner for keychain transactions) and the keychain keyId. */
export async function getTxSigner(hash: string): Promise<{ from?: Address; keyId?: Address } | null> {
  const t = await rpcRead('eth_getTransactionByHash', [hash])
  if (!t) return null
  return { from: t.from, keyId: t.signature?.keyId ?? undefined }
}

export async function chainHead(): Promise<{ number: bigint; timestamp: number }> {
  const b = await rpcRead('eth_getBlockByNumber', [finalityFor('tempo', 'moderato') === 'instant' ? 'latest' : 'finalized', false])
  return { number: BigInt(b.number), timestamp: parseInt(b.timestamp, 16) }
}

export async function pathUsdBalance(address: string): Promise<bigint> {
  const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0')
  return BigInt(await rpcRead('eth_call', [{ to: TOKEN_ADDRESS, data }, 'latest']))
}

/**
 * The most the network fee of a payment from `owner` can be, in base units, read before signing: the gas the node
 * estimates for each transfer, plus what mppx adds in pull mode, times the node's gas price (see maxFeeUnits). Throws when
 * a read fails; the caller then lets the chain decide.
 */
export async function estimateMaxFee(owner: Address, transfers: { to: string; amount: bigint; memo?: string }[], mode: string): Promise<bigint> {
  const word = (v: string | bigint) => (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace('0x', '')).padStart(64, '0')
  let gas = mode === 'pull' ? 5000n : 0n
  for (const t of transfers) {
    const data = t.memo ? TRANSFER_WITH_MEMO_SELECTOR + word(t.to) + word(t.amount) + word(t.memo) : '0xa9059cbb' + word(t.to) + word(t.amount)
    const g = await rpcRead('eth_estimateGas', [{ from: owner, to: TOKEN_ADDRESS, data }])
    if (typeof g !== 'string' || !/^0x[0-9a-fA-F]+$/.test(g)) throw new Error('eth_estimateGas: the RPC answer is not a quantity')
    gas += BigInt(g)
  }
  const price = await rpcRead('eth_gasPrice', [])
  if (typeof price !== 'string' || !/^0x[0-9a-fA-F]+$/.test(price)) throw new Error('eth_gasPrice: the RPC answer is not a quantity')
  return maxFeeUnits(gas, BigInt(price))
}

export type KeyState = {
  exists: boolean
  revoked: boolean
  expiry: number
  spendPolicy: string
  remaining: bigint
  periodEnd: number
}

/**
 * State of an access key from the keychain precompile (views only). "Never authorized" is
 * exists=false, revoked=false; a revoked key reads exists=false, revoked=true.
 */
export async function readKey(owner: Address, key: Address): Promise<KeyState> {
  const client = makeClient()
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const [meta, limit] = await Promise.all([
        client.accessKey.getMetadata({ account: owner, accessKey: key }),
        client.accessKey.getRemainingLimit({ account: owner, accessKey: key, token: TOKEN_ADDRESS }),
      ])
      return {
        exists: meta.expiry > 0n && !meta.isRevoked,
        revoked: meta.isRevoked,
        expiry: Number(meta.expiry),
        spendPolicy: String(meta.spendPolicy),
        remaining: BigInt(limit.remaining),
        periodEnd: Number(limit.periodEnd ?? 0n),
      }
    } catch (e) {
      last = e
      await sleep(400 * 2 ** attempt)
    }
  }
  throw last
}

/** A key's call scope (the seller list): `scoped` false means any call is allowed. */
export type KeyScope = { scoped: boolean; scopes: { target: string; selectorRules: { selector: string; recipients: string[] }[] }[] }

export async function readScope(owner: Address, key: Address): Promise<KeyScope> {
  const client = makeClient()
  const r = (await client.readContract({ address: Addresses.accountKeychain, abi: Abis.accountKeychain, functionName: 'getAllowedCalls', args: [owner, key] })) as readonly [boolean, readonly any[]]
  return {
    scoped: Boolean(r[0]),
    scopes: (r[1] ?? []).map((s: any) => ({ target: String(s.target), selectorRules: (s.selectorRules ?? []).map((x: any) => ({ selector: String(x.selector).toLowerCase(), recipients: [...(x.recipients ?? [])].map(String) })) })),
  }
}

/**
 * Checks a receipt against what an operation intended. "Settled" needs the transaction's OWN success
 * and a pathUSD Transfer owner -> recipient of exactly `amount`. `debit` is the principal that left the
 * owner in that transaction.
 */
export function settlementOf(
  receipt: ChainReceipt,
  intent: { owner: string; recipient: string; amount: bigint; token?: string },
): { settled: boolean; debit: bigint; note: string } {
  const token = (intent.token ?? TOKEN_ADDRESS).toLowerCase()
  const fromOwner = receipt.transfers.filter((t) => t.token.toLowerCase() === token && t.from.toLowerCase() === intent.owner.toLowerCase())
  const debit = fromOwner.reduce((s, t) => s + t.value, 0n)
  if (receipt.status !== 'success') return { settled: false, debit: 0n, note: 'transaction reverted on chain' }
  const match = fromOwner.find((t) => t.to.toLowerCase() === intent.recipient.toLowerCase() && t.value === intent.amount)
  if (!match) return { settled: false, debit, note: `transaction succeeded but has no ${fromBaseUnits(intent.amount)} transfer owner -> recipient` }
  return { settled: true, debit, note: 'matched' }
}

/** topic0 of TIP-20 TransferWithMemo(from indexed, to indexed, amount, memo indexed). */
export const TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes('TransferWithMemo(address,address,uint256,bytes32)'))

/**
 * The memo mppx puts on a tempo.charge payment (Attribution.encode, no clientId): 4-byte "mpp" tag,
 * version 1, 10-byte fingerprint of the realm, 10 zero bytes, 7-byte nonce of the challenge id. It is
 * known before anything is signed, and it is an indexed topic of the TransferWithMemo event, so the
 * chain can be searched for one specific purchase without knowing its transaction hash (a sponsored
 * transaction's final hash is fixed only when the seller adds the fee payer's signature).
 */
export function mppMemo(challengeId: string, realm: string): Hex {
  const buf = new Uint8Array(32)
  buf.set(toBytes(keccak256(toBytes('mpp'))).slice(0, 4), 0)
  buf[4] = 1
  buf.set(toBytes(keccak256(toBytes(realm))).slice(0, 10), 5)
  buf.set(toBytes(keccak256(toBytes(challengeId))).slice(0, 7), 25)
  return ('0x' + Buffer.from(buf).toString('hex')) as Hex
}

/** One search covers at most LOG_WINDOWS windows of LOG_WINDOW blocks from its first block: 2,000,000 blocks. */
export const LOG_WINDOW = 100_000n
export const LOG_WINDOWS = 20n
const hex = (n: bigint) => '0x' + n.toString(16)

/**
 * pathUSD logs matching `topics` from `fromBlock` on, in windows of LOG_WINDOW blocks, at most LOG_WINDOWS of them. When
 * the head is further, the search is complete only if the last block it covers is later than `until` (unix seconds after
 * which nothing searched for can land, such as a signed payment's validBefore); otherwise it throws "not searched past
 * block N" before any log call, which callers treat as a failed read, never as "not found".
 * `reachUntil`: the caller will conclude "nothing found" from an empty answer, so a search that ends at the head must end at
 * a head later than `until` too (a load-balanced RPC can answer from a node that is behind); otherwise it throws the same way.
 */
async function searchLogs(topics: Hex[], fromBlock: bigint, until?: number, reachUntil = false): Promise<{ transactionHash: Hex }[]> {
  const { number: head, timestamp } = await chainHead()
  let last = head
  if (head >= fromBlock + LOG_WINDOW * LOG_WINDOWS) {
    last = fromBlock + LOG_WINDOW * LOG_WINDOWS - 1n
    const edge = await rpcRead('eth_getBlockByNumber', [hex(last), false])
    const at = typeof edge?.timestamp === 'string' && /^0x[0-9a-fA-F]+$/.test(edge.timestamp) ? parseInt(edge.timestamp, 16) : NaN
    if (until === undefined || !(at > until)) throw new Error(`not searched past block ${last}`)
  } else if (reachUntil && (until === undefined || !(timestamp > until))) throw new Error(`not searched past block ${head}`)
  const logs: { transactionHash: Hex }[] = []
  for (let from = fromBlock; from <= last; from += LOG_WINDOW) {
    const to = from + LOG_WINDOW - 1n > last ? last : from + LOG_WINDOW - 1n
    const got = await rpcRead('eth_getLogs', [{ address: TOKEN_ADDRESS, fromBlock: hex(from), toBlock: hex(to), topics }])
    if (!Array.isArray(got)) throw new Error('eth_getLogs: the RPC answer is not a list of logs')
    logs.push(...got)
  }
  return logs
}

/**
 * Transactions with a pathUSD TransferWithMemo owner -> recipient carrying `memo`, from `fromBlock` on (indexed, cheap).
 * `until`: the payment's validBefore plus slack, when it has one. `reachUntil`: true when the caller will treat an empty answer as
 * "not found" (searchLogs).
 */
export async function findByMemo(owner: Address, recipient: Address, memo: Hex, fromBlock: bigint, until?: number, reachUntil = false): Promise<Hex[]> {
  const hashes: Hex[] = []
  for (const l of await searchLogs([TRANSFER_WITH_MEMO_TOPIC, topicOf(owner), topicOf(recipient), memo], fromBlock, until, reachUntil))
    if (!hashes.includes(l.transactionHash)) hashes.push(l.transactionHash)
  return hashes
}

/** JSON-RPC write (eth_sendRawTransaction, the faucet's tempo_fundAddress). NEVER retried: a resend could pay twice. */
export async function rpcWrite(method: string, params: unknown[]): Promise<any> {
  const answer = await exchange(method, params, 30_000)
  if (answer.error) throw new Error(answer.error.message)
  return answer.result
}
