// Reading an RPC's refusals: a rate limit is waited for, a range limit narrows the window, and a JSON-RPC error inside an HTTP
// 4xx answer is read rather than lost.

import { afterEach, describe, expect, it } from "vitest";
import { rangeRefusal, rateRefusal, searchLogs } from "../../src/core/log-windows.mjs";
import { rateLimited, rpcCall, RpcError } from "../../src/core/rpc.js";
import { TEMPO_MODERATO } from "../../src/core/chain.js";
import { tempoRail } from "../../src/core/rails/tempo.js";
import { startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { readBody, sendJson, startServer, type TestServer } from "../helpers/servers.js";

const cleanup: TestServer[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!.close();
});
const serve = async (status: number, body: unknown) => {
  const s = await startServer(async (req, res) => {
    await readBody(req);
    sendJson(res, status, body);
  });
  cleanup.push(s);
  return s;
};

describe("range and rate words", () => {
  it("tells a rate limit from a range limit", () => {
    expect(rangeRefusal(-32005, "rate limit exceeded")).toBe(false);
    expect(rateRefusal(-32005, "rate limit exceeded")).toBe(true);
    expect(rangeRefusal(undefined, "too many requests")).toBe(false);
    expect(rangeRefusal(-32005, "query returned more than 10000 results")).toBe(true);
    expect(rangeRefusal(-32614, "eth_getLogs is limited to a 200 range")).toBe(true);
  });

  it("reads the JSON-RPC error inside an HTTP 400", async () => {
    const s = await serve(400, { jsonrpc: "2.0", id: 1, error: { code: -32614, message: "eth_getLogs is limited to a 200 range" } });
    const err: any = await rpcCall(s.url, "eth_getLogs", []).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32614, rangeRefused: true, status: 400 });
    expect(err.message).not.toMatch(/200 range/);
  });

  it("reads a rate limit inside an HTTP 429 answer", async () => {
    const s = await serve(429, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "daily request count exceeded" } });
    expect(rateLimited(await rpcCall(s.url, "eth_blockNumber", []).catch((e) => e))).toBe(true);
  });

  it("waits for a rate limit instead of halving the window", async () => {
    const widths: bigint[] = [];
    let first = true;
    const pauses: number[] = [];
    const found = await searchLogs<number, string>(
      async (from, to) => {
        widths.push(to - from + 1n);
        if (first) {
          first = false;
          throw new RpcError("the RPC answered with an error", undefined, -32005, undefined, rangeRefusal(-32005, "daily request count exceeded"), rateRefusal(-32005, "daily request count exceeded"));
        }
        return [1];
      },
      { from: 0n, to: 99n, window: 100, blockSeconds: 1 },
      async (logs) => (logs.length ? "hit" : undefined),
      { pause: async (ms) => void pauses.push(ms) },
    );
    expect(found.found).toBe("hit");
    expect(pauses.length).toBe(1);
    expect(widths).toEqual([100n, 100n]);
  });

  it("Tempo narrows its log window when the RPC refuses a range, and finds a payment 60,000 blocks on", async () => {
    const chain = await startFakeTempoPay();
    cleanup.push(chain);
    const memo = `0x${"55".repeat(32)}` as `0x${string}`;
    const payer = `0x${"11".repeat(20)}`;
    const recipient = `0x${"22".repeat(20)}`;
    const boundary = chain.head.number - 60_000n;
    chain.mine({ from: payer, to: recipient, amount: 10_000n, memo, token: TEMPO_MODERATO.token.address });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { id: number; method: string; params: { fromBlock: string; toBlock: string }[] };
      if (call.method === "eth_getLogs" && BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) + 1n > 20_000n) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32005, message: "block range too large" } }), { status: 200 });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const found = await tempoRail.findPayment!(
      { network: TEMPO_MODERATO.caip2, payer, recipient, amountAtomic: "10000", memo, searchFromBlock: boundary.toString(), since: new Date().toISOString() },
      { rpcUrlFor: () => chain.url, fetchImpl },
    );
    expect(found).toMatchObject({ found: true });
  });
});
