// An approval whose worker the host ended (budget/approvals.mjs): a hosted owner request still open on the site keeps its chain,
// the next `wait` starts the worker again (once, however many ask at once), and a worker that was started again records a
// result only once it has the request in hand. Small scripts stand in for the worker. No network.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";

let home: string;
let approvals: typeof import("../../budget/approvals.mjs");
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-approval-resume-"));
  process.env.SUPERSTABLES_HOME = home;
  approvals = await import("../../budget/approvals.mjs");
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret" };
const RESUMABLE = { ...HOSTED, resumable: true, intent: "a".repeat(64), expiresAt: Date.now() + 600_000, deadline: Date.now() + 600_000 };
/**
 * A worker that was running and is gone, as the record of one the host ended names it: its pid with its start identity (a
 * record that names none is read as possibly alive, never as gone).
 */
async function goneWorker() {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const fields = createIdentitySource().fields(child.pid!);
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
  return { pid: child.pid!, ...fields };
}

const killGroup = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };

let n = 0;
/** An open approval on evm base-sepolia whose worker is gone, holding the chain's lock as a command that has exited left it. */
async function openApproval(over: Record<string, unknown> = {}, hosted: Record<string, unknown> | null = RESUMABLE) {
  const id = `oa-2026102006${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  const worker = await goneWorker();
  approvals.saveApproval({
    id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(),
    ...worker, url: "http://127.0.0.1:9/approve/budget/ba_test0001#x", workerArgs: [], timeoutS: 600, deadline: Date.now() + 600_000, ...(hosted ? { hosted } : {}), ...over,
  });
  return id;
}
const holdChain = async (id: string) => writeFileSync(join(home, "budget", "approvals", "active-evm-base-sepolia"), JSON.stringify({ id, ...(await goneWorker()), createdAt: Date.now() - 600_000 }));
const clearChain = () => { try { rmSync(join(home, "budget", "approvals", "active-evm-base-sepolia")); } catch {} };
beforeEach(clearChain);

describe("a hosted request the site may still hold keeps its chain", () => {
  it("held while its worker is gone and the approval is not final: a later command is not let through", async () => {
    const id = await openApproval();
    await holdChain(id);
    expect(approvals.findPending("evm", "base-sepolia")?.id).toBe(id);
    expect(approvals.claim("evm", "base-sepolia", "oa-20261020070000-ffffffff")).toMatchObject({ ok: false, pending: { id } });
  });

  it("free once the approval is final: the token is gone and the chain can be taken", async () => {
    const id = await openApproval();
    await holdChain(id);
    approvals.recordFinal(id, 3, { ok: false, state: "refused_precheck" });
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
    expect(approvals.claim("evm", "base-sepolia", "oa-20261020070001-fffffff1")).toEqual({ ok: true });
  });

  it("an approval with no hosted request, and a single purchase, keep the rule they had: stale once their processes are gone", async () => {
    const plain = await openApproval({}, null);
    await holdChain(plain);
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
    const once = await openApproval({ command: "buy-once" });
    await holdChain(once);
    expect(approvals.findPending("evm", "base-sepolia")).toBeNull();
  });
});

describe("canResume", () => {
  it("only an open hosted request of a worker that was recorded and said it can be finished", async () => {
    const id = await openApproval();
    expect(approvals.canResume(approvals.readApproval(id))).toBe(true);
    for (const [what, over, hosted] of [
      ["not resumable (tempo, solana)", {}, HOSTED],
      ["no recorded worker command", { workerArgs: undefined }, RESUMABLE],
      ["no hosted request", {}, null],
      ["a blocking command", { foreground: true }, RESUMABLE],
      ["final", { final: { code: 0, result: {} } }, RESUMABLE],
    ] as const) {
      expect(approvals.canResume(approvals.readApproval(await openApproval(over, hosted as any))), what).toBe(false);
    }
  });
});

describe("waitFor, with the worker gone", () => {
  it("answers that a later command can finish it, instead of cancelling the request", async () => {
    const id = await openApproval();
    expect(await approvals.waitFor(id, 0)).toMatchObject({ final: false, resume: true });
    expect(approvals.readApproval(id)?.final).toBeUndefined();
  });

  it("an approval that cannot be finished ends as it always did: the site is asked to cancel, else unknown", async () => {
    const id = await openApproval({}, HOSTED);
    const r = await approvals.waitFor(id, 0);
    expect(r).toMatchObject({ final: true });
    // the site is not there (a cancel gets no answer): the request may still be open, so unknown
    expect(r!.code).toBe(5);
    expect(JSON.stringify(approvals.readApproval(id))).not.toContain("ssbt_");
  });

  it("with resume off (the worker was just started again and is gone too) it ends the same way", async () => {
    const id = await openApproval();
    const r = await approvals.waitFor(id, 0, { resume: false });
    expect(r).toMatchObject({ final: true, code: 5 });
  });
});

describe("restartWorker", () => {
  const script = () => {
    const file = join(home, `worker-${n}.mjs`);
    writeFileSync(file, `
      import { readFileSync } from "node:fs";
      import { RESUME_ENV, WORKER_ENV } from ${JSON.stringify(new URL("../../budget/approvals.mjs", import.meta.url).pathname)};
      if (process.env[RESUME_ENV] !== process.env[WORKER_ENV]) process.exit(9);
      setTimeout(() => {}, 3000);
    `);
    return file;
  };

  it("starts the same worker with RESUME_ENV, records its pid and a fresh deadline, and counts the restart", async () => {
    const id = await openApproval({ deadline: Date.now() - 1000, railPgid: 123, railPgidStart: "x" });
    const r = approvals.restartWorker(id, { cmd: process.execPath, script: script(), cwd: home });
    expect(r.started).toBe(true);
    const rec = approvals.readApproval(id)!;
    expect(rec.pid).toBe(r.record.pid);
    expect(rec.pid).not.toBe(undefined);
    expect(rec.resumes).toBe(1);
    expect(rec.deadline).toBeGreaterThan(Date.now());
    // nothing of the first worker's rail script is named any more
    expect(rec.railPgid).toBeUndefined();
    expect(approvals.processesAlive(rec)).toBe(true);
    killGroup(rec.pid);
  });

  it("starts one worker however many ask: the second sees the first running", async () => {
    const id = await openApproval();
    const file = script();
    const first = approvals.restartWorker(id, { cmd: process.execPath, script: file, cwd: home });
    const second = approvals.restartWorker(id, { cmd: process.execPath, script: file, cwd: home });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(approvals.readApproval(id)!.resumes).toBe(1);
    killGroup(first.record.pid);
  });

  it("starts nothing for an approval that cannot be finished, or one that has ended", async () => {
    const plain = await openApproval({}, HOSTED);
    expect(approvals.restartWorker(plain, { cmd: process.execPath, script: script(), cwd: home }).started).toBe(false);
    const done = await openApproval();
    approvals.recordFinal(done, 0, { ok: true });
    expect(approvals.restartWorker(done, { cmd: process.execPath, script: script(), cwd: home }).started).toBe(false);
  });
});

describe("a worker that was started again records a result only once it has the request in hand", () => {
  it("taken over is per restart: a new worker has not taken it over until it says so", async () => {
    const id = await openApproval();
    expect(approvals.hasTakenOver(id)).toBe(false);
    approvals.recordTakenOver(id);
    expect(approvals.hasTakenOver(id)).toBe(true);
    const r = approvals.restartWorker(id, { cmd: process.execPath, script: join(home, "worker-none.mjs"), cwd: home });
    expect(r.started).toBe(true);
    expect(approvals.hasTakenOver(id)).toBe(false);
    approvals.recordTakenOver(id);
    expect(approvals.hasTakenOver(id)).toBe(true);
    killGroup(r.record.pid);
  });
});

describe("what a rail script read before it asked", () => {
  it("is kept whole, BigInts included, and read back; a key never kept is not found", async () => {
    const id = await openApproval();
    approvals.saveRequestFact(id, "setup", { startBlock: 123456789012345678901234567890n, agentHad: 7n, createdNow: true });
    approvals.saveRequestFact(id, "grant", 42n);
    expect(approvals.readRequestFact(id, "setup")).toEqual({ found: true, value: { startBlock: 123456789012345678901234567890n, agentHad: 7n, createdNow: true } });
    expect(approvals.readRequestFact(id, "grant")).toEqual({ found: true, value: 42n });
    expect(approvals.readRequestFact(id, "revoke")).toEqual({ found: false });
  });

  it("is not changed once the approval is final", async () => {
    const id = await openApproval();
    approvals.recordFinal(id, 0, { ok: true });
    approvals.saveRequestFact(id, "grant", 1n);
    expect(approvals.readRequestFact(id, "grant")).toEqual({ found: false });
  });
});

describe("recordHosted", () => {
  it("keeps what a later worker needs for a resumable request, and nothing more for any other", async () => {
    const id = await openApproval({}, null);
    approvals.recordHosted(id, RESUMABLE);
    expect(approvals.readApproval(id)!.hosted).toEqual({ ...RESUMABLE });
    const other = await openApproval({}, null);
    approvals.recordHosted(other, { ...HOSTED, intent: "b".repeat(64), expiresAt: 1, deadline: 2 });
    expect(approvals.readApproval(other)!.hosted).toEqual(HOSTED);
  });
});
