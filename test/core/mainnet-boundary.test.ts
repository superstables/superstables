// The mainnet boundary at the signers, with a manifest injected for this file only: a made-up mainnet "testmain"
// (chain 990001), approved and live, with caps of 1 token per signature and 2.5 tokens per 24 hours. Nothing here
// touches a real chain: the signer is a key made in memory, and the manifest is a mock. Every test checks the property
// at the place the key signs: past a cap or a pause, the key is never asked.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/core/mainnet-manifest.js", () => ({
  MAINNET_MANIFEST: {
    schema: 1,
    signing: "live",
    chains: {
      testmain: {
        status: "approved",
        rail: "evm",
        chainId: 990001,
        label: "Example Main",
        explorer: "https://explorer.testmain.example",
        blockSeconds: 2,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpc: { url: "https://rpc.testmain.example", source: "https://docs.testmain.example/rpc" },
        token: { symbol: "USDC", address: "0xabababababababababababababababababababab", decimals: 6, domain: { name: "USD Coin", version: "2" }, approveReset: false, source: ["https://docs.testmain.example/usdc"] },
        permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", use: "refused", source: "https://docs.testmain.example/permit2" },
        allowanceSpenders: [],
        caps: { perGrantAtomic: "1000000", perDayAtomic: "2500000" },
        sources: { chainId: "https://docs.testmain.example/chain", explorer: "https://docs.testmain.example/explorer" },
        approval: { by: "a human", date: "2026-10-29", evidence: "https://example.com/review" },
      },
    },
  },
}));

vi.mock("../../src/core/finality-policy.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/finality-policy.js")>();
  return { ...real, finalityProfile: (rail: string, chain: string) => (chain === "testmain" ? { kind: "finalized", typicalSeconds: 12 } : real.finalityProfile(rail, chain)) };
});

// The payment engine reads the token's signing domain on chain before it asks anyone; "testmain" has no chain to read.
vi.mock("../../src/core/token-domain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/token-domain.js")>();
  return { ...real, tokenDomainProblem: async () => "" };
});

import { MAINNET_SIGNING, setChainGateSource, setPrerequisiteCheck } from "../../src/core/chain-gate.js";
import { BASE_SEPOLIA, EVM_NETWORKS, networkFor, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { manifestState } from "../../src/core/mainnet-policy.js";
import { MAINNET_LEDGER, MAINNET_PAUSE_FILE, heldToday, mainnetSendRefusal, type MainnetHold } from "../../src/core/mainnet-spend.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";
import { termsFor } from "../../src/core/x402.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { SignRefused } from "../../src/core/signer/types.js";

const PAY_TO = `0x${"22".repeat(20)}`;
const TESTMAIN = networkFor("eip155:990001") as EvmNetwork;
const homes: string[] = [];
let h = "";
afterAll(() => { for (const d of homes) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => {
  h = mkdtempSync(join(tmpdir(), "mainnet-boundary-"));
  homes.push(h);
  vi.stubEnv("SUPERSTABLES_HOME", h);
  vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "");
  setChainGateSource(() => ({ enabledChains: ["testmain"] }));
  setPrerequisiteCheck("ownerRpc", () => true);
  setPrerequisiteCheck("agentKeyStore", () => true);
});
afterEach(() => vi.unstubAllEnvs());

/** A key whose every signing request is counted, so a test can say the key was never asked. */
function countedSigner(fail = false) {
  const account = privateKeyToAccount(generatePrivateKey());
  let asked = 0;
  const counted = { ...account, signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => { asked++; if (fail) throw new Error("the device went away"); return account.signTypedData(args); } };
  return { signer: new LocalKeySigner(counted as typeof account), asked: () => asked };
}
const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const request = (amount: number, n: number, network: EvmNetwork = TESTMAIN) =>
  ({ kind: "eip3009", x402Version: 2, requirements: usdcRequirement(amount, PAY_TO, network), nonce: nonce(n) }) as Parameters<LocalKeySigner["sign"]>[0];
const ledger = (): MainnetHold[] => (existsSync(join(h, MAINNET_LEDGER)) ? JSON.parse(readFileSync(join(h, MAINNET_LEDGER), "utf8")).holds : []);
const refusedWith = async (p: Promise<unknown>, reason: RegExp) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SignRefused);
  expect((err as Error).message).toMatch(reason);
};

describe("an injected live manifest", () => {
  it("adds its approved chain to the table as a mainnet, after the testnets, which are unchanged", () => {
    expect(manifestState().state).toBe("live");
    expect(MAINNET_SIGNING).toBe(true);
    expect(TESTMAIN).toMatchObject({ key: "testmain", chainId: 990001, testnet: false });
    expect(EVM_NETWORKS.slice(0, 7).every((n) => n.testnet === true)).toBe(true);
    expect(EVM_NETWORKS.at(-1)?.key).toBe("testmain");
  });
});

