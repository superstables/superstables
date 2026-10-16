// The chain gate (src/core/chain-gate.js) in front of everything `pay` signs: quoting, the payment engine's offer, the
// browser signer's page and the local wallet's key. The chain table is replaced here by one that also names a copy of
// Base Sepolia that is not a testnet ("gated-base", chain 8453), and a Tempo Moderato whose testnet flag a test can turn
// off: whatever a chain table says, nothing is signed or asked for on a chain that is not marked as a testnet.

import { Challenge } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ tempoTestnet: true }));

vi.mock("../../src/core/chain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/chain.js")>();
  const gated = { ...real.BASE_SEPOLIA, key: "gated-base", caip2: "eip155:8453", chainId: 8453, v1Name: "", label: "Gated Base", testnet: false };
  const tempo = { ...real.TEMPO_MODERATO, get testnet() { return state.tempoTestnet; } };
  const evm = [...real.EVM_NETWORKS, gated];
  const known = [...evm, tempo, real.SOLANA_DEVNET];
  const networkFor = (name: string) => (name ? known.find((n) => n.caip2 === name || (n.v1Name !== "" && n.v1Name === name)) : undefined);
  return {
    ...real,
    EVM_NETWORKS: evm,
    TEMPO_MODERATO: tempo,
    KNOWN_NETWORKS: known,
    networkFor,
    evmNetworkFor: (name: string) => { const found = networkFor(name); return found?.rail === "evm" ? found : undefined; },
  };
});

import { MAINNET_SIGNING, chainGate, chainGateSettings } from "../../src/core/chain-gate.js";
import { BASE_SEPOLIA, KNOWN_NETWORKS, networkFor, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { parseMppChallenges, type MppChallenge } from "../../src/core/mpp.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";
import { firstPayable, judgeAccept, judgeMppChallenge, judgeSignRequest } from "../../src/core/rails/index.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { SignRefused } from "../../src/core/signer/types.js";
import { termsFor, type RawAccept, type SellerChallenge } from "../../src/core/x402.js";

const REFUSED = /^this client does not sign on mainnet chains: the evm chain gated-base is not marked as a testnet/;
const PAY_TO = `0x${"22".repeat(20)}`;
const GATED = networkFor("eip155:8453") as EvmNetwork;
const gatedOffer = () => usdcRequirement(0.01, PAY_TO, GATED);
const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
afterEach(() => { state.tempoTestnet = true; });

function tempoCharge(): MppChallenge {
  const issued = Challenge.from({
    id: "challenge-1", realm: "seller.example", method: "tempo", intent: "charge",
    request: { amount: "10000", currency: "0x20C0000000000000000000000000000000000000", recipient: PAY_TO, methodDetails: { chainId: 42431 } },
    expires: new Date(Date.now() + 300_000).toISOString(),
  } as Parameters<typeof Challenge.from>[0]);
  return parseMppChallenges(Challenge.serialize(issued))[0];
}

describe("chainGate", () => {
  it("lets a testnet through and refuses anything else, whatever the settings say, in this build", () => {
    expect(MAINNET_SIGNING).toBe(false);
    expect(chainGateSettings()).toBeUndefined();
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true }, undefined)).toBe("");
    for (const testnet of [false, undefined, "true", 1, null]) {
      expect(chainGate({ rail: "evm", key: "base", testnet }, undefined), String(testnet)).toMatch(/^this client does not sign on mainnet chains/);
    }
    expect(chainGate({ rail: "evm", key: "base", testnet: false }, { enabledChains: ["base"], missing: { base: [] } })).toMatch(/does not sign on mainnet chains/);
  });

  it("passes every chain the client ships", () => {
    for (const n of KNOWN_NETWORKS.filter((k) => k.key !== "gated-base")) expect(chainGate({ rail: n.rail, key: n.key, testnet: n.testnet }, undefined), n.key).toBe("");
  });
});

