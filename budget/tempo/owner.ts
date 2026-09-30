// The owner's side of the tempo rail: setup, grant and revoke go through the owner's own browser wallet (MetaMask or any
// EIP-1193 wallet) on the shared owner page (../owner-page.ts). The owner's root account calls the AccountKeychain precompile
// like any contract, in a plain type-2 transaction: authorizeKey (selector 0x980a6025) to grant, revokeKey (0x5ae7ab32) to
// revoke. No wallet can build Tempo's 0x76 transaction with a keyAuthorization, and none is needed.
//
// Fees: a type-2 transaction has no fee_token field and no fee payer signature, so the owner pays its own fee, in the fee
// token its FeeManager preference names, else pathUSD. The owner's native balance on Tempo is a meaningless placeholder:
// never read eth_getBalance for fees here.
//
// After the wallet sends, the command reads the chain itself (readSent, then the key): from the owner, to the keychain, the
// exact calldata, success, a block after the request, fee payer the owner; then the key's type, expiry, limit, period and
// seller scope, or its revocation.
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import type { OwnerChain, OwnerTerms } from '../../src/core/signer/owner-approval-server.ts'
import { closeOwnerPage, ownerPageFor } from '../owner-page.ts'
import { CHAIN_ID, EXPLORER_BASE, RPC_URL, TOKEN_ADDRESS, TOKEN_LABEL, fromBaseUnits, makeClient } from './lib/common.ts'
import { chainHead, rpcRead, sleep, topicOf } from './lib/chain.ts'

export { closeOwnerPage }

/**
 * Moderato for wallet_addEthereumChain. decimals 18, not viem's 6: MetaMask refuses any other value, and fees are priced in
 * 1e-18 USD per unit, so a fee shows as a USD amount.
 */
export const TEMPO_OWNER_CHAIN: OwnerChain = {
  chainId: CHAIN_ID,
  chainName: 'Tempo Testnet (Moderato)',
  rpcUrl: RPC_URL,
  explorer: EXPLORER_BASE,
  nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  testnet: true,
}

export const KEYCHAIN: Address = Addresses.accountKeychain
const FEE_MANAGER: Address = Addresses.feeManager
const TRANSFER = '0xa9059cbb'
const TRANSFER_WITH_MEMO = '0x95777d59'
/** The owner's fee token must hold at least this much (a scoped grant costs about 0.003 to 0.09 pathUSD at testnet prices). */
export const MIN_FEE_BALANCE = 100_000n // 0.1 in 6-decimal units

/** One RESULT line, last on stdout (CLI.md), the same shape as the evm scripts. Returns `exit`. */
export function emit(command: string, exit: number, o: Record<string, unknown>): number {
  console.log(`RESULT ${JSON.stringify({ ok: exit === 0, command, rail: 'tempo', chain: 'moderato', ...o })}`)
  return exit
}

export const agentFlag = (label: string) => (label ? ` --agent ${label}` : '')
export const { askConnect, askTransaction, endUnapproved } = ownerPageFor({
  chain: TEMPO_OWNER_CHAIN,
  walletWords: 'MetaMask or another',
  statusCommand: 'superstables budget status --rail tempo',
  emit,
})

// ── calldata ─────────────────────────────────────────────────────────────────────────────────────────────

const authorizeAbi = (Abis.accountKeychain as readonly any[]).filter((x) => x.type === 'function' && x.name === 'authorizeKey' && x.inputs.length === 3)
const revokeAbi = (Abis.accountKeychain as readonly any[]).filter((x) => x.type === 'function' && x.name === 'revokeKey')

export type GrantPlan = { agent: Address; limit: bigint; expiry: number; period?: number; sellers?: Address[] }

/**
 * authorizeKey(agent, secp256k1, { expiry, enforceLimits: true, limits: [pathUSD, limit, period or 0], allowAnyCalls, allowedCalls }).
 * With sellers, only transfer and transferWithMemo on pathUSD, both limited to those recipients (MPP's charge sends
 * transferWithMemo). Without, any call.
 */
export function grantCalldata(p: GrantPlan): Hex {
  const recipients = p.sellers?.map((s) => getAddress(s))
  return encodeFunctionData({
    abi: authorizeAbi,
    functionName: 'authorizeKey',
    args: [
      getAddress(p.agent),
      0,
      {
        expiry: BigInt(p.expiry),
        enforceLimits: true,
        limits: [{ token: TOKEN_ADDRESS, amount: p.limit, period: BigInt(p.period ?? 0) }],
        allowAnyCalls: !recipients,
        allowedCalls: recipients
          ? [{ target: TOKEN_ADDRESS, selectorRules: [{ selector: TRANSFER, recipients }, { selector: TRANSFER_WITH_MEMO, recipients }] }]
          : [],
      },
    ],
  })
}

