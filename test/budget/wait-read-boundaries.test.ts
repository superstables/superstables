// One rule for every read `budget wait` makes of an approval record: once the command has seen a usable record, a later read that finds
// it missing, damaged, `{ "id" }` only, with a malformed final or malformed payment evidence, or turned into another approval answers unknown (exit 5, final false),
// never failed, refused or final, and never an unhandled error. The record file and the chain lock are left as found, no worker is
// started and nothing is written from what that read found.
//
// The table covers every read by construction. Each form is run once as it is to list its reads (test/helpers/remove-record-after-lock.mjs
// logs each read, whether this process held the record's lock then, and each record write, chain lock change and worker launch). Then
// it is run again for each read and each change of the file, made right after that read. A read made under the command's own record lock
// is followed by that lock's own write, which no other writer may come between: only a crash or an unhandled error counts there.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = resolve(ROOT, "test/helpers/remove-record-after-lock.mjs");
let gone: Record<string, unknown>;

/** The identity of a worker that has ended: a record that names it has no process left. */
beforeAll(async () => {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const fields = createIdentitySource().fields(child.pid!);
  const ended = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await ended;
  gone = { pid: child.pid, ...fields };
});

type Context = { home: string; id: string; site?: string };
type Answer = { code: number; state: string; final: boolean };
type Form = {
  name: string;
  /** the record as a worker or buy-once left it */
  record: (c: Context) => Record<string, unknown>;
  args: (c: Context) => string[];
  terminal?: (c: Context) => string;
  env?: (c: Context) => Record<string, string>;
  /** a buy-once purchase: its record is one request, so one with another request id is another approval (an owner approval may record a
   * second request; a decision about one request checks its id where it is made, tested in wait-owner-strict) */
  request?: boolean;
  /** a fake site that answers the purchase as still waiting for the owner */
  site?: boolean;
  /** the answer to the record as it is (or the answers it may give, by timing) */
  answer: Answer | Answer[];
  /** the record as it is starts a worker */
  launches?: boolean;
};

const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret" };
const owner = (over: Record<string, unknown> = {}) => (c: Context) => ({ id: c.id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(), ...gone, timeoutS: 600, deadline: Date.now() + 600_000, ...over });
const shown = (c: Context) => ["wait", "--id", c.id, "--shown", "--timeout", "0"];
const abandon = (c: Context) => ["wait", "--id", c.id, "--abandon", "--timeout", "0"];
const typed = (c: Context) => `${c.id} abandon\n`;
const asWorker = (c: Context) => ({ SUPERSTABLES_BUDGET_APPROVAL_ID: c.id });

export const FORMS: Form[] = [
  { name: "wait --shown, its worker gone, no hosted request", record: owner(), args: shown, answer: { code: 3, state: "refused_precheck", final: true } },
  { name: "wait --shown, its worker gone, a hosted request no restart can finish", record: owner({ hosted: HOSTED }), args: shown, answer: { code: 5, state: "unknown", final: true } },
  { name: "wait --shown, its worker gone, a hosted request a restarted worker finishes", record: owner({ hosted: { ...HOSTED, resumable: true }, workerArgs: ["not-a-command"] }), args: shown, launches: true,
    // the restarted worker (a command that ends at once) is still starting when wait answers, or has already ended with no result
    answer: [{ code: 0, state: "waiting_owner", final: false }, { code: 5, state: "unknown", final: false }] },
  { name: "wait --abandon from the owner's terminal", record: owner({ hosted: HOSTED }), args: abandon, terminal: typed, answer: { code: 5, state: "unknown", final: true } },
  { name: "wait --shown with a worker's variable set by hand", record: owner(), args: shown, env: asWorker, answer: { code: 3, state: "refused_precheck", final: true } },
  { name: "wait --abandon with a worker's variable set by hand", record: owner(), args: abandon, terminal: typed, env: asWorker, answer: { code: 5, state: "unknown", final: false } },
];

const MUTATIONS: [string, (r: any) => unknown, boolean?][] = [
  ["removed", () => undefined],
  ["only the id", (r) => ({ id: r.id })],
  ["a stored final that is true", (r) => ({ ...r, final: true })],
  ["a record with no command", (r) => ({ ...r, command: undefined })],
  ["another approval's record (another chain)", (r) => ({ ...r, chain: "arc-testnet" })],
  ["the record of another hosted request", (r) => ({ ...r, hosted: { ...r.hosted, requestId: `${r.hosted.requestId}x` } }), true],
  // payment evidence (`seen`) that is not a list of transactions and their payers: the evidence merge and the check that evidence only
  // grows would read it as if it were
  ["payment evidence whose transactions are an object", (r) => ({ ...r, seen: { hashes: {} } })],
  ["payment evidence whose transactions are a number", (r) => ({ ...r, seen: { hashes: 1 } })],
  ["payment evidence whose payer is a number", (r) => ({ ...r, seen: { hashes: [], payers: { [`0x${"a".repeat(64)}`]: 7 } } })],
];

