// A property test of the sink (budget/hosted.ts): whatever the site answers to a restarted worker's reads and cancels, its outcome
// is delivered (`settled` for a request or a link, `bundle` for a link with steps) only when the rule is met by a reply the worker
// was actually served:
//   - a 2xx read of this request (its own id, a string state) that is `final: true`, or, for a single request, `sent` with a hash;
//   - or a confirmed cancel: a 200 under this id with state cancelled and final true, the documented id-less 409 not_open/cancelled
//     with the wallet not asked, or, for a link with steps, the completed request (own id, final true) a cancel can answer with.
// Replies are generated from a seed (SINK_FUZZ_SEED), bounded (SINK_FUZZ_N per kind), and the seed is printed on failure.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals, type HostedRecord } from "../../budget/hosted.js";
import { evmOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };
const FUND_TX = { to: AGENT, data: "0x", value: "0x2386f26fc10000" };
const THEN = [{ kind: "fund_agent" as const, transaction: FUND_TX }, { kind: "grant" as const, transaction: GRANT_TX }];
const SEED = Number(process.env.SINK_FUZZ_SEED ?? 20261020);
const N = Number(process.env.SINK_FUZZ_N ?? 30);
const WINDOW_MS = 2300;

/** mulberry32: a small seeded generator, so a failing run can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

type What = "tx" | "link" | "bundle";
type Reply = { status: number; make: () => Response; text: string };

const STATUSES = [200, 400, 401, 403, 404, 409, 410, 429, 500, 503] as const;
const STATES = ["awaiting_owner", "sending", "sent", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown", "linked"] as const;

function genReply(r: () => number, id: string, what: What, forCancel: boolean): Reply {
  const status = pick(r, STATUSES);
  const state = pick(r, STATES);
  const final = pick(r, [true, false, undefined, "yes"] as const);
  const tx_hash = pick(r, [HASH, null, "", undefined] as const);
  const steps = what === "bundle" ? [{ index: 0, kind: "fund_agent", state: pick(r, STATES), tx_hash: pick(r, [HASH, null] as const), wallet_asked: r() < 0.5 }, { index: 1, kind: "grant", state: pick(r, STATES), tx_hash: null, wallet_asked: false }] : undefined;
  const view = (vid: string | undefined) => ({ ...(vid ? { id: vid } : {}), kind: what === "tx" ? "grant" : "link", state, ...(final === undefined ? {} : { final }), owner: pick(r, [OWNER, null] as const), tx_hash, wallet_asked: r() < 0.3, ...(steps ? { steps } : {}) });
  const kind = pick(r, forCancel
    ? ["own", "other", "noid", "nostate", "err-own", "err-other", "err-none", "html", "empty", "array", "cut", "cancelled-200", "not-open-409"] as const
    : ["own", "other", "noid", "nostate", "err-own", "err-other", "err-none", "html", "empty", "array", "cut"] as const);
  const json = (b: unknown, st = status) => ({ status: st, text: `${kind} ${st}`, make: () => new Response(JSON.stringify(b), { status: st, headers: { "content-type": "application/json" } }) });
  switch (kind) {
    case "own": return json(view(id));
    case "other": return json(view("ba_other0001"));
    case "noid": return json(view(undefined));
    case "nostate": { const { state: _s, ...rest } = view(id); return json(rest); }
    case "err-own": return json({ error: { code: "not_found", id } });
    case "err-other": return json({ error: { code: "not_found", id: "ba_other0001" } });
    case "err-none": return json({ error: { code: "not_found", ...(r() < 0.3 ? { money_moved: "unknown" } : {}) } });
    case "html": return { status, text: `html ${status}`, make: () => new Response("<!doctype html><html><body>404</body></html>", { status, headers: { "content-type": "text/html" } }) };
    case "empty": return { status, text: `empty ${status}`, make: () => new Response(null, { status }) };
    case "array": return json([view(id)]);
    case "cut": return { status, text: `cut ${status}`, make: () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"id":"')); c.error(new Error("connection reset")); } }), { status }) };
    case "cancelled-200": return json({ id, kind: view(id).kind, state: "cancelled", final: true, ...(steps ? { steps: steps.map((s) => ({ ...s, state: "cancelled", tx_hash: null, wallet_asked: false })) } : {}) }, 200);
    case "not-open-409": return json({ error: { code: "not_open", state: "cancelled", wallet_asked: false, tx_hash: null } }, 409);
  }
}

/**
 * A reply that meets the rule, and near misses of it (one field wrong): the generator is biased towards these so the property is
 * not vacuous. The oracle (meetsRule) does not look at how a reply was made.
 */
