// What a hosted budget request may say after the agent cancels it: "nothing was sent" only for an explicit, coherent
// cancellation of this request (budget/site.mjs cancelSiteRequest), and unknown (exit 5) for any other answer on a request
// that can move funds. The fake superstables.com and a fake Base Sepolia RPC on 127.0.0.1; no network, no real key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals, HostedRefusal } from "../../budget/hosted.js";
import { cancelSiteRequest } from "../../budget/site.mjs";
import { evmOwner, signLinkProof, startFakeRpc, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import type { TestServer } from "../helpers/servers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
// a grant is asked for only when the endpoints agree, at a final block, that the allowance is 0: a copy names the fake twice
let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const OTHER = evmOwner("33");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };
const FUND_TX = { to: AGENT, data: "0x", value: "0x2386f26fc10000" };

// the approvals module fixes its home when it is first imported: one home for this whole file, set before that
const savedHome = process.env.SUPERSTABLES_HOME;
const fileHome = mkdtempSync(join(tmpdir(), "ss-hosted-cancel-home-"));
process.env.SUPERSTABLES_HOME = fileHome;
let approvals: typeof import("../../budget/approvals.mjs");
let ownerApprovalsLog: () => string;
beforeAll(async () => {
  approvals = await import("../../budget/approvals.mjs");
  ({ ownerApprovalsLog } = await import("../../budget/paths.mjs"));
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.SUPERSTABLES_HOME;
  else process.env.SUPERSTABLES_HOME = savedHome;
  rmSync(fileHome, { recursive: true, force: true });
});

describe("cancelSiteRequest: what counts as cancelled", () => {
  const id = "ba_test1234";
  const cancel = (status: number, body: unknown) =>
    cancelSiteRequest({
      site: "https://www.superstables.com", id, token: "ssbt_test_token0001",
      fetchImpl: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    });

  const NOT_CANCELLED: [string, number, unknown][] = [
    ["an empty object", 200, {}],
    ["a body that is not JSON", 200, "not json"],
    ["another request's cancellation", 200, { id: "ba_other123", state: "cancelled", final: true }],
    ["a cancellation that names a transaction", 200, { id, state: "cancelled", final: true, tx_hash: `0x${"ab".repeat(32)}` }],
    ["a cancellation that says the wallet was asked", 200, { id, state: "cancelled", final: true, wallet_asked: true }],
    ["a cancelled step that was asked", 200, { id, state: "cancelled", final: true, steps: [{ state: "cancelled", wallet_asked: true }] }],
    ["a skipped step with a transaction", 200, { id, state: "cancelled", final: true, steps: [{ state: "skipped", tx_hash: `0x${"ab".repeat(32)}` }] }],
    ["a step that was sent", 200, { id, state: "cancelled", final: true, steps: [{ state: "sent" }] }],
    ["a cancelled state that is not final", 200, { id, state: "cancelled" }],
    ["a sending state", 200, { id, state: "sending", final: false }],
    ["a 200 that carries error.wallet_asked", 200, { id, state: "cancelled", final: true, error: { wallet_asked: true } }],
    ["a 200 that carries a transaction under error", 200, { id, state: "cancelled", final: true, error: { tx_hash: `0x${"ab".repeat(32)}` } }],
    ["a 200 that carries error.money_moved unknown", 200, { id, state: "cancelled", final: true, error: { money_moved: "unknown" } }],
    ["a 200 whose step shows money may have moved", 200, { id, state: "cancelled", final: true, steps: [{ state: "skipped", money_moved: "unknown" }] }],
    ["a 200 whose step shows money moved", 200, { id, state: "cancelled", final: true, steps: [{ state: "skipped", money_moved: true }] }],
    ["a 200 whose error carries a step that was sent", 200, { id, state: "cancelled", final: true, error: { steps: [{ state: "sent", tx_hash: `0x${"ab".repeat(32)}` }] } }],
    ["a 200 that names another request in its error", 200, { id, state: "cancelled", final: true, error: { id: "ba_other123" } }],
    ["a 409 not_open whose error carries a step that was sent", 409, { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null, steps: [{ state: "sent", tx_hash: `0x${"ab".repeat(32)}` }] } }],
    ["a 409 not_open whose error carries a step with money moved", 409, { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null, steps: [{ state: "skipped", money_moved: "unknown" }] } }],
    ["a 409 not_open with a step at the top that was sent", 409, { steps: [{ state: "sent" }], error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null } }],
    ["a 409 not_open for another request (id in error)", 409, { error: { code: "not_open", id: "ba_other123", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } }],
    ["a 409 not_open for another request (id at the top)", 409, { id: "ba_other123", error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } }],
    ["a refusal because the wallet was asked", 409, { error: { code: "wallet_asked", state: "sending", wallet_asked: true, money_moved: "unknown" } }],
    ["a refusal for an expired request", 409, { error: { code: "not_open", state: "expired", wallet_asked: false, tx_hash: null, money_moved: false } }],
    ["a refusal that says cancelled but names a transaction", 409, { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: `0x${"ab".repeat(32)}` } }],
    ["a refusal that says cancelled without saying the wallet was not asked", 409, { error: { code: "not_open", state: "cancelled" } }],
    ["a refusal that says cancelled but money may have moved", 409, { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: "unknown" } }],
    ["a refusal with another code", 409, { error: { code: "something_else", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } }],
    ["a cancelled refusal with its fields at the top, not under error", 409, { state: "cancelled", wallet_asked: false, tx_hash: null }],
    ["a server error", 503, { error: { code: "unavailable" } }],
  ];
  for (const [what, status, body] of NOT_CANCELLED) {
    it(`${what} (${status}) is not a cancellation`, async () => {
      expect(await cancel(status, body)).toMatchObject({ cancelled: false });
    });
  }

  it("keeps the evidence it saw: the wallet was asked, with the state in documented words", async () => {
    expect(await cancel(200, { id, state: "cancelled", final: true, tx_hash: HASH })).toMatchObject({ cancelled: false, walletAsked: true, state: "cancelled" });
    expect(await cancel(200, { id, state: "cancelled", final: true, steps: [{ state: "skipped", wallet_asked: true }] })).toMatchObject({ walletAsked: true });
    expect(await cancel(200, {})).toMatchObject({ cancelled: false, walletAsked: false, state: null });
    expect(await cancel(409, { error: { code: "wallet_asked", state: "sending", wallet_asked: true, money_moved: "unknown" } })).toMatchObject({ walletAsked: true, state: "sending" });
    expect(await cancel(200, { id, state: "cancelled", final: true, error: { wallet_asked: true } })).toMatchObject({ cancelled: false, walletAsked: true });
    // money that may have moved is evidence on its own
    expect(await cancel(409, { error: { code: "wallet_asked", money_moved: "unknown" } })).toMatchObject({ walletAsked: true });
  });

  it("an answer for a link with steps keeps the view for the caller, cancelled or not", async () => {
    const steps = [{ index: 0, kind: "grant", state: "skipped", wallet_asked: false, tx_hash: null }];
    const ok = await cancel(200, { id, state: "cancelled", final: true, steps });
    expect(ok).toMatchObject({ cancelled: true, view: { id, steps } });
    const unclear = await cancel(200, { id, steps });
    expect(unclear).toMatchObject({ cancelled: false, view: { steps } });
  });

  it("is cancelled only for the request's own explicit answer", async () => {
    expect(await cancel(200, { id, kind: "grant", state: "cancelled", final: true, wallet_asked: false, tx_hash: null, reason_code: "agent_cancelled" })).toEqual({ cancelled: true, state: "cancelled" });
    // the site's answer to a second cancel: a refusal, with its fields under `error`
    expect(await cancel(409, { error: { code: "not_open", message: "already cancelled", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } })).toEqual({ cancelled: true, state: "cancelled" });
    // the second cancel may name the request, or none
    expect(await cancel(409, { error: { code: "not_open", id, state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } })).toMatchObject({ cancelled: true });
    // a link with steps, none asked for
    expect(await cancel(200, { id, state: "cancelled", final: true, steps: [{ state: "skipped", wallet_asked: false, tx_hash: null }] })).toMatchObject({ cancelled: true });
  });

  it("the site not answering is null", async () => {
    const down = await cancelSiteRequest({ site: "https://www.superstables.com", id, token: "ssbt_test_token0001", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    expect(down).toBeNull();
  });
});

