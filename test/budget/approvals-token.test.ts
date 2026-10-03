// A hosted approval's record holds the agent's access token for its site request until the approval is final, and never
// after: every way an approval ends goes through recordFinal, which removes it. Workers here are small scripts that record
// a hosted request (with a token) and then end one way or another. No network.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processStart } from "../../budget/procs.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TOKEN = "ssbt_test_ba_test0001secret";
// a site on this computer that is not there: a cancel gets no answer
const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: TOKEN };
const APPROVE = { action: "grant", url: "http://127.0.0.1:9/approve/budget/ba_test0001#ssba_test_owner1", expires: new Date(Date.now() + 600_000).toISOString(), terms: { title: "Grant" }, matchCode: "ABC-DEF" };

let home: string;
let approvals: typeof import("../../budget/approvals.mjs");
const noToken = (id: string) => {
  const r = approvals.readApproval(id)!;
  expect(r.final).toBeDefined();
  expect(r.hosted?.requestId).toBe("ba_test0001");
  expect(JSON.stringify(r)).not.toContain("ssbt_");
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-approval-token-"));
  process.env.SUPERSTABLES_HOME = home;
  approvals = await import("../../budget/approvals.mjs");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Start a worker that records the hosted request, then runs `then` (JavaScript, with recordLink, recordFinal and id). */
async function worker(then: string, linkWaitMs?: number) {
  const file = join(home, `worker-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, `
    import { recordFinal, recordHosted, recordLink, WORKER_ENV } from ${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))};
    const id = process.env[WORKER_ENV];
    recordHosted(id, ${JSON.stringify(HOSTED)});
    ${then}
  `);
  const id = approvals.newApprovalId();
  expect(approvals.claim("evm", "base-sepolia", id).ok).toBe(true);
  const r = await approvals.startDetached({ id, command: "grant", rail: "evm", chain: "base-sepolia", cmd: process.execPath, args: [file], cwd: ROOT, timeoutS: 30, ...(linkWaitMs ? { linkWaitMs } : {}) });
  return { id, r };
}

describe("the access token leaves the record when the approval is final", () => {
  for (const [how, code, state] of [["approved", 0, "ok"], ["rejected", 3, "rejected"], ["expired", 3, "expired"], ["cancelled", 3, "refused_precheck"], ["failed with an error", 1, "failed"]] as const) {
    it(`${how}: the worker's own result`, async () => {
      const { id, r } = await worker(`
        recordLink(id, ${JSON.stringify(APPROVE)});
        setTimeout(() => recordFinal(id, ${code}, { ok: ${code === 0}, command: "grant", state: ${JSON.stringify(state)} }), 300);
      `);
      expect(r.kind).toBe("waiting");
      // the token is there while the approval waits for the owner
      expect(JSON.stringify(approvals.readApproval(id))).toContain(TOKEN);
      const w = await approvals.waitFor(id, 10_000);
      expect(w).toMatchObject({ final: true, code });
      noToken(id);
    }, 30_000);
  }

  it("the worker stops before any page (an error): recorded as failed, without the token", async () => {
    const { id, r } = await worker(`process.exit(1);`);
    expect(r.kind).toBe("failed");
    expect(r.record.final.result).toMatchObject({ state: "failed" });
    noToken(id);
  }, 30_000);

  it("no page within the link wait (a timeout): stopped, recorded as failed, without the token", async () => {
    const { id, r } = await worker(`setTimeout(() => {}, 60_000);`, 1_000);
    expect(r.kind).toBe("failed");
    expect(r.reason).toMatch(/no approval page within 1 s/);
    noToken(id);
  }, 30_000);

  it("the worker dies after the link with no result (wait gives it up): final, without the token", async () => {
    const { id, r } = await worker(`
      recordLink(id, ${JSON.stringify(APPROVE)});
      setTimeout(() => process.exit(0), 300);
    `);
    expect(r.kind).toBe("waiting");
    const w = await approvals.waitFor(id, 15_000);
    expect(w).toMatchObject({ final: true });
    noToken(id);
  }, 30_000);

  it("recordFinal from another process in the middle of recordHosted: the record ends final, without the token", async () => {
    const id = approvals.newApprovalId();
    approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(), pid: null });
    const finisher = join(home, "finisher.mjs");
    writeFileSync(finisher, `
      import { recordFinal } from ${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))};
      recordFinal(${JSON.stringify(id)}, 3, { ok: false, command: "grant", state: "rejected" });
    `);
    let child: ReturnType<typeof spawn> | undefined;
    // inside recordHosted's change, after it read the record (not final yet) and before it writes: another process
    // records the final result, and gets 1.5 s to do it
    approvals.recordTestHook.inLock = () => {
      approvals.recordTestHook.inLock = null;
      child = spawn(process.execPath, [finisher], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: "ignore" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500);
    };
    try {
      approvals.recordHosted(id, HOSTED);
    } finally {
      approvals.recordTestHook.inLock = null;
    }
    expect(child).toBeDefined();
    await new Promise((done) => child!.once("exit", done));
    noToken(id);
    expect(approvals.readApproval(id)!.final).toMatchObject({ code: 3 });
  }, 30_000);

  it("a hosted request recorded after the result is not kept", async () => {
    const { id } = await worker(`
      recordLink(id, ${JSON.stringify(APPROVE)});
      recordFinal(id, 0, { ok: true, command: "grant", state: "ok" });
      recordHosted(id, ${JSON.stringify(HOSTED)});
    `);
    await approvals.waitFor(id, 10_000);
    noToken(id);
  }, 30_000);
});

