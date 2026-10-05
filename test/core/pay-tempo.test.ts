// `pay` on Tempo Moderato, end to end: a local MPP seller, a local Tempo chain, the real payment engine and the real
// approval server, with the test playing the owner's browser wallet (it posts what the page posts, and "sends" the call
// it is given by mining it on the fake chain). What matters here is that money moves at most once, and only after the
// engine has written down that it may: a wallet asked to send and never heard from leaves the attempt uncertain, and the
// chain is searched for the payment's memo later.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PaymentEngine, recheckChain, shownAttempt, shownReceipt } from "../../src/core/pay.js";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { mppMemo } from "../../src/core/rails/tempo.js";
import { withFileLock } from "../../src/core/lock.js";
import { Records } from "../../src/core/records.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SignRefused, type Signer, type TempoSignRequest } from "../../src/core/signer/types.js";

import { attemptView, messageFor } from "../../src/cli/views.js";
import { nextFor } from "../../src/cli/outcome.js";
import { PATH_USD, startFakeMppSeller, startFakeTempoPay, type FakeMppSeller, type FakeTempoPay } from "../helpers/fake-tempo-pay.js";

const RECIPIENT = "0x2222222222222222222222222222222222222222";

let home: string;
const opened: { close(): Promise<void> }[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-pay-tempo-"));
});
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

interface Stack {
  chain: FakeTempoPay;
  seller: FakeMppSeller;
  records: Records;
  engine: PaymentEngine;
  url: string;
  clock: { now: number };
}

async function stack(options: { timeoutMs?: number; policy?: Partial<Policy>; expiresIn?: number; challengeId?: string } = {}): Promise<Stack> {
  const chain = await startFakeTempoPay();
  const seller = await startFakeMppSeller(chain, { recipient: RECIPIENT, expiresIn: options.expiresIn, challengeId: options.challengeId });
  const dir = mkdtempSync(join(home, "stack-"));
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const signer = new BrowserWalletSigner({ port: 0, home: dir, policy, timeoutMs: options.timeoutMs ?? 10_000, balance: false });
  const records = new Records(join(dir, "records"));
  const clock = { now: Date.now() };
  const engine = new PaymentEngine({ records, policy, signer, rpcUrl: chain.url, now: () => clock.now });
  opened.push(chain, seller, { close: () => signer.close() });
  return { chain, seller, records, engine, url: `${seller.url}/paid`, clock };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

function approvalLink(engine: PaymentEngine, id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no approval link")), 10_000);
    const check = () => {
      const url = engine.getAttempt(id)?.approvalUrl;
      if (!url) return;
      clearTimeout(timer);
      engine.events.off("transition", onTransition);
      resolve(url);
    };
    const onTransition = () => check();
    engine.events.on("transition", onTransition);
    check();
  });
}

/** Quote, start, and open the approval page: the attempt, its link, and the account the "wallet" connects. */
async function startTempoPayment(s: Stack) {
  const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
  expect(q.terms).toMatchObject({ asset: "pathUSD", network: "eip155:42431", scheme: "charge", amountAtomic: "10000", recipient: RECIPIENT });
  expect(q.policy.allowed).toBe(true);
  const attempt = s.engine.startPayment(q.id);
  const link = await approvalLink(s.engine, attempt.id);
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  return { q, attempt, link, owner };
}

