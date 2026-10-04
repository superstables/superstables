// One rule for buy-once, checked over many sequences of site answers: once any answer for a purchase has carried payment
// evidence (a transaction id, a paid state, or money_moved other than false), no later outcome for it is paid: false or
// says "nothing was paid". A sequence with no evidence that ends in an explicit not-paid state still ends unpaid (exit 1
// or 3). The real code (budget/once.mjs) runs in this process against the fake purchase site and its fake chain; the
// test serves its scripted answers through fetchImpl and forwards the rest. Seeded, so every run plays the same sequences.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYER, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

const home = mkdtempSync(join(tmpdir(), "ss-once-invariant-"));
process.env.SUPERSTABLES_HOME = home;
// the module is plain JavaScript; its inferred types do not describe every result shape, so it is used untyped here
const once: any = await import("../../budget/once.mjs");
const approvals: any = await import("../../budget/approvals.mjs");
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let site: FakePurchaseSite;
beforeAll(async () => {
  site = await startFakePurchaseSite();
  process.env.B4_RPC = site.chainUrl;
});
afterAll(async () => {
  await site.close();
  rmSync(home, { recursive: true, force: true });
});

/** mulberry32: a small seeded generator, so the sequences are the same on every run. */
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

type Ev = Record<string, unknown>;
const HASH = `0x${"3c".repeat(32)}`;
/** The evidence an answer may carry, and whether this test counts it as evidence (its own definition, not the code's). */
const EVIDENCE: [Ev, boolean][] = [
  [{}, false],
  [{ money_moved: false }, false],
  [{ payment: { money_moved: false } }, false],
  [{ payment: { transaction: HASH, payer: PAYER } }, true],
  [{ payment: { transaction: HASH } }, true],
  [{ payment: { transaction: "not-a-hash" } }, true],
  [{ payment: { status: "paid" } }, true],
  [{ money_moved: true }, true],
  [{ money_moved: null }, true],
  [{ money_moved: "unknown" }, true],
  [{ payment: { money_moved: "unknown" } }, true],
  [{ error: { code: "internal_error", message: "x", money_moved: true } }, true],
  [{ receipt: { transaction: HASH, payer: PAYER } }, true],
  // the site saying the outcome is not known: an uncertain state, or a payment status of unknown
  [{ state: "uncertain", reason_code: "wallet_may_have_sent" }, true],
  [{ payment: { status: "unknown" } }, true],
];

type Answer = { status: number; body: unknown };
/** The answers the test serves next, by kind; anything else goes to the fake site. */
const queue: Record<"create" | "read" | "cancel", ((forward: () => Promise<Response>) => Promise<Answer>)[]> = { create: [], read: [], cancel: [] };
let served: boolean[] = [];

const kindOf = (url: string, init?: RequestInit) =>
  /\/api\/v1\/purchases$/.test(url) && init?.method === "POST" ? "create" : /\/cancel$/.test(url) ? "cancel" : /\/api\/v1\/purchases\/[^/?]+\?/.test(url) ? "read" : null;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const kind = kindOf(url, init);
  const next = kind ? queue[kind].shift() : undefined;
  if (!next) return fetch(input, init);
  const a = await next(() => fetch(input, init));
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

/** An answer with evidence merged in (payment objects are merged, not replaced). */
const withEv = (body: Record<string, any>, ev: Ev, counts: boolean): Record<string, any> => {
  served.push(counts);
  const out = { ...body, ...ev };
  if (ev.payment) out.payment = { ...(body.payment ?? {}), ...(ev.payment as object) };
  return out;
};

/** A scripted answer that is the fake site's own. */
const passthrough = async (forward: () => Promise<Response>): Promise<Answer> => {
  const res = await forward();
  return { status: res.status, body: await res.json() };
};

type Outcome = { paid: unknown; code: number; text: string; about: "ours" | "none" };
const fromStart = (r: any): Outcome =>
  r.ok ? { paid: undefined, code: 0, text: "", about: "none" }
  : r.code === 5 ? { paid: r.result?.paid ?? null, code: 5, text: `${r.reason} ${r.next}`, about: "ours" }
  : r.pending ? { paid: undefined, code: r.code, text: "", about: "none" }
  // the dispatcher prints any other refusal of a purchase this command made as paid: false
  : { paid: false, code: r.code, text: `${r.reason} ${r.next}`, about: "ours" };
