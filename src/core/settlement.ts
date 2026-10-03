// Reading a `pay` settlement back from the chain. The seller reports that its facilitator settled the payment and names
// a transaction; this reads that transaction's receipt from Base Sepolia and checks that it is this payment:
//
//   - the transaction succeeded;
//   - the USDC contract logged AuthorizationUsed(authorizer = the payer, nonce = the EIP-3009 nonce the owner signed);
//   - the USDC contract logged Transfer(from = the payer, to = the recipient the client checked, value = the amount signed).
//
// The nonce is what ties the transaction to this payment: an older transfer of the same amount to the same seller cannot
// carry it. Three answers:
//
//   verified    the receipt shows exactly that
//   mismatch    the receipt shows something else (another amount, recipient or nonce, or a failed transaction): the
//               payment is not confirmed, and whether money moved is unknown
//   unchecked   the chain could not say (no hash, no receipt yet, the RPC did not answer); the seller's word stands until
//               a later check
//
// The RPC is SUPERSTABLES_RPC_URL when it is https, or http on this computer, without credentials; https://sepolia.base.org
// otherwise, the same default as the budget's Base Sepolia rail. One request, under a short deadline, never redirected.

import { keccak256, toBytes } from "viem";
import { BASE_SEPOLIA, isAddress } from "./chain.js";
import { readCapped } from "./x402.js";

export type ChainState = "verified" | "mismatch" | "unchecked";
export interface ChainCheck {
  chain: ChainState;
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
}

const DEFAULT_RPC = "https://sepolia.base.org";
const CHECK_TIMEOUT_MS = 10_000;
const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The RPC a settlement is read through, or the reason the configured one is refused. */
export function settlementRpc(env: NodeJS.ProcessEnv = process.env): { url: string } | { error: string } {
  const value = env.SUPERSTABLES_RPC_URL?.trim();
  if (!value) return { url: DEFAULT_RPC };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "SUPERSTABLES_RPC_URL is not a URL" };
  }
  if (url.username || url.password) return { error: "SUPERSTABLES_RPC_URL carries a user name or password" };
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) return { url: value };
  return { error: "SUPERSTABLES_RPC_URL must be https, or http on this computer" };
}

const isHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
}

/** Read the transaction's receipt and say whether it is this payment. Never throws. */
export async function checkSettlement(
  input: SettlementToCheck,
  options: { rpcUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChainCheck> {
  if (!isHash(input.transaction)) return { chain: "unchecked", reason: "no transaction hash was given" };
  if (!input.nonce || !/^0x[0-9a-fA-F]{64}$/.test(input.nonce) || !isAddress(input.payer) || !isAddress(input.recipient)) {
    return { chain: "unchecked", reason: "this payment's signed authorization was not recorded, so it cannot be matched" };
  }
  const rpc = options.rpcUrl ? { url: options.rpcUrl } : settlementRpc();
  if ("error" in rpc) return { chain: "unchecked", reason: `the chain was not read: ${rpc.error}` };

  let receipt: { status?: string; transactionHash?: string; logs?: RpcLog[] } | null;
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
  if (receipt.status !== "0x1") return { chain: "mismatch", reason: "the transaction failed on chain" };

  const usdc = BASE_SEPOLIA.usdc.address;
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
  return { chain: "verified" };
}

async function rpcCall<T>(url: string, method: string, params: unknown[], options: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const res = await (options.fetchImpl ?? fetch)(url, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await readCapped(res, 2_000_000, timeoutMs, url);
  const answer = JSON.parse(text) as { result?: T; error?: unknown };
  if (answer.error !== undefined) throw new Error("the RPC answered with an error");
  return answer.result as T;
}
