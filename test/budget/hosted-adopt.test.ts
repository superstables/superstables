// A request signed on this machine (--sign-only), carried to the site by the connector (submit_budget_request), and adopted by
// `wait --site-request`. The money and key property: no request moves money or grants authority unless the agent key here signed
// exactly that request and the owner's wallet approved it; the connector can carry, delay or drop it, never alter, replay, enlarge
// or redirect it; the client reports an outcome only from a confirmed basis, never from what the connector says.
//
// The paths that can break it on this side, each covered below:
//   - a signed record that no site request was given for, past the site's window: expired, nothing sent, still adoptable ("expired")
//   - adopting a request another agent made, or one for other terms: refused before any record changes ("another agent", "other terms")
//   - a read during adoption that fails or shows the owner's wallet was asked, before or after adopting, then reads that fail, the
//     window passing after the connector sent it, and a killed wait: unknown until the outcome is final ("wallet maybe asked")
//   - settling an adopted request without a confirmed basis: the sink parks it ("confirmed basis")
//   - a wait killed while it reads an adopted request: the next one resumes it and settles once ("killed wait")
//   - the access token anywhere but the approval record, mode 600 ("token")
// First against HostedApprovals and a fake superstables.com, then through the real dispatcher and evm rail scripts with a fake
// Base Sepolia RPC. No network, no real key.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    let asked: boolean | undefined;
    const kept: { requestId: string; walletAsked: boolean }[] = [];
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: key, adopt: { signed, ...given, onAdopt: (r, _shown, walletAsked) => { adopted = r; asked = walletAsked; }, onUnsettled: (u) => { kept.push(u); } } });
    const err = await ask(c).catch((e) => e);
    return { err, adopted, asked, kept };
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
    expect((err as HostedRefusal).notAdopted).toBe(true);
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

  it("other terms on a link: a complete read with other steps, owner proof or chain is refused; one that leaves a field out or garbles it is kept", async () => {
    const { request, record } = await sign(KEY, bundle(AGENT));
    const given = await submit(request);
    const drop = (key: string) => (v: any) => { const { [key]: _drop, ...rest } = v; return rest; };
    for (const [change, refused] of [
      [(v: any) => ({ ...v, steps: v.steps.slice(0, 1) }), true],
      [(v: any) => ({ ...v, steps: [v.steps[0], { ...v.steps[1], transaction: grantTx(AGENT, 20000n) }] }), true],
      [(v: any) => ({ ...v, owner_proof_version: 1 }), true],
      [(v: any) => ({ ...v, chain: { key: "arc-testnet" } }), true],
      [(v: any) => ({ ...v, expected_owner: privateKeyToAccount(OTHER_KEY).address }), true],
      [(v: any) => ({ ...v, steps: [v.steps[1], v.steps[0]] }), true],
      [drop("expected_owner"), false],
      [(v: any) => ({ ...v, expected_owner: "garbled" }), false],
      [(v: any) => ({ ...v, owner_proof_version: 99 }), false],
      [(v: any) => ({ ...v, owner_proof_version: "2" }), false],
      [(v: any) => ({ ...v, steps: [{ kind: "garbled" }] }), false],
      [(v: any) => ({ ...v, steps: [v.steps[0], { ...v.steps[1], kind: "garbled" }] }), false],
      [(v: any) => ({ ...v, steps: [...v.steps, { kind: "grant" }] }), false],
      [drop("agent"), false],
      [drop("steps"), false],
      [(v: any) => ({ ...v, steps: [v.steps[0], { ...v.steps[1], transaction: { to: "nope" } }] }), false],
      [(v: any) => ({ ...v, agent: "garbled" }), false],
      [(v: any) => ({ ...v, chain: { key: "garbled" } }), false],
    ] as const) {
      site.readAnswer = (_r, v) => ({ status: 200, body: change(v) });
      const { err, adopted, kept } = await adopt(KEY, record, given, bundle(AGENT));
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(adopted).toBeUndefined();
      expect((err as HostedRefusal).notAdopted, String(change)).toBe(refused);
      if (refused) {
        expect((err as HostedRefusal).message).toMatch(/not adopted: .*Nothing was recorded/);
        expect(kept).toEqual([]);
      } else {
        expect((err as HostedRefusal).message).toMatch(/It is kept with this approval/);
        expect((err as HostedRefusal).sending).toBe(true);
        expect(kept).toMatchObject([{ requestId: given.requestId, walletAsked: false }]);
      }
    }
  });

  it("a link without steps: steps that are not an array are kept, alone or beside another difference; none, null or [] adopt", async () => {
    const plain: Ask = (c) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, expectedOwner: OWNER });
    const { request, record } = await sign(KEY, plain);
    expect(JSON.parse(request.body)).toMatchObject({ owner_proof_version: 2 });
    expect(JSON.parse(request.body).then).toBeUndefined();
    const given = await submit(request);
    const step = { kind: "grant", transaction: grantTx(AGENT, 10000n) };
    for (const [changed, outcome] of [
      [{ steps: {} }, "kept"],
      [{ steps: "garbled" }, "kept"],
      [{ steps: 0 }, "kept"],
      [{ steps: true }, "kept"],
      [{ steps: {}, owner_proof_version: 1 }, "kept"],
      [{ steps: "garbled", expected_owner: privateKeyToAccount(OTHER_KEY).address }, "kept"],
      [{ steps: [step] }, "refused"],
      [{ owner_proof_version: 1 }, "refused"],
      [{ steps: null }, "adopted"],
      [{ steps: [] }, "adopted"],
      [{}, "adopted"],
    ] as const) {
      const what = JSON.stringify(changed);
      site.readAnswer = (_r, v) => ({ status: 200, body: { ...(v as object), ...changed } });
      const { err, adopted, kept } = await adopt(KEY, record, given, plain);
      if (outcome === "adopted") {
        expect(err, what).toBeInstanceOf(HostedAdopted);
        continue;
      }
      expect(err, what).toBeInstanceOf(HostedRefusal);
      expect(adopted, what).toBeUndefined();
      expect((err as HostedRefusal).notAdopted, what).toBe(outcome === "refused");
      if (outcome === "kept") {
        expect((err as HostedRefusal).message, what).toMatch(/leaves out, or garbles, what was signed.*It is kept with this approval/);
        expect((err as HostedRefusal).sending, what).toBe(true);
        expect(kept, what).toMatchObject([{ requestId: given.requestId, walletAsked: false }]);
      } else {
        expect(kept, what).toEqual([]);
      }
    }
    expect(site.requests[0].cancels).toBe(0);
  });

  it("other terms on an approval: a read naming another agent, kind or chain the site sends is refused; one with a value the site never sends is kept", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    const otherAgent = privateKeyToAccount(OTHER_KEY).address;
    for (const [changed, refused] of [
      [{ agent: otherAgent }, true],
      [{ kind: "revoke" }, true],
      [{ chain: "arc-testnet" }, true],
      [{ rail: "tempo", chain: "moderato" }, true],
      [{ agent: "" }, false],
      [{ agent: "garbled" }, false],
      [{ kind: "" }, false],
      [{ kind: "garbled" }, false],
      [{ rail: "" }, false],
      [{ rail: "garbled" }, false],
      [{ rail: "solana" }, false],
      [{ chain: "" }, false],
      [{ chain: "garbled" }, false],
    ] as const) {
      const what = JSON.stringify(changed);
      site.readAnswer = (_r, v) => ({ status: 200, body: { ...(v as object), ...changed } });
      const { err, adopted, kept } = await adopt(KEY, record, given, grant(AGENT, 10000n));
      expect(err, what).toBeInstanceOf(HostedRefusal);
      expect(adopted).toBeUndefined();
      expect((err as HostedRefusal).notAdopted, what).toBe(refused);
      expect((err as HostedRefusal).sending, what).toBe(!refused);
      expect(kept, what).toMatchObject(refused ? [] : [{ requestId: given.requestId, walletAsked: false }]);
      if (!refused) expect((err as HostedRefusal).message, what).toMatch(/leaves out, or garbles, what was signed.*It is kept with this approval/);
    }
    expect(site.requests[0].cancels).toBe(0);
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

  it("this agent's request whose read fails, or shows the wallet was asked, is kept before the refusal and is unknown, never nothing sent; an adopted one keeps the evidence", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    site.readAnswer = () => ({ status: 503, body: { error: { code: "unavailable" } } });
    const a = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect((a.err as HostedRefusal).message).toMatch(/could not be read back.*It is kept with this approval/);
    expect((a.err as HostedRefusal).message).not.toMatch(/Nothing was recorded|nothing was sent/i);
    expect((a.err as HostedRefusal).sending).toBe(true);
    expect(a.kept).toMatchObject([{ requestId: given.requestId, link: given.link, matchCode: given.matchCode, walletAsked: false }]);
    site.readAnswer = () => ({ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } });
    const b = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect((b.err as HostedRefusal).sending).toBe(true);
    expect(b.adopted).toBeUndefined();
    expect(b.kept).toMatchObject([{ requestId: given.requestId, walletAsked: true }]);
    // other terms, but the wallet was asked: kept too
    site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, transaction: grantTx(AGENT, 20000n), state: "sending", wallet_asked: true } });
    const c = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect((c.err as HostedRefusal).message).toMatch(/another transaction.*may have sent/);
    expect(c.kept).toMatchObject([{ walletAsked: true }]);
    // adopted while the wallet is asked: the evidence goes with it
    site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, state: "sending", wallet_asked: true } });
    const d = await adopt(KEY, record, given, grant(AGENT, 10000n));
    expect(d.err).toBeInstanceOf(HostedAdopted);
    expect(d.asked).toBe(true);
    expect(d.kept).toEqual([]);
    site.readAnswer = undefined;
    expect((await adopt(KEY, record, given, grant(AGENT, 10000n))).asked).toBe(false);
  });

  it("a token renewal the site does not answer as another agent's or missing keeps the request before the refusal, with the answer's evidence", async () => {
    const { request, record } = await sign(KEY, grant(AGENT, 10000n));
    const given = await submit(request);
    const asked = [{ requestId: given.requestId, walletAsked: true }];
    const notAsked = [{ requestId: given.requestId, link: given.link, matchCode: given.matchCode, walletAsked: false }];
    // only the site's own refusals (renewAccess), complete and with no wallet asked, are a basis: every other answer keeps the request
    const cases: [{ status: number; body: unknown }, object[]][] = [
      [{ status: 404, body: { error: { code: "not_found", message: "there is no budget request with this id" } } }, []],
      [{ status: 403, body: { error: { code: "not_your_request", message: "another agent's key made this request" } } }, []],
      [{ status: 503, body: { error: { code: "unavailable" } } }, notAsked],
      [{ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } }, asked],
      [{ status: 403, body: { error: { code: "not_your_request", money_moved: true } } }, asked],
      [{ status: 404, body: { error: { code: "not_found", wallet_asked: true } } }, asked],
      [{ status: 403, body: "upstream access denied" }, notAsked],
      [{ status: 404, body: { error: { code: "upstream_unavailable" } } }, notAsked],
      [{ status: 403, body: { code: "not_your_request" } }, notAsked],
      [{ status: 404, body: "" }, notAsked],
      [{ status: 403, body: { error: { code: "not_your_request", message: "x".repeat(1_100_000) } } }, notAsked],
      [{ status: 404, body: { error: { code: "not_your_request" } } }, notAsked],
      [{ status: 401, body: { error: { code: "agent_proof" } } }, notAsked],
      [{ status: 200, body: { id: given.requestId } }, notAsked],
      // a refusal that names another request says nothing about this one; one that names this request is still a refusal
      [{ status: 403, body: { id: "ba_different0002", error: { code: "not_your_request", id: "ba_different0002" } } }, notAsked],
      [{ status: 403, body: { id: "ba_different0002", error: { code: "not_your_request" } } }, notAsked],
      [{ status: 404, body: { error: { code: "not_found", id: "ba_different0002" } } }, notAsked],
      [{ status: 404, body: { id: given.requestId, error: { code: "not_found", id: given.requestId } } }, []],
    ];
    for (const [answer, kept] of cases) {
      const what = JSON.stringify(answer).slice(0, 120);
      site.renewAnswer = () => answer;
      const out = await adopt(KEY, record, given, grant(AGENT, 10000n));
      expect(out.err, what).toBeInstanceOf(HostedRefusal);
      expect(out.adopted).toBeUndefined();
      expect(out.kept, what).toMatchObject(kept);
      expect((out.err as HostedRefusal).sending, what).toBe(kept.length > 0);
      expect((out.err as HostedRefusal).notAdopted, what).toBe(kept.length === 0);
      if (kept.length) expect((out.err as HostedRefusal).message).not.toMatch(/Nothing was recorded/);
    }
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
/** Every call the fake chain answered, in order. */
const rpcCalls: { method: string; params: any[] }[] = [];

type Run = { code: number; stdout: string; stderr: string; result: any };
const outputs: string[] = [];
function start(args: string[], extraEnv: Record<string, string> = {}): { child: ChildProcess; done: Promise<Run> } {
  const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc!.url, ...extraEnv };
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
const budget = (args: string[], extraEnv?: Record<string, string>) => start(args, extraEnv).done;

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
    rpcCalls.push({ method, params });
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

  it("expired: grant --sign-only prints one signed request, keeps it mode 600 and sends nothing; wait says signed, then expired with nothing sent from here, unknown", async () => {
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
    // the connector may already have sent it: never a bare "nothing was sent"
    expect(early.result.next).toMatch(/Nothing was sent from this machine, but if submit_budget_request already sent it, the owner may be approving it now/);
    expect(JSON.stringify(early.result)).not.toMatch(/nothing was sent(?! from this machine)/i);
    expect(JSON.stringify(signed.result)).not.toMatch(/nothing was sent(?! from this machine)/i);

    // never adopted, and past the site's window
    const r = record(id);
    r.hosted.signed.signedAt -= 301;
    writeFileSync(recordPath(id), JSON.stringify(r));
    const late = await budget(["wait", "--id", id, "--shown"]);
    // this machine cannot tell whether the connector sent it in time: unknown, never refused
    expect(late.code, late.stderr).toBe(5);
    expect(late.result).toMatchObject({ command: "grant", state: "unknown", final: false, id });
    expect(late.result.reason).toMatch(/expired.*Nothing was sent from this machine, but if submit_budget_request sent it in time/);
    expect(late.result.next).toContain("--sign-only");
    expect(late.result.next).toContain(`superstables budget wait --id ${id} --site-request REQUEST_ID`);
    // not final: had the connector sent it in time, --site-request would still adopt that request
    expect(record(id).final).toBeUndefined();
    expect(site.posts).toEqual([]);
    // the next owner command signs afresh
    const again = await budget([...grantArgs, "--sign-only"]);
    expect(again.result).toMatchObject({ state: "signed" });
    expect(again.result.id).not.toBe(id);
  }, 120_000);

  it("--sign-only reads the chain only for its checks and the facts it keeps, and sends nothing to the site and no transaction", async () => {
    onRecord(true);
    for (const args of [[...grantArgs, "--sign-only"], ["revoke", "--rail", "evm", "--sign-only"], ["fund-agent", "--rail", "evm", "--sign-only"]]) {
      rpcCalls.length = 0;
      const out = await budget(args);
      expect(out.code, out.stderr).toBe(0);
      expect(out.result).toMatchObject({ command: args[0], state: "signed" });
      expect(new Set(rpcCalls.map((c) => c.method)), args[0]).toEqual(new Set(rpcCalls.map((c) => c.method).filter((m) => ["eth_chainId", "eth_call", "eth_getBalance", "eth_getBlockByNumber", "eth_blockNumber"].includes(m))));
      // a grant shows the owner's token balance (balanceOf) and checks nothing with it: it is read when the request is adopted
      if (args[0] === "grant") expect(rpcCalls.filter((c) => c.method === "eth_call" && String(c.params[0]?.data).startsWith("0x70a08231"))).toEqual([]);
    }
    expect(site.posts).toEqual([]);
    expect(site.requests).toEqual([]);
  }, 120_000);

  it("setup --hosted --sign-only reads the agent's balance only for a fund step, and the block for any step", async () => {
    onRecord(false);
    const agentBalance = () => rpcCalls.filter((c) => c.method === "eth_getBalance" && String(c.params[0]).toLowerCase() === AGENT.toLowerCase());
    const rows: [string[], string[]][] = [[["--grant", "0.01"], ["grant"]], [["--fund"], ["fund_agent"]], [["--grant", "0.01", "--fund"], ["fund_agent", "grant"]], [[], []]];
    for (const [extra, steps] of rows) {
      rpcCalls.length = 0;
      const out = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, ...extra, "--sign-only"]);
      expect(out.code, out.stderr).toBe(0);
      expect(out.result).toMatchObject({ command: "setup", state: "signed" });
      expect((JSON.parse(out.result.request.body).then ?? []).map((t: { kind: string }) => t.kind)).toEqual(steps);
      expect(agentBalance(), extra.join(" ")).toHaveLength(steps.includes("fund_agent") ? 1 : 0);
      expect(rpcCalls.some((c) => c.method === "eth_blockNumber"), extra.join(" ")).toBe(steps.length > 0);
    }
    expect(site.posts).toEqual([]);
  }, 180_000);

  it("grant --sign-only on a chain whose gas is USDC reads no owner balance: no fee check needs it there", async () => {
    onRecord(true);
    const arcCalls: { method: string; params: any[] }[] = [];
    const arc = await startFakeRpc(5042002, (method, params) => {
      arcCalls.push({ method, params });
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_call") return `0x${"0".repeat(64)}`;
      return undefined;
    });
    try {
      writeFileSync(join(home, "budget", "public", "evm-arc-testnet.env"), publicFile());
      tree.set({ "base-sepolia": [{ url: rpc!.url, operator: "fake-a" }, { url: `${rpc!.url}/`, operator: "fake-b" }], "arc-testnet": [{ url: arc.url, operator: "fake-a" }, { url: `${arc.url}/`, operator: "fake-b" }] });
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: arc.url };
      for (const k of ["SUPERSTABLES_SITE", "SUPERSTABLES_BUDGET_APPROVAL_ID", "SUPERSTABLES_BUDGET_HOLDER", "SUPERSTABLES_BUDGET_RESUME", "SUPERSTABLES_BUDGET_SIGN_ONLY", "SUPERSTABLES_BUDGET_ADOPT"]) delete env[k];
      const out = await new Promise<{ code: number; stderr: string }>((ok) => {
        const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...grantArgs, "--chain", "arc-testnet", "--sign-only"], { cwd: tree.root, env });
        let stderr = "";
        child.stderr!.on("data", (c) => (stderr += String(c)));
        child.once("close", (code) => ok({ code: code ?? 0, stderr }));
      });
      expect(arcCalls.length, out.stderr).toBeGreaterThan(0);
      expect(arcCalls.filter((c) => c.method === "eth_getBalance" && String(c.params[0]).toLowerCase() === OWNER.toLowerCase()), out.stderr).toEqual([]);
    } finally {
      await arc.close();
    }
    expect(site.posts).toEqual([]);
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

  it("a link whose read garbles the owner, the owner proof version or a step is unknown, keeps the request and holds the chain", async () => {
    onRecord(false);
    const signed = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--sign-only"]);
    expect(signed.code, signed.stderr).toBe(0);
    const id = signed.result.id;
    const v = await connector(signed.result.request);
    for (const change of [{ expected_owner: "garbled" }, { owner_proof_version: 99 }, { steps: [{ kind: "garbled" }] }]) {
      const what = JSON.stringify(change);
      site.readAnswer = (_r, view) => ({ status: 200, body: { ...(view as object), ...change } });
      const out = await budget(adoptArgs(id, v));
      expect(out.code, `${what}: ${out.stderr}`).toBe(5);
      expect(out.result, what).toMatchObject({ state: "unknown", final: false });
      expect(out.result.reason, what).toMatch(/leaves out, or garbles, what was signed/);
      expect(record(id).hosted.signed.submitted, what).toEqual({ requestId: v.request_id, link: v.approval_link, matchCode: v.match_code });
      expect(existsSync(lockPath()), what).toBe(true);
    }
    expect(site.requests[0].cancels).toBe(0);
    site.readAnswer = undefined;
    const later = await budget(["wait", "--id", id]);
    expect(later.code, later.stderr).toBe(0);
    expect(later.result).toMatchObject({ command: "setup", state: "waiting_owner", id, url: v.approval_link });
    expect(record(id).hosted.signed.submitted).toBeUndefined();
  }, 300_000);

  it("a link without steps whose read has steps that are not an array is unknown, keeps the request and holds the chain", async () => {
    onRecord(false);
    const signed = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--sign-only"]);
    expect(signed.code, signed.stderr).toBe(0);
    const id = signed.result.id;
    const v = await connector(signed.result.request);
    for (const change of [{ steps: {} }, { steps: "garbled" }, { steps: {}, owner_proof_version: 1 }]) {
      const what = JSON.stringify(change);
      site.readAnswer = (_r, view) => ({ status: 200, body: { ...(view as object), ...change } });
      const out = await budget(adoptArgs(id, v));
      expect(out.code, `${what}: ${out.stderr}`).toBe(5);
      expect(out.result, what).toMatchObject({ state: "unknown", final: false });
      expect(out.result.reason, what).toMatch(/leaves out, or garbles, what was signed/);
      expect(record(id).hosted.signed.submitted, what).toEqual({ requestId: v.request_id, link: v.approval_link, matchCode: v.match_code });
      expect(existsSync(lockPath()), what).toBe(true);
    }
    expect(site.requests[0].cancels).toBe(0);
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

  // Once the owner's wallet may have been asked, the outcome is unknown, never "nothing sent", "refused" or "failed", until the site or
  // the chain gives a final answer: every path below that saw a site request reads unknown, and each ends settled once the owner's
  // transaction is on the site and the chain.
  const unknown = (out: Run, what: string) => {
    expect(out.code, `${what}: ${out.stderr}`).toBe(5);
    expect(out.result, what).toMatchObject({ state: "unknown", final: false });
  };
  const signAndSend = async () => {
    const signed = await budget([...grantArgs, "--sign-only"]);
    expect(signed.code, signed.stderr).toBe(0);
    const v = await connector(signed.result.request);
    return { id: signed.result.id as string, v, r: site.requests.at(-1)! };
  };
  const pastWindow = (id: string) => {
    const r = record(id);
    r.hosted.signed.signedAt -= 301;
    writeFileSync(recordPath(id), JSON.stringify(r));
  };
  /** The first read shows the wallet asked, every later one fails. */
  const askedThenDown = () => {
    let reads = 0;
    site.readAnswer = (_r, v) => (++reads === 1 ? { status: 200, body: { ...v, state: "sending", wallet_asked: true, final: false } } : { status: 503, body: { error: { code: "unavailable" } } });
  };
  async function settles(id: string, r: { state?: string }) {
    site.readAnswer = undefined;
    Object.assign(r, { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    chain.approved = true;
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ command: "grant", state: "settled", final: true, tx: { grant: GRANT_HASH } });
    expect(lines("B4_CAP")).toBe(1);
    expect(site.posts.filter((p) => p.path === "/api/v1/budget/approvals")).toHaveLength(1);
    expect(existsSync(lockPath())).toBe(false);
  }
  it.each([
    {
      path: "adopted while the wallet is asked, then every read fails",
      run: async () => {
        const { id, v, r } = await signAndSend();
        askedThenDown();
        unknown(await budget([...adoptArgs(id, v), "--timeout", "0"]), "the adoption");
        expect(record(id).hosted).toMatchObject({ requestId: v.request_id, signed: { walletAsked: true } });
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "a later wait");
        await settles(id, r);
      },
    },
    {
      path: "refused with money_moved, past the window, read failing again, then read and adopted",
      run: async () => {
        const { id, v, r } = await signAndSend();
        site.readAnswer = () => ({ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } });
        const first = await budget(adoptArgs(id, v));
        unknown(first, "the adoption");
        expect(first.result.next).toContain(`superstables budget wait --id ${id} --shown`);
        expect(record(id).hosted.signed).toMatchObject({ walletAsked: true, submitted: { requestId: v.request_id, link: v.approval_link, matchCode: v.match_code } });
        // the chain stays held: no other owner command starts while the wallet may be sending
        expect(existsSync(lockPath())).toBe(true);
        expect((await budget([...grantArgs, "--sign-only"])).code).toBe(3);
        pastWindow(id);
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "a wait past the window");
        expect(record(id).final).toBeUndefined();
        // another request id is not taken in its place
        unknown(await budget(adoptArgs(id, { ...v, request_id: "ba_other0001" })), "another id");
        // the site answers again: wait adopts the kept request with the values kept for it, and the evidence stays
        site.readAnswer = undefined;
        unknown(await budget(["wait", "--id", id, "--timeout", "0"]), "the adoption on a later wait");
        expect(record(id).hosted).toMatchObject({ requestId: v.request_id, signed: { walletAsked: true } });
        expect(record(id).hosted.signed.submitted).toBeUndefined();
        await settles(id, r);
      },
    },
    {
      path: "sent in time, the window passes before any id is given, then adopted while the wallet is asked",
      run: async () => {
        const { id, v, r } = await signAndSend();
        askedThenDown();
        pastWindow(id);
        // no site request was given: this machine sent nothing, but the connector did, so the expiry is unknown and the record stays open
        unknown(await budget(["wait", "--shown", "--id", id]), "a wait past the window with no id given");
        expect(record(id).final).toBeUndefined();
        unknown(await budget(adoptArgs(id, v)), "the adoption after the window");
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "a later wait");
        await settles(id, r);
      },
    },
    {
      path: "the token renewal answers 503 with money_moved, past the window, then renewed and adopted",
      run: async () => {
        const { id, v, r } = await signAndSend();
        site.renewAnswer = () => ({ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } });
        unknown(await budget(adoptArgs(id, v)), "the adoption");
        expect(record(id).hosted.signed).toMatchObject({ walletAsked: true, submitted: { requestId: v.request_id, link: v.approval_link, matchCode: v.match_code } });
        expect(existsSync(lockPath())).toBe(true);
        pastWindow(id);
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "a wait past the window");
        site.renewAnswer = undefined;
        unknown(await budget(["wait", "--id", id, "--timeout", "0"]), "the adoption on a later wait");
        expect(record(id).hosted).toMatchObject({ requestId: v.request_id, signed: { walletAsked: true } });
        await settles(id, r);
      },
    },
    {
      path: "the token renewal gets no answer, then a read shows the wallet asked",
      run: async () => {
        const { id, v, r } = await signAndSend();
        site.renewAnswer = () => ({ status: 502, body: "" });
        unknown(await budget(adoptArgs(id, v)), "the adoption");
        expect(record(id).hosted.signed).toMatchObject({ submitted: { requestId: v.request_id } });
        site.renewAnswer = undefined;
        askedThenDown();
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "the adoption on a later wait");
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "a wait after it");
        await settles(id, r);
      },
    },
    {
      path: "a wait killed while it reads a request adopted with the wallet asked",
      run: async () => {
        const { id, v, r } = await signAndSend();
        askedThenDown();
        unknown(await budget([...adoptArgs(id, v), "--timeout", "0"]), "the adoption");
        const reading = start(["wait", "--shown", "--id", id, "--timeout", "60"]);
        await new Promise((x) => setTimeout(x, 3000));
        reading.child.kill("SIGKILL");
        await reading.done;
        await endEveryProcess(id);
        expect(record(id).final).toBeUndefined();
        unknown(await budget(["wait", "--shown", "--id", id, "--timeout", "0"]), "the wait after the kill");
        await settles(id, r);
      },
    },
  ])("wallet maybe asked: $path reads unknown until the outcome is final", async ({ run }) => {
    onRecord(true);
    await run();
  }, 300_000);

  // One rule for every path after a possible send. From the moment a request is signed, this machine cannot know whether the
  // connector sent it. wait --site-request keeps the id, link and match code with the approval before it asks the site or checks
  // anything; from then on, whatever stops the check (any answer of the site but its complete "not this request", a check on this
  // machine, a crash) and every plain wait after it, inside the window or after it, is unknown with the request kept and the chain
  // held, never refused_precheck, failed, exit 3, "nothing was sent" or "sign again". Once the fault is gone, a plain wait adopts it.
  const neverDefinite = (out: Run, what: string) => {
    unknown(out, what);
    expect(JSON.stringify(out.result), what).not.toMatch(/refused_precheck|"state":"failed"|--sign-only|sign (it )?again|sign a new|nothing was (signed or )?(sent|requested)(?! from this machine)/i);
  };
  /** The chain is held for `id`, even once its lock is older than the startup grace and no process of it runs. */
  async function heldFor(id: string, what: string) {
    expect(existsSync(lockPath()), what).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath(), "utf8"));
    writeFileSync(lockPath(), JSON.stringify({ ...lock, createdAt: Date.now() - 31_000 }));
    const other = await budget([...grantArgs, "--sign-only"]);
    expect(other.code, `${what}: ${other.stderr}`).toBe(3);
    expect(other.result.reason, what).toContain(id);
  }
  const keyFile = () => join(home, "keys", "budget", "evm-agent.env");
  const railScript = () => join(tree.root, "budget", "evm", "setBudget.ts");
  type Fault = { on: () => void | Promise<void>; off: () => void | Promise<void>; env?: () => Record<string, string>; local?: RegExp };
  const answer = (status: number, body: unknown): Fault => ({ on: () => { site.renewAnswer = () => ({ status, body }); }, off: () => { site.renewAnswer = undefined; } });
  let script = "";
  it.each<{ path: string; fault: () => Fault }>([
    { path: "the token renewal answers 403 with a plain-text body", fault: () => answer(403, "upstream access denied") },
    { path: "the token renewal answers 404 with another code", fault: () => answer(404, { error: { code: "upstream_unavailable" } }) },
    { path: "the token renewal answers 403 not_your_request, cut off", fault: () => answer(403, { error: { code: "not_your_request", message: "x".repeat(1_100_000) } }) },
    { path: "the token renewal answers 401", fault: () => answer(401, { error: { code: "agent_proof" } }) },
    { path: "the token renewal answers 502 with nothing", fault: () => answer(502, "") },
    { path: "the token renewal answers 200 without a token", fault: () => answer(200, { id: "ba_other0001" }) },
    { path: "the token renewal answers 403 not_your_request about another request", fault: () => answer(403, { id: "ba_different0002", error: { code: "not_your_request", id: "ba_different0002" } }) },
    {
      path: "the read leaves out the agent",
      fault: () => ({ on: () => { site.readAnswer = (_r, v) => { const { agent: _drop, ...rest } = v as Record<string, unknown>; return { status: 200, body: rest }; }; }, off: () => { site.readAnswer = undefined; } }),
    },
    {
      path: "the read names an agent that is no address",
      fault: () => ({ on: () => { site.readAnswer = (_r, v) => ({ status: 200, body: { ...(v as object), agent: "garbled" } }); }, off: () => { site.readAnswer = undefined; } }),
    },
    { path: "a local check: the agent key file can be read by other users", fault: () => ({ on: () => chmodSync(keyFile(), 0o644), off: () => chmodSync(keyFile(), 0o600), local: /key file/ }) },
    {
      path: "a local check: the shell names an RPC of another chain",
      fault: () => {
        let other: TestServer | undefined;
        return { on: async () => { other = await startFakeRpc(1); }, off: async () => { await other?.close(); }, env: () => ({ B4_RPC: other!.url }), local: /answers chain id 1/ };
      },
    },
    {
      path: "a local check: the public file is gone",
      fault: () => {
        let before = "";
        return { on: () => { before = publicFile(); rmSync(publicPath()); }, off: () => writeFileSync(publicPath(), before), local: /no budget has been set up here/ };
      },
    },
    {
      path: "the check crashes after the request was kept",
      fault: () => ({
        on: () => { script = readFileSync(railScript(), "utf8"); writeFileSync(railScript(), `throw new Error("injected crash after the write-ahead");\n${script}`); },
        off: () => writeFileSync(railScript(), script),
        local: /injected crash after the write-ahead/,
      }),
    },
  ])("after a possible send: $path is unknown, keeps the request and holds the chain, inside and after the window", async ({ path, fault }) => {
    onRecord(true);
    const { id, v, r } = await signAndSend();
    const f = fault();
    await f.on();
    try {
      const env = f.env?.();
      const adopted = await budget(adoptArgs(id, v), env);
      neverDefinite(adopted, `${path}: the adoption`);
      if (f.local) {
        expect(adopted.result.next, path).toMatch(/This machine could not check it/);
        expect(adopted.result.reason, path).toMatch(f.local);
      } else expect(adopted.result.next, `${path}: ${adopted.result.reason}`).not.toMatch(/This machine could not check it/);
      expect(record(id).hosted.signed.submitted, path).toEqual({ requestId: v.request_id, link: v.approval_link, matchCode: v.match_code });
      expect(record(id).hosted.requestId, path).toBeUndefined();
      neverDefinite(await budget(["wait", "--id", id, "--shown", "--timeout", "0"], env), `${path}: a plain wait inside the window`);
      pastWindow(id);
      neverDefinite(await budget(["wait", "--id", id, "--shown", "--timeout", "0"], env), `${path}: a plain wait after the window`);
      expect(record(id).hosted.signed.submitted, path).toMatchObject({ requestId: v.request_id });
      expect(record(id).final, path).toBeUndefined();
    } finally {
      await f.off();
    }
    await heldFor(id, path);
    // nothing was cancelled, and the kept values adopt the request once the fault is gone
    expect(r.cancels).toBe(0);
    const later = await budget(["wait", "--id", id]);
    expect(later.code, later.stderr).toBe(0);
    expect(later.result).toMatchObject({ state: "waiting_owner", id, url: v.approval_link });
    expect(record(id).hosted).toMatchObject({ requestId: v.request_id });
    expect(record(id).hosted.signed.submitted).toBeUndefined();
  }, 300_000);

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
