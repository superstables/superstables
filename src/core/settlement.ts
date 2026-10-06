// Reading a `pay` settlement back from the chain. Each rail has its own check (src/core/rails/), and each answers in
// the same three words:
//
//   verified    the chain shows exactly this payment
//   mismatch    the chain shows something else (another amount, recipient, token, memo or nonce, or a failed
//               transaction): the payment is not confirmed, and whether money moved is unknown
//   unchecked   the chain could not say (no transaction, no receipt yet, the RPC did not answer); the seller's word
//               stands until a later check
//
// This file holds the x402 check on an EVM chain. The seller reports that its facilitator settled the payment and names a
// transaction; this reads that transaction's receipt from the payment's own chain and checks that it is this payment:
//
//   - the transaction succeeded;
//   - the chain's USDC contract logged AuthorizationUsed(authorizer = the payer, nonce = the EIP-3009 nonce the owner signed);
//   - the same contract logged Transfer(from = the payer, to = the recipient the client checked, value = the amount signed).
//
// The nonce is what ties the transaction to this payment: an older transfer of the same amount to the same seller cannot
// carry it. The RPC is the chain's own (src/core/rpc.ts): on Base Sepolia SUPERSTABLES_RPC_URL when it is https, or
// http on this computer, without credentials; https://sepolia.base.org otherwise, the same default as the budget's Base
// Sepolia rail. One request, under a short deadline, never redirected.

import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes } from "viem";
import { BASE_SEPOLIA, evmNetworkFor, isAddress, type EvmNetwork } from "./chain.js";
import { chainRpc, rpcCall, type RpcOptions } from "./rpc.js";
import { inclusion } from "./finality.js";
import type { FoundPayment } from "./rails/types.js";

/** "unpaid": the chain shows this payment was never made and can no longer be (recorded by a later check). */
export type ChainState = "verified" | "mismatch" | "unchecked" | "unpaid";
export interface ChainCheck {
  chain: ChainState;
  /** Matching successful inclusion, still rechecked until chain is verified. */
  included?: true;
  /** Why, for mismatch and unchecked: the client's own words. */
  reason?: string;
}

export interface SettlementToCheck {
  /** The transaction the seller named, if it named one. */
  transaction?: string;
  payer: string;
  recipient: string;
  /** Atomic units (USDC has 6 decimals). */
  amountAtomic: string;
  /** The EIP-3009 nonce the owner signed (bytes32 hex). */
  nonce?: string;
  /** The payment's chain (CAIP-2 or x402 v1 name). Base Sepolia when absent, as before chains were named here. */
  network?: string;
}

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

/** The RPC a Base Sepolia settlement is read through, or the reason the configured one is refused. */
export function settlementRpc(env: NodeJS.ProcessEnv = process.env): { url: string } | { error: string } {
  return chainRpc(BASE_SEPOLIA, env);
}

const isHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  removed?: boolean;
}

