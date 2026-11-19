// Shared helpers for the Tempo superstables budget scripts.
//
// Reads the agent key from tempo-agent.env (mode 600, paths from ../../paths.mjs). The owner's key
// stays in the owner's own wallet: owner commands go through the owner page (../owner.ts). An owner
// key file is read only when a test names it with --owner-key-file (loadOwnerKeyFile), and never
// in the same process as the agent file (contract rule 1). Never logs a private key.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Account, Addresses, createClient, http } from 'viem/tempo'
import { tempo as tempoMainnet, tempoModerato } from 'viem/tempo/chains'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import type { Address, Hex } from 'viem'

import { CHAIN, CHAIN_ENV, CHAIN_ID as CHAIN_ID_, CHAIN_PROBLEM, RPC_URL as RPC_URL_, TESTNET, TOKEN_DECIMALS as TOKEN_DECIMALS_, TOKEN_LABEL as TOKEN_LABEL_ } from './constants.mjs'
import { HOME, agentKeyFile, ensurePrivateDir, ownerKeyFile, publicFile } from '../../paths.mjs'
import { UNSAFE_SECRET_FILE, readSecretFile, replaceSecretFile } from '../../secret-file.mjs'
import { RPC_MAX_BYTES, cappedRpcFetch } from '../../rpc.mjs'
import { markSend } from '../../proof.mjs'
import { agentBinding, hostedFlags, legacyWarning } from '../../owner-binding.mjs'
import { noteBinding } from '../../page-facts.mjs'
// importing os-keychain.mjs registers the chain gate's key-storage check, and mainnet-spend.js the pause file check: without
// them a mainnet reads as missing its keychain and as paused
import { KEYCHAIN_REFUSED, KEYCHAIN_UNAVAILABLE, deleteAgentSecret, readAgentSecret, storeAgentSecret } from '../../os-keychain.mjs'
import { chainGate } from '../../../src/core/chain-gate.js'
import { mainnetSendRefusal } from '../../../src/core/mainnet-spend.js'

export { CHAIN }
export const RPC_URL: string = RPC_URL_
export const EXPLORER_BASE: string = CHAIN.explorer
export const CHAIN_ID: number = CHAIN_ID_
/** The viem chain of CHAIN: the one object every client here is made with (a client made with only `testnet` picks by that flag). */
export const VIEM_CHAIN = CHAIN.chainId === tempoModerato.id ? tempoModerato : tempoMainnet
if (VIEM_CHAIN.id !== CHAIN.chainId) throw new Error(`the chain table says ${CHAIN.key} is chain ${CHAIN.chainId}, but viem's chain for it is ${VIEM_CHAIN.id}`)
/** ` --testnet` on Moderato, '' on Tempo (the default): added to every command a message tells the owner to run. */
export const CHAIN_FLAG = CHAIN.testnet ? ' --testnet' : ''

// pathUSD: Tempo's protocol-level reference USD stablecoin. Fixed address on
// every Tempo chain (mainnet and testnets share the same precompile-style
// address). 6 decimals. Also the default fallback fee token.
// (constants.mjs holds the same values for the plain .mjs helpers.)
export const TOKEN_ADDRESS: Address = Addresses.pathUsd
export const TOKEN_DECIMALS: number = TOKEN_DECIMALS_
export const TOKEN_LABEL: string = TOKEN_LABEL_

/**
 * Seller text (its challenge, its answer, its errors) on one log line, at most `max` characters: control characters, newlines
 * included, become spaces; format, bidi and Unicode tag characters are removed. A seller must not be able to start a line of
 * its own on stdout, where the dispatcher reads APPROVE and RESULT lines. The same rule as untrustedText (src/core/text.ts).
 */
export const oneLine = (s: unknown, max = 300): string => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\p{Cf}\u{E0000}-\u{E007F}\u2060-\u2064]/gu, '').trim().slice(0, max)

