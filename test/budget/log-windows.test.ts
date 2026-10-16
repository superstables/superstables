// The budget's EVM log searches (budget/evm/ops.ts, budget/evm/owner.ts) through an RPC that caps eth_getLogs: they read
// in windows the RPC accepts, narrow on a refusal, cover a bounded span, and a search they could not finish is unread,
// never "not found". The RPC's answers are replaced in-process, as in chain-finality.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcRequestError, encodeEventTopics, parseAbi, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agreedFromClient } from "../helpers/agree-from-client.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";
const PULL: Hex = `0x${"ab".repeat(32)}`;
const SETTLE: Hex = `0x${"cd".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"ee".repeat(32)}`;
const NONCE: Hex = `0x${"ef".repeat(32)}`;
const HEAD = 1_000_000n;

let dir: string;
let limit = 200;
let widths: number[] = [];
/** Logs on the chain, by event name. */
let logs: Record<string, { blockNumber: bigint; transactionHash: Hex; args?: Record<string, unknown> }[]> = {};
const refuse = () => new RpcRequestError({ body: { method: "eth_getLogs" }, url: "http://127.0.0.1", error: { code: -32614, message: `eth_getLogs is limited to a ${limit} range` } });
const rpc = {
  getBlockNumber: vi.fn(async () => HEAD),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint }) => ({ number: blockNumber ?? HEAD, timestamp: 2_000_000_000n, hash: BLOCK_HASH, transactions: [] })),
  readContract: vi.fn(async () => true),
  getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => ({ hash, from: AGENT, nonce: 7 })),
  getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => ({ transactionHash: hash, blockNumber: HEAD - 10n, blockHash: BLOCK_HASH, status: "success", logs: [] as unknown[] })),
  getLogs: vi.fn(async ({ event, fromBlock, toBlock }: { event: { name: string }; fromBlock: bigint; toBlock: bigint }) => {
    const width = Number(toBlock - fromBlock + 1n);
    widths.push(width);
    if (width > limit) throw refuse();
    return (logs[event.name] ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock).map((l) => ({ ...l, blockHash: BLOCK_HASH, removed: false, address: TOKEN }));
  }),
};
const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)", "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);
const settlementLogs = [
  { address: TOKEN, topics: encodeEventTopics({ abi, eventName: "AuthorizationUsed", args: { authorizer: AGENT, nonce: NONCE } }), data: "0x" },
  { address: TOKEN, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: AGENT, to: TO } }), data: `0x${10000n.toString(16).padStart(64, "0")}` },
];
const journal = (over: Record<string, unknown> = {}) => ({ op: "lw-test", rail: "base-sepolia", path: "approve", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: "https://seller.example", owner: OWNER, agent: AGENT, token: TOKEN, max: "1", pullTx: PULL, pullNonce: 7, pullBlock: String(HEAD - 2_000n), signed: true, auth: { from: AGENT, to: TO, value: "10000", nonce: NONCE, validBefore: 1000, validAfter: 0 }, delivered: null, notes: [], ...over });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-log-windows-"));
  vi.resetModules();
  limit = 200;
  widths = [];
  logs = {};
  delete process.env.B4_CHAIN;
  // Tests below replace these two; mockReset puts back the implementations given to vi.fn above.
  rpc.getTransactionReceipt.mockReset();
  rpc.getTransaction.mockReset();
  vi.doMock("../../budget/evm/lib.js", async (original) => ({ ...await original<object>(), OPS_DIR: dir, publicClient: rpc, ...agreedFromClient(rpc, TOKEN), USDC: TOKEN, sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f() }));
});
afterEach(() => { vi.doUnmock("../../budget/evm/lib.js"); rmSync(dir, { recursive: true, force: true }); });
const ops = () => import(new URL("../../budget/evm/ops.ts", import.meta.url).href);
const owner = () => import(new URL("../../budget/evm/owner.ts", import.meta.url).href);

