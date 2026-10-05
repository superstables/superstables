// Solana devnet and an x402 seller on it, for `pay` on Solana: a JSON-RPC stand-in with just
// the calls the rail and its wallet step make (getGenesisHash, getLatestBlockhash, getBlockHeight, getEpochInfo,
// getTransaction, getSignaturesForAddress, getBlocksWithLimit, getBlock), and a
// seller that answers 402 with an exact SVM offer, takes the signed transaction, "settles" it the way a facilitator does
// (adds the fee payer's signature and lands it on the fake chain) and answers. An owner wallet that signs with a real
// ed25519 key. No network; @solana/web3.js is used here only to read what the client built.

import { generateKeyPairSync, randomBytes, sign as ed25519Sign, type KeyObject } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SOLANA_DEVNET } from "../../src/core/chain.js";
import { readBody, startServer, type TestServer } from "./servers.js";

export const MINT = SOLANA_DEVNET.token.address;
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** The other cluster's genesis (Solana mainnet): what an RPC on the wrong cluster answers. */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SolanaKey {
  address: string;
  sign(message: Uint8Array): Uint8Array;
}

/** A throwaway ed25519 key, as a Solana wallet holds one. */
export function solanaKey(): SolanaKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  return {
    address: bs58.encode(Buffer.from(x, "base64url")),
    sign: (message) => new Uint8Array(ed25519Sign(null, message, privateKey as KeyObject)),
  };
}

/** A random address (no key behind it). */
export const randomAddress = (): string => bs58.encode(randomBytes(32));

/** The owner's wallet signs the transaction it was given, in its own slot only: what solana:signTransaction returns. */
export function signAsOwner(transactionBase64: string, owner: SolanaKey): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  const index = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === owner.address);
  if (index < 0) throw new Error("the owner does not sign this transaction");
  tx.signatures[index] = owner.sign(tx.message.serialize());
  return Buffer.from(tx.serialize()).toString("base64");
}

// ── The chain ────────────────────────────────────────────────────────────────────────────────────────────────

/** A confirmed transaction in getTransaction's json shape. */
export interface RpcTx {
  slot: number;
  blockTime: number;
  meta: { err: unknown; fee: number; loadedAddresses: { writable: string[]; readonly: string[] } };
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      recentBlockhash: string;
      instructions: { programIdIndex: number; accounts: number[]; data: string; stackHeight: null }[];
    };
  };
}

export interface FakeSolanaDevnet extends TestServer {
  genesis: string;
  height: number;
  /** Every call, by method. */
  calls: string[];
  /** Answer every call with an RPC error. */
  down: boolean;
  /** Transactions this node lists but answers null for. */
  unreadable: Set<string>;
  /** Slots missing from this node's ledger (a node restarted from a newer snapshot): their blocks and transactions. */
  missingSlots: Set<number>;
  /** Slots this node lists among its blocks but fails to serve. */
  blockFails: Set<number>;
  /**
   * Slots whose block holds a version 1 transaction, as devnet's do: a read asking for less than version 1 is refused,
   * with devnet's own error.
   */
  versionOneSlots: Set<number>;
  /** The slot this node has reached, when it lags the cluster (a request with a higher minContextSlot is refused). */
  contextSlot?: number;
  /** The last slot getBlocksWithLimit lists (a node whose finalized view stops there). */
  blocksUpTo?: number;
  /**
   * Calls of a method this node limits, as the public devnet RPC limits getBlock: from call `after` + 1 of that method on,
   * `times` calls are answered HTTP 429 "too many requests", with Retry-After `retryAfter` seconds when it is given.
   */
  limit?: { method: string; after: number; times: number; retryAfter?: number };
  /** Methods this node does not serve. */
  refuses: Set<string>;
  /** Called before each call is answered, with how many calls of that method there have been: lets a test change the node mid-search. */
  onCall?: (method: string, n: number) => void;
  txs: Map<string, RpcTx>;
  /**
   * The facilitator's part: add the fee payer's signature to what the owner signed and land it. Returns the transaction
   * id (the fee payer's signature). `err` lands it failed; `edit` changes what the chain shows (a lying RPC, a test of
   * the check).
   */
  land(signedBase64: string, opts?: { err?: unknown; edit?: (tx: RpcTx) => void }): string;
}

