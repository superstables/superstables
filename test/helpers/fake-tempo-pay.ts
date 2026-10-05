// Stand-ins for a `pay` on Tempo Moderato, without the network: a JSON-RPC Tempo chain that knows pathUSD transfers the
// owner's wallet sends (receipts with TransferWithMemo logs, log searches by memo), and an MPP seller that answers 402
// with a tempo.charge challenge and accepts a credential naming a transfer the chain shows with the challenge's memo.
// The seller reads the credential with mppx's own parser, so a credential mppx would not take fails here too.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import { Challenge, Credential } from "mppx";
import { readBody, sendJson, startServer, type TestServer } from "./servers.js";

export const PATH_USD = "0x20C0000000000000000000000000000000000000";
const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
const topic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

const TRANSFER_WITH_MEMO_ABI = [
  { type: "function", name: "transferWithMemo", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }], outputs: [] },
] as const;

interface MinedTransfer {
  hash: Hex;
  from: string;
  to: string;
  amount: bigint;
  memo: Hex;
  token: string;
  block: bigint;
  reverted: boolean;
}

export interface FakeTempoPay extends TestServer {
  head: { number: bigint; timestamp: number };
  transfers: Map<string, MinedTransfer>;
  /** When true, every request answers HTTP 503. */
  down: boolean;
  /** When true, the latest block is answered null (a node that has none to give). */
  headless: boolean;
  calls: string[];
  /** The owner's wallet sent `call` (a transferWithMemo on `to`) from `from`: mine it, return its hash. */
  send(from: string, call: { to: string; data: string }, opts?: { reverted?: boolean; pending?: boolean }): Hex;
  /** A transfer mined directly, for tests that need one the wallet did not send through a page. */
  mine(transfer: Omit<MinedTransfer, "hash" | "block" | "reverted"> & { reverted?: boolean }): Hex;
  /** Mine a transaction left pending by send(..., { pending: true }). */
  confirm(hash: Hex): void;
}

export async function startFakeTempoPay(): Promise<FakeTempoPay> {
  const chain = { head: { number: 5_000_000n, timestamp: Math.floor(Date.now() / 1000) }, transfers: new Map(), down: false, calls: [] } as unknown as FakeTempoPay;
  const pending = new Map<string, MinedTransfer>();
  const record = (t: Omit<MinedTransfer, "hash" | "block" | "reverted"> & { reverted?: boolean }, hold = false): Hex => {
    chain.head = { number: chain.head.number + 1n, timestamp: chain.head.timestamp + 1 };
    const hash = `0x${randomBytes(32).toString("hex")}` as Hex;
    const mined: MinedTransfer = { ...t, hash, block: chain.head.number, reverted: t.reverted === true };
    (hold ? pending : chain.transfers).set(hash.toLowerCase(), mined);
    return hash;
  };
  chain.mine = (t) => record(t);
  chain.send = (from, call, opts = {}) => {
    const decoded = decodeFunctionData({ abi: TRANSFER_WITH_MEMO_ABI, data: call.data as Hex });
    const [to, amount, memo] = decoded.args as [string, bigint, Hex];
    return record({ from, to, amount, memo, token: call.to, reverted: opts.reverted }, opts.pending === true);
  };
  chain.confirm = (hash) => {
    const t = pending.get(hash.toLowerCase());
    if (!t) return;
    pending.delete(hash.toLowerCase());
    chain.transfers.set(hash.toLowerCase(), t);
  };
  const logsOf = (t: MinedTransfer) =>
    t.reverted
      ? []
      : [
          { address: t.token, topics: [TRANSFER_TOPIC, topic(t.from), topic(t.to)], data: word(t.amount), transactionHash: t.hash, blockNumber: hex(t.block) },
          { address: t.token, topics: [TRANSFER_WITH_MEMO_TOPIC, topic(t.from), topic(t.to), t.memo], data: word(t.amount), transactionHash: t.hash, blockNumber: hex(t.block) },
        ];
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return hex(42431);
      case "eth_getBlockByNumber": {
        if (params[0] === "latest" && chain.headless) return null;
        const n = params[0] === "latest" ? chain.head.number : BigInt(params[0]);
        return { number: hex(n), timestamp: hex(chain.head.timestamp - Number(chain.head.number - n)) };
      }
      case "eth_getTransactionReceipt": {
        const t = chain.transfers.get(String(params[0]).toLowerCase());
        return t ? { transactionHash: t.hash, status: t.reverted ? "0x0" : "0x1", blockNumber: hex(t.block), from: t.from, logs: logsOf(t) } : null;
      }
      case "eth_getLogs": {
        const q = params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | null)[] };
        const out = [];
        for (const t of chain.transfers.values()) {
          if (t.block < BigInt(q.fromBlock) || t.block > BigInt(q.toBlock)) continue;
          for (const log of logsOf(t)) {
            if (log.address.toLowerCase() !== q.address.toLowerCase()) continue;
            if (q.topics.every((want, i) => want === null || (log.topics[i] ?? "").toLowerCase() === want.toLowerCase())) out.push(log);
          }
        }
        return out;
      }
      default:
        throw new Error(`fake tempo: ${method}`);
    }
  };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse((await readBody(req)) || "{}") as { id?: number; method: string; params?: any[] };
    chain.calls.push(body.method);
    if (chain.down) {
      res.writeHead(503);
      res.end("down");
      return;
    }
    try {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params ?? []) });
    } catch (err) {
      sendJson(res, 200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: String((err as Error).message) } });
    }
  });
  return Object.assign(chain, server);
}

