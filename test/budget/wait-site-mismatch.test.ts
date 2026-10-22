// `wait` and `wait --abandon` refuse a mistaken input (a --site that is not the approval's, one that is not a site at all, a
// --timeout out of range, --abandon on a command running in a terminal). The refusal is about the command and says nothing about
// what the approval did: when --id names an approval record in this home the answer is unknown (exit 5, final false) with the fix,
// never failed, because no field of the record proves nothing was sent. It writes nothing and touches no lock. An --id that names no
// record, or is malformed, keeps the bad-input answer. No network: the refusal happens before anything is read from a site.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MADE_ON = "http://127.0.0.1:41111";
const OTHER = "http://127.0.0.1:41112";
const PURCHASE = "11111111-2222-4333-8444-555555555555";
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-wait-site-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[], terminal = "x\n", extra: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    Object.assign(env, extra);
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
/** An owner approval record under this home, as a worker left it, with `over` on top. */
function record(over: Record<string, unknown> = {}) {
  const id = `oa-2026102101${String(++n).padStart(4, "0")}-${String(n).padStart(8, "0")}`;
  const dir = join(home, "budget", "approvals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "budget"), 0o700);
  chmodSync(dir, 0o700);
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify({
    id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date(Date.now() - 600_000).toISOString(),
    pid: 2_000_000_000, url: `${MADE_ON}/approve/budget/ba_test0001#x`, workerArgs: ["x"], timeoutS: 600, deadline: Date.now() + 600_000,
    hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", matchCode: "ABC-DEF", token: "ssbt_test_ba_test0001secret", resumable: true }, ...over,
  }, null, 2) + "\n", { mode: 0o600 });
  return { id, path };
}

const waitArgs = (id: string, site: string) => ["wait", "--id", id, "--shown", "--site", site];
const abandonArgs = (id: string, site: string) => ["wait", "--id", id, "--abandon", "--site", site];

