import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, parseAbi, type Hex } from "viem";
import { readSettlement as hostedSettlement } from "../../budget/settlement.mjs";
import { sendJson, readBody, startServer } from "../helpers/servers.js";
import { SOLANA_MARKET, SOLANA_PAYER, startFakePurchaseSite } from "../helpers/fake-purchase-site.js";
import { assessOp, refusalIsFinal } from "../../budget/solana/ops.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"cd".repeat(32)}`;
const NONCE: Hex = `0x${"ef".repeat(32)}`;
const abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event TransferWithMemo(address indexed from, address indexed to, uint256 value, bytes32 indexed memo)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);
const transfer = (from: Hex = AGENT, to: Hex = TO) => ({ address: TOKEN, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }), data: `0x${10000n.toString(16).padStart(64, "0")}` });
const used = (name: "AuthorizationUsed" | "AuthorizationCanceled" = "AuthorizationUsed") => ({ address: TOKEN, topics: encodeEventTopics({ abi, eventName: name, args: { authorizer: AGENT, nonce: NONCE } }), data: "0x", transactionHash: HASH, blockNumber: 100n, blockHash: BLOCK_HASH, removed: false });
const receipt = (logs: (ReturnType<typeof used> | ReturnType<typeof transfer>)[] = [used(), transfer()]) => ({ transactionHash: HASH, blockNumber: 100n, blockHash: BLOCK_HASH, status: "success", logs });
const journal = () => ({ op: "finality-test", rail: "base-sepolia", path: "approve", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: "https://seller.example", owner: OWNER, agent: AGENT, token: TOKEN, max: "1", pullTx: HASH, pullNonce: 7, pullBlock: "90", signed: true, auth: { from: AGENT, to: TO, value: "10000", nonce: NONCE, validBefore: 1000, validAfter: 0 }, delivered: null, notes: [] });

let dir: string;
const rpc = {
  getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getTransactionCount: vi.fn(),
  getBlock: vi.fn(), getBlockNumber: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(),
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-finality-"));
  vi.resetModules();
  for (const fn of Object.values(rpc)) fn.mockReset();
  rpc.getBlockNumber.mockResolvedValue(110n);
  rpc.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => ({ number: blockNumber ?? (blockTag === "finalized" ? 90n : 110n), timestamp: 2000n, hash: BLOCK_HASH, transactions: [] }));
  rpc.getTransactionCount.mockResolvedValue(8);
  rpc.readContract.mockResolvedValue(true);
  rpc.getTransaction.mockRejectedValue(new Error("not found"));
  rpc.getLogs.mockImplementation(async ({ event }) => event.name === "AuthorizationUsed" ? [used()] : []);
  rpc.getTransactionReceipt.mockResolvedValue(receipt());
  vi.doMock("../../budget/evm/lib.js", async (original) => ({ ...await original<object>(), OPS_DIR: dir, publicClient: rpc, USDC: TOKEN, sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f() }));
});
afterEach(() => { vi.doUnmock("../../budget/evm/lib.js"); rmSync(dir, { recursive: true, force: true }); });
const ops = () => import(new URL("../../budget/evm/ops.ts", import.meta.url).href);