export const revokeCalldata = (agent: Address): Hex => encodeFunctionData({ abi: revokeAbi, functionName: 'revokeKey', args: [getAddress(agent)] })

/** The most the key can move by expiry: every period window that starts before expiry can be spent in full. */
export function maxByExpiry(limit: bigint, expirySeconds: number, period?: number): { windows: number; max: bigint } {
  const windows = period ? Math.ceil(expirySeconds / period) : 1
  return { windows, max: limit * BigInt(windows) }
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────────────────

const word = (a: string) => a.toLowerCase().replace('0x', '').padStart(64, '0')

/** The token the owner pays fees in: its FeeManager preference if it set one, else pathUSD. */
export async function feeTokenOf(owner: Address): Promise<Address> {
  try {
    const r = await rpcRead('eth_call', [{ to: FEE_MANAGER, data: '0xed498fa8' + word(owner) }, 'latest'])
    const token = ('0x' + String(r).slice(-40)) as Address
    return /^0x0{40}$/.test(token) ? TOKEN_ADDRESS : getAddress(token)
  } catch {
    return TOKEN_ADDRESS
  }
}

export async function tokenBalance(token: Address, holder: Address): Promise<bigint> {
  return BigInt(await rpcRead('eth_call', [{ to: token, data: '0x70a08231' + word(holder) }, 'latest']))
}

export type FullKey = {
  signatureType: number
  expiry: number
  enforceLimits: boolean
  revoked: boolean
  remaining: bigint
  periodEnd: number
  scoped: boolean
  scopes: { target: string; selectorRules: { selector: string; recipients: string[] }[] }[]
  admin: boolean
}

/** Everything the keychain says about one key, in one read with retries. */
export async function readFullKey(owner: Address, key: Address): Promise<FullKey> {
  const client = makeClient()
  const read = (functionName: string, args: unknown[]) => client.readContract({ address: KEYCHAIN, abi: Abis.accountKeychain, functionName: functionName as any, args: args as any }) as Promise<any>
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const [k, lim, calls, admin] = await Promise.all([
        read('getKey', [owner, key]),
        read('getRemainingLimitWithPeriod', [owner, key, TOKEN_ADDRESS]),
        read('getAllowedCalls', [owner, key]),
        read('isAdminKey', [owner, key]),
      ])
      return {
        signatureType: Number(k.signatureType),
        expiry: Number(k.expiry),
        enforceLimits: Boolean(k.enforceLimits),
        revoked: Boolean(k.isRevoked),
        remaining: BigInt(lim[0]),
        periodEnd: Number(lim[1]),
        scoped: Boolean(calls[0]),
        scopes: (calls[1] as any[]).map((s) => ({ target: s.target, selectorRules: (s.selectorRules as any[]).map((r) => ({ selector: String(r.selector).toLowerCase(), recipients: [...r.recipients] })) })),
        admin: Boolean(admin),
      }
    } catch (e) {
      last = e
      await sleep(500 * 2 ** attempt)
    }
  }
  throw last
}

/** What the chain must read after a grant. Empty means it matches the plan. */
export function grantProblems(k: FullKey, p: GrantPlan): string[] {
  const out: string[] = []
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (k.revoked) out.push('the key reads as revoked')
  if (k.expiry !== p.expiry) out.push(`the key expires at ${k.expiry}, not ${p.expiry}`)
  if (k.signatureType !== 0) out.push(`the key type is ${k.signatureType}, not secp256k1 (0)`)
  if (!k.enforceLimits) out.push('the key has no spending limit')
  if (k.admin) out.push('the key is an admin key')
  if (k.remaining !== p.limit) out.push(`the limit reads ${fromBaseUnits(k.remaining)} ${TOKEN_LABEL}, not ${fromBaseUnits(p.limit)}`)
  if (p.period && !k.periodEnd) out.push('the limit has no period')
  if (!p.period && k.periodEnd) out.push(`the limit resets (period end ${k.periodEnd}), but no period was planned`)
  if (p.sellers) {
    const want = [...p.sellers].map((s) => s.toLowerCase()).sort().join(',')
    const scope = k.scopes.length === 1 && same(k.scopes[0].target, TOKEN_ADDRESS) ? k.scopes[0] : undefined
    const rules = scope?.selectorRules ?? []
    const ok = k.scoped && rules.length === 2 && [TRANSFER, TRANSFER_WITH_MEMO].every((sel) => {
      const r = rules.find((x) => x.selector === sel)
      return r && [...r.recipients].map((x) => x.toLowerCase()).sort().join(',') === want
    })
    if (!ok) out.push('the seller list on chain is not the planned one')
  } else if (k.scoped) out.push('the key is limited to some calls, but no seller list was planned')
  return out
}