describe("wait --site that is not the site the approval was made on", () => {
  for (const [what, over] of [
    ["a hosted request recorded with no result", {}],
    ["its wallet step started (sending) and a hosted request recorded", { sending: true }],
    ["its wallet step started (sending), though a result is stored", { sending: true, state: "final", final: { code: 0, result: { ok: true, state: "ok", final: true } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    // a hosted approval's wallet sends through the site: `sending` is never set, so a stored result is what says it may have sent
    ["a stored ok result with a transaction (a hosted setup, no sending)", { state: "final", final: { code: 0, result: { ok: true, state: "ok", final: true, tx: { fundAgent: "0xabc", grant: "0xdef" } } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["an approval the owner gave up (stored unknown, the wallet may have been asked)", { state: "final", abandoned: { at: "2026-10-21T00:00:00Z", walletMayHaveBeenAsked: true }, final: { code: 5, result: { ok: false, state: "unknown", final: true, abandonedAt: "2026-10-21T00:00:00Z" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["a stored failed result that names no proof", { state: "final", final: { code: 1, result: { ok: false, state: "failed", final: true, reason: "the worker stopped" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["a buy-once the owner gave up (stored unknown, paid null)", { command: "buy-once", state: "final", final: { code: 5, result: { ok: false, command: "buy-once", state: "unknown", paid: null, delivered: null, final: true, abandonedAt: "2026-10-21T00:00:00Z" } }, hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: undefined } }],
    ["a buy-once read as paid", { command: "buy-once", state: "final", final: { code: 0, result: { ok: true, command: "buy-once", state: "settled", paid: true, delivered: true, final: true } }, hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: undefined } }],
  ] as const) {
    it(`${what}: unknown (exit 5, final false) with the fix, for wait and for wait --abandon; nothing is changed`, async () => {
      const { id, path } = record(over);
      const before = readFileSync(path, "utf8");
      for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER)]) {
        const run = await budget(args);
        expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", rail: "evm", chain: "base-sepolia", state: "unknown", final: false, id });
        expect(run.result.reason).toMatch(/not the site this approval was made on/);
        expect(run.result.reason).toMatch(/whether the approval sent anything is unknown/);
        expect(run.result.next).toContain(`--site ${MADE_ON}`);
        expect(run.result.next).toMatch(/or leave --site out/);
        expect(run.result.state).not.toBe("failed");
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    }, 60_000);
  }

  for (const [what, over] of [
    ["a stored pre-send refusal", { state: "final", final: { code: 3, result: { ok: false, state: "refused_precheck", reason: "the link expired; nothing was sent" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    // shapes where a stored refusal is not proof that nothing was sent
    ["an owner-mismatch refusal that names the site's transaction hashes only in its reason", { state: "final", final: { code: 3, result: { ok: false, state: "refused_precheck", reason: "that account's wallet reported grant 0xabc and fund 0xdef" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } }],
    ["a buy-once refusal followed by payment evidence in its record", { command: "buy-once", state: "final", seen: { hashes: ["0xabc"], paid: false }, final: { code: 3, result: { ok: false, command: "buy-once", state: "refused_precheck", paid: false, tx: {}, final: true } }, hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: undefined } }],
  ] as const) {
    it(`${what}: also unknown, not failed (a stored result is never proof that nothing was sent)`, async () => {
      const { id, path } = record(over);
      const before = readFileSync(path, "utf8");
      for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER)]) {
        const run = await budget(args);
        expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
        expect(run.result.next).toContain(`--site ${MADE_ON}`);
      }
      expect(readFileSync(path, "utf8")).toBe(before);
    }, 60_000);
  }

  it("a finished approval: the wrong --site changes nothing, and a rerun with the right --site (or none) returns the stored result unchanged", async () => {
    const stored = { ok: true, command: "setup", rail: "evm", chain: "base-sepolia", id: "", state: "ok", final: true, owner: "0x1563915e194D8CfBA1943570603F7606A3115508", agent: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A", amount: "0.01", tx: { fundAgent: `0x${"a1".repeat(32)}`, grant: `0x${"b2".repeat(32)}` }, next: "the budget is set" };
    const { id, path } = record({ state: "final", sending: true, endedAt: "2026-10-21T00:00:00.000Z", final: { code: 0, result: { ...stored, id: "" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } });
    // the stored result carries the approval's own id, as a worker leaves it
    const record1 = JSON.parse(readFileSync(path, "utf8"));
    record1.final.result.id = id;
    writeFileSync(path, JSON.stringify(record1, null, 2) + "\n", { mode: 0o600 });
    const before = readFileSync(path, "utf8");
    // the right site, or none, before the mistake: the stored result
    const first = await budget(waitArgs(id, MADE_ON));
    expect(first.code, first.stderr).toBe(0);
    expect(first.result).toMatchObject({ state: "ok", final: true, id, owner: stored.owner, tx: stored.tx });
    expect(readFileSync(path, "utf8")).toBe(before);
    for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER)]) {
      const wrong = await budget(args);
      expect(wrong.code, wrong.stderr).toBe(5);
      expect(wrong.result).toMatchObject({ state: "unknown", final: false, id });
      expect(wrong.result.next).toContain(`--site ${MADE_ON}`);
      // nothing was written: the record is the same file, byte for byte
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    // the rerun the answer asks for, with the right site and with none: the original result, exit code and fields
    for (const args of [waitArgs(id, MADE_ON), ["wait", "--id", id, "--shown"], abandonArgs(id, MADE_ON)]) {
      const again = await budget(args);
      expect(again.code, `${args.join(" ")}: ${again.stderr}`).toBe(0);
      expect(again.result).toMatchObject({ state: "ok", final: true, id, owner: stored.owner, agent: stored.agent, amount: stored.amount, tx: stored.tx });
      expect(again.result.state).not.toBe("unknown");
      expect(readFileSync(path, "utf8")).toBe(before);
    }
    // no lock was left or taken
    expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
  }, 120_000);

  // every way wait refuses its input, for a record that exists (here: a hosted request recorded with no result)
  const refusals: [string, (id: string) => string[]][] = [
    ["a --site with a path (the approval's own site)", (id) => ["wait", "--id", id, "--shown", "--site", `${MADE_ON}/approve`]],
    ["a --site that adds a path to another site", (id) => ["wait", "--id", id, "--shown", "--site", `${OTHER}/x`]],
    ["a --site that is another site on the open internet", (id) => ["wait", "--id", id, "--shown", "--site", "https://example.com"]],
    ["a --site with no scheme", (id) => ["wait", "--id", id, "--shown", "--site", "staging.superstables.com"]],
    ["a --timeout out of range", (id) => ["wait", "--id", id, "--shown", "--timeout", "999"]],
    ["a --timeout that is not a number", (id) => ["wait", "--id", id, "--shown", "--timeout", "soon"]],
    ["--mainnet (the mainnet refusal is not a second way out)", (id) => ["wait", "--id", id, "--shown", "--mainnet"]],
    ["--mainnet with --abandon", (id) => ["wait", "--id", id, "--abandon", "--mainnet"]],
    ["a --site with --abandon (path)", (id) => ["wait", "--id", id, "--abandon", "--site", `${MADE_ON}/approve`]],
    ["a --timeout out of range with --abandon", (id) => ["wait", "--id", id, "--abandon", "--timeout", "999"]],
  ];
  for (const [what, args] of refusals) {
    it(`${what}: unknown (exit 5, final false), the record untouched`, async () => {
      const { id, path } = record();
      const before = readFileSync(path, "utf8");
      const run = await budget(args(id));
      expect(run.code, run.stderr).toBe(5);
      expect(run.result).toMatchObject({ command: "wait", rail: "evm", chain: "base-sepolia", state: "unknown", final: false, id });
      expect(run.result.reason).toMatch(/whether the approval sent anything is unknown/);
      expect(run.result.state).not.toBe("failed");
      expect(readFileSync(path, "utf8")).toBe(before);
    }, 60_000);
  }

  it("a recorded site this home cannot compare (not a site, or one the owner no longer allows): a --site is unknown, not ignored", async () => {
    for (const recorded of ["this is not a url", "https://removed.example.com"]) {
      const { id, path } = record({ hosted: { site: recorded, requestId: "ba_test0001", kind: "link", token: "ssbt_test_ba_test0001secret", resumable: true } });
      const before = readFileSync(path, "utf8");
      for (const args of [waitArgs(id, MADE_ON), abandonArgs(id, MADE_ON)]) {
        const run = await budget(args);
        expect(run.code, `${recorded} ${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
        expect(run.result.reason).toMatch(/cannot be compared/);
        expect(run.result.next).toMatch(/leave --site out/);
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    }
  }, 120_000);

  it("the answer writes nothing and touches no lock: a chain lock and a record lock that stand before it are byte for byte as they were", async () => {
    const { id, path } = record();
    const dir = join(home, "budget", "approvals");
    const chainLock = join(dir, "active-evm-base-sepolia");
    writeFileSync(chainLock, JSON.stringify({ id, pid: 2_000_000_000, createdAt: Date.now() - 600_000 }), { mode: 0o600 });
    const before = { record: readFileSync(path, "utf8"), chain: readFileSync(chainLock, "utf8") };
    for (const args of [waitArgs(id, OTHER), abandonArgs(id, OTHER), ["wait", "--id", id, "--shown", "--timeout", "999"]]) {
      const run = await budget(args);
      expect(run.code, run.stderr).toBe(5);
      expect(readFileSync(path, "utf8")).toBe(before.record);
      expect(readFileSync(chainLock, "utf8")).toBe(before.chain);
      expect(readdirSync(dir).filter((f) => f.endsWith(".lock"))).toEqual([]);
    }
  }, 120_000);

  it("a command that carries a worker's variables (set by hand) gets the same answer and no result stored for any approval", async () => {
    const { id, path } = record();
    const before = readFileSync(path, "utf8");
    const claims: Record<string, string>[] = [{ SUPERSTABLES_BUDGET_APPROVAL_ID: id }, { SUPERSTABLES_BUDGET_APPROVAL_ID: id, SUPERSTABLES_BUDGET_RESUME: id, SUPERSTABLES_BUDGET_RESUME_GENERATION: "1" }];
    for (const env of claims) {
      for (const args of [waitArgs(id, OTHER), ["wait", "--id", id, "--shown", "--timeout", "999"], ["wait", "--id", id, "--shown", "--mainnet"]]) {
        const run = await budget(args, "x\n", env);
        expect(run.code, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result).toMatchObject({ state: "unknown", final: false, id });
        expect(readFileSync(path, "utf8")).toBe(before);
      }
    }
  }, 120_000);

  it("a worker's variables set by hand (and the resume variables) never make wait store a result or release a lock: every answer leaves token, record and chain lock alone", async () => {
    const { id, path } = record();
    const dir = join(home, "budget", "approvals");
    const chainLock = join(dir, "active-evm-base-sepolia");
    writeFileSync(chainLock, JSON.stringify({ id, pid: 2_000_000_000, createdAt: Date.now() - 600_000 }), { mode: 0o600 });
    const before = { record: readFileSync(path, "utf8"), chain: readFileSync(chainLock, "utf8") };
    const claims: Record<string, string>[] = [{ SUPERSTABLES_BUDGET_APPROVAL_ID: id }, { SUPERSTABLES_BUDGET_APPROVAL_ID: id, SUPERSTABLES_BUDGET_RESUME: id, SUPERSTABLES_BUDGET_RESUME_GENERATION: "1" }];
    const forms: [string[], number, string][] = [
      [["wait", "--id", id], 2, "show_owner_first"],
      [["wait", "--id", id, "--shown", "--timeout", "0"], 0, "waiting_owner"],
      [["wait", "--id", id, "--shown", "--timeout", "999"], 5, "unknown"],
      [waitArgs(id, OTHER), 5, "unknown"],
      [["wait", "--id", id, "--shown", "--mainnet"], 5, "unknown"],
    ];
    // controls: the same forms with no worker variable answer the same, and leave the same record behind
    for (const [args, code, state] of forms) {
      const control = await budget(args);
      expect(control.code, `control ${args.join(" ")}: ${control.stderr}`).toBe(code);
      expect(control.result).toMatchObject({ state });
      expect(readFileSync(path, "utf8")).toBe(before.record);
      expect(readFileSync(chainLock, "utf8")).toBe(before.chain);
    }
    for (const env of claims) {
      for (const [args, code, state] of forms) {
        const run = await budget(args, "x\n", env);
        expect(run.code, `${JSON.stringify(env)} ${args.join(" ")}: ${run.stderr}`).toBe(code);
        expect(run.result, `${args.join(" ")}: a RESULT is printed`).toMatchObject({ state });
        expect(run.result.final).not.toBe(true);
        expect(readFileSync(path, "utf8")).toBe(before.record);
        expect(readFileSync(chainLock, "utf8")).toBe(before.chain);
      }
    }
    expect(JSON.parse(before.record).hosted.token).toMatch(/^ssbt_/);
  }, 240_000);

  it("an --id that names no record, or is malformed, keeps the existing answers", async () => {
    const gone = "oa-20261021010000-00000000";
    for (const args of [["wait", "--id", gone, "--shown", "--timeout", "999"], ["wait", "--id", gone, "--shown", "--site", "https://example.com"], ["wait", "--id", "not-an-id", "--shown"]]) {
      const run = await budget(args);
      expect(run.code, `${args.join(" ")}: ${run.stderr}`).toBe(2);
      expect(run.result).toMatchObject({ state: "failed" });
    }
    // --mainnet with no record: the mainnet refusal, as before
    const mainnet = await budget(["wait", "--id", gone, "--shown", "--mainnet"]);
    expect(mainnet.code, mainnet.stderr).toBe(3);
    expect(mainnet.result).toMatchObject({ state: "refused_precheck" });
    const plain = await budget(["wait", "--id", gone, "--shown"]);
    expect(plain.code).toBe(2);
    expect(plain.result.reason).toMatch(/no owner approval with id/);
  }, 120_000);

  it("a wait without --shown on an open approval refuses without polling, and is not final", async () => {
    const { id, path } = record();
    const before = readFileSync(path, "utf8");
    const run = await budget(["wait", "--id", id]);
    expect(run.result).toMatchObject({ state: "show_owner_first", final: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 60_000);

  // a record file that is there but is not a record: every way of reading it in wait counts it as an approval (unknown, exit 5), never as none
  for (const [label, made] of [["false", "false"], ["0", "0"], ["an empty string", '""'], ["null", "null"], ["broken JSON", "{ not json"], ["an empty file", ""], ["an array", "[]"], ["a number", "42"], ["a string", '"x"'], ["an empty object", "{}"], ["an object with another id", JSON.stringify({ id: "oa-20261021999999-ffffffff", command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting_owner" })],
    // a record file that has its id and not what wait needs to answer from it: damaged, which wait answers like a file it cannot read
    ["an object holding only the id", (id: string) => JSON.stringify({ id })],
    ["a stored final that is true", (_id: string, base: any) => JSON.stringify({ ...base, final: true })],
    ["a stored final that is a string", (_id: string, base: any) => JSON.stringify({ ...base, final: "yes" })],
    ["a stored final with neither code nor result", (_id: string, base: any) => JSON.stringify({ ...base, final: {} })],
    ["a stored final with a result and no code", (_id: string, base: any) => JSON.stringify({ ...base, final: { result: { ok: false, state: "failed" } } })],
    ["a record with no command", (_id: string, base: any) => JSON.stringify({ ...base, command: undefined })]] as [string, string | ((id: string, base: any) => string)][]) {
    it(`a record file holding ${label}: plain wait, --shown, --abandon and a bad flag all answer unknown, the file untouched`, async () => {
      const { id, path } = record();
      const content = typeof made === "function" ? made(id, JSON.parse(readFileSync(path, "utf8"))) : made;
      writeFileSync(path, content, { mode: 0o600 });
      const forms: string[][] = [["wait", "--id", id], ["wait", "--id", id, "--shown"], ["wait", "--id", id, "--shown", "--timeout", "0"], abandonArgs(id, MADE_ON), ["wait", "--id", id, "--abandon"], ["wait", "--id", id, "--shown", "--timeout", "999"], ["wait", "--id", id, "--shown", "--mainnet"]];
      for (const args of forms) {
        const run = await budget(args);
        expect(run.code, `${label} ${args.join(" ")}: ${run.stderr}`).toBe(5);
        expect(run.result, args.join(" ")).toMatchObject({ command: "wait", state: "unknown", final: false, id });
        expect(run.result.state).not.toBe("failed");
        expect(readFileSync(path, "utf8")).toBe(content);
      }
    }, 120_000);
  }

  it("a record that disappears between wait's first read and waitFor's first read is an approval it cannot read (unknown), not 'no approval'", async () => {
    const { id, path } = record();
    const hook = `--import ${resolve(ROOT, "test/helpers/remove-record-after-lock.mjs")}`;
    const run = await budget(["wait", "--id", id, "--shown", "--timeout", "0"], "x\n", { NODE_OPTIONS: [process.env.NODE_OPTIONS, hook].filter(Boolean).join(" "), REMOVE_RECORD_AFTER_READ: "1" });
    expect(run.code, run.stderr).toBe(5);
    expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
    expect(run.result.reason).toMatch(/disappeared/);
    expect(run.result.state).not.toBe("failed");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
  }, 60_000);

  // wait looks at the record once: every answer after that rests on that first look, so a file that goes after it was seen is an approval
  // that exists, never "no approval" (failed, final)
  const hookEnv = (extra: Record<string, string>) => ({ NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${resolve(ROOT, "test/helpers/remove-record-after-lock.mjs")}`].filter(Boolean).join(" "), ...extra });
  it("a record that disappears after wait saw it, in a refusal of wait's input, is still an approval that exists: unknown, never failed", async () => {
    const forms: [string, (id: string) => string[]][] = [
      ["--mainnet", (id) => ["wait", "--id", id, "--shown", "--mainnet"]],
      ["--mainnet with --abandon", (id) => ["wait", "--id", id, "--abandon", "--mainnet"]],
      ["a --site that is not the approval's", (id) => waitArgs(id, OTHER)],
      ["--abandon with a --site that is not the approval's", (id) => abandonArgs(id, OTHER)],
    ];
    for (const [label, args] of forms) {
      const { id, path } = record();
      const run = await budget(args(id), "x\n", hookEnv({ REMOVE_RECORD_AFTER_READ: "1" }));
      expect(run.code, `${label}: ${run.stderr}`).toBe(5);
      expect(run.result, label).toMatchObject({ command: "wait", state: "unknown", final: false, id });
      expect(run.result.state).not.toBe("failed");
      expect(existsSync(path), label).toBe(false);
      expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-")), label).toEqual([]);
    }
  }, 120_000);

  // a buy-once purchase is read through the strict reader after wait's first read: a record that goes, or turns into a file wait cannot
  // answer from, makes the payment outcome unknown, with no record lock taken for it and nothing stored
  const purchase = () => record({ command: "buy-once", state: "waiting_owner", hosted: { site: MADE_ON, requestId: "bp_test0001", kind: "purchase", token: "ssbt_test_bp_test0001secret" }, expires: new Date(Date.now() + 600_000).toISOString(), service: { id: "svc" } });
  for (const [label, rewrite] of [["removed", null], ["a buy-once record with no hosted request", JSON.stringify({ id: "X", command: "buy-once", rail: "evm", chain: "base-sepolia", state: "waiting_owner" })], ["null", "null"], ["a final that is true", JSON.stringify({ id: "X", command: "buy-once", rail: "evm", chain: "base-sepolia", final: true })]] as [string, string | null][]) {
    for (const flag of ["--shown", "--abandon"]) {
      it(`a purchase's record ${label} after wait read it, wait ${flag}: unknown (exit 5), no record lock, nothing stored`, async () => {
        const { id, path } = purchase();
        const locks = join(home, "locks.log");
        let env: Record<string, string> = { LOG_RECORD_LOCKS: locks };
        let written: string | null = null;
        if (rewrite === null) env.REMOVE_RECORD_AFTER_READ = "1";
        else { written = rewrite.replace('"X"', JSON.stringify(id)); const f = join(home, "rewrite.json"); writeFileSync(f, written); env.REWRITE_RECORD_AFTER_READ = f; }
        const run = await budget(["wait", "--id", id, flag, "--timeout", "0"], "x\n", hookEnv(env));
        expect(run.stderr, "no crash").not.toMatch(/TypeError|\bat .*\.mjs:\d+/);
        expect(run.code, run.stderr).toBe(5);
        expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
        expect(run.result.next).toMatch(/superstables\.com/);
        expect(run.result.next).toMatch(/do not start another purchase/);
        expect(existsSync(locks) ? readFileSync(locks, "utf8") : "", "no record lock was taken").toBe("");
        if (written === null) expect(existsSync(path)).toBe(false);
        else expect(readFileSync(path, "utf8")).toBe(written);
      }, 60_000);
    }
  }

  // the strict reader is also the one under the record's lock: wait reads the purchase, checks it, then changes it under the lock, and a
  // file that goes or turns bad between the check and the change must not be taken for the record that was read. The site here answers, so
  // wait reads the record again after the answer: reads 2 and 4 are the checks that come right before a change (the hook counts every read
  // of the record file), the first before the answer's evidence is added and the second before the answer is judged.
  for (const [label, rewrite] of [["removed", null], ["a buy-once record with no hosted request", JSON.stringify({ id: "X", command: "buy-once", rail: "evm", chain: "base-sepolia", state: "waiting_owner" })], ["null", "null"]] as [string, string | null][]) {
    for (const flag of ["--shown", "--abandon"]) {
      for (const read of [2, 4]) {
        it(`a purchase's record ${label} right after wait's read ${read} of it, wait ${flag}: unknown (exit 5, not final), no crash, nothing written`, async () => {
          const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: PURCHASE, state: "awaiting_approval", final: false })); });
          await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
          try {
            const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            const { id, path } = record({ command: "buy-once", state: "waiting_owner", hosted: { site, requestId: PURCHASE, kind: "purchase", token: "sspt_test_aaaaaaaaaaaaaaaa" }, expires: new Date(Date.now() + 600_000).toISOString(), service: { id: "svc" } });
            let env: Record<string, string> = {};
            let written: string | null = null;
            if (rewrite === null) env.REMOVE_RECORD_AFTER_READ = String(read);
            else { written = rewrite.replace('"X"', JSON.stringify(id)); const f = join(home, "rewrite.json"); writeFileSync(f, written); env.REWRITE_RECORD_AFTER_READ = f; env.REWRITE_RECORD_AFTER_READ_N = String(read); }
            const run = await budget(["wait", "--id", id, flag, "--timeout", "0"], "x\n", hookEnv(env));
            expect(run.stderr, "no crash").not.toMatch(/TypeError|\bat .*\.mjs:\d+/);
            expect(run.code, run.stderr).toBe(5);
            expect(run.result).toMatchObject({ command: "wait", state: "unknown", final: false, id });
            expect(run.result.next).toMatch(/do not start another purchase/);
            // the hook acted, and nothing wait did put the file back or stored an answer over it
            expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(written);
            expect(readdirSync(join(home, "budget", "approvals")).filter((f) => f.endsWith(".lock") || f.startsWith("active-"))).toEqual([]);
          } finally {
            server.close();
          }
        }, 60_000);
      }
    }
  }

  it("a worker's variable naming a finished approval (set by hand) does not silence wait: refusals answer, and a correct rerun returns the stored result", async () => {
    const stored = { ok: true, command: "setup", rail: "evm", chain: "base-sepolia", state: "ok", final: true, tx: { grant: `0x${"b2".repeat(32)}` }, next: "the budget is set" };
    const { id, path } = record({ state: "final", final: { code: 0, result: stored }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } });
    const before = readFileSync(path, "utf8");
    const env = { SUPERSTABLES_BUDGET_APPROVAL_ID: id };
    const refused = await budget(["wait", "--id", id, "--shown", "--timeout", "999"], "x\n", env);
    expect(refused.code, refused.stderr).toBe(5);
    expect(refused.result).toMatchObject({ state: "unknown", final: false, id });
    const again = await budget(["wait", "--id", id, "--shown"], "x\n", env);
    expect(again.code, again.stderr).toBe(0);
    expect(again.result).toMatchObject({ state: "ok", final: true, tx: stored.tx });
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 120_000);

  it("the site the approval was made on is accepted: no site refusal", async () => {
    const { id } = record({ state: "final", final: { code: 3, result: { ok: false, state: "refused_precheck", reason: "the link expired; nothing was sent" } }, hosted: { site: MADE_ON, requestId: "ba_test0001", kind: "link", token: undefined } });
    const run = await budget(waitArgs(id, MADE_ON));
    expect(run.stderr + run.stdout).not.toMatch(/not the site this approval was made on/);
  }, 60_000);
});