// Key files (contract rule 1). Owner and agent keys never share a file.
//   the owner's wallet  holds the owner key. setup, grant and revoke ask it on the owner page.
//   tempo-agent.env     AGENT*_PRIVATE_KEY (access keys) + public addresses. Opened only by agent
//                       commands (buy) and by setup, which creates it. No owner key in it.
//   public file         public addresses only. Read commands (readBudget, reconcile) and the owner
//                       commands use it, or take --owner/--key and need no file at all.
//   an owner key file   tests and automation only, named with --owner-key-file <path> (mode 600):
//                       OWNER_PRIVATE_KEY. The default path ownerKeyFile('tempo') is never read.
export const OWNER_ENV_PATH = ownerKeyFile('tempo')
//                       On a mainnet the file is tempo-<chain>-agent.env and names the OS keychain (AGENT_KEY_STORE=os-keychain):
//                       the keys are in the keychain, the file holds addresses only.
export const AGENT_ENV_PATH = agentKeyFile('tempo', CHAIN.key)
export const PUBLIC_ENV_PATH = publicFile('tempo', CHAIN.key)
/** The line that names the OS keychain in the agent file (../../os-keychain.mjs). */
export const STORE_LINE = 'AGENT_KEY_STORE'

export type OwnerEnv = Record<string, string> & {
  OWNER_PRIVATE_KEY: Hex
  OWNER_ADDRESS: Address
}
export type AgentEnv = Record<string, string> & { OWNER_ADDRESS: Address }

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** A key file's values. Refuses (throws) a file other users can read, or anything that is not a regular file (../../secret-file.mjs). */
function readSecretEnvFile(path: string, what: string, hint: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`${path} not found. ${hint}`)
  return parseEnvFile(readSecretFile(path, what))
}

const isAddress = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/**
 * An owner key file named with --owner-key-file (tests and automation only; the caller checks its mode): the owner private key.
 * OWNER_ADDRESS is derived from the key; if the file also names one, it must match.
 */
export function loadOwnerKeyFile(path: string): OwnerEnv {
  const parsed = readSecretEnvFile(path, '--owner-key-file', 'Pass the path of a test owner key file.')
  if (!parsed.OWNER_PRIVATE_KEY) throw new Error(`Missing OWNER_PRIVATE_KEY in ${path}`)
  const derived = privateKeyToAddress(parsed.OWNER_PRIVATE_KEY as Hex)
  if (parsed.OWNER_ADDRESS && parsed.OWNER_ADDRESS.toLowerCase() !== derived.toLowerCase()) throw new Error(`OWNER_PRIVATE_KEY in ${path} does not match its OWNER_ADDRESS`)
  return { ...parsed, OWNER_ADDRESS: derived } as OwnerEnv
}

/**
 * The agent file's text for a command that must refuse cleanly rather than throw: `{ text }` ("" when there is no file), or
 * `{ problem }` when the file must not be used. Mode 600 is set when the file is written, but a restore, a `cp` without -p
 * or an editor can leave it readable by other users, and every signature from here on would then be made with a key this
 * machine no longer keeps to itself. Checked on the file actually read; ask again after any wait.
 */
export function agentFileText(): { text: string; problem?: undefined } | { text?: undefined; problem: string } {
  try {
    return { text: readSecretFile(AGENT_ENV_PATH, 'the agent key file') }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '' }
    if ((err as NodeJS.ErrnoException).code === UNSAFE_SECRET_FILE) return { problem: (err as Error).message }
    throw err
  }
}

/** An agent key that must not be used: the keychain refused it, or a mainnet file holds one in plain text. `code` is set. */
export const AGENT_KEY_REFUSED = 'AGENT_KEY_REFUSED'
const agentKeyRefusal = (message: string) => Object.assign(new Error(message), { code: AGENT_KEY_REFUSED })
/** Whether `err` is a refusal to use an agent key (keychain locked, missing or wrong; a plain key on a mainnet): a command ends with exit 3. */
export const isKeyRefusal = (err: unknown): boolean => {
  const code = (err as { code?: string } | undefined)?.code
  return code === AGENT_KEY_REFUSED || code === KEYCHAIN_REFUSED || code === KEYCHAIN_UNAVAILABLE
}
/** Whether this agent file names the keychain: every key in it is in the keychain, and the file holds addresses only. */
export const inKeychain = (env: Record<string, string>): boolean => env[STORE_LINE] === 'os-keychain'

