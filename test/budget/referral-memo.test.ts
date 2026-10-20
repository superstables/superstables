// A referred budget buy on Solana and Tempo: the operation freezes the seller's referral when it starts, the payment's
// memo names it, and only the paid request carries the referral's token, with the operation id as the purchase
// reference. The Solana buy runs as the dispatcher runs it, under node alone, against a local seller and a local
// stand-in for devnet.

import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { Challenge, Credential } from "mppx";
import { keccak256, toBytes, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { tempoClientId } from "../../src/core/referral-memo.mjs";
import { endpointTree } from "../helpers/endpoint-tree.js";
import { PATH_USD, startFakeTempo } from "../helpers/fake-chains.js";
import { referralKey, signReferral } from "../helpers/referrals.js";

const hexOf = (n: bigint) => toHex(n);
const REPO = join(import.meta.dirname, "..", "..");
const BUY = join(REPO, "budget", "solana", "buy.mjs");
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const ID = "ref_AAECAwQFBgcICQoLDA0ODw";
const OTHER_ID = "ref_AAAAAAAAAAAAAAAAAAAAAA";

const ataOf = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(MINT).toBuffer()], ATA_PROGRAM)[0];

const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const body = (req: import("node:http").IncomingMessage) => new Promise<string>((resolve) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => resolve(text));
});

/** Just enough of devnet for one buy: the mint, the owner's account delegated to the agent, and the landed payment. */
async function devnet(owner: PublicKey, agent: PublicKey, landed: { sig: string; agentSig?: string }): Promise<string> {
  const account = (o: PublicKey, delegate?: PublicKey) => {
    const d = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(d, 0);
    o.toBuffer().copy(d, 32);
    d.writeBigUInt64LE(5_000_000n, 64);
    if (delegate) {
      d.writeUInt32LE(1, 72);
      delegate.toBuffer().copy(d, 76);
      d.writeBigUInt64LE(1_000_000n, 121);
    }
    d.writeUInt8(1, 108);
    return d;
  };
  const mint = Buffer.alloc(82);
  mint.writeUInt8(6, 44);
  mint.writeUInt8(1, 45);
  const info = (d: Buffer) => ({ data: [d.toString("base64"), "base64"], executable: false, lamports: 2039280, owner: TOKEN_PROGRAM, rentEpoch: 0, space: d.length });
  const ctx = (value: unknown) => ({ context: { slot: 5000 }, value });
  const answer = (method: string, params: any[]): unknown => {
    switch (method) {
      case "getAccountInfo":
        if (params[0] === MINT) return ctx(info(mint));
        if (params[0] === ataOf(owner).toBase58()) return ctx(info(account(owner, agent)));
        return ctx(null);
      case "getGenesisHash": return "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
      case "getLatestBlockhash": return ctx({ blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: 5150 });
      case "getSignatureStatuses": return ctx(params[0].map((s: string) => (s === landed.sig ? { slot: 5001, confirmations: null, err: null, confirmationStatus: "finalized" } : null)));
      case "getTransaction":
        if (params[0] !== landed.sig || params[1]?.encoding === "jsonParsed") return null;
        return {
          slot: 5001, blockTime: Math.floor(Date.now() / 1000), version: "legacy",
          meta: { err: null, fee: 5000, preBalances: [0, 0], postBalances: [0, 0], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], rewards: [], status: { Ok: null }, loadedAddresses: { writable: [], readonly: [] }, computeUnitsConsumed: 1000 },
          transaction: {
            signatures: [landed.sig, landed.agentSig],
            message: { accountKeys: [Keypair.generate().publicKey.toBase58(), agent.toBase58()], header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [], recentBlockhash: bs58.encode(Buffer.alloc(32, 9)) },
          },
        };
      default: throw new Error(`fake devnet: ${method}`);
    }
  };
  return listen(async (req, res) => {
    const call = JSON.parse(await body(req));
    const one = (c: { id: number; method: string; params?: any[] }) => {
      try {
        return { jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params ?? []) };
      } catch (e) {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: String((e as Error).message) } };
      }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(call) ? call.map(one) : one(call)));
  });
}

interface Sale { headers: IncomingHttpHeaders; memo: string; agentSig: string }

