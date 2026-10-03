// Constants shared by the TypeScript scripts (through common.ts) and the plain .mjs helpers.
import { DEFAULT_RPC, rpcFromEnv } from '../../rpc.mjs'
/**
 * SUPERSTABLES_TEMPO_RPC replaces the Moderato RPC URL (tests point it at a local fake; you can point it at your own node).
 * https, or http on this computer only (../../rpc.mjs): anything else is ignored here with a warning, and the dispatcher
 * refuses the command before it runs a script.
 */
export const RPC_URL = (() => {
  const r = rpcFromEnv('SUPERSTABLES_TEMPO_RPC', DEFAULT_RPC.tempo)
  if (r.error) process.stderr.write(`warning: ${r.error}; using ${DEFAULT_RPC.tempo}\n`)
  return r.url
})()
export const CHAIN_ID = 42431
// pathUSD: Tempo's protocol-level reference USD stablecoin, a fixed address, 6 decimals.
export const TOKEN_ADDRESS = '0x20C0000000000000000000000000000000000000'
export const TOKEN_DECIMALS = 6
export const TOKEN_LABEL = 'pathUSD'