describe("the record's lock", () => {
  const fresh = () => {
    const id = approvals.newApprovalId();
    approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(), pid: null });
    return id;
  };
  /** Another process records a final result for `id`; resolves when it exits. */
  const finishElsewhere = (id: string) => {
    const file = join(home, `finish-${id}.mjs`);
    writeFileSync(file, `
      import { recordFinal } from ${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))};
      recordFinal(${JSON.stringify(id)}, 3, { ok: false, command: "grant", state: "rejected" });
    `);
    const child = spawn(process.execPath, [file], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: "ignore" });
    let exited = false;
    const done = new Promise<void>((r) => child.once("exit", () => { exited = true; r(); }));
    return { done, exited: () => exited };
  };
  const hold = (id: string, holder: { pid: number; pidStart: string | null }) => {
    writeFileSync(approvals.recordLockFile(id), JSON.stringify({ ...holder, owner: "test" }), { mode: 0o600 });
  };

  it("is kept by a live holder however long it is paused, never taken over by age", async () => {
    const id = fresh();
    // held by this (live) process, with a lock file an hour old
    hold(id, { pid: process.pid, pidStart: processStart(process.pid) ?? null });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(approvals.recordLockFile(id), old, old);
    const other = finishElsewhere(id);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(other.exited()).toBe(false);
    expect(approvals.readApproval(id)!.final).toBeUndefined();
    // released: the waiting process goes on
    unlinkSync(approvals.recordLockFile(id));
    await other.done;
    expect(approvals.readApproval(id)!.final).toMatchObject({ code: 3 });
  }, 30_000);

  it("is taken over from a holder that is gone", async () => {
    const id = fresh();
    const dead = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => dead.once("exit", r));
    hold(id, { pid: dead.pid!, pidStart: null });
    const other = finishElsewhere(id);
    await other.done;
    expect(approvals.readApproval(id)!.final).toMatchObject({ code: 3 });
  }, 30_000);

  it("a final record never becomes not final again", () => {
    const id = fresh();
    approvals.recordFinal(id, 0, { ok: true, command: "grant", state: "ok" });
    approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(), pid: null });
    approvals.recordLink(id, APPROVE);
    const r = approvals.readApproval(id)!;
    expect(r.final).toMatchObject({ code: 0 });
    expect(r.state).toBe("final");
    expect(r.url).toBeUndefined();
  });
});

