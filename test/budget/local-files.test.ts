// Small things about the budget's own files: operation ids carry 64 random bits on every rail, and `budget doctor` flags an
// old owner key file that other users on this machine can read.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newOpId as solanaOp } from "../../budget/solana/ops.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = "0x1563915e194D8CfBA1943570603F7606A3115508";
const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const KEY = `0x${"11".repeat(32)}`;
const OWNER_KEY = `0x${"22".repeat(32)}`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ss-budget-localfiles-"));
  mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${KEY}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o644 });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any }> {
  return new Promise((done, fail) => {
    // nothing listens on port 9: a command that got as far as the chain fails fast instead of reaching the network
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: "http://127.0.0.1:9" };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const l = stdout.split("\n").reverse().find((x) => x.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: l ? JSON.parse(l.slice(7)) : null });
    });
  });
}

describe("operation ids", () => {
  it("the dispatcher draws 64 random bits", async () => {
    // The dispatcher takes the op's lock before the rail reads the chain, so the lock file names the op at once. The command
    // is then stopped: the RPC on port 9 would only make it retry for a minute.
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: "http://127.0.0.1:9" };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, "buy", "--rail", "evm", "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--json"], { cwd: ROOT, env, stdio: "ignore", detached: true });
    const dir = join(home, "budget", "ops", "evm-base-sepolia");
    let op: string | undefined;
    try {
      for (let i = 0; i < 200 && op === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          op = readdirSync(dir).map((n) => /^(.*)\.buy\.lock$/.exec(n)?.[1]).find(Boolean);
        } catch {
          // not there yet
        }
      }
    } finally {
      // the whole group: the dispatcher and the rail script it started
      process.kill(-child.pid!, "SIGKILL");
    }
    expect(op).toMatch(/^rb-\d{14}-[0-9a-f]{16}$/);
  }, 30_000);

  // loaded by path: the budget's TypeScript is built on its own (see budget/CLI.md), not part of this project's type check
  const rails = {
    evm: async () => (await import(new URL("../../budget/evm/ops.ts", import.meta.url).href)).newOpId as () => string,
    solana: async () => solanaOp,
    tempo: async () => (await import(new URL("../../budget/tempo/lib/ops.ts", import.meta.url).href)).newOpId as () => string,
  };
  for (const [name, load] of Object.entries(rails)) {
    it(`${name}: 64 random bits, all different, and still a valid id`, async () => {
      const make = await load();
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const id = make();
        expect(id).toMatch(/-[0-9a-f]{16}$/);
        expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
        ids.add(id);
      }
      expect(ids.size).toBe(1000);
    });
  }
});

describe("budget doctor and a leftover owner key file", () => {
  const ownerFile = () => join(home, "keys", "budget", "evm-owner.env");

  it("fails the check when other users can read it", async () => {
    writeFileSync(ownerFile(), `B4_OWNER_KEY=${OWNER_KEY}\n`, { mode: 0o644 });
    chmodSync(ownerFile(), 0o644);
    const r = await budget(["doctor", "--rail", "evm"]);
    expect(r.stderr).toMatch(/FAIL\s+owner key file .*evm-owner\.env: mode is 644/);
    expect(r.stderr).toMatch(/an owner key file is on this machine/);
  }, 60_000);

  it("only prints the note when it is 0600", async () => {
    writeFileSync(ownerFile(), `B4_OWNER_KEY=${OWNER_KEY}\n`, { mode: 0o600 });
    const r = await budget(["doctor", "--rail", "evm"]);
    expect(r.stderr).not.toMatch(/FAIL\s+owner key file/);
    expect(r.stderr).toMatch(/an owner key file is on this machine/);
  }, 60_000);
});
