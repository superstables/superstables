// Auto recovery for budget buys as a process: the real dispatcher and rail scripts, a fake superstables.com, two fake EVM chains
// (Base Sepolia and Arc Testnet, each with its own USDC) and sellers on 127.0.0.1. Nothing reaches a network, no wallet, no
// real key. The seller that cannot be read is a server that answers 503; the working one is a fake x402 seller on the other chain.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { ARC_USDC, startFakeEvm, startSeller, usdc, type FakeEvm, type Seller } from "../helpers/fake-evm.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const { agentProofText, ed25519Verifies } = await import(new URL("../../budget/hosted.ts", import.meta.url).href);

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
  home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-recovery-cli-"));
  base = await startFakeEvm();
  arc = await startFakeEvm({ chainId: 5042002, usdc: ARC_USDC, gasIsToken: true });
  cleanups.push(() => base.close(), () => arc.close());
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(home, { recursive: true, force: true });
});

// ---- the stand-ins -------------------------------------------------------------------------------------------------

type SiteCall = { path: string; body: any; headers: Record<string, string | string[] | undefined>; raw: string; signed: boolean };
interface Site { url: string; servicesGate: Promise<void> | null; servicesReached: (() => void) | null; reportGate: Promise<void> | null; reportReached: (() => void) | null; serviceReads: { signed: boolean; nonce: string; method: string }[]; servicesStatus: number; calls: SiteCall[]; features: string[]; advice: (req: any) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>; adviceCalls: SiteCall[]; reportCalls: SiteCall[]; }

/** A fake superstables.com: the feature list, and the two recovery routes, which check the agent's signature like the real one. */
async function startSite(over: Partial<Pick<Site, "features" | "advice">> = {}): Promise<Site & { close(): Promise<void> }> {
  const site: Site = { url: "", servicesGate: null, servicesReached: null, reportGate: null, reportReached: null, serviceReads: [], servicesStatus: 200, calls: [], features: ["recovery_advice_v1"], advice: () => ({ status: 404, body: { error: "not_found" } }), adviceCalls: [], reportCalls: [], ...over };
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    if (req.method === "GET" && req.url === "/api/v1/budget/services") {
      // account-scoped: only a request signed by the agent (proof v2, GET, empty body) sees the features
      const signed = await signatureHolds(site.url, req, raw);
      site.serviceReads.push({ signed, nonce: String(req.headers["superstables-agent-nonce"] ?? ""), method: req.method });
      site.servicesReached?.();
      if (site.servicesGate) await site.servicesGate;
      if (site.servicesStatus !== 200) return json(res, site.servicesStatus, { error: "down" });
      return json(res, 200, { services: [], features: signed ? site.features : [] });
    }
    if (req.method === "POST" && req.url?.startsWith("/api/v1/recovery/")) {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* */ }
      const call: SiteCall = { path: req.url, body, headers: req.headers, raw, signed: await signatureHolds(site.url, req, raw) };
      site.calls.push(call);
      if (req.url.endsWith("/advice")) { site.adviceCalls.push(call); const a = await site.advice(body); return json(res, a.status, a.body); }
      site.reportCalls.push(call);
      site.reportReached?.();
      if (site.reportGate) await site.reportGate;
      return json(res, 202, { ok: true });
    }
    return json(res, 404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closer = () => closeServer(server);
  cleanups.push(closer);
  return Object.assign(site, { close: closer });
}
/** The agent proof (v2) of a request, checked for the site's own origin, the path, the exact body and a fresh nonce. */
async function signatureHolds(origin: string, req: IncomingMessage, raw: string): Promise<boolean> {
  const h = req.headers;
  const address = String(h["superstables-agent"] ?? ""), ts = Number(h["superstables-agent-timestamp"]), nonce = String(h["superstables-agent-nonce"] ?? ""), sig = String(h["superstables-agent-signature"] ?? "");
  if (!address || !/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60) return false;
  const message = agentProofText(origin, String(req.method), String(req.url).split("?")[0], raw, ts, nonce);
  if (address.startsWith("0x")) return (await recoverMessageAddress({ message, signature: sig as `0x${string}` })).toLowerCase() === address.toLowerCase() && address.toLowerCase() === agent.address.toLowerCase();
  return address === solAgent.publicKey.toBase58() && ed25519Verifies(address, message, sig);
}
/** The headers of a forwarded answer, without the ones that describe the bytes the relay re-sends. */
const relayed = (r: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  r.headers.forEach((v, k) => { if (!["content-length", "transfer-encoding", "content-encoding", "connection"].includes(k)) out[k] = v; });
  return out;
};
const text = (req: IncomingMessage) => new Promise<string>((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(d)); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
const closeServer = (s: Server) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });

/**
 * One origin with two faces: /base cannot be read (503, or garbage, with the time of every read), /arc is the working seller on
 * the Arc fake chain (forwarded to it, payment header and all).
 */
async function startGate(behaviour: { base: "503" | "garbage" | "retry-after"; arcSeller?: Seller }) {
  const hits: { path: string; at: number }[] = [];
  const server = createServer(async (req, res) => {
    hits.push({ path: req.url ?? "", at: Date.now() });
    if (req.url?.startsWith("/arc") && behaviour.arcSeller) {
      const headers: Record<string, string> = {};
      for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
      const r = await fetch(behaviour.arcSeller.url, { headers, redirect: "manual" });
      const out = relayed(r);
      res.writeHead(r.status, out).end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (behaviour.base === "garbage") return void res.writeHead(402, { "content-type": "text/plain" }).end("pay me, somehow");
    if (behaviour.base === "retry-after") return void res.writeHead(503, { "retry-after": "2" }).end("later");
    res.writeHead(503, { "content-type": "text/plain" }).end("down");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => closeServer(server));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

// ---- the budget on disk and on the fake chains ------------------------------------------------------------------------------

const write = (path: string, body: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, body, { mode }); };
function setUpEvm(site: string | null, chains: ("base-sepolia" | "arc-testnet")[] = ["base-sepolia", "arc-testnet"]) {
  write(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent.address}\n`);
  for (const chain of chains) {
    write(join(home, "budget", "public", `evm-${chain}.env`), `B4_OWNER_ADDRESS=${owner.address}\nB4_AGENT_ADDRESS=${agent.address}\n${site ? `APPROVALS=hosted\nSITE=${site}\n` : ""}`, 0o644);
    const chainFake = chain === "base-sepolia" ? base : arc;
    chainFake.setUsdc(owner.address, usdc("100"));
    chainFake.setNative(owner.address, 10n ** 20n);
    chainFake.setNative(agent.address, 10n ** 17n);
    chainFake.setAllowance(owner.address, agent.address, usdc("1"));
  }
}
function setUpSolana(site: string) {
  write(join(home, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(solAgent.secretKey)}\nSOLANA_AGENT_ADDRESS=${solAgent.publicKey.toBase58()}\nSOLANA_OWNER_ADDRESS=${solOwner.publicKey.toBase58()}\n`);
  write(join(home, "budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${solOwner.publicKey.toBase58()}\nSOLANA_AGENT_ADDRESS=${solAgent.publicKey.toBase58()}\nAPPROVALS=hosted\nSITE=${site}\n`, 0o644);
}

type Out = { code: number; stdout: string; stderr: string; result: any; pid: number };
function budget(args: string[], opts: { onSpawn?: (pid: number) => void } = {}): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, detached: true });
    opts.onSpawn?.(child.pid!);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch { /* */ }
      done({ code: code ?? 0, stdout, stderr, result, pid: child.pid! });
    });
  });
}
const buy = (url: string, o: { op?: string; max?: string; rail?: string; chain?: string; extra?: string[]; onSpawn?: (pid: number) => void } = {}) =>
  budget(["buy", "--rail", o.rail ?? "evm", ...(o.rail === "solana" ? [] : ["--chain", o.chain ?? "base-sepolia"]), "--url", url, "--max", o.max ?? "0.05", "--op", o.op ?? "rec-1", ...(o.extra ?? [])], { onSpawn: o.onSpawn });

const arcCandidate = (gate: string, over: Record<string, unknown> = {}) => ({
  kind: "rail", offer_id: "arc-1", seller: { id: "seller-1", name: "Spot prices", operator: "demo", ours: true, origin: gate }, url: `${gate}/arc`, params: {}, capability: "spot-price", chain: "arc-testnet", asset: ARC_USDC,
  listed_price_atomic: "10000", pricing_family: "test:USDC:6", disclosure: { required: false, allowed: false, consent_id: null, fields: [] },
  rank: { tier: "exact", health: "5/5", why: "the same seller on Arc" }, ...over,
});
const adviceFor = (candidates: unknown[], policy: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => (_req: unknown) => ({
  status: 200,
  body: {
    version: 1, advice_id: "adv-e2e", expires_at: new Date(Date.now() + 100_000).toISOString(), refusals: [],
    original: { offer_id: "orig", capability: "spot-price", listed_price_atomic: "10000" },
    policy: { version: 3, enabled: true, rail: true, service: true, preventive: false, max_offers: 3, allowed_chains: ["base-sepolia", "arc-testnet", "devnet"], margin_bps: 2000, sharing: [], ...policy },
    candidates, ...over,
  },
});
/** A rail script run by hand, the way anyone can run it without the dispatcher. */
function direct(script: string, args: string[]): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url };
    const [dir, file] = script.split("/");
    const tsx = file!.endsWith(".ts");
    const child = spawn(process.execPath, tsx ? [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), file!, ...args] : [file!, ...args], { cwd: join(ROOT, "budget", dir!), env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null, pid: 0 });
    });
  });
}
/** A process that holds the original op's record lock, the way a rail command working on it does, until released. */
async function holdRecordLock(rail: string, chain: string, op: string) {
  const code = `import(${JSON.stringify(new URL("../../budget/op-lock.mjs", import.meta.url).href)}).then(async (m) => { const p = await import(${JSON.stringify(new URL("../../budget/paths.mjs", import.meta.url).href)}); const l = m.lockRecord(p.opsDir(${JSON.stringify(rail)}, ${JSON.stringify(chain)}), ${JSON.stringify(op)}); console.log(l.ok ? "locked" : "busy"); process.stdin.resume(); process.stdin.on("end", () => { l.release(); process.exit(0); }); });`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((ok, bad) => { child.stdout.once("data", (d) => (String(d).startsWith("locked") ? ok() : bad(new Error("lock busy")))); child.once("error", bad); });
  return { release: () => new Promise<void>((done) => { child.once("close", () => done()); child.stdin.end(); }) };
}
const recordsDir = () => join(home, "budget", "recovery");
const { attemptOp } = await import(new URL("../../budget/recovery.mjs", import.meta.url).href);
/** The order reference recorded for an original op. */
const orderRef = (op: string, rail = "evm", chain = "base-sepolia") => JSON.parse(readFileSync(join(recordsDir(), `${rail}-${chain}-${op}.json`), "utf8")).order_ref;
/** The op of attempt `n` of the order recorded for `op`: the op, part of the order's reference, the number. */
const aop = (op: string, n = 2, rail = "evm", chain = "base-sepolia") => attemptOp(op, n, orderRef(op, rail, chain));
/** The rail command an order runs for its attempt, run by hand: the same flags, the order's reference included. */
const candidateBuy = (gate: string, op: string, extra: string[] = []) => ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop(op), "--recovery-order", orderRef(op), ...extra];
const ops = (rail: string, chain: string) => { const d = join(home, "budget", "ops", `${rail}-${chain}`); return existsSync(d) ? readdirSync(d) : []; };
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
/** The answer without the parts that differ per run. */
const plain = (r: any) => { const { op: _op, rpc: _rpc, ...rest } = r; return rest; };

// ---- tests --------------------------------------------------------------------------------------------------------------

