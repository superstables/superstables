// revokeBudget(): the owner revokes the agent's access key. THE KILL SWITCH under a stolen agent key.
//
// On-chain primitive: AccountKeychain.revokeKey(keyId), called by the owner's root account. The key is permanently
// inactive: every payment it signs is refused with KeyAlreadyRevoked, and it can never be re-authorized for this account.
// The owner approves it in their own wallet (owner page, owner.ts); the command then reads the chain: the transaction (from
// the owner, to the keychain, the exact calldata, fee payer the owner) and the key (isRevoked). With --owner-key-file <path>
// it signs with that key file instead (tests and automation only).
//
// What a revoke does NOT stop: a payment session the key already opened. superstables budget never opens one (buy is a
// one-off charge), but the key could have been used elsewhere. After the revoke this script scans the channel reserve and
// prints the residual exposure: every channel of this key that still holds a deposit. It only reports.
//
// Usage:
//   npx tsx budget/tempo/revokeBudget.ts [--agent <label> | --key <address>] [--lookback-blocks 300000]
//                                        [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 revoked (or already revoked), 1 the key still reads as live or the session scan failed, 3 refused (never
// authorized, the owner rejected or the link expired), 5 the wallet may have sent it but the chain does not show it.

import type { Address, Hex } from 'viem'
import { addressCheck, intCheck, labelCheck, parseCli } from './lib/args.mjs'
import { explorerTx, fromBaseUnits, loadOwnerKeyFile, loadPublicEnv, makeClient, ownerAccount } from './lib/common.ts'
import { chainHead, readKey, sleep } from './lib/chain.ts'
import { closeGracePeriod, findOpenChannels, type OpenChannel } from './lib/channels.ts'
import { OWNER_KEY_FILE, checkOwnerKeyFile } from '../owner-page.ts'
import { KEYCHAIN, MIN_FEE_BALANCE, agentFlag, askTransaction, closeOwnerPage, emit, endUnapproved, feeTokenOf, findKeyEvent, readSent, revokeCalldata, revokeTerms, tokenBalance } from './owner.ts'

