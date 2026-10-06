import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { afterEach, expect, it } from "vitest";
import { Records, BASE_SEPOLIA, SOLANA_DEVNET, TEMPO_MODERATO, type Attempt, type Receipt } from "../../src/index.js";
import { recheckChain, shownAttempt, shownReceipt } from "../../src/core/pay.js";
import { startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { startFakeTempoPay } from "../helpers/fake-tempo-pay.js";
import { MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet } from "../helpers/fake-solana-pay.js";
import { buildPayment, checkSigned } from "../../src/core/rails/solana-transaction.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });
const payer = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const nonce = `0x${"44".repeat(32)}` as const;

async function setup(rail: "evm" | "solana" | "tempo") {
  const dir = mkdtempSync(join(tmpdir(), "sdk-chain-contract-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const records = new Records(dir);
  let network = BASE_SEPOLIA.caip2;
  let token: string = BASE_SEPOLIA.usdc.address;
  let owner = payer;
  let to = recipient;
  let facts: Partial<Attempt> = {};
  let rpc: string;
  let transaction: string;
  let remove: () => void;
  let restore: () => void;
  if (rail === "evm") {
    const chain = await startFakeBaseSepolia(); cleanup.push(() => chain.close());
    rpc = chain.url;
    const landed = chain.settle({ from: payer, to: recipient, value: "10000", nonce });
    transaction = landed;
    facts = { authorizationNonce: nonce, authorizationValidBefore: new Date(Date.now() + 86400000).toISOString() };
    const receipt = chain.receipts.get(landed)!; const used = chain.used.get(nonce)!;
    remove = () => { chain.receipts.delete(landed); chain.used.delete(nonce); };
    restore = () => { chain.receipts.set(landed, receipt); chain.used.set(nonce, used); };
  } else if (rail === "tempo") {
    const chain = await startFakeTempoPay(); cleanup.push(() => chain.close());
    rpc = chain.url;
    network = TEMPO_MODERATO.caip2; token = TEMPO_MODERATO.token.address;
    const landed = chain.mine({ from: payer, to: recipient, amount: 10000n, memo: nonce, token: TEMPO_MODERATO.token.address });
    transaction = landed;
    facts = { paymentMemo: nonce, searchFromBlock: "0" };
    const transfer = chain.transfers.get(landed)!;
    remove = () => { chain.transfers.delete(landed); };
    restore = () => { chain.transfers.set(landed, transfer); };
  } else {
    const chain = await startFakeDevnet(); cleanup.push(() => chain.close());
    rpc = chain.url;
    network = SOLANA_DEVNET.caip2; token = MINT;
    const key = solanaKey(); owner = key.address; to = randomAddress();
    const built = buildPayment({ owner, recipient: to, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    const signed = signAsOwner(built.transaction, key);
    const checked = checkSigned(signed, { ...built, owner });
    if (!checked.ok) throw new Error(checked.reason);
    transaction = chain.land(signed);
    facts = { ownerSignature: checked.signature, searchFromSlot: 300010, lastValidBlockHeight: 300150 };
    const tx = chain.txs.get(transaction)!;
    remove = () => { chain.txs.delete(transaction); };
    restore = () => { chain.txs.set(transaction, tx); };
  }
  const at = new Date(Date.now() - 86400000).toISOString();
  const terms: Attempt["terms"] = { network, networkLabel: rail, asset: rail === "tempo" ? "pathUSD" : "USDC", assetAddress: token, amountAtomic: "10000", amountDecimal: 0.01, recipient: to, scheme: "exact" };
  const attempt: Attempt = { id: "a", quoteId: "q", createdAt: at, updatedAt: at, state: "settled", chain: "unchecked", transaction, payer: owner, url: "https://seller.example", terms, receiptId: "a", history: [], ...facts };
  const receipt: Receipt = { id: "a", at, attemptId: "a", quoteId: "q", url: attempt.url, terms, payer: owner, transaction, transactionKind: "hash", transactionUrl: "", network, settlement: { success: true, transaction, network: rail === "solana" ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" : rail === "tempo" ? "eip155:42431" : "eip155:84532" }, chain: "unchecked", serviceOutcome: "ok", ms: 0 };
  records.saveAttempt(attempt); records.saveReceipt(receipt);
  let final = false;
  let failGone = false;
  let goneReads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    if (failGone && call.method === (rail === "solana" ? "getTransaction" : "eth_getTransactionReceipt") && ++goneReads === (rail === "solana" ? 3 : 2)) throw new Error("second gone observation unavailable");
    if (!final && call.method === "eth_getBlockByNumber" && call.params[0] === (rail === "tempo" ? "latest" : "finalized")) return Response.json({ jsonrpc: "2.0", id: call.id, result: { number: "0x0", timestamp: "0x0" } });
    if (!final && call.method === "getTransaction" && call.params[1].commitment === "finalized") return Response.json({ jsonrpc: "2.0", id: call.id, result: null });
    return fetch(input, init);
  };
  return { records, dir, attempt, receipt, options: { rpcUrlFor: () => rpc, fetchImpl }, remove, restore, finalize: () => { final = true; }, failSecondGone: () => { failGone = true; goneReads = 0; }, allowGone: () => { failGone = false; } };
}

it.each(["evm", "solana", "tempo"] as const)("keeps the 0.3.0 SDK chain contract and observes provisional/final evidence on %s", async rail => {
  const s = await setup(rail);
  const included = await recheckChain(s.records, "a", s.options);
  expect(included).toMatchObject({ state: "settled", chain: "verified", chainFinal: false });
  expect(s.records.getAttempt("a")).toMatchObject({ chain: "verified", chainFinal: false });
  expect(s.records.listReceipts()).toEqual([expect.objectContaining({ chain: "verified", chainFinal: false })]);
  expect(shownAttempt(included!)).toMatchObject({ chain: "verified", chain_final: false });
  expect(shownReceipt(s.records.getReceipt("a")!)).toMatchObject({ chain: "verified", chain_final: false });
  expect(s.records.spentToday("USDC")).toBe(0.01);
  expect(await recheckChain(s.records, "a", { rpcUrlFor: s.options.rpcUrlFor, fetchImpl: async () => { throw new Error("RPC unavailable"); } })).toEqual(included);
  s.finalize();
  expect(await recheckChain(s.records, "a", s.options)).toMatchObject({ chain: "verified", chainFinal: true });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "verified", chainFinal: true });
  expect(s.records.spentToday("USDC")).toBe(0);
  s.remove();
  expect(await recheckChain(s.records, "a", s.options)).toMatchObject({ state: "settled", chain: "verified", chainFinal: true });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "verified", chainFinal: true });
});

it.each(["evm", "solana", "tempo"] as const)("demotes provisional SDK evidence only after successful gone reads on %s", async rail => {
  const s = await setup(rail);
  const included = await recheckChain(s.records, "a", s.options);
  expect(included).toMatchObject({ chain: "verified", chainFinal: false });
  s.remove(); s.failSecondGone();
  expect(await recheckChain(s.records, "a", s.options)).toEqual(included);
  s.allowGone();
  expect(await recheckChain(s.records, "a", s.options)).toMatchObject({ state: "uncertain", chain: "unchecked", chainFinal: null });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "unchecked", chainFinal: null });
  expect(s.records.spentToday("USDC")).toBe(0.01);
});

