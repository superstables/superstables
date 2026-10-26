// readBudget() -- anyone (read-only). No key file is opened.
//
// On-chain primitives (AccountKeychain precompile view functions):
//   - getKey(account, keyId)                      -> expiry, isRevoked, enforceLimits
//   - getRemainingLimitWithPeriod(account, keyId, token) -> remaining, periodEnd
//   - getAllowedCalls(account, keyId)              -> isScoped, seller/selector scopes
//
// Addresses come from --owner and --key, or from the public address file with --agent <label>.
//
// Usage:
//   npx tsx budget/tempo/readBudget.ts --owner 0x... --key 0x...
//   npx tsx budget/tempo/readBudget.ts [--agent 2]

import { Abis, Addresses } from 'viem/tempo'
import type { Address } from 'viem'
import { addressCheck, labelCheck, parseCli } from './lib/args.mjs'
import { TOKEN_ADDRESS, TOKEN_LABEL, explorerAddress, fromBaseUnits, loadPublicEnv, makeClient, oneLine } from './lib/common.ts'
import { agreedAtBlock, readKeyAt } from './lib/chain.ts'
import { agreementWords } from '../../src/core/rpc-quorum.mjs'

const { values: args } = parseCli({
  name: 'readBudget.ts',
  summary: 'Read an access key\'s budget from the chain. Opens no key file.',
  flags: {
    owner: { type: 'string', metavar: 'address', desc: 'Owner account address (with --key, no file is read at all)', check: addressCheck },
    key: { type: 'string', metavar: 'address', desc: 'Agent access key address', check: addressCheck },
    agent: { type: 'string', metavar: 'label', desc: 'Agent label from the public address list', check: labelCheck },
  },
  examples: ['npx tsx budget/tempo/readBudget.ts --owner 0x... --key 0x...', 'npx tsx budget/tempo/readBudget.ts --agent 2'],
})