const { values: args } = parseCli({
  name: 'revokeBudget.ts',
  summary: 'Revoke an agent access key (the owner approves it in their own wallet), then list any payment sessions it left open.',
  flags: {
    agent: { type: 'string', metavar: 'label', desc: 'Agent label; omit for the primary agent', check: labelCheck },
    key: { type: 'string', metavar: 'address', desc: 'Revoke this key address instead (e.g. a throwaway key)', check: addressCheck },
    'lookback-blocks': { type: 'string', metavar: 'n', desc: 'How far back to look for channels (default 300000, about 50 hours)', check: intCheck(1) },
    timeout: { type: 'string', metavar: 'seconds', desc: 'How long the approval link stays open (default 600)', check: intCheck(1) },
    'no-open': { type: 'boolean', desc: 'Do not open the link in the default browser' },
    'owner-key-file': { type: 'string', metavar: 'path', desc: 'Tests and automation only: sign with this owner key file (mode 600) instead of the wallet' },
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
  const pub = loadPublicEnv()
  const owner = pub.OWNER_ADDRESS as Address | undefined
  const agentAddress = (typeof args.key === 'string' ? args.key : pub[`AGENT${agentLabel}_ADDRESS`]) as Address | undefined
  if (!owner || !agentAddress) {
    console.log('REFUSED: the public file names no owner or no agent. Nothing was sent.')
    process.exit(emit('revokeBudget', 3, { state: 'refused_precheck', reason: 'the public file names no owner or no agent', next: 'superstables budget setup --rail tempo' }))
  }
  console.log(`Revoking agent access key ${agentAddress} on owner ${owner}`)

  const before = await readKey(owner, agentAddress)
  const headStart = await chainHead()
  const fromBlock = headStart.number > lookback ? headStart.number - lookback : 0n
  const grace = await closeGracePeriod()
  let hash: Hex | null = null
  let finish: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null

  if (before.revoked) console.log('The key is already revoked; nothing to send.')
  else if (!before.exists) {
    console.log('REFUSED: the key was never authorized on this owner; there is nothing to revoke. Nothing was sent.')
    process.exit(emit('revokeBudget', 3, { state: 'refused_precheck', reason: 'the key was never authorized on this owner; there is nothing to revoke', next: 'none' }))
  } else if (OWNER_KEY_FILE) {
    checkOwnerKeyFile(OWNER_KEY_FILE)
    const account = ownerAccount(loadOwnerKeyFile(OWNER_KEY_FILE))
    if (account.address.toLowerCase() !== owner.toLowerCase()) {
      console.log(`REFUSED: the key in ${OWNER_KEY_FILE} is not the recorded owner ${owner}. Nothing was sent.`)
      process.exit(emit('revokeBudget', 3, { state: 'refused_precheck', reason: 'the owner key file is not the recorded owner', next: 'pass the owner key file of the recorded owner' }))
    }
    try {
      const { receipt } = await makeClient(account).accessKey.revokeSync({ accessKey: agentAddress })
      hash = receipt.transactionHash
      console.log(`\ntx hash: ${hash}\nexplorer: ${explorerTx(hash)}\nstatus: ${receipt.status}`)
    } catch (err) {
      // An error here does not mean the revoke failed: the transaction may have landed. Read the chain.
      console.log(`\nThe send raised an error (${String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 160)}). Reading the chain to see whether the revoke landed.`)
    }
  } else {
    let feeToken: Address
    try {
      feeToken = await feeTokenOf(owner)
    } catch (err) {
      const reason = `could not read the owner's fee token from the FeeManager (${String((err as Error)?.message ?? err).slice(0, 120)})`
      console.log(`REFUSED: ${reason}. Nothing was sent.`)
      process.exit(emit('revokeBudget', 3, { state: 'refused_precheck', reason, next: 'check the Moderato RPC (superstables budget doctor --rail tempo), then revoke again' }))
    }
    const feeBalance = await tokenBalance(feeToken, owner)
    if (feeBalance < MIN_FEE_BALANCE) {
      const reason = `the owner ${owner} holds ${fromBaseUnits(feeBalance)} of its fee token ${feeToken}, less than the ${fromBaseUnits(MIN_FEE_BALANCE)} the revoke's network fee may need`
      console.log(`REFUSED: ${reason}. Nothing was sent.`)
      process.exit(emit('revokeBudget', 3, { state: 'refused_precheck', reason, next: 'fund the owner (npx tsx budget/tempo/setup.ts --fund-only), then revoke again' }))
    }
    const data = revokeCalldata(agentAddress)
    const { handle, outcome } = await askTransaction('revoke', owner, { to: KEYCHAIN, data }, revokeTerms({ owner, agent: agentAddress, remaining: before.remaining, expiry: before.expiry, feeToken, label: agentLabel }))
    if (outcome.status === 'rejected' || outcome.status === 'expired') await endUnapproved('revokeBudget', outcome, { remaining: fromBaseUnits(before.remaining) })
    if (outcome.status !== 'sent') throw new Error(`unexpected owner page outcome ${outcome.status}`)
    finish = handle.finish
    console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`)
    let sent = await readSent(outcome.hash as Hex, { from: owner, data, afterBlock: headStart.number })
    if (!sent) {
      const alt = await findKeyEvent('revoked', owner, agentAddress, headStart.number).catch(() => null)
      if (alt) sent = await readSent(alt, { from: owner, data, afterBlock: headStart.number })
    }
    if (!sent) {
      handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity.", hash: outcome.hash })
      await closeOwnerPage()
      process.exit(emit('revokeBudget', 5, { state: 'unknown', tx: outcome.hash, reason: 'the wallet reported a transaction the chain does not show (replaced, dropped or still pending)', next: `superstables budget status --rail tempo${agentFlag(agentLabel)}` }))
    }
    hash = sent.hash
    console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, transaction type ${sent.type}, fee payer ${sent.feePayer ?? 'n/a (the sender)'}, fee token ${sent.feeToken ?? 'n/a'}`)
    console.log(`explorer: ${explorerTx(hash)}`)
    if (sent.status === 'success' && sent.problems.length) {
      const reason = `the transaction on chain is not the one planned: ${sent.problems.join('; ')}`
      console.log(`MISMATCH: ${reason}`)
      const now = await readKey(owner, agentAddress).catch(() => null)
      handle.finish({ ok: false, message: `The chain shows a different transaction than planned (${sent.problems.join('; ')}). Check the key and revoke again.`, hash })
      await closeOwnerPage()
      process.exit(emit('revokeBudget', 3, { state: 'mismatch', tx: hash, revoked: now ? now.revoked : null, reason, next: `revoke again (superstables budget revoke --rail tempo${agentFlag(agentLabel)}) and check superstables budget status --rail tempo${agentFlag(agentLabel)}` }))
    }
  }

  let after = await readKey(owner, agentAddress)
  for (let i = 0; i < 8 && hash && !after.revoked; i++) {
    await sleep(2000)
    after = await readKey(owner, agentAddress)
  }
  console.log(`readback: isRevoked ${after.revoked}`)
  let unclosed = 0
  let scanFailed = false
  try {
    unclosed = (await residualScan(owner, agentAddress, fromBlock, grace, 'Open payment sessions of this key (report only)')).unclosed
  } catch (err) {
    console.log(`\nSession scan FAILED (${String((err as Error).message).slice(0, 160)}). Residual exposure from payment sessions is UNKNOWN.`)
    scanFailed = true
  }
  if (after.revoked && unclosed) console.log('\nThis revoke does not stop those sessions. Close them with the tool that opened them.')
  if (!after.revoked) {
    finish?.({ ok: false, message: 'The chain still shows the key as live. Run the revoke again.', hash: hash ?? undefined })
    await closeOwnerPage()
    process.exit(emit('revokeBudget', 1, { state: 'not_revoked', tx: hash, reason: 'the key still reads as live on chain', next: 'run revoke again' }))
  }
  finish?.({ ok: true, message: `Done. The chain shows the key as revoked: your agent can spend nothing more with it.${unclosed ? ' The terminal lists payment sessions it left open.' : ''} You can close this page.`, hash: hash ?? undefined })
  await closeOwnerPage()
  process.exit(emit('revokeBudget', scanFailed ? 1 : 0, { state: scanFailed ? 'failed' : 'revoked', tx: hash, remaining: fromBaseUnits(after.remaining), openSessions: unclosed, reason: scanFailed ? 'revoked, but the session scan failed: residual exposure is unknown' : undefined, next: 'none' }))
}

main().catch((err) => {
  console.error('revokeBudget failed:', String(err?.shortMessage ?? err?.message ?? err).slice(0, 400))
  process.exit(1)
})
