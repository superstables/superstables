// Constants shared by the TypeScript scripts (through common.ts) and the plain .mjs helpers.
//
// The chain: Tempo Moderato, the testnet (default), or Tempo mainnet, which the table holds only while the operator's
// switch is on (SUPERSTABLES_ALLOW_MAINNET, ../../../src/core/mainnet-policy.js) and takes its facts from the mainnet
// manifest. The dispatcher names the chain in SUPERSTABLES_BUDGET_CHAIN (--chain moderato or --chain tempo). A chain this
// table does not hold sets CHAIN_PROBLEM, and every Tempo script refuses on it as it loads (common.ts), before it reads a
// key or asks an RPC anything. The dispatcher imports this file too, so a bad value never stops it here.
import { DEFAULT_RPC, rpcFromEnv } from '../../rpc.mjs'
import { mainnetChains } from '../../../src/core/mainnet-policy.js'

/** The variable the dispatcher names the Tempo or Solana budget chain in. */
export const CHAIN_ENV = 'SUPERSTABLES_BUDGET_CHAIN'

/**
 * The Tempo chains a budget can be on, by their --chain key. `gateKey` is the chain's key in the chain gate, the RPC
 * tables and the owner settings; `binding` is how the owner-binding message and the owner page name the chain.
 */
export const TEMPO_CHAINS = {
  moderato: {
    key: 'moderato', gateKey: 'tempo-moderato', label: 'Tempo Moderato', binding: 'Tempo Testnet (Moderato)', chainId: 42431, testnet: true,
    rpc: DEFAULT_RPC.tempo, explorer: 'https://explore.testnet.tempo.xyz', faucet: true,
  },
}
for (const [key, c] of mainnetChains('tempo')) {
  TEMPO_CHAINS[key] = { key, gateKey: key, label: c.label, binding: c.label, chainId: c.chainId, testnet: false, rpc: c.rpc[0].url, explorer: c.explorer, faucet: false }
}
export const TEMPO_CHAIN_KEYS = Object.keys(TEMPO_CHAINS)
export const TEMPO_DEFAULT_CHAIN = 'moderato'

const named = process.env[CHAIN_ENV]?.trim() || TEMPO_DEFAULT_CHAIN
/** Why this process must not run a Tempo script, or '': SUPERSTABLES_BUDGET_CHAIN names a chain the table does not hold. */
export const CHAIN_PROBLEM = Object.hasOwn(TEMPO_CHAINS, named) ? '' : `${CHAIN_ENV} names "${named.slice(0, 40)}", which is not a Tempo chain this process holds (${TEMPO_CHAIN_KEYS.join(', ')}); a mainnet is there only while the operator's switch is on`
/** The chain this process runs on: SUPERSTABLES_BUDGET_CHAIN, or Moderato when it is unset. Under CHAIN_PROBLEM, Moderato's facts, never used to sign. */
export const CHAIN = CHAIN_PROBLEM ? TEMPO_CHAINS.moderato : TEMPO_CHAINS[named]

/**
 * SUPERSTABLES_TEMPO_RPC replaces the chain's RPC URL (tests point it at a local fake; you can point it at your own node);
 * with no variable, the RPC the owner set for the chain (superstables owner settings rpc) is read. https, or http on this
 * computer only (../../rpc.mjs): anything else is ignored here with a warning, and the dispatcher refuses the command before
 * it runs a script. An owner script (owner.ts) also refuses a variable that is not one of the owner's RPCs, before it does anything.
 */
export const RPC_URL = (() => {
  const r = rpcFromEnv('SUPERSTABLES_TEMPO_RPC', CHAIN.rpc, 'read', CHAIN.gateKey)
  if (r.error) process.stderr.write(`warning: ${r.error}; using ${CHAIN.rpc}\n`)
  return r.url
})()
export const CHAIN_ID = CHAIN.chainId
/** true on Moderato. On mainnet the chain gate (../../../src/core/chain-gate.js) decides whether anything is signed. */
export const TESTNET = CHAIN.testnet
// pathUSD: Tempo's protocol-level reference USD stablecoin, a fixed address, 6 decimals, the same on every Tempo chain.
export const TOKEN_ADDRESS = '0x20C0000000000000000000000000000000000000'
export const TOKEN_DECIMALS = 6
export const TOKEN_LABEL = 'pathUSD'
