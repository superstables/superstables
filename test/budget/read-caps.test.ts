// What a chain, an owner page on this computer or a library may make the budget half hold in memory, and what its error text may
// do to a terminal. An answer past its cap is a failed read, never parsed; RPC error text is one short line. No spawned
// processes: fetch is replaced with streams that count what was pulled from them and whether they were cancelled.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const OWNER = `0x${"22".repeat(20)}` as const;
const RECIPIENT = `0x${"33".repeat(20)}` as const;
const MEMO = `0x${"44".repeat(32)}` as const;
const ESC = "\u001b";
const BEL = "\u0007";

let home: string;
// The rails' TypeScript sources are loaded by URL, as chain-finality.test.ts does: tsc does not take them into this project.
const load = (path: string): Promise<any> => import(new URL(path, import.meta.url).href);
let chain: any;
let common: any;
let resolve: any;
let rpc: typeof import("../../budget/rpc.mjs");
let evm: any;
let solana: typeof import("../../budget/solana/lib.mjs");
let approvals: typeof import("../../budget/approvals.mjs");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "superstables-read-caps-"));
  // paths.mjs reads the home once, and the rails read their RPC once, when each is first imported
  process.env.SUPERSTABLES_HOME = home;
  process.env.B4_RPC = "http://127.0.0.1:9/";
  chain = await load("../../budget/tempo/lib/chain.ts");
  common = await load("../../budget/tempo/lib/common.ts");
  resolve = await load("../../budget/tempo/lib/resolve.ts");
  rpc = await import("../../budget/rpc.mjs");
  evm = await load("../../budget/evm/lib.ts");
  solana = await import("../../budget/solana/lib.mjs");
  approvals = await import("../../budget/approvals.mjs");
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** What the streams of one `big` answer saw: the most any one of them was asked for, and how many were cancelled. */
type Counters = { pulled: number; cancelled: number; streams: number };

/**
 * An answer that is `head`, then `padBytes` of "x" in 64 KB chunks, then `tail`, made fresh for each call of `response()`. A
 * chunk is produced only when the reader asks for one, so `pulled` is what the code under test read, to within one chunk.
 */
function big(head: string, padBytes: number, tail: string): { counters: Counters; response: (status?: number) => Response } {
  const counters: Counters = { pulled: 0, cancelled: 0, streams: 0 };
  const enc = new TextEncoder();
  return {
    counters,
    response(status = 200) {
      counters.streams++;
      let mine = 0;
      let phase = 0;
      let sent = 0;
      const out = (c: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array) => { mine += bytes.length; counters.pulled = Math.max(counters.pulled, mine); c.enqueue(bytes); };
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (phase === 0) { out(c, enc.encode(head)); phase = 1; return; }
          if (phase === 1) {
            const n = Math.min(64 * 1024, padBytes - sent);
            if (n > 0) { sent += n; out(c, new Uint8Array(n).fill(120)); }
            if (sent >= padBytes) phase = 2;
            return;
          }
          out(c, enc.encode(tail));
          c.close();
        },
        cancel() { counters.cancelled++; },
      }, { highWaterMark: 0 });
      return new Response(stream, { status, headers: { "content-type": "application/json" } });
    },
  };
}

/** A JSON-RPC answer padded to about `bytes` bytes. */
const padded = (bytes: number, result: unknown = "0x1") => big(`{"jsonrpc":"2.0","id":1,"result":${JSON.stringify(result)},"pad":"`, bytes, `"}`);