export async function startFakeDevnet(): Promise<FakeSolanaDevnet> {
  const chain = { genesis: SOLANA_DEVNET.genesisHash, height: 300_000, calls: [] as string[], down: false, txs: new Map<string, RpcTx>(), unreadable: new Set<string>(), missingSlots: new Set<number>(), blockFails: new Set<number>(), versionOneSlots: new Set<number>(), refuses: new Set<string>() } as FakeSolanaDevnet;
  const counts = new Map<string, number>();
  // Every block height h has its block at slot h + 10 here, as skipped slots put slots ahead of heights on a real cluster.
  const slotOf = (h: number) => h + 10;
  const blockhash = bs58.encode(randomBytes(32));
  chain.land = (signedBase64, opts = {}) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(signedBase64, "base64"));
    const feePayerSignature = randomBytes(64);
    const signatures = tx.signatures.map((s, i) => bs58.encode(i === 0 ? feePayerSignature : Buffer.from(s)));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    chain.height += 1;
    const landed: RpcTx = {
      slot: chain.height + 10,
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: opts.err ?? null, fee: 5000, loadedAddresses: { writable: [], readonly: [] } },
      transaction: {
        signatures,
        message: {
          accountKeys: keys,
          header: tx.message.header,
          recentBlockhash: tx.message.recentBlockhash,
          instructions: tx.message.compiledInstructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accounts: [...ix.accountKeyIndexes],
            data: bs58.encode(Buffer.from(ix.data)),
            stackHeight: null,
          })),
        },
      },
    };
    opts.edit?.(landed);
    chain.txs.set(signatures[0], landed);
    return signatures[0];
  };
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "getGenesisHash":
        return chain.genesis;
      case "getLatestBlockhash":
        return { context: { slot: chain.height + 10 }, value: { blockhash, lastValidBlockHeight: chain.height + 150 } };
      case "getBlockHeight":
        return chain.height;
      case "getEpochInfo":
        return { absoluteSlot: slotOf(chain.height), blockHeight: chain.height, epoch: 800, slotIndex: 0, slotsInEpoch: 432000 };
      case "getBlocksWithLimit": {
        const [start, limit] = params as [number, number];
        const out: number[] = [];
        const top = Math.min(slotOf(chain.height), chain.blocksUpTo ?? Number.POSITIVE_INFINITY);
        for (let slot = Math.max(start, slotOf(0)); slot <= top && out.length < limit; slot += 1) if (!chain.missingSlots.has(slot)) out.push(slot);
        return out;
      }
      case "getBlock": {
        const slot = params[0] as number;
        if (slot > slotOf(chain.height) || chain.missingSlots.has(slot) || chain.blockFails.has(slot)) throw new Error("Block not available for slot");
        if (chain.versionOneSlots.has(slot) && !((params[1]?.maxSupportedTransactionVersion ?? -1) >= 1)) {
          throw new Error('Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1');
        }
        const block: Record<string, unknown> = { blockHeight: slot - 10, blockTime: Math.floor(Date.now() / 1000), parentSlot: slot - 1, blockhash: bs58.encode(randomBytes(32)) };
        const details = params[1]?.transactionDetails ?? "full";
        // "accounts": every transaction with all of its signatures (its id first) and its accounts, as a node answers it.
        if (details === "accounts" || details === "full") {
          block.transactions = [...chain.txs.values()]
            .filter((tx) => tx.slot === slot)
            .map((tx) => ({ transaction: { signatures: tx.transaction.signatures, accountKeys: tx.transaction.message.accountKeys.map((pubkey) => ({ pubkey })) }, meta: { err: tx.meta.err } }));
        }
        // "signatures": each transaction's id only, its first signature.
        if (details === "signatures") block.signatures = [...chain.txs.values()].filter((tx) => tx.slot === slot).map((tx) => tx.transaction.signatures[0]);
        return block;
      }
      case "getTransaction":
        return chain.unreadable.has(params[0]) || chain.missingSlots.has(chain.txs.get(params[0])?.slot ?? -1) ? null : (chain.txs.get(params[0]) ?? null);
      case "getSignaturesForAddress": {
        if (chain.contextSlot !== undefined && params[1]?.minContextSlot > chain.contextSlot) throw new Error("Minimum context slot has not been reached");
        const limit = params[1]?.limit ?? 1000;
        const all = [...chain.txs.entries()].filter(([, tx]) => tx.transaction.message.accountKeys.includes(params[0]) && !chain.missingSlots.has(tx.slot)).reverse();
        // newest first; `before` starts the page after that signature, as the RPC does
        const from = params[1]?.before ? all.findIndex(([signature]) => signature === params[1].before) + 1 : 0;
        return all
          .slice(from)
          .slice(0, limit)
          .map(([signature, tx]) => ({ signature, slot: tx.slot, blockTime: tx.blockTime, err: tx.meta.err, memo: null, confirmationStatus: "confirmed" }));
      }
      default:
        throw new Error(`fake devnet: ${method}`);
    }
  };
  const one = (call: { id: number; method: string; params?: any[] }) => {
    chain.calls.push(call.method);
    const n = (counts.get(call.method) ?? 0) + 1;
    counts.set(call.method, n);
    chain.onCall?.(call.method, n);
    if (chain.down) return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "node is down" } };
    if (chain.refuses.has(call.method)) return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "Method not found" } };
    try {
      return { jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params ?? []) };
    } catch (e) {
      return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: (e as Error).message } };
    }
  };
  // Calls of the limited method since the limit was set: every one counts, the refused ones too, as devnet counts them.
  let limiting: { limit?: FakeSolanaDevnet["limit"]; n: number } = { n: 0 };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse(await readBody(req)) as { id: number; method: string; params?: any[] };
    const limit = chain.limit;
    if (limit && body.method === limit.method) {
      if (limiting.limit !== limit) limiting = { limit, n: 0 };
      const n = (limiting.n += 1);
      if (n > limit.after && n <= limit.after + limit.times) {
        chain.calls.push(`${body.method} (limited)`);
        res.writeHead(429, { "content-type": "application/json", ...(limit.retryAfter !== undefined ? { "retry-after": String(limit.retryAfter) } : {}) });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 429, message: "Too many requests for a specific RPC call" } }));
        return;
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(one(body)));
  });
  return Object.assign(chain, server);
}

