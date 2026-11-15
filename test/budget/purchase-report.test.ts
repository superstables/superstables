// The report of a settled budget purchase (budget/purchase-report.mjs), as a process: the dispatcher and rail scripts as the npm
// package builds them, a fake superstables.com on 127.0.0.1, a fake EVM chain and sellers on 127.0.0.1. Nothing reaches a network.
// Property: a purchase report never changes what the buy answers. With the report failing, timing out, refused, switched off or the
// feature absent, the RESULT line and the exit code are those of a build without reporting; and nothing is sent unless the purchase
// settled, the budget is linked to a site, and the site lists purchase_reports_v1.
// Solana and Tempo buys cannot be driven here (no fake chain for either): their journals are read by the body builder in the unit
// tests below, and their site-call scripts run by hand against the fake site.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { ARC_USDC, SELLER_ADDR, startFakeEvm, startSeller, usdc, type FakeEvm } from "../helpers/fake-evm.js";
import { budgetBundle } from "../helpers/budget-bundle.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = budgetBundle();
const CLI = join(BUNDLE, "cli.mjs");
const { agentProofText, ed25519Verifies } = await import(new URL("../../budget/hosted.ts", import.meta.url).href);
const { atomicDigits, purchaseReportsOn, reportBody, reportSettled, strippedUrl } = await import(new URL("../../budget/purchase-report.mjs", import.meta.url).href);
const { signedSitePost, siteCallArgs } = await import(new URL("../../budget/site-request.ts", import.meta.url).href);

const owner = privateKeyToAccount(generatePrivateKey());
const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey);
const solAgent = Keypair.generate();
const solOwner = Keypair.generate();

let home: string;
let base: FakeEvm;
let arc: FakeEvm;
const cleanups: (() => unknown)[] = [];
beforeEach(async () => {
  home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-purchase-report-"));
  base = await startFakeEvm();
  arc = await startFakeEvm({ chainId: 5042002, usdc: ARC_USDC, gasIsToken: true });
  cleanups.push(() => base.close(), () => arc.close());
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(home, { recursive: true, force: true });
});

// ---- the fake site ---------------------------------------------------------------------------------------------------------

type Report = { body: any; raw: string; signed: boolean; headers: IncomingMessage["headers"]; contentType: string };
type Site = {
  url: string; features: string[]; reports: Report[]; reads: number; advice: (body: unknown) => { status: number; body: unknown } | null;
  purchaseReply: () => { status: number; body: unknown };
  purchaseGate: Promise<void> | null; purchaseReached: (() => void) | null; servicesGate: Promise<void> | null;
  other: string[];
};
async function startSite(over: Partial<Pick<Site, "features" | "purchaseReply" | "advice">> = {}): Promise<Site> {
  const site: Site = { url: "", features: ["purchase_reports_v1"], reports: [], reads: 0, advice: () => null, purchaseReply: () => ({ status: 202, body: { accepted: true, replayed: false } }), purchaseGate: null, purchaseReached: null, servicesGate: null, other: [], ...over };
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    const path = String(req.url).split("?")[0];
    if (req.method === "GET" && path === "/api/v1/budget/services") {
      site.reads++;
      if (site.servicesGate) await site.servicesGate;
      return json(res, 200, { services: [], features: site.features });
    }
    if (req.method === "POST" && path === "/api/v1/budget/purchases") {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* */ }
      site.reports.push({ body, raw, signed: await signatureHolds(site.url, req, raw), headers: req.headers, contentType: String(req.headers["content-type"] ?? "") });
      site.purchaseReached?.();
      if (site.purchaseGate) await site.purchaseGate;
      const a = site.purchaseReply();
      return json(res, a.status, a.body);
    }
    if (req.method === "POST" && path === "/api/v1/recovery/advice") {
      const a = site.advice(JSON.parse(raw));
      if (a) return json(res, a.status, a.body);
    }
    site.other.push(`${req.method} ${path}`);
    return json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => closeServer(server));
  return site;
}
async function signatureHolds(origin: string, req: IncomingMessage, raw: string): Promise<boolean> {
  const h = req.headers;
  const address = String(h["superstables-agent"] ?? ""), ts = Number(h["superstables-agent-timestamp"]), nonce = String(h["superstables-agent-nonce"] ?? ""), sig = String(h["superstables-agent-signature"] ?? "");
  if (!address || !/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60) return false;
  const message = agentProofText(origin, String(req.method), String(req.url).split("?")[0], raw, ts, nonce);
  if (address.startsWith("0x")) return (await recoverMessageAddress({ message, signature: sig as `0x${string}` })).toLowerCase() === address.toLowerCase() && address.toLowerCase() === agent.address.toLowerCase();
  return address === solAgent.publicKey.toBase58() && ed25519Verifies(address, message, sig);
}
const text = (req: IncomingMessage) => new Promise<string>((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(d)); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
const closeServer = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
/** A promise that stays pending until the test ends: a site that never answers. */
/** The headers of a forwarded answer, without the ones that describe the bytes the relay re-sends. */
const relayed = (r: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => { if (!["content-length", "transfer-encoding", "content-encoding", "connection"].includes(k)) out[k] = v; });
  return out;
};
const never = (): Promise<void> => new Promise(() => {});

