// A hosted request outlives the command that made it when the host ends every process of that command (budget/hosted.ts:
// HostedSettings.resume). A later worker takes the recorded request over: it creates none, reads it from the site before any
// expiry is acted on, leaves it open when it ends, and refuses a request that asks for something else. Against a fake
// superstables.com. No network, no real key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals, HostedRefusal, type HostedRecord } from "../../budget/hosted.js";
import { evmOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const OTHER = evmOwner("33");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const FUND_HASH = `0x${"cd".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };
const FUND_TX = { to: AGENT, data: "0x", value: "0x2386f26fc10000" };
const THEN = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];

describe("a hosted request taken over by a later worker", () => {
  let site: FakeSite;
  let dir: string;
  let records: HostedRecord[];
  const client = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(dir, "audit.jsonl"), onRecord: (r) => records.push(r), pollWaitS: 0, minPollMs: 20, resumable: true, ...over });
  const grant = (c: HostedApprovals, over: { transaction?: typeof GRANT_TX; action?: string; timeoutMs?: number } = {}) =>
    c.request({ kind: "evm-transaction", action: over.action ?? "grant", account: OWNER, transaction: over.transaction ?? GRANT_TX, terms: TERMS, timeoutMs: over.timeoutMs ?? 60_000 });
  /**
   * The first worker made the request and the host ended it: from then on nothing it sends reaches the site (it never ends the
   * request itself, as a process that is gone cannot). Its record is what a later worker is given.
   */
  let gone = false;
  const deadFetch: typeof fetch = (input, init) => (gone ? new Promise<Response>(() => {}) : fetch(input, init));
  const firstWorker = async () => {
    site.owner = OWNER;
    gone = false;
    const first = client({ fetchImpl: deadFetch });
    await grant(first);
    gone = true;
    expect(records).toHaveLength(1);
    return records[0];
  };

  beforeEach(async () => {
    site = await startFakeSite();
    dir = mkdtempSync(join(tmpdir(), "ss-hosted-resume-"));
    records = [];
  });
  afterEach(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a resumable request's record keeps what a later worker needs; a request that is not resumable keeps nothing more", async () => {
    const record = await firstWorker();
    expect(record).toMatchObject({ site: site.url, requestId: "ba_test0001", kind: "grant", matchCode: "ABC-DEF", resumable: true });
    expect(record.intent).toMatch(/^[0-9a-f]{64}$/);
    expect(record.expiresAt).toBeGreaterThan(Date.now());
    expect(record.deadline).toBeGreaterThan(Date.now());
    records.length = 0;
    await grant(client({ resumable: false }));
    expect(records[0]).toEqual({ site: site.url, requestId: "ba_test0002", token: expect.stringMatching(/^ssbt_/), kind: "grant", matchCode: "ABC-DEF" });
  });

  it("creates no request: it reads the recorded one, and settles when the owner approved it after the first worker was gone", async () => {
    const record = await firstWorker();
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
    const later = client({ resume: record });
    const h = await grant(later);
    expect(h.adopted).toBe(true);
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
    // one request, one POST: the later worker never asked the site for another
    expect(site.requests).toHaveLength(1);
    expect(site.posts).toEqual([{ path: "/api/v1/budget/approvals", ok: true, why: undefined }]);
    await later.close();
  });

  it("is not cancelled when the worker that took it over ends: the next one finishes it", async () => {
    const record = await firstWorker();
    const later = client({ resume: record });
    const h = await grant(later);
    // the owner has not approved yet, and this worker's command ends
    await later.close();
    expect(site.requests[0]).toMatchObject({ state: "awaiting_owner", cancels: 0 });
    // a worker that made the request itself still withdraws it when its command ends: unchanged
    const own = client();
    await grant(own);
    await own.close();
    expect(site.requests[1]).toMatchObject({ state: "cancelled", cancels: 1 });
    void h.settled;
  });

  it("reads the site first, past the request's expiry: an approval the owner gave in time is settled, not called expired", async () => {
    site.expiresInMs = 100;
    const record = await firstWorker();
    await new Promise((r) => setTimeout(r, 400));
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
    const h = await grant(client({ resume: record, minPollMs: 20 }));
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
    expect(site.requests[0].cancels).toBe(0);
  });

  it("an expired request nobody approved ends as expired, as the first worker would have ended it", async () => {
    site.expiresInMs = 100;
    const record = await firstWorker();
    await new Promise((r) => setTimeout(r, 400));
    const h = await grant(client({ resume: { ...record, deadline: Date.now() - 1000 }, quietGraceMs: 50 }));
    const outcome = await h.settled;
    expect(outcome).toMatchObject({ status: "expired" });
    expect(outcome).not.toMatchObject({ sending: true });
  });

  it("a request the site ended is reported as the site ended it", async () => {
    const record = await firstWorker();
    Object.assign(site.requests[0], { state: "rejected", reason: "no", reason_code: "owner_rejected" });
    const h = await grant(client({ resume: record }));
    expect(await h.settled).toMatchObject({ status: "rejected" });
  });

  describe("only the same request is finished", () => {
    it.each([
      ["another transaction", (r: HostedRecord) => ({ resume: r, transaction: { ...GRANT_TX, to: OTHER } })],
      ["another kind", (r: HostedRecord) => ({ resume: r, action: "revoke" })],
      ["another site", (r: HostedRecord) => ({ resume: { ...r, site: "https://staging.superstables.com" } })],
      ["a record from before the request kept what was asked", (r: HostedRecord) => ({ resume: { ...r, intent: undefined } })],
    ])("%s: refused as unknown, nothing created and nothing cancelled", async (_what, change) => {
      const record = await firstWorker();
      const { resume, ...ask } = change(record) as { resume: HostedRecord; transaction?: typeof GRANT_TX; action?: string };
      const err = await grant(client({ resume }), ask).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.sending).toBe(true);
      expect(err.message).toMatch(/cannot be finished/);
      expect(site.requests).toHaveLength(1);
      expect(site.requests[0]).toMatchObject({ state: "awaiting_owner", cancels: 0 });
    });
  });

  it("a link with steps: the bundle settles from the recorded request, with the owner proof checked", async () => {
    gone = false;
    const first = client({ fetchImpl: deadFetch });
    const h1 = await first.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN });
    gone = true;
    expect(h1.bundle).toBeDefined();
    const record = records[0];
    expect(record).toMatchObject({ kind: "link", then: ["fund_agent", "grant"], resumable: true });
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
    const later = client({ resume: record });
    const h = await later.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN });
    expect(h.adopted).toBe(true);
    const bundle = await h.bundle!;
    expect(bundle.link).toMatchObject({ status: "connected", address: OWNER, proof: { message: expect.stringMatching(/^Superstables: add an agent to my account\n/) } });
    expect(bundle.steps).toMatchObject([{ kind: "fund_agent", state: "confirmed", hash: FUND_HASH }, { kind: "grant", state: "confirmed", hash: HASH }]);
    expect(site.posts).toHaveLength(1);
    expect(r.cancels).toBe(0);
  });

  it("a link with steps, past the expiry: the owner's link and steps are read first, not withdrawn", async () => {
    site.expiresInMs = 100;
    gone = false;
    const first = client({ fetchImpl: deadFetch });
    await first.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN });
    gone = true;
    const record = { ...records[0], deadline: Date.now() - 1000 };
    await new Promise((r) => setTimeout(r, 400));
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    for (const [i, hash] of [FUND_HASH, HASH].entries()) Object.assign(r.steps![i], { state: "confirmed", tx_hash: hash, wallet_asked: true });
    const h = await client({ resume: record }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN });
    const bundle = await h.bundle!;
    expect(bundle.link).toMatchObject({ status: "connected", address: OWNER });
    expect(bundle.steps.map((s) => s.state)).toEqual(["confirmed", "confirmed"]);
    expect(r.cancels).toBe(0);
  });

  it("a link with no steps settles as connected from the recorded request", async () => {
    gone = false;
    const first = client({ fetchImpl: deadFetch });
    await first.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    gone = true;
    const record = records[0];
    Object.assign(site.requests[0], { state: "linked", owner: OWNER });
    const h = await client({ resume: record }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    expect(await h.settled).toMatchObject({ status: "connected", address: OWNER });
    expect(h.link).toEqual({ id: "bl_test0001", code: "ABC-DEF" });
    expect(site.posts).toHaveLength(1);
  });

  it("a renewed access token goes back into the record, with what a later worker needs", async () => {
    const record = await firstWorker();
    site.requests[0].expired = true;
    const later = client({ resume: record });
    const h = await grant(later);
    Object.assign(site.requests[0], { state: "confirmed", tx_hash: HASH, wallet_asked: true });
    expect(await h.settled).toMatchObject({ status: "sent", hash: HASH });
    // the renewal wrote the record again, whole
    expect(records.length).toBeGreaterThan(1);
    expect(records.at(-1)).toMatchObject({ requestId: "ba_test0001", resumable: true, intent: record.intent, expiresAt: record.expiresAt });
    expect(records.at(-1)!.token).not.toBe(record.token);
  });
});
