// buy-once: a purchase counts as paid only for the payment the site first showed for it (payer, authorization nonce and,
// on EVM chains, the order the nonce commits to), and the site's word alone never makes a signed purchase "not paid".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { ARC_MARKET, MARKET, PAYER, ROBINHOOD_MARKET, SELLER, SOLANA_MARKET, SOLANA_PAYER, TEMPO_MARKET, orderOf, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

process.env.SUPERSTABLES_HOME = mkdtempSync(join(tmpdir(), "ss-binding-"));
const { settleOnce, signedOnly, siteWord, startOnce } = await import("../../budget/once.mjs");
const approvals = await import("../../budget/approvals.mjs");
const home = process.env.SUPERSTABLES_HOME;
let site: FakePurchaseSite;

const rails = [
  { name: "base", rail: "evm", chain: "base-sepolia", service: MARKET, payer: PAYER, tx: `0x${"a1".repeat(32)}` },
  { name: "arc", rail: "evm", chain: "arc-testnet", service: ARC_MARKET, payer: PAYER, tx: `0x${"a2".repeat(32)}` },
  { name: "robinhood", rail: "evm", chain: "robinhood-testnet", service: ROBINHOOD_MARKET, payer: PAYER, tx: `0x${"a3".repeat(32)}` },
  { name: "tempo", rail: "tempo", chain: "moderato", service: TEMPO_MARKET, payer: PAYER, tx: `0x${"a4".repeat(32)}` },
  { name: "solana", rail: "solana", chain: "devnet", service: SOLANA_MARKET, payer: SOLANA_PAYER, tx: "5".repeat(87) },
];
const BASE = rails[0];
const SOLANA = rails[4];
const TEMPO = rails[3];
const OTHER_PAYER = "0x4444444444444444444444444444444444444444";

