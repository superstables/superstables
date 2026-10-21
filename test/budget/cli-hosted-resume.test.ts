// A host that ends every process of a command when the command ends (Codex does) takes the detached approval worker with it
// before the owner approves. The next `wait` finishes the hosted request from the site's record of it, and records what the
// worker would have recorded. The real dispatcher (budget/cli.mjs) and the real evm rail scripts, against a fake
// superstables.com and a fake Base Sepolia RPC on 127.0.0.1. No network, no real key.
//
// The property, on every path: after the owner approves, exactly one local budget record exists, whether it came from the
// worker, a later command, both or a retry; and nothing new is asked of the owner before the recorded request is reconciled.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
function budget(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc!.url };
    for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME"]) delete env[k];
    Object.assign(env, extraEnv);
    tree.set({ "base-sepolia": [{ url: rpc!.url, operator: "fake-a" }, { url: `${rpc!.url}/`, operator: "fake-b" }], "arc-testnet": [{ url: rpc!.url, operator: "fake-a" }] });
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
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

describe("setup --hosted --grant --fund, when the host ends the worker before the owner approves", () => {
  it("wait finishes it from the site's request: the same result and the same local records, recorded once", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    expect(record(id)).toMatchObject({ hosted: { resumable: true, kind: "link", then: ["fund_agent", "grant"] }, workerArgs: expect.any(Array) });
    await endEveryProcess(id);
    // the worker never recorded anything: the owner's approval would land on the site with nothing here to take it
    expect(publicFile()).not.toMatch(/^APPROVALS=/m);
    approveSetup();

    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({
      ok: true, command: "setup", state: "ok", final: true, owner: OWNER, agent: AGENT, approvals: "hosted", site: site.url, linked: true,
      amount: "0.01", remaining: "0.01", tx: { fundAgent: FUND_HASH, grant: GRANT_HASH },
      steps: [{ kind: "fund_agent", state: "settled", tx: FUND_HASH }, { kind: "grant", state: "settled", tx: GRANT_HASH }],
    });
    // the request the first worker made was finished: the site saw one request and no other POST, and nothing was cancelled
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests).toHaveLength(1);
    expect(site.requests[0].cancels).toBe(0);
    for (const key of ["B4_OWNER_ADDRESS", "APPROVALS", "SITE", "LINK_ID", "LINK_CODE", "B4_CAP", "B4_SET_TX"]) expect(lines(key), key).toBe(1);
    expect(publicFile()).toMatch(/^B4_CAP=10000$/m);
    expect(publicFile()).toMatch(new RegExp(`^B4_SET_TX=${GRANT_HASH}$`, "m"));
    expect(publicFile()).toMatch(/^LINK_ID=bl_test0001$/m);
    // one restart, the access token gone, the chain free
    expect(record(id)).toMatchObject({ resumes: 1, final: { code: 0 } });
    expect(readFileSync(join(approvals(), `${id}.json`), "utf8")).not.toContain("ssbt_");
    expect(existsSync(lockPath())).toBe(false);

    // asking again changes nothing: the stored answer, the same records
    const before = publicFile();
    const again = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
    expect(again.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(publicFile()).toBe(before);
    expect(record(id).resumes).toBe(1);
  }, 240_000);

  it("the worker finishes first (a host that keeps it): a later wait starts nothing and records nothing more", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER, steps: [{ state: "settled" }, { state: "settled" }] });
    // no worker was started again
    expect(record(id).resumes).toBeUndefined();
    const before = publicFile();
    const later = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
    expect(later.result).toMatchObject({ state: "ok", final: true });
    expect(publicFile()).toBe(before);
    for (const key of ["B4_OWNER_ADDRESS", "LINK_ID", "B4_CAP"]) expect(lines(key), key).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 240_000);

  it("before the owner approves: wait neither cancels nor ends the request, and nothing new is asked while it is open", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    // the chain's lock was taken by a command that has long exited: it is not a reason to start another request
    const lock = JSON.parse(readFileSync(lockPath(), "utf8"));
    writeFileSync(lockPath(), JSON.stringify({ ...lock, createdAt: Date.now() - 10 * 60_000 }));

    const early = await budget(["wait", "--shown", "--id", id, "--timeout", "3"]);
    expect(early.result).toMatchObject({ state: "waiting_owner", id });
    expect(site.requests[0]).toMatchObject({ state: "awaiting_owner", cancels: 0 });
    expect(record(id).final).toBeUndefined();

    // a retry, or another owner command, is refused until this one is reconciled: no second request
    const retry = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(retry.code).toBe(3);
    expect(retry.result).toMatchObject({ state: "refused_precheck", id });
    expect(retry.result.next).toContain(`superstables budget wait --id ${id} --shown`);
    const grant = await budget(["grant", "--rail", "evm", "--amount", "0.01"]);
    expect(grant.result).toMatchObject({ state: "refused_precheck", id });
    expect(site.requests).toHaveLength(1);

    // the owner approves after the early wait ended (its restarted worker was ended with it): the next wait finishes it
    await endEveryProcess(id);
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(record(id).resumes).toBe(2);
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
    expect(site.requests[0].cancels).toBe(0);
  }, 300_000);

  it("two waits at once start one worker; both answer with the one result", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    approveSetup();
    const [a, b] = await Promise.all([budget(["wait", "--shown", "--id", id, "--timeout", "120"]), budget(["wait", "--shown", "--id", id, "--timeout", "120"])]);
    expect(a.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(b.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(record(id).resumes).toBe(1);
    for (const key of ["B4_OWNER_ADDRESS", "LINK_ID", "B4_CAP", "B4_SET_TX"]) expect(lines(key), key).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 300_000);

  it("a worker that is ended again after taking the request over: the next wait finishes it, and the records are still one", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    const early = await budget(["wait", "--shown", "--id", id, "--timeout", "2"]);
    expect(early.result.state).toBe("waiting_owner");
    await endEveryProcess(id);
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true });
    expect(record(id).resumes).toBe(2);
    for (const key of ["B4_OWNER_ADDRESS", "LINK_ID", "B4_CAP"]) expect(lines(key), key).toBe(1);
  }, 300_000);

  it("the owner approved in time and the request has expired on the site since: still finished, not called expired", async () => {
    await fakeChain(0n, 10000n);
    site.expiresInMs = 2500;
    const id = await startSetup();
    await endEveryProcess(id);
    approveSetup();
    await new Promise((r) => setTimeout(r, 3000));
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.requests[0].cancels).toBe(0);
  }, 300_000);

  it("a request nobody approved, expired on the site: refused (nothing sent), the chain is free again", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    Object.assign(site.requests[0], { state: "expired", reason: "the link expired", reason_code: "expired" });
    for (const s of site.requests[0].steps!) Object.assign(s, { state: "skipped" });
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "60"]);
    expect(done.result).toMatchObject({ final: true, state: "refused_precheck", linked: false });
    expect(done.code).toBe(3);
    expect(done.result.reason).toMatch(/expired|nothing was sent/i);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    expect(existsSync(lockPath())).toBe(false);
    expect(site.posts).toHaveLength(1);
  }, 240_000);

  it("a record whose request is not the one the command asks for: nothing is created or cancelled, and the approval stays open however often wait is run", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    const path = join(approvals(), `${id}.json`);
    const r = record(id);
    writeFileSync(path, JSON.stringify({ ...r, hosted: { ...r.hosted, intent: "0".repeat(64) } }));
    approveSetup();
    for (let n = 1; n <= 2; n++) {
      const w = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
      expect(w.code).toBe(5);
      expect(w.result).toMatchObject({ state: "unknown", final: false });
      expect(record(id).final).toBeUndefined();
      expect(record(id).resumes).toBe(n);
    }
    expect(readFileSync(join(approvals(), `${id}.log`), "utf8")).toMatch(/cannot be finished: this command asks for something other than the recorded request/);
    expect(site.posts).toHaveLength(1);
    expect(site.requests[0].cancels).toBe(0);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    expect(record(id).hosted.token).toMatch(/^ssbt_/);
    expect(existsSync(lockPath())).toBe(true);
    // the record is put right: the next wait finishes it
    writeFileSync(path, JSON.stringify({ ...record(id), hosted: { ...record(id).hosted, intent: r.hosted.intent } }));
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true });
    expect(lines("B4_CAP")).toBe(1);
  }, 300_000);

  it("only the rail script of the first worker is gone (the worker itself runs on): nothing is called failed, and wait finishes the approval", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    const r = record(id);
    process.kill(-r.railPgid, "SIGKILL");
    // the worker sees its rail script end with no RESULT
    for (let i = 0; i < 100 && alive(r.pid); i++) await new Promise((x) => setTimeout(x, 100));
    expect(alive(r.pid)).toBe(false);
    expect(record(id).final).toBeUndefined();
    expect(record(id).hosted.token).toMatch(/^ssbt_/);
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 300_000);

  it("the restarted worker stops while this wait is still reading: nothing is decided, and the next wait finishes the approval", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    const waiting = budget(["wait", "--shown", "--id", id, "--timeout", "40"]);
    // the restarted worker is recorded once it started
    for (let i = 0; i < 300 && !(record(id).resumes && record(id).resume?.takenOver === record(id).resumes); i++) await new Promise((x) => setTimeout(x, 100));
    // it has read the request on the site: this is a worker that had the request in hand when it was ended
    expect(record(id).resume?.takenOver).toBe(record(id).resumes);
    await endEveryProcess(id);
    const stopped = await waiting;
    expect(stopped.code).toBe(5);
    expect(stopped.result).toMatchObject({ state: "unknown", final: false });
    expect(record(id).final).toBeUndefined();
    expect(site.requests[0]).toMatchObject({ state: "awaiting_owner", cancels: 0 });
    expect(existsSync(lockPath())).toBe(true);
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 300_000);

  it("a worker that starts after its approval has ended does nothing: no chain lock, no new approval, no request", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true });
    const files = () => readdirSync(approvals()).filter((f) => /^oa-.*\.json$/.test(f)).sort();
    const before = files();
    const worker = await budget([...setupArgs(), "--wait", "--no-open"], { SUPERSTABLES_BUDGET_APPROVAL_ID: id, SUPERSTABLES_BUDGET_RESUME: id });
    expect(worker.code).toBe(0);
    expect(worker.stderr).toMatch(/has ended; this worker has nothing to do/);
    expect(files()).toEqual(before);
    expect(existsSync(lockPath())).toBe(false);
    expect(site.posts).toHaveLength(1);
  }, 240_000);

  it("the site taken from SUPERSTABLES_SITE when the command started is the one the restarted worker asks, whatever wait's environment says", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup(["setup", "--rail", "evm", "--hosted", "--grant", "0.01", "--fund"], { SUPERSTABLES_SITE: site.url });
    await endEveryProcess(id);
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true, site: site.url });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 240_000);

  it("a site that cannot be read after the first worker ended decides nothing: the approval stays open, and the next wait finishes it", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    approveSetup();
    site.readAnswer = () => ({ status: 503, body: { error: "unavailable" } });
    const early = await budget(["wait", "--shown", "--id", id, "--timeout", "8"]);
    expect(early.result).toMatchObject({ final: false });
    expect(record(id).final).toBeUndefined();
    expect(site.requests[0].cancels).toBe(0);
    expect(existsSync(lockPath())).toBe(true);
    await endEveryProcess(id);
    site.readAnswer = undefined;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true });
    expect(lines("B4_CAP")).toBe(1);
  }, 300_000);

  it("a worker stopped by SIGTERM (a host that asks politely) leaves the approval open too", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id, "SIGTERM");
    approveSetup();
    // give the worker's own signal handling time to finish what it does
    await new Promise((x) => setTimeout(x, 1500));
    expect(record(id).final).toBeUndefined();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 300_000);
});