/** A Solana devnet seller asking 0.01 USDC through a facilitator that pays the fee; it settles every payment as `landed.sig`. */
async function seller(landed: { sig: string; agentSig?: string }, agent: PublicKey): Promise<{ url: string; unpaid: IncomingHttpHeaders[]; sales: Sale[] }> {
  const unpaid: IncomingHttpHeaders[] = [];
  const sales: Sale[] = [];
  const accept = { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", amount: "10000", asset: MINT, payTo: Keypair.generate().publicKey.toBase58(), maxTimeoutSeconds: 60, extra: { feePayer: Keypair.generate().publicKey.toBase58() } };
  const url = await listen((req, res) => {
    const paid = req.headers["payment-signature"];
    if (typeof paid !== "string") {
      unpaid.push({ ...req.headers });
      const challenge = { x402Version: 2, error: "payment required", resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [accept] };
      res.writeHead(402, { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") }).end();
      return;
    }
    const payload = JSON.parse(Buffer.from(paid, "base64").toString("utf8"));
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    const memo = tx.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === MEMO_PROGRAM)!;
    const agentSig = bs58.encode(tx.signatures[keys.indexOf(agent.toBase58())]!);
    landed.agentSig = agentSig;
    sales.push({ headers: { ...req.headers }, memo: Buffer.from(memo.data).toString("utf8"), agentSig });
    const response = Buffer.from(JSON.stringify({ success: true, transaction: landed.sig, network: accept.network })).toString("base64");
    res.writeHead(200, { "content-type": "application/json", "payment-response": response }).end("{}");
  });
  return { url: `${url}/paid`, unpaid, sales };
}

/** A budget home with a Solana agent, its owner, and the referrals `find` remembered for `origin`. */
function home(owner: PublicKey, agent: Keypair): string {
  const dir = mkdtempSync(join(tmpdir(), "superstables-budget-referral-"));
  homes.push(dir);
  mkdirSync(join(dir, "keys", "budget"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "budget", "public"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agent.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent.publicKey.toBase58()}\nSOLANA_OWNER_ADDRESS=${owner.toBase58()}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${owner.toBase58()}\nSOLANA_AGENT_ADDRESS=${agent.publicKey.toBase58()}\n`);
  return dir;
}

function remember(dir: string, origin: string, id: string): string {
  const { token } = signReferral(referralKey(), { jti: id, aud: origin });
  mkdirSync(join(dir, "records"), { recursive: true });
  const entry = { listingId: "seller.example", token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), terms: "terms-1", seenAt: new Date().toISOString() };
  writeFileSync(join(dir, "records", "referrals.json"), JSON.stringify({ [origin]: entry }));
  return token;
}

function buy(dir: string, rpc: string, url: string, op: string, env: Record<string, string> = {}): Promise<{ code: number; result: Record<string, any>; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUY, "--url", url, "--max", "0.01", "--op", op], { cwd: join(REPO, "budget", "solana"), env: { ...process.env, SUPERSTABLES_HOME: dir, SUPERSTABLES_SOLANA_RPC: rpc, ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.once("error", reject);
    child.once("close", (code) => {
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      resolve({ code: code ?? 1, result: line ? JSON.parse(line.slice(7)) : {}, out });
    });
  });
}

const journal = (dir: string, op: string) => JSON.parse(readFileSync(join(dir, "budget", "ops", "solana-devnet", `${op}.json`), "utf8"));

describe("a referred Solana budget buy", () => {
  it("names the referral in its memo, sends the token with the paid request only, and journals both", async () => {
    const owner = Keypair.generate().publicKey;
    const agent = Keypair.generate();
    const landed = { sig: bs58.encode(Buffer.alloc(64, 7)) };
    const rpc = await devnet(owner, agent.publicKey, landed);
    const s = await seller(landed, agent.publicKey);
    const dir = home(owner, agent);
    const token = remember(dir, new URL(s.url).origin, ID);

    const r = await buy(dir, rpc, s.url, "op-ref-1");
    expect(r.result.state, r.out).toBe("settled");
    expect(s.sales).toHaveLength(1);
    expect(s.sales[0]!.memo).toBe("rb:op-ref-1;ss1AAECAwQFBgcICQoLDA0ODw");
    expect(s.sales[0]!.headers["superstables-referral"]).toBe(token);
    expect(s.sales[0]!.headers["superstables-purchase-ref"]).toBe("op-ref-1");
    expect(s.unpaid.every((h) => h["superstables-referral"] === undefined)).toBe(true);
    expect(journal(dir, "op-ref-1")).toMatchObject({ memo: "rb:op-ref-1;ss1AAECAwQFBgcICQoLDA0ODw", referral: { id: ID, listingId: "seller.example", terms: "terms-1", token } });
  }, 60_000);

  it("keeps the referral it started with when the same operation runs again", async () => {
    const owner = Keypair.generate().publicKey;
    const agent = Keypair.generate();
    const landed = { sig: bs58.encode(Buffer.alloc(64, 8)) };
    const rpc = await devnet(owner, agent.publicKey, landed);
    const s = await seller(landed, agent.publicKey);
    const dir = home(owner, agent);
    const first = remember(dir, new URL(s.url).origin, ID);
    expect((await buy(dir, rpc, s.url, "op-ref-2")).result.state).toBe("settled");

    // The payment never landed after all; the index has handed out another referral since.
    const path = join(dir, "budget", "ops", "solana-devnet", "op-ref-2.json");
    writeFileSync(path, JSON.stringify({ ...journal(dir, "op-ref-2"), state: "not_found" }));
    remember(dir, new URL(s.url).origin, OTHER_ID);
    const again = await buy(dir, rpc, s.url, "op-ref-2");
    expect(again.result.state, again.out).toBe("settled");
    expect(s.sales).toHaveLength(2);
    expect(s.sales[1]!.memo).toBe("rb:op-ref-2;ss1AAECAwQFBgcICQoLDA0ODw");
    expect(s.sales[1]!.headers["superstables-referral"]).toBe(first);
    expect(journal(dir, "op-ref-2").referral).toMatchObject({ id: ID, token: first });
  }, 60_000);

  it("keeps rb:<op> and sends no token without a referral, with a malformed id, or with referrals off", async () => {
    const owner = Keypair.generate().publicKey;
    const agent = Keypair.generate();
    const landed = { sig: bs58.encode(Buffer.alloc(64, 9)) };
    const rpc = await devnet(owner, agent.publicKey, landed);
    const s = await seller(landed, agent.publicKey);
    const dir = home(owner, agent);

    expect((await buy(dir, rpc, s.url, "op-plain")).result.state).toBe("settled");
    expect(journal(dir, "op-plain").referral).toBeNull();
    remember(dir, new URL(s.url).origin, "ref_not-a-16-byte-id");
    expect((await buy(dir, rpc, s.url, "op-malformed")).result.state).toBe("settled");
    remember(dir, new URL(s.url).origin, ID);
    expect((await buy(dir, rpc, s.url, "op-off", { SUPERSTABLES_REFERRALS: "off" })).result.state).toBe("settled");
    expect(s.sales.map((sale) => sale.memo)).toEqual(["rb:op-plain", "rb:op-malformed", "rb:op-off"]);
    expect(s.sales.every((sale) => sale.headers["superstables-referral"] === undefined && sale.headers["superstables-purchase-ref"] === undefined)).toBe(true);
  }, 60_000);
});

const { mppMemo } = await import(new URL("../../budget/tempo/lib/chain.ts", import.meta.url).href);
const Attribution = await import(new URL("../../node_modules/mppx/dist/tempo/Attribution.js", import.meta.url).href);

/** The MPP memo in a serialized transaction: 32 bytes from the tag keccak256("mpp")[0..3] and version 1. */
const memoIn = (serialized: string) => {
  const at = serialized.toLowerCase().indexOf("ef1ed71201");
  return at < 0 ? undefined : `0x${serialized.toLowerCase().slice(at, at + 64)}`;
};
const word = (value: string | bigint) => `0x${(typeof value === "bigint" ? value.toString(16) : value.slice(2).toLowerCase()).padStart(64, "0")}`;
const TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
const TRANSFER_WITH_MEMO = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
const RECIPIENT = "0x2222222222222222222222222222222222222222";

/**
 * Moderato for one Tempo buy: the fake keychain (../helpers/fake-chains.ts) with an active key for the agent, plus what
 * mppx asks while it builds the payment. A push broadcast is kept and mined in the head block as the transfer it makes.
 */
async function moderato(owner: string, agent: string): Promise<{ url: string; raw: string[]; chain: Awaited<ReturnType<typeof startFakeTempo>> }> {
  const chain = await startFakeTempo();
  servers.push({ close: (done: () => void) => chain.close().then(done) } as unknown as Server);
  chain.keys.set(`${owner.toLowerCase()}:${agent.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), limit: 10n ** 7n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
  const raw: string[] = [];
  let receipt: Record<string, unknown> | undefined;
  const fixed: Record<string, unknown> = { eth_getTransactionCount: "0x0", eth_estimateGas: "0x30000", eth_maxPriorityFeePerGas: "0x1", eth_gasPrice: "0x1" };
  const url = await listen(async (req, res) => {
    const call = JSON.parse(await body(req));
    const answer = async (c: { id: number; method: string; params?: any[] }) => {
      if (c.method in fixed) return { jsonrpc: "2.0", id: c.id, result: fixed[c.method] };
      if (c.method === "eth_sendRawTransactionSync") {
        raw.push(c.params![0]);
        const logs = [
          { address: PATH_USD, topics: [TRANSFER, word(owner), word(RECIPIENT)], data: word(10000n), removed: false },
          { address: PATH_USD, topics: [TRANSFER_WITH_MEMO, word(owner), word(RECIPIENT), memoIn(c.params![0])], data: word(10000n), removed: false },
        ];
        receipt = { transactionHash: keccak256(c.params![0]), blockNumber: hexOf(chain.head.number), blockHash: `0x${"ab".repeat(32)}`, status: "0x1", logs, gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", from: owner, to: PATH_USD, type: "0x76", transactionIndex: "0x0", logsBloom: `0x${"0".repeat(512)}`, contractAddress: null };
        return { jsonrpc: "2.0", id: c.id, result: receipt };
      }
      if (c.method === "eth_getTransactionReceipt" && receipt && c.params![0] === receipt.transactionHash) return { jsonrpc: "2.0", id: c.id, result: receipt };
      if (c.method === "eth_getTransactionByHash" && receipt && c.params![0] === receipt.transactionHash) return { jsonrpc: "2.0", id: c.id, result: { hash: receipt.transactionHash, from: owner, signature: { keyId: agent } } };
      const r = (await (await fetch(chain.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) })).json()) as { result?: Record<string, unknown> };
      if (c.method === "eth_getBlockByNumber" && r.result) r.result.baseFeePerGas = "0x1";
      return r;
    };
    const out = Array.isArray(call) ? await Promise.all(call.map(answer)) : await answer(call);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  // The endpoints that confirm a verdict that lets the agent pay again come from the client's table, so the buy runs from a
  // copy whose table names this RPC.
  const tree = endpointTree();
  tree.set({ "tempo-moderato": [url] });
  servers.push({ close: (done: () => void) => { tree.close(); done(); } } as unknown as Server);
  treeOf.set(url, tree.root);
  return { url, raw, chain };
}

const treeOf = new Map<string, string>();

/** An MPP seller of one tempo.charge in `mode`, keeping every request's headers and every credential's payload. */
async function mppSeller(mode: "pull" | "push", onPaid: () => void = () => {}, challengeId = "challenge-1"): Promise<{ url: string; unpaid: IncomingHttpHeaders[]; paid: { headers: IncomingHttpHeaders; payload: { type: string; signature?: string; hash?: string } }[] }> {
  const unpaid: IncomingHttpHeaders[] = [];
  const paid: { headers: IncomingHttpHeaders; payload: { type: string; signature?: string; hash?: string } }[] = [];
  const url = await listen((req, res) => {
    if (req.headers.authorization) {
      paid.push({ headers: { ...req.headers }, payload: Credential.deserialize(req.headers.authorization).payload as never });
      onPaid();
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    unpaid.push({ ...req.headers });
    const challenge = Challenge.from({ id: challengeId, realm: "seller.example", method: "tempo", intent: "charge", request: { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: [mode] } }, expires: new Date(Date.now() + 300_000).toISOString() });
    res.writeHead(402, { "www-authenticate": Challenge.serialize(challenge) }).end("{}");
  });
  return { url: `${url}/paid`, unpaid, paid };
}

function tempoHome(owner: string): { dir: string; agent: string } {
  const dir = mkdtempSync(join(tmpdir(), "superstables-budget-referral-tempo-"));
  homes.push(dir);
  mkdirSync(join(dir, "keys", "budget"), { recursive: true, mode: 0o700 });
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key).address;
  writeFileSync(join(dir, "keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${key}\nAGENT_ADDRESS=${agent}\nOWNER_ADDRESS=${owner}\n`, { mode: 0o600 });
  return { dir, agent };
}

function tempoBuy(dir: string, rpc: string, url: string, op: string): Promise<{ result: Record<string, any>; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "buy.ts", "--url", url, "--max", "0.01", "--op", op], { cwd: join(treeOf.get(rpc)!, "budget", "tempo"), env: { ...process.env, SUPERSTABLES_HOME: dir, SUPERSTABLES_TEMPO_RPC: rpc } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.once("error", reject);
    child.once("close", () => {
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      resolve({ result: line ? JSON.parse(line.slice(7)) : {}, out });
    });
  });
}

const tempoJournal = (dir: string, op: string) => JSON.parse(readFileSync(join(dir, "budget", "ops", "tempo-moderato", `${op}.json`), "utf8"));

describe("a referred Tempo budget buy", () => {
  const memo = (clientId?: string, challengeId = "challenge-1") => mppMemo(challengeId, "seller.example", clientId);

  for (const mode of ["pull", "push"] as const) {
    it(`journals the memo mppx sends with the referral's client id, and sends the token with the paid request only (${mode} mode)`, async () => {
      const owner = privateKeyToAccount(generatePrivateKey()).address;
      const { dir, agent } = tempoHome(owner);
      const chain = await moderato(owner, agent);
      // pull: the seller's relay never lands the payment, and the chain's clock passes its expiry
      const s = await mppSeller(mode, () => (chain.chain.head.timestamp += 1_000));
      const token = remember(dir, new URL(s.url).origin, ID);

      const r = await tempoBuy(dir, chain.url, s.url, `tempo-${mode}`);
      expect(r.result.delivered, r.out).toBe(true);
      const journaled = tempoJournal(dir, `tempo-${mode}`);
      expect(journaled.memo).toBe(memo(`superstables:${ID}`));
      expect(journaled.memo).toBe(Attribution.encode({ challengeId: "challenge-1", clientId: `superstables:${ID}`, serverId: "seller.example" }));
      expect(journaled.referral).toMatchObject({ id: ID, listingId: "seller.example", terms: "terms-1", token });
      // The transaction mppx signed carries that memo: in the credential (pull), or as broadcast (push).
      const signed = mode === "pull" ? s.paid[0]!.payload.signature! : chain.raw[0]!;
      expect(memoIn(signed)).toBe(journaled.memo);
      expect(r.result.state, r.out).toBe(mode === "pull" ? "not_found" : "settled");
      expect(s.paid).toHaveLength(1);
      expect(s.paid[0]!.headers["superstables-referral"]).toBe(token);
      expect(s.paid[0]!.headers["superstables-purchase-ref"]).toBe(`tempo-${mode}`);
      expect(s.unpaid.every((h) => h["superstables-referral"] === undefined)).toBe(true);
    }, 60_000);
  }

  it("keeps the referral it started with when the same operation runs again, and marks nothing without one", async () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const { dir, agent } = tempoHome(owner);
    const chain = await moderato(owner, agent);
    const s = await mppSeller("pull", () => (chain.chain.head.timestamp += 1_000));
    const first = remember(dir, new URL(s.url).origin, ID);
    expect((await tempoBuy(dir, chain.url, s.url, "tempo-again")).result.delivered).toBe(true);
    const path = join(dir, "budget", "ops", "tempo-moderato", "tempo-again.json");
    writeFileSync(path, JSON.stringify({ ...tempoJournal(dir, "tempo-again"), state: "not_found" }));
    remember(dir, new URL(s.url).origin, OTHER_ID);
    const again = await tempoBuy(dir, chain.url, s.url, "tempo-again");
    expect(again.result.delivered, again.out).toBe(true);
    expect(tempoJournal(dir, "tempo-again")).toMatchObject({ memo: memo(`superstables:${ID}`), referral: { id: ID, token: first } });
    expect(s.paid[1]!.headers["superstables-referral"]).toBe(first);

    // The seller hands the same challenge to another operation, under no referral: the challenge is spent, referral or not
    rmSync(join(dir, "records"), { recursive: true });
    const spent = await tempoBuy(dir, chain.url, s.url, "tempo-plain");
    expect(spent.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^challenge_used: operation tempo-again /) });
    expect(s.paid).toHaveLength(2);

    // A new challenge is paid as before
    const fresh = await mppSeller("pull", () => (chain.chain.head.timestamp += 1_000), "challenge-2");
    expect((await tempoBuy(dir, chain.url, fresh.url, "tempo-plain")).result.delivered).toBe(true);
    expect(tempoJournal(dir, "tempo-plain")).toMatchObject({ memo: memo(undefined, "challenge-2"), referral: null });
    expect(tempoJournal(dir, "tempo-plain").memo.slice(32, 52)).toBe("0".repeat(20));
    expect(fresh.paid[0]!.headers["superstables-referral"]).toBeUndefined();
  }, 90_000);

  it("journals no client id for a malformed referral id", () => {
    expect(mppMemo("challenge-1", "seller.example", tempoClientId("ref_not-a-16-byte-id"))).toBe(Attribution.encode({ challengeId: "challenge-1", serverId: "seller.example" }));
  });
});
