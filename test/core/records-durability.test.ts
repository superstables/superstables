// The ledger is on disk before a signed payment leaves the machine: the `submitting` line, and the claim on the quote,
// are written and flushed (fsync) first. A flush that fails stops the payment instead of letting it go on.
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ events: [] as string[], paths: new Map<number, string>(), failFsync: false }));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    io.paths.set(fd, String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const fsyncSync = ((fd: number) => {
    const path = io.paths.get(fd);
    if (path !== undefined) io.events.push(`fsync ${basename(dirname(path)).replace(/^superstables-dur-.*$/, "root")}/${basename(path)}`);
    if (io.failFsync) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    return actual.fsyncSync(fd);
  }) as typeof actual.fsyncSync;
  return { ...actual, default: { ...actual, openSync, fsyncSync }, openSync, fsyncSync };
});

import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { quote } from "../../src/core/quote.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import type { Attempt } from "../../src/core/types.js";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "../helpers/servers.js";

const open: TestServer[] = [];
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "superstables-dur-"));
  io.events.length = 0;
  io.paths.clear();
  io.failFsync = false;
});
afterEach(async () => {
  io.failFsync = false;
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function stack() {
  const facilitator = await startFacilitator();
  const seller = await startPaidEndpoint(facilitator.url);
  const wallet = await startWallet();
  open.push(facilitator, seller, wallet);
  const dir = join(base, "records");
  const records = new Records(dir);
  const seen: { lastAttemptState?: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.has("payment-signature") || headers.has("x-payment")) {
      io.events.push("fetch with payment");
      const lines = readFileSync(join(dir, "attempts.jsonl"), "utf8").trim().split("\n");
      seen.push({ lastAttemptState: (JSON.parse(lines[lines.length - 1]) as Attempt).state });
    }
    return fetch(input, init);
  };
  const engine = new PaymentEngine({
    records,
    policy: { ...DEFAULT_POLICY },
    fetchImpl,
    signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }),
  });
  return { records, engine, seen, url: `${seller.url}/v1/market?asset=BTC` };
}

describe("the ledger is flushed before a credential leaves", () => {
  it("writes and fsyncs the claim and the submitting line first", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    const started = s.engine.startPayment(q.id);
    const final = await s.engine.waitForAttempt(started.id, 10_000);
    expect(final.state).toBe("settled");

    expect(s.seen).toEqual([{ lastAttemptState: "submitting" }]);
    const paid = io.events.indexOf("fetch with payment");
    expect(paid).toBeGreaterThan(0);
    const before = io.events.slice(0, paid);
    expect(before.some((e) => /^fsync claims\/[0-9a-f]{64}$/.test(e))).toBe(true);
    expect(before.some((e) => e === "fsync records/claims")).toBe(true);
    // the last thing flushed before the credential leaves is the ledger line that says so
    expect(before[before.length - 1]).toBe("fsync records/attempts.jsonl");
  }, 20_000);

  it("a flush that fails stops the payment: nothing is sent", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    io.failFsync = true;
    expect(() => s.engine.startPayment(q.id)).toThrow(/EIO/);
    expect(io.events).not.toContain("fetch with payment");
  });
});

describe("record lines that cannot be read", () => {
  it("are counted per file, and the valid rows still read", () => {
    const records = new Records(join(base, "records"));
    const now = new Date().toISOString();
    records.saveQuote({ id: "q1", createdAt: now, url: "https://example.com/x", status: "open" } as never);
    appendFileSync(join(base, "records", "quotes.jsonl"), "not json {\n[]\n");
    expect(records.skippedLines()).toEqual([{ file: "quotes.jsonl", lines: 2 }]);
    expect(records.getQuote("q1")?.id).toBe("q1");
  });

  it("is empty for clean files and for a folder with no files", () => {
    const records = new Records(join(base, "records"));
    expect(records.skippedLines()).toEqual([]);
    records.saveQuote({ id: "q2", createdAt: new Date().toISOString(), url: "https://example.com/x", status: "open" } as never);
    expect(records.skippedLines()).toEqual([]);
  });
});

describe("a seller's answer kept for later", () => {
  it("is flushed, then its folder is flushed after the rename", () => {
    const records = new Records(join(base, "records"));
    records.savePendingAnswer({ id: "a1", attemptId: "a1" } as never);
    const flushed = io.events.filter((e) => e.startsWith("fsync"));
    const file = flushed.findIndex((e) => /^fsync pending-answers\/[0-9a-f]{64}\.json\.\d+\.[0-9a-f]+\.tmp$/.test(e));
    const folder = flushed.indexOf("fsync records/pending-answers");
    expect(file).toBeGreaterThanOrEqual(0);
    expect(folder).toBeGreaterThan(file);
  });
});
