// setup for the tempo rail: make this machine an agent and record who its owner is. No owner key is ever created or stored.
//   1. The agent key file ($SUPERSTABLES_HOME/keys/budget/tempo-agent.env, mode 600): AGENT_PRIVATE_KEY, its address and,
//      once known, the owner's public OWNER_ADDRESS (buy binds the access key to it). Created if missing, never overwritten.
//   2. The owner connects their own wallet (MetaMask or any EIP-1193 wallet) on the owner page and signs a free sign-in
//      message: it proves the address is theirs and sends nothing. With --owner-key-file <path> the address comes from that
//      key instead (tests and automation only).
//   3. The public file: owner and agent addresses, no secret.
//   4. If the owner holds less than 1 pathUSD, the Moderato faucet (tempo_fundAddress) tops it up. The agent needs nothing:
//      its access key spends the owner's pathUSD and the fees come from the owner.
//
//   setup.ts                        the above
//   setup.ts --agent <label>        a new agent key AGENT<label>_* (key to the agent file, address to the public file), for the
//                                   next budget after a revoke or an expiry. Needs the owner recorded already; no page. On a
//                                   hosted chain the owner links the new key on the site (one link; the site must name the
//                                   owner on record).
//   setup.ts --fund-only            fund the recorded owner from the Moderato faucet, change no file
//
//   setup.ts --new-owner            replace the recorded owner (refused while any agent key in the agent file is live on it)
//
// --hosted [--site URL] [--grant A]: the owner approves on superstables.com instead of the page on this computer. Step 2 is
// then a link: the agent key signs a link request, the owner signs in to the site with their wallet, picks the match code
// and links this agent to their account; the account's address becomes the owner on record, and the public file gets
// APPROVALS=hosted and SITE, so grant and revoke ask through the site from then on. With --grant A the same page then asks
// the owner's wallet for the grant (authorizeKey for A pathUSD in total, expiring 24 hours after the request), built as
// grant builds it; the command reads it from the chain with grant's checks before it reports it.
//
// Setup is a trusted step: the signature proves control of the connected address, not that it is the intended owner, so
// the owner runs it or watches it run, and an agent must not complete it. A recorded owner never changes silently.
// Never prints a private key.
// Usage: npx tsx budget/tempo/setup.ts [--agent <label>] [--fund-only] [--new-owner] [--hosted [--site <url>] [--grant <amount>]]
//                                      [--timeout <s>] [--no-open] [--owner-key-file <path>]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { LABEL, decimalCheck, intCheck, labelCheck, parseCli } from './lib/args.mjs'
import { AGENT_ENV_PATH, PUBLIC_ENV_PATH, RPC_URL, TOKEN_ADDRESS, TOKEN_LABEL, appendExtraAgent, explorerTx, fromBaseUnits, loadOwnerKeyFile, loadPublicEnv, parseEnvFile, agentFileText, setAgentPublic, toBaseUnits, writePublicEnv } from './lib/common.ts'
import { NEW_OWNER, OWNER_KEY_FILE, checkOwnerKeyFile } from '../owner-page.ts'
import { UNSAFE_SECRET_FILE } from '../secret-file.mjs'
import { siteFailedWords, type HostedStep, type HostedStepOutcome, type PriorLink } from '../hosted.ts'
import { chosenSite, isSiteRequestId, siteOrigin } from '../site.mjs'
import { KEYCHAIN, approvalSite, askConnect, checkGrantSent, closeOwnerPage, emit, endUnapproved, grantCalldata, iso, tokenBalance, useApprovalSite, useHostedAgent, type GrantPlan, type SentCheck } from './owner.ts'
import { chainHead, readKey } from './lib/chain.ts'

const { values: args } = parseCli({
  name: 'setup.ts',
  summary: 'Create the agent key file (never overwritten), let the owner connect their own wallet on the owner page, and write the public file. No owner key is created.',
  flags: {
    agent: { type: 'string', metavar: 'label', desc: 'Add a new agent key AGENT<label> (for the next budget after a revoke)', check: labelCheck },
    'fund-only': { type: 'boolean', desc: 'Fund the recorded owner from the Moderato faucet, change no file' },
    'new-owner': { type: 'boolean', desc: 'Replace the recorded owner with the wallet that connects (refused while a key is live)' },
    hosted: { type: 'boolean', desc: 'The owner approves on superstables.com (adds this agent to their account) instead of a page here' },
    site: { type: 'string', metavar: 'url', desc: 'With --hosted: the site (default superstables.com, or SUPERSTABLES_SITE)' },
    grant: { type: 'string', metavar: 'amount', desc: `With --hosted: on the same page, a budget of this many ${TOKEN_LABEL} in total for 24 hours`, check: decimalCheck(6) },
    timeout: { type: 'string', metavar: 'seconds', desc: 'How long the approval link stays open (default 600)', check: intCheck(1) },
    'no-open': { type: 'boolean', desc: 'Do not open the approval link in the default browser' },
    'owner-key-file': { type: 'string', metavar: 'path', desc: 'Tests and automation only: record this owner key file\'s address instead of asking the wallet' },
  },
  examples: ['npx tsx budget/tempo/setup.ts', 'npx tsx budget/tempo/setup.ts --agent 2', 'npx tsx budget/tempo/setup.ts --hosted --grant 1'],
})

