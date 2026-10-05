import { rpcCall, type RpcOptions } from "./rpc.js";

interface Inclusion {
  blockNumber?: unknown;
  blockHash?: unknown;
  logs?: { removed?: boolean }[];
}

const quantity = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Final head first, then canonical inclusion. Instant finality applies only to pinned SKALE and Tempo networks. */
export async function finalInclusion(url: string, receipt: Inclusion, finality: "finalized" | "instant", options: RpcOptions): Promise<boolean> {
  if (!quantity(receipt.blockNumber) || !hash(receipt.blockHash) || (receipt.logs !== undefined && (!Array.isArray(receipt.logs) || receipt.logs.some((log) => log?.removed === true)))) return false;
  try {
    const head = await rpcCall<{ number?: unknown } | null>(url, "eth_getBlockByNumber", [finality === "instant" ? "latest" : "finalized", false], options);
    if (!quantity(head?.number) || BigInt(head.number) < BigInt(receipt.blockNumber)) return false;
    const block = await rpcCall<{ number?: unknown; hash?: unknown } | null>(url, "eth_getBlockByNumber", [receipt.blockNumber, false], options);
    return quantity(block?.number) && BigInt(block.number) === BigInt(receipt.blockNumber) && hash(block?.hash) && block.hash.toLowerCase() === receipt.blockHash.toLowerCase();
  } catch {
    return false;
  }
}
