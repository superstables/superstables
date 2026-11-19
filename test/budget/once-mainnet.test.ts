// buy-once on the mainnets the site's purchase API pays on (Base, Arc and Robinhood Chain), through the real dispatcher
// against a fake superstables.com on 127.0.0.1. With SUPERSTABLES_ALLOW_MAINNET off, a mainnet listing or --chain is refused
// before the site is asked for anything; with it on, the purchase is asked for and the owner is told the amount and the mainnet. A
// mainnet purchase read once the switch is off again is never called unpaid on the site's word and never read as Base
// Sepolia. No network, no key, no transaction.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { MARKET, PAYER, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

type Service = typeof MARKET;

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const SELLER = "0x1111111111111111111111111111111111111111";

let home: string;
let site: FakePurchaseSite;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-once-mainnet-"));
  site = await startFakePurchaseSite();
});
afterEach(async () => {
  await site.close();
  rmSync(home, { recursive: true, force: true });
});

/** A listing on a mainnet of the manifest, in its own token. */
const listing = (key: "base" | "arc" | "robinhood"): Service => {
  const m = MAINNET_MANIFEST.chains[key];
  return { ...structuredClone(MARKET), id: `market-${key}`, name: `Market data (${m.label})`, asset: m.token.address, network: m.caip2, payTo: SELLER, symbol: m.token.symbol };
};

type Run = { code: number; stdout: string; stderr: string; result: any; approve: any };
function budget(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const all: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: site.chainUrl, ...env };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_MAINNET_PAUSE"]) delete all[k];
    if (env.SUPERSTABLES_ALLOW_MAINNET === undefined) delete all.SUPERSTABLES_ALLOW_MAINNET;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: all });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = (p: string) => stdout.split("\n").reverse().find((l) => l.startsWith(p));
      const parse = (p: string) => { const l = line(p); return l ? JSON.parse(l.slice(p.length)) : null; };
      done({ code: code ?? 0, stdout, stderr, result: parse("RESULT "), approve: parse("APPROVE ") });
    });
  });
}
const ON = { SUPERSTABLES_ALLOW_MAINNET: "1" };
const buy = (key: string, extra: string[] = [], env: Record<string, string> = {}) =>
  budget(["buy-once", "--site", site.url, "--service", `market-${key}`, "--param", "asset=BTC", "--max", "0.01", ...extra], env);

describe("buy-once on a mainnet, switch off", () => {
  it.each(["base", "arc", "robinhood"] as const)("a %s listing is refused before the site is asked, and so is --chain %s", async (key) => {
    site.services.push(listing(key));
    const r = await buy(key);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck", paid: false });
    expect(r.result.reason).toMatch(/a mainnet, and mainnet is off: it needs SUPERSTABLES_ALLOW_MAINNET=1/);
    const named = await buy(key, ["--chain", key]);
    expect(named.code).toBe(3);
    expect(named.result.reason).toMatch(new RegExp(`"${key}" is a mainnet, and mainnet is off`));
    expect(site.purchases).toEqual([]);
  }, 30_000);
});

describe("buy-once on a mainnet, switch on", () => {
  it.each(["base", "arc", "robinhood"] as const)("a %s purchase is asked for, naming the mainnet and the amount", async (key) => {
    const m = MAINNET_MANIFEST.chains[key];
    site.services.push(listing(key));
    const r = await buy(key, [], ON);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, command: "buy-once", rail: "evm", chain: key, state: "waiting_owner" });
    expect(site.purchases).toHaveLength(1);
    const once = (text: string) => {
      expect(text.split(m.label).length - 1, text).toBe(1);
      expect(text.split(`0.01 ${m.token.symbol}`).length - 1, text).toBe(1);
    };
    expect(r.approve.terms.summary).toContain(`One payment of 0.01 ${m.token.symbol} on ${m.label} (mainnet) to ${SELLER}`);
    expect(r.approve.terms.summary).toContain("Only the operator turns mainnet on; agents never set SUPERSTABLES_ALLOW_MAINNET.");
    once(r.approve.terms.summary);
    expect(r.result.message_for_owner).toContain(`0.01 ${m.token.symbol} on ${m.label} (mainnet). Only the operator turns mainnet on`);
    once(r.result.message_for_owner);
    expect(r.result.message_for_owner).not.toMatch(/test USDC|test USDG|Test tokens|real money/);
  }, 30_000);

  it("a pause stops a new mainnet purchase before the site is asked", async () => {
    site.services.push(listing("base"));
    writeFileSync(join(home, "mainnet-paused"), "");
    const r = await buy("base", [], ON);
    expect(r.code).toBe(3);
    expect(r.result.reason).toMatch(/paused/);
    const env = await buy("base", [], { ...ON, SUPERSTABLES_MAINNET_PAUSE: "1" });
    expect(env.code).toBe(3);
    expect(site.purchases).toEqual([]);
  }, 30_000);

  it("testnets are unchanged with the switch on", async () => {
    const r = await budget(["buy-once", "--site", site.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01"], ON);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ chain: "base-sepolia", state: "waiting_owner" });
    expect(r.result.message_for_owner).toMatch(/test USDC on Base Sepolia/);
  }, 30_000);
});

describe("a mainnet purchase read after the switch is off", () => {
  it("the site saying paid is not taken as paid, and the purchase is never read as Base Sepolia", async () => {
    site.services.push(listing("base"));
    const first = await buy("base", [], ON);
    expect(first.code, first.stderr).toBe(0);
    const hash = `0x${"b5".repeat(32)}`;
    site.settle(site.purchases[0], { asset: "BTC" }, { transaction: hash, payer: PAYER });
    const later = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
    expect(later.result).toMatchObject({ chain: "base" });
    expect(later.result.paid).not.toBe(false);
    expect(later.result.state).not.toBe("settled");
    expect(JSON.stringify(later.result)).not.toMatch(/Base Sepolia|sepolia\.basescan/);
    expect(later.code).not.toBe(0);
  }, 60_000);

  it("the site saying it was never paid, with no transaction named, still reads as Base", async () => {
    site.services.push(listing("base"));
    const first = await buy("base", [], ON);
    Object.assign(site.purchases[0], { state: "expired", final: true, reason_code: "expired", payment: { status: "not_paid" }, delivery: { status: "not_called" } });
    const later = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
    expect(later.result).toMatchObject({ chain: "base", paid: false });
    expect(JSON.stringify(later.result)).not.toMatch(/Base Sepolia/);
  }, 60_000);
});
