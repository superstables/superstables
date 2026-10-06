import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import type { Hex } from "viem";
import { afterEach, expect, it } from "vitest";
import { BASE_SEPOLIA, SOLANA_DEVNET, SKALE_BASE_SEPOLIA, TEMPO_MODERATO } from "../../src/core/chain.js";
import { PaymentEngine, recheckChain } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { tempoRail } from "../../src/core/rails/tempo.js";
import { startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { solanaRail } from "../../src/core/rails/solana.js";
import { buildPayment, checkSigned } from "../../src/core/rails/solana-transaction.js";
import { checkSettlement } from "../../src/core/settlement.js";
import type { Attempt } from "../../src/core/types.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { SignRefused } from "../../src/core/signer/types.js";
import { startFacilitator, startPaidEndpoint, startWallet } from "../helpers/servers.js";
import { startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet } from "../helpers/fake-solana-pay.js";
const PAYER = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const NONCE: Hex = `0x${"44".repeat(32)}`;
const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
it.each(["unchecked", "mismatch"] as const)("status rechecks provisional payment after a reorg removes its receipt, initially %s", async (initialChain) => {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  const dir = mkdtempSync(join(tmpdir(), "pay-finality-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  const transaction = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE });
  chain.finalizedLag = 2;
  const at = new Date().toISOString();
  const a: Attempt = { id: "a", quoteId: "q", createdAt: at, updatedAt: at, state: "settled", chain: initialChain, transaction, url: "https://seller.example", payer: PAYER, authorizationNonce: NONCE, authorizationValidBefore: new Date((chain.head.timestamp + 300) * 1000).toISOString(), terms: { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: TO, scheme: "exact" }, history: [] };
  records.saveAttempt(a);
  const first = await recheckChain(records, "a", chain.url);
  chain.receipts.delete(transaction); chain.used.delete(NONCE);
  const second = await recheckChain(records, "a", chain.url);
  expect(first?.chain).toBe("unchecked"); expect(second?.chain).toBe("unchecked");
  expect(second?.state).toBe("uncertain");
  const replacement = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE });
  chain.advance(10);
  expect(await recheckChain(records, "a", chain.url)).toMatchObject({ chain: "verified", transaction: replacement });
});
it("rejects a successful EVM receipt whose canonical block hash changed", async () => {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  const transaction = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE });
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await fetch(input, init);
    if (call.method !== "eth_getTransactionReceipt") return response;
    const answer = await response.json();
    answer.result.blockHash = `0x${"ff".repeat(32)}`;
    return Response.json(answer);
  };
  expect((await checkSettlement({ transaction, payer: PAYER, recipient: TO, amountAtomic: "10000", nonce: NONCE }, { rpcUrl: chain.url, fetchImpl })).chain).toBe("unchecked");
});
it("does not verify a confirmed Solana transaction before finalized commitment serves it", async () => {
  const chain = await startFakeDevnet(); cleanup.push(() => chain.close());
  const owner = solanaKey(); const recipient = randomAddress();
  const built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
  const signed = signAsOwner(built.transaction, owner);
  const checked = checkSigned(signed, { ...built, owner: owner.address });
  if (!checked.ok) throw new Error(checked.reason);
  const transaction = chain.land(signed);
  let finalized = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    if (call.method === "getTransaction" && call.params[1].commitment === "finalized" && !finalized) return Response.json({ jsonrpc: "2.0", id: call.id, result: null });
    return fetch(input, init);
  };
  const facts = { network: SOLANA_DEVNET.caip2, payer: owner.address, recipient, amountAtomic: "10000", ownerSignature: checked.signature, transaction };
  expect((await solanaRail.checkPayment(facts, { rpcUrlFor: () => chain.url, fetchImpl })).chain).toBe("unchecked");
  finalized = true;
  expect(await solanaRail.checkPayment(facts, { rpcUrlFor: () => chain.url, fetchImpl })).toEqual({ chain: "verified" });
});

it("requires canonical inclusion on instant-finality Tempo", async () => {
  const chain = await startFakeTempoPay(); cleanup.push(() => chain.close());
  const transaction = chain.mine({ from: PAYER, to: TO, amount: 10000n, memo: NONCE, token: TEMPO_MODERATO.token.address });
  const facts = { network: TEMPO_MODERATO.caip2, transaction, payer: PAYER, recipient: TO, amountAtomic: "10000", memo: NONCE };
  let unavailable = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    if (call.method === "eth_getBlockByNumber" && unavailable) return Response.json({ jsonrpc: "2.0", id: call.id, result: null });
    return fetch(input, init);
  };
  const options = { rpcUrlFor: () => chain.url, fetchImpl };
  expect((await tempoRail.checkPayment(facts, options)).chain).toBe("unchecked");
  unavailable = false;
  expect(await tempoRail.checkPayment(facts, options)).toEqual({ chain: "verified" });
});
it("uses the EVM instant-finality exception only for pinned SKALE", async () => {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  chain.finalizedLag = undefined;
  const baseTx = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE });
  expect((await checkSettlement({ transaction: baseTx, payer: PAYER, recipient: TO, amountAtomic: "10000", nonce: NONCE }, { rpcUrl: chain.url })).chain).toBe("unchecked");
  const transaction = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE, token: SKALE_BASE_SEPOLIA.usdc.address });
  expect(await checkSettlement({ network: SKALE_BASE_SEPOLIA.caip2, transaction, payer: PAYER, recipient: TO, amountAtomic: "10000", nonce: NONCE }, { rpcUrl: chain.url })).toEqual({ chain: "verified" });
});