describe("hosted approvals: an unclear cancel answer is unknown", () => {
  let site: FakeSite;
  let dir: string;
  const client = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(dir, "audit.jsonl"), pollWaitS: 0, minPollMs: 20, ...over });
  const grant = (c: HostedApprovals, timeoutMs = 60_000) =>
    c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs });

  beforeEach(async () => {
    site = await startFakeSite();
    dir = mkdtempSync(join(tmpdir(), "ss-hosted-cancel-"));
  });
  afterEach(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("another owner named at creation, and an empty cancel answer: unknown, never nothing sent", async () => {
    site.owner = OTHER;
    site.cancelAnswer = () => ({ status: 200, body: {} });
    const err = await grant(client()).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.sending).toBe(true);
    expect(err.message).toMatch(/did not confirm the request was cancelled before the owner's wallet was asked, so whether anything was sent is unknown/);
    expect(err.message).not.toMatch(/nothing was sent/);
    expect(err.next).toMatch(/read whether anything landed/);
    // control: the site's own cancel answer says what happened, and then nothing was sent
    site.cancelAnswer = undefined;
    const clear = await grant(client()).catch((e) => e);
    expect(clear.sending).toBe(false);
    expect(clear.message).toMatch(/cancelled on the site before the wallet was asked; nothing was sent/);
  });

  it("a cancel the site answers with a 503, for an approval: unknown", async () => {
    site.owner = OTHER;
    site.cancelFails = true;
    const approval = await grant(client()).catch((e) => e);
    expect(approval.sending).toBe(true);
    expect(approval.message).not.toMatch(/nothing was sent/);
  });

  it("a malformed creation answer and a cancel that gets no answer at all: unknown for an approval, as before for a plain link", async () => {
    const noCancel: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/cancel")) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return fetch(input, init);
    };
    site.owner = OWNER;
    site.answerCreated = (b) => ({ ...b, approval: { ...b.approval, match_code: "" } });
    const approval = await grant(client({ fetchImpl: noCancel })).catch((e) => e);
    expect(approval).toBeInstanceOf(HostedRefusal);
    expect(approval.sending).toBe(true);
    expect(approval.message).not.toMatch(/nothing was sent/);
    expect(approval.next).toMatch(/read whether anything landed/);
    // a plain link moves no funds: the words it had
    const link = await client({ fetchImpl: noCancel }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
    expect(link).toBeInstanceOf(HostedRefusal);
    expect(link.sending).toBe(false);
    expect(link.message).toMatch(/Check wallet activity before retrying$/);
  });

  it("a link with steps whose steps differ, and a cancel answer that is empty: unknown; with the right steps it is accepted", async () => {
    site.answerSteps = (st) => [st[0], { ...st[1], kind: "fund_agent" }];
    site.cancelAnswer = () => ({ status: 200, body: {} });
    const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];
    const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.sending).toBe(true);
    expect(err.message).not.toMatch(/nothing was sent/);
    // control: the same link with the steps asked for is accepted, and nothing is cancelled
    site.cancelAnswer = undefined;
    site.answerSteps = undefined;
    const polling = client();
    const ok = await polling.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
    expect(ok.bundle).toBeDefined();
    expect(site.requests[1].cancels).toBe(0);
    await polling.close();
  });

  it("a link with steps, cancelled before an owner: the site's answer is final and nothing was sent", async () => {
    site.answerSteps = (st) => [st[0], { ...st[1], kind: "fund_agent" }];
    const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];
    const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then }).catch((e) => e);
    expect(err.sending).toBe(false);
    expect(err.message).toMatch(/The request was cancelled on the site before the wallet was asked; nothing was sent/);
    expect(site.requests[0].steps).toMatchObject([{ state: "skipped", reason_code: "link_not_done" }, { state: "skipped" }]);
  });

  it("a link with steps whose owner proof is wrong, and an empty cancel answer: the steps are not confirmed withdrawn", async () => {
    site.cancelAnswer = () => ({ status: 200, body: {} });
    const then = [{ kind: "grant" as const, transaction: GRANT_TX }];
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "XYZ-UVW" }) });
    const b = await h.bundle!;
    expect(b.link.status === "rejected" && b.link.reason).toMatch(/steps were not confirmed withdrawn/);
    expect(b.link.status === "rejected" && b.link.reason).not.toMatch(/steps were withdrawn/);
  });

  it("a hash read while the state stays awaiting_owner reaches the page log: a later wait ends unknown (exit 5), not refused", async () => {
    rmSync(ownerApprovalsLog(), { force: true });
    site.owner = OWNER;
    site.cancelAnswer = () => ({ status: 200, body: { id: site.requests[0].id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null } });
    // the hash shows on the poll's first read only, with the state unchanged
    site.onPoll = (r) => {
      r.tx_hash = r.polls === 2 ? HASH : null;
    };
    const c = client({ auditPath: ownerApprovalsLog() });
    const h = await grant(c);
    const req = site.requests[0];
    // let the poll read it
    for (let i = 0; i < 100 && req.polls < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(req.polls).toBeGreaterThanOrEqual(3);
    // before anything ends the request: the evidence is in the log although the state never changed
    const lines = readFileSync(ownerApprovalsLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ id: req.id, status: "awaiting_owner", sending: true, hash: HASH });
    const id = approvals.newApprovalId();
    approvals.saveApproval({
      id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(),
      hosted: { site: site.url, requestId: req.id, token: req.token, kind: "grant", matchCode: "ABC-DEF" },
    });
    await c.close();
    const outcome = await approvals.waitFor(id, 1000);
    expect(outcome).toMatchObject({ final: true, code: 5 });
    expect(outcome!.final && outcome!.result).toMatchObject({ state: "unknown" });
  });

  it("a step the wallet was asked for, with its state unchanged, reaches the page log", async () => {
    rmSync(ownerApprovalsLog(), { force: true });
    const then = [{ kind: "grant" as const, transaction: GRANT_TX }];
    const c = client({ auditPath: ownerApprovalsLog() });
    const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "ABC-DEF" }) });
    Object.assign(r.steps![0], { state: "awaiting_owner" });
    const logged = () => readFileSync(ownerApprovalsLog(), "utf8");
    for (let i = 0; i < 100 && !logged().includes('"kind":"grant"'); i++) await new Promise((res) => setTimeout(res, 20));
    expect(logged()).not.toContain('"sending":true');
    // now the wallet is asked, and the step's state stays awaiting_owner
    r.steps![0].wallet_asked = true;
    for (let i = 0; i < 100 && !readFileSync(ownerApprovalsLog(), "utf8").includes('"sending":true'); i++) await new Promise((res) => setTimeout(res, 20));
    const lines = readFileSync(ownerApprovalsLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.kind === "grant" && l.status === "awaiting_owner").at(-1)).toMatchObject({ id: r.id, sending: true });
    await c.close();
    await h.bundle;
  });

  describe("evidence on the very first read stays, whatever later reads and the cancel say", () => {
    const coherent = () => ({ status: 200, body: { id: site.requests[0].id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null } });
    // the first GET (the owner check before the link is shown) reports it; every later read is clean
    const first = (evidence: Record<string, unknown>) => (r: { polls: number; wallet_asked?: boolean; tx_hash: string | null; state: string }) => {
      if (r.polls === 1) Object.assign(r, evidence);
      else Object.assign(r, { wallet_asked: false, tx_hash: null, state: "awaiting_owner" });
    };
    const EVIDENCE: [string, Record<string, unknown>][] = [["a transaction hash and wallet_asked", { tx_hash: HASH, wallet_asked: true }], ["a state that implies a send", { state: "sending" }], ["wallet_asked alone", { wallet_asked: true }]];

    for (const [what, evidence] of EVIDENCE) {
      it(`${what} on GET 1, the owner another one, and a clean cancel: unknown`, async () => {
        site.owner = OTHER;
        site.cancelAnswer = coherent;
        site.onPoll = first(evidence);
        const err = await grant(client()).catch((e) => e);
        expect(err).toBeInstanceOf(HostedRefusal);
        expect(err.sending).toBe(true);
        expect(err.message).not.toMatch(/nothing was sent/);
        expect(err.next).toMatch(/read whether anything landed/);
      });

      it(`${what} on GET 1, the owner the right one, then the command's timeout: unknown, never nothing sent`, async () => {
        rmSync(ownerApprovalsLog(), { force: true });
        site.owner = OWNER;
        site.cancelAnswer = coherent;
        site.onPoll = first(evidence);
        const h = await grant(client({ sendingGraceMs: 300, auditPath: ownerApprovalsLog() }), 300);
        expect(await h.settled).toMatchObject({ status: "expired", sending: true });
        // the first line of the approval already says so
        expect(JSON.parse(readFileSync(ownerApprovalsLog(), "utf8").split("\n")[0])).toMatchObject({ id: site.requests[0].id, status: "awaiting_owner", sending: true });
        // the site was not asked to cancel what had been asked of the wallet
        expect(site.requests[0].cancels).toBe(0);
      });
    }

    // an error answer about a request handed to the wallet says so in error.money_moved, even a 429
    const rateLimited = (onGet: number): typeof fetch => {
      let gets = 0;
      return async (input, init) => {
        if ((init?.method ?? "GET") === "GET" && /\/requests\/ba_/.test(String(input)) && ++gets === onGet) {
          return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", money_moved: "unknown" } }), { status: 429, headers: { "content-type": "application/json" } });
        }
        return fetch(input, init);
      };
    };

    it("a 429 with money_moved unknown on GET 1, the owner another one, and a clean cancel: unknown", async () => {
      site.owner = OTHER;
      site.cancelAnswer = coherent;
      const err = await grant(client({ fetchImpl: rateLimited(1) })).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.sending).toBe(true);
      expect(err.message).not.toMatch(/nothing was sent/);
    });

    it("a 429 with money_moved unknown on GET 1, the owner the right one, then the command's timeout: unknown", async () => {
      rmSync(ownerApprovalsLog(), { force: true });
      site.owner = OWNER;
      site.cancelAnswer = coherent;
      const h = await grant(client({ fetchImpl: rateLimited(1), sendingGraceMs: 300, auditPath: ownerApprovalsLog() }), 300);
      expect(await h.settled).toMatchObject({ status: "expired", sending: true });
      expect(JSON.parse(readFileSync(ownerApprovalsLog(), "utf8").split("\n")[0])).toMatchObject({ status: "awaiting_owner", sending: true });
      expect(site.requests[0].cancels).toBe(0);
    });

    it("a 429 with money_moved unknown on a later poll, clean reads after it, and a clean cancel: unknown", async () => {
      rmSync(ownerApprovalsLog(), { force: true });
      site.owner = OWNER;
      site.cancelAnswer = coherent;
      // GET 1 is the owner check; GET 2 is the poll's first read
      const h = await grant(client({ fetchImpl: rateLimited(2), sendingGraceMs: 300, auditPath: ownerApprovalsLog() }), 300);
      expect(await h.settled).toMatchObject({ status: "expired", sending: true });
      expect(site.requests[0].cancels).toBe(0);
      expect(readFileSync(ownerApprovalsLog(), "utf8")).toContain('"sending":true');
    });

    it("a 429 with money_moved unknown on a later poll of a link with steps: logged, and the steps are not reported as never asked", async () => {
      rmSync(ownerApprovalsLog(), { force: true });
      const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }];
      // the first read after the link is linked goes through; every read after it is a 429
      let afterLinked = 0;
      const noisy: typeof fetch = async (input, init) => {
        if ((init?.method ?? "GET") === "GET" && /\/requests\/bl_/.test(String(input)) && site.requests[0].state === "linked" && ++afterLinked > 1) {
          return new Response(JSON.stringify({ error: { code: "rate_limited", money_moved: "unknown" } }), { status: 429, headers: { "content-type": "application/json" } });
        }
        return fetch(input, init);
      };
      const c = client({ fetchImpl: noisy, sendingGraceMs: 300, auditPath: ownerApprovalsLog() });
      const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 2500, then });
      const r = site.requests[0];
      Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "ABC-DEF" }) });
      Object.assign(r.steps![0], { state: "awaiting_owner" });
      // before the bundle settles, the log already has a step line that says the wallet was asked
      const stepLines = () => readFileSync(ownerApprovalsLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "fund_agent");
      for (let i = 0; i < 150 && !stepLines().some((l) => l.sending === true); i++) await new Promise((res) => setTimeout(res, 20));
      expect(stepLines().at(-1)).toMatchObject({ id: r.id, kind: "fund_agent", status: "awaiting_owner", sending: true });
      // so a wait that finds no worker ends unknown (exit 5), not "no recorded submission"
      const id = approvals.newApprovalId();
      approvals.saveApproval({
        id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(),
        hosted: { site: site.url, requestId: r.id, token: r.token, kind: "link", matchCode: "ABC-DEF", then: ["fund_agent"] },
      });
      const outcome = await approvals.waitFor(id, 1000);
      expect(outcome).toMatchObject({ final: true, code: 5 });
      const b = await h.bundle!;
      expect(b.steps[0].walletAsked).toBe(true);
      expect(b.steps[0].state).not.toBe("skipped");
      await c.close();
    });

    describe("a link with steps: evidence anywhere in the request is never taken back", () => {
      const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }];
      const lines = () => readFileSync(ownerApprovalsLog(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      /** What `budget wait` would conclude from the log alone for this link, after a cancel the site now answers cleanly. */
      const recovered = async (h: { url: string }, req: { id: string; token: string }) => {
        const id = approvals.newApprovalId();
        approvals.saveApproval({
          id, command: "setup", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(),
          hosted: { site: site.url, requestId: req.id, token: req.token, kind: "link", matchCode: "ABC-DEF", then: ["fund_agent"] },
        });
        return approvals.waitFor(id, 1000);
      };
      const link = async (over: Record<string, unknown> = {}) => {
        const r = site.requests[0];
        Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "ABC-DEF" }), ...over });
        return r;
      };
      const rate = (body: unknown) => ({ status: 429, body });
      beforeEach(() => rmSync(ownerApprovalsLog(), { force: true }));

      it("money_moved unknown in the creation answer's envelope, then a clean cancel: the bundle says unknown, not nothing sent", async () => {
        site.answerCreated = (b) => ({ ...b, money_moved: "unknown" });
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then });
        const b = await h.bundle!;
        expect(b.link).toMatchObject({ status: "expired", sending: true });
        expect(b.link.status === "expired" && b.link.reason).not.toMatch(/nothing was sent/);
        expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
        expect(b.steps[0].reason).not.toMatch(/nothing was sent/);
        expect(lines().some((l) => l.sending === true)).toBe(true);
        expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
      });

      it("a 429 with money_moved unknown on the first read, before any owner is verified, then a clean cancel: unknown, and recovery says 5", async () => {
        let gets = 0;
        const first429: typeof fetch = async (input, init) =>
          (init?.method ?? "GET") === "GET" && /\/requests\/bl_/.test(String(input)) && ++gets === 1
            ? new Response(JSON.stringify({ error: { code: "rate_limited", money_moved: "unknown" } }), { status: 429, headers: { "content-type": "application/json" } })
            : fetch(input, init);
        const c = client({ fetchImpl: first429, sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then });
        const b = await h.bundle!;
        expect(b.link).toMatchObject({ sending: true });
        expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
        expect(b.steps[0].state).not.toBe("skipped");
        expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
      });

      it("a read whose envelope says wallet_asked on GET 1, then an expired link and a skipped step on GET 2: unknown", async () => {
        site.readAnswer = (r, v) => (r.polls === 1 ? { status: 200, body: { ...v, wallet_asked: true } } : undefined);
        site.onPoll = (r) => {
          if (r.polls >= 2) {
            r.state = "expired";
            for (const st of r.steps!) Object.assign(st, { state: "skipped", wallet_asked: false });
          }
        };
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
        const b = await h.bundle!;
        expect(b.link).toMatchObject({ status: "expired", sending: true });
        expect(b.link.status === "expired" && b.link.reason).not.toMatch(/nothing was sent/);
        expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
        expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
      });

      it("a timeout cancel that answers 200 final with error.money_moved unknown and a skipped step: the step is unknown; recovery after a later clean cancel says 5", async () => {
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 400, then });
        const r = await link();
        Object.assign(r.steps![0], { state: "awaiting_owner" });
        site.cancelAnswer = () => ({ status: 200, body: { id: r.id, state: "cancelled", final: true, error: { money_moved: "unknown" }, steps: [{ index: 0, kind: "fund_agent", state: "skipped", wallet_asked: false, tx_hash: null }] } });
        const b = await h.bundle!;
        expect(b.link).toMatchObject({ status: "connected" });
        expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
        expect(b.steps[0].reason).not.toMatch(/nothing was sent/);
        // a later, clean cancel changes nothing for a wait that finds the command gone
        site.cancelAnswer = undefined;
        expect(await recovered(h, r)).toMatchObject({ final: true, code: 5 });
      });

      // The real site's request-level wallet_asked summarises its steps: one asked step must not make the others look asked
      const FUND_THEN_GRANT = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];

      it("fund_agent confirmed with its hash, the grant never asked, then the timeout: the grant is withdrawn on the site (one cancel), not unknown", async () => {
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 400, then: FUND_THEN_GRANT });
        const r = await link();
        Object.assign(r.steps![0], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
        Object.assign(r.steps![1], { state: "awaiting_owner" });
        const b = await h.bundle!;
        expect(r.cancels).toBe(1);
        expect(r.steps![1].state).toBe("cancelled");
        expect(b.steps[0]).toMatchObject({ kind: "fund_agent", hash: HASH, walletAsked: true });
        expect(b.steps[1]).toMatchObject({ kind: "grant", state: "cancelled", walletAsked: false });
      });

      it("fund_agent reverted on chain, and the site marks the grant skipped (earlier_step): the grant stays skipped, never asked", async () => {
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: FUND_THEN_GRANT });
        const r = await link();
        Object.assign(r.steps![0], { state: "failed", tx_hash: HASH, wallet_asked: true });
        Object.assign(r.steps![1], { state: "skipped", reason_code: "earlier_step" });
        const b = await h.bundle!;
        expect(b.steps[0]).toMatchObject({ kind: "fund_agent", state: "failed", walletAsked: true });
        expect(b.steps[1]).toMatchObject({ kind: "grant", state: "skipped", walletAsked: false });
      });

      it("an unapproved link with money_moved unknown in the creation answer: the timeout still withdraws it on the site, and both steps are unknown", async () => {
        site.answerCreated = (b) => ({ ...b, money_moved: "unknown" });
        const c = client({ sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
        const b = await h.bundle!;
        // nobody can open the old link and fund it after a retry
        expect(site.requests[0].cancels).toBe(1);
        expect(site.requests[0].state).toBe("cancelled");
        expect(b.link).toMatchObject({ status: "expired", sending: true });
        expect(b.link.status === "expired" && b.link.reason).not.toMatch(/nothing was sent/);
        expect(b.steps).toMatchObject([{ kind: "fund_agent", state: "unknown", walletAsked: true }, { kind: "grant", state: "unknown", walletAsked: true }]);
      });

      it("an unapproved link whose first read was a 429 with money_moved unknown: the timeout still withdraws it on the site, and both steps are unknown", async () => {
        let gets = 0;
        const first429: typeof fetch = async (input, init) =>
          (init?.method ?? "GET") === "GET" && /\/requests\/bl_/.test(String(input)) && ++gets === 1
            ? new Response(JSON.stringify({ error: { code: "rate_limited", money_moved: "unknown" } }), { status: 429, headers: { "content-type": "application/json" } })
            : fetch(input, init);
        const c = client({ fetchImpl: first429, sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
        const b = await h.bundle!;
        expect(site.requests[0].cancels).toBe(1);
        expect(site.requests[0].state).toBe("cancelled");
        expect(b.link).toMatchObject({ status: "expired", sending: true });
        expect(b.steps).toMatchObject([{ kind: "fund_agent", state: "unknown", walletAsked: true }, { kind: "grant", state: "unknown", walletAsked: true }]);
        expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
      });

      it("a 429 with money movement after linking, while the last known step state is queued: the step is not skipped or unasked", async () => {
        let linked429 = 0;
        const noisy: typeof fetch = async (input, init) =>
          (init?.method ?? "GET") === "GET" && /\/requests\/bl_/.test(String(input)) && site.requests[0].state === "linked" && ++linked429 > 1
            ? new Response(JSON.stringify({ error: { code: "rate_limited", money_moved: "unknown" } }), { status: 429, headers: { "content-type": "application/json" } })
            : fetch(input, init);
        const c = client({ fetchImpl: noisy, sendingGraceMs: 200, auditPath: ownerApprovalsLog() });
        const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 500, then });
        const r = await link();
        // the step is queued on the one read that is answered, and the 429s after it show money may have moved
        const b = await h.bundle!;
        expect(b.link).toMatchObject({ status: "connected" });
        expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
        expect(b.steps[0].reason).not.toMatch(/nothing was sent/);
        expect(b.steps[0].state).not.toBe("skipped");
        expect(await recovered(h, r)).toMatchObject({ final: true, code: 5 });
      });

      describe("positive proof: a step is nothing sent only when an answer about this request shows it ended unasked, or the site confirmed the unapproved link withdrawn", () => {
        const HASH_B = `0x${"cd".repeat(32)}`;
        const quick = () => client({ sendingGraceMs: 200, quietGraceMs: 200, auditPath: ownerApprovalsLog() });
        const stepView = (i: number, state: string, extra: Record<string, unknown> = {}) => ({ index: i, kind: FUND_THEN_GRANT[i].kind, state, wallet_asked: false, tx_hash: null, ...extra });
        /** Reads: GET 1 gets `first` merged in; GET 2 on, the link is expired and every step skipped, with no evidence. */
        const expiresOnRead2 = (first: (v: any) => Record<string, unknown>) => {
          site.readAnswer = (r, v) => (r.polls === 1 ? { status: 200, body: { ...v, ...first(v) } } : undefined);
          site.onPoll = (r) => {
            if (r.polls >= 2) {
              r.state = "expired";
              for (const st of r.steps!) Object.assign(st, { state: "skipped", wallet_asked: false });
            }
          };
        };
        const unknownAll = (b: { steps: { state: string; walletAsked: boolean }[] }) => expect(b.steps.map((st) => st.state)).toEqual(b.steps.map(() => "unknown"));
        const ours = (over: Record<string, unknown>) => ({ id: site.requests[0].id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null, ...over });
        const cancelWith = (make: () => Response | Promise<Response>): typeof fetch => async (input, init) => (String(input).endsWith("/cancel") ? make() : fetch(input, init));

        it("a send-implying state on the envelope that no step explains, then an expired link and a skipped step: unknown, logged, recovery 5", async () => {
          expiresOnRead2(() => ({ state: "sending" }));
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
          const b = await h.bundle!;
          expect(b.link).toMatchObject({ status: "expired", sending: true });
          expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
          expect(lines().some((l) => l.sending === true)).toBe(true);
          expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
        });

        it("an extra step no known step matches, carrying a send, then a clean expired link: unknown, logged, recovery 5", async () => {
          expiresOnRead2((v) => ({ wallet_asked: true, steps: [...v.steps, { index: 9, kind: "unexpected", state: "sent", wallet_asked: true, tx_hash: HASH }] }));
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
          const b = await h.bundle!;
          expect(b.link).toMatchObject({ status: "expired", sending: true });
          expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
          expect(lines().some((l) => l.sending === true)).toBe(true);
          expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
        });

        it("a cancel answer whose error lists the grant as sent with another hash: the grant keeps that hash and is read from the chain", async () => {
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 400, then: FUND_THEN_GRANT });
          const r = await link();
          Object.assign(r.steps![0], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
          Object.assign(r.steps![1], { state: "awaiting_owner" });
          site.cancelAnswer = () => ({ status: 200, body: { id: r.id, state: "linked", final: true, wallet_asked: true, steps: [stepView(0, "confirmed", { wallet_asked: true, tx_hash: HASH }), stepView(1, "cancelled")], error: { steps: [stepView(1, "sent", { wallet_asked: true, tx_hash: HASH_B })] } } });
          const b = await h.bundle!;
          expect(b.steps[0]).toMatchObject({ hash: HASH, walletAsked: true });
          expect(b.steps[1]).toMatchObject({ hash: HASH_B, walletAsked: true });
          expect(b.steps[1].state).not.toBe("cancelled");
          expect(readFileSync(ownerApprovalsLog(), "utf8")).toContain("cd".repeat(32));
        });

        for (const [what, body] of [
          ["a foreign top-level id", () => ({ id: "bl_other123", state: "cancelled", final: true, wallet_asked: false, tx_hash: null, steps: [stepView(0, "skipped"), stepView(1, "skipped")] })],
          ["its own id with a foreign id in error", () => ours({ error: { id: "bl_other123" }, steps: [stepView(0, "skipped"), stepView(1, "skipped")] })],
        ] as const) {
          it(`linked, and the timeout cancel answers ${what}: the steps are unknown, never skipped`, async () => {
            const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 400, then: FUND_THEN_GRANT });
            const r = await link();
            Object.assign(r.steps![0], { state: "awaiting_owner" });
            site.cancelAnswer = () => ({ status: 200, body: body() });
            const b = await h.bundle!;
            expect(b.link).toMatchObject({ status: "connected" });
            expect(b.steps.map((st) => st.state)).toEqual(["unknown", "unknown"]);
            expect(r.cancels).toBe(1);
            expect(await recovered(h, r)).toMatchObject({ final: true, code: 5 });
          });
        }

        it("the owner proof is refused and the cancel answers a foreign id: the steps are not confirmed withdrawn, unknown, sending", async () => {
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: FUND_THEN_GRANT });
          const r = site.requests[0];
          Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "XYZ-UVW" }) });
          site.cancelAnswer = () => ({ status: 200, body: { id: "bl_other123", state: "cancelled", final: true, wallet_asked: false, tx_hash: null, steps: [stepView(0, "skipped"), stepView(1, "skipped")] } });
          const b = await h.bundle!;
          expect(b.link).toMatchObject({ status: "rejected", sending: true });
          expect(b.link.status === "rejected" && b.link.reason).toMatch(/not confirmed withdrawn/);
          expect(b.steps.map((st) => st.state)).toEqual(["unknown", "unknown"]);
        });

        const UNCONFIRMED: [string, () => void, typeof fetch | undefined][] = [
          ["200 {}", () => { site.cancelAnswer = () => ({ status: 200, body: {} }); }, undefined],
          ["a body that is not JSON", () => {}, cancelWith(() => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }))],
          ["a body over the 1 MB cap", () => {}, cancelWith(() => new Response(JSON.stringify({ pad: "x".repeat(2_000_000) }), { status: 200, headers: { "content-type": "application/json" } }))],
          ["503", () => { site.cancelFails = true; }, undefined],
          ["a fetch that throws", () => {}, cancelWith(() => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); })],
          ["no answer at all (the request is aborted)", () => {}, cancelWith(() => Promise.reject(new DOMException("aborted", "AbortError")))],
        ];
        for (const [what, setup, fetchImpl] of UNCONFIRMED) {
          it(`an unapproved link at its timeout, and the cancel gets ${what}: expired, sending, every step unknown, recovery 5`, async () => {
            setup();
            const c = client({ sendingGraceMs: 200, quietGraceMs: 200, auditPath: ownerApprovalsLog(), ...(fetchImpl ? { fetchImpl } : {}) });
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
            const b = await h.bundle!;
            expect(b.link).toMatchObject({ status: "expired", sending: true });
            expect(b.link.status === "expired" && b.link.reason).not.toMatch(/nothing was sent/);
            expect(b.steps.map((st) => st.state)).toEqual(["unknown", "unknown"]);
            expect(lines().some((l) => l.sending === true)).toBe(true);
            site.cancelFails = false;
            expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
          });
        }

        const refusedRead = (): typeof fetch => async (input, init) =>
          String(input).includes("/requests/") && !init?.method
            ? new Response(JSON.stringify({ error: { code: "ethereum_account_required", message: "x" } }), { status: 403, headers: { "content-type": "application/json" } })
            : fetch(input, init);

        it("an account refusal on an unapproved bundle, with the cancel working: withdrawn on the site, steps skipped, sending false", async () => {
          const h = await client({ fetchImpl: refusedRead(), auditPath: ownerApprovalsLog() }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: FUND_THEN_GRANT });
          const b = await h.bundle!;
          expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
          expect(b.link).toMatchObject({ sending: false });
          expect(b.steps.map((st) => st.state)).toEqual(["skipped", "skipped"]);
          expect(b.steps.some((st) => st.walletAsked)).toBe(false);
        });

        it("an account refusal on an unapproved bundle, with the cancel answering {}: steps unknown, sending", async () => {
          site.cancelAnswer = () => ({ status: 200, body: {} });
          const h = await client({ fetchImpl: refusedRead(), auditPath: ownerApprovalsLog() }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: FUND_THEN_GRANT });
          const b = await h.bundle!;
          expect(b.link).toMatchObject({ sending: true });
          expect(b.steps.map((st) => st.state)).toEqual(["unknown", "unknown"]);
        });

        it("close() on an unapproved bundle, with the cancel working: one shared cancel withdraws it, steps skipped, sending false", async () => {
          const c = client({ auditPath: ownerApprovalsLog() });
          const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: FUND_THEN_GRANT });
          await c.close();
          const b = await h.bundle!;
          expect(site.requests[0].state).toBe("cancelled");
          expect(b.link).toMatchObject({ sending: false });
          expect(b.steps.map((st) => st.state)).toEqual(["skipped", "skipped"]);
        });

        describe("close() shares the request's one cancellation: evidence only in the shutdown answer is kept", () => {
          const cleanSkipped = (id: string) => ({ id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null, steps: [stepView(0, "skipped")] });
          const slowClient = (over: Record<string, unknown> = {}) => client({ minPollMs: 500, sendingGraceMs: 50, quietGraceMs: 50, auditPath: ownerApprovalsLog(), ...over });
          const oneStep = [{ kind: "fund_agent" as const, transaction: FUND_TX }];

          it("the shutdown answer shows wallet_asked and a transaction, the next one would be clean: unknown, logged before close() returns, recovery 5, one cancel", async () => {
            let cancels = 0;
            site.cancelAnswer = (r) => (++cancels === 1 ? { status: 200, body: { id: r.id, state: "cancelled", final: true, wallet_asked: true, tx_hash: HASH, steps: r.steps } } : { status: 200, body: cleanSkipped(r.id) });
            const c = slowClient();
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: oneStep });
            await new Promise((res) => setTimeout(res, 100));
            await c.close();
            // by the time close() returns, the evidence is in the log
            expect(lines().some((l) => l.sending === true)).toBe(true);
            const b = await h.bundle!;
            expect(cancels).toBe(1);
            expect(b.link).toMatchObject({ status: "expired", sending: true });
            expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
            expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
          });

          it("the shutdown answer lists the step as sent with a hash only in error.steps: the step keeps the hash for the chain read", async () => {
            site.cancelAnswer = (r) => ({ status: 200, body: { ...cleanSkipped(r.id), error: { steps: [stepView(0, "sent", { wallet_asked: true, tx_hash: HASH_B })] } } });
            const c = slowClient();
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: oneStep });
            await new Promise((res) => setTimeout(res, 100));
            await c.close();
            const b = await h.bundle!;
            expect(b.link).toMatchObject({ sending: true });
            expect(b.steps[0]).toMatchObject({ hash: HASH_B, walletAsked: true });
            expect(readFileSync(ownerApprovalsLog(), "utf8")).toContain("cd".repeat(32));
            expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
          });

          it("the deadline cancel is in flight when close() is called: one cancel is sent, and its evidence-bearing answer is the one kept", async () => {
            let cancels = 0;
            const slow: typeof fetch = async (input, init) => {
              if (!String(input).endsWith("/cancel")) return fetch(input, init);
              const first = ++cancels === 1;
              await new Promise((res) => setTimeout(res, 250));
              const id = /requests\/(b[la]_[^/]+)\/cancel/.exec(String(input))![1];
              return new Response(JSON.stringify(first ? { id, state: "cancelled", final: true, wallet_asked: true, tx_hash: HASH, steps: [stepView(0, "skipped")] } : cleanSkipped(id)), { status: 200, headers: { "content-type": "application/json" } });
            };
            const c = slowClient({ fetchImpl: slow, minPollMs: 20 });
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: oneStep });
            // the deadline passes at 300 ms and its cancel takes 250 ms: close() lands in the middle
            await new Promise((res) => setTimeout(res, 400));
            await c.close();
            const b = await h.bundle!;
            expect(cancels).toBe(1);
            expect(b.link).toMatchObject({ sending: true });
            expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
            expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
          });

          /** close() is called while a read is in flight: its cancel answer comes late with evidence, and the reads meanwhile say cancelled and final, clean. */
          const closeRace = (): { fetchImpl: typeof fetch; closing: () => void; readStarted: Promise<void> } => {
            let closing = false;
            let started!: () => void;
            const readStarted = new Promise<void>((res) => (started = res));
            const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));
            return {
              readStarted,
              closing: () => { closing = true; },
              fetchImpl: async (input, init) => {
                const url = String(input);
                if (url.endsWith("/cancel")) {
                  await wait(400);
                  return new Response(JSON.stringify({ error: { code: "wallet_asked", state: "sending", wallet_asked: true, tx_hash: HASH, money_moved: "unknown" } }), { status: 409, headers: { "content-type": "application/json" } });
                }
                if ((init?.method ?? "GET") === "GET" && /\/requests\//.test(url) && closing) {
                  started();
                  await wait(100);
                  const r = site.requests[0];
                  const body = r.steps
                    ? { id: r.id, kind: r.kind, state: "cancelled", final: true, owner: null, tx_hash: null, wallet_asked: false, reason_code: "agent_cancelled", steps: r.steps.map((st) => ({ ...st, state: "skipped", wallet_asked: false, tx_hash: null })) }
                    : { id: r.id, kind: r.kind, state: "cancelled", final: true, owner: OWNER, tx_hash: null, wallet_asked: false };
                  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
                }
                return fetch(input, init);
              },
            };
          };

          it("a link with steps: the read settles clean before close()'s late cancel answer arrives: the answer is still learned, unknown, logged, recovery 5", async () => {
            const race = closeRace();
            const c = client({ fetchImpl: race.fetchImpl, minPollMs: 50, sendingGraceMs: 300, quietGraceMs: 300, auditPath: ownerApprovalsLog() });
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: oneStep });
            await new Promise((res) => setTimeout(res, 150));
            race.closing();
            // close() is called while the read that answers "cancelled, final, clean" is in flight
            await race.readStarted;
            await c.close();
            const b = await h.bundle!;
            expect(b.link).toMatchObject({ sending: true });
            expect(b.steps[0]).toMatchObject({ state: "unknown", walletAsked: true });
            expect(lines().some((l) => l.sending === true)).toBe(true);
            expect(await recovered(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
          });

          it("a single approval: the read says cancelled before close()'s late cancel answer shows the wallet was asked: sending, logged, and not 'before the wallet was asked'", async () => {
            site.owner = OWNER;
            const race = closeRace();
            const c = client({ fetchImpl: race.fetchImpl, minPollMs: 50, sendingGraceMs: 300, auditPath: ownerApprovalsLog() });
            const h = await grant(c);
            await new Promise((res) => setTimeout(res, 150));
            race.closing();
            await race.readStarted;
            await c.close();
            const o = await h.settled;
            expect(o).toMatchObject({ status: "rejected", sending: true });
            expect(o.status === "rejected" && o.reason).not.toMatch(/nothing was sent|before the wallet was asked/);
            // either the read's end, upgraded by close()'s answer, or the stop: never a clean end
            expect(o.status === "rejected" && o.reason).toMatch(/whether anything was sent is unknown|check wallet activity/);
            expect(lines().some((l) => l.sending === true)).toBe(true);
          });

          // ---- single approvals ----
          const evidenceThenClean = (): void => {
            let cancels = 0;
            site.cancelAnswer = (r) => (++cancels === 1 ? { status: 200, body: { id: r.id, state: "cancelled", final: true, wallet_asked: true, tx_hash: HASH } } : { status: 200, body: { id: r.id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null } });
          };
          const recoverSingle = async (h: { url: string }, req: { id: string; token: string }) => {
            const id = approvals.newApprovalId();
            approvals.saveApproval({ id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(), hosted: { site: site.url, requestId: req.id, token: req.token, kind: "grant", matchCode: "ABC-DEF" } });
            return approvals.waitFor(id, 1000);
          };

          it("a single approval: the shutdown answer shows a transaction; the log has it the moment close() returns, before the poller ends, and recovery says 5", async () => {
            site.owner = OWNER;
            evidenceThenClean();
            const c = client({ minPollMs: 2500, sendingGraceMs: 50, auditPath: ownerApprovalsLog() });
            const h = await grant(c);
            await new Promise((res) => setTimeout(res, 100));
            await c.close();
            // without awaiting h.settled: a process that exits here never reaches the poller's own end
            expect(lines().some((l) => l.sending === true && l.hash === HASH)).toBe(true);
            expect(await recoverSingle(h, site.requests[0])).toMatchObject({ final: true, code: 5 });
            expect(await h.settled).toMatchObject({ sending: true });
          });

          it("a single approval in a process that exits right after close(): a later wait still says 5 though the next cancel is clean", async () => {
            site.owner = OWNER;
            evidenceThenClean();
            // a hung child is killed after 50 s (before the test's own 60 s) and never outlives the test; its stderr is in any failure
            const out = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((done, fail) => {
              const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "test/helpers/hosted-close-child.ts"), site.url], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: fileHome }, timeout: 50_000, killSignal: "SIGKILL" });
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (x) => (stdout += x));
              child.stderr.on("data", (x) => (stderr += x));
              child.once("error", (err) => {
                child.kill("SIGKILL");
                fail(err);
              });
              child.once("close", (code, signal) => done({ code, signal, stdout, stderr }));
            });
            const why = `exit ${out.code}${out.signal ? ` (${out.signal})` : ""}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`;
            expect(out.code, why).toBe(0);
            const child = JSON.parse(out.stdout.trim().split("\n").at(-1)!);
            expect(child).toMatchObject({ closed: true, loggedSending: true });
            expect(await approvals.waitFor(child.id, 1000)).toMatchObject({ final: true, code: 5 });
          }, 60_000);

          for (const [where, setup] of [
            ["deadline", () => {}],
            ["owner-mismatch", () => { site.onPoll = (r) => { if (r.polls >= 2) r.owner = OTHER; }; }],
          ] as [string, () => void][]) {
            it(`a single approval's ${where} cancellation is held while close() is called: one cancel, and close() waits for its answer, which is logged`, async () => {
              site.owner = OWNER;
              setup();
              let calls = 0;
              let started!: () => void;
              let release!: () => void;
              const began = new Promise<void>((res) => (started = res));
              const hold = new Promise<void>((res) => (release = res));
              const held: typeof fetch = async (input, init) => {
                if (!String(input).endsWith("/cancel")) return fetch(input, init);
                const first = ++calls === 1;
                if (first) {
                  started();
                  await hold;
                }
                const id = site.requests[0].id;
                return new Response(JSON.stringify(first ? { id, state: "cancelled", final: true, wallet_asked: true, tx_hash: HASH } : { id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null }), { status: 200, headers: { "content-type": "application/json" } });
              };
              const c = client({ fetchImpl: held, minPollMs: 20, sendingGraceMs: 50, auditPath: ownerApprovalsLog() });
              const h = await grant(c, where === "deadline" ? 150 : 60_000);
              await began;
              let closed = false;
              const closing = c.close().then(() => (closed = true));
              await new Promise((res) => setTimeout(res, 80));
              expect(closed).toBe(false);
              expect(calls).toBe(1);
              release();
              await closing;
              expect(calls).toBe(1);
              expect(lines().some((l) => l.sending === true && l.hash === HASH)).toBe(true);
              expect(await h.settled).toMatchObject({ sending: true });
            });
          }

          it("control: a plain link's close() goes through the same call and stays sending false", async () => {
            const c = client({ minPollMs: 20, auditPath: ownerApprovalsLog() });
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
            await c.close();
            expect(await h.settled).toMatchObject({ sending: false });
            expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
          });

          it("the clean-stop control: a clean shutdown answer is shared, and the step is skipped with sending false", async () => {
            const c = slowClient();
            const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: oneStep });
            await new Promise((res) => setTimeout(res, 100));
            await c.close();
            const b = await h.bundle!;
            expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
            expect(b.link).toMatchObject({ sending: false });
            expect(b.steps[0]).toMatchObject({ state: "skipped", walletAsked: false });
          });
        });

        // controls
        it("control E: an unapproved link, clean, at its timeout: one cancel, expired, sending false, both steps skipped", async () => {
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
          const b = await h.bundle!;
          expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
          expect(b.link).toMatchObject({ status: "expired", sending: false });
          expect(b.steps).toMatchObject([{ state: "skipped", walletAsked: false }, { state: "skipped", walletAsked: false }]);
        });

        it("control F: an unapproved link whose creation answer shows step 0 asked: one cancel, sending, fund_agent unknown, the grant skipped", async () => {
          site.answerSteps = (st) => [{ ...st[0], wallet_asked: true }, st[1]];
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
          const b = await h.bundle!;
          expect(site.requests[0].cancels).toBe(1);
          expect(b.link).toMatchObject({ sending: true });
          expect(b.steps).toMatchObject([{ kind: "fund_agent", state: "unknown", walletAsked: true }, { kind: "grant", state: "skipped", walletAsked: false }]);
        });

        it("control N: an unapproved link whose cancel answers 409 not_open, cancelled, no evidence: steps skipped, sending false", async () => {
          site.cancelAnswer = () => ({ status: 409, body: { error: { code: "not_open", message: "already cancelled", state: "cancelled", wallet_asked: false, tx_hash: null, money_moved: false } } });
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 300, then: FUND_THEN_GRANT });
          const b = await h.bundle!;
          expect(b.link).toMatchObject({ status: "expired", sending: false });
          expect(b.steps.map((st) => st.state)).toEqual(["skipped", "skipped"]);
        });

        it("control: a plain link without steps never goes through the bundle", async () => {
          const h = await quick().request({ kind: "connect", terms: TERMS, timeoutMs: 300 });
          expect(h.bundle).toBeUndefined();
          expect(await h.settled).toMatchObject({ sending: false });
        });
      });
    });

    it("a single approval with wallet_asked on GET 1, then a clean cancelled read: unknown in its words too, never 'before the wallet was asked; nothing was sent'", async () => {
      site.owner = OWNER;
      site.onPoll = (r) => {
        if (r.polls === 1) Object.assign(r, { wallet_asked: true });
        else Object.assign(r, { wallet_asked: false, state: "cancelled" });
      };
      const h = await grant(client({ sendingGraceMs: 200 }));
      const o = await h.settled;
      expect(o).toMatchObject({ status: "rejected", sending: true });
      expect(o.status === "rejected" && o.reason).not.toMatch(/nothing was sent|before the wallet was asked/);
      expect(o.status === "rejected" && o.reason).toMatch(/whether anything was sent is unknown/);
    });

    it("a hash on GET 1 and no owner named at all: unknown", async () => {
      site.owner = null;
      site.cancelAnswer = coherent;
      site.onPoll = (r) => {
        r.owner = null;
        first({ tx_hash: HASH, wallet_asked: true })(r);
      };
      const err = await grant(client()).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.sending).toBe(true);
      expect(err.message).not.toMatch(/nothing was sent/);
    });

    it("the control: clean on every read and a clean cancel is still nothing sent", async () => {
      site.owner = OTHER;
      const err = await grant(client()).catch((e) => e);
      expect(err.sending).toBe(false);
      expect(err.message).toMatch(/nothing was sent/);
    });

    it("evidence in the creation answer's steps, then a step mismatch and a clean cancel: unknown", async () => {
      site.answerSteps = (st) => [{ ...st[0], wallet_asked: true }, { ...st[1], kind: "fund_agent" }];
      const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];
      const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then }).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.sending).toBe(true);
      expect(err.message).not.toMatch(/nothing was sent/);
    });

    it("evidence in the creation answer's steps seeds the bundle: the step is not reported as never asked", async () => {
      site.answerSteps = (st) => [{ ...st[0], wallet_asked: true }, st[1]];
      const then = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];
      const h = await client({ sendingGraceMs: 200 }).request({ kind: "connect", terms: TERMS, timeoutMs: 300, then });
      const b = await h.bundle!;
      expect(b.steps[0]).toMatchObject({ kind: "fund_agent", walletAsked: true });
      expect(b.steps[0].state).not.toBe("skipped");
      expect(b.steps[0].reason).not.toMatch(/^nothing was sent/);
    });
  });

  it("the owner changes after the link is shown, and the cancel is not confirmed: unknown, not 'not used'", async () => {
    site.owner = OWNER;
    site.cancelAnswer = () => ({ status: 200, body: {} });
    site.onPoll = (r) => {
      if (r.polls >= 2) r.owner = OTHER;
    };
    const h = await grant(client());
    expect(await h.settled).toMatchObject({ status: "rejected", sending: true });
  });

  it("the owner changes after the link is shown, and the site confirms the cancel: nothing was sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) r.owner = OTHER;
    };
    const h = await grant(client());
    expect(await h.settled).toMatchObject({ status: "rejected", sending: false });
  });

  it("a hash seen earlier, then reads without it, and the command's timeout: unknown, never nothing sent", async () => {
    site.owner = OWNER;
    site.cancelAnswer = () => ({ status: 200, body: { id: site.requests[0].id, state: "cancelled", final: true, wallet_asked: false, tx_hash: null } });
    site.onPoll = (r) => {
      // polls 1 is the owner check before the link is shown; the poll's own first read is 2
      r.tx_hash = r.polls === 2 ? HASH : null;
    };
    const h = await grant(client({ sendingGraceMs: 300 }), 300);
    const o = await h.settled;
    expect(o).toMatchObject({ status: "expired", sending: true });
    // the site was never asked to cancel: the hash had been seen
    expect(site.requests[0].cancels).toBe(0);
  });
});

