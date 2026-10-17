// buy-once: a purchase read as paid whose payment is not final holds the next one, until `wait` stores it final or the
// owner stops waiting for its finality (`wait --abandon`). The real dispatcher against a fake superstables.com.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAYER, TX, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
let home: string;
let site: FakePurchaseSite;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-not-final-"));
  vi.stubEnv("SUPERSTABLES_HOME", home);
  site = await startFakePurchaseSite();
});
afterEach(async () => {
  await site.close();
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: site.chainUrl };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const once = () => budget(["buy-once", "--site", site.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01"]);
const recordOf = (id: string) => JSON.parse(readFileSync(join(home, "budget", "approvals", `${id}.json`), "utf8"));

describe("a paid purchase that is not final holds the next one", () => {
  it("N1: refused with paid_not_final and no link; after the payment is final and stored, a new purchase starts", async () => {
    const first = await once();
    expect(first.code, first.stderr).toBe(0);
    site.finalizedBlock = 10;
    site.settle(site.purchases[0], { asset: "BTC" }, { transaction: TX, payer: PAYER });
    const waited = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "30"]);
    expect(waited.result).toMatchObject({ paid: true, chain_final: false });
    const second = await once();
    expect(second.code).toBe(3);
    expect(second.result).toMatchObject({ state: "refused_pending", paid: null, pending: { id: first.result.id, state: "paid_not_final" } });
    expect(second.result.pending.url).toBeUndefined();
    expect(second.result.reason).toMatch(/was paid, but its payment is not final yet: one at a time/);
    expect(second.result.next).toMatch(/--abandon/);
    expect(site.purchases).toHaveLength(1);
    site.finalizedBlock = 1000;
    const final = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "30"]);
    expect(final.result).toMatchObject({ paid: true, chain_final: true });
    expect(recordOf(first.result.id).final).toBeDefined();
    const third = await once();
    expect(third.code, third.stderr).toBe(0);
    expect(site.purchases).toHaveLength(2);
  }, 120_000);

  it("N2: paid on chain while the site has not finished the purchase: blocked the same way", async () => {
    const first = await once();
    site.finalizedBlock = 1000;
    site.settle(site.purchases[0], { asset: "BTC" }, { transaction: TX, payer: PAYER });
    site.purchases[0].final = false;
    const second = await once();
    expect(second.code).toBe(3);
    expect(second.result.pending).toMatchObject({ id: first.result.id, state: "paid_not_final" });
    expect(site.purchases).toHaveLength(1);
  }, 120_000);

  it("N3: the owner stops waiting for finality: the result stays paid, the record is marked, and the next purchase starts", async () => {
    const first = await once();
    site.finalizedBlock = 10;
    site.settle(site.purchases[0], { asset: "BTC" }, { transaction: TX, payer: PAYER });
    await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "30"]);
    const blocked = await once();
    expect(blocked.code).toBe(3);
    const abandoned = await budget(["wait", "--id", first.result.id, "--abandon"]);
    expect(abandoned.result).toMatchObject({ paid: true });
    expect(abandoned.result.finalityAbandonedAt).toBeTruthy();
    expect(abandoned.result.next).toMatch(/stopped waiting for this payment to become final/);
    const stored = recordOf(first.result.id);
    expect(stored.final).toBeUndefined();
    expect(stored.finalityAbandonedAt).toBeTruthy();
    const next = await once();
    expect(next.code, next.stderr).toBe(0);
    expect(site.purchases).toHaveLength(2);
  }, 120_000);

  it("N4: a paid purchase with a later conflicting payer is unknown, never paid_not_final, and --abandon gives unknown", async () => {
    const first = await once();
    site.finalizedBlock = 10;
    const p = site.purchases[0];
    Object.assign(p, { state: "submitting", payment: { status: "submitting", payer: "0x4444444444444444444444444444444444444444" } });
    await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
    site.settle(p, { asset: "BTC" }, { transaction: TX, payer: PAYER });
    const waited = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "30"]);
    expect(waited.result).toMatchObject({ state: "unknown", paid: null });
    const abandoned = await budget(["wait", "--id", first.result.id, "--abandon"]);
    expect(abandoned.result).toMatchObject({ state: "unknown", paid: null });
    expect(abandoned.result.finalityAbandonedAt).toBeUndefined();
  }, 120_000);
});