async function main() {
  let ownerAddress = args.owner as Address | undefined
  let agentAddress = args.key as Address | undefined
  if (!ownerAddress || !agentAddress) {
    const pub = loadPublicEnv()
    const label = typeof args.agent === 'string' ? args.agent : ''
    ownerAddress ??= pub.OWNER_ADDRESS as Address
    agentAddress ??= pub[`AGENT${label}_ADDRESS`] as Address
  }
  if (!ownerAddress || !agentAddress) throw new Error('No addresses: pass --owner and --key, or run setup.ts to create the public address list.')
  const client = makeClient() // no account: this is a read anyone can do

  // getAllowedCalls has no high-level SDK wrapper in this viem version: call the precompile directly.
  const getAllowedCalls = () =>
    client.readContract({
      address: Addresses.accountKeychain,
      abi: Abis.accountKeychain,
      functionName: 'getAllowedCalls',
      args: [ownerAddress!, agentAddress!],
    }) as Promise<readonly [boolean, readonly { target: string; selectorRules: readonly unknown[] }[]]>

  const [metadata, limit, scopesResult] = await Promise.all([
    client.accessKey.getMetadata({ account: ownerAddress, accessKey: agentAddress }),
    client.accessKey.getRemainingLimit({ account: ownerAddress, accessKey: agentAddress, token: TOKEN_ADDRESS }),
    getAllowedCalls(),
  ])
  const [isScoped, scopesList] = scopesResult

  const iso = (unix: number) => new Date(unix * 1000).toISOString()
  const expiry = Number(metadata.expiry)
  const periodEnd = Number(limit.periodEnd ?? 0)
  const remaining = BigInt(limit.remaining)
  const granted = expiry > 0 || metadata.isRevoked
  const expired = expiry > 0 && expiry * 1000 <= Date.now()
  // Four things end a budget in what this prints: the key reads revoked, expired, with 0 remaining, or never granted. Each is a
  // verdict that could be a lie, and one endpoint's word must not end a budget. When the primary shows any of them, the
  // confirming endpoints read the key at one block; a fact is printed as true only when that agreed read shows the same. Else it
  // is printed as unknown, and the amount stays counted as at risk.
  const primaryEnds = metadata.isRevoked || expired || remaining === 0n || !granted
  const agreed = primaryEnds ? await agreedAtBlock((url, _block, hash) => readKeyAt(url, ownerAddress!, agentAddress!, hash)).catch(() => null) : null
  const seen = agreed && agreed.agreed ? (agreed.value as { revoked: boolean; expiry: string; remaining: string }) : null
  // Revoked and expired never undo, so an old agreed block shows them truly. "Remaining 0" and "never granted" are true before a
  // grant: they are believed only at a block near the highest head, never one the lowest endpoint's lag has left far behind.
  const recent = !!agreed && agreed.agreed && agreed.block.highest - agreed.block.number <= 64n
  const failure = !agreed ? 'we couldn\'t check the chain state' : agreed.agreed ? (recent ? 'the RPC checks do not confirm this' : 'we can\'t yet confirm the chain\'s final state') : agreementWords(agreed)
  const words = (what: string) => ` (${what} on one RPC, but ${failure})`
  const agreedWords = ` (agreement: ${agreed && agreed.agreed ? agreed.agreement : ''})`
  const revoked = metadata.isRevoked && !!seen?.revoked
  const expiredSure = expired && !!seen && BigInt(seen.expiry) > 0n && Number(seen.expiry) === expiry && BigInt(seen.expiry) <= BigInt(agreed!.block.timestamp)
  const spent = remaining === 0n && recent && !!seen && seen.remaining === '0' && seen.expiry === String(metadata.expiry) && seen.revoked === metadata.isRevoked
  const neverGranted = !granted && recent && !!seen && seen.expiry === '0' && !seen.revoked
  console.log(`Budget for agent ${agentAddress} on owner ${ownerAddress}`)
  console.log(`  owner explorer: ${explorerAddress(ownerAddress)}`)
  console.log(`  remaining:  ${remaining === 0n && !spent && !revoked && !neverGranted ? `unknown${words('the remaining limit reads 0')}` : `${limit.remaining} base units (${fromBaseUnits(limit.remaining)} ${TOKEN_LABEL})`}`)
  // A key that was never granted reads as zeros (and "unlimited", "secp256k1"): say that instead of printing them.
  if (neverGranted) {
    console.log(`  periodEnd:  0 (no budget)`)
    console.log(`  expiry:     0 (no budget)`)
    console.log(`  isRevoked:  false`)
    console.log(`  granted:    no. This agent key has no budget on chain: the owner has not granted one.`)
    return
  }
  const live = !revoked && !expiredSure
  console.log(`  periodEnd:  ${periodEnd}${periodEnd ? ` (${iso(periodEnd)}: the current period ends${live && periodEnd < expiry ? ', and the limit refills then' : ''}${periodEnd * 1000 > Date.now() ? '' : ', already passed'})` : ' (one-time limit, no refill)'}`)
  if (!granted) console.log(`  granted:    unknown${words('the key reads as never granted')}`)
  console.log(`  expiry:     ${expired && !expiredSure ? `unknown${words('the key reads expired')}` : !granted ? `unknown${words('the key reads as never granted')}` : `${expiry} (${iso(expiry)}${expiredSure ? ', EXPIRED: a new budget needs a new agent key' : ''})`}`)
  console.log(`  expired:    ${expired && !expiredSure ? `unknown${words('the key reads expired')}` : expiredSure}`)
  console.log(`  spendPolicy: ${metadata.spendPolicy}`)
  console.log(`  isRevoked:  ${metadata.isRevoked ? (revoked ? `true${agreedWords}` : `unknown${words('the key reads revoked')}`) : 'false'}`)
  console.log(`  keyType:    ${metadata.keyType}`)
  const scopeJson = JSON.stringify(scopesList, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  console.log(`  seller scope: ${isScoped ? scopeJson : 'unscoped (any seller)'}`)
}

main().catch((err) => {
  // viem puts the revert reason an RPC sent as ABI data into its message: the same one-line, no-hidden-characters rule as any outside text
  console.error('readBudget failed:', oneLine(err?.message ?? err, 1000))
  process.exit(1)
})
