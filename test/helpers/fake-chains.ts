// JSON-RPC stand-ins for Tempo Moderato and Solana devnet, for the hosted approval tests: just enough of each chain for the
// rail scripts to read what the owner's wallet sent (a transaction, its receipt, the keychain or the token account) after the
// site reports it. A test changes the chain by calling the helpers below, as the owner's wallet would. No network.
import type { IncomingMessage, ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { Abis, Addresses } from "viem/tempo";
import { readBody, startServer, type TestServer } from "./servers.js";

const json = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

// ── Tempo ────────────────────────────────────────────────────────────────────────────────────────────────

export const KEYCHAIN = Addresses.accountKeychain;
export const PATH_USD = "0x20C0000000000000000000000000000000000000";
type TempoKey = { expiry: bigint; limit: bigint; period: bigint; periodEnd: bigint; revoked: boolean; scoped: boolean };

export interface FakeTempo extends TestServer {
  head: { number: bigint; timestamp: number };
  /** Access keys by `${owner}:${key}` (lowercase). */
  keys: Map<string, TempoKey>;
  /** The owner's wallet sent `data` to the keychain: mine it in the next block, apply it to the keychain, return its hash. */
  mine(from: string, data: Hex): Hex;
}

export async function startFakeTempo(): Promise<FakeTempo> {
  const chain = {} as FakeTempo;
  chain.head = { number: 1000n, timestamp: Math.floor(Date.now() / 1000) };
  chain.keys = new Map();
  const txs = new Map<string, { from: string; input: Hex; block: bigint }>();
  const id = (owner: string, key: string) => `${owner.toLowerCase()}:${key.toLowerCase()}`;
  chain.mine = (from, data) => {
    chain.head = { number: chain.head.number + 1n, timestamp: chain.head.timestamp + 1 };
    const hash = `0x${(txs.size + 1).toString(16).padStart(64, "c")}` as Hex;
    txs.set(hash, { from, input: data, block: chain.head.number });
    const call = decodeFunctionData({ abi: Abis.accountKeychain, data });
    const args = call.args as unknown as any[];
    if (call.functionName === "authorizeKey") {
      const cfg = args[2];
      const lim = cfg.limits[0];
      chain.keys.set(id(from, args[0]), { expiry: BigInt(cfg.expiry), limit: BigInt(lim.amount), period: BigInt(lim.period), periodEnd: lim.period ? BigInt(chain.head.timestamp) + BigInt(lim.period) : 0n, revoked: false, scoped: !cfg.allowAnyCalls });
    }
    if (call.functionName === "revokeKey") {
      const k = chain.keys.get(id(from, args[0]));
      if (k) k.revoked = true;
    }
    return hash;
  };
  const keychain = (data: Hex): Hex => {
    const call = decodeFunctionData({ abi: Abis.accountKeychain, data });
    const a = call.args as unknown as any[];
    const k = chain.keys.get(id(a[0], a[1]));
    const out = (result: unknown) => encodeFunctionResult({ abi: Abis.accountKeychain, functionName: call.functionName as any, result: result as any });
    switch (call.functionName) {
      case "getKey": return out({ signatureType: 0, keyId: a[1], expiry: k?.expiry ?? 0n, enforceLimits: !!k, isRevoked: k?.revoked ?? false });
      case "getRemainingLimit": return out(k && !k.revoked ? k.limit : 0n);
      case "getRemainingLimitWithPeriod": return out([k && !k.revoked ? k.limit : 0n, k?.periodEnd ?? 0n]);
      case "getAllowedCalls": return out([k?.scoped ?? false, []]);
      case "isAdminKey": return out(false);
      default: throw new Error(`fake keychain: ${call.functionName}`);
    }
  };
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "eth_chainId": return hex(42431);
      case "eth_blockNumber": return hex(chain.head.number);
      case "eth_getBlockByNumber": {
        const n = params[0] === "latest" ? chain.head.number : BigInt(params[0]);
        return { number: hex(n), timestamp: hex(chain.head.timestamp - Number(chain.head.number - n)), hash: `0x${"ab".repeat(32)}`, transactions: [] };
      }
      case "eth_call": {
        const { to, data } = params[0];
        if (String(to).toLowerCase() === KEYCHAIN.toLowerCase()) return keychain(data);
        if (String(data).startsWith("0xed498fa8")) return `0x${"0".repeat(64)}`; // FeeManager: no fee token preference
        if (String(data).startsWith("0x70a08231")) return `0x${(1000n * 10n ** 6n).toString(16).padStart(64, "0")}`; // 1000 pathUSD
        return `0x${"0".repeat(64)}`;
      }
      case "eth_getTransactionByHash": {
        const t = txs.get(params[0]);
        return t ? { hash: params[0], from: t.from, to: KEYCHAIN, input: t.input, value: "0x0", chainId: hex(42431), type: "0x2", blockNumber: hex(t.block), nonce: "0x0", gas: "0x100000" } : null;
      }
      case "eth_getTransactionReceipt": {
        const t = txs.get(params[0]);
        return t ? { transactionHash: params[0], status: "0x1", blockNumber: hex(t.block), from: t.from, to: KEYCHAIN, logs: [], gasUsed: "0x1" } : null;
      }
      case "eth_getLogs": return [];
      default: return null;
    }
  };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse(await readBody(req));
    const one = (c: { id: number; method: string; params?: any[] }) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params ?? []) };
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: String((e as Error).message) } };
      }
    };
    json(res, Array.isArray(body) ? body.map(one) : one(body));
  });
  return Object.assign(chain, server);
}

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────────────

