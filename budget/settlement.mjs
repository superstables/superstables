// buy-once: read a payment the site reports from the chain before the CLI says it was paid. Plain JavaScript with Node
// built-ins only (JSON-RPC through rpc.mjs), so the dispatcher and the standalone build share it.
//
//   Base Sepolia (evm), Tempo Moderato (tempo)   the transaction's receipt: success, and a Transfer log of the listed token
//                                                from the payer to the listed recipient of exactly the amount
//   Solana devnet (solana)                       the transaction: no error, and the recipient's token account of the
//                                                listed mint up by exactly the amount (the payer's down by it)
//
// On every network the transaction must be mined after the purchase was created (less a minute for clock skew), so an older
// payment to the same recipient does not count. The RPC is the rail's, or its replacement (B4_RPC, SUPERSTABLES_TEMPO_RPC,
// SUPERSTABLES_SOLANA_RPC; https or this computer only).
import { EVM_CHAINS } from "./evm/chains.mjs";
import { DEFAULT_RPC, jsonRpc, rpcFromEnv } from "./rpc.mjs";

/** topic0 of ERC-20 and TIP-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** How much earlier than the purchase's creation a payment may be mined (clock skew between this computer and the chain). */
const SKEW_S = 60;

/** The RPC this computer reads `rail` and `chain` through. */
export function settlementRpc(rail, chain) {
  if (rail === "tempo") return rpcFromEnv("SUPERSTABLES_TEMPO_RPC", DEFAULT_RPC.tempo).url;
  if (rail === "solana") return rpcFromEnv("SUPERSTABLES_SOLANA_RPC", DEFAULT_RPC.solana).url;
  return rpcFromEnv("B4_RPC", EVM_CHAINS[chain]?.rpc ?? EVM_CHAINS["base-sepolia"].rpc).url;
}

const topicAddress = (t) => (typeof t === "string" && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : null);

/**
 * Whether transaction `tx` paid `amount` (atomic units, bigint) of `asset` to `payTo` (from `payer`, when the site named
 * one), after `notBefore` (unix seconds). { state: "settled" }, { state: "mismatch", reason } when the chain shows that
 * transaction and it is not that payment, or { state: "unread", reason } when the chain cannot say (not found, RPC down).
 */
export async function readSettlement({ rail, chain, tx, payer, payTo, asset, amount, notBefore, rpcUrl, deadline }) {
  const url = rpcUrl ?? settlementRpc(rail, chain);
  // `deadline` (an absolute time, ms): every RPC call gets what is left of it at most, and none starts after it
  const rpc = (method, params) => {
    const left = deadline === undefined ? RPC_TIMEOUT_MS : Math.min(RPC_TIMEOUT_MS, deadline - Date.now());
    if (left <= 0) throw new Error("the chain did not answer before this command's deadline");
    return jsonRpc(url, method, params, left);
  };
  try {
    return rail === "solana" ? await solanaSettlement({ rpc, tx, payer, payTo, asset, amount, notBefore }) : await evmSettlement({ rpc, rail, chain, tx, payer, payTo, asset, amount, notBefore });
  } catch (e) {
    // a call cut short by the deadline is said as such, not as an RPC error
    if (deadline !== undefined && Date.now() >= deadline - 50) return { state: "unread", reason: "the chain did not answer before this command's deadline" };
    return { state: "unread", reason: `the chain could not be read (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})` };
  }
}

/** How long one RPC call may take when no deadline is closer (rpc.mjs's own default). */
const RPC_TIMEOUT_MS = 15_000;

async function evmSettlement({ rpc, rail, chain, tx, payer, payTo, asset, amount, notBefore }) {
  const receipt = await rpc("eth_getTransactionReceipt", [tx]);
  if (!receipt) return { state: "unread", reason: `the chain does not show transaction ${tx} (yet)` };
  // Only the pinned Tempo and SKALE configurations use committed blocks with instant BFT finality.
  const final = await rpc("eth_getBlockByNumber", [rail === "tempo" || chain === "skale-base-sepolia" ? "latest" : "finalized", false]);
  const hexNumber = (n) => typeof n === "string" && /^0x[0-9a-fA-F]+$/.test(n);
  const hash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  if (!hexNumber(final?.number) || !hexNumber(receipt.blockNumber) || BigInt(receipt.blockNumber) > BigInt(final.number) || !hash(receipt.blockHash) || receipt.logs?.some((l) => l.removed)) return { state: "unread", reason: `transaction ${tx} has not reached final canonical inclusion` };
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!hexNumber(block?.number) || BigInt(block.number) !== BigInt(receipt.blockNumber) || !hash(block?.hash) || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return { state: "unread", reason: `the canonical block of transaction ${tx} could not be verified` };
  if (receipt.status !== "0x1") return { state: "mismatch", reason: `transaction ${tx} failed on chain` };
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const paid = logs.find((l) =>
    String(l.address).toLowerCase() === asset.toLowerCase() &&
    Array.isArray(l.topics) && l.topics[0] === TRANSFER_TOPIC &&
    topicAddress(l.topics[2]) === payTo.toLowerCase() &&
    (!payer || topicAddress(l.topics[1]) === payer.toLowerCase()) &&
    (() => { try { return BigInt(l.data) === amount; } catch { return false; } })());
  if (!paid) return { state: "mismatch", reason: `transaction ${tx} has no transfer of exactly ${amount} base units of ${asset} ${payer ? `from ${payer} ` : ""}to ${payTo}` };
  const at = block?.timestamp ? Number(BigInt(block.timestamp)) : null;
  if (at === null) return { state: "unread", reason: `the block of transaction ${tx} could not be read` };
  if (at < notBefore - SKEW_S) return { state: "mismatch", reason: `transaction ${tx} was mined before this purchase was created` };
  return { state: "settled" };
}

async function solanaSettlement({ rpc, tx, payer, payTo, asset, amount, notBefore }) {
  const t = await rpc("getTransaction", [tx, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  if (!t) return { state: "unread", reason: `the chain does not show transaction ${tx} (yet)` };
  if (t.meta?.err) return { state: "mismatch", reason: `transaction ${tx} failed on chain` };
  const balances = (list) => new Map((Array.isArray(list) ? list : []).filter((b) => b && b.mint === asset).map((b) => [b.owner, BigInt(b.uiTokenAmount?.amount ?? "0")]));
  const pre = balances(t.meta?.preTokenBalances);
  const post = balances(t.meta?.postTokenBalances);
  const delta = (owner) => (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n);
  if (delta(payTo) !== amount) return { state: "mismatch", reason: `transaction ${tx} moved ${delta(payTo)} base units of ${asset} to ${payTo}, not ${amount}` };
  if (payer && delta(payer) !== -amount) return { state: "mismatch", reason: `transaction ${tx} did not take ${amount} base units of ${asset} from ${payer}` };
  if (typeof t.blockTime !== "number") return { state: "unread", reason: `the time of transaction ${tx} could not be read` };
  if (t.blockTime < notBefore - SKEW_S) return { state: "mismatch", reason: `transaction ${tx} landed before this purchase was created` };
  return { state: "settled" };
}