const MIN_OWNER = 1_000_000n // 1 pathUSD, what doctor asks for
/** A grant asked for in setup --hosted --grant lasts this long, as grant's default. */
const GRANT_SECONDS = 86_400
const same = (x?: string, y?: string) => !!x && !!y && x.toLowerCase() === y.toLowerCase()
const result = (exit: number, o: Record<string, unknown>) => emit('setup', exit, o)
const usage = (message: string): never => {
  process.stderr.write(`setup.ts: ${message}\n`)
  process.exit(2)
}

async function fundAddress(address: string): Promise<string[]> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [address] }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json()
  if (json.error) throw new Error(`tempo_fundAddress failed for ${address}: ${JSON.stringify(json.error)}`)
  return json.result as string[]
}

async function faucet(owner: string) {
  console.log(`Funding the owner ${owner} from the Moderato faucet (tempo_fundAddress, test pathUSD)...`)
  for (const h of await fundAddress(owner)) console.log(`  https://explore.testnet.tempo.xyz/tx/${h}`)
}

// hosted approvals: the site, chosen here (--site, else SUPERSTABLES_SITE, else superstables.com)
const HOSTED = args.hosted === true
let SITE: string | null = null
if (HOSTED) {
  if (OWNER_KEY_FILE) usage('--hosted asks the owner on the site; with --owner-key-file there is no owner to ask')
  if (typeof args.agent === 'string') usage('--agent on a hosted chain adds the new key on the site by itself: drop --hosted')
  const s = chosenSite(typeof args.site === 'string' ? args.site : undefined)
  if (s.error) usage(`--site: ${s.error}`)
  SITE = s.origin as string
} else if (typeof args.site === 'string') usage('--site goes with --hosted')
// The setup command that replaces the owner. On a hosted chain it names --hosted and the exact site: without them, setup
// would ask on the page on this computer and move the chain's approvals there, or take SUPERSTABLES_SITE.
const newOwnerCmd = (site: string | null | undefined) => `superstables budget setup --rail tempo${site ? ` --hosted --site ${site}` : ''} --new-owner`
const GRANT = typeof args.grant === 'string' ? args.grant : undefined
if (GRANT !== undefined && !HOSTED) usage('--grant goes with --hosted: without it, run setup, then grant')
const LIMIT = GRANT !== undefined ? toBaseUnits(GRANT) : undefined
if (LIMIT === 0n) usage('--grant must be above 0')
const HOST = SITE ? new URL(SITE).host.replace(/^www\./, '') : ''

/** setup --agent on a hosted chain: the owner links the new key on the site; the site must name the owner on record. */
async function linkExtraAgent(label: string, address: Address, owner: Address) {
  const site = approvalSite()!
  const host = new URL(site).host.replace(/^www\./, '')
  useHostedAgent(address)
  // this key's own link, when it was linked before (AGENT<label>_LINK_ID and _LINK_CODE): an "already linked" answer is
  // checked against it; without it only a fresh link the owner signs counts
  const pub = loadPublicEnv()
  const id = pub[`AGENT${label}_LINK_ID`]
  const code = pub[`AGENT${label}_LINK_CODE`]
  const prior: PriorLink | null = isSiteRequestId(id) && code ? { owner, linkId: id, linkCode: code } : null
  const { outcome, link } = await askConnect('setup', {
    title: `Add this agent's new key to your ${host} account`,
    summary: `Sign in to ${host} with your wallet and add the agent's new key ${address} to your account, so you can grant it a budget there. This does not grant a budget or send a transaction.`,
    rows: [
      { label: 'New agent key', value: address, mono: true },
      { label: 'Chain', value: 'Tempo Testnet (Moderato)' },
      { label: 'Agent key', value: `on this computer only, in ${AGENT_ENV_PATH}` },
    ],
    enforced: [],
    notEnforced: [],
    notes: [`You pick the match code your agent shows you before the key is added. The agent key stays on this computer; ${host} does not receive it.`],
  }, '', undefined, undefined, { prior })
  if (outcome.status === 'rejected' || outcome.status === 'expired') await endUnapproved('setup', outcome, { agent: address, linked: false })
  if (outcome.status !== 'connected') throw new Error(`unexpected approval outcome ${outcome.status}`)
  if (!same(outcome.address, owner)) {
    await closeOwnerPage(0)
    const reason = `${host} added the key ${address} to the account ${outcome.address}, but this computer records the owner ${owner}`
    console.log(`REFUSED: ${reason}.`)
    process.exit(result(3, { state: 'refused_precheck', reason, owner, agent: address, next: `remove this key from that account on ${host}; grant only from the account ${owner}` }))
  }
  await closeOwnerPage(0)
  if (!link) throw new Error('an add-agent request without its id and code')
  writePublicEnv({ [`AGENT${label}_LINK_ID`]: link.id, [`AGENT${label}_LINK_CODE`]: link.code })
  console.log(`Key ${address} added to the ${host} account ${owner}`)
  process.exit(result(0, { state: 'ok', owner, agent: address, linked: true, next: `superstables budget grant --rail tempo --agent ${label} --amount A (the owner approves it on ${host}, in their wallet)` }))
}

