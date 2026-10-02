// setBudget(amount, expiry, sellers?): the owner authorizes the agent's access key.
//
// On-chain primitive: AccountKeychain.authorizeKey (precompile 0xaAAAaaAA00000000000000000000000000000000), called by the
// owner's root account. Sets a per-token spending limit (pathUSD), an expiry, and an optional recipient allowlist (TIP-1011
// call scoping on transfer and transferWithMemo) for the agent's access key.
//
// The owner approves it in their own wallet: this script builds the calldata and the terms, opens the owner page
// (owner.ts; on a hosted chain, the link on superstables.com), waits, and then reads the chain: the transaction (from the owner, to the keychain, the exact calldata, fee
// payer the owner) and the key (secp256k1, the planned expiry, the limit, the period, the seller scope, not an admin key).
// With --owner-key-file <path> it signs with that key file instead (tests and automation only).
//
// What can move by expiry (contract rule 2), as measured on Moderato:
//   * no --period-seconds: one-time limit. Exactly `amount` in total, ever.
//   * --period-seconds P: the remaining amount resets to the full `amount` whenever the chain time reaches periodEnd, and
//     the first window starts at authorization. Every window that starts before expiry can be spent in full, so the total
//     by expiry is amount x ceil(expirySeconds / P). The page and the log print that number before anything is sent.
//   * Fees paid in pathUSD by the owner for the agent's payments count against the same limit.
// The script refuses (exit 3) if the agent key is already authorized or revoked: authorizeKey on a live key reverts with
// KeyAlreadyExists and a revoked key can never be authorized again. To change a budget, revoke it and grant a fresh key.
//
// Usage:
//   npx tsx budget/tempo/setBudget.ts --amount 1 --expiry-seconds 86400 [--agent 2] [--sellers <a>,<b>] [--period-seconds 3600]
//                                     [--timeout <s>] [--no-open] [--owner-key-file <path>]
// Exit codes: 0 set, 1 failed or reverted, 3 refused (live or revoked key, the owner rejected or the link expired, the key on
// chain is not the planned one), 5 the wallet may have sent it but the chain does not show it.

import { Scopes } from 'viem/tempo'
import type { Address, Hex } from 'viem'
import { addressListCheck, decimalCheck, intCheck, labelCheck, parseCli } from './lib/args.mjs'
import { TOKEN_ADDRESS, TOKEN_LABEL, explorerTx, fromBaseUnits, loadOwnerKeyFile, loadPublicEnv, makeClient, ownerAccount, toBaseUnits } from './lib/common.ts'
import { chainHead, readKey, rpcRead, sleep } from './lib/chain.ts'
import { OWNER_KEY_FILE, OWNER_TIMEOUT_MS, checkOwnerKeyFile } from '../owner-page.ts'
import {
  KEYCHAIN, MIN_FEE_BALANCE, agentFlag, askTransaction, closeOwnerPage, emit, endUnapproved, feeTokenOf, findKeyEvent, grantCalldata,
  grantTerms, iso, maxByExpiry, readSent, readUntilMatches, tokenBalance, useHostedAgent, type GrantPlan,
} from './owner.ts'

const { values: args } = parseCli({
  name: 'setBudget.ts',
  summary: `Authorize an agent access key with a ${TOKEN_LABEL} limit and an expiry. The owner approves it in their own wallet. Prints the most that can move by expiry.`,
  flags: {
    amount: { type: 'string', required: true, metavar: 'amount', desc: `Limit in ${TOKEN_LABEL} (per period with --period-seconds, in total without)`, check: decimalCheck(6) },
    'expiry-seconds': { type: 'string', required: true, metavar: 'seconds', desc: 'Key lifetime from now', check: intCheck(1) },
    'period-seconds': { type: 'string', metavar: 'seconds', desc: 'Recurring limit: the amount resets every period', check: intCheck(1) },
    sellers: { type: 'string', metavar: 'a,b', desc: 'Only these recipients (transfer and transferWithMemo)', check: addressListCheck },
    agent: { type: 'string', metavar: 'label', desc: 'Agent label (AGENT<label>_ADDRESS); omit for the primary agent', check: labelCheck },
    timeout: { type: 'string', metavar: 'seconds', desc: 'How long the approval link stays open (default 600)', check: intCheck(1) },
    'no-open': { type: 'boolean', desc: 'Do not open the link in the default browser' },
    'owner-key-file': { type: 'string', metavar: 'path', desc: 'Tests and automation only: sign with this owner key file (mode 600) instead of the wallet' },
  },
  examples: ['npx tsx budget/tempo/setBudget.ts --amount 1 --expiry-seconds 86400'],
})