it.each(["evm", "solana", "tempo"] as const)("loads actual 0.3.0 SDK records without inventing finality on %s", async rail => {
  const s = await setup(rail);
  appendFileSync(join(s.dir, "attempts.jsonl"), JSON.stringify({ ...s.attempt, chain: "verified" }) + "\n");
  appendFileSync(join(s.dir, "receipts.jsonl"), JSON.stringify({ ...s.receipt, chain: "verified" }) + "\n");
  expect(s.records.getAttempt("a")).toEqual({ ...s.attempt, chain: "verified", chainFinal: null });
  expect(s.records.getReceipt("a")).toEqual({ ...s.receipt, chain: "verified", chainFinal: null });
  expect(s.records.listAttempts()[0]).toHaveProperty("chainFinal", null);
  expect(s.records.listReceipts()[0]).toHaveProperty("chainFinal", null);
  expect(await recheckChain(s.records, "a", s.options)).toMatchObject({ chain: "verified", chainFinal: false });
});

it.each(["evm", "solana", "tempo"] as const)("keeps final SDK evidence when an older gone read finishes on %s", async rail => {
  const s = await setup(rail);
  expect(await recheckChain(s.records, "a", s.options)).toMatchObject({ chainFinal: false });
  s.remove();
  let release!: () => void;
  let ready!: () => void;
  const observed = new Promise<void>(resolve => { ready = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await s.options.fetchImpl(input, init);
    const lastRead = rail === "evm" ? call.method === "eth_call" : rail === "tempo" ? call.method === "eth_getBlockByNumber" && call.params[0] === "latest" : call.method === "getSignaturesForAddress";
    if (lastRead) { ready(); await resume; }
    return response;
  };
  const stale = recheckChain(s.records, "a", { ...s.options, fetchImpl });
  await observed;
  s.restore(); s.finalize();
  const final = await recheckChain(s.records, "a", s.options);
  expect(final).toMatchObject({ state: "settled", chain: "verified", chainFinal: true });
  release();
  expect(await stale).toEqual(final);
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "verified", chainFinal: true });
});

