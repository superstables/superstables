// Which restart took a hosted request over (budget/approvals.mjs recordTakenOver, hasTakenOver, restartWorker): a worker that a
// newer restart replaced neither marks the request taken over nor relies on a mark, whatever `processesAlive` said when the
// restart was made. No network.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";

let home: string;
let approvals: typeof import("../../budget/approvals.mjs");
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-approval-generation-"));
  process.env.SUPERSTABLES_HOME = home;
  approvals = await import("../../budget/approvals.mjs");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret", resumable: true, intent: "a".repeat(64), expiresAt: Date.now() + 600_000, deadline: Date.now() + 600_000 };
async function goneWorker() {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const fields = createIdentitySource().fields(child.pid!);
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
  return { pid: child.pid!, ...fields };
}
let n = 0;
async function open(over: Record<string, unknown> = {}) {
  const id = `oa-2026102009${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  approvals.saveApproval({
    id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(),
    ...(await goneWorker()), url: "http://127.0.0.1:9/approve/budget/ba_test0001#x", workerArgs: [], timeoutS: 600, deadline: Date.now() + 600_000, hosted: HOSTED, ...over,
  });
  return id;
}
const takenOver = (id: string) => approvals.readApproval(id)?.resume?.takenOver;

describe("a takeover belongs to the restart that made it", () => {
  it("only the newest restart marks the request taken over, and only it counts as having done so", async () => {
    const id = await open({ resumes: 1 });
    // restart 1 reads the request and marks it
    expect(approvals.hasTakenOver(id, 1)).toBe(false);
    approvals.recordTakenOver(id, 1);
    expect(takenOver(id)).toBe(1);
    expect(approvals.hasTakenOver(id, 1)).toBe(true);
    // restart 2 starts (a restart that thought the first worker gone): the earlier mark is not its own
    approvals.updateApproval(id, () => ({ resumes: 2 }));
    expect(approvals.hasTakenOver(id, 2)).toBe(false);
    // the replaced worker neither marks nor relies on a mark
    approvals.recordTakenOver(id, 1);
    expect(takenOver(id)).toBe(1);
    expect(approvals.hasTakenOver(id, 1)).toBe(false);
    expect(approvals.hasTakenOver(id, 2)).toBe(false);
    // the newest restart reads the request and marks it
    approvals.recordTakenOver(id, 2);
    expect(takenOver(id)).toBe(2);
    expect(approvals.hasTakenOver(id, 2)).toBe(true);
    expect(approvals.hasTakenOver(id, 1)).toBe(false);
  });

  it("a worker that does not know its restart (no generation) never counts as having taken the request over", async () => {
    const id = await open({ resumes: 3, resume: { takenOver: 3 } });
    expect(approvals.hasTakenOver(id, Number.NaN)).toBe(false);
    expect(approvals.hasTakenOver(id, Number(undefined))).toBe(false);
    approvals.recordTakenOver(id, Number.NaN);
    expect(takenOver(id)).toBe(3);
    // without an argument the record's own restart is meant (the callers that are not a worker)
    expect(approvals.hasTakenOver(id)).toBe(true);
  });

  it("nothing is marked once the approval has a result", async () => {
    const id = await open({ resumes: 1 });
    approvals.recordFinal(id, 5, { ok: false, state: "unknown" });
    approvals.recordTakenOver(id, 1);
    expect(takenOver(id)).toBeUndefined();
  });

  it("a restart gives its worker its own number, one more each time", async () => {
    const script = join(home, "worker.js");
    const out = join(home, "generation.txt");
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(out)}, (process.env.SUPERSTABLES_BUDGET_RESUME_GENERATION ?? "none") + "\\n");`);
    const id = await open({ resumes: 0 });
    for (let want = 1; want <= 3; want++) {
      const started = approvals.restartWorker(id, { cmd: process.execPath, script, cwd: home });
      expect(started.started, `restart ${want}`).toBe(true);
      expect(started.record.resumes).toBe(want);
      for (let i = 0; i < 100 && (!existsSync(out) || readFileSync(out, "utf8").trim().split("\n").length < want); i++) await new Promise((x) => setTimeout(x, 50));
      for (let i = 0; i < 100 && approvals.processesAlive(approvals.readApproval(id)); i++) await new Promise((x) => setTimeout(x, 50));
    }
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(["1", "2", "3"]);
    expect(existsSync(out)).toBe(true);
  });
});
