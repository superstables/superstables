import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import { buildPayment } from "../../src/core/rails/solana-transaction.js";
import { MINT, randomAddress, signAsOwner, solanaKey } from "../helpers/fake-solana-pay.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, parseAbi, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readSettlement as hostedSettlement } from "../../budget/settlement.mjs";
import { sendJson, readBody, startServer } from "../helpers/servers.js";
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
const sendJournaled = vi.fn();
const usdcBalance = vi.fn();
const rpc = {
  getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getTransactionCount: vi.fn(),
  getBlock: vi.fn(), getBlockNumber: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(),
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-finality-"));
  vi.resetModules();
  sendJournaled.mockReset();
  usdcBalance.mockReset().mockResolvedValue(10000n);
  for (const fn of Object.values(rpc)) fn.mockReset();
  rpc.getBlockNumber.mockResolvedValue(110n);
  rpc.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => ({ number: blockNumber ?? (blockTag === "finalized" ? 90n : 110n), timestamp: 2000n, hash: BLOCK_HASH, transactions: [] }));
  rpc.getTransactionCount.mockResolvedValue(8);
  rpc.readContract.mockResolvedValue(true);
  rpc.getTransaction.mockRejectedValue(new Error("not found"));
  rpc.getLogs.mockImplementation(async ({ event }) => event.name === "AuthorizationUsed" ? [used()] : []);
  rpc.getTransactionReceipt.mockResolvedValue(receipt());
  vi.doMock("../../budget/evm/lib.js", async (original) => ({ ...await original<object>(), OPS_DIR: dir, publicClient: rpc, sendJournaled, usdcBalance, allowanceOf: async () => 10000n, USDC: TOKEN, sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f() }));
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
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ kind: "used", transferOk: true, final: false });
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
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ kind: "canceled", used: false, canceled: true, final: true });
    rpc.getTransactionReceipt.mockResolvedValue(receipt());
    expect((await (await ops()).readSettlement(journal())).canceled).toBe(false);
  });
  it("identifies the different final nonce-consuming transaction before proving no pull", async () => {
    const replacement: Hex = `0x${"12".repeat(32)}`;
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => hash === HASH ? null : { ...receipt([]), transactionHash: replacement, blockNumber: 80n });
    rpc.getTransactionCount.mockResolvedValue(8);
    rpc.getTransaction.mockImplementation(async ({ hash }) => hash === replacement ? { from: AGENT, nonce: 7, hash: replacement } : null);
    rpc.getLogs.mockResolvedValue([{ ...used(), transactionHash: replacement, blockNumber: 80n }]);
    rpc.getBlock.mockImplementation(async ({ blockNumber, includeTransactions }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH, transactions: includeTransactions ? [{ from: AGENT, nonce: 7, hash: replacement }] : [] }));
    const result = await (await ops()).reconcileJournal(journal(), { quiet: true });
    expect(result.verdict).toBe("not_found");
    expect(result.j.reason).toContain(replacement);
    expect(rpc.getTransactionCount.mock.calls.every(([arg]) => typeof arg.blockNumber === "bigint")).toBe(true);
  });
  it("checks the canonical pull provisionally for funding but requires finality for reconciliation", async () => {
    expect(await (await ops()).readPull(journal(), { final: false })).toMatchObject({ found: true });
    expect(await (await ops()).readPull(journal())).toMatchObject({ found: true, final: false });
  });
  it("does not accept a removed settlement receipt or an unavailable finalized head", async () => {
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH }));
    rpc.getTransactionReceipt.mockResolvedValue(receipt([{ ...used(), removed: true }, transfer()]));
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ kind: "pending", used: false, canceled: false });
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
    expect(await assessOp(solRpc("confirmed"), solRec)).toMatchObject({ verdict: "settled", final: false });
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
    expect(await assessOp(conn, rec, { paceMs: 0 })).toMatchObject({ verdict: "settled", tx: hidden });
    expect(conn.getSignaturesForAddress).toHaveReturned();
    expect(conn.getBlock).toHaveBeenCalledWith(111, expect.objectContaining({ commitment: "finalized" }));
  });
  it("proves sponsored absence only after all finalized landing blocks are read without gaps", async () => {
    const conn = scanRpc();
    const rec = { ...solRec, feePayer: "sponsor", tx: null };
    expect((await assessOp(conn, rec, { paceMs: 0 })).verdict).toBe("not_found");
    expect(conn.getBlock).toHaveBeenCalledTimes(151);
    conn.getBlock.mockImplementation(async (slot: number) => ({ blockHeight: slot === 200 ? 191 : slot - 10, transactions: [] }));
    expect((await assessOp(conn, { ...rec, searchedToSlot: undefined }, { paceMs: 0 })).verdict).toBe("pending");
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
    getBlock: vi.fn(async (slot: number, _options?: { maxSupportedTransactionVersion?: number }) => ({ blockHeight: slot - 10, transactions: hidden && slot === 111 ? [{ transaction: { signatures: [hidden, solRec.agentSig] } }] : [] })),
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
        ? { transactionHash: HASH, blockNumber: "0x64", blockHash: BLOCK_HASH, status: "0x1", logs: [{ ...used(), blockNumber: "0x64" }, transfer(), { ...transfer(), topics: encodeEventTopics({ abi, eventName: "TransferWithMemo", args: { from: AGENT, to: TO, memo: NONCE } }) }] }
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
  it("reads hosted Solana payment at finalized commitment", async () => {
    const owner = solanaKey();
    const recipient = randomAddress();
    const sponsor = solanaKey();
    const built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: sponsor.address, blockhash: randomAddress() });
    const signed = signAsOwner(signAsOwner(built.transaction, owner), sponsor);
    const parsed = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
    const nonce = `0x${createHash("sha256").update(Buffer.from(parsed.message.serialize()).toString("base64")).digest("hex")}`;
    const signature = (await import("bs58")).default.encode(parsed.signatures[0]);
    let finalized = false;
    const server = await startServer(async (req, res) => {
      const call = JSON.parse(await readBody(req));
      const result = call.params[1].commitment === "finalized" && !finalized ? null : {
        blockTime: 2000,
        transaction: [signed, "base64"],
        meta: { err: null, preTokenBalances: [
          { mint: MINT, owner: owner.address, uiTokenAmount: { amount: "10000" } },
          { mint: MINT, owner: recipient, uiTokenAmount: { amount: "0" } },
        ], postTokenBalances: [
          { mint: MINT, owner: owner.address, uiTokenAmount: { amount: "0" } },
          { mint: MINT, owner: recipient, uiTokenAmount: { amount: "10000" } },
        ] },
      };
      sendJson(res, 200, { jsonrpc: "2.0", id: call.id, result });
    });
    try {
      const input = { rail: "solana", chain: "devnet", tx: signature, payer: owner.address, payTo: recipient, asset: MINT, amount: 10000n, notBefore: 1000, nonce, rpcUrl: server.url, deadline: Date.now() + 10000 };
      expect((await hostedSettlement(input)).state).toBe("included");
      finalized = true;
      expect((await hostedSettlement(input)).state).toBe("settled");
    } finally { await server.close(); }
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


describe("round 2: EVM landed results and recovery", () => {
  it("reports a matching landed payment as paid and delivered while keeping it reconcilable", async () => {
    const module = await ops();
    const j = { ...journal(), delivered: true };
    const result = await module.reconcileJournal(j, { quiet: true });
    expect(result.j).toMatchObject({ state: "settled", final: false });
    expect(JSON.parse((await module.resultLine(result.j, "buy")).slice(7))).toMatchObject({ ok: true, state: "settled", paid: true, delivered: true, final: false });
    rpc.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH }));
    expect((await module.reconcileJournal(result.j, { quiet: true })).j).toMatchObject({ state: "settled", final: true });
  });
  it("keeps a reorged inclusion unknown even after authorization expiry", async () => {
    const module = await ops();
    const result = await module.reconcileJournal(journal(), { quiet: true });
    rpc.getLogs.mockResolvedValue([]);
    rpc.readContract.mockResolvedValue(false);
    rpc.getTransactionReceipt.mockResolvedValue(null);
    const after = await module.reconcileJournal(result.j, { quiet: true });
    expect(after.j).toMatchObject({ state: "unknown" });
    expect(after.j.next).toContain("Do not pay again");
  });
  it("a log read error is unreadable, never a used authorization or a transfer mismatch", async () => {
    const module = await ops();
    rpc.getLogs.mockRejectedValue(new Error("RPC offline"));
    expect(await module.readSettlement(journal())).toMatchObject({ kind: "unread", used: false });
    const result = await module.reconcileJournal(journal(), { quiet: true });
    expect(result.j.reason).toContain("could not be read");
    expect(result.j.reason).not.toContain("does not match");
  });
  it("a landed cancellation pending finality is separate from a used payment", async () => {
    rpc.getLogs.mockImplementation(async ({ event }) => event.name === "AuthorizationCanceled" ? [used("AuthorizationCanceled")] : []);
    rpc.getTransactionReceipt.mockResolvedValue(receipt([used("AuthorizationCanceled")]));
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ kind: "canceled", final: false, used: false });
  });
  it("returns the pulled price after the agent's own cancellation lands before finality", async () => {
    const module = await ops();
    const cancel: Hex = `0x${"13".repeat(32)}`;
    const returned: Hex = `0x${"14".repeat(32)}`;
    let cancelled = false;
    rpc.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => ({ number: blockNumber ?? (blockTag === "finalized" ? 90n : 110n), timestamp: 900n, hash: BLOCK_HASH }));
    rpc.readContract.mockImplementation(async ({ blockNumber }) => blockNumber > 90n && cancelled);
    rpc.getLogs.mockResolvedValue([]);
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => hash === HASH ? { ...receipt([transfer(OWNER, AGENT)]), blockNumber: 80n } : hash === cancel ? { ...receipt([used("AuthorizationCanceled")]), transactionHash: cancel } : { ...receipt([transfer(AGENT, OWNER)]), transactionHash: returned });
    sendJournaled.mockImplementation(async (_wallet, _to, _data, label, before) => {
      const hash = label.includes("cancel") ? cancel : returned;
      before({ hash, nonce: 9 });
      cancelled = true;
      return { hash, feeWei: 1n };
    });
    const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const wallet = { account, client: createWalletClient({ account, transport: http("http://127.0.0.1:1") }) };
    const result = await module.makeSafe(journal(), wallet, { log: () => {} });
    expect(sendJournaled).toHaveBeenCalledTimes(2);
    expect(result.returned).toBe("0.01");
    expect(result.state).toBe("unknown"); // only permanence waits for finality
  });
  it("identifies a replaced pull from event logs without querying pruned account state", async () => {
    const replacement: Hex = `0x${"15".repeat(32)}`;
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => hash === HASH ? null : { ...receipt([]), blockNumber: 80n, transactionHash: replacement });
    rpc.getTransactionCount.mockRejectedValue(new Error("missing trie node for historical state"));
    rpc.getTransaction.mockImplementation(async ({ hash }) => hash === replacement ? { from: AGENT, nonce: 7, hash } : null);
    rpc.getLogs.mockResolvedValue([{ ...used(), blockNumber: 80n, transactionHash: replacement }]);
    expect((await (await ops()).reconcileJournal(journal(), { quiet: true })).verdict).toBe("not_found");
    expect(rpc.getLogs).toHaveBeenCalled();
    expect(rpc.getTransactionCount.mock.calls.every(([arg]) => arg.blockNumber === 90n)).toBe(true);
  });
});

