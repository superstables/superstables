// A second `pay` on a quote that another process just claimed. The claim file names the first payment at once; its
// attempt record is readable only after the first process has flushed everything else, which a loaded disk can make
// slow. The second `pay` waits for it in real time, and when it still is not there, names the payment from the claim
// instead of sending the agent to quote again while that payment may be live.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine, QuoteUsedError } from "../../src/core/pay.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";
import { startFacilitator, startPaidEndpoint, type TestServer } from "../helpers/servers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const LATE_ATTEMPT = resolve(ROOT, "test/helpers/late-attempt.ts");
const CLI = resolve(ROOT, "src/cli/main.ts");

// The owner is never asked here: the test is about who holds the quote.
const signer: Signer = { kind: "browser", address: async () => `0x${"11".repeat(20)}`, sign: () => new Promise(() => {}) };

const servers: TestServer[] = [];
const dirs: string[] = [];
let url = "";

beforeAll(async () => {
  const facilitator = await startFacilitator();
  const seller = await startPaidEndpoint(facilitator.url);
  servers.push(facilitator, seller);
  url = `${seller.url}/v1/market?asset=BTC`;
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "superstables-claim-wait-"));
  dirs.push(dir);
  return dir;
}

/** An open quote in fresh records, claimed by an attempt that has no record (yet). */
async function claimedQuote(attemptId: string): Promise<{ records: Records; quoteId: string }> {
  const records = new Records(scratch());
  const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
  expect(records.claimQuote(q.id, attemptId)).toBeUndefined();
  return { records, quoteId: q.id };
}

function engineOver(records: Records): PaymentEngine {
  return new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, fetchImpl: () => new Promise(() => {}) });
}

function refusal(engine: PaymentEngine, quoteId: string): { error: QuoteUsedError; ms: number } {
  const started = performance.now();
  try {
    engine.startPayment(quoteId);
  } catch (err) {
    expect(err).toBeInstanceOf(QuoteUsedError);
    return { error: err as QuoteUsedError, ms: performance.now() - started };
  }
  throw new Error("startPayment did not refuse a claimed quote");
}