describe("the record's lock: breaking a dead holder's lock, and its deadline", () => {
  const fresh = () => {
    const id = approvals.newApprovalId();
    approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(), pid: null });
    return id;
  };
  const until = async (ok: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /**
   * Another process records a final result for `id`, with the lock deadline `timeoutMs`. With `pause`, it stops inside
   * the break of a dead lock, holding the break mutex: it writes `<pause>.held` and waits for `<pause>.go`.
   */
  const finisher = (id: string, timeoutMs: number, pause?: string) => {
    const file = join(home, `finisher-${Math.random().toString(16).slice(2)}.mjs`);
    writeFileSync(file, `
      import { existsSync, writeFileSync } from "node:fs";
      import * as a from ${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))};
      a.recordLockOptions.timeoutMs = ${timeoutMs};
      ${pause ? `a.breakTestHook.holdingMutex = () => {
        a.breakTestHook.holdingMutex = null;
        writeFileSync(${JSON.stringify(pause + ".held")}, "");
        while (!existsSync(${JSON.stringify(pause + ".go")})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      };` : ""}
      try {
        a.recordFinal(${JSON.stringify(id)}, 3, { ok: false, command: "grant", state: "rejected" });
        console.log("done");
      } catch (e) {
        console.log("ERR " + e.message);
        process.exitCode = 2;
      }
    `);
    const child = spawn(process.execPath, [file], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    const done = new Promise<{ code: number | null; out: string }>((r) => child.once("exit", (code) => r({ code, out })));
    return { child, done };
  };
  const deadLock = async (id: string) => {
    const dead = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => dead.once("exit", r));
    const text = JSON.stringify({ pid: dead.pid, pidStart: null, owner: "dead" });
    writeFileSync(approvals.recordLockFile(id), text, { mode: 0o600 });
    return text;
  };
  const liveText = JSON.stringify({ pid: process.pid, pidStart: processStart(process.pid) ?? null, owner: "test" });

  it("a breaker paused (SIGSTOP) while it holds the break mutex is not robbed of it", async () => {
    const id = fresh();
    const dead = await deadLock(id);
    const pause = join(home, `pause-${id}`);
    const a = finisher(id, 30_000, pause);
    await until(() => existsSync(pause + ".held"));
    a.child.kill("SIGSTOP");
    try {
      const mutex = readFileSync(approvals.recordLockFile(id) + ".break", "utf8");
      expect(JSON.parse(mutex).pid).toBe(a.child.pid);
      // another process finds the same dead lock, but the mutex's holder is alive (paused): it waits, then gives up
      const b = await finisher(id, 1_500).done;
      expect(b.code).toBe(2);
      expect(b.out).toMatch(new RegExp(`ERR the lock .*\\.break is held by process ${a.child.pid}, which is still running`));
      expect(readFileSync(approvals.recordLockFile(id) + ".break", "utf8")).toBe(mutex);
      expect(readFileSync(approvals.recordLockFile(id), "utf8")).toBe(dead);
    } finally {
      a.child.kill("SIGCONT");
      writeFileSync(pause + ".go", "");
    }
    // resumed, it breaks the dead lock it judged, takes the lock and records the result
    expect((await a.done).out).toMatch(/done/);
    expect(approvals.readApproval(id)!.final).toMatchObject({ code: 3 });
    expect(existsSync(approvals.recordLockFile(id))).toBe(false);
  }, 60_000);

  it("a resumed breaker leaves a lock that was replaced meanwhile alone", async () => {
    const id = fresh();
    await deadLock(id);
    const pause = join(home, `pause-${id}`);
    const a = finisher(id, 30_000, pause);
    await until(() => existsSync(pause + ".held"));
    a.child.kill("SIGSTOP");
    // while it is paused, the dead lock is replaced by a live holder's (this process)
    writeFileSync(approvals.recordLockFile(id), liveText, { mode: 0o600 });
    a.child.kill("SIGCONT");
    writeFileSync(pause + ".go", "");
    await new Promise((r) => setTimeout(r, 800));
    expect(readFileSync(approvals.recordLockFile(id), "utf8")).toBe(liveText);
    expect(approvals.readApproval(id)!.final).toBeUndefined();
    // the live holder lets go: the waiting process goes on
    unlinkSync(approvals.recordLockFile(id));
    expect((await a.done).out).toMatch(/done/);
    expect(approvals.readApproval(id)!.final).toMatchObject({ code: 3 });
  }, 60_000);

  it("a waiter honours its deadline with a clear error, while this process's timers keep firing", async () => {
    const id = fresh();
    writeFileSync(approvals.recordLockFile(id), liveText, { mode: 0o600 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const started = Date.now();
    const r = await finisher(id, 1_000).done;
    clearInterval(timer);
    const took = Date.now() - started;
    expect(r.code).toBe(2);
    expect(r.out).toMatch(new RegExp(`ERR the lock .* is held by process ${process.pid}, which is still running`));
    expect(took).toBeGreaterThanOrEqual(1_000);
    expect(took).toBeLessThan(10_000);
    expect(ticks).toBeGreaterThan(5);
    expect(approvals.readApproval(id)!.final).toBeUndefined();
    unlinkSync(approvals.recordLockFile(id));
  }, 30_000);

  it("an unreadable lock is waited for, never taken, and named at the deadline", async () => {
    const id = fresh();
    writeFileSync(approvals.recordLockFile(id), "not a lock", { mode: 0o600 });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(approvals.recordLockFile(id), old, old);
    const r = await finisher(id, 800).done;
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/ERR the lock .* cannot be read; if no superstables budget command is running, remove it/);
    expect(readFileSync(approvals.recordLockFile(id), "utf8")).toBe("not a lock");
    unlinkSync(approvals.recordLockFile(id));
  }, 30_000);

  it("an unreadable chain lock, however old, is not taken over: claim names the file", () => {
    const id = approvals.newApprovalId();
    const path = join(home, "budget", "approvals", "active-evm-base-sepolia");
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(path, old, old);
    const r = approvals.claim("evm", "base-sepolia", id);
    expect(r.ok).toBe(false);
    expect((r as any).pending.command).toMatch(/an unreadable lock \(.*active-evm-base-sepolia\); if no superstables budget command is running, remove that file/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    unlinkSync(path);
  });
});
