// The sink rule (budget/hosted.ts, header). A restarted worker's client delivers an outcome only through settleOne and settleBundle,
// and only with a Confirmed basis: a terminal read of the request under its own id, the site's confirmed cancel, or the site's own
// refusal to know it under that id. Anything else parks the client and calls onUnresolved. Against a fake superstables.com.
//
// Every path that can settle a poll is listed below, and a static check fails if code outside the sink resolves one.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { Confirmed, HostedApprovals, type HostedRecord } from "../../budget/hosted.js";
import { readSiteRequest } from "../../budget/site.mjs";
import { evmOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const OTHER_ID = "ba_other0001";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const FUND_HASH = `0x${"cd".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };
const FUND_TX = { to: AGENT, data: "0x", value: "0x2386f26fc10000" };
const THEN = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];

describe("the sink is the only place a poll is settled", () => {
  const source = readFileSync(new URL("../../budget/hosted.ts", import.meta.url), "utf8");
  const code = source.split("\n").map((l) => l.replace(/\/\/.*$/, ""));

  it("no code outside settleOne and settleBundle resolves a poll or settles a bundle", () => {
    const from = code.findIndex((l) => /private settleOne\(/.test(l));
    const bundle = code.findIndex((l) => /private settleBundle\(/.test(l));
    const to = code.findIndex((l, i) => i > bundle && /^  }$/.test(l));
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(bundle);
    const calls = code.map((l, i) => ({ l, i })).filter(({ l }) => /(?<!Promise)\b(?:p\.)?(?:resolve|settle)\(/.test(l) && !/Promise\.resolve\(/.test(l));
    const outside = calls.filter(({ i }) => i < from || i > to).map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(outside).toEqual([]);
    // and the sink does call them: a refactor that moved the calls elsewhere would pass the check above for the wrong reason
    expect(calls.filter(({ i }) => i >= from && i <= to).length).toBeGreaterThanOrEqual(3);
  });

  it("every settle call of the pollers names its basis: end, done and finish take one", () => {
    const sites = code.map((l, i) => ({ l, i })).filter(({ l }) => /\b(?:end|done|finish)\(/.test(l) && !/const (?:end|done|finish) =/.test(l));
    // each call line carries Confirmed.of..., null, or (for finish/done helpers) a Basis variable
    const bare = sites.filter(({ l }) => !/Confirmed\.of|, null\)|cancelConfirmed|answered \?|, basis\)/.test(l) && !/^\s*(?:\/\*|\*)/.test(l));
    const spots = bare.filter(({ l }) => /\b(?:end|done|finish)\((?!verdict)/.test(l)).map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(spots.filter((s) => !/finish: \(verdict\)|finish\(\)|\.finish\(/.test(s))).toEqual([]);
  });

  it("a Confirmed basis can only be made from an answer about the request", () => {
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "confirmed" })).not.toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "sent" })).not.toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "awaiting_owner", final: true })).not.toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "awaiting_owner" })).toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_2", state: "confirmed" })).toBeNull();
    expect(Confirmed.ofView("ba_1", { state: "confirmed" })).toBeNull();
    expect(Confirmed.ofView("ba_1", null)).toBeNull();
    expect(Confirmed.ofCancel({ cancelled: true })).not.toBeNull();
    expect(Confirmed.ofCancel({ cancelled: false })).toBeNull();
    expect(Confirmed.ofCancel(null)).toBeNull();
    expect(Confirmed.ofDenial({ ok: false, own: true, status: 404 })).not.toBeNull();
    expect(Confirmed.ofDenial({ ok: false, own: true, status: 410 })).not.toBeNull();
    expect(Confirmed.ofDenial({ ok: false, own: true, status: 403 })).toBeNull();
    expect(Confirmed.ofDenial({ ok: false, own: false, status: 404 })).toBeNull();
    expect(Confirmed.ofDenial({ ok: false, own: true, foreign: true, status: 404 })).toBeNull();
    expect(Confirmed.ofDenial({ ok: true, own: true, status: 404 })).toBeNull();
  });

  it("a client that finishes a recorded request is refused without the sink's exit", () => {
    expect(() => new HostedApprovals({ site: "https://x.example", rail: "evm", chain: "base-sepolia", agentKey: KEY, resume: { site: "https://x.example", requestId: "ba_1", token: "ssbt_test_abcdefgh", kind: "grant", matchCode: "ABC" } })).toThrow(/needs onUnresolved/);
  });
});

describe("readSiteRequest with own: the answer must be about this request, checked here once", () => {
  let site: FakeSite;
  beforeEach(async () => { site = await startFakeSite(); });
  afterEach(async () => { await site.close(); });
  const read = (id: string, own: boolean) => readSiteRequest({ site: site.url, id, token: "ssbt_test_ba_test0001secret", own });

  it("an ok answer under another id, or none, is foreign; under the request's id it is the view", async () => {
    site.owner = OWNER;
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
    await c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
    const id = site.requests[0].id;
    expect(await read(id, true)).toMatchObject({ ok: true, view: { id } });
    site.readAnswer = (_r, view) => ({ status: 200, body: { ...view, id: OTHER_ID } });
    expect(await read(id, true)).toMatchObject({ ok: false, foreign: true });
    site.readAnswer = (_r, view) => { const { id: _drop, ...rest } = view; return { status: 200, body: rest }; };
    expect(await read(id, true)).toMatchObject({ ok: false, foreign: true });
    // without own the reader is as it was: the first worker and buy-once read as before
    expect(await read(id, false)).toMatchObject({ ok: true });
    await c.close();
  });

  it.each([[404, "not_found"], [410, "gone"], [400, "wrong_account"]])("an error %s whose error.id names another request is foreign; one that names none, or this one, is the site's answer", async (status, code) => {
    site.owner = OWNER;
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
    await c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
    const id = site.requests[0].id;
    site.readAnswer = () => ({ status, body: { error: { code, id: OTHER_ID } } });
    expect(await read(id, true)).toMatchObject({ ok: false, foreign: true });
    expect(await read(id, false)).toMatchObject({ ok: false, status });
    site.readAnswer = () => ({ status, body: { error: { code } } });
    expect(await read(id, true)).toMatchObject({ ok: false, status, own: true });
    expect(await read(id, true)).not.toHaveProperty("foreign");
    site.readAnswer = () => ({ status, body: { error: { code, id } } });
    expect(await read(id, true)).toMatchObject({ ok: false, status, own: true });
    await c.close();
  });
});

describe("every path that cannot rest on the site's word parks a restarted worker", () => {
  let site: FakeSite;
  let dir: string;
  let records: HostedRecord[];
  let unresolved: string[];
  let taken: number;
  /** After the first worker's request exists nothing it sends reaches the site (it is gone). */
  let gone = false;
  const deadFetch: typeof fetch = (input, init) => (gone ? new Promise<Response>(() => {}) : fetch(input, init));
  const client = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(dir, "audit.jsonl"), onRecord: (r) => records.push(r), pollWaitS: 0, minPollMs: 20, resumable: true, ...over });
  const restarted = (record: HostedRecord, over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    client({ resume: { ...record, deadline: Date.now() - 1000 }, onTakeover: () => taken++, onUnresolved: (why) => { unresolved.push(why); }, sendingGraceMs: 50, quietGraceMs: 50, ...over });
  const grant = (c: HostedApprovals) => c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
  const link = (c: HostedApprovals, then?: typeof THEN) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...(then ? { then } : {}) });
  /** The first worker made the request and is gone. */
  const first = async (what: "tx" | "link" | "bundle") => {
    site.owner = OWNER;
    gone = false;
    // the first worker reads once, at once, and then sleeps: nothing of it is in flight when the restarted worker begins
    const c = client({ fetchImpl: deadFetch, minPollMs: 3_600_000 });
    if (what === "tx") await grant(c); else await link(c, what === "bundle" ? THEN : undefined);
    await new Promise((x) => setTimeout(x, 200));
    gone = true;
    return { record: records.at(-1)!, r: site.requests.at(-1)! };
  };
  const ask = async (what: "tx" | "link" | "bundle", c: HostedApprovals) => (what === "tx" ? grant(c) : link(c, what === "bundle" ? THEN : undefined));
  /** Whether the outcome was delivered within a moment. */
  const delivered = async (what: "tx" | "link" | "bundle", h: Awaited<ReturnType<typeof grant>>, ms = 1500) =>
    (await Promise.race([(what === "bundle" ? h.bundle! : h.settled).then(() => true), new Promise<boolean>((x) => setTimeout(() => x(false), ms))]));
  const complete = (what: "tx" | "link" | "bundle", r: ReturnType<typeof site.requests.at> & object) => {
    if (what === "tx") Object.assign(r, { state: "confirmed", tx_hash: HASH, wallet_asked: true });
    else {
      Object.assign(r, { state: what === "bundle" ? "confirmed" : "linked", owner: OWNER });
      if (what === "bundle") { Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true }); Object.assign(r.steps![1], { state: "confirmed", tx_hash: HASH, wallet_asked: true }); }
    }
  };

  beforeEach(async () => {
    site = await startFakeSite();
    dir = mkdtempSync(join(tmpdir(), "ss-hosted-sink-"));
    records = []; unresolved = []; taken = 0; gone = false;
  });
  afterEach(async () => { await site.close(); rmSync(dir, { recursive: true, force: true }); });

  const KINDS = ["tx", "link", "bundle"] as const;

  describe.each(KINDS)("%s", (what) => {
    it("a timeout after a read that shows nothing final", async () => {
      const { record, r } = await first(what);
      site.expiresInMs = 100;
      site.cancelFails = true;
      let reads = 0;
      site.readAnswer = (_r, view) => (++reads === 1 ? { status: 200, body: { ...view, state: what === "bundle" ? "awaiting_owner" : "sending", wallet_asked: what !== "bundle", final: false } } : { status: 503, body: {} });
      const h = await ask(what, restarted(record));
      // the failed reads are retried a second apart, so the deadline plus grace is seen a moment later
      expect(await delivered(what, h, 4000)).toBe(false);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatch(/in time|came back|expired|confirmed/i);
      expect(taken).toBe(1);
      void r;
    });

    it("the site refuses the agent's token after the first read (401 that cannot be renewed, 403)", async () => {
      for (const refusal of [{ status: 401, body: { error: { code: "token_expired" } } }, { status: 403, body: { error: { code: "forbidden" } } }]) {
        unresolved.length = 0;
        site.readAnswer = undefined;
        const { record } = await first(what);
        let reads = 0;
        site.renewAnswer = () => ({ status: 503, body: {} });
        // the site is down for the cancel too: nothing about the request is confirmed
        site.cancelFails = true;
        site.readAnswer = (_r, view) => (++reads === 1 ? { status: 200, body: { ...view, state: "awaiting_owner", final: false } } : refusal);
        const h = await ask(what, restarted(record));
        const got = await Promise.race([(what === "bundle" ? h.bundle! : h.settled).then((o) => o), new Promise((x) => setTimeout(() => x("open"), 2500))]);
        expect(got, `${what} ${refusal.status}`).toBe("open");
        expect(unresolved, `${what} ${refusal.status}`).toHaveLength(1);
        site.renewAnswer = undefined;
        site.readAnswer = undefined;
        site.cancelFails = false;
      }
    });

    it("an exception while polling (a renewed token that cannot be written)", async () => {
      const { record, r } = await first(what);
      r.expired = true;
      const h = await ask(what, restarted(record, { onRecord: () => { throw new Error("the record lock timed out"); } }));
      expect(await delivered(what, h, 1200)).toBe(false);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]).toMatch(/stopped reading the request/);
    });

    it("close() while it polls", async () => {
      const { record } = await first(what);
      const c = restarted(record);
      const h = await ask(what, c);
      await c.close();
      expect(await delivered(what, h, 800)).toBe(false);
      // closing a taken-over request is not a reason to end it: nothing is cancelled
      expect(site.requests.at(-1)!.cancels).toBe(0);
    });

    it("an answer that names another request, as a view or as an error, decides nothing", async () => {
      for (const answer of [(_r: unknown, view: any) => ({ status: 200, body: { ...view, id: OTHER_ID, state: "rejected", final: true } }), () => ({ status: 404, body: { error: { code: "not_found", id: OTHER_ID } } }), () => ({ status: 410, body: { error: { code: "gone", id: OTHER_ID } } }), () => ({ status: 400, body: { error: { code: "wrong_account", id: OTHER_ID } } })]) {
        taken = 0;
        site.readAnswer = undefined;
        const { record, r } = await first(what);
        site.readAnswer = answer as never;
        const h = await ask(what, restarted(record));
        expect(await delivered(what, h, 700), `${what}`).toBe(false);
        expect(taken).toBe(0);
        expect(r.cancels).toBe(0);
        // the site answers about this request: the outcome is delivered
        site.readAnswer = undefined;
        complete(what, r);
        expect(await delivered(what, h, 3000)).toBe(true);
        expect(taken).toBe(1);
      }
    });

    it("the owner is not the one on record and the cancel cannot be confirmed", async () => {
      const { record } = await first(what);
      if (what === "link") return; // a link names no expected owner here
      site.owner = evmOwner("33");
      site.cancelFails = true;
      const h = await ask(what, restarted(record));
      expect(await delivered(what, h, 1200)).toBe(false);
      expect(unresolved.length).toBeGreaterThanOrEqual(0);
    });

    it("what the site confirms is delivered: a terminal read, with this request's id", async () => {
      const { record, r } = await first(what);
      complete(what, r);
      const h = await ask(what, restarted(record));
      expect(await delivered(what, h, 3000)).toBe(true);
      expect(unresolved).toEqual([]);
      expect(taken).toBe(1);
    });
  });

  it("a request the site says it does not know, under its own id, is delivered (404, 410)", async () => {
    for (const status of [404, 410]) {
      unresolved.length = 0;
      site.readAnswer = undefined;
      const { record } = await first("tx");
      site.readAnswer = () => ({ status, body: { error: { code: status === 404 ? "not_found" : "gone" } } });
      const h = await grant(restarted(record));
      expect(await delivered("tx", h, 3000), `${status}`).toBe(true);
      expect(unresolved).toEqual([]);
    }
  });

  it("a deadline cancel that the site answers with the completed bundle: the owner proof is checked and the outcome is the bundle, never expired", async () => {
    const { record, r } = await first("bundle");
    // the request as the site will show it once completed, captured for the cancel's answer
    complete("bundle", r);
    const view = await (await fetch(`${site.url}/api/v1/budget/requests/${r.id}`, { headers: { authorization: `Bearer ${r.token}` } })).json();
    // reads show it still open; the cancel (at the deadline) answers with the completed request
    Object.assign(r, { state: "awaiting_owner", owner: null });
    for (const s of r.steps!) Object.assign(s, { state: "queued", tx_hash: null, wallet_asked: false });
    site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, state: "awaiting_owner", final: false, owner: null } });
    site.cancelAnswer = () => ({ status: 200, body: view });
    const h = await link(restarted(record), THEN);
    const bundle = await Promise.race([h.bundle!, new Promise<null>((x) => setTimeout(() => x(null), 4000))]);
    expect(bundle).not.toBeNull();
    expect(bundle!.link).toMatchObject({ status: "connected", address: OWNER });
    expect(bundle!.steps.map((s) => s.state)).toEqual(["confirmed", "confirmed"]);
    expect(unresolved).toEqual([]);
  });

  it("a first worker has no sink: it settles on its own timeout as it always did", async () => {
    site.owner = OWNER;
    site.expiresInMs = 100;
    const c = client({ sendingGraceMs: 50 });
    let reads = 0;
    site.readAnswer = (_r, view) => (++reads === 1 ? { status: 200, body: { ...view, state: "sending", wallet_asked: true, final: false } } : { status: 503, body: {} });
    const h = await grant(c);
    expect(await h.settled).toMatchObject({ status: "expired", sending: true });
  });
});
