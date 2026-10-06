// Buy once, after the owner's step is over: every site state whose payment outcome is not established (uncertain, a
// submission in flight, a failure whose credential may still settle, a settlement the chain has not confirmed, or a
// purchase the site ended with the payment unknown) is `unknown`, exit 5, paid null, on every rail buy-once pays on. It
// is never "waiting for the owner", never "Not approved or paid yet", never "nothing was paid", and `final` says whether a
// later read can still change it. The real code runs against the fake purchase site and its fake chain: in this process
// for the whole table (budget/once.mjs), and as the CLI (budget/cli.mjs) for wait, the next buy-once and the battery repro.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARC_MARKET, PAYER, SOLANA_MARKET, TEMPO_MARKET, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const home = mkdtempSync(join(tmpdir(), "ss-once-uncertain-"));
process.env.SUPERSTABLES_HOME = home;
// the module is plain JavaScript; its inferred types do not describe every result shape, so it is used untyped here
const once: any = await import("../../budget/once.mjs");

let site: FakePurchaseSite;
beforeAll(async () => {
  site = await startFakePurchaseSite();
  site.services.push(structuredClone(TEMPO_MARKET), structuredClone(SOLANA_MARKET), structuredClone(ARC_MARKET));
  process.env.B4_RPC = site.chainUrl;
  process.env.SUPERSTABLES_TEMPO_RPC = site.chainUrl;
  process.env.SUPERSTABLES_SOLANA_RPC = site.chainUrl;
});
afterAll(async () => {
  await site.close();
  rmSync(home, { recursive: true, force: true });
});

const EVM_HASH = `0x${"6d".repeat(32)}`;
const SOL_SIG = `4${"x".repeat(86)}`;
const SOL_PAYER = "So11111111111111111111111111111111111111112";
const RAILS = [
  { rail: "evm", chain: "base-sepolia", service: "demo-market-data", max: "0.01", hash: EVM_HASH, payer: PAYER },
  { rail: "evm", chain: "arc-testnet", service: "demo-market-data-arc", max: "0.01", hash: EVM_HASH, payer: PAYER },
  { rail: "tempo", chain: "moderato", service: "demo-market-data-tempo", max: "0.002", hash: EVM_HASH, payer: PAYER },
  { rail: "solana", chain: "devnet", service: "demo-market-data-solana", max: "0.01", hash: SOL_SIG, payer: SOL_PAYER },
] as const;

type View = Record<string, unknown>;
type Row = { name: string; final: boolean; withHash: boolean; reason: RegExp; view: (id: string, hash: string, payer: string) => View };
const uncertain = (code: string, reason: RegExp, withHash = false): Row => ({
  name: `uncertain, ${code}`,
  final: false,
  withHash,
  reason,
  view: (id, hash, payer) => ({ id, state: "uncertain", final: false, reason_code: code, payment: { status: "unknown", ...(withHash ? { transaction: hash, payer } : {}) }, delivery: { status: "unknown" }, next_action: { type: "wait_for_chain" } }),
});
/** A failure the site has not concluded (a signed credential may still settle), with one documented reason code. */
const failedOpen = (code: string | undefined, reason: RegExp): Row[] => [{
  name: `failed, not final, ${code ?? "no reason code"}`,
  final: false,
  withHash: false,
  reason,
  view: (id) => ({ id, state: "failed", final: false, ...(code ? { reason_code: code } : {}), payment: { status: "unconfirmed" }, delivery: { status: "not_called" }, next_action: { type: "wait_for_chain" } }),
}];