/**
 * The private key of the agent at `address` (label `label` for the words). From the keychain when the file names it: the entry is
 * read and must derive to `address`. A mainnet never reads a key from a file: a plain key line there is refused. Throws a
 * refusal (isKeyRefusal) and nothing is signed.
 */
export function agentSecretFor(env: Record<string, string>, label: string, address: string | undefined): Hex {
  const prefix = `AGENT${label}`
  if (inKeychain(env)) {
    if (!address || !isAddress(address)) throw agentKeyRefusal(`${AGENT_ENV_PATH} names the keychain but has no ${prefix}_ADDRESS`)
    const secret = readAgentSecret('tempo', address) // throws a keychain refusal when it is locked, missing or not a key
    let derived: string
    try { derived = privateKeyToAddress(secret as Hex) } catch { throw agentKeyRefusal(`the keychain entry for ${address} is not a key`) }
    if (derived.toLowerCase() !== address.toLowerCase()) throw agentKeyRefusal(`the keychain holds a key for ${derived}, not ${address}`)
    return secret as Hex
  }
  if (!CHAIN.testnet) throw agentKeyRefusal(`${AGENT_ENV_PATH} does not name the OS keychain: on ${CHAIN.label}, a plain-text agent key is never used`)
  const privateKey = env[`${prefix}_PRIVATE_KEY`]
  if (!privateKey || !address) throw new Error(`Missing ${prefix}_PRIVATE_KEY/${prefix}_ADDRESS in ${AGENT_ENV_PATH}`)
  return privateKey as Hex
}

/** Agent file: access-key private keys and public addresses (on a mainnet, the keychain's marker and addresses). It holds no owner key. For agent commands only. */
export function loadAgentEnv(): AgentEnv {
  const parsed = readSecretEnvFile(AGENT_ENV_PATH, 'the agent key file', 'Run "superstables budget setup --rail tempo' + CHAIN_FLAG + '" to create the agent key and connect the owner.')
  if (!isAddress(parsed.OWNER_ADDRESS)) throw new Error(`OWNER_ADDRESS (public) missing in ${AGENT_ENV_PATH}`)
  if (parsed.OWNER_PRIVATE_KEY) throw new Error(`${AGENT_ENV_PATH} contains OWNER_PRIVATE_KEY. Remove it: the agent file must not hold the owner key.`)
  return parsed as AgentEnv
}

/** Public addresses only. Returns {} if the file does not exist. Never holds a key. */
export function loadPublicEnv(): Record<string, string> {
  if (!existsSync(PUBLIC_ENV_PATH)) return {}
  const parsed = parseEnvFile(readFileSync(PUBLIC_ENV_PATH, 'utf8'))
  for (const k of Object.keys(parsed)) if (/PRIVATE|MNEMONIC|PASSWORD/i.test(k)) delete parsed[k]
  return parsed
}

/** Public address of an agent key: label "" is the primary agent, "2"/"V26..." are extras. */
export function resolveAgentAddress(env: Record<string, string>, label = ''): Address {
  const key = `AGENT${label}_ADDRESS`
  const address = env[key]
  if (!address || !isAddress(address)) throw new Error(`Missing ${key}`)
  return address as Address
}

/** Access-key private key and address for an agent label, from the agent file (or the keychain it names: agentSecretFor). */
export function resolveAgentKeys(env: Record<string, string>, label = ''): { privateKey: Hex; address: Address } {
  const address = env[`AGENT${label}_ADDRESS`]
  return { privateKey: agentSecretFor(env, label, address), address: address as Address }
}