describe("an approval the restarted worker cannot read: it parks, holds the chain, and settles once the request is readable", () => {
  const notFound = () => ({ status: 404, body: { error: { code: "not_found", message: "there is no budget request with this id for this token" } } });
  for (const [when, firstRead] of [["on the first read", false], ["after a valid non-final read", true]] as const) {
    it(`a clean JSON 404 ${when}: no result is recorded, the token and the chain lock stay, another owner command is refused; then wait settles it normally`, async () => {
      await fakeChain(0n, 10000n);
      const id = await startSetup();
      await endEveryProcess(id);
      approveSetup();
      let reads = 0;
      site.readAnswer = (_r, view) => (firstRead && ++reads === 1 ? { status: 200, body: { ...view, state: "awaiting_owner", final: false, owner: null } } : notFound());
      const parked = await budget(["wait", "--shown", "--id", id, "--timeout", "25"]);
      expect(parked.code).toBe(5);
      expect(parked.result).toMatchObject({ state: "unknown", final: false });
      // nothing was decided: no final, the token kept, the chain held
      expect(record(id).final).toBeUndefined();
      expect(record(id).hosted.token).toMatch(/^ssbt_/);
      expect(existsSync(lockPath())).toBe(true);
      expect(publicFile()).not.toMatch(/^B4_CAP=/m);
      // another owner command on the chain is refused, and no second request is made
      const other = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
      expect(other.code).toBe(3);
      expect(other.result).toMatchObject({ state: "refused_precheck", id });
      expect(site.posts).toHaveLength(1);
      // the same request is readable as final: the next wait settles it, once
      await endEveryProcess(id);
      site.readAnswer = undefined;
      const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
      expect(done.code, done.stderr).toBe(0);
      expect(done.result).toMatchObject({ state: "ok", final: true, owner: OWNER });
      expect(lines("B4_CAP")).toBe(1);
      expect(record(id).hosted.token).toBeUndefined();
      expect(existsSync(lockPath())).toBe(false);
      expect(site.posts).toHaveLength(1);
    }, 400_000);
  }
});

