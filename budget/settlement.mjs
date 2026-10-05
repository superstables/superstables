// buy-once: read a payment the site reports from the chain before the CLI says it was paid. Plain JavaScript with Node
// built-ins only (JSON-RPC through rpc.mjs), so the dispatcher and the standalone build share it.
// EVM checks AuthorizationUsed for the purchase nonce and its Transfer in the claimed receipt. Tempo checks the
// purchase memo in TransferWithMemo. Solana checks the payer's signature over the message committed by the hosted API,
// its first signature as transaction ID, and the exact token balance changes. All receipts require successful execution.
// The creation-time boundary allows a minute of clock skew in addition to the purchase identity check.
import { createHash, createPublicKey, verify } from "node:crypto";
import { EVM_CHAINS } from "./evm/chains.mjs";
import { DEFAULT_RPC, jsonRpc, rpcFromEnv } from "./rpc.mjs";

/** topic0 of ERC-20 and TIP-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** How much earlier than the purchase's creation a payment may be mined (clock skew between this computer and the chain). */
const SKEW_S = 60;
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
const sameHex = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const isNonce = (n) => typeof n === "string" && /^0x[0-9a-fA-F]{64}$/.test(n);

function base58Bytes(text) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (typeof text !== "string" || !text.length || text.length > 90) throw new Error("invalid base58 identity");
  let value = 0n;
  for (const c of text) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error("invalid base58 identity");
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  return Buffer.concat([Buffer.alloc(/^1*/.exec(text)[0].length), value === 0n ? Buffer.alloc(0) : Buffer.from(hex.padStart(Math.ceil(hex.length / 2) * 2, "0"), "hex")]);
}

function shortvec(bytes, at) {
  let value = 0;
  for (let shift = 0; shift <= 14; shift += 7) {
    if (at >= bytes.length) throw new Error("incomplete Solana transaction");
    const byte = bytes[at++];
    value |= (byte & 127) << shift;
    if (!(byte & 128)) return { value, at };
  }
  throw new Error("invalid Solana transaction length");
}

function solanaIdentity(raw, tx, payer, nonce) {
  if (!Array.isArray(raw) || raw[1] !== "base64" || typeof raw[0] !== "string") return false;
  const bytes = Buffer.from(raw[0], "base64");
  const count = shortvec(bytes, 0);
  const start = count.at + count.value * 64;
  if (!count.value || start >= bytes.length || !bytes.subarray(count.at, count.at + 64).equals(base58Bytes(tx))) return false;
  const message = bytes.subarray(start);
  // The hosted API commits to the base64 string, matching prepareSolana's authNonce.
  if (!sameHex(`0x${createHash("sha256").update(message.toString("base64")).digest("hex")}`, nonce)) return false;
  const header = message[0] & 128 ? 1 : 0;
  if (header && message[0] !== 128) return false;
  const required = message[header];
  const keys = shortvec(message, header + 3);
  if (required !== count.value || required > keys.value || keys.at + keys.value * 32 > message.length) return false;
  const owner = base58Bytes(payer);
  if (owner.length !== 32) return false;
  for (let i = 0; i < required; i++) {
    if (!message.subarray(keys.at + i * 32, keys.at + (i + 1) * 32).equals(owner)) continue;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), owner]), format: "der", type: "spki" });
    return verify(null, message, key, bytes.subarray(count.at + i * 64, count.at + (i + 1) * 64));
  }
  return false;
}

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
export async function readSettlement({ rail, chain, tx, payer, payTo, asset, amount, notBefore, nonce, rpcUrl, deadline }) {
  if (!isNonce(nonce) || !payer) return { state: "unread", reason: "this purchase has no payment identity and payer to verify" };
  const url = rpcUrl ?? settlementRpc(rail, chain);
  // `deadline` (an absolute time, ms): every RPC call gets what is left of it at most, and none starts after it
  const rpc = (method, params) => {
    const left = deadline === undefined ? RPC_TIMEOUT_MS : Math.min(RPC_TIMEOUT_MS, deadline - Date.now());
    if (left <= 0) throw new Error("the chain did not answer before this command's deadline");
    return jsonRpc(url, method, params, left);
  };
  try {
    return rail === "solana" ? await solanaSettlement({ rpc, tx, payer, payTo, asset, amount, notBefore, nonce }) : await evmSettlement({ rpc, rail, tx, payer, payTo, asset, amount, notBefore, nonce });
  } catch (e) {
    // a call cut short by the deadline is said as such, not as an RPC error
    if (deadline !== undefined && Date.now() >= deadline - 50) return { state: "unread", reason: "the chain did not answer before this command's deadline" };
    return { state: "unread", reason: `the chain could not be read (${String(e?.message ?? e).split("\n")[0].slice(0, 160)})` };
  }
}

