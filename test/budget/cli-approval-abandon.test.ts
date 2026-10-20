// The owner gives up a background owner approval with `wait --id ID --abandon` (budget/cli.mjs abandonOwnerApproval): only
// from a terminal, after typing the approval's id and "abandon". It ends unknown (exit 5, final), keeps the record, frees
// the chain, and no later wait restarts it. The request on the site is not cancelled. The real dispatcher and evm rail
// scripts against a fake superstables.com and a fake Base Sepolia RPC. No network, no real key.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, pad, parseAbi, toEventSelector } from "viem";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { evmOwner, startFakeRpc, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import type { TestServer } from "../helpers/servers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OWNER = evmOwner("22");
const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FUND_VALUE = 100_000_000_000_000n;
const FUND_HASH = `0x${"a1".repeat(32)}`;
const GRANT_HASH = `0x${"b2".repeat(32)}`;
const REVOKE_HASH = `0x${"c3".repeat(32)}`;
const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const approveData = (value: bigint) => encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, value] });

let home: string;
let site: FakeSite;
let rpc: TestServer | undefined;
let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-budget-resume-"));
  site = await startFakeSite();
});
afterEach(async () => {
  await site.close();
  await rpc?.close();
  rpc = undefined;
  rmSync(home, { recursive: true, force: true });
});

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[], extraEnv: Record<string, string> = {}, terminal?: string): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc!.url };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    Object.assign(env, extraEnv);
    tree.set({ "base-sepolia": [{ url: rpc!.url, operator: "fake-a" }, { url: `${rpc!.url}/`, operator: "fake-b" }], "arc-testnet": [{ url: rpc!.url, operator: "fake-a" }] });
    const preload = terminal === undefined ? [] : ["--import", resolve(ROOT, "test/helpers/budget-owner-terminal.mjs")];
    const child = spawn(process.execPath, [...preload, resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
    child.stdin.end(terminal ?? "");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}

const approvals = () => join(home, "budget", "approvals");
const publicPath = () => join(home, "budget", "public", "evm-base-sepolia.env");
const publicFile = () => readFileSync(publicPath(), "utf8");
const record = (id: string) => JSON.parse(readFileSync(join(approvals(), `${id}.json`), "utf8"));
const lockPath = () => join(approvals(), "active-evm-base-sepolia");
/** How many lines of the public file set `key`. */
const lines = (key: string) => publicFile().split("\n").filter((l) => l.startsWith(`${key}=`)).length;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** What Codex does when the command that started the worker ends: every process of it goes, the rail script's group too. */
async function endEveryProcess(id: string, signal: NodeJS.Signals = "SIGKILL") {
  const r = record(id);
  for (const pgid of [r.pid, r.railPgid]) if (pgid) { try { process.kill(-pgid, signal); } catch { /* already gone */ } }
  for (let i = 0; i < 100 && [r.pid, r.railPgid].some((p) => p && alive(p)); i++) await new Promise((x) => setTimeout(x, 50));
  expect([r.pid, r.railPgid].some((p) => p && alive(p))).toBe(false);
}

const approvalLog = (token: string, owner: string, spender: string, value: bigint, blockNumber: string) => ({
  address: token,
  topics: [toEventSelector("Approval(address,address,uint256)"), pad(owner.toLowerCase() as `0x${string}`), pad(spender.toLowerCase() as `0x${string}`)],
  data: `0x${value.toString(16).padStart(64, "0")}`,
  blockNumber, logIndex: "0x0", transactionIndex: "0x0", removed: false,
});

/**
 * A chain that shows the owner's transactions once `chain.approved` is set (block 0x20; the head is 0x10 before), with the
 * allowance and the agent's gas as they stand then. `allowanceAfter` is what the allowance reads once the owner approved.
 */
const chain = { approved: false };
async function fakeChain(allowanceBefore: bigint, allowanceAfter: bigint) {
  chain.approved = false;
  const txs: Record<string, { to: string; input: string; value: bigint; logs: unknown[] }> = {
    [FUND_HASH]: { to: AGENT, input: "0x", value: FUND_VALUE, logs: [] },
    [GRANT_HASH]: { to: USDC, input: approveData(10000n), value: 0n, logs: [approvalLog(USDC, OWNER, AGENT, 10000n, "0x20")] },
    [REVOKE_HASH]: { to: USDC, input: approveData(0n), value: 0n, logs: [approvalLog(USDC, OWNER, AGENT, 0n, "0x20")] },
  };
  const blockHash = `0x${"ef".repeat(32)}`;
  await rpc?.close();
  rpc = await startFakeRpc(84532, (method, params) => {
    if (method === "eth_blockNumber") return chain.approved ? "0x20" : "0x10";
    const t = txs[params[0]];
    if (method === "eth_getTransactionByHash" && t) return { hash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, input: t.input, value: `0x${t.value.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
    if (method === "eth_getTransactionReceipt" && t) return { transactionHash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, status: "0x1", logs: t.logs, gasUsed: "0x10000", cumulativeGasUsed: "0x10000", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
    if (method === "eth_call" && String(params[0]?.data).startsWith("0xdd62ed3e")) return `0x${(chain.approved ? allowanceAfter : allowanceBefore).toString(16).padStart(64, "0")}`;
    if (method === "eth_getBalance" && String(params[0]).toLowerCase() === AGENT.toLowerCase()) return `0x${(10n ** 18n + (chain.approved ? FUND_VALUE : 0n)).toString(16)}`;
    return undefined;
  });
}

function writeAgent() {
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
}
/** A chain set up on the site, with the owner on record (and a budget, when `cap` says so). */
function hostedChain(cap?: string) {
  writeAgent();
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  writeFileSync(publicPath(), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n${cap ? `B4_CAP=${cap}\nB4_SET_AT=1790000000\nB4_SET_TX=${GRANT_HASH}\n` : ""}`);
}

/** The owner approves the one-link set-up on the site: the link, then the gas, then the budget. */
function approveSetup() {
  const r = site.requests[0];
  Object.assign(r, { state: "linked", owner: OWNER });
  Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
  Object.assign(r.steps![1], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
  chain.approved = true;
}
const setupArgs = () => ["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund"];
const startSetup = async (args = setupArgs(), env: Record<string, string> = {}) => {
  writeAgent();
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  // a reused key is granted over only when the owner is on record and the endpoints read its allowance at a final block
  writeFileSync(publicPath(), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`);
  const first = await budget(args, env);
  expect(first.code, first.stderr).toBe(0);
  expect(first.result).toMatchObject({ state: "waiting_owner", matchCode: "ABC-DEF" });
  return first.result.id as string;
};


const abandonArgs = (id: string) => ["wait", "--id", id, "--abandon"];
const typed = (id: string) => `${id} abandon\n`;
/** Whether a process of the approval (its worker or its rail script) still runs. */
const running = (id: string) => { const r = record(id); return [r.pid, r.railPgid].some((p) => p && alive(p)); };

describe("wait --abandon on a background owner approval", () => {
  it("is refused without a terminal, and with a wrong confirmation: nothing changes", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    const before = readFileSync(join(approvals(), `${id}.json`), "utf8");

    const agent = await budget(abandonArgs(id));
    expect(agent.code, agent.stderr).toBe(3);
    expect(agent.result).toMatchObject({ state: "refused_precheck", reason: "owner_terminal_required", id, final: false });
    expect(agent.result.next).toMatch(/ask the owner/);

    for (const answer of ["\n", `${id}\n`, `abandon\n`, `${id} abandon extra\n`, `${id} ABANDON\n`]) {
      const wrong = await budget(abandonArgs(id), {}, answer);
      expect(wrong.code, `${JSON.stringify(answer)}: ${wrong.stderr}`).toBe(3);
      expect(wrong.result).toMatchObject({ state: "refused_precheck", reason: "owner_confirmation_mismatch", final: false });
    }
    // no input at all
    expect((await budget(abandonArgs(id), {}, "")).result).toMatchObject({ reason: "owner_confirmation_mismatch" });

    expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).toBe(before);
    expect(record(id).hosted.token).toMatch(/^ssbt_/);
    expect(existsSync(lockPath())).toBe(true);
    // the approval is still the one a later wait finishes
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true });
  }, 300_000);

  it("ends it unknown from the owner's terminal: the record stays, the chain is free, no later wait restarts it, even once the owner approves on the site", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    expect(existsSync(lockPath())).toBe(true);

    const gone = await budget(abandonArgs(id), {}, typed(id));
    expect(gone.code, gone.stderr).toBe(5);
    expect(gone.result).toMatchObject({ ok: false, command: "setup", state: "unknown", final: true, id });
    expect(gone.result.abandonedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(gone.result.next).toMatch(/may still be open/);
    expect(gone.result.next).toMatch(/wallet/);
    expect(gone.stderr).toMatch(/was not cancelled and may still be open/);
    const r = record(id);
    expect(r).toMatchObject({ final: { code: 5, result: { state: "unknown", final: true } }, abandoned: { requestId: expect.any(String), site: site.url }, hosted: { requestId: expect.any(String), site: site.url }, workerArgs: expect.any(Array) });
    expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).not.toContain("ssbt_");
    expect(existsSync(lockPath())).toBe(false);
    // nothing was asked of the site: the request is as the owner's browser would find it
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].cancels).toBe(0);
    expect(site.requests[0].state).not.toBe("cancelled");

    // the owner approves on the site anyway: no later wait takes it back, restarts a worker or records a budget
    approveSetup();
    const stored = readFileSync(join(approvals(), `${id}.json`), "utf8");
    const again = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
    expect(again.code, again.stderr).toBe(5);
    expect(again.result).toMatchObject({ state: "unknown", final: true, id, abandonedAt: gone.result.abandonedAt });
    expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).toBe(stored);
    expect(record(id).resumes).toBeUndefined();
    expect(existsSync(lockPath())).toBe(false);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    expect(publicFile()).not.toMatch(/^APPROVALS=/m);
    expect(site.posts).toHaveLength(1);

    // the late approval is on the chain now: the next owner command reads it and refuses, instead of asking for another grant
    const next = await budget(setupArgs());
    expect(next.code, next.stderr + JSON.stringify(next.result)).toBe(3);
    expect(next.result.reason).toMatch(/a budget is live/);
    expect(site.posts).toHaveLength(1);
  }, 300_000);

  it("frees the chain for the next owner command at once", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    // while the abandoned request is open, another owner command is refused for it
    const blocked = await budget(setupArgs());
    expect(blocked.code).toBe(3);
    expect(blocked.result).toMatchObject({ state: "refused_precheck", id });
    const gone = await budget(abandonArgs(id), {}, typed(id));
    expect(gone.code, gone.stderr).toBe(5);
    const next = await budget(setupArgs());
    expect(next.code, next.stderr + JSON.stringify(next.result)).toBe(0);
    expect(next.result).toMatchObject({ state: "waiting_owner" });
    expect(next.result.id).not.toBe(id);
    expect(site.posts).toHaveLength(2);
    await endEveryProcess(next.result.id as string);
  }, 300_000);

  it("stops a restarted worker that is running: it records nothing, and the owner's later approval on the site changes nothing here", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    // the site answers, but not with a final answer: the restarted worker keeps polling
    site.readAnswer = (_r, view) => ({ status: 200, body: { ...view, state: "awaiting_owner", final: false, owner: null } });
    const waiting = await budget(["wait", "--shown", "--id", id, "--timeout", "6"]);
    expect(waiting.code, waiting.stderr).toBe(0);
    expect(record(id).resumes).toBe(1);
    expect(running(id)).toBe(true);

    const gone = await budget(abandonArgs(id), {}, typed(id));
    expect(gone.code, gone.stderr).toBe(5);
    expect(gone.result).toMatchObject({ state: "unknown", final: true, id });
    expect(running(id)).toBe(false);
    expect(existsSync(lockPath())).toBe(false);

    // the request becomes final and approved on the site: the stopped worker is not there to read it, and no wait restarts one
    site.readAnswer = undefined;
    approveSetup();
    await new Promise((x) => setTimeout(x, 3000));
    const later = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
    expect(later.result).toMatchObject({ state: "unknown", final: true, abandonedAt: gone.result.abandonedAt });
    expect(record(id)).toMatchObject({ resumes: 1, final: { code: 5 } });
    expect(running(id)).toBe(false);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    expect(site.requests[0].cancels).toBe(0);
  }, 300_000);

  it("racing a worker's final write: exactly one result is stored, the same one every later wait and abandon answer, and nothing is written twice", async () => {
    for (const delayMs of (process.env.ABANDON_RACE_DELAYS ?? "0,3000,6000,6800,7500").split(",").map(Number)) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      await site.close();
      site = await startFakeSite();
      await fakeChain(0n, 10000n);
      const id = await startSetup();
      await endEveryProcess(id);
      // the owner has approved: the restarted worker will read a final request and record the budget
      approveSetup();
      const restarted = budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
      await new Promise((x) => setTimeout(x, delayMs));
      const gave = await budget(abandonArgs(id), {}, typed(id));
      const waited = await restarted;
      expect([0, 5], `${delayMs}: ${gave.stderr}\n${waited.stderr}`).toContain(gave.code);

      const r = record(id);
      expect(r.final, `${delayMs}`).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain("ssbt_");
      expect(existsSync(lockPath())).toBe(false);
      const stored = readFileSync(join(approvals(), `${id}.json`), "utf8");
      const publicBefore = existsSync(publicPath()) ? publicFile() : "";
      // abandoned: the result is unknown and says so; otherwise the worker's result stood and the give-up answered it
      if (r.abandoned) expect(r.final).toMatchObject({ code: 5, result: { state: "unknown", abandonedAt: expect.any(String) } });
      else expect(r.final).toMatchObject({ code: 0, result: { state: "ok" } });
      expect(gave.result).toMatchObject({ state: r.abandoned ? "unknown" : "ok", final: true });
      // later asks answer that one result and change nothing
      for (const args of [["wait", "--shown", "--id", id, "--timeout", "30"], abandonArgs(id)]) {
        const again = await budget(args, {}, args.includes("--abandon") ? typed(id) : undefined);
        expect(again.result, `${delayMs} ${args.join(" ")}`).toMatchObject({ state: r.abandoned ? "unknown" : "ok", final: true });
      }
      expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).toBe(stored);
      expect(existsSync(publicPath()) ? publicFile() : "").toBe(publicBefore);
      if (publicBefore) for (const key of ["B4_OWNER_ADDRESS", "LINK_ID", "B4_CAP"]) expect(lines(key), `${delayMs} ${key}`).toBeLessThanOrEqual(1);
      expect(site.posts).toHaveLength(1);
      expect(running(id)).toBe(false);
    }
  }, 600_000);

  it("an approval the worker already finished keeps its result: abandon answers it and changes nothing", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    const stored = readFileSync(join(approvals(), `${id}.json`), "utf8");
    const publicBefore = publicFile();
    const gave = await budget(abandonArgs(id));
    expect(gave.code, gave.stderr).toBe(0);
    expect(gave.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    const again = await budget(abandonArgs(id), {}, typed(id));
    expect(again.code, again.stderr).toBe(0);
    expect(again.result).toMatchObject({ state: "ok", final: true });
    expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).toBe(stored);
    expect(publicFile()).toBe(publicBefore);
    expect(record(id).abandoned).toBeUndefined();
  }, 300_000);

  it("a command that only claims to be the approval's worker (its environment variables set by hand) is refused and ends nothing", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    const path = join(approvals(), `${id}.json`);
    // a restarted worker's whole identity, with the takeover marked: what a worker needs to record a result
    const r = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...r, resumes: 1, resume: { takenOver: 1 } }, null, 2) + "\n");
    const before = readFileSync(path, "utf8");
    const claims: Record<string, string>[] = [
      { SUPERSTABLES_BUDGET_APPROVAL_ID: id },
      { SUPERSTABLES_BUDGET_APPROVAL_ID: id, SUPERSTABLES_BUDGET_RESUME: id, SUPERSTABLES_BUDGET_RESUME_GENERATION: "1" },
    ];
    for (const env of claims) {
      for (const terminal of [undefined, typed(id)]) {
        const run = await budget(abandonArgs(id), env, terminal);
        expect(run.code, `${JSON.stringify(env)} ${terminal}: ${run.stderr}`).toBe(3);
        expect(run.result).toMatchObject({ state: "refused_precheck", reason: "owner_terminal_required" });
        expect(readFileSync(path, "utf8")).toBe(before);
        expect(existsSync(lockPath())).toBe(true);
      }
    }
    expect(JSON.parse(before).final).toBeUndefined();
    expect(JSON.parse(before).hosted.token).toMatch(/^ssbt_/);
  }, 300_000);

  it("a command running in a terminal is not given up here: it is stopped there", async () => {
    await fakeChain(0n, 10000n);
    const holder = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    holder.unref();
    try {
      mkdirSync(approvals(), { recursive: true });
      const id = "oa-20261020999999-abcdef01";
      const path = join(approvals(), `${id}.json`);
      writeFileSync(path, JSON.stringify({ id, command: "setup", rail: "evm", chain: "base-sepolia", state: "running", foreground: true, createdAt: new Date().toISOString(), pid: holder.pid, deadline: null }, null, 2) + "\n");
      const before = readFileSync(path, "utf8");
      const run = await budget(abandonArgs(id), {}, typed(id));
      expect(run.code, run.stderr).toBe(2);
      expect(run.stderr).toMatch(/running in a terminal: stop it there/);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(alive(holder.pid!)).toBe(true);
    } finally { try { process.kill(-holder.pid!, "SIGKILL"); } catch { /* gone */ } }
  }, 60_000);

  it("is for owner approvals and buy-once only: a foreground command or an unknown id is refused", async () => {
    await fakeChain(0n, 10000n);
    const none = await budget(abandonArgs("oa-20261020000000-deadbeef"), {}, "x\n");
    expect(none.code).toBe(2);
    expect(none.stderr + none.stdout).toMatch(/buy-once purchase or a background owner approval/);
  }, 60_000);
});
