import { spawn } from "node:child_process";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAYER, SOLANA_PAYER, TX, TEMPO_MARKET, SOLANA_MARKET, startFakePurchaseSite, type FakePurchaseSite, type Paid } from "../helpers/fake-purchase-site.js";

process.env.SUPERSTABLES_HOME = mkdtempSync(join(tmpdir(), "ss-attribution-"));
const { settleOnce, onceTestHook } = await import("../../budget/once.mjs");
const approvals = await import("../../budget/approvals.mjs");
const home = process.env.SUPERSTABLES_HOME;
let site: FakePurchaseSite;
const rails = [
  { rail: "evm", chain: "base-sepolia", service: "demo-market-data", payer: PAYER, tx: TX },
  { rail: "tempo", chain: "moderato", service: TEMPO_MARKET.id, payer: PAYER, tx: `0x${"7e".repeat(32)}` },
  { rail: "solana", chain: "devnet", service: SOLANA_MARKET.id, payer: SOLANA_PAYER, tx: "5".repeat(87) },
];

beforeEach(async () => {
  rmSync(join(home, "budget"), { recursive: true, force: true });
  site = await startFakePurchaseSite();
  site.services.push(TEMPO_MARKET, SOLANA_MARKET);
  for (const key of ["B4_RPC", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) process.env[key] = site.chainUrl;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
afterEach(async () => { onceTestHook.beforeFinal = null; approvals.recordTestHook.inLock = null; await site.close(); });

async function purchase(rail: typeof rails[number]) {
  const response = await fetch(`${site.url}/api/v1/purchases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: rail.service, params: { asset: "BTC" }, max_amount: "0.01" }) });
  expect(response.status).toBe(201);
  const p = site.purchases[site.purchases.length - 1];
  const record = { id: approvals.newApprovalId(), command: "buy-once", rail: rail.rail, chain: rail.chain, createdAt: new Date().toISOString(), state: "waiting_owner", hosted: { kind: "purchase", site: site.url, requestId: p.id, token: p.token, amount: p.service.amount, payTo: p.service.payTo ?? "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E" } };
  approvals.saveApproval(record);
  return { p, record };
}
function unknown(result: Awaited<ReturnType<typeof settleOnce>>) {
  expect(result).toMatchObject({ code: 5, result: { state: "unknown", paid: null } });
  expect(JSON.stringify(result)).not.toMatch(/nothing was paid/);
}

describe("hosted purchase payment identity", () => {
  for (const rail of rails) {
    it(`${rail.rail}: genuine purchase verifies`, async () => {
      const { p, record } = await purchase(rail);
      site.settle(p, "ok", { transaction: rail.tx, payer: rail.payer });
      expect(await settleOnce(record)).toMatchObject({ code: 0, result: { state: "settled", paid: true } });
    });
    if (rail.rail !== "solana") {
      it(`${rail.rail}: rejects another purchase's matching transfer`, async () => {
        const original = await purchase(rail);
        site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
        const target = await purchase(rail);
        site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
        target.p.nonce = `0x${"9a".repeat(32)}`;
        unknown(await settleOnce(target.record));
      });
      it(`${rail.rail}: rejects a receipt with a different transaction hash`, async () => {
        const { p, record } = await purchase(rail);
        site.settle(p, "ok", { transaction: rail.tx, payer: rail.payer, chain: { receiptHash: `0x${"9a".repeat(32)}` } });
        unknown(await settleOnce(record));
      });
    }
    it(`${rail.rail}: one transfer cannot satisfy two local purchase records`, async () => {
      const original = await purchase(rail);
      site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
      expect(await settleOnce(original.record)).toMatchObject({ code: 0, result: { paid: true } });
      const target = await purchase(rail);
      site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
      target.p.nonce = original.p.nonce;
      unknown(await settleOnce(target.record));
    });
  }
  for (const [name, chain] of [
    ["signed by someone else", { signer: "other" }],
    ["with an invalid payer signature", { badSignature: true }],
    ["first signature differs from the claimed ID", { firstSignature: "6".repeat(87) }],
    ["execution metadata is missing", { missingMeta: true }],
  ] satisfies [string, Exclude<Paid["chain"], false | undefined>][]) {
    it(`solana: rejects a transaction ${name}`, async () => {
      const rail = rails[2];
      const { p, record } = await purchase(rail);
      site.settle(p, "ok", { transaction: rail.tx, payer: rail.payer, chain });
      unknown(await settleOnce(record));
    });
  }
  it("evm: concurrent processes can attribute a transfer to only one purchase", async () => {
    const rail = rails[0];
    const original = await purchase(rail);
    site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
    const target = await purchase(rail);
    site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
    target.p.nonce = original.p.nonce;
    let releaseBarrier = () => {};
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let arrived = 0;
    site.onChainRead = async (method) => {
      if (method !== "eth_getTransactionReceipt") return;
      if (++arrived === 2) releaseBarrier();
      await barrier;
    };
    const run = (id: string) => new Promise<string>((resolve, reject) => {
      const script = `import { settleOnce } from "./budget/once.mjs"; import { readApproval } from "./budget/approvals.mjs"; const s = await settleOnce(readApproval(process.argv[1])); console.log(JSON.stringify({ paid: s.result?.paid ?? null }));`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, id], { env: process.env });
      let output = "";
      let error = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { error += data; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error)));
    });
    const outputs = await Promise.all([run(original.record.id), run(target.record.id)]);
    const verdict = z.object({ paid: z.boolean().nullable() });
    const paid = outputs.map((output) => verdict.parse(JSON.parse(output)).paid);
    expect(paid.filter((value) => value === true)).toHaveLength(1);
    expect(paid.filter((value) => value === null)).toHaveLength(1);
    expect(arrived).toBe(2);
    const records = [original.record, target.record].map((record) => approvals.readApproval(record.id));
    expect(records.filter((record) => record.final?.result?.paid === true)).toHaveLength(1);
  });

  it("a transfer claim survives a failed final-record write and permits only its purchase's retry", async () => {
    const rail = rails[0];
    const original = await purchase(rail);
    site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
    onceTestHook.beforeFinal = () => {
      onceTestHook.beforeFinal = null;
      approvals.recordTestHook.inLock = () => {
        approvals.recordTestHook.inLock = null;
        throw new Error("forced final-record write failure");
      };
    };
    await expect(settleOnce(original.record)).rejects.toThrow("forced final-record write failure");
    expect(approvals.readApproval(original.record.id).final).toBeUndefined();
    const target = await purchase(rail);
    site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
    target.p.nonce = original.p.nonce;
    unknown(await settleOnce(target.record));
    expect(await settleOnce(original.record)).toMatchObject({ code: 0, result: { paid: true } });
  });

  it("a legacy cached paid verdict without purchase identity becomes unknown", async () => {
    const { record } = await purchase(rails[0]);
    const seen = { hashes: [TX], payers: { [TX]: PAYER }, named: true, paid: true };
    approvals.updateApproval(record.id, () => ({ seen }));
    approvals.recordFinal(record.id, 0, { paid: true, payer: PAYER, tx: { settle: TX } });
    unknown(await settleOnce(record));
  });

  it("a changed purchase nonce before committing paid preserves uncertainty", async () => {
    const { p, record } = await purchase(rails[0]);
    site.settle(p, "ok", { transaction: TX, payer: PAYER });
    onceTestHook.beforeFinal = () => {
      onceTestHook.beforeFinal = null;
      approvals.updateApproval(record.id, (current: ReturnType<typeof approvals.readApproval>) => ({ seen: { ...current.seen, nonce: `0x${"9a".repeat(32)}` } }));
    };
    unknown(await settleOnce(record));
    expect(approvals.readApproval(record.id).final?.result?.paid).not.toBe(true);
  });

  it("missing purchase identity is unknown and remains readable", async () => {
    const { p, record } = await purchase(rails[0]);
    site.settle(p, "ok", { transaction: TX, payer: PAYER });
    p.nonce = undefined;
    const result = await settleOnce(record);
    unknown(result);
    expect(result).toMatchObject({ result: { final: false } });
    expect(approvals.readApproval(record.id).final).toBeUndefined();
  });

  it("solana: rejects another purchase's signed message", async () => {
    const rail = rails[2];
    const original = await purchase(rail);
    site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
    const target = await purchase(rail);
    site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
    target.p.nonce = `0x${"9a".repeat(32)}`;
    unknown(await settleOnce(target.record));
  });
});
