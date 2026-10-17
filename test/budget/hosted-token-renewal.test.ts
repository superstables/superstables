// Token renewal: a budget poll that gets 401 token_expired renews once with a fresh agent proof
// (POST /api/v1/budget/requests/{id}/token, body { agent }) and reads again; a purchase read that gets it keeps the record.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals, type HostedRecord } from "../../budget/hosted.js";
import { evmOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

// the owner proof the site answered with is passed on, for the agent binding
const PROOF = { message: expect.stringMatching(/^Superstables: add an agent to my account/), signature: expect.stringMatching(/^0x[0-9a-f]+$/) };

process.env.SUPERSTABLES_HOME = mkdtempSync(join(tmpdir(), "ss-renewal-"));
const { settleOnce } = await import("../../budget/once.mjs");
const approvals = await import("../../budget/approvals.mjs");
const home = process.env.SUPERSTABLES_HOME;

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TERMS = { title: "Add this agent", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT = { kind: "grant" as const, transaction: { to: USDC, data: "0x095ea7b3", value: "0x0" } };

let site: FakeSite;
let records: HostedRecord[];
beforeEach(async () => {
  site = await startFakeSite();
  records = [];
});
afterEach(async () => {
  await site.close();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));
const evm = () => new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, onRecord: (r) => records.push(r) });
const connect = (c: HostedApprovals = evm(), extra: Record<string, unknown> = {}) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...extra } as any);
/** The token expires on the first read, then the request is linked on the next. */
const expireThenLink = () => {
  site.onPoll = (r) => {
    if (r.kind !== "link") return;
    if (r.polls === 1) r.expired = true;
    if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
  };
};

describe("a budget poll whose token expired", () => {
  it("R1: renews once with a fresh agent proof, stores the new token in the record, and settles; the old token is never used again", async () => {
    expireThenLink();
    const h = await connect();
    const oldToken = site.requests[0].token;
    expect(await h.settled).toEqual({ status: "connected", address: OWNER, proof: PROOF });
    const renewal = site.posts.filter((p) => p.path.endsWith("/token"));
    expect(renewal).toEqual([{ path: `/api/v1/budget/requests/${site.requests[0].id}/token`, ok: true, why: undefined }]);
    // the record: first the creation, then the same request with the new token, and nothing else changed
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual({ ...records[0], token: site.requests[0].token });
    expect(records[1].token).not.toBe(oldToken);
    expect(records[1].token).toMatch(/^ssbt_/);
    expect(site.readTokens.filter((t) => t === `Bearer ${oldToken}`)).toHaveLength(1);
    expect(site.readTokens.at(-1)).toBe(`Bearer ${site.requests[0].token}`);
  });

  it("R1b: the same for a link with wallet steps (the bundle)", async () => {
    expireThenLink();
    const h = await connect(evm(), { then: [GRANT] });
    const oldToken = site.requests[0].token;
    site.requests[0].steps![0].state = "confirmed";
    expect((await h.bundle!).link).toEqual({ status: "connected", address: OWNER, proof: PROOF });
    expect(site.requests[0].renewals).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[1].token).toBe(site.requests[0].token);
    expect(site.readTokens.filter((t) => t === `Bearer ${oldToken}`)).toHaveLength(1);
  });

  it("R1c: a request cancelled later (the deadline, close) uses the new token", async () => {
    expireThenLink();
    site.onPoll = (r) => { if (r.polls === 1) r.expired = true; };
    const c = evm();
    const h = await connect(c);
    await new Promise((r) => setTimeout(r, 300));
    await c.close();
    expect(site.requests[0].renewals).toBe(1);
    expect(site.requests[0].cancels).toBeGreaterThanOrEqual(1);
    void h.settled;
  });

  it("R2: a second token_expired ends as no longer answering, after one renewal", async () => {
    site.renewKeepsExpired = true;
    site.onPoll = (r) => { if (r.polls === 1) r.expired = true; };
    const h = await connect();
    const out = await h.settled;
    expect(out).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no longer answers for this request.*token_expired/) });
    expect(site.requests[0].renewals).toBe(1);
  });

  it("R3 (adversarial): a renewal answer without a valid ssbt_ token ends as no longer answering, and nothing is stored", async () => {
    for (const body of [{ id: "x", access_token: "nope" }, { id: "x" }, { access_token: 5 }, "text"]) {
      records = [];
      site.renewAnswer = () => ({ status: 200, body });
      site.onPoll = (r) => { if (r.polls === 1) r.expired = true; };
      const h = await connect();
      expect(await h.settled, JSON.stringify(body)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no longer answers/) });
      expect(records, JSON.stringify(body)).toHaveLength(1);
    }
  });

  it("R3b: a renewal the site refuses ends the same way", async () => {
    site.renewAnswer = () => ({ status: 403, body: { error: { code: "not_your_request", message: "x" } } });
    site.onPoll = (r) => { if (r.polls === 1) r.expired = true; };
    const h = await connect();
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no longer answers/) });
    expect(records).toHaveLength(1);
  });

  it("R5: a token that never expired is never renewed", async () => {
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER }); };
    const h = await connect();
    await h.settled;
    expect(site.posts.filter((p) => p.path.endsWith("/token"))).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it("R6: a 401 with another code is not renewed", async () => {
    site.readAnswer = () => ({ status: 401, body: { error: { code: "unauthorized", message: "x" } } });
    const h = await connect();
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no longer answers/) });
    expect(site.posts.filter((p) => p.path.endsWith("/token"))).toEqual([]);
  });
});

describe("a purchase read whose token expired", () => {
  let psite: FakePurchaseSite;
  beforeEach(async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    psite = await startFakePurchaseSite();
  });
  afterEach(async () => { await psite.close(); });

  it("R4: the record is kept, and it says the site no longer answers for it", async () => {
    const response = await fetch(`${psite.url}/api/v1/purchases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: "demo-market-data", params: { asset: "BTC" }, max_amount: "0.01" }) });
    expect(response.status).toBe(201);
    const p = psite.purchases[0];
    const record = { id: approvals.newApprovalId(), command: "buy-once", rail: "evm", chain: "base-sepolia", createdAt: new Date().toISOString(), state: "waiting_owner", attributionVersion: 2, hosted: { kind: "purchase", site: psite.url, requestId: p.id, token: p.token, amount: p.service.amount, payTo: "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E" } };
    approvals.saveApproval(record);
    psite.readAnswer = () => ({ status: 401, body: { error: { code: "token_expired", message: "this purchase ended over 30 days ago", money_moved: false } } });
    const s = await settleOnce(record);
    expect(s).toMatchObject({ final: true, code: 5, result: { state: "unknown", final: false, paid: null, reasonCode: "token_expired" } });
    expect(s.result.next).toContain("the site no longer answers for this purchase (its access token expired); ask the owner to check it on their account;");
    expect(s.result.next).toContain(`superstables budget wait --id ${record.id} --abandon`);
    const kept = approvals.readApproval(record.id);
    expect(kept.final).toBeUndefined();
    expect(kept.hosted.token).toBe(p.token);
  });
});
