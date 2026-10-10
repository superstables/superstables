// The chain facts that prove a sent transaction changed nothing, shared by the owner approval page (owner-approval-server.ts)
// and the budget commands (budget/proof.mjs). A `failed` answer after a send names one of them, or it is unknown.

/** The only values a `proof` may take. */
export const PROOFS = Object.freeze({
  reverted: "the transaction landed and failed on chain, so it changed nothing (its network fee may still be charged)",
  blockhash_expired: "solana: the chain is past the transaction's last valid block height and has no status for its signature, so it can never land",
});

/** Whether `proof` is one of PROOFS. */
export const isProof = (proof) => typeof proof === "string" && Object.hasOwn(PROOFS, proof);