describe("pay on Tempo Moderato", () => {
  it("records the memo before the wallet is asked, checks the owner's transfer on chain, then calls the seller once", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);

    // The page shows the verified facts, the Tempo wallet step, and Tempo's chain for the wallet to add.
    const html = await (await fetch(link)).text();
    expect(html).toContain("Tempo Moderato");
    expect(html).toContain("pathUSD");
    expect(html).toContain(RECIPIENT);
    expect(html).toContain("send the payment from your browser wallet");
    expect(html).toContain("eth_sendTransaction");
    expect(html).toContain('"chainIdHex":"0xa5bf"');
    expect(html).toContain('"nativeCurrency":{"name":"USD","symbol":"USD","decimals":18}');

    const prepared = await postJson(`${link}/account`, { address: owner });
    expect(prepared.status).toBe(200);
    const call = prepared.body.transaction as { from: string; to: string; data: string; value: string };
    expect(call.to).toBe("0x20C0000000000000000000000000000000000000");
    expect(s.engine.getAttempt(attempt.id)?.state).toBe("awaiting_approval");

    const sending = await postJson(`${link}/sending`, { address: owner });
    expect(sending.status).toBe(200);
    // Written down before the wallet is asked: money may move from here on.
    const asked = s.records.getAttempt(attempt.id)!;
    expect(asked.state).toBe("approved");
    expect(asked.payer).toBe(owner);
    expect(asked.paymentMemo).toBe(mppMemo(s.seller.issued.at(-1)!.id, "seller.example"));
    expect(s.seller.credentials).toHaveLength(0);

    const hash = s.chain.send(owner, call);
    expect((await postJson(`${link}/sent`, { address: owner, hash })).status).toBe(200);

    const done = await s.engine.waitForAttempt(attempt.id, 15_000);
    expect(done.state).toBe("settled");
    expect(done.transaction).toBe(hash.toLowerCase());
    expect(done.chain).toBe("verified");
    expect(s.seller.paid).toEqual([{ hash: hash.toLowerCase(), source: `did:pkh:eip155:42431:${owner}` }]);
    const receipt = s.records.getReceipt(done.receiptId!)!;
    expect(receipt).toMatchObject({ payer: owner, transaction: hash.toLowerCase(), transactionKind: "hash", serviceOutcome: "ok", chain: "verified", network: "eip155:42431" });
    expect(receipt.transactionUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${hash.toLowerCase()}`);
    expect(shownReceipt(receipt).transactionUrl).toBe(receipt.transactionUrl);
    expect(shownAttempt(done).payer).toBe(owner);
    expect(attemptView({ records: s.records }, done)).toMatchObject({ state: "settled" });
    // The daily cap counts pathUSD as dollars, with USDC.
    expect(s.records.spentToday("USDC")).toBe(0.01);
    expect(s.records.spentToday("pathUSD")).toBe(0.01);
  });

  it("ends uncertain when the receipt cannot be recorded, and the next status records it and the payment", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    const call = (await postJson(`${link}/account`, { address: owner })).body.transaction as { from: string; to: string; data: string; value: string };
    expect((await postJson(`${link}/sending`, { address: owner })).status).toBe(200);
    // Another process holds the lock status writes under for longer than the run waits for it.
    mkdirSync(s.records.dir, { recursive: true });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = withFileLock(join(s.records.dir, "reconcile.lock"), async () => {
      locked();
      await released;
    });
    await holding;
    const hash = s.chain.send(owner, call);
    expect((await postJson(`${link}/sent`, { address: owner, hash })).status).toBe(200);
    const done = await s.engine.waitForAttempt(attempt.id, 20_000);
    release();
    await holder;
    expect(done).toMatchObject({ state: "uncertain", transaction: hash.toLowerCase(), reason: expect.stringMatching(/receipt could not be recorded while another process held the records' lock/) });
    expect(s.seller.paid).toHaveLength(1);
    expect(s.records.getReceipt(attempt.id)).toBeUndefined();
    expect(s.records.spentToday("USDC")).toBe(0.01);
    expect(await recheckChain(s.records, attempt.id, s.chain.url)).toMatchObject({ state: "settled", chain: "verified", transaction: hash.toLowerCase() });
    expect(s.records.getReceipt(attempt.id)).toMatchObject({ chain: "verified", serviceOutcome: "ok", transaction: hash.toLowerCase() });
    expect(s.records.pendingAnswer(attempt.id)).toBeUndefined();
    expect(s.records.spentToday("USDC")).toBe(0.01);
  }, 40_000);

  it("asks the wallet at most once, and never takes a rejection reported after it was asked as nothing sent", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    await postJson(`${link}/account`, { address: owner });
    expect((await postJson(`${link}/sending`, { address: owner })).status).toBe(200);

    const again = await postJson(`${link}/sending`, { address: owner });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already asked to send this payment/);
    // Nothing is prepared again for another account once the wallet was asked.
    expect((await postJson(`${link}/account`, { address: privateKeyToAccount(generatePrivateKey()).address })).status).toBe(409);
    // The page's own button is not an answer from a wallet that may still send.
    const button = await postJson(`${link}/reject`, {});
    expect(button.status).toBe(409);
    expect(button.body.error).toMatch(/reject it in your wallet/);
    expect(s.engine.getAttempt(attempt.id)?.state).toBe("approved");

    // "The wallet said no" is a request body anyone with the link can send: it ends the approval, as unknown.
    const said = await postJson(`${link}/reject`, { by: "wallet" });
    expect(said.status).toBe(200);
    expect(said.body.status).toBe("unknown");
    const done = await s.engine.waitForAttempt(attempt.id, 5_000);
    expect(done.state).toBe("uncertain");
    expect(done.reason).toMatch(/cannot be checked against the wallet, so whether it was sent is unknown/);
    expect(s.seller.credentials).toHaveLength(0);
    // It keeps its place against the cap, today and on later days, until the chain shows it: a send has no expiry.
    expect(s.records.spentToday("pathUSD")).toBe(0.01);
    expect(s.records.spentToday("pathUSD", new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))).toBe(0.01);
    const unseen = await recheckChain(s.records, attempt.id, s.chain.url);
    expect(unseen?.state).toBe("uncertain");
    expect(unseen?.chainReason).toBe("the chain shows no transfer with this payment's memo");
  });

  it("finds a transfer sent before a reported rejection: paid, never denied, and the cap counts it once", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    const prepared = await postJson(`${link}/account`, { address: owner });
    expect((await postJson(`${link}/sending`, { address: owner })).status).toBe(200);
    // The wallet sent the transfer, and then the page (or anything holding the link) says the wallet rejected it.
    const hash = s.chain.send(owner, prepared.body.transaction);
    expect((await postJson(`${link}/reject`, { by: "wallet" })).status).toBe(200);
    const done = await s.engine.waitForAttempt(attempt.id, 5_000);
    expect(done.state).toBe("uncertain");
    expect(s.records.spentToday("pathUSD")).toBe(0.01);

    // The chain cannot be read: it stays uncertain, still counted.
    s.chain.down = true;
    const unread = await recheckChain(s.records, attempt.id, s.chain.url);
    expect(unread?.state).toBe("uncertain");
    expect(unread?.chainReason).toMatch(/the chain could not be read/);
    expect(s.records.spentToday("pathUSD")).toBe(0.01);

    s.chain.down = false;
    const found = await recheckChain(s.records, attempt.id, s.chain.url);
    expect(found?.state).toBe("paid_service_failed");
    expect(found?.transaction).toBe(hash);
    expect(found?.chain).toBe("verified");
    expect(s.records.getReceipt(found!.receiptId!)).toMatchObject({ transaction: hash, chain: "verified" });
    expect(s.records.spentToday("pathUSD")).toBe(0.01);
    expect(s.seller.credentials).toHaveLength(0);
  });

  it("ends uncertain, never unpaid, when the wallet was asked and nothing came back; the chain then decides by the memo", async () => {
    const s = await stack({ timeoutMs: 1_500 });
    const { attempt, link, owner } = await startTempoPayment(s);
    const prepared = await postJson(`${link}/account`, { address: owner });
    await postJson(`${link}/sending`, { address: owner });

    const done = await s.engine.waitForAttempt(attempt.id, 10_000);
    expect(done.state).toBe("uncertain");
    expect(done.reason).toMatch(/your wallet was asked to send this payment and the page did not report a transaction/);
    expect(done.paymentMemo).toBeTruthy();
    expect(s.seller.credentials).toHaveLength(0);
    // It counts toward the cap on the day it became uncertain: it may have been paid.
    expect(s.records.spentToday("pathUSD")).toBe(0.01);
    expect(messageFor(done)).toBeTruthy();

    // Nothing on chain: it stays uncertain, with the chain's answer.
    const unseen = await recheckChain(s.records, attempt.id, s.chain.url);
    expect(unseen?.state).toBe("uncertain");
    expect(unseen?.chainReason).toBe("the chain shows no transfer with this payment's memo");

    // The wallet did send, later: the chain shows it, so it was paid, and the service was never called.
    const hash = s.chain.send(owner, prepared.body.transaction);
    const found = await recheckChain(s.records, attempt.id, s.chain.url);
    expect(found?.state).toBe("paid_service_failed");
    expect(found?.transaction).toBe(hash);
    expect(found?.chain).toBe("verified");
    expect(found?.reason).toMatch(/the service was never called/);
    const receipt = s.records.getReceipt(found!.receiptId!)!;
    expect(receipt).toMatchObject({ transaction: hash, chain: "verified", serviceOutcome: "unknown" });
    expect(s.seller.credentials).toHaveLength(0);
    // Counted once, through its receipt.
    expect(s.records.spentToday("pathUSD")).toBe(0.01);
  });

  it("never asks a wallet to send for a challenge an earlier payment used: the memo would be the same", async () => {
    const s = await stack({ challengeId: "the-same-challenge" });
    // The first payment, paid.
    const first = await startTempoPayment(s);
    const prepared = await postJson(`${first.link}/account`, { address: first.owner });
    await postJson(`${first.link}/sending`, { address: first.owner });
    const hash = s.chain.send(first.owner, prepared.body.transaction);
    await postJson(`${first.link}/sent`, { address: first.owner, hash });
    expect((await s.engine.waitForAttempt(first.attempt.id, 15_000)).state).toBe("settled");

    // The seller hands out the same challenge again: refused before anyone is asked.
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    const second = await s.engine.waitForAttempt(s.engine.startPayment(q.id).id, 10_000);
    expect(second).toMatchObject({ state: "failed", refusal: "invalid" });
    expect(second.reason).toBe(
      `the seller's payment challenge is one an earlier payment already used (attempt ${first.attempt.id}), so a transfer for it could not be told apart from that payment's; nothing was sent. Quote again for a new challenge`,
    );
    expect(second.approvalUrl).toBeUndefined();
    expect(s.chain.transfers.size).toBe(1);
    expect(s.seller.credentials).toHaveLength(1);
  });

  it("asks one wallet only, when two approvals for the same challenge reach the wallet at once", async () => {
    const s = await stack({ challengeId: "the-same-challenge" });
    // Both pass the first check (neither has asked a wallet yet) and are waiting for the owner.
    const a = await startTempoPayment(s);
    const b = await startTempoPayment(s);
    await postJson(`${a.link}/account`, { address: a.owner });
    await postJson(`${b.link}/account`, { address: b.owner });
    expect((await postJson(`${a.link}/sending`, { address: a.owner })).status).toBe(200);
    const refused = await postJson(`${b.link}/sending`, { address: b.owner });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/one an earlier payment already used/);
    const ended = await s.engine.waitForAttempt(b.attempt.id, 5_000);
    expect(ended).toMatchObject({ state: "failed", refusal: "invalid" });
    expect(ended.paymentMemo).toBeUndefined();
    await postJson(`${a.link}/reject`, { by: "wallet" });
  });

  it("records the chain's head before the wallet is asked, and takes no older transfer for the payment", async () => {
    const s = await stack({ timeoutMs: 1_500 });
    const { attempt, link, owner } = await startTempoPayment(s);
    const prepared = await postJson(`${link}/account`, { address: owner });
    // A transfer exactly like this one, already on chain before the wallet is asked.
    const older = s.chain.send(owner, prepared.body.transaction);
    await postJson(`${link}/sending`, { address: owner });
    const asked = s.records.getAttempt(attempt.id)!;
    expect(asked.searchFromBlock).toBe(String(s.chain.head.number));
    const done = await s.engine.waitForAttempt(attempt.id, 10_000);
    expect(done.state).toBe("uncertain");
    expect((await recheckChain(s.records, attempt.id, s.chain.url))?.state).toBe("uncertain");
    // Reporting the older transfer as this payment's is no better: the chain shows it was mined before.
    expect(older).toBeTruthy();
    const ours = s.chain.send(owner, prepared.body.transaction);
    expect(await recheckChain(s.records, attempt.id, s.chain.url)).toMatchObject({ state: "paid_service_failed", transaction: ours });
  });

  it("does not ask the wallet when the chain cannot be read first: nothing is sent", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    await postJson(`${link}/account`, { address: owner });
    s.chain.down = true;
    const sending = await postJson(`${link}/sending`, { address: owner });
    expect(sending.status).toBe(409);
    expect(sending.body.error).toMatch(/^the Tempo Moderato RPC could not be read .*so your wallet was not asked to send this payment; nothing was sent/);
    const done = await s.engine.waitForAttempt(attempt.id, 5_000);
    expect(done).toMatchObject({ state: "failed", refusal: "chain" });
    expect(done.paymentMemo).toBeUndefined();
    // What to do next names the RPC and a new quote: no local wallet is involved.
    const next = nextFor(done, s.records.getQuote(done.quoteId));
    expect(next).not.toMatch(/local wallet|wallet serve/);
    expect(next).toMatch(/^Nothing was sent: the Tempo Moderato RPC could not be read before the owner's wallet was asked\. Check that RPC \(`SUPERSTABLES_TEMPO_RPC` when it is set, otherwise https:\/\/rpc\.moderato\.tempo\.xyz\), then take a new quote: `superstables quote .*`, then `superstables --wallet browser pay <new-quote-id>`\.$/);
  });

  it("takes no signer's word for a rejection once the wallet was asked to send", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    // A signer that asks the wallet to send, and then reports the owner's "no".
    const stub: Signer = {
      kind: "browser",
      address: async () => owner,
      async sign(req, hooks) {
        hooks?.onPending?.("w", "http://127.0.0.1:1/approve");
        const challenge = (req as TempoSignRequest).challenge;
        await hooks?.beforeWalletSends?.({ payer: owner, memo: mppMemo(challenge.id, challenge.realm) });
        throw new SignRefused("denied", "rejected by the owner in their wallet");
      },
    };
    const engine = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: stub, rpcUrl: s.chain.url });
    const final = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
    expect(final.state).toBe("uncertain");
    expect(final.reason).toBe("rejected by the owner in their wallet, after the owner's wallet was asked to send the payment, so whether it was sent is unknown");
  });

  it("does not call the seller when the wallet reports a transfer with another memo than the one it was asked to send", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: DEFAULT_POLICY });
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const other = mppMemo("another", "seller.example");
    // A wallet step that is asked for this payment's memo, and reports a transfer it made with another one.
    const stub: Signer = {
      kind: "browser",
      address: async () => owner,
      async sign(req, hooks) {
        hooks?.onPending?.("w", "http://127.0.0.1:1/approve");
        const challenge = (req as TempoSignRequest).challenge;
        await hooks?.beforeWalletSends?.({ payer: owner, memo: mppMemo(challenge.id, challenge.realm) });
        const hash = s.chain.mine({ from: owner, to: RECIPIENT, amount: 10_000n, memo: other, token: PATH_USD });
        return { kind: "tempo-transfer", hash, memo: other, signer: owner };
      },
    };
    const engine = new PaymentEngine({ records: s.records, policy: DEFAULT_POLICY, signer: stub, rpcUrl: s.chain.url });
    const final = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
    expect(final.state).toBe("uncertain");
    expect(final.reason).toMatch(/another payment than the one it was asked to send/);
    expect(final.paymentMemo).toBe(mppMemo(s.seller.issued.at(-1)!.id, "seller.example"));
    expect(s.seller.credentials).toHaveLength(0);
  });

  it("does not call the seller when the transaction the wallet reports is not this payment", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    const prepared = await postJson(`${link}/account`, { address: owner });
    await postJson(`${link}/sending`, { address: owner });
    // A transfer for another payment: another memo.
    const other = s.chain.mine({ from: owner, to: RECIPIENT, amount: 10_000n, memo: mppMemo("another", "seller.example"), token: prepared.body.transaction.to });
    await postJson(`${link}/sent`, { address: owner, hash: other });

    const done = await s.engine.waitForAttempt(attempt.id, 10_000);
    expect(done.state).toBe("uncertain");
    expect(done.chain).toBe("mismatch");
    expect(done.reason).toMatch(/does not show it as this payment.*the service was not called/);
    expect(s.seller.credentials).toHaveLength(0);
  });

  it("waits for a transaction the chain does not show yet, then pays the seller", async () => {
    const s = await stack();
    const { attempt, link, owner } = await startTempoPayment(s);
    const prepared = await postJson(`${link}/account`, { address: owner });
    await postJson(`${link}/sending`, { address: owner });
    const hash = s.chain.send(owner, prepared.body.transaction, { pending: true });
    await postJson(`${link}/sent`, { address: owner, hash });
    setTimeout(() => s.chain.confirm(hash), 2_000);
    const done = await s.engine.waitForAttempt(attempt.id, 15_000);
    expect(done.state).toBe("settled");
    expect(s.seller.paid).toHaveLength(1);
  });

  it("refuses to let the wallet be asked when the daily cap now refuses it: nothing is sent", async () => {
    const s = await stack({ policy: { perDay: { amount: 1, asset: "USDC" } } });
    const { attempt, link, owner } = await startTempoPayment(s);
    await postJson(`${link}/account`, { address: owner });
    // The reservation lapses while the owner reads the page, and meanwhile another payment spent the day's cap.
    s.clock.now += 20 * 60_000;
    const other = s.records.getAttempt(attempt.id)!;
    s.records.saveReceipt({
      id: "spent-elsewhere",
      // On the engine's day, which the moved clock may have turned over.
      at: new Date(s.clock.now).toISOString(),
      quoteId: "q",
      attemptId: "spent-elsewhere",
      url: "http://elsewhere",
      terms: { ...other.terms, asset: "USDC", amountDecimal: 1, amountAtomic: "1000000" },
      payer: owner,
      transaction: "",
      transactionKind: "pending",
      transactionUrl: "",
      network: "eip155:84532",
      settlement: { success: true, transaction: "", network: "eip155:84532" } as never,
      serviceOutcome: "ok",
      ms: 1,
    });
    const sending = await postJson(`${link}/sending`, { address: owner });
    expect(sending.status).toBe(409);
    expect(sending.body.error).toMatch(/caps\.per_day/);
    const done = await s.engine.waitForAttempt(attempt.id, 5_000);
    expect(done.state).toBe("failed");
    expect(done.refusal).toBe("policy");
    expect(s.seller.credentials).toHaveLength(0);
    expect(s.chain.transfers.size).toBe(0);
  });

  it("ends the approval before the seller's challenge expires", async () => {
    const s = await stack({ expiresIn: 90 });
    const { attempt, link } = await startTempoPayment(s);
    const state = await (await fetch(`${link}/state`)).json();
    // 90 s of challenge, less the minute the seller still needs once the payment is sent.
    expect(state.expiresAt - Date.now()).toBeLessThan(31_000);
    expect(s.engine.getAttempt(attempt.id)?.state).toBe("awaiting_approval");
    await postJson(`${link}/reject`, {});
  });

  it("refuses a challenge it cannot pay at quote time, naming why", async () => {
    const chain = await startFakeTempoPay();
    const seller = await startFakeMppSeller(chain, { recipient: RECIPIENT, request: (r) => ({ ...r, methodDetails: { chainId: 42431, splits: [{ recipient: RECIPIENT, amount: "1" }] } }) });
    opened.push(chain, seller);
    const records = new Records(mkdtempSync(join(home, "refuse-")));
    await expect(quote({ url: `${seller.url}/paid` }, { records, policy: DEFAULT_POLICY })).rejects.toThrow(/offers no payment this client can make/);
  });

  it("keeps pathUSD out when the owner's policy lists USDC only", async () => {
    const s = await stack();
    const q = await quote({ url: s.url }, { records: s.records, policy: { ...DEFAULT_POLICY, stablecoins: ["USDC"] } });
    expect(q.policy.allowed).toBe(false);
    expect(q.policy.reason).toBe("pathUSD is not in the policy's stablecoin list [USDC]");
  });
});

