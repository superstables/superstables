// Read-only helpers for TIP-1034 payment-session channels (the TIP-20 channel reserve precompile at
// 0x4D50500000000000000000000000000000000000). revokeBudget uses them to report what a revoke does not
// stop: a session's deposit leaves the owner at `open` and sits in the precompile until the payer
// requests a close and, after CLOSE_GRACE_PERIOD, withdraws it.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem'
import { Abis } from 'viem/tempo'
import { rpcRead } from './chain.ts'

export const CHANNEL_RESERVE: Address = '0x4D50500000000000000000000000000000000000'
const MAX_LOG_RANGE = 100_000 // Moderato's eth_getLogs limit
const ABI = Abis.tip20ChannelReserve

export type Descriptor = {
  payer: Address
  payee: Address
  operator: Address
  token: Address
  salt: Hex
  authorizedSigner: Address
  expiringNonceHash: Hex
}
export type OpenChannel = {
  channelId: Hex
  descriptor: Descriptor
  deposit: bigint
  settled: bigint
  closeRequestedAt: number
  openedInBlock: bigint
}

// Reads retry with backoff and throw on any transport or RPC error. Nothing here sends a transaction.
const rpc = rpcRead

export async function blockNumber(): Promise<bigint> {
  return BigInt(await rpc('eth_blockNumber', []))
}

const topicOf = (a: string) => ('0x' + a.toLowerCase().replace('0x', '').padStart(64, '0')) as Hex
const OPENED_TOPIC = keccak256(
  toBytes('ChannelOpened(bytes32,address,address,address,address,address,bytes32,bytes32,uint96)'),
)

/**
 * Finds channels opened by `payer` whose voucher signer (`authorizedSigner`) is `signer` (the
 * agent's access key), and that still exist on chain (closed channels have no state).
 * Scans `eth_getLogs` backwards in 100,000-block chunks (about 17 hours each) down to `fromBlock`.
 */
export async function findOpenChannels(payer: Address, signer: Address, fromBlock: bigint): Promise<OpenChannel[]> {
  const head = await blockNumber()
  const found: OpenChannel[] = []
  for (let to = head; to >= fromBlock; to -= BigInt(MAX_LOG_RANGE)) {
    const from = to - BigInt(MAX_LOG_RANGE) + 1n > fromBlock ? to - BigInt(MAX_LOG_RANGE) + 1n : fromBlock
    const logs = (await rpc('eth_getLogs', [
      {
        address: CHANNEL_RESERVE,
        fromBlock: '0x' + from.toString(16),
        toBlock: '0x' + to.toString(16),
        topics: [OPENED_TOPIC, null, topicOf(payer)],
      },
    ])) as { topics: Hex[]; data: Hex; blockNumber: Hex }[]
    for (const log of logs) {
      const ev = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      if (ev.eventName !== 'ChannelOpened') continue
      const a = ev.args as any
      if (a.authorizedSigner.toLowerCase() !== signer.toLowerCase()) continue
      const state = await readState(a.channelId) // throws on an RPC error, never treated as absence
      if (state.deposit === 0n) continue // closed or withdrawn: no state left
      found.push({
        channelId: a.channelId,
        descriptor: {
          payer: a.payer,
          payee: a.payee,
          operator: a.operator,
          token: a.token,
          salt: a.salt,
          authorizedSigner: a.authorizedSigner,
          expiringNonceHash: a.expiringNonceHash,
        },
        deposit: state.deposit,
        settled: state.settled,
        closeRequestedAt: state.closeRequestedAt,
        openedInBlock: BigInt(log.blockNumber),
      })
    }
    if (from === fromBlock) break
  }
  return found
}

/**
 * getChannelState(channelId). A channel that does not exist (closed, withdrawn, never opened) reads as
 * all zeros, so `deposit === 0n` means "no channel". A failed RPC call is NOT absence: it throws, so a
 * caller never mistakes an unreachable node for "no open channel".
 */
export async function readState(channelId: Hex) {
  const data = encodeFunctionData({ abi: ABI, functionName: 'getChannelState', args: [channelId] })
  const result = (await rpc('eth_call', [{ to: CHANNEL_RESERVE, data }, 'latest'])) as Hex | undefined
  if (!result || result === '0x') throw new Error(`getChannelState(${channelId}): empty answer from the node`)
  const s = decodeFunctionResult({ abi: ABI, functionName: 'getChannelState', data: result }) as any
  return { settled: BigInt(s.settled), deposit: BigInt(s.deposit), closeRequestedAt: Number(s.closeRequestedAt) }
}

export async function closeGracePeriod(): Promise<number> {
  const data = encodeFunctionData({ abi: ABI, functionName: 'CLOSE_GRACE_PERIOD' })
  const out = await rpc('eth_call', [{ to: CHANNEL_RESERVE, data }, 'latest'])
  return Number(decodeFunctionResult({ abi: ABI, functionName: 'CLOSE_GRACE_PERIOD', data: out }))
}
