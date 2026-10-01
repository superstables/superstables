// superstables budget as a process, before it reaches a rail: which copy runs, and what it refuses up front.
//
// Nothing here reaches the network or starts a rail script: every case ends in the dispatcher (help, version, a
// refusal) or in a stand-in for the built copy.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

describe("a checkout without its dev packages", () => {
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
