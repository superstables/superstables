import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import type { Hex } from "viem";
import { afterEach, expect, it } from "vitest";
import { BASE_SEPOLIA, SOLANA_DEVNET, SKALE_BASE_SEPOLIA, TEMPO_MODERATO } from "../../src/core/chain.js";
import { recheckChain } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { tempoRail } from "../../src/core/rails/tempo.js";
import { startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { solanaRail } from "../../src/core/rails/solana.js";
import { buildPayment, checkSigned } from "../../src/core/rails/solana-transaction.js";
import { checkSettlement } from "../../src/core/settlement.js";
import type { Attempt } from "../../src/core/types.js";
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
  expect(first?.chain).toBe(initialChain); expect(second?.chain).toBe(initialChain);
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