/**
 * Creates a fresh agent access key for `label` ("2", "3", "V2609..."): private key + address go to
 * the agent file, the address alone to the public file. Returns the address (the existing one if the
 * label is taken). Owner commands and read commands find the agent by address; only the agent file
 * holds the key.
 */
export function appendExtraAgent(label: string): { address: Address; created: boolean } {
  const agentPath = AGENT_ENV_PATH
  if (!existsSync(agentPath)) throw new Error('The agent key file is missing. Run "superstables budget setup --rail tempo' + CHAIN_FLAG + '" first.')
  // read and rewritten through ../../secret-file.mjs: a file other users can read is refused, never quietly re-tightened
  const text = readSecretFile(agentPath, 'the agent key file')
  const existing = parseEnvFile(text)
  const addrKey = `AGENT${label}_ADDRESS`
  // a key address the public file records is never replaced (setup refuses first; this is the last guard)
  const recorded = loadPublicEnv()[addrKey]
  if (recorded && recorded.toLowerCase() !== (existing[addrKey] ?? '').toLowerCase()) throw new Error(`${PUBLIC_ENV_PATH} already records ${addrKey}=${recorded}; it is never replaced`)
  if (existing[addrKey]) {
    if (!loadPublicEnv()[addrKey]) writePublicEnv({ [addrKey]: existing[addrKey] })
    return { address: existing[addrKey] as Address, created: false }
  }
  const pk = generatePrivateKey()
  const address = privateKeyToAddress(pk)
  const head = `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}`
  if (inKeychain(existing)) {
    // the keychain first (it reads the key back): the file gets the address only, and a refusal leaves both as they were
    storeAgentSecret('tempo', address, pk)
    try {
      replaceSecretFile(agentPath, `${head}${addrKey}=${address}\n`)
    } catch (err) {
      try { deleteAgentSecret('tempo', address) } catch { /* the entry belongs to a key nothing else knows */ }
      throw err
    }
  } else {
    if (!CHAIN.testnet) throw agentKeyRefusal(`${agentPath} does not name the OS keychain: on ${CHAIN.label}, a plain-text agent key is never written`)
    replaceSecretFile(agentPath, `${head}AGENT${label}_PRIVATE_KEY=${pk}\n${addrKey}=${address}\n`)
  }
  writePublicEnv({ [addrKey]: address })
  return { address, created: true }
}

/** Adds or updates public values in the public file (addresses only, never a key). Mode 644. */
/** Merge `updates` into the public file; `drop` names keys to remove (setup on this computer drops APPROVALS and SITE). */
export function writePublicEnv(updates: Record<string, string>, drop: string[] = []) {
  for (const k of Object.keys(updates)) if (/PRIVATE|MNEMONIC|PASSWORD/i.test(k)) throw new Error(`${k} does not belong in the public file`)
  const env: Record<string, string> = { ...loadPublicEnv(), ...updates }
  for (const k of drop) delete env[k]
  ensurePrivateDir(dirname(PUBLIC_ENV_PATH), { root: HOME })
  writeFileSync(PUBLIC_ENV_PATH, '# Tempo public addresses only. Read commands use this file. No secrets.\n' + Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o644 })
}

/** Adds or replaces public (non-secret) lines in the agent file, keeping its keys. Mode stays 600. */
export function setAgentPublic(updates: Record<string, string>) {
  const lines = readSecretFile(AGENT_ENV_PATH, 'the agent key file').split('\n').filter((l) => l !== '')
  for (const [k, v] of Object.entries(updates)) {
    if (/PRIVATE/i.test(k)) throw new Error(`${k} is not a public value`)
    const i = lines.findIndex((l) => l.startsWith(`${k}=`))
    if (i >= 0) lines[i] = `${k}=${v}`
    else lines.push(`${k}=${v}`)
  }
  // the agent file holds the only copy of the agent keys: a new file (mode 600, flushed) renamed over the old in one step,
  // so a crash or a full disk leaves the old file or the new one, never a truncated one
  replaceSecretFile(AGENT_ENV_PATH, lines.join('\n') + '\n')
}