/** Every site state in which the owner's step is over and the payment outcome is not established. */
const ROWS: Row[] = [
  uncertain("wallet_may_have_sent", /^a transfer was prepared for the owner's wallet; the chain does not show it yet, and it could still arrive$/),
  uncertain("submission_interrupted", /^the submission stopped before it finished; whether the payment reached the seller is not known$/),
  uncertain("seller_unreachable", /^the signed credential was sent, but the seller could not be reached$/),
  uncertain("seller_no_receipt", /^the seller answered without a payment receipt$/),
  uncertain("settlement_pending", /^the payment was sent but is not yet confirmed on chain \(transaction /, true),
  uncertain("settlement_not_on_chain", /^the seller named a transaction that does not show this payment \(transaction /, true),

  {
    name: "submitting",
    final: false,
    withHash: false,
    reason: /^the owner signed and the payment is being submitted; payment is not yet confirmed$/,
    view: (id) => ({ id, state: "submitting", final: false, payment: { status: "submitting" }, delivery: { status: "pending" }, next_action: { type: "poll" } }),
  },
  ...failedOpen("seller_refused_payment", /^the seller asked for payment again; the signed credential was sent and can still settle$/),
  ...failedOpen("settlement_failed", /^the seller's facilitator reported that the transfer did not settle; the signed credential was sent and can still settle$/),
  ...failedOpen("authorization_cancelled", /^the authorization was cancelled on chain; \S+ has not concluded$/),
  ...failedOpen("terms_changed", /^the seller changed its terms; \S+ has not concluded$/),
  ...failedOpen(undefined, /^the seller reported no settlement, but a signed credential was sent and can still settle$/),
  // staging: the wallet's transaction is not this payment (Tempo), the seller was never called, and the site has not concluded
  {
    name: "failed, not final, transaction_mismatch",
    final: false,
    withHash: true,
    reason: /^the transaction the owner's wallet sent is not this payment \(transaction \S+\); \S+ has not concluded$/,
    view: (id, hash, payer) => ({ id, state: "failed", final: false, reason_code: "transaction_mismatch", payment: { status: "unknown", transaction: hash, payer }, delivery: { status: "not_called" }, next_action: { type: "wait_for_chain" } }),
  },
  {
    name: "settled, chain not confirmed",
    final: false,
    withHash: true,
    reason: /says paid, but this purchase has no payment identity or payer to verify$/,
    view: (id, hash, payer) => ({ id, state: "settled", final: false, payment: { status: "paid", transaction: hash, payer }, delivery: { status: "delivered", http_status: 200 }, next_action: { type: "wait_for_chain" } }),
  },
  {
    name: "failed, not_settled with payment unknown (the site concluded)",
    final: true,
    withHash: false,
    reason: /found no transfer for it as of its last check, and one could still arrive, so whether it was paid is unknown$/,
    view: (id) => ({ id, state: "failed", final: true, reason_code: "not_settled", payment: { status: "unknown" }, delivery: { status: "not_called" }, next_action: { type: "report_unknown" } }),
  },
];

/** Never in an answer about a purchase whose outcome is not established. */
const FORBIDDEN = [/waiting_owner/, /Not approved or paid yet/i, /nothing was paid/i, /a signed payment was sent/i];
const clean = (text: string, what: string) => {
  for (const f of FORBIDDEN) expect(text, `${what}: ${f}`).not.toMatch(f);
};

// ---- in this process: every row on every rail --------------------------------------------------------------------

let answer: ((id: string) => View) | null = null;
const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const m = /\/api\/v1\/purchases\/([^/?]+)\?/.exec(url);
  if (m && answer && !(init?.method === "POST")) return new Response(JSON.stringify(answer(m[1])), { status: 200, headers: { "content-type": "application/json" } });
  return fetch(input, init);
}) as typeof fetch;

describe("buy once: an outcome that is not established is unknown, on every rail", () => {
  for (const rail of RAILS) {
    for (const row of ROWS) {
      it(`${rail.chain}: ${row.name}`, async () => {
        rmSync(join(home, "budget"), { recursive: true, force: true });
        answer = null;
        const args = { site: site.url, service: rail.service, params: { asset: "BTC" }, max: rail.max, fetchImpl };
        const started = await once.startOnce(args);
        expect(started.ok, JSON.stringify(started)).toBe(true);
        answer = (id) => row.view(id, rail.hash, rail.payer);

        // wait (and buy-once's own wait loop): one read
        const w = await once.waitOnce(started.record, 0, { fetchImpl, unknownGraceMs: 0 });
        expect(w.code).toBe(5);
        expect(w.result).toMatchObject({ state: "unknown", paid: null, amount: null, ...(row.final ? {} : { final: false }), rail: rail.rail, chain: rail.chain });
        expect(Boolean(w.final), "final").toBe(row.final);
        expect(w.result.reason).toMatch(row.reason);
        if (row.withHash) expect(w.result.tx).toEqual({ settle: rail.hash });
        if (!row.final) expect(w.result.next).toMatch(/^do not buy again\. Check again later with superstables budget wait --id \S+ --shown/);
        clean(JSON.stringify(w.result), "wait");

        // the next buy-once: an open one blocks it, as unknown, with no approval link to show again
        const next = await once.startOnce(args);
        if (row.final) {
          // the site concluded: stored as unknown, and it no longer blocks a new purchase
          expect(next.ok).toBe(true);
        } else {
          expect(next.ok).toBe(false);
          expect(next.code).toBe(3);
          expect(next.pendingState).toBe("unknown");
          expect(next.reason).toMatch(/has no final answer yet/);
          clean(`${next.reason} ${next.next}`, "next buy-once");
        }
        answer = null;
      }, 30_000);
    }
  }

  it("the read-on is bounded: slow reads after the outcome turned unknown end within the grace and one short read", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    answer = null;
    const started = await once.startOnce({ site: site.url, service: "demo-market-data", params: { asset: "BTC" }, max: "0.01", fetchImpl });
    let reads = 0;
    // the first read says uncertain at once; every later read hangs for 30 s unless the client gives up on it
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!/\/api\/v1\/purchases\/[^/?]+\?/.test(url) || init?.method === "POST") return fetch(input, init);
      reads++;
      const body = JSON.stringify(ROWS[0].view(started.record.hosted.requestId, EVM_HASH, PAYER));
      if (reads === 1) return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      return new Promise<Response>((done, fail) => {
        const t = setTimeout(() => done(new Response(body, { status: 200, headers: { "content-type": "application/json" } })), 30_000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); fail(new Error("aborted")); });
      });
    }) as typeof fetch;
    const grace = 2_000;
    const t = Date.now();
    const w = await once.waitOnce(started.record, 120_000, { fetchImpl: slow, unknownGraceMs: grace });
    const took = Date.now() - t;
    expect(w).toMatchObject({ final: false, code: 5, result: { state: "unknown", final: false } });
    expect(took).toBeLessThanOrEqual(grace + 1_500);
    expect(reads).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("the deadline covers the chain check: a final answer read in the grace, with an RPC that never answers, is unknown", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    answer = null;
    const started = await once.startOnce({ site: site.url, service: "demo-market-data", params: { asset: "BTC" }, max: "0.01", fetchImpl });
    const id = started.record.hosted.requestId;
    // an RPC that accepts every request and never answers
    const hung = createServer(() => {});
    await new Promise<void>((done) => hung.listen(0, "127.0.0.1", done));
    const rpc = `http://127.0.0.1:${(hung.address() as { port: number }).port}`;
    const before = process.env.B4_RPC;
    process.env.B4_RPC = rpc;
    let reads = 0;
    // the first read is uncertain (the read-on starts); the next is final and says paid, with a transaction to check
    answer = () => (++reads === 1 ? ROWS[0].view(id, EVM_HASH, PAYER) : { id, state: "settled", final: true, payment: { status: "paid", transaction: EVM_HASH, payer: PAYER, authorization: { nonce: `0x${"9a".repeat(32)}` } }, delivery: { status: "delivered", http_status: 200, result: { ok: true } } });
    try {
      const grace = 2_000;
      const t = Date.now();
      const w = await once.waitOnce(started.record, 120_000, { fetchImpl, unknownGraceMs: grace });
      const took = Date.now() - t;
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(took).toBeLessThanOrEqual(grace + 1_500);
      expect(w.result).toMatchObject({ state: "unknown", paid: null, final: false, tx: { settle: EVM_HASH } });
      expect(w.result.reason).toMatch(/deadline/);
      // nothing final was stored: a later read decides again
      expect(JSON.parse(readFileSync(join(home, "budget", "approvals", `${started.record.id}.json`), "utf8")).final).toBeUndefined();
    } finally {
      process.env.B4_RPC = before;
      hung.closeAllConnections();
      hung.close();
      answer = null;
    }
  }, 60_000);

  it("a wait reads on for a short while, then answers unknown rather than waiting for the chain", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    answer = null;
    const started = await once.startOnce({ site: site.url, service: "demo-market-data-tempo", params: { asset: "BTC" }, max: "0.002", fetchImpl });
    answer = (id) => ROWS[0].view(id, EVM_HASH, PAYER);
    const t = Date.now();
    const w = await once.waitOnce(started.record, 60_000, { fetchImpl, unknownGraceMs: 1_500 });
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(w).toMatchObject({ final: false, code: 5, result: { state: "unknown", final: false } });
    answer = null;
  }, 30_000);
});

