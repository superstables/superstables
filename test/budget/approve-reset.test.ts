// A token that needs its allowance at 0 before a new one (approveReset) is never granted through the approval site, which
// has no approve(0) step, and a grant on this computer never approves over a live allowance. Part A runs a copy of the
// client whose Base Sepolia entry says approveReset: true (the copy is edited on disk, as a later change to the table would
// be). Part B runs the real tree against an in-memory chain (test/helpers/fake-evm.ts) whose token reverts an approve over
// a live allowance.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { domainSeparator } from "viem";
import { makeChain, makeHome, startFakeEvm, startSeller, usdc } from "../helpers/fake-evm.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TSX = join(ROOT, "node_modules/.bin/tsx");
const APPROVE = "0x095ea7b3";
const cleanups: (() => unknown)[] = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

type Run = { code: number | null; out: string; result: any };
function run(cwd: string, cmd: string, argv: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((done) => {
    const c = spawn(cmd, argv, { cwd, env: { ...process.env, B4_CHAIN: "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => c.kill("SIGKILL"), 90_000);
    c.once("close", (code) => {
      clearTimeout(timer);
      const l = out.trim().split("\n").reverse().find((x) => x.startsWith("RESULT "));
      done({ code, out, result: l ? JSON.parse(l.slice(7)) : null });
    });
  });
}

/** A loopback HTTP server that only counts requests (the site, which must never hear from a refused command). */
async function countingSite() {
  let hits = 0;
  const server: Server = createServer((_q, r) => { hits++; r.writeHead(500).end(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits: () => hits };
}

describe("a copy of the client whose Base Sepolia token says approveReset: true", () => {
  let tree: string;
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "ss-approve-reset-tree-"));
    for (const dir of ["budget", "src"]) cpSync(join(ROOT, dir), join(tree, dir), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(tree, file));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
    const path = join(tree, "budget/evm/chains.mjs");
    const text = readFileSync(path, "utf8");
    const from = `"USDC", version: "2" }, approveReset: false },\n    // sepolia.base.org`;
    if (text.split(from).length !== 2) throw new Error(`chains.mjs: expected exactly one ${JSON.stringify(from)}`);
    writeFileSync(path, text.replace(from, `"USDC", version: "2" }, approveReset: true },\n    // sepolia.base.org`));
    cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
  }, 60_000);

  it("setup --hosted --grant is refused before any key, RPC or site is touched", async () => {
    const site = await countingSite();
    const h = makeHome(); cleanups.push(h.cleanup);
    rmSync(join(h.home, "keys"), { recursive: true, force: true });
    rmSync(join(h.home, "budget"), { recursive: true, force: true });
    const r = await run(tree, TSX, [join(tree, "budget/evm/setup.ts"), "--hosted", "--site", site.url, "--grant", "1"], { SUPERSTABLES_HOME: h.home });
    expect(r.code, r.out).toBe(3);
    expect(r.result).toMatchObject({ command: "setup", state: "refused_precheck" });
    expect(r.result.reason).toMatch(/^USDC on Base Sepolia needs its allowance set to 0 before a new one is approved, and approvals on 127\.0\.0\.1:\d+ have no such step, so this budget is not asked for there$/);
    expect(r.out).toContain("REFUSED: USDC on Base Sepolia needs its allowance set to 0");
    expect(existsSync(join(h.home, "keys", "budget", "evm-agent.env"))).toBe(false);
    expect(site.hits()).toBe(0);
  }, 120_000);

  it("grant on a hosted chain is refused with nothing sent and no site request", async () => {
    const site = await countingSite();
    const chain = await makeChain({ allow: "0" });
    cleanups.push(() => chain.close());
    const h = makeHome(); cleanups.push(h.cleanup);
    const pub = join(h.home, "budget", "public", "evm-base-sepolia.env");
    writeFileSync(pub, `${readFileSync(pub, "utf8")}APPROVALS=hosted\nSITE=${site.url}\n`);
    const r = await run(tree, process.execPath, [join(tree, "budget/cli.mjs"), "grant", "--rail", "evm", "--amount", "1"], { SUPERSTABLES_HOME: h.home, B4_RPC: chain.url });
    expect(r.code, r.out).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/needs its allowance set to 0 before a new one is approved/);
    expect(chain.sentRaw).toEqual([]);
    expect(site.hits()).toBe(0);
  }, 120_000);
});

