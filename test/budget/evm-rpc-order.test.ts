// Which RPC a budget EVM command uses (B4_RPC_<CHAIN>, then B4_RPC, then the owner's settings, then the built-in one), that the
// owner-action guard judges the variable that actually wins, and that a refused endpoint set says why. Loopback fakes only.
import { spawn } from "node:child_process";
import { appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeRpc } from "../helpers/fake-site.js";
import { makeChain, makeHome } from "../helpers/fake-evm.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import { agreementWords } from "../../budget/evm/lib.js";
import { evmRpcFromEnv, ownerRpcNext, ownerRpcProblem } from "../../budget/rpc.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BUILTIN = "https://sepolia.base.org";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const account = (settings: object | null) => { const a = accountHomeWith(settings); cleanups.push(() => rmSync(a, { recursive: true, force: true })); return a; };

/** process.env for the length of one callback (the in-process cases read it). */
function withEnv<T>(env: Record<string, string | undefined>, f: () => T): T {
  const saved = { ...process.env };
  for (const k of ["B4_RPC", "B4_RPC_BASE_SEPOLIA", "SUPERSTABLES_TEST_ACCOUNT_HOME"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try { return f(); } finally { process.env = saved; }
}

describe("the order of the RPC: B4_RPC_<CHAIN>, then B4_RPC, then the owner's settings, then the built-in one", () => {
  const owner = () => account({ version: 1, rpc: { "base-sepolia": { urls: ["https://owner.example/rpc"] } } });
  const pick = (env: Record<string, string | undefined>, acct: string) => withEnv({ SUPERSTABLES_TEST_ACCOUNT_HOME: acct, ...env }, () => evmRpcFromEnv("base-sepolia", BUILTIN));

  it("the chain's own variable wins over B4_RPC and the owner's RPC", () => {
    expect(pick({ B4_RPC_BASE_SEPOLIA: "https://chain.example/rpc", B4_RPC: "https://shared.example/rpc" }, owner())).toMatchObject({ url: "https://chain.example/rpc", custom: true, name: "B4_RPC_BASE_SEPOLIA" });
  });
  it("B4_RPC wins over the owner's RPC when the chain's own variable is unset", () => {
    expect(pick({ B4_RPC: "https://shared.example/rpc" }, owner())).toMatchObject({ url: "https://shared.example/rpc", custom: true, name: "B4_RPC" });
  });
  it("the owner's RPC wins over the built-in one when neither variable is set", () => {
    expect(pick({}, owner())).toMatchObject({ url: "https://owner.example/rpc", custom: true });
  });
  it("the built-in one is used when nothing is set", () => {
    expect(pick({}, account(null))).toMatchObject({ url: BUILTIN, custom: false });
  });
  it("a chain's own variable that is refused is an error, not a silent fall through to B4_RPC", () => {
    expect(pick({ B4_RPC_BASE_SEPOLIA: "http://example.com/rpc", B4_RPC: "https://shared.example/rpc" }, owner()).error).toContain("B4_RPC_BASE_SEPOLIA is refused");
  });
});

describe("the owner-action guard judges the variable that wins", () => {
  const judge = (env: Record<string, string | undefined>, acct: string) => withEnv({ SUPERSTABLES_TEST_ACCOUNT_HOME: acct, ...env }, () => ({ problem: ownerRpcProblem("evm", "base-sepolia"), next: ownerRpcNext("evm", "base-sepolia") }));

  it("B4_RPC_BASE_SEPOLIA naming an RPC the owner did not set is refused, and named", () => {
    const j = judge({ B4_RPC_BASE_SEPOLIA: "https://agent.example/rpc" }, account(null));
    expect(j.problem).toContain("B4_RPC_BASE_SEPOLIA (https://agent.example/…) is not an RPC the owner set for base-sepolia");
    expect(j.next).toContain("unset B4_RPC_BASE_SEPOLIA");
  });
  it("it is refused even when B4_RPC alone would have been allowed", () => {
    expect(judge({ B4_RPC_BASE_SEPOLIA: "https://agent.example/rpc", B4_RPC: BUILTIN }, account(null)).problem).toContain("B4_RPC_BASE_SEPOLIA");
  });
  it("a B4_RPC that no longer wins does not stop the command", () => {
    expect(judge({ B4_RPC_BASE_SEPOLIA: BUILTIN, B4_RPC: "https://agent.example/rpc" }, account(null)).problem).toBe("");
  });
  it("B4_RPC alone is still judged, as before", () => {
    const j = judge({ B4_RPC: "https://agent.example/rpc" }, account(null));
    expect(j.problem).toContain("B4_RPC (https://agent.example/…) is not an RPC");
    expect(j.next).toContain("unset B4_RPC,");
  });
  it("the owner's own URL through the chain's variable is allowed", () => {
    const acct = account({ version: 1, rpc: { "base-sepolia": { urls: ["https://owner.example/rpc"] } } });
    expect(judge({ B4_RPC_BASE_SEPOLIA: "https://owner.example/rpc" }, acct).problem).toBe("");
  });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function run(argv: string[], env: Record<string, string>, script?: string): Promise<Out> {
  return new Promise((done) => {
    const [cmd, args] = script ? [join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, script), ...argv]] : [process.execPath, [join(ROOT, "budget/cli.mjs"), ...argv]];
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, B4_CHAIN: "", B4_RPC: "", B4_RPC_BASE_SEPOLIA: "", ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch {}
      done({ code: code ?? 0, stdout, stderr, result });
    });
  });
}

