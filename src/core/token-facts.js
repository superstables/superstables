// The facts about the token a chain pays in, as a chain table states them: its address, symbol and decimals, and on
// an EVM chain its own EIP-712 signing domain and whether a new allowance must start from 0 (approveReset). Every
// table entry states every fact; nothing is assumed (no "6 decimals", no "USDC"). Both chain tables check their
// entries with this as they load (src/core/chain.ts, budget/evm/chains.ts), so an entry with a missing or malformed
// fact stops the program instead of signing with a guess.
//
// Plain JavaScript with JSDoc types, so the budget's scripts and src/ share it, like ./chain-gate.js. It imports nothing.

/**
 * @typedef {object} TokenFacts  The token a chain pays in.
 * @property {string} symbol     what people read, e.g. "USDC"
 * @property {string} address    the token contract (EVM, Tempo) or mint (Solana)
 * @property {number} decimals   how many decimal places one unit has: amounts are whole numbers of 10^-decimals
 */
/**
 * @typedef {TokenFacts & { domain: { name: string, version: string }, approveReset: boolean }} EvmTokenFacts
 *   domain: the token's own EIP-712 domain (name, version); approveReset: approve(spender, 0) must come before a new
 *   allowance above 0 (USDT-style tokens). Every grant here already starts from an allowance of 0, so a true value
 *   changes no transaction; it is a fact a mainnet entry must state.
 */

/** The most decimal places a token may state (the bound the exact amount helpers in chain.ts accept). */
export const MAX_TOKEN_DECIMALS = 77;

const nonEmpty = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && v.trim() === v;

/**
 * Why `token` is not a complete statement of a token's facts on `rail`, in words, or "" when it is.
 * @param {unknown} token
 * @param {"evm" | "tempo" | "solana"} rail
 * @returns {string}
 */
export function tokenFactsProblem(token, rail) {
  if (!token || typeof token !== "object" || Array.isArray(token)) return "it states no token";
  const t = /** @type {Record<string, unknown>} */ (token);
  if (!nonEmpty(t.symbol, 12) || !/^[A-Za-z0-9]+$/.test(String(t.symbol))) return "the token's symbol is missing or malformed";
  const address = rail === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-fA-F]{40}$/;
  if (typeof t.address !== "string" || !address.test(t.address)) return "the token's address is missing or malformed";
  if (!Number.isInteger(t.decimals) || /** @type {number} */ (t.decimals) < 0 || /** @type {number} */ (t.decimals) > MAX_TOKEN_DECIMALS) return "the token's decimals are missing or not a whole number from 0 to 77";
  if (rail !== "evm") return "";
  const d = /** @type {Record<string, unknown> | undefined} */ (t.domain);
  if (!d || typeof d !== "object" || !nonEmpty(d.name, 80) || !nonEmpty(d.version, 20)) return "the token's EIP-712 domain (name, version) is missing or malformed";
  if (typeof t.approveReset !== "boolean") return "the token does not say whether a new allowance must start from 0 (approveReset)";
  return "";
}
