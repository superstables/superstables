// Constants shared by the TypeScript scripts (through common.ts) and the plain .mjs helpers.
/**
 * SUPERSTABLES_TEMPO_RPC replaces the Moderato RPC URL (tests point it at a local fake; you can point it at your own node).
 * Anything but an http(s) URL is ignored, with a warning.
 */
export const RPC_URL = (() => {
  const v = process.env.SUPERSTABLES_TEMPO_RPC?.trim()
  if (!v) return 'https://rpc.moderato.tempo.xyz'
  if (/^https?:\/\/[^\s]+$/.test(v)) return v
  process.stderr.write(`warning: SUPERSTABLES_TEMPO_RPC is not an http(s) URL; using https://rpc.moderato.tempo.xyz\n`)
  return 'https://rpc.moderato.tempo.xyz'
})()
export const CHAIN_ID = 42431
// pathUSD: Tempo's protocol-level reference USD stablecoin, a fixed address, 6 decimals.
export const TOKEN_ADDRESS = '0x20C0000000000000000000000000000000000000'
export const TOKEN_DECIMALS = 6
export const TOKEN_LABEL = 'pathUSD'
