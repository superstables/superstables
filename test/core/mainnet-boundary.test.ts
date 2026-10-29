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

import { MAINNET_SIGNING, chainGate, setChainGateSource, setPrerequisiteCheck } from "../../src/core/chain-gate.js";
import { judgeAccept } from "../../src/core/rails/index.js";
import { BASE_SEPOLIA, EVM_NETWORKS, networkFor, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { manifestState } from "../../src/core/mainnet-policy.js";
import { MAINNET_LEDGER, MAINNET_PAUSE_FILE, heldToday, mainnetSendRefusal, type MainnetHold } from "../../src/core/mainnet-spend.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";
import { termsFor } from "../../src/core/x402.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import { ApprovalServer } from "../../src/core/signer/approval-server.js";
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
    expect(ledger()).toMatchObject([{ chain: "testmain", amountAtomic: "1000000", what: `eip3009:testmain:${String(signed.payload.authorization.from).toLowerCase()}:${nonce(1)}` }]);
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

  it("counts a retry of the same nonce again: each one is a new authorization", async () => {
    const { signer, asked } = countedSigner();
    await signer.sign(request(1, 7));
    await signer.sign(request(1, 7));
    expect(asked()).toBe(2);
    expect(new Set(ledger().map((x) => x.id)).size).toBe(2);
    await refusedWith(signer.sign(request(1, 8)), /would reach 3000000 in 24 hours/);
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
      { id: "crashed", what: "eip3009:testmain:0x1:0x1", chain: "testmain", amountAtomic: "2000000", at: now - 60 * 60 * 1000 },
      { id: "old", what: "eip3009:testmain:0x1:0x2", chain: "testmain", amountAtomic: "2500000", at: now - 25 * 60 * 60 * 1000 },
    ] }));
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(1, 11)), /would reach 3000000 in 24 hours/);
    await signer.sign(request(0.5, 12));
    expect(asked()).toBe(1);
  });

  it("refuses when the ledger cannot be read, and leaves it as it is", async () => {
    writeFileSync(join(h, MAINNET_LEDGER), "{not json");
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(0.1, 31)), /ledger .* is not valid/);
    expect(asked()).toBe(0);
    expect(readFileSync(join(h, MAINNET_LEDGER), "utf8")).toBe("{not json");
  });

  it("refuses a chain table entry that states another chain id than the manifest, and quotes the true entry", async () => {
    const forged = { ...TESTMAIN, chainId: 1 };
    expect(chainGate({ rail: "evm", key: "testmain", chainId: forged.chainId, testnet: false, token: forged.token }, { enabledChains: ["testmain"] })).toMatch(/chain id 1 here/);
    expect(judgeAccept({ ...usdcRequirement(0.1, PAY_TO, TESTMAIN) } as never, 2)).toMatchObject({ supported: true });
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
      expect(ledger()).toMatchObject([{ what: `page:testmain:${nonce(81)}`, amountAtomic: "1000000" }]);
    } finally {
      await signer.close();
    }
  });

  it("offers no page past the 24-hour cap or during a pause", async () => {
    writeFileSync(join(h, MAINNET_LEDGER), JSON.stringify({ holds: [{ id: "earlier", what: "page:testmain:once", chain: "testmain", amountAtomic: "2000000", at: Date.now() }] }));
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

describe("review repairs: every signing request holds its own amount", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("S1: counts a fresh authorization over an unused nonce once the earlier hold has left the window", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ now: t0, toFake: ["Date"] });
    try {
      const { signer, asked } = countedSigner();
      await signer.sign(request(1, 90));
      vi.setSystemTime(t0 + DAY + 1_000);
      await signer.sign(request(1, 91));
      await signer.sign(request(1, 92));
      // The same nonce, never used on chain, signed again: a new validBefore, so a new authorization that can settle.
      await refusedWith(signer.sign(request(1, 90)), /would reach 3000000 in 24 hours, above its cap of 2500000/);
      expect(asked()).toBe(3);
      expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
    } finally {
      vi.useRealTimers();
    }
  });

  it("S3: a concurrent twin that fails cannot release the hold of a signature still being made", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    let finish!: () => void;
    const held = new Promise<void>((done) => { finish = done; });
    let asked = 0;
    const key = { ...account, signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => {
      asked++;
      if (asked === 1) { await held; return account.signTypedData(args); }
      throw new Error("the device went away");
    } };
    const signer = new LocalKeySigner(key as typeof account);
    const slow = signer.sign(request(1, 95));
    await vi.waitFor(() => expect(asked).toBe(1));
    await expect(signer.sign(request(1, 95))).rejects.toThrow(/device went away/);
    finish();
    expect((await slow).payload.signature).toMatch(/^0x/);
    // Both requests reached the key, so both count: the signature that exists is never left out.
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
    await refusedWith(signer.sign(request(1, 96)), /would reach 3000000 in 24 hours/);
  });

  it("S3: a request whose key fails still counts (nothing is released)", async () => {
    const failing = countedSigner(true);
    await expect(failing.signer.sign(request(1, 97))).rejects.toThrow(/device went away/);
    expect(heldToday(ledger(), "testmain", Date.now())).toBe(1_000_000n);
  });
});

