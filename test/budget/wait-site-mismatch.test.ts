// `wait --site` names the site an approval was made on. Another site is a mistake in the command, and says nothing about what the
// approval did: for an approval that may have sent, the answer is unknown (exit 5) with the fix to the flag, never failed. One that
// cannot have sent keeps the bad-input answer. No network: the refusal happens before anything is read from a site.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MADE_ON = "http://127.0.0.1:41111";
const OTHER = "http://127.0.0.1:41112";
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-wait-site-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[], terminal = "x\n"): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    const child = spawn(process.execPath, ["--import", resolve(ROOT, "test/helpers/budget-owner-terminal.mjs"), resolve(ROOT, "budget/cli.mjs"), ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.stdin.end(terminal);
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

let n = 0;
/** An owner approval record under this home, as a worker left it, with `over` on top. */
function record(over: Record<string, unknown> = {}) {
  const id = `oa-2026102101${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  const dir = join(home, "budget", "approvals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "budget"), 0o700);
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({
    id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(),
    pid: 2_000_000_000, url: `${MADE_ON}/approve/budget/ba_test0001#x`, workerArgs: ["x"], timeoutS: 600, deadline: Date.now() + 600_000,
    hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret", resumable: true }, ...over,
  }, null, 2) + "\n", { mode: 0o600 });
  return { id, path };
}

const waitArgs = (id: string, site: string) => ["wait", "--id", id, "--shown", "--site", site];
const abandonArgs = (id: string, site: string) => ["wait", "--id", id, "--abandon", "--site", site];

describe("wait --site that is not the site the approval was made on", () => {
  for (const [what, over] of [
    ["a hosted request recorded with no result", {}],
    ["its wallet step started (sending) and a hosted request recorded", { sending: true }],
    ["its wallet step started (sending), though a result is stored", { sending: true, state: "final", final: { code: 0, result: { ok: true, state: "ok", final: true } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    // a hosted approval's wallet sends through the site: `sending` is never set, so a stored result is what says it may have sent
    ["a stored ok result with a transaction (a hosted setup, no sending)", { state: "final", final: { code: 0, result: { ok: true, state: "ok", final: true, tx: { fundAgent: "0xabc", grant: "0xdef" } } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["an approval the owner gave up (stored unknown, the wallet may have been asked)", { state: "final", abandoned: { at: "2026-10-21T00:00:00Z", walletMayHaveBeenAsked: true }, final: { code: 5, result: { ok: false, state: "unknown", final: true, abandonedAt: "2026-10-21T00:00:00Z" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["a stored failed result that names no proof", { state: "final", final: { code: 1, result: { ok: false, state: "failed", final: true, reason: "the worker stopped" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["a buy-once the owner gave up (stored unknown, paid null)", { command: "buy-once", state: "final", final: { code: 5, result: { ok: false, command: "buy-once", state: "unknown", paid: null, delivered: null, final: true, abandonedAt: "2026-10-21T00:00:00Z" } }, hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: undefined } }],
    ["a buy-once read as paid", { command: "buy-once", state: "final", final: { code: 0, result: { ok: true, command: "buy-once", state: "settled", paid: true, delivered: true, final: true } }, hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: undefined } }],
  ] as const) {
    it(`${what}: unknown (exit 5, final false) with the fix, for wait and for wait --abandon; nothing is changed`, async () => {
      const { id, path } = record(over);
      const before = readFileSync(path, "utf8");
      for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER)]) {
        const run = await budget(args);
        expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", rail: "evm", chain: "base-sepolia", state: "unknown", final: false, id });
        expect(run.result.reason).toMatch(/not the site this approval was made on/);
        expect(run.result.reason).toMatch(/whether the approval sent anything is unknown/);
        expect(run.result.next).toContain(`--site ${MADE_ON}`);
        expect(run.result.next).toMatch(/or leave --site out/);
        expect(run.result.state).not.toBe("failed");
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    }, 60_000);
  }

  it("an approval that cannot have sent (it has a result, and its wallet step never started) keeps the bad-input answer", async () => {
    const { id, path } = record({ state: "final", final: { code: 3, result: { ok: false, state: "refused_precheck", reason: "the link expired; nothing was sent" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } });
    const before = readFileSync(path, "utf8");
    for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER)]) {
      const run = await budget(args);
      expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(2);
      expect(run.result).toMatchObject({ command: "wait", state: "failed" });
      expect(run.result.reason).toMatch(/not the site this approval was made on/);
      expect(run.result.next).toMatch(/fix the command/);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 60_000);

  it("the site the approval was made on is accepted: no site refusal", async () => {
    const { id } = record({ state: "final", final: { code: 3, result: { ok: false, state: "refused_precheck", reason: "the link expired; nothing was sent" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } });
    const run = await budget(waitArgs(id, MADE_ON));
    expect(run.stderr + run.stdout).not.toMatch(/not the site this approval was made on/);
  }, 60_000);
});
