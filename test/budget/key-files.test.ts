// `superstables budget` against key files that are not key files: a FIFO, which a plain read would wait on forever. No
// rail script signs anything here and no RPC is reached; each command must answer at once.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = "0x2222222222222222222222222222222222222222";
const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const SOL_OWNER = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_AGENT = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ss-budget-keyfiles-"));
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  mkdirSync(join(home, "budget", "public"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any }> {
  return new Promise((done, fail) => {
    // nothing listens on port 9: a command that got as far as the chain fails fast instead of reaching the network
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: "http://127.0.0.1:9", SUPERSTABLES_TEMPO_RPC: "http://127.0.0.1:9", SUPERSTABLES_SOLANA_RPC: "http://127.0.0.1:9" };
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

const RAILS = {
  evm: { agent: "evm-agent.env", pub: ["evm-base-sepolia.env", `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`] },
  tempo: { agent: "tempo-agent.env", pub: ["tempo-moderato.env", `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${AGENT}\n`] },
  solana: { agent: "solana-agent.env", pub: ["solana-devnet.env", `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`] },
} as const;

/** The agent key file is a FIFO (mode 600); the public file is a normal one. */
const fifoAgent = (rail: keyof typeof RAILS) => {
  const r = RAILS[rail];
  execFileSync("mkfifo", ["-m", "600", join(home, "keys", "budget", r.agent)]);
  writeFileSync(join(home, "budget", "public", r.pub[0]), r.pub[1], { mode: 0o644 });
};

describe("an agent key file that is a FIFO", () => {
  for (const rail of ["evm", "tempo", "solana"] as const) {
    it(`${rail}: status and buy refuse at once (exit 3), nothing signed`, async () => {
      fifoAgent(rail);
      const status = await budget(["status", "--rail", rail]);
      expect(status.code, status.stderr).toBe(3);
      expect(status.result).toMatchObject({ state: "refused_precheck" });
      expect(status.result.reason).toMatch(new RegExp(`${RAILS[rail].agent.replace(".", "\\.")} is not a regular file`));
      const buy = await budget(["buy", "--rail", rail, "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--op", "fifo"]);
      expect(buy.code, buy.stderr).toBe(3);
      expect(buy.result).toMatchObject({ state: "refused_precheck", paid: false });
      expect(buy.result.reason).toMatch(/is not a regular file/);
    }, 30_000);
  }

  it("doctor reports it as a failed check instead of waiting on it", async () => {
    fifoAgent("tempo");
    const r = await budget(["doctor", "--rail", "tempo"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/FAIL\s+agent key file .*tempo-agent\.env: the agent key file .* is not a regular file/);
  }, 30_000);
});

describe("an --owner-key-file that is a FIFO", () => {
  for (const rail of ["evm", "tempo", "solana"] as const) {
    it(`${rail}: bad input (exit 2), before the rail runs`, async () => {
      const fifo = join(home, "owner.fifo");
      execFileSync("mkfifo", ["-m", "600", fifo]);
      const r = await budget(["revoke", "--rail", rail, "--owner-key-file", fifo, "--yes"]);
      expect(r.code, r.stderr).toBe(2);
      expect(r.result.reason).toMatch(/--owner-key-file .*owner\.fifo is not a regular file/);
    }, 30_000);
  }
});
