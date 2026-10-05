import { spawn } from "node:child_process";
import { z } from "zod";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const record = { id: approvals.newApprovalId(), command: "buy-once", rail: rail.rail, chain: rail.chain, createdAt: new Date().toISOString(), state: "waiting_owner", attributionVersion: 1, hosted: { kind: "purchase", site: site.url, requestId: p.id, token: p.token, amount: p.service.amount, payTo: p.service.payTo ?? "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E" } };
  approvals.saveApproval(record);
  return { p, record };
}
function runNode(script: string, args: string[] = []) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], { env: process.env });
    let output = "";
    let error = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error)));
  });
}
function claimFile(rail: typeof rails[number]) {
  return join(home, "budget", "once", `attributed-${rail.rail}-${rail.chain}-${rail.tx}.json`);
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
      const result = await settleOnce(record);
      unknown(result);
      if (name === "first signature differs from the claimed ID") expect(result.result.reason).toContain("first signature");
      if (name === "signed by someone else" || name === "with an invalid payer signature") expect(result.result.reason).toContain("does not carry this payer's signature");
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
    const script = `import { settleOnce } from "./budget/once.mjs"; import { readApproval } from "./budget/approvals.mjs"; const s = await settleOnce(readApproval(process.argv[1])); console.log(JSON.stringify({ paid: s.result?.paid ?? null }));`;
    const outputs = await Promise.all([runNode(script, [original.record.id]), runNode(script, [target.record.id])]);
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

  for (const failAt of [1, 2, 3]) {
    it(`a failure at claim fsync ${failAt} cannot commit paid and keeps the purchase retriable`, async () => {
      const { p, record } = await purchase(rails[0]);
      site.settle(p, "ok", { transaction: TX, payer: PAYER });
      const script = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const events = [];
        const sync = fs.fsyncSync;
        const link = fs.linkSync;
        let calls = 0;
        fs.fsyncSync = (fd) => {
          events.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
          if (++calls === Number(process.argv[2])) throw new Error("forced fsync failure");
          return sync(fd);
        };
        fs.linkSync = (...args) => { if (args[1].includes("/once/attributed-")) events.push("link"); return link(...args); };
        syncBuiltinESMExports();
        const { settleOnce } = await import("./budget/once.mjs");
        const { readApproval } = await import("./budget/approvals.mjs");
        let error = null;
        try { await settleOnce(readApproval(process.argv[1])); } catch (e) { error = e.message; }
        console.log(JSON.stringify({ error, events }));`;
      const output = z.object({ error: z.string().nullable(), events: z.array(z.string()) }).parse(JSON.parse(await runNode(script, [record.id, String(failAt)])));
      expect(output.error).toBe("forced fsync failure");
      expect(output.events.slice(0, failAt === 3 ? 4 : failAt)).toEqual(failAt === 1 ? ["file"] : failAt === 2 ? ["file", "directory"] : ["file", "directory", "link", "directory"]);
      expect(existsSync(claimFile(rails[0]))).toBe(failAt === 3);
      expect(approvals.readApproval(record.id).final).toBeUndefined();
      expect(approvals.readApproval(record.id).hosted.token).toBe(p.token);
      expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
    });
  }

  for (const [name, content] of [["empty", ""], ["malformed", "{"], ["invalid key", '["site"]']] satisfies [string, string][]) {
    it(`a ${name} claim stays undecided, keeps its access token and retries on the next read`, async () => {
      const { p, record } = await purchase(rails[0]);
      site.settle(p, "ok", { transaction: TX, payer: PAYER });
      const file = claimFile(rails[0]);
      mkdirSync(join(home, "budget", "once"), { recursive: true });
      writeFileSync(file, content);
      const result = await settleOnce(record);
      unknown(result);
      expect(result).toMatchObject({ result: { final: false } });
      expect(result.result.reason).toContain("its attribution claim could not be read");
      expect(result.result.reason).not.toContain("already attributed");
      expect(result.result.next).not.toContain("the chain does not show");
      expect(approvals.readApproval(record.id)).toMatchObject({ hosted: { token: p.token } });
      expect(approvals.readApproval(record.id).final).toBeUndefined();
      expect((await settleOnce(record)).result).toMatchObject({ final: false, paid: null });
      rmSync(file);
      expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([site.url, p.id]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(approvals.readApproval(record.id).hosted.token).toBeUndefined();
    });
  }

  it("an unreadable claim stays undecided without discarding its access token", async () => {
    const { p, record } = await purchase(rails[0]);
    site.settle(p, "ok", { transaction: TX, payer: PAYER });
    mkdirSync(claimFile(rails[0]), { recursive: true });
    const result = await settleOnce(record);
    unknown(result);
    expect(result.result).toMatchObject({ final: false });
    expect(approvals.readApproval(record.id).hosted.token).toBe(p.token);
    expect(approvals.readApproval(record.id).final).toBeUndefined();
    rmSync(claimFile(rails[0]), { recursive: true });
    expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
  });

  it("an empty claim appearing before the paid commit stays retriable", async () => {
    const { p, record } = await purchase(rails[0]);
    site.settle(p, "ok", { transaction: TX, payer: PAYER });
    onceTestHook.beforeFinal = () => {
      onceTestHook.beforeFinal = null;
      mkdirSync(join(home, "budget", "once"), { recursive: true });
      writeFileSync(claimFile(rails[0]), "");
    };
    unknown(await settleOnce(record));
    expect(approvals.readApproval(record.id).final).toBeUndefined();
    expect(approvals.readApproval(record.id).hosted.token).toBe(p.token);
    rmSync(claimFile(rails[0]));
    expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
  });

  it("cleans dead-writer and already-linked claim temporaries while preserving active writers and unrelated files", async () => {
    const { p, record } = await purchase(rails[0]);
    site.settle(p, "ok", { transaction: TX, payer: PAYER });
    const file = claimFile(rails[0]);
    mkdirSync(join(home, "budget", "once"), { recursive: true });
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const dead = `${file}.2147483647.${uuid}.tmp`;
    const active = `${file}.${process.pid}.${uuid}.tmp`;
    const linked = `${file}.${uuid}.tmp`;
    const unrelated = join(home, "budget", "once", "unrelated.tmp");
    for (const tmp of [dead, active, unrelated]) writeFileSync(tmp, "unfinished");
    writeFileSync(linked, JSON.stringify([site.url, p.id]));
    linkSync(linked, file);
    expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(readdirSync(join(home, "budget", "once")).filter((name) => name.startsWith("attributed-") && name.endsWith(".tmp"))).toEqual([active.split("/").at(-1)]);
  });

  for (const code of [0, 4]) {
    it(`preserves a legacy cached paid outcome with exit ${code} and marks its attribution limit`, async () => {
      const { record } = await purchase(rails[0]);
      approvals.updateApproval(record.id, () => ({ attributionVersion: undefined }));
      const result = { state: "settled", paid: true, delivered: code === 0, amount: "0.01", payer: PAYER, tx: { settle: TX }, responseFile: "saved-response", next: "recorded instructions", reason: "recorded reason" };
      approvals.recordFinal(record.id, code, result);
      const expected = { ...result, attribution: "not verified (recorded by an older version)" };
      expect(await settleOnce(record)).toMatchObject({ code, result: expected });
      expect(approvals.readApproval(record.id).final).toEqual({ code, result: expected });
      expect(await settleOnce(record)).toMatchObject({ code, result: expected });
      const target = await purchase(rails[0]);
      site.settle(target.p, "ok", { transaction: TX, payer: PAYER });
      unknown(await settleOnce(target.record));
    });
  }

  it("a new cached paid verdict without verified attribution becomes unknown", async () => {
    const { record } = await purchase(rails[0]);
    const seen = { hashes: [TX], payers: { [TX]: PAYER }, named: true, paid: true };
    approvals.updateApproval(record.id, () => ({ seen }));
    approvals.recordFinal(record.id, 0, { paid: true, payer: PAYER, tx: { settle: TX } });
    unknown(await settleOnce(record));
  });

  it("a Tempo transfer with a different memo reports a memo mismatch", async () => {
    const rail = rails[1];
    const { p, record } = await purchase(rail);
    site.settle(p, "ok", { transaction: rail.tx, payer: rail.payer, chain: { nonce: `0x${"9a".repeat(32)}` } });
    const result = await settleOnce(record);
    unknown(result);
    expect(result.result.reason).toContain(`transaction ${rail.tx} does not carry this purchase's memo`);
    expect(result.result.reason).not.toContain("has no transfer of exactly");
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
    expect(result.result.reason).toContain("no payment identity or payer");
    expect(result.result.next).toContain("payment that cannot be verified yet");
    expect(result.result.next).not.toContain("the chain does not show");
  });

  it("solana: rejects another purchase's signed message", async () => {
    const rail = rails[2];
    const original = await purchase(rail);
    site.settle(original.p, "ok", { transaction: rail.tx, payer: rail.payer });
    const target = await purchase(rail);
    site.settle(target.p, "ok", { transaction: rail.tx, payer: rail.payer, chain: false });
    target.p.nonce = `0x${"9a".repeat(32)}`;
    const result = await settleOnce(target.record);
    unknown(result);
    expect(result.result.reason).toContain("signed message that does not match this purchase's payment identity");
  });
});