export type Sent = { hash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; type: string; feePayer?: string; problems: string[] }

/**
 * Read a transaction the page reported, from the chain. Every difference from the plan is a problem: another sender, another
 * target, changed calldata, a value, a block before the request, another fee payer. Null when the chain never shows the hash.
 */
export async function readSent(hash: Hex, want: { from: Address; data: Hex; afterBlock: bigint }, waitMs = 120_000): Promise<Sent | null> {
  const until = Date.now() + waitMs
  let t: any = null
  while (!t && Date.now() < until) {
    try { t = await rpcRead('eth_getTransactionByHash', [hash]) } catch {}
    if (!t) await sleep(1500)
  }
  if (!t) return null
  let r: any = null
  while (!r && Date.now() < until + 60_000) {
    try { r = await rpcRead('eth_getTransactionReceipt', [hash]) } catch {}
    if (!r) await sleep(1500)
  }
  if (!r) return null
  const same = (a?: string | null, b?: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
  const problems: string[] = []
  if (!same(t.from, want.from)) problems.push(`it was sent from ${t.from}, not the owner ${want.from}`)
  if (!same(t.to, KEYCHAIN)) problems.push(`it was sent to ${t.to}, not the keychain ${KEYCHAIN}`)
  if (!same(t.input, want.data)) problems.push('the wallet changed the transaction data')
  if (BigInt(t.value ?? '0x0') !== 0n) problems.push(`it sent a value of ${t.value}`)
  if (BigInt(r.blockNumber) <= want.afterBlock) problems.push(`it was mined in block ${BigInt(r.blockNumber)}, before this request started (block ${want.afterBlock})`)
  if (r.feePayer && !same(r.feePayer, want.from)) problems.push(`its fee was paid by ${r.feePayer}, not the owner`)
  if (r.status !== '0x1') problems.push('it reverted on chain')
  return { hash, status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: BigInt(r.blockNumber), type: String(t.type), feePayer: r.feePayer, problems }
}

const KEY_AUTHORIZED = '0x7c46af0758d3eca5e8195833bff1e5153f6249fc0f2968a878fd28544315a03c'
const KEY_REVOKED = '0x14ce4f0c8c12936436b733974fb13d10fc13e8c41c06dc8e19d82001c93d7989'

/**
 * A wallet's "speed up" or "cancel" replaces the transaction under a new hash. Find the keychain's own event for this key since
 * `fromBlock` instead: KeyAuthorized for a grant, KeyRevoked for a revoke.
 */
export async function findKeyEvent(kind: 'authorized' | 'revoked', owner: Address, key: Address, fromBlock: bigint): Promise<Hex | null> {
  const head = (await chainHead()).number
  const logs = (await rpcRead('eth_getLogs', [{ address: KEYCHAIN, fromBlock: '0x' + (fromBlock + 1n).toString(16), toBlock: '0x' + head.toString(16), topics: [kind === 'authorized' ? KEY_AUTHORIZED : KEY_REVOKED, topicOf(owner), topicOf(key)] }])) as { transactionHash: Hex }[]
  return logs.length ? logs[logs.length - 1].transactionHash : null
}

// ── terms ────────────────────────────────────────────────────────────────────────────────────────────────

export const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z')
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
/** A period in exact words: "hour", "2 days", "90 seconds" (after "every"). */
const one = (n: number, unit: string) => (n === 1 ? unit : plural(n, unit))
const every = (s: number) => (s % 86400 === 0 ? one(s / 86400, 'day') : s % 3600 === 0 ? one(s / 3600, 'hour') : s % 60 === 0 ? one(s / 60, 'minute') : one(s, 'second'))
/** A duration in round words: "23 hours", "2 days", "15 minutes". */
const about = (s: number) => (s >= 172800 ? plural(Math.round(s / 86400), 'day') : s >= 7200 ? plural(Math.round(s / 3600), 'hour') : s >= 120 ? plural(Math.round(s / 60), 'minute') : plural(s, 'second'))

export function grantTerms(p: GrantPlan & { owner: Address; expirySeconds: number; held: bigint; feeToken: Address; label: string }): OwnerTerms {
  const amt = `${fromBaseUnits(p.limit)} ${TOKEN_LABEL}`
  const { windows, max } = maxByExpiry(p.limit, p.expirySeconds, p.period)
  const most = `${fromBaseUnits(max)} ${TOKEN_LABEL}`
  return {
    title: 'give your agent a budget',
    amount: fromBaseUnits(p.limit),
    unit: TOKEN_LABEL,
    summary: p.period
      ? `Your agent may spend up to ${amt} every ${every(p.period)} from your account, until ${iso(p.expiry)}. That is at most ${most} in total by then.`
      : `Your agent may spend up to ${amt} from your account, in total, until ${iso(p.expiry)}.`,
    rows: [
      { label: 'Agent key', value: p.agent, mono: true },
      { label: 'Your account', value: p.owner, mono: true },
      { label: 'Token', value: `${TOKEN_LABEL} ${TOKEN_ADDRESS}`, mono: true },
      { label: 'Limit', value: p.period ? `${amt} every ${every(p.period)} (the limit refills each period)` : `${amt} in total (no refill)` },
      { label: 'Expires', value: `${iso(p.expiry)} (in about ${about(p.expirySeconds)})` },
      { label: 'Sellers', value: p.sellers ? p.sellers.join(', ') : 'any address' },
      { label: 'Most by expiry', value: `${most}${windows > 1 ? ` (${windows} periods of ${amt})` : ''}` },
      { label: 'You hold', value: `${fromBaseUnits(p.held)} ${TOKEN_LABEL}` },
      { label: 'Transaction', value: `AccountKeychain.authorizeKey(${p.agent}, ...) at ${KEYCHAIN}`, mono: true },
    ],
    enforced: [
      p.period ? `A limit of ${amt} per period, and ${most} at most by expiry.` : `A total limit of ${amt}. Once the agent has used it, it can spend nothing more.`,
      `The expiry. After ${iso(p.expiry)} every payment the key signs is refused.`,
      ...(p.sellers ? [`The seller list. The key can pay only ${p.sellers.length === 1 ? 'that address' : 'those addresses'}.`] : []),
      'The chain checks every payment the key signs, even with a stolen key.',
    ],
    notEnforced: [
      ...(p.sellers ? [] : ['No seller list. Whoever holds the agent key can pay any address, up to the limit.']),
      "No per-payment limit. The agent's command checks each price against a maximum, but a stolen key skips that check.",
    ],
    notes: [
      `Your wallet shows "Interacting with ${KEYCHAIN.slice(0, 7)}...${KEYCHAIN.slice(-5)}" and no amounts. The terms above are what this transaction sets; the command reads them back from the chain.`,
      `Your wallet may first ask to add Tempo Testnet (Moderato). You pay a small network fee in ${p.feeToken.toLowerCase() === TOKEN_ADDRESS.toLowerCase() ? TOKEN_LABEL : `your fee token ${p.feeToken}`}; it moves no money to the agent now.`,
      `To end the budget at any time: superstables budget revoke --rail tempo${agentFlag(p.label)}. You approve that in your wallet too.`,
      'A revoked or expired key can never be granted again: the next budget needs a new agent key (superstables budget setup --rail tempo --agent LABEL).',
    ],
  }
}

export function revokeTerms(p: { owner: Address; agent: Address; remaining: bigint; expiry: number; feeToken: Address; label: string }): OwnerTerms {
  return {
    title: "end your agent's budget",
    amount: fromBaseUnits(p.remaining),
    unit: TOKEN_LABEL,
    summary: `This ends your agent's key for good: the ${fromBaseUnits(p.remaining)} ${TOKEN_LABEL} it has left can no longer be spent. From the block it lands in, every payment the key signs is refused.`,
    rows: [
      { label: 'Agent key', value: p.agent, mono: true },
      { label: 'Your account', value: p.owner, mono: true },
      { label: 'Key would expire', value: iso(p.expiry) },
      { label: 'Transaction', value: `AccountKeychain.revokeKey(${p.agent}) at ${KEYCHAIN}`, mono: true },
    ],
    enforced: ['From that block on, every payment by this key fails, even one signed earlier, even with a stolen key.'],
    notEnforced: [
      'A payment session the key opened elsewhere. superstables budget never opens one; the command lists any it finds after the revoke.',
      'A payment mined before this transaction.',
    ],
    notes: [
      `This costs a small network fee in ${p.feeToken.toLowerCase() === TOKEN_ADDRESS.toLowerCase() ? TOKEN_LABEL : 'your fee token'} and moves no money.`,
      'This key can never be granted again. For a new budget, make a new agent key: superstables budget setup --rail tempo --agent LABEL.',
    ],
  }
}