/** Root account for the owner from a test owner key file (--owner-key-file). Tests and automation only. */
export function ownerAccount(env: OwnerEnv) {
  const account = Account.fromSecp256k1(env.OWNER_PRIVATE_KEY)
  if (account.address.toLowerCase() !== env.OWNER_ADDRESS.toLowerCase()) {
    throw new Error('the owner key file does not match its OWNER_ADDRESS')
  }
  return account
}

/**
 * Access-key account for the agent, bound to the owner's PUBLIC address only. Transactions signed by
 * this account act on behalf of the owner (the keychain envelope names the owner as the account), so
 * the agent process never holds the owner key or any balance of its own.
 */
export function agentAccessKeyAccount(env: AgentEnv, label = '') {
  const { privateKey } = resolveAgentKeys(env, label)
  return accessKeyAccountForOwner(env.OWNER_ADDRESS, privateKey)
}

/** Access-key account bound to an owner *address* (no owner private key is ever needed for this). */
export function accessKeyAccountForOwner(ownerAddress: Address, privateKey: Hex) {
  return Account.fromSecp256k1(privateKey, { access: ownerAddress })
}

/** The script this process runs (buy, setBudget, ...), by its file name: the sources and the built bundle name them alike. */
export const SCRIPT = String(process.argv[1] ?? '').split(/[\\/]/).pop()!.replace(/\.(?:ts|mjs|js)$/, '') || 'tempo'
/**
 * The scripts that work without the agent key: they read the chain or the journal, or are the owner's own revoke. On a mainnet
 * only the rest must find the key in the OS keychain. A script this list does not name is held to the stricter rule.
 */
const NO_AGENT_KEY_SCRIPTS = new Set(['readBudget', 'reconcile', 'preflight', 'revokeBudget'])
/** setup that is creating the key in the keychain (setup.ts --key-store os-keychain): the key is not there yet. */
const CREATING_KEY = SCRIPT === 'setup' && process.argv.includes('--key-store') && process.argv[process.argv.indexOf('--key-store') + 1] === 'os-keychain'

/** The chain gate for this rail's one chain: '' when this build may sign, ask the owner's wallet or send on it, else why not. */
export function tempoGate(): string {
  return chainGate({ rail: 'tempo', key: CHAIN.gateKey, chainId: CHAIN.chainId, testnet: TESTNET, token: { symbol: TOKEN_LABEL, address: TOKEN_ADDRESS, decimals: TOKEN_DECIMALS }, agentKey: !NO_AGENT_KEY_SCRIPTS.has(SCRIPT) && !CREATING_KEY })
}

/**
 * On a mainnet, throws when the network mode, the manifest or the pause has closed it since the command started: read
 * right before each signature by the agent key and each broadcast. `signed`: something was already signed, and it stays on
 * this computer. A testnet always passes.
 */
export function assertMainnetOpen(what: string, signed = false): void {
  if (CHAIN.testnet) return
  const closed = mainnetSendRefusal({ rail: 'tempo', key: CHAIN.gateKey, chainId: CHAIN.chainId, testnet: CHAIN.testnet, token: { symbol: TOKEN_LABEL, address: TOKEN_ADDRESS, decimals: TOKEN_DECIMALS } })
  if (closed) throw Object.assign(new Error(`${closed}; ${what}`), { mainnetClosed: true, signed })
}
/** The assertMainnetOpen error in `err` or its cause chain (an RPC client wraps what its request hook throws), or undefined. */
export function mainnetClosedError(err: unknown): (Error & { signed?: boolean }) | undefined {
  for (let e: any = err, i = 0; e && i < 8; e = e.cause, i++) if (e.mainnetClosed === true) return e
  return undefined
}
/** Whether `err` came from assertMainnetOpen. */
export const isMainnetClosed = (err: unknown): boolean => mainnetClosedError(err) !== undefined