describe("budget EVM finality", () => {
  it("keeps a receipt read error unknown during a nonce advance", async () => {
    rpc.getTransactionReceipt.mockRejectedValue(new Error("RPC unavailable"));
    expect((await (await ops()).reconcileJournal(journal(), { quiet: true })).verdict).toBe("unknown");
  });
  it("does not turn nonce advancement alone into a different final transaction", async () => {
    rpc.getTransactionReceipt.mockResolvedValue(null);
    expect((await (await ops()).reconcileJournal(journal(), { quiet: true })).verdict).toBe("unknown");
  });
  it("keeps a successful settlement provisional until its canonical block is final", async () => {
    expect(await (await ops()).readSettlement(journal())).not.toMatchObject({ status: "success", transferOk: true });
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH }));
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ used: true, status: "success", transferOk: true });
  });
  it("does not accept a cancellation above finality or after its block hash changes", async () => {
    rpc.getLogs.mockImplementation(async ({ event }) => event.name === "AuthorizationCanceled" ? [used("AuthorizationCanceled")] : []);
    expect((await (await ops()).readSettlement(journal())).canceled).toBe(false);
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: blockNumber === 100n ? NONCE : BLOCK_HASH }));
    expect((await (await ops()).readSettlement(journal())).canceled).toBe(false);
  });
  it("accepts a canonical final cancellation only with the cancellation in its successful receipt", async () => {
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH }));
    rpc.getLogs.mockImplementation(async ({ event }) => event.name === "AuthorizationCanceled" ? [used("AuthorizationCanceled")] : []);
    rpc.getTransactionReceipt.mockResolvedValue(receipt([used("AuthorizationCanceled")]));
    expect(await (await ops()).readSettlement(journal())).toEqual({ used: false, canceled: true });
    rpc.getTransactionReceipt.mockResolvedValue(receipt());
    expect((await (await ops()).readSettlement(journal())).canceled).toBe(false);
  });
  it("identifies the different final nonce-consuming transaction before proving no pull", async () => {
    const replacement: Hex = `0x${"12".repeat(32)}`;
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => hash === HASH ? null : { ...receipt([]), transactionHash: replacement, blockNumber: 80n });
    rpc.getTransactionCount.mockImplementation(async ({ blockNumber }) => blockNumber >= 80n ? 8 : 7);
    rpc.getBlock.mockImplementation(async ({ blockNumber, includeTransactions }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH, transactions: includeTransactions ? [{ from: AGENT, nonce: 7, hash: replacement }] : [] }));
    const result = await (await ops()).reconcileJournal(journal(), { quiet: true });
    expect(result.verdict).toBe("not_found");
    expect(result.j.reason).toContain(replacement);
    expect(rpc.getTransactionCount.mock.calls.every(([arg]) => typeof arg.blockNumber === "bigint")).toBe(true);
  });
  it("checks the canonical pull provisionally for funding but requires finality for reconciliation", async () => {
    expect(await (await ops()).readPull(journal(), { final: false })).toMatchObject({ found: true });
    expect(await (await ops()).readPull(journal())).toMatchObject({ found: false, unknown: true });
  });
  it("does not accept a removed settlement receipt or an unavailable finalized head", async () => {
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH }));
    rpc.getTransactionReceipt.mockResolvedValue(receipt([{ ...used(), removed: true }, transfer()]));
    expect(await (await ops()).readSettlement(journal())).toEqual({ used: true, canceled: false });
    rpc.getBlock.mockRejectedValue(new Error("finality unavailable"));
    expect(await (await ops()).authDead(journal(), { used: false, canceled: false })).toBe(false);
  });
  it("pins unused expiry to the final block rather than latest", async () => {
    rpc.readContract.mockResolvedValue(false);
    rpc.getBlock.mockImplementation(async ({ blockTag }) => ({ number: blockTag === "finalized" ? 90n : 110n, timestamp: blockTag === "finalized" ? 900n : 2000n, hash: BLOCK_HASH }));
    expect(await (await ops()).authDead(journal(), { used: false, canceled: false })).toBe(false);
  });
});

