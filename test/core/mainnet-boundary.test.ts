// The mainnet boundary at the signers, with a manifest injected for this file only: a made-up mainnet "testmain"
// (chain 990001), with the operator's switch on when the tables load. Nothing here touches a real chain: the signer is a
// key made in memory, and the manifest is a mock. Every test checks the property at the place the key signs: while
// mainnet is paused or switched off, the key is never asked, and a signature made before a pause is never sent.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tables are built as their modules load: the switch must be on before then.
vi.hoisted(() => { process.env.SUPERSTABLES_ALLOW_MAINNET = "1"; });

vi.mock("../../src/core/mainnet-manifest.js", () => ({
  MAINNET_MANIFEST: {
    schema: 2,
    chains: {
      testmain: {
        rail: "evm",
        chainId: 990001,
        caip2: "eip155:990001",
        label: "Example Main",
        v1Name: "",
        explorer: "https://explorer.testmain.example",
        blockSeconds: 2,
        logRange: 1000,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpc: [{ url: "https://rpc.testmain.example", operator: "testmain", source: "https://docs.testmain.example/rpc" }],
        token: { symbol: "USDC", address: "0xabababababababababababababababababababab", decimals: 6, domain: { name: "USD Coin", version: "2" }, approveReset: false, source: ["https://docs.testmain.example/usdc"] },
        finality: { kind: "finalized", typicalSeconds: 12, maxSpread: 1000, measured: "made up for this test" },
        sources: { chainId: "https://docs.testmain.example/chain", explorer: "https://docs.testmain.example/explorer" },
      },
    },
  },
}));

// The payment engine reads the token's signing domain on chain before it asks anyone; "testmain" has no chain to read.
vi.mock("../../src/core/token-domain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/token-domain.js")>();
  return { ...real, tokenDomainProblem: async () => "" };
});

import { chainGate, setPrerequisiteCheck } from "../../src/core/chain-gate.js";
import { judgeAccept } from "../../src/core/rails/index.js";
import { BASE_SEPOLIA, EVM_NETWORKS, networkFor, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { MAINNET_PAUSE_FILE, mainnetSendRefusal } from "../../src/core/mainnet-spend.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import type { Signer } from "../../src/core/signer/types.js";
import { termsFor } from "../../src/core/x402.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import { ApprovalServer } from "../../src/core/signer/approval-server.js";
import { OwnerApprovalServer } from "../../src/core/signer/owner-approval-server.js";
import { verdictSet } from "../../src/core/rpc.js";
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
  vi.stubEnv("SUPERSTABLES_ALLOW_MAINNET", "1");
  // "testmain" has one made-up RPC: its verdicts are taken as decidable here, as an owner's own node would make them.
  setPrerequisiteCheck("verdictRpc", () => true);
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
const refusedWith = async (p: Promise<unknown>, reason: RegExp) => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SignRefused);
  expect((err as Error).message).toMatch(reason);
};

describe("a manifest chain with the switch on", () => {
  it("is in the table as a mainnet, after the testnets, which are unchanged", () => {
    expect(TESTMAIN).toMatchObject({ key: "testmain", chainId: 990001, testnet: false });
    expect(EVM_NETWORKS.slice(0, 7).every((n) => n.testnet === true)).toBe(true);
    expect(EVM_NETWORKS.at(-1)?.key).toBe("testmain");
  });

  it("signs with no cap of its own: amounts are the owner's policy's to limit", async () => {
    const { signer, asked } = countedSigner();
    await signer.sign(request(50, 1));
    await signer.sign(request(50, 2));
    expect(asked()).toBe(2);
  });

  it("refuses a chain table entry that states another chain id than the manifest", () => {
    const forged = { ...TESTMAIN, chainId: 1 };
    expect(chainGate({ rail: "evm", key: "testmain", chainId: forged.chainId, testnet: false, token: forged.token })).toMatch(/chain id 1 here/);
    expect(judgeAccept({ ...usdcRequirement(0.1, PAY_TO, TESTMAIN) } as never, 2)).toMatchObject({ supported: true });
  });

  it("refuses at the next signature once the switch is off, without asking the key", async () => {
    vi.stubEnv("SUPERSTABLES_ALLOW_MAINNET", "0");
    const { signer, asked } = countedSigner();
    await refusedWith(signer.sign(request(0.1, 3)), /^mainnet is off: /);
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
  });

  it("never stops a testnet", async () => {
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "1");
    writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
    const { signer, asked } = countedSigner();
    await signer.sign(request(5, 71, BASE_SEPOLIA));
    expect(asked()).toBe(1);
    expect(mainnetSendRefusal(BASE_SEPOLIA)).toBe("");
    expect(existsSync(join(h, "mainnet-spend.json"))).toBe(false);
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

  it("offers no page during a pause", async () => {
    const signer = pageSigner();
    const hooks = { onPending: vi.fn() };
    try {
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      await refusedWith(signer.sign(request(0.1, 83), hooks), /paused/);
      expect(hooks.onPending).not.toHaveBeenCalled();
    } finally {
      await signer.close();
    }
  });

  it("names the mainnet on the page", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 90));
      const html = await (await fetch(links[0])).text();
      expect(html).toContain('<span class="pill real">Mainnet</span>');
      expect(html).toContain("This payment is on Example Main (mainnet). A payment cannot be undone.");
      expect(html).toContain('<div class="amount">1<span>USDC</span></div>');
      expect(html).not.toMatch(/real money|money is real/);
      await postJson(`${links[0]}/reject`, {});
      await Promise.all(endings);
    } finally {
      await signer.close();
    }
  });

  it.each(["pause", "expiry"])("%s during the settings lookup withholds the prepared authorization", async (stop) => {
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

  it("a mainnet page prepares for one wallet only; switching accounts prepares nothing new", async () => {
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
      await postJson(`${links[0]}/reject`, {});
      await Promise.all(endings);
    } finally {
      await signer.close();
    }
  });

  it("a testnet page still lets the owner switch accounts", async () => {
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

  it("a page already open prepares nothing once mainnet signing is paused", async () => {
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
    } finally {
      await signer.close();
    }
  });

  it("a wallet that connected before the pause is not handed its authorization again after it", async () => {
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
    } finally {
      await signer.close();
    }
  });

  it("a page that handed out its authorization takes no signature back once mainnet signing is paused", async () => {
    const signer = pageSigner();
    try {
      const { links, endings } = await open(signer, request(1, 91));
      const address = wallet();
      expect((await postJson(`${links[0]}/account`, { address })).status).toBe(200);
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      const back = await postJson(`${links[0]}/signature`, { signature: `0x${"11".repeat(65)}` });
      expect(back.status).toBe(409);
      expect(String(back.body.error)).toMatch(/paused/);
      const [ended] = await Promise.all(endings);
      expect(ended).toBeInstanceOf(SignRefused);
    } finally {
      await signer.close();
    }
  });
});

