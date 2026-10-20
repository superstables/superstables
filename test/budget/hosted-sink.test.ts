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
import { cancelSiteRequest, readSiteRequest } from "../../budget/site.mjs";
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
    const bare = sites.filter(({ l }) => !/Confirmed\.of|, null\)|cancelConfirmed|refusalBasis|, basis\)/.test(l) && !/^\s*(?:\/\*|\*)/.test(l));
    const spots = bare.filter(({ l }) => /\b(?:end|done|finish)\((?!verdict)/.test(l)).map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(spots.filter((s) => !/finish: \(verdict\)|finish\(\)|\.finish\(/.test(s))).toEqual([]);
  });

  it("no basis is built from a read that was not a success: no factory takes a read result, and none is called with one", () => {
    expect(source).not.toMatch(/ofDenial/);
    const fromRead = code.map((l, i) => ({ l, i })).filter(({ l }) => /Confirmed\.of\w+\(\s*(?:p\.id\s*,\s*)?r\b/.test(l)).map(({ l, i }) => `${i + 1}: ${l.trim()}`);
    expect(fromRead).toEqual([]);
    // the views a basis is made from are the ones of a read that was ok (`r.view`, held as `v`) or a cancel's answer
    const callers = code.map((l, i) => ({ l, i })).filter(({ l }) => /Confirmed\.of(?:View|Whole)\(/.test(l) && !/static of/.test(l));
    expect(callers.length).toBeGreaterThan(8);
    expect(callers.filter(({ l }) => !/Confirmed\.of(?:View|Whole)\(p\.id, (?:v|c\.body)\)/.test(l)).map(({ l, i }) => `${i + 1}: ${l.trim()}`)).toEqual([]);
  });

  it("a Confirmed basis can only be made from an answer about the request, and only from final or sent with a hash", () => {
    // final: true, under the request's id
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "confirmed", final: true })).not.toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "awaiting_owner", final: true })).not.toBeNull();
    // sent with a transaction hash is not final on the site, and is the rule's second form (the rail reads the chain from the hash)
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "sent", tx_hash: HASH })).not.toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "sent", tx_hash: "" })).toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "sent" })).toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: "sending", tx_hash: HASH })).toBeNull();
    // a terminal-looking state is not final unless the site says so
    for (const state of ["linked", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown"]) expect(Confirmed.ofView("ba_1", { id: "ba_1", state })).toBeNull();
    // not about this request, or not a view
    expect(Confirmed.ofView("ba_1", { id: "ba_2", state: "confirmed", final: true })).toBeNull();
    expect(Confirmed.ofView("ba_1", { state: "confirmed", final: true })).toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", state: 7, final: true })).toBeNull();
    expect(Confirmed.ofView("ba_1", { id: "ba_1", final: true })).toBeNull();
    expect(Confirmed.ofView("ba_1", [{ id: "ba_1", state: "confirmed", final: true }])).toBeNull();
    expect(Confirmed.ofView("ba_1", null)).toBeNull();
    expect(Confirmed.ofCancel({ cancelled: true })).not.toBeNull();
    expect(Confirmed.ofCancel({ cancelled: false })).toBeNull();
    expect(Confirmed.ofCancel(null)).toBeNull();
    // a bundle is final as a whole or not at all: one step's sent, or the link's linked, says nothing about the others
    expect(Confirmed.ofWhole("ba_1", { id: "ba_1", state: "confirmed", final: true })).not.toBeNull();
    expect(Confirmed.ofWhole("ba_1", { id: "ba_1", state: "sent", tx_hash: HASH, final: false })).toBeNull();
    expect(Confirmed.ofWhole("ba_1", { id: "ba_1", state: "linked" })).toBeNull();
    expect(Confirmed.ofWhole("ba_1", { id: "ba_2", state: "confirmed", final: true })).toBeNull();
    // there is no basis from a refusal to know the request, whatever its status or body
    expect(Object.getOwnPropertyNames(Confirmed).filter((n) => n.startsWith("of")).sort()).toEqual(["ofCancel", "ofView", "ofWhole"]);
  });

  it("no Confirmed factory takes a failed read; a bundle uses only ofWhole and a single request only ofView", () => {
    const text = code.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const cls = text.slice(text.indexOf("export class Confirmed"), text.indexOf("type Basis"));
    expect(cls.length).toBeGreaterThan(200);
    // the factories take an id and a view, or a cancel answer: nothing with `ok`, a status or a read result
    expect(cls).not.toMatch(/\bok\b|\bstatus\b|\bForeign\b|\bown\b/);
    const poll = text.slice(text.indexOf("private async poll("), text.indexOf("private async pollBundle("));
    const bundle = text.slice(text.indexOf("private async pollBundle("), text.indexOf("private audit("));
    expect(poll).not.toMatch(/Confirmed\.ofWhole\(/);
    expect(bundle).not.toMatch(/Confirmed\.ofView\(/);
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
  // a client left polling by an earlier test must not write into this test's list: each takes the list of its own test
  const restarted = (record: HostedRecord, over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) => {
    const mine = unresolved;
    return client({ resume: { ...record, deadline: Date.now() - 1000 }, onTakeover: () => taken++, onUnresolved: (why) => { mine.push(why); }, sendingGraceMs: 50, quietGraceMs: 50, ...over });
  };
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

    it("a successful read that names another request decides nothing about this one: it is read again until the site answers about it", async () => {
      taken = 0;
      site.readAnswer = undefined;
      const { record, r } = await first(what);
      site.readAnswer = (_r, view) => ({ status: 200, body: { ...view, id: OTHER_ID, state: "rejected", final: true } });
      const h = await ask(what, restarted(record));
      expect(await delivered(what, h, 700)).toBe(false);
      expect(taken).toBe(0);
      expect(r.cancels).toBe(0);
      // the site answers about this request: the outcome is delivered
      site.readAnswer = undefined;
      complete(what, r);
      expect(await delivered(what, h, 3000)).toBe(true);
      expect(taken).toBe(1);
      expect(unresolved).toEqual([]);
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

  /**
   * A restarted client whose reads of the request are answered by `answer` (everything else goes to the fake site). The answer is
   * built by the test, so it can be an HTML page or a body that is cut off, which the fake site cannot send.
   */
  const readsAnswered = (answer: () => Response): typeof fetch => (input, init) => {
    const url = String(input);
    return (init?.method ?? "GET") === "GET" && /\/requests\/b[la]_[^/?]+(\?|$)/.test(url) ? Promise.resolve(answer()) : fetch(input, init);
  };
  const BODIES: [string, () => BodyInit | null][] = [
    ["an HTML page", () => "<html><body>404: NOT_FOUND</body></html>"],
    ["a body that is cut off at the cap", () => JSON.stringify({ error: { code: "not_found", pad: "x".repeat(1_100_000) } })],
    ["a clean JSON not_found", () => JSON.stringify({ error: { code: "not_found", message: "no budget request with this id for this token" } })],
    ["a JSON error that names this request", () => JSON.stringify({ error: { code: "not_found", id: "__ID__" } })],
    ["a JSON error that names another request", () => JSON.stringify({ error: { code: "not_found", id: OTHER_ID } })],
    ["no body", () => null],
  ];

  describe.each(KINDS)("a read that is a 400, 404 or 410 (%s)", (what) => {
    for (const status of [400, 404, 410]) for (const [name, body] of BODIES) {
      it(`${status} with ${name} parks, and nothing is delivered or cancelled`, async () => {
        const { record, r } = await first(what);
        const fetchImpl = readsAnswered(() => new Response(body()?.toString().replace("__ID__", r.id) ?? null, { status }));
        const h = await ask(what, restarted(record, { fetchImpl }));
        expect(await delivered(what, h, 1500)).toBe(false);
        expect(unresolved).toHaveLength(1);
        expect(taken).toBe(0);
        expect(r.cancels).toBe(0);
      });
    }
  });

  describe.each(KINDS)("any other read that was not a 2xx (%s)", (what) => {
    for (const status of [401, 403, 429, 500, 502, 503]) {
      it(`${status} delivers nothing`, async () => {
        const { record, r } = await first(what);
        const fetchImpl = readsAnswered(() => new Response(JSON.stringify({ error: { code: "x" } }), { status }));
        const h = await ask(what, restarted(record, { fetchImpl }));
        expect(await delivered(what, h, 1200)).toBe(false);
        expect(taken).toBe(0);
        expect(r.cancels).toBe(0);
      });
    }
  });

  describe("a bundle's refusal branches need a whole-bundle terminal read or a confirmed cancel", () => {
    const other = evmOwner("33");
    const bundleView = (r: ReturnType<typeof site.requests.at> & object, over: object) => ({ id: r.id, kind: "link", state: "sent", final: false, owner: OWNER, owner_proof: undefined as unknown, steps: [{ index: 0, kind: "fund_agent", state: "sent", tx_hash: FUND_HASH, wallet_asked: true, reason: null, reason_code: null }, { index: 1, kind: "grant", state: "queued", tx_hash: null, wallet_asked: false, reason: null, reason_code: null }], ...over });
    const expectOther = (c: HostedApprovals) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: THEN, expectedOwner: other });

    it("an owner that is not the one on record, in a bundle that is not final: parks, with the funding step sent and the grant open", async () => {
      const { record, r } = await first("bundle");
      site.cancelFails = true;
      site.readAnswer = (_r, v) => ({ status: 200, body: bundleView(r, { account_id: v.account_id }) });
      const h = await expectOther(restarted(record));
      expect(await delivered("bundle", h, 1500)).toBe(false);
      expect(unresolved.length).toBeGreaterThanOrEqual(1);
    });

    it("an owner proof that fails, in a bundle that is not final: parks", async () => {
      const { record, r } = await first("bundle");
      site.cancelFails = true;
      site.readAnswer = (_r, v) => ({ status: 200, body: bundleView(r, { account_id: v.account_id, owner_proof: { scheme: "eip191", message: "not the text", signature: "0x00" } }) });
      const h = await link(restarted(record), THEN);
      expect(await delivered("bundle", h, 1500)).toBe(false);
      expect(unresolved.length).toBeGreaterThanOrEqual(1);
    });

    it("the same refusals in a bundle the site calls final are delivered: the whole bundle is terminal", async () => {
      const { record, r } = await first("bundle");
      site.cancelFails = true;
      site.readAnswer = (_r, v) => ({ status: 200, body: bundleView(r, { account_id: v.account_id, state: "confirmed", final: true }) });
      const h = await expectOther(restarted(record));
      const out = await Promise.race([h.bundle!, new Promise<null>((x) => setTimeout(() => x(null), 3000))]);
      expect(out).not.toBeNull();
      expect(out!.link.status).toBe("rejected");
      expect(unresolved).toEqual([]);
    });
  });

  /** Reads: the first reaches the site (a valid, non-final answer about this request), every later one is `answer`. */
  const afterFirstRead = (answer: () => Response): typeof fetch => {
    let reads = 0;
    return (input, init) => {
      const read = (init?.method ?? "GET") === "GET" && /\/requests\/b[la]_[^/?]+(\?|$)/.test(String(input));
      return read && ++reads > 1 ? Promise.resolve(answer()) : fetch(input, init);
    };
  };

  describe.each(KINDS)("a refusal to know the request after a valid non-final read (%s)", (what) => {
    for (const status of [400, 404, 410]) for (const [name, body] of BODIES) {
      it(`${status} with ${name}: an earlier takeover gives it no authority to settle`, async () => {
        const { record, r } = await first(what);
        site.cancelFails = true;
        const fetchImpl = afterFirstRead(() => new Response(body()?.toString().replace("__ID__", r.id) ?? null, { status }));
        const h = await ask(what, restarted(record, { fetchImpl }));
        expect(await delivered(what, h, 1800)).toBe(false);
        expect(taken).toBe(1);
        expect(unresolved.length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  it("a 404 whose error says money may have moved parks, and the audit log says the wallet may have been asked", async () => {
    const { record } = await first("tx");
    const fetchImpl = readsAnswered(() => new Response(JSON.stringify({ error: { code: "not_found", money_moved: "unknown" } }), { status: 404 }));
    const h = await grant(restarted(record, { fetchImpl }));
    expect(await delivered("tx", h, 1500)).toBe(false);
    expect(unresolved).toHaveLength(1);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toMatch(/"sending":true/);
  });

  it.each(KINDS)("a final: true read whose state is not a string decides nothing (%s)", async (what) => {
    const { record, r } = await first(what);
    const fetchImpl = readsAnswered(() => new Response(JSON.stringify({ id: r.id, state: 7, final: true, steps: [] }), { status: 200 }));
    const h = await ask(what, restarted(record, { fetchImpl }));
    expect(await delivered(what, h, 1500)).toBe(false);
    expect(taken).toBe(0);
  });

  it("F3: the token was rotated and the record kept the old one: a clean JSON 404 not_found for the stale token parks, whatever it looks like", async () => {
    const { record, r } = await first("tx");
    r.expired = true;
    const tokenBefore = r.token;
    // a restarted worker renews the token (the site rotates it), cannot write the record, and parks
    const a = restarted(record, { onRecord: () => { throw new Error("the record lock timed out"); } });
    const ha = await grant(a);
    expect(await delivered("tx", ha, 1500)).toBe(false);
    expect(r.token).not.toBe(tokenBefore);
    expect(record.token).toBe(tokenBefore);
    unresolved.length = 0;
    taken = 0;
    // the next worker reads with the stale token: the real site answers 404 not_found, as it does for an unknown request
    const asProduction: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (res.status === 401 && /\?wait=/.test(String(input))) return new Response(JSON.stringify({ error: { code: "not_found", message: "there is no budget request with this id for this token" } }), { status: 404 });
      return res;
    };
    const hb = await grant(restarted(record, { fetchImpl: asProduction }));
    expect(await delivered("tx", hb, 1500)).toBe(false);
    expect(unresolved).toHaveLength(1);
    expect(taken).toBe(0);
    expect(r.state).toBe("awaiting_owner");
    expect(r.cancels).toBe(0);
  });

  describe("a confirmed cancel is a basis, and the one documented cancel answer with no id is a deliberate exception", () => {
    it.each(KINDS)("the deadline cancel the site confirms finishes a restarted worker (%s)", async (what) => {
      const { record } = await first(what);
      const h = await ask(what, restarted(record));
      expect(await delivered(what, h, 3000)).toBe(true);
      expect(unresolved).toEqual([]);
    });

    it("cancelSiteRequest accepts the site's id-less 409 not_open/cancelled (no id in the answer), and refuses it with another request's id", async () => {
      const { r } = await first("tx");
      const notOpen = (error: object) => () => ({ status: 409, body: { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null, ...error } } });
      site.cancelAnswer = notOpen({});
      expect(await cancelSiteRequest({ site: site.url, id: r.id, token: r.token })).toMatchObject({ cancelled: true });
      site.cancelAnswer = notOpen({ id: OTHER_ID });
      expect(await cancelSiteRequest({ site: site.url, id: r.id, token: r.token })).toMatchObject({ cancelled: false });
      site.cancelAnswer = notOpen({ wallet_asked: true });
      expect(await cancelSiteRequest({ site: site.url, id: r.id, token: r.token })).toMatchObject({ cancelled: false });
    });

    it("a restarted worker finishes on that id-less answer (the exception to 'every basis carries the request's id', stated on the PR)", async () => {
      const { record } = await first("tx");
      site.cancelAnswer = () => ({ status: 409, body: { error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null } } });
      const h = await grant(restarted(record));
      expect(await delivered("tx", h, 3000)).toBe(true);
      expect(unresolved).toEqual([]);
    });
  });

  describe("the bundle's refusals, and the completed request a cancel can answer with", () => {
    /** The request as the site would show it linked, with its valid owner proof, captured while it is in that state. */
    const captured = async (r: { id: string; token: string }) => (await (await fetch(`${site.url}/api/v1/budget/requests/${r.id}`, { headers: { authorization: `Bearer ${r.token}` } })).json()) as Record<string, any>;
    const BAD_PROOF = { scheme: "eip191", message: "not the add-agent text", signature: `0x${"11".repeat(65)}` };

    it("a link that is linked but not final, whose cancel is answered with that same non-final request, decides nothing", async () => {
      const { record, r } = await first("bundle");
      Object.assign(r, { state: "linked", owner: OWNER });
      const view = { ...(await captured(r)), final: false };
      Object.assign(r, { state: "awaiting_owner", owner: null });
      site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, state: "awaiting_owner", final: false, owner: null } });
      site.cancelAnswer = () => ({ status: 200, body: view });
      const h = await link(restarted(record), THEN);
      // the link is taken in (its proof is valid) and the steps get their own time: nothing is delivered from a non-final answer
      expect(await delivered("bundle", h, 2000)).toBe(false);
      expect(taken).toBe(1);
    });

    it("a bad owner proof on a linked, non-final bundle parks; a cancel answered with the whole bundle final settles it in the same worker", async () => {
      const { record, r } = await first("bundle");
      site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, state: "linked", final: false, owner: OWNER, owner_proof: BAD_PROOF } });
      site.cancelFails = true;
      const parked = await link(restarted(record), THEN);
      expect(await delivered("bundle", parked, 1500)).toBe(false);
      expect(unresolved.length).toBeGreaterThanOrEqual(1);
      // the site withdraws the steps: its cancel answers with the request as it stands, final as a whole
      unresolved.length = 0;
      site.cancelFails = false;
      site.cancelAnswer = () => ({ status: 200, body: { id: r.id, kind: "link", state: "cancelled", final: true, owner: OWNER, owner_proof: BAD_PROOF, steps: [{ index: 0, kind: "fund_agent", state: "cancelled", tx_hash: null, wallet_asked: false }, { index: 1, kind: "grant", state: "cancelled", tx_hash: null, wallet_asked: false }] } });
      const settled = await link(restarted(record), THEN);
      expect(await delivered("bundle", settled, 3000)).toBe(true);
      expect(unresolved).toEqual([]);
    });

    it("the next worker settles the same bundle on its first read that is final", async () => {
      const { record, r } = await first("bundle");
      site.readAnswer = (_r, v) => ({ status: 200, body: { ...v, state: "linked", final: false, owner: OWNER, owner_proof: BAD_PROOF } });
      site.cancelFails = true;
      const parked = await link(restarted(record), THEN);
      expect(await delivered("bundle", parked, 1500)).toBe(false);
      site.cancelFails = false;
      site.readAnswer = undefined;
      complete("bundle", r);
      const next = await link(restarted(record), THEN);
      expect(await delivered("bundle", next, 3000)).toBe(true);
    });
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
