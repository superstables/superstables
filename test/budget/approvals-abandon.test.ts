// The owner gives up an approval no later wait can settle (budget/approvals.mjs abandonApproval): it ends unknown, keeps its
// record, and frees the chain; a worker's own final, a worker that runs again, and a restart cannot be undone or doubled by it.
// Small scripts stand in for the worker. No network.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
const sleepers: number[] = [];
function liveWorker() {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  sleepers.push(child.pid!);
  return { pid: child.pid!, ...createIdentitySource().fields(child.pid!) };
}
// every stand-in worker a test started is stopped when the test ends: a process left running fails the test run
afterEach(() => { for (const pid of sleepers.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } } });
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

describe("spawnRail", () => {
  const sleeper = () => spawn("sleep", ["60"], { detached: true, stdio: "ignore" });

  it("names the rail script's group in the step that starts it: a give-up after that stops it", async () => {
    const id = await open({}, liveWorker());
    const { child, ended } = approvals.spawnRail(id, sleeper);
    expect(ended).toBe(false);
    expect(approvals.readApproval(id)?.railPgid).toBe(child.pid);
    expect(alive(child.pid)).toBe(true);
    const out = await approvals.abandonApproval(id, build);
    expect(out.kind).toBe("abandoned");
    for (let i = 0; i < 50 && alive(child.pid); i++) await new Promise((x) => setTimeout(x, 100));
    expect(alive(child.pid)).toBe(false);
    killGroup(approvals.readApproval(id)!.pid);
  });

  it("holds the record's lock while it starts the rail script: nothing can end or restart the approval in between", async () => {
    const id = await open({}, liveWorker());
    const saved = approvals.recordLockOptions.timeoutMs;
    approvals.recordLockOptions.timeoutMs = 300;
    let blocked: unknown;
    try {
      const { child } = approvals.spawnRail(id, () => {
        try { approvals.updateApproval(id, { probe: true }); } catch (err) { blocked = err; }
        return sleeper();
      });
      killGroup(child.pid);
    } finally { approvals.recordLockOptions.timeoutMs = saved; }
    expect(blocked).toBeTruthy();
    expect(approvals.readApproval(id)?.probe).toBeUndefined();
    killGroup(approvals.readApproval(id)!.pid);
  });

  it("a worker that dies between starting its rail script and recording it leaves a mark: for a minute the approval is not ended", async () => {
    const id = await open({}, liveWorker());
    // the write that would name the rail script fails (a disk fault), after the script was started
    let writes = 0;
    approvals.recordTestHook.inLock = () => { if (++writes === 2) throw new Error("ENOSPC: no space left on device"); };
    let started: ReturnType<typeof spawn> | undefined;
    try {
      expect(() => approvals.spawnRail(id, () => (started = sleeper()))).toThrow(/ENOSPC/);
    } finally { approvals.recordTestHook.inLock = null; }
    // the script that was started was stopped, not left to run unseen
    for (let i = 0; i < 50 && started?.pid && alive(started.pid); i++) await new Promise((x) => setTimeout(x, 50));
    expect(alive(started!.pid!)).toBe(false);
    // and the record still says a script was being started: a give-up refuses, storing nothing
    expect(approvals.readApproval(id)?.railSpawning).toBeGreaterThan(0);
    expect(approvals.readApproval(id)?.railPgid).toBeUndefined();
    const refused = await approvals.abandonApproval(id, build, { attempts: 1 });
    expect(refused.kind).toBe("starting");
    expect(approvals.readApproval(id)?.final).toBeUndefined();
    // a minute later nothing is in flight any more
    approvals.updateApproval(id, () => ({ railSpawning: Date.now() - 2 * 60_000 }));
    expect((await approvals.abandonApproval(id, build)).kind).toBe("abandoned");
    killGroup(approvals.readApproval(id)!.pid);
  });

  it("a rail script that was named clears the mark", async () => {
    const id = await open({}, liveWorker());
    const { child } = approvals.spawnRail(id, sleeper);
    const record = approvals.readApproval(id);
    expect(record?.railSpawning).toBeUndefined();
    expect(record?.railPgid).toBe(child.pid);
    killGroup(child.pid);
    killGroup(record!.pid);
  });

  it("starts nothing for an approval that has a result", async () => {
    const id = await open();
    approvals.recordFinal(id, 5, { ok: false, state: "unknown" });
    let called = false;
    const out = approvals.spawnRail(id, () => { called = true; return sleeper(); });
    expect(out).toEqual({ child: null, ended: true });
    expect(called).toBe(false);
  });

  it("starts the rail script for a record that is not there, as it always did", () => {
    const out = approvals.spawnRail("oa-20261020000000-00000000", sleeper);
    expect(out.ended).toBe(false);
    expect(out.child.pid).toBeGreaterThan(0);
    killGroup(out.child.pid);
  });
});