describe("round 2: Solana complete history and resumable fallback", () => {
  it("accepts the full devnet genesis hash and rejects a CAIP-2 prefix", async () => {
    const conn = solRpc("finalized");
    expect((await assessOp(conn, solRec)).verdict).toBe("settled");
    conn.getGenesisHash.mockResolvedValue("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wc");
    await expect(assessOp(conn, solRec)).rejects.toThrow("not Solana devnet");
  });
  it("uses old own-fee-payer signature history when block zero is pruned", async () => {
    const conn = { ...solRpc(), getFirstAvailableBlock: vi.fn(async () => 116113408), getBlockTime: vi.fn(async () => 1600000000) };
    conn.getEpochInfo.mockResolvedValue({ absoluteSlot: 116113608, blockHeight: 351 });
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 116113608 }, value: [null] });
    const rec = { ...solRec, searchFromSlot: undefined, submittedAt: "2026-10-01T00:00:00Z" };
    expect((await assessOp(conn, rec)).verdict).toBe("not_found");
    conn.getBlockTime.mockResolvedValue(1900000000);
    expect((await assessOp(conn, rec)).verdict).toBe("pending");
  });
  it("proves sponsored absence with finalized paginated history spanning the whole landing window", async () => {
    const conn = { ...solRpc(), getSignaturesForAddress: vi.fn(async (_address, options, commitment) => {
      expect(commitment).toBe("finalized");
      expect(options.minContextSlot).toBe(361);
      return options.before ? [{ signature: "older", slot: 109, confirmationStatus: "finalized" }] : [{ signature: "unrelated", slot: 120, confirmationStatus: "finalized" }];
    }), getTransaction: vi.fn(async (sig) => ({ slot: 120, meta: { err: null }, transaction: { signatures: [sig, "other-owner"] } })) };
    const rec = { ...solRec, feePayer: "sponsor", tx: null };
    expect((await assessOp(conn, rec, { paceMs: 0 })).verdict).toBe("not_found");
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
  it("does not conclude absence from an empty or unreadable address page", async () => {
    const conn = solRpc();
    const rec = { ...solRec, feePayer: "sponsor", tx: null, searchFromSlot: undefined };
    expect((await assessOp(conn, rec, { paceMs: 0 })).verdict).toBe("pending");
    conn.getSignaturesForAddress.mockRejectedValue(new Error("429"));
    await expect(assessOp(conn, rec, { paceMs: 0 })).rejects.toThrow();
  });
  it("paces the block fallback and resumes only fully read slots after a rate limit", async () => {
    const conn = scanRpc();
    const rec = { ...solRec, feePayer: "sponsor", tx: null, searchedToSlot: undefined };
    const pause = vi.fn(async () => {});
    const progress: unknown[] = [];
    conn.getBlock.mockImplementation(async (slot) => { if (slot === 115) throw new Error("429"); return { blockHeight: slot - 10, transactions: [] }; });
    expect((await assessOp(conn, rec, { pause, onProgress: (patch) => progress.push(patch) })).verdict).toBe("pending");
    expect(rec.searchedToSlot).toBe(114);
    expect(pause).toHaveBeenCalledWith(2000);
    expect(progress).toContainEqual({ searchedToSlot: 114 });
    conn.getBlock.mockClear().mockImplementation(async (slot) => ({ blockHeight: slot - 10, transactions: [] }));
    expect((await assessOp(conn, rec, { paceMs: 0 })).verdict).toBe("not_found");
    expect(conn.getBlock.mock.calls[0][0]).toBe(115);
    expect(conn.getBlock.mock.calls.every(([, options]) => options?.maxSupportedTransactionVersion === 1)).toBe(true);
  });
  it("finishes the fallback when landing blocks contain version 1 transactions", async () => {
    const conn = scanRpc();
    conn.getBlock.mockImplementation(async (slot, options) => {
      if ((options?.maxSupportedTransactionVersion ?? -1) < 1) throw new Error("version 1 transaction unsupported");
      return { blockHeight: slot - 10, transactions: [{ version: 1, transaction: { signatures: ["unrelated-v1"] } }] };
    });
    expect((await assessOp(conn, { ...solRec, feePayer: "sponsor", tx: null }, { paceMs: 0 })).verdict).toBe("not_found");
    expect(conn.getBlock).toHaveBeenCalledTimes(151);
  });
  it("keeps a removed earlier inclusion unknown even after finalized expiry", async () => {
    expect(await assessOp(solRpc(), { ...solRec, inclusionObserved: true })).toMatchObject({ verdict: "pending", reason: expect.stringContaining("Do not pay again") });
  });
  it("does not classify a landed failed transaction as a simulation refusal", async () => {
    const conn = solRpc("finalized");
    conn.getSignatureStatuses.mockResolvedValue({ context: { slot: 361 }, value: [{ confirmationStatus: "finalized", err: { InstructionError: [1, "Custom"] }, slot: 111 }] });
    expect((await assessOp(conn, solRec)).verdict).toBe("failed");
    expect(await refusalIsFinal(conn, solRec)).toBe(false);
  });
});