describe("owner actions through the chain's own variable (the real CLI)", () => {
  async function fakeAndHome() {
    const calls: string[] = [];
    const fake = await startFakeRpc(84532, (m) => { calls.push(m); return undefined; });
    const h = makeHome();
    cleanups.push(() => fake.close(), h.cleanup);
    return { calls, fake, h };
  }

  it.each([
    ["grant", ["grant", "--rail", "evm", "--amount", "1"]],
    ["revoke", ["revoke", "--rail", "evm"]],
  ])("%s through the dispatcher: B4_RPC_BASE_SEPOLIA the owner did not set is refused (exit 3) and the RPC hears nothing", async (_n, args) => {
    const { calls, fake, h } = await fakeAndHome();
    const r = await run([...args, "--yes"], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account(null), B4_RPC_BASE_SEPOLIA: fake.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toContain(`B4_RPC_BASE_SEPOLIA (${fake.url}) is not an RPC the owner set for base-sepolia`);
    expect(r.result.next).toContain("unset B4_RPC_BASE_SEPOLIA");
    expect(calls).toEqual([]);
  }, 90_000);

  it("the owner script run directly refuses it too, before it reads a key", async () => {
    const { calls, fake, h } = await fakeAndHome();
    const r = await run(["--cap", "1", "--owner-key-file", join(h.home, "owner.env")], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account(null), B4_RPC_BASE_SEPOLIA: fake.url, B4_RPC: BUILTIN }, "budget/evm/setBudget.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/REFUSED: B4_RPC_BASE_SEPOLIA .*is not an RPC the owner set/);
    expect(calls).toEqual([]);
  }, 90_000);
});

describe("which RPC a read uses (the real CLI)", () => {
  async function two() {
    const a = await makeChain({ allow: "1" }), b = await makeChain({ allow: "1" });
    const h = makeHome();
    cleanups.push(() => a.close(), () => b.close(), h.cleanup);
    return { a, b, h };
  }
  const asked = (c: { rpcLog: { method: string }[] }) => c.rpcLog.length;

  it("B4_RPC wins over the owner's RPC", async () => {
    const { a, b, h } = await two();
    const r = await run([], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account({ version: 1, rpc: { "base-sepolia": { urls: [b.url] } } }), B4_RPC: a.url }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(asked(a)).toBeGreaterThan(0);
    expect(asked(b)).toBe(0);
  }, 90_000);

  it("the owner's RPC is read when no variable is set", async () => {
    const { a, b, h } = await two();
    const r = await run([], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account({ version: 1, rpc: { "base-sepolia": { urls: [b.url] } } }) }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(asked(b)).toBeGreaterThan(0);
    expect(asked(a)).toBe(0);
  }, 90_000);

  it("B4_RPC_BASE_SEPOLIA wins over both B4_RPC and the owner's RPC", async () => {
    const { a, b, h } = await two();
    const c = await makeChain({ allow: "1" });
    cleanups.push(() => c.close());
    const r = await run([], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account({ version: 1, rpc: { "base-sepolia": { urls: [b.url] } } }), B4_RPC: a.url, B4_RPC_BASE_SEPOLIA: c.url }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(asked(c)).toBeGreaterThan(0);
    expect(asked(a) + asked(b)).toBe(0);
  }, 90_000);
});

describe("a set that cannot be built says why, in the owner settings' words (the real CLI)", () => {
  async function zeroAllowance(env: (url: string) => Record<string, string>) {
    const chain = await makeChain({ allow: "0" });
    const h = makeHome();
    appendFileSync(join(h.home, "budget", "public", "evm-base-sepolia.env"), `B4_REVOKED_AT=${Math.floor(Date.now() / 1000) - 3600}\n`);
    cleanups.push(() => chain.close(), h.cleanup);
    // the production defaults: this computer's RPCs are not the owner's, so a loopback variable cannot decide a verdict
    return run([], { SUPERSTABLES_HOME: h.home, SUPERSTABLES_TEST_ACCOUNT_HOME: account(null), ...env(chain.url) }, "budget/evm/read.ts");
  }

  it("B4_RPC: the allowance reads 0, but the line is not 'revoked', and it quotes why", async () => {
    const r = await zeroAllowance((url) => ({ B4_RPC: url }));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ allowanceZero: true, revoked: false });
    expect(r.result.agreement).toMatch(/^the RPC endpoints could not be used: B4_RPC \(http:\/\/127\.0\.0\.1:\d+\) is not an RPC the owner set for base-sepolia/);
    expect(r.stdout).toContain("revoked: no: the allowance reads 0 on this RPC, but the RPC endpoints could not be used: B4_RPC (");
    expect(r.result.agreement).toContain("Unset it, or ask the owner to add it in the owner settings");
  }, 90_000);

  it("B4_RPC_BASE_SEPOLIA is the name in the words when it is the one that decided", async () => {
    const r = await zeroAllowance((url) => ({ B4_RPC_BASE_SEPOLIA: url }));
    expect(r.result.agreement).toContain("B4_RPC_BASE_SEPOLIA (http://127.0.0.1:");
  }, 90_000);
});

describe("agreementWords", () => {
  it("keeps the engine's words, and adds the refusal's own reason only for a set that could not be built", () => {
    expect(agreementWords({ agreed: false, why: "disagree" } as any)).toBe("the RPC endpoints disagree");
    expect(agreementWords({ agreed: false, why: "unreadable", left: ["a: down"] } as any)).toBe("the RPC endpoints could not be read (left out: a: down)");
    expect(agreementWords({ agreed: false, why: "unreadable", reason: "the owner settings could not be read: broken" } as any)).toBe("the RPC endpoints could not be used: the owner settings could not be read: broken. Unset it, or ask the owner to add it in the owner settings");
  });
});
