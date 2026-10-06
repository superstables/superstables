// Chain reads for the Tempo scripts. Reads retry with backoff; nothing here sends a transaction, so
// a retry can never pay twice.
import { keccak256, toBytes, type Address, type Hex } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { RPC_URL, TOKEN_ADDRESS, fromBaseUnits, makeClient } from './common.ts'

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const topicOf = (a: string) => ('0x' + a.toLowerCase().replace('0x', '').padStart(64, '0')) as Hex

/** JSON-RPC read with up to 4 attempts. Throws on transport errors and on JSON-RPC errors. */
export async function rpcRead(method: string, params: unknown[]): Promise<any> {
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
      const json = (await res.json()) as { result?: any; error?: { message: string } }
      if (json.error) {
        const err = new Error(`${method}: ${json.error.message}`) as Error & { rpcError?: boolean }
        err.rpcError = true
        // a revert is a definite answer from the chain: do not retry it. Anything else (lag, gateway) is retried.
        if (/revert/i.test(json.error.message)) throw err
        last = err
      } else {
        return json.result
      }
    } catch (e) {
      if ((e as any)?.rpcError) throw e
      last = e
    }
    await sleep(400 * 2 ** attempt)
  }
  throw last instanceof Error ? last : new Error(String(last))
}

export type ChainReceipt = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  transactionHash: Hex
  feePayer?: Address
  from?: Address
  transfers: { token: Address; from: Address; to: Address; value: bigint }[]
  /** TIP-20 TransferWithMemo events: the memo binds a payment to one purchase. */
  memos: { token: Address; from: Address; to: Address; memo: Hex }[]
}

/** Tempo has instant BFT finality. A receipt still needs canonical committed inclusion. */
export async function getReceipt(hash: string): Promise<ChainReceipt | null> {
  const r = await rpcRead('eth_getTransactionReceipt', [hash])
  if (!r) return null
  const quantity = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)
  const blockHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
  if (!blockHash(r.transactionHash) || r.transactionHash.toLowerCase() !== hash.toLowerCase() || !quantity(r.blockNumber) || !blockHash(r.blockHash) || !Array.isArray(r.logs) || r.logs.some((l: { removed?: boolean }) => l?.removed) || !['0x0', '0x1'].includes(r.status)) throw new Error('transaction inclusion unreadable')
  const head = await rpcRead('eth_getBlockByNumber', ['latest', false])
  if (!quantity(head?.number) || BigInt(r.blockNumber) > BigInt(head.number)) throw new Error('transaction is not in a committed block')
  const block = await rpcRead('eth_getBlockByNumber', [r.blockNumber, false])
  if (!quantity(block?.number) || BigInt(block.number) !== BigInt(r.blockNumber) || !blockHash(block?.hash) || block.hash.toLowerCase() !== r.blockHash.toLowerCase()) throw new Error('transaction canonical inclusion unreadable')
  return {
    status: r.status === '0x1' ? 'success' : 'reverted',
    blockNumber: BigInt(r.blockNumber),
    transactionHash: r.transactionHash,
    feePayer: r.feePayer,
    from: r.from,
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
  const b = await rpcRead('eth_getBlockByNumber', ['latest', false])
  return { number: BigInt(b.number), timestamp: parseInt(b.timestamp, 16) }
}

export async function pathUsdBalance(address: string): Promise<bigint> {
  const data = '0x70a08231' + address.toLowerCase().replace('0x', '').padStart(64, '0')
  return BigInt(await rpcRead('eth_call', [{ to: TOKEN_ADDRESS, data }, 'latest']))
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

/** Transactions with a pathUSD TransferWithMemo owner -> recipient carrying `memo`, from `fromBlock` to head (indexed, cheap). */
export async function findByMemo(owner: Address, recipient: Address, memo: Hex, fromBlock: bigint): Promise<Hex[]> {
  const head = (await chainHead()).number
  const hashes: Hex[] = []
  const RANGE = 100_000n
  for (let from = fromBlock; from <= head; from += RANGE) {
    const to = from + RANGE - 1n > head ? head : from + RANGE - 1n
    const logs = (await rpcRead('eth_getLogs', [
      { address: TOKEN_ADDRESS, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(owner), topicOf(recipient), memo] },
    ])) as { transactionHash: Hex }[]
    for (const l of logs) if (!hashes.includes(l.transactionHash)) hashes.push(l.transactionHash)
  }
  return hashes
}

/** Plain Transfer logs owner -> recipient of exactly `amount` (a bare transfer has no memo), from `fromBlock` to head. */
export async function findTransfers(owner: Address, recipient: Address, amount: bigint, fromBlock: bigint): Promise<Hex[]> {
  const head = (await chainHead()).number
  const hashes: Hex[] = []
  const RANGE = 100_000n
  for (let from = fromBlock; from <= head; from += RANGE) {
    const to = from + RANGE - 1n > head ? head : from + RANGE - 1n
    const logs = (await rpcRead('eth_getLogs', [
      { address: TOKEN_ADDRESS, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_TOPIC, topicOf(owner), topicOf(recipient)] },
    ])) as { transactionHash: Hex; data: Hex }[]
    for (const l of logs) if (BigInt(l.data.slice(0, 66)) === amount && !hashes.includes(l.transactionHash)) hashes.push(l.transactionHash)
  }
  return hashes
}

/** JSON-RPC write (eth_sendRawTransaction). NEVER retried: a resend could pay twice. */
export async function rpcWrite(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json()) as { result?: any; error?: { message: string; data?: unknown } }
  if (json.error) throw new Error(`${json.error.message}${json.error.data ? ' ' + JSON.stringify(json.error.data) : ''}`)
  return json.result
}
