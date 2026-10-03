// A JSON-RPC stand-in for Base Sepolia: just eth_getTransactionReceipt, from a table a test fills in, so the chain check
// on `pay` (src/core/settlement.ts) runs against a chain without the network. `paymentReceipt` builds the receipt a real
// EIP-3009 settlement of USDC leaves: AuthorizationUsed and Transfer, from the USDC contract.
import { keccak256, toBytes } from "viem";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
import { readBody, sendJson, startServer, type TestServer } from "./servers.js";

export interface FakeBaseSepolia extends TestServer {
  /** Receipts by transaction hash (lowercase). A hash missing here answers null: not mined (yet). */
  receipts: Map<string, unknown>;
  /** When true, every request answers HTTP 503. */
  down: boolean;
  /** When set, a receipt for any hash missing from `receipts`, built at request time. */
  dynamic?: (hash: string) => unknown;
  calls: number;
}

const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

export function paymentReceipt(input: {
  /** The transaction the receipt is for; the RPC answer for a hash missing it gets that hash filled in. */
  transactionHash?: string;
  payer: string;
  to: string;
  value: string | bigint;
  nonce: string;
  status?: "0x1" | "0x0";
  token?: string;
}): unknown {
  const token = input.token ?? BASE_SEPOLIA.usdc.address;
  return {
    ...(input.transactionHash ? { transactionHash: input.transactionHash } : {}),
    status: input.status ?? "0x1",
    blockNumber: "0x10",
    logs: [
      { address: token, topics: [keccak256(toBytes("AuthorizationUsed(address,bytes32)")), topic(input.payer), input.nonce], data: "0x" },
      {
        address: token,
        topics: [keccak256(toBytes("Transfer(address,address,uint256)")), topic(input.payer), topic(input.to)],
        data: `0x${BigInt(input.value).toString(16).padStart(64, "0")}`,
      },
    ],
  };
}

export async function startFakeBaseSepolia(): Promise<FakeBaseSepolia> {
  const chain = { receipts: new Map<string, unknown>(), down: false, calls: 0 } as FakeBaseSepolia;
  const server = await startServer(async (req, res) => {
    chain.calls += 1;
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: number; method?: string; params?: unknown[] };
    if (chain.down) {
      res.writeHead(503);
      res.end("down");
      return;
    }
    if (body.method !== "eth_getTransactionReceipt") {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not here" } });
      return;
    }
    const hash = String(body.params?.[0] ?? "").toLowerCase();
    const found = chain.receipts.has(hash) ? chain.receipts.get(hash) : (chain.dynamic?.(hash) ?? null);
    // A real node's receipt names its transaction; a test that wants another (or none) sets transactionHash itself.
    const result = found && typeof found === "object" && !("transactionHash" in found) ? { transactionHash: hash, ...found } : found;
    sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result });
  });
  return Object.assign(chain, server);
}