// a final answer, or an open one whose outcome is not established (unknown, not final): both are about this purchase
const fromSettle = (s: any): Outcome =>
  s.final || s.result ? { paid: s.result.paid, code: s.code, text: `${s.result.reason ?? ""} ${s.result.next ?? ""}`, about: "ours" } : { paid: undefined, code: 0, text: "", about: "none" };

const ARGS = { site: "", service: "demo-market-data", params: { asset: "BTC" }, max: "0.01" };

/** Play one sequence; return a description of any broken rule, or null. */
async function play(seed: number): Promise<string | null> {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const ev = () => pick(EVIDENCE);
  rmSync(join(home, "budget"), { recursive: true, force: true });
  for (const k of Object.keys(queue) as (keyof typeof queue)[]) queue[k] = [];
  served = [];
  const log: string[] = [];
  const seen = () => served.some(Boolean);
  const check = (what: string, o: Outcome) => {
    if (o.about !== "ours") return null;
    if (seen() && (o.paid === false || /nothing was paid/i.test(o.text))) return `${what}: paid ${String(o.paid)} after evidence (${o.text}) [${log.join(" | ")}]`;
    return null;
  };
  const args = { ...ARGS, site: site.url, fetchImpl };

  // 1. creation: as the site makes it, with evidence, with an unusable id, or a 4xx error
  const create = pick(["ok", "ok", "okE", "badId", "error"]);
  const [cev, ccount] = ev();
  log.push(`create ${create}${create === "ok" ? "" : ` ${JSON.stringify(cev)}`}`);
  if (create === "okE" || create === "badId") {
    queue.create.push(async (forward) => {
      const body = (await (await forward()).json()) as Record<string, any>;
      return { status: 201, body: withEv(create === "badId" ? { ...body, id: "not-a-purchase-id" } : body, cev, ccount) };
    });
  } else if (create === "error") {
    const { error: cerr, ...rest } = cev;
    const status = pick([409, 422]);
    queue.create.push(async () => ({ status, body: withEv({ error: { code: "invalid_params", message: "x", ...((cerr as object) ?? {}) } }, rest, ccount) }));
  }
  const started = await once.startOnce(args);
  const bad = check("create", fromStart(started));
  if (bad) return bad;
  if (!started.ok) {
    // ended at creation: with no evidence it is unpaid, exit 1, 2 or 3
    if (!seen() && started.code === 5) return `create: unknown with no evidence [${log.join(" | ")}]`;
    return null;
  }
  let record = started.record;

  // 2. a few reads: as the site has it, a non-final answer with evidence, an error with evidence, or two in one wait
  const steps = Math.floor(r() * 4);
  // after a replacement, another purchase is open too: a second --replace could act on that one, so it is not played
  let replaced = false;
  for (let i = 0; i < steps; i++) {
    const picked = pick(["forward", "nonfinal", "error", "wait2", "replace", "replaceE"]);
    const step = (picked === "replace" || picked === "replaceE") && replaced ? "forward" : picked;
    const [e, counts] = ev();
    log.push(`${step} ${JSON.stringify(e)}`);
    const id = record.hosted.requestId;
    if (step === "nonfinal") queue.read.push(async () => ({ status: 200, body: withEv({ id, state: "awaiting_approval", final: false, payment: { status: "awaiting_approval" } }, e, counts) }));
    if (step === "error") queue.read.push(async () => ({ status: 503, body: withEv({ error: { code: "internal_error", message: "x" } }, e, counts) }));
    if (step === "wait2") {
      // one wait, two reads: evidence, then a final not-paid answer without it
      queue.read.push(async () => ({ status: 200, body: withEv({ id, state: "awaiting_approval", final: false, payment: { status: "awaiting_approval" } }, e, counts) }));
      queue.read.push(async () => ({ status: 200, body: { id, state: "failed", final: true, reason_code: "not_settled", payment: { status: "not_paid" }, delivery: { status: "not_called" } } }));
      const w = await once.waitOnce(record, 5_000, { fetchImpl });
      const b = check("wait", fromSettle(w));
      if (b) return b;
      record = w.record ?? record;
      if (w.final && w.result?.final !== false) break;
      continue;
    }
    if (step === "replaceE") {
      // --replace: the first read as the site has it, a confirmed cancel without evidence, then the read after the cancel
      // carries the evidence. With evidence, no second purchase may be created.
      queue.read.push(passthrough);
      queue.cancel.push(async () => ({ status: 200, body: { id, state: "denied", final: true, reason_code: "agent_cancelled", payment: { status: "not_paid" } } }));
      queue.read.push(async () => ({ status: 200, body: withEv({ id, state: "denied", final: true, reason_code: "agent_cancelled", payment: { status: "not_paid" }, delivery: { status: "not_called" } }, e, counts) }));
      const before = site.purchases.length;
      const again = await once.startOnce({ ...args, replace: true });
      queue.read = [];
      queue.cancel = [];
      const b = check("replace after cancel", fromStart(again));
      if (b) return b;
      if (counts && site.purchases.length !== before) return `replace after cancel: a new purchase was created after evidence [${log.join(" | ")}]`;
      if (again.ok) replaced = true;
      // the old purchase may be final now (unpaid, with no evidence): the final answer below then reads the stored one
      continue;
    }
    if (step === "replace") {
      // --replace reads the open purchase (as the site has it), then cancels it; the cancel answer may carry evidence
      queue.cancel.push(async () => ({ status: 200, body: withEv({ id, state: "denied", final: true, reason_code: "agent_cancelled", payment: { status: "not_paid" } }, e, counts) }));
      const again = await once.startOnce({ ...args, replace: true });
      const b = check("replace", fromStart(again));
      if (b) return b;
      if (again.ok) replaced = true;
      // a refused replacement sends no cancel: its answer is not served
      queue.cancel = [];
      // a replacement started a new purchase: the rest of the sequence still reads the old one
      continue;
    }
    const s = await once.settleOnce(record, { waitS: 0, fetchImpl });
    const b = check(step, fromSettle(s));
    if (b) return b;
    record = s.record ?? record;
  }

  // 3. the site's final answer: not paid, with no evidence of its own
  const end = pick(["expired", "failed", "denied", "failedUnknown"]);
  log.push(`final ${end}`);
  const id = record.hosted.requestId;
  if (end === "failedUnknown") {
    // the site concluded with the payment unknown (no transfer found as of its last check; one could still arrive)
    queue.read.push(async () => ({ status: 200, body: withEv({ id, state: "failed", final: true, reason_code: "not_settled", delivery: { status: "not_called" }, next_action: { type: "report_unknown" } }, { payment: { status: "unknown" } }, true) }));
  } else {
    queue.read.push(async () => ({ status: 200, body: { id, state: end, final: true, reason_code: end === "denied" ? "owner_rejected" : end === "expired" ? "approval_expired" : "not_settled", payment: { status: "not_paid" }, delivery: { status: "not_called" } } }));
  }
  const fin = await once.settleOnce(record, { waitS: 0, fetchImpl });
  const o = fromSettle(fin);
  const b = check("final", o);
  if (b) return b;
  if (!seen() && fin.final && (o.paid !== false || ![1, 3].includes(o.code))) return `final: no evidence, but paid ${String(o.paid)} exit ${o.code} [${log.join(" | ")}]`;
  if (seen() && fin.final && o.paid === false) return `final: paid false after evidence [${log.join(" | ")}]`;
  return null;
}

