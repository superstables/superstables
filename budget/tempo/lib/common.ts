// Shared helpers for the Tempo superstables budget scripts.
//
// Reads the agent key from tempo-agent.env (mode 600, paths from ../../paths.mjs). The owner's key
// stays in the owner's own wallet: owner commands go through the owner page (../owner.ts). An owner
// key file is read only when a test names it with --owner-key-file (loadOwnerKeyFile), and never
// in the same process as the agent file (contract rule 1). Never logs a private key.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { Account, Addresses, createClient, http } from 'viem/tempo'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import type { Address, Hex } from 'viem'

import { CHAIN_ID as CHAIN_ID_, RPC_URL as RPC_URL_, TOKEN_DECIMALS as TOKEN_DECIMALS_, TOKEN_LABEL as TOKEN_LABEL_ } from './constants.mjs'
import { agentKeyFile, ownerKeyFile, publicFile } from '../../paths.mjs'

export const RPC_URL: string = RPC_URL_
export const EXPLORER_BASE = 'https://explore.testnet.tempo.xyz'
export const CHAIN_ID: number = CHAIN_ID_

// pathUSD: Tempo's protocol-level reference USD stablecoin. Fixed address on
// every Tempo chain (mainnet and testnets share the same precompile-style
// address). 6 decimals. Also the default fallback fee token.
// (constants.mjs holds the same values for the plain .mjs helpers.)
export const TOKEN_ADDRESS: Address = Addresses.pathUsd
export const TOKEN_DECIMALS: number = TOKEN_DECIMALS_
export const TOKEN_LABEL: string = TOKEN_LABEL_

/**
 * Seller text (its challenge, its answer, its errors) on one log line: control characters, newlines included, and the Unicode
 * line separators become spaces. A seller must not be able to start a line of its own on stdout, where the dispatcher reads
 * APPROVE and RESULT lines. The same rule as evm's oneLine.
 */
export const oneLine = (s: unknown, max = 300): string => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max)

// Key files (contract rule 1). Owner and agent keys never share a file.
//   the owner's wallet  holds the owner key. setup, grant and revoke ask it on the owner page.
//   tempo-agent.env     AGENT*_PRIVATE_KEY (access keys) + public addresses. Opened only by agent
//                       commands (buy) and by setup, which creates it. No owner key in it.
//   public file         public addresses only. Read commands (readBudget, reconcile) and the owner
//                       commands use it, or take --owner/--key and need no file at all.
//   an owner key file   tests and automation only, named with --owner-key-file <path> (mode 600):
//                       OWNER_PRIVATE_KEY. The default path ownerKeyFile('tempo') is never read.
export const OWNER_ENV_PATH = ownerKeyFile('tempo')
export const AGENT_ENV_PATH = agentKeyFile('tempo')
export const PUBLIC_ENV_PATH = publicFile('tempo', 'moderato')

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

function readEnvFile(path: string, hint: string): Record<string, string> {
  if (!existsSync(path)) throw new Error(`${path} not found. ${hint}`)
  return parseEnvFile(readFileSync(path, 'utf8'))
}

const isAddress = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

/**
 * An owner key file named with --owner-key-file (tests and automation only; the caller checks its mode): the owner private key.
 * OWNER_ADDRESS is derived from the key; if the file also names one, it must match.
 */
export function loadOwnerKeyFile(path: string): OwnerEnv {
  const parsed = readEnvFile(path, 'Pass the path of a test owner key file.')
  if (!parsed.OWNER_PRIVATE_KEY) throw new Error(`Missing OWNER_PRIVATE_KEY in ${path}`)
  const derived = privateKeyToAddress(parsed.OWNER_PRIVATE_KEY as Hex)
  if (parsed.OWNER_ADDRESS && parsed.OWNER_ADDRESS.toLowerCase() !== derived.toLowerCase()) throw new Error(`OWNER_PRIVATE_KEY in ${path} does not match its OWNER_ADDRESS`)
  return { ...parsed, OWNER_ADDRESS: derived } as OwnerEnv
}