describe("waitFor when the record file goes", () => {
  it("answers gone (not final, and no throw) when the file is removed or stops being a record after it was first read", async () => {
    for (const how of ["removed", "null"] as const) {
      const id = await open({}, liveWorker());
      const path = join(home, "budget", "approvals", `${id}.json`);
      setTimeout(() => { if (how === "removed") rmSync(path, { force: true }); else writeFileSync(path, "null"); }, 400);
      const answer = await approvals.waitFor(id, 5000, { poll: 100 });
      expect(answer, how).toMatchObject({ final: false, gone: true });
      expect(answer?.record?.id).toBe(id);
      killGroup(answer!.record.pid);
    }
  });

  it("answers gone, never null, for a caller that already read the record when the file is missing or not a record at its first read", async () => {
    const id = await open({}, liveWorker());
    const path = join(home, "budget", "approvals", `${id}.json`);
    const kept = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    expect(await approvals.waitFor(id, 1000, { poll: 50, seen: true })).toMatchObject({ final: false, gone: true });
    expect(await approvals.waitFor(id, 1000, { poll: 50 }), "an approval this home never had").toBeNull();
    for (const content of ["null", "{}", JSON.stringify({ id }), JSON.stringify({ ...JSON.parse(kept), final: true })]) {
      writeFileSync(path, content);
      for (const seen of [true, false]) expect(await approvals.waitFor(id, 1000, { poll: 50, seen }), `${content} seen=${seen}`).toMatchObject({ final: false, gone: true });
    }
    writeFileSync(path, kept);
    killGroup(JSON.parse(kept).pid);
  });

  it("a record missing what every record has, or with a field of the wrong shape, is not a record", async () => {
    const id = await open({}, liveWorker());
    const path = join(home, "budget", "approvals", `${id}.json`);
    const kept = JSON.parse(readFileSync(path, "utf8"));
    expect(approvals.readApprovalFile(id).kind).toBe("record");
    for (const over of [{ id: undefined }, { command: undefined }, { rail: 5 }, { chain: "" }, { final: true }, { final: "x" }, { final: {} }, { final: { code: "0", result: {} } }, { final: { code: 0, result: null } }, { final: { code: 0, result: {} } }, { command: "buy-once", hosted: null }, { seen: "x" }, { workerArgs: "x" }, { timeoutS: "x" }, { hosted: "x" }, { hosted: { site: {} } }, { hosted: [] }, { pid: "1" }, { pid: 1.5 }, { deadline: "soon" }]) {
      writeFileSync(path, JSON.stringify({ ...kept, ...over }));
      expect(approvals.readApprovalFile(id).kind, JSON.stringify(over)).not.toBe("record");
    }
    for (const over of [{ final: null }, { hosted: null }, { pid: null }, { deadline: null }, { final: { code: 5, result: { state: "unknown" } } }]) {
      writeFileSync(path, JSON.stringify({ ...kept, ...over }));
      expect(approvals.readApprovalFile(id).kind, JSON.stringify(over)).toBe("record");
    }
    writeFileSync(path, JSON.stringify(kept));
    killGroup(kept.pid);
  });

  it("answers gone when a live record is rewritten mid-poll to a shape wait cannot answer from, and stores nothing", async () => {
    const shapes: [string, (id: string, base: any) => unknown][] = [
      ["an object holding only the id", (id) => ({ id })],
      ["a final that is true", (_id, base) => ({ ...base, final: true })],
      ["a final with no code", (_id, base) => ({ ...base, final: { result: { ok: false } } })],
    ];
    for (const [label, make] of shapes) {
      const id = await open({}, liveWorker());
      const path = join(home, "budget", "approvals", `${id}.json`);
      const base = JSON.parse(readFileSync(path, "utf8"));
      const damaged = JSON.stringify(make(id, base));
      setTimeout(() => writeFileSync(path, damaged), 400);
      const answer = await approvals.waitFor(id, 5000, { poll: 100 });
      expect(answer, label).toMatchObject({ final: false, gone: true });
      expect(readFileSync(path, "utf8"), `${label}: nothing stored`).toBe(damaged);
      killGroup(base.pid);
    }
  });

  it("a record wait cannot answer from is damaged, not undecodable: readApproval still returns it (lock recovery reads partial records)", async () => {
    const id = await open({}, liveWorker());
    const path = join(home, "budget", "approvals", `${id}.json`);
    const base = JSON.parse(readFileSync(path, "utf8"));
    for (const content of [{ id }, { ...base, command: undefined }, { ...base, final: true }, { ...base, final: "yes" }, { ...base, final: {} }, { ...base, final: { code: 0 } }, { ...base, final: { code: 0.5, result: {} } }, { ...base, final: { result: { ok: false } } }]) {
      writeFileSync(path, JSON.stringify(content));
      expect(approvals.readApprovalFile(id).kind, JSON.stringify(content)).toBe("damaged");
      expect(approvals.readApproval(id)?.id, "lock scans still see the approval").toBe(id);
    }
    // a whole record, with or without a stored { code, result }, stays a record
    for (const content of [base, { ...base, final: { code: 3, result: { ok: false, state: "refused_precheck" } } }]) {
      writeFileSync(path, JSON.stringify(content));
      expect(approvals.readApprovalFile(id).kind).toBe("record");
    }
    killGroup(base.pid);
  });

  it("readApprovalFile tells a missing file, a file that is not a record, and a record apart", async () => {
    const id = await open({}, liveWorker());
    const path = join(home, "budget", "approvals", `${id}.json`);
    expect(approvals.readApprovalFile(id).kind).toBe("record");
    for (const content of ["false", "0", '""', "null", "[]", "7", "42", '"x"', "{}", "{ broken", "", JSON.stringify({ id: "oa-20261021999999-ffffffff" })]) {
      writeFileSync(path, content);
      expect(approvals.readApprovalFile(id).kind, JSON.stringify(content)).toBe("undecodable");
      expect(approvals.readApproval(id)).toBeNull();
    }
    rmSync(path, { force: true });
    expect(approvals.readApprovalFile(id).kind).toBe("none");
    expect(approvals.readApprovalFile("not an id").kind).toBe("none");
  });
});