const result = (exit: number, o: Record<string, unknown>) => emit('setBudget', exit, o)
function refuse(reason: string, next: string, extra: Record<string, unknown> = {}): never {
  console.log(`REFUSED: ${reason}. Nothing was sent.`)
  process.exit(result(3, { state: 'refused_precheck', reason, next, ...extra }))
}

async function main() {
  const amount = args.amount as string
  const expirySeconds = Number(args['expiry-seconds'])
  const period = args['period-seconds'] ? Number(args['period-seconds']) : undefined
  const label = typeof args.agent === 'string' ? args.agent : ''
  const sellers = typeof args.sellers === 'string' ? (args.sellers.split(',').map((s) => s.trim()) as Address[]) : undefined
  const limit = toBaseUnits(amount)

  const pub = loadPublicEnv()
  const owner = pub.OWNER_ADDRESS as Address | undefined
  const agent = pub[`AGENT${label}_ADDRESS`] as Address | undefined
  if (!owner || !agent) refuse(`the public file names no owner or no agent${label ? ` ${label}` : ''}`, `superstables budget setup --rail tempo${agentFlag(label)}`)

  // Refuse before anything is signed if the key is already authorized or burned.
  const before = await readKey(owner, agent)
  if (before.exists || before.revoked) {
    refuse(
      before.revoked
        ? `agent key ${agent} is revoked, and a revoked key can never be authorized again`
        : `agent key ${agent} is already authorized (expiry ${new Date(before.expiry * 1000).toISOString()}, remaining ${fromBaseUnits(before.remaining)} ${TOKEN_LABEL}). Revoke it first, then grant a fresh key`,
      before.revoked ? 'make a new agent key: superstables budget setup --rail tempo --agent LABEL, then grant with --agent LABEL' : `revoke first (superstables budget revoke --rail tempo${agentFlag(label)}), then grant a new key`,
    )
  }

  const { windows, max } = maxByExpiry(limit, expirySeconds, period)
  console.log(`Authorizing agent access key ${agent} on owner ${owner}`)
  console.log(`  limit: ${amount} ${TOKEN_LABEL} (${limit} base units)${period ? `, resets every ${period}s` : ' (one-time, no reset)'}`)
  console.log(`  sellers: ${sellers ? sellers.join(', ') : 'any (allowAnyCalls)'}`)
  console.log(`  MAXIMUM THAT CAN MOVE BY EXPIRY: ${fromBaseUnits(max)} ${TOKEN_LABEL} (${windows} window${windows === 1 ? '' : 's'} x ${amount})`)

  let hash: Hex
  let plan: GrantPlan
  let authorizedAt: number | undefined // the grant block's timestamp: the first period window starts there
  let finish: ((v: { ok: boolean; message: string; hash?: string }) => void) | null = null

  if (OWNER_KEY_FILE) {
    checkOwnerKeyFile(OWNER_KEY_FILE)
    const account = ownerAccount(loadOwnerKeyFile(OWNER_KEY_FILE))
    if (account.address.toLowerCase() !== owner.toLowerCase()) refuse(`the key in ${OWNER_KEY_FILE} is for ${account.address}, not the recorded owner ${owner}`, 'pass the owner key file of the recorded owner')
    const head = await chainHead()
    plan = { agent, limit, expiry: head.timestamp + expirySeconds, period, sellers }
    console.log(`  expiry: ${new Date(plan.expiry * 1000).toISOString()} (unix ${plan.expiry}, chain time + ${expirySeconds}s)`)
    const scopes = sellers ? [Scopes.tip20(TOKEN_ADDRESS).transfer({ recipients: sellers }), Scopes.tip20(TOKEN_ADDRESS).transferWithMemo({ recipients: sellers })] : undefined
    const { receipt } = await makeClient(account).accessKey.authorizeSync({
      accessKey: { address: agent, type: 'secp256k1' },
      expiry: plan.expiry,
      limits: [{ token: TOKEN_ADDRESS, limit, period }],
      scopes,
    })
    hash = receipt.transactionHash
    console.log(`\ntx hash: ${hash}\nexplorer: ${explorerTx(hash)}\nstatus: ${receipt.status}`)
    if (receipt.status !== 'success') process.exit(result(1, { state: 'failed', tx: hash, reason: 'the authorizeKey transaction reverted', next: 'superstables budget status --rail tempo' }))
    const block = await rpcRead('eth_getBlockByNumber', ['0x' + receipt.blockNumber.toString(16), false]).catch(() => null)
    authorizedAt = block?.timestamp ? parseInt(block.timestamp, 16) : undefined
  } else {
    // Refuse here, before any link exists, whatever would make the owner's approval fail or pointless.
    if (expirySeconds * 1000 <= OWNER_TIMEOUT_MS + 60_000) refuse(`the key would expire (in ${expirySeconds}s) before the approval link does (${Math.round(OWNER_TIMEOUT_MS / 1000)}s)`, 'grant with a later --expiry, or a shorter --timeout')
    const feeToken = await feeTokenOf(owner).catch((err) => refuse(`could not read the owner's fee token from the FeeManager (${String(err?.message ?? err).slice(0, 120)})`, 'check the Moderato RPC (superstables budget doctor --rail tempo), then grant again'))
    const feeBalance = await tokenBalance(feeToken, owner)
    if (feeBalance < MIN_FEE_BALANCE) {
      refuse(`the owner ${owner} holds ${fromBaseUnits(feeBalance)} of its fee token ${feeToken}, less than the ${fromBaseUnits(MIN_FEE_BALANCE)} a grant's network fee may need`, 'fund the owner (superstables budget setup --rail tempo --fund-only uses the Moderato faucet), then grant again')
    }
    const held = await tokenBalance(TOKEN_ADDRESS, owner)
    const head = await chainHead()
    plan = { agent, limit, expiry: head.timestamp + expirySeconds, period, sellers }
    console.log(`  expiry: ${new Date(plan.expiry * 1000).toISOString()} (unix ${plan.expiry}, chain time + ${expirySeconds}s)`)
    const data = grantCalldata(plan)
    useHostedAgent(agent) // a hosted chain: this agent key signs the request to the site
    const { handle, outcome } = await askTransaction('grant', owner, { to: KEYCHAIN, data }, grantTerms({ ...plan, owner, expirySeconds, held, feeToken, label }))
    if (outcome.status === 'rejected' || outcome.status === 'expired') await endUnapproved('setBudget', outcome, { requested: amount }, `superstables budget status --rail tempo${agentFlag(label)}`)
    if (outcome.status !== 'sent') throw new Error(`unexpected owner page outcome ${outcome.status}`)
    finish = handle.finish
    console.log(`the wallet reported transaction ${outcome.hash}; checking it on chain`)
    let sent = await readSent(outcome.hash as Hex, { from: owner, data, afterBlock: head.number })
    if (!sent) {
      // replaced ("speed up") or dropped: look for the keychain's own event for this key
      const alt = await findKeyEvent('authorized', owner, agent, head.number).catch(() => null)
      if (alt) {
        console.log(`the reported transaction is not on chain, but ${alt} authorized the key after this request started; reading that one`)
        sent = await readSent(alt, { from: owner, data, afterBlock: head.number })
      }
    }
    if (!sent) {
      handle.finish({ ok: false, message: "The transaction did not show up on chain. Check your wallet's activity; the command reports it as unknown.", hash: outcome.hash })
      await closeOwnerPage()
      process.exit(result(5, { state: 'unknown', tx: outcome.hash, reason: 'the wallet reported a transaction the chain does not show (replaced, dropped or still pending)', next: `superstables budget status --rail tempo${agentFlag(label)}: read the key before granting again` }))
    }
    hash = sent.hash
    authorizedAt = sent.blockTimestamp
    console.log(`receipt: ${sent.status}, block ${sent.blockNumber}, transaction type ${sent.type}, fee payer ${sent.feePayer ?? 'n/a (the sender)'}, fee token ${sent.feeToken ?? 'n/a'}`)
    if (sent.feeToken && sent.feeToken.toLowerCase() !== feeToken.toLowerCase()) console.log(`note: the fee was paid in ${sent.feeToken}, not the expected ${feeToken}`)
    if (sent.status !== 'success') {
      handle.finish({ ok: false, message: 'The transaction reverted. No access key was granted by it, but a network fee may have been charged.', hash })
      await closeOwnerPage()
      process.exit(result(1, { state: 'failed', tx: hash, reason: 'the authorizeKey transaction reverted on chain', next: `superstables budget status --rail tempo${agentFlag(label)}` }))
    }
    // Any difference from the plan is a mismatch, whatever the key reads afterwards: the wallet already sent it.
    if (sent.problems.length) {
      const reason = `the transaction on chain is not the one planned: ${sent.problems.join('; ')}`
      console.log(`MISMATCH: ${reason}`)
      handle.finish({ ok: false, message: `The chain shows a different transaction than planned (${sent.problems.join('; ')}). Revoke it: superstables budget revoke --rail tempo${agentFlag(label)}.`, hash })
      await closeOwnerPage()
      process.exit(result(3, { state: 'mismatch', tx: hash, reason, next: `revoke it (superstables budget revoke --rail tempo${agentFlag(label)}), then grant a new key` }))
    }
  }

  // Read back what the chain stored: the key must be exactly the plan.
  if (period && authorizedAt === undefined) console.log('note: the grant block time could not be read, so the period is checked only as present')
  const { key, problems } = await readUntilMatches(owner, agent, plan, authorizedAt)
  console.log(`readback: type ${key.signatureType}, expiry ${key.expiry}, limits ${key.enforceLimits}, remaining ${fromBaseUnits(key.remaining)}, periodEnd ${key.periodEnd || 'none (one-time)'}, scoped ${key.scoped}, admin ${key.admin}, revoked ${key.revoked}`)
  if (problems.length) {
    const reason = `the key on chain is not the planned one: ${problems.join('; ')}`
    console.log(`REFUSED: ${reason}`)
    finish?.({ ok: false, message: `The chain shows a different key than planned (${problems.join('; ')}). Revoke it: superstables budget revoke --rail tempo${agentFlag(label)}.`, hash })
    await closeOwnerPage()
    process.exit(result(3, { state: 'mismatch', tx: hash, reason, next: `revoke it (superstables budget revoke --rail tempo${agentFlag(label)}), then grant a new key` }))
  }
  let trueMax = max
  let trueWindows = windows
  if (period && key.periodEnd) {
    const start = key.periodEnd - period
    trueWindows = Math.ceil((key.expiry - start) / period)
    trueMax = limit * BigInt(trueWindows)
  }
  console.log(`readback maximum by expiry: ${fromBaseUnits(trueMax)} ${TOKEN_LABEL} (${trueWindows} window${trueWindows === 1 ? '' : 's'})`)
  console.log(`explorer: ${explorerTx(hash)}`)
  const expiryIso = iso(key.expiry)
  finish?.({ ok: true, message: `Done. The chain shows your agent's key with a limit of ${fromBaseUnits(limit)} ${TOKEN_LABEL}${period ? ` per period (planned maximum ${fromBaseUnits(trueMax)} by expiry)` : ''}, until ${expiryIso}${sellers ? ', for the listed sellers only' : ''}. You can close this page.`, hash })
  await closeOwnerPage()
  process.exit(result(0, {
    state: 'set', tx: hash, limit: fromBaseUnits(limit), remaining: fromBaseUnits(key.remaining), expiry: expiryIso, periodSeconds: period ?? null,
    sellers: sellers ?? null, maxByExpiry: fromBaseUnits(trueMax), enforcedOnChain: { limit: true, expiry: true, period: !!period, sellers: !!sellers }, next: 'agent: buy',
  }))
}

main().catch((err) => {
  console.error('setBudget failed:', err?.shortMessage ?? err?.message ?? err)
  process.exit(1)
})
