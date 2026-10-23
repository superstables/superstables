// One rule for every read `budget wait` makes of an approval record: once the command has seen a usable record, a later read that finds
// it missing, damaged, `{ "id" }` only, with a malformed final or malformed payment evidence, or turned into another approval answers unknown
// (exit 5, final false) and says the record changed, never failed, refused or final, and never an unhandled error. The record file and the
// chain lock are left as found, no worker is started and nothing is written from what that read found.
//
// The table covers every read by construction, on the branches its forms reach. Each form is run once as it is to list what it does to the
// record (test/helpers/remove-record-after-lock.mjs logs each read, whether this process held the record's lock then, and each record
// write, chain lock change and worker launch). Then it is run again for each of those events and each change of the file, made right after
// that event. So a read that follows a write, a chain change or a launch is reached too, not only one that follows another read.
// - After a read made without the record's lock, nothing more is written, changed or started, and the file and chain lock stay as found;
//   a later read answers unknown.
// - After a read under the command's own record lock, the rest of that locked step may follow (another read under the same lock, such as
//   the attribution scan, and the lock's own write): the write replaces the change, which no other writer may come between (a writer that
//   ignored the lock loses its change to the locked one). When the lock is released with nothing written, the next read finds the change,
//   as below.
// - After a write, a chain change or a launch, what follows from the command's own step may still happen (a chain released after its own
//   final write, say, or the lock's own write after a launch under it); from the next read on, the rule above holds.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIdentitySource } from "../../budget/lock-identity.mjs";
import { PAYER, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = resolve(ROOT, "test/helpers/remove-record-after-lock.mjs");
let gone: Record<string, unknown>;
let holder: { pid: number; fields: Record<string, unknown> };
let market: FakePurchaseSite;

beforeAll(async () => {
  // the identity of a worker that has ended: a record that names it has no process left
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const fields = createIdentitySource().fields(child.pid!);
  const ended = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await ended;
  gone = { pid: child.pid, ...fields };
  // a live process: the worker of another approval that holds the chain
  const live = spawn("sleep", ["900"], { detached: true, stdio: "ignore" });
  holder = { pid: live.pid!, fields: createIdentitySource().fields(live.pid!) };
  // a purchase site with a chain behind it, for purchases the site settles
  market = await startFakePurchaseSite();
});
afterAll(async () => {
  try { process.kill(-holder.pid, "SIGKILL"); } catch { /* gone */ }
  await market?.close();
});

type Context = { home: string; id: string; site?: string; env: Record<string, string | undefined> };
type Answer = { code: number; state: string; final: boolean };
type Run = { code: number; stderr: string; result: any; events: string[]; file: string | null; chain: string | null; created: string };
type Form = {
  name: string;
  /** the record as a worker or buy-once left it (written by hand) */
  record?: (c: Context) => Record<string, unknown>;
  /** or made by the client itself: it sets c.id */
  prepare?: (c: Context) => Promise<void>;
  args: (c: Context) => string[];
  terminal?: (c: Context) => string;
  env?: (c: Context) => Record<string, string>;
  /** a buy-once purchase: its record is one request, so one with another request id is another approval (an owner approval may record a
   * second request; a decision about one request checks its id where it is made, tested in wait-owner-strict) */
  request?: boolean;
  /** a fake site that answers the purchase as still waiting for the owner */
  site?: boolean;
  /** another approval, whose worker runs, holds the chain */
  blocked?: boolean;
  /** the answer to the record as it is (or the answers it may give, by timing) */
  answer: Answer | Answer[];
  /** the record as it is starts a worker */
  launches?: boolean;
  /** the branch the form is there for: what its run as it is shows */
  reaches?: (r: Run) => void;
};

const HOSTED = { site: "http://127.0.0.1:9", requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret" };
const owner = (over: Record<string, unknown> = {}) => (c: Context) => ({ id: c.id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(), ...gone, timeoutS: 600, deadline: Date.now() + 600_000, ...over });
const purchase = (c: Context) => ({
  id: c.id, command: "buy-once", rail: "evm", chain: "base-sepolia", state: "waiting_owner", attributionVersion: 2, createdAt: new Date(Date.now() - 60_000).toISOString(),
  action: "buy-once", url: `${c.site}/approve/purchase/x`, matchCode: "ABC-DEF", expires: new Date(Date.now() + 600_000).toISOString(), service: { id: "svc" }, pid: null,
  hosted: { site: c.site, requestId: "11111111-2222-4333-8444-555555555555", kind: "purchase", token: "sspt_test_aaaaaaaaaaaaaaaa" },
});
const TX = `0x${"5e".repeat(32)}`;
const NONCE = `0x${"6f".repeat(32)}`;
const payer = PAYER.toLowerCase();
/** A buy-once purchase that already has a stored final answer: wait checks it against the record's evidence (checkedFinal). */
const ended = (over: Record<string, unknown>) => (c: Context) => ({
  id: c.id, command: "buy-once", rail: "evm", chain: "base-sepolia", state: "final", createdAt: new Date(Date.now() - 60_000).toISOString(), endedAt: new Date().toISOString(),
  action: "buy-once", service: { id: "svc" }, pid: null, hosted: { site: "http://127.0.0.1:9", requestId: "11111111-2222-4333-8444-555555555555", kind: "purchase" }, ...over,
});
const settled = { ok: true, command: "buy-once", rail: "evm", chain: "base-sepolia", state: "settled", final: true, chain_final: true, paid: true, delivered: true, amount: "0.01", tx: { settle: TX }, payer };
let txs = 0;
/** A purchase made by buy-once on the fake site, which the site then settles with a payment on its chain. */
const bought = (c: Context) => async () => {
  const run = await cli(c, ["buy-once", "--site", market.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01"]);
  if (run.code !== 0 || !run.result?.id) throw new Error(`buy-once: ${run.stderr}`);
  c.id = run.result.id;
  const p = market.purchases.find((x) => x.id === run.result.purchase)!;
  market.settle(p, { asset: "BTC" }, { transaction: `0x${(++txs).toString(16).padStart(64, "0")}`, payer: PAYER });
};
/** A purchase made by buy-once on the fake site, which the site then ends with nothing paid (the approval link expired). */
const expired = async (c: Context) => {
  const run = await cli(c, ["buy-once", "--site", market.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01"]);
  if (run.code !== 0 || !run.result?.id) throw new Error(`buy-once: ${run.stderr}`);
  c.id = run.result.id;
  Object.assign(market.purchases.find((x) => x.id === run.result.purchase)!, { state: "expired", final: true, reason_code: "approval_expired", payment: { status: "not_paid" }, delivery: { status: "not_called" } });
};
const shown = (c: Context) => ["wait", "--id", c.id, "--shown", "--timeout", "0"];
const abandon = (c: Context) => ["wait", "--id", c.id, "--abandon", "--timeout", "0"];
const typed = (c: Context) => `${c.id} abandon\n`;
const asWorker = (c: Context) => ({ SUPERSTABLES_BUDGET_APPROVAL_ID: c.id });
const stored = (r: Run) => JSON.parse(r.file ?? "{}");

export const FORMS: Form[] = [
  { name: "wait --shown, its worker gone, no hosted request", record: owner(), args: shown, answer: { code: 3, state: "refused_precheck", final: true } },
  { name: "wait --shown, its worker gone, a hosted request no restart can finish", record: owner({ hosted: HOSTED }), args: shown, answer: { code: 5, state: "unknown", final: true } },
  { name: "wait --shown, its worker gone, a hosted request a restarted worker finishes", record: owner({ hosted: { ...HOSTED, resumable: true }, workerArgs: ["not-a-command"] }), args: shown, launches: true,
    // the restarted worker (a command that ends at once) is still starting when wait answers, or has already ended with no result
    answer: [{ code: 0, state: "waiting_owner", final: false }, { code: 5, state: "unknown", final: false }] },
  // finishHosted's branch where no worker starts: another approval's live worker holds the chain, so the restart is refused
  { name: "wait --shown, its worker gone, a restart refused because another approval holds the chain", record: owner({ hosted: { ...HOSTED, resumable: true }, workerArgs: ["not-a-command"] }), args: shown, blocked: true,
    answer: { code: 5, state: "unknown", final: false }, reaches: (r) => expect(r.result.reason).toMatch(/another owner approval .* holds this chain/) },
  { name: "wait --shown on an owner approval that already has a stored final answer", record: owner({ state: "final", final: { code: 3, result: { ok: false, command: "setup", state: "refused_precheck", final: true, reason: "the owner rejected it" } } }), args: shown,
    answer: { code: 3, state: "refused_precheck", final: true } },
  { name: "wait --abandon from the owner's terminal", record: owner({ hosted: HOSTED }), args: abandon, terminal: typed, answer: { code: 5, state: "unknown", final: true } },
  { name: "wait --shown with a worker's variable set by hand", record: owner(), args: shown, env: asWorker, answer: { code: 3, state: "refused_precheck", final: true } },
  { name: "wait --abandon with a worker's variable set by hand", record: owner(), args: abandon, terminal: typed, env: asWorker, answer: { code: 5, state: "unknown", final: false } },
  // wait takes no --mainnet: for an approval that exists, the flag is refused as unknown from the command's first look at the record
  { name: "wait --mainnet", record: owner(), args: (c) => [...shown(c), "--mainnet"], answer: { code: 5, state: "unknown", final: false } },
  { name: "wait --mainnet with a worker's variable set by hand", record: owner(), args: (c) => [...shown(c), "--mainnet"], env: asWorker, answer: { code: 5, state: "unknown", final: false } },
  { name: "wait --shown on a buy-once purchase the site still holds open", record: purchase, args: shown, request: true, site: true, answer: { code: 0, state: "waiting_owner", final: false } },
  { name: "wait --abandon on a buy-once purchase the site still holds open", record: purchase, args: abandon, terminal: typed, request: true, site: true, answer: { code: 5, state: "unknown", final: true } },
  // a stored final is a cache of a decision over the evidence (checkedFinal): a paid answer stored by an older version gets its attribution
  // note, a verdict the evidence no longer holds is stored again as unknown, and one that holds is answered after the attribution scan; each
  // is followed by a read of the record as stored now (settleOnce's again)
  { name: "wait --shown on a buy-once paid answer stored by an older version", request: true, args: shown, answer: { code: 0, state: "settled", final: true },
    record: ended({ seen: { hashes: [TX], payers: { [TX]: payer }, named: true, paid: true }, final: { code: 0, result: settled } }),
    reaches: (r) => expect(stored(r).final.result.attribution).toMatch(/older version/) },
  { name: "wait --shown on a buy-once refusal that later evidence overrules", request: true, args: shown, answer: { code: 5, state: "unknown", final: true },
    record: ended({ seen: { hashes: [TX], named: true }, final: { code: 3, result: { ok: false, command: "buy-once", state: "refused_precheck", final: true, paid: false, tx: {} } } }),
    reaches: (r) => expect(stored(r).final.code).toBe(5) },
  { name: "wait --shown on a buy-once paid answer the evidence still holds", request: true, args: shown, answer: { code: 0, state: "settled", final: true },
    record: ended({ attributionVersion: 2, seen: { nonce: NONCE, payer, hashes: [TX], payers: { [TX]: payer }, named: true, paid: true }, final: { code: 0, result: settled, attribution: { nonce: NONCE, payer } } }),
    reaches: (r) => { expect(stored(r).final).toMatchObject({ code: 0, attribution: { nonce: NONCE } }); expect(stored(r).final.result.attribution, "nothing to correct").toBeUndefined(); } },
  // a purchase the site settles: the payment is read on the chain and committed under the record's lock, after the attribution scan
  { name: "wait --shown on a buy-once purchase the site settled, its payment final on chain", prepare: async (c) => { market.finalizedBlock = 1000; await bought(c)(); }, args: shown, request: true,
    answer: { code: 0, state: "settled", final: true }, reaches: (r) => expect(stored(r).final).toMatchObject({ code: 0, result: { paid: true } }) },
  { name: "wait --shown on a buy-once purchase the site settled, its payment included but not final", prepare: async (c) => { market.finalizedBlock = 10; await bought(c)(); }, args: shown, request: true,
    answer: { code: 0, state: "settled", final: true }, reaches: (r) => { expect(stored(r).included).toMatchObject({ code: 0, result: { paid: true, chain_final: false } }); expect(stored(r).final).toBeUndefined(); } },
  { name: "wait --shown on a buy-once purchase the site ended with nothing paid", prepare: expired, args: shown, request: true,
    answer: { code: 3, state: "refused_precheck", final: true }, reaches: (r) => expect(stored(r).final).toMatchObject({ code: 3, result: { paid: false } }) },
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

/** The client run as it is in this home (no hook): how a test makes a record the way the client makes it. */
function cli(c: Context, args: string[]): Promise<{ code: number; stderr: string; result: any }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(ROOT, "budget/cli.mjs"), ...args], { cwd: ROOT, env: c.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += String(b)));
    child.stderr.on("data", (b) => (stderr += String(b)));
    child.stdin.end();
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

let n = 0;
async function run(form: Form, mutate?: { kind: string; n: number; change: (r: any) => unknown }): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "ss-wait-reads-"));
  try {
    const id = `oa-2026102203${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
    const dir = join(home, "budget", "approvals");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(home, "budget"), 0o700);
    chmodSync(dir, 0o700);
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: market.chainUrl };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME", "RECORD_HOOK_PID"]) delete env[k];
    let server: { close(): void } | undefined;
    const c: Context = { home, id, env };
    if (form.site) {
      const { createServer } = await import("node:http");
      const s = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", state: "awaiting_approval", final: false })); });
      await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
      c.site = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
      server = s;
    }
    try {
      const path = () => join(dir, `${c.id}.json`);
      if (form.prepare) await form.prepare(c);
      else writeFileSync(path(), JSON.stringify(form.record!(c)), { mode: 0o600 });
      const created = readFileSync(path(), "utf8");
      const record = JSON.parse(created);
      // the chain lock a worker that is gone left behind, or the one another approval's running worker holds
      const chainPath = join(dir, `active-${record.rail}-${record.chain}`);
      if (form.blocked) {
        const other = `oa-20261022040000-${String(n).padStart(8, "0")}`;
        writeFileSync(join(dir, `${other}.json`), JSON.stringify({ ...owner()({ ...c, id: other }), pid: holder.pid, ...holder.fields }), { mode: 0o600 });
        writeFileSync(chainPath, JSON.stringify({ id: other, pid: holder.pid, ...holder.fields, createdAt: Date.now() }), { mode: 0o600 });
      } else if (record.command !== "buy-once") writeFileSync(chainPath, JSON.stringify({ id: c.id, ...gone, createdAt: Date.now() - 600_000 }), { mode: 0o600 });
      const events = join(home, "events.log");
      const hooked: Record<string, string | undefined> = { ...env, RECORD_EVENTS: events, RECORD_ID: c.id };
      hooked.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${HOOK}`].filter(Boolean).join(" ");
      let written: string | null = created;
      if (mutate) {
        const changed = mutate.change(record);
        written = changed === undefined ? null : JSON.stringify(changed);
        hooked.CHANGE_RECORD_AT = `${mutate.kind} ${mutate.n}`;
        if (written !== null) {
          writeFileSync(join(home, "rewrite.json"), written);
          hooked.CHANGE_RECORD_TO = join(home, "rewrite.json");
        }
      }
      Object.assign(hooked, form.env?.(c));
      const chainBefore = existsSync(chainPath) ? readFileSync(chainPath, "utf8") : null;
      const out = await new Promise<{ code: number; stdout: string; stderr: string }>((done, fail) => {
        const child = spawn(process.execPath, ["--import", resolve(ROOT, "test/helpers/budget-owner-terminal.mjs"), resolve(ROOT, "budget/cli.mjs"), ...form.args(c)], { cwd: ROOT, env: hooked });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += String(b)));
        child.stderr.on("data", (b) => (stderr += String(b)));
        child.stdin.end(form.terminal?.(c) ?? "");
        child.once("error", fail);
        child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
      });
      const file = existsSync(path()) ? readFileSync(path(), "utf8") : null;
      // a worker this command started stops here, whatever the record says now
      try { const pid = JSON.parse(file ?? "{}").pid; if (Number.isInteger(pid) && pid !== gone.pid && pid !== holder.pid) process.kill(-pid, "SIGKILL"); } catch { /* none, or gone */ }
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
const SIDE_EFFECT = /^(write|chain|launch) \d+ /;
/** The answer once a read found the change: unknown, not final, and saying it is the record that changed (no other branch's answer). */
const answersChange = (r: Run, at: string) => {
  expect({ code: r.code, state: r.result.state, final: r.result.final }, `${at}: a later read found it: unknown\n${r.stderr}`).toEqual({ code: 5, state: "unknown", final: false });
  expect(r.result.reason, `${at}: the answer says the record changed`).toMatch(/record/);
};

describe("every read wait makes of an approval record, with the file changed right after each thing the command does to it", () => {
  for (const form of FORMS) {
    it(form.name, async () => {
      const base = await run(form);
      crashFree(base, `${form.name}, as it is`);
      expect([form.answer].flat(), `${form.name}, as it is\n${base.stderr}`).toContainEqual({ code: base.code, state: base.result.state, final: base.result.final });
      if (form.launches) expect(base.events.some((e) => e.startsWith("launch ")), `${form.name}: a worker was started`).toBe(true);
      form.reaches?.(base);
      const points = base.events.filter((e) => /^(read|write|chain|launch) \d+/.test(e)).map((e) => { const [kind, k] = e.split(" "); return { kind, n: Number(k), locked: e.endsWith(" locked") }; });
      expect(points.filter((p) => p.kind === "read").length, `${form.name}: wait read the record`).toBeGreaterThan(0);
      const mutations = MUTATIONS.filter(([, , request]) => !request || form.request);
      const rows = points.flatMap((point) => mutations.map(([label, change]) => ({ point, label, change })));
      const runs = await pool(rows.map((row) => () => run(form, { kind: row.point.kind, n: row.point.n, change: row.change })));
      const failures: string[] = [];
      runs.forEach((r, i) => {
        const { point, label } = rows[i];
        const at = `${label} after ${point.kind} ${point.n}${point.locked ? " (under the command's lock)" : ""}`;
        try {
          crashFree(r, at);
          expect(r.result.state, `${at}: never failed`).not.toBe("failed");
          const from = r.events.indexOf(`mutate ${point.kind} ${point.n}`);
          expect(from, `${at}: the hook changed the file\n${r.events.join("\n")}`).toBeGreaterThanOrEqual(0);
          const after = r.events.slice(from + 1);
          if (point.kind === "read" && !point.locked) {
            expect(after.filter((e) => SIDE_EFFECT.test(e)), `${at}: nothing written, no chain lock changed, no worker started\n${r.events.join("\n")}`).toEqual([]);
            expect(r.file ?? "(removed)", `${at}: the file as found`).toBe(r.created);
            expect(r.chain, `${at}: the chain lock as found`).toBe("unchanged");
            if (after.some((e) => e.startsWith("read "))) answersChange(r, at);
            return;
          }
          // under the command's lock, the rest of that locked step may follow, and its own write replaces the change; after a write, a chain
          // change or a launch, the command's own step may go on. Once it reads the record again, that read finds the change
          let rest = after;
          if (point.locked) {
            const end = after.findIndex((e) => e === "unlock" || e.startsWith("write "));
            if (end < 0 || after[end].startsWith("write ")) return;
            rest = after.slice(end + 1);
          }
          const next = rest.findIndex((e) => e.startsWith("read "));
          if (next < 0) return;
          expect(rest.slice(next + 1).filter((e) => SIDE_EFFECT.test(e)), `${at}: nothing written, no chain lock changed, no worker started after the next read\n${r.events.join("\n")}`).toEqual([]);
          expect(r.file ?? "(removed)", `${at}: the file as found`).toBe(r.created);
          answersChange(r, at);
        } catch (err) {
          failures.push(String((err as Error).message).split("\n").slice(0, 3).join(" | "));
        }
      });
      expect(failures, `${failures.length} of ${rows.length} rows`).toEqual([]);
    }, 900_000);
  }
});