describe("the record lock's errors and a result that is already stored", () => {
  it("a record locked by a live process answers RECORD_BUSY at the deadline", async () => {
    const id = await open({}, liveWorker());
    const holder = liveWorker();
    writeFileSync(join(home, "budget", "approvals", `${id}.json.lock`), JSON.stringify({ ...holder, owner: "test" }));
    const saved = approvals.recordLockOptions.timeoutMs;
    approvals.recordLockOptions.timeoutMs = 300;
    try {
      await expect(approvals.abandonApproval(id, build)).rejects.toMatchObject({ code: "RECORD_BUSY" });
      expect(approvals.readApproval(id)?.final).toBeUndefined();
    } finally {
      approvals.recordLockOptions.timeoutMs = saved;
      rmSync(join(home, "budget", "approvals", `${id}.json.lock`), { force: true });
      killGroup(holder.pid);
      killGroup(approvals.readApproval(id)!.pid);
    }
  });

  it.skipIf(process.getuid?.() === 0)("a file system error is not reported as busy: its own code stays", async () => {
    const id = await open({}, liveWorker());
    const dir = join(home, "budget", "approvals");
    chmodSync(dir, 0o500);
    try {
      const err = await approvals.abandonApproval(id, build).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("EACCES");
      expect(err.code).not.toBe("RECORD_BUSY");
    } finally {
      chmodSync(dir, 0o700);
      killGroup(approvals.readApproval(id)!.pid);
    }
    expect(approvals.readApproval(id)?.final).toBeUndefined();
  });

  it("a refused second result frees no chain lock, not even one that names the same approval", async () => {
    const id = await open();
    approvals.recordFinal(id, 5, { ok: false, state: "unknown", final: true, tag: "first" });
    // the chain's lock names this approval again (a restart claimed it after the result, say)
    writeFileSync(lockFile(), JSON.stringify({ id, ...(await goneWorker()), createdAt: Date.now() }));
    approvals.recordFinal(id, 0, { ok: true, state: "ok", final: true, tag: "second" });
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 5, result: { tag: "first" } });
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).id).toBe(id);
  });

  it("recordFinal does not replace a result that is already stored, and frees nothing a second time", async () => {
    const id = await open();
    approvals.recordFinal(id, 5, { ok: false, state: "unknown", final: true, tag: "first" });
    // another approval takes the chain after the first ended
    writeFileSync(lockFile(), JSON.stringify({ id: "oa-20261020999999-aaaaaaaa", ...(await goneWorker()), createdAt: Date.now() }));
    const again = approvals.recordFinal(id, 0, { ok: true, state: "ok", final: true, tag: "second" });
    expect(again?.final).toMatchObject({ code: 5, result: { tag: "first" } });
    expect(approvals.readApproval(id)?.final).toMatchObject({ code: 5, result: { tag: "first" } });
    // the lock that another approval holds is not removed by the second call
    expect(JSON.parse(readFileSync(lockFile(), "utf8")).id).toBe("oa-20261020999999-aaaaaaaa");
  });
});
