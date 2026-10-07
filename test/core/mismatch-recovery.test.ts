import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recheckChain } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { checkSettlement } from "../../src/core/settlement.js";
import { BASE_SEPOLIA } from "../../src/core/chain.js";
import { exitCodeFor } from "../../src/cli/outcome.js";
import { startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
const original = JSON.parse(readFileSync(new URL("fixtures/030-mismatch.json", import.meta.url), "utf8")).attempt;
async function setup(legacy = false) {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  const dir = mkdtempSync(join(tmpdir(), "mismatch-recovery-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  const transaction = chain.settle({ from: original.payer, to: original.terms.recipient, value: "20000", nonce: `0x${"99".repeat(32)}` });
  const raw = { ...original, id: "a", quoteId: "q", transaction, createdAt: new Date().toISOString(), authorizationValidBefore: new Date((chain.head.timestamp + 300) * 1000).toISOString() };
  if (legacy) appendFileSync(join(dir, "attempts.jsonl"), JSON.stringify(raw) + "\n");
  else records.saveAttempt({ ...raw, chainMismatch: "content", chainFinal: null });
  const attempt = records.getAttempt("a");
  if (!attempt) throw new Error("fixture did not load");
  return { chain, records, attempt };
}
it.each([false, true])("recovers another transaction by the payment's identity, legacy=%s", async legacy => {
  const s = await setup(legacy);
  const transaction = s.chain.settle({ from: s.attempt.payer!, to: s.attempt.terms.recipient, value: "10000", nonce: s.attempt.authorizationNonce! });
  s.chain.finalizedLag = 2;
  const paid = await recheckChain(s.records, "a", s.chain.url);
  expect(paid).toMatchObject({ state: "paid_service_failed", chain: "verified", chainFinal: false, transaction, receiptId: "a" });
  expect(s.records.getReceipt("a")).toMatchObject({ transaction, chain: "verified", chainFinal: false });
  expect(exitCodeFor(paid!)).toBe(4);
  s.chain.advance(10);
  expect(await recheckChain(s.records, "a", s.chain.url)).toMatchObject({ state: "paid_service_failed", chainFinal: true });
});
it("resolves a content mismatch unpaid only after unused authorization expiry at a final head", async () => {
  const s = await setup();
  s.chain.advance(400); s.chain.finalizedLag = 1000;
  expect(await recheckChain(s.records, "a", s.chain.url)).toMatchObject({ state: "uncertain", chain: "mismatch" });
  s.chain.finalizedLag = 0;
  const unpaid = await recheckChain(s.records, "a", s.chain.url);
  expect(unpaid).toMatchObject({ state: "failed", chain: "unpaid" });
  expect(exitCodeFor(unpaid!)).toBe(1);
  expect(s.records.spentToday("USDC")).toBe(0);
});
it("never accepts a rejected hash when a later RPC gives it matching-looking content", async () => {
  const s = await setup();
  const transaction = s.attempt.transaction!;
  s.chain.used.set(s.attempt.authorizationNonce!, { payer: s.attempt.payer!, transaction, block: s.chain.head.number, token: BASE_SEPOLIA.usdc.address });
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await fetch(input, init);
    if (call.method !== "eth_getTransactionReceipt") return response;
    const body = await response.json();
    body.result.logs[0].topics[2] = s.attempt.authorizationNonce;
    body.result.logs[1].data = `0x${(10000).toString(16).padStart(64, "0")}`;
    return Response.json(body);
  };
  expect(await recheckChain(s.records, "a", { rpcUrlFor: () => s.chain.url, fetchImpl })).toEqual(s.attempt);
  expect(s.records.getReceipt("a")).toBeUndefined();
});
it.each(["null receipt", "pruned block"])("preserves a three-day-old 0.3.0 verified payment with %s without charging today's cap", async mode => {
  const s = await setup(true);
  const transaction = s.chain.settle({ from: s.attempt.payer!, to: s.attempt.terms.recipient, value: "10000", nonce: s.attempt.authorizationNonce! });
  const at = new Date(Date.now() - 3 * 86400000).toISOString();
  const paid = { ...s.attempt, state: "settled" as const, chain: "verified" as const, transaction, createdAt: at, updatedAt: at, receiptId: "a" };
  s.records.saveAttempt(paid);
  s.records.saveReceipt({ id: "a", attemptId: "a", quoteId: "q", at, url: paid.url, terms: paid.terms, payer: paid.payer!, transaction, transactionKind: "hash", transactionUrl: "", network: paid.terms.network, settlement: { success: true, transaction, network: "eip155:84532" }, chain: "verified", serviceOutcome: "ok", ms: 0 });
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    if ((mode === "null receipt" && call.method === "eth_getTransactionReceipt") || (mode === "pruned block" && call.method === "eth_getBlockByNumber" && !["latest", "finalized"].includes(call.params[0]))) return Response.json({ jsonrpc: "2.0", id: call.id, result: null });
    return fetch(input, init);
  };
  expect(await recheckChain(s.records, "a", { rpcUrlFor: () => s.chain.url, fetchImpl })).toEqual(s.records.getAttempt("a"));
  expect(s.records.getAttempt("a")).toMatchObject({ state: "settled", chain: "verified", chainFinal: null });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "verified", chainFinal: null });
  expect(s.records.spentToday("USDC", new Date(at))).toBe(0.01);
  expect(s.records.spentToday("USDC")).toBe(0);
});
it.each(["none", "authorization only", "transfer only"])("classifies non-final EVM execution with %s payment effect logs as provisional", async mode => {
  const s = await setup();
  s.chain.finalizedLag = 2;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await fetch(input, init);
    if (call.method !== "eth_getTransactionReceipt") return response;
    const body = await response.json();
    body.result.logs[0].topics[2] = s.attempt.authorizationNonce;
    body.result.logs = mode === "none" ? [] : mode === "authorization only" ? [body.result.logs[0]] : [body.result.logs[1]];
    return Response.json(body);
  };
  expect(await checkSettlement({ transaction: s.attempt.transaction, payer: s.attempt.payer!, recipient: s.attempt.terms.recipient, amountAtomic: "10000", nonce: s.attempt.authorizationNonce }, { rpcUrl: s.chain.url, fetchImpl })).toMatchObject({ chain: "mismatch", mismatchKind: "provisional_execution" });
});

it("requires two final unused reads past the payment block before demoting a null receipt", async () => {
  const s = await setup();
  const transaction = s.chain.settle({ from: s.attempt.payer!, to: s.attempt.terms.recipient, value: "10000", nonce: s.attempt.authorizationNonce! });
  s.chain.finalizedLag = 2;
  const included = await recheckChain(s.records, "a", s.chain.url);
  expect(included).toMatchObject({ chain: "verified", chainFinal: false, transaction });
  s.chain.receipts.delete(transaction); s.chain.used.delete(s.attempt.authorizationNonce!);
  expect(await recheckChain(s.records, "a", s.chain.url)).toEqual(included);
  s.chain.advance(10);
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    if (call.method === "eth_call" && ++reads === 4) throw new Error("second final unused read unavailable");
    return fetch(input, init);
  };
  expect(await recheckChain(s.records, "a", { rpcUrlFor: () => s.chain.url, fetchImpl })).toEqual(included);
  expect(await recheckChain(s.records, "a", s.chain.url)).toMatchObject({ state: "uncertain", chain: "unchecked", chainFinal: null, paymentIncluded: true });
  s.chain.advance(1000);
  expect(await recheckChain(s.records, "a", s.chain.url)).toMatchObject({ state: "uncertain", chain: "unchecked" });
});