describe("grant, revoke and fund-agent, when the host ends the worker before the owner approves", () => {
  const start = async (args: string[]) => {
    const first = await budget(args);
    expect(first.code, first.stderr).toBe(0);
    expect(first.result.state).toBe("waiting_owner");
    return first.result.id as string;
  };

  it("grant: the budget is recorded by the later wait (the allowance now reads the cap, which the grant's own refusal would turn away)", async () => {
    hostedChain();
    site.owner = OWNER;
    await fakeChain(0n, 10000n);
    const id = await start(["grant", "--rail", "evm", "--amount", "0.01"]);
    expect(record(id).hosted).toMatchObject({ kind: "grant", resumable: true });
    await endEveryProcess(id);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "grant", state: "settled", final: true, amount: "0.01", tx: { grant: GRANT_HASH } });
    expect(lines("B4_CAP")).toBe(1);
    expect(publicFile()).toMatch(/^B4_CAP=10000$/m);
    expect(site.posts).toHaveLength(1);
    expect(record(id).resumes).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  }, 240_000);

  it("revoke: the revoke is recorded by the later wait, and the budget it ended is no longer recorded", async () => {
    hostedChain("10000");
    site.owner = OWNER;
    await fakeChain(10000n, 0n);
    const id = await start(["revoke", "--rail", "evm"]);
    await endEveryProcess(id);
    expect(publicFile()).toMatch(/^B4_CAP=10000$/m);
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: REVOKE_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "revoke", final: true, tx: { revoke: REVOKE_HASH } });
    expect(done.result.state).toMatch(/^(settled|landed)$/);
    expect(lines("B4_REVOKED_TX")).toBe(1);
    expect(publicFile()).toMatch(new RegExp(`^B4_REVOKED_TX=${REVOKE_HASH}$`, "m"));
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    // the RESULT says what the allowance was before the owner revoked it, as the worker's would
    expect(readFileSync(join(approvals(), `${id}.log`), "utf8")).toMatch(/allowance before: 0\.01/);
    expect(site.posts).toHaveLength(1);
  }, 240_000);

  it("revoke: a site the owner no longer allows is not a reason to ask on the page on this computer: the approval stays open, nothing new is requested", async () => {
    hostedChain("10000");
    site.owner = OWNER;
    await fakeChain(10000n, 0n);
    const id = await start(["revoke", "--rail", "evm"]);
    await endEveryProcess(id);
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: REVOKE_HASH, wallet_asked: true });
    chain.approved = true;
    const noSite = accountHomeWith({ version: 1, rpcEnv: { allowLoopback: true } });
    const stalled = await budget(["wait", "--shown", "--id", id, "--timeout", "20"], { SUPERSTABLES_TEST_ACCOUNT_HOME: noSite });
    expect(stalled.result).toMatchObject({ final: false });
    const r = record(id);
    expect(r.final).toBeUndefined();
    // the recorded hosted request is still there, and no local page was opened for a second revoke
    expect(r.hosted?.token).toMatch(/^ssbt_/);
    expect(String(r.url ?? "")).not.toMatch(/\/owner\/[0-9a-f]{32}/);
    expect(readdirSync(approvals()).filter((f) => /^oa-.*\.json$/.test(f))).toHaveLength(1);
    expect(site.posts).toHaveLength(1);
    // allowed again: finished from the same request
    await endEveryProcess(id);
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "revoke", final: true });
    expect(lines("B4_REVOKED_TX")).toBe(1);
  }, 300_000);

  it("after the first read the site goes quiet past the request's time: the worker leaves with no result, nothing is cancelled or ended, and the next wait finishes it", async () => {
    hostedChain();
    site.owner = OWNER;
    site.expiresInMs = 3000;
    await fakeChain(0n, 10000n);
    const id = await start(["grant", "--rail", "evm", "--amount", "0.01", "--timeout", "10"]);
    await endEveryProcess(id);
    let reads = 0;
    // the site is quiet: it answers neither reads nor the cancel
    site.cancelFails = true;
    site.readAnswer = (_r, view) => (++reads === 1 ? { status: 200, body: { ...view, state: "awaiting_owner", final: false } } : { status: 503, body: {} });
    const quiet = await budget(["wait", "--shown", "--id", id, "--timeout", "55"]);
    expect(quiet.result).toMatchObject({ final: false });
    expect(record(id).final).toBeUndefined();
    expect(record(id).hosted.token).toMatch(/^ssbt_/);
    // the cancel was tried and not answered: the request is not cancelled
    expect(site.requests[0].state).not.toBe("cancelled");
    expect(existsSync(lockPath())).toBe(true);
    await endEveryProcess(id);
    site.readAnswer = undefined;
    site.cancelFails = false;
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "grant", state: "settled", final: true });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
  }, 300_000);

  it("fund-agent: the later wait checks the transfer against the agent's balance from before the owner sent it", async () => {
    hostedChain();
    site.owner = OWNER;
    await fakeChain(0n, 0n);
    const id = await start(["fund-agent", "--rail", "evm"]);
    await endEveryProcess(id);
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "fund-agent", final: true, tx: { fundAgent: FUND_HASH } });
    expect(done.result.state).toMatch(/^(settled|landed)$/);
    expect(site.posts).toHaveLength(1);
  }, 240_000);
});

