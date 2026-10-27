// A request signed on this machine (--sign-only), carried to the site by the connector (submit_budget_request), and adopted by
// `wait --site-request`. The money and key property: no request moves money or grants authority unless the agent key here signed
// exactly that request and the owner's wallet approved it; the connector can carry, delay or drop it, never alter, replay, enlarge
// or redirect it; the client reports an outcome only from a confirmed basis, never from what the connector says.
//
// The paths that can break it on this side, each covered below:
//   - a signed record that was never adopted and is past the site's window: expired, nothing sent ("expired")
//   - adopting a request another agent made, or one for other terms: refused before any record changes ("another agent", "other terms")
//   - settling an adopted request without a confirmed basis: the sink parks it ("confirmed basis")
//   - a wait killed while it reads an adopted request: the next one resumes it and settles once ("killed wait")
//   - the access token anywhere but the approval record, mode 600 ("token")
// First against HostedApprovals and a fake superstables.com, then through the real dispatcher and evm rail scripts with a fake
// Base Sepolia RPC. No network, no real key.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, pad, parseAbi, toEventSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HostedAdopted, HostedApprovals, HostedRefusal, HostedSigned, type HostedRecord, type SignedRecord, type SignedRequest } from "../../budget/hosted.js";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { evmOwner, startFakeRpc, startFakeSite, submitSigned, type FakeSite } from "../helpers/fake-site.js";
import type { TestServer } from "../helpers/servers.js";

