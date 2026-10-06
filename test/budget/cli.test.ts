// superstables budget as a process, before it reaches a rail: which copy runs, and what it refuses up front.
//
// Nothing here reaches the network or starts a rail script: every case ends in the dispatcher (help, version, a
// refusal) or in a stand-in for the built copy.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = resolve(ROOT, "src/cli/main.ts");
const BUDGET = resolve(ROOT, "budget/cli.mjs");
// Loaded before the dispatcher: makes it believe it runs on native Windows.
const AS_WINDOWS = 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "superstables-budget-test-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: work, env: { ...process.env, SUPERSTABLES_HOME: join(work, "home"), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}

const result = (stdout: string) => {
  const last = stdout.trimEnd().split("\n").pop() ?? "";
  expect(last.startsWith("RESULT {")).toBe(true);
  return JSON.parse(last.slice(7));
};

/** A checkout with the budget sources and no node_modules: what `npm ci --omit=dev` and a prune leave, minus the rest. */
function checkoutWithoutDevPackages(): string {
  const repo = join(work, "repo");
  cpSync(resolve(ROOT, "budget"), join(repo, "budget"), { recursive: true });
  mkdirSync(join(repo, "src", "core"), { recursive: true });
  cpSync(resolve(ROOT, "src/core/finality-policy.js"), join(repo, "src/core/finality-policy.js"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "checkout", version: "9.9.9" }));
  return repo;
}