function refuseAgentFile(reason: string): never {
  console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`)
  process.exit(result(3, { state: 'refused_precheck', reason, next: `make ${AGENT_ENV_PATH} a regular file only you can read (chmod 600), then run setup again` }))
}
/** The agent file's text ("" when there is none), or a refusal (exit 3) when other users can read it or it is not a regular file. */
function agentFileTextOrRefuse(): string {
  const file = agentFileText()
  return file.problem === undefined ? file.text : refuseAgentFile(file.problem)
}
/** Runs a helper that reads and rewrites the agent file; its refusal of an unsafe file becomes this command's refusal. */
function refuseAgentFileErrors<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === UNSAFE_SECRET_FILE) refuseAgentFile((err as Error).message)
    throw err
  }
}

/** An agent file's key line (AGENT_PRIVATE_KEY, AGENT<label>_PRIVATE_KEY) and an address line in either file, by label. */
const KEY_LINE = new RegExp(`^AGENT(${LABEL})?_PRIVATE_KEY$`)
const ADDRESS_LINE = new RegExp(`^AGENT(${LABEL})?_ADDRESS$`)
const isAddressValue = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/** The access keys the public file records, by label ('' for the default key): what revoke [--agent LABEL] acts on. */
function publicKeys(pub: Record<string, string>): { label: string; address: Address }[] {
  return Object.entries(pub).flatMap(([k, v]) => {
    const m = ADDRESS_LINE.exec(k)
    return m && isAddressValue(v) ? [{ label: m[1] ?? '', address: v }] : []
  })
}

/**
 * Every access key either file records: the agent file's keys, by the address derived from each private key, its address
 * lines without a key, and the public file's key addresses. A stored address line that is missing or names another
 * address than its key is a refusal: the owner is never replaced on the strength of a line that does not match the key it
 * stands for.
 */
function recordedKeys(pub: Record<string, string>): Address[] {
  const env = parseEnvFile(agentFileTextOrRefuse())
  const keys: Address[] = []
  const add = (a: Address) => { if (!keys.some((k) => same(k, a))) keys.push(a) }
  for (const [k, v] of Object.entries(env)) {
    const m = KEY_LINE.exec(k)
    if (!m) continue
    const line = `AGENT${m[1] ?? ''}_ADDRESS`
    let derived: Address | null = null
    try { derived = privateKeyToAddress(v as `0x${string}`) } catch {}
    const problem = !derived ? `${k} is not a private key` : !env[line] ? `${line} is missing for its key ${derived}` : !same(env[line], derived) ? `${line} is ${env[line]}, not the address of its key (${derived})` : ''
    if (problem) {
      const reason = `the agent key file does not match its keys: ${problem}; the owner is not replaced`
      console.log(`REFUSED: ${reason}. Nothing was changed.`)
      process.exit(result(3, { state: 'refused_precheck', reason, next: `${derived ? `put ${line}=${derived} in ${AGENT_ENV_PATH}` : `restore ${AGENT_ENV_PATH}`}, then run the same command again` }))
    }
    add(derived!)
  }
  // address lines without their key, in either file: still checked (the key may be elsewhere)
  for (const [k, v] of Object.entries(env)) if (ADDRESS_LINE.test(k) && isAddressValue(v)) add(v)
  for (const { address } of publicKeys(pub)) add(address)
  return keys
}

async function main() {
  const pub = loadPublicEnv()

  if (args['fund-only']) {
    if (!pub.OWNER_ADDRESS) process.exit(result(3, { state: 'refused_precheck', reason: 'no owner is recorded yet', next: 'superstables budget setup --rail tempo' }))
    await faucet(pub.OWNER_ADDRESS)
    process.exit(result(0, { state: 'ok', owner: pub.OWNER_ADDRESS, next: 'superstables budget doctor --rail tempo' }))
  }

  // Every path below reads or rewrites the agent key file, through agentFileTextOrRefuse or a helper that checks the same
  // way. Reusing a file other users can read would hand the owner's budget to a key they may already hold, and the file
  // can change while setup waits for the owner, so it is read again, never kept.
  agentFileTextOrRefuse()

  if (typeof args.agent === 'string') {
    const label = args.agent
    if (!pub.OWNER_ADDRESS || !existsSync(AGENT_ENV_PATH)) process.exit(result(3, { state: 'refused_precheck', reason: 'run setup without --agent first: no owner is recorded yet', next: 'superstables budget setup --rail tempo' }))
    // a new key for the owner on record only: an agent key file bound to another owner is a conflict, not a choice
    const boundTo = parseEnvFile(agentFileTextOrRefuse()).OWNER_ADDRESS
    if (boundTo && !same(boundTo, pub.OWNER_ADDRESS)) {
      const reason = `the owner files disagree: ${PUBLIC_ENV_PATH} records the owner ${pub.OWNER_ADDRESS}, and ${AGENT_ENV_PATH} is bound to ${boundTo}`
      console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`)
      const site = pub.APPROVALS === 'hosted' && pub.SITE ? siteOrigin(pub.SITE).origin : undefined
      process.exit(result(3, { state: 'refused_precheck', reason, owner: pub.OWNER_ADDRESS, next: `${newOwnerCmd(site)} records one owner again (refused while a budget is live on either), then superstables budget setup --rail tempo --agent ${label}` }))
    }
    // unbound (an interrupted setup, a backup): bind it to the owner on record, so a later setup cannot replace that owner
    // without --new-owner
    // a label the public file already records names that key for good: a grant may be live on it, and revoke --agent LABEL
    // finds it there. Never replaced by a new key under the same label.
    const recordedKey = pub[`AGENT${label}_ADDRESS`]
    const heldKey = parseEnvFile(agentFileTextOrRefuse())[`AGENT${label}_ADDRESS`]
    if (recordedKey && !(heldKey && same(heldKey, recordedKey))) {
      const reason = `${PUBLIC_ENV_PATH} already records the access key ${recordedKey} under the label ${label}, and ${heldKey ? `${AGENT_ENV_PATH} holds another key (${heldKey}) under it` : `${AGENT_ENV_PATH} holds no key for it`}; setup --agent never replaces a recorded key`
      console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`)
      process.exit(result(3, { state: 'refused_precheck', reason, owner: pub.OWNER_ADDRESS, agent: recordedKey, next: `pick another label (superstables budget setup --rail tempo --agent OTHER). If ${recordedKey} may still hold a budget, revoke it: superstables budget revoke --rail tempo --agent ${label}, approved by ${pub.OWNER_ADDRESS}` }))
    }
    if (!boundTo) refuseAgentFileErrors(() => setAgentPublic({ OWNER_ADDRESS: pub.OWNER_ADDRESS! }))
    const { address, created } = refuseAgentFileErrors(() => appendExtraAgent(label))
    console.log(`${created ? 'created' : 'reusing'} agent key AGENT${label} in ${AGENT_ENV_PATH}: ${address}`)
    if (approvalSite()) await linkExtraAgent(label, address, pub.OWNER_ADDRESS as Address)
    process.exit(result(0, { state: 'ok', owner: pub.OWNER_ADDRESS, agent: address, next: `superstables budget grant --rail tempo --agent ${label} --amount A (you approve it in your wallet)` }))
  }
  useApprovalSite(SITE)

  // 1. the agent key
  let agent: Address
  let agentOwner: string | undefined
  if (existsSync(AGENT_ENV_PATH)) {
    const env = parseEnvFile(agentFileTextOrRefuse())
    if (!env.AGENT_PRIVATE_KEY) process.exit(result(3, { state: 'refused_precheck', reason: `${AGENT_ENV_PATH} has no AGENT_PRIVATE_KEY`, next: `move ${AGENT_ENV_PATH} away if you mean to start over` }))
    try {
      agent = privateKeyToAddress(env.AGENT_PRIVATE_KEY as `0x${string}`)
    } catch {
      process.exit(result(3, { state: 'refused_precheck', reason: `${AGENT_ENV_PATH} holds an AGENT_PRIVATE_KEY that is not a key`, next: `restore ${AGENT_ENV_PATH} from a copy that has the agent key, or move it away if you mean to start over` }))
    }
    agentOwner = env.OWNER_ADDRESS
    console.log(`agent key file ${AGENT_ENV_PATH} exists; reusing it (agent ${agent})`)
  } else {
    const key = generatePrivateKey()
    agent = privateKeyToAddress(key)
    mkdirSync(dirname(AGENT_ENV_PATH), { recursive: true, mode: 0o700 })
    writeFileSync(AGENT_ENV_PATH, `# Tempo agent: access-key private keys plus public addresses. NO owner private key. Only agent commands open this file.\nAGENT_PRIVATE_KEY=${key}\nAGENT_ADDRESS=${agent}\n`, { mode: 0o600, flag: 'wx' })
    console.log(`created the agent key file ${AGENT_ENV_PATH} (mode 600): agent ${agent}`)
  }
  if (pub.AGENT_ADDRESS && !same(pub.AGENT_ADDRESS, agent)) {
    console.error(`REFUSED: ${PUBLIC_ENV_PATH} already names another agent (${pub.AGENT_ADDRESS}). Nothing was changed.`)
    process.exit(result(3, { state: 'refused_precheck', reason: 'the public file already names another agent', next: `move ${PUBLIC_ENV_PATH} away if you mean to start over` }))
  }

  useHostedAgent(agent) // hosted: this agent key signs the link request

  // 2. the owner address
  // The owner is on record when either file names it: the public file (for this agent, or with no agent named), or the
  // owner binding in the agent key file. An unbound agent key file (an interrupted setup, a backup, an edit) does not make
  // the public file's owner replaceable, and the binding alone (an interrupted first setup) is an owner too. Only
  // --new-owner replaces it, with its live-key check. Two files that name different owners are a conflict: refused, and
  // --new-owner checks both for a live key.
  const newOwner = NEW_OWNER
  const publicOwner = pub.OWNER_ADDRESS && (!pub.AGENT_ADDRESS || same(pub.AGENT_ADDRESS, agent)) ? (pub.OWNER_ADDRESS as Address) : undefined
  const recorded = (publicOwner ?? agentOwner) as Address | undefined
  const recordedSite = pub.APPROVALS === 'hosted' && pub.SITE ? siteOrigin(pub.SITE).origin : undefined
  if (agentOwner && publicOwner && !same(agentOwner, publicOwner) && !newOwner) {
    const reason = `the owner files disagree: ${PUBLIC_ENV_PATH} records the owner ${publicOwner}, and ${AGENT_ENV_PATH} is bound to ${agentOwner}`
    console.log(`REFUSED: ${reason}. Nothing was changed on this computer.`)
    process.exit(result(3, { state: 'refused_precheck', reason, owner: publicOwner, next: `${newOwnerCmd(recordedSite)} records one owner again (refused while a budget is live on either)` }))
  }
  if (newOwner && recorded) {
    // never move the owner while any agent key can still spend from a recorded one
    const keys = recordedKeys(pub)
    const owners = [publicOwner, agentOwner].filter((o, i, all): o is Address => Boolean(o) && all.findIndex((x) => x && same(x, o!)) === i)
    for (const was of owners) {
      for (const key of keys) {
        const k = await readKey(was, key).catch(() => null)
        const live = k === null ? null : k.exists && k.expiry * 1000 > Date.now()
        if (live !== false) {
          const reason = live === null ? `could not read access key ${key} on the recorded owner ${was}; the owner is not replaced` : `a budget is live: access key ${key} is authorized on the recorded owner ${was} until ${new Date(k!.expiry * 1000).toISOString()}`
          // superstables budget revoke [--agent LABEL] acts for the public file's owner and the key the public file records
          // under that label, and refuses while the files disagree: only when it reaches exactly this owner and key is it
          // the way out; otherwise the owner signs the revoke in their own wallet
          const label = publicKeys(pub).find((p) => same(p.address, key))?.label
          const viaRevoke = publicOwner && same(was, publicOwner) && !(agentOwner && !same(agentOwner, publicOwner)) && label !== undefined
          console.log(`REFUSED: ${reason}. Nothing was changed.`)
          process.exit(result(3, { state: 'refused_precheck', reason, owner: was, next: live === null ? `superstables budget doctor --rail tempo, then ${newOwnerCmd(SITE)} again` : viaRevoke ? `revoke it first (superstables budget revoke --rail tempo${label ? ` --agent ${label}` : ''}, approved by ${was}), then ${newOwnerCmd(SITE)}` : `ask the owner ${was} to sign a transaction in their wallet on Tempo Moderato that revokes access key ${key}, using a tool that can call AccountKeychain.revokeKey(${key}) at ${KEYCHAIN}; superstables budget revoke acts only for the owner in the public file, and refuses while the two files disagree. Then ${newOwnerCmd(SITE)}` }))
        }
      }
    }
    console.log(`replacing the recorded owner ${recorded} (no key is live on it): the new owner connects on the page`)
  }
  // The link recorded with the owner (setup --hosted), on this same site: an "already linked" answer is checked against it.
  // None with --new-owner, or when the site changes: then only a fresh link the owner signs records an owner.
  const prior: PriorLink | null = recorded && !newOwner && SITE && recordedSite === SITE && isSiteRequestId(pub.LINK_ID) && pub.LINK_CODE ? { owner: recorded, linkId: pub.LINK_ID, linkCode: pub.LINK_CODE } : null
  if (HOSTED && recordedSite && recordedSite !== SITE) console.log(`this chain's approvals are hosted on ${recordedSite}; moving them to ${SITE} means adding the agent there, with a new owner proof`)
  let linked: { id: string; code: string } | undefined

  // --hosted --grant: the grant after the link, built exactly as grant builds it, and the block it must be mined after
  let then: HostedStep[] | undefined
  let plan: GrantPlan | undefined
  let startBlock = 0n
  if (LIMIT !== undefined) {
    let head: { number: bigint; timestamp: number }
    try {
      // a key that exists or was revoked cannot be authorized again (grant refuses the same way)
      if (recorded && !newOwner) {
        const k = await readKey(recorded, agent)
        if (k.exists || k.revoked) {
          const reason = k.revoked ? `agent key ${agent} is revoked on the owner on record ${recorded}, and a revoked key can never be authorized again` : `a budget is live: agent key ${agent} is already authorized on the owner on record ${recorded}`
          console.log(`REFUSED: ${reason}. Nothing was requested.`)
          process.exit(result(3, { state: 'refused_precheck', reason, owner: recorded, next: k.revoked ? 'make a new agent key: superstables budget setup --rail tempo --agent LABEL, then grant with --agent LABEL' : 'revoke first (superstables budget revoke --rail tempo), then grant a new key' }))
        }
      }
      head = await chainHead()
    } catch (e) {
      const reason = `could not read Tempo Moderato before asking (${String((e as Error).message).split('\n')[0]}); the grant could not be checked afterwards`
      console.log(`REFUSED: ${reason}. Nothing was requested.`)
      process.exit(result(3, { state: 'refused_precheck', reason, next: 'superstables budget doctor --rail tempo checks the RPC; then run the same command again' }))
    }
    startBlock = head!.number
    plan = { agent, limit: LIMIT, expiry: head!.timestamp + GRANT_SECONDS }
    then = [{ kind: 'grant', transaction: { to: KEYCHAIN, data: grantCalldata(plan), value: '0x0' } }]
    console.log(`one approval link: the owner adds this agent, then their wallet authorizes a budget of ${GRANT} ${TOKEN_LABEL} until ${iso(plan.expiry)}. The transaction is checked from block ${startBlock + 1n} on.`)
  }

  let owner: Address
  let finish: ((v: { ok: boolean; message: string }) => void) | null = null
  let bundle: { steps: HostedStepOutcome[] } | undefined
  if (OWNER_KEY_FILE) {
    checkOwnerKeyFile(OWNER_KEY_FILE)
    owner = loadOwnerKeyFile(OWNER_KEY_FILE).OWNER_ADDRESS
    console.log(`owner address from --owner-key-file: ${owner}`)
  } else if (publicOwner && !newOwner && !HOSTED) {
    owner = publicOwner
    console.log(`${PUBLIC_ENV_PATH} already records owner ${owner} for this agent; not asking again. If this isn't your wallet, stop: ${newOwnerCmd(recordedSite)} replaces it`)
  } else if (HOSTED) {
    // the owner links this agent to their account on the site; the account's address becomes the owner on record
    const amt = GRANT !== undefined ? `${fromBaseUnits(LIMIT!)} ${TOKEN_LABEL}` : ''
    const r = await askConnect('setup', {
      title: plan ? `Add this agent and approve a budget of ${amt}` : `Add this agent to your ${HOST} account`,
      ...(plan ? { amount: fromBaseUnits(LIMIT!), unit: TOKEN_LABEL } : {}),
      summary: plan
        ? `1. Add this agent to your ${HOST} account: your account's address is recorded as the budget owner on this computer. 2. Allow the agent key to spend up to ${amt} from your account in total until ${iso(plan.expiry)}. Your wallet asks you to approve the transaction.`
        : `Sign in to ${HOST} with your wallet and add this agent to your account. Your account's address is recorded as the budget owner on this computer. This does not grant a budget or send a transaction.`,
      rows: [
        { label: 'Your agent', value: agent, mono: true },
        { label: 'Chain', value: 'Tempo Testnet (Moderato)' },
        ...(plan ? [{ label: 'Transaction', value: `AccountKeychain.authorizeKey(${agent}, ...) at ${KEYCHAIN}`, mono: true }] : [{ label: 'Agent key', value: `on this computer only, in ${AGENT_ENV_PATH}` }]),
      ],
      enforced: plan ? [`A total limit of ${amt}.`, `The expiry. After ${iso(plan.expiry)} every payment the key signs is refused.`] : [],
      notEnforced: plan ? ['No call or seller restriction. Whoever holds the key can make other calls as your account, subject to the keychain limits.', 'No per-payment limit. The CLI checks --max, but anyone using the key outside the CLI can skip it.'] : [],
      notes: [
        `You pick the match code your agent shows you before the agent is added or anything is sent. The agent key stays on this computer; ${HOST} does not receive it.`,
        ...(plan ? ['You pay the network fee in your wallet. To end the budget at any time: superstables budget revoke --rail tempo.'] : [`Grants and revokes for this agent are then approved on ${HOST}, in your wallet.`]),
      ],
    }, '', newOwner ? recorded : undefined, then, { prior, newOwner })
    bundle = r.bundle
    linked = r.link
    const outcome = r.outcome
    if (outcome.status === 'rejected' || outcome.status === 'expired') await endUnapproved('setup', outcome, { agent, linked: false })
    if (outcome.status !== 'connected') throw new Error(`unexpected approval outcome ${outcome.status}`)
    owner = outcome.address as Address
    console.log(`Agent added to the ${HOST} account ${owner}`)
    if (recorded && !same(recorded, owner) && !newOwner) {
      await closeOwnerPage(0)
      const sent = bundle?.steps.filter((s) => s.hash).map((s) => `${s.kind} ${s.hash}`) ?? []
      const reason = `${HOST} added this agent to the account ${owner}, but this computer records the owner ${recorded}. Nothing was changed on this computer${sent.length ? `; that account's wallet reported ${sent.join(', ')}` : ''}`
      console.log(`REFUSED: ${reason}.`)
      process.exit(result(3, { state: 'refused_precheck', reason, owner: recorded, next: `if ${owner} is the right owner: ${newOwnerCmd(SITE)} (refused while a budget is live). If not, remove this agent from that account on ${HOST}${sent.length ? ", and check that account's wallet activity" : ''}` }))
    }
  } else {
    const { handle, outcome } = await askConnect('setup', {
      title: 'Connect your wallet',
      summary: "Connect your wallet and sign a message to record its address as the budget owner on this computer. This does not grant a budget or send a transaction.",
      rows: [
        { label: 'Your agent', value: agent, mono: true },
        { label: 'Agent key', value: `on this computer only, in ${AGENT_ENV_PATH}` },
      ],
      enforced: [],
      notEnforced: [],
      notes: [
        'Signing the message proves control of this address. It grants no spending permission and has no network fee.',
        'Your signing key stays in your wallet. You will review and approve any later budget grant separately.',
      ],
    }, `Superstables budget: record this wallet as the owner of agent ${agent} on Tempo Testnet (Moderato).`, newOwner ? recorded : undefined)
    if (outcome.status === 'rejected' || outcome.status === 'expired') await endUnapproved('setup', outcome, { agent })
    if (outcome.status !== 'connected') throw new Error(`unexpected owner page outcome ${outcome.status}`)
    owner = outcome.address as Address
    finish = handle.finish
    console.log(`the owner connected ${owner} and signed the sign-in message`)
  }
  if (same(owner, agent)) {
    finish?.({ ok: false, message: "That is the agent's own address. Connect your own wallet instead." })
    await closeOwnerPage()
    process.exit(result(3, { state: 'refused_precheck', reason: "the owner address is the agent's address", next: "connect the owner's own wallet" }))
  }
  // every way an owner arrives (the key file, the page, the site): another owner than the one on record needs --new-owner
  if (recorded && !same(recorded, owner) && !newOwner) {
    const reason = `another owner (${recorded}) is recorded for this agent`
    finish?.({ ok: false, message: `This computer records another owner for this agent (${recorded}). Nothing was changed.` })
    await closeOwnerPage()
    console.log(`REFUSED: ${reason}, not ${owner}. Nothing was changed on this computer.`)
    process.exit(result(3, { state: 'refused_precheck', reason, owner: recorded, next: `${newOwnerCmd(HOSTED ? SITE : recordedSite)} replaces it (refused while a budget is live)` }))
  }
  const replaced = recorded && !same(recorded, owner) ? recorded : undefined
  if (replaced) console.log(`the recorded owner changed: ${replaced} -> ${owner}`)

  // 3. the owner's public address, in the agent file (buy binds the access key to it) and the public file. Hosted: APPROVALS
  // and SITE. Asked on this computer: neither.
  const asked = !OWNER_KEY_FILE && !(publicOwner && !newOwner && !HOSTED)
  refuseAgentFileErrors(() => setAgentPublic({ OWNER_ADDRESS: owner })) // checked again after the wait for the owner
  if (HOSTED && !linked) throw new Error('an add-agent request without its id and code')
  // hosted: APPROVALS, SITE, and the link the owner signed (LINK_ID, LINK_CODE: a later "already linked" answer is checked
  // against them)
  writePublicEnv({ OWNER_ADDRESS: owner, AGENT_ADDRESS: agent, ...(HOSTED ? { APPROVALS: 'hosted', SITE: SITE!, LINK_ID: linked!.id, LINK_CODE: linked!.code } : {}) }, asked && !HOSTED ? ['APPROVALS', 'SITE', 'LINK_ID', 'LINK_CODE'] : replaced && !HOSTED ? ['LINK_ID', 'LINK_CODE'] : [])
  console.log(`wrote ${PUBLIC_ENV_PATH} (no secret) and the owner's address into ${AGENT_ENV_PATH}.${HOSTED ? ` Owner approvals on this chain: hosted on ${SITE}.` : ''}`)

  // 4. test pathUSD for the owner, if it has too little
  let held = await tokenBalance(TOKEN_ADDRESS, owner).catch(() => null)
  if (held !== null && held < MIN_OWNER) {
    try {
      await faucet(owner)
      // the faucet answers with transaction hashes before they are mined: wait (up to 30 s) for the balance to show them
      for (let i = 0; i < 15 && (held ?? 0n) < MIN_OWNER; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        held = await tokenBalance(TOKEN_ADDRESS, owner).catch(() => held)
      }
    } catch (e) {
      console.log(`the faucet did not answer (${(e as Error).message}); fund the owner later with: superstables budget setup --rail tempo --fund-only`)
    }
  }
  console.log(`owner ${owner}: pathUSD ${held === null ? 'unknown' : fromBaseUnits(held)}. The agent needs no funds.`)

  if (plan) await finishBundle(owner, agent, plan, startBlock, bundle?.steps ?? [])

  const where = approvalSite() ? `on ${new URL(approvalSite()!).host.replace(/^www\./, '')}, in your wallet` : 'in your wallet'
  const steps = [
    'Check everything: superstables budget doctor --rail tempo',
    `Grant a budget: superstables budget grant --rail tempo --amount 0.05 [--expiry ISO] [--period S] [--sellers a,b] (you approve it ${where}).`,
  ]
  console.log('\nNext:')
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
  finish?.({ ok: true, message: `Done. The owner on record is now ${owner}. Check that this is your own wallet's address: if it is not, someone else connected, so grant nothing. Agent: ${agent}. You can close this page. Next: grant a budget (the terminal lists the command).` })
  await closeOwnerPage()
  process.exit(result(0, { state: 'ok', owner, ...(replaced ? { replacedOwner: replaced } : {}), agent, publicFile: PUBLIC_ENV_PATH, agentKeyFile: AGENT_ENV_PATH, steps, next: 'superstables budget doctor --rail tempo, then superstables budget grant --rail tempo --amount A' }))
}

