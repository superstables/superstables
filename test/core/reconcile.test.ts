// What `superstables status` writes when it reads the chain for a payment whose outcome is open, end to end through
// recheckChain with the records and a fake chain: the decisions that release a payment as never made are taken only on
// final evidence, and a later or concurrent status never undoes what the chain verified.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { keccak256, toBytes } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_SEPOLIA, POLYGON_AMOY, SOLANA_DEVNET } from "../../src/core/chain.js";
import { recheckChain } from "../../src/core/pay.js";
import { findAuthorization } from "../../src/core/settlement.js";
import { buildPayment, checkSigned } from "../../src/core/rails/solana-transaction.js";
import { Records } from "../../src/core/records.js";
import type { Attempt } from "../../src/core/types.js";
import { startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet } from "../helpers/fake-solana-pay.js";

const PAYER = `0x${"11".repeat(20)}`;
const RECIPIENT = `0x${"22".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function ledger(): Records {
  const dir = mkdtempSync(join(tmpdir(), "superstables-reconcile-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return new Records(dir);
}

/** An uncertain EVM attempt on Base Sepolia, as the engine leaves one after a seller's "no". */
function evmAttempt(r: Records, validBefore: string): Attempt {
  const at = new Date().toISOString();
  const attempt: Attempt = {
    id: "a",
    quoteId: "q",
    createdAt: at,
    updatedAt: at,
    state: "uncertain",
    url: "https://seller.example/x",
    terms: { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
    payer: PAYER,
    authorizationNonce: NONCE,
    authorizationValidBefore: validBefore,
    history: [{ at, state: "approved" }, { at, state: "uncertain" }],
  };
  r.saveAttempt(attempt);
  return attempt;
}

async function evmChain(): Promise<FakeBaseSepolia> {
  const chain = await startFakeBaseSepolia();
  cleanup.push(() => chain.close());
  return chain;
}

describe("status on EVM chains", () => {
  it("does not call a cancellation final before its block is, and finds the payment when a reorg drops it", async () => {
    const chain = await evmChain();
    const r = ledger();
    const validBefore = new Date((chain.head.timestamp + 300) * 1000).toISOString();
    const cancelled = chain.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    chain.used.get(NONCE)!.cancelled = true;
    chain.receipts.set(cancelled, { status: "0x1", blockNumber: `0x${chain.used.get(NONCE)!.block.toString(16)}`, logs: [{ address: BASE_SEPOLIA.usdc.address, topics: [keccak256(toBytes("AuthorizationCanceled(address,bytes32)")), `0x${PAYER.slice(2).padStart(64, "0")}`, NONCE], data: "0x" }] });
    chain.finalizedLag = 2;
    evmAttempt(r, validBefore);
    const first = await recheckChain(r, "a", chain.url);
    expect(first).toMatchObject({ state: "uncertain" });
    expect(first?.chain).not.toBe("unpaid");
    expect(r.spentToday("USDC")).toBe(0.01);
    // A reorg drops the cancellation, and the seller settles the authorization.
    chain.used.delete(NONCE);
    chain.receipts.delete(cancelled);
    // A new matching payment is paid while finality waits; this reorg removed a cancellation.
    const landed = chain.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    expect(await recheckChain(r, "a", chain.url)).toMatchObject({ state: "paid_service_failed", chain: "unchecked", paymentIncluded: true, transaction: landed });
    expect(r.spentToday("USDC")).toBe(0.01);
    chain.advance(10);
    expect(await recheckChain(r, "a", chain.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: landed });
    expect(r.spentToday("USDC")).toBe(0.01);
  });

  it("never records unpaid from a cancellation that a reorganisation replaced with the payment before finality passed it", async () => {
    // The round-3 review's reproduction, on Polygon Amoy: status reads the cancellation's log above the finalized block;
    // before it reads further, a reorganisation replaces that block with the payment, and finality passes it.
    const chain = await evmChain();
    const r = ledger();
    const token = POLYGON_AMOY.usdc.address;
    const validBefore = new Date((chain.head.timestamp + 300) * 1000).toISOString();
    const cancelled = chain.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE, token });
    chain.used.get(NONCE)!.cancelled = true;
    chain.finalizedLag = 2;
    let landed = "";
    let reorged = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const call = JSON.parse(String(init?.body)) as { method: string };
      const answer = await fetch(input, init);
      if (call.method !== "eth_getLogs" || reorged) return answer;
      const body = await answer.text();
      if (!(JSON.parse(body) as { result?: unknown[] }).result?.length) return new Response(body, { status: answer.status });
      reorged = true;
      const at = chain.used.get(NONCE)!.block;
      chain.used.delete(NONCE);
      chain.receipts.delete(cancelled);
      chain.head = { number: at - 1n, timestamp: chain.head.timestamp - 2 };
      landed = chain.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE, token });
      chain.advance(8);
      chain.finalizedLag = 0;
      return new Response(body, { status: answer.status });
    };
    const at = new Date().toISOString();
    r.saveAttempt({
      id: "a",
      quoteId: "q",
      createdAt: at,
      updatedAt: at,
      state: "uncertain",
      url: "https://seller.example/x",
      terms: { network: POLYGON_AMOY.caip2, networkLabel: POLYGON_AMOY.label, asset: "USDC", assetAddress: token, amountAtomic: "10000", amountDecimal: 0.01, recipient: RECIPIENT, scheme: "exact" },
      payer: PAYER,
      authorizationNonce: NONCE,
      authorizationValidBefore: validBefore,
      history: [{ at, state: "uncertain" }],
    });
    const first = await recheckChain(r, "a", { rpcUrlFor: () => chain.url, fetchImpl });
    expect(reorged).toBe(true);
    expect(first).toMatchObject({ state: "uncertain" });
    expect(first?.chain).not.toBe("unpaid");
    expect(r.spentToday("USDC")).toBe(0.01);
    // The chain as it now is: the payment.
    expect(await findAuthorization({ network: POLYGON_AMOY.caip2, payer: PAYER, recipient: RECIPIENT, nonce: NONCE, amountAtomic: "10000", validBefore, since: at }, { rpcUrl: chain.url })).toEqual({ found: true, transaction: landed });
    expect(await recheckChain(r, "a", chain.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: landed });
    expect(r.spentToday("USDC")).toBe(0.01);
  });

  it("never writes unpaid over a payment another status verified while it read the chain", async () => {
    // Two RPCs answering differently: a stale one that still shows the authorization unused past its expiry, and one
    // that shows the transfer. The stale status reads first and writes last.
    const stale = await evmChain();
    const live = await evmChain();
    const r = ledger();
    const validBefore = new Date((stale.head.timestamp + 60) * 1000).toISOString();
    stale.advance(600);
    evmAttempt(r, validBefore);
    const landed = live.settle({ from: PAYER, to: RECIPIENT, value: "10000", nonce: NONCE });
    let ready!: () => void;
    let resume!: () => void;
    const read = new Promise<void>((res) => (ready = res));
    const go = new Promise<void>((res) => (resume = res));
    let reads = 0;
    const held: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      reads += 1;
      // Hold the stale status after its last read, before it writes.
      if (JSON.parse(String(init?.body)).method === "eth_call" && reads > 2) {
        const body = await answer.text();
        ready();
        await go;
        return new Response(body, { status: answer.status });
      }
      return answer;
    };
    const a = recheckChain(r, "a", { rpcUrlFor: () => stale.url, fetchImpl: held });
    await read;
    expect(await recheckChain(r, "a", live.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: landed });
    resume();
    expect(await a).toMatchObject({ chain: "verified", transaction: landed });
    expect(r.getAttempt("a")).toMatchObject({ state: "paid_service_failed", chain: "verified" });
    expect(r.getReceipt("a")).toMatchObject({ chain: "verified" });
    expect(r.spentToday("USDC")).toBe(0.01);
  });
});

describe("status on Solana devnet", () => {
  it("does not release a landed payment the address index had not caught up with when it searched", async () => {
    const chain = await startFakeDevnet();
    cleanup.push(() => chain.close());
    const owner = solanaKey();
    const recipient = randomAddress();
    const feePayer = randomAddress();
    const funding = buildPayment({ owner: owner.address, recipient: randomAddress(), mint: MINT, decimals: 6, amountAtomic: "1", feePayer, blockhash: bs58.encode(randomBytes(32)) });
    chain.land(signAsOwner(funding.transaction, owner));
    chain.height += 400;
    const builtHeight = chain.height;
    const buildSlot = chain.height + 10;
    const built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer, blockhash: bs58.encode(randomBytes(32)) });
    const signed = signAsOwner(built.transaction, owner);
    const checked = checkSigned(signed, { ...built, owner: owner.address });
    if (!checked.ok) throw new Error(checked.reason);
    const landed = chain.land(signed);
    chain.height = builtHeight + 151;
    const status = chain.txs.get(landed)!;
    // The node lists signatures before it has written this transaction's status; its blocks come whole.
    chain.onCall = (method) => {
      if (method === "getSignaturesForAddress") chain.txs.delete(landed);
      if (method === "getBlock") chain.txs.set(landed, status);
    };
    const r = ledger();
    const at = new Date().toISOString();
    r.saveAttempt({
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
    });
    const first = await recheckChain(r, "sol", chain.url);
    expect(first).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: landed });
    expect(r.spentToday("USDC")).toBe(0.01);
  });

  it("reads the blocks of a payment that never landed over several statuses when the RPC limits it, never moving back", async () => {
    const chain = await startFakeDevnet();
    cleanup.push(() => chain.close());
    const owner = solanaKey();
    const recipient = randomAddress();
    chain.height += 400;
    const builtHeight = chain.height;
    const buildSlot = chain.height + 10;
    const built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    const checked = checkSigned(signAsOwner(built.transaction, owner), { ...built, owner: owner.address });
    if (!checked.ok) throw new Error(checked.reason);
    chain.height = builtHeight + 151;
    const r = ledger();
    const at = new Date().toISOString();
    r.saveAttempt({
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
    });
    const blocks = () => chain.calls.filter((c) => c === "getBlock").length;
    const read = { rpcUrlFor: () => chain.url, searchMs: 1_500 };
    // The RPC serves fifty blocks, then limits this client for longer than a status reads.
    chain.limit = { method: "getBlock", after: 50, times: 1_000, retryAfter: 5 };
    expect(await recheckChain(r, "sol", read)).toMatchObject({ state: "uncertain", chain: "unchecked", searchedToSlot: buildSlot + 50, chainReason: expect.stringMatching(/limits how fast blocks can be read; 50 of the 151/) });
    expect(r.spentToday("USDC")).toBe(0.01);
    // The next status reads on from there. Another status got further meanwhile: what it read is kept.
    chain.limit = { method: "getBlock", after: 20, times: 1_000, retryAfter: 5 };
    chain.calls.length = 0;
    let further = true;
    chain.onCall = (method) => {
      if (method !== "getBlock" || !further) return;
      r.saveAttempt({ ...r.getAttempt("sol")!, searchedToSlot: buildSlot + 100 });
      further = false;
    };
    expect(await recheckChain(r, "sol", read)).toMatchObject({ state: "uncertain", searchedToSlot: buildSlot + 100 });
    expect(chain.calls.filter((c) => c === "getBlock")).toHaveLength(20);
    chain.onCall = undefined;
    // Once the RPC lets it, the rest of the window is read, and the payment is shown never made.
    chain.limit = undefined;
    chain.calls.length = 0;
    expect(await recheckChain(r, "sol", read)).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(blocks()).toBe(51);
    expect(r.spentToday("USDC")).toBe(0);
  });
});