it.each(["evm", "solana", "tempo"] as const)("keeps a recorded content mismatch terminal despite matching-looking reads on %s", async rail => {
  const s = await setup(rail);
  const mismatch = s.records.saveAttempt({ ...s.attempt, chain: "mismatch", chainMismatch: "content", chainFinal: null });
  s.records.saveReceipt({ ...s.receipt, chain: "mismatch", chainMismatch: "content", chainFinal: null });
  s.finalize();
  let reads = 0;
  const options = { ...s.options, fetchImpl: async (...args: Parameters<typeof fetch>) => { reads++; return s.options.fetchImpl(...args); } };
  expect(await recheckChain(s.records, "a", options)).toEqual(mismatch);
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "mismatch", chainMismatch: "content", chainFinal: null });
  expect(reads).toBe(0);
});

it.each(["evm", "solana", "tempo"] as const)("keeps an actual 0.3.0 mismatch terminal on %s", async rail => {
  const s = await setup(rail);
  appendFileSync(join(s.dir, "attempts.jsonl"), JSON.stringify({ ...s.attempt, chain: "mismatch" }) + "\n");
  appendFileSync(join(s.dir, "receipts.jsonl"), JSON.stringify({ ...s.receipt, chain: "mismatch" }) + "\n");
  s.finalize();
  expect(await recheckChain(s.records, "a", s.options)).toEqual({ ...s.attempt, chain: "mismatch", chainFinal: null });
  expect(s.records.getReceipt("a")).toEqual({ ...s.receipt, chain: "mismatch", chainFinal: null });
});

it.each(["evm", "solana", "tempo"] as const)("rechecks provisional failed execution with the full payment identity on %s", async rail => {
  const s = await setup(rail);
  let reverted = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await s.options.fetchImpl(input, init);
    if (reverted && (call.method === "eth_getTransactionReceipt" || call.method === "getTransaction")) {
      const answer = await response.json();
      if (answer.result) {
        if (rail === "solana") answer.result.meta.err = { InstructionError: [0, "Custom"] };
        else answer.result.status = "0x0";
      }
      return Response.json(answer);
    }
    return response;
  };
  const options = { ...s.options, fetchImpl };
  expect(await recheckChain(s.records, "a", options)).toMatchObject({ state: "uncertain", chain: "mismatch", chainMismatch: "provisional_execution", chainFinal: null });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "mismatch", chainMismatch: "provisional_execution", chainFinal: null });
  reverted = false; s.finalize();
  expect(await recheckChain(s.records, "a", options)).toMatchObject({ state: "settled", chain: "verified", chainFinal: true });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "verified", chainFinal: true });
});

it.each(["evm", "solana", "tempo"] as const)("rejects a successful execution that still has the wrong signed amount on %s", async rail => {
  const s = await setup(rail);
  const terms = { ...s.attempt.terms, amountAtomic: "20000", amountDecimal: 0.02 };
  s.records.saveAttempt({ ...s.attempt, terms, state: "uncertain", chain: "mismatch", chainMismatch: "provisional_execution" });
  s.records.saveReceipt({ ...s.receipt, terms, chain: "mismatch", chainMismatch: "provisional_execution" });
  s.finalize();
  const mismatch = await recheckChain(s.records, "a", s.options);
  expect(mismatch).toMatchObject({ state: "uncertain", chain: "mismatch", chainMismatch: "content", chainFinal: null });
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "mismatch", chainMismatch: "content", chainFinal: null });
  expect(await recheckChain(s.records, "a", s.options)).toEqual(mismatch);
});

it.each(["evm", "solana", "tempo"] as const)("makes a finalized execution mismatch terminal on %s", async rail => {
  const s = await setup(rail);
  s.finalize();
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = JSON.parse(String(init?.body));
    const response = await s.options.fetchImpl(input, init);
    if (call.method === "eth_getTransactionReceipt" || call.method === "getTransaction") {
      const answer = await response.json();
      if (answer.result) {
        if (rail === "solana") answer.result.meta.err = { InstructionError: [0, "Custom"] };
        else answer.result.status = "0x0";
      }
      return Response.json(answer);
    }
    return response;
  };
  const mismatch = await recheckChain(s.records, "a", { ...s.options, fetchImpl });
  expect(mismatch).toMatchObject({ state: "uncertain", chain: "mismatch", chainMismatch: "final_execution", chainFinal: null });
  expect(await recheckChain(s.records, "a", s.options)).toEqual(mismatch);
});

it.each(["content", undefined] as const)("keeps a %s mismatch when a late seller answer looks paid", async kind => {
  const s = await setup("evm");
  const mismatch = s.records.saveAttempt({ ...s.attempt, chain: "mismatch", chainMismatch: kind, chainFinal: null });
  s.records.saveReceipt({ ...s.receipt, chain: "mismatch", chainMismatch: kind });
  s.records.savePendingAnswer({ ...s.receipt, chain: "verified", chainFinal: true });
  expect(await recheckChain(s.records, "a", s.options)).toEqual(mismatch);
  expect(s.records.getReceipt("a")).toMatchObject({ chain: "mismatch", chainFinal: null });
  expect(s.records.pendingAnswer("a")).toBeUndefined();
});
