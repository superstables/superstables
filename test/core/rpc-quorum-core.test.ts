// What `pay` and `status` believe about an RPC: a payment is called never made (and released from the cap) only when
// the verdict set agrees, and every endpoint is asked which chain it is on before it is read. One primary that lies,
// an RPC named only in an environment variable, a missing or disagreeing confirmer, a wrong chain: each leaves the
// attempt uncertain and counted. The EVM cases run the production endpoint table through a fetch router that sends each
// public URL to a loopback fake; the Solana cases give the engine its endpoints through `endpointsFor`.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { encodeFunctionResult, keccak256, toBytes } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARC_TESTNET, BASE_SEPOLIA, SOLANA_DEVNET, TEMPO_MODERATO } from "../../src/core/chain.js";
import { recheckChain } from "../../src/core/pay.js";
import { endpointId, type EndpointSet } from "../../src/core/rpc-endpoints.mjs";
import { forgetIdentities } from "../../src/core/rpc-quorum.mjs";
import { confirmAuthorizationDead, confirmCancellationFinal, findAuthorization } from "../../src/core/settlement.js";
import { buildPayment, checkSigned } from "../../src/core/rails/solana-transaction.js";
import { tempoRail } from "../../src/core/rails/tempo.js";
import { Records } from "../../src/core/records.js";
import type { Attempt } from "../../src/core/types.js";
import { startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { MAINNET_GENESIS, MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet, type FakeSolanaDevnet } from "../helpers/fake-solana-pay.js";
import { startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import type { TestServer } from "../helpers/servers.js";

const PAYER = `0x${"11".repeat(20)}`;
const RECIPIENT = `0x${"22".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const BASE_URL = "https://sepolia.base.org";
const PUBLICNODE_URL = "https://base-sepolia-rpc.publicnode.com";
const ATTACKER = "https://attacker.invalid/rpc";
const cleanup: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  forgetIdentities();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

function ledger(): Records {
  const dir = mkdtempSync(join(tmpdir(), "superstables-quorum-core-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return new Records(dir);
}

/** Clear the RPC variables the test setup points at a dead port, so the endpoint table decides. */
function noRpcVariables() {
  vi.stubEnv("SUPERSTABLES_RPC_URL", "");
  vi.stubEnv("SUPERSTABLES_SOLANA_RPC", "");
  vi.stubEnv("SUPERSTABLES_TEMPO_RPC", "");
}

const own = async <T extends TestServer>(server: T | Promise<T>): Promise<T> => {
  const s = await server;
  cleanup.push(() => s.close());
  return s;
};
const chainOf = async (id = 84532): Promise<FakeBaseSepolia> => {
  const chain = await own(startFakeBaseSepolia());
  chain.chainId = id;
  return chain;
};

/** What a node answers an unused authorization: false. */
const UNUSED = encodeFunctionResult({ abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "authorizationState", result: false });

/** The mirror that always says the authorization is unused, and says nothing else different. */
const liar = (chain: FakeBaseSepolia, more: (method: string, params: any[]) => unknown = () => undefined) =>
  own(chain.mirror((method, params) => (method === "eth_call" ? UNUSED : more(method, params))));

async function ask(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await res.json()) as { result: unknown }).result;
}

interface Routed {
  fetchImpl: typeof fetch;
  /** Every request, as `<original url> <method>`. */
  calls: string[];
}
/** A fetch that sends each public URL to the loopback fake named for it; a loopback URL goes as it is; any other URL fails. */
function route(map: Record<string, string>): Routed {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${url} ${(JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method}`);
    const target = map[url] ?? (url.startsWith("http://127.0.0.1") ? url : undefined);
    if (!target) throw new TypeError("fetch failed");
    return fetch(target, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** An RPC that answers in memory, whatever URL it is asked at. */
function inMemory(answer: (method: string, params: any[]) => unknown, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: any[] };
    calls.push(`${String(input)} ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const pastValidBefore = (chain: { head: { timestamp: number } }) => new Date((chain.head.timestamp - 3_600) * 1000).toISOString();

function evmAttempt(r: Records, validBefore: string, o: { network?: typeof BASE_SEPOLIA; transaction?: string } = {}): Attempt {
  const network = o.network ?? BASE_SEPOLIA;
  const at = new Date().toISOString();
  const attempt: Attempt = {
    id: "a",
    quoteId: "q",
    createdAt: at,
    updatedAt: at,
    state: "uncertain",
    url: "https://seller.example/x",
    terms: { network: network.caip2, networkLabel: network.label, asset: "USDC", assetAddress: network.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
    payer: PAYER,
    authorizationNonce: NONCE,
    authorizationValidBefore: validBefore,
    ...(o.transaction ? { transaction: o.transaction } : {}),
    history: [{ at, state: "approved" }, { at, state: "uncertain" }],
  };
  r.saveAttempt(attempt);
  return attempt;
}

const toFind = (validBefore: string) => ({ network: BASE_SEPOLIA.caip2, payer: PAYER, recipient: RECIPIENT, nonce: NONCE, amountAtomic: "10000", validBefore, since: new Date().toISOString() });

/** Not released: uncertain, counted, and the reason is the chain's, in words. */
function expectHeld(attempt: Attempt | undefined, r: Records, reason: RegExp) {
  expect(attempt).toMatchObject({ state: "uncertain", chainReason: expect.stringMatching(reason) });
  expect(attempt?.chain).not.toBe("unpaid");
  expect(attempt?.chainAgreement).toBeUndefined();
  expect(r.spentToday("USDC")).toBe(0.01);
}

describe("an RPC the owner did not approve cannot say a payment never happened", () => {
  for (const [name, home] of [["the default test account (loopback RPCs allowed)", undefined], ["production defaults (no owner settings)", null]] as const) {
    it(`findAuthorization with SUPERSTABLES_RPC_URL set to an unknown HTTPS RPC, ${name}`, async () => {
      if (home === null) vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith(null));
      vi.stubEnv("SUPERSTABLES_RPC_URL", ATTACKER);
      const calls: string[] = [];
      const now = Math.floor(Date.now() / 1000);
      const fetchImpl = inMemory((method) => {
        if (method === "eth_chainId") return "0x14a34";
        if (method === "eth_call") return UNUSED;
        return { number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${now.toString(16)}` };
      }, calls);
      const found = await findAuthorization(toFind(new Date((now - 3_600) * 1000).toISOString()), { fetchImpl });
      expect(found.found).toBe(false);
      expect((found as { never?: boolean }).never).toBeUndefined();
      expect((found as { reason: string }).reason).toMatch(/SUPERSTABLES_RPC_URL/);
      expect((found as { reason: string }).reason).toMatch(/unset the variable, or stop and ask the owner to add this RPC/);
      expect(calls[0]).toBe(`${ATTACKER} eth_chainId`);
      expect(calls.every((c) => c.startsWith(`${ATTACKER} `))).toBe(true);
    });
  }

  it("status leaves the payment uncertain and counted", async () => {
    vi.stubEnv("SUPERSTABLES_RPC_URL", ATTACKER);
    const now = Math.floor(Date.now() / 1000);
    const fetchImpl = inMemory((method) => (method === "eth_chainId" ? "0x14a34" : method === "eth_call" ? UNUSED : { number: "0x100", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${now.toString(16)}` }), []);
    const r = ledger();
    evmAttempt(r, new Date((now - 3_600) * 1000).toISOString());
    expectHeld(await recheckChain(r, "a", { fetchImpl }), r, /SUPERSTABLES_RPC_URL.*unset the variable, or stop and ask the owner to add this RPC/);
  });
});

describe("a payment is called never made only when the endpoints agree", () => {
  beforeEach(noRpcVariables);

  it("a lying primary and an honest confirmer leave it uncertain", async () => {
    const honest = await chainOf();
    honest.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    const lying = await liar(honest);
    const net = route({ [BASE_URL]: lying.url, [PUBLICNODE_URL]: honest.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(honest));
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /^the chain shows the owner's authorization unused and past its expiry on one RPC, but the RPC endpoints disagree|the RPC endpoints disagree/);
  });

  it("two honest operators at the same final block release it, and the record says how", async () => {
    const a = await chainOf();
    const b = await own(a.mirror());
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: b.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    const done = await recheckChain(r, "a", { fetchImpl: net.fetchImpl });
    expect(done).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "quorum", chainAgreedAt: { operators: ["base", "publicnode"], block: expect.stringMatching(/^\d+$/), blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    expect(r.spentToday("USDC")).toBe(0);
    expect(r.getReceipt("a")).toBeUndefined();
  });

  it("records the agreement on the receipt too when the seller had reported the payment", async () => {
    const a = await chainOf();
    const b = await own(a.mirror());
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: b.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    r.saveReceipt({
      id: "a", attemptId: "a", quoteId: "q", at: new Date().toISOString(), url: "https://seller.example/x", terms: r.getAttempt("a")!.terms, payer: PAYER,
      transaction: `0x${"99".repeat(32)}`, transactionKind: "hash", transactionUrl: "", network: BASE_SEPOLIA.caip2,
      settlement: { success: true, payer: PAYER, transaction: `0x${"99".repeat(32)}`, network: BASE_SEPOLIA.caip2 },
      serviceOutcome: "delivered", serviceStatus: 200, chain: "unchecked",
    } as never);
    await recheckChain(r, "a", { fetchImpl: net.fetchImpl });
    expect(r.getReceipt("a")).toMatchObject({ chain: "unpaid", chainAgreement: "quorum", chainAgreedAt: { operators: ["base", "publicnode"] } });
  });

  it("a second endpoint that cannot be reached leaves it uncertain", async () => {
    const a = await chainOf();
    const net = route({ [BASE_URL]: a.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /we couldn't complete the required RPC checks/);
  });

  it("a final failure and an unused nonce, both from a lying primary, cannot release it", async () => {
    const honest = await chainOf();
    const tx = honest.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    const real = await ask(honest.url, "eth_getTransactionReceipt", [tx]);
    await ask(honest.url, "eth_getBlockByNumber", [real.blockNumber, false]);
    const lying = await liar(honest, (method) => (method === "eth_getTransactionReceipt" ? { ...real, status: "0x0" } : undefined));
    const net = route({ [BASE_URL]: lying.url, [PUBLICNODE_URL]: honest.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(honest), { transaction: tx });
    const first = await recheckChain(r, "a", { fetchImpl: net.fetchImpl });
    expect(first?.chain).not.toBe("unpaid");
    expect(first?.state).not.toBe("failed");
    expect(r.spentToday("USDC")).toBe(0.01);
  });

  it("endpoints that name different blocks at the final height disagree", async () => {
    const a = await chainOf();
    const other = await own(a.mirror((method, params) => (method === "eth_call" ? UNUSED : method === "eth_getBlockByNumber" && params[0] !== "latest" && params[0] !== "finalized" ? { number: params[0], hash: `0x${"cd".repeat(32)}`, timestamp: `0x${a.head.timestamp.toString(16)}` } : undefined)));
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: other.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /the RPC endpoints disagree/);
  });

  it("a second endpoint on another chain is left out", async () => {
    const a = await chainOf();
    const wrong = await chainOf(1);
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: wrong.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /couldn't complete the required RPC checks.*answers chain id 1/);
  });

  it("one pinned owner RPC without the owner's own node is not enough", async () => {
    const a = await chainOf();
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith({ version: 1, rpcEnv: { allowLoopback: true }, rpc: { "base-sepolia": { urls: [a.url] } } }));
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expectHeld(await recheckChain(r, "a", { fetchImpl: route({}).fetchImpl }), r, /we couldn't complete the required RPC checks/);
  });

  it("the owner's own node decides alone, and the record says so", async () => {
    const a = await chainOf();
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith({ version: 1, rpcEnv: { allowLoopback: true }, rpc: { "base-sepolia": { urls: [a.url], ownNode: true } } }));
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expect(await recheckChain(r, "a", { fetchImpl: route({}).fetchImpl })).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "owner-node", chainAgreedAt: { operators: ["127.0.0.1"] } });
  });

  it("a loopback RPC variable cannot decide: it disagrees with the table's honest endpoints", async () => {
    const honest = await chainOf();
    honest.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    const lying = await liar(honest);
    vi.stubEnv("SUPERSTABLES_RPC_URL", lying.url);
    const net = route({ [BASE_URL]: honest.url, [PUBLICNODE_URL]: (await own(honest.mirror())).url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(honest));
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /the RPC endpoints disagree/);
  });

  it("a loopback RPC variable cannot stand in for a table endpoint that cannot be reached", async () => {
    const a = await chainOf();
    vi.stubEnv("SUPERSTABLES_RPC_URL", (await own(a.mirror())).url);
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expectHeld(await recheckChain(r, "a", { fetchImpl: route({ [BASE_URL]: a.url }).fetchImpl }), r, /we couldn't complete the required RPC checks/);
  });

  it("a testnet with one public RPC is decided by it, labelled single", async () => {
    const a = await chainOf(ARC_TESTNET.chainId);
    const net = route({ "https://rpc.testnet.arc.io": a.url });
    const r = ledger();
    evmAttempt(r, pastValidBefore(a), { network: ARC_TESTNET });
    expect(await recheckChain(r, "a", { fetchImpl: net.fetchImpl })).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "single" });
  });

  it("an RPC the calling code pinned is believed, labelled caller; the same URL in the variable is not", async () => {
    const a = await chainOf();
    const r = ledger();
    evmAttempt(r, pastValidBefore(a));
    expect(await recheckChain(r, "a", a.url)).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "caller" });
    const other = ledger();
    evmAttempt(other, pastValidBefore(a));
    vi.stubEnv("SUPERSTABLES_RPC_URL", a.url);
    const viaVariable = await recheckChain(other, "a", { fetchImpl: route({}).fetchImpl });
    expectHeld(viaVariable, other, /couldn't complete the required RPC checks|could not be read/);
  });

  it("a cancellation one endpoint cannot show is not final", async () => {
    const a = await chainOf();
    const cancelled = a.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    a.used.get(NONCE)!.cancelled = true;
    a.receipts.set(cancelled, { status: "0x1", blockNumber: `0x${a.used.get(NONCE)!.block.toString(16)}`, logs: [{ address: BASE_SEPOLIA.usdc.address, topics: [keccak256(toBytes("AuthorizationCanceled(address,bytes32)")), `0x${PAYER.slice(2).padStart(64, "0")}`, NONCE], data: "0x" }] });
    const lying = await own(a.mirror((method) => (method === "eth_getTransactionReceipt" ? null : undefined)));
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: lying.url });
    const r = ledger();
    evmAttempt(r, new Date((a.head.timestamp + 300) * 1000).toISOString());
    expectHeld(await recheckChain(r, "a", { fetchImpl: net.fetchImpl }), r, /the RPC endpoints disagree/);
  });

  it("a cancellation both operators show in a final block releases it", async () => {
    const a = await chainOf();
    const cancelled = a.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    const block = a.used.get(NONCE)!.block;
    a.used.get(NONCE)!.cancelled = true;
    a.receipts.set(cancelled, { status: "0x1", blockNumber: `0x${block.toString(16)}`, logs: [{ address: BASE_SEPOLIA.usdc.address, topics: [keccak256(toBytes("AuthorizationCanceled(address,bytes32)")), `0x${PAYER.slice(2).padStart(64, "0")}`, NONCE], data: "0x" }] });
    const b = await own(a.mirror());
    const net = route({ [BASE_URL]: a.url, [PUBLICNODE_URL]: b.url });
    const r = ledger();
    evmAttempt(r, new Date((a.head.timestamp + 300) * 1000).toISOString());
    const done = await recheckChain(r, "a", { fetchImpl: net.fetchImpl });
    expect(done).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "quorum" });
    expect(BigInt(done!.chainAgreedAt!.block!)).toBeGreaterThanOrEqual(block);
  });
});

describe("core authorization proofs with batched final heads", () => {
  beforeEach(noRpcVariables);
  const low = 50210845n;
  const high = low + 1822n;
  const hash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
  const tx = `0x${"12".repeat(32)}`;
  const transport = (mode: "unused" | "used_since_low" | "cancelled", receiptBlock = low) => {
    const reads: [string, bigint][] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const head = url === BASE_URL ? low : high;
      let result: unknown;
      if (body.method === "eth_chainId") result = "0x14a34";
      else if (body.method === "eth_getBlockByNumber") {
        const n = body.params[0] === "finalized" ? head : BigInt(String(body.params[0]));
        expect(n <= head).toBe(true);
        result = { number: `0x${n.toString(16)}`, hash: hash(n), timestamp: "0x6ad00000" };
      } else if (body.method === "eth_call") {
        const at = body.params[1] as { blockHash: string };
        const n = BigInt(at.blockHash);
        expect(n <= head).toBe(true);
        reads.push([url, n]);
        result = mode === "cancelled" || (mode === "used_since_low" && n > low) ? hash(1n) : hash(0n);
      } else if (body.method === "eth_getTransactionReceipt") {
        result = { transactionHash: tx, status: "0x1", blockNumber: `0x${receiptBlock.toString(16)}`, blockHash: hash(receiptBlock), logs: [{ address: BASE_SEPOLIA.usdc.address, topics: [keccak256(toBytes("AuthorizationCanceled(address,bytes32)")), `0x${PAYER.slice(2).padStart(64, "0")}`, NONCE] }] };
      } else throw new Error("unexpected method");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    return { fetchImpl, reads };
  };

  it("expiry requires unused state at every counted endpoint's own final head", async () => {
    const unused = transport("unused");
    expect(await confirmAuthorizationDead(BASE_SEPOLIA, { payer: PAYER, nonce: NONCE, validBefore: 1 }, unused)).toMatchObject({ dead: true });
    expect(unused.reads).toContainEqual([PUBLICNODE_URL, high]);
    expect(await confirmAuthorizationDead(BASE_SEPOLIA, { payer: PAYER, nonce: NONCE, validBefore: 1 }, transport("used_since_low"))).toMatchObject({ dead: false });
  });

  it("cancellation is final only at or below every counted final head", async () => {
    const cancellation = { payer: PAYER, nonce: NONCE, transaction: tx };
    expect(await confirmCancellationFinal(BASE_SEPOLIA, cancellation, transport("cancelled"))).toMatchObject({ dead: true });
    expect(await confirmCancellationFinal(BASE_SEPOLIA, cancellation, transport("cancelled", high))).toMatchObject({ dead: false });
  });
});

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An endpoint set of two operators, the first the primary. */
const twoOperators = (primary: string, second: string): EndpointSet => {
  const ep = (url: string, operator: string) => ({ url, operator, source: "settings" as const, id: endpointId(url) });
  return { primary: ep(primary, "op-a"), verdict: [ep(primary, "op-a"), ep(second, "op-b")], quorum: 2, agreement: "quorum" };
};

interface SolanaCase {
  chain: FakeSolanaDevnet;
  records: Records;
  landed?: string;
  landedSlot?: number;
  last: number;
}
/** An expired Solana payment: a funding transaction, the payment (landed, or not), the chain past its blockhash. */
async function solanaCase(o: { land?: boolean; err?: unknown } = {}): Promise<SolanaCase> {
  const chain = await own(startFakeDevnet());
  const owner = solanaKey();
  const recipient = randomAddress();
  chain.height += 400;
  const builtHeight = chain.height;
  const buildSlot = chain.height + 10;
  const built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
  const signed = signAsOwner(built.transaction, owner);
  const checked = checkSigned(signed, { ...built, owner: owner.address });
  if (!checked.ok) throw new Error(checked.reason);
  const landed = o.land ? chain.land(signed, o.err === undefined ? {} : { err: o.err }) : undefined;
  chain.height = builtHeight + 151;
  const records = ledger();
  const at = new Date().toISOString();
  records.saveAttempt({
    id: "sol",
    quoteId: "q",
    createdAt: at,
    updatedAt: at,
    state: "uncertain",
    url: "https://seller.example/x",
    terms: { network: SOLANA_DEVNET.caip2, networkLabel: SOLANA_DEVNET.label, asset: "USDC", assetAddress: MINT, amountAtomic: "10000", amountDecimal: 0.01, recipient, scheme: "exact" },
    payer: owner.address,
    ownerSignature: checked.signature,
    lastValidBlockHeight: builtHeight + 150,
    searchFromSlot: buildSlot,
    history: [{ at, state: "uncertain" }],
  } as Attempt);
  return { chain, records, landed, landedSlot: landed ? chain.txs.get(landed)!.slot : undefined, last: builtHeight + 150 };
}

describe("Solana: a second endpoint reads the blocks too", () => {
  beforeEach(noRpcVariables);

  it("a primary that hides the block holding the payment cannot release it", async () => {
    const s = await solanaCase({ land: true });
    const slot = s.landedSlot!;
    const hiding = await own(s.chain.mirror((method, params) => {
      if (method === "getSignaturesForAddress") return [];
      if (method === "getBlock" && params[0] === slot) return { blockHeight: slot - 10, blockTime: 0, parentSlot: slot - 1, blockhash: bs58.encode(randomBytes(32)), transactions: [] };
      return undefined;
    }));
    const honest = await own(s.chain.mirror());
    const done = await recheckChain(s.records, "sol", { endpointsFor: () => twoOperators(hiding.url, honest.url) } as never);
    expect(done).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.landed });
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("a primary that says the carrying transaction failed cannot release it", async () => {
    const s = await solanaCase({ land: true });
    const failing = await own(s.chain.mirror((method, params) => {
      if (method !== "getTransaction" || params[0] !== s.landed) return undefined;
      const tx = s.chain.txs.get(s.landed!)!;
      return { ...tx, meta: { ...tx.meta, err: { InstructionError: [0, "Custom"] } } };
    }));
    const honest = await own(s.chain.mirror());
    const done = await recheckChain(s.records, "sol", { endpointsFor: () => twoOperators(failing.url, honest.url) } as never);
    expect(done).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.landed });
  });

  it("two clean endpoints release it, and a confirmer cut short reads on over statuses", async () => {
    const s = await solanaCase();
    const primary = await own(s.chain.mirror());
    let blocks = 0;
    const slow = await own(s.chain.mirror((method) => {
      if (method === "getBlock" && (blocks += 1) === 6) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      return undefined;
    }));
    const options = (confirmMs: number) => ({ endpointsFor: () => twoOperators(primary.url, slow.url), confirmMs, searchMs: 60_000 }) as never;
    const first = await recheckChain(s.records, "sol", options(60));
    expectHeld(first, s.records, /has not finished reading them; the next status reads on/);
    expect(Object.values(first!.confirmSearchedTo ?? {})[0]).toBeGreaterThan(0);
    expect(first?.searchedToSlot).toBeGreaterThan(0);
    const second = await recheckChain(s.records, "sol", options(60_000));
    expect(second).toMatchObject({ state: "failed", chain: "unpaid", chainAgreement: "quorum", chainAgreedAt: { operators: ["op-a", "op-b"], slot: expect.any(Number) } });
  });

  it("a confirmer whose finalized height is not past the blockhash does not agree", async () => {
    const s = await solanaCase();
    const primary = await own(s.chain.mirror());
    const behind = await own(s.chain.mirror((method) => (method === "getEpochInfo" ? { absoluteSlot: s.last, blockHeight: s.last - 5, epoch: 800, slotIndex: 0, slotsInEpoch: 432_000 } : undefined)));
    const done = await recheckChain(s.records, "sol", { endpointsFor: () => twoOperators(primary.url, behind.url) } as never);
    expectHeld(done, s.records, /a second RPC endpoint does not show the blockhash expired yet/);
  });

  it("a confirmer on another genesis is left out", async () => {
    const s = await solanaCase();
    const primary = await own(s.chain.mirror());
    const other = await own(s.chain.mirror((method) => (method === "getGenesisHash" ? MAINNET_GENESIS : undefined)));
    const done = await recheckChain(s.records, "sol", { endpointsFor: () => twoOperators(primary.url, other.url) } as never);
    expectHeld(done, s.records, /answers another genesis/);
  });

  it("a loopback RPC variable cannot stand in for an owner RPC that cannot be read", async () => {
    const s = await solanaCase();
    const second = await own(s.chain.mirror());
    vi.stubEnv("SUPERSTABLES_SOLANA_RPC", (await own(s.chain.mirror())).url);
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith({ version: 1, rpcEnv: { allowLoopback: true }, rpc: { "solana-devnet": { urls: ["http://127.0.0.1:9/", second.url.replace("127.0.0.1", "localhost")] } } }));
    expectHeld(await recheckChain(s.records, "sol"), s.records, /we couldn't complete the required RPC checks/);
  });

  it("the owner's two Solana RPCs from the owner settings: a primary that hides the block cannot release it", async () => {
    const s = await solanaCase({ land: true });
    const slot = s.landedSlot!;
    const hiding = await own(s.chain.mirror((method, params) => {
      if (method === "getSignaturesForAddress") return [];
      if (method === "getBlock" && params[0] === slot) return { blockHeight: slot - 10, blockTime: 0, parentSlot: slot - 1, blockhash: bs58.encode(randomBytes(32)), transactions: [] };
      return undefined;
    }));
    const honest = await own(s.chain.mirror());
    // 127.0.0.1 and localhost are two operators (operatorOf in src/core/rpc-endpoints.mjs)
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith({ version: 1, rpcEnv: { allowLoopback: true }, rpc: { "solana-devnet": { urls: [hiding.url, honest.url.replace("127.0.0.1", "localhost")] } } }));
    expect(await recheckChain(s.records, "sol")).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.landed });
  });

  it("a loopback RPC variable that hides the block is read first, and the table's endpoint still reads the blocks", async () => {
    const s = await solanaCase({ land: true });
    const slot = s.landedSlot!;
    const hiding = await own(s.chain.mirror((method, params) => {
      if (method === "getSignaturesForAddress") return [];
      if (method === "getBlock" && params[0] === slot) return { blockHeight: slot - 10, blockTime: 0, parentSlot: slot - 1, blockhash: bs58.encode(randomBytes(32)), transactions: [] };
      return undefined;
    }));
    vi.stubEnv("SUPERSTABLES_SOLANA_RPC", hiding.url);
    const done = await recheckChain(s.records, "sol", { fetchImpl: route({ "https://api.devnet.solana.com": s.chain.url }).fetchImpl });
    expect(done).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.landed });
  });

  it("an RPC variable the owner did not approve is read, never believed", async () => {
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith(null));
    vi.stubEnv("SUPERSTABLES_SOLANA_RPC", "https://solana.example/rpc");
    const s = await solanaCase();
    const done = await recheckChain(s.records, "sol", { fetchImpl: route({ "https://solana.example/rpc": s.chain.url }).fetchImpl });
    expectHeld(done, s.records, /SUPERSTABLES_SOLANA_RPC.*unset the variable, or stop and ask the owner to add this RPC/);
  });
});

// ── Tempo ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("Tempo", () => {
  beforeEach(noRpcVariables);

  it("a primary that hides the transfer never makes it unpaid, however often status runs", async () => {
    const chain = await own(startFakeTempoPay());
    const owner = `0x${"11".repeat(20)}`;
    const memo = `0x${"55".repeat(32)}`;
    chain.mine({ from: owner, to: RECIPIENT, amount: 10_000n, memo: memo as `0x${string}`, token: TEMPO_MODERATO.token.address });
    const hiding = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "eth_getLogs") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: [] }), { status: 200 });
      return fetch(input, init);
    }) as typeof fetch;
    const r = ledger();
    const at = new Date(Date.now() - 600_000).toISOString();
    r.saveAttempt({
      id: "t", quoteId: "q", createdAt: at, updatedAt: at, state: "uncertain", url: "https://seller.example/x",
      terms: { network: TEMPO_MODERATO.caip2, networkLabel: TEMPO_MODERATO.label, asset: "pathUSD", assetAddress: TEMPO_MODERATO.token.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
      payer: owner, paymentMemo: memo, searchFromBlock: "1", history: [{ at, state: "approved" }, { at, state: "uncertain" }],
    } as Attempt);
    for (let i = 0; i < 3; i += 1) {
      const seen = await recheckChain(r, "t", { rpcUrlFor: () => chain.url, fetchImpl: hiding });
      expect(seen).toMatchObject({ state: "uncertain" });
      expect(seen?.chain).not.toBe("unpaid");
    }
    expect(r.spentToday("pathUSD")).toBeGreaterThan(0);
  });
});