describe("a budget owner page on a mainnet", () => {
  const OWNER = privateKeyToAccount(generatePrivateKey()).address;
  const terms = { title: "Approve a budget", amount: "1", unit: "USDC", summary: "Approve 1 USDC.", rows: [], enforced: [], notEnforced: [], notes: [] };
  const mainChain = { chainId: 990001, chainName: "Example Main", rpcUrl: "http://127.0.0.1:1", explorer: "https://explorer.testmain.example", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, testnet: false };
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  async function page() {
    const server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    const handle = server.request({ kind: "evm-transaction", chain: mainChain, terms, account: OWNER, transaction: { to: PAY_TO, data: "0x", value: "0x0" }, timeoutMs: 20_000 } as never);
    return { server, handle };
  }

  it("hands out nothing, and never tells the wallet to send, once mainnet signing is paused", async () => {
    const { server, handle } = await page();
    try {
      expect((await post(`${handle.url}/account`, { address: OWNER })).status).toBe(200);
      writeFileSync(join(h, MAINNET_PAUSE_FILE), "");
      const sending = await post(`${handle.url}/sending`, { address: OWNER });
      expect(sending.status).toBe(409);
      expect(String(sending.body.error)).toMatch(/mainnet signing is paused/);
      expect(sending.body.status).toBe("rejected");
    } finally {
      await server.close();
    }
  });

  it("refuses at the first step once the operator's switch is off", async () => {
    const { server, handle } = await page();
    try {
      vi.stubEnv("SUPERSTABLES_ALLOW_MAINNET", "0");
      const account = await post(`${handle.url}/account`, { address: OWNER });
      expect(account.status).toBe(409);
      expect(String(account.body.error)).toMatch(/^mainnet is off: /);
    } finally {
      await server.close();
    }
  });
});

describe("the endpoints that decide a mainnet verdict", () => {
  it("never believe one RPC the caller pinned, while a testnet's still can", () => {
    expect(verdictSet(TESTMAIN, { rpcUrlFor: () => "https://one.example" })).toMatchObject({ error: expect.stringMatching(/two RPC operators/) });
    expect(verdictSet(BASE_SEPOLIA, { rpcUrlFor: () => "https://one.example" })).toMatchObject({ agreement: "caller", quorum: 1 });
  });

  it("take a caller's set only with two operators that must agree, or the owner's own node", () => {
    const ep = (url: string, operator: string) => ({ url, operator, source: "caller" as const, id: url });
    const one = { primary: ep("https://a.example", "a"), verdict: [ep("https://a.example", "a")], quorum: 1, agreement: "caller" as const };
    const two = { primary: ep("https://a.example", "a"), verdict: [ep("https://a.example", "a"), ep("https://b.example", "b")], quorum: 2, agreement: "quorum" as const };
    expect(verdictSet(TESTMAIN, { endpointsFor: () => one })).toMatchObject({ error: expect.any(String) });
    expect(verdictSet(TESTMAIN, { endpointsFor: () => two })).toBe(two);
    expect(verdictSet(TESTMAIN, { endpointsFor: () => ({ ...one, agreement: "owner-node" as const }) })).toMatchObject({ agreement: "owner-node" });
  });
});
