// Setup/fund script for the tempo rail.
//
// Key files (contract rule 1), mode 600, paths from ../paths.mjs:
//   tempo-owner.env  OWNER_PRIVATE_KEY + public addresses  (owner commands only)
//   tempo-agent.env  AGENT_PRIVATE_KEY + public addresses  (agent commands only; no owner key)
// and a public address file (no secret) for read commands.
//
//   setup.ts                       new keys (owner, agent), funded from the Moderato faucet.
//                                  Reuses the key files if they already exist.
//   setup.ts --fund-only           fund the addresses already listed, no key changes
//   setup.ts --extra-agent <label> a fresh agent key AGENT<label>_* (key to the agent file, address to
//                                  the owner and public files), funded
//
// Never prints a private key.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import { labelCheck, parseCli } from './lib/args.mjs'
import {
  AGENT_ENV_PATH,
  OWNER_ENV_PATH,
  PUBLIC_ENV_PATH,
  RPC_URL,
  appendExtraAgent,
  loadPublicEnv,
  parseEnvFile,
  writeEnvFile,
} from './lib/common.ts'

const { values: args } = parseCli({
  name: 'setup.ts',
  summary: 'Create the owner and agent key files and fund the addresses from the Moderato faucet.',
  flags: {
    'fund-only': { type: 'boolean', desc: 'Fund the listed addresses only, change no key file' },
    'extra-agent': { type: 'string', metavar: 'label', desc: 'Add AGENT<label>_* (a fresh agent key)', check: labelCheck },
  },
  examples: ['npx tsx budget/tempo/setup.ts', 'npx tsx budget/tempo/setup.ts --extra-agent 2'],
})

async function fundAddress(address: string): Promise<string[]> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tempo_fundAddress', params: [address] }),
  })
  const json = await res.json()
  if (json.error) throw new Error(`tempo_fundAddress failed for ${address}: ${JSON.stringify(json.error)}`)
  return json.result as string[]
}

function writePublic(entries: [string, string][]) {
  mkdirSync(dirname(PUBLIC_ENV_PATH), { recursive: true, mode: 0o700 })
  if (existsSync(PUBLIC_ENV_PATH)) throw new Error(`${PUBLIC_ENV_PATH} already exists. Refusing to overwrite.`)
  writeFileSync(PUBLIC_ENV_PATH, '# Tempo public addresses only. Read commands use this file. No secrets.\n' + entries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o644 })
}
async function fundAll(list: [string, string][]) {
  console.log('\nFunding from the Moderato faucet (tempo_fundAddress)...')
  for (const [label, address] of list) {
    const hashes = await fundAddress(address)
    console.log(`  ${label} (${address}): ${hashes.length} mint tx(es)`)
    for (const h of hashes) console.log(`    https://explore.testnet.tempo.xyz/tx/${h}`)
  }
}

async function main() {
  if (typeof args['extra-agent'] === 'string') {
    const label = args['extra-agent'] as string
    const address = appendExtraAgent(label)
    console.log(`agent${label} address: ${address}`)
    console.log(`AGENT${label}_ADDRESS=${address}`)
    for (const h of await fundAddress(address)) console.log(`    https://explore.testnet.tempo.xyz/tx/${h}`)
    return
  }

  if (args['fund-only']) {
    const pub = loadPublicEnv()
    if (!pub.OWNER_ADDRESS) throw new Error(`No addresses in ${PUBLIC_ENV_PATH}. Run setup.ts first.`)
    console.log(`Using existing addresses from ${PUBLIC_ENV_PATH}`)
    return fundAll([['owner', pub.OWNER_ADDRESS], ['agent', pub.AGENT_ADDRESS]].filter((e) => e[1]) as [string, string][])
  }

  let pub = loadPublicEnv()
  if (existsSync(OWNER_ENV_PATH) && existsSync(AGENT_ENV_PATH)) {
    console.log(`${OWNER_ENV_PATH} and ${AGENT_ENV_PATH} already exist. Reusing them.`)
    if (!pub.OWNER_ADDRESS) {
      const o = parseEnvFile(readFileSync(OWNER_ENV_PATH, 'utf8'))
      const publics = Object.entries(o).filter(([k]) => k.endsWith('_ADDRESS')) as [string, string][]
      if (!existsSync(PUBLIC_ENV_PATH)) writePublic(publics)
      pub = Object.fromEntries(publics)
    }
  } else {
    const ownerPk = generatePrivateKey()
    const agentPk = generatePrivateKey()
    const publics: [string, string][] = [
      ['OWNER_ADDRESS', privateKeyToAddress(ownerPk)],
      ['AGENT_ADDRESS', privateKeyToAddress(agentPk)],
    ]
    writeEnvFile(OWNER_ENV_PATH, 'Tempo owner: OWNER_PRIVATE_KEY plus public addresses. Only owner commands open this file.', [['OWNER_PRIVATE_KEY', ownerPk], ...publics])
    writeEnvFile(AGENT_ENV_PATH, 'Tempo agent: access-key private keys plus public addresses. NO owner private key. Only agent commands open this file.', [['AGENT_PRIVATE_KEY', agentPk], ...publics])
    if (!existsSync(PUBLIC_ENV_PATH)) writePublic(publics)
    pub = Object.fromEntries(publics)
    console.log(`Generated fresh keys and wrote ${OWNER_ENV_PATH} and ${AGENT_ENV_PATH} (mode 600).`)
  }
  console.log('\nAddresses (public, safe to print):')
  console.log(`  owner:     ${pub.OWNER_ADDRESS}\n  agent:     ${pub.AGENT_ADDRESS}`)
  await fundAll([['owner', pub.OWNER_ADDRESS], ['agent', pub.AGENT_ADDRESS]])
  console.log('\nDone. Run "npx superstables budget doctor --rail tempo" to confirm.')
}

main().catch((err) => {
  console.error('setup failed:', err?.message ?? err)
  process.exit(1)
})