/** Replace fetch with `answer`, which gets the parsed JSON-RPC request(s) and returns the Response (or a body to send). */
function rpcStub(answer: (call: { id: number; method: string; params: any[] }) => unknown): { calls: { method: string; params: any[] }[]; count: (method: string) => number } {
  const calls: { method: string; params: any[] }[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const one = (c: any) => { calls.push({ method: c.method, params: c.params }); return answer(c); };
    if (Array.isArray(body)) return new Response(JSON.stringify(body.map(one)), { headers: { "content-type": "application/json" } });
    const got = one(body);
    return got instanceof Response ? got : new Response(JSON.stringify(got), { headers: { "content-type": "application/json" } });
  });
  return { calls, count: (method) => calls.filter((c) => c.method === method).length };
}
const ok = (c: { id: number }, result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
const fail = (c: { id: number }, message: string, code = -32000, data?: unknown) => ({ jsonrpc: "2.0", id: c.id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const whole = (err: any) => `${err?.message ?? ""}\n${err?.details ?? ""}\n${err?.shortMessage ?? ""}`;

describe("Tempo reads (budget/tempo/lib/chain.ts)", () => {
  it("1. a 6 MB answer to rpcRead is a failed read, pulled only as far as the cap, and cancelled", async () => {
    const b = padded(6_000_000);
    vi.stubGlobal("fetch", async () => b.response());
    await expect(chain.rpcRead("eth_blockNumber", [])).rejects.toThrow(/eth_blockNumber: the RPC answer was cut off or longer than 4000000 bytes/);
    expect(b.counters.streams).toBe(1);
    expect(b.counters.pulled).toBeLessThan(4_300_000);
    expect(b.counters.cancelled).toBeGreaterThan(0);
  });

  it("2. an error message carrying escape sequences reaches the caller as one short line", async () => {
    rpcStub((c) => fail(c, `execution reverted ${ESC}]0;pwn${BEL} ${ESC}[2J`, 3));
    const err = await chain.rpcRead("eth_call", []).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("execution reverted");
    expect(err?.message).not.toContain(ESC);
    expect(err?.message).not.toContain(BEL);
  });

  it("3. an answer that is not JSON is reported as such, not as a parser's quote of it", async () => {
    vi.stubGlobal("fetch", async () => new Response("Node.js v22 <html>", { status: 200 }));
    const err = await chain.rpcRead("eth_chainId", []).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/eth_chainId: the RPC answer is not JSON/);
    expect(err?.message).not.toMatch(/Unexpected token|Node\.js/);
  }, 20_000);

  it("4. a 6 MB answer to rpcWrite is a failed write", async () => {
    const b = padded(6_000_000, ["0x" + "ab".repeat(32)]);
    vi.stubGlobal("fetch", async () => b.response());
    await expect(chain.rpcWrite("tempo_fundAddress", [OWNER])).rejects.toThrow(/longer than 4000000/);
    expect(b.counters.pulled).toBeLessThan(4_300_000);
  });
});

describe("jsonRpc (budget/rpc.mjs)", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
  });
  async function serve(status: number, body: string): Promise<string> {
    const server = createServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body); });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("5. an error message carrying escape sequences is one short line", async () => {
    const url = await serve(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `node says ${ESC}[31mRED${ESC}[0m${BEL}` } }));
    const err = await rpc.jsonRpc(url, "eth_chainId").then(() => null, (e: Error) => e);
    expect(err?.message).toContain("node says");
    expect(err?.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it("6. an answer that is not JSON is named so, with the HTTP status when it is not 200", async () => {
    await expect(rpc.jsonRpc(await serve(200, "<html>"), "eth_chainId")).rejects.toThrow(/^the RPC answer is not JSON$/);
    await expect(rpc.jsonRpc(await serve(502, "<html>"), "eth_chainId")).rejects.toThrow(/^the RPC answer is not JSON \(HTTP 502\)$/);
  });

  it("7. a JSON answer that is not an object is not a JSON-RPC answer", async () => {
    await expect(rpc.jsonRpc(await serve(200, "null"), "eth_chainId")).rejects.toThrow(/^the RPC answer is not a JSON-RPC answer$/);
  });
});

describe("cappedRpcFetch (budget/rpc.mjs)", () => {
  const rpcCapped500 = () => rpc.cappedRpcFetch(4_000_000, async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "reverted", data: "0x" + "ab".repeat(900) } }), { status: 500, headers: { "content-type": "application/json" } }));
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

  it("8. an answer longer than the cap throws, pulled only as far as the cap, and cancelled", async () => {
    const b = padded(6_000_000);
    const capped = rpc.cappedRpcFetch(4_000_000, async () => b.response());
    await expect(capped("http://127.0.0.1:1/", {})).rejects.toThrow(/cut off or longer than 4000000 bytes/);
    expect(b.counters.pulled).toBeLessThan(4_300_000);
    expect(b.counters.cancelled).toBe(1);
  });

  it("9. a 200 answer that is not JSON throws", async () => {
    const capped = rpc.cappedRpcFetch(4_000_000, async () => new Response("<html>", { status: 200 }));
    await expect(capped("http://127.0.0.1:1/", {})).rejects.toThrow(/^the RPC answer is not JSON$/);
  });

  it("10. an error message is shortened, and the status, headers and error data are kept", async () => {
    const capped = rpc.cappedRpcFetch(4_000_000, async () => json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `a${ESC}[31mb`, data: "0x08c379a0" } }, { status: 200, statusText: "OK", headers: { "content-type": "application/json", "content-length": "9999" } }));
    const res = await capped("http://127.0.0.1:1/", {});
    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-length")).toBeNull();
    const body = await res.json();
    expect(body.error.message).toBe("a [31mb");
    expect(body.error.data).toBe("0x08c379a0");
  });

  it("11. a failed answer with a long text becomes at most 1,000 characters without escapes", async () => {
    const capped = rpc.cappedRpcFetch(4_000_000, async () => new Response(`${ESC}[2J${"y".repeat(5000)}`, { status: 500, statusText: "Internal Server Error" }));
    const res = await capped("http://127.0.0.1:1/", {});
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).not.toContain(ESC);
  });

  it("11b. a failed JSON-RPC answer still over 1,000 bytes is text, not the JSON it was cut from", async () => {
    const capped = rpcCapped500();
    const res = await capped("http://127.0.0.1:1/", {});
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect((await res.text()).length).toBeLessThanOrEqual(1000);
  });

  it("12. every message in a batch is shortened, and a result is unchanged", async () => {
    const capped = rpc.cappedRpcFetch(4_000_000, async () => json([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `${BEL}x` } }, { jsonrpc: "2.0", id: 2, result: "0x1" }]));
    const body = await (await capped("http://127.0.0.1:1/", {})).json();
    expect(body[0].error.message).toBe("x");
    expect(body[1]).toEqual({ jsonrpc: "2.0", id: 2, result: "0x1" });
  });
});

