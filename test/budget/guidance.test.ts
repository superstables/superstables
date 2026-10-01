// superstables budget used from its own output: a buy with no setup is a refusal that says what is missing and who runs
// what next, status says there is no budget first, every help says what the command does, and scripts get one RESULT
// and a final flag. Nothing here reaches a chain: the sellers are local, and a buy with no setup ends before its rail.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "budget", "cli.mjs");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-budget-guidance-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  result: Record<string, any>;
}

/** The budget CLI with a fresh home. stdout is a pipe, as it is for an agent's tool. */
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, SUPERSTABLES_HOME: home, DISPLAY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => {
      const last = stdout.trimEnd().split("\n").pop() ?? "";
      done({ code: code ?? 1, stdout, stderr, result: last.startsWith("RESULT {") ? JSON.parse(last.slice(7)) : {} });
    });
  });
}

const owners = { evm: "setup --rail evm", tempo: "setup --rail tempo", solana: "setup --rail solana" } as const;

describe("a buy with no budget set up here", () => {
  for (const rail of ["evm", "tempo", "solana"] as const) {
    it(`is refused on ${rail} before anything is signed, and names the owner's commands`, async () => {
      const r = await budget(["buy", "--rail", rail, "--url", "http://127.0.0.1:9/paid", "--max", "0.02"]);
      expect(r.code).toBe(3);
      expect(r.result).toMatchObject({ ok: false, command: "buy", rail, state: "refused_precheck", final: true, paid: false, delivered: false, amount: "0", tx: {} });
      expect(r.result.reason).toMatch(/^no budget has been set up here for /);
      expect(r.result.reason).toContain("Nothing was signed or paid");
      expect(r.result.next).toContain(`superstables budget ${owners[rail]}`);
      expect(r.result.next).toContain(`superstables budget grant --rail ${rail}`);
      expect(r.result.next).not.toMatch(/reconcile/);
      // no op id was made up, and nothing that looks like a purchase was written: no journal, no lock
      expect(r.result.op).toBeUndefined();
      expect(existsSync(join(home, "budget", "ops"))).toBe(false);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
    });
  }

  it("says what is still missing when setup stopped halfway (an agent key, no owner yet)", async () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\n`, { mode: 0o600 });
    const r = await budget(["buy", "--rail", "evm", "--chain", "arc-testnet", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--op", "half-1"]);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", op: "half-1", paid: false, amount: "0" });
    expect(r.result.reason).toContain("no owner has connected a wallet");
    expect(r.result.reason).not.toContain("no agent key");
    expect(r.result.next).toContain("superstables budget setup --rail evm --chain arc-testnet");
  });

  it("is a refusal, not an unknown, when the rail stops before it records a purchase", async () => {
    // setup files that pass the dispatcher's check, with an agent key the rail cannot load: it exits before any journal
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), "B4_AGENT_KEY=not-a-key\n", { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=0x${"22".repeat(20)}\nB4_AGENT_ADDRESS=0x${"33".repeat(20)}\n`);
    const r = await budget(["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--op", "broken-key"]);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", op: "broken-key", paid: false, amount: "0" });
    expect(r.result.reason).toMatch(/stopped before it recorded a purchase: .*private key/);
    expect(existsSync(join(home, "budget", "ops", "evm-base-sepolia", "broken-key.json"))).toBe(false);
    expect(readdirSync(join(home, "budget", "ops", "evm-base-sepolia"))).toEqual([]); // the lock is gone too
  }, 60_000);
});