describe("caps at the local key signer", () => {
  it("signs within the caps and records the signature as held", async () => {
    const { signer, asked } = countedSigner();
    const signed = await signer.sign(request(1, 1));
    expect(signed.payload.signature).toMatch(/^0x/);
    expect(asked()).toBe(1);
    expect(ledger()).toMatchObject([{ chain: "testmain", amountAtomic: "1000000", state: "signed" }]);
  });

  it("refuses one payment above the per-grant cap without asking the key", async () => {
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(1.000001, 1)), /above testmain's cap of 1000000 for one payment or grant/);
    expect(asked()).toBe(0);
    expect(ledger()).toEqual([]);
  });

  it("refuses the payment that would pass the 24-hour cap, without asking the key", async () => {
    const { signer, asked } = countedSigner();
    await signer.sign(request(1, 1));
    await signer.sign(request(1, 2));
    await refusedWith(signer.sign(request(1, 3)), /would reach 3000000 in 24 hours, above its cap of 2500000/);
    expect(asked()).toBe(2);
    await signer.sign(request(0.5, 4));
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_500_000n);
  });

  it("does not count a retry of the same signature twice", async () => {
    const { signer, asked } = countedSigner();
    await signer.sign(request(1, 7));
    await signer.sign(request(1, 7));
    expect(asked()).toBe(2);
    expect(ledger()).toHaveLength(1);
    await signer.sign(request(1, 8));
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
  });

  it("refuses a retry that reuses a nonce for another amount", async () => {
    const { signer } = countedSigner();
    await signer.sign(request(0.5, 9));
    await refusedWith(signer.sign(request(0.6, 9)), /already holds another amount/);
  });

  it("lets only as many concurrent payments through as the cap holds", async () => {
    const { signer, asked } = countedSigner();
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => signer.sign(request(1, 100 + n))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof SignRefused)).toBe(true);
    expect(asked()).toBe(2);
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
  });

  it("counts a reservation a stopped process left pending, until its 24 hours pass", async () => {
    const now = Date.now();
    writeFileSync(join(h, MAINNET_LEDGER), JSON.stringify({ holds: [
      { opId: "crashed", chain: "testmain", amountAtomic: "2000000", at: now - 60 * 60 * 1000, state: "reserved" },
      { opId: "old", chain: "testmain", amountAtomic: "2500000", at: now - 25 * 60 * 60 * 1000, state: "signed" },
    ] }));
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(1, 11)), /would reach 3000000 in 24 hours/);
    await signer.sign(request(0.5, 12));
    expect(asked()).toBe(1);
  });

  it("releases a reservation when the key failed before any signature existed", async () => {
    const failing = countedSigner(true);
    await expect(failing.signer.sign(request(1, 21))).rejects.toThrow(/device went away/);
    expect(ledger()).toMatchObject([{ opId: expect.stringContaining("eip3009:testmain:"), state: "released" }]);
    const { signer } = countedSigner();
    await signer.sign(request(1, 22));
    await signer.sign(request(1, 23));
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
  });

  it("refuses when the ledger cannot be read, and leaves it as it is", async () => {
    writeFileSync(join(h, MAINNET_LEDGER), "{not json");
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(0.1, 31)), /ledger .* is not valid/);
    expect(asked()).toBe(0);
    expect(readFileSync(join(h, MAINNET_LEDGER), "utf8")).toBe("{not json");
  });

  it("still lets the owner's settings decide: a chain they do not enable is refused", async () => {
    setChainGateSource(() => ({ enabledChains: [] }));
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(0.1, 41)), /do not enable signing on it/);
    expect(asked()).toBe(0);
  });
});

describe("the pause at the local key signer and at sending", () => {
  it("stops the next signature at once when the pause file appears, and lets it through when it goes", async () => {
    const { signer, asked } = countedSigner();
    await signer.sign(request(0.1, 51));
    writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
    await refusedWith(signer.sign(request(0.1, 52)), /paused: the pause file .* exists/);
    expect(mainnetSendRefusal(TESTMAIN)).toMatch(/paused/);
    expect(asked()).toBe(1);
    rmSync(join(h, MAINNET_PAUSE_FILE));
    await signer.sign(request(0.1, 53));
    expect(mainnetSendRefusal(TESTMAIN)).toBe("");
    expect(asked()).toBe(2);
  });

  it("stops the next signature while SUPERSTABLES_MAINNET_PAUSE is set", async () => {
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "1");
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(0.1, 61)), /SUPERSTABLES_MAINNET_PAUSE is set/);
    expect(asked()).toBe(0);
    expect(ledger()).toEqual([]);
  });

  it("never stops a testnet", async () => {
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "1");
    writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
    const { signer, asked } = countedSigner();
    await signer.sign(request(5, 71, BASE_SEPOLIA));
    expect(asked()).toBe(1);
    expect(mainnetSendRefusal(BASE_SEPOLIA)).toBe("");
    expect(existsSync(join(h, MAINNET_LEDGER))).toBe(false);
  });
});