it("rechecks a prior day's landed payment before admitting the next payment under the daily cap", async () => {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  const dir = mkdtempSync(join(tmpdir(), "cap-finality-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const transaction = chain.settle({ from: PAYER, to: TO, value: "10000", nonce: NONCE });
  const terms = { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: TO, scheme: "exact" };
  const prior: Attempt = { id: "prior", quoteId: "old-quote", createdAt: yesterday, updatedAt: yesterday, state: "settled", chain: "unchecked", paymentIncluded: true, transaction, url: "https://seller.example", payer: PAYER, authorizationNonce: NONCE, authorizationValidBefore: new Date(Date.now() + 86400000).toISOString(), terms, receiptId: "prior", history: [] };
  records.saveAttempt(prior);
  records.saveReceipt({ id: "prior", at: yesterday, attemptId: "prior", quoteId: "old-quote", url: prior.url, terms, payer: PAYER, transaction, transactionKind: "hash", transactionUrl: "", network: BASE_SEPOLIA.caip2, settlement: { success: true, transaction, network: "eip155:84532" }, chain: "unchecked", paymentIncluded: true, serviceOutcome: "ok", ms: 0 });
  expect(records.spentToday("USDC")).toBe(0.01);
  const facilitator = await startFacilitator(); cleanup.push(() => facilitator.close());
  const seller = await startPaidEndpoint(facilitator.url); cleanup.push(() => seller.close());
  let asked = 0;
  const policy = { ...DEFAULT_POLICY, perDay: { amount: 0.01, asset: "USDC" } };
  const engine = new PaymentEngine({ records, policy, rpcUrl: chain.url, signer: { kind: "wallet", async address() { return PAYER; }, async sign() { asked++; throw new SignRefused("denied", "test declined before signing"); } } });
  const next = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records, policy });
  const attempt = engine.startPayment(next.id);
  await engine.waitForAttempt(attempt.id, 5000);
  expect(asked).toBe(1);
  expect(records.getAttempt("prior")?.chain).toBe("verified");
  expect(records.spentToday("USDC")).toBe(0);
});

it("counts an included provisional receipt after UTC midnight even when the signed authorization expired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "included-cap-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const terms = { network: BASE_SEPOLIA.caip2, networkLabel: BASE_SEPOLIA.label, asset: "USDC", assetAddress: BASE_SEPOLIA.usdc.address, amountAtomic: "10000", amountDecimal: 0.01, recipient: TO, scheme: "exact" };
  records.saveAttempt({ id: "a", quoteId: "q", createdAt: yesterday, updatedAt: yesterday, state: "settled", chain: "unchecked", paymentIncluded: true, authorizationValidBefore: yesterday, url: "https://seller.example", terms, receiptId: "a", history: [] });
  records.saveReceipt({ id: "a", at: yesterday, attemptId: "a", quoteId: "q", url: "https://seller.example", terms, payer: PAYER, transaction: `0x${"ab".repeat(32)}`, transactionKind: "hash", transactionUrl: "", network: BASE_SEPOLIA.caip2, settlement: { success: true, transaction: "", network: "eip155:84532" }, chain: "unchecked", paymentIncluded: true, serviceOutcome: "ok", ms: 0 });
  expect(records.spentToday("USDC")).toBe(0.01);
});


it("reports a matching included payment as paid even when the seller says settlement failed", async () => {
  const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
  chain.finalizedLag = 2;
  const facilitator = await startFacilitator(); cleanup.push(() => facilitator.close());
  const seller = await startPaidEndpoint(facilitator.url); cleanup.push(() => seller.close());
  const wallet = await startWallet(); cleanup.push(() => wallet.close());
  const dir = mkdtempSync(join(tmpdir(), "included-denied-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, rpcUrl: chain.url, signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3000 }), fetchImpl: async (input, init) => {
    const res = await fetch(input, init);
    if (!new Headers(init?.headers).has("payment-signature")) return res;
    const transaction = chain.settle(facilitator.lastAuthorization!);
    return new Response("{}", { status: 402, headers: { "payment-response": encodePaymentResponseHeader({ success: false, transaction, network: "eip155:84532" }) } });
  } });
  const q = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
  const a = await engine.waitForAttempt(engine.startPayment(q.id).id, 5000);
  expect(a).toMatchObject({ state: "paid_service_failed", chain: "unchecked", paymentIncluded: true });
  expect(records.getReceipt(a.receiptId!)?.paymentIncluded).toBe(true);
  expect(records.spentToday("USDC")).toBe(0.01);
  chain.receipts.delete(a.transaction!);
  chain.used.delete(a.authorizationNonce!);
  expect(await recheckChain(records, a.id, chain.url)).toMatchObject({ state: "uncertain", paymentIncluded: true });
  expect(records.getReceipt(a.receiptId!)?.paymentIncluded).toBeUndefined();
  expect(records.getReceipt(a.receiptId!)?.chainReason).toContain("Do not pay again");
  expect(records.spentToday("USDC")).toBe(0.01);
});
