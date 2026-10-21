// `wait` on an approval whose record file is there but is not a valid record (broken JSON, `null`, an empty file, `{}`, an array, a bare
// value, only an id, or a field of the wrong shape) answers unknown (exit 5, final false) and tells the caller to check the approval on
// superstables.com and the wallet before running an owner command again. Never failed ("no approval with that id"), never a hang
// past --timeout, never a crash. Nothing is written. No network.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ID = "oa-20261021010000-0000abcd";
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-wait-damaged-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Run = { code: number; stderr: string; result: any };
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    const child = spawn(process.execPath, [resolve(ROOT, "budget/cli.mjs"), ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.stdin.end();
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

const valid = { id: ID, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(), pid: 2_000_000_000, url: "http://127.0.0.1:41111/approve/x", workerArgs: ["x"], timeoutS: 600, deadline: Date.now() + 600_000 };
function put(content: string) {
  const dir = join(home, "budget", "approvals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "budget"), 0o700);
  chmodSync(dir, 0o700);
  const path = join(dir, `${ID}.json`);
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}
const json = (over: Record<string, unknown>) => JSON.stringify({ ...valid, ...over });

describe("wait on a record file that is there but is not a valid record", () => {
  for (const [what, content] of [
    ["broken JSON", "{ broken"], ["a truncated record", JSON.stringify(valid).slice(0, 40)], ["an empty file", ""], ["null", "null"], ["{}", "{}"], ["[]", "[]"],
    ["false", "false"], ["true", "true"], ["0", "0"], ["42", "42"], ['""', '""'], ['"x"', '"x"'], ["a record inside an array", JSON.stringify([valid])],
    ["a record filed under another id", json({ id: "oa-20261021999999-ffffffff" })], ["only the id", JSON.stringify({ id: ID })], ["the id and a stray field", JSON.stringify({ id: ID, x: 1 })],
    ["final: true", json({ final: true })], ["final: {}", json({ final: {} })], ["final: a string", json({ final: "x" })], ["final without a result", json({ final: { code: 0 } })],
    ["final with a result that is null", json({ final: { code: 0, result: null } })], ["final with a code that is not a number", json({ final: { code: "x", result: {} } })],
    ["hosted: a string", json({ hosted: "x" })], ["hosted.site: an object", json({ hosted: { site: {} } })], ["pid: a string", json({ pid: "x" })], ["deadline: a string", json({ deadline: "x" })],
    ["final with a result that has no state", json({ final: { code: 0, result: {} } })], ["workerArgs: a string", json({ workerArgs: "x" })], ["seen: a string", json({ seen: "x" })],
    ["a buy-once record with no hosted request", json({ command: "buy-once" })], ["a buy-once record whose site is not text", json({ command: "buy-once", hosted: { site: 5 } })],
    ["command: buy-once and nothing else", JSON.stringify({ id: ID, command: "buy-once" })], ["no command", json({ command: undefined })],
  ] as const) {
    it(`${what}: unknown (exit 5, final false), the check named, no hang, no crash, file untouched`, async () => {
      const path = put(content);
      for (const args of [["wait", "--id", ID, "--shown", "--timeout", "2"], ["wait", "--id", ID, "--timeout", "2"], ["wait", "--id", ID, "--abandon", "--timeout", "2"]]) {
        const run = await budget(args);
        expect(run.stderr, args.join(" ")).not.toMatch(/TypeError|\bat .*\.mjs:\d+/);
        expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id: ID });
        expect(run.result.next).toMatch(/superstables\.com/);
        expect(run.result.next).toMatch(/wallet/);
        expect(run.result.next).toMatch(/before running any owner command again/);
        expect(readFileSync(path, "utf8")).toBe(content);
      }
    }, 60_000);
  }

  it("a dangling symlink in the record's place is a file that is there: unknown", async () => {
    const path = put("");
    rmSync(path);
    symlinkSync(join(home, "nowhere"), path);
    const run = await budget(["wait", "--id", ID, "--shown", "--timeout", "2"]);
    expect(run.code).toBe(5);
    expect(run.result).toMatchObject({ state: "unknown", final: false });
  }, 60_000);

  it("a file that is not a record is not 'no approval': failed is only for an id this home never had", async () => {
    const none = await budget(["wait", "--id", ID, "--shown", "--timeout", "2"]);
    expect(none.result).toMatchObject({ state: "failed" });
    expect(none.code).toBe(2);
    put("{}");
    expect((await budget(["wait", "--id", ID, "--shown", "--timeout", "2"])).result.state).toBe("unknown");
  }, 60_000);
});
