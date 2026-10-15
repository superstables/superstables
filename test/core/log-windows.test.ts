// Log searches in windows the RPC accepts: `status` finds an EVM payment through an RPC that caps eth_getLogs, narrows
// its window when the RPC refuses a range, waits when it is rate-limited, and calls a search it could not finish
// unreadable, never "not paid".

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVM_CHAINS } from "../../budget/evm/chains.mjs";
import { BASE_SEPOLIA, EVM_NETWORKS } from "../../src/core/chain.js";
import { recheckChain } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { findAuthorization } from "../../src/core/settlement.js";
import type { Attempt } from "../../src/core/types.js";
import { startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";

const PAYER = `0x${"11".repeat(20)}`;
const RECIPIENT = `0x${"22".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type Refusal = { code: number; message: string } | { status: number; retryAfter?: string };
/** The chain behind an RPC that refuses eth_getLogs wider than `limit` blocks; `refusal` says how. Records each width asked. */
function capped(limit: number, refusal: Refusal = { code: -32614, message: `eth_getLogs is limited to a ${limit} range` }, once?: Refusal) {
  const widths: number[] = [];
  let first = once;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as { id: number; method: string; params: { fromBlock: string; toBlock: string }[] };
    if (call.method === "eth_getLogs") {
      const width = Number(BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) + 1n);
      widths.push(width);
      const r = first ?? (width > limit ? refusal : undefined);
      first = undefined;
      if (r && "status" in r) return new Response("slow down", { status: r.status, headers: r.retryAfter ? { "retry-after": r.retryAfter } : {} });
      if (r) return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: r }), { headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, widths };
}

async function chainWithPayment(blocksAfter: number): Promise<{ chain: FakeBaseSepolia; since: string; validBefore: string; tx: string }> {
  const chain = await startFakeBaseSepolia();
  cleanup.push(() => chain.close());
  const since = new Date(chain.head.timestamp * 1000).toISOString();
  const validBefore = new Date((chain.head.timestamp + 3 * 86_400) * 1000).toISOString();
  chain.advance(blocksAfter * chain.secondsPerBlock);
  const tx = chain.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
  chain.advance(20);
  return { chain, since, validBefore, tx };
}

const find = (c: { chain: FakeBaseSepolia; since: string; validBefore: string }, fetchImpl?: typeof fetch, logSearch?: object) =>
  findAuthorization(
    { network: BASE_SEPOLIA.caip2, payer: PAYER, recipient: RECIPIENT, amountAtomic: "10000", nonce: NONCE, validBefore: c.validBefore, since: c.since },
    { rpcUrl: c.chain.url, ...(fetchImpl ? { fetchImpl } : {}), ...(logSearch ? { logSearch } : {}) } as Parameters<typeof findAuthorization>[1],
  );

describe("the chain tables", () => {
  it("search Base Sepolia in 200-block windows, and agree on every chain's range and block time", () => {
    expect(BASE_SEPOLIA.logRange).toBe(200);
    const budget = EVM_CHAINS as Record<string, { logRange?: number; blockSeconds?: number }>;
    for (const n of EVM_NETWORKS) {
      expect(budget[n.key].logRange ?? 1_000, n.key).toBe(n.logRange);
      expect(budget[n.key].blockSeconds, n.key).toBe(n.blockSeconds);
    }
  });
});

describe("findAuthorization through an RPC that caps eth_getLogs", () => {
  it("finds a payment 450 blocks after the attempt began through a 200-block cap", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(200);
    expect(await find(c, rpc.fetchImpl)).toEqual({ found: true, transaction: c.tx });
    expect(Math.max(...rpc.widths)).toBeLessThanOrEqual(200);
  });

  it("narrows the window when the RPC refuses a range below the chain's known one, and does not skip a block", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(50);
    expect(await find(c, rpc.fetchImpl)).toEqual({ found: true, transaction: c.tx });
    expect(rpc.widths.slice(0, 3)).toEqual([200, 100, 50]);
  });

  it("narrows on a refusal it knows by its words alone", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(50, { code: -32000, message: "block range too large" });
    expect(await find(c, rpc.fetchImpl)).toEqual({ found: true, transaction: c.tx });
  });

  it("waits out a rate limit and reads on", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(200, { code: -32614, message: "limited to a 200 range" }, { status: 429, retryAfter: "0" });
    expect(await find(c, rpc.fetchImpl, { paceMs: 0 })).toEqual({ found: true, transaction: c.tx });
  });

  it("is unreadable, never `never`, when the RPC refuses even the narrowest window", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(5);
    const r = await find(c, rpc.fetchImpl);
    expect(r).toMatchObject({ found: false, unreadable: true, authorizationUsed: true, reason: expect.stringMatching(/could not be searched past block/) });
    expect(r).not.toHaveProperty("never");
    expect(rpc.widths).toEqual([200, 100, 50, 25, 12, 10]);
  });

  it("is unreadable, never `never`, past its span, and reads no more than a day of blocks", async () => {
    const c = await chainWithPayment(50_000); // about 28 hours of Base Sepolia blocks after the attempt began
    const rpc = capped(200);
    const r = await find(c, rpc.fetchImpl);
    expect(r).toMatchObject({ found: false, unreadable: true, authorizationUsed: true, reason: expect.stringMatching(/could not be searched past block/) });
    expect(r).not.toHaveProperty("never");
    expect(rpc.widths.reduce((a, b) => a + b, 0)).toBe(86_400 / BASE_SEPOLIA.blockSeconds);
  });

  it("stops at an RPC error that is not about the range, unreadable", async () => {
    const c = await chainWithPayment(450);
    const rpc = capped(0, { code: -32601, message: "method not found" });
    expect(await find(c, rpc.fetchImpl)).toMatchObject({ found: false, unreadable: true, authorizationUsed: true });
    expect(rpc.widths).toEqual([200]);
  });
});

describe("status through an RPC that caps eth_getLogs", () => {
  it("records the payment it finds as verified", async () => {
    const c = await chainWithPayment(450);
    const dir = mkdtempSync(join(tmpdir(), "superstables-log-windows-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = new Records(dir);
    const attempt: Attempt = {
      id: "a", quoteId: "q", createdAt: c.since, updatedAt: c.since, state: "uncertain", url: "https://seller.example/x",
      terms: { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
      payer: PAYER, authorizationNonce: NONCE, authorizationValidBefore: c.validBefore,
      history: [{ at: c.since, state: "approved" }, { at: c.since, state: "uncertain" }],
    };
    r.saveAttempt(attempt);
    const rpc = capped(200);
    expect(await recheckChain(r, "a", { rpcUrlFor: () => c.chain.url, fetchImpl: rpc.fetchImpl })).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: c.tx });
  });
});

describe("searchLogs", () => {
  it("covers every block once, in order, and says whether it covered the span", async () => {
    const { searchLogs } = await import("../../src/core/log-windows.mjs");
    const seen: [bigint, bigint][] = [];
    const r = await searchLogs(async (a: bigint, b: bigint) => (seen.push([a, b]), []), { from: 10n, to: 509n, window: 200, blockSeconds: 2 }, async () => undefined);
    expect(seen).toEqual([[10n, 209n], [210n, 409n], [410n, 509n]]);
    expect(r).toMatchObject({ covered: true, searchedTo: 509n, calls: 3 });
  });
  it("stops at its call budget, incomplete", async () => {
    const { searchLogs } = await import("../../src/core/log-windows.mjs");
    const r = await searchLogs(async () => [], { from: 0n, to: 100_000n, window: 10, blockSeconds: 2 }, async () => undefined);
    expect(r).toMatchObject({ covered: false, calls: 400, searchedTo: 3_999n });
  });
  it("honours Retry-After and keeps a pace after the RPC limited it", async () => {
    const { searchLogs } = await import("../../src/core/log-windows.mjs");
    let t = 0;
    const waits: number[] = [];
    let calls = 0;
    const read = async () => { calls += 1; if (calls === 1) throw Object.assign(new Error("HTTP 429"), { status: 429, retryAfterMs: 5_000 }); return []; };
    const r = await searchLogs(read, { from: 0n, to: 599n, window: 200, blockSeconds: 2 }, async () => undefined, { now: () => t, pause: async (ms: number) => { waits.push(ms); t += ms; } });
    expect(r).toMatchObject({ covered: true, calls: 4 });
    expect(waits).toEqual([5_000, 2_000, 2_000]);
  });
});