// ---- the CLI: wait and the next buy-once, every row on Tempo, one row on each other rail, and the battery repro ------------

type Run = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: site.chainUrl, SUPERSTABLES_TEMPO_RPC: site.chainUrl, SUPERSTABLES_SOLANA_RPC: site.chainUrl };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const buyOnce = (rail: (typeof RAILS)[number]) => budget(["buy-once", "--site", site.url, "--service", rail.service, "--param", "asset=BTC", "--max", rail.max]);

describe("buy once, as the CLI: wait and the next buy-once never say waiting for the owner", () => {
  const tempo = RAILS[2];
  const cases: [(typeof RAILS)[number], Row][] = [...ROWS.map((row) => [tempo, row] as [(typeof RAILS)[number], Row]), [RAILS[0], ROWS[0]], [RAILS[1], ROWS[4]], [RAILS[3], ROWS.find((r) => r.name.startsWith("settled"))!]];
  for (const [rail, row] of cases) {
    it(`${rail.chain}: ${row.name}`, async () => {
      rmSync(join(home, "budget"), { recursive: true, force: true });
      site.readAnswer = undefined;
      const first = await buyOnce(rail);
      expect(first.code, first.stderr).toBe(0);
      site.readAnswer = (p) => ({ status: 200, body: row.view(p.id, rail.hash, rail.payer) });
      const w = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
      expect(w.code, w.stderr).toBe(5);
      expect(w.result).toMatchObject({ state: "unknown", paid: null, complete: row.final, final: false });
      expect(w.result.reason).toMatch(row.reason);
      clean(w.stdout + w.stderr, "wait");
      const next = await buyOnce(rail);
      if (row.final) {
        expect(next.code, next.stderr).toBe(0);
      } else {
        expect(next.code).toBe(3);
        expect(next.result).toMatchObject({ state: "refused_pending", paid: null, pending: { id: first.result.id, state: "unknown" } });
        expect(next.result.pending.url).toBeUndefined();
        clean(JSON.stringify(next.result), "next buy-once");
      }
      site.readAnswer = undefined;
    }, 60_000);
  }

  it("the owner's finished step is kept across an outage and a regressed answer: unknown, never waiting for the owner", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    site.readAnswer = undefined;
    const base = RAILS[0];
    const first = await buyOnce(base);
    expect(first.code, first.stderr).toBe(0);
    // the owner signed: the site says submitting
    site.readAnswer = (p) => ({ status: 200, body: { id: p.id, state: "submitting", final: false, payment: { status: "submitting" }, delivery: { status: "pending" } } });
    const a = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
    expect(a.code, a.stderr).toBe(5);
    // then the site cannot be read, and then it answers as if the owner had not started
    for (const [what, reply] of [
      ["503", () => ({ status: 503, body: { error: { code: "internal_error", message: "x" } } })],
      ["awaiting_approval again", (p: any) => ({ status: 200, body: { id: p.id, state: "awaiting_approval", final: false, payment: { status: "awaiting_approval" }, delivery: { status: "pending" } } })],
    ] as const) {
      site.readAnswer = reply as any;
      const w = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0"]);
      expect(w.code, what).toBe(5);
      expect(w.result, what).toMatchObject({ state: "unknown", final: false, paid: null });
      expect(w.result.reason, what).toMatch(/an earlier answer for this purchase showed that the purchase was no longer awaiting approval$/);
      clean(w.stdout + w.stderr, what);
      const next = await buyOnce(base);
      expect(next.code, what).toBe(3);
      expect(next.result, what).toMatchObject({ state: "refused_pending", pending: { id: first.result.id, state: "unknown" } });
      expect(next.result.pending.url, what).toBeUndefined();
      clean(JSON.stringify(next.result), what);
    }
    site.readAnswer = undefined;
  }, 60_000);

  it("the battery repro: a Tempo purchase at approval expiry, the wallet call handed out and nothing on chain", async () => {
    rmSync(join(home, "budget"), { recursive: true, force: true });
    site.readAnswer = undefined;
    const first = await buyOnce(tempo);
    expect(first.code, first.stderr).toBe(0);
    // the site's answer, saved from staging, word for word
    const saved = JSON.parse(readFileSync(join(ROOT, "test/budget/fixtures/tempo-wallet-may-have-sent.json"), "utf8"));
    site.readAnswer = () => ({ status: 200, body: saved });
    const w = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "2"]);
    expect(w.code, w.stderr).toBe(5);
    expect(w.result).toMatchObject({ command: "buy-once", rail: "tempo", chain: "moderato", state: "unknown", final: false, paid: null, delivered: null, amount: null, tx: {} });
    expect(w.result.reason).toBe("a transfer was prepared for the owner's wallet; the chain does not show it yet, and it could still arrive");
    expect(w.result.next).toBe(`do not buy again. Check again later with superstables budget wait --id ${first.result.id} --shown. Tell the owner the payment outcome is not known yet`);
    clean(w.stdout + w.stderr, "battery repro");
    site.readAnswer = undefined;
  }, 120_000);
});