beforeEach(async () => {
  rmSync(join(home, "budget"), { recursive: true, force: true });
  site = await startFakePurchaseSite();
  site.finalizedBlock = 1000;
  site.finalizedSlot = 1000;
  site.services.push(ARC_MARKET, ROBINHOOD_MARKET, TEMPO_MARKET, SOLANA_MARKET);
  for (const key of ["B4_RPC", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) process.env[key] = site.chainUrl;
});
afterEach(async () => { await site.close(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function purchase(rail: (typeof rails)[number]) {
  const response = await fetch(`${site.url}/api/v1/purchases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: rail.service.id, params: { asset: "BTC" }, max_amount: "0.01" }) });
  expect(response.status).toBe(201);
  const p = site.purchases[site.purchases.length - 1];
  const record = { id: approvals.newApprovalId(), command: "buy-once", rail: rail.rail, chain: rail.chain, createdAt: new Date().toISOString(), state: "waiting_owner", attributionVersion: 2, service: { id: rail.service.id }, hosted: { kind: "purchase", site: site.url, requestId: p.id, token: p.token, amount: p.service.amount, payTo: p.service.payTo ?? SELLER } };
  approvals.saveApproval(record);
  return { p, record };
}
/** The order of this purchase with its terms changed, and the nonce that commits to it. */
function commit(p: any, order: string) {
  p.order = order;
  p.nonce = keccak256(toBytes(order));
}
const unknown = (s: any, words?: RegExp) => {
  expect(s).toMatchObject({ code: 5, result: { state: "unknown", paid: null } });
  expect(JSON.stringify(s)).not.toMatch(/nothing was paid/);
  if (words) expect(s.result.reason).toMatch(words);
};

describe("EVM: the nonce must commit to this purchase", () => {
  it("B1: an order that names another purchase is unknown", async () => {
    const { p, record } = await purchase(BASE);
    commit(p, orderOf({ id: "11111111-2222-3333-4444-555555555555", service: MARKET }));
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    unknown(await settleOnce(record), /commits to purchase 11111111-2222-3333-4444-555555555555/);
  });

  for (const [name, change] of [
    ["another amount", (o: any) => { o.pay.amount = "20000"; }],
    ["another recipient", (o: any) => { o.pay.to = "0x7777777777777777777777777777777777777777"; }],
    ["another network", (o: any) => { o.pay.network = "eip155:5042002"; }],
    ["another service", (o: any) => { o.service = "something-else"; }],
  ] as const) {
    it(`B2: an order with ${name}, hashing correctly, is unknown`, async () => {
      const { p, record } = await purchase(BASE);
      const o = JSON.parse(orderOf(p));
      change(o);
      commit(p, JSON.stringify(o));
      site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
      unknown(await settleOnce(record), /names other terms/);
    });
  }

  it("B3: an order with a repeated key, the later one naming this purchase, is not canonical and unknown", async () => {
    const { p, record } = await purchase(BASE);
    const text = orderOf(p).replace(`"purchase":"${p.id}"`, `"purchase":"11111111-2222-3333-4444-555555555555","purchase":"${p.id}"`);
    expect(JSON.parse(text).purchase).toBe(p.id);
    commit(p, text);
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    unknown(await settleOnce(record), /not in its canonical form/);
  });

  it("B3b: an order with other fields than superstables-order/1 is unknown", async () => {
    const { p, record } = await purchase(BASE);
    commit(p, JSON.stringify({ ...JSON.parse(orderOf(p)), extra: 1 }));
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    unknown(await settleOnce(record), /other fields/);
  });

  it("B4: an order that does not hash to the nonce is unknown", async () => {
    const { p, record } = await purchase(BASE);
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    p.nonce = `0x${"12".repeat(32)}`;
    p.order = orderOf(p);
    // the chain shows the nonce the site gives, so only the order check can tell
    site.pay(p, { transaction: BASE.tx, payer: BASE.payer });
    unknown(await settleOnce(record), /does not hash/);
  });

  it("B6: no order yet is unknown and not final; once it appears, the purchase is paid", async () => {
    const { p, record } = await purchase(BASE);
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    const order = p.order;
    p.order = undefined;
    const first = await settleOnce(record);
    expect(first).toMatchObject({ code: 5, result: { state: "unknown", final: false } });
    expect(first.result.reason).toMatch(/shows no order/);
    expect(approvals.readApproval(record.id).final).toBeUndefined();
    p.order = order;
    expect(await settleOnce(approvals.readApproval(record.id))).toMatchObject({ code: 0, result: { paid: true } });
  });
});

describe("the payer is fixed by the first answer that shows one", () => {
  it("B5: EVM, a settled answer naming another payer than the first is unknown", async () => {
    const { p, record } = await purchase(BASE);
    commit(p, orderOf(p));
    Object.assign(p, { state: "submitting", payment: { status: "submitting", payer: OTHER_PAYER } });
    await settleOnce(record);
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    unknown(await settleOnce(approvals.readApproval(record.id)));
  });

  it("B5s: Solana, a settled answer naming another payer than the first is unknown", async () => {
    const { p, record } = await purchase(SOLANA);
    Object.assign(p, { state: "submitting", payment: { status: "submitting", payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } });
    await settleOnce(record);
    site.settle(p, "ok", { transaction: SOLANA.tx, payer: SOLANA.payer });
    unknown(await settleOnce(approvals.readApproval(record.id)));
  });

  it("B5t: Tempo, a settled answer naming another payer than the first is unknown", async () => {
    const { p, record } = await purchase(TEMPO);
    Object.assign(p, { state: "submitting", payment: { status: "submitting", payer: OTHER_PAYER } });
    await settleOnce(record);
    site.settle(p, "ok", { transaction: TEMPO.tx, payer: TEMPO.payer });
    unknown(await settleOnce(approvals.readApproval(record.id)));
  });
});

describe("signed means not 'not paid'", () => {
  for (const [name, patch] of [
    ["not_paid", { state: "failed", reason_code: "not_settled", payment: { status: "not_paid", payer: PAYER } }],
    ["denied", { state: "denied", reason_code: "owner_rejected", payment: { status: "not_paid", payer: PAYER } }],
  ] as const) {
    it(`B7: a final ${name} answer that shows a payer is unknown, and the record holds what an agreed check needs`, async () => {
      const { p, record } = await purchase(BASE);
      commit(p, orderOf(p));
      Object.assign(p, { final: true, delivery: { status: "not_called" }, ...patch });
      const s = await settleOnce(record);
      unknown(s, /does not take the site's word alone/);
      const stored = approvals.readApproval(record.id);
      expect(signedOnly(stored.seen)).toBe(true);
      expect(stored.seen).toMatchObject({ payer: PAYER.toLowerCase(), nonce: p.nonce, order: p.order });
      expect(typeof stored.seen.validBefore).toBe("number");
    });
  }

  it("B7n: a final not_paid answer with no payer is still not paid", async () => {
    const { p, record } = await purchase(BASE);
    Object.assign(p, { state: "denied", final: true, reason_code: "owner_rejected", payment: { status: "not_paid" }, delivery: { status: "not_called" } });
    expect(await settleOnce(record)).toMatchObject({ result: { paid: false } });
  });

  it("signedOnly is false once a transaction, a paid state or moved money is seen", () => {
    expect(signedOnly({ payer: PAYER })).toBe(true);
    expect(signedOnly({ payer: PAYER, hashes: ["0x1"] })).toBe(false);
    expect(signedOnly({ payer: PAYER, paid: true })).toBe(false);
    expect(signedOnly({ payer: PAYER, moved: true })).toBe(false);
    expect(signedOnly({ payer: null })).toBe(false);
    expect(signedOnly({})).toBe(false);
  });
});

describe("genuine purchases and records", () => {
  for (const rail of rails) {
    it(`B8: ${rail.name}: a genuine purchase is paid, and the final record keeps its attribution`, async () => {
      const { p, record } = await purchase(rail);
      site.settle(p, "ok", { transaction: rail.tx, payer: rail.payer });
      expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
      const stored = approvals.readApproval(record.id);
      expect(stored.attributionVersion).toBe(2);
      const evm = rail.rail === "evm";
      expect(stored.final.attribution).toMatchObject({ nonce: p.nonce, payer: rail.rail === "solana" ? rail.payer : rail.payer.toLowerCase(), ...(evm ? { order: p.order } : {}) });
      if (!evm) expect(stored.final.attribution.order).toBeUndefined();
    });
  }

  it("B9: a version 1 final paid record is still paid; a version 1 open record gets the order rule from its next read", async () => {
    const final = await purchase(BASE);
    commit(final.p, orderOf(final.p));
    site.settle(final.p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    expect(await settleOnce(final.record)).toMatchObject({ code: 0, result: { paid: true } });
    // written as before: attribution has the nonce only, version 1
    approvals.updateApproval(final.record.id, (now: any) => ({ attributionVersion: 1, final: { ...now.final, attribution: { nonce: final.p.nonce } } }));
    expect(await settleOnce(approvals.readApproval(final.record.id))).toMatchObject({ code: 0, result: { paid: true } });

    const open = await purchase(BASE);
    approvals.updateApproval(open.record.id, () => ({ attributionVersion: 1 }));
    commit(open.p, orderOf({ id: "11111111-2222-3333-4444-555555555555", service: MARKET }));
    site.settle(open.p, "ok", { transaction: `0x${"b1".repeat(32)}`, payer: BASE.payer });
    unknown(await settleOnce(approvals.readApproval(open.record.id)));
  });

  it("B9b: a version 2 final paid record whose seen order is edited afterwards is read as unknown", async () => {
    const { p, record } = await purchase(BASE);
    site.settle(p, "ok", { transaction: BASE.tx, payer: BASE.payer });
    expect(await settleOnce(record)).toMatchObject({ code: 0, result: { paid: true } });
    approvals.updateApproval(record.id, (now: any) => ({ seen: { ...now.seen, order: orderOf({ id: "11111111-2222-3333-4444-555555555555", service: MARKET }) } }));
    const again = await settleOnce(approvals.readApproval(record.id));
    expect(again.result.paid).not.toBe(true);
  });
});

describe("words", () => {
  it("B11: the purchase API's documented codes are named, not 'unexpected'", () => {
    for (const code of ["body_too_large", "idempotency_conflict", "invalid_replay_secret", "invalid_request", "missing_token", "payment_outcome_unknown", "replay_secret_required", "unknown_parameter", "unsupported_media_type"]) {
      expect(siteWord("error", code)).toBe(code);
    }
    expect(siteWord("error", "invented")).toBe("unexpected");
  });
});

describe("replay secret", () => {
  /** Every creation request the client makes, as sent; the first attempt of each run is lost on the way. */
  async function run(requests: { key: string; secret: string }[]) {
    let dropped = false;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (init.method === "POST" && String(url).endsWith("/api/v1/purchases")) {
        const h = init.headers as Record<string, string>;
        requests.push({ key: h["idempotency-key"], secret: h["superstables-replay-secret"] });
        // the site answers, and the answer is lost on the way back
        const res = await fetch(url, init);
        if (!dropped) { dropped = true; throw new Error("connection lost after the site answered"); }
        return res;
      }
      return fetch(url, init);
    }) as typeof fetch;
    return startOnce({ site: site.url, service: "demo-market-data", params: { asset: "BTC" }, max: "0.01", fetchImpl });
  }

  it("B10: the same secret on every attempt of one run, 32 random bytes in hex, and a new one for the next run", async () => {
    const a: { key: string; secret: string }[] = [];
    const first = await run(a);
    expect(first.ok).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a[0].secret).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(a.map((r) => r.secret)).size).toBe(1);
    expect(new Set(a.map((r) => r.key)).size).toBe(1);
    // the site took the retry as the same purchase, because the secret matched
    expect(site.purchases).toHaveLength(1);
    expect(site.purchases[0].secret).toBe(a[0].secret);
    // finish the first so the next can start
    site.settle(site.purchases[0], "ok", { transaction: BASE.tx, payer: BASE.payer });
    await settleOnce(approvals.readApproval((first as any).record.id));
    const b: { key: string; secret: string }[] = [];
    const second = await run(b);
    expect(second.ok).toBe(true);
    expect(b[0].secret).toMatch(/^[0-9a-f]{64}$/);
    expect(b[0].secret).not.toBe(a[0].secret);
  });

  it("B10b: a site that requires the secret on a repeated key still returns the same purchase to this client's retry", async () => {
    site.replaySecretRequired = true;
    const a: { key: string; secret: string }[] = [];
    const started = await run(a);
    expect(started.ok).toBe(true);
    expect(site.purchases).toHaveLength(1);
  });

  it("B11: a creation refused with replay_secret_required or unknown_parameter names the code", async () => {
    for (const [status, code] of [[409, "replay_secret_required"], [400, "unknown_parameter"], [400, "invalid_replay_secret"]] as const) {
      site.refuseCreate = { status, error: { code, message: "x" } };
      const r = await startOnce({ site: site.url, service: "demo-market-data", params: { asset: "BTC" }, max: "0.01" });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(code);
      expect(r.reason).not.toContain("unexpected");
    }
  });
});
