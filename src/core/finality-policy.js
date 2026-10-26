/** The finality rule for every client reader. Only these pinned BFT networks use latest. */
export function finalityFor(rail, chain) {
  return (rail === "tempo" && chain === "moderato") || (rail === "evm" && chain === "skale-base-sepolia")
    ? "instant" : "finalized";
}

/**
 * Seconds a chain usually takes to make a block final: for wording only ("final in about N minutes"). Never decides a
 * verdict or a wait. The mainnet gate (chain-gate.js) asks that a chain have one before it can be signed on.
 * Filled from measured runs in the same sitting as the website's table; a chain left out has no number. The two
 * instant-finality chains are final the moment a block is canonical.
 */
export const TYPICAL_FINAL_SECONDS = { "evm:skale-base-sepolia": 0, "tempo:moderato": 0 };

/** { kind, typicalSeconds }: typicalSeconds is undefined when it has not been measured yet. */
export function finalityProfile(rail, chain) {
  return { kind: finalityFor(rail, chain), typicalSeconds: TYPICAL_FINAL_SECONDS[`${rail}:${chain}`] };
}

/** "about N minutes", "a few seconds", or "" when the number is not known: callers then leave the time out. */
export function finalWords(rail, chain) {
  const s = TYPICAL_FINAL_SECONDS[`${rail}:${chain}`];
  if (typeof s !== "number") return "";
  if (s < 10) return "a few seconds";
  if (s < 90) return `about ${Math.round(s)} seconds`;
  const m = Math.round(s / 60);
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}

export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Maximum distance between EVM final heads, in blocks. Base Sepolia advances finalized in batches of
 * 1,800–2,400 blocks (~0.2 s/block, measured 25–26 October 2026): 3,000 allows one batch plus headroom.
 * Arbitrum's batched finality uses the same 5,000-block bound as the website. Other chains keep 1,000.
 * This bounds lag; agreement also checks each endpoint's own final value so old live state cannot win.
 * @param {number} chainId
 */
export function maxFinalizedSpread(chainId) {
  if (chainId === 84532) return 3000n;
  if (chainId === 421614) return 5000n;
  return 1000n;
}