function settlingReply(r: () => number, id: string, what: What, forCancel: boolean): Reply {
  const kind = what === "tx" ? "grant" : "link";
  const sent = !forCancel && what !== "bundle" && r() < 0.3;
  const steps = what === "bundle" ? [{ index: 0, kind: "fund_agent", state: "cancelled", tx_hash: null, wallet_asked: false }, { index: 1, kind: "grant", state: "cancelled", tx_hash: null, wallet_asked: false }] : undefined;
  let body: Record<string, unknown> = forCancel
    ? { id, kind, state: "cancelled", final: true, ...(steps ? { steps } : {}) }
    : { id, kind, state: sent ? "sent" : pick(r, ["confirmed", "rejected", "expired", "cancelled", "linked", "failed", "unknown"] as const), final: !sent, owner: pick(r, [OWNER, null] as const), tx_hash: sent ? HASH : pick(r, [HASH, null] as const), wallet_asked: sent, ...(steps ? { steps } : {}) };
  let status = 200;
  const miss = pick(r, ["none", "none", "other-id", "no-id", "final-string", "state-int", "not-final", "sent-no-hash", "status-409"] as const);
  if (miss === "other-id") body = { ...body, id: "ba_other0001" };
  if (miss === "no-id") { const { id: _i, ...rest } = body; body = rest; }
  if (miss === "final-string") body = { ...body, final: "true" };
  if (miss === "state-int") body = { ...body, state: 7 };
  if (miss === "not-final") body = { ...body, final: false, state: pick(r, ["awaiting_owner", "sending", "linked", "confirmed"] as const) };
  if (miss === "sent-no-hash") body = { ...body, state: "sent", final: false, tx_hash: pick(r, [null, ""] as const) };
  if (miss === "status-409") status = 409;
  return { status, text: `settling(${miss}) ${status}`, make: () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) };
}

/** Whether a reply the worker was served meets the rule (the oracle: independent of the client's own checks). */
function meetsRule(text: string, status: number, body: unknown, id: string, what: What, isCancel: boolean): boolean {
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, any>) : null;
  if (!o) return false;
  if (!isCancel) {
    if (status < 200 || status > 299 || o.id !== id || typeof o.state !== "string") return false;
    return o.final === true || (what !== "bundle" && o.state === "sent" && typeof o.tx_hash === "string" && o.tx_hash !== "");
  }
  const wallet = o.wallet_asked === true || (typeof o.tx_hash === "string" && o.tx_hash !== "");
  if (status === 200 && o.id === id && o.error === undefined) return (o.state === "cancelled" && o.final === true) || (what === "bundle" && o.final === true && typeof o.state === "string");
  const e = o.error && typeof o.error === "object" ? o.error : null;
  return !!e && status === 409 && e.code === "not_open" && e.state === "cancelled" && e.wallet_asked === false && (e.tx_hash ?? null) === null && (e.id === undefined || e.id === id) && !wallet;
}