type Run = { code: number; stderr: string; result: any; events: string[]; file: string | null; chain: string | null; created: string };
let n = 0;
async function run(form: Form, mutate?: { after: number; change: (r: any) => unknown }): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "ss-wait-reads-"));
  try {
    const id = `oa-2026102203${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
    const dir = join(home, "budget", "approvals");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(home, "budget"), 0o700);
    chmodSync(dir, 0o700);
    let server: { close(): void } | undefined;
    const c: Context = { home, id };
    if (form.site) {
      const { createServer } = await import("node:http");
      const s = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", state: "awaiting_approval", final: false })); });
      await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
      c.site = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
      server = s;
    }
    try {
      const record = form.record(c);
      const path = join(dir, `${id}.json`);
      const created = JSON.stringify(record);
      writeFileSync(path, created, { mode: 0o600 });
      // the chain lock a worker that is gone left behind
      const chainPath = join(dir, `active-${record.rail}-${record.chain}`);
      if (record.command !== "buy-once") writeFileSync(chainPath, JSON.stringify({ id, ...gone, createdAt: Date.now() - 600_000 }), { mode: 0o600 });
      const events = join(home, "events.log");
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, RECORD_EVENTS: events };
      for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME", "RECORD_HOOK_PID"]) delete env[k];
      env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${HOOK}`].filter(Boolean).join(" ");
      let written: string | null = created;
      if (mutate) {
        const changed = mutate.change(record);
        written = changed === undefined ? null : JSON.stringify(changed);
        if (written === null) env.REMOVE_RECORD_AFTER_READ = String(mutate.after);
        else {
          writeFileSync(join(home, "rewrite.json"), written);
          Object.assign(env, { REWRITE_RECORD_AFTER_READ: join(home, "rewrite.json"), REWRITE_RECORD_AFTER_READ_N: String(mutate.after) });
        }
      }
      Object.assign(env, form.env?.(c));
      const chainBefore = existsSync(chainPath) ? readFileSync(chainPath, "utf8") : null;
      const out = await new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn(process.execPath, ["--import", resolve(ROOT, "test/helpers/budget-owner-terminal.mjs"), resolve(ROOT, "budget/cli.mjs"), ...form.args(c)], { cwd: ROOT, env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += String(b)));
        child.stderr.on("data", (b) => (stderr += String(b)));
        child.stdin.end(form.terminal?.(c) ?? "");
        child.once("error", fail);
        child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
      });
      const file = existsSync(path) ? readFileSync(path, "utf8") : null;
      // a worker this command started stops here, whatever the record says now
      try { const pid = JSON.parse(file ?? "{}").pid; if (Number.isInteger(pid) && pid !== gone.pid) process.kill(-pid, "SIGKILL"); } catch { /* none, or gone */ }
      const line = out.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      return {
        code: out.code, stderr: out.stderr, result: line ? JSON.parse(line.slice(7)) : null,
        events: existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean) : [],
        file, chain: chainBefore === (existsSync(chainPath) ? readFileSync(chainPath, "utf8") : null) ? "unchanged" : "changed",
        created: mutate ? written ?? "(removed)" : created,
      };
    } finally {
      server?.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Run `jobs` with at most `width` at a time. */
async function pool<T>(jobs: (() => Promise<T>)[], width = 4): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }));
  return out;
}

const crashFree = (r: Run, label: string) => {
  expect(r.stderr, `${label}: no unhandled error`).not.toMatch(/TypeError|ReferenceError|\n\s+at .*\.m?[jt]s:\d+/);
  expect(r.result, `${label}: a RESULT\n${r.stderr}`).not.toBeNull();
};

describe("every read wait makes of an approval record, with the file changed right after it", () => {
  for (const form of FORMS) {
    it(form.name, async () => {
      const base = await run(form);
      crashFree(base, `${form.name}, as it is`);
      expect([form.answer].flat(), `${form.name}, as it is\n${base.stderr}`).toContainEqual({ code: base.code, state: base.result.state, final: base.result.final });
      if (form.launches) expect(base.events, `${form.name}: a worker was started`).toContain("launch");
      const reads = base.events.filter((e) => e.startsWith("read ")).map((e) => ({ n: Number(e.split(" ")[1]), locked: e.endsWith("locked") }));
      expect(reads.length, `${form.name}: wait read the record`).toBeGreaterThan(0);
      const mutations = MUTATIONS.filter(([, , request]) => !request || form.request);
      const rows = reads.flatMap((read) => mutations.map(([label, change]) => ({ read, label, change })));
      const runs = await pool(rows.map((row) => () => run(form, { after: row.read.n, change: row.change })));
      const failures: string[] = [];
      runs.forEach((r, i) => {
        const { read, label } = rows[i];
        const at = `${label} after read ${read.n}${read.locked ? " (under the command's lock)" : ""}`;
        try {
          crashFree(r, at);
          expect(r.result.state, `${at}: never failed`).not.toBe("failed");
          const from = r.events.indexOf(`mutate ${read.n}`);
          expect(from, `${at}: the hook changed the file\n${r.events.join("\n")}`).toBeGreaterThanOrEqual(0);
          if (read.locked) return;
          const after = r.events.slice(from + 1);
          expect(after.filter((e) => /^(write|chain|launch)$/.test(e)), `${at}: nothing written, no chain lock changed, no worker started\n${r.events.join("\n")}`).toEqual([]);
          expect(r.file ?? "(removed)", `${at}: the file as found`).toBe(r.created);
          expect(r.chain, `${at}: the chain lock as found`).toBe("unchanged");
          if (after.some((e) => e.startsWith("read "))) {
            expect({ code: r.code, state: r.result.state, final: r.result.final }, `${at}: a later read found it: unknown\n${r.stderr}`).toEqual({ code: 5, state: "unknown", final: false });
          }
        } catch (err) {
          failures.push(String((err as Error).message).split("\n").slice(0, 3).join(" | "));
        }
      });
      expect(failures, `${failures.length} of ${rows.length} rows`).toEqual([]);
    }, 600_000);
  }
});
