// The Tempo rail (src/core/rails/tempo.ts): which tempo.charge challenges it pays, the one call the owner's wallet is
// asked to send, the credential it shows the seller, and how it reads the chain for the owner's transfer.

import { Challenge } from "mppx";
import { decodeFunctionData, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import * as Attribution from "../../node_modules/mppx/dist/tempo/Attribution.js";
import { Credential } from "mppx";
import { parseMppChallenges, type MppChallenge } from "../../src/core/mpp.js";
import { judgeMppChallenge, judgeOffers } from "../../src/core/rails/index.js";
import { judgeTempoCharge, mppMemo, tempoRail, transferCall } from "../../src/core/rails/tempo.js";
import type { PaymentFacts } from "../../src/core/rails/types.js";
import { PATH_USD, startFakeTempoPay, type FakeTempoPay } from "../helpers/fake-tempo-pay.js";

const RECIPIENT = "0x2222222222222222222222222222222222222222";
const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x3333333333333333333333333333333333333333";

function challenge(over: { request?: Record<string, unknown>; details?: Record<string, unknown>; expiresIn?: number; method?: string; intent?: string; header?: string } = {}): MppChallenge {
  const request = { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, ...over.request, methodDetails: { chainId: 42431, ...over.details } };
  const issued = Challenge.from({
    id: "challenge-1",
    realm: "seller.example",
    method: over.method ?? "tempo",
    intent: over.intent ?? "charge",
    request,
    expires: new Date(Date.now() + (over.expiresIn ?? 300) * 1000).toISOString(),
    ...(over.header ? { header: over.header } : {}),
  } as Parameters<typeof Challenge.from>[0]);
  return parseMppChallenges(Challenge.serialize(issued))[0];
}

const refusal = (c: MppChallenge) => {
  const judged = judgeMppChallenge(c);
  if (judged.supported) throw new Error("expected a refusal");
  return judged.reason;
};

describe("judging a tempo.charge challenge", () => {
  it("accepts pathUSD on Tempo Moderato and derives the terms from the challenge alone", () => {
    const judged = judgeMppChallenge(challenge());
    expect(judged.supported).toBe(true);
    if (!judged.supported) return;
    expect(judged.offer.rail).toBe("tempo");
    expect(judged.offer.terms).toEqual({
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "pathUSD",
      assetAddress: PATH_USD,
      network: "eip155:42431",
      networkLabel: "Tempo Moderato (testnet)",
      recipient: RECIPIENT,
      scheme: "charge",
    });
    // An offer of push and pull, or of push alone, or one that names no mode (both), is payable.
    expect(judgeTempoCharge(challenge({ details: { supportedModes: ["push"] } })).supported).toBe(true);
    expect(judgeTempoCharge(challenge({ details: { splits: [] } })).supported).toBe(true);
  });

  it("refuses every challenge it cannot pay, before the owner is asked, with a reason", () => {
    const cases: [MppChallenge, RegExp][] = [
      [challenge({ method: "stripe" }), /stripe\.charge is not supported/],
      [challenge({ intent: "session" }), /tempo\.session is not supported/],
      [challenge({ details: { chainId: 4217 } }), /Tempo \(mainnet\) is not supported: it is a mainnet/],
      [challenge({ details: { chainId: 31318 } }), /chain eip155:31318 is not supported for MPP/],
      [challenge({ details: { chainId: "42431" } }), /chain id is missing or malformed/],
      [challenge({ request: { currency: `0x20C0${"0".repeat(35)}1` } }), /currency is not pathUSD/],
      [challenge({ request: { decimals: 18 } }), /quotes 18 decimals/],
      [challenge({ request: { amount: "0" } }), /amount is missing or malformed/],
      [challenge({ request: { amount: "0.01" } }), /amount is missing or malformed/],
      [challenge({ request: { amount: 10000 } }), /amount is missing or malformed/],
      [challenge({ request: { recipient: "seller" } }), /recipient is missing or malformed/],
      [challenge({ details: { splits: [{ recipient: OTHER, amount: "1" }] } }), /split between several recipients/],
      [challenge({ details: { memo: `0x${"00".repeat(32)}` } }), /memo chosen by the seller/],
      // Any memo field, null and empty included: the memo is the client's own.
      [challenge({ details: { memo: null } }), /memo chosen by the seller/],
      [challenge({ details: { memo: "" } }), /memo chosen by the seller/],
      [challenge({ details: { supportedModes: ["pull"] } }), /push mode/],
      [challenge({ header: "X-Payment" }), /header of its own/],
      [challenge({ expiresIn: 30 }), /too soon to approve/],
      [challenge({ expiresIn: 7_200 }), /longer than this client approves/],
    ];
    for (const [c, reason] of cases) expect(refusal(c), JSON.stringify(c.request)).toMatch(reason);
    const noExpiry = { ...challenge() };
    delete noExpiry.expires;
    expect(refusal(noExpiry)).toMatch(/no expiry/);
  });

  it("refuses a challenge larger than superstables.com takes (4,000 characters as mppx writes it), and takes one just under", () => {
    // The size is the challenge as mppx holds it: without the raw request this client also keeps.
    const sized = (chars: number) => {
      const base = challenge();
      const without = JSON.stringify({ ...base, requestRaw: undefined }).length;
      return challenge({ request: { pad: "x".repeat(Math.max(0, chars - without - 10)) } });
    };
    const size = (c: MppChallenge) => JSON.stringify({ ...c, requestRaw: undefined }).length;
    const under = sized(3_990);
    expect(size(under)).toBeLessThanOrEqual(4_000);
    expect(judgeMppChallenge(under).supported).toBe(true);
    let over = sized(4_001);
    while (size(over) <= 4_000) over = challenge({ request: { pad: `${(over.request as { pad: string }).pad}x` } });
    expect(size(over)).toBe(4_001);
    expect(refusal(over)).toBe("the challenge is too large");
  });

  it("is judged next to x402 offers, after them, in one 402", () => {
    const judged = judgeOffers({ mpp: [challenge({ method: "stripe" }), challenge()], description: "" });
    expect(judged.map((j) => j.offered)).toEqual(["MPP stripe.charge on Tempo Moderato (testnet)", "MPP tempo.charge on Tempo Moderato (testnet)"]);
    expect(judged.map((j) => j.judged.supported)).toEqual([false, true]);
  });
});

describe("the wallet's call and the seller's credential", () => {
  it("binds the memo to the challenge exactly as mppx does", () => {
    const memo = mppMemo("challenge-1", "seller.example");
    expect(memo).toBe(Attribution.encode({ challengeId: "challenge-1", serverId: "seller.example" }));
    expect(Attribution.verifyChallengeBinding(memo, "challenge-1")).toBe(true);
    expect(Attribution.verifyServer(memo, "seller.example")).toBe(true);
  });

  it("asks the wallet for one pathUSD transferWithMemo to the recipient, for the amount, with the memo, and no value", () => {
    const memo = mppMemo("challenge-1", "seller.example");
    const call = transferCall({ from: PAYER, recipient: RECIPIENT, amountAtomic: "10000", memo });
    expect(call.to).toBe(PATH_USD);
    expect(call.value).toBe("0x0");
    expect(call.data.slice(0, 10)).toBe("0x95777d59");
    const decoded = decodeFunctionData({
      abi: [{ type: "function", name: "transferWithMemo", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "memo", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" }],
      data: call.data,
    });
    expect(decoded.args).toEqual([RECIPIENT, 10000n, memo]);
  });

  it("shows the seller an Authorization credential naming the owner's transaction, the challenge and the payer", () => {
    const c = challenge();
    const judged = judgeTempoCharge(c);
    if (!judged.supported) throw new Error("fixture");
    const hash = `0x${"ab".repeat(32)}`;
    const headers = tempoRail.credentialHeaders(judged.offer, { kind: "tempo-transfer", hash, memo: mppMemo(c.id, c.realm), signer: PAYER });
    expect(Object.keys(headers)).toEqual(["Authorization"]);
    const parsed = Credential.deserialize(headers.Authorization);
    expect(parsed.payload).toEqual({ hash, type: "hash" });
    expect(parsed.source).toBe(`did:pkh:eip155:42431:${PAYER}`);
    expect(parsed.challenge.id).toBe(c.id);
    expect(tempoRail.signRequest(judged.offer, 2, { target: "http://seller" })).toEqual({ kind: "tempo-transfer", challenge: c, context: { target: "http://seller" } });
    expect(tempoRail.signedFacts({ kind: "tempo-transfer", hash, memo: "0xmemo", signer: PAYER })).toEqual({ paymentMemo: "0xmemo" });
  });
});

describe("reading the chain for the owner's transfer", () => {
  let chain: FakeTempoPay | undefined;
  afterEach(async () => {
    await chain?.close();
    chain = undefined;
  });

  const memo = mppMemo("challenge-1", "seller.example");
  const facts = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
    network: "eip155:42431",
    payer: PAYER,
    recipient: RECIPIENT,
    amountAtomic: "10000",
    memo,
    since: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  });
  const options = () => ({ rpcUrlFor: () => chain!.url });

  it("verifies the transaction that moved exactly this pathUSD, to this recipient, from the owner, with this memo", async () => {
    chain = await startFakeTempoPay();
    const hash = chain.mine({ from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD });
    expect(await tempoRail.checkPayment(facts({ transaction: hash }), options())).toEqual({ chain: "verified" });
  });

  it("reports a mismatch for another amount, recipient, payer, token or memo, or a reverted transaction", async () => {
    chain = await startFakeTempoPay();
    const wrong = [
      { from: PAYER, to: RECIPIENT, amount: 9999n, memo, token: PATH_USD },
      { from: PAYER, to: OTHER, amount: 10000n, memo, token: PATH_USD },
      { from: OTHER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD },
      { from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: `0x20C0${"0".repeat(35)}1` },
      { from: PAYER, to: RECIPIENT, amount: 10000n, memo: mppMemo("challenge-2", "seller.example"), token: PATH_USD },
      { from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD, reverted: true },
    ];
    for (const transfer of wrong) {
      const hash = chain.mine(transfer);
      const check = await tempoRail.checkPayment(facts({ transaction: hash }), options());
      expect(check.chain, JSON.stringify({ ...transfer, amount: String(transfer.amount) })).toBe("mismatch");
      expect(check.reason).toBeTruthy();
    }
  });

  it("leaves it unchecked when the transaction is not on chain yet, the RPC is down, or no hash or memo was recorded", async () => {
    chain = await startFakeTempoPay();
    expect(await tempoRail.checkPayment(facts({ transaction: `0x${"cd".repeat(32)}` }), options())).toEqual({ chain: "unchecked", reason: "the chain does not show the transaction yet" });
    expect((await tempoRail.checkPayment(facts({ transaction: "not a hash" }), options())).reason).toBe("no transaction hash was given");
    expect((await tempoRail.checkPayment(facts({ transaction: `0x${"cd".repeat(32)}`, memo: undefined }), options())).reason).toMatch(/memo was not recorded/);
    chain.down = true;
    expect((await tempoRail.checkPayment(facts({ transaction: `0x${"cd".repeat(32)}` }), options())).chain).toBe("unchecked");
  });

  it("finds a payment nobody reported by its memo, and says so when there is none", async () => {
    chain = await startFakeTempoPay();
    expect(await tempoRail.findPayment!(facts(), options())).toEqual({ found: false, reason: "the chain shows no transfer with this payment's memo" });
    // Another transfer to the same seller, of the same amount, does not count: it carries another memo.
    chain.mine({ from: PAYER, to: RECIPIENT, amount: 10000n, memo: mppMemo("challenge-0", "seller.example"), token: PATH_USD });
    expect((await tempoRail.findPayment!(facts(), options())).found).toBe(false);
    const hash = chain.mine({ from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD });
    expect(await tempoRail.findPayment!(facts(), options())).toEqual({ found: true, transaction: hash });
    // With the hash known, it is read first.
    expect(await tempoRail.findPayment!(facts({ transaction: hash }), options())).toEqual({ found: true, transaction: hash });
    chain.down = true;
    expect(await tempoRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
    // A node with no latest block to give: it could not read the chain, not "no transfer".
    chain.down = false;
    chain.headless = true;
    expect(await tempoRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/could not be read/) });
    await expect(tempoRail.headBlock(options())).rejects.toThrow();
  });

  it("never takes a transfer mined before the wallet was asked, however alike, nor one another attempt was paid with", async () => {
    chain = await startFakeTempoPay();
    // An earlier transfer with this memo (a seller that handed out the same challenge twice): the same facts exactly.
    const older = chain.mine({ from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD });
    // The wallet is asked after it: the head the client read then is the boundary.
    const boundary = String(await tempoRail.headBlock(options()));
    expect(boundary).toBe(String(chain.head.number));
    expect(await tempoRail.findPayment!(facts({ searchFromBlock: boundary }), options())).toEqual({ found: false, reason: "the chain shows no transfer with this payment's memo" });
    expect(await tempoRail.findPayment!(facts({ searchFromBlock: boundary, transaction: older }), options())).toMatchObject({ found: false });
    expect(await tempoRail.checkPayment(facts({ searchFromBlock: boundary, transaction: older }), options())).toEqual({
      chain: "mismatch",
      reason: "the transaction was mined before the owner's wallet was asked to send this payment",
    });
    // An attempt recorded without the boundary is held to when its wallet was asked, by the chain's clock.
    const askedAt = new Date((chain.head.timestamp + 1) * 1000).toISOString();
    expect((await tempoRail.findPayment!(facts({ since: askedAt }), options())).found).toBe(false);
    const ours = chain.mine({ from: PAYER, to: RECIPIENT, amount: 10000n, memo, token: PATH_USD });
    expect(await tempoRail.findPayment!(facts({ searchFromBlock: boundary }), options())).toEqual({ found: true, transaction: ours });
    expect(await tempoRail.findPayment!(facts({ since: askedAt }), options())).toEqual({ found: true, transaction: ours });
    // The one transfer after the boundary is already another attempt's payment: never this one's.
    expect(await tempoRail.findPayment!(facts({ searchFromBlock: boundary, attributed: [ours.toUpperCase().replace("0X", "0x")] }), options())).toMatchObject({ found: false });
  });
});

describe("the memo transfer the seller's own mppx would check", () => {
  it("is a memo mppx recognises as bound to this challenge and this realm", () => {
    const c = challenge();
    const memo = mppMemo(c.id, c.realm) as Hex;
    expect(Attribution.isMppMemo(memo)).toBe(true);
    expect(Attribution.verifyChallengeBinding(memo, "another-challenge")).toBe(false);
  });
});