describe("EVM viem client (budget/evm/lib.ts)", () => {
  it("13. an RPC error carrying escape sequences reaches viem's error as one short line", async () => {
    rpcStub((c) => fail(c, `bad ${ESC}]0;pwn${BEL}${ESC}[31mred`));
    const err = await evm.publicClient.getBlockNumber().then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect(whole(err)).not.toContain(ESC);
    expect(whole(err)).not.toContain(BEL);
  });

  it("14. an 11 MB answer is a failed read, pulled only as far as the cap", async () => {
    const b = padded(11_000_000);
    vi.stubGlobal("fetch", async () => b.response());
    await expect(evm.publicClient.getBlockNumber()).rejects.toThrow();
    expect(b.counters.pulled).toBeLessThan(10_800_000);
    expect(b.counters.cancelled).toBeGreaterThan(0);
  }, 40_000);

  it("15. an answer that is not JSON is named so in viem's error", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    const err: any = await evm.publicClient.getBlockNumber().then(() => null, (e: unknown) => e);
    expect(err?.details).toBe("the RPC answer is not JSON");
  }, 40_000);

  it("15b. the wallet client reads through the same cap and the same words", async () => {
    rpcStub((c) => fail(c, `bad ${ESC}[2J`));
    const { client } = evm.walletFor(`0x${"11".repeat(32)}`);
    const err = await client.request({ method: "eth_chainId" }).then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    expect(whole(err)).not.toContain(ESC);
  });
});

describe("Tempo viem client (budget/tempo/lib/common.ts makeClient)", () => {
  it("16. a 6 MB answer is a failed read", async () => {
    const b = padded(6_000_000);
    vi.stubGlobal("fetch", async () => b.response());
    const err = await common.makeClient().request({ method: "eth_blockNumber" } as any).then(() => null, (e: unknown) => e);
    expect(whole(err)).toMatch(/longer than 4000000/);
    expect(b.counters.pulled).toBeLessThan(4_300_000);
  }, 40_000);
});

describe("Solana connection (budget/solana/lib.mjs)", () => {
  it("17. a 17 MB answer is a failed read, pulled only as far as the cap", async () => {
    const b = padded(17_000_000, 1);
    vi.stubGlobal("fetch", async () => b.response());
    await expect(solana.connection().getSlot()).rejects.toThrow(/longer than 16000000 bytes/);
    expect(b.counters.pulled).toBeLessThan(16_300_000);
  });

  it("18. an RPC error carrying escape sequences reaches the library's error as one short line", async () => {
    rpcStub((c) => fail(c, `bad ${ESC}]0;pwn${BEL}${ESC}[31mred`));
    const err = await solana.connection().getSlot().then(() => null, (e: Error) => e);
    expect(err).toBeTruthy();
    expect(whole(err)).not.toContain(ESC);
    expect(whole(err)).not.toContain(BEL);
  });
});

describe("owner page on this computer (budget/approvals.mjs)", () => {
  it("19. pageState gives null for a 10 MB answer, reads about a cap of it, and cancels", async () => {
    const b = big(`{"status":"pending","pad":"`, 10_000_000, `"}`);
    vi.stubGlobal("fetch", async () => b.response());
    expect(await approvals.pageState("http://127.0.0.1:1/x")).toBeNull();
    expect(b.counters.pulled).toBeLessThan(400_000);
    expect(b.counters.cancelled).toBeGreaterThan(0);
  });

  it("20. cancelPage gives null for a 10 MB answer, so a --replace does not go ahead on it", async () => {
    const b = big(`{"cancelled":true,"pad":"`, 10_000_000, `"}`);
    vi.stubGlobal("fetch", async () => b.response());
    expect(await approvals.cancelPage("http://127.0.0.1:1/x", "oa-test")).toBeNull();
    expect(b.counters.pulled).toBeLessThan(400_000);
  });

  it("21. cancelPage gives a status without escape sequences", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ cancelled: false, status: `${ESC}[2Jsending` }), { status: 409, headers: { "content-type": "application/json" } }));
    const got = await approvals.cancelPage("http://127.0.0.1:1/x", "oa-test");
    expect(got?.cancelled).toBe(false);
    expect(got?.status).toBe("[2Jsending");
    expect(got?.status).not.toContain(ESC);
  });
});