// ---- the budget on disk and the dispatcher -----------------------------------------------------------------------------------

const write = (path: string, body: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, body, { mode }); };
function setUpEvm(site: string | null, chains: ("base-sepolia" | "arc-testnet")[] = ["base-sepolia"]) {
  write(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent.address}\n`);
  for (const chain of chains) {
    write(join(home, "budget", "public", `evm-${chain}.env`), `B4_OWNER_ADDRESS=${owner.address}\nB4_AGENT_ADDRESS=${agent.address}\n${site ? `APPROVALS=hosted\nSITE=${site}\n` : ""}`, 0o644);
    const fake = chain === "base-sepolia" ? base : arc;
    fake.setUsdc(owner.address, usdc("100"));
    fake.setNative(owner.address, 10n ** 20n);
    fake.setNative(agent.address, 10n ** 17n);
    fake.setAllowance(owner.address, agent.address, usdc("1"));
  }
}

type Out = { code: number; stdout: string; stderr: string; result: any; resultLine: string; ms: number };
function budget(args: string[], opts: { env?: Record<string, string>; onSpawn?: (pid: number) => void } = {}): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, SUPERSTABLES_TEST_RPC_WAIT_MS: "0", ...opts.env };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    if (!opts.env?.SUPERSTABLES_PURCHASE_REPORTS) delete env.SUPERSTABLES_PURCHASE_REPORTS;
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, detached: true });
    opts.onSpawn?.(child.pid!);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const resultLine = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")) ?? "";
      done({ code: code ?? 0, stdout, stderr, result: resultLine ? JSON.parse(resultLine.slice(7)) : null, resultLine, ms: Date.now() - started });
    });
  });
}
const buy = (url: string, o: { op?: string; env?: Record<string, string>; onSpawn?: (pid: number) => void } = {}) =>
  budget(["buy", "--rail", "evm", "--chain", "base-sepolia", "--url", url, "--max", "0.05", "--op", o.op ?? "rep-1"], { env: o.env, onSpawn: o.onSpawn });
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
/** The RESULT without what differs per run (the transaction hashes, the response file, the fake chain's port); everything else must match a build without reporting. */
const stable = (o: Out) => {
  const { tx: _tx, responseFile: _file, rpc: _rpc, ...rest } = o.result;
  const scrub = (t: string) => t.replace(/"tx":\{[^}]*\}/, '"tx":{}').replace(/"responseFile":"[^"]*",?/, "").replace(/"rpc":"[^"]*",?/, "");
  return { code: o.code, stdout: scrub(o.stdout), result: rest };
};
/** A working seller on Base. */
async function seller(price = "10000") {
  const s = await startSeller(base, 84532, { price });
  cleanups.push(() => s.close());
  return s;
}

// ---- the dispatcher ---------------------------------------------------------------------------------------------------------

describe("a settled buy reports once, to the site the budget is linked to", () => {
  it("sends the contract's body, and only it, signed with the agent key", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await seller();
    const r = await buy(`${s.url}/spot?token=secret&k=1#frag`);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", paid: true, delivered: true, amount: "0.01" });
    expect(site.reads).toBe(1);
    expect(site.reports).toHaveLength(1);
    const rep = site.reports[0]!;
    expect(rep.signed).toBe(true);
    expect(rep.contentType).toContain("application/json");
    expect(Object.keys(rep.body).sort()).toEqual(["amount_atomic", "chain", "delivered", "op", "pay_to", "rail", "tx", "url", "version"]);
    expect(rep.body).toEqual({
      version: 1, rail: "evm", chain: "base-sepolia", op: "rep-1", url: `${s.url}/spot`, amount_atomic: "10000", pay_to: SELLER_ADDR,
      tx: r.result.tx.settle, delivered: true,
    });
    expect(r.result.tx.settle).toMatch(/^0x[0-9a-f]{64}$/);
    // the pull, a second hash of the same purchase, is not what paid the seller
    expect(rep.body.tx).not.toBe(r.result.tx.pull);
    // nothing else leaves: not the query, the fragment, the owner, the seller's answer
    for (const secret of ["secret", "frag", owner.address.slice(2).toLowerCase(), "token="]) expect(rep.raw.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(r.stderr).toContain("purchase reported to 127.0.0.1");
    expect(site.other).toEqual([]);
  }, 90_000);

  it("is not sent again when the same op is run again", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await seller();
    const first = await buy(`${s.url}/spot`);
    expect(first.code, all(first)).toBe(0);
    const again = await buy(`${s.url}/spot`);
    expect(again.result).toMatchObject({ state: "refused_precheck", reason: "op_already_settled" });
    expect(site.reports).toHaveLength(1);
    expect(site.reads).toBe(1);
  }, 120_000);

  it("reports the delivery as false when the seller did not deliver (exit 4)", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await startSeller(base, 84532, {});
    cleanups.push(() => s.close());
    const server = createServer(async (req, res) => {
      const headers: Record<string, string> = {};
      if (req.headers["payment-signature"]) headers["payment-signature"] = String(req.headers["payment-signature"]);
      const r = await fetch(s.url, { headers });
      if (headers["payment-signature"]) return void res.writeHead(500).end("broken");
      res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const r = await buy(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`);
    expect(r.result).toMatchObject({ state: "settled", paid: true, delivered: false });
    expect(r.code).toBe(4);
    expect(site.reports).toHaveLength(1);
    expect(site.reports[0]!.body.delivered).toBe(false);
  }, 90_000);
});

describe("nothing is sent unless the purchase settled, the budget is linked to a site, the site lists the feature and the switch is on", () => {
  it("a budget approved on this machine sends nothing, and reads nothing from any site", async () => {
    const site = await startSite();
    setUpEvm(null);
    const s = await seller();
    const r = await buy(`${s.url}/spot`);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", paid: true });
    expect(site.reads).toBe(0);
    expect(site.reports).toEqual([]);
    expect(r.stderr).not.toContain("purchase report");
  }, 90_000);

  it("a site that does not list purchase_reports_v1 gets the features read and no report", async () => {
    const site = await startSite({ features: ["recovery_advice_v1"] });
    setUpEvm(site.url);
    const s = await seller();
    const r = await buy(`${s.url}/spot`);
    expect(r.code, all(r)).toBe(0);
    expect(site.reads).toBe(1);
    expect(site.reports).toEqual([]);
    expect(r.stderr).not.toContain("purchase report");
  }, 90_000);

  it("SUPERSTABLES_PURCHASE_REPORTS=off sends nothing and does not even read the features", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await seller();
    const r = await buy(`${s.url}/spot`, { env: { SUPERSTABLES_PURCHASE_REPORTS: "off" } });
    expect(r.code, all(r)).toBe(0);
    expect(site.reads).toBe(0);
    expect(site.reports).toEqual([]);
  }, 90_000);

  it("a buy that did not settle sends nothing (a seller that cannot be read: refused before signing)", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const down = createServer((_req, res) => void res.writeHead(503).end("down"));
    await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(down));
    const r = await buy(`http://127.0.0.1:${(down.address() as AddressInfo).port}/x`);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(site.reports).toEqual([]);
    expect(base.sentRaw).toEqual([]);
  }, 90_000);

  it("a buy refused for its price (over --max) sends nothing", async () => {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await seller("900000");
    const r = await buy(`${s.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(site.reports).toEqual([]);
  }, 90_000);
});

describe("a purchase report never changes what the buy answers", () => {
  /** The same buy with reporting switched off: what a build without reporting answers. */
  async function baseline() {
    const site = await startSite();
    setUpEvm(site.url);
    const s = await seller();
    return buy(`${s.url}/spot`, { env: { SUPERSTABLES_PURCHASE_REPORTS: "off" } });
  }
  async function withSite(site: Site) {
    setUpEvm(site.url);
    const s = await seller();
    return buy(`${s.url}/spot`);
  }
  const same = (a: Out, b: Out) => expect(stable(a)).toEqual(stable(b));

  it.each([
    ["a site that errors (500)", () => ({ status: 500, body: { error: "boom" } })],
    ["a site that refuses (403 not_linked)", () => ({ status: 403, body: { error: { code: "not_linked" } } })],
    ["a site with the feature off (404)", () => ({ status: 404, body: { error: "not_found" } })],
    ["a site that rejects the body (400)", () => ({ status: 400, body: { error: "bad" } })],
    ["a site that answers with something that is not JSON", () => ({ status: 202, body: null })],
  ])("%s: the RESULT and the exit code are those of a build without reporting", async (_name, reply) => {
    const want = await baseline();
    await afterEach0();
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-purchase-report-"));
    base = await startFakeEvm();
    cleanups.push(() => base.close());
    const site = await startSite({ purchaseReply: reply });
    const got = await withSite(site);
    expect(site.reports).toHaveLength(1);
    expect(got.code).toBe(0);
    same(got, want);
    // at most one line on stderr says so
    expect(got.stderr.split("\n").filter((l) => /purchase report/.test(l))).toHaveLength(1);
  }, 180_000);

  it("a site that never answers the report: the RESULT is written within the added-time bound, unchanged", async () => {
    const want = await baseline();
    await afterEach0();
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-purchase-report-"));
    base = await startFakeEvm();
    cleanups.push(() => base.close());
    const site = await startSite();
    site.purchaseGate = never();
    const got = await withSite(site);
    expect(site.reports).toHaveLength(1);
    expect(got.code).toBe(0);
    same(got, want);
    expect(got.ms - want.ms).toBeLessThan(15_000);
    expect(got.stderr).toMatch(/purchase report/);
  }, 180_000);

  it("a site that never answers the features read: no report, the RESULT unchanged, within the bound", async () => {
    const want = await baseline();
    await afterEach0();
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-purchase-report-"));
    base = await startFakeEvm();
    cleanups.push(() => base.close());
    const site = await startSite();
    site.servicesGate = never();
    const got = await withSite(site);
    expect(site.reports).toEqual([]);
    expect(got.code).toBe(0);
    same(got, want);
    expect(got.ms - want.ms).toBeLessThan(15_000);
  }, 180_000);

  it("a site that is not there at all (connection refused): the RESULT is unchanged", async () => {
    const want = await baseline();
    await afterEach0();
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-purchase-report-"));
    base = await startFakeEvm();
    cleanups.push(() => base.close());
    // a closed port: nothing listens there any more
    const s0 = createServer();
    await new Promise<void>((r) => s0.listen(0, "127.0.0.1", r));
    const port = (s0.address() as AddressInfo).port;
    await closeServer(s0);
    setUpEvm(`http://127.0.0.1:${port}`);
    const s = await seller();
    const got = await buy(`${s.url}/spot`);
    expect(got.code).toBe(0);
    same(got, want);
  }, 180_000);

  it("a signal while the report is in flight still lets the command print its RESULT and exit as the buy did", async () => {
    const site = await startSite();
    const reached = new Promise<void>((r) => (site.purchaseReached = r));
    site.purchaseGate = never();
    setUpEvm(site.url);
    const s = await seller();
    let pid = 0;
    const running = buy(`${s.url}/spot`, { onSpawn: (p) => (pid = p) });
    await reached;
    const signalled = Date.now();
    process.kill(pid, "SIGTERM");
    const r = await running;
    expect(Date.now() - signalled).toBeLessThan(8_000);
    expect(r.result, all(r)).toMatchObject({ state: "settled", paid: true, delivered: true, command: "buy" });
    expect(r.code).toBe(0);
  }, 120_000);
});

describe("after auto recovery paid on another chain", () => {
  it("reports the attempt that paid: its chain, op, seller URL and transaction", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    // one origin with two faces: /spot cannot be read, /arc is the seller on Arc
    const gateServer = createServer(async (req, res) => {
      if (req.url?.startsWith("/arc")) {
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers, redirect: "manual" });
        const out = relayed(r);
        return void res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => gateServer.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(gateServer));
    const gate = `http://127.0.0.1:${(gateServer.address() as AddressInfo).port}`;
    const site = await startSite({
      features: ["recovery_advice_v1", "purchase_reports_v1"],
      advice: () => ({
        status: 200,
        body: {
          version: 1, advice_id: "adv-e2e", expires_at: new Date(Date.now() + 100_000).toISOString(), refusals: [],
          original: { offer_id: "orig", capability: "spot-price", listed_price_atomic: "10000" },
          policy: { version: 3, enabled: true, rail: true, service: true, preventive: false, max_offers: 3, allowed_chains: ["base-sepolia", "arc-testnet", "devnet"], margin_bps: 2000, sharing: [] },
          candidates: [{
            kind: "rail", offer_id: "arc-1", seller: { id: "seller-1", name: "Spot prices", operator: "demo", ours: true, origin: gate }, url: `${gate}/arc`, params: {}, capability: "spot-price", chain: "arc-testnet", asset: ARC_USDC,
            listed_price_atomic: "10000", pricing_family: "test:USDC:6", disclosure: { required: false, allowed: false, consent_id: null, fields: [] },
            rank: { tier: "exact", health: "5/5", why: "the same seller on Arc" },
          }],
        },
      }),
    });
    setUpEvm(site.url, ["base-sepolia", "arc-testnet"]);
    const r = await buy(`${gate}/spot`);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ rail: "evm", chain: "arc-testnet", state: "settled", paid: true });
    expect(site.reports).toHaveLength(1);
    expect(site.reports[0]!.signed).toBe(true);
    expect(site.reports[0]!.body).toEqual({
      version: 1, rail: "evm", chain: "arc-testnet", op: r.result.op, url: `${gate}/arc`, amount_atomic: "10000", pay_to: SELLER_ADDR, tx: r.result.tx.settle, delivered: true,
    });
  }, 180_000);
});