describe("status with no budget set up here", () => {
  it("says so first, with the owner's next commands", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n")[0]).toContain("no budget has been set up here for evm on base-sepolia");
    expect(r.result.reason).toBe("no budget has been set up here for evm on base-sepolia: no agent key on this computer; no owner has connected a wallet");
    expect(r.result.next).toContain("superstables budget setup --rail evm, superstables budget fund-agent --rail evm, superstables budget doctor --rail evm, superstables budget grant --rail evm --amount A");
    expect(`${r.stderr}${r.stdout}`).not.toMatch(/B4/);
  });

  it("names the home it checked, and says to ask the user for the path when the budget is elsewhere", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.result.home).toBe(home);
    expect(r.stderr).toContain(`Checked the home ${home} (SUPERSTABLES_HOME), chain base-sepolia.`);
    expect(r.stderr).toContain("If the budget is elsewhere, ask the user for the path");
    expect(r.result.next).toContain(`no budget yet in ${home}`);
    expect(r.result.next).toContain("do not change SUPERSTABLES_HOME or look in another home yourself, ~/.superstables included");
  });
});

describe("--json", () => {
  const json = (r: Run) => {
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("{")).toBe(true);
    return JSON.parse(lines[0]);
  };

  it("is accepted by every command, and stdout is the RESULT object alone", async () => {
    const r = await budget(["status", "--rail", "evm", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r)).toMatchObject({ ok: false, command: "status", state: "failed", final: true, home });
    expect(r.stderr).toContain("no budget has been set up here for evm on base-sepolia");
  });

  it("keeps the exit code and the fields of a refusal", async () => {
    const r = await budget(["buy", "--rail", "solana", "--url", "http://127.0.0.1:9/paid", "--max", "0.02", "--json"]);
    expect(r.code).toBe(3);
    expect(json(r)).toMatchObject({ command: "buy", rail: "solana", state: "refused_precheck", paid: false, amount: "0" });
  });

  it("prints bad input as the same object", async () => {
    const r = await budget(["grant", "--rail", "evm", "--amount", "1", "--yes", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r)).toMatchObject({ ok: false, command: "grant", state: "failed" });
    const w = await budget(["wait", "--id", "oa-20260930120000-1a2b3c4d", "--json"]);
    expect(w.code).toBe(2);
    expect(json(w)).toMatchObject({ ok: false, command: "wait", state: "failed" });
  });

  it("changes nothing without it: stdout still ends with the RESULT line", async () => {
    const r = await budget(["status", "--rail", "evm"]);
    expect(r.stdout.trim().split("\n").pop()).toMatch(/^RESULT \{/);
  });

  it("is in every command's help", async () => {
    for (const cmd of ["status", "buy", "grant", "wait"]) {
      const r = await budget([cmd, "--help"]);
      expect(r.stdout).toContain("--json: stdout is that RESULT object alone, as JSON");
    }
    expect((await budget(["grant", "--help"])).stdout).toContain("the APPROVE line goes to stderr");
    expect((await budget(["--help"])).stdout).toContain("--json (every command): stdout is only that object");
  });
});

describe("help", () => {
  const commands = ["setup", "fund-agent", "doctor", "preflight", "grant", "status", "buy", "reconcile", "recover", "wait", "revoke"];

  for (const cmd of commands) {
    it(`${cmd} --help says what it does, whether it moves money, who runs it, an example, what it prints and the exit codes`, async () => {
      const r = await budget([cmd, "--help"]);
      expect(r.code).toBe(0);
      for (const part of ["Moves money: ", "Run by: ", "Example:\n  $ superstables budget " + cmd, "Prints: ", "Exit codes: "]) expect(r.stdout).toContain(part);
      if (r.stdout.split("\n")[0].includes("--chain")) expect(r.stdout).toContain("--chain C: evm base-sepolia (default), arc-testnet");
    });
  }

  it("budget --help starts the owner and the agent, maps chains to rails, and lists exit codes and paths", async () => {
    const r = await budget(["--help"]);
    expect(r.code).toBe(0);
    for (const part of [
      "Start here, the owner",
      "Start here, the agent",
      "base-sepolia (Base Sepolia, default)",
      "Base Sepolia, Arc Testnet, Arbitrum Sepolia, Polygon Amoy, SKALE Base Sepolia and Ethereum Sepolia are evm",
      "Tempo Moderato is tempo; Solana devnet is solana",
      "evm     setup, fund-agent, doctor, grant.",
      "ssh -L PORT:127.0.0.1:PORT",
      "4  paid, not delivered",
      "keys/budget/<rail>-agent.env",
    ]) expect(r.stdout).toContain(part);
  });

  it("buy --help says what --max is and what a buy needs first", async () => {
    const r = await budget(["buy", "--help"]);
    expect(r.stdout).toContain("--max 0.02 means 0.02 USDC");
    expect(r.stdout).toContain("the owner has run setup and grant (on evm and solana also fund-agent)");
    expect(r.stdout).toContain("superstables budget status --rail R");
  });

  it("wait --help documents final", async () => {
    const r = await budget(["wait", "--help"]);
    expect(r.stdout).toContain("final false");
    expect(r.stdout).toContain("Scripts test final, not the exit code");
  });

  it("names the build on --version only: doctor does not print it", async () => {
    const r = await budget(["doctor", "--rail", "evm"]);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/superstables budget \S+ \((checkout|standalone)/);
  }, 60_000);
});