describe("a chain table entry that is not a testnet", () => {
  it("quote and pay: the offer is refused, and a seller offering a testnet too is paid there", () => {
    const judged = judgeAccept(gatedOffer(), 2);
    expect(judged.supported).toBe(false);
    if (!judged.supported) expect(judged.reason).toMatch(REFUSED);
    expect(judgeAccept(usdcRequirement(0.01, PAY_TO, BASE_SEPOLIA), 2).supported).toBe(true);
    expect(termsFor(gatedOffer(), 2).supported).toBe(false);
    const challenge = (accepts: RawAccept[]): SellerChallenge => ({ x402: { version: 2, resource: "https://seller.example/x", description: "", accepts }, mpp: [], description: "" });
    expect(firstPayable(challenge([gatedOffer()]))).toBeUndefined();
    expect(firstPayable(challenge([gatedOffer(), usdcRequirement(0.01, PAY_TO, BASE_SEPOLIA)]))?.terms.network).toBe(BASE_SEPOLIA.caip2);
  });

  it("a signer's own check refuses it, for x402 and for MPP", () => {
    const signed = judgeSignRequest({ kind: "eip3009", requirements: gatedOffer(), x402Version: 2 });
    expect(signed.supported).toBe(false);
    expect(judgeMppChallenge(tempoCharge()).supported).toBe(true);
    state.tempoTestnet = false;
    const mpp = judgeMppChallenge(tempoCharge());
    expect(mpp.supported).toBe(false);
    if (!mpp.supported) expect(mpp.reason).toMatch(/does not sign on mainnet chains: the tempo chain tempo-moderato/);
    expect(judgeSignRequest({ kind: "tempo-transfer", challenge: tempoCharge() }).supported).toBe(false);
  });

  it("the local wallet's key does not sign it", async () => {
    const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
    const refused = await signer.sign({ kind: "eip3009", requirements: gatedOffer(), x402Version: 2 }).catch((e) => e);
    expect(refused).toBeInstanceOf(SignRefused);
    expect(refused).toMatchObject({ code: "invalid" });
    expect(refused.message).toMatch(REFUSED);
    await expect(signer.sign({ kind: "eip3009", requirements: usdcRequirement(0.01, PAY_TO, BASE_SEPOLIA), x402Version: 2 })).resolves.toMatchObject({ kind: "eip3009" });
  });

  it("the browser signer refuses it before any approval page exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "ss-chain-gate-"));
    homes.push(home);
    const signer = new BrowserWalletSigner({ port: 0, home, policy: DEFAULT_POLICY, timeoutMs: 1_500, balance: false });
    const hooks = { beforeAsk: vi.fn(async () => undefined), onPending: vi.fn() };
    try {
      const refused = await signer.sign({ kind: "eip3009", requirements: gatedOffer(), x402Version: 2 }, hooks).catch((e) => e);
      expect(refused).toBeInstanceOf(SignRefused);
      expect(refused).toMatchObject({ code: "invalid" });
      expect(refused.message).toMatch(REFUSED);
      expect(signer.url).toBe("");
      expect(hooks.beforeAsk).not.toHaveBeenCalled();
      expect(hooks.onPending).not.toHaveBeenCalled();
    } finally {
      await signer.close();
    }
  });

  it("pay: a quote on it, saved before the gate existed, never reaches the signer", async () => {
    const home = mkdtempSync(join(tmpdir(), "ss-chain-gate-pay-"));
    homes.push(home);
    const records = new Records(join(home, "records"));
    const base = termsFor(usdcRequirement(0.01, PAY_TO, BASE_SEPOLIA), 2);
    if (!base.supported) throw new Error(base.reason);
    const url = "http://127.0.0.1:9/x";
    const now = Date.now();
    records.saveQuote({
      id: "q-gated", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), status: "open", url,
      terms: { ...base.terms, network: GATED.caip2, networkLabel: GATED.label }, requirement: gatedOffer(), policy: { allowed: true }, approval: "wallet",
    });
    const sign = vi.fn(async () => { throw new SignRefused("denied", "the test signer refuses"); });
    const signer: Signer = { kind: "local", address: async () => PAY_TO, sign };
    const paymentRequired = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [gatedOffer()] })).toString("base64");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": paymentRequired } }));
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5_000 });
    const attempt = engine.startPayment("q-gated");
    const done = await engine.waitForAttempt(attempt.id, 10_000);
    expect(fetchImpl).toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(done).toMatchObject({ state: "failed", reason: "terms changed, quote again" });
  });
});