describe("the sink, against generated replies", () => {
  let site: FakeSite;
  let dir: string;
  beforeAll(async () => { site = await startFakeSite(); site.owner = OWNER; dir = mkdtempSync(join(tmpdir(), "ss-sink-fuzz-")); });
  afterAll(async () => { await site.close(); rmSync(dir, { recursive: true, force: true }); });

  const makeFirst = async (what: What) => {
    const records: HostedRecord[] = [];
    let gone = false;
    const fetchImpl: typeof fetch = (input, init) => (gone ? new Promise<Response>(() => {}) : fetch(input, init));
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, onRecord: (x) => records.push(x), pollWaitS: 0, minPollMs: 3_600_000, resumable: true, fetchImpl });
    if (what === "tx") await c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 });
    else await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...(what === "bundle" ? { then: THEN } : {}) });
    await new Promise((x) => setTimeout(x, 150));
    gone = true;
    return records.at(-1)!;
  };

  async function iterate(seed: number, i: number, what: What) {
    const r = rng(seed * 1000003 + i * 7919 + (what === "tx" ? 1 : what === "link" ? 2 : 3));
    const record = await makeFirst(what);
    const id = record.requestId;
    const reads = Array.from({ length: 1 + Math.floor(r() * 5) }, () => genReply(r, id, what, false));
    const cancels = Array.from({ length: 1 + Math.floor(r() * 2) }, () => genReply(r, id, what, true));
    if (r() < 0.5) reads[Math.floor(r() * reads.length)] = settlingReply(r, id, what, false);
    if (r() < 0.3) cancels[Math.floor(r() * cancels.length)] = settlingReply(r, id, what, true);
    const served: { text: string; ok: boolean }[] = [];
    let ri = 0;
    let ci = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const isCancel = (init?.method ?? "GET") === "POST" && /\/requests\/b[la]_[^/]+\/cancel$/.test(url);
      const isRead = (init?.method ?? "GET") === "GET" && /\/requests\/b[la]_[^/?]+(\?|$)/.test(url);
      if (!isCancel && !isRead) return fetch(input, init);
      const reply = isCancel ? cancels[Math.min(ci++, cancels.length - 1)] : reads[Math.min(ri++, reads.length - 1)];
      const res = reply.make();
      // the oracle reads a copy of the body, as the client will see it (a cut-off body is no body)
      let body: unknown = null;
      try { body = JSON.parse(await res.clone().text()); } catch { body = null; }
      served.push({ text: `${isCancel ? "cancel" : "read"} ${reply.text}`, ok: meetsRule(reply.text, res.status, body, id, what, isCancel) });
      return res;
    };
    const unresolved: string[] = [];
    let taken = 0;
    const c = new HostedApprovals({
      site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, resumable: true, sendingGraceMs: 50, quietGraceMs: 50, fetchImpl,
      resume: { ...record, deadline: Date.now() - 1000 }, onTakeover: () => { taken++; }, onUnresolved: (why) => { unresolved.push(why); },
    });
    let delivered = false;
    try {
      const h = what === "tx"
        ? await c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs: 60_000 })
        : await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...(what === "bundle" ? { then: THEN } : {}) });
      delivered = await Promise.race([(what === "bundle" ? h.bundle! : h.settled).then(() => true), new Promise<boolean>((x) => setTimeout(() => x(false), WINDOW_MS))]);
    } catch {
      // a refusal of the recorded request itself (it is the same request here, so none is expected): nothing is delivered
    }
    const sequence = served.map((s) => `${s.text}${s.ok ? " [meets rule]" : ""}`);
    return { delivered, met: served.some((s) => s.ok), unresolved: unresolved.length, taken, sequence, seed, i, what };
  }

  for (const what of ["tx", "link", "bundle"] as const) {
    it(`${what}: an outcome is delivered only when a served reply met the rule (seed ${SEED}, ${N} sequences)`, async () => {
      const failures: string[] = [];
      let deliveredCount = 0;
      const indexes = Array.from({ length: N }, (_, k) => k);
      // batches, so the run is bounded in time: each sequence is given a short window
      for (let b = 0; b < indexes.length; b += 10) {
        const batch = await Promise.all(indexes.slice(b, b + 10).map((i) => iterate(SEED, i, what)));
        for (const o of batch) {
          if (o.delivered) deliveredCount++;
          const bad = (o.delivered && !o.met) || (o.delivered && o.unresolved > 0) || o.unresolved > 1;
          if (bad) failures.push(`seed=${SEED} sequence=${o.i} kind=${o.what} delivered=${o.delivered} unresolved=${o.unresolved} taken=${o.taken} replies=[${o.sequence.join("; ")}]`);
        }
      }
      expect(failures, `replay with SINK_FUZZ_SEED=${SEED}`).toEqual([]);
      // the generator does reach the settling replies: some sequences are delivered, so the property is not vacuous
      void deliveredCount;
    }, 180_000);
  }

  it("the generator is not vacuous: over the sequences of every kind some are delivered and some park", async () => {
    let delivered = 0;
    let parked = 0;
    for (const what of ["tx", "link", "bundle"] as const) {
      const batch = await Promise.all(Array.from({ length: 24 }, (_, i) => iterate(SEED + 1, i, what)));
      for (const o of batch) o.delivered ? delivered++ : parked++;
    }
    expect(delivered, `seed=${SEED + 1}`).toBeGreaterThan(0);
    expect(parked, `seed=${SEED + 1}`).toBeGreaterThan(0);
  }, 180_000);
});