describe("one RESULT line", () => {
  it("preflight prints the rail's result once, as its own", async () => {
    // a seller that is not there: the rail prints a RESULT of its own, which the dispatcher replaces
    const r = await budget(["preflight", "--rail", "evm", "--url", "http://127.0.0.1:9/paid"]);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ command: "preflight", state: "failed", final: true });
    expect(`${r.stdout}\n${r.stderr}`.split("\n").filter((l) => l.startsWith("RESULT "))).toHaveLength(1);
  }, 60_000);
});

describe("an owner approval an agent started", () => {
  it("prints its link once, reports final false while it waits, and ends refused once the link expires", async () => {
    const setup = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10"]);
    expect(setup.code).toBe(0);
    expect(setup.result).toMatchObject({ command: "setup", state: "waiting_owner", final: false });
    const { id, url } = setup.result;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/owner\//);
    const port = new URL(url).port;
    expect(setup.result.next).toContain(`ssh -L ${port}:127.0.0.1:${port}`);
    expect(setup.result.next).toContain(`superstables budget wait --id ${id} until final is true`);
    // the link once: one APPROVE line on stdout, none repeated on stderr
    expect(`${setup.stdout}\n${setup.stderr}`.split("\n").filter((l) => l.startsWith("APPROVE "))).toHaveLength(1);
    expect(setup.stdout.split("\n")[0]).toMatch(/^APPROVE \{/);

    const waiting = await budget(["wait", "--id", id, "--timeout", "1"]);
    expect(waiting.code).toBe(0);
    expect(waiting.result).toMatchObject({ state: "waiting_owner", final: false, id });

    // nobody approves: the link expires, nothing was sent, and the next step is to run it again
    const ended = await budget(["wait", "--id", id, "--timeout", "40"]);
    expect(ended.code).toBe(3);
    expect(ended.result).toMatchObject({ command: "setup", state: "refused_precheck", final: true, id });
    expect(ended.result.reason).toMatch(/expired/);
    expect(ended.result.next).toContain("run the same command again for a new link (setup reuses the agent key it created)");
  }, 90_000);

  it("with --json: stdout is the waiting_owner object alone, and the APPROVE line goes to stderr", async () => {
    const setup = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10", "--json"]);
    expect(setup.code).toBe(0);
    const lines = setup.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]);
    expect(out).toMatchObject({ command: "setup", state: "waiting_owner", final: false });
    expect(setup.stderr.split("\n").filter((l) => l.startsWith("APPROVE "))).toHaveLength(1);
    expect(JSON.parse(setup.stderr.split("\n").find((l) => l.startsWith("APPROVE "))!.slice(8)).url).toBe(out.url);

    const ended = await budget(["wait", "--id", out.id, "--timeout", "40", "--json"]);
    expect(ended.code).toBe(3);
    expect(JSON.parse(ended.stdout.trim())).toMatchObject({ command: "setup", state: "refused_precheck", final: true, id: out.id });
  }, 90_000);
});