export const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const ataOf = (owner: string) => PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC_MINT.toBuffer()], ATA_PROGRAM)[0];

export interface FakeSolana extends TestServer {
  slot: number;
  /** Lamports by base58 address. */
  balances: Map<string, bigint>;
  /** The owner's USDC token account: amount, delegate and delegated amount. */
  usdc: Map<string, { amount: bigint; delegate: string | null; delegated: bigint }>;
  /**
   * The owner's wallet signed what the site built and the site sent it: land it in the next slot, apply it, and return its
   * signature. `signer` is signer 0 (the fee payer): the owner, unless a test says otherwise.
   */
  land(t: { kind: "grant" | "revoke" | "fund_agent"; owner: string; agent: string; amount?: bigint; signer?: string; slot?: number }): string;
}

export async function startFakeSolana(): Promise<FakeSolana> {
  const chain = {} as FakeSolana;
  chain.slot = 5000;
  chain.balances = new Map();
  chain.usdc = new Map();
  const txs = new Map<string, any>();
  chain.land = (t) => {
    chain.slot += 1;
    const slot = t.slot ?? chain.slot;
    const signer = t.signer ?? t.owner;
    const sig = bs58.encode(Buffer.alloc(64, txs.size + 1));
    const ata = ataOf(t.owner).toBase58();
    const acc = chain.usdc.get(t.owner) ?? { amount: 0n, delegate: null, delegated: 0n };
    let keys: string[];
    let pre: bigint[];
    let post: bigint[];
    if (t.kind === "fund_agent") {
      const had = chain.balances.get(t.agent) ?? 0n;
      chain.balances.set(t.agent, had + t.amount!);
      chain.balances.set(t.owner, (chain.balances.get(t.owner) ?? 0n) - t.amount! - 5000n);
      keys = [signer, t.agent, SYSTEM_PROGRAM];
      pre = [10n ** 9n, had, 1n];
      post = [10n ** 9n - t.amount! - 5000n, had + t.amount!, 1n];
    } else {
      if (t.kind === "grant") Object.assign(acc, { delegate: t.agent, delegated: t.amount! });
      else Object.assign(acc, { delegate: null, delegated: 0n });
      chain.usdc.set(t.owner, acc);
      keys = [signer, ata, ...(t.kind === "grant" ? [USDC_MINT.toBase58(), t.agent] : []), TOKEN_PROGRAM.toBase58()];
      pre = keys.map(() => 10n ** 9n);
      post = keys.map((_, i) => (i === 0 ? 10n ** 9n - 5000n : 10n ** 9n));
    }
    txs.set(sig, {
      slot,
      blockTime: Math.floor(Date.now() / 1000),
      version: "legacy",
      meta: { err: null, fee: 5000, preBalances: pre.map(Number), postBalances: post.map(Number), innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], rewards: [], status: { Ok: null }, loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: 1000 },
      transaction: {
        signatures: [sig],
        message: { accountKeys: keys, header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [{ programIdIndex: keys.length - 1, accounts: [0, 1], data: bs58.encode(Buffer.from([1])), stackHeight: null }], recentBlockhash: bs58.encode(Buffer.alloc(32, 9)) },
      },
    });
    return sig;
  };
  const tokenAccount = (owner: string) => {
    const a = chain.usdc.get(owner);
    if (!a) return null;
    const d = Buffer.alloc(165);
    USDC_MINT.toBuffer().copy(d, 0);
    new PublicKey(owner).toBuffer().copy(d, 32);
    d.writeBigUInt64LE(a.amount, 64);
    if (a.delegate) {
      d.writeUInt32LE(1, 72);
      new PublicKey(a.delegate).toBuffer().copy(d, 76);
    }
    d.writeUInt8(1, 108);
    d.writeBigUInt64LE(a.delegated, 121);
    return { data: [d.toString("base64"), "base64"], executable: false, lamports: 2039280, owner: TOKEN_PROGRAM.toBase58(), rentEpoch: 0, space: 165 };
  };
  const ctx = (value: unknown) => ({ context: { slot: chain.slot }, value });
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "getSlot": return chain.slot;
      case "getBlockHeight": return chain.slot;
      case "getBalance": return ctx(Number(chain.balances.get(params[0]) ?? 0n));
      case "getAccountInfo": {
        const owner = [...chain.usdc.keys()].find((o) => ataOf(o).toBase58() === params[0]);
        return ctx(owner ? tokenAccount(owner) : null);
      }
      case "getTransaction": return txs.get(params[0]) ?? null;
      case "getSignatureStatuses": return ctx(params[0].map((s: string) => (txs.has(s) ? { slot: txs.get(s).slot, confirmations: null, err: null, confirmationStatus: "confirmed" } : null)));
      case "getLatestBlockhash": return ctx({ blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: chain.slot + 150 });
      default: throw new Error(`fake solana: ${method}`);
    }
  };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse(await readBody(req));
    const one = (c: { id: number | string; method: string; params?: any[] }) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params ?? []) };
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: String((e as Error).message) } };
      }
    };
    json(res, Array.isArray(body) ? body.map(one) : one(body));
  });
  return Object.assign(chain, server);
}
