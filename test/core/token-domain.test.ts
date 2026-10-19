// Before `pay` asks anyone to sign on an EVM chain, it checks once per process that the token contract answers
// DOMAIN_SEPARATOR() with the domain the chain table states. Each case runs against an RPC on this computer.

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainSeparator } from "viem";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_SEPOLIA, type EvmNetwork } from "../../src/core/chain.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { SignRefused, type Signer } from "../../src/core/signer/types.js";
import * as domain from "../../src/core/token-domain.js";
import { startPaidEndpoint } from "../helpers/paid-endpoint.js";
import { randomAddress, startFakeDevnet, startSolanaSeller } from "../helpers/fake-solana-pay.js";
import { startFakeMppSeller, startFakeTempoPay } from "../helpers/fake-tempo-pay.js";

// The module as the engine sees it, with a count of how often pay asked it.
const asked = vi.hoisted(() => ({ n: 0 }));
vi.mock("../../src/core/token-domain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/token-domain.js")>();
  return { ...real, tokenDomainProblem: (...a: Parameters<typeof real.tokenDomainProblem>) => { asked.n++; return real.tokenDomainProblem(...a); } };
});

const { tokenDomainProblem, forgetTokenDomains } = domain as typeof import("../../src/core/token-domain.js");
const cleanups: (() => unknown)[] = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
beforeEach(() => forgetTokenDomains?.());

const RIGHT = domainSeparator({ domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: BASE_SEPOLIA.token.address } });
const WRONG = domainSeparator({ domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: BASE_SEPOLIA.token.address } });

type Rpc = { url: string; calls: { method: string; to?: string; data?: string }[]; chainId: string; separator: string; down: boolean };
async function rpc(o: Partial<Rpc> = {}): Promise<Rpc> {
  const state: Rpc = { url: "", calls: [], chainId: "0x14a34", separator: RIGHT, down: false, ...o };
  const server: Server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const call = JSON.parse(b);
      state.calls.push({ method: call.method, to: call.params?.[0]?.to, data: call.params?.[0]?.data });
      if (state.down) { res.writeHead(503); res.end("down"); return; }
      const result = call.method === "eth_chainId" ? state.chainId : call.method === "eth_call" && call.params[0].data === "0x3644e515" ? state.separator : undefined;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not here" } } : { jsonrpc: "2.0", id: call.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}
const separatorReads = (r: Rpc) => r.calls.filter((c) => c.method === "eth_call" && c.data === "0x3644e515").length;

const BASE_CHAIN_READ = (r: Rpc) => ({ rpcUrlFor: () => r.url });

describe("tokenDomainProblem", () => {
  it("passes the table's domain, reads it once per process, and reads the table's token", async () => {
    const r = await rpc();
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(r))).toBe("");
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(r))).toBe("");
    expect(separatorReads(r)).toBe(1);
    expect(r.calls[1]).toMatchObject({ method: "eth_call", to: BASE_SEPOLIA.token.address, data: "0x3644e515" });
  });

  it("refuses another domain, another chain, and no contract", async () => {
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(await rpc({ separator: WRONG })))).toMatch(/signs under another EIP-712 domain than this client's chain table states \(name "USDC", version "2"\)/);
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(await rpc({ chainId: "0x1" })))).toMatch(/answers for chain 1, not 84532/);
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(await rpc({ separator: "0x" })))).toMatch(/does not answer DOMAIN_SEPARATOR\(\)/);
  });

  it("goes on when a testnet's RPC cannot be read and reads again next time; refuses when the chain is not a testnet", async () => {
    const r = await rpc({ down: true });
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(r))).toBe("");
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(r))).toBe("");
    expect(r.calls.length).toBe(2);
    const mainnetLike = { ...BASE_SEPOLIA, testnet: false } as EvmNetwork;
    expect(await tokenDomainProblem(mainnetLike, BASE_CHAIN_READ(r))).toMatch(/signing domain on .* could not be checked: its RPC could not be read/);
  });

  it("treats a JSON-RPC error answer as an RPC that cannot be read", async () => {
    const r = await rpc({ separator: undefined as unknown as string });
    expect(await tokenDomainProblem(BASE_SEPOLIA, BASE_CHAIN_READ(r))).toBe("");
    expect(await tokenDomainProblem({ ...BASE_SEPOLIA, testnet: false } as EvmNetwork, BASE_CHAIN_READ(r))).toMatch(/could not be checked/);
  });
});

