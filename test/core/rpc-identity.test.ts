// Every RPC is asked which chain it is on before its first read: a payment check, a search and a balance read nothing from an
// endpoint that answers another chain, and say so in words.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARBITRUM_SEPOLIA, BASE_SEPOLIA, ROBINHOOD_TESTNET, TEMPO_MODERATO } from "../../src/core/chain.js";
import { forgetIdentities } from "../../src/core/rpc-quorum.mjs";
import { findAuthorization } from "../../src/core/settlement.js";
import { verifiedRpc } from "../../src/core/rpc.js";
import { tempoRail } from "../../src/core/rails/tempo.js";
import { startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import type { TestServer } from "../helpers/servers.js";

const PAYER = `0x${"11".repeat(20)}`;
const RECIPIENT = `0x${"22".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const ATTACKER = "https://attacker.invalid/rpc";
const cleanup: (() => Promise<void> | void)[] = [];
beforeEach(() => forgetIdentities());
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});
const own = async <T extends TestServer>(server: T | Promise<T>): Promise<T> => {
  const s = await server;
  cleanup.push(() => s.close());
  return s;
};
const toFind = (validBefore: string) => ({ network: BASE_SEPOLIA.caip2, payer: PAYER, recipient: RECIPIENT, nonce: NONCE, amountAtomic: "10000", validBefore, since: new Date().toISOString() });

/** An RPC that answers in memory, whatever URL it is asked at. */
function inMemory(answer: (method: string, params: any[]) => unknown, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] };
    calls.push(`${String(input)} ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("identity before the first read", () => {
  it("an RPC that answers another chain is not read at all", async () => {
    vi.stubEnv("SUPERSTABLES_RPC_URL", ATTACKER);
    const calls: string[] = [];
    const found = await findAuthorization(toFind(new Date(Date.now() - 3_600_000).toISOString()), { fetchImpl: inMemory((method) => (method === "eth_chainId" ? "0x1" : "0x"), calls) });
    expect(found).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/answers chain id 1, not 84532/) });
    expect(calls).toEqual([`${ATTACKER} eth_chainId`]);
  });
  const facts = { network: TEMPO_MODERATO.caip2, payer: PAYER, recipient: RECIPIENT, amountAtomic: "10000", memo: `0x${"55".repeat(32)}`, since: new Date().toISOString() };

  it("an RPC on another chain is not read", async () => {
    const calls: string[] = [];
    const fetchImpl = inMemory((method) => (method === "eth_chainId" ? "0x1" : method === "eth_getLogs" ? [] : { number: "0x10", timestamp: "0x1" }), calls);
    const found = await tempoRail.findPayment!(facts, { rpcUrlFor: () => "http://127.0.0.1:1", fetchImpl });
    expect(found).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/answers chain id 1, not 42431/) });
    expect(calls).toEqual(["http://127.0.0.1:1 eth_chainId"]);
  });
});

// ── Balances ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("balances", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("a Base Sepolia balance is not read through an RPC variable that is neither HTTPS nor on this machine", async () => {
    vi.stubEnv("SUPERSTABLES_RPC_URL", "http://203.0.113.9:8545");
    const spy = vi.spyOn(globalThis, "fetch");
    const { usdcBalance, BASE_SEPOLIA: network } = await import("../../src/core/chain.js");
    await expect(usdcBalance(PAYER, network)).rejects.toThrow(/SUPERSTABLES_RPC_URL must use HTTPS, or HTTP on this machine/);
    expect(spy.mock.calls.map((c) => String(c[0]))).not.toContain("http://203.0.113.9:8545/");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a balance is not read from an RPC on another chain", async () => {
    const wrong = await own(startFakeBaseSepolia());
    wrong.chainId = 1;
    vi.stubEnv("SUPERSTABLES_RPC_URL", wrong.url);
    const { usdcBalance, BASE_SEPOLIA: network } = await import("../../src/core/chain.js");
    await expect(usdcBalance(PAYER, network)).rejects.toThrow(/answers chain id 1/);
  });
});

describe("the endpoint for state at the final block", () => {
  it("is dRPC on Robinhood Chain Testnet, whose official RPC keeps only recent state; elsewhere it is the primary", async () => {
    const calls: string[] = [];
    const chainOf = (url: string) => (url.includes("robinhood") ? ROBINHOOD_TESTNET.chainId : ARBITRUM_SEPOLIA.chainId);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => inMemory(() => `0x${chainOf(String(input)).toString(16)}`, calls)(input, init)) as typeof fetch;
    expect(await verifiedRpc(ROBINHOOD_TESTNET, { fetchImpl })).toEqual({ url: "https://rpc.testnet.chain.robinhood.com" });
    expect(await verifiedRpc(ROBINHOOD_TESTNET, { fetchImpl, state: true })).toEqual({ url: "https://robinhood-testnet.drpc.org" });
    expect(await verifiedRpc(ARBITRUM_SEPOLIA, { fetchImpl, state: true })).toEqual({ url: "https://sepolia-rollup.arbitrum.io/rpc" });
    // each is asked which chain it is on first
    expect(calls).toContain("https://robinhood-testnet.drpc.org eth_chainId");
  });
});
