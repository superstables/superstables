// A whole Single purchase on Solana devnet: quote a seller's exact SVM offer, the owner approves on the page (a wallet
// that signs with a real ed25519 key), the client sends the signed transaction to the seller once, the seller's
// facilitator lands it, and the chain is read for it. Then the endings that are not "settled": the answer that never
// came (uncertain, and found later by the owner's signature), a seller that names someone else's transaction, and a
// payment that never landed. One quote, one attempt, one payment.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_DEVNET } from "../../src/core/chain.js";
import { PaymentEngine, QuoteUsedError, recheckChain, shownAttempt, shownReceipt } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { buildPayment } from "../../src/core/rails/solana-transaction.js";
import { Records } from "../../src/core/records.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SellerTextError } from "../../src/core/text.js";
import type { Attempt } from "../../src/core/types.js";
import { attemptView, messageFor } from "../../src/mcp/server.js";
import { withFileLock } from "../../src/core/lock.js";
import type { SignResult, Signer } from "../../src/core/signer/types.js";
import { MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet, startSolanaSeller, type FakeSolanaDevnet, type SolanaSeller, type SolanaSellerBehaviour } from "../helpers/fake-solana-pay.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";

/** A pid no process has: a runner that is gone. */
const GONE = { pid: 2 ** 30 + 7, start: "linux:gone:1" };

const RPC_ENV = "SUPERSTABLES_SOLANA_RPC";
const savedRpc = process.env[RPC_ENV];
const owner = solanaKey();
let home: string;
let chain: FakeSolanaDevnet;
const open: { close(): Promise<void> }[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-pay-solana-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  chain = await startFakeDevnet();
  process.env[RPC_ENV] = chain.url;
  // The owner's token account was funded minutes before any payment here: the oldest transaction a search reaches.
  const funding = buildPayment({ owner: owner.address, recipient: randomAddress(), mint: MINT, decimals: 6, amountAtomic: "1", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
  chain.land(signAsOwner(funding.transaction, owner));
  chain.height += 400;
});
afterEach(async () => {
  process.env[RPC_ENV] = savedRpc;
  while (open.length) await open.pop()!.close();
  await chain.close();
});

async function stack(behaviour: SolanaSellerBehaviour = "ok") {
  const seller = await startSolanaSeller(chain, { behaviour });
  const dir = mkdtempSync(join(home, "run-"));
  const records = new Records(join(dir, "records"));
  const signer = new BrowserWalletSigner({ port: 0, home: dir, policy: DEFAULT_POLICY, timeoutMs: 20_000, balance: false });
  open.push(seller, signer);
  const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url, timeoutMs: 5_000 });
  return { seller, records, signer, engine };
}