describe("buy-once: once payment evidence appears, no outcome says nothing was paid", () => {
  it("holds over 300 seeded sequences of creation, read, wait, replace and cancel answers", async () => {
    const broken: string[] = [];
    let withEvidence = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const why = await play(seed);
      if (served.some(Boolean)) withEvidence++;
      if (why) broken.push(`seed ${seed}: ${why}`);
    }
    expect(broken).toEqual([]);
    // both kinds of sequence were played
    expect(withEvidence).toBeGreaterThan(50);
    expect(300 - withEvidence).toBeGreaterThan(50);
  }, 60_000);
  it("one wait keeps what its first read found: a read error with money_moved, then a final not-paid answer, is unknown", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    for (const k of Object.keys(queue) as (keyof typeof queue)[]) queue[k] = [];
    const started = await once.startOnce({ ...ARGS, site: site.url, fetchImpl });
    expect(started.ok).toBe(true);
    const id = started.record.hosted.requestId;
    queue.read.push(async () => ({ status: 503, body: { error: { code: "internal_error", message: "x" }, money_moved: true } }));
    queue.read.push(async () => ({ status: 200, body: { id, state: "failed", final: true, reason_code: "not_settled", payment: { status: "not_paid" }, delivery: { status: "not_called" } } }));
    const w = await once.waitOnce(started.record, 10_000, { fetchImpl });
    expect(w.final).toBe(true);
    expect(w.code).toBe(5);
    expect(w.result).toMatchObject({ state: "unknown", paid: null });
    expect(`${w.result.reason} ${w.result.next}`).not.toMatch(/nothing was paid/i);
  }, 30_000);

  it("creation retries keep every answer's evidence: a 500 with money_moved, then an ordinary 409, is unknown and stored", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    for (const k of Object.keys(queue) as (keyof typeof queue)[]) queue[k] = [];
    queue.create.push(async () => ({ status: 500, body: { error: { code: "internal_error", message: "x", money_moved: true } } }));
    queue.create.push(async () => ({ status: 409, body: { error: { code: "idempotency_conflict", message: "x", money_moved: false } } }));
    const r: any = await once.startOnce({ ...ARGS, site: site.url, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown", paid: null });
    expect(`${r.reason} ${r.next}`).not.toMatch(/nothing was paid/i);
    // stored under its own id, so wait --id can print it again
    const again = await once.settleOnce(r.record, { waitS: 0, fetchImpl });
    expect(again).toMatchObject({ final: true, code: 5 });
  }, 30_000);
  const fresh = async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    for (const k of Object.keys(queue) as (keyof typeof queue)[]) queue[k] = [];
    const started = await once.startOnce({ ...ARGS, site: site.url, fetchImpl });
    expect(started.ok).toBe(true);
    return started.record;
  };

  it("two processes adding evidence to one record at once lose none of it (read, union and write under the record's lock)", async () => {
    const record = await fresh();
    const script = `
      const once = await import(${JSON.stringify(resolve(ROOT, "budget/once.mjs"))});
      const [id, tag, n] = process.argv.slice(1);
      for (let i = 0; i < Number(n); i++) {
        const h = "0x" + tag.repeat(2) + i.toString(16).padStart(62, "0");
        once.accumulate({ id, chain: "base-sepolia" }, { payment: { transaction: h, payer: ${JSON.stringify(PAYER)} } });
        if (tag === "b" && i === 7) once.accumulate({ id, chain: "base-sepolia" }, { money_moved: true });
      }`;
    const run = (tag: string) => new Promise<number>((done, fail) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, record.id, tag, "40"], { env: { ...process.env, SUPERSTABLES_HOME: home }, stdio: ["ignore", "ignore", "inherit"] });
      child.once("error", fail);
      child.once("close", (code) => done(code ?? 1));
    });
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
    const seen = approvals.readApproval(record.id).seen;
    expect(seen.hashes).toHaveLength(80);
    expect(seen.moved).toBe(true);
  }, 60_000);

  it("a final unpaid answer is not stored when another command added evidence while it was being decided", async () => {
    const record = await fresh();
    const id = record.hosted.requestId;
    // after this command decided "not paid" and before it stores that, another command stores money_moved: true
    queue.read.push(async () => ({ status: 200, body: { id, state: "failed", final: true, reason_code: "not_settled", payment: { status: "not_paid" }, delivery: { status: "not_called" } } }));
    once.onceTestHook.beforeFinal = (rid: string) => {
      once.onceTestHook.beforeFinal = null;
      once.accumulate({ id: rid, chain: record.chain }, { money_moved: true });
    };
    const s = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(s.result.paid).not.toBe(false);
    expect(`${s.result.reason} ${s.result.next}`).not.toMatch(/nothing was paid/i);
    const stored = approvals.readApproval(record.id);
    expect(stored.final?.result?.paid).not.toBe(false);
    // the next read decides with that evidence: unknown, never unpaid
    queue.read.push(async () => ({ status: 200, body: { id, state: "failed", final: true, reason_code: "not_settled", payment: { status: "not_paid" }, delivery: { status: "not_called" } } }));
    const again = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(again).toMatchObject({ final: true, code: 5 });
    expect(again.result).toMatchObject({ state: "unknown", paid: null });
  }, 30_000);

  it("a stored unpaid answer is never repeated when the record's evidence says a payment may have happened", async () => {
    const record = await fresh();
    const hash = `0x${"5d".repeat(32)}`;
    // the record holds evidence, and (from a command that decided before it arrived) a final unpaid answer
    once.accumulate(record, { payment: { transaction: hash, payer: PAYER } });
    approvals.recordFinal(record.id, 1, { ok: false, command: "buy-once", state: "failed", paid: false, delivered: false, amount: "0", tx: {}, next: "nothing was paid. Do not retry blindly", reason: "the site's reason: not_settled" });
    const s = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(s).toMatchObject({ final: true, code: 5 });
    expect(s.result).toMatchObject({ state: "unknown", paid: null, tx: { settle: hash } });
    expect(`${s.result.reason} ${s.result.next}`).not.toMatch(/nothing was paid/i);
    // stored that way: every later wait says the same
    expect(approvals.readApproval(record.id).final).toMatchObject({ code: 5, result: { state: "unknown", paid: null } });
  }, 30_000);

  it("--replace starts nothing new when the read after a confirmed cancel names a transaction: unknown, with the hash", async () => {
    const record = await fresh();
    const id = record.hosted.requestId;
    const hash = `0x${"6e".repeat(32)}`;
    queue.read.push(passthrough);
    queue.cancel.push(async () => ({ status: 200, body: { id, state: "denied", final: true, reason_code: "agent_cancelled", payment: { status: "not_paid" } } }));
    queue.read.push(async () => ({ status: 200, body: { id, state: "denied", final: true, reason_code: "agent_cancelled", payment: { status: "not_paid", transaction: hash, payer: PAYER }, delivery: { status: "not_called" } } }));
    const before = site.purchases.length;
    const r = await once.startOnce({ ...ARGS, site: site.url, fetchImpl, replace: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(5);
    expect(r.reason).toMatch(new RegExp(`named a transaction or a payment for it \\(${hash}\\)`));
    expect(r.record.seen.hashes).toContain(hash);
    expect(site.purchases.length).toBe(before);
  }, 30_000);
  it("evidence that arrives after another command stored an unpaid final is kept, and the final is no longer unpaid", async () => {
    const notPaid = (id: string, extra: Record<string, unknown> = {}) => ({ id, state: "failed", final: true, reason_code: "not_settled", delivery: { status: "not_called" }, ...extra, payment: { status: "not_paid", ...((extra.payment as object) ?? {}) } });
    const kinds: [string, (id: string) => Answer][] = [
      ["money_moved", (id) => ({ status: 200, body: notPaid(id, { money_moved: true }) })],
      ["malformed transaction id", (id) => ({ status: 200, body: notPaid(id, { payment: { transaction: "not-a-hash" } }) })],
      ["non-final hash", (id) => ({ status: 200, body: { id, state: "submitting", final: false, payment: { status: "unconfirmed", transaction: `0x${"8f".repeat(32)}`, payer: PAYER } } })],
      ["error envelope", () => ({ status: 503, body: { error: { code: "internal_error", message: "x", money_moved: "unknown" } } })],
    ];
    for (const [name, late] of kinds) {
      const record = await fresh();
      const id = record.hosted.requestId;
      // command B has started reading; while its read is in flight, command A reads a final not-paid answer and stores it
      queue.read.push(async () => {
        const a = await once.settleOnce({ ...record }, { waitS: 0, fetchImpl });
        expect(a.result.paid, name).toBe(false);
        expect(approvals.readApproval(record.id).final.result.paid, name).toBe(false);
        return late(id);
      });
      queue.read.push(async () => ({ status: 200, body: notPaid(id) }));
      const b = await once.settleOnce({ ...record }, { waitS: 0, fetchImpl });
      expect(b.result?.paid ?? null, name).not.toBe(false);
      expect(`${b.result?.reason ?? ""} ${b.result?.next ?? ""} ${b.words ?? ""}`, name).not.toMatch(/nothing was paid/i);
      // stored that way: every later wait says the same
      const stored = approvals.readApproval(record.id);
      expect(stored.final.result.paid, name).toBeNull();
      const later = await once.settleOnce(stored, { waitS: 0, fetchImpl });
      expect(later, name).toMatchObject({ final: true, code: 5 });
      expect(later.result.paid, name).toBeNull();
    }
  }, 60_000);

  it("a payer conflict recorded between the chain check and the paid commit makes the outcome unknown, never paid", async () => {
    const record = await fresh();
    const id = record.hosted.requestId;
    const hash = `0x${"7a".repeat(32)}`;
    const other = `0x${"77".repeat(20)}`;
    // the chain shows the payment from PAYER, and the site says paid by PAYER
    site.pay(site.purchases.at(-1)!, { transaction: hash, payer: PAYER });
    const settled = { id, state: "settled", final: true, payment: { status: "paid", transaction: hash, payer: PAYER }, delivery: { status: "delivered", http_status: 200, result: { ok: true } } };
    queue.read.push(async () => ({ status: 200, body: settled }));
    // after this command verified it and before it stores "paid", another command records another payer for that hash
    once.onceTestHook.beforeFinal = (rid: string) => {
      once.onceTestHook.beforeFinal = null;
      once.accumulate({ id: rid, chain: record.chain }, { payment: { transaction: hash, payer: other } });
    };
    const a = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(a.result.paid).toBeNull();
    expect(a.result.state).toBe("unknown");
    expect(approvals.readApproval(record.id).final?.result?.paid).not.toBe(true);
    // decided again on the next read: the hash has no single payer, so it cannot establish payment
    queue.read.push(async () => ({ status: 200, body: settled }));
    const later = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(later.result).toMatchObject({ state: "unknown", paid: null, tx: { settle: hash } });
  }, 30_000);
  it("a stored paid verdict is re-checked too: another payer named for its transaction later makes it unknown", async () => {
    const record = await fresh();
    const hash = `0x${"4b".repeat(32)}`;
    once.accumulate(record, { payment: { transaction: hash, payer: PAYER } });
    approvals.recordFinal(record.id, 0, { ok: true, command: "buy-once", state: "settled", paid: true, delivered: true, amount: "0.01", tx: { settle: hash }, payer: PAYER, next: "none" });
    // the stored verdict holds while the transaction has that one payer
    expect((await once.settleOnce(record, { waitS: 0, fetchImpl })).result.paid).toBe(true);
    // another answer names a different payer for the same transaction
    once.accumulate(record, { payment: { transaction: hash, payer: `0x${"77".repeat(20)}` } });
    const s = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(s).toMatchObject({ final: true, code: 5 });
    expect(s.result).toMatchObject({ state: "unknown", paid: null, tx: { settle: hash } });
    expect(approvals.readApproval(record.id).final.result.paid).toBeNull();
  }, 30_000);
  // an EVM transaction hash spelled in two letter cases is one transaction
  const LOWER = `0x${"ab".repeat(32)}`;
  const UPPER = `0x${"AB".repeat(32)}`;
  const OTHER = `0x${"77".repeat(20)}`;
  const settledWith = (id: string, transaction: string, payer: string) => ({ id, state: "settled", final: true, payment: { status: "paid", transaction, payer }, delivery: { status: "delivered", http_status: 200, result: { ok: true } } });

  it("one key per EVM transaction: another payer named for the same hash in other letters, read late, makes it unknown", async () => {
    const record = await fresh();
    const id = record.hosted.requestId;
    site.pay(site.purchases.at(-1)!, { transaction: LOWER, payer: PAYER });
    // command B's read is in flight while command A verifies the lowercase hash and stores "paid"
    queue.read.push(async () => {
      const a = await once.settleOnce({ ...record }, { waitS: 0, fetchImpl });
      expect(a.result.paid).toBe(true);
      return { status: 200, body: { id, state: "submitting", final: false, payment: { status: "unconfirmed", transaction: UPPER, payer: OTHER } } };
    });
    queue.read.push(async () => ({ status: 200, body: settledWith(id, LOWER, PAYER) }));
    const b = await once.settleOnce({ ...record }, { waitS: 0, fetchImpl });
    expect(b.result).toMatchObject({ state: "unknown", paid: null, tx: { settle: LOWER } });
    const stored = approvals.readApproval(record.id);
    expect(stored.seen.hashes).toEqual([LOWER]);
    expect(stored.seen.payers).toEqual({ [LOWER]: null });
    expect((await once.settleOnce(stored, { waitS: 0, fetchImpl })).result.paid).toBeNull();
  }, 30_000);

  it("one key per EVM transaction: another payer for the same hash in other letters, between verification and commit, is unknown", async () => {
    const record = await fresh();
    const id = record.hosted.requestId;
    site.pay(site.purchases.at(-1)!, { transaction: LOWER, payer: PAYER });
    queue.read.push(async () => ({ status: 200, body: settledWith(id, LOWER, PAYER) }));
    once.onceTestHook.beforeFinal = (rid: string) => {
      once.onceTestHook.beforeFinal = null;
      once.accumulate({ id: rid, chain: record.chain }, { payment: { transaction: UPPER, payer: OTHER } });
    };
    const a = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(a.result).toMatchObject({ state: "unknown", paid: null });
    expect(approvals.readApproval(record.id).final?.result?.paid).not.toBe(true);
  }, 30_000);

  it("a record written with one transaction in two letter cases is read as one, its payers merged (two: none)", async () => {
    const record = await fresh();
    // an older record: the same transaction under two spellings, with two payers, and a stored paid verdict
    approvals.updateApproval(record.id, () => ({ seen: { hashes: [UPPER, LOWER], payers: { [UPPER]: PAYER, [LOWER]: OTHER }, named: true, paid: true, moved: false } }));
    approvals.recordFinal(record.id, 0, { ok: true, command: "buy-once", state: "settled", paid: true, delivered: true, amount: "0.01", tx: { settle: LOWER }, payer: PAYER, next: "none" });
    const s = await once.settleOnce(record, { waitS: 0, fetchImpl });
    expect(s.result).toMatchObject({ state: "unknown", paid: null, tx: { settle: LOWER } });
    // stored in the canonical form
    const stored = approvals.readApproval(record.id);
    expect(stored.seen.hashes).toEqual([LOWER]);
    expect(stored.seen.payers).toEqual({ [LOWER]: null });
  }, 30_000);

  it("Solana signatures keep their letter case: two signatures that differ only in case are two transactions", async () => {
    const id = approvals.newApprovalId();
    approvals.saveApproval({ id, command: "buy-once", rail: "solana", chain: "devnet", state: "waiting_owner", createdAt: new Date().toISOString() });
    const sigA = `5${"a".repeat(86)}`;
    const sigB = `5${"A".repeat(86)}`;
    const payerA = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const payerB = "So11111111111111111111111111111111111111112";
    once.accumulate({ id, chain: "devnet" }, { payment: { transaction: sigA, payer: payerA } });
    once.accumulate({ id, chain: "devnet" }, { payment: { transaction: sigB, payer: payerB } });
    const seen = approvals.readApproval(id).seen;
    expect(seen.hashes.sort()).toEqual([sigA, sigB].sort());
    expect(seen.payers).toEqual({ [sigA]: payerA, [sigB]: payerB });
  }, 30_000);

  it("the store refuses a write that would drop or replace payment evidence, final record or not", async () => {
    const record = await fresh();
    const h2 = `0x${"cd".repeat(32)}`;
    once.accumulate(record, { payment: { transaction: LOWER, payer: PAYER } });
    once.accumulate(record, { money_moved: true });
    const before = approvals.readApproval(record.id).seen;
    // a hash dropped, a flag cleared, a payer replaced: each refused
    for (const seen of [
      { ...before, hashes: [] },
      { ...before, moved: false },
      { ...before, payers: { [LOWER]: OTHER } },
      { hashes: [h2], payers: {}, named: false, paid: false, moved: false },
    ]) {
      approvals.updateApproval(record.id, () => ({ seen }));
      expect(approvals.readApproval(record.id).seen).toEqual(before);
    }
    // the same on a final record
    approvals.recordFinal(record.id, 5, { ok: false, command: "buy-once", state: "unknown", paid: null });
    approvals.updateApproval(record.id, () => ({ seen: { ...before, hashes: [] } }));
    expect(approvals.readApproval(record.id).seen).toEqual(before);
    // growing is allowed: another hash, and a payer turned into a conflict (null)
    approvals.updateApproval(record.id, () => ({ seen: { ...before, hashes: [...before.hashes, h2], payers: { [LOWER]: null } } }));
    expect(approvals.readApproval(record.id).seen).toMatchObject({ hashes: [LOWER, h2], payers: { [LOWER]: null } });
  }, 30_000);
  /** A record holding evidence; final or not. Returns the record and a copy of it taken before the evidence arrived. */
  const withEvidence = async (final: boolean) => {
    const record = await fresh();
    const stale = approvals.readApproval(record.id);
    once.accumulate(record, { payment: { transaction: `0x${"e9".repeat(32)}`, payer: PAYER } });
    once.accumulate(record, { money_moved: true });
    if (final) approvals.recordFinal(record.id, 5, { ok: false, command: "buy-once", state: "unknown", paid: null });
    return { record, stale, stored: approvals.readApproval(record.id) };
  };

  for (const final of [false, true]) {
    const label = final ? "a final record" : "an open record";

    it(`no write path shrinks the evidence of ${label}: a whole stale record saved over it`, async () => {
      const { record, stale, stored } = await withEvidence(final);
      // a copy from before the evidence (with final set, when the record is final), saved whole
      approvals.saveApproval(final ? { ...stale, final: stored.final, state: "final" } : stale);
      expect(approvals.readApproval(record.id)).toEqual(stored);
    }, 30_000);

    it(`no write path shrinks the evidence of ${label}: a patch with seen: undefined`, async () => {
      const { record, stored } = await withEvidence(final);
      approvals.updateApproval(record.id, () => ({ seen: undefined }));
      expect(approvals.readApproval(record.id)).toEqual(stored);
    }, 30_000);

    it(`a write stays on the record it locked: another record's id in the result cannot overwrite ${label}`, async () => {
      const { record: target, stale, stored } = await withEvidence(final);
      const sourceId = approvals.newApprovalId();
      approvals.saveApproval({ id: sourceId, command: "buy-once", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString() });
      const source = approvals.readApproval(sourceId);
      // a patch that is the target's stale copy, and a change that rewrites the id of the record it was given
      approvals.updateApproval(sourceId, () => ({ ...stale }));
      approvals.updateApproval(sourceId, (now: any) => {
        now.id = target.id;
        return { state: "waiting_owner" };
      });
      expect(approvals.readApproval(target.id)).toEqual(stored);
      expect(approvals.readApproval(sourceId)).toEqual(source);
    }, 30_000);

    it(`no write path shrinks the evidence of ${label}: a change that empties the record it was given`, async () => {
      const { record, stored } = await withEvidence(final);
      approvals.updateApproval(record.id, (now: any) => {
        now.seen.hashes.length = 0;
        now.seen.payers = {};
        now.seen.moved = false;
        return final ? { seen: now.seen } : { state: "waiting_owner" };
      });
      expect(approvals.readApproval(record.id)).toEqual(stored);
    }, 30_000);
  }
});
