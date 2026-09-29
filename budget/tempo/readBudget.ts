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
import { TOKEN_ADDRESS, TOKEN_LABEL, explorerAddress, fromBaseUnits, loadPublicEnv, makeClient } from './lib/common.ts'

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

  console.log(`Budget for agent ${agentAddress} on owner ${ownerAddress}`)
  console.log(`  owner explorer: ${explorerAddress(ownerAddress)}`)
  console.log(`  remaining:  ${limit.remaining} base units (${fromBaseUnits(limit.remaining)} ${TOKEN_LABEL})`)
  console.log(`  periodEnd:  ${limit.periodEnd ?? 'n/a'}`)
  console.log(`  expiry:     ${metadata.expiry} (${metadata.expiry > 0n ? new Date(Number(metadata.expiry) * 1000).toISOString() : 'n/a'})`)
  console.log(`  spendPolicy: ${metadata.spendPolicy}`)
  console.log(`  isRevoked:  ${metadata.isRevoked}`)
  console.log(`  keyType:    ${metadata.keyType}`)
  const scopeJson = JSON.stringify(scopesList, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  console.log(`  seller scope: ${isScoped ? scopeJson : 'unscoped (any seller)'}`)
}

main().catch((err) => {
  console.error('readBudget failed:', err?.message ?? err)
  process.exit(1)
})