describe("Tempo memo search", () => {
  /** A chain at head `head` whose block `edge` (any numbered block) has timestamp `edgeTime`; eth_getLogs answers `logs`. */
  function chainAt(head: number, edgeTime: number, logs: unknown = []) {
    return rpcStub((c) => {
      if (c.method === "eth_getBlockByNumber") {
        const latest = c.params[0] === "latest" || c.params[0] === "finalized";
        return ok(c, latest ? { number: "0x" + head.toString(16), timestamp: "0xf423f" } : { number: c.params[0], hash: "0x" + "ab".repeat(32), timestamp: "0x" + edgeTime.toString(16) });
      }
      if (c.method === "eth_chainId") return ok(c, "0xa5bf"); // the endpoints that confirm an expired payment are asked which chain they are on
      if (c.method === "eth_getLogs") return ok(c, logs);
      return fail(c, "unexpected " + c.method);
    });
  }

  it("22. a search that cannot reach the payment's last moment fails before any log call", async () => {
    const stub = chainAt(5_000_000, 2000);
    await expect(chain.findByMemo(OWNER, RECIPIENT, MEMO, 0n)).rejects.toThrow(/not searched past block 1999999/);
    expect(stub.count("eth_getLogs")).toBe(0);
  });

  it("23. a search whose last block is later than `until` makes 20 calls and finds nothing", async () => {
    const stub = chainAt(5_000_000, 2000);
    expect(await chain.findByMemo(OWNER, RECIPIENT, MEMO, 0n, 1000)).toEqual([]);
    expect(stub.count("eth_getLogs")).toBe(20);
    expect(stub.calls.filter((c) => c.method === "eth_getLogs").at(-1)?.params[0].toBlock).toBe("0x1e847f");
  });

  it("24. a search whose last block is not later than `until` fails", async () => {
    chainAt(5_000_000, 2000);
    await expect(chain.findByMemo(OWNER, RECIPIENT, MEMO, 0n, 3000)).rejects.toThrow(/not searched past block/);
  });

  it("25. a short chain is searched whole, in two windows", async () => {
    const stub = chainAt(150_000, 0);
    expect(await chain.findByMemo(OWNER, RECIPIENT, MEMO, 0n)).toEqual([]);
    expect(stub.count("eth_getLogs")).toBe(2);
  });

  it("26. a log answer that is not a list is a failed read", async () => {
    chainAt(150_000, 0, {});
    await expect(chain.findByMemo(OWNER, RECIPIENT, MEMO, 0n)).rejects.toThrow(/not a list of logs/);
  });

  const op = (validBefore: number) => ({ memo: MEMO, startBlock: "0", validBefore, intent: { owner: OWNER, recipient: RECIPIENT } }) as any;

  it("27. lookupOnce calls a payment expired once the span covered its last moment, in at most 40 log calls", async () => {
    const stub = chainAt(5_000_000, 2000);
    expect(await resolve.lookupOnce(op(1000))).toEqual({ kind: "expired" });
    expect(stub.count("eth_getLogs")).toBeLessThanOrEqual(40);
  });

  it("28. lookupOnce stays pending, with no log call, when the span cannot cover the payment's last moment", async () => {
    const stub = chainAt(5_000_000, 2000);
    expect(await resolve.lookupOnce(op(3000))).toEqual({ kind: "pending" });
    expect(stub.count("eth_getLogs")).toBe(0);
  });

  it("28b. lookupOnce never calls a payment expired when its last search ends at a head before validBefore (a lagging RPC node)", async () => {
    const heads = [{ n: 100, ts: 990 }, { n: 200, ts: 2000 }, { n: 100, ts: 990 }];
    let i = 0;
    rpcStub((c) => {
      if (c.method === "eth_getBlockByNumber") { const h = heads[Math.min(i++, heads.length - 1)]; return ok(c, { number: "0x" + h.n.toString(16), timestamp: "0x" + h.ts.toString(16) }); }
      if (c.method === "eth_getLogs") return ok(c, []);
      return fail(c, "unexpected " + c.method);
    });
    expect(await resolve.lookupOnce(op(1000))).toEqual({ kind: "pending" });
  });
});
