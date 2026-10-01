// The payment engine, end to end, against a local seller, a local facilitator and a local
// wallet. Every ending the state machine can reach is exercised here, because the endings
// are the product: a settled payment with a receipt, a refusal that signed nothing, and the
// two awkward cases — the service failed after being paid, and we cannot tell what happened.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy.js";
import { PaymentEngine, QuoteUsedError } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import { quote } from "../../src/core/quote.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import type { Attempt } from "../../src/core/types.js";
import {
  startFacilitator,
  startPaidEndpoint,
  startWallet,
  type FakeFacilitator,
  type FakeWallet,
  type PaidEndpoint,
  type TestServer,
} from "../helpers/servers.js";

const open: TestServer[] = [];

interface Stack {
  facilitator: FakeFacilitator;
  seller: PaidEndpoint;
  wallet: FakeWallet;
  records: Records;
  engine: PaymentEngine;
  url: string;
  transitions: Attempt[];
}

async function stack(options: { walletUrl?: string; policy?: Partial<Policy> } = {}): Promise<Stack> {
  const facilitator = await startFacilitator();
  const seller = await startPaidEndpoint(facilitator.url);
  const wallet = await startWallet();
  open.push(facilitator, seller, wallet);

  const records = new Records(mkdtempSync(join(tmpdir(), "superstables-pay-")));
  const engine = new PaymentEngine({
    records,
    policy: { ...DEFAULT_POLICY, ...options.policy },
    signer: new WalletSigner({
      url: options.walletUrl ?? wallet.url,
      agentToken: wallet.token,
      pollMs: 5,
      timeoutMs: 3_000,
    }),
  });
  const transitions: Attempt[] = [];
  engine.events.on("transition", (attempt: Attempt) => transitions.push({ ...attempt }));

  return { facilitator, seller, wallet, records, engine, url: `${seller.url}/v1/market?asset=BTC`, transitions };
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("PaymentEngine", () => {
  it("pays, records a receipt and spends the quote", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const started = s.engine.startPayment(q.id);
    expect(started.state).toBe("awaiting_approval");
    expect(started.quoteId).toBe(q.id);

    const final = await s.engine.waitForAttempt(started.id, 10_000);
    expect(final.state).toBe("settled");
    expect(final.reason).toBeUndefined();
    expect(final.payer).toBe(s.wallet.address);
    expect(final.transaction).toBe(s.facilitator.transaction);
    expect(final.transactionUrl).toBe(`https://sepolia.basescan.org/tx/${s.facilitator.transaction}`);
    expect(final.serviceStatus).toBe(200);
    expect(JSON.parse(final.serviceBody ?? "{}")).toMatchObject({ asset: "BTC" });

    // The facilitator was asked once to check and once to move the money.
    expect(s.facilitator.calls).toEqual({ verify: 1, settle: 1 });

    const receipt = s.engine.getReceipt(final.receiptId ?? "");
    expect(receipt).toMatchObject({
      attemptId: final.id,
      quoteId: q.id,
      payer: s.wallet.address,
      transaction: s.facilitator.transaction,
      transactionKind: "hash",
      network: "eip155:84532",
      serviceOutcome: "ok",
      serviceStatus: 200,
    });
    expect(receipt?.settlement).toMatchObject({ success: true, network: "eip155:84532" });
    expect(receipt?.terms.amountDecimal).toBe(0.01);
    expect(receipt?.ms).toBeGreaterThanOrEqual(0);
    expect(s.records.spentToday("USDC")).toBe(0.01);

    // The quote is spent, and the whole path is in the attempt's history.
    expect(s.records.getQuote(q.id)?.status).toBe("used");
    expect(final.history.map((h) => h.state)).toEqual([
      "awaiting_approval",
      "awaiting_approval",
      "approved",
      "submitting",
      "settled",
    ]);
    expect(final.history[1].note).toContain("waiting for the owner");
    expect(final.walletRequestId).toBeTruthy();
    expect(s.transitions.at(-1)?.state).toBe("settled");
  });

  it("signs nothing and pays nothing when the owner denies", async () => {
    const s = await stack();
    s.wallet.setMode("deny");
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("denied");
    expect(final.reason).toBe("denied by the owner in the wallet");
    expect(final.receiptId).toBeUndefined();
    expect(s.engine.listReceipts()).toHaveLength(0);
    // The seller was never shown a credential, so no money was ever asked for.
    expect(s.facilitator.calls).toEqual({ verify: 0, settle: 0 });
  });

  it("reports the wallet's own refusal without bothering the seller", async () => {
    const s = await stack();
    s.wallet.setMode("policy-refusal");
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("failed");
    expect(final.reason).toContain("caps.per_call");
    expect(s.facilitator.calls.settle).toBe(0);
  });

  it("refuses to pay when the seller changed its price after the quote", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    s.seller.options.price = 0.02;

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("failed");
    expect(final.reason).toBe("terms changed, quote again");
    expect(s.records.getQuote(q.id)?.status).toBe("stale");
    expect(s.facilitator.calls).toEqual({ verify: 0, settle: 0 });
    expect(s.engine.listReceipts()).toHaveLength(0);
  });

  it("refuses a second attempt on a quote that has already been used", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const first = s.engine.startPayment(q.id);
    expect(() => s.engine.startPayment(q.id)).toThrow(`A payment for this quote already exists: attempt ${first.id}`);
    await s.engine.waitForAttempt(first.id, 10_000);
    let refused: unknown;
    try {
      s.engine.startPayment(q.id);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(QuoteUsedError);
    expect((refused as QuoteUsedError).attempt?.id).toBe(first.id);
    expect((refused as QuoteUsedError).attempt?.state).toBe(s.engine.getAttempt(first.id)?.state);
    expect((refused as Error).message).not.toContain("(not final)");
    expect(s.engine.listAttempts()).toHaveLength(1);
  });

  it("keeps the receipt when the money moved and the service then failed", async () => {
    const s = await stack();
    s.seller.options.failAfterPaying = true;
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("paid_service_failed");
    expect(final.serviceStatus).toBe(500);
    expect(final.reason).toContain("the payment settled but the service answered 500");
    const receipt = s.engine.getReceipt(final.receiptId ?? "");
    expect(receipt?.serviceOutcome).toBe("failed");
    expect(receipt?.settlement.success).toBe(true);
    // Paid is paid: it counts against the daily cap even though the answer was useless.
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("ends uncertain when the service answers without saying what happened to the payment", async () => {
    const s = await stack();
    s.seller.options.omitPaymentResponse = true;
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("uncertain");
    expect(final.reason).toContain("without a payment receipt");
    expect(final.serviceStatus).toBe(200);
    // Nothing is claimed that is not known: no receipt, and nothing counted as spent.
    expect(final.receiptId).toBeUndefined();
    expect(s.engine.listReceipts()).toHaveLength(0);
    expect(s.records.spentToday("USDC")).toBe(0);
  });

  it("says the wallet is not running rather than failing obscurely", async () => {
    const s = await stack({ walletUrl: "http://127.0.0.1:1" });
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);

    expect(final.state).toBe("failed");
    expect(final.refusal).toBe("unavailable");
    expect(final.reason).toBe(
      "the wallet is not running or the agent token is wrong; start it with `superstables wallet serve`. " +
        `Nothing was signed, and quote ${q.id} can still be paid`,
    );
    expect(s.facilitator.calls).toEqual({ verify: 0, settle: 0 });
    // The owner was never asked, so the quote was handed back: it starts a new attempt.
    expect(s.records.getQuote(q.id)?.status).toBe("open");
    expect(() => s.engine.startPayment(q.id)).not.toThrow();
  });

  it("stops before the wallet when the local policy already said no", async () => {
    const s = await stack({ policy: { perCall: { amount: 0.001, asset: "USDC" } } });
    const q = await quote(
      { url: s.url },
      { records: s.records, policy: { ...DEFAULT_POLICY, perCall: { amount: 0.001, asset: "USDC" } } },
    );
    expect(q.policy.allowed).toBe(false);

    const final = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);
    expect(final.state).toBe("failed");
    expect(final.reason).toContain("the local spend policy refuses this payment");
  });

  it("will not start a payment for a quote it does not have", async () => {
    const s = await stack();
    expect(() => s.engine.startPayment("no-such-quote")).toThrow(/no quote no-such-quote/i);
  });

  it("returns the attempt as it stands when the wait times out", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    const started = s.engine.startPayment(q.id);
    const early = await s.engine.waitForAttempt(started.id, 1);
    expect(early.id).toBe(started.id);
    await s.engine.waitForAttempt(started.id, 10_000);
  });
});