describe("retry of the seller's terms, as a process", () => {
  // the retries happen only for a buy auto recovery can follow: a budget linked to a site that lists the feature. This site lists it
  // and has no advice (404), so after the reads the answer is the plain refusal.
  const offering = async () => (await startSite({ advice: () => ({ status: 404, body: { error: "not_found" } }) })).url;

  it("reads an unreadable seller three times, 250 ms then 1 s apart, and then refuses as before: nothing signed", async () => {
    const gate = await startGate({ base: "503" });
    setUpEvm(await offering());
    const r = await buy(`${gate.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false, rail: "evm", chain: "base-sepolia" });
    expect(r.result.recovery).toBeUndefined();
    expect(gate.hits).toHaveLength(3);
    const gaps = [gate.hits[1]!.at - gate.hits[0]!.at, gate.hits[2]!.at - gate.hits[1]!.at];
    // read 2 comes at least 250 ms after read 1, once the site's feature list was read; read 3 at least 1 s after read 2
    expect(gaps[0]).toBeGreaterThanOrEqual(240);
    expect(gaps[1]).toBeGreaterThanOrEqual(990);
    expect(base.sentRaw).toEqual([]);
  }, 60_000);

  it("waits for the seller's Retry-After, and reads a garbled 402 three times too", async () => {
    const slow = await startGate({ base: "retry-after" });
    setUpEvm(await offering());
    const r = await buy(`${slow.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(slow.hits).toHaveLength(3);
    expect(slow.hits[1]!.at - slow.hits[0]!.at).toBeGreaterThanOrEqual(1990);
    expect(slow.hits[2]!.at - slow.hits[1]!.at).toBeGreaterThanOrEqual(1990);

    const garbled = await startGate({ base: "garbage" });
    const g = await buy(`${garbled.url}/spot`, { op: "rec-garbled" });
    expect(g.code, all(g)).toBe(3);
    expect(garbled.hits).toHaveLength(3);
    expect(base.sentRaw).toEqual([]);
  }, 60_000);

  it("a seller that works on the second read is paid once, and the site is asked for no advice", async () => {
    const site = await startSite({ advice: adviceFor([]) });
    setUpEvm(site.url);
    const seller = await startSeller(base, 84532);
    cleanups.push(() => seller.close());
    let reads = 0;
    const server = createServer(async (req, res) => {
      if (!req.headers["payment-signature"] && ++reads === 1) return void res.writeHead(503).end("warming up");
      const headers: Record<string, string> = {};
      if (req.headers["payment-signature"]) headers["payment-signature"] = String(req.headers["payment-signature"]);
      const r = await fetch(seller.url, { headers });
      res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const r = await buy(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", paid: true });
    expect(reads).toBe(2);
    expect(seller.settled).toHaveLength(1);
    expect(site.adviceCalls).toEqual([]);
  }, 120_000);
});

// What main (before auto recovery) answers for a seller whose unpaid read gets a 503: one read, refused before anything is signed.
// Captured from the dispatcher at main 4e3794be with these fixtures; `op` and `rpc` differ per run.
const MAIN_503 = { ok: false, command: "buy", rail: "evm", chain: "base-sepolia", state: "refused_precheck", final: true, chain_final: null, paid: false, delivered: false, amount: "0", remaining: "1", tx: { cancel: null, pull: null, return: null, settle: null }, next: "respect the refusal; nothing was signed; never raise --max to get around it", reason: "seller did not ask for payment (HTTP 503)" };

describe("without auto recovery, a buy is exactly what it was before it (main): one read, then the refusal", () => {
  /** A seller that answers 503 to its first unpaid read, and is a working x402 seller from then on. */
  async function flaky() {
    const seller = await startSeller(base, 84532);
    cleanups.push(() => seller.close());
    let reads = 0;
    const server = createServer(async (req, res) => {
      if (!req.headers["payment-signature"] && ++reads === 1) return void res.writeHead(503, { "content-type": "text/plain" }).end("warming up");
      const headers: Record<string, string> = {};
      if (req.headers["payment-signature"]) headers["payment-signature"] = String(req.headers["payment-signature"]);
      const r = await fetch(seller.url, { headers });
      res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, seller, reads: () => reads };
  }

  it.each([
    ["no site: the budget was not set up with --hosted", async () => null],
    ["a site that does not list the feature", async () => (await startSite({ features: [] })).url],
    ["a site whose feature list does not answer", async () => { const s = await startSite(); s.servicesStatus = 500; return s.url; }],
  ])("%s: a 503 stops the buy unpaid at the first read, as on main", async (_name, siteUrl) => {
    setUpEvm(await siteUrl());
    const f = await flaky();
    const r = await buy(f.url, { op: "main-503" });
    expect(r.code, all(r)).toBe(3);
    expect(plain(r.result)).toEqual(MAIN_503);
    expect(f.reads()).toBe(1);
    expect(f.seller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    expect(existsSync(recordsDir())).toBe(false);
  }, 120_000);

  it("a buy recovery cannot follow (--pay-to) reads once too, with a site that offers recovery", async () => {
    const site = await startSite({ advice: adviceFor([]) });
    setUpEvm(site.url);
    const f = await flaky();
    const r = await buy(f.url, { op: "main-payto", extra: ["--pay-to", "0x0000000000000000000000000000000000000001"] });
    expect(r.code, all(r)).toBe(3);
    expect(plain(r.result)).toEqual(MAIN_503);
    expect(f.reads()).toBe(1);
    expect(site.serviceReads).toEqual([]);
    expect(site.adviceCalls).toEqual([]);
  }, 120_000);

  it("a rail script run by hand reads once and reports no termsFailure, as before", async () => {
    setUpEvm(null);
    const f = await flaky();
    const r = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", f.url, "--max", "0.05", "--op", "main-direct"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result.termsFailure).toBeUndefined();
    expect(f.reads()).toBe(1);
  }, 120_000);
});

describe("an application request is never replayed by the terms retry", () => {
  it("a solana POST to a seller that answers 503 is sent once, with no site or recovery involved", async () => {
    const bodies: string[] = [];
    const server = createServer(async (req, res) => { bodies.push(`${req.method} ${await text(req)}`); res.writeHead(503).end("busy"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    setUpSolana("http://127.0.0.1:9");
    const r = await buy(`http://127.0.0.1:${(server.address() as AddressInfo).port}/job`, { rail: "solana", op: "rec-post", extra: ["--method", "POST", "--body", '{"job":1}'] });
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(r.result.recovery).toBeUndefined();
    expect(bodies).toEqual(['POST {"job":1}']);
  }, 60_000);
});

describe("a site that does not take part: the answer is exactly what it is today", () => {
  const without = async () => {
    const gate = await startGate({ base: "503" });
    setUpEvm(null);
    const r = await buy(`${gate.url}/spot`);
    // the baseline is main's answer, read once
    expect(gate.hits).toHaveLength(1);
    expect(plain(r.result)).toEqual(MAIN_503);
    return plain(r.result);
  };
  it.each([
    ["does not list the feature", { features: [], advice: adviceFor([]) }],
    ["answers 403 recovery_off", { features: ["recovery_advice_v1"], advice: () => ({ status: 403, body: { error: "recovery_off" } }) }],
    ["answers 404", { features: ["recovery_advice_v1"], advice: () => ({ status: 404, body: { error: "not_found" } }) }],
    ["answers 500 and garbage", { features: ["recovery_advice_v1"], advice: () => ({ status: 500, body: "oops" }) }],
  ])("%s", async (_name, over) => {
    const baseline = await without();
    rmSync(home, { recursive: true, force: true });
    home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-recovery-cli-"));
    const site = await startSite(over as any);
    const gate = await startGate({ base: "503" });
    setUpEvm(site.url);
    const r = await buy(`${gate.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(plain(r.result)).toEqual(baseline);
    expect(r.result.recovery).toBeUndefined();
    // the terms are read again only once the site said it offers recovery; the advice (403, 404, an error) comes after them
    expect(gate.hits).toHaveLength(over.features.length ? 3 : 1);
    expect(base.sentRaw).toEqual([]);
    expect(arc.sentRaw).toEqual([]);
    expect(site.reportCalls).toEqual([]);
    // the site is asked only when it lists the feature
    expect(site.adviceCalls).toHaveLength(over.features.length ? 1 : 0);
    expect(existsSync(recordsDir())).toBe(false);
  }, 120_000);

  it("the feature list is read with a signed GET (proof v2, empty body, a fresh nonce each time); a failed read is today's behaviour", async () => {
    const site = await startSite({ advice: adviceFor([]) });
    const gate = await startGate({ base: "503" });
    setUpEvm(site.url);
    const a = await buy(`${gate.url}/spot`, { op: "rec-f1" });
    const b = await buy(`${gate.url}/spot`, { op: "rec-f2" });
    expect(site.serviceReads.map((x) => x.signed)).toEqual([true, true]);
    expect(site.serviceReads[0]!.nonce).not.toBe(site.serviceReads[1]!.nonce);
    expect(site.serviceReads[0]!.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.code).toBe(3);
    expect(b.code).toBe(3);
    // the signed read fails: no advice is asked and the answer is the plain refusal
    site.servicesStatus = 500;
    const c = await buy(`${gate.url}/spot`, { op: "rec-f3" });
    expect(c.code, all(c)).toBe(3);
    expect(c.result.recovery).toBeUndefined();
    expect(site.adviceCalls).toHaveLength(2);
  }, 120_000);

  it("a budget that was not set up with the site is not recovered either", async () => {
    const site = await startSite({ advice: adviceFor([]) });
    const gate = await startGate({ base: "503" });
    setUpEvm(null);
    const r = await buy(`${gate.url}/spot`);
    expect(r.code).toBe(3);
    expect(site.calls).toEqual([]);
  }, 60_000);
});

describe("rail recovery: the same seller on another chain, paid by the agent inside that chain's allowance", () => {
  async function recovered(candidates: (gate: string) => unknown[], policy: Record<string, unknown> = {}, o: { op?: string; sellerOpts?: object } = {}) {
    const arcSeller = await startSeller(arc, 5042002, o.sellerOpts);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: (req) => adviceFor(candidates(gate.url), policy)(req) });
    setUpEvm(site.url);
    const r = await buy(`${gate.url}/spot`, { op: o.op });
    return { r, gate, site, arcSeller };
  }

  it("asks the site, journals the switch, pays on Arc, reports, and says truthfully what happened", async () => {
    const { r, gate, site, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    // what was paid: Arc, by the agent key, one payment, nothing on Base
    expect(arcSeller.settled).toHaveLength(1);
    expect(arcSeller.creds[0].payload.authorization.from.toLowerCase()).toBe(agent.address.toLowerCase());
    expect(base.sentRaw).toEqual([]);
    expect(r.result).toMatchObject({ command: "buy", rail: "evm", chain: "arc-testnet", op: aop("rec-1"), state: "settled", paid: true, delivered: true });
    expect(r.result.recovery).toMatchObject({
      switched: true, kind: "rail", decided_by: "agent", disclosed: false,
      original: { rail: "evm", chain: "base-sepolia", op: "rec-1" }, paid_to: { host: new URL(gate.url).host, chain: "arc-testnet" },
    });
    expect(r.result.recovery.note).toContain("The owner was not asked about this switch");
    expect(r.result.recovery.why).toContain("server error after 3 reads");
    expect(JSON.stringify(r.result)).not.toMatch(/owner (approved|agreed)|approved by the owner/i);
    // the original seller was read three times, then left alone
    expect(gate.hits.filter((h) => h.path === "/spot")).toHaveLength(3);
    // the advice request: signed by the agent key for this site, the contract's fields, and only chains this client found funded
    expect(site.adviceCalls).toHaveLength(1);
    const ask = site.adviceCalls[0]!;
    expect(ask.signed).toBe(true);
    expect(ask.body).toMatchObject({
      version: 1, original: { url: `${gate.url}/spot`, chain: "base-sepolia", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount_atomic: "50000" },
      failure: { stage: "seller_error", attempts_used: 3 }, tried: [{ url: `${gate.url}/spot`, chain: "base-sepolia" }],
    });
    expect(ask.body.funded_chains.sort()).toEqual(["arc-testnet", "base-sepolia"]);
    // reported after the fact, signed, with the same order and attempt
    expect(site.reportCalls).toHaveLength(1);
    expect(site.reportCalls[0]!.signed).toBe(true);
    expect(site.reportCalls[0]!.body).toMatchObject({ version: 1, order_ref: ask.body.order_ref, advice_id: "adv-e2e", attempt_no: 2, offer_id: "arc-1", outcome: "paid", disclosed: false, tx: r.result.tx.settle });
    // the journal of the switch
    const rec = JSON.parse(readFileSync(join(recordsDir(), "evm-base-sepolia-rec-1.json"), "utf8"));
    expect(rec).toMatchObject({ order_ref: ask.body.order_ref, op: "rec-1", attempts: [{ attempt_no: 2, offer_id: "arc-1", why: "the same seller on Arc", op: aop("rec-1"), state: "done", outcome: "paid", reported: true }] });
    // the original op signed nothing; the candidate's own journal lives with its chain
    expect(ops("evm", "arc-testnet")).toContain(`${aop("rec-1")}.json`);
  }, 180_000);

  it("a second buy with the same op never goes back to the original seller or pays again", async () => {
    const { r, gate, site, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const hitsBefore = gate.hits.length;
    const again = await buy(`${gate.url}/spot`, { op: "rec-1" });
    expect(again.result).toMatchObject({ rail: "evm", chain: "arc-testnet", op: aop("rec-1"), state: "settled" });
    expect(again.result.recovery.switched).toBe(true);
    expect(gate.hits).toHaveLength(hitsBefore);
    expect(arcSeller.settled).toHaveLength(1);
    expect(site.adviceCalls).toHaveLength(1);
  }, 240_000);

  it("a problem with the original's own setup never makes a recovered order look unpaid", async () => {
    const { r, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    // the original chain's setup and the original agent key are gone; the candidate's journal still says settled
    rmSync(join(home, "budget", "public", "evm-base-sepolia.env"));
    const again = await buy("http://127.0.0.1:9/gone", { op: "rec-1" });
    expect(again.result, all(again)).toMatchObject({ op: aop("rec-1"), chain: "arc-testnet", state: "settled", paid: true });
    expect(again.result.recovery.switched).toBe(true);
    rmSync(join(home, "keys", "budget", "evm-agent.env"));
    const noKey = await buy("http://127.0.0.1:9/gone", { op: "rec-1" });
    expect(noKey.result.paid).not.toBe(false);
    expect(noKey.result.state).not.toBe("refused_precheck");
    expect(noKey.result.reason ?? "").not.toMatch(/Nothing was signed or paid/);
    expect(arcSeller.settled).toHaveLength(1);
    // the record gone but the original still marked: unknown, never unpaid
    rmSync(join(recordsDir(), "evm-base-sepolia-rec-1.json"));
    const lost = await buy("http://127.0.0.1:9/gone", { op: "rec-1" });
    expect(lost.code).toBe(5);
    expect(lost.result).toMatchObject({ state: "unknown", paid: null });
  }, 300_000);

  it("losing the candidate's journal after a paid switch still reports it paid, with its transaction, never unpaid", async () => {
    const { r, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const journal = join(home, "budget", "ops", "evm-arc-testnet", `${aop("rec-1")}.json`);
    renameSync(journal, `${journal}.away`);
    const again = await buy("http://127.0.0.1:9/gone", { op: "rec-1" });
    expect(again.code, all(again)).toBe(0);
    expect(again.result).toMatchObject({ state: "settled", paid: true, op: aop("rec-1"), chain: "arc-testnet" });
    expect(again.result.tx.settle).toBe(r.result.tx.settle);
    expect(JSON.stringify(again.result)).not.toMatch(/new --op/);
    expect(arcSeller.settled).toHaveLength(1);
  }, 240_000);

  it("the original op is frozen at the rail: a direct rail script, run by hand, never pays it after the order moved", async () => {
    const { r, site } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const original = await startSeller(base, 84532);
    cleanups.push(() => original.close());
    const journal = JSON.parse(readFileSync(join(home, "budget", "ops", "evm-base-sepolia", "rec-1.json"), "utf8"));
    expect(journal.supersededBy).toMatchObject({ op: aop("rec-1"), rail: "evm", chain: "arc-testnet" });
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", original.url, "--max", "0.05", "--op", "rec-1"]);
    expect(hand.result, all(hand)).toMatchObject({ state: "refused_precheck", paid: false });
    expect(hand.result.reason).toMatch(/superseded by auto recovery/);
    expect(hand.code).toBe(3);
    expect(original.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    // the dispatcher says the same
    const again = await buy(original.url, { op: "rec-1" });
    expect(again.result).toMatchObject({ op: aop("rec-1"), state: "settled" });
    expect(original.creds).toEqual([]);
    expect(site.adviceCalls).toHaveLength(1);
  }, 240_000);

  it("owned-original-recovery-flag: the order flag does not get an owned original past the record, even with its journal gone; one settlement only", async () => {
    const { r, gate, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const rootJournal = join(home, "budget", "ops", "evm-base-sepolia", "rec-1.json");
    renameSync(rootJournal, `${rootJournal}.away`);
    const ref = orderRef("rec-1");
    const args = ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "rec-1"];
    const plain = await direct("evm/buy.ts", args);
    expect(plain.code, all(plain)).toBe(3);
    const flagged = await direct("evm/buy.ts", [...args, "--recovery-order", ref]);
    expect(flagged.code, all(flagged)).toBe(3);
    expect(flagged.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(baseSeller.creds).toEqual([]);
    expect(baseSeller.settled).toEqual([]);
    expect(existsSync(rootJournal)).toBe(false);
    expect(arcSeller.settled).toHaveLength(1);
    void gate;
  }, 300_000);

  it("solana-owned-original-flag: the flag on an original the record owns is refused before the seller is contacted", async () => {
    setUpSolana("http://127.0.0.1:9");
    const hits: string[] = [];
    const server = createServer((req, res) => { hits.push(req.url ?? ""); res.writeHead(503).end("x"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/s`;
    mkdirSync(recordsDir(), { recursive: true, mode: 0o700 });
    const ref = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(recordsDir(), "solana-devnet-sol-root.json"), JSON.stringify({ version: 2, order_ref: ref, rail: "solana", chain: "devnet", op: "sol-root", url, max: "0.05", owns: true, attempts: [{ attempt_no: 2, op: "sol-root-11111111-r2", rail: "evm", chain: "arc-testnet", url, state: "done", outcome: "paid", tx: "0xabc" }] }), { mode: 0o600 });
    for (const extra of [[], ["--recovery-order", ref], ["--recovery-order", "99999999-2222-3333-4444-555555555555"]]) {
      const r = await direct("solana/buy.mjs", ["--url", url, "--max", "0.05", "--op", "sol-root", ...extra]);
      expect(r.code, all(r)).toBe(3);
      expect(r.result).toMatchObject({ state: "refused_precheck" });
    }
    expect(hits).toEqual([]);
  }, 120_000);

  it("malicious advice: a site that lies about the price cannot make the agent pay more than the ceiling", async () => {
    // listed 10000 but the seller really asks 90000, above the caller's --max of 0.05: the ordinary buy refuses before it pulls or signs
    const { r, arcSeller } = await recovered((g) => [arcCandidate(g, { listed_price_atomic: "10000" })], {}, { sellerOpts: { price: "90000" } });
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false, chain: "arc-testnet" });
    expect(r.result.recovery.note).toMatch(/tried/);
    expect(arc.sentRaw).toEqual([]);
    expect(arcSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
  }, 180_000);

  it("malicious advice: every candidate the client must refuse is skipped, and nothing is paid or contacted", async () => {
    const policyOver = { sharing: [], max_offers: 3 };
    const bad = (g: string) => [
      arcCandidate(g, { offer_id: "over-margin", listed_price_atomic: "60001" }),
      arcCandidate(g, { offer_id: "family", pricing_family: "test:USDG:6" }),
      arcCandidate(g, { offer_id: "other-seller", kind: "service", url: "http://127.0.0.1:9/elsewhere", params: {}, seller: { id: "s-x", name: "x", operator: "d", ours: false, origin: "http://127.0.0.1:9" }, disclosure: { required: true, allowed: false, consent_id: null, fields: [] } }),
      arcCandidate(g, { offer_id: "no-consent", kind: "service", url: "http://127.0.0.1:9/elsewhere", params: {}, seller: { id: "s-x", name: "x", operator: "d", ours: false, origin: "http://127.0.0.1:9" }, disclosure: { required: true, allowed: true, consent_id: "c-x", fields: ["asset"] } }),
      arcCandidate(g, { offer_id: "unfunded", chain: "devnet", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }),
      "garbage",
    ];
    const { r, gate, arcSeller } = await recovered(bad, policyOver);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false, chain: "base-sepolia" });
    expect(r.result.recovery).toMatchObject({ switched: false });
    expect(r.result.recovery.skipped.map((s: any) => s.reason)).toEqual(["over_margin", "pricing_family", "other_seller_off", "other_seller_off", "not_funded", "unparsable_candidate"]);
    expect(gate.hits.filter((h) => h.path.startsWith("/arc"))).toEqual([]);
    expect(arcSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    expect(arc.sentRaw).toEqual([]);
    expect(existsSync(recordsDir())).toBe(false);
  }, 180_000);

  it("malicious advice: an unfunded chain, more than max_offers, and expired advice", async () => {
    // Arc's allowance is gone: the client sees it on chain and skips the candidate whatever the site says
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: adviceFor([arcCandidate(gate.url)]) });
    setUpEvm(site.url);
    arc.setAllowance(owner.address, agent.address, 0n);
    const unfunded = await buy(`${gate.url}/spot`, { op: "rec-unfunded" });
    expect(unfunded.code, all(unfunded)).toBe(3);
    expect(unfunded.result.recovery.skipped).toEqual([{ offer_id: "arc-1", reason: "not_funded" }]);
    expect(site.adviceCalls[0]!.body.funded_chains).toEqual(["base-sepolia"]);
    expect(arcSeller.creds).toEqual([]);

    // max_offers 1: the original is the only offer
    arc.setAllowance(owner.address, agent.address, usdc("1"));
    site.advice = adviceFor([arcCandidate(gate.url)], { max_offers: 1 });
    const one = await buy(`${gate.url}/spot`, { op: "rec-one" });
    expect(one.code, all(one)).toBe(3);
    expect(one.result.recovery.skipped).toEqual([{ offer_id: "arc-1", reason: "over_max_offers" }]);

    // expired advice
    site.advice = adviceFor([arcCandidate(gate.url)], {}, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const old = await buy(`${gate.url}/spot`, { op: "rec-old" });
    expect(old.code, all(old)).toBe(3);
    expect(old.result.recovery).toBeUndefined();
    expect(arcSeller.creds).toEqual([]);
    expect(arc.sentRaw).toEqual([]);
  }, 240_000);

  it("unparsable advice is no recovery", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: () => ({ status: 200, body: "<html>not json</html>" }) });
    setUpEvm(site.url);
    const r = await buy(`${gate.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(r.result.recovery).toBeUndefined();
    expect(arcSeller.creds).toEqual([]);
  }, 120_000);
});

describe("a freeze that loses its race to the original's own rail owns nothing", () => {
  async function raceSetup() {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    let lock: Awaited<ReturnType<typeof holdRecordLock>> | undefined;
    // the lock is taken while the advice is on its way: after the three failed reads, before the freeze
    const site = await startSite({ advice: async () => { lock = await holdRecordLock("evm", "base-sepolia", "rec-race"); return adviceFor([arcCandidate(gate.url)])(null); } });
    setUpEvm(site.url);
    const first = await buy(`${gate.url}/spot`, { op: "rec-race" });
    return { arcSeller, gate, site, first, lock: lock! };
  }

  it("the original is unknown while another command holds it, the candidate is never contacted, and a payment of the original is kept", async () => {
    const { arcSeller, gate, first, lock } = await raceSetup();
    expect(first.code, all(first)).toBe(5);
    expect(first.result).toMatchObject({ state: "unknown", paid: null, op: "rec-race", rail: "evm", chain: "base-sepolia" });
    expect(first.result.recovery).toBeUndefined();
    expect(gate.hits.filter((h) => h.path.startsWith("/arc"))).toEqual([]);
    expect(arcSeller.creds).toEqual([]);
    // the other command finishes: the original settles on Base, once
    await lock.release();
    const working = await startSeller(base, 84532);
    cleanups.push(() => working.close());
    const direct1 = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", working.url, "--max", "0.05", "--op", "rec-race"]);
    expect(direct1.result, all(direct1)).toMatchObject({ state: "settled", paid: true });
    // the dispatcher now keeps that evidence: never "nothing paid, buy again with a new --op"
    const again = await buy(working.url, { op: "rec-race" });
    expect(again.result).toMatchObject({ state: "refused_precheck", paid: true, reason: "op_already_settled" });
    expect(again.result.tx.settle).toBe(direct1.result.tx.settle);
    expect(working.settled).toHaveLength(1);
    expect(arcSeller.settled).toEqual([]);
  }, 300_000);

  it("an unsigned original whose candidate was never contacted stays payable on the same op", async () => {
    const { arcSeller, first, lock } = await raceSetup();
    expect(first.code, all(first)).toBe(5);
    await lock.release();
    const working = await startSeller(base, 84532);
    cleanups.push(() => working.close());
    const again = await buy(working.url, { op: "rec-race" });
    expect(again.code, all(again)).toBe(0);
    expect(again.result).toMatchObject({ state: "settled", paid: true, op: "rec-race", chain: "base-sepolia" });
    expect(working.settled).toHaveLength(1);
    expect(arcSeller.creds).toEqual([]);
  }, 300_000);
});

describe("a freeze is permanent: the order is never paid on both the original and the candidate", () => {
  /** An order frozen and journaled, then killed the moment the candidate is first contacted. The candidate's later requests can be held. */
  async function frozenOrder(op: string) {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const hold: { gate: Promise<void> | null; reached: (() => void) | null; seen: Promise<void>; paidOnly?: boolean } = { gate: null, reached: null, seen: Promise.resolve() };
    let killer: (() => void) | undefined;
    let killOnce = true;
    const hits: string[] = [];
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const server = createServer(async (req, res) => {
      hits.push(req.url ?? "");
      if (req.url?.startsWith("/arc")) {
        if (killOnce) { killOnce = false; killer?.(); return; }
        if (!hold.paidOnly || req.headers["payment-signature"] || req.headers["x-payment"]) {
          hold.reached?.();
          if (hold.gate) await hold.gate;
        }
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers });
        res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const gate = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await startSite({ advice: adviceFor([arcCandidate(gate)]) });
    setUpEvm(site.url);
    const first = await buy(`${gate}/spot`, { op, onSpawn: (pid) => { killer = () => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }; } });
    expect(first.result).toBeNull();
    const file = join(recordsDir(), `evm-base-sepolia-${op}.json`);
    expect(JSON.parse(readFileSync(file, "utf8")).attempts[0]).toMatchObject({ op: aop(op), state: "journaled" });
    expect(JSON.parse(readFileSync(join(home, "budget", "ops", "evm-base-sepolia", `${op}.json`), "utf8")).supersededBy).toMatchObject({ op: aop(op) });
    return { gate, arcSeller, baseSeller, site, hold, file, hits };
  }
  const settlements = (a: Seller, b: Seller) => a.settled.length + b.settled.length;

  it("the candidate signs before the order is resumed: the original is never paid, one settlement in all", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-a");
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-a"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-a"]);
    expect(hand.result).toMatchObject({ state: "refused_precheck" });
    expect(hand.result.reason).toMatch(/superseded/);
    const again = await buy(`${gate}/spot`, { op: "fz-a" });
    expect(again.result).toMatchObject({ op: aop("fz-a"), chain: "arc-testnet", state: "settled", paid: true });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("the candidate is in its terms read when the order is resumed with expired advice: unknown, then still one settlement", async () => {
    const { gate, arcSeller, baseSeller, hold, file } = await frozenOrder("fz-b");
    let release!: () => void;
    hold.gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (hold.reached = r));
    const candidate = direct("evm/buy.ts", candidateBuy(gate, "fz-b"));
    await reached;
    // the advice has run out; the candidate command holds its op and has not signed
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.advice.expires_at_ms = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(rec));
    const during = await buy(`${gate}/spot`, { op: "fz-b" });
    expect(during.code, all(during)).toBe(5);
    expect(during.result).toMatchObject({ state: "unknown", paid: null });
    // the original is still superseded, whatever the order's state
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-b"]);
    expect(hand.result.reason).toMatch(/superseded/);
    release();
    const done = await candidate;
    expect(done.result, all(done)).toMatchObject({ state: "settled", paid: true });
    const after = await buy(`${gate}/spot`, { op: "fz-b" });
    expect(after.result).toMatchObject({ op: aop("fz-b"), state: "settled", paid: true });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("schedule: the candidate settles while the order waits for the candidate's lock; the rerun reports the settlement, never unpaid", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-d");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    const signal = join(home, "paused"), done = join(home, "go");
    const hook = fileURLToPath(new URL("../helpers/pause-before-lock.mjs", import.meta.url));
    const rerun = new Promise<Out>((resolveRun, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, AR_PAUSE_LOCK: join(dir, `${aop("fz-d")}.json.lock`), AR_PAUSE_SIGNAL: signal, AR_PAUSE_DONE: done, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` };
      const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--chain", "base-sepolia", "--url", `${gate}/spot`, "--max", "0.05", "--op", "fz-d"], { cwd: ROOT, env });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.once("error", fail);
      child.once("close", (code) => { const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")); resolveRun({ code: code ?? 0, stdout, stderr: "", result: line ? JSON.parse(line.slice(7)) : null, pid: 0 }); });
    });
    for (let i = 0; i < 600 && !existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(signal), "the rerun reached the candidate's lock").toBe(true);
    // the candidate runs to its settlement while the rerun is paused just before it takes the lock
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-d"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    writeFileSync(done, "go");
    const out = await rerun;
    expect(out.result).toMatchObject({ op: aop("fz-d"), state: "settled", paid: true });
    expect(out.code).toBe(0);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("schedule: the candidate settles during the signed feature read, which then says the feature is off; the rerun reports the settlement", async () => {
    const { gate, arcSeller, baseSeller, site } = await frozenOrder("fz-e");
    site.features = [];
    let release!: () => void;
    site.servicesGate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (site.servicesReached = r));
    const rerun = buy(`${gate}/spot`, { op: "fz-e" });
    await reached;
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-e"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    release();
    const out = await rerun;
    expect(out.result).toMatchObject({ op: aop("fz-e"), state: "settled", paid: true });
    expect(out.result.reason ?? "").not.toMatch(/new --op/);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("expired advice on an uncontacted freeze keeps the original superseded: the same op is refused and nothing is paid", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-c");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.advice.expires_at_ms = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(rec));
    const r = await buy(`${gate}/spot`, { op: "fz-c" });
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(r.result.reason, r.result.reason).toMatch(/all of them are closed\. fz-c is never paid: buy again with a new --op/);
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-c"]);
    expect(hand.result.reason).toMatch(/closed by auto recovery/);
    // the attempt that was never contacted is closed for good too: run by hand later, it is refused
    const late = await direct("evm/buy.ts", candidateBuy(gate, "fz-c"));
    expect(late.result.reason, all(late)).toMatch(/closed by auto recovery/);
    expect(late.code).toBe(3);
    const again = await buy(baseSeller.url, { op: "fz-c" });
    expect(again.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(settlements(arcSeller, baseSeller)).toBe(0);
  }, 400_000);
  it("schedule: the attempt's own rail run settles while the rerun waits for the attempt's buy lock; the rerun reads it with the lock it holds", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-f");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    const signal = join(home, "paused-f"), done = join(home, "go-f");
    const hook = fileURLToPath(new URL("../helpers/pause-before-lock.mjs", import.meta.url));
    const rerun = new Promise<Out>((resolveRun, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, AR_PAUSE_LOCK: join(dir, `${aop("fz-f")}.buy.lock`), AR_PAUSE_SIGNAL: signal, AR_PAUSE_DONE: done, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` };
      const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--chain", "base-sepolia", "--url", `${gate}/spot`, "--max", "0.05", "--op", "fz-f"], { cwd: ROOT, env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.once("error", fail);
      child.once("close", (code) => { const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")); resolveRun({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null, pid: 0 }); });
    });
    for (let i = 0; i < 600 && !existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(signal), "the rerun reached the attempt's buy lock").toBe(true);
    // the attempt, as the order's own rail run (the same --recovery-order), settles while the rerun is paused just before that lock
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-f"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    writeFileSync(done, "go");
    const out = await rerun;
    expect(out.result, all(out)).toMatchObject({ op: aop("fz-f"), state: "settled", paid: true });
    expect(out.result.reason ?? "").not.toBe("op_in_progress");
    expect(out.code).toBe(0);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("schedule: the advice runs out while the signed feature read is pending and the attempt starts meanwhile; the rerun is unknown, then reports the settlement", async () => {
    const { gate, arcSeller, baseSeller, site, file, hold } = await frozenOrder("fz-g");
    // the advice still holds when the rerun starts, and has run out by the time its feature read returns
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.advice.expires_at_ms = Date.now() + 4_000;
    writeFileSync(file, JSON.stringify(rec));
    let releaseRead!: () => void;
    site.servicesGate = new Promise<void>((r) => (releaseRead = r));
    const readReached = new Promise<void>((r) => (site.servicesReached = r));
    let releaseTerms!: () => void;
    hold.gate = new Promise<void>((r) => (releaseTerms = r));
    const termsReached = new Promise<void>((r) => (hold.reached = r));
    const rerun = buy(`${gate}/spot`, { op: "fz-g" });
    await readReached;
    // the order's own attempt starts during the feature read and is in its terms read, holding its op
    const candidate = direct("evm/buy.ts", candidateBuy(gate, "fz-g"));
    await termsReached;
    while (Date.now() < rec.advice.expires_at_ms + 200) await new Promise((r) => setTimeout(r, 100));
    releaseRead();
    const during = await rerun;
    expect(during.code, all(during)).toBe(5);
    expect(during.result).toMatchObject({ state: "unknown", paid: null, final: false, op: aop("fz-g") });
    expect(JSON.stringify(during.result)).not.toMatch(/new --op/);
    releaseTerms();
    const done = await candidate;
    expect(done.result, all(done)).toMatchObject({ state: "settled", paid: true });
    const after = await buy(`${gate}/spot`, { op: "fz-g" });
    expect(after.result, all(after)).toMatchObject({ op: aop("fz-g"), state: "settled", paid: true });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("report race: the candidate refuses, its op is closed before the outcome is recorded or reported, and a direct buy released during the report is refused", async () => {
    const { gate, arcSeller, baseSeller, site } = await frozenOrder("fz-r");
    arc.setAllowance(owner.address, agent.address, 0n); // the candidate refuses: no allowance on Arc
    let release!: () => void;
    site.reportGate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (site.reportReached = r));
    const rerun = buy(`${gate}/spot`, { op: "fz-r" });
    await Promise.race([reached, rerun.then((r) => { throw new Error(`the rerun ended before the report: ${all(r).slice(-1500)}`); })]);
    arc.setAllowance(owner.address, agent.address, usdc("1"));
    const hand = await direct("evm/buy.ts", candidateBuy(gate, "fz-r"));
    expect(hand.result, all(hand)).toMatchObject({ state: "refused_precheck", paid: false });
    expect(hand.result.reason).toMatch(/closed by auto recovery/);
    release();
    const out = await rerun;
    expect(out.result).toMatchObject({ state: "refused_precheck", paid: false });
    expect(settlements(arcSeller, baseSeller)).toBe(0);
    expect(arc.sentRaw).toEqual([]);
  }, 400_000);

  it("owned-op-retry: a direct retry of an owned candidate op without the order's flag is refused; with it, the payment keeps its stamp and the root reports it", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-o");
    const journalFile = join(home, "budget", "ops", "evm-arc-testnet", `${aop("fz-o")}.json`);
    arc.setAllowance(owner.address, agent.address, 0n);
    const refused = await direct("evm/buy.ts", candidateBuy(gate, "fz-o"));
    expect(refused.result, all(refused)).toMatchObject({ state: "refused_precheck" });
    expect(JSON.parse(readFileSync(journalFile, "utf8")).recoveryOf).toMatchObject({ order_ref: orderRef("fz-o") });
    arc.setAllowance(owner.address, agent.address, usdc("1"));
    // a plain retry of the owned op, as a crash and a hurried operator can produce, is refused and cannot take the op over
    const plain = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop("fz-o")]);
    expect(plain.result, all(plain)).toMatchObject({ state: "refused_precheck", paid: false });
    expect(plain.result.reason).toMatch(/reserved/);
    expect(arcSeller.creds).toEqual([]);
    expect(JSON.parse(readFileSync(journalFile, "utf8")).recoveryOf).toMatchObject({ order_ref: orderRef("fz-o") });
    // the order's own retry settles, keeps its stamp, and the root reports the payment
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-o"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    expect(JSON.parse(readFileSync(journalFile, "utf8")).recoveryOf).toMatchObject({ order_ref: orderRef("fz-o") });
    const root = await buy(`${gate}/spot`, { op: "fz-o" });
    expect(root.result).toMatchObject({ op: aop("fz-o"), state: "settled", paid: true });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("legacy-r5-payment: an unstamped settled journal is the order's payment when its version 1 record lists the op and the url is the same; a version 2 record keeps the rule", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-v1");
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-v1"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    const journalFile = join(home, "budget", "ops", "evm-arc-testnet", `${aop("fz-v1")}.json`);
    const legacy = JSON.parse(readFileSync(journalFile, "utf8"));
    delete legacy.recoveryOf;
    writeFileSync(journalFile, JSON.stringify(legacy, null, 2));
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.version = 1;
    writeFileSync(file, JSON.stringify(rec, null, 2));
    const root = await buy(`${gate}/spot`, { op: "fz-v1" });
    expect(root.result, all(root)).toMatchObject({ op: aop("fz-v1"), state: "settled", paid: true });
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.attempts[0]).toMatchObject({ outcome: "paid" });
    expect(JSON.parse(readFileSync(join(home, "budget", "ops", "evm-base-sepolia", "fz-v1.json"), "utf8")).supersededBy).toMatchObject({ op: aop("fz-v1") });
    // a different url in the same legacy record is still a collision
    legacy.url = `${gate}/arc?other=1`;
    writeFileSync(journalFile, JSON.stringify(legacy, null, 2));
    const clash = await buy(`${gate}/spot`, { op: "fz-v1" });
    expect(clash.code, all(clash)).toBe(5);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("unstamped-payment: a settled journal without this order's stamp is not claimed as the order's payment: unknown, and nothing is paid again", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-l");
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-l"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    const journalFile = join(home, "budget", "ops", "evm-arc-testnet", `${aop("fz-l")}.json`);
    const legacy = JSON.parse(readFileSync(journalFile, "utf8"));
    delete legacy.recoveryOf;
    writeFileSync(journalFile, JSON.stringify(legacy, null, 2));
    const root = await buy(`${gate}/spot`, { op: "fz-l" });
    expect(root.code, all(root)).toBe(5);
    expect(root.result).toMatchObject({ op: aop("fz-l"), state: "unknown", paid: null, final: false });
    expect(root.result.reason).toMatch(/without this order's stamp/);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec.attempts[0].outcome).toBe("unknown");
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-l"]);
    expect(hand.result.state).toBe("refused_precheck");
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  const plainCandidate = (gate: string, op: string) => ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop(op)]; // no --recovery-order: an unstamped journal

  it("signed-before-attempt-buy: the attempt op settles, unstamped, while the rerun waits for its buy lock; the rerun reports it and so does every later rerun", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-s");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    const signal = join(home, "paused-s"), done = join(home, "go-s");
    const hook = fileURLToPath(new URL("../helpers/pause-before-lock.mjs", import.meta.url));
    const rerun = new Promise<Out>((resolveRun, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, AR_PAUSE_LOCK: join(dir, `${aop("fz-s")}.buy.lock`), AR_PAUSE_SIGNAL: signal, AR_PAUSE_DONE: done, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` };
      const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--chain", "base-sepolia", "--url", `${gate}/spot`, "--max", "0.05", "--op", "fz-s"], { cwd: ROOT, env });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.once("error", fail);
      child.once("close", (code) => { const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")); resolveRun({ code: code ?? 0, stdout, stderr: "", result: line ? JSON.parse(line.slice(7)) : null, pid: 0 }); });
    });
    for (let i = 0; i < 600 && !existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(signal), "the rerun reached the attempt's buy lock").toBe(true);
    // an ordinary buy of the reserved name gets nowhere; the order's own run (its flag) settles
    const ordinary = await direct("evm/buy.ts", plainCandidate(gate, "fz-s"));
    expect(ordinary.result.reason).toMatch(/reserved/);
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-s"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    writeFileSync(done, "go");
    const out = await rerun;
    expect(out.result, all(out)).toMatchObject({ op: aop("fz-s"), state: "settled", paid: true });
    expect(out.code).toBe(0);
    for (let i = 0; i < 2; i++) {
      const again = await buy(`${gate}/spot`, { op: "fz-s" });
      expect(again.result).toMatchObject({ op: aop("fz-s"), state: "settled", paid: true });
    }
    expect(JSON.parse(readFileSync(join(recordsDir(), "evm-base-sepolia-fz-s.json"), "utf8")).attempts[0].taken).toBeUndefined();
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("legacy-signed-during-features: an unstamped candidate settles during the signed feature read, which then says the feature is off; the rerun reports the settlement", async () => {
    const { gate, arcSeller, baseSeller, site } = await frozenOrder("fz-m");
    site.features = [];
    let release!: () => void;
    site.servicesGate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (site.servicesReached = r));
    const rerun = buy(`${gate}/spot`, { op: "fz-m" });
    await reached;
    // an ordinary buy of the reserved name gets nowhere; the order's own run (its flag) settles
    const ordinary = await direct("evm/buy.ts", plainCandidate(gate, "fz-m"));
    expect(ordinary.result.reason).toMatch(/reserved/);
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-m"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    release();
    const out = await rerun;
    expect(out.result, all(out)).toMatchObject({ op: aop("fz-m"), state: "settled", paid: true });
    expect(out.result.reason ?? "").not.toMatch(/new --op/);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("candidate-before-root-freeze: the order's own attempt settled before the original was marked; the rerun freezes the original first, reports the payment, and the original is never bought", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-q");
    // as if the crash came before the original's mark was written
    const rootFile = join(home, "budget", "ops", "evm-base-sepolia", "fz-q.json");
    const root = JSON.parse(readFileSync(rootFile, "utf8"));
    delete root.supersededBy;
    writeFileSync(rootFile, JSON.stringify(root, null, 2));
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-q"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    const out = await buy(`${gate}/spot`, { op: "fz-q" });
    expect(out.result, all(out)).toMatchObject({ op: aop("fz-q"), state: "settled", paid: true });
    expect(JSON.parse(readFileSync(rootFile, "utf8")).supersededBy).toMatchObject({ op: aop("fz-q") });
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-q"]);
    expect(hand.result.reason).toMatch(/superseded/);
    const again = await buy(baseSeller.url, { op: "fz-q" });
    expect(again.result).toMatchObject({ op: aop("fz-q"), state: "settled", paid: true });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("signed-before-rail-record-lock: the order's attempt settles between the dispatcher's snapshot and the rail's lock; the rail's refusal is not the answer, the settled journal is", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-t");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    const signal = join(home, "paused-t"), done = join(home, "go-t");
    const hook = fileURLToPath(new URL("../helpers/pause-before-lock.mjs", import.meta.url));
    const rerun = new Promise<Out>((resolveRun, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, AR_PAUSE_LOCK: join(dir, `${aop("fz-t")}.json.lock`), AR_PAUSE_ONLY: "buy.ts", AR_PAUSE_SIGNAL: signal, AR_PAUSE_DONE: done, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` };
      const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--chain", "base-sepolia", "--url", `${gate}/spot`, "--max", "0.05", "--op", "fz-t"], { cwd: ROOT, env });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.once("error", fail);
      child.once("close", (code) => { const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")); resolveRun({ code: code ?? 0, stdout, stderr: "", result: line ? JSON.parse(line.slice(7)) : null, pid: 0 }); });
    });
    for (let i = 0; i < 600 && !existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(signal), "the recovery rail reached its record lock").toBe(true);
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-t"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    // an ordinary buy of the reserved name cannot get in either
    const ordinary = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop("fz-t")]);
    expect(ordinary.result.reason).toMatch(/reserved|belongs to an auto-recovered order|already ended/);
    writeFileSync(done, "go");
    const out = await rerun;
    expect(out.result, all(out)).toMatchObject({ op: aop("fz-t"), state: "settled", paid: true });
    expect(out.result.reason ?? "").not.toMatch(/already ended|new --op/);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("collision-before-rail-record-lock: a journal for another request at the attempt's name is left alone, and the order answers unknown, never paid under it", async () => {
    const { gate, arcSeller, baseSeller } = await frozenOrder("fz-c2");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    // the order's own flagged run for ANOTHER request (a different query, and a ceiling below the price): an unsigned journal for a different url
    const different = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", `${gate}/arc?other=1`, "--max", "0.001", "--op", aop("fz-c2"), "--recovery-order", orderRef("fz-c2")]);
    expect(different.result, all(different)).toMatchObject({ state: "refused_precheck" });
    const before = readFileSync(join(dir, `${aop("fz-c2")}.json`), "utf8");
    expect(JSON.parse(before).url).toContain("other=1");
    // the order's real attempt (its own url) meets it at the rail's lock: collision, unknown, exit 5
    const real = await direct("evm/buy.ts", candidateBuy(gate, "fz-c2"));
    expect(real.code, all(real)).toBe(5);
    expect(real.result).toMatchObject({ state: "unknown", paid: null });
    expect(readFileSync(join(dir, `${aop("fz-c2")}.json`), "utf8")).toBe(before);
    const root = await buy(`${gate}/spot`, { op: "fz-c2" });
    expect(root.code, all(root)).toBe(5);
    expect(root.result).toMatchObject({ state: "unknown", paid: null });
    expect(readFileSync(join(dir, `${aop("fz-c2")}.json`), "utf8")).toBe(before);
    expect(settlements(arcSeller, baseSeller)).toBe(0);
  }, 400_000);

  it("settled-collision-before-rail-record-lock: a SETTLED journal for another request at the attempt's name is a collision: unknown, nothing learned as this order's payment", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-u");
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    const signal = join(home, "paused-u"), done = join(home, "go-u");
    const hook = fileURLToPath(new URL("../helpers/pause-before-lock.mjs", import.meta.url));
    const rerun = new Promise<Out>((resolveRun, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC_BASE_SEPOLIA: base.url, B4_RPC_ARC_TESTNET: arc.url, AR_PAUSE_LOCK: join(dir, `${aop("fz-u")}.json.lock`), AR_PAUSE_ONLY: "buy.ts", AR_PAUSE_SIGNAL: signal, AR_PAUSE_DONE: done, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${hook}` };
      const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--chain", "base-sepolia", "--url", `${gate}/spot`, "--max", "0.05", "--op", "fz-u"], { cwd: ROOT, env });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.once("error", fail);
      child.once("close", (code) => { const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT ")); resolveRun({ code: code ?? 0, stdout, stderr: "", result: line ? JSON.parse(line.slice(7)) : null, pid: 0 }); });
    });
    for (let i = 0; i < 600 && !existsSync(signal); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(signal), "the recovery rail reached its record lock").toBe(true);
    // between the dispatcher's snapshot and the rail's lock, the order's flagged run settles ANOTHER request under the attempt's name
    const other = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", `${gate}/arc?other=1`, "--max", "0.012", "--op", aop("fz-u"), "--recovery-order", orderRef("fz-u")]);
    expect(other.result, all(other)).toMatchObject({ state: "settled", paid: true });
    writeFileSync(done, "go");
    const out = await rerun;
    expect(out.code, all(out)).toBe(5);
    expect(out.result).toMatchObject({ state: "unknown", paid: null });
    const a = JSON.parse(readFileSync(file, "utf8")).attempts[0];
    expect(a.outcome).not.toBe("paid");
    expect(a.tx ?? null).toBeNull();
    // and every later rerun says the same
    const again = await buy(`${gate}/spot`, { op: "fz-u" });
    expect(again.code, all(again)).toBe(5);
    expect(again.result).toMatchObject({ state: "unknown", paid: null });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("recorded-payment-before-root-freeze: a payment on record with the journal gone freezes the original first; if it cannot, the answer is unknown and the evidence stays", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-w");
    const own = await direct("evm/buy.ts", candidateBuy(gate, "fz-w"));
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
    const first = await buy(`${gate}/spot`, { op: "fz-w" });
    expect(first.result).toMatchObject({ state: "settled", paid: true });
    const tx = first.result.tx.settle;
    // the crash window: the original's mark is missing and the attempt's journal is gone; only the record knows
    const rootFile = join(home, "budget", "ops", "evm-base-sepolia", "fz-w.json");
    const root = JSON.parse(readFileSync(rootFile, "utf8"));
    delete root.supersededBy;
    writeFileSync(rootFile, JSON.stringify(root, null, 2));
    const journal = join(home, "budget", "ops", "evm-arc-testnet", `${aop("fz-w")}.json`);
    renameSync(journal, `${journal}.away`);
    // the original is busy: unknown, and the saved payment stays in the record
    const lock = await holdRecordLock("evm", "base-sepolia", "fz-w");
    const busy = await buy(`${gate}/spot`, { op: "fz-w" });
    await lock.release();
    expect(busy.code, all(busy)).toBe(5);
    expect(busy.result).toMatchObject({ state: "unknown", paid: null });
    expect(JSON.parse(readFileSync(file, "utf8")).attempts[0]).toMatchObject({ outcome: "paid", tx });
    // free again: the payment is reported, the original is superseded first, and the original cannot be bought
    const out = await buy(`${gate}/spot`, { op: "fz-w" });
    expect(out.result, all(out)).toMatchObject({ state: "settled", paid: true, tx: { settle: tx } });
    expect(JSON.parse(readFileSync(rootFile, "utf8")).supersededBy).toMatchObject({ op: aop("fz-w") });
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "fz-w"]);
    expect(hand.result.reason).toMatch(/superseded/);
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("legacy-pull-kind: a version 1 record whose bare tx is a pull is reported as recorded, kind unknown, never as the settlement", async () => {
    const { gate, file } = await frozenOrder("fz-p");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.version = 1;
    rec.attempts[0] = { ...rec.attempts[0], state: "done", outcome: "unknown", tx: "0x" + "ab".repeat(32) };
    delete rec.attempts[0].tx_pull;
    writeFileSync(file, JSON.stringify(rec));
    const out = await buy(`${gate}/spot`, { op: "fz-p" });
    expect(out.code, all(out)).toBe(5);
    expect(out.result).toMatchObject({ state: "unknown", paid: null, tx: { recorded: "0x" + "ab".repeat(32) } });
    expect(out.result.tx.settle).toBeUndefined();
  }, 400_000);

  for (const [name, paidOnly] of [["busy-candidate-before-root-freeze", false], ["signed-busy-candidate-before-root-freeze", true]] as const) {
    it(`${name}: the original is superseded first even though the candidate's lock is held; unknown, never a second payment`, async () => {
      const tag = paidOnly ? "fz-sb" : "fz-bb";
      const { gate, arcSeller, baseSeller, hold } = await frozenOrder(tag);
      const rootFile = join(home, "budget", "ops", "evm-base-sepolia", `${tag}.json`);
      // the crash window: the original's mark was never written
      const root = JSON.parse(readFileSync(rootFile, "utf8"));
      delete root.supersededBy;
      writeFileSync(rootFile, JSON.stringify(root, null, 2));
      let release!: () => void;
      hold.gate = new Promise<void>((r) => (release = r));
      hold.paidOnly = paidOnly;
      const reached = new Promise<void>((r) => (hold.reached = r));
      const candidate = direct("evm/buy.ts", candidateBuy(gate, tag)); // holds the attempt op's record lock
      await reached;
      const out = await buy(`${gate}/spot`, { op: tag });
      expect(out.code, all(out)).toBe(5);
      expect(out.result).toMatchObject({ state: "unknown", paid: null });
      // the original is superseded, although the candidate could not be read
      expect(JSON.parse(readFileSync(rootFile, "utf8")).supersededBy).toMatchObject({ op: aop(tag) });
      const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", tag]);
      expect(hand.result.reason).toMatch(/superseded/);
      release();
      const done = await candidate;
      expect(done.result, all(done)).toMatchObject({ state: "settled", paid: true });
      const after = await buy(`${gate}/spot`, { op: tag });
      expect(after.result).toMatchObject({ op: aop(tag), state: "settled", paid: true });
      expect(settlements(arcSeller, baseSeller)).toBe(1);
    }, 400_000);
  }

  it("a payment seen on a rerun is kept in the record with its transaction, and survives the loss of the journal", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-k");
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "fz-k"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    expect(JSON.parse(readFileSync(file, "utf8")).attempts[0].outcome).not.toBe("paid");
    const again = await buy(`${gate}/spot`, { op: "fz-k" });
    expect(again.result).toMatchObject({ op: aop("fz-k"), state: "settled", paid: true });
    expect(JSON.parse(readFileSync(file, "utf8")).attempts[0]).toMatchObject({ outcome: "paid", tx: candidate.result.tx.settle });
    const journal = join(home, "budget", "ops", "evm-arc-testnet", `${aop("fz-k")}.json`);
    renameSync(journal, `${journal}.away`);
    const lost = await buy(`${gate}/spot`, { op: "fz-k" });
    expect(lost.code, all(lost)).toBe(0);
    expect(lost.result).toMatchObject({ state: "settled", paid: true, tx: { settle: candidate.result.tx.settle } });
    expect(settlements(arcSeller, baseSeller)).toBe(1);
  }, 400_000);

  it("schedule: the rerun closes the order unpaid first; the attempt started afterwards is refused, so 'not paid' stays true", async () => {
    const { gate, arcSeller, baseSeller, file } = await frozenOrder("fz-h");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.advice.expires_at_ms = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(rec));
    const out = await buy(`${gate}/spot`, { op: "fz-h" });
    expect(out.code, all(out)).toBe(3);
    expect(out.result).toMatchObject({ state: "refused_precheck", paid: false });
    for (const args of [candidateBuy(gate, "fz-h"), ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop("fz-h")]]) {
      const late = await direct("evm/buy.ts", args);
      expect(late.code, all(late)).toBe(3);
      expect(late.result.reason).toMatch(/closed by auto recovery|reserved/);
    }
    // and the dispatcher, asked for the attempt op, answers from the order: not paid, closed
    const viaAttempt = await budget(["buy", "--rail", "evm", "--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop("fz-h")]);
    expect(viaAttempt.result, all(viaAttempt)).toMatchObject({ state: "refused_precheck", paid: false, op: "fz-h" });
    expect(settlements(arcSeller, baseSeller)).toBe(0);
    expect(arc.sentRaw).toEqual([]);
  }, 400_000);
});

describe("invariant 1: nothing is switched once anything was signed", () => {
  it("an order that already paid is answered from its journal; the site is never asked and nothing is read again", async () => {
    const seller = await startSeller(base, 84532);
    cleanups.push(() => seller.close());
    const site = await startSite({ advice: adviceFor([]) });
    setUpEvm(site.url);
    const first = await buy(seller.url, { op: "rec-paid" });
    expect(first.code, all(first)).toBe(0);
    await seller.close();
    const second = await buy(seller.url, { op: "rec-paid" });
    expect(second.result).toMatchObject({ state: "refused_precheck", reason: "op_already_settled" });
    expect(second.result.recovery).toBeUndefined();
    expect(site.calls).toEqual([]);
  }, 180_000);

  it("a purchase whose outcome is unknown stays unknown: no advice, no second payment", async () => {
    const site = await startSite({ advice: adviceFor([]) });
    setUpEvm(site.url);
    const dir = join(home, "budget", "ops", "evm-base-sepolia");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "rec-unknown.json"), JSON.stringify({ op: "rec-unknown", rail: "evm", path: "approve", state: "unknown", owner: owner.address, agent: agent.address, createdAt: new Date().toISOString(), notes: [], signed: true, url: "http://127.0.0.1:9/x" }), { mode: 0o600 });
    const r = await buy("http://127.0.0.1:9/x", { op: "rec-unknown" });
    expect(r.code).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown", paid: null });
    expect(site.calls).toEqual([]);
  }, 60_000);
});

describe("a crash in the middle of a switch", () => {
  it("killed after the switch was journaled and the new seller was contacted, before anything was signed: the rerun pays that switch once", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    // the gate kills the whole process group when the new seller is first contacted
    let killer: (() => void) | undefined;
    const hits: string[] = [];
    let killOnce = true;
    const server = createServer(async (req, res) => {
      hits.push(req.url ?? "");
      if (req.url?.startsWith("/arc")) {
        if (killOnce) { killOnce = false; killer?.(); return; }
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers });
        res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const gate = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await startSite({ advice: adviceFor([arcCandidate(gate)]) });
    setUpEvm(site.url);

    const first = await buy(`${gate}/spot`, { op: "rec-crash", onSpawn: (pid) => { killer = () => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }; } });
    expect(first.result, "the first run was killed before it could answer").toBeNull();
    const rec = JSON.parse(readFileSync(join(recordsDir(), "evm-base-sepolia-rec-crash.json"), "utf8"));
    expect(rec.attempts).toHaveLength(1);
    expect(rec.attempts[0]).toMatchObject({ attempt_no: 2, offer_id: "arc-1", state: "journaled", op: aop("rec-crash") });
    expect(arcSeller.creds).toEqual([]);
    expect(site.adviceCalls).toHaveLength(1);
    const baseReads = hits.filter((h) => h === "/spot").length;

    // the rerun: no new advice, the original seller is not read, the switch is carried on and pays once
    const again = await buy(`${gate}/spot`, { op: "rec-crash" });
    expect(again.code, all(again)).toBe(0);
    expect(again.result).toMatchObject({ chain: "arc-testnet", op: aop("rec-crash"), state: "settled", paid: true });
    expect(again.result.recovery).toMatchObject({ switched: true, order_ref: rec.order_ref });
    expect(arcSeller.settled).toHaveLength(1);
    expect(site.adviceCalls).toHaveLength(1);
    expect(hits.filter((h) => h === "/spot")).toHaveLength(baseReads);
    expect(base.sentRaw).toEqual([]);

    // and a third run answers from the candidate's journal without paying again
    const third = await buy(`${gate}/spot`, { op: "rec-crash" });
    expect(third.result).toMatchObject({ chain: "arc-testnet", op: aop("rec-crash") });
    expect(["settled", "unknown"]).toContain(third.result.state);
    expect(arcSeller.settled).toHaveLength(1);
  }, 300_000);
});

describe("solana: the same retry, and a payment on another chain of the same seller", () => {
  it("reads the terms three times, then pays the same seller on Arc Testnet with the evm agent key, and says so", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: adviceFor([arcCandidate(gate.url)]) });
    setUpSolana(site.url);
    setUpEvm(null, ["arc-testnet"]);
    const r = await buy(`${gate.url}/sol`, { rail: "solana", op: "rec-sol" });
    expect(r.code, all(r)).toBe(0);
    expect(gate.hits.filter((h) => h.path === "/sol")).toHaveLength(3);
    expect(arcSeller.settled).toHaveLength(1);
    expect(r.result).toMatchObject({ rail: "evm", chain: "arc-testnet", op: aop("rec-sol", 2, "solana", "devnet"), state: "settled", paid: true });
    expect(r.result.recovery).toMatchObject({ switched: true, kind: "rail", disclosed: false, original: { rail: "solana", chain: "devnet", op: "rec-sol" } });
    // the advice request was signed with the Solana agent key (ed25519), for this site
    expect(site.adviceCalls[0]!.signed).toBe(true);
    expect(site.adviceCalls[0]!.body).toMatchObject({ original: { chain: "devnet", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, failure: { attempts_used: 3 } });
    expect(site.reportCalls[0]!.body).toMatchObject({ outcome: "paid", disclosed: false, offer_id: "arc-1" });
  }, 240_000);

  it("another seller is never contacted, even with a sharing consent in the site's policy copy: the client cannot verify it", async () => {
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const down = await startGate({ base: "503" });
    const other = {
      kind: "service", offer_id: "svc-1", capability: "spot-price", params: {}, seller: { id: "seller-2", name: "Other prices", operator: "demo", ours: false, origin: new URL(baseSeller.url).origin }, url: baseSeller.url, chain: "base-sepolia",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", listed_price_atomic: "10000", pricing_family: "test:USDC:6",
      disclosure: { required: true, allowed: true, consent_id: "consent-1", fields: ["asset"] }, rank: { tier: "equivalent", health: "4/5", why: "an equivalent seller" },
    };
    for (const sharing of [[{ capability: "spot-price", seller_id: "seller-2", seller_origin: new URL(baseSeller.url).origin, consent_id: "consent-1" }], []]) {
      const site = await startSite({ advice: adviceFor([other], { sharing }) });
      setUpSolana(site.url);
      setUpEvm(null, ["base-sepolia"]);
      const op = `rec-sol-${sharing.length}`;
      const r = await buy(`${down.url}/sol`, { rail: "solana", op });
      expect(r.code, all(r)).toBe(3);
      expect(r.result).toMatchObject({ rail: "solana", state: "refused_precheck", paid: false });
      expect(r.result.recovery.skipped).toEqual([{ offer_id: "svc-1", reason: "other_seller_off" }]);
      expect(site.reportCalls).toEqual([]);
    }
    expect(baseSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
  }, 240_000);
});

// ---- review round 1: regressions ------------------------------------------------------------------------------------------

describe("two orders never share an attempt op, and an attempt never adopts another command's op", () => {
  it("two ops that share their first 58 characters recover as two orders, each paid once under its own attempt op", async () => {
    const opA = "a".repeat(58) + "X", opB = "a".repeat(58) + "Y";
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: adviceFor([arcCandidate(gate.url)]) });
    setUpEvm(site.url);
    const a = await buy(`${gate.url}/spot`, { op: opA });
    expect(a.result, all(a)).toMatchObject({ state: "settled", paid: true, op: aop(opA) });
    const b = await buy(`${gate.url}/spot`, { op: opB });
    expect(b.result, all(b)).toMatchObject({ state: "settled", paid: true, op: aop(opB) });
    expect(aop(opB)).not.toBe(aop(opA));
    expect(b.result.tx.settle).not.toBe(a.result.tx.settle);
    expect(arcSeller.settled).toHaveLength(2);
    // each rerun answers with its own order's payment
    const againB = await buy(`${gate.url}/spot`, { op: opB });
    expect(againB.result).toMatchObject({ op: aop(opB), state: "settled" });
    expect(againB.result.tx.settle).toBe(b.result.tx.settle);
    expect(arcSeller.settled).toHaveLength(2);
    // every attempt journal names its order
    for (const op of [opA, opB]) expect(JSON.parse(readFileSync(join(home, "budget", "ops", "evm-arc-testnet", `${aop(op)}.json`), "utf8")).recoveryOf).toEqual({ order_ref: orderRef(op) });
  }, 300_000);

  it("an attempt takes over an unsigned, unstamped journal for the SAME request and stamps it; a journal for another request is a collision that is left as it is", async () => {
    setUpEvm(null);
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seller = await startSeller(arc, 5042002);
    cleanups.push(() => seller.close());
    const ref = "11111111-2222-3333-4444-555555555555";
    const op = attemptOp("taken", 2, ref);
    const prior = (url: string) => ({ op, rail: "evm", path: "approve", state: "refused_precheck", owner: owner.address, agent: agent.address, createdAt: new Date().toISOString(), notes: [], signed: false, url });
    // a different request: unknown, exit 5, untouched, nothing paid
    const other = prior("http://127.0.0.1:9/elsewhere");
    writeFileSync(join(dir, `${op}.json`), JSON.stringify(other), { mode: 0o600 });
    const clash = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", seller.url, "--max", "0.05", "--op", op, "--recovery-order", ref]);
    expect(clash.code, all(clash)).toBe(5);
    expect(clash.result).toMatchObject({ state: "unknown", paid: null });
    expect(JSON.parse(readFileSync(join(dir, `${op}.json`), "utf8"))).toEqual(other);
    expect(seller.creds).toEqual([]);
    // the same request: taken over, stamped, paid
    writeFileSync(join(dir, `${op}.json`), JSON.stringify(prior(seller.url)), { mode: 0o600 });
    const r = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", seller.url, "--max", "0.05", "--op", op, "--recovery-order", ref]);
    expect(r.result, all(r)).toMatchObject({ state: "settled", paid: true });
    expect(JSON.parse(readFileSync(join(dir, `${op}.json`), "utf8")).recoveryOf).toEqual({ order_ref: ref });
    // an op that already belongs to an order is never run without that order's flag
    const plain = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", seller.url, "--max", "0.05", "--op", op]);
    expect(plain.result.state).toBe("refused_precheck");
    expect(seller.settled).toHaveLength(1);
  }, 120_000);

  it("reserved names: every entrypoint refuses an attempt op without the matching --recovery-order, before it writes or signs anything", async () => {
    setUpEvm(null);
    setUpSolana("http://127.0.0.1:9");
    const seller = await startSeller(arc, 5042002);
    cleanups.push(() => seller.close());
    const ref = "11111111-2222-3333-4444-555555555555";
    const eop = attemptOp("mine", 2, ref);
    const edir = join(home, "budget", "ops", "evm-arc-testnet"), sdir = join(home, "budget", "ops", "solana-devnet");
    const evm = ["--chain", "arc-testnet", "--url", seller.url, "--max", "0.05", "--op", eop];
    for (const extra of [[], ["--recovery-order", "99999999-2222-3333-4444-555555555555"]]) {
      const r = await direct("evm/buy.ts", [...evm, ...extra]);
      expect(r.code, all(r)).toBe(3);
      expect(r.result).toMatchObject({ state: "refused_precheck", paid: false });
      expect(r.result.reason).toMatch(/reserved/);
    }
    const sol = await direct("solana/buy.mjs", ["--url", seller.url, "--max", "0.05", "--op", eop]);
    expect(sol.code, all(sol)).toBe(3);
    expect(sol.result.reason).toMatch(/reserved/);
    const viaCli = await buy(seller.url, { op: eop, chain: "arc-testnet" });
    expect(viaCli.code, all(viaCli)).toBe(3);
    expect(JSON.stringify(viaCli.result)).toMatch(/reserved/);
    const viaSolana = await buy(seller.url, { op: eop, rail: "solana" });
    expect(viaSolana.code, all(viaSolana)).toBe(3);
    expect(existsSync(join(edir, `${eop}.json`))).toBe(false);
    expect(existsSync(join(sdir, `${eop}.json`))).toBe(false);
    expect(seller.creds).toEqual([]);
    expect(arc.sentRaw).toEqual([]);
    // and the order that owns the name may buy it
    const own = await direct("evm/buy.ts", [...evm, "--recovery-order", ref]);
    expect(own.result, all(own)).toMatchObject({ state: "settled", paid: true });
  }, 240_000);
});

describe("a seller that never answers: refused no later than without the retry", () => {
  it("the unpaid read that ran out of time is not tried again, so the buy ends within --http-timeout", async () => {
    const hits: number[] = [];
    const server = createServer((req) => { hits.push(Date.now()); req.resume(); /* never answers */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    setUpEvm(null);
    const r = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", `http://127.0.0.1:${(server.address() as AddressInfo).port}/slow`, "--max", "0.05", "--op", "slow-1", "--http-timeout", "3", "--terms-reads", "1-3"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    // one read, cut off at --http-timeout: without the bound it was three reads, 3 s each, with waits between
    expect(hits).toHaveLength(1);
    expect(base.sentRaw).toEqual([]);
  }, 60_000);
});

describe("an order that moves on freezes every earlier attempt (three offers)", () => {
  it("attempt 2 fails its terms read, attempt 3 pays; neither the original nor attempt 2 is ever paid afterwards, by hand or through the dispatcher", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    // the first candidate is the same seller on Arc at a path that cannot be read either; the second works
    const site = await startSite({ advice: adviceFor([arcCandidate(gate.url, { offer_id: "arc-down", url: `${gate.url}/down` }), arcCandidate(gate.url)]) });
    setUpEvm(site.url);
    const r = await buy(`${gate.url}/spot`, { op: "three" });
    expect(r.code, all(r)).toBe(0);
    const r2 = aop("three", 2), r3 = aop("three", 3);
    expect(r.result).toMatchObject({ op: r3, chain: "arc-testnet", state: "settled", paid: true });
    expect(gate.hits.filter((h) => h.path === "/down")).toHaveLength(3);
    expect(arcSeller.settled).toHaveLength(1);
    const journal = (chain: string, op: string) => JSON.parse(readFileSync(join(home, "budget", "ops", `evm-${chain}`, `${op}.json`), "utf8"));
    expect(journal("arc-testnet", r2).supersededBy).toMatchObject({ order_ref: orderRef("three"), op: r3, root: { op: "three" } });
    expect(journal("base-sepolia", "three").supersededBy).toMatchObject({ op: r3 });
    // attempt 2, run by hand at a seller that works, with and without the order's reference: refused, nothing paid
    const working = await startSeller(arc, 5042002);
    cleanups.push(() => working.close());
    for (const extra of [[], ["--recovery-order", orderRef("three")]]) {
      const hand = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", working.url, "--max", "0.012", "--op", r2, ...extra]);
      // flagged, at another url than the attempt's: a collision (unknown, exit 5) is checked first; unflagged: reserved. Never paid.
      expect(hand.code, all(hand)).toBe(extra.length ? 5 : 3);
      expect(hand.result.reason).toMatch(extra.length ? /different request/ : /reserved/);
      expect(hand.result.state).not.toBe("settled");
    }
    // through the dispatcher: attempt 2 is answered from its order (attempt 3's payment), and so is the original
    for (const op of [r2, "three"]) {
      const again = await budget(["buy", "--rail", "evm", "--chain", op === r2 ? "arc-testnet" : "base-sepolia", "--url", working.url, "--max", "0.05", "--op", op]);
      expect(again.result, all(again)).toMatchObject({ op: r3, state: "settled", paid: true });
      expect(again.result.tx.settle).toBe(r.result.tx.settle);
    }
    const hand0 = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", working.url, "--max", "0.05", "--op", "three"]);
    expect(hand0.result.reason).toMatch(/superseded by auto recovery/);
    expect(working.creds).toEqual([]);
    expect(arcSeller.settled).toHaveLength(1);
    expect(base.sentRaw).toEqual([]);
  }, 300_000);
});

describe("a rerun answers from the order's record whatever its flags (--pay-to)", () => {
  it("a paid switch rerun with --pay-to is that payment; with the attempt's journal lost it is still reported paid, with its tx", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const gate = await startGate({ base: "503", arcSeller });
    const site = await startSite({ advice: adviceFor([arcCandidate(gate.url)]) });
    setUpEvm(site.url);
    const first = await buy(`${gate.url}/spot`, { op: "payto" });
    expect(first.code, all(first)).toBe(0);
    const payTo = ["--pay-to", "0x2222222222222222222222222222222222222222"];
    const again = await buy(`${gate.url}/spot`, { op: "payto", extra: payTo });
    expect(again.result, all(again)).toMatchObject({ op: aop("payto"), state: "settled", paid: true });
    const journal = join(home, "budget", "ops", "evm-arc-testnet", `${aop("payto")}.json`);
    renameSync(journal, `${journal}.away`);
    const lost = await buy(`${gate.url}/spot`, { op: "payto", extra: payTo });
    expect(lost.code, all(lost)).toBe(0);
    expect(lost.result).toMatchObject({ state: "settled", paid: true, tx: { settle: first.result.tx.settle } });
    expect(JSON.stringify(lost.result)).not.toMatch(/new --op/);
    expect(arcSeller.settled).toHaveLength(1);
    expect(site.adviceCalls).toHaveLength(1);
  }, 300_000);
});

describe("round 2: the original is never bought again once any attempt may have paid", () => {
  /** A recovered order paid on Arc; the original's own seller is reachable at `baseSeller` afterwards. */
  async function paidOrder(op: string, o: { deliver?: boolean } = {}) {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/arc")) {
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers, redirect: "manual" });
        const body = Buffer.from(await r.arrayBuffer());
        // a seller that settles and then fails to deliver: the paid answer is an error
        if (o.deliver === false && headers["payment-signature"]) return void res.writeHead(500, { ...relayed(r), "content-type": "text/plain" }).end("broken after payment");
        return void res.writeHead(r.status, relayed(r)).end(body);
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const gate = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await startSite({ advice: adviceFor([arcCandidate(gate)]) });
    setUpEvm(site.url);
    const first = await buy(`${gate}/spot`, { op });
    return { first, gate, site, arcSeller, baseSeller };
  }
  const opJournal = (op: string, chain = "base-sepolia") => join(home, "budget", "ops", `evm-${chain}`, `${op}.json`);

  it("lost original journal: a completed switch keeps the original, and a buy of it against a working seller is the order's payment, never a second one", async () => {
    const { first, arcSeller, baseSeller } = await paidOrder("own-lost");
    expect(first.code, all(first)).toBe(0);
    renameSync(opJournal("own-lost"), `${opJournal("own-lost")}.away`);
    // a rail script run by hand, with the mark gone with the journal: the recovery record still keeps the original
    const early = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "own-lost"]);
    expect(early.code, all(early)).toBe(3);
    expect(early.result.reason).toMatch(/recovery record says so/);
    expect(baseSeller.creds).toEqual([]);
    const again = await buy(baseSeller.url, { op: "own-lost" });
    expect(again.result, all(again)).toMatchObject({ op: aop("own-lost"), chain: "arc-testnet", state: "settled", paid: true });
    expect(baseSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    // and the original is marked again: a direct rail run of it is refused
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", baseSeller.url, "--max", "0.05", "--op", "own-lost"]);
    expect(hand.result, all(hand)).toMatchObject({ state: "refused_precheck" });
    expect(hand.result.reason).toMatch(/superseded by auto recovery/);
    expect(arcSeller.settled.length + baseSeller.settled.length).toBe(1);
  }, 300_000);

  it("paid but not delivered, then its journal lost: exit 4, delivered false, never exit 0", async () => {
    const { first, arcSeller } = await paidOrder("own-undelivered", { deliver: false });
    expect(first.code, all(first)).toBe(4);
    expect(first.result).toMatchObject({ state: "settled", paid: true, delivered: false });
    renameSync(opJournal(aop("own-undelivered"), "arc-testnet"), `${opJournal(aop("own-undelivered"), "arc-testnet")}.away`);
    const lost = await buy("http://127.0.0.1:9/gone", { op: "own-undelivered" });
    expect(lost.code, all(lost)).toBe(4);
    expect(lost.result).toMatchObject({ ok: false, state: "settled", paid: true, delivered: false, tx: { settle: first.result.tx.settle } });
    expect(arcSeller.settled).toHaveLength(1);
  }, 300_000);

  it("paid, journal lost, and the record does not hold the delivery: exit 4, delivered null and chain finality null, never exit 0", async () => {
    const { first, arcSeller } = await paidOrder("own-nodelivery");
    expect(first.code, all(first)).toBe(0);
    const file = join(recordsDir(), "evm-base-sepolia-own-nodelivery.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec.attempts[0]).toMatchObject({ outcome: "paid", delivered: true });
    // as a record from before delivery was kept
    delete rec.attempts[0].delivered; delete rec.attempts[0].chain_final;
    writeFileSync(file, JSON.stringify(rec));
    renameSync(opJournal(aop("own-nodelivery"), "arc-testnet"), `${opJournal(aop("own-nodelivery"), "arc-testnet")}.away`);
    const lost = await buy("http://127.0.0.1:9/gone", { op: "own-nodelivery" });
    expect(lost.code, all(lost)).toBe(4);
    expect(lost.result).toMatchObject({ ok: false, state: "settled", paid: true, delivered: null, chain_final: null });
    expect(lost.result.reason).toMatch(/delivery is not known/);
    expect(arcSeller.settled).toHaveLength(1);
  }, 300_000);
});

describe("round 2: a candidate that signed before the original was marked", () => {
  /**
   * The state a crash leaves between writing the switch and marking the original: the record says journaled, the original's
   * journal is unmarked. Built from an order killed at the candidate's first contact, with the original's mark taken off again.
   */
  async function beforeFirstFreeze(op: string) {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    let killer: (() => void) | undefined;
    let killOnce = true;
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/arc")) {
        if (killOnce) { killOnce = false; killer?.(); return; }
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers });
        return void res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const gate = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await startSite({ advice: adviceFor([arcCandidate(gate)]) });
    setUpEvm(site.url);
    const first = await buy(`${gate}/spot`, { op, onSpawn: (pid) => { killer = () => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }; } });
    expect(first.result).toBeNull();
    const original = join(home, "budget", "ops", "evm-base-sepolia", `${op}.json`);
    const j = JSON.parse(readFileSync(original, "utf8"));
    delete j.supersededBy;
    writeFileSync(original, JSON.stringify(j, null, 2));
    const file = join(recordsDir(), `evm-base-sepolia-${op}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    delete rec.owns; delete rec.attempts[0].freeze;
    writeFileSync(file, JSON.stringify(rec, null, 2));
    return { gate, arcSeller, baseSeller, site, original };
  }

  it("signed before the first freeze: the rerun answers the payment and marks the original; a later buy with changed flags against a working seller pays nothing", async () => {
    const { gate, arcSeller, baseSeller, original } = await beforeFirstFreeze("pre-freeze");
    const candidate = await direct("evm/buy.ts", candidateBuy(gate, "pre-freeze"));
    expect(candidate.result, all(candidate)).toMatchObject({ state: "settled", paid: true });
    const again = await buy(`${gate}/spot`, { op: "pre-freeze" });
    expect(again.result, all(again)).toMatchObject({ op: aop("pre-freeze"), state: "settled", paid: true });
    expect(JSON.parse(readFileSync(original, "utf8")).supersededBy).toMatchObject({ op: aop("pre-freeze") });
    // another --max, --pay-to and the original seller working again: still the order's payment
    const changed = await buy(baseSeller.url, { op: "pre-freeze", max: "0.04", extra: ["--pay-to", "0x0000000000000000000000000000000000000001"] });
    expect(changed.result, all(changed)).toMatchObject({ op: aop("pre-freeze"), state: "settled", paid: true });
    const plainRerun = await buy(baseSeller.url, { op: "pre-freeze" });
    expect(plainRerun.result, all(plainRerun)).toMatchObject({ op: aop("pre-freeze"), state: "settled", paid: true });
    expect(baseSeller.creds).toEqual([]);
    expect(arcSeller.settled.length + baseSeller.settled.length).toBe(1);
  }, 400_000);

  it("the candidate is busy (unknown) before the first freeze: the original is marked anyway, and no later buy pays it", async () => {
    const { gate, arcSeller, baseSeller, original } = await beforeFirstFreeze("pre-busy");
    const held = await holdRecordLock("evm", "arc-testnet", aop("pre-busy"));
    const busy = await buy(`${gate}/spot`, { op: "pre-busy" });
    expect(busy.code, all(busy)).toBe(5);
    expect(busy.result).toMatchObject({ state: "unknown", paid: null });
    expect(JSON.parse(readFileSync(original, "utf8")).supersededBy).toMatchObject({ op: aop("pre-busy") });
    await held.release();
    // the original journal is lost too: the record alone keeps the original
    renameSync(original, `${original}.away`);
    const later = await buy(baseSeller.url, { op: "pre-busy", extra: ["--pay-to", "0x0000000000000000000000000000000000000001"] });
    expect(later.result, all(later)).not.toBeNull();
    // whatever the order does next (carry the switch on, or end), the original seller is never paid
    expect(later.result.chain === "base-sepolia" && later.result.paid === true).toBe(false);
    expect(baseSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    expect(arcSeller.settled.length + baseSeller.settled.length).toBeLessThanOrEqual(1);
  }, 400_000);
});

describe("round 2: a journal stamped for another order is never this order's payment", () => {
  it("another order's settled journal at this order's attempt op (same URL): unknown on every rerun, never claimed, nothing paid again", async () => {
    const arcSeller = await startSeller(arc, 5042002);
    cleanups.push(() => arcSeller.close());
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    let killer: (() => void) | undefined;
    let killOnce = true;
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/arc")) {
        if (killOnce) { killOnce = false; killer?.(); return; }
        const headers: Record<string, string> = {};
        for (const k of ["payment-signature", "x-payment"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
        const r = await fetch(arcSeller.url, { headers });
        return void res.writeHead(r.status, relayed(r)).end(Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(503).end("down");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => closeServer(server));
    const gate = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const site = await startSite({ advice: adviceFor([arcCandidate(gate)]) });
    setUpEvm(site.url);
    const first = await buy(`${gate}/spot`, { op: "foreign-1", onSpawn: (pid) => { killer = () => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }; } });
    expect(first.result).toBeNull();
    // another order whose reference starts with the same 8 characters: its attempt has the same name and the same URL, and settles
    const otherRef = `${orderRef("foreign-1").slice(0, 8)}-0000-4000-8000-000000000000`;
    expect(otherRef).not.toBe(orderRef("foreign-1"));
    const other = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", `${gate}/arc`, "--max", "0.012", "--op", aop("foreign-1"), "--recovery-order", otherRef]);
    expect(other.result, all(other)).toMatchObject({ state: "settled", paid: true });
    for (let i = 0; i < 2; i++) {
      const again = await buy(`${gate}/spot`, { op: "foreign-1" });
      expect(again.code, all(again)).toBe(5);
      expect(again.result).toMatchObject({ state: "unknown", paid: null, final: false });
      expect(again.result.reason).toMatch(/names another auto-recovered order/);
    }
    expect(JSON.parse(readFileSync(join(recordsDir(), "evm-base-sepolia-foreign-1.json"), "utf8")).attempts[0].outcome).not.toBe("paid");
    // the original stays the order's: a buy of it against a working seller pays nothing
    const original = await buy(baseSeller.url, { op: "foreign-1" });
    expect(original.result?.paid, all(original)).not.toBe(true);
    expect(baseSeller.creds).toEqual([]);
    expect(arcSeller.settled).toHaveLength(1);
  }, 400_000);

  it("the rails refuse an attempt (--recovery-order) under an op whose journal names another order, and leave that journal as it was", async () => {
    setUpEvm(null);
    const dir = join(home, "budget", "ops", "evm-arc-testnet");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const seller = await startSeller(arc, 5042002);
    cleanups.push(() => seller.close());
    // the same request, stamped for another order
    const foreign = { op: "taken-11111111-r2", rail: "evm", path: "approve", state: "refused_precheck", owner: owner.address, agent: agent.address, createdAt: new Date().toISOString(), notes: [], signed: false, url: seller.url, recoveryOf: { order_ref: "aaaaaaaa-1111-4111-8111-111111111111" } };
    writeFileSync(join(dir, "taken-11111111-r2.json"), JSON.stringify(foreign), { mode: 0o600 });
    const r = await direct("evm/buy.ts", ["--chain", "arc-testnet", "--url", seller.url, "--max", "0.05", "--op", "taken-11111111-r2", "--recovery-order", "11111111-2222-3333-4444-555555555555"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(all(r)).toMatch(/belongs to another auto-recovered order/);
    expect(JSON.parse(readFileSync(join(dir, "taken-11111111-r2.json"), "utf8"))).toEqual(foreign);
    expect(seller.creds).toEqual([]);
    setUpSolana("http://127.0.0.1:9");
    const sdir = join(home, "budget", "ops", "solana-devnet");
    mkdirSync(sdir, { recursive: true, mode: 0o700 });
    const sforeign = { op: "taken-11111111-r2", state: "refused_precheck", history: [], recoveryOf: { order_ref: "aaaaaaaa-1111-4111-8111-111111111111" } };
    writeFileSync(join(sdir, "taken-11111111-r2.json"), JSON.stringify(sforeign), { mode: 0o600 });
    const s = await direct("solana/buy.mjs", ["--url", "http://127.0.0.1:9/x", "--max", "0.05", "--op", "taken-11111111-r2", "--recovery-order", "11111111-2222-3333-4444-555555555555"]);
    expect(s.code, all(s)).toBe(3);
    expect(s.result.reason).toMatch(/belongs to another auto-recovered order/);
    expect(JSON.parse(readFileSync(join(sdir, "taken-11111111-r2.json"), "utf8"))).toEqual(sforeign);
  }, 120_000);
});