/** How long one RPC call may take when no deadline is closer (rpc.mjs's own default). */
const RPC_TIMEOUT_MS = 15_000;

async function evmSettlement({ rpc, rail, tx, payer, payTo, asset, amount, notBefore, nonce }) {
  const receipt = await rpc("eth_getTransactionReceipt", [tx]);
  if (!receipt) return { state: "unread", reason: `the chain does not show transaction ${tx} (yet)` };
  if (!sameHex(receipt.transactionHash, tx)) return { state: "mismatch", reason: `the receipt does not belong to transaction ${tx}` };
  if (receipt.status !== "0x1") return { state: "mismatch", reason: `transaction ${tx} failed on chain` };
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const tokenLogs = logs.filter((l) => !l.removed && sameHex(l.address, asset));
  const paid = tokenLogs.find((l) =>
    Array.isArray(l.topics) && sameHex(l.topics[0], rail === "tempo" ? TRANSFER_WITH_MEMO_TOPIC : TRANSFER_TOPIC) &&
    (rail !== "tempo" || sameHex(l.topics[3], nonce)) &&
    topicAddress(l.topics[2]) === payTo.toLowerCase() &&
    (!payer || topicAddress(l.topics[1]) === payer.toLowerCase()) &&
    (() => { try { return BigInt(l.data) === amount; } catch { return false; } })());
  if (!paid) return { state: "mismatch", reason: `transaction ${tx} has no transfer of exactly ${amount} base units of ${asset} ${payer ? `from ${payer} ` : ""}to ${payTo}` };
  if (rail !== "tempo" && !tokenLogs.some((l) => sameHex(l.topics?.[0], AUTHORIZATION_USED_TOPIC) && topicAddress(l.topics?.[1]) === payer.toLowerCase() && sameHex(l.topics?.[2], nonce))) {
    return { state: "mismatch", reason: `transaction ${tx} did not use this purchase's authorization nonce` };
  }
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const at = block?.timestamp ? Number(BigInt(block.timestamp)) : null;
  if (at === null) return { state: "unread", reason: `the block of transaction ${tx} could not be read` };
  if (at < notBefore - SKEW_S) return { state: "mismatch", reason: `transaction ${tx} was mined before this purchase was created` };
  return { state: "settled" };
}

async function solanaSettlement({ rpc, tx, payer, payTo, asset, amount, notBefore, nonce }) {
  const t = await rpc("getTransaction", [tx, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!t) return { state: "unread", reason: `the chain does not show transaction ${tx} (yet)` };
  if (!t.meta || !Object.prototype.hasOwnProperty.call(t.meta, "err")) return { state: "unread", reason: `transaction ${tx} has no execution result` };
  if (t.meta.err) return { state: "mismatch", reason: `transaction ${tx} failed on chain` };
  const balances = (list) => new Map((Array.isArray(list) ? list : []).filter((b) => b && b.mint === asset).map((b) => [b.owner, BigInt(b.uiTokenAmount?.amount ?? "0")]));
  const pre = balances(t.meta?.preTokenBalances);
  const post = balances(t.meta?.postTokenBalances);
  const delta = (owner) => (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n);
  if (delta(payTo) !== amount) return { state: "mismatch", reason: `transaction ${tx} moved ${delta(payTo)} base units of ${asset} to ${payTo}, not ${amount}` };
  if (payer && delta(payer) !== -amount) return { state: "mismatch", reason: `transaction ${tx} did not take ${amount} base units of ${asset} from ${payer}` };
  const signed = await rpc("getTransaction", [tx, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  if (!signed) return { state: "unread", reason: `the signed message of transaction ${tx} could not be read` };
  if (!solanaIdentity(signed.transaction, tx, payer, nonce)) return { state: "mismatch", reason: `transaction ${tx} does not carry this payer's signature over this purchase's message` };
  if (typeof t.blockTime !== "number") return { state: "unread", reason: `the time of transaction ${tx} could not be read` };
  if (t.blockTime < notBefore - SKEW_S) return { state: "mismatch", reason: `transaction ${tx} landed before this purchase was created` };
  return { state: "settled" };
}