/** Agent file: access-key private keys and public addresses. It holds no owner key. For agent commands only. */
export function loadAgentEnv(): AgentEnv {
  const parsed = readEnvFile(AGENT_ENV_PATH, 'Run "superstables budget setup --rail tempo" to create the agent key and connect the owner.')
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

/** Access-key private key and address for an agent label, from the agent file. */
export function resolveAgentKeys(env: Record<string, string>, label = ''): { privateKey: Hex; address: Address } {
  const prefix = label ? `AGENT${label}` : 'AGENT'
  const privateKey = env[`${prefix}_PRIVATE_KEY`]
  const address = env[`${prefix}_ADDRESS`]
  if (!privateKey || !address) throw new Error(`Missing ${prefix}_PRIVATE_KEY/${prefix}_ADDRESS in ${AGENT_ENV_PATH}`)
  return { privateKey: privateKey as Hex, address: address as Address }
}

function appendLines(path: string, lines: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, lines, { mode: 0o600 })
}

/**
 * Creates a fresh agent access key for `label` ("2", "3", "V2609..."): private key + address go to
 * the agent file, the address alone to the public file. Returns the address (the existing one if the
 * label is taken). Owner commands and read commands find the agent by address; only the agent file
 * holds the key.
 */
export function appendExtraAgent(label: string): { address: Address; created: boolean } {
  const agentPath = AGENT_ENV_PATH
  if (!existsSync(agentPath)) throw new Error('The agent key file is missing. Run "superstables budget setup --rail tempo" first.')
  const existing = parseEnvFile(readFileSync(agentPath, 'utf8'))
  const addrKey = `AGENT${label}_ADDRESS`
  if (existing[addrKey]) {
    if (!loadPublicEnv()[addrKey]) writePublicEnv({ [addrKey]: existing[addrKey] })
    return { address: existing[addrKey] as Address, created: false }
  }
  const pk = generatePrivateKey()
  const address = privateKeyToAddress(pk)
  appendLines(agentPath, `AGENT${label}_PRIVATE_KEY=${pk}\n${addrKey}=${address}\n`)
  chmodSync(agentPath, 0o600)
  writePublicEnv({ [addrKey]: address })
  return { address, created: true }
}

/** Adds or updates public values in the public file (addresses only, never a key). Mode 644. */
export function writePublicEnv(updates: Record<string, string>) {
  for (const k of Object.keys(updates)) if (/PRIVATE|MNEMONIC|PASSWORD/i.test(k)) throw new Error(`${k} does not belong in the public file`)
  const env = { ...loadPublicEnv(), ...updates }
  mkdirSync(dirname(PUBLIC_ENV_PATH), { recursive: true, mode: 0o700 })
  writeFileSync(PUBLIC_ENV_PATH, '# Tempo public addresses only. Read commands use this file. No secrets.\n' + Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o644 })
}

/** Adds or replaces public (non-secret) lines in the agent file, keeping its keys. Mode stays 600. */
export function setAgentPublic(updates: Record<string, string>) {
  const lines = readFileSync(AGENT_ENV_PATH, 'utf8').split('\n').filter((l) => l !== '')
  for (const [k, v] of Object.entries(updates)) {
    if (/PRIVATE/i.test(k)) throw new Error(`${k} is not a public value`)
    const i = lines.findIndex((l) => l.startsWith(`${k}=`))
    if (i >= 0) lines[i] = `${k}=${v}`
    else lines.push(`${k}=${v}`)
  }
  // the agent file holds the only copy of the agent keys: write a new file (mode 600, never an existing one) and rename it
  // over the old in one step, so a crash or a full disk leaves the old file or the new one, never a truncated one
  const tmp = `${AGENT_ENV_PATH}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    chmodSync(tmp, 0o600)
    renameSync(tmp, AGENT_ENV_PATH)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
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

/** Writes a new env file with mode 600. Refuses to overwrite. */
export function writeEnvFile(path: string, header: string, entries: [string, string][], mode = 0o600) {
  if (existsSync(path)) throw new Error(`${path} already exists. Refusing to overwrite.`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `# ${header}\n` + entries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode })
  chmodSync(path, mode)
}

export function makeClient(account?: ReturnType<typeof ownerAccount> | ReturnType<typeof agentAccessKeyAccount>) {
  return createClient({
    account,
    testnet: true,
    transport: http(RPC_URL),
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
