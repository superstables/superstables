// Which restart took a hosted request over (budget/approvals.mjs recordTakenOver, hasTakenOver, restartWorker): a worker that a
// newer restart replaced neither marks the request taken over nor relies on a mark, whatever `processesAlive` said when the
// restart was made. No network.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  it("a replaced worker marks nothing even where no mark stands yet", async () => {
    const id = await open({ resumes: 2 });
    approvals.recordTakenOver(id, 1);
    expect(takenOver(id)).toBeUndefined();
    expect(approvals.hasTakenOver(id, 1)).toBe(false);
    approvals.recordTakenOver(id, 2);
    expect(takenOver(id)).toBe(2);
  });

  it("a worker that does not know its restart (no generation) never counts as having taken the request over", async () => {
    const id = await open({ resumes: 3, resume: { takenOver: 3 } });
    expect(approvals.hasTakenOver(id, Number.NaN)).toBe(false);
    expect(approvals.hasTakenOver(id, Number(undefined))).toBe(false);
    approvals.recordTakenOver(id, Number.NaN);
    expect(takenOver(id)).toBe(3);
    // no number at all never counts either: there is no "the record's own restart" fallback for a worker
    expect(approvals.hasTakenOver(id)).toBe(false);
    // ... and marks nothing, where no mark stands yet (a fallback to the record's own count would mark restart 2 here)
    const fresh = await open({ resumes: 2 });
    approvals.recordTakenOver(fresh);
    approvals.recordTakenOver(fresh, undefined as unknown as number);
    expect(takenOver(fresh)).toBeUndefined();
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

describe("a restarted worker stores its result only while it is the newest restart that has the request", () => {
  it("a worker that was paused after its own check, and replaced meanwhile, stores nothing; the newest restart does", async () => {
    const id = await open({ resumes: 1, resume: { takenOver: 1 } });
    // restart 2 starts (liveness said the first worker was gone): restart 1 wakes up with its check long passed
    approvals.updateApproval(id, () => ({ resumes: 2 }));
    const late = approvals.recordFinalAsRestart(id, 1, 0, { ok: true, state: "ok", final: true });
    expect(late.stored).toBe(false);
    expect(approvals.readApproval(id)?.final).toBeUndefined();
    expect(approvals.readApproval(id)?.hosted?.token).toBeDefined();
    // restart 2 has not read the request yet: it stores nothing either
    expect(approvals.recordFinalAsRestart(id, 2, 0, { ok: true, state: "ok", final: true }).stored).toBe(false);
    approvals.recordTakenOver(id, 2);
    const mine = approvals.recordFinalAsRestart(id, 2, 0, { ok: true, state: "ok", final: true });
    expect(mine.stored).toBe(true);
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 0 });
    // and once there is a result, nobody replaces it
    expect(approvals.recordFinalAsRestart(id, 2, 5, { ok: false, state: "unknown" }).stored).toBe(false);
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 0 });
  });

  it("a worker with no restart number stores nothing", async () => {
    const id = await open({ resumes: 1, resume: { takenOver: 1 } });
    expect(approvals.recordFinalAsRestart(id, Number.NaN, 0, { ok: true }).stored).toBe(false);
    expect(approvals.recordFinalAsRestart(id, undefined as unknown as number, 0, { ok: true }).stored).toBe(false);
    expect(approvals.readApproval(id)?.final).toBeUndefined();
  });

  it("a replaced worker cannot overwrite the mark of the restart that has the request", async () => {
    const id = await open({ resumes: 2, resume: { takenOver: 2 } });
    approvals.recordTakenOver(id, 1);
    expect(takenOver(id)).toBe(2);
    expect(approvals.hasTakenOver(id, 2)).toBe(true);
  });
});

describe("where the check is made, and who is told which restart they are", () => {
  it("the check is made under the record's lock: a restart that commits while the final waits for the lock is seen", async () => {
    const id = await open({ resumes: 1, resume: { takenOver: 1 } });
    const lock = join(home, "budget", "approvals", `${id}.json.lock`);
    // another process holds the record's lock while it starts restart 2
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from "node:fs";
      const approvals = await import(${JSON.stringify(pathToFileURL(resolve(fileURLToPath(new URL("../../", import.meta.url)), "budget/approvals.mjs")).href)});
      approvals.recordTestHook.inLock = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      approvals.updateApproval(${JSON.stringify(id)}, () => ({ resumes: 2 }));
      console.log("committed");
    `], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    holder.stdout.on("data", (c) => (out += String(c)));
    const exited = new Promise((done) => holder.once("exit", done));
    for (let i = 0; i < 200 && !existsSync(lock); i++) await new Promise((x) => setTimeout(x, 25));
    expect(existsSync(lock), "the other process holds the record's lock").toBe(true);
    // restart 1 asks to store its result now: it must wait for the lock and then see restart 2, not decide on what it read before waiting
    const late = approvals.recordFinalAsRestart(id, 1, 0, { ok: true, state: "ok", final: true });
    await exited;
    expect(out).toContain("committed");
    expect(late.stored).toBe(false);
    expect(approvals.readApproval(id)).toMatchObject({ resumes: 2 });
    expect(approvals.readApproval(id)?.final).toBeUndefined();
  });

  it("a restarted worker's number is a positive whole number as written; anything else matches no restart", () => {
    const given = (value: string | undefined) => approvals.resumeGeneration(value === undefined ? {} : { SUPERSTABLES_BUDGET_RESUME_GENERATION: value });
    expect(given("1")).toBe(1);
    expect(given("12")).toBe(12);
    for (const bad of [undefined, "", "0", "01", "-1", "1.5", " 2", "2 ", "x", "1e3", "NaN"]) expect(Number.isNaN(given(bad)), JSON.stringify(bad)).toBe(true);
  });

  it("the dispatcher stores a restarted worker's result only through recordFinalAsRestart, and the rail's takeover mark carries the number", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const cli = readFileSync(resolve(root, "budget/cli.mjs"), "utf8");
    const emit = cli.slice(cli.indexOf("function emit(code, fields)"), cli.indexOf("function emit(code, fields)") + 6000);
    expect(emit).toMatch(/if \(APPROVAL_ID && RESUMING\) \{\s*if \(!recordFinalAsRestart\(APPROVAL_ID, RESUME_GENERATION, code, out\)\.stored\)/);
    expect(emit.match(/\brecordFinal\(APPROVAL_ID/g)?.length).toBe(1);
    expect(emit).toMatch(/\} else if \(APPROVAL_ID\) recordFinal\(APPROVAL_ID, code, out\)/);
    const page = readFileSync(resolve(root, "budget/owner-page.ts"), "utf8");
    expect(page).toMatch(/onTakeover: \(\) => recordTakenOver\(holder!, resumeGeneration\(\)\)/);
  });
});