describe("sending a signature made before a pause", () => {
  it("keeps it on this computer: the seller never receives it", async () => {
    const records = new Records(join(h, "records"));
    const offer = usdcRequirement(0.01, PAY_TO, TESTMAIN);
    const judged = termsFor(offer, 2);
    if (!judged.supported) throw new Error(judged.reason);
    const url = "http://127.0.0.1:9/x";
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith({ version: 1, sellers: { allowLoopback: true } }));
    const now = Date.now();
    records.saveQuote({
      id: "q-main", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(), status: "open", url,
      terms: judged.terms, requirement: offer, policy: { allowed: true }, approval: "wallet",
    });
    // The owner signs; in the moment before the payment is sent, the pause file appears.
    const { signer: key, asked } = countedSigner();
    const signer: Signer = { kind: "local", address: async () => PAY_TO, sign: (async (req: Parameters<LocalKeySigner["sign"]>[0]) => {
      const signed = await key.sign(req);
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      return signed;
    }) as Signer["sign"] };
    const paymentRequired = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url }, accepts: [offer] })).toString("base64");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": paymentRequired } }));
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 5_000 });
    const attempt = engine.startPayment("q-main");
    const done = await engine.waitForAttempt(attempt.id, 10_000);
    expect(asked()).toBe(1);
    expect(done).toMatchObject({ state: "failed", reason: expect.stringMatching(/mainnet signing stopped after the owner signed .* not sent/) });
    const sent = fetchImpl.mock.calls.filter((c) => JSON.stringify(c).match(/payment-signature|x-payment/i));
    expect(sent).toEqual([]);
  });
});

describe("the approval page (browser signer)", () => {
  const policy = { ...DEFAULT_POLICY, perCall: { amount: 10, asset: "USDC", atomic: "10000000" }, perDay: { amount: 100, asset: "USDC", atomic: "100000000" } };
  const pageSigner = () => new BrowserWalletSigner({ port: 0, home: h, policy, timeoutMs: 300, balance: false });

  it("reserves the amount before any page is offered, and keeps it counted whatever the page reports", async () => {
    const signer = pageSigner();
    let heldWhenOffered = -1n;
    const hooks = { onPending: vi.fn(() => { heldWhenOffered = heldToday(ledger(), "testmain", Date.now()); }) };
    try {
      await expect(signer.sign(request(1, 81), hooks)).rejects.toBeInstanceOf(SignRefused);
      expect(hooks.onPending).toHaveBeenCalledTimes(1);
      expect(heldWhenOffered).toBe(1_000_000n);
      expect(ledger()).toMatchObject([{ opId: `page:testmain:${nonce(81)}`, state: "signed" }]);
    } finally {
      await signer.close();
    }
  });

  it("offers no page past the 24-hour cap or during a pause", async () => {
    writeFileSync(join(h, MAINNET_LEDGER), JSON.stringify({ holds: [{ opId: "earlier", chain: "testmain", amountAtomic: "2000000", at: Date.now(), state: "signed" }] }));
    const signer = pageSigner();
    const hooks = { onPending: vi.fn() };
    try {
      await refusedWith(signer.sign(request(1, 82), hooks), /would reach 3000000 in 24 hours/);
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      await refusedWith(signer.sign(request(0.1, 83), hooks), /paused/);
      // The page's server may be up, but no approval was created: nothing was offered to a wallet.
      expect(hooks.onPending).not.toHaveBeenCalled();
    } finally {
      await signer.close();
    }
  });
});

describe("caps across processes", () => {
  it("lets only as many payments through as the cap holds when separate processes reserve at once", async () => {
    const child = resolve(__dirname, "../helpers/mainnet-reserve-child.ts");
    const tsx = resolve(__dirname, "../../node_modules/.bin/tsx");
    const run = (n: number) => new Promise<string>((done, fail) => {
      const p = spawn(tsx, [child, `op-${n}`, "1000000"], { env: { ...process.env, SUPERSTABLES_HOME: h }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.on("error", fail);
      p.on("close", () => done(out.trim()));
    });
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(run));
    expect(outcomes.filter((o) => o === "held")).toHaveLength(2);
    expect(outcomes.filter((o) => o.startsWith("refused:"))).toHaveLength(3);
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
  }, 60_000);
});