// No Tempo budget script runs on a chain this build does not sign on: it refuses here, as it loads, before it reads a key
// file or asks an RPC anything.
{
  const problem = CHAIN_PROBLEM || tempoGate()
  if (problem) {
    console.error(`REFUSED: ${problem}. Nothing was signed or sent.`)
    console.log(`RESULT ${JSON.stringify({ ok: false, command: SCRIPT, rail: 'tempo', chain: CHAIN_PROBLEM ? oneLine(process.env[CHAIN_ENV], 40) : CHAIN.key, state: 'refused_precheck', reason: problem, next: CHAIN_PROBLEM ? 'nothing was signed or sent; use --chain tempo, or --testnet for Moderato' : CHAIN.testnet ? 'nothing was signed or sent; run it again with --testnet if the owner asked for a testnet' : SCRIPT === 'setup' && /OS keychain/.test(problem) ? `nothing was signed or sent; the key is kept in the OS keychain only: superstables budget setup --rail tempo${CHAIN_FLAG} --key-store os-keychain` : 'nothing was signed or sent; ask the owner: the refusal says what this mainnet still needs' })}`)
    process.exit(3)
  }
}

export function makeClient(account?: ReturnType<typeof ownerAccount> | ReturnType<typeof agentAccessKeyAccount>) {
  const gate = tempoGate()
  if (gate) throw new Error(`${gate}; nothing was signed or sent`)
  return createClient({
    account,
    chain: VIEM_CHAIN,
    // a broadcast prints SENDING before it leaves (../../proof.mjs)
    transport: http(RPC_URL, { onFetchRequest: (_request, init) => markSend(init.body), fetchFn: cappedRpcFetch(RPC_MAX_BYTES), maxResponseBodySize: RPC_MAX_BYTES }),
    feeToken: TOKEN_ADDRESS,
  })
}

export function explorerTx(hash: string) {
  return `${EXPLORER_BASE}/tx/${hash}`
}

export function explorerAddress(address: string) {
  return `${EXPLORER_BASE}/address/${address}`
}

/**
 * Parses a plain decimal string (e.g. "0.1") into pathUSD base units (6 decimals). Throws on a sign,
 * an exponent, more than 6 decimal places (never rounds or truncates) or anything else non-numeric.
 */
