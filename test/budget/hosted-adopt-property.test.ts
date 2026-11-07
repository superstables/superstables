// The property of adopting a request by id ("the property" in hosted-adopt.test.ts, which lists the paths it covers): every
// answer alone and in every order, against HostedApprovals and a fake superstables.com. Its own file because these tests are
// long and use the CPU: here they run beside the rest of hosted-adopt.test.ts instead of after it. No network, no real key.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HostedAdopted, HostedApprovals, HostedRefusal, HostedSigned, givesUp, type Evidence, type HostedRecord, type SignedRecord, type SignedRequest } from "../../budget/hosted.js";
import { startFakeSite, submitSigned, type FakeSite } from "../helpers/fake-site.js";
import { walletEvidence } from "../../budget/site.mjs";
import { AFTER_HANDOFF_CODES, AGENT, GRANT_HASH, KEY, OWNER, TERMS, grantTx } from "../helpers/hosted-adopt-fixtures.js";

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
  type Given = { requestId: string; link: string; matchCode: string };
  /** One adoption. `kept`: every answer's evidence as onEvidence got it, the first before the site is asked; `asked`: any of it. */
  async function adopt(key: typeof KEY, signed: SignedRecord, given: Given, ask: Ask) {
    let adopted: HostedRecord | undefined;
    const kept: (Given & Evidence)[] = [];
    // the record's evidence as mergeEvidence keeps it: it only grows
    let held: Evidence = { walletAsked: signed.signed.walletAsked === true, hashes: signed.signed.hashes ?? [] };
    const onEvidence = (e: Given & Evidence) => {
      kept.push(e);
      const hashes = [...new Set([...held.hashes, ...e.hashes])];
      return (held = { walletAsked: held.walletAsked || e.walletAsked || hashes.length > 0, hashes });
    };
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: key, adopt: { signed, ...given, onAdopt: (r) => { adopted = r; }, onEvidence } });
    const err = await ask(c).catch((e) => e);
    return { err, adopted, kept, asked: kept.some((e) => e.walletAsked) };
  }

  describe("the property", () => {
    let approvals: typeof import("../../budget/approvals.mjs");
    let propertyHome: string;
    beforeAll(async () => {
      propertyHome = mkdtempSync(join(tmpdir(), "ss-budget-adopt-property-"));
      process.env.SUPERSTABLES_HOME = propertyHome;
      approvals = await import("../../budget/approvals.mjs");
      expect(approvals.logFile("oa-x")).toContain(propertyHome);
    });
    afterAll(() => {
      delete process.env.SUPERSTABLES_HOME;
      rmSync(propertyHome, { recursive: true, force: true });
    });

    type Answer = { status: number; body: unknown };
    /**
     * One adoption's answers: the token renewal's and the read's (the site's own when absent), or, with `wire`, what the network
     * gives this machine for one of them instead (a body that is not JSON, cut off, or no answer). `unread`: that answer cannot be
     * read whole, so it leaves the record's mayHaveSent mark.
     */
    type Shape = { name: string; renew?: (r: { id: string; token: string }) => Answer; read?: (v: any) => Answer; wire?: { at: "renew" | "read"; answer: () => Promise<Response> }; frees?: true; asked?: true; hash?: string; adopts?: true; unread?: true };
    const exact = (status: 403 | 404) => ({ status, body: { error: { code: status === 403 ? "not_your_request" : "not_found", message: "words", money_moved: false, retryable: false, doc_url: "https://superstables.com/docs/budgets.md", request_id: "req_abcdefABCDEF0123" } } });
    const otherAmount = (v: any) => ({ ...v, transaction: grantTx(AGENT, 20000n) });
    const read = (change: (v: any) => unknown) => (v: any) => ({ status: 200, body: change(v) });
    const noState = (v: any) => { const { state: _drop, ...rest } = v; return rest; };
    /** A final read as the site sends it when the owner's wallet was never asked. */
    const never = (state: string, reason_code: string | null) => ({ state, final: true, wallet_asked: false, tx_hash: null, reason_code });
    const askedRenewal = (r: { id: string; token: string }) => ({ status: 200, body: { id: r.id, access_token: r.token, wallet_asked: true, money_moved: "unknown" } });
    /** Sol's round 6 repros: a transaction only next_action names, on a read with other terms, a failed read, and a read about another request. */
    const SOL: Shape[] = [
      { name: "Sol's repro: read with another amount, its transaction only in next_action.tx_hash", read: read((v) => ({ ...otherAmount(v), next_action: { type: "verify_on_chain", tx_hash: GRANT_HASH } })), asked: true, hash: GRANT_HASH },
      { name: "Sol's repro: read 503, its transaction only in error.next_action.tx_hashes", read: () => ({ status: 503, body: { error: { code: "chain_unavailable", next_action: { type: "verify_on_chain", tx_hashes: [GRANT_HASH] } } } }), asked: true, hash: GRANT_HASH },
      { name: "Sol's repro: read about another request, its transaction only in next_action.tx_hashes", read: read((v) => ({ ...v, id: "ba_different0002", next_action: { type: "verify_on_chain", tx_hashes: [GRANT_HASH] } })), asked: true, hash: GRANT_HASH },
    ];
    /** Answers this machine cannot read whole, as the network delivers them: each is no answer to judge, and leaves the mark. */
    const BIG = "x".repeat(1_100_000);
    const broken = (start: string, error: unknown) => () => Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(start)); c.error(error); } }), { status: 200, headers: { "content-type": "application/json" } }));
    const reset = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
    const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const evidenceStart = `{"wallet_asked":true,"tx_hash":"${GRANT_HASH}","state":"sent"`;
    const UNREADABLE = (["renew", "read"] as const).flatMap((at): Shape[] => {
      const what = at === "renew" ? "renewal" : "read";
      return [
        { name: `${what} that is not JSON`, wire: { at, answer: () => Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })) } },
        { name: `${what} 200 with an empty body`, wire: { at, answer: () => Promise.resolve(new Response("", { status: 200 })) } },
        { name: `${what} 404 with an empty body`, wire: { at, answer: () => Promise.resolve(new Response(null, { status: 404 })) } },
        { name: `${what} 403 whose body is not JSON`, wire: { at, answer: () => Promise.resolve(new Response("not_your_request", { status: 403 })) } },
        { name: `${what} cut off by a reset, after it showed the wallet asked`, wire: { at, answer: broken(evidenceStart, reset()) } },
        { name: `${what} cut off by a timeout, after it showed the wallet asked`, wire: { at, answer: broken(evidenceStart, timedOut()) } },
        { name: `${what}: connection reset before any answer`, wire: { at, answer: () => Promise.reject(reset()) } },
        { name: `${what}: timeout before any answer`, wire: { at, answer: () => Promise.reject(timedOut()) } },
        at === "renew"
          ? { name: "renewal 200 with a token, longer than the cap", renew: (r) => ({ status: 200, body: { id: r.id, access_token: r.token, reason: BIG } }) }
          : { name: "read with the signed terms, longer than the cap", read: read((v) => ({ ...v, reason: BIG })) },
      ];
    }).map((x) => ({ ...x, unread: true as const }));
    /** Sol's round 7 repros: a read or renewal, 200 or 503, that shows the wallet asked and a transaction, then runs past the cap. */
    const SOL7: Shape[] = [
      { name: "Sol's repro: read 200 with the wallet asked and a transaction, longer than the cap", read: read((v) => ({ ...v, wallet_asked: true, tx_hash: GRANT_HASH, reason: BIG })) },
      { name: "Sol's repro: read 503 with the wallet asked and a transaction, longer than the cap", read: () => ({ status: 503, body: { error: { wallet_asked: true, tx_hash: GRANT_HASH, reason: BIG } } }) },
      { name: "Sol's repro: renewal 200 with the wallet asked and a transaction, longer than the cap", renew: (r: { id: string; token: string }) => ({ status: 200, body: { id: r.id, access_token: r.token, wallet_asked: true, tx_hash: GRANT_HASH, reason: BIG } }) },
      { name: "Sol's repro: renewal 503 with the wallet asked and a transaction, longer than the cap", renew: () => ({ status: 503, body: { error: { wallet_asked: true, tx_hash: GRANT_HASH, reason: BIG } } }) },
    ].map((x) => ({ ...x, unread: true as const }));
    const SHAPES: Shape[] = [
      { name: "renewal 200 and the signed terms", adopts: true },
      { name: "renewal 200 with the wallet asked, and the signed terms", renew: askedRenewal, asked: true, adopts: true },
      { name: "renewal 200 with a transaction, and the signed terms", renew: (r) => ({ status: 200, body: { id: r.id, access_token: r.token, tx_hash: GRANT_HASH } }), asked: true, hash: GRANT_HASH, adopts: true },
      { name: "Sol's repro: renewal 200 with the wallet asked, then a read with another amount", renew: askedRenewal, read: read(otherAmount), asked: true },
      { name: "renewal 200 without a token", renew: (r) => ({ status: 200, body: { id: r.id } }) },
      { name: "renewal 403 not_your_request, exact", renew: () => exact(403), frees: true },
      { name: "renewal 404 not_found, exact", renew: () => exact(404), frees: true },
      { name: "renewal 403 naming another request", renew: () => ({ status: 403, body: { error: { ...exact(403).body.error, id: "ba_different0002" } } }) },
      { name: "renewal 404 naming another request in its words", renew: () => ({ status: 404, body: { error: { ...exact(404).body.error, message: "ba_different0002 is not here" } } }) },
      { name: "renewal 403 with money_moved", renew: () => ({ status: 403, body: { error: { ...exact(403).body.error, money_moved: "unknown" } } }), asked: true },
      { name: "renewal 404 with the wallet asked", renew: () => ({ status: 404, body: { error: { code: "not_found", wallet_asked: true } } }), asked: true },
      { name: "renewal 403, malformed", renew: () => ({ status: 403, body: { code: "not_your_request" } }) },
      { name: "renewal 404, plain text", renew: () => ({ status: 404, body: "not found" }) },
      { name: "renewal 404 with the other refusal's code", renew: () => ({ status: 404, body: { error: { code: "not_your_request" } } }) },
      { name: "renewal 401", renew: () => ({ status: 401, body: { error: { code: "agent_proof" } } }) },
      { name: "renewal 429 with money_moved", renew: () => ({ status: 429, body: { error: { code: "rate_limited", money_moved: "unknown" } } }), asked: true },
      { name: "renewal 503", renew: () => ({ status: 503, body: { error: { code: "unavailable" } } }) },
      { name: "renewal 403 not_your_request, cut off", renew: () => ({ status: 403, body: { error: { ...exact(403).body.error, message: BIG } } }), unread: true },
      { name: "renewal times out", wire: { at: "renew", answer: () => Promise.reject(timedOut()) }, unread: true },
      { name: "read with another amount", read: read(otherAmount) },
      { name: "read with another amount, final as expired, wallet never asked", read: read((v) => ({ ...otherAmount(v), ...never("expired", "approval_expired") })), frees: true },
      { name: "read with another amount, final as rejected, wallet never asked", read: read((v) => ({ ...otherAmount(v), ...never("rejected", "owner_rejected") })), frees: true },
      { name: "read with another amount, final as cancelled, wallet never asked", read: read((v) => ({ ...otherAmount(v), ...never("cancelled", "agent_cancelled") })), frees: true },
      { name: "read with the signed terms, final as expired, wallet never asked", read: read((v) => ({ ...v, ...never("expired", "approval_expired") })), adopts: true },
      { name: "read with another amount, expired, not final", read: read((v) => ({ ...otherAmount(v), ...never("expired", "approval_expired"), final: false })) },
      { name: "read with another amount, expired and final, wallet_asked absent", read: read((v) => ({ ...otherAmount(v), state: "expired", final: true })) },
      { name: "read with another amount, cancelled and final, wallet_asked absent", read: read((v) => ({ ...otherAmount(v), state: "cancelled", final: true })) },
      { name: "read with another amount, final as expired, the wallet asked", read: read((v) => ({ ...otherAmount(v), ...never("expired", "approval_expired"), wallet_asked: true })), asked: true },
      { name: "read with another amount, final as rejected, with a transaction", read: read((v) => ({ ...otherAmount(v), ...never("rejected", "owner_rejected"), tx_hash: GRANT_HASH })), asked: true, hash: GRANT_HASH },
      { name: "read with another amount, final as cancelled, money_moved", read: read((v) => ({ ...otherAmount(v), ...never("cancelled", "agent_cancelled"), money_moved: "unknown" })), asked: true },
      { name: "read with another amount, final as expired, an undocumented reason", read: read((v) => ({ ...otherAmount(v), ...never("expired", "garbled") })) },
      { name: "read with another amount, final and confirmed", read: read((v) => ({ ...otherAmount(v), ...never("confirmed", null) })), asked: true },
      { name: "read with another amount, final and failed", read: read((v) => ({ ...otherAmount(v), ...never("failed", "reverted") })), asked: true },
      { name: "read with another amount, final and linked", read: read((v) => ({ ...otherAmount(v), ...never("linked", null) })) },
      { name: "read with another amount, final with a garbled state", read: read((v) => ({ ...otherAmount(v), ...never("garbled", null) })) },
      { name: "Sol's repro: read with a garbled state and another amount", read: read((v) => ({ ...otherAmount(v), state: "garbled" })) },
      { name: "read with a garbled state and the signed terms", read: read((v) => ({ ...v, state: "garbled" })), adopts: true },
      { name: "read with no state", read: read(noState) },
      { name: "read with no state and another amount", read: read((v) => noState(otherAmount(v))) },
      { name: "read with the unknown state and the signed terms", read: read((v) => ({ ...v, state: "unknown" })), asked: true, adopts: true },
      { name: "read with the unknown state and another amount", read: read((v) => ({ ...otherAmount(v), state: "unknown" })), asked: true },
      { name: "read with another amount and a transaction", read: read((v) => ({ ...otherAmount(v), state: "confirmed", wallet_asked: true, tx_hash: GRANT_HASH })), asked: true, hash: GRANT_HASH },
      { name: "read 404 not_found, exact", read: () => exact(404) },
      { name: "read 403 not_your_request, exact", read: () => exact(403) },
      { name: "read 503 with money_moved", read: () => ({ status: 503, body: { error: { code: "unavailable", money_moved: "unknown" } } }), asked: true },
      { name: "read cut off", read: read((v) => ({ ...v, reason: BIG })), unread: true },
      { name: "read times out", wire: { at: "read", answer: () => Promise.reject(timedOut()) }, unread: true },
      ...SOL,
      ...UNREADABLE,
      ...SOL7,
    ];
    /** Every answer that gives the request up while the record holds no evidence. */
    const EXITS = SHAPES.filter((x) => x.frees);
    /** A renewal that recorded the wallet asked, and a read that failed: the request is kept, with evidence. */
    const EVIDENCE: Shape = { name: "renewal 200 with the wallet asked, read 503", renew: askedRenewal, read: () => ({ status: 503, body: { error: { code: "unavailable" } } }), asked: true };

    let n = 0;
    /** One signed approval through `shapes`, one adoption each, as `wait --site-request` and every later wait run them. */
    async function through(shapes: Shape[], signed: SignedRecord, given: Given) {
      const id = `oa-20261028000000-${(++n).toString(16).padStart(8, "0")}`;
      const nonce = signed.signed.nonce;
      approvals.startSigning({ id, command: "grant", rail: "evm", chain: "base-sepolia", workerArgs: [], timeoutS: 60 });
      approvals.recordSigned(id, signed);
      // the dispatcher keeps the request before the check starts
      approvals.mergeEvidence(id, nonce, given);
      let before = { walletAsked: false, hashes: [] as string[], mayHaveSent: false };
      for (const [i, shape] of shapes.entries()) {
        const what = shapes.slice(0, i + 1).map((x) => x.name).join(" → ");
        site.renewAnswer = shape.renew;
        site.readAnswer = shape.read && ((_r, v) => shape.read!(v));
        const wire = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const hit = shape.wire?.at === "renew" ? url.endsWith("/token") : shape.wire?.at === "read" && /\/requests\/[^/]+\?wait=/.test(url);
          return hit ? shape.wire!.answer() : fetch(input, init);
        };
        const c = new HostedApprovals({
          site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, fetchImpl: wire as typeof fetch,
          adopt: {
            signed: approvals.readApproval(id).hosted, ...given,
            onAdopt: (r, shown) => approvals.adoptSigned(id, nonce, r, { ...shown, action: "grant", terms: TERMS }),
            onEvidence: (e) => approvals.mergeEvidence(id, nonce, e),
          },
        });
        const err = await grant(AGENT, 10000n)(c).catch((e) => e);
        // the dispatcher frees the chain only on this
        const freed = err instanceof HostedRefusal && err.notAdopted && approvals.dropUnsettled(id, nonce, given.requestId);
        const now = approvals.readApproval(id).hosted;
        // a give-up only on a clean history: every answer so far read whole, none with evidence
        expect(freed, what).toBe(shape.frees === true && !before.walletAsked && !before.mayHaveSent);
        expect(now.signed.walletAsked === true, what).toBe(before.walletAsked || shape.asked === true);
        expect(now.signed.hashes ?? [], what).toEqual([...new Set([...before.hashes, ...(shape.hash ? [shape.hash] : [])])]);
        expect(now.signed.mayHaveSent === true, what).toBe(before.mayHaveSent || shape.unread === true);
        before = { walletAsked: now.signed.walletAsked === true, hashes: now.signed.hashes ?? [], mayHaveSent: now.signed.mayHaveSent === true };
        if (freed) {
          expect(now.signed.submitted, what).toBeUndefined();
          return now;
        }
        if (shape.adopts) {
          expect(err, what).toBeInstanceOf(HostedAdopted);
          expect(now, what).toMatchObject({ requestId: given.requestId, token: expect.any(String) });
          return now;
        }
        expect(err, what).toBeInstanceOf(HostedRefusal);
        expect((err as HostedRefusal).sending, what).toBe(true);
        expect(now.signed.submitted, what).toEqual(given);
        // with evidence or the mark, nothing drops it, whatever the check said
        if (before.walletAsked || before.mayHaveSent) expect(approvals.dropUnsettled(id, nonce, given.requestId), what).toBe(false);
      }
      return approvals.readApproval(id).hosted;
    }

    it("frees the chain only on givesUp's answers with no recorded evidence, and never loses evidence: each answer alone, then in every order", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      const kept = SHAPES.filter((x) => !x.adopts && !x.frees);
      for (const a of SHAPES) await through([a], record, given);
      for (const a of kept) for (const b of SHAPES) await through([a, b], record, given);
      expect(site.requests).toHaveLength(1);
      expect(site.requests[0].cancels).toBe(0);
    }, 600_000);

    it("after a renewal that recorded the wallet asked, no answer in any order frees the chain or loses the evidence", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      const kept = SHAPES.filter((x) => !x.adopts && !x.frees);
      for (const a of SHAPES) await through([EVIDENCE, a], record, given);
      for (const a of kept) for (const b of SHAPES) await through([EVIDENCE, a, b], record, given);
      expect(site.requests[0].cancels).toBe(0);
    }, 600_000);

    it("Sol's round 6 repros: a transaction next_action names, on any read, is kept, and no exit after it frees the chain", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      for (const sol of SOL) {
        for (const exit of EXITS) {
          const now = await through([sol, exit], record, given);
          expect(now.signed, `${sol.name} → ${exit.name}`).toMatchObject({ walletAsked: true, hashes: [GRANT_HASH], submitted: given });
        }
      }
    }, 600_000);

    it("Sol's round 7 repros: a read or renewal, 200 or 503, with wallet evidence past the cap leaves the mark, and no exit after it frees the chain", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      for (const sol of SOL7) {
        for (const exit of EXITS) {
          const now = await through([sol, exit], record, given);
          expect(now.signed, `${sol.name} → ${exit.name}`).toMatchObject({ mayHaveSent: true, submitted: given });
        }
      }
      expect(site.requests[0].cancels).toBe(0);
    }, 600_000);

    it("every kind of answer this machine cannot read whole leaves the mark, at the renewal and at the read, and no exit after it frees the chain", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      for (const u of UNREADABLE) {
        for (const shapes of [[u], ...EXITS.map((exit) => [u, exit]), ...EXITS.map((exit) => [EVIDENCE, u, exit])]) {
          const now = await through(shapes, record, given);
          expect(now.signed, shapes.map((x) => x.name).join(" → ")).toMatchObject({ mayHaveSent: true, submitted: given });
        }
      }
      expect(site.requests[0].cancels).toBe(0);
    }, 600_000);

    it("controls: after answers each read whole with no evidence, every exit still frees the chain", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      const clean = SHAPES.filter((x) => !x.adopts && !x.frees && !x.asked && !x.unread);
      expect(clean.length).toBeGreaterThan(10);
      for (const exit of EXITS) {
        expect((await through([exit], record, given)).signed.submitted, exit.name).toBeUndefined();
        for (const a of clean) expect((await through([a, exit], record, given)).signed, `${a.name} → ${exit.name}`).not.toHaveProperty("submitted");
      }
    }, 600_000);

    // Every place walletEvidence reads a transaction from: the answer, its error, a step of either; in tx_hash, tx_hashes, and
    // next_action's tx_hash and tx_hashes (next_action of type none, so the hash alone is the evidence).
    const SPOT = `0x${"c3".repeat(32)}`;
    const FIELDS = ["tx_hash", "tx_hashes", "next_action.tx_hash", "next_action.tx_hashes"] as const;
    const put = (o: any, field: (typeof FIELDS)[number]) =>
      field === "tx_hash" ? { ...o, tx_hash: SPOT } : field === "tx_hashes" ? { ...o, tx_hashes: [SPOT] } : { ...o, next_action: field === "next_action.tx_hash" ? { type: "none", tx_hash: SPOT } : { type: "none", tx_hashes: [SPOT] } };
    const quiet = { index: 0, kind: "grant", state: "skipped", tx_hash: null, wallet_asked: false, reason_code: "link_not_done" };
    const PLACES: [string, (b: any) => any][] = FIELDS.flatMap((f): [string, (b: any) => any][] => [
      [`the answer's ${f}`, (b) => put(b, f)],
      [`the error's ${f}`, (b) => ({ ...b, error: put(b.error ?? { code: "unavailable" }, f) })],
      [`a step's ${f}`, (b) => ({ ...b, steps: [put(quiet, f)] })],
      [`a step of the error's ${f}`, (b) => ({ ...b, error: { ...(b.error ?? { code: "unavailable" }), steps: [put(quiet, f)] } })],
    ]);
    /** Answers that are not judged (no token, a failure, other terms, another request), and each exit, carrying the transaction. */
    const carriers = (place: (b: any) => any): Shape[] => ([
      { name: "renewal 200 without a token", renew: (r: { id: string }) => ({ status: 200, body: place({ id: r.id }) }) },
      { name: "renewal 503", renew: () => ({ status: 503, body: place({ error: { code: "unavailable" } }) }) },
      { name: "read with another amount", read: read((v) => place(otherAmount(v))) },
      { name: "read 503", read: () => ({ status: 503, body: place({ error: { code: "chain_unavailable" } }) }) },
      { name: "read about another request", read: read((v) => place({ ...v, id: "ba_different0002" })) },
      ...EXITS.map((exit): Shape => ({
        name: `${exit.name}, carrying it`,
        ...(exit.renew ? { renew: (r: { id: string; token: string }) => { const x = exit.renew!(r); return { ...x, body: place(x.body) }; } } : {}),
        ...(exit.read ? { read: (v: any) => { const x = exit.read!(v); return { ...x, body: place(x.body) }; } } : {}),
      })),
    ] as Shape[]).map((x) => ({ ...x, asked: true, hash: SPOT }));

    it("a transaction anywhere walletEvidence reads is kept, and blocks every exit, in the answer that carries it and after it", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      for (const [where, place] of PLACES) {
        for (const carrier of carriers(place)) {
          const what = `${carrier.name}, in ${where}`;
          const sequences = carrier.name.endsWith("carrying it") ? [[carrier]] : [[carrier], ...EXITS.map((exit) => [carrier, exit])];
          for (const shapes of sequences) {
            const now = await through(shapes.map((x) => ({ ...x, name: x === carrier ? what : x.name })), record, given);
            expect(now.signed, what).toMatchObject({ walletAsked: true, hashes: [SPOT], submitted: given });
          }
        }
      }
    }, 600_000);

    it("a final read whose reason code the site sets after the wallet may have been asked never gives the request up", async () => {
      const { request, record } = await sign(KEY, grant(AGENT, 10000n));
      const given = await submit(request);
      for (const code of [...AFTER_HANDOFF_CODES, null]) {
        for (const state of ["expired", "rejected", "cancelled"]) {
          const now = await through([{ name: `read with another amount, final as ${state}, wallet never asked, reason ${code}`, read: read((v) => ({ ...otherAmount(v), ...never(state, code) })) }], record, given);
          expect(now.signed.submitted).toEqual(given);
        }
      }
    }, 600_000);

    it("controls: with nothing given, no answer is asked for, nothing is kept and the chain is not held", async () => {
      const { record } = await sign(KEY, grant(AGENT, 10000n));
      const id = "oa-20261028000000-ffffffff";
      approvals.startSigning({ id, command: "grant", rail: "evm", chain: "base-sepolia", workerArgs: [], timeoutS: 60 });
      approvals.recordSigned(id, record);
      const signed = approvals.readApproval(id);
      expect(approvals.awaitingAdoption(signed)).toBe(true);
      expect(approvals.unsettledRequest(signed)).toBeNull();
      expect(approvals.walletWasAsked(signed)).toBe(false);
      expect(site.posts).toEqual([]);
    });
  });
});