describe("superstables budget on native Windows", () => {
  for (const argv of [
    ["setup", "--rail", "evm"],
    ["grant", "--rail", "tempo", "--amount", "1"],
    ["wait", "--id", "oa-20260930120000-1a2b3c4d"],
    ["doctor", "--rail", "evm"],
    ["buy", "--rail", "solana", "--url", "https://example.com", "--max", "1"],
    ["status", "--rail", "evm"],
  ]) {
    it(`refuses ${argv[0]} before doing anything, and points at WSL`, async () => {
      const r = await run(["--import", AS_WINDOWS, BUDGET, ...argv]);
      expect(r.code).toBe(2);
      const out = result(r.stdout);
      expect(out).toMatchObject({ ok: false, command: argv[0], state: "failed" });
      expect(out.reason).toMatch(/WSL/);
      expect(r.stderr).toMatch(/WSL/);
    });
  }

  it("still prints help and the version", async () => {
    expect((await run(["--import", AS_WINDOWS, BUDGET, "--help"])).code).toBe(0);
    expect((await run(["--import", AS_WINDOWS, BUDGET, "grant", "--help"])).code).toBe(0);
    const v = await run(["--import", AS_WINDOWS, BUDGET, "--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/^superstables budget /);
  });
});

describe("owner approval help", () => {
  it("keeps recovery local when other owner commands offer hosted approval", async () => {
    const recover = await run([BUDGET, "recover", "--help"]);
    expect(recover.code).toBe(0);
    expect(recover.stdout).toContain("Recovery always uses this machine's local approval page");
    expect(recover.stdout).toContain("127.0.0.1");
    expect(recover.stdout).not.toContain("the approval link is on superstables.com");
    expect(recover.stdout).not.toContain("matchCode");
    expect(recover.stdout).not.toContain("match code");

    const grant = await run([BUDGET, "grant", "--help"]);
    expect(grant.code).toBe(0);
    expect(grant.stdout).toContain("the approval link is on superstables.com");
    expect(grant.stdout).toContain("matchCode");
  });
});

describe("setup --fund-only", () => {
  for (const [argv, why] of [
    [["--rail", "evm"], /tempo only/],
    [["--rail", "tempo", "--agent", "2"], /no --agent/],
    [["--rail", "tempo", "--new-owner"], /no --new-owner/],
    [["--rail", "tempo", "--detach"], /no --detach/],
    [["--rail", "tempo", "--hosted"], /no --hosted/],
    [["--rail", "tempo", "--site", "https://www.superstables.com"], /no --site/],
    [["--rail", "tempo", "--grant", "1"], /no --grant/],
    [["--rail", "tempo", "--fund"], /no --fund/],
  ] as const) {
    it(`refuses ${argv.join(" ")} before running a rail script`, async () => {
      const r = await run([BUDGET, "setup", "--fund-only", ...argv]);
      expect(r.code).toBe(2);
      expect(result(r.stdout)).toMatchObject({ ok: false, command: "setup", state: "failed" });
      expect(result(r.stdout).reason).toMatch(why);
    });
  }

  it("is in setup's help", async () => {
    const r = await run([BUDGET, "setup", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[--fund-only\]/);
    expect(r.stdout).toMatch(/--fund-only tops up the\s+owner on record/);
  });
});

describe("a checkout without its dev packages", () => {
  it.each(["evm", "solana", "tempo"])("published %s reconcile prints a runnable provisional next command", async (rail) => {
    const repo = checkoutWithoutDevPackages();
    unlinkSync(join(repo, "budget", "owner-page.ts"));
    const chain = rail === "evm" ? "base-sepolia" : rail === "solana" ? "devnet" : "moderato";
    const op = "provisional-order";
    const dir = join(work, "home", "budget", "ops", `${rail}-${chain}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${op}.json`), JSON.stringify({ op, state: "settled", final: false, path: "approve" }));
    writeFileSync(join(repo, "budget", rail, "reconcile.mjs"), `console.log('RESULT ' + JSON.stringify({ state: 'settled', chain_final: false, delivered: false, debit: '0.01', next: 'node budget/${rail}/reconcile.mjs' }));`);
    const r = await run([join(repo, "budget", "cli.mjs"), "reconcile", "--rail", rail, "--op", op]);
    expect(r.code).toBe(4);
    expect(result(r.stdout)).toMatchObject({ state: "settled", paid: true, delivered: false, final: true, chain_final: false, next: `Run superstables budget reconcile --rail ${rail}${rail === "evm" ? " --chain base-sepolia" : ""} --op ${op} later to check finality. Do not pay again. Contact the seller.` });
  });
  it.each(["unknown", "settled"])("published reconcile separates command completion from chain finality: %s", async (state) => {
    const repo = checkoutWithoutDevPackages();
    unlinkSync(join(repo, "budget", "owner-page.ts"));
    const dir = join(work, "home", "budget", "ops", "solana-devnet");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test-order.json"), JSON.stringify({ op: "test-order", state: "unknown" }));
    writeFileSync(join(repo, "budget", "solana", "reconcile.mjs"), `console.log('RESULT ' + JSON.stringify({ state: '${state}', delivered: true, debit: '0.01' }));`);
    const r = await run([join(repo, "budget", "cli.mjs"), "reconcile", "--rail", "solana", "--op", "test-order"]);
    expect(result(r.stdout)).toMatchObject({ state, final: true, chain_final: null });
  });
  it.each(["unknown", "refused_precheck", "settled"])("published wait normalizes a legacy stored %s result", async (state) => {
    const repo = checkoutWithoutDevPackages();
    unlinkSync(join(repo, "budget", "owner-page.ts"));
    const id = "oa-20260930120000-1a2b3c4d";
    const dir = join(work, "home", "budget", "approvals");
    mkdirSync(dir, { recursive: true });
    const paid = state === "settled";
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, command: "grant", rail: "evm", chain: "base-sepolia", final: { code: paid ? 0 : 5, result: { command: "grant", state, final: true, complete: true } } }));
    const r = await run([join(repo, "budget", "cli.mjs"), "wait", "--id", id, "--shown", "--json"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ state, final: true, chain_final: null });
    expect(JSON.parse(r.stdout)).not.toHaveProperty("complete");
  });
  for (const rail of ["evm", "solana", "tempo"]) for (const command of ["buy", "reconcile"]) {
    for (const json of [false, true]) for (const [state, chainFinal, delivered, code] of [
      ["settled", false, true, 0], ["settled", false, false, 4],
      ["settled", true, true, 0], ["unknown", null, true, 5],
    ] as const) it(`${rail} ${command} keeps the 0.3.0 completion contract: ${state}/${chainFinal}/${delivered}, json=${json}`, async () => {
      const repo = checkoutWithoutDevPackages();
      unlinkSync(join(repo, "budget", "owner-page.ts"));
      const chain = rail === "evm" ? "base-sepolia" : rail === "solana" ? "devnet" : "moderato";
      const dir = join(work, "home", "budget", "ops", `${rail}-${chain}`);
      mkdirSync(dir, { recursive: true });
      if (command === "reconcile") writeFileSync(join(dir, "contract.json"), JSON.stringify({ op: "contract", state: "unknown" }));
      // An existing setup lets buy reach the stand-in rail without a wallet or a payment.
      mkdirSync(join(work, "home", "keys", "budget"), { recursive: true });
      mkdirSync(join(work, "home", "budget", "public"), { recursive: true });
      writeFileSync(join(work, "home", "keys", "budget", `${rail}-agent.env`), "B4_AGENT_KEY=test\nAGENT_PRIVATE_KEY=test\nSOLANA_AGENT_SECRET_BASE58=test", { mode: 0o600 });
      writeFileSync(join(work, "home", "budget", "public", `${rail}-${chain}.env`), "B4_OWNER_ADDRESS=test\nOWNER_ADDRESS=test\nSOLANA_OWNER_ADDRESS=test");
      writeFileSync(join(repo, "budget", rail, `${command}.mjs`), `console.log('RESULT ' + JSON.stringify(${JSON.stringify({ state, final: chainFinal !== false, chain_final: chainFinal, delivered, debit: "0.01" })}));`);
      const args = [join(repo, "budget", "cli.mjs"), command, "--rail", rail, "--op", "contract", ...(json ? ["--json"] : []), ...(command === "buy" ? ["--url", "https://seller.example", "--max", "1"] : [])];
      const r = await run(args);
      const out = json ? JSON.parse(r.stdout) : result(r.stdout);
      expect(r.code, r.stderr).toBe(code);
      expect(out).toMatchObject({ state, final: true, chain_final: chainFinal, paid: state === "settled" ? true : null, delivered });
      expect(out).not.toHaveProperty("complete");
    });
  }
  it("says what to run when it has no build either", async () => {
    const repo = checkoutWithoutDevPackages();
    const r = await run([join(repo, "budget", "cli.mjs"), "doctor", "--rail", "evm"]);
    expect(r.code).toBe(2);
    expect(result(r.stdout).next).toMatch(/npm ci/);
    const v = await run([join(repo, "budget", "cli.mjs"), "--version"]);
    expect(v.code).toBe(0);
    expect(v.stdout).toMatch(/superstables budget 9\.9\.9 \(checkout: no tsx and no build/);
  });

  it("hands the whole command to its dist/budget build", async () => {
    const repo = checkoutWithoutDevPackages();
    // A stand-in for the built dispatcher: reports what it was given and exits with its own code.
    mkdirSync(join(repo, "dist", "budget"), { recursive: true });
    writeFileSync(
      join(repo, "dist", "budget", "cli.mjs"),
      "console.log(JSON.stringify({ argv: process.argv.slice(2), from: process.env.SUPERSTABLES_BUDGET_FROM_CHECKOUT })); process.exit(7);\n",
    );
    const r = await run([join(repo, "budget", "cli.mjs"), "doctor", "--rail", "evm"]);
    expect(r.code).toBe(7);
    // node resolves the script path through symbolic links (on macOS the temporary folder is one)
    expect(JSON.parse(r.stdout)).toEqual({ argv: ["doctor", "--rail", "evm"], from: realpathSync(repo) });
  });
});

describe("superstables budget from the client's CLI", () => {
  it("runs this checkout's budget, and says so", async () => {
    const r = await run([TSX, CLI, "budget", "--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^superstables budget \S+ \(checkout: runs the TypeScript sources with tsx/);
  });

  it("passes the exit code and the RESULT line through", async () => {
    const r = await run([TSX, CLI, "budget", "grant", "--rail", "evm"]);
    expect(r.code).toBe(2);
    expect(result(r.stdout)).toMatchObject({ command: "grant", state: "failed" });
  });
});
