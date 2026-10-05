// A JSON-RPC stand-in for an EVM chain's USDC (Base Sepolia's by default), so the chain checks of `pay`
// (src/core/settlement.ts) run against a chain without the network: eth_getTransactionReceipt from a table a test fills
// in, and, for the search for an authorization nobody reported, blocks with times (eth_getBlockByNumber), the token's
// authorizationState (eth_call) and its AuthorizationUsed logs (eth_getLogs). A block's hash follows what is in it, so a
// test that replaces a block's transactions (a reorganisation) changes its hash. `paymentReceipt` builds the receipt a real
// EIP-3009 settlement of USDC leaves: AuthorizationUsed and Transfer, from the USDC contract; `settle` puts one on chain.
import { randomBytes } from "node:crypto";
import { decodeFunctionData, encodeFunctionResult, keccak256, toBytes } from "viem";
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
  /** The latest block. Block n is `secondsPerBlock` seconds after block n - 1. */
  head: { number: bigint; timestamp: number };
  secondsPerBlock: number;
  /** Authorizations the token consumed, by nonce (lowercase): the transaction and block that used them. */
  used: Map<string, { payer: string; transaction: string; block: bigint; token: string; cancelled?: boolean }>;
  /** What the facilitator does: settle this authorization in the next block. Returns the transaction's hash. */
  settle(authorization: { from: string; to: string; value: string | bigint; nonce: string; token?: string }): string;
  /** Let `seconds` pass on chain. */
  advance(seconds: number): void;
  /** How many blocks the finalized block is behind the head; undefined: the chain names no finalized block. */
  finalizedLag?: number;
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

const AUTHORIZATION_STATE_ABI = [
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;
const USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
const CANCELED_TOPIC = keccak256(toBytes("AuthorizationCanceled(address,bytes32)"));
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

export async function startFakeBaseSepolia(): Promise<FakeBaseSepolia> {
  const chain = {
    receipts: new Map<string, unknown>(),
    down: false,
    calls: 0,
    head: { number: 20_000_000n, timestamp: Math.floor(Date.now() / 1000) },
    secondsPerBlock: 2,
    used: new Map(),
    finalizedLag: 0,
  } as unknown as FakeBaseSepolia;
  const timeOf = (n: bigint) => chain.head.timestamp - Number(chain.head.number - n) * chain.secondsPerBlock;
  // A block's hash: its number and what the token did in it, on this chain.
  const salt = randomBytes(8).toString("hex");
  const hashOf = (n: bigint) => {
    const content = [...chain.used.values()].filter((u) => u.block === n).map((u) => `${u.transaction}:${u.cancelled ? "cancel" : "use"}`).sort();
    return keccak256(toBytes(`${salt}:${n}:${content.join(",")}`));
  };
  chain.advance = (seconds) => {
    const blocks = Math.max(1, Math.round(seconds / chain.secondsPerBlock));
    chain.head = { number: chain.head.number + BigInt(blocks), timestamp: chain.head.timestamp + blocks * chain.secondsPerBlock };
  };
  chain.settle = (a) => {
    chain.advance(chain.secondsPerBlock);
    const transaction = `0x${randomBytes(32).toString("hex")}`;
    const token = a.token ?? BASE_SEPOLIA.usdc.address;
    chain.used.set(a.nonce.toLowerCase(), { payer: a.from, transaction, block: chain.head.number, token });
    chain.receipts.set(transaction, { ...(paymentReceipt({ payer: a.from, to: a.to, value: a.value, nonce: a.nonce, token }) as object), blockNumber: hex(chain.head.number) });
    return transaction;
  };
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_getTransactionReceipt": {
        const hash = String(params[0] ?? "").toLowerCase();
        const found = chain.receipts.has(hash) ? chain.receipts.get(hash) : (chain.dynamic?.(hash) ?? null);
        // A real node's receipt names its transaction; a test that wants another (or none) sets transactionHash itself.
        return found && typeof found === "object" && !("transactionHash" in found) ? { transactionHash: hash, ...found } : found;
      }
      case "eth_getBlockByNumber": {
        if (params[0] === "finalized" && chain.finalizedLag === undefined) throw new Error("unknown block tag");
        const n = params[0] === "latest" ? chain.head.number : params[0] === "finalized" ? chain.head.number - BigInt(chain.finalizedLag!) : BigInt(params[0]);
        if (n > chain.head.number) return null;
        return { number: hex(n), hash: hashOf(n), timestamp: hex(timeOf(n)) };
      }
      case "eth_call": {
        const call = decodeFunctionData({ abi: AUTHORIZATION_STATE_ABI, data: params[0].data });
        const [, nonce] = call.args as [string, string];
        const at = params[1] === "latest" || params[1] === undefined ? chain.head.number : BigInt(params[1]);
        const used = chain.used.get(nonce.toLowerCase());
        return encodeFunctionResult({ abi: AUTHORIZATION_STATE_ABI, functionName: "authorizationState", result: !!used && used.block <= at });
      }
      case "eth_getLogs": {
        const q = params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
        const out = [];
        for (const [nonce, u] of chain.used) {
          if (u.block < BigInt(q.fromBlock) || u.block > BigInt(q.toBlock) || u.token.toLowerCase() !== q.address.toLowerCase()) continue;
          const log = { address: u.token, topics: [u.cancelled ? CANCELED_TOPIC : USED_TOPIC, topic(u.payer), nonce], data: "0x", transactionHash: u.transaction, blockNumber: hex(u.block), blockHash: hashOf(u.block), removed: false };
          const matches = q.topics.every((want, i) => want === null || (Array.isArray(want) ? want.map((w) => w.toLowerCase()) : [want.toLowerCase()]).includes(log.topics[i].toLowerCase()));
          if (matches) out.push(log);
        }
        return out;
      }
      default:
        throw new Error("not here");
    }
  };
  const server = await startServer(async (req, res) => {
    chain.calls += 1;
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: number; method?: string; params?: unknown[] };
    if (chain.down) {
      res.writeHead(503);
      res.end("down");
      return;
    }
    try {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: answer(String(body.method), body.params ?? []) });
    } catch (err) {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: (err as Error).message } });
    }
  });
  return Object.assign(chain, server);
}
