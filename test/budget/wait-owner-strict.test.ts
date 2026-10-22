// An owner approval's record read leniently turned a damaged file into an answer: `wait --shown` finalized `{ "id": ... }` as
// refused_precheck (final, exit 3) over the file, and a record changed to `final: true` crashed the command. Every read of the record
// that decides something is strict, the one under the finalization lock included: a record that is not one `wait` can answer from
// when the command goes to store or to decide its answer is unknown (exit 5, final false), and the file is left as found.
// The file is rewritten at an exact moment by test/helpers/remove-record-after-lock.mjs, which counts every read of a record file: wait
// --shown reads it four times before it takes the lock to finalize (the command, waitFor's first look, the poll, the poll again after a
// worker that is gone); wait --abandon reads it once before the give-up reads it again.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let home: string;
let gone: Record<string, unknown>;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-wait-owner-strict-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The identity of a worker that has ended: a record that names it has no process left. */
beforeAll(async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const fields = createIdentitySource().fields(child.pid!);
  const ended = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await ended;
  gone = { pid: child.pid, ...fields };
});

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[], terminal: string, extra: Record<string, string>): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    const hook = `--import ${resolve(ROOT, "test/helpers/remove-record-after-lock.mjs")}`;
    Object.assign(env, { NODE_OPTIONS: [process.env.NODE_OPTIONS, hook].filter(Boolean).join(" ") }, extra);
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
/** A background owner approval whose worker has ended and that has no result. */
function open(over: Record<string, unknown> = {}) {
  const id = `oa-2026102201${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  const dir = join(home, "budget", "approvals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "budget"), 0o700);
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}.json`);
  const record = { id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(), ...gone, timeoutS: 600, deadline: Date.now() + 600_000, ...over };
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  return { id, path, record };
}

const REPLACEMENTS: [string, (record: any) => unknown][] = [
  ["only the id", (r) => ({ id: r.id })],
  ["a stored final that is true", (r) => ({ ...r, final: true })],
  ["a stored final that is a string", (r) => ({ ...r, final: "yes" })],
  ["a stored final with a result that has no state", (r) => ({ ...r, final: { code: 0, result: {} } })],
  ["a record with no command", (r) => ({ ...r, command: undefined })],
  ["a stored final that is empty", (r) => ({ ...r, final: {} })],
  ["a stored final with a result and no code", (r) => ({ ...r, final: { result: { ok: true, command: "setup", state: "ok", final: true } } })],
  ["a record filed under another id", (r) => ({ ...r, id: "oa-20261021999999-ffffffff" })],
];

/** The same approval, but a hosted request that its worker (now gone) cannot finish again: asking the site to cancel it comes first. */
const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret" };
const HOSTED_REPLACEMENTS: [string, (record: any) => unknown][] = [
  ["only the id", (r) => ({ id: r.id })],
  ["a record with no hosted request", (r) => ({ ...r, hosted: undefined })],
  ["a record of another hosted request", (r) => ({ ...r, hosted: { ...r.hosted, requestId: "ba_other0002" } })],
  ["a stored final that is empty", (r) => ({ ...r, final: {} })],
  ["a stored final that is true", (r) => ({ ...r, final: true })],
  ["a record filed under another id", (r) => ({ ...r, id: "oa-20261021999999-ffffffff" })],
];

const sentinel = (run: Run) => {
  expect(run.stderr, "no crash").not.toMatch(/TypeError|\bat .*\.mjs:\d+/);
  expect(run.result, run.stderr).not.toBeNull();
  expect(run.result.state, "never an answer made of what was left").not.toMatch(/refused_precheck|failed/);
};