// ---- the pieces --------------------------------------------------------------------------------------------------------------

describe("the body builder", () => {
  const evmFields = { rail: "evm", chain: "base-sepolia", op: "op-1", state: "settled", paid: true, delivered: true, amount: "0.01", tx: { pull: `0x${"1".repeat(64)}`, settle: `0x${"a".repeat(64)}`, cancel: null, return: null } };
  const evmJournal = { op: "op-1", state: "settled", url: "https://seller.example/x", payTo: SELLER_ADDR, settleTx: `0x${"a".repeat(64)}`, pullTx: `0x${"1".repeat(64)}` };
  const sig = bs58.encode(Buffer.alloc(64, 7));
  const solPayee = Keypair.generate().publicKey.toBase58();
  const solFields = { rail: "solana", chain: "devnet", op: "op-2", state: "settled", paid: true, delivered: false, amount: "0.25", tx: { settle: sig } };
  const solJournal = { op: "op-2", state: "settled", url: "https://seller.example/sol", payTo: solPayee, tx: sig };
  const tempoFields = { rail: "tempo", chain: "moderato", op: "op-3", state: "settled", paid: true, delivered: true, amount: "1.5", tx: { settle: `0x${"b".repeat(64)}` } };
  const tempoJournal = { op: "op-3", state: "settled", tx: `0x${"b".repeat(64)}`, intent: { url: "https://mpp.example/paid?x=1", recipient: "0x00000000000000000000000000000000000b0b00" } };

  it("reads the evm journal's url, payee and settlement", () => {
    expect(reportBody(evmFields, evmJournal, 6)).toEqual({ version: 1, rail: "evm", chain: "base-sepolia", op: "op-1", url: "https://seller.example/x", amount_atomic: "10000", pay_to: SELLER_ADDR, tx: evmFields.tx.settle, delivered: true });
  });
  it("reads the solana journal: base58 signature, base58 payee, 6 places", () => {
    expect(reportBody(solFields, solJournal, 6)).toEqual({ version: 1, rail: "solana", chain: "devnet", op: "op-2", url: "https://seller.example/sol", amount_atomic: "250000", pay_to: solPayee, tx: sig, delivered: false });
  });
  it("reads the tempo journal's intent (url, recipient) and its transaction, and strips the query", () => {
    expect(reportBody(tempoFields, tempoJournal, 6)).toEqual({ version: 1, rail: "tempo", chain: "moderato", op: "op-3", url: "https://mpp.example/paid", amount_atomic: "1500000", pay_to: "0x00000000000000000000000000000000000b0b00", tx: tempoFields.tx.settle, delivered: true });
  });
  it("sends pay_to null when the journal holds none, and delivered null when the RESULT has none", () => {
    expect(reportBody({ ...evmFields, delivered: null }, { ...evmJournal, payTo: undefined }, 6)).toMatchObject({ pay_to: null, delivered: null });
  });
  it.each([
    ["not settled", { ...evmFields, state: "unknown", paid: null }, evmJournal],
    ["not paid", { ...evmFields, paid: false }, evmJournal],
    ["a journal that is not settled", evmFields, { ...evmJournal, state: "submitted" }],
    ["a journal of another op", evmFields, { ...evmJournal, op: "other" }],
    ["a journal whose settlement is another transaction", evmFields, { ...evmJournal, settleTx: `0x${"c".repeat(64)}` }],
    ["no journal", evmFields, null],
    ["no settlement hash (a pull only)", { ...evmFields, tx: { pull: evmFields.tx.pull, settle: null } }, { ...evmJournal, settleTx: undefined }],
    ["an unknown amount", { ...evmFields, amount: null }, evmJournal],
    ["an amount with more places than the token", { ...evmFields, amount: "0.0000001" }, evmJournal],
    ["a bad op", { ...evmFields, op: "a b" }, { ...evmJournal, op: "a b" }],
    ["a url that is not http(s)", evmFields, { ...evmJournal, url: "ftp://seller.example/x" }],
    ["a url over 500 characters", evmFields, { ...evmJournal, url: `https://seller.example/${"a".repeat(500)}` }],
  ])("sends no report for %s", (_name, fields, journal) => {
    expect(reportBody(fields as any, journal as any, 6)).toBeNull();
  });
  it("strips the query string, fragment and userinfo of the seller url", () => {
    expect(strippedUrl("https://user:pw@seller.example:8443/a/b?token=1#x")).toBe("https://seller.example:8443/a/b");
    expect(strippedUrl("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000/");
    expect(strippedUrl("javascript:alert(1)")).toBeNull();
    expect(strippedUrl("not a url")).toBeNull();
  });
  it("converts a decimal debit to atomic digits for the token's decimals", () => {
    expect(atomicDigits("0.05", 6)).toBe("50000");
    expect(atomicDigits("12", 6)).toBe("12000000");
    expect(atomicDigits("0.000001", 6)).toBe("1");
    expect(atomicDigits("1.5", 18)).toBe("1500000000000000000");
    expect(atomicDigits("-1", 6)).toBeNull();
    expect(atomicDigits("1e3", 6)).toBeNull();
    expect(atomicDigits(null, 6)).toBeNull();
  });
  it("reads the switch like SUPERSTABLES_REFERRALS: on unless off, 0, false or no", () => {
    expect(purchaseReportsOn({})).toBe(true);
    expect(purchaseReportsOn({ SUPERSTABLES_PURCHASE_REPORTS: "on" })).toBe(true);
    for (const v of ["off", "OFF", " 0 ", "false", "no"]) expect(purchaseReportsOn({ SUPERSTABLES_PURCHASE_REPORTS: v })).toBe(false);
  });
});

describe("reportSettled", () => {
  const fields = { rail: "evm", chain: "base-sepolia", op: "op-1", state: "settled", paid: true, delivered: true, amount: "0.01", tx: { settle: `0x${"a".repeat(64)}` } };
  const journal = { op: "op-1", state: "settled", url: "https://seller.example/x", payTo: SELLER_ADDR, settleTx: `0x${"a".repeat(64)}` };
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: any[] = [], logs: string[] = [];
    return { calls, logs, d: {
      on: () => true, interrupted: () => false, journal: () => journal, decimals: () => 6, site: () => "https://www.superstables.com", stop: () => {}, log: (l: string) => logs.push(l), now: Date.now,
      call: async (t: any, method: string, path: string, body: unknown, ms: number) => { calls.push({ t, method, path, body, ms }); return method === "GET" ? { status: 200, body: { features: ["purchase_reports_v1"] } } : { status: 202, body: { accepted: true, replayed: false } }; },
      ...over,
    } };
  };
  it("reads the features, then posts, each call bounded under the 15 s of the signed call", async () => {
    const { calls, logs, d } = deps();
    await reportSettled(fields, d);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/v1/budget/services", "POST /api/v1/budget/purchases"]);
    expect(calls.every((c) => c.ms >= 1_000 && c.ms <= 5_000)).toBe(true);
    expect(logs).toHaveLength(1);
  });
  it("never throws, whatever a dependency does", async () => {
    await expect(reportSettled(fields, deps({ journal: () => { throw new Error("x"); } }).d)).resolves.toBeUndefined();
    await expect(reportSettled(fields, deps({ call: async () => { throw new Error("x"); } }).d)).resolves.toBeUndefined();
  });
  it("sends nothing after a signal, when switched off, or for a buy that did not settle", async () => {
    for (const [f, over] of [[fields, { interrupted: () => true }], [fields, { on: () => false }], [{ ...fields, state: "unknown", paid: null }, {}], [{ ...fields, state: "settled", paid: false }, {}]] as const) {
      const { calls, d } = deps(over);
      await reportSettled(f as any, d);
      expect(calls).toEqual([]);
    }
  });
  it("stops the call in flight when the added time is used up", async () => {
    let stopped = 0;
    const { d } = deps({ stop: () => stopped++, call: () => new Promise(() => {}), now: (() => { let t = 0; return () => (t += 0); })() });
    const started = Date.now();
    await reportSettled(fields, d);
    expect(stopped).toBe(1);
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 20_000);
});

describe("the site-call scripts and the route allow-list", () => {
  it("signs the purchases route and no other new one", async () => {
    const site = await startSite();
    const key = generatePrivateKey();
    const ok = await signedSitePost(key, site.url, "/api/v1/budget/purchases", { version: 1 });
    expect(ok).toMatchObject({ status: 202 });
    const no = await signedSitePost(key, site.url, "/api/v1/budget/anything", { version: 1 });
    expect(no).toHaveProperty("network");
    expect(site.reports).toHaveLength(1);
  });
  it("siteCallArgs reads --timeout-ms, 1 to 15000", () => {
    const get = (o: Record<string, string>) => (n: string) => o[n];
    expect(siteCallArgs(get({ site: "s", path: "/p", body: "{}" }))).toMatchObject({ timeoutMs: 15_000 });
    expect(siteCallArgs(get({ site: "s", path: "/p", body: "{}", "timeout-ms": "4000" }))).toMatchObject({ timeoutMs: 4000 });
    for (const bad of ["0", "15001", "-1", "abc", "1.5"]) expect(siteCallArgs(get({ site: "s", path: "/p", body: "{}", "timeout-ms": bad }))).toBeNull();
  });

  function script(rail: string, args: string[]): Promise<{ code: number; result: any; stderr: string }> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, ["siteCall.mjs", ...args], { cwd: join(BUNDLE, rail), env: { ...process.env, SUPERSTABLES_HOME: home } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.once("error", fail);
      child.once("close", (code) => {
        const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
        done({ code: code ?? 0, result: line ? JSON.parse(line.slice(7)) : null, stderr });
      });
    });
  }
  const body = JSON.stringify({ version: 1, rail: "tempo" });

  it("tempo: signs the report with the Tempo agent key, as the other rails do", async () => {
    const site = await startSite();
    write(join(home, "keys", "budget", "tempo-agent.env"), `OWNER_ADDRESS=${owner.address}\nAGENT_ADDRESS=${agent.address}\nAGENT_PRIVATE_KEY=${agentKey}\n`);
    const r = await script("tempo", ["--site", site.url, "--path", "/api/v1/budget/purchases", "--body", body, "--timeout-ms", "4000"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "siteCall", rail: "tempo", state: "ok", reply: { status: 202 } });
    expect(site.reports).toHaveLength(1);
    expect(site.reports[0]!.signed).toBe(true);
    expect(site.reports[0]!.raw).toBe(body);
    const read = await script("tempo", ["--site", site.url, "--method", "GET", "--path", "/api/v1/budget/services"]);
    expect(read.result.reply).toMatchObject({ status: 200, body: { features: ["purchase_reports_v1"] } });
    const refused = await script("tempo", ["--site", site.url, "--path", "/api/v1/budget/purchases"]);
    expect(refused.code).toBe(3);
    expect(site.reports).toHaveLength(1);
  }, 60_000);

  it("solana: signs the report with the Solana agent key", async () => {
    const site = await startSite();
    write(join(home, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(solAgent.secretKey)}\nSOLANA_AGENT_ADDRESS=${solAgent.publicKey.toBase58()}\nSOLANA_OWNER_ADDRESS=${solOwner.publicKey.toBase58()}\n`);
    const r = await script("solana", ["--site", site.url, "--path", "/api/v1/budget/purchases", "--body", JSON.stringify({ version: 1, rail: "solana" }), "--timeout-ms", "4000"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result.reply).toMatchObject({ status: 202 });
    expect(site.reports).toHaveLength(1);
    expect(site.reports[0]!.signed).toBe(true);
    expect(site.reports[0]!.headers["superstables-agent"]).toBe(solAgent.publicKey.toBase58());
  }, 60_000);
});

// the tests above that start a second run in one test put the home and chain back first
async function afterEach0() {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(home, { recursive: true, force: true });
}
