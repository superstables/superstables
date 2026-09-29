// revokeBudget() -- owner signs. THE KILL SWITCH under a stolen agent key.
//
// On-chain primitive: AccountKeychain.revokeKey(keyId), called by the owner's root key. The key is
// permanently inactive: every payment it signs is refused with KeyAlreadyRevoked, and it can never be
// re-authorized for this account.
//
// What a revoke does NOT stop: a payment session the key already opened. superstables budget never opens
// one (buy is a one-off charge), but the key could have been used elsewhere. After the revoke this script
// scans the channel reserve and prints the residual exposure: every channel of this key that still holds
// a deposit. It only reports; closing a session is up to the tool that opened it.
//
// Usage:
//   npx tsx budget/tempo/revokeBudget.ts [--agent <label> | --key <address>] [--lookback-blocks 300000]

import type { Address } from 'viem'
import { addressCheck, intCheck, labelCheck, parseCli } from './lib/args.mjs'
import { explorerTx, fromBaseUnits, loadOwnerEnv, makeClient, ownerAccount, resolveAgentAddress } from './lib/common.ts'
import { chainHead, readKey } from './lib/chain.ts'
import { closeGracePeriod, findOpenChannels, type OpenChannel } from './lib/channels.ts'

const { values: args } = parseCli({
  name: 'revokeBudget.ts',
  summary: 'Revoke an agent access key (owner signs), then list any payment sessions it left open.',
  flags: {
    agent: { type: 'string', metavar: 'label', desc: 'Agent label; omit for the primary agent', check: labelCheck },
    key: { type: 'string', metavar: 'address', desc: 'Revoke this key address instead (e.g. a throwaway key)', check: addressCheck },
    'lookback-blocks': { type: 'string', metavar: 'n', desc: 'How far back to look for channels (default 300000, about 50 hours)', check: intCheck(1) },
  },
  examples: ['npx tsx budget/tempo/revokeBudget.ts --agent 2'],
})

const agentLabel = typeof args.agent === 'string' ? args.agent : ''
const lookback = BigInt(typeof args['lookback-blocks'] === 'string' ? args['lookback-blocks'] : 300_000)

async function residualScan(owner: Address, key: Address, fromBlock: bigint, grace: number, heading: string): Promise<{ unclosed: number; total: bigint }> {
  const head = await chainHead()
  const channels = await findOpenChannels(owner, key, fromBlock)
  console.log(`\n${heading}: scanned blocks ${fromBlock}..${head.number} (chain time ${head.timestamp})`)
  let total = 0n
  let unclosed = 0
  const row = (c: OpenChannel) => {
    const unspent = c.deposit - c.settled
    total += unspent
    if (c.closeRequestedAt === 0) unclosed++
    const at = c.closeRequestedAt + grace
    const when = c.closeRequestedAt === 0 ? 'NOT CLOSED (no close requested)' : head.timestamp >= at ? 'withdrawable now' : `withdrawable in ${at - head.timestamp} s`
    console.log(`  channel ${c.channelId} payee ${c.descriptor.payee} deposit ${fromBaseUnits(c.deposit)} settled ${fromBaseUnits(c.settled)} unspent ${fromBaseUnits(unspent)}  ${when}`)
  }
  if (!channels.length) console.log('  no channel of this key holds a deposit: residual exposure 0')
  channels.forEach(row)
  if (channels.length) console.log(`  RESIDUAL EXPOSURE (the seller can still settle up to this until the owner withdraws): ${fromBaseUnits(total)} pathUSD in ${channels.length} channel${channels.length === 1 ? '' : 's'}`)
  console.log(`  Channels older than ${lookback} blocks are not visible to this scan (--lookback-blocks).`)
  return { unclosed, total }
}

async function main() {
  const env = loadOwnerEnv()
  const owner = ownerAccount(env)
  const client = makeClient(owner)
  const agentAddress = (typeof args.key === 'string' ? args.key : resolveAgentAddress(env, agentLabel)) as Address
  console.log(`Revoking agent access key ${agentAddress} on owner ${owner.address}`)

  const before = await readKey(owner.address, agentAddress)
  const headStart = (await chainHead()).number
  const fromBlock = headStart > lookback ? headStart - lookback : 0n
  const grace = await closeGracePeriod()

  if (before.revoked) console.log('The key is already revoked; nothing to send.')
  else if (!before.exists) {
    console.log('REFUSED: the key was never authorized on this owner; there is nothing to revoke. Nothing was sent.')
    process.exit(3)
  } else {
    try {
      const { receipt } = await client.accessKey.revokeSync({ accessKey: agentAddress })
      console.log(`\ntx hash: ${receipt.transactionHash}`)
      console.log(`explorer: ${explorerTx(receipt.transactionHash)}`)
      console.log(`status: ${receipt.status}`)
    } catch (err) {
      // An error here does not mean the revoke failed: the transaction may have landed. Read the chain.
      console.log(`\nThe send raised an error (${String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 160)}). Reading the chain to see whether the revoke landed.`)
    }
  }
  const after = await readKey(owner.address, agentAddress)
  console.log(`readback: isRevoked ${after.revoked}`)
  let unclosed = 0
  try {
    unclosed = (await residualScan(owner.address, agentAddress, fromBlock, grace, 'Open payment sessions of this key (report only)')).unclosed
  } catch (err) {
    console.log(`\nSession scan FAILED (${String((err as Error).message).slice(0, 160)}). Residual exposure from payment sessions is UNKNOWN.`)
    process.exitCode = 1
  }
  if (!after.revoked) process.exitCode = 1
  else if (unclosed) console.log('\nThis revoke does not stop those sessions. Close them with the tool that opened them.')
}

main().catch((err) => {
  console.error('revokeBudget failed:', String(err?.shortMessage ?? err?.message ?? err).slice(0, 400))
  process.exit(1)
})