const solRec = { agent: "11111111111111111111111111111111", feePayer: "11111111111111111111111111111111", agentSig: "agent-signature", tx: "agent-signature", lastValidBlockHeight: 250, searchFromSlot: 110 };
function solRpc(status: "confirmed" | "finalized" | null = null) {
  return {
    getGenesisHash: vi.fn(async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
    getEpochInfo: vi.fn(async () => ({ absoluteSlot: 361, blockHeight: 351 })),
    getBlockHeight: vi.fn(async () => 351),
    getSignatureStatuses: vi.fn(async (): Promise<{ context: { slot: number }; value: ({ confirmationStatus: "confirmed" | "finalized"; err: unknown; slot: number } | null)[] }> => ({ context: { slot: 361 }, value: status ? [{ confirmationStatus: status, err: null, slot: 111 }] : [null] })),
    getTransaction: vi.fn(async () => null),
    getSignaturesForAddress: vi.fn(async () => []),
    getFirstAvailableBlock: vi.fn(async () => 0),
  };
}
describe("budget Solana finality and absence", () => {
  it("distinguishes a confirmed own transaction from a finalized one", async () => {
    expect((await assessOp(solRpc("confirmed"), solRec)).verdict).toBe("pending");
    expect(await assessOp(solRpc("finalized"), solRec)).toMatchObject({ verdict: "settled", tx: solRec.agentSig });
  });
  it("keeps an index that omits a landed sponsored transaction unresolved", async () => {
    const rec = { ...solRec, tx: null, feePayer: "sponsor", searchFromSlot: undefined };
    expect((await assessOp(solRpc(), rec)).verdict).toBe("pending");
    expect(await refusalIsFinal(solRpc(), rec)).toBe(false);
  });
  it("uses finalized expiry and history for a known own transaction ID", async () => {
    const conn = solRpc();
    conn.getBlockHeight.mockImplementation(async (commitment?: string) => commitment === "finalized" ? 240 : 351);
    conn.getEpochInfo.mockResolvedValue({ absoluteSlot: 250, blockHeight: 240 });
    expect((await assessOp(conn, solRec)).verdict).toBe("pending");
    conn.getEpochInfo.mockResolvedValue({ absoluteSlot: 361, blockHeight: 351 });
    conn.getBlockHeight.mockResolvedValue(351);
    expect((await assessOp(conn, solRec)).verdict).toBe("not_found");
  });
  it("finds a finalized landed transaction omitted by the address index in the complete landing window", async () => {
    const hidden = "hidden-sponsored-id";
    const conn = scanRpc(hidden);
    const rec = { ...solRec, feePayer: "sponsor", tx: null };
    expect(await assessOp(conn, rec)).toMatchObject({ verdict: "settled", tx: hidden });
    expect(conn.getSignaturesForAddress).toHaveReturned();
    expect(conn.getBlock).toHaveBeenCalledWith(111, expect.objectContaining({ commitment: "finalized" }));
  });
  it("proves sponsored absence only after all finalized landing blocks are read without gaps", async () => {
    const conn = scanRpc();
    const rec = { ...solRec, feePayer: "sponsor", tx: null };
    expect((await assessOp(conn, rec)).verdict).toBe("not_found");
    expect(conn.getBlock).toHaveBeenCalledTimes(151);
    conn.getBlock.mockImplementation(async (slot: number) => ({ blockHeight: slot === 200 ? 191 : slot - 10, transactions: [] }));
    expect((await assessOp(conn, rec)).verdict).toBe("pending");
  });
  it("preserves uncertainty for pruned or lagging direct signature history", async () => {
    const conn = solRpc();
    conn.getFirstAvailableBlock.mockResolvedValue(111);
    expect((await assessOp(conn, solRec)).verdict).toBe("pending");
    conn.getFirstAvailableBlock.mockResolvedValue(0);
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 360 }, value: [null] });
    expect((await assessOp(conn, solRec)).verdict).toBe("pending");
  });
  it("does not use a confirmed execution error as final failure", async () => {
    const conn = solRpc("confirmed");
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 361 }, value: [{ confirmationStatus: "confirmed", err: { InstructionError: [1, "Custom"] }, slot: 111 }] });
    expect((await assessOp(conn, solRec)).verdict).toBe("pending");
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 361 }, value: [{ confirmationStatus: "finalized", err: { InstructionError: [1, "Custom"] }, slot: 111 }] });
    expect((await assessOp(conn, solRec)).verdict).toBe("failed");
  });

});

function scanRpc(hidden?: string) {
  return {
    ...solRpc(),
    getBlocks: vi.fn(async () => Array.from({ length: 151 }, (_, i) => 111 + i)),
    getBlock: vi.fn(async (slot: number) => ({ blockHeight: slot - 10, transactions: hidden && slot === 111 ? [{ transaction: { signatures: [hidden, solRec.agentSig] } }] : [] })),
    getTransaction: vi.fn(async (sig: string) => sig === hidden ? { slot: 111, meta: { err: null }, transaction: { signatures: [hidden, solRec.agentSig] } } : null),
  };
}