describe("--replace on a hosted approval whose wallet was asked", () => {
  const home = fileHome;
  let site: FakeSite;

  beforeEach(async () => {
    rmSync(ownerApprovalsLog(), { force: true });
    site = await startFakeSite();
  });
  afterEach(async () => {
    await site.close();
  });

  it("ends unknown (exit 5), not refused_precheck, even when the site confirms the cancel", async () => {
    site.owner = OWNER;
    const h = await new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(home, "audit.jsonl"), pollWaitS: 0, minPollMs: 20 })
      .request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
    const req = site.requests[0];
    // the page log says the wallet was asked for this request
    mkdirSync(join(home, "budget"), { recursive: true });
    writeFileSync(join(home, "budget", "owner-approvals.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), id: req.id, kind: "evm-transaction", title: "Grant a spending budget", status: "sending", sending: true })}\n`, { mode: 0o600 });
    const id = approvals.newApprovalId();
    approvals.saveApproval({
      id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting", url: h.url, createdAt: new Date().toISOString(),
      hosted: { site: site.url, requestId: req.id, token: req.token, kind: "grant", matchCode: "ABC-DEF" },
    });
    const r = await approvals.replacePending(approvals.readApproval(id), "oa-20261013000000-00000000");
    expect(r.ok).toBe(true);
    const ended = approvals.readApproval(id)!;
    expect(ended.final).toMatchObject({ code: 5, result: { state: "unknown" } });
    expect(JSON.stringify(ended)).not.toContain("ssbt_");
  });

  it("is not replaced when the site's cancel answer is empty", async () => {
    site.owner = OWNER;
    site.cancelAnswer = () => ({ status: 200, body: {} });
    await new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(home, "audit.jsonl"), pollWaitS: 0, minPollMs: 20 })
      .request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
    const req = site.requests[0];
    const id = approvals.newApprovalId();
    approvals.saveApproval({
      id, command: "grant", rail: "evm", chain: "base-sepolia", state: "waiting", url: `${site.url}/approve/budget/${req.id}#x`, createdAt: new Date().toISOString(),
      hosted: { site: site.url, requestId: req.id, token: req.token, kind: "grant", matchCode: "ABC-DEF" },
    });
    const r = await approvals.replacePending(approvals.readApproval(id), "oa-20261013000000-00000000");
    expect(r.ok).toBe(false);
    expect(approvals.readApproval(id)!.final).toBeUndefined();
  });
});