describe("pay checks the token's domain before anyone is asked", () => {
  async function setup(r: Rpc) {
    const seller = await startPaidEndpoint({ priceDecimal: 0.01, payTo: `0x${"22".repeat(20)}`, facilitatorUrl: "http://127.0.0.1:9" });
    cleanups.push(() => seller.close());
    const dir = mkdtempSync(join(tmpdir(), "token-domain-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const records = new Records(dir);
    let asked = 0;
    const signer: Signer = { kind: "wallet", async address() { return `0x${"11".repeat(20)}`; }, async sign() { asked++; throw new SignRefused("denied", "test owner declined"); } };
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: r.url });
    const pay = async () => {
      const q = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
      return { q, attempt: await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000) };
    };
    return { records, pay, asked: () => asked };
  }

  it("refuses before the signer is called when the token answers another domain", async () => {
    const s = await setup(await rpc({ separator: WRONG }));
    const { q, attempt } = await s.pay();
    expect(attempt).toMatchObject({ state: "failed", refusal: "invalid" });
    expect(attempt.reason).toMatch(/another EIP-712 domain.*Nothing was signed, and nobody was asked$/);
    expect(s.asked()).toBe(0);
    expect(s.records.getQuote(q.id)?.status).toBe("used");
    expect(s.records.spentTodayAtomic("USDC")).toBe(0n);
    expect(attempt.reservedAt).toBeUndefined();
  });

  it("asks the owner once the domain matches, and reads it once for two payments", async () => {
    const r = await rpc();
    const s = await setup(r);
    expect((await s.pay()).attempt.state).toBe("denied");
    expect((await s.pay()).attempt.state).toBe("denied");
    expect(s.asked()).toBe(2);
    expect(separatorReads(r)).toBe(1);
  });

  it("makes no domain read for a Tempo payment", async () => {
    const chain = await startFakeTempoPay();
    cleanups.push(() => chain.close());
    const seller = await startFakeMppSeller(chain, { recipient: "0x2222222222222222222222222222222222222222" });
    cleanups.push(() => seller.close());
    const dir = mkdtempSync(join(tmpdir(), "token-domain-tempo-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const records = new Records(dir);
    const signer: Signer = { kind: "wallet", async address() { return `0x${"11".repeat(20)}`; }, async sign() { throw new SignRefused("denied", "test owner declined"); } };
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url });
    const before = asked.n;
    const q = await quote({ url: `${seller.url}/paid` }, { records, policy: DEFAULT_POLICY });
    const attempt = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
    expect(attempt.state).toBe("denied");
    expect(asked.n).toBe(before);
  });

  it("makes no domain read for a Solana payment", async () => {
    const chain = await startFakeDevnet();
    cleanups.push(() => chain.close());
    const seller = await startSolanaSeller(chain, { behaviour: "ok" });
    cleanups.push(() => seller.close());
    const saved = process.env.SUPERSTABLES_SOLANA_RPC;
    process.env.SUPERSTABLES_SOLANA_RPC = chain.url;
    cleanups.push(() => { if (saved === undefined) delete process.env.SUPERSTABLES_SOLANA_RPC; else process.env.SUPERSTABLES_SOLANA_RPC = saved; });
    const dir = mkdtempSync(join(tmpdir(), "token-domain-solana-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const records = new Records(dir);
    const signer: Signer = { kind: "wallet", async address() { return randomAddress(); }, async sign() { throw new SignRefused("denied", "test owner declined"); } };
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url });
    const before = asked.n;
    const q = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
    const attempt = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
    expect(attempt.state).toBe("denied");
    expect(asked.n).toBe(before);
  });
});