describe("a second pay on a claimed quote", () => {
  it("waits for the first payment's record when it is written 600 ms late", async () => {
    const id = randomUUID();
    const { records, quoteId } = await claimedQuote(id);
    // The second pay blocks this process while it waits, so the record is written by another one. Its 600 ms start
    // once it has loaded, which is when the wait below begins.
    const writer = spawn(process.execPath, [TSX, LATE_ATTEMPT, records.dir, quoteId, id, "600"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise<void>((done) => writer.once("exit", () => done()));
    await new Promise<void>((ready, fail) => {
      writer.once("error", fail);
      writer.stdout.on("data", (chunk) => String(chunk).includes("ready") && ready());
    });
    const { error } = refusal(engineOver(records), quoteId);
    await exited;
    expect(error.attempt?.id).toBe(id);
    expect(error.message).toContain(`A payment for this quote already exists: attempt ${id}, awaiting_approval`);
    expect(error.message).not.toContain("quote again");
  }, 30_000);

  it("names the payment from the claim, and says to follow it, when the record never appears", async () => {
    const id = randomUUID();
    const { records, quoteId } = await claimedQuote(id);
    const { error, ms } = refusal(engineOver(records), quoteId);
    expect(error.attempt).toBeUndefined();
    expect(error.attemptId).toBe(id);
    expect(error.message).toContain(`attempt ${id}`);
    expect(error.message).toContain(`\`superstables status ${id}\``);
    expect(error.message).toContain("a minute from now");
    expect(error.message).not.toContain("quote again before paying");
    expect(error.message).not.toContain("only if status says there is no such attempt");
    expect(ms).toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThanOrEqual(2_500);
  }, 15_000);

  it("names a payment whose quote is already marked used but whose attempt line is not written yet", async () => {
    const id = randomUUID();
    const { records, quoteId } = await claimedQuote(id);
    records.saveQuote({ ...records.getQuote(quoteId)!, status: "used" });
    const { error, ms } = refusal(engineOver(records), quoteId);
    expect(error.attemptId).toBe(id);
    expect(error.message).toContain(`\`superstables status ${id}\``);
    expect(error.message).not.toContain("quote again before paying");
    expect(ms).toBeGreaterThanOrEqual(1_900);
    expect(ms).toBeLessThanOrEqual(2_500);
  }, 15_000);

  it("names the payment that holds the quote now, not an earlier one, after the quote was handed back", async () => {
    const earlier = randomUUID();
    const current = randomUUID();
    const records = new Records(scratch());
    const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
    // Attempt A failed before the owner was asked: its claim is released and the quote is open again.
    expect(records.claimQuote(q.id, earlier)).toBeUndefined();
    const at = new Date().toISOString();
    records.saveAttempt({
      id: earlier,
      quoteId: q.id,
      createdAt: at,
      updatedAt: at,
      state: "failed",
      refusal: "approval_page",
      chainFinal: null,
      url: q.url,
      terms: q.terms,
      history: [{ at, state: "failed" }],
    });
    expect(records.releaseQuote(q.id, earlier)).toBe(true);
    records.saveQuote({ ...q, status: "open" });
    // Paid again as attempt B, which holds the claim and has marked the quote used; its line is not written yet.
    expect(records.claimQuote(q.id, current)).toBeUndefined();
    records.saveQuote({ ...q, status: "used" });

    const { error } = refusal(engineOver(records), q.id);

    expect(error.attempt).toBeUndefined();
    expect(error.attemptId).toBe(current);
    expect(error.message).toContain(`\`superstables status ${current}\``);
    expect(error.message).not.toContain(earlier);
    expect(error.message).not.toContain("quote again before paying");
    expect(error.message).not.toContain("new quote");
  }, 15_000);

  it("reads an empty claim again, and names the attempt a moment later written into it", async () => {
    const id = randomUUID();
    const records = new Records(scratch());
    const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
    expect(records.claimQuote(q.id, "")).toBeUndefined(); // the file exists, its content is not written yet
    const claim = join(records.dir, "claims", createHash("sha256").update(q.id).digest("hex"));
    const writer = spawn(
      process.execPath,
      ["-e", `console.log("ready"); setTimeout(() => require("node:fs").writeFileSync(process.argv[1], process.argv[2]), 600)`, claim, id],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<void>((done) => writer.once("exit", () => done()));
    await new Promise<void>((ready, fail) => {
      writer.once("error", fail);
      writer.stdout.on("data", (chunk) => String(chunk).includes("ready") && ready());
    });
    const { error, ms } = refusal(engineOver(records), q.id);
    await exited;
    expect(error.attemptId).toBe(id);
    expect(error.message).not.toContain("quote again before paying");
    expect(ms).toBeLessThanOrEqual(2_500);
  }, 15_000);

  it("keeps a quote marked used before claims existed (no claim file) on the old message", async () => {
    const records = new Records(scratch());
    const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
    records.saveQuote({ ...q, status: "used" });
    const { error, ms } = refusal(engineOver(records), q.id);
    expect(error.attemptId).toBeUndefined();
    expect(error.message).toBe("This quote has already been used to start a payment; quote again before paying");
    expect(ms).toBeLessThan(500);
  }, 15_000);

  it("does not print a claim's contents that are not an attempt id", async () => {
    const { records, quoteId } = await claimedQuote("not an id; run something");
    const { error } = refusal(engineOver(records), quoteId);
    expect(error.attemptId).toBeUndefined();
    expect(error.message).not.toContain("run something");
  }, 15_000);

  it("keeps the same message when the claim itself names no attempt", async () => {
    const records = new Records(scratch());
    const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
    expect(records.claimQuote(q.id, "")).toBeUndefined(); // a process that stopped before writing the name
    const { error } = refusal(engineOver(records), q.id);
    expect(error.attemptId).toBeUndefined();
    expect(error.message).toBe("This quote has already been used to start a payment; quote again before paying");
  }, 15_000);

  it("counts real time, not sleeps, when every read of the records is slow", async () => {
    const id = randomUUID();
    const { records, quoteId } = await claimedQuote(id);
    const read = records.getAttempt.bind(records);
    records.getAttempt = (id: string) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return read(id);
    };
    const { ms } = refusal(engineOver(records), quoteId);
    expect(ms).toBeLessThanOrEqual(2_400);
  }, 30_000);

  it("through the CLI: exits 2 and follows the payment instead of asking for a new quote", async () => {
    const id = randomUUID();
    const home = scratch();
    const env = {
      ...process.env,
      SUPERSTABLES_HOME: home,
      SUPERSTABLES_DOCTOR_OFFLINE: "1",
      SUPERSTABLES_APPROVE_PORT: "0",
      SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1",
    };
    const run = (args: string[]) =>
      new Promise<{ code: number; out: string }>((done, fail) => {
        const child = spawn(process.execPath, [TSX, CLI, ...args], { cwd: ROOT, env });
        let out = "";
        child.stdout.on("data", (chunk) => (out += String(chunk)));
        child.stderr.on("data", (chunk) => (out += String(chunk)));
        child.once("error", fail);
        child.once("close", (code) => done({ code: code ?? 0, out }));
      });
    const q = JSON.parse((await run(["quote", url, "--json"])).out) as { id: string };
    const records = new Records(join(home, "records"));
    expect(records.claimQuote(q.id, id)).toBeUndefined();

    const result = await run(["pay", q.id]);

    expect(result.code).toBe(2);
    expect(result.out).toContain(`A payment for this quote already exists: attempt ${id}, whose record is not readable yet`);
    expect(result.out).toContain(`\`superstables status ${id}\``);
    expect(result.out).not.toContain("superstables quote");

    // The same when the quote is already marked used and only the attempt line is missing.
    records.saveQuote({ ...records.getQuote(q.id)!, status: "used" });
    const used = await run(["pay", q.id]);
    expect(used.code).toBe(2);
    expect(used.out).toContain(`\`superstables status ${id}\``);
    expect(used.out).not.toContain("superstables quote");
  }, 90_000);
});
