// What a site or an RPC may make the budget code hold in memory: budget/site.mjs call() reads at most 1 MB, jsonRpc() at most 4 MB.
// An answer past the cap is a failed read, never parsed. Loopback servers only.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HostedApprovals, HostedRefusal } from "../../budget/hosted.js";
import { jsonRpc } from "../../budget/rpc.mjs";
import { call, cancelSiteRequest, listSiteServices } from "../../budget/site.mjs";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
});

/** A server whose answer is `head`, then `total` bytes of spaces. Counts what it handed to the socket, and whether it got to the end. */
async function spaces(total: number, head = "", status = 200): Promise<{ url: string; written: () => number; finished: () => boolean }> {
  let written = 0;
  let finished = false;
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, 32);
    let sent = 0;
    const next = (): void => {
      while (sent < total && !res.destroyed) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        written += n;
        if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void res.once("drain", next);
      }
      if (!res.destroyed) res.end("{}");
    };
    res.on("finish", () => (finished = true));
    res.on("error", () => {});
    res.write(head);
    next();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, written: () => written, finished: () => finished };
}

async function json(body: unknown): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("a site answer longer than the cap", () => {
  it("is a failed read: not ok, no body, and the server is not read to the end", async () => {
    // 100 MB offered. Loopback socket buffers hold a few MB, so a reader that stopped at the cap leaves most of it unwritten.
    const big = await spaces(100_000_000);
    const r = await call(`${big.url}/x`, {}, 15_000);
    expect(r).toMatchObject({ ok: false, status: 200, body: null, network: expect.stringMatching(/longer than/) });
    expect(r.network).toContain("127.0.0.1:");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(big.finished()).toBe(false);
    expect(big.written()).toBeLessThan(25_000_000);
  });

  it("makes the service list fail and a cancel not count as cancelled", async () => {
    const big = await spaces(5_000_000, '{"services":[');
    expect(await listSiteServices({ site: big.url })).toMatchObject({ ok: false });
    const cancelled = await cancelSiteRequest({ site: big.url, id: "ba_test1234", token: "ssbt_testtoken1234" });
    expect(cancelled?.cancelled).not.toBe(true);
  });

  it("still parses a normal small answer", async () => {
    const url = await json({ services: [{ name: "Weather", url: "https://seller.example/api", network: "eip155:84532" }] });
    const r = await call(`${url}/x`, {}, 15_000);
    expect(r.ok).toBe(true);
    expect(r.body.services).toHaveLength(1);
    expect(await listSiteServices({ site: url, chainByNetwork: { "eip155:84532": "base-sepolia" } })).toMatchObject({ ok: true });
  });

  it("keeps the status and no body for a non-JSON answer within the cap", async () => {
    const server = createServer((_req, res) => res.writeHead(502).end("bad gateway"));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const r = await call(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, {}, 15_000);
    expect(r).toEqual({ ok: false, status: 502, body: null, unread: true });
  });
});

describe("the site's answer to creating a request, longer than the cap", () => {
  const KEY = `0x${"11".repeat(32)}` as const;
  const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };

  for (const status of [201, 409]) {
    it(`is a refusal, not a body read whole or an empty one (${status})`, async () => {
      const big = await spaces(100_000_000, '{"id":"ba_test1234","state":"awaiting_owner","token":"ssbt_testtoken1234","', status);
      const err = await new HostedApprovals({ site: big.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 })
        .request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 })
        .catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.message).toMatch(/cut off or longer than 1000000 bytes, so it was not read; nothing was sent/);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(big.finished()).toBe(false);
      expect(big.written()).toBeLessThan(25_000_000);
    });
  }
});

describe("an RPC answer longer than the cap", () => {
  it("rejects", async () => {
    const big = await spaces(5_000_000, '{"jsonrpc":"2.0","id":1,"result":"');
    await expect(jsonRpc(big.url, "eth_chainId")).rejects.toThrow(/cut off or longer than 4000000 bytes/);
  });

  it("still returns the result of a normal answer, and still throws an RPC error", async () => {
    const ok = await json({ jsonrpc: "2.0", id: 1, result: "0x14a34" });
    expect(await jsonRpc(ok, "eth_chainId")).toBe("0x14a34");
    const err = await json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no such method" } });
    await expect(jsonRpc(err, "nope")).rejects.toThrow("no such method");
  });
});