// ── The seller ───────────────────────────────────────────────────────────────────────────────────────────────

export type SolanaSellerBehaviour =
  /** Lands the payment and answers 200 with PAYMENT-RESPONSE. */
  | "ok"
  /** Lands the payment, then the connection breaks before any answer. */
  | "drop-after-landing"
  /** The connection breaks before anything is landed. */
  | "drop-before-landing"
  /** Lands the payment and answers 200 without PAYMENT-RESPONSE. */
  | "no-payment-response"
  /** Lands the payment, but names another transaction in PAYMENT-RESPONSE. */
  | "names-another-transaction"
  /** Lands the payment, then answers 402 without PAYMENT-RESPONSE, as if it wanted to be paid again. */
  | "land-then-402"
  /** Lands the payment, then answers 402 with a PAYMENT-RESPONSE saying it did not settle, and no transaction. */
  | "land-then-did-not-settle"
  /** Lands nothing and answers 402 with a PAYMENT-RESPONSE saying it did not settle (the signed transaction may land later). */
  | "did-not-settle"
  /** Lands nothing, and answers 200 with a PAYMENT-RESPONSE claiming success with no transaction. */
  | "claims-success";

export interface SolanaSeller extends TestServer {
  /** The signed transaction in the last credential: what a facilitator could still land. */
  lastTransaction(): string;
  /** The paid resource. */
  resource: string;
  payTo: string;
  feePayer: string;
  /** The accept the 402 offers; a test may change it. */
  accept: Record<string, unknown>;
  /** The x402Version the 402 names (2); a test may change it, or delete it. */
  version?: unknown;
  hits: { challenges: number; paid: number };
  /** The last credential, decoded. */
  lastPayment?: Record<string, unknown>;
  /** The transaction it landed for the last payment. */
  landed?: string;
  /** Name this transaction in PAYMENT-RESPONSE instead of the one it landed (a seller that names someone else's). */
  names?: string;
}

