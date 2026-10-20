// The owner gives up an approval no later wait can settle (budget/approvals.mjs abandonApproval): it ends unknown, keeps its
// record, and frees the chain; a worker's own final, a worker that runs again, and a restart cannot be undone or doubled by it.
// Small scripts stand in for the worker. No network.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";

let home: string;
let approvals: typeof import("../../budget/approvals.mjs");
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-approval-abandon-"));
  process.env.SUPERSTABLES_HOME = home;
  approvals = await import("../../budget/approvals.mjs");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret", resumable: true, intent: "a".repeat(64), expiresAt: Date.now() + 600_000, deadline: Date.now() + 600_000 };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A process standing in for a worker: its group's leader, with the start identity a record names it by. */
function liveWorker() {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid!, ...createIdentitySource().fields(child.pid!) };
}
async function goneWorker() {
  const w = liveWorker();
  process.kill(-w.pid, "SIGKILL");
  for (let i = 0; i < 100 && alive(w.pid); i++) await new Promise((x) => setTimeout(x, 20));
  return w;
}
const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };
const lockFile = () => join(home, "budget", "approvals", "active-evm-base-sepolia");
const clearChain = () => { try { rmSync(lockFile()); } catch { /* none */ } };
beforeEach(clearChain);

let n = 0;
async function open(over: Record<string, unknown> = {}, worker?: Record<string, unknown>) {
  const id = `oa-2026102008${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  approvals.saveApproval({
    id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(),
    ...(worker ?? (await goneWorker())), url: "http://127.0.0.1:9/approve/budget/ba_test0001#x", workerArgs: ["x"], timeoutS: 600, deadline: Date.now() + 600_000, hosted: HOSTED, resumes: 2, seen: { hashes: ["0xabc"] }, ...over,
  });
  writeFileSync(lockFile(), JSON.stringify({ id, ...(worker ?? (await goneWorker())), createdAt: Date.now() - 600_000 }));
  return id;
}
const build = (before: any) => ({ code: 5, record: { abandoned: { at: "2026-10-20T20:00:00Z", requestId: before.hosted?.requestId } }, result: { ok: false, state: "unknown", final: true, id: before.id, abandonedAt: "2026-10-20T20:00:00Z" } });

describe("abandonApproval", () => {
  it("ends an open approval unknown: its evidence stays, the token goes, the chain is free, and nothing restarts it", async () => {
    const id = await open();
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(id);
    const out = await approvals.abandonApproval(id, build);
    expect(out.kind).toBe("abandoned");
    const record = approvals.readApproval(id);
    expect(record).toMatchObject({ final: { code: 5, result: { state: "unknown", final: true, abandonedAt: "2026-10-20T20:00:00Z" } }, abandoned: { requestId: "ba_test0001" }, resumes: 2, seen: { hashes: ["0xabc"] }, hosted: { requestId: "ba_test0001", site: HOSTED.site } });
    expect(readFileSync(join(home, "budget", "approvals", `${id}.json`), "utf8")).not.toContain("ssbt_");
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
    expect(approvals.canResume(record)).toBe(false);
    // a later wait finds nothing to start, and takes no chain
    expect(approvals.restartWorker(id, { cmd: process.execPath, script: "-e", cwd: home })).toMatchObject({ started: false });
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
    expect(approvals.readApproval(id)?.resumes).toBe(2);
  });

  it("stops a worker that is running, then ends the approval", async () => {
    const worker = liveWorker();
    const id = await open({}, worker);
    expect(alive(worker.pid)).toBe(true);
    const out = await approvals.abandonApproval(id, build);
    expect(out.kind).toBe("abandoned");
    expect(alive(worker.pid)).toBe(false);
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 5 });
  });

  it("a result the worker stored first stands: nothing is replaced and the record is not marked abandoned", async () => {
    const id = await open();
    const out = await approvals.abandonApproval(id, build, {
      stop: async () => { approvals.recordFinal(id, 0, { ok: true, state: "ok", final: true }); },
    });
    expect(out.kind).toBe("ended");
    const record = approvals.readApproval(id);
    expect(record?.final).toMatchObject({ code: 0, result: { state: "ok" } });
    expect(record?.abandoned).toBeUndefined();
  });

  it("a worker started again after the stop (a restart that raced) is never marked ended while it runs: nothing is stored", async () => {
    const id = await open();
    const revived: ReturnType<typeof liveWorker>[] = [];
    const out = await approvals.abandonApproval(id, build, {
      attempts: 2,
      stop: async () => {
        // a wait restarted the worker between the stop and the write: the record names a process that runs
        const w = liveWorker();
        revived.push(w);
        approvals.updateApproval(id, () => ({ ...w }));
      },
    });
    expect(out.kind).toBe("running");
    expect(approvals.readApproval(id)?.final).toBeUndefined();
    expect(approvals.readApproval(id)?.hosted?.token).toBeDefined();
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(id);
    for (const w of revived) killGroup(w.pid);
  });

  it("a worker launched a moment ago and not yet in the record is not ended: its process may be running unseen", async () => {
    const id = await open({ pid: null, pidStart: undefined, pidStartUtc: undefined, state: "starting", createdAt: new Date().toISOString() });
    const out = await approvals.abandonApproval(id, build, { attempts: 2 });
    expect(out.kind).toBe("starting");
    expect(approvals.readApproval(id)?.final).toBeUndefined();
    expect(approvals.readApproval(id)?.hosted?.token).toBeDefined();
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(id);
    // the same record a minute past the startup grace: no worker ever came, so it can end
    approvals.updateApproval(id, () => ({ createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }));
    expect((await approvals.abandonApproval(id, build)).kind).toBe("abandoned");
  });

  it("a worker that publishes its process after the give-up cannot undo it", async () => {
    const id = await open({ pid: null, pidStart: undefined, pidStartUtc: undefined, state: "starting", createdAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect((await approvals.abandonApproval(id, build)).kind).toBe("abandoned");
    // startDetached publishes the pid of the worker it launched: a final record takes no such change
    approvals.updateApproval(id, () => ({ pid: 4242 }));
    expect(approvals.readApproval(id)?.pid ?? null).toBeNull();
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 5 });
  });

  it("an approval that has ended is not changed", async () => {
    const id = await open();
    approvals.recordFinal(id, 3, { ok: false, state: "refused_precheck" });
    const out = await approvals.abandonApproval(id, build);
    expect(out.kind).toBe("ended");
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 3 });
  });

  it("a give-up and a worker's final written at the same time leave one final, whichever came first", async () => {
    for (let i = 0; i < 25; i++) {
      clearChain();
      const id = await open();
      const [out] = await Promise.all([
        approvals.abandonApproval(id, build),
        Promise.resolve().then(() => approvals.recordFinal(id, 0, { ok: true, state: "ok", final: true })),
      ]);
      const record = approvals.readApproval(id)!;
      expect(record.final).toBeTruthy();
      if (out.kind === "abandoned") { expect(record.final.code).toBe(5); expect(record.abandoned).toBeTruthy(); }
      else { expect(out.kind).toBe("ended"); expect(record.final.code).toBe(0); expect(record.abandoned).toBeUndefined(); }
      expect(JSON.stringify(record)).not.toContain("ssbt_");
    }
  });
});
