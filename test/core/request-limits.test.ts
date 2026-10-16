// What `pay` will sign: an EVM authorization that lasts ten minutes at most, whatever window the seller allows, with the
// requirement sent back to the seller as offered; EIP-3009 offers only, with known `extra` fields; and a recipient that
// is not the zero address, the token or mint itself, or the account paying.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { Challenge } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_SEPOLIA, SOLANA_DEVNET, TEMPO_MODERATO, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { settleWith, verifyWith } from "../../src/core/facilitator.js";
import { parseMppChallenges } from "../../src/core/mpp.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { evmRail } from "../../src/core/rails/evm.js";
import { judgeTempoCharge } from "../../src/core/rails/tempo.js";
import { Records } from "../../src/core/records.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { buildTypedData, eip3009Step } from "../../src/core/signer/steps/eip3009.js";
import { solanaStep } from "../../src/core/signer/steps/solana.js";
import { tempoStep } from "../../src/core/signer/steps/tempo.js";
import type { StepRecord } from "../../src/core/signer/steps/types.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { sameTerms, termsFor, type RawAccept } from "../../src/core/x402.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { randomAddress } from "../helpers/fake-solana-pay.js";
import { sendJson, startFacilitator, startServer, type TestServer } from "../helpers/servers.js";

/** The longest an authorization signed by pay may last, in seconds. */
const CAP = 600;
const PAY_TO = `0x${"22".repeat(20)}`;
const nowS = () => Math.floor(Date.now() / 1000);
const offer = (over: Partial<RawAccept> = {}): RawAccept => ({ ...(usdcRequirement(0.01, PAY_TO) as unknown as RawAccept), ...over });

function evmRecord(accept: RawAccept, network: EvmNetwork = BASE_SEPOLIA): StepRecord {
  const judged = termsFor(accept, 2);
  if (!judged.supported) throw new Error(judged.reason);
  return { id: "x", kind: "eip3009", network, verified: { ...judged.terms, payer: "" }, requirement: judged.requirement, x402Version: 2, expiresAt: Date.now() + 60_000 };
}