export async function startSolanaSeller(chain: FakeSolanaDevnet, options: { amountAtomic?: string; behaviour?: SolanaSellerBehaviour } = {}): Promise<SolanaSeller> {
  const behaviour = options.behaviour ?? "ok";
  const seller = {
    payTo: randomAddress(),
    feePayer: randomAddress(),
    hits: { challenges: 0, paid: 0 },
    version: 2,
  } as SolanaSeller;
  seller.accept = {
    scheme: "exact",
    network: SOLANA_DEVNET.caip2,
    amount: options.amountAtomic ?? "10000",
    asset: MINT,
    payTo: seller.payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: seller.feePayer },
  };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const header = req.headers["payment-signature"];
    const resource = `http://${req.headers.host}${req.url}`;
    if (typeof header !== "string") {
      seller.hits.challenges += 1;
      const body = { ...("version" in seller ? { x402Version: seller.version } : {}), error: "Payment required", resource: { url: resource, description: "test Solana service", mimeType: "application/json" }, accepts: [seller.accept] };
      res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(body)).toString("base64") });
      res.end(JSON.stringify(body));
      return;
    }
    const payment = decodePaymentSignatureHeader(header) as unknown as Record<string, unknown>;
    seller.lastPayment = payment;
    if (behaviour === "drop-before-landing") {
      req.socket.destroy();
      return;
    }
    if (behaviour === "did-not-settle" || behaviour === "claims-success") {
      const said = encodePaymentResponseHeader(
        behaviour === "did-not-settle"
          ? ({ success: false, errorReason: "transaction_failed", transaction: "", network: SOLANA_DEVNET.caip2 } as never)
          : ({ success: true, transaction: "", network: SOLANA_DEVNET.caip2, payer: "someone" } as never),
      );
      res.writeHead(behaviour === "did-not-settle" ? 402 : 200, { "content-type": "application/json", "payment-response": said });
      res.end(JSON.stringify(behaviour === "did-not-settle" ? { error: "not settled" } : { ok: true, answer: "the paid answer" }));
      return;
    }
    const transaction = String((payment.payload as { transaction?: unknown }).transaction);
    // The facilitator signs as fee payer: its slot must be the empty one at 0.
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    if (tx.message.staticAccountKeys[0].toBase58() !== seller.feePayer || tx.signatures[0].some((b) => b !== 0)) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the fee payer is not ours" }));
      return;
    }
    const landed = chain.land(transaction);
    seller.landed = landed;
    seller.hits.paid += 1;
    if (behaviour === "drop-after-landing") {
      req.socket.destroy();
      return;
    }
    if (behaviour === "land-then-402") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payment required" }));
      return;
    }
    if (behaviour === "land-then-did-not-settle") {
      const said = encodePaymentResponseHeader({ success: false, errorReason: "unexpected_error", transaction: "", network: SOLANA_DEVNET.caip2 } as never);
      res.writeHead(402, { "content-type": "application/json", "payment-response": said });
      res.end(JSON.stringify({ error: "not settled" }));
      return;
    }
    const named = seller.names ?? (behaviour === "names-another-transaction" ? bs58.encode(randomBytes(64)) : landed);
    const receipt = encodePaymentResponseHeader({ success: true, transaction: named, network: SOLANA_DEVNET.caip2 as never, payer: "someone" });
    res.writeHead(200, { "content-type": "application/json", ...(behaviour === "no-payment-response" ? {} : { "payment-response": receipt }) });
    res.end(JSON.stringify({ ok: true, answer: "the paid answer" }));
  });
  seller.resource = `${server.url}/paid`;
  seller.lastTransaction = () => String(((seller.lastPayment?.payload ?? {}) as { transaction?: unknown }).transaction);
  return Object.assign(seller, server);
}