describe("the real tree against a token that reverts an approve over a live allowance", () => {
  async function setup(live: bigint) {
    const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey);
    const agentKey = generatePrivateKey(), agent = privateKeyToAccount(agentKey);
    const chain = await startFakeEvm();
    (chain as unknown as { approveReset: boolean }).approveReset = true;
    chain.setUsdc(owner.address, usdc("100"));
    chain.setNative(owner.address, 10n ** 20n);
    chain.setAllowance(owner.address, agent.address, live);
    const home = mkdtempSync(join(tmpdir(), "approve-reset-home-"));
    cleanups.push(() => chain.close(), () => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\n`, { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${owner.address}\nB4_AGENT_ADDRESS=${agent.address}\n`);
    writeFileSync(join(home, "owner.env"), `B4_OWNER_KEY=${ownerKey}\n`, { mode: 0o600 });
    const grant = (extra: string[]) => run(ROOT, TSX, [join(ROOT, "budget/evm/setBudget.ts"), "--cap", "2", ...extra], { SUPERSTABLES_HOME: home, B4_RPC: chain.url });
    const approvals = () => chain.sentRaw.filter((t) => t.data.startsWith(APPROVE)).map((t) => BigInt(`0x${t.data.slice(74, 138)}`));
    return { chain, owner, agent, home, grant, approvals };
  }

  it("--replace sends approve(agent, 0), waits for 0, then approve(agent, cap); without it nothing is sent", async () => {
    const s = await setup(usdc("1"));
    const refused = await s.grant(["--owner-key-file", join(s.home, "owner.env")]);
    expect(refused.code, refused.out).toBe(3);
    expect(s.approvals()).toEqual([]);
    const r = await s.grant(["--owner-key-file", join(s.home, "owner.env"), "--replace"]);
    expect(r.code, r.out).toBe(0);
    expect(s.approvals()).toEqual([0n, usdc("2")]);
    expect(s.chain.allowanceOf(s.owner.address, s.agent.address)).toBe(usdc("2"));
  }, 120_000);

  it("a grant from 0 is one approve", async () => {
    const s = await setup(0n);
    const r = await s.grant(["--owner-key-file", join(s.home, "owner.env")]);
    expect(r.code, r.out).toBe(0);
    expect(s.approvals()).toEqual([usdc("2")]);
  }, 120_000);

  it("through the owner page (no owner key file) a live allowance is refused: no page, nothing sent", async () => {
    const s = await setup(usdc("1"));
    const r = await s.grant(["--no-open"]);
    expect(r.code, r.out).toBe(3);
    expect(r.out).toMatch(/already live/);
    expect(s.approvals()).toEqual([]);
  }, 120_000);
});

describe("preflight against a token that answers another signing domain", () => {
  it("fails the DOMAIN_SEPARATOR() line", async () => {
    const chain = await makeChain();
    cleanups.push(() => chain.close());
    const sel = await startSeller(chain, 84532);
    cleanups.push(() => sel.close());
    const other = domainSeparator({ domain: { name: "USD Coin", version: "2", chainId: 84532, verifyingContract: chain.usdcAddress } });
    chain.hook = (method, params) => (method === "eth_call" && params?.[0]?.data === "0x3644e515" ? { result: other } : undefined);
    const h = makeHome(); cleanups.push(h.cleanup);
    const r = await run(ROOT, TSX, [join(ROOT, "budget/evm/preflight.ts"), "--url", sel.url, "--max", "0.05"], { SUPERSTABLES_HOME: h.home, B4_RPC: chain.url });
    expect(r.out).toMatch(/FAIL -- DOMAIN_SEPARATOR\(\)/);
    expect(r.result).toMatchObject({ state: "failed" });
  }, 120_000);
});