/** The first approval link the engine records. */
function linkOf(engine: PaymentEngine): Promise<string> {
  return new Promise((resolve) => {
    const on = (attempt: Attempt) => {
      if (!attempt.approvalUrl) return;
      engine.events.off("transition", on);
      resolve(attempt.approvalUrl);
    };
    engine.events.on("transition", on);
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** What the page and Phantom do: connect, take the built transaction, sign it, give it back. */
async function approveOnPage(link: string): Promise<void> {
  expect((await post(`${link}/account`, { address: owner.address })).status).toBe(200);
  const built = await post(`${link}/prepare`, { address: owner.address });
  expect(built.status, JSON.stringify(built.body)).toBe(200);
  const signed = await post(`${link}/signed`, { address: owner.address, signedTransaction: signAsOwner(built.body.transaction as string, owner) });
  expect(signed.status, JSON.stringify(signed.body)).toBe(200);
}

async function pay(s: Awaited<ReturnType<typeof stack>>): Promise<Attempt> {
  const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
  const link = linkOf(s.engine);
  const started = s.engine.startPayment(taken.id);
  await approveOnPage(await link);
  return s.engine.waitForAttempt(started.id, 15_000);
}

describe("a Single purchase on Solana devnet", () => {
  it("settles: the owner signs once, the seller's facilitator lands it, and the chain shows this payment", async () => {
    const s = await stack();
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    expect(taken.terms).toMatchObject({ amountDecimal: 0.01, asset: "USDC", assetAddress: MINT, network: SOLANA_DEVNET.caip2, recipient: s.seller.payTo, x402Version: 2 });
    expect(taken.policy.allowed).toBe(true);

    const link = linkOf(s.engine);
    const started = s.engine.startPayment(taken.id);
    await approveOnPage(await link);
    const final = await s.engine.waitForAttempt(started.id, 15_000);

    expect(final.state, final.reason).toBe("settled");
    expect(final.payer).toBe(owner.address);
    expect(final.transaction).toBe(s.seller.landed);
    expect(final.transactionUrl).toBe(`https://explorer.solana.com/tx/${s.seller.landed}?cluster=devnet`);
    expect(final.chain).toBe("verified");
    expect(final.ownerSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    expect(final.lastValidBlockHeight).toBeGreaterThan(0);
    expect(final.history.map((h) => h.state)).toEqual(["awaiting_approval", "awaiting_approval", "approved", "submitting", "settled"]);
    expect(s.seller.hits.paid).toBe(1);

    // the seller got the offer as it made it, the 402's resource, and the transaction the owner signed
    expect(s.seller.lastPayment).toMatchObject({ x402Version: 2, accepted: s.seller.accept, resource: { url: s.seller.resource, description: "test Solana service" } });
    // the landed transaction carries the owner's signature: what ties it to this attempt
    expect(chain.txs.get(s.seller.landed!)!.transaction.signatures).toContain(final.ownerSignature);

    const receipt = s.records.getReceipt(final.receiptId!)!;
    expect(receipt).toMatchObject({ transaction: s.seller.landed, transactionKind: "hash", payer: owner.address, network: SOLANA_DEVNET.caip2, chain: "verified", serviceOutcome: "ok" });
    expect(shownReceipt(receipt)).toMatchObject({ transaction: s.seller.landed, payer: owner.address, transactionUrl: final.transactionUrl, settlement: { payer: owner.address } });
    expect(shownAttempt(final)).toMatchObject({ transaction: s.seller.landed, payer: owner.address });
    expect(shownAttempt(final)).not.toHaveProperty("untrusted_seller_data.payer");
    expect(s.records.spentToday("USDC")).toBe(0.01);
    // what an agent is told: the base58 payer and signature, with the devnet explorer link
    const view = attemptView({ records: s.records }, final) as { receipt: Record<string, unknown>; message: string };
    expect(view.receipt).toMatchObject({ payer: owner.address, transaction: s.seller.landed, transaction_url: final.transactionUrl, chain: "verified", network_label: "Solana devnet (testnet)" });
    expect(view.message).toContain(`transaction ${s.seller.landed}`);
    // the browser signer remembers the Solana account for this chain
    expect(await s.signer.address(SOLANA_DEVNET.caip2)).toBe(owner.address);

    // one quote, one payment
    expect(() => s.engine.startPayment(taken.id)).toThrow(QuoteUsedError);
  });

  it("tells the agent to sign in a Solana wallet while it waits", () => {
    const attempt = {
      id: "a", quoteId: "q", state: "awaiting_approval", approvalUrl: "http://127.0.0.1:1/approve/x", history: [],
      terms: { amountDecimal: 0.01, amountAtomic: "10000", asset: "USDC", assetAddress: MINT, network: SOLANA_DEVNET.caip2, networkLabel: SOLANA_DEVNET.label, recipient: randomAddress(), scheme: "exact" },
    } as unknown as Attempt;
    expect(messageFor(attempt)).toContain("Open this approval link to review and sign in a Solana wallet such as Phantom: http://127.0.0.1:1/approve/x.");
    expect(messageFor({ ...attempt, terms: { ...attempt.terms, network: "eip155:84532" } })).toContain("sign in MetaMask");
  });

  it("reads only x402 versions 1 and 2 off the wire, and never takes another for version 2", async () => {
    const s = await stack();
    for (const version of [3, 0, "2", null]) {
      s.seller.version = version;
      await expect(quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY }), String(version)).rejects.toThrow(
        `The 402 response offers no payment this client reads: the x402 challenge is version ${JSON.stringify(version)}, and this client reads versions 1 and 2 only`,
      );
    }
    delete s.seller.version;
    await expect(quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY })).rejects.toThrow(/the x402 challenge names no version/);
    // Version 1 is read, and refused on Solana: the v1 wire is EVM only.
    s.seller.version = 1;
    await expect(quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY })).rejects.toSatisfy(
      (err: unknown) => err instanceof SellerTextError && /x402 version 1 is not supported on Solana devnet/.test(String((err as SellerTextError & { detail?: string }).detail)),
    );
    // A seller that switches to version 3 between the quote and the payment: nothing is signed.
    s.seller.version = 2;
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    s.seller.version = 3;
    const final = await s.engine.waitForAttempt(s.engine.startPayment(taken.id).id, 10_000);
    expect(final.state).toBe("failed");
    expect(final.reason).toMatch(/version 3/);
    expect(final.approvalUrl).toBeUndefined();
    expect(s.seller.hits.paid).toBe(0);
  });

  it("never hands two approvals the same transaction, and never sends one an earlier payment's owner already signed", async () => {
    const s = await stack();
    // The seller fixes the memo; devnet (here) answers the same blockhash every time: same terms, same message.
    s.seller.accept.extra = { feePayer: s.seller.feePayer, memo: "order-42" };
    const first = await pay(s);
    expect(first.state).toBe("settled");
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(s.engine);
    const second = s.engine.startPayment(taken.id);
    const url = await link;
    expect((await post(`${url}/account`, { address: owner.address })).status).toBe(200);
    const built = await post(`${url}/prepare`, { address: owner.address });
    expect(built.status).toBe(503);
    expect(String(built.body.error)).toMatch(/came out the same transaction as an earlier one/);
    await post(`${url}/reject`, {});
    expect((await s.engine.waitForAttempt(second.id, 5_000)).state).toBe("denied");

    // Another process built and the owner signed the same message: the payment core refuses it before it is sent.
    const again = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const twin: Signer = {
      kind: "browser",
      address: async () => owner.address,
      async sign(_req, hooks) {
        hooks?.onPending?.("w", "http://127.0.0.1:1/approve");
        return { kind: "solana-transaction", transaction: s.seller.lastTransaction(), signature: first.ownerSignature!, lastValidBlockHeight: first.lastValidBlockHeight, signer: owner.address } satisfies SignResult;
      },
    };
    const other = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: twin, rpcUrl: chain.url, timeoutMs: 5_000 });
    const refused = await other.waitForAttempt(other.startPayment(again.id).id, 10_000);
    expect(refused).toMatchObject({ state: "failed", refusal: "invalid" });
    expect(refused.reason).toMatch(/identical to one an earlier payment signed \(attempt .+\).*Nothing was submitted/);
    expect(s.seller.hits.paid).toBe(1);
  });

  it("never counts one landed transaction as the payment of two attempts", async () => {
    const s = await stack();
    const first = await pay(s);
    expect(first).toMatchObject({ state: "settled", chain: "verified" });
    // An attempt recorded with the same owner's signature (identical messages, before they were refused) and unresolved.
    const { receiptId: _r, transaction: _t, transactionUrl: _u, ...rest } = first;
    s.records.saveAttempt({ ...rest, id: "twin", quoteId: "q-twin", state: "uncertain", chain: undefined, history: [...first.history, { at: new Date().toISOString(), state: "uncertain" }] });
    const twin = await recheckChain(s.records, "twin", chain.url);
    expect(twin?.state).toBe("uncertain");
    expect(twin?.receiptId).toBeUndefined();
    expect(s.records.listReceipts()).toHaveLength(1);
  });

  it("does not verify a payment by a transaction already recorded as another attempt's, even when it carries the owner's signature", async () => {
    const s = await stack();
    const first = await pay(s);
    expect(first).toMatchObject({ state: "settled", chain: "verified" });
    const paidWith = s.seller.landed!;
    // An attempt recorded without its signature (as before signatures were recorded), so nothing refuses a twin before sending.
    s.records.saveAttempt({ ...s.records.getAttempt(first.id)!, ownerSignature: undefined });
    const again = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const twin: Signer = {
      kind: "browser",
      address: async () => owner.address,
      async sign(_req, hooks) {
        hooks?.onPending?.("w", "http://127.0.0.1:1/approve");
        return { kind: "solana-transaction", transaction: s.seller.lastTransaction(), signature: first.ownerSignature!, lastValidBlockHeight: first.lastValidBlockHeight, signer: owner.address } satisfies SignResult;
      },
    };
    // The seller names the first payment's transaction for the second.
    s.seller.names = paidWith;
    const other = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: twin, rpcUrl: chain.url, timeoutMs: 5_000 });
    const second = await other.waitForAttempt(other.startPayment(again.id).id, 10_000);
    expect(second).toMatchObject({ state: "uncertain", chain: "mismatch" });
    expect(second.chainReason).toBe(`transaction ${paidWith} is already recorded as the payment of attempt ${first.id}`);
    expect(s.records.listReceipts().filter((r) => r.transaction === paidWith)).toHaveLength(1);
  });

  it("does not take up an attempt that was stopped while it waited for the cap lock", async () => {
    const s = await stack();
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(s.engine);
    const started = s.engine.startPayment(taken.id);
    const url = await link;
    expect((await post(`${url}/account`, { address: owner.address })).status).toBe(200);
    const built = await post(`${url}/prepare`, { address: owner.address });
    // Another process holds the cap lock while the owner's signature arrives.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const lock = withFileLock(join(s.records.dir, "cap.lock"), async () => {
      locked();
      await held;
    });
    await holding;
    const signed = await post(`${url}/signed`, { address: owner.address, signedTransaction: signAsOwner(built.body.transaction as string, owner) });
    expect(signed.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    // The caller stops meanwhile, and is told nothing was submitted.
    expect(s.engine.stop(started.id, "the test stopped waiting", "stopped")?.state).toBe("abandoned");
    release();
    await lock;
    await new Promise((r) => setTimeout(r, 300));
    const final = s.records.getAttempt(started.id)!;
    expect(final.state).toBe("abandoned");
    expect(final.history.map((h) => h.state)).toEqual(["awaiting_approval", "awaiting_approval", "abandoned"]);
    expect(s.seller.hits.paid).toBe(0);
    expect(s.seller.lastPayment).toBeUndefined();
  });

  it("reconciles a payment its process left submitting: found by the owner's signature, or unpaid once it can never land", async () => {
    const crashed = (attempt: Attempt): Attempt => ({
      ...attempt,
      state: "submitting",
      runner: GONE,
      receiptId: undefined,
      reason: undefined,
      history: attempt.history.filter((h) => h.state !== "uncertain"),
    });
    // The signed record was written, the facilitator landed it, and the process died before it heard back.
    const s = await stack("drop-after-landing");
    const landed = await pay(s);
    s.records.saveAttempt(crashed(landed));
    expect(s.records.spentToday("USDC", new Date(Date.now() + 5 * 24 * 60 * 60 * 1000))).toBe(0.01);
    const found = await recheckChain(s.records, landed.id, chain.url);
    expect(found).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.seller.landed });
    expect(found?.history.map((h) => h.state).slice(-2)).toEqual(["uncertain", "paid_service_failed"]);
    expect(s.records.spentToday("USDC")).toBe(0.01);

    // Nothing landed: it stays uncertain while it can, and is unpaid once the chain shows it cannot.
    const t = await stack("drop-before-landing");
    const lost = await pay(t);
    t.records.saveAttempt(crashed(lost));
    const open = await recheckChain(t.records, lost.id, chain.url);
    expect(open?.state).toBe("uncertain");
    expect(open?.reason).toBe("the process running this payment stopped after the owner approved it, while the payment was being submitted, so whether it settled is unknown");
    chain.height = lost.lastValidBlockHeight! + 1;
    expect(await recheckChain(t.records, lost.id, chain.url)).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(t.records.spentToday("USDC", new Date(Date.now() + 5 * 24 * 60 * 60 * 1000))).toBe(0);

    // A process that is still running carries its own attempt on: status leaves it alone.
    t.records.saveAttempt({ ...crashed(lost), id: "live", runner: { pid: process.pid, start: null } });
    expect((await recheckChain(t.records, "live", chain.url))?.state).toBe("submitting");
  });

  it("finds the real payment after a seller named someone else's transaction while the chain could not be read", async () => {
    const s = await stack();
    const stranger = solanaKey();
    const theirs = buildPayment({ owner: stranger.address, recipient: s.seller.payTo, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: s.seller.feePayer, blockhash: bs58.encode(randomBytes(32)) });
    s.seller.names = chain.land(signAsOwner(theirs.transaction, stranger));
    // The engine's chain reads fail at pay time (the wallet's page still builds on devnet).
    const blind = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: s.signer, rpcUrl: "http://127.0.0.1:1", timeoutMs: 5_000 });
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(blind);
    const started = blind.startPayment(taken.id);
    await approveOnPage(await link);
    const final = await blind.waitForAttempt(started.id, 15_000);
    expect(final).toMatchObject({ state: "settled", chain: "unchecked", transaction: s.seller.names });
    expect(messageFor(final)).toMatch(/^The seller reported it paid/);

    // The chain answers: the named transaction is someone else's, and this payment is found by the owner's signature,
    // in the same check. The receipt is corrected, not doubled.
    const rechecked = await recheckChain(s.records, final.id, chain.url);
    expect(rechecked).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    const receipt = s.records.getReceipt(final.receiptId!)!;
    expect(receipt).toMatchObject({ id: final.id, chain: "verified", transaction: s.seller.landed });
    expect(receipt.settlement.transaction).toBe(s.seller.names);
    expect(s.records.listReceipts()).toHaveLength(1);
    expect(s.records.spentToday("USDC")).toBe(0.01);
    expect((await recheckChain(s.records, final.id, chain.url))?.state).toBe("settled");
  });

  it("refuses an offer it cannot pay at the quote, before anyone is asked: no fee payer, another mint", async () => {
    const s = await stack();
    s.seller.accept.extra = {};
    await expect(quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY })).rejects.toSatisfy(
      (err: unknown) => err instanceof SellerTextError && /names no fee payer/.test(String((err as SellerTextError & { detail?: string }).detail ?? err)),
    );
    s.seller.accept.extra = { feePayer: s.seller.feePayer };
    s.seller.accept.asset = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    await expect(quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY })).rejects.toBeInstanceOf(SellerTextError);
  });

  it("ends uncertain when the answer never comes, and a recheck finds the payment by the owner's signature", async () => {
    const s = await stack("drop-after-landing");
    const final = await pay(s);
    expect(final.state).toBe("uncertain");
    expect(final.reason).toMatch(/could not be completed with this service/);
    expect(final.receiptId).toBeUndefined();
    expect(s.records.spentToday("USDC")).toBe(0.01);

    const rechecked = await recheckChain(s.records, final.id, chain.url);
    expect(rechecked?.state).toBe("paid_service_failed");
    expect(rechecked?.transaction).toBe(s.seller.landed);
    expect(rechecked?.chain).toBe("verified");
    expect(rechecked?.reason).toBe("the chain shows this payment, but the service's answer was not received, so whether it delivered is unknown");
    const receipt = s.records.getReceipt(rechecked!.receiptId!)!;
    expect(receipt).toMatchObject({ transaction: s.seller.landed, payer: owner.address, chain: "verified" });
    // counted once
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("stays uncertain while the payment can still land, and is unpaid once the chain shows it never can", async () => {
    const s = await stack("drop-before-landing");
    const final = await pay(s);
    expect(final.state).toBe("uncertain");
    expect(s.seller.landed).toBeUndefined();
    const first = await recheckChain(s.records, final.id, chain.url);
    expect(first?.state).toBe("uncertain");
    expect(first?.chainReason).toBe(`no transaction carrying the owner's signature was found yet; it can still land until block height ${final.lastValidBlockHeight}`);
    // Counted on later days too, until the chain says: a Solana transaction expires at a height only the chain knows.
    expect(s.records.spentToday("USDC", new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))).toBe(0.01);
    chain.height = final.lastValidBlockHeight! + 1;
    const later = await recheckChain(s.records, final.id, chain.url);
    expect(later).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(later?.chainReason).toMatch(/blockhash expired at block height \d+ .*so it can no longer land/);
    expect(s.records.spentToday("USDC")).toBe(0);
    expect(s.records.spentToday("USDC", new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))).toBe(0);
  });

  it("never takes a seller's no after the credential left as unpaid: landed, the chain finds it by the owner's signature", async () => {
    for (const behaviour of ["land-then-402", "land-then-did-not-settle"] as const) {
      const s = await stack(behaviour);
      const final = await pay(s);
      expect(final.state, behaviour).toBe("uncertain");
      expect(s.seller.landed, behaviour).toBeTruthy();
      expect(s.records.spentToday("USDC"), behaviour).toBe(0.01);
      if (behaviour === "land-then-did-not-settle") expect(final.serviceReason).toBe("unexpected_error");
      const found = await recheckChain(s.records, final.id, chain.url);
      expect(found, behaviour).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.seller.landed });
      expect(s.records.spentToday("USDC"), behaviour).toBe(0.01);
    }
  });

  it("finds a landed payment whatever this machine's clock said when the payment began", async () => {
    const s = await stack("land-then-402");
    const final = await pay(s);
    expect(final.state).toBe("uncertain");
    expect(final.searchFromSlot).toBeGreaterThan(0);
    // The record as a machine three minutes fast would have written it, read after the blockhash expired.
    s.records.saveAttempt({ ...final, createdAt: new Date(Date.parse(final.createdAt) + 180_000).toISOString() });
    chain.height = final.lastValidBlockHeight! + 1;
    expect(await recheckChain(s.records, final.id, chain.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.seller.landed });
  });

  it("reports what the chain decided for an attempt it ran, after the run ended", async () => {
    const s = await stack("land-then-402");
    const final = await pay(s);
    expect(s.engine.getAttempt(final.id)?.state).toBe("uncertain");
    expect((await s.engine.recheckChain(final.id))?.state).toBe("paid_service_failed");
    expect(s.engine.getAttempt(final.id)?.state).toBe("paid_service_failed");
    expect(s.engine.listAttempts().find((a) => a.id === final.id)?.state).toBe("paid_service_failed");
  });

  it("keeps the seller's answer a run recorded after its caller stopped, when status finds the payment", async () => {
    const s = await stack();
    let go!: () => void;
    const held = new Promise<void>((resolve) => (go = resolve));
    const engine = new PaymentEngine({
      records: s.records,
      policy: DEFAULT_POLICY,
      signer: s.signer,
      rpcUrl: chain.url,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        if (new Headers(init?.headers).has("payment-signature")) await held;
        return fetch(input, init);
      },
    });
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(engine);
    const started = engine.startPayment(taken.id);
    await approveOnPage(await link);
    for (let i = 0; i < 200 && engine.getAttempt(started.id)?.state !== "submitting"; i++) await new Promise((r) => setTimeout(r, 10));
    // The caller stops while the credential is on its way; the run goes on and records the seller's answer.
    expect(engine.stop(started.id, "the test stopped waiting")?.state).toBe("uncertain");
    go();
    for (let i = 0; i < 200 && !s.records.getReceipt(started.id); i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.records.getReceipt(started.id)).toMatchObject({ serviceOutcome: "ok", chain: "verified" });
    // The chain cannot be read when status runs: the receipt the run verified is the chain's word already, and it stands.
    const offline = await recheckChain(s.records, started.id, "http://127.0.0.1:1");
    expect(offline).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    expect(s.records.getReceipt(started.id)).toMatchObject({ chain: "verified" });
    const found = await recheckChain(s.records, started.id, chain.url);
    expect(found).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    expect(s.records.getReceipt(started.id)).toMatchObject({ serviceOutcome: "ok", chain: "verified", serviceBodyPreview: expect.stringContaining("the paid answer") });
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("keeps a payment status verified when the seller's answer arrives later, and adds what the service delivered", async () => {
    // The round-3 review's reproduction: the facilitator lands the payment while the seller's answer is on its way; the
    // caller stops waiting; status, on a working RPC, finds the payment; then the answer reaches the run, whose own chain
    // read fails.
    const s = await stack();
    let ready!: () => void;
    let go!: () => void;
    const arrived = new Promise<void>((resolve) => (ready = resolve));
    const held = new Promise<void>((resolve) => (go = resolve));
    const engine = new PaymentEngine({
      records: s.records,
      policy: DEFAULT_POLICY,
      signer: s.signer,
      rpcUrl: "http://127.0.0.1:1",
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        const answer = await fetch(input, init);
        if (new Headers(init?.headers).has("payment-signature")) {
          ready();
          await held;
        }
        return answer;
      },
    });
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(engine);
    const started = engine.startPayment(taken.id);
    await approveOnPage(await link);
    await arrived;
    expect(engine.stop(started.id, "the caller stopped waiting")?.state).toBe("uncertain");
    expect(await recheckChain(s.records, started.id, chain.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: s.seller.landed });
    const found = s.records.getReceipt(started.id)!;
    expect(found).toMatchObject({ chain: "verified", serviceOutcome: "unknown" });
    // The answer is written under the lock every status writes under: while one holds it, the answer waits for it.
    await withFileLock(join(s.records.dir, "reconcile.lock"), async () => {
      go();
      const waiting = () => readdirSync(s.records.dir).some((f) => f.startsWith("reconcile.lock.") && f.endsWith(".tmp"));
      for (let i = 0; i < 500 && !waiting(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(waiting()).toBe(true);
      expect(s.records.getReceipt(started.id)).toEqual(found);
    });
    for (let i = 0; i < 200 && s.records.getReceipt(started.id)?.serviceOutcome !== "ok"; i++) await new Promise((r) => setTimeout(r, 10));
    const receipt = s.records.getReceipt(started.id)!;
    expect(receipt).toMatchObject({ chain: "verified", transaction: s.seller.landed, serviceOutcome: "ok", serviceStatus: 200, at: found.at, serviceBodyPreview: expect.stringContaining("the paid answer") });
    expect(receipt).not.toHaveProperty("chainReason");
    // The attempt learns that the service delivered.
    expect(s.records.getAttempt(started.id)).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed, serviceStatus: 200 });
    expect(s.records.getAttempt(started.id)).not.toHaveProperty("reason");
    expect(engine.getAttempt(started.id)).toMatchObject({ state: "settled", chain: "verified" });
    expect(await recheckChain(s.records, started.id, chain.url)).toMatchObject({ state: "settled", chain: "verified" });
    expect(s.records.getReceipt(started.id)).toMatchObject({ chain: "verified" });
    const tomorrow = new Date(Date.parse(receipt.at) + 86_400_000);
    expect(s.records.spentToday("USDC", new Date(receipt.at))).toBe(0.01);
    expect(s.records.spentToday("USDC", tomorrow)).toBe(0);
  });

  /** A run whose seller answer is held until `go`, with the chain unreadable for it, and its caller stopped. */
  async function stoppedRun(s: Awaited<ReturnType<typeof stack>>, rpcUrl = "http://127.0.0.1:1") {
    let ready!: () => void;
    let go!: () => void;
    const arrived = new Promise<void>((resolve) => (ready = resolve));
    const held = new Promise<void>((resolve) => (go = resolve));
    const engine = new PaymentEngine({
      records: s.records,
      policy: DEFAULT_POLICY,
      signer: s.signer,
      rpcUrl,
      timeoutMs: 5_000,
      fetchImpl: async (input, init) => {
        const answer = await fetch(input, init);
        if (new Headers(init?.headers).has("payment-signature")) {
          ready();
          await held;
        }
        return answer;
      },
    });
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(engine);
    const started = engine.startPayment(taken.id);
    await approveOnPage(await link);
    await arrived;
    expect(engine.stop(started.id, "the caller stopped waiting")?.state).toBe("uncertain");
    return { engine, id: started.id, go };
  }

  it.each([
    ["for a moment", false],
    ["for longer than the run waits for it", true],
  ] as const)("never writes a late answer without the lock: a status holding it %s keeps its verified receipt", async (_label, long) => {
    // The round-4 review's reproduction: a status in another process finds the payment and holds the lock right before
    // it writes the receipt, while the seller's answer reaches the run.
    const s = await stack();
    const run = await stoppedRun(s);
    const gate = join(s.records.dir, "held-status");
    const worker = spawn(process.execPath, ["--import", "tsx", "test/helpers/held-status.ts", s.records.dir, run.id, chain.url, gate], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    worker.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => worker.once("exit", resolve));
    const until = async (done: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !done() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
      return done();
    };
    try {
      expect(await until(() => existsSync(`${gate}.ready`), 15_000), stderr).toBe(true);
      // The run's receipt writes while the other status holds the lock: there must be none.
      let writtenUnderTheirLock = 0;
      const save = s.records.saveReceipt.bind(s.records);
      s.records.saveReceipt = (receipt) => {
        if (!existsSync(`${gate}.go`)) writtenUnderTheirLock += 1;
        return save(receipt);
      };
      run.go();
      if (long) {
        // The run gives up waiting for the lock and keeps the answer aside.
        expect(await until(() => s.records.pendingAnswer(run.id) !== undefined, 15_000)).toBe(true);
        expect(s.records.getReceipt(run.id)).toBeUndefined();
      } else {
        await new Promise((r) => setTimeout(r, 150));
      }
      writeFileSync(`${gate}.go`, "write");
      expect(await exited, stderr).toBe(0);
      expect(writtenUnderTheirLock).toBe(0);
      if (!long) expect(await until(() => s.records.getReceipt(run.id)?.serviceOutcome === "ok", 15_000)).toBe(true);
      s.records.saveReceipt = save;
      // The next status records the answer kept aside, under the lock; the verified receipt stands.
      expect(await recheckChain(s.records, run.id, chain.url)).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
      expect(s.records.pendingAnswer(run.id)).toBeUndefined();
      const receipt = s.records.getReceipt(run.id)!;
      expect(receipt).toMatchObject({ chain: "verified", transaction: s.seller.landed, serviceOutcome: "ok", serviceBodyPreview: expect.stringContaining("the paid answer") });
      expect(s.records.spentToday("USDC", new Date(Date.parse(receipt.at) + 86_400_000))).toBe(0);
    } finally {
      writeFileSync(`${gate}.go`, "cleanup");
      run.go();
      if (worker.exitCode === null) worker.kill("SIGKILL");
    }
  }, 40_000);

  it("reports a waiting answer that status cannot write, keeps it, and records it on the next status", async () => {
    // The round-5 review's reproduction: the receipt write fails under the lock (a full disk) while status records a
    // waiting answer. Status says so, and nothing is lost.
    const s = await stack();
    const final = await pay(s);
    const original = s.records.getReceipt(final.id)!;
    s.records.savePendingAnswer({ ...original, chain: "unchecked", serviceBodyPreview: "still waiting" });
    const save = s.records.saveReceipt.bind(s.records);
    s.records.saveReceipt = () => {
      expect(existsSync(join(s.records.dir, "reconcile.lock"))).toBe(true);
      throw new Error("ENOSPC: no space left on device");
    };
    try {
      await expect(recheckChain(s.records, final.id, chain.url)).rejects.toThrow("ENOSPC");
    } finally {
      s.records.saveReceipt = save;
    }
    expect(s.records.pendingAnswer(final.id)).toMatchObject({ serviceBodyPreview: "still waiting" });
    expect(s.records.getReceipt(final.id)).toEqual(original);
    expect(await recheckChain(s.records, final.id, chain.url)).toMatchObject({ state: "settled", chain: "verified" });
    expect(s.records.getReceipt(final.id)).toMatchObject({ chain: "verified", transaction: original.transaction, at: original.at, serviceBodyPreview: "still waiting" });
    expect(s.records.pendingAnswer(final.id)).toBeUndefined();
  });

  it("keeps a payment the chain showed was never made unpaid when the seller's success arrives later, and counts it nowhere", async () => {
    // The round-4 review's reproduction: the seller took the signed transaction, landed nothing and held its answer; the
    // caller stopped; status read the whole window and recorded unpaid; then the seller's success reached the run.
    const s = await stack("claims-success");
    const run = await stoppedRun(s, chain.url);
    chain.height = s.records.getAttempt(run.id)!.lastValidBlockHeight! + 1;
    const unpaid = (await recheckChain(s.records, run.id, chain.url))!;
    expect(unpaid).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(s.records.getReceipt(run.id)).toBeUndefined();
    run.go();
    for (let i = 0; i < 400 && !s.records.getReceipt(run.id); i++) await new Promise((r) => setTimeout(r, 10));
    // The seller's word is kept, marked as what the chain contradicts.
    expect(s.records.getReceipt(run.id)).toMatchObject({ chain: "unpaid", chainReason: unpaid.chainReason, serviceOutcome: "ok", settlement: { success: true } });
    expect(s.records.getAttempt(run.id)).toMatchObject({ state: "failed", chain: "unpaid", chainReason: unpaid.chainReason, reason: unpaid.reason });
    expect(await recheckChain(s.records, run.id, chain.url)).toMatchObject({ state: "failed", chain: "unpaid" });
    const receipt = s.records.getReceipt(run.id)!;
    expect(s.records.spentToday("USDC", new Date(receipt.at))).toBe(0);
    expect(s.records.spentToday("USDC", new Date(Date.parse(receipt.at) + 86_400_000))).toBe(0);
  });

  it("ends a run that cannot record its receipt uncertain, and the next status records it and finds the payment", async () => {
    const s = await stack();
    let held!: () => void;
    const release = new Promise<void>((resolve) => (held = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    // Another process holds the lock for longer than the run waits for it.
    mkdirSync(s.records.dir, { recursive: true });
    const holder = withFileLock(join(s.records.dir, "reconcile.lock"), async () => {
      locked();
      await release;
    }, 1_000);
    await holding;
    const final = await pay(s);
    held();
    await holder;
    expect(final).toMatchObject({ state: "uncertain", chain: "unchecked", transaction: s.seller.landed, reason: expect.stringMatching(/receipt could not be recorded while another process held the records' lock/) });
    expect(s.records.getReceipt(final.id)).toBeUndefined();
    expect(s.records.pendingAnswer(final.id)).toMatchObject({ serviceOutcome: "ok", transaction: s.seller.landed });
    // Uncertain, it counts until status resolves it.
    expect(s.records.spentToday("USDC")).toBe(0.01);
    expect(await recheckChain(s.records, final.id, chain.url)).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    expect(s.records.getReceipt(final.id)).toMatchObject({ chain: "verified", serviceOutcome: "ok" });
    expect(s.records.pendingAnswer(final.id)).toBeUndefined();
    expect(s.records.spentToday("USDC")).toBe(0.01);
  }, 40_000);

  it("keeps a seller's success that the chain has not confirmed counted on the next day, while it can still land", async () => {
    const s = await stack("claims-success");
    const final = await pay(s);
    expect(final).toMatchObject({ state: "settled", chain: "unchecked" });
    const receipt = s.records.getReceipt(final.receiptId!)!;
    const tomorrow = new Date(Date.parse(receipt.at) + 86_400_000);
    expect(s.records.spentToday("USDC", new Date(receipt.at))).toBe(0.01);
    expect(s.records.spentToday("USDC", tomorrow)).toBe(0.01);
    // Shown on chain never to have landed: it stops counting.
    chain.height = final.lastValidBlockHeight! + 1;
    expect(await recheckChain(s.records, final.id, chain.url)).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(s.records.spentToday("USDC", tomorrow)).toBe(0);
  });

  it("never lets a status that read the chain earlier downgrade a payment another status verified meanwhile", async () => {
    const s = await stack();
    const stranger = solanaKey();
    const theirs = buildPayment({ owner: stranger.address, recipient: s.seller.payTo, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: s.seller.feePayer, blockhash: bs58.encode(randomBytes(32)) });
    s.seller.names = chain.land(signAsOwner(theirs.transaction, stranger));
    const blind = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: s.signer, rpcUrl: "http://127.0.0.1:1", timeoutMs: 5_000 });
    const taken = await quote({ url: s.seller.resource }, { records: s.records, policy: DEFAULT_POLICY });
    const link = linkOf(blind);
    const started = blind.startPayment(taken.id);
    await approveOnPage(await link);
    const final = await blind.waitForAttempt(started.id, 15_000);
    expect(final).toMatchObject({ state: "settled", chain: "unchecked" });
    // Status A reads the seller's (wrong) transaction, then waits; every chain read after that fails.
    let ready!: () => void;
    let resume!: () => void;
    const read = new Promise<void>((r) => (ready = r));
    const go = new Promise<void>((r) => (resume = r));
    let calls = 0;
    const slow: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) {
        const answer = await fetch(input, init);
        const body = await answer.text();
        ready();
        await go;
        return new Response(body, { status: answer.status });
      }
      return new Response("RPC unavailable", { status: 503 });
    };
    const a = recheckChain(s.records, final.id, { rpcUrlFor: () => chain.url, fetchImpl: slow });
    await read;
    // Status B finds the owner's payment and verifies it.
    expect(await recheckChain(s.records, final.id, chain.url)).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    resume();
    const after = await a;
    expect(after).toMatchObject({ state: "settled", chain: "verified", transaction: s.seller.landed });
    expect(s.records.getAttempt(final.id)).toMatchObject({ state: "settled", chain: "verified" });
    expect(s.records.getReceipt(final.receiptId!)).toMatchObject({ chain: "verified", transaction: s.seller.landed });
  });

  it("decides nothing when the node lists the payment and then cannot read it", async () => {
    const s = await stack("land-then-402");
    const final = await pay(s);
    chain.unreadable.add(s.seller.landed!);
    chain.height = final.lastValidBlockHeight! + 1;
    const rechecked = await recheckChain(s.records, final.id, chain.url);
    expect(rechecked?.state).toBe("uncertain");
    expect(rechecked?.chainReason).toMatch(/could not be read/);
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("finds a payment that lands after the seller said it did not settle, and releases one that never can", async () => {
    const s = await stack("did-not-settle");
    const late = await pay(s);
    expect(late.state).toBe("uncertain");
    expect((await recheckChain(s.records, late.id, chain.url))?.state).toBe("uncertain");
    // The facilitator lands the signed transaction after it answered.
    const landed = chain.land(s.seller.lastTransaction());
    expect(await recheckChain(s.records, late.id, chain.url)).toMatchObject({ state: "paid_service_failed", chain: "verified", transaction: landed });

    const never = await pay(s);
    expect(never.state).toBe("uncertain");
    expect(s.records.spentToday("USDC")).toBe(0.02);
    chain.height = never.lastValidBlockHeight! + 1;
    expect(await recheckChain(s.records, never.id, chain.url)).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(s.records.spentToday("USDC")).toBe(0.01);
  });

  it("does not call a seller's success without a transaction paid: reported, then searched for, then unpaid when it never landed", async () => {
    const s = await stack("claims-success");
    const final = await pay(s);
    expect(final).toMatchObject({ state: "settled", chain: "unchecked" });
    expect(messageFor(final)).toMatch(/^The seller reported it paid: 0\.01 USDC on Solana devnet \(testnet\) \(no transaction hash was given\)\. The chain has not confirmed it yet/);
    expect(messageFor(final, undefined, "cli")).not.toMatch(/^Paid/);
    // Looked for by the owner's signature, not by the transaction the seller did not name.
    const searched = await recheckChain(s.records, final.id, chain.url);
    expect(searched).toMatchObject({ state: "settled", chain: "unchecked" });
    expect(searched?.chainReason).toMatch(/^no transaction carrying the owner's signature was found yet/);
    expect(s.records.spentToday("USDC")).toBe(0.01);
    chain.height = final.lastValidBlockHeight! + 1;
    const unpaid = await recheckChain(s.records, final.id, chain.url);
    expect(unpaid).toMatchObject({ state: "failed", chain: "unpaid" });
    expect(unpaid?.reason).toBe("the service reported this payment settled, but the chain shows it was never made, and it can no longer be");
    expect(s.records.getReceipt(final.receiptId!)).toMatchObject({ chain: "unpaid" });
    expect(s.records.spentToday("USDC")).toBe(0);
  });

  it("does not take someone else's transaction as this payment: uncertain, then found by the owner's signature", async () => {
    const s = await stack();
    // another owner's payment to the same seller, on chain already
    const stranger = solanaKey();
    const theirs = buildPayment({ owner: stranger.address, recipient: s.seller.payTo, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: s.seller.feePayer, blockhash: bs58.encode(randomBytes(32)) });
    s.seller.names = chain.land(signAsOwner(theirs.transaction, stranger));
    const final = await pay(s);
    expect(final.state).toBe("uncertain");
    expect(final.chain).toBe("mismatch");
    expect(final.reason).toMatch(/the chain does not confirm it \(the transaction does not carry the owner's signature over this payment\)/);
    expect(final.receiptId).toBeUndefined();
    const rechecked = await recheckChain(s.records, final.id, chain.url);
    expect(rechecked?.state).toBe("paid_service_failed");
    expect(rechecked?.transaction).toBe(s.seller.landed);
    expect(rechecked?.transaction).not.toBe(s.seller.names);
  });
});