const open: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("how long an EVM authorization signed by pay lasts", () => {
  it("builds the approval page's typed data for ten minutes at most when the seller allows an hour", () => {
    const before = nowS();
    const typed = buildTypedData(evmRecord(offer({ maxTimeoutSeconds: 3600 })), PAY_TO.replace("22", "33"));
    expect(Number(typed.message.validBefore) - before).toBeLessThanOrEqual(CAP + 1);
    expect(Number(typed.message.validBefore) - before).toBeGreaterThanOrEqual(CAP - 1);
  });

  it("keeps a seller's shorter window as it is", () => {
    const before = nowS();
    const typed = buildTypedData(evmRecord(offer({ maxTimeoutSeconds: 60 })), `0x${"33".repeat(20)}`);
    expect(Number(typed.message.validBefore) - before).toBeLessThanOrEqual(61);
  });

  it("asks the wallet for ten minutes at most, and sends the seller its requirement as offered", async () => {
    const judged = evmRail.judgeAccept(offer({ maxTimeoutSeconds: 3600 }), 2, BASE_SEPOLIA);
    if (!judged.supported) throw new Error(judged.reason);
    const request = evmRail.signRequest(judged.offer, 2, { target: "http://127.0.0.1/x" });
    if (request.kind !== "eip3009") throw new Error("kind");
    expect(request.requirements.maxTimeoutSeconds).toBe(CAP);
    // The local wallet's signer takes validBefore from that field.
    const before = nowS();
    const signed = await new LocalKeySigner(privateKeyToAccount(generatePrivateKey())).sign(request);
    expect(Number(signed.payload.authorization.validBefore) - before).toBeLessThanOrEqual(CAP + 1);
    // The seller matches the requirement it wrote exactly: it goes back unchanged.
    const header = evmRail.credentialHeaders(judged.offer, signed, { version: 2, resource: "", description: "", accepts: [] });
    expect(decodePaymentSignatureHeader(header["PAYMENT-SIGNATURE"]).accepted.maxTimeoutSeconds).toBe(3600);
    expect((judged.offer.requirement as PaymentRequirements).maxTimeoutSeconds).toBe(3600);
  });

  it("pays through the local wallet with a ten-minute authorization, and the seller takes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "superstables-limits-"));
    dirs.push(dir);
    const facilitator = await startFacilitator();
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const requirement = { ...usdcRequirement(0.01, payTo), maxTimeoutSeconds: 3600 };
    let paid: PaymentPayload | undefined;
    const seller: TestServer = await startServer(async (req, res) => {
      const credential = req.headers["payment-signature"];
      if (typeof credential !== "string") {
        const challenge = { x402Version: 2, error: "payment required", resource: { url: "http://127.0.0.1/x", description: "limits" }, accepts: [requirement] };
        res.writeHead(402, { "content-type": "application/json", "payment-required": encodePaymentRequiredHeader(challenge) });
        res.end(JSON.stringify(challenge));
        return;
      }
      paid = decodePaymentSignatureHeader(credential);
      const verified = await verifyWith(paid, requirement, [facilitator.url]);
      if (!verified.isValid) return sendJson(res, 402, { error: verified.invalidReason });
      const settled = await settleWith(paid, requirement, [facilitator.url]);
      sendJson(res, 200, { ok: true }, { "payment-response": encodePaymentResponseHeader(settled) });
    });
    const wallet: WalletHandle = await startWallet({
      port: 0, tcp: true, dir: join(dir, "wallet"), account: privateKeyToAccount(generatePrivateKey()), policy: DEFAULT_POLICY,
      quiet: true, openBrowser: false, balance: false, launcherDir: join(dir, "launcher"),
    });
    open.push(facilitator, seller, wallet);
    const records = new Records(join(dir, "home"));
    const engine = new PaymentEngine({
      records, policy: DEFAULT_POLICY, rpcUrl: "http://127.0.0.1:9",
      signer: new WalletSigner({ url: wallet.url, agentToken: wallet.agentToken, pollMs: 10, timeoutMs: 10_000 }),
    });
    const q = await quote({ url: `${seller.url}/v1/market` }, { records, policy: DEFAULT_POLICY });
    const attempt = engine.startPayment(q.id);
    const owner = { authorization: `Bearer ${wallet.ownerSecret}` };
    for (let i = 0; i < 400; i++) {
      const { requests } = (await (await fetch(`${wallet.url}/owner/requests`, { headers: owner })).json()) as { requests: { id: string; status: string }[] };
      const pending = requests.find((r) => r.status === "pending");
      if (pending) {
        expect((await fetch(`${wallet.url}/owner/requests/${pending.id}/approve`, { method: "POST", headers: owner })).status).toBe(200);
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const done = await engine.waitForAttempt(attempt.id, 15_000);
    expect(done.state).toBe("settled");
    expect(paid?.accepted.maxTimeoutSeconds).toBe(3600);
    const lifetime = Number((paid?.payload as { authorization: { validBefore: string } }).authorization.validBefore) - nowS();
    expect(lifetime).toBeLessThanOrEqual(CAP);
    expect(lifetime).toBeGreaterThan(CAP - 30);
    // The attempt counts against the daily cap until that time, not an hour.
    expect(Date.parse(done.authorizationValidBefore ?? "") / 1000 - nowS()).toBeLessThanOrEqual(CAP);
  });
});

describe("the seller's window is part of the terms", () => {
  it("is not the same payment when the window changes between quote and pay", () => {
    const quoted = termsFor(offer({ maxTimeoutSeconds: 300 }), 2);
    const paying = termsFor(offer({ maxTimeoutSeconds: 3600 }), 2);
    if (!quoted.supported || !paying.supported) throw new Error("fixture");
    expect(quoted.terms.maxTimeoutSeconds).toBe(300);
    expect(sameTerms(quoted.terms, paying.terms)).toBe(false);
    expect(sameTerms(quoted.terms, quoted.terms)).toBe(true);
  });

  it("asks for a new quote when a quote recorded without the window is paid", () => {
    const now = termsFor(offer(), 2);
    if (!now.supported) throw new Error("fixture");
    const { maxTimeoutSeconds: _, ...recordedBefore } = now.terms;
    expect(sameTerms(recordedBefore, now.terms)).toBe(false);
  });
});

describe("EIP-3009 offers only, with known fields", () => {
  it("refuses an offer that asks for another transfer method", () => {
    for (const method of ["permit2", "PERMIT2", "", 1]) {
      const judged = termsFor(offer({ extra: { name: "USDC", version: "2", assetTransferMethod: method } }), 2);
      expect(judged, String(method)).toMatchObject({ supported: false, reason: expect.stringMatching(/signs EIP-3009 transfers only/) });
    }
    expect(termsFor(offer({ extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }), 2).supported).toBe(true);
  });

  it("refuses unknown or malformed extra fields, and decimals that are not the token's", () => {
    expect(termsFor(offer({ extra: { name: "USDC", version: "2", spender: PAY_TO } }), 2)).toMatchObject({ supported: false, reason: expect.stringMatching(/signing fields this client does not use \(spender\)/) });
    expect(termsFor(offer({ extra: "permit2" as never }), 2)).toMatchObject({ supported: false, reason: expect.stringMatching(/extra fields are malformed/) });
    expect(termsFor(offer({ extra: [] as never }), 2)).toMatchObject({ supported: false });
    expect(termsFor(offer({ extra: { name: "USDC", version: "2", decimals: 18 } }), 2)).toMatchObject({ supported: false, reason: expect.stringMatching(/decimals/) });
    expect(termsFor(offer({ extra: { name: "USDC", version: "2", decimals: 6 } }), 2).supported).toBe(true);
    expect(termsFor(offer({ extra: {} }), 2).supported).toBe(true);
  });
});

describe("recipients on every rail", () => {
  const solanaAccept = (payTo: string): RawAccept => ({ scheme: "exact", network: SOLANA_DEVNET.caip2, amount: "10000", asset: SOLANA_DEVNET.token.address, payTo, maxTimeoutSeconds: 60, extra: { feePayer: randomAddress() } });
  const tempoChallenge = (recipient: string, details: Record<string, unknown> = {}) =>
    parseMppChallenges(Challenge.serialize(Challenge.from({
      id: "challenge-1", realm: "seller.example", method: "tempo", intent: "charge",
      request: { amount: "10000", currency: TEMPO_MODERATO.token.address, recipient, methodDetails: { chainId: 42431, ...details } },
      expires: new Date(Date.now() + 300_000).toISOString(),
    } as Parameters<typeof Challenge.from>[0])))[0];

  it("refuses a Solana payment to the all-zero address or to the mint", () => {
    expect(termsFor(solanaAccept("11111111111111111111111111111111"), 2)).toMatchObject({ supported: false, reason: expect.stringMatching(/all-zero address/) });
    expect(termsFor(solanaAccept(SOLANA_DEVNET.token.address), 2)).toMatchObject({ supported: false, reason: expect.stringMatching(/mint itself/) });
    expect(termsFor(solanaAccept(randomAddress()), 2).supported).toBe(true);
  });

  it("refuses a Tempo payment to the zero address or to pathUSD, and the machine-token route", () => {
    expect(judgeTempoCharge(tempoChallenge(`0x${"00".repeat(20)}`))).toMatchObject({ supported: false, reason: expect.stringMatching(/zero address/) });
    expect(judgeTempoCharge(tempoChallenge(TEMPO_MODERATO.token.address.toLowerCase()))).toMatchObject({ supported: false, reason: expect.stringMatching(/pathUSD contract itself/) });
    expect(judgeTempoCharge(tempoChallenge(PAY_TO, { machineTokenEnabled: true }))).toMatchObject({ supported: false, reason: expect.stringMatching(/machine-token/) });
    expect(judgeTempoCharge(tempoChallenge(PAY_TO, { machineTokenEnabled: false })).supported).toBe(true);
  });

  it("refuses to prepare a payment whose recipient is the connected account, on each wallet step", async () => {
    const evm = evmRecord(offer());
    const answer = await eip3009Step.prepare(evm, PAY_TO);
    expect(answer).toMatchObject({ http: 409, body: { error: expect.stringMatching(/recipient is the account paying/) } });
    expect(evm.prepared).toBeUndefined();
    expect((await eip3009Step.prepare(evm, `0x${"33".repeat(20)}`)).http).toBe(200);

    const tempoJudged = judgeTempoCharge(tempoChallenge(PAY_TO));
    if (!tempoJudged.supported) throw new Error(tempoJudged.reason);
    const tempo: StepRecord = { id: "t", kind: "tempo-transfer", network: TEMPO_MODERATO, verified: { ...tempoJudged.offer.terms, payer: "" }, requirement: tempoJudged.offer.requirement, x402Version: 2, expiresAt: Date.now() + 60_000 };
    expect(await tempoStep.prepare(tempo, PAY_TO)).toMatchObject({ http: 409, body: { error: expect.stringMatching(/recipient is the account paying/) } });
    expect(tempo.prepared).toBeUndefined();

    const owner = randomAddress();
    const accept = solanaAccept(owner);
    const solJudged = termsFor(accept, 2);
    if (!solJudged.supported) throw new Error(solJudged.reason);
    const solana: StepRecord = { id: "s", kind: "solana-transaction", network: SOLANA_DEVNET, verified: { ...solJudged.terms, payer: "" }, requirement: solJudged.requirement, x402Version: 2, expiresAt: Date.now() + 60_000 };
    expect(await solanaStep.prepare(solana, owner)).toMatchObject({ http: 409, body: { error: expect.stringMatching(/recipient is the account paying/) } });
  });
});