/** Read the transaction's receipt and say whether it is this payment. Never throws. */
export async function checkSettlement(
  input: SettlementToCheck,
  options: { rpcUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChainCheck> {
  if (!isHash(input.transaction)) return { chain: "unchecked", reason: "no transaction hash was given" };
  const network = input.network === undefined ? BASE_SEPOLIA : evmNetworkFor(input.network);
  if (!network) return { chain: "unchecked", reason: "this payment's chain is not one this client reads" };
  if (!input.nonce || !/^0x[0-9a-fA-F]{64}$/.test(input.nonce) || !isAddress(input.payer) || !isAddress(input.recipient)) {
    return { chain: "unchecked", reason: "this payment's signed authorization was not recorded, so it cannot be matched" };
  }
  const rpc = options.rpcUrl ? { url: options.rpcUrl } : chainRpc(network);
  if ("error" in rpc) return { chain: "unchecked", reason: `the chain was not read: ${rpc.error}` };

  let receipt: { status?: string; transactionHash?: string; blockNumber?: string; blockHash?: string; logs?: RpcLog[] } | null;
  try {
    receipt = await rpcCall(rpc.url, "eth_getTransactionReceipt", [input.transaction], options);
  } catch {
    // The RPC's own error text is not repeated: it is somebody else's words.
    return { chain: "unchecked", reason: "the chain could not be read: the RPC did not give a usable answer" };
  }
  if (!receipt) return { chain: "unchecked", reason: "the chain does not show the transaction yet" };
  // The answer must be the receipt of the transaction asked for: an RPC that answers with another one's is not read.
  if (!isHash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== input.transaction.toLowerCase()) {
    return { chain: "unchecked", reason: "the chain could not be read: the RPC answered with a receipt for another transaction" };
  }
  const proof = await inclusion(rpc.url, receipt, network.finality, options);
  if (proof === "unread") return { chain: "unchecked", reason: "the transaction's block could not be verified" };
  if (receipt.status !== "0x1") return { chain: "mismatch", reason: "the transaction failed on chain" };

  const usdc = network.usdc.address;
  const logs = (Array.isArray(receipt.logs) ? receipt.logs : []).filter((l) => same(l?.address, usdc) && Array.isArray(l.topics));
  const used = logs.some(
    (l) => l.topics![0] === AUTHORIZATION_USED_TOPIC && same(l.topics![1], topicOf(input.payer)) && same(l.topics![2], input.nonce!),
  );
  if (!used) return { chain: "mismatch", reason: "the transaction did not use the authorization the owner signed for this payment" };
  const paid = logs.some((l) => {
    if (l.topics![0] !== TRANSFER_TOPIC || !same(l.topics![1], topicOf(input.payer)) || !same(l.topics![2], topicOf(input.recipient))) return false;
    try {
      return BigInt(l.data ?? "") === BigInt(input.amountAtomic);
    } catch {
      return false;
    }
  });
  if (!paid) return { chain: "mismatch", reason: "the transaction did not transfer the signed amount to the checked recipient" };
  return proof === "final" ? { chain: "verified" } : { chain: "unchecked", included: true, reason: "the payment landed, but is not final on chain yet" };
}

// ── Finding an authorization nobody reported ─────────────────────────────────────────────────────────────────

const AUTHORIZATION_CANCELED_TOPIC = keccak256(toBytes("AuthorizationCanceled(address,bytes32)"));
const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;


/** A log search starts this long before the attempt began (clocks differ), and reads at most this many windows. */
const SEARCH_MARGIN_S = 600;
const MAX_LOG_WINDOWS = 100;

export interface AuthorizationToFind {
  network: string;
  payer: string;
  /** The EIP-3009 nonce the owner signed. */
  nonce?: string;
  /** The signed validBefore, ISO. */
  validBefore?: string;
  /** When the attempt began: the authorization did not exist before. */
  since?: string;
  /** A transaction the seller named, read first. */
  transaction?: string;
  recipient: string;
  amountAtomic: string;
}

interface Block {
  number: bigint;
  timestamp: number;
  /** The block's hash, when the RPC gave a well-formed one. */
  hash?: string;
}

/**
 * Look for the payment of an EIP-3009 authorization on its chain, without trusting any transaction a seller named. The
 * token itself says whether the nonce was used (authorizationState):
 *
 *   used       the transaction that used it is found by its AuthorizationUsed log, and checked as above: found. A
 *              cancellation (AuthorizationCanceled) is `never` only when it is in the chain's final history: the final
 *              block is read before the logs, the cancellation's block is at or below it, and that height's block, read
 *              after it, is the cancellation's (the same hash). A used nonce does not say what used it: a payment may
 *              have replaced a cancellation that a reorganisation dropped. Anything less decides nothing.
 *   unused     before validBefore it can still be used: not found yet. `never` (no money moved, and none can) only on a
 *              final block (the `finalized` block, or the latest on a chain with instant finality) dated at or past
 *              validBefore, at which the authorization is still unused. Without such a block, nothing is decided.
 *
 * Never throws: a chain that cannot be read is `unreadable`, and decides nothing.
 */
export async function findAuthorization(input: AuthorizationToFind, options: { rpcUrl?: string } & RpcOptions = {}): Promise<FoundPayment> {
  const network = evmNetworkFor(input.network);
  if (!network || !input.nonce || !/^0x[0-9a-fA-F]{64}$/.test(input.nonce) || !isAddress(input.payer) || !isAddress(input.recipient)) {
    return { found: false, reason: "this payment's signed authorization was not recorded, so it cannot be looked for" };
  }
  if (isHash(input.transaction)) {
    const named = await checkSettlement({ ...input, network: network.caip2 }, options);
    if (named.chain === "verified") return { found: true, transaction: input.transaction };
    if (named.included) return { found: true, transaction: input.transaction, final: false };
  }
  const rpc = options.rpcUrl ? { url: options.rpcUrl } : chainRpc(network);
  if ("error" in rpc) return { found: false, unreadable: true, reason: `the chain was not read: ${rpc.error}` };
  const unreadable: FoundPayment = { found: false, unreadable: true, reason: "the chain could not be read: the RPC did not give a usable answer" };
  try {
    const head = await blockAt(rpc.url, "latest", options);
    if (!head) return unreadable;
    const usedAt = async (block: bigint) =>
      decodeFunctionResult({
        abi: AUTHORIZATION_STATE_ABI,
        functionName: "authorizationState",
        data: (await rpcCall<string>(
          rpc.url,
          "eth_call",
          [{ to: network.usdc.address, data: encodeFunctionData({ abi: AUTHORIZATION_STATE_ABI, functionName: "authorizationState", args: [input.payer as `0x${string}`, input.nonce as `0x${string}`] }) }, hex(block)],
          options,
        )) as `0x${string}`,
      });
    if (!(await usedAt(head.number))) {
      const validBefore = Date.parse(input.validBefore ?? "") / 1000;
      if (!Number.isFinite(validBefore)) return { found: false, reason: "the chain shows the owner's authorization unused so far" };
      if (head.timestamp < validBefore) return { found: false, reason: `the chain shows the owner's authorization unused so far; it can still be used until ${iso(validBefore)}` };
      // Past validBefore by the latest block. "Never" is the word of a final block: one dated at or past validBefore,
      // at which the authorization is still unused. No block after it can be dated earlier, so none can use it.
      const final = await finalBlock(rpc.url, network, head, options);
      if (!final || final.timestamp < validBefore) {
        return { found: false, reason: `the chain shows the owner's authorization unused, and past its expiry at ${iso(validBefore)}, but no final block confirms that yet` };
      }
      if (await usedAt(final.number)) return unreadable;
      return {
        found: false,
        never: true,
        reason: `the chain shows the owner's authorization was never used, and it can no longer be: it expired at ${iso(validBefore)}, and the chain's final block is dated ${iso(final.timestamp)}`,
      };
    }
    // Used: by a transfer (this payment) or, never through this client, a cancellation. Its log names the transaction.
    // The final block is read before the logs, so a cancellation at or below it is one the chain has made final.
    const final = await finalBlock(rpc.url, network, head, options);
    /** Is this cancellation in the chain's final history, and still that block's? */
    const finalCancellation = async (log: { blockNumber?: string; blockHash?: string; removed?: boolean }): Promise<boolean> => {
      const at = typeof log.blockNumber === "string" && /^0x[0-9a-fA-F]+$/.test(log.blockNumber) ? BigInt(log.blockNumber) : undefined;
      if (!final || at === undefined || at > final.number || log.removed === true || !isHash(log.blockHash)) return false;
      const block = await blockAt(rpc.url, at, options);
      return !!block?.hash && same(block.hash, log.blockHash) && (await usedAt(final.number));
    };
    const since = Date.parse(input.since ?? "") / 1000;
    const start = Number.isFinite(since) ? await firstBlockFrom(rpc.url, since - SEARCH_MARGIN_S, head, network, options) : 0n;
    const window = BigInt(network.logRange);
    for (let from = start, i = 0; from <= head.number && i < MAX_LOG_WINDOWS; i += 1) {
      const to = from + window - 1n > head.number ? head.number : from + window - 1n;
      const logs = await rpcCall<{ topics?: string[]; transactionHash?: string; blockNumber?: string; blockHash?: string; removed?: boolean }[]>(
        rpc.url,
        "eth_getLogs",
        [{ address: network.usdc.address, fromBlock: hex(from), toBlock: hex(to), topics: [[AUTHORIZATION_USED_TOPIC, AUTHORIZATION_CANCELED_TOPIC], topicOf(input.payer), input.nonce.toLowerCase()] }],
        options,
      );
      for (const log of Array.isArray(logs) ? logs : []) {
        if (!same(log.topics?.[2], input.nonce) || !same(log.topics?.[1], topicOf(input.payer))) continue;
        if (same(log.topics?.[0], AUTHORIZATION_CANCELED_TOPIC)) {
          if (await finalCancellation(log)) {
            return { found: false, never: true, reason: "the chain shows the owner's authorization was cancelled, in a final block, so it can never be used" };
          }
          return { found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" };
        }
        if (!same(log.topics?.[0], AUTHORIZATION_USED_TOPIC) || !isHash(log.transactionHash)) continue;
        const check = await checkSettlement({ ...input, network: network.caip2, transaction: log.transactionHash }, options);
        if (check.chain === "verified") return { found: true, transaction: log.transactionHash };
        if (check.included) return { found: true, transaction: log.transactionHash, final: false };
        if (check.chain === "unchecked") return unreadable;
      }
      from = to + 1n;
    }
    return { found: false, reason: "the chain shows the owner's authorization was used, but its transaction was not found in the blocks searched" };
  } catch {
    return unreadable;
  }
}

/**
 * The newest block that can no longer change: the RPC's `finalized` block, or on a chain with instant finality the latest
 * one. Undefined when the RPC does not give one: nothing is decided on anything less.
 */
async function finalBlock(url: string, network: EvmNetwork, latest: Block, options: RpcOptions): Promise<Block | undefined> {
  if (network.finality === "instant") return latest;
  try {
    return await blockAt(url, "finalized", options);
  } catch {
    return undefined;
  }
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

async function blockAt(url: string, tag: bigint | "latest" | "finalized", options: RpcOptions): Promise<Block | undefined> {
  const block = await rpcCall<{ number?: string; timestamp?: string; hash?: string } | null>(url, "eth_getBlockByNumber", [typeof tag === "string" ? tag : hex(tag), false], options);
  if (!block || typeof block.number !== "string" || typeof block.timestamp !== "string") return undefined;
  return { number: BigInt(block.number), timestamp: Number(BigInt(block.timestamp)), ...(isHash(block.hash) ? { hash: block.hash } : {}) };
}

/**
 * The first block whose time is at or after `seconds`: a guess from the chain's usual block time, widened until it
 * brackets the time, then halved. Throws when a block cannot be read.
 */
async function firstBlockFrom(url: string, seconds: number, head: Block, network: EvmNetwork, options: RpcOptions): Promise<bigint> {
  if (head.timestamp < seconds) return head.number;
  const read = async (n: bigint) => {
    const block = await blockAt(url, n, options);
    if (!block) throw new Error("no block");
    return block;
  };
  let hi = head.number;
  let span = BigInt(Math.max(16, Math.ceil((head.timestamp - seconds) / network.blockSeconds)));
  let lo = hi > span ? hi - span : 0n;
  for (let i = 0; lo > 0n && i < 64; i += 1) {
    const at = await read(lo);
    if (at.timestamp < seconds) break;
    hi = lo;
    span *= 2n;
    lo = lo > span ? lo - span : 0n;
  }
  if ((await read(lo)).timestamp >= seconds) return lo;
  // timestamp(lo) < seconds <= timestamp(hi)
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await read(mid)).timestamp >= seconds) hi = mid;
    else lo = mid;
  }
  return hi;
}