/**
 * The grant after the link: the transaction the site reports is read from the chain with grant's checks. The link is
 * already recorded. Ends the process with one RESULT: ok when the key is on chain as planned, else the grant's state.
 */
async function finishBundle(owner: Address, agent: Address, plan: GrantPlan, startBlock: bigint, steps: HostedStepOutcome[]): Promise<never> {
  type Report = { kind: string; state: SentCheck['state'] | 'refused_precheck'; tx?: string; txUrl?: string; amount?: string; reason?: string; reasonCode?: string }
  const amount = fromBaseUnits(plan.limit)
  const reports: Report[] = []
  let done: SentCheck | undefined
  for (const s of steps) {
    if (s.hash) {
      console.log(`${s.kind}: ${HOST} reports transaction ${s.hash} (${s.state}); checking it on chain`)
      // a step the site reported as failed is read too, but never settled
      const c = await checkGrantSent(s.hash as Hex, { owner, plan, afterBlock: startBlock, siteFailed: s.state === 'failed' ? siteFailedWords(HOST, s.reasonCode) : undefined })
      if (c.state === 'settled') done = c
      reports.push({ kind: s.kind, state: c.state, tx: c.tx, txUrl: explorerTx(c.tx), amount, reason: c.reason })
    } else if (s.walletAsked || s.state === 'unknown') {
      reports.push({ kind: s.kind, state: 'unknown', amount, reason: s.reason || 'the wallet was asked to send, but superstables.com reported no transaction' })
    } else {
      const why = s.state === 'rejected'
        ? s.reasonCode === 'cap_above_limit' ? `refused: the budget is above the limit set on the owner's ${HOST} account${s.reason ? ` (${s.reason})` : ''}` : `rejected${s.reason ? `: ${s.reason}` : ' by the owner'}`
        : s.state === 'skipped' ? 'not asked, because the agent was not added'
        : s.state === 'expired' ? 'not approved before the approval link expired'
        : s.state === 'cancelled' ? 'withdrawn on superstables.com when this command stopped waiting, before the owner\'s wallet was asked'
        : `${s.state}${s.reason ? `: ${s.reason}` : ''}`
      reports.push({ kind: s.kind, state: 'refused_precheck', amount, reason: `nothing was sent: ${why}`, reasonCode: s.reasonCode ?? undefined })
    }
  }
  await closeOwnerPage()
  const r = reports[0] ?? { kind: 'grant', state: 'unknown' as const, amount, reason: 'superstables.com reported no grant step' }
  console.log(`  budget: ${r.state === 'settled' ? `${amount} ${TOKEN_LABEL} authorized until ${iso(plan.expiry)} (tx ${r.tx})` : `${r.state}${r.tx ? ` (tx ${r.tx})` : ''}: ${r.reason}`}`)
  const base = { owner, agent, linked: true, steps: reports, tx: r.tx ? { grant: r.tx } : {}, cap: done ? amount : undefined, allowance: done?.key ? fromBaseUnits(done.key.remaining) : undefined, expiry: done?.key ? iso(done.key.expiry) : undefined, publicFile: PUBLIC_ENV_PATH, agentKeyFile: AGENT_ENV_PATH }
  if (r.state === 'settled') {
    console.log(`\nDone with one approval link: the agent was added to the account and has a budget of ${amount} ${TOKEN_LABEL} until ${iso(plan.expiry)}.`)
    process.exit(result(0, { state: 'ok', ...base, next: 'none: the agent can buy under the budget. superstables budget status --rail tempo shows what is left' }))
  }
  const summary = `agent added: yes; budget: ${r.state === 'refused_precheck' ? (r.reason ?? '').slice(0, 120) : `${r.state}, ${(r.reason ?? '').slice(0, 110)}`}`
  const next = r.state === 'unknown'
    ? "superstables budget status --rail tempo and the owner's wallet activity: read whether the grant landed before running anything again. The agent has been added to the account"
    : r.state === 'mismatch'
      ? 'the chain shows another key than planned: the owner revokes it (superstables budget revoke --rail tempo); grant again only with a new key (setup --agent LABEL), and only if the owner asks'
      : 'the agent has been added to the account. Tell the owner what happened in one reply and end your turn. Later, only if the owner asks: superstables budget grant --rail tempo --amount A'
  process.exit(result(r.state === 'unknown' ? 5 : r.state === 'failed' ? 1 : 3, { state: r.state, ...base, reason: summary, next }))
}

main().catch((err) => {
  console.error('setup failed:', err?.message ?? err)
  process.exit(1)
})