describe("an owner approval's record that is damaged after wait read it", () => {
  for (const [label, damaged] of REPLACEMENTS) {
    it(`wait --shown, record replaced by ${label} right after the poll's second look: unknown (exit 5, not final), the file as found`, async () => {
      const { id, path, record } = open();
      const written = JSON.stringify(damaged(record));
      const replacement = join(home, "rewrite.json");
      writeFileSync(replacement, written);
      const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", { REWRITE_RECORD_AFTER_READ: replacement, REWRITE_RECORD_AFTER_READ_N: "4" });
      sentinel(run);
      expect(run.code, run.stderr).toBe(5);
      expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
      expect(readFileSync(path, "utf8"), "the file is left as found").toBe(written);
      expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
    }, 60_000);

    for (const read of [1, 2]) {
      it(`wait --abandon, record replaced by ${label} right after the command's read ${read}: unknown (exit 5, not final), the file as found`, async () => {
        const { id, path, record } = open();
        const written = JSON.stringify(damaged(record));
        const replacement = join(home, "rewrite.json");
        writeFileSync(replacement, written);
        const run = await budget(["wait", "--id", id, "--abandon", "--timeout", "0"], `${id} abandon\n`, { REWRITE_RECORD_AFTER_READ: replacement, REWRITE_RECORD_AFTER_READ_N: String(read) });
        sentinel(run);
        expect(run.code, run.stderr).toBe(5);
        expect(run.result).toMatchObject({ state: "unknown", final: false, id });
        expect(run.result.abandonedAt, "nothing was given up").toBeUndefined();
        expect(readFileSync(path, "utf8"), "the file is left as found").toBe(written);
        expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
      }, 60_000);
    }
  }

  // a worker that is gone and cannot be restarted: wait asks the site to cancel the request (a network round trip), then ends the approval
  // under the record's lock. The record may turn into something else during that round trip; nothing is decided from what it was.
  for (const [label, damaged] of HOSTED_REPLACEMENTS) {
    it(`wait --shown on a gone worker with a hosted request, record replaced by ${label} right after the poll's second look: unknown (exit 5, not final), the file as found`, async () => {
      const { id, path, record } = open({ hosted: HOSTED });
      const written = JSON.stringify(damaged(record));
      const replacement = join(home, "rewrite.json");
      writeFileSync(replacement, written);
      const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", { REWRITE_RECORD_AFTER_READ: replacement, REWRITE_RECORD_AFTER_READ_N: "4" });
      sentinel(run);
      expect(run.code, run.stderr).toBe(5);
      expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
      expect(readFileSync(path, "utf8"), "the file is left as found").toBe(written);
      expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
    }, 60_000);
  }

  it("a gone worker with a hosted request that is left intact is ended unknown, as before: the request may still be open on the site", async () => {
    const { id, path } = open({ hosted: HOSTED });
    const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", {});
    expect(run.code, run.stderr).toBe(5);
    expect(run.result).toMatchObject({ state: "unknown", final: true, id });
    expect(JSON.parse(readFileSync(path, "utf8")).final.code).toBe(5);
  }, 60_000);

  it("wait --shown, record removed right after the poll's second look: unknown (exit 5, not final), nothing written", async () => {
    const { id, path } = open();
    const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", { REMOVE_RECORD_AFTER_READ: "4" });
    sentinel(run);
    expect(run.code, run.stderr).toBe(5);
    expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
  }, 60_000);

  it("wait --abandon, record removed right after the command's first read: unknown (exit 5, not final), nothing written", async () => {
    const { id, path } = open();
    const run = await budget(["wait", "--id", id, "--abandon", "--timeout", "0"], `${id} abandon\n`, { REMOVE_RECORD_AFTER_READ: "1" });
    sentinel(run);
    expect(run.code, run.stderr).toBe(5);
    expect(run.result).toMatchObject({ command: "setup", state: "unknown", final: false, id });
    expect(existsSync(path)).toBe(false);
  }, 60_000);

  // a gone worker whose hosted request a restarted worker can finish: wait reads the record (1), waitFor looks (2), polls (3) and polls again
  // after the worker is gone (4), then the restart reads it (5) and reads it again under the record's lock, where it would claim the chain,
  // start the worker and record it (6). A record that turned bad or into another request after read 4 or 5 starts nothing and writes nothing.
  for (const [label, change] of [
    ["a record with no command", (r: any) => ({ ...r, command: undefined })],
    ["the record of another hosted request", (r: any) => ({ ...r, hosted: { ...r.hosted, requestId: "ba_other0002" } })],
    ["only the id", (r: any) => ({ id: r.id })],
  ] as [string, (r: any) => unknown][]) {
    for (const read of [4, 5]) {
      it(`a restart of a gone worker, record replaced by ${label} right after read ${read}: unknown (exit 5, not final), no worker started, the file and the chain lock as found`, async () => {
        const { id, path, record } = open({ hosted: { ...HOSTED, resumable: true }, workerArgs: ["not-a-command"] });
        const chainPath = join(home, "budget", "approvals", "active-evm-base-sepolia");
        const chain = JSON.stringify({ id, ...gone, createdAt: Date.now() - 600_000 });
        writeFileSync(chainPath, chain, { mode: 0o600 });
        const written = JSON.stringify(change(record));
        const replacement = join(home, "rewrite.json");
        writeFileSync(replacement, written);
        const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", { REWRITE_RECORD_AFTER_READ: replacement, REWRITE_RECORD_AFTER_READ_N: String(read) });
        sentinel(run);
        expect(run.code, run.stderr).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
        expect(readFileSync(path, "utf8"), "the file is left as found").toBe(written);
        expect(readFileSync(chainPath, "utf8"), "the chain lock is left as found").toBe(chain);
        expect(existsSync(join(home, "budget", "approvals", `${id}.log`)), "no worker was started").toBe(false);
        expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock"))).toEqual([]);
      }, 60_000);
    }
  }

  it("wait --abandon under a long home path, record removed right after the first read: the reason still says the outcome is unknown", async () => {
    const base = home;
    home = join(base, "a-home-path-long-enough-that-a-reason-naming-it-runs-past-three-hundred-characters-x");
    mkdirSync(home, { mode: 0o700 });
    try {
      const { id } = open();
      const run = await budget(["wait", "--id", id, "--abandon", "--timeout", "0"], `${id} abandon\n`, { REMOVE_RECORD_AFTER_READ: "1" });
      sentinel(run);
      expect(run.code, run.stderr).toBe(5);
      expect(run.result).toMatchObject({ state: "unknown", final: false, id });
      expect(home.length).toBeGreaterThan(80);
      expect(run.result.reason).toMatch(/^whether the approval sent anything is unknown/);
      expect(run.result.reason).toMatch(/stored no give-up/);
      expect(run.result.reason).toMatch(/processes may have been stopped/);
    } finally {
      home = base;
    }
  }, 60_000);

  it("an intact record is still finalized by wait --shown and still given up by wait --abandon", async () => {
    const shown = open();
    const ended = await budget(["wait", "--id", shown.id, "--shown", "--timeout", "0"], "x\n", {});
    expect(ended.code, ended.stderr).toBe(3);
    expect(ended.result).toMatchObject({ state: "refused_precheck", final: true, id: shown.id });
    expect(JSON.parse(readFileSync(shown.path, "utf8")).final.code).toBe(3);
    const given = open();
    const gaveUp = await budget(["wait", "--id", given.id, "--abandon", "--timeout", "0"], `${given.id} abandon\n`, {});
    expect(gaveUp.code, gaveUp.stderr).toBe(5);
    expect(gaveUp.result).toMatchObject({ state: "unknown", final: true, id: given.id });
    expect(JSON.parse(readFileSync(given.path, "utf8")).abandoned).toBeTruthy();
  }, 60_000);
});