describe("a restarted worker that runs past its backstop", () => {
  it("leaves the approval open: no result is recorded, the token and the chain stay, and a later wait can still finish it", async () => {
    await fakeChain(0n, 10000n);
    const id = await startSetup();
    await endEveryProcess(id);
    // the site answers, but never with a final answer: the restarted worker takes the request over and keeps polling
    site.readAnswer = (_r, view) => ({ status: 200, body: { ...view, state: "awaiting_owner", final: false, owner: null } });
    // the backstop fires after 7 s; the rail script's stdout stays open for 20 s after the backstop kills it (a process of its own holds
    // it), so the dispatcher cannot end the worker by seeing the rail script leave: the backstop's own code decides what is recorded
    const hooks = ["shorten-worker-backstop", "hold-rail-stdout"].map((name) => `--import ${pathToFileURL(resolve(ROOT, `test/helpers/${name}.mjs`)).href}`);
    const stopped = await budget(["wait", "--shown", "--id", id, "--timeout", "30"], { NODE_OPTIONS: [process.env.NODE_OPTIONS, ...hooks].filter(Boolean).join(" "), BACKSTOP_TEST_MS: "7000", HOLD_RAIL_STDOUT_MS: "20000", HOLD_RAIL_STDOUT_PIDFILE: join(home, "hold-pids") });
    expect(stopped.code, stopped.stderr).toBe(5);
    expect(stopped.result).toMatchObject({ state: "unknown", final: false, id });
    const r = record(id);
    // the worker had the request in hand (so a result could have been recorded), and the backstop is what ended it
    expect(r.resumes).toBe(1);
    expect(r.resume?.takenOver).toBe(1);
    expect(readFileSync(join(approvals(), `${id}.log`), "utf8")).toMatch(/the restarted worker ran past its deadline and recorded no result/);
    expect(r.final).toBeUndefined();
    expect(r.hosted.token).toMatch(/^ssbt_/);
    expect(existsSync(lockPath())).toBe(true);
    expect([r.pid, r.railPgid].some((p) => p && alive(p))).toBe(false);
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
    // the owner approves: the next wait finishes it, once
    site.readAnswer = undefined;
    approveSetup();
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", final: true });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts).toHaveLength(1);
    // the helper process that held the rail script's stdout is not left behind
    if (existsSync(join(home, "hold-pids"))) for (const pid of readFileSync(join(home, "hold-pids"), "utf8").split("\n").filter(Boolean)) { try { process.kill(-Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }, 400_000);
});