const KEY = `0x${"11".repeat(32)}` as const;
const OTHER_KEY = `0x${"44".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const GRANT_HASH = `0x${"b2".repeat(32)}`;
const FUND_HASH = `0x${"a1".repeat(32)}`;
const FUND_VALUE = 100_000_000_000_000n;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const approveData = (agent: string, value: bigint) => encodeFunctionData({ abi: erc20, functionName: "approve", args: [agent as `0x${string}`, value] });
const grantTx = (agent: string, cap: bigint) => ({ to: USDC, data: approveData(agent, cap), value: "0x0" });
const PROOF_HEADERS = ["superstables-agent", "superstables-agent-nonce", "superstables-agent-signature", "superstables-agent-timestamp"];

let site: FakeSite;

describe("signed here, adopted by id (HostedApprovals)", () => {
  /** Every request a client sends that is not to the fake site's reads: none may leave a --sign-only client. */
  let sent: string[];
  const noNetwork: typeof fetch = (input) => { sent.push(String(input)); return Promise.reject(new Error("no network in --sign-only")); };

  beforeEach(async () => {
    site = await startFakeSite();
    site.owner = OWNER;
    site.features = ["expected_owner", "owner_proof_v2"];
    sent = [];
  });
  afterEach(async () => { await site.close(); });

  type Ask = (c: HostedApprovals) => Promise<unknown>;
  const grant = (agent: string, cap: bigint): Ask => (c) => c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: grantTx(agent, cap), terms: TERMS, timeoutMs: 60_000 });
  const THEN = (agent: string) => [{ kind: "fund_agent" as const, transaction: { to: agent, data: "0x", value: "0x5af3107a4000" } }, { kind: "grant" as const, transaction: grantTx(agent, 10000n) }];
  const bundle = (agent: string): Ask => (c) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN(agent), expectedOwner: OWNER });

  async function sign(key: typeof KEY, ask: Ask) {
    let kept: SignedRecord | undefined;
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: key, fetchImpl: noNetwork, signOnly: (_r, rec) => { kept = rec; } });
    const err = await ask(c).catch((e) => e);
    expect(err).toBeInstanceOf(HostedSigned);
    return { request: (err as HostedSigned).request, record: kept! };
  }
  async function submit(request: SignedRequest) {
    const out = await submitSigned(site, request);
    if ("error" in out) throw new Error(out.error);
    return { requestId: out.request_id, link: out.approval_link, matchCode: out.match_code };
  }
  async function adopt(key: typeof KEY, signed: SignedRecord, given: { requestId: string; link: string; matchCode: string }, ask: Ask) {
    let adopted: HostedRecord | undefined;
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: key, adopt: { signed, ...given, onAdopt: (r) => { adopted = r; } } });
    const err = await ask(c).catch((e) => e);
    return { err, adopted };
  }

  it("--sign-only signs the body the create path sends, with the four agent proof headers, and sends nothing", async () => {
    for (const ask of [grant(AGENT, 10000n), bundle(AGENT)]) {
      const posted = site.posts.length;
      const { request, record } = await sign(KEY, ask);
      expect(sent).toEqual([]);
      expect(site.posts).toHaveLength(posted);
      expect(Object.keys(request.headers).sort()).toEqual(PROOF_HEADERS);
      expect(request).toMatchObject({ method: "POST", headers: { "superstables-agent": AGENT, "superstables-agent-nonce": record.signed.nonce, "superstables-agent-timestamp": String(record.signed.signedAt) } });
      expect(record).toMatchObject({ site: site.url, resumable: true, intent: expect.any(String), signed: { path: request.path, body: request.body } });
      // the same ask through the create path: the site receives that same body
      const direct = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
      await ask(direct);
      expect(JSON.parse(request.body)).toEqual(site.requests.at(-1)!.body);
      await direct.close();
    }
    expect(JSON.parse((await sign(KEY, bundle(AGENT))).request.body)).toMatchObject({ expected_owner: OWNER, owner_proof_version: 2 });
  });

  it("adopt: the connector's request is checked, gets a fresh token signed by this agent's key, and is recorded", async () => {
    for (const ask of [grant(AGENT, 10000n), bundle(AGENT)]) {
      const { request, record } = await sign(KEY, ask);
      const given = await submit(request);
      const r = site.requests.at(-1)!;
      const connectorToken = r.token;
      const { err, adopted } = await adopt(KEY, record, given, ask);
      expect(err).toBeInstanceOf(HostedAdopted);
      expect(adopted).toMatchObject({ site: site.url, requestId: given.requestId, matchCode: given.matchCode, kind: record.kind, resumable: true, intent: record.intent, signed: record.signed });
      expect(r.renewals).toBe(1);
      expect(adopted!.token).toBe(r.token);
      expect(adopted!.token).not.toBe(connectorToken);
      expect(adopted!.deadline).toBeLessThanOrEqual(adopted!.expiresAt!);
      // the token the connector was given no longer reads the request, and nothing was cancelled
      expect((await fetch(`${site.url}/api/v1/budget/requests/${r.id}`, { headers: { authorization: `Bearer ${connectorToken}` } })).status).toBe(401);
      expect(r.cancels).toBe(0);
    }
  });

  it("another agent: a request another agent's key made is refused before anything is recorded", async () => {
    const mine = await sign(KEY, grant(AGENT, 10000n));
    const otherAgent = privateKeyToAccount(OTHER_KEY).address;
    const theirs = await sign(OTHER_KEY, grant(otherAgent, 10000n));
    const given = await submit(theirs.request);
    const { err, adopted } = await adopt(KEY, mine.record, given, grant(AGENT, 10000n));
    expect(err).toBeInstanceOf(HostedRefusal);
    expect((err as HostedRefusal).message).toMatch(/not adopted: another agent's key made that request\. Nothing was recorded/);
    expect((err as HostedRefusal).sending).toBe(false);
    expect(adopted).toBeUndefined();
    expect(site.requests[0].renewals).toBeUndefined();
    expect(site.requests[0].cancels).toBe(0);
  });

  it("other terms: a request this agent signed for another amount, or another kind, is refused before anything is recorded", async () => {
    const small = await sign(KEY, grant(AGENT, 10000n));
    const large = await sign(KEY, grant(AGENT, 20000n));
    const given = await submit(large.request);
    const a = await adopt(KEY, small.record, given, grant(AGENT, 10000n));
    expect((a.err as HostedRefusal).message).toMatch(/not adopted: it has another transaction\. Nothing was recorded/);
    expect(a.adopted).toBeUndefined();
    // the command itself now asks for something else than the record signed
    const b = await adopt(KEY, small.record, given, grant(AGENT, 20000n));
    expect((b.err as HostedRefusal).message).toMatch(/this command no longer asks for what was signed/);
    // a link's record with an approval's id
    const link = await sign(KEY, bundle(AGENT));
    const c = await adopt(KEY, link.record, given, bundle(AGENT));
    expect((c.err as HostedRefusal).message).toMatch(/the id of a request to add an agent starts with bl_/);
    expect(site.requests[0].cancels).toBe(0);
  });

  it("other terms on a link: other steps, no expected owner or no owner proof v2 in the site's read are refused", async () => {
    const { request, record } = await sign(KEY, bundle(AGENT));
    const given = await submit(request);
    for (const change of [
      (v: any) => ({ ...v, steps: v.steps.slice(0, 1) }),
      (v: any) => ({ ...v, steps: [v.steps[0], { ...v.steps[1], transaction: grantTx(AGENT, 20000n) }] }),
      (v: any) => { const { expected_owner: _drop, ...rest } = v; return rest; },
      (v: any) => ({ ...v, owner_proof_version: 1 }),
      (v: any) => ({ ...v, chain: { key: "arc-testnet" } }),
      (v: any) => { const { agent: _drop, ...rest } = v; return rest; },
    ]) {
      site.readAnswer = (_r, v) => ({ status: 200, body: change(v) });
      const { err, adopted } = await adopt(KEY, record, given, bundle(AGENT));
      expect(err).toBeInstanceOf(HostedRefusal);
      expect((err as HostedRefusal).message).toMatch(/not adopted: .*Nothing was recorded/);
      expect(adopted).toBeUndefined();
    }
  });

  it("values that are not the site's own for that request are refused before the site is asked", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    const before = site.posts.length;
    const other = new URL(given.link);
    for (const bad of [
      { requestId: given.requestId.replace(/^ba_/, "bl_") },
      { link: given.link.replace(site.url, "https://www.superstables.com") },
      { link: `${site.url}/approve/budget/ba_other0001${other.hash}` },
      { link: `${site.url}/approve/budget/${given.requestId}?x=1${other.hash}` },
      { link: `${site.url}/approve/budget/${given.requestId}` },
      { link: `${given.link} ` },
      { matchCode: "abc-def" },
    ]) {
      const { err, adopted } = await adopt(KEY, record, { ...given, ...bad }, grant(AGENT, 10000n));
      expect(err, JSON.stringify(bad)).toBeInstanceOf(HostedRefusal);
      expect(adopted).toBeUndefined();
    }
    expect(site.posts.length).toBe(before);
    expect(site.requests[0].renewals).toBeUndefined();
  });

  it("a read that fails records nothing; one that shows the wallet was asked is unknown, never nothing sent", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    site.readAnswer = () => ({ status: 503, body: { error: { code: "unavailable" } } });
    const a = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect((a.err as HostedRefusal).message).toMatch(/could not be read back/);
    expect((a.err as HostedRefusal).sending).toBe(false);
    site.readAnswer = () => ({ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } });
    const b = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect((b.err as HostedRefusal).sending).toBe(true);
    expect(b.adopted).toBeUndefined();
  });

  it("confirmed basis: once adopted, a restarted worker parks on anything the site did not confirm, and settles on a final read", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    const { adopted } = await adopt(KEY, record, given, grant(AGENT, 10000n));
    const unresolved: string[] = [];
    let taken = 0;
    const restarted = () => new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, resumable: true, sendingGraceMs: 50, quietGraceMs: 50, resume: { ...adopted!, deadline: Date.now() - 1000 }, onTakeover: () => taken++, onUnresolved: (why) => { unresolved.push(why); } });
    const r = site.requests[0];
    site.cancelFails = true;
    let reads = 0;
    site.readAnswer = (_r, v) => (++reads === 1 ? { status: 200, body: { ...v, state: "sending", wallet_asked: true, final: false } } : { status: 503, body: {} });
    const parked = await grant(AGENT, 10000n)(restarted()) as { settled: Promise<unknown> };
    expect(await Promise.race([parked.settled.then(() => "settled"), new Promise((x) => setTimeout(() => x("open"), 4000))])).toBe("open");
    expect(unresolved).toHaveLength(1);
    // the owner's transaction is reported: the next worker settles on that read
    site.readAnswer = undefined;
    Object.assign(r, { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    const done = await grant(AGENT, 10000n)(restarted()) as { settled: Promise<unknown> };
    expect(await done.settled).toMatchObject({ status: "sent", hash: GRANT_HASH });
    expect(unresolved).toHaveLength(1);
    expect(taken).toBeGreaterThanOrEqual(1);
  });
});

// ── through the dispatcher ──────────────────────────────────────────────────────────────────────────────────────────────

let home: string;
let rpc: TestServer | undefined;
let tree: EndpointTree;
const chain = { approved: false };

type Run = { code: number; stdout: string; stderr: string; result: any };
const outputs: string[] = [];
function start(args: string[]): { child: ChildProcess; done: Promise<Run> } {
  const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc!.url };
  for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME", "SUPERSTABLES_BUDGET_SIGN_ONLY", "SUPERSTABLES_BUDGET_ADOPT"]) delete env[k];
  tree.set({ "base-sepolia": [{ url: rpc!.url, operator: "fake-a" }, { url: `${rpc!.url}/`, operator: "fake-b" }] });
  const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
  const done = new Promise<Run>((ok, fail) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => (stdout += String(c)));
    child.stderr!.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      outputs.push(stdout, stderr);
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      ok({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
  return { child, done };
}
const budget = (args: string[]) => start(args).done;

const approvals = () => join(home, "budget", "approvals");
const publicPath = () => join(home, "budget", "public", "evm-base-sepolia.env");
const publicFile = () => readFileSync(publicPath(), "utf8");
const recordPath = (id: string) => join(approvals(), `${id}.json`);
const record = (id: string) => JSON.parse(readFileSync(recordPath(id), "utf8"));
const lockPath = () => join(approvals(), "active-evm-base-sepolia");
const lines = (key: string) => publicFile().split("\n").filter((l) => l.startsWith(`${key}=`)).length;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function endEveryProcess(id: string) {
  const r = record(id);
  for (const pgid of [r.pid, r.railPgid]) if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ } }
  for (let i = 0; i < 100 && [r.pid, r.railPgid].some((p) => p && alive(p)); i++) await new Promise((x) => setTimeout(x, 50));
}

const approvalLog = (owner: string, spender: string, value: bigint) => ({
  address: USDC,
  topics: [toEventSelector("Approval(address,address,uint256)"), pad(owner.toLowerCase() as `0x${string}`), pad(spender.toLowerCase() as `0x${string}`)],
  data: `0x${value.toString(16).padStart(64, "0")}`, blockNumber: "0x20", logIndex: "0x0", transactionIndex: "0x0", removed: false,
});
/** A chain that shows the owner's transactions once `chain.approved` is set, with the allowance before and after. */
async function fakeChain(allowanceAfter: bigint) {
  chain.approved = false;
  const txs: Record<string, { to: string; input: string; value: bigint; logs: unknown[] }> = {
    [FUND_HASH]: { to: AGENT, input: "0x", value: FUND_VALUE, logs: [] },
    [GRANT_HASH]: { to: USDC, input: approveData(AGENT, 10000n), value: 0n, logs: [approvalLog(OWNER, AGENT, 10000n)] },
  };
  const blockHash = `0x${"ef".repeat(32)}`;
  await rpc?.close();
  rpc = await startFakeRpc(84532, (method, params) => {
    if (method === "eth_blockNumber") return chain.approved ? "0x20" : "0x10";
    const t = txs[params[0]];
    if (method === "eth_getTransactionByHash" && t) return { hash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, input: t.input, value: `0x${t.value.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
    if (method === "eth_getTransactionReceipt" && t) return { transactionHash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, status: "0x1", logs: t.logs, gasUsed: "0x10000", cumulativeGasUsed: "0x10000", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
    if (method === "eth_call" && String(params[0]?.data).startsWith("0xdd62ed3e")) return `0x${(chain.approved ? allowanceAfter : 0n).toString(16).padStart(64, "0")}`;
    if (method === "eth_getBalance" && String(params[0]).toLowerCase() === AGENT.toLowerCase()) return `0x${(10n ** 18n + (chain.approved ? FUND_VALUE : 0n)).toString(16)}`;
    return undefined;
  });
}
/** The agent key, and the owner on record (with the chain's approvals on the site when `hosted`). */
function onRecord(hosted: boolean) {
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${KEY}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  writeFileSync(publicPath(), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n${hosted ? `APPROVALS=hosted\nSITE=${site.url}\n` : ""}`);
}
/** Every file under the client home but the approval records: logs, the approvals log, public and key files. */
function filesOutsideRecords(dir = home): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesOutsideRecords(p);
    return /\/approvals\/oa-[^/]+\.json$/.test(p) ? [] : [readFileSync(p, "utf8")];
  });
}
const grantArgs = ["grant", "--rail", "evm", "--amount", "0.01"];
const adoptArgs = (id: string, v: { request_id: string; approval_link: string; match_code: string }) => ["wait", "--id", id, "--site-request", v.request_id, "--link", v.approval_link, "--match", v.match_code];
async function connector(request: SignedRequest) {
  const out = await submitSigned(site, request);
  if ("error" in out) throw new Error(out.error);
  return out;
}

describe("signed here, adopted by id (the dispatcher)", () => {
  beforeAll(() => { tree = endpointTree(); });
  afterAll(() => tree.close());
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ss-budget-adopt-"));
    site = await startFakeSite();
    site.owner = OWNER;
    site.features = ["expected_owner", "owner_proof_v2"];
    outputs.length = 0;
    await fakeChain(10000n);
  });
  afterEach(async () => {
    await site.close();
    await rpc?.close();
    rpc = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("expired: grant --sign-only prints one signed request, keeps it mode 600 and sends nothing; wait says signed, then expired with nothing sent", async () => {
    onRecord(true);
    const signed = await budget([...grantArgs, "--sign-only"]);
    expect(signed.code, signed.stderr).toBe(0);
    expect(signed.result).toMatchObject({ command: "grant", state: "signed", final: false, id: expect.stringMatching(/^oa-/), expires: expect.any(String), request: { method: "POST", path: "/api/v1/budget/approvals" } });
    const id = signed.result.id;
    // the block before the RESULT is the same request
    expect(JSON.parse(signed.stdout.slice(0, signed.stdout.indexOf("\nRESULT ")))).toEqual(signed.result.request);
    expect(Object.keys(signed.result.request.headers).sort()).toEqual(PROOF_HEADERS);
    expect(site.posts).toEqual([]);
    expect(site.requests).toEqual([]);
    expect(statSync(recordPath(id)).mode & 0o777).toBe(0o600);
    expect(record(id).hosted).toMatchObject({ kind: "grant", resumable: true, signed: { body: signed.result.request.body, nonce: signed.result.request.headers["superstables-agent-nonce"] } });
    // a signed request holds no chain
    expect(existsSync(lockPath())).toBe(false);

    const early = await budget(["wait", "--id", id]);
    expect(early.code, early.stderr).toBe(0);
    expect(early.result).toMatchObject({ state: "signed", final: false, id, expires: signed.result.expires });
    expect(early.result.next).toContain(`superstables budget wait --id ${id} --site-request REQUEST_ID`);

    // never adopted, and past the site's window
    const r = record(id);
    r.hosted.signed.signedAt -= 301;
    writeFileSync(recordPath(id), JSON.stringify(r));
    const late = await budget(["wait", "--id", id, "--shown"]);
    expect(late.code, late.stderr).toBe(3);
    expect(late.result).toMatchObject({ command: "grant", state: "refused_precheck", final: true, id });
    expect(late.result.reason).toMatch(/expired.*Nothing was sent from this machine/);
    expect(late.result.next).toContain("--sign-only");
    expect(record(id).final.code).toBe(3);
    expect(site.posts).toEqual([]);
    // the next owner command signs afresh
    const again = await budget([...grantArgs, "--sign-only"]);
    expect(again.result).toMatchObject({ state: "signed" });
    expect(again.result.id).not.toBe(id);
  }, 120_000);

  it("refuses --sign-only where nothing could adopt it, and with flags that send or wait", async () => {
    onRecord(false);
    for (const args of [[...grantArgs, "--sign-only"], ["setup", "--rail", "evm", "--sign-only"], ["recover", "--rail", "evm", "--sign-only"], ["grant", "--rail", "tempo", "--amount", "1", "--sign-only"], [...grantArgs, "--sign-only", "--detach"]]) {
      const out = await budget(args);
      expect(out.code, args.join(" ")).toBe(2);
      expect(out.result.reason).toMatch(/sign-only/);
    }
    expect(site.posts).toEqual([]);
  }, 60_000);

  it("setup --hosted --grant --fund --sign-only, sent by the connector and adopted by wait --site-request, ends final once the owner approves; the token never leaves the mode-600 record", async () => {
    onRecord(false);
    const signed = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund", "--sign-only"]);
    expect(signed.code, signed.stderr).toBe(0);
    expect(signed.result).toMatchObject({ command: "setup", state: "signed", request: { path: "/api/v1/budget/links" } });
    expect(JSON.parse(signed.result.request.body)).toMatchObject({ agent: AGENT, expected_owner: OWNER, owner_proof_version: 2, then: [{ kind: "fund_agent" }, { kind: "grant" }] });
    expect(site.posts).toEqual([]);
    const id = signed.result.id;

    const v = await connector(signed.result.request);
    const adopted = await budget(adoptArgs(id, v));
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(adopted.result).toMatchObject({ command: "setup", state: "waiting_owner", final: false, id, url: v.approval_link, matchCode: v.match_code });
    expect(adopted.result.message_for_owner).toContain(v.approval_link);
    expect(adopted.result.next).toContain(`superstables budget wait --id ${id} --shown`);
    const r = site.requests[0];
    expect(record(id).hosted).toMatchObject({ requestId: v.request_id, token: r.token, signed: { nonce: signed.result.request.headers["superstables-agent-nonce"] } });
    expect(statSync(recordPath(id)).mode & 0o777).toBe(0o600);

    // the owner adds the agent, sends it gas and grants the budget on the site
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "setup", state: "ok", final: true, owner: OWNER, steps: [{ state: "settled" }, { state: "settled" }] });
    for (const key of ["B4_OWNER_ADDRESS", "LINK_ID", "B4_CAP"]) expect(lines(key), key).toBe(1);
    expect(publicFile()).toMatch(new RegExp(`^LINK_ID=${v.request_id}$`, "m"));
    // one request created (the connector's) and one token renewal (the adoption); nothing else was asked of the site
    expect(site.posts.map((p) => p.path)).toEqual(["/api/v1/budget/links", `/api/v1/budget/requests/${v.request_id}/token`]);
    expect(record(id).hosted.token).toBeUndefined();

    // token: never in any output, log or file but the approval record
    const tokens = [r.token, ...Array.from({ length: r.renewals ?? 0 }, (_, i) => `ssbt_test_${r.id}renewed${i + 1}`)];
    for (const text of [...outputs, ...filesOutsideRecords()]) for (const t of tokens) expect(text).not.toContain(t);
  }, 300_000);

  it("another agent, other terms: adopting either is refused, the record stays byte for byte, and the chain stays free", async () => {
    onRecord(true);
    const signed = await budget([...grantArgs, "--sign-only"]);
    const id = signed.result.id;
    const before = readFileSync(recordPath(id), "utf8");
    const otherAgent = privateKeyToAccount(OTHER_KEY).address;
    const signWith = async (key: typeof KEY, agent: string, cap: bigint) => {
      let request: SignedRequest | undefined;
      const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: key, signOnly: (req) => { request = req; } });
      await c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: grantTx(agent, cap), terms: TERMS, timeoutMs: 60_000 }).catch(() => {});
      return request!;
    };
    for (const [request, why] of [[await signWith(OTHER_KEY, otherAgent, 10000n), /another agent's key made that request/], [await signWith(KEY, AGENT, 20000n), /it has another transaction/]] as const) {
      const v = await connector(request);
      const out = await budget(adoptArgs(id, v));
      expect(out.code, out.stderr).toBe(3);
      expect(out.result).toMatchObject({ command: "wait", state: "refused_precheck", final: false, id });
      expect(out.result.reason).toMatch(why);
      expect(readFileSync(recordPath(id), "utf8")).toBe(before);
      expect(existsSync(lockPath())).toBe(false);
    }
    expect(site.requests.map((r) => r.cancels)).toEqual([0, 0]);
    // the signed approval can still adopt its own request
    const v = await connector(signed.result.request);
    const own = await budget(adoptArgs(id, v));
    expect(own.code, own.stderr).toBe(0);
    expect(own.result).toMatchObject({ state: "waiting_owner", id });
  }, 240_000);

  it("killed wait: a wait killed while it reads an adopted request is resumed by the next one, which settles once", async () => {
    onRecord(true);
    const signed = await budget([...grantArgs, "--sign-only"]);
    const id = signed.result.id;
    const v = await connector(signed.result.request);
    expect((await budget(adoptArgs(id, v))).code).toBe(0);
    // a wait that reads, killed mid-poll together with the worker it was reading
    const reading = start(["wait", "--shown", "--id", id, "--timeout", "60"]);
    await new Promise((x) => setTimeout(x, 3000));
    reading.child.kill("SIGKILL");
    await reading.done;
    await endEveryProcess(id);
    expect(record(id).final).toBeUndefined();
    expect(record(id).hosted.token).toBeTruthy();

    Object.assign(site.requests[0], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "grant", state: "settled", final: true, amount: "0.01", tx: { grant: GRANT_HASH } });
    expect(lines("B4_CAP")).toBe(1);
    const later = await budget(["wait", "--shown", "--id", id]);
    expect(later.result).toMatchObject({ state: "settled", final: true });
    expect(lines("B4_CAP")).toBe(1);
    // a rerun of the adoption itself answers the same final result
    const rerun = await budget(adoptArgs(id, v));
    expect(rerun.result).toMatchObject({ state: "settled", final: true });
    expect(site.posts.filter((p) => p.path === "/api/v1/budget/approvals")).toHaveLength(1);
    expect(existsSync(lockPath())).toBe(false);
  }, 300_000);
});
