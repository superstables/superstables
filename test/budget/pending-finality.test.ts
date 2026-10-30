// An owner transaction that is in a block the chain has not made final is not done. `wait` says so (final false,
// chain_final false, a next that does not tell the agent there is nothing to do), and the next owner command is refused
// with a reason that says the approval waits for the chain, not for the owner.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HASH = `0x${"ab".repeat(32)}`;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-pending-finality-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Run = { code: number; stderr: string; result: any };
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    const child = spawn(process.execPath, ["--import", resolve(ROOT, "test/helpers/budget-owner-terminal.mjs"), resolve(ROOT, "budget/cli.mjs"), ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.stdin.end("");
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

function record(id: string, over: Record<string, unknown>) {
  const dir = join(home, "budget", "approvals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "budget"), 0o700);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, rail: "evm", chain: "base-sepolia", createdAt: new Date().toISOString(), ...over }), { mode: 0o600 });
}

describe("wait on an owner transaction that landed but is not final", () => {
  it("is not final, says chain_final false, and does not say there is nothing to do", async () => {
    const id = "oa-20261030000001-00000001";
    const result = {
      ok: true, command: "fund-agent", rail: "evm", chain: "base-sepolia", state: "landed", final: false, chain_final: false,
      tx: { fundAgent: HASH }, next: "landed, not final yet. Nothing to do: the transfer is final once its block is.",
    };
    record(id, { command: "fund-agent", state: "done", foreground: false, final: { code: 0, result } });
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "5"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ ok: true, command: "fund-agent", state: "landed", final: false, chain_final: false });
    expect(done.result.next).toMatch(/not final yet/);
    expect(done.result.next).toMatch(/start the next owner command only once it is final/);
    expect(done.result.next).not.toMatch(/nothing to do/i);
  }, 60_000);

  it("keeps final true for a settled result", async () => {
    const id = "oa-20261030000002-00000002";
    record(id, { command: "grant", state: "done", foreground: false, final: { code: 0, result: { ok: true, command: "grant", rail: "evm", chain: "base-sepolia", state: "settled", next: "none" } } });
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "5"]);
    expect(done.result).toMatchObject({ state: "settled", final: true });
  }, 60_000);
});

describe("an owner command while an approved transaction waits for the chain", () => {
  it("is refused with a reason that says the approval waits for the chain", async () => {
    mkdirSync(join(home, "budget"), { recursive: true, mode: 0o700 });
    process.env.SUPERSTABLES_HOME = home;
    const approvals = await import("../../budget/approvals.mjs");
    const id = "oa-20261030000003-00000003";
    expect(approvals.claim("evm", "base-sepolia", id).ok).toBe(true);
    approvals.startForeground({ id, command: "grant", rail: "evm", chain: "base-sepolia" });
    const page = "0123456789abcdef0123456789abcdef";
    const url = `http://127.0.0.1:1/owner/${page}`;
    const dir = join(home, "budget", "approvals");
    record(id, { ...JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")), url });
    writeFileSync(join(home, "budget", "owner-approvals.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), id: page, kind: "grant", status: "sent" })}\n`);
    const run = await budget(["grant", "--rail", "evm", "--chain", "base-sepolia", "--amount", "1", "--detach"]);
    expect(run.result, run.stderr).toMatchObject({ ok: false, state: "refused_precheck", id });
    expect(run.result.reason).toMatch(/approved and its transaction is on this chain; it holds the chain until the chain makes it final/);
    expect(run.result.next).toMatch(/already approved .* has nothing to do/);
    expect(run.result.next).not.toMatch(/message_for_owner/);
    approvals.release?.(id);
  }, 60_000);
});