describe("hosted client finality", () => {
  it("keeps hosted EVM payment provisional until canonical finalized inclusion", async () => {
    let final = "0x5f";
    let canonical = BLOCK_HASH;
    const server = await startServer(async (req, res) => {
      const call = JSON.parse(await readBody(req));
      const result = call.method === "eth_getTransactionReceipt"
        ? { transactionHash: HASH, blockNumber: "0x64", blockHash: BLOCK_HASH, status: "0x1", logs: [{ address: TOKEN, topics: used().topics, data: "0x" }, transfer(), { address: TOKEN, topics: encodeEventTopics({ abi, eventName: "TransferWithMemo", args: { from: AGENT, to: TO, memo: NONCE } }), data: transfer().data }] }
        : call.params[0] === "finalized"
          ? { number: final }
          : { number: call.params[0] === "latest" ? "0x6e" : "0x64", hash: canonical, timestamp: "0x7d0" };
      sendJson(res, 200, { jsonrpc: "2.0", id: call.id, result });
    });
    try {
      const input = { rail: "evm", chain: "base-sepolia", tx: HASH, payer: AGENT, payTo: TO, asset: TOKEN, amount: 10000n, notBefore: 1000, nonce: NONCE, rpcUrl: server.url, deadline: Date.now() + 10000 };
      expect((await hostedSettlement(input)).state).toBe("included");
      final = "0x6e";
      expect((await hostedSettlement(input)).state).toBe("settled");
      canonical = NONCE;
      expect((await hostedSettlement(input)).state).toBe("unread");
      canonical = BLOCK_HASH; final = "0x5f";
      expect((await hostedSettlement({ ...input, chain: "skale-base-sepolia" })).state).toBe("settled");
      expect((await hostedSettlement({ ...input, rail: "tempo", chain: "moderato" })).state).toBe("settled");
    } finally { await server.close(); }
  });
  it("reads the hosted Solana payment identity at the same commitment as its execution", async () => {
    const site = await startFakePurchaseSite();
    site.services.push(SOLANA_MARKET);
    site.finalizedSlot = 10;
    const reads: unknown[] = [];
    const proxy = await startServer(async (req, res) => {
      const raw = await readBody(req);
      const call = JSON.parse(raw);
      reads.push(call.params[1]);
      const response = await fetch(site.chainUrl, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      sendJson(res, 200, await response.json());
    });
    try {
      await fetch(`${site.url}/api/v1/purchases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: SOLANA_MARKET.id }) });
      const p = site.purchases[0];
      const tx = "5".repeat(87);
      site.settle(p, "ok", { transaction: tx, payer: SOLANA_PAYER });
      const input = { rail: "solana", chain: "devnet", tx, payer: SOLANA_PAYER, payTo: SOLANA_MARKET.payTo, asset: SOLANA_MARKET.asset, amount: 10000n, notBefore: 0, nonce: p.nonce, rpcUrl: proxy.url, deadline: undefined };
      expect((await hostedSettlement(input)).state).toBe("included");
      site.finalizedSlot = 1000;
      expect((await hostedSettlement(input)).state).toBe("settled");
      expect((await hostedSettlement({ ...input, nonce: NONCE })).state).toBe("mismatch");
      expect(reads).toEqual([
        expect.objectContaining({ encoding: "json", commitment: "finalized" }),
        expect.objectContaining({ encoding: "json", commitment: "confirmed" }),
        expect.objectContaining({ encoding: "base64", commitment: "confirmed" }),
        expect.objectContaining({ encoding: "json", commitment: "finalized" }),
        expect.objectContaining({ encoding: "base64", commitment: "finalized" }),
        expect.objectContaining({ encoding: "json", commitment: "finalized" }),
        expect.objectContaining({ encoding: "base64", commitment: "finalized" }),
      ]);
    } finally { await proxy.close(); await site.close(); }
  });
});


it("keeps budget Tempo receipt inclusion unreadable without a canonical committed block", async () => {
  let available = false;
  const server = await startServer(async (req, res) => {
    const call = JSON.parse(await readBody(req));
    const result = call.method === "eth_getTransactionReceipt"
      ? { transactionHash: HASH, status: "0x1", blockNumber: "0x64", blockHash: BLOCK_HASH, logs: [] }
      : available ? { number: call.params[0] === "latest" ? "0x6e" : "0x64", hash: BLOCK_HASH, timestamp: "0x7d0" } : null;
    sendJson(res, 200, { jsonrpc: "2.0", id: call.id, result });
  });
  vi.doMock("../../budget/tempo/lib/common.ts", async (original) => ({ ...await original<object>(), RPC_URL: server.url }));
  try {
    const chain = await import(new URL("../../budget/tempo/lib/chain.ts", import.meta.url).href);
    await expect(chain.getReceipt(HASH)).rejects.toThrow();
    available = true;
    expect(await chain.getReceipt(HASH)).toMatchObject({ status: "success", transactionHash: HASH });
  } finally { vi.doUnmock("../../budget/tempo/lib/common.ts"); await server.close(); }
});
