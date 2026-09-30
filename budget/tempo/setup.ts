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
//                                   next budget after a revoke or an expiry. Needs the owner recorded already; no page.
//   setup.ts --fund-only            fund the recorded owner from the Moderato faucet, change no file
//
// Never prints a private key.
// Usage: npx tsx budget/tempo/setup.ts [--agent <label>] [--fund-only] [--timeout <s>] [--no-open] [--owner-key-file <path>]

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import type { Address } from 'viem'
import { intCheck, labelCheck, parseCli } from './lib/args.mjs'
import { AGENT_ENV_PATH, PUBLIC_ENV_PATH, RPC_URL, TOKEN_ADDRESS, appendExtraAgent, fromBaseUnits, loadOwnerKeyFile, loadPublicEnv, parseEnvFile, setAgentPublic, writePublicEnv } from './lib/common.ts'
import { readFileSync } from 'node:fs'
import { OWNER_KEY_FILE, checkOwnerKeyFile } from '../owner-page.ts'
import { askConnect, closeOwnerPage, emit, endUnapproved, tokenBalance } from './owner.ts'

const { values: args } = parseCli({
  name: 'setup.ts',
  summary: 'Create the agent key file (never overwritten), let the owner connect their own wallet on the owner page, and write the public file. No owner key is created.',
  flags: {
    agent: { type: 'string', metavar: 'label', desc: 'Add a new agent key AGENT<label> (for the next budget after a revoke)', check: labelCheck },
    'fund-only': { type: 'boolean', desc: 'Fund the recorded owner from the Moderato faucet, change no file' },
    timeout: { type: 'string', metavar: 'seconds', desc: 'How long the approval link stays open (default 600)', check: intCheck(1) },
    'no-open': { type: 'boolean', desc: 'Do not open the link in the default browser' },
    'owner-key-file': { type: 'string', metavar: 'path', desc: 'Tests and automation only: record this owner key file\'s address instead of asking the wallet' },
  },
  examples: ['npx tsx budget/tempo/setup.ts', 'npx tsx budget/tempo/setup.ts --agent 2'],
})

const MIN_OWNER = 1_000_000n // 1 pathUSD, what doctor asks for
const same = (x?: string, y?: string) => !!x && !!y && x.toLowerCase() === y.toLowerCase()
const result = (exit: number, o: Record<string, unknown>) => emit('setup', exit, o)

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

async function main() {
  const pub = loadPublicEnv()

  if (args['fund-only']) {
    if (!pub.OWNER_ADDRESS) process.exit(result(3, { state: 'refused_precheck', reason: 'no owner is recorded yet', next: 'superstables budget setup --rail tempo' }))
    await faucet(pub.OWNER_ADDRESS)
    process.exit(result(0, { state: 'ok', owner: pub.OWNER_ADDRESS, next: 'superstables budget doctor --rail tempo' }))
  }

  if (typeof args.agent === 'string') {
    const label = args.agent
    if (!pub.OWNER_ADDRESS || !existsSync(AGENT_ENV_PATH)) process.exit(result(3, { state: 'refused_precheck', reason: 'run setup without --agent first: no owner is recorded yet', next: 'superstables budget setup --rail tempo' }))
    const { address, created } = appendExtraAgent(label)
    console.log(`${created ? 'created' : 'reusing'} agent key AGENT${label} in ${AGENT_ENV_PATH}: ${address}`)
    process.exit(result(0, { state: 'ok', owner: pub.OWNER_ADDRESS, agent: address, next: `superstables budget grant --rail tempo --agent ${label} --amount A (you approve it in your wallet)` }))
  }

  // 1. the agent key
  let agent: Address
  let agentOwner: string | undefined
  if (existsSync(AGENT_ENV_PATH)) {
    const env = parseEnvFile(readFileSync(AGENT_ENV_PATH, 'utf8'))
    if (!env.AGENT_PRIVATE_KEY) process.exit(result(3, { state: 'refused_precheck', reason: `${AGENT_ENV_PATH} has no AGENT_PRIVATE_KEY`, next: `move ${AGENT_ENV_PATH} away if you mean to start over` }))
    agent = privateKeyToAddress(env.AGENT_PRIVATE_KEY as `0x${string}`)
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

  // 2. the owner address
  let owner: Address
  let finish: ((v: { ok: boolean; message: string }) => void) | null = null
  if (OWNER_KEY_FILE) {
    checkOwnerKeyFile(OWNER_KEY_FILE)
    owner = loadOwnerKeyFile(OWNER_KEY_FILE).OWNER_ADDRESS
    console.log(`owner address from --owner-key-file: ${owner}`)
  } else if (pub.OWNER_ADDRESS && same(pub.AGENT_ADDRESS, agent)) {
    owner = pub.OWNER_ADDRESS as Address
    console.log(`${PUBLIC_ENV_PATH} already records owner ${owner} for this agent; not asking again (move the file away to connect another wallet)`)
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
    }, `Superstables budget: record this wallet as the owner of agent ${agent} on Tempo Testnet (Moderato).`)
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
  if (agentOwner && !same(agentOwner, owner)) {
    finish?.({ ok: false, message: `This agent is already bound to another owner (${agentOwner}). Nothing was changed.` })
    await closeOwnerPage()
    process.exit(result(3, { state: 'refused_precheck', reason: `the agent key file is bound to another owner (${agentOwner})`, next: `move ${AGENT_ENV_PATH} away if you mean to start over` }))
  }

  // 3. the owner's public address, in the agent file (buy binds the access key to it) and the public file
  setAgentPublic({ OWNER_ADDRESS: owner })
  writePublicEnv({ OWNER_ADDRESS: owner, AGENT_ADDRESS: agent })
  console.log(`wrote ${PUBLIC_ENV_PATH} (no secret) and the owner's address into ${AGENT_ENV_PATH}`)

  // 4. test pathUSD for the owner, if it has too little
  let held = await tokenBalance(TOKEN_ADDRESS, owner).catch(() => null)
  if (held !== null && held < MIN_OWNER) {
    try {
      await faucet(owner)
      held = await tokenBalance(TOKEN_ADDRESS, owner).catch(() => held)
    } catch (e) {
      console.log(`the faucet did not answer (${(e as Error).message}); fund the owner later with: npx tsx budget/tempo/setup.ts --fund-only`)
    }
  }
  console.log(`owner ${owner}: pathUSD ${held === null ? 'unknown' : fromBaseUnits(held)}. The agent needs no funds.`)

  const steps = [
    'Check everything: superstables budget doctor --rail tempo',
    'Grant a budget: superstables budget grant --rail tempo --amount 0.05 [--expiry ISO] [--period S] [--sellers a,b] (you approve it in your wallet).',
  ]
  console.log('\nNext:')
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
  finish?.({ ok: true, message: `Done. ${owner} is recorded as the owner of agent ${agent}. You can close this page. Next: grant a budget (the terminal lists the command).` })
  await closeOwnerPage()
  process.exit(result(0, { state: 'ok', owner, agent, publicFile: PUBLIC_ENV_PATH, agentKeyFile: AGENT_ENV_PATH, steps, next: 'superstables budget doctor --rail tempo, then superstables budget grant --rail tempo --amount A' }))
}

main().catch((err) => {
  console.error('setup failed:', err?.message ?? err)
  process.exit(1)
})