export function toBaseUnits(amount: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Not a plain decimal amount: ${JSON.stringify(amount)}`)
  const [whole, frac = ''] = amount.split('.')
  if (frac.length > TOKEN_DECIMALS) throw new Error(`${JSON.stringify(amount)} has more than ${TOKEN_DECIMALS} decimal places (${TOKEN_LABEL} precision)`)
  return BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((frac + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS) || '0')
}

export function fromBaseUnits(amount: bigint): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const divisor = 10n ** BigInt(TOKEN_DECIMALS)
  const whole = abs / divisor
  const frac = (abs % divisor).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

/** Names of the chain's own refusals (keychain and TIP-20 errors) that mean "the chain said no". */
export const CHAIN_REFUSALS = [
  'SpendingLimitExceeded',
  'KeyAlreadyRevoked',
  'KeyExpired',
  'KeyNotFound',
  'KeyAlreadyExists',
  'CallNotAllowed',
  'InsufficientBalance',
  'UnauthorizedCaller',
]

export function isChainRefusal(description: string): boolean {
  return CHAIN_REFUSALS.some((n) => description.includes(n))
}

/** Decodes a viem write error down to a short, printable on-chain reason. */
export function describeError(err: unknown): string {
  const e = err as any
  // viem nests the decoded custom error under `.cause` chains; walk them.
  let cur = e
  const seen = new Set<string>()
  while (cur) {
    if (cur.data?.errorName) return `${cur.data.errorName} (on-chain revert)`
    if (cur.errorName) return `${cur.errorName} (on-chain revert)`
    // Node clients (e.g. mppx's generic `prepareTransactionRequest` ->
    // `estimateGas` path) sometimes only surface the keychain revert reason
    // inside a free-text "Details: ..." line rather than a decoded
    // `errorName`, e.g. "Revm error: keychain validation failed:
    // AccountKeychainError(KeyAlreadyRevoked(KeyAlreadyRevoked))".
    const detailsMatch = typeof cur.message === 'string' ? cur.message.match(/Details:\s*(.+)/) : undefined
    if (detailsMatch) return `${detailsMatch[1].trim()} (on-chain revert)`
    if (typeof cur.shortMessage === 'string' && !seen.has(cur.shortMessage)) {
      seen.add(cur.shortMessage)
    }
    cur = cur.cause
  }
  if (seen.size) return [...seen].join(' | ')
  return e?.message ?? String(err)
}

/**
 * The owner and agent addresses of an owner plan (grant) for the agent key `label` ('' is the primary). Before it returns, the owner's
 * setup signature for that label in the public file must name this agent address for the owner on record, the address must be the
 * key on this machine when the agent file is here, and it must not be retired (../../owner-binding.mjs). Otherwise `refuse(reason, next)`
 * ends the command (exit 3) before any page or send. A public file from before the signature was kept goes on, with one warning line.
 */
export async function ownerPlanCtx(label: string, refuse: (reason: string, next: string) => never): Promise<{ owner: Address; agent: Address }> {
  const pub = loadPublicEnv()
  const owner = pub.OWNER_ADDRESS as Address | undefined
  const agent = pub[`AGENT${label}_ADDRESS`] as Address | undefined
  const flag = label ? ` --agent ${label}` : ''
  if (!owner || !agent) return refuse(`the public file names no owner or no agent${label ? ` ${label}` : ''}`, `superstables budget setup --rail tempo${CHAIN_FLAG}${flag}`)
  const hosted = label ? '' : hostedFlags(pub)
  const next = `check ${PUBLIC_ENV_PATH}: run superstables budget setup --rail tempo${CHAIN_FLAG}${flag}${hosted} where the agent key is, to record the owner's signature again. The owner can still end the key from any machine: superstables budget revoke --rail tempo${CHAIN_FLAG}${flag}`
  let keyAgent: string | null = null
  if (existsSync(AGENT_ENV_PATH)) {
    const file = agentFileText()
    if (file.problem !== undefined) return refuse(file.problem, next)
    const env = parseEnvFile(file.text)
    const key = env[`AGENT${label}_PRIVATE_KEY`]
    if (inKeychain(env)) {
      // the keychain holds the key: it is read, and must be the address the file names
      try { keyAgent = privateKeyToAddress(agentSecretFor(env, label, env[`AGENT${label}_ADDRESS`])) } catch (err) {
        if (!isKeyRefusal(err)) throw err
        return refuse((err as Error).message, next)
      }
    } else if (key) {
      if (!CHAIN.testnet) return refuse(`${AGENT_ENV_PATH} holds a plain-text agent key, which is never used on ${CHAIN.label}`, next)
      try { keyAgent = privateKeyToAddress(key as Hex) } catch { return refuse(`${AGENT_ENV_PATH} holds an AGENT${label}_PRIVATE_KEY that is not a key`, next) }
    } else if (env[`AGENT${label}_ADDRESS`]) keyAgent = env[`AGENT${label}_ADDRESS`]
  }
  const b = await agentBinding('tempo', { owner, agent, lines: pub }, { label, keyAgent, file: PUBLIC_ENV_PATH, testnet: TESTNET === true })
  if (b.state === 'refused') return refuse(b.problem, next)
  noteBinding(b) // the page this plan opens says whether the owner signed this agent
  if (b.state === 'legacy') console.error(legacyWarning('tempo', PUBLIC_ENV_PATH, agent, `${flag}${hosted}`))
  return { owner, agent }
}