describe("findApproval (a replaced grant or revoke)", () => {
  it("finds the approval 450 blocks after the request through a 200-block cap", async () => {
    logs.Approval = [{ blockNumber: HEAD - 1_000n + 450n, transactionHash: SETTLE, args: { owner: OWNER, spender: AGENT, value: 5n } }];
    await expect((await owner()).findApproval(OWNER, AGENT, HEAD - 1_000n)).resolves.toEqual({ hash: SETTLE, value: 5n });
    expect(Math.max(...widths)).toBeLessThanOrEqual(200);
  });
  it("takes no approval when it could not read every block, rather than throw", async () => {
    limit = 5;
    logs.Approval = [{ blockNumber: HEAD - 1_000n + 450n, transactionHash: SETTLE, args: { owner: OWNER, spender: AGENT, value: 5n } }];
    await expect((await owner()).findApproval(OWNER, AGENT, HEAD - 1_000n)).resolves.toBeNull();
  });
});

describe("readSettlement (reconcile's settlement lookup)", () => {
  it("finds the settlement through an RPC that caps eth_getLogs below 100 blocks", async () => {
    limit = 50;
    logs.AuthorizationUsed = [{ blockNumber: HEAD - 2_000n + 450n, transactionHash: SETTLE }];
    rpc.getTransactionReceipt.mockImplementationOnce(async ({ hash }) => ({ transactionHash: hash, blockNumber: HEAD - 2_000n + 450n, blockHash: BLOCK_HASH, status: "success", logs: settlementLogs }));
    expect(await (await ops()).readSettlement(journal())).toMatchObject({ kind: "used", settleTx: SETTLE, transferOk: true });
    expect(widths.slice(0, 3)).toEqual([200, 100, 50]);
  });
  it("is unread, not pending, when the span is more than a day of blocks", async () => {
    const s = await (await ops()).readSettlement(journal({ pullBlock: String(HEAD - 100_000n) }));
    expect(s).toMatchObject({ kind: "unread", used: false, reason: expect.stringMatching(/could not be read/) });
    expect(widths.reduce((a, b) => a + b, 0)).toBe(2 * 43_200);
  });
});

describe("reconcile's search for a transaction that replaced the pull", () => {
  it("finds a replacement 6,000 blocks after the operation began through a 200-block cap", async () => {
    const REPLACEMENT: Hex = `0x${"98".repeat(32)}`;
    const start = HEAD - 10_000n;
    logs.Transfer = [{ blockNumber: start + 6_000n, transactionHash: REPLACEMENT }];
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => (hash === PULL ? null : { transactionHash: hash, blockNumber: start + 6_000n, blockHash: BLOCK_HASH, status: "success", logs: [] }) as never);
    rpc.getTransaction.mockImplementation(async ({ hash }) => { if (hash === PULL) throw new Error("not in the pool"); return { hash, from: AGENT, nonce: 7 }; });
    const result = await (await ops()).reconcileJournal(journal({ pullBlock: String(start) }), { quiet: true });
    expect(result.verdict).toBe("not_found");
    expect(result.j.reason).toContain(REPLACEMENT);
  });
});

describe("reconcile's search for a transaction that replaced the pull, when it cannot finish", () => {
  it("is unknown, never not_found, when the RPC refuses even the narrowest window", async () => {
    limit = 5;
    const REPLACEMENT: Hex = `0x${"98".repeat(32)}`;
    const start = HEAD - 10_000n;
    logs.Transfer = [{ blockNumber: start + 6_000n, transactionHash: REPLACEMENT }];
    rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => (hash === PULL ? null : { transactionHash: hash, blockNumber: start + 6_000n, blockHash: BLOCK_HASH, status: "success", logs: [] }) as never);
    rpc.getTransaction.mockImplementation(async ({ hash }) => { if (hash === PULL) throw new Error("not in the pool"); return { hash, from: AGENT, nonce: 7 }; });
    const result = await (await ops()).reconcileJournal(journal({ pullBlock: String(start) }), { quiet: true });
    expect(result.verdict).toBe("unknown");
    expect(Math.min(...widths)).toBe(10);
  });
});