describe("through the CLI", () => {
  let home: string;
  let site: FakeSite;
  let rpc: TestServer;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "ss-budget-hosted-cancel-"));
    site = await startFakeSite();
    rpc = await startFakeRpc(84532);
  });
  afterEach(async () => {
    await site.close();
    await rpc.close();
    rmSync(home, { recursive: true, force: true });
  });

  function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any }> {
    return new Promise((done, fail) => {
      const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc.url };
      delete env.SUPERSTABLES_SITE;
      delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
      tree.set({ "base-sepolia": [{ url: rpc.url, operator: "fake-a" }, { url: `${rpc.url}/`, operator: "fake-b" }] });
      const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.once("error", fail);
      child.once("close", (code) => {
        const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
        done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice("RESULT ".length)) : null });
      });
    });
  }

  const hostedChain = () => {
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${KEY}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`);
  };

  it("grant: the site names another owner and answers the cancel with {}: unknown (exit 5), next reads the chain", async () => {
    hostedChain();
    site.owner = OTHER;
    site.cancelAnswer = () => ({ status: 200, body: {} });
    const r = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(5);
    expect(r.result.state).toBe("unknown");
    expect(r.result.reason).not.toMatch(/nothing was sent/);
    expect(r.result.next).toMatch(/superstables budget status/);
  }, 60_000);

  /** The agent key setup reuses, with no owner on record: the owner is whoever adds the agent on the site. */
  const agentOnly = () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${KEY}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  };
  const SETUP = ["setup", "--rail", "evm", "--hosted", "--fund", "--wait", "--no-open", "--timeout", "10"];

  it("setup --fund: wallet_asked in the envelope of GET 1, then an expired link and a skipped step: unknown (exit 5), and next says to read the chain", async () => {
    agentOnly();
    site.readAnswer = (r, v) => (r.polls === 1 ? { status: 200, body: { ...v, wallet_asked: true } } : undefined);
    site.onPoll = (r) => {
      if (r.polls >= 2) {
        r.state = "expired";
        for (const st of r.steps ?? []) Object.assign(st, { state: "skipped", wallet_asked: false });
      }
    };
    const r = await budget([...SETUP, "--site", site.url]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result.state).toBe("unknown");
    expect(r.result.reason).not.toMatch(/nothing was sent/);
    expect(r.result.next).toMatch(/read whether it landed before running this again/);
    expect(r.result.next).not.toMatch(/nothing was sent|run the same command again|To try again/);
  }, 60_000);

  it("setup --fund: the timeout cancel answers 200 final with error.money_moved unknown and a skipped step: unknown (exit 5), never skipped", async () => {
    agentOnly();
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--fund", "--no-open", "--timeout", "10", "--site", site.url]);
    expect(first.code, first.stderr).toBe(0);
    const req = site.requests[0];
    Object.assign(req, { state: "linked", owner: OWNER });
    Object.assign(req.steps![0], { state: "awaiting_owner" });
    site.cancelAnswer = () => ({ status: 200, body: { id: req.id, state: "cancelled", final: true, error: { money_moved: "unknown" }, steps: [{ index: 0, kind: "fund_agent", state: "skipped", wallet_asked: false, tx_hash: null }] } });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "150"]);
    expect(done.code, done.stdout + done.stderr).toBe(5);
    expect(done.result).toMatchObject({ state: "unknown", linked: true, steps: [{ kind: "fund_agent", state: "unknown" }] });
    expect(JSON.stringify(done.result)).not.toMatch(/nothing was sent/);
  }, 240_000);

  const NEXT_STATUS = /^superstables budget status --rail evm/;

  it("setup --fund: a send-implying state on GET 1 that no step explains, then an expired link: unknown (exit 5), next reads the chain", async () => {
    agentOnly();
    site.readAnswer = (r, v) => (r.polls === 1 ? { status: 200, body: { ...v, state: "sending" } } : undefined);
    site.onPoll = (r) => {
      r.owner = null;
      if (r.polls > 1) {
        Object.assign(r, { wallet_asked: false, state: "expired", final: true });
        Object.assign(r.steps![0], { state: "skipped", wallet_asked: false });
      }
    };
    const r = await budget([...SETUP, "--site", site.url]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.next).toMatch(NEXT_STATUS);
    expect(r.result.reason).not.toMatch(/nothing was sent/);
    expect(r.result.next).not.toMatch(/nothing was sent|run the same command again|To try again/);
  }, 60_000);

  it("setup --fund: wallet_asked and an extra step carrying a send on GET 1, then an expired link: unknown (exit 5), next reads the chain", async () => {
    agentOnly();
    site.readAnswer = (r, v) => (r.polls === 1 ? { status: 200, body: { ...v, wallet_asked: true, steps: [...(v.steps as any[]), { index: 9, kind: "unexpected", state: "sent", wallet_asked: true, tx_hash: `0x${"ab".repeat(32)}` }] } } : undefined);
    site.onPoll = (r) => {
      r.owner = null;
      if (r.polls > 1) {
        Object.assign(r, { wallet_asked: false, state: "expired", final: true });
        Object.assign(r.steps![0], { state: "skipped", wallet_asked: false });
      }
    };
    const r = await budget([...SETUP, "--site", site.url]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.next).toMatch(NEXT_STATUS);
    expect(r.result.next).not.toMatch(/nothing was sent|run the same command again|To try again/);
  }, 60_000);

  it("setup --fund: the timeout cancel answers a foreign request's final cancellation: unknown (exit 5), the funding step unknown", async () => {
    agentOnly();
    site.onPoll = (r) => {
      Object.assign(r, { owner: OWNER, state: "linked" });
      r.steps![0].state = "awaiting_owner";
    };
    site.cancelAnswer = (r) => ({ status: 200, body: { id: "bl_other123", state: "cancelled", final: true, wallet_asked: false, tx_hash: null, steps: r.steps?.map((st) => ({ ...st, state: "skipped", wallet_asked: false, tx_hash: null })) } });
    const r = await budget([...SETUP, "--site", site.url]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.next).toMatch(NEXT_STATUS);
    expect(JSON.stringify(r.result)).not.toMatch(/nothing was sent: not asked/);
    if (r.result.steps) expect(r.result.steps[0]).toMatchObject({ kind: "fund_agent", state: "unknown" });
  }, 90_000);

  it("setup --fund: the timeout cancel answers {} and the link is still open: unknown (exit 5), no 'nothing was sent', next reads the chain", async () => {
    agentOnly();
    site.cancelAnswer = () => ({ status: 200, body: {} });
    const r = await budget([...SETUP, "--site", site.url]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.reason).not.toMatch(/nothing was sent/);
    expect(r.result.next).toMatch(NEXT_STATUS);
    expect(r.result.next).not.toMatch(/nothing was sent|run the same command again|To try again/);
  }, 120_000);

  it("grant: the same site with a coherent cancel answer: nothing was sent (exit 3)", async () => {
    hostedChain();
    site.owner = OTHER;
    const r = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(/nothing was sent/);
  }, 60_000);
});
