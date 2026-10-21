// Auto recovery for budget buys as a process: the real dispatcher and rail scripts, a fake superstables.com, two fake EVM chains
// (Base Sepolia and Arc Testnet, each with its own USDC) and sellers on 127.0.0.1. Nothing reaches a network, no wallet, no
// real key. The seller that cannot be read is a server that answers 503; the working one is a fake x402 seller on the other chain.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
interface Site { url: string; calls: SiteCall[]; features: string[]; advice: (req: any) => { status: number; body: unknown }; adviceCalls: SiteCall[]; reportCalls: SiteCall[]; }

/** A fake superstables.com: the feature list, and the two recovery routes, which check the agent's signature like the real one. */
async function startSite(over: Partial<Pick<Site, "features" | "advice">> = {}): Promise<Site & { close(): Promise<void> }> {
  const site: Site = { url: "", calls: [], features: ["recovery_advice_v1"], advice: () => ({ status: 404, body: { error: "not_found" } }), adviceCalls: [], reportCalls: [], ...over };
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    if (req.method === "GET" && req.url === "/api/v1/budget/services") return json(res, 200, { services: [], features: site.features });
    if (req.method === "POST" && req.url?.startsWith("/api/v1/recovery/")) {
      let body: any = null;
      try { body = JSON.parse(raw); } catch { /* */ }
      const call: SiteCall = { path: req.url, body, headers: req.headers, raw, signed: await signatureHolds(site.url, req, raw) };
      site.calls.push(call);
      if (req.url.endsWith("/advice")) { site.adviceCalls.push(call); const a = site.advice(body); return json(res, a.status, a.body); }
      site.reportCalls.push(call);
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
  const message = agentProofText(origin, "POST", String(req.url).split("?")[0], raw, ts, nonce);
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
const recordsDir = () => join(home, "budget", "recovery");
const ops = (rail: string, chain: string) => { const d = join(home, "budget", "ops", `${rail}-${chain}`); return existsSync(d) ? readdirSync(d) : []; };
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
/** The answer without the parts that differ per run. */
const plain = (r: any) => { const { op: _op, rpc: _rpc, ...rest } = r; return rest; };

// ---- tests --------------------------------------------------------------------------------------------------------------

describe("retry of the seller's terms, as a process", () => {
  it("reads an unreadable seller three times, 250 ms then 1 s apart, and then refuses as before: nothing signed, no site involved", async () => {
    const gate = await startGate({ base: "503" });
    setUpEvm(null);
    const r = await buy(`${gate.url}/spot`);
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", paid: false, rail: "evm", chain: "base-sepolia" });
    expect(r.result.recovery).toBeUndefined();
    expect(gate.hits).toHaveLength(3);
    const gaps = [gate.hits[1]!.at - gate.hits[0]!.at, gate.hits[2]!.at - gate.hits[1]!.at];
    expect(gaps[0]).toBeGreaterThanOrEqual(240);
    expect(gaps[1]).toBeGreaterThanOrEqual(990);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(base.sentRaw).toEqual([]);
  }, 60_000);

  it("waits for the seller's Retry-After, and reads a garbled 402 three times too", async () => {
    const slow = await startGate({ base: "retry-after" });
    setUpEvm(null);
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

  it("a seller that works on the second read is paid once, and the order never reaches the site", async () => {
    setUpEvm(null);
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
    return plain((await buy(`${gate.url}/spot`)).result);
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
    expect(gate.hits).toHaveLength(3);
    expect(base.sentRaw).toEqual([]);
    expect(arc.sentRaw).toEqual([]);
    expect(site.reportCalls).toEqual([]);
    // the site is asked only when it lists the feature
    expect(site.adviceCalls).toHaveLength(over.features.length ? 1 : 0);
    expect(existsSync(recordsDir())).toBe(false);
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
    expect(r.result).toMatchObject({ command: "buy", rail: "evm", chain: "arc-testnet", op: "rec-1-r2", state: "settled", paid: true, delivered: true });
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
    expect(rec).toMatchObject({ order_ref: ask.body.order_ref, op: "rec-1", attempts: [{ attempt_no: 2, offer_id: "arc-1", why: "the same seller on Arc", op: "rec-1-r2", state: "done", outcome: "paid", reported: true }] });
    // the original op signed nothing; the candidate's own journal lives with its chain
    expect(ops("evm", "arc-testnet")).toContain("rec-1-r2.json");
  }, 180_000);

  it("a second buy with the same op never goes back to the original seller or pays again", async () => {
    const { r, gate, site, arcSeller } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const hitsBefore = gate.hits.length;
    const again = await buy(`${gate.url}/spot`, { op: "rec-1" });
    expect(again.result).toMatchObject({ rail: "evm", chain: "arc-testnet", op: "rec-1-r2", state: "settled" });
    expect(again.result.recovery.switched).toBe(true);
    expect(gate.hits).toHaveLength(hitsBefore);
    expect(arcSeller.settled).toHaveLength(1);
    expect(site.adviceCalls).toHaveLength(1);
  }, 240_000);

  it("the original op is frozen at the rail: a direct rail script, run by hand, never pays it after the order moved", async () => {
    const { r, site } = await recovered((g) => [arcCandidate(g)]);
    expect(r.code, all(r)).toBe(0);
    const original = await startSeller(base, 84532);
    cleanups.push(() => original.close());
    const journal = JSON.parse(readFileSync(join(home, "budget", "ops", "evm-base-sepolia", "rec-1.json"), "utf8"));
    expect(journal.supersededBy).toMatchObject({ op: "rec-1-r2", rail: "evm", chain: "arc-testnet" });
    const hand = await direct("evm/buy.ts", ["--chain", "base-sepolia", "--url", original.url, "--max", "0.05", "--op", "rec-1"]);
    expect(hand.result, all(hand)).toMatchObject({ state: "refused_precheck", paid: false });
    expect(hand.result.reason).toMatch(/superseded by auto recovery/);
    expect(hand.code).toBe(3);
    expect(original.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
    // the dispatcher says the same
    const again = await buy(original.url, { op: "rec-1" });
    expect(again.result).toMatchObject({ op: "rec-1-r2", state: "settled" });
    expect(original.creds).toEqual([]);
    expect(site.adviceCalls).toHaveLength(1);
  }, 240_000);

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
    expect(r.result.recovery.skipped.map((s: any) => s.reason)).toEqual(["over_margin", "pricing_family", "disclosure_not_allowed", "no_consent", "not_funded", "unparsable_candidate"]);
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
    expect(rec.attempts[0]).toMatchObject({ attempt_no: 2, offer_id: "arc-1", state: "journaled", op: "rec-crash-r2" });
    expect(arcSeller.creds).toEqual([]);
    expect(site.adviceCalls).toHaveLength(1);
    const baseReads = hits.filter((h) => h === "/spot").length;

    // the rerun: no new advice, the original seller is not read, the switch is carried on and pays once
    const again = await buy(`${gate}/spot`, { op: "rec-crash" });
    expect(again.code, all(again)).toBe(0);
    expect(again.result).toMatchObject({ chain: "arc-testnet", op: "rec-crash-r2", state: "settled", paid: true });
    expect(again.result.recovery).toMatchObject({ switched: true, order_ref: rec.order_ref });
    expect(arcSeller.settled).toHaveLength(1);
    expect(site.adviceCalls).toHaveLength(1);
    expect(hits.filter((h) => h === "/spot")).toHaveLength(baseReads);
    expect(base.sentRaw).toEqual([]);

    // and a third run answers from the candidate's journal without paying again
    const third = await buy(`${gate}/spot`, { op: "rec-crash" });
    expect(third.result).toMatchObject({ chain: "arc-testnet", op: "rec-crash-r2" });
    expect(["settled", "unknown"]).toContain(third.result.state);
    expect(arcSeller.settled).toHaveLength(1);
  }, 300_000);
});

describe("solana: the same retry, and a payment on another rail when the site advises it with a consent", () => {
  it("reads the terms three times, then moves to a seller the owner shared requests with, on Base Sepolia, and says so", async () => {
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const down = await startGate({ base: "503" });
    const other = {
      kind: "service", offer_id: "svc-1", capability: "spot-price", params: {}, seller: { id: "seller-2", name: "Other prices", operator: "demo", ours: false, origin: new URL(baseSeller.url).origin }, url: baseSeller.url, chain: "base-sepolia",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", listed_price_atomic: "10000", pricing_family: "test:USDC:6",
      disclosure: { required: true, allowed: true, consent_id: "consent-1", fields: ["asset"] }, rank: { tier: "equivalent", health: "4/5", why: "an equivalent seller" },
    };
    const site = await startSite({ advice: adviceFor([other], { sharing: [{ capability: "spot-price", seller_id: "seller-2", seller_origin: new URL(baseSeller.url).origin, consent_id: "consent-1" }] }) });
    setUpSolana(site.url);
    setUpEvm(null, ["base-sepolia"]);
    const r = await buy(`${down.url}/sol`, { rail: "solana", op: "rec-sol" });
    expect(r.code, all(r)).toBe(0);
    expect(down.hits).toHaveLength(3);
    expect(baseSeller.settled).toHaveLength(1);
    expect(r.result).toMatchObject({ rail: "evm", chain: "base-sepolia", op: "rec-sol-r2", state: "settled", paid: true });
    expect(r.result.recovery).toMatchObject({ switched: true, kind: "service", disclosed: true, original: { rail: "solana", chain: "devnet", op: "rec-sol" } });
    // the advice request was signed with the Solana agent key (ed25519), for this site
    expect(site.adviceCalls[0]!.signed).toBe(true);
    expect(site.adviceCalls[0]!.body).toMatchObject({ original: { chain: "devnet", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, failure: { attempts_used: 3 } });
    expect(site.reportCalls[0]!.body).toMatchObject({ outcome: "paid", disclosed: true, offer_id: "svc-1" });
  }, 240_000);

  it("without the consent in the policy copy, the other seller is never contacted", async () => {
    const baseSeller = await startSeller(base, 84532);
    cleanups.push(() => baseSeller.close());
    const down = await startGate({ base: "503" });
    const other = {
      kind: "service", offer_id: "svc-1", capability: "spot-price", params: {}, seller: { id: "seller-2", name: "Other prices", operator: "demo", ours: false, origin: new URL(baseSeller.url).origin }, url: baseSeller.url, chain: "base-sepolia",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", listed_price_atomic: "10000", pricing_family: "test:USDC:6",
      disclosure: { required: true, allowed: true, consent_id: "consent-1", fields: ["asset"] }, rank: { tier: "equivalent", health: "4/5", why: "an equivalent seller" },
    };
    const site = await startSite({ advice: adviceFor([other], { sharing: [] }) });
    setUpSolana(site.url);
    setUpEvm(null, ["base-sepolia"]);
    const r = await buy(`${down.url}/sol`, { rail: "solana", op: "rec-sol-2" });
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ rail: "solana", state: "refused_precheck", paid: false });
    expect(r.result.recovery.skipped).toEqual([{ offer_id: "svc-1", reason: "no_consent" }]);
    expect(baseSeller.creds).toEqual([]);
    expect(base.sentRaw).toEqual([]);
  }, 240_000);
});
