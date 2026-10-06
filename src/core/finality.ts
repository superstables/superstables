import { rpcCall, type RpcOptions } from "./rpc.js";

interface Inclusion {
  blockNumber?: unknown;
  blockHash?: unknown;
  logs?: { removed?: boolean }[];
}

const quantity = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Canonical inclusion permits delivery; only final inclusion permits a permanent paid record. */
export async function inclusion(url: string, receipt: Inclusion, finality: "finalized" | "instant", options: RpcOptions): Promise<"final" | "included" | "removed" | "unread"> {
  if (!quantity(receipt.blockNumber) || !hash(receipt.blockHash) || (receipt.logs !== undefined && !Array.isArray(receipt.logs))) return "unread";
  if (receipt.logs?.some((log) => log?.removed === true)) return "removed";
  try {
    const head = await rpcCall<{ number?: unknown } | null>(url, "eth_getBlockByNumber", [finality === "instant" ? "latest" : "finalized", false], options).catch(() => null);
    const block = await rpcCall<{ number?: unknown; hash?: unknown } | null>(url, "eth_getBlockByNumber", [receipt.blockNumber, false], options);
    if (!quantity(block?.number) || BigInt(block.number) !== BigInt(receipt.blockNumber) || !hash(block?.hash)) return "unread";
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return "removed";
    return quantity(head?.number) && BigInt(head.number) >= BigInt(receipt.blockNumber) ? "final" : "included";
  } catch {
    return "unread";
  }
}

export async function finalInclusion(url: string, receipt: Inclusion, finality: "finalized" | "instant", options: RpcOptions): Promise<boolean> {
  return await inclusion(url, receipt, finality, options) === "final";
}
