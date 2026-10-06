/** The finality rule for every client reader. Only these pinned BFT networks use latest. */
export function finalityFor(rail, chain) {
  return (rail === "tempo" && chain === "moderato") || (rail === "evm" && chain === "skale-base-sepolia")
    ? "instant" : "finalized";
}

export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