/** The memo mppx's own client puts on a payment for this challenge (Attribution.encode, no client id). */
export function memoFor(challengeId: string, realm: string): Hex {
  const buf = new Uint8Array(32);
  buf.set(toBytes(keccak256(toBytes("mpp"))).slice(0, 4), 0);
  buf[4] = 1;
  buf.set(toBytes(keccak256(toBytes(realm))).slice(0, 10), 5);
  buf.set(toBytes(keccak256(toBytes(challengeId))).slice(0, 7), 25);
  return `0x${Buffer.from(buf).toString("hex")}` as Hex;
}

export interface MppSellerOptions {
  /** pathUSD atomic units. */
  amount?: string;
  recipient: string;
  /** Seconds until the challenge expires. */
  expiresIn?: number;
  /** Change the challenge's request, e.g. to ask for something this client refuses. */
  request?: (request: Record<string, unknown>) => Record<string, unknown>;
  /** Replace the whole WWW-Authenticate value. */
  wwwAuthenticate?: () => string;
  /** Hand out this challenge id every time (a seller that reuses or caches its challenge), instead of a fresh one. */
  challengeId?: string;
}

export interface FakeMppSeller extends TestServer {
  /** Paid requests the seller accepted, with the credential it read. */
  paid: { hash: string; source?: string }[];
  /** Every credential the seller received, accepted or not. */
  credentials: string[];
  /** The challenges it issued, newest last. */
  issued: { id: string; realm: string; expires: string }[];
  /** When set, the paid request answers this status instead of 200. */
  failWith?: number;
}

/** An MPP seller of one resource, priced in pathUSD on Tempo Moderato, checking payments on `chain`. */
export async function startFakeMppSeller(chain: FakeTempoPay, options: MppSellerOptions): Promise<FakeMppSeller> {
  const seller = { paid: [], credentials: [], issued: [] } as unknown as FakeMppSeller;
  const amount = options.amount ?? "10000";
  const server = await startServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth) {
      seller.credentials.push(auth);
      let credential;
      try {
        credential = Credential.deserialize(auth);
      } catch {
        sendJson(res, 402, { error: "malformed credential" });
        return;
      }
      const issued = seller.issued.find((c) => c.id === credential.challenge.id);
      const payload = credential.payload as { type?: string; hash?: string };
      const transfer = payload.hash ? chain.transfers.get(payload.hash.toLowerCase()) : undefined;
      const ok =
        issued &&
        Date.parse(issued.expires) > Date.now() &&
        payload.type === "hash" &&
        transfer &&
        !transfer.reverted &&
        transfer.memo.toLowerCase() === memoFor(issued.id, issued.realm).toLowerCase() &&
        transfer.amount === BigInt(amount) &&
        transfer.to.toLowerCase() === options.recipient.toLowerCase() &&
        transfer.token.toLowerCase() === PATH_USD.toLowerCase() &&
        !seller.paid.some((p) => p.hash === payload.hash);
      if (!ok) {
        sendJson(res, 402, { error: "payment verification failed" });
        return;
      }
      seller.paid.push({ hash: payload.hash!, source: credential.source });
      const receipt = Buffer.from(JSON.stringify({ method: "tempo", reference: payload.hash, status: "success", timestamp: new Date().toISOString() })).toString("base64url");
      res.writeHead(seller.failWith ?? 200, { "content-type": "application/json", "payment-receipt": receipt });
      res.end(JSON.stringify({ answer: 42 }));
      return;
    }
    const id = options.challengeId ?? randomBytes(16).toString("base64url");
    const realm = "seller.example";
    const expires = new Date(Date.now() + (options.expiresIn ?? 300) * 1000).toISOString();
    seller.issued.push({ id, realm, expires });
    const base: Record<string, unknown> = { amount, currency: PATH_USD, recipient: options.recipient, methodDetails: { chainId: 42431, supportedModes: ["push", "pull"] } };
    const request = options.request ? options.request(base) : base;
    const header = options.wwwAuthenticate
      ? options.wwwAuthenticate()
      : Challenge.serialize(Challenge.from({ id, realm, method: "tempo", intent: "charge", request, expires, description: "One answer" }));
    res.writeHead(402, { "content-type": "application/json", "www-authenticate": header });
    res.end(JSON.stringify({ error: "payment required" }));
  });
  return Object.assign(seller, server);
}