describe("review repairs: the approval page", () => {
  const policy = { ...DEFAULT_POLICY, perCall: { amount: 10, asset: "USDC", atomic: "10000000" }, perDay: { amount: 100, asset: "USDC", atomic: "100000000" } };
  const pageSigner = () => new BrowserWalletSigner({ port: 0, home: h, policy, timeoutMs: 20_000, balance: false });
  const postJson = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const wallet = () => privateKeyToAccount(generatePrivateKey()).address;
  /** Open pages for `requests`, and hand back their links and their endings (a SignRefused or a result). */
  async function open(signer: BrowserWalletSigner, ...requests: Parameters<LocalKeySigner["sign"]>[0][]) {
    const links: string[] = [];
    const endings = requests.map((r) => signer.sign(r, { onPending: (_id: string, url?: string) => { links.push(url ?? ""); } }).catch((e: unknown) => e));
    await vi.waitFor(() => expect(links).toHaveLength(requests.length));
    return { links, endings };
  }

  it("S1: a long-lived page cannot issue validity past its accounting window", async () => {
    const now = Date.now();
    const signer = new BrowserWalletSigner({ port: 0, home: h, policy, timeoutMs: 90_000_000, balance: false });
    try {
      const { links, endings } = await open(signer, request(1, 501));
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 86_400_001);
      try {
        const answer = await postJson(`${links[0]}/account`, { address: wallet() });
        expect(answer.status).toBe(409);
        expect(answer.body.typedData).toBeUndefined();
      } finally { clock.mockRestore(); }
      await signer.close();
      await Promise.all(endings);
    } finally { await signer.close(); }
  });

  it("S1: the last authorization before the page deadline expires within its reservation", async () => {
    const signer = new BrowserWalletSigner({ port: 0, home: h, policy, timeoutMs: 90_000_000, balance: false });
    try {
      const { links, endings } = await open(signer, request(1, 503));
      const hold = ledger()[0];
      const clock = vi.spyOn(Date, "now").mockReturnValue(hold.at + 86_400_000 - 600_001);
      try {
        const prepared = await postJson(`${links[0]}/account`, { address: wallet() });
        expect(prepared.status).toBe(200);
        const typed = prepared.body.typedData;
        if (!typed || typeof typed !== "object" || !("message" in typed)) throw new Error("no typed message");
        const message = typed.message;
        if (!message || typeof message !== "object" || !("validBefore" in message)) throw new Error("no validity");
        expect(Number(message.validBefore) * 1000).toBeLessThanOrEqual(hold.at + 86_400_000);
      } finally { clock.mockRestore(); }
      await signer.close();
      await Promise.all(endings);
    } finally { await signer.close(); }
  });

  it.each(["pause", "expiry"])("S5: %s during the settings lookup withholds the prepared authorization", async (stop) => {
    const clock = vi.spyOn(Date, "now");
    const started = Date.now();
    const server = new ApprovalServer({ port: 0, recordsDirPath: join(h, "records"), settingsNote: async () => {
      if (stop === "pause") writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      else clock.mockReturnValue(started + 30_000);
      return undefined;
    } });
    try {
      await server.start();
      const judged = judgeAccept(usdcRequirement(1, PAY_TO, TESTMAIN), 2);
      if (!judged.supported) throw new Error(judged.reason);
      const approval = server.request({ kind: "eip3009", verified: { ...judged.offer.terms, payer: "" }, requirement: judged.offer.requirement, x402Version: 2, timeoutMs: 20_000, nonce: nonce(502) });
      const answer = await postJson(`${approval.url}/account`, { address: wallet() });
      expect(answer.status).toBe(409);
      expect(answer.body.typedData).toBeUndefined();
      expect((await approval.settled).status).toBe("refused");
    } finally { clock.mockRestore(); await server.close(); }
  });

  it("S2: two pages with the same nonce, each connected to another wallet, both count", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 84), request(1, 84));
      expect((await postJson(`${links[0]}/account`, { address: wallet() })).body.typedData).toBeDefined();
      expect((await postJson(`${links[1]}/account`, { address: wallet() })).body.typedData).toBeDefined();
      expect(heldToday(ledger(), "testmain", Date.now())).toBe(2_000_000n);
      await refusedWith(signer.sign(request(1, 85)), /would reach 3000000 in 24 hours/);
      for (const link of links) await postJson(`${link}/reject`, {});
      await Promise.all(endings);
    } finally {
      await signer.close();
    }
  });

  it("S2: a mainnet page prepares for one wallet only; switching accounts prepares nothing new", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 86));
      const first = wallet();
      const prepared = await postJson(`${links[0]}/account`, { address: first });
      expect(prepared.status).toBe(200);
      const other = await postJson(`${links[0]}/account`, { address: wallet() });
      expect(other.status).toBe(409);
      expect(other.body.typedData).toBeUndefined();
      // The same wallet again (a reload) gets the very authorization it was given, not a new one.
      const again = await postJson(`${links[0]}/account`, { address: first });
      expect(again.status).toBe(200);
      expect(again.body.typedData).toEqual(prepared.body.typedData);
      expect(heldToday(ledger(), "testmain", Date.now())).toBe(1_000_000n);
      await postJson(`${links[0]}/reject`, {});
      await Promise.all(endings);
    } finally {
      await signer.close();
    }
  });

  it("S2: a testnet page still lets the owner switch accounts", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 87, BASE_SEPOLIA));
      const a = await postJson(`${links[0]}/account`, { address: wallet() });
      const b = await postJson(`${links[0]}/account`, { address: wallet() });
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((b.body.typedData as { message: { from: string } }).message.from).not.toBe((a.body.typedData as { message: { from: string } }).message.from);
      await postJson(`${links[0]}/reject`, {});
      await Promise.all(endings);
    } finally {
      await signer.close();
    }
  });

  it("S5: a page already open prepares nothing once mainnet signing is paused, and keeps its hold", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 88));
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      const answer = await postJson(`${links[0]}/account`, { address: wallet() });
      expect(answer.status).toBe(409);
      expect(answer.body.typedData).toBeUndefined();
      expect(String(answer.body.error)).toMatch(/paused/);
      const [ended] = await Promise.all(endings);
      expect(ended).toBeInstanceOf(SignRefused);
      expect((ended as SignRefused).code).toBe("policy");
      expect(heldToday(ledger(), "testmain", Date.now())).toBe(1_000_000n);
    } finally {
      await signer.close();
    }
  });

  it("S5: a wallet that connected before the pause is not handed its authorization again after it", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 89));
      const address = wallet();
      expect((await postJson(`${links[0]}/account`, { address })).status).toBe(200);
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      const again = await postJson(`${links[0]}/account`, { address });
      expect(again.status).toBe(409);
      expect(again.body.typedData).toBeUndefined();
      await Promise.all(endings);
      expect(heldToday(ledger(), "testmain", Date.now())).toBe(1_000_000n);
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
