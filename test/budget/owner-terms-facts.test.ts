// What each owner action tells the page: the exact values the wallet will show (budget/{evm,tempo,solana}/owner.ts), the RPC
// hosts the command reads (budget/page-facts.mjs) and the agent-binding verdict that travels with the request. No network.
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountHomeWith, DEV_SETTINGS } from "../helpers/owner-settings.js";

const AGENT = "0x1563915e194D8CfBA1943570603F7606A3115508";
const OWNER = "0x6dB2c4b9C1a8F6a0E1a5b9F0f5D2f1C7e8A94a31";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";

// ── evm ───────────────────────────────────────────────────────────────────────────────────

async function evmOwner(chain: string) {
  vi.resetModules();
  const before = process.env.B4_CHAIN;
  process.env.B4_CHAIN = chain;
  try {
    return (await import(new URL("../../budget/evm/owner.ts", import.meta.url).href)) as any;
  } finally {
    if (before === undefined) delete process.env.B4_CHAIN;
    else process.env.B4_CHAIN = before;
  }
}

describe("evm: what the wallet will show", () => {
  it("a revoke is approve(agent, 0) on the token, with the fee", async () => {
    const o = await evmOwner("base-sepolia");
    const terms = o.revokeTerms(OWNER, AGENT, 5_000_000n, 1_000_000n);
    expect(terms.walletShows).toEqual([
      `approve(spender ${AGENT}, amount 0): 0 USDC`,
      `To: the USDC token contract ${BASE_USDC}`,
      "A network fee in ETH, paid from your wallet",
    ]);
    // a zero amount has no units to read, and the kill switch gets no extra prompt
    expect(terms.watchToken).toBeUndefined();
  });

  it("a grant is approve(agent, cap) with the raw amount next to the readable one", async () => {
    const o = await evmOwner("base-sepolia");
    expect(o.approveShows(AGENT, 12_500_000n)).toEqual([
      `approve(spender ${AGENT}, amount 12500000): 12.5 USDC`,
      `To: the USDC token contract ${BASE_USDC}`,
      "A network fee in ETH, paid from your wallet",
    ]);
  });

  it("the gas transfer on Arc is a native transfer in 18 decimals: the wei next to the readable USDC, and no token to offer", async () => {
    const o = await evmOwner("arc-testnet");
    const shows = o.fundShows(AGENT, 100_000_000_000_000_000n);
    expect(shows).toEqual([
      "A transfer of 100000000000000000 wei: 0.1 USDC",
      `To: ${AGENT}`,
      "A network fee in USDC, paid from your wallet",
    ]);
    expect(o.approveShows(AGENT, 1_000_000n)[1]).toBe(`To: the USDC token contract ${ARC_USDC}`);
  });

  it("the token facts for the wallet come from the chain table", async () => {
    const o = await evmOwner("base-sepolia");
    expect(o.OWNER_TOKEN).toEqual({ address: BASE_USDC, symbol: "USDC", decimals: 6 });
  });
});

// ── tempo ─────────────────────────────────────────────────────────────────────────────────

describe("tempo: the keychain call in words", () => {
  it("a grant names the call, the limit raw and readable, the expiry and the sellers", async () => {
    const t = (await import(new URL("../../budget/tempo/owner.ts", import.meta.url).href)) as any;
    const expiry = 1_792_000_000;
    const terms = t.grantTerms({ agent: AGENT, owner: OWNER, limit: 5_000_000n, expiry, period: 86_400, sellers: undefined, expirySeconds: 604_800, held: 9_000_000n, feeToken: t.KEYCHAIN, label: "" });
    expect(terms.walletShows).toEqual([
      `Call authorizeKey for the key ${AGENT} on the account keychain ${t.KEYCHAIN}`,
      "Spending limit: 5000000 in base units (5 pathUSD), refilled every 86400 seconds",
      `Expires: unix time ${expiry} (${new Date(expiry * 1000).toISOString().replace(".000Z", "Z")})`,
      "Allowed calls: any",
      expect.stringMatching(/^A network fee in .+, paid from your account$/),
    ]);
    expect(terms.watchToken).toBeUndefined();
    const scoped = t.grantTerms({ agent: AGENT, owner: OWNER, limit: 1_000_000n, expiry, period: 0, sellers: [OWNER], expirySeconds: 3600, held: 0n, feeToken: t.KEYCHAIN, label: "" });
    expect(scoped.walletShows[1]).toBe("Spending limit: 1000000 in base units (1 pathUSD), no refill");
    expect(scoped.walletShows[3]).toBe(`Allowed calls: token transfers to ${OWNER}`);
  });

  it("a revoke names the call and says no token moves", async () => {
    const t = (await import(new URL("../../budget/tempo/owner.ts", import.meta.url).href)) as any;
    const terms = t.revokeTerms({ owner: OWNER, agent: AGENT, remaining: 4_000_000n, expiry: 1_792_000_000, feeToken: t.KEYCHAIN, label: "" });
    expect(terms.walletShows).toEqual([
      `Call revokeKey for the key ${AGENT} on the account keychain ${t.KEYCHAIN}`,
      "No token amount moves",
      expect.stringMatching(/^A network fee in .+, paid from your account$/),
    ]);
  });
});

// ── solana ────────────────────────────────────────────────────────────────────────────────

describe("solana: the instruction, raw and readable", () => {
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
  const agent = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
  const ata = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();

  it("a grant is approveChecked with its amount and decimals", async () => {
    const s = (await import(new URL("../../budget/solana/owner.ts", import.meta.url).href)) as any;
    const terms = s.grantTerms({ owner, agent, ata, cap: 2_500_000n, held: 9_000_000n });
    expect(terms.walletShows).toEqual([
      `SPL Token approveChecked: delegate ${agent}, amount 2500000, decimals 6: 2.5 USDC`,
      `From your USDC account ${ata}`,
      "A network fee in SOL, typically 0.000005 SOL",
    ]);
  });

  it("a revoke is the Revoke instruction and a fund is a lamports transfer", async () => {
    const s = (await import(new URL("../../budget/solana/owner.ts", import.meta.url).href)) as any;
    expect(s.revokeTerms({ owner, agent, ata, remaining: 1_000_000n }).walletShows).toEqual([
      `SPL Token Revoke: clears the delegate on your USDC account ${ata}`,
      "A network fee in SOL, typically 0.000005 SOL",
    ]);
    expect(s.fundTerms({ owner, agent, lamports: 50_000_000n, agentHas: 0n }).walletShows).toEqual([
      "System transfer of 50000000 lamports: 0.05 SOL",
      `To: ${agent}`,
      "A network fee in SOL, typically 0.000005 SOL",
    ]);
  });

  it("the cluster is named by its genesis hash", async () => {
    const s = (await import(new URL("../../budget/solana/owner.ts", import.meta.url).href)) as any;
    expect(s.SOLANA_OWNER_CHAIN.genesis).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  });
});

// ── the RPC row and the binding that travel with a request ────────────────────────────────

describe("page-facts: the RPC hosts the command reads", () => {
  // the test setup points the RPC variables at a dead address: these tests choose their own
  const NAMES = ["B4_RPC", "B4_RPC_BASE_SEPOLIA", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC", "SUPERSTABLES_TEST_ACCOUNT_HOME"];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const n of NAMES) {
      saved.set(n, process.env[n]);
      delete process.env[n];
    }
  });
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
  const account = (settings: object | null) => {
    const a = accountHomeWith(settings);
    process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = a;
  };
  const facts = async () => (await import(new URL("../../budget/page-facts.mjs", import.meta.url).href)) as any;

  it("the built-in endpoints: hosts only, source built-in", async () => {
    account(null);
    const { rpcFacts } = await facts();
    expect(rpcFacts("evm", "base-sepolia")).toEqual({ hosts: ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"], source: "built-in" });
    expect(rpcFacts("solana", "devnet")).toEqual({ hosts: ["api.devnet.solana.com"], source: "built-in" });
    expect(rpcFacts("tempo", "moderato")).toEqual({ hosts: ["rpc.moderato.tempo.xyz"], source: "built-in" });
  });

  it("the owner's own settings, named without the path or key", async () => {
    account({ ...DEV_SETTINGS, rpc: { "base-sepolia": { urls: ["https://one.example/v2/SECRETKEY", "https://two.example"] } } });
    const { rpcFacts } = await facts();
    const got = rpcFacts("evm", "base-sepolia");
    expect(got).toEqual({ hosts: ["one.example", "two.example"], source: "owner settings" });
    expect(JSON.stringify(got)).not.toContain("SECRETKEY");
  });

  it("drops query-string keys too (a URL with a user name, password or fragment is refused before it gets here)", async () => {
    account({ ...DEV_SETTINGS, rpc: { "base-sepolia": { urls: ["https://one.example:8443/v2/KEY?api-key=QKEY", "https://two.example/?apikey=OTHERKEY"] } } });
    const { rpcFacts } = await facts();
    const got = rpcFacts("evm", "base-sepolia");
    expect(got.hosts).toEqual(["one.example:8443", "two.example"]);
    for (const secret of ["QKEY", "OTHERKEY", "api-key"]) expect(JSON.stringify(got)).not.toContain(secret);
  });

  it("the owner's own node", async () => {
    account({ ...DEV_SETTINGS, rpc: { "base-sepolia": { urls: ["https://node.example/key"], ownNode: true } } });
    const { rpcFacts } = await facts();
    expect(rpcFacts("evm", "base-sepolia")).toEqual({ hosts: ["node.example"], source: "owner node" });
  });

  it("an environment variable that the owner allows leads, and says so", async () => {
    account(DEV_SETTINGS);
    process.env.B4_RPC_BASE_SEPOLIA = "http://127.0.0.1:8545";
    const { rpcFacts } = await facts();
    const got = rpcFacts("evm", "base-sepolia");
    expect(got.hosts[0]).toBe("127.0.0.1:8545");
    expect(got.source).toBe("environment variable");
  });

  it("a variable the owner did not allow gives no row rather than a wrong one", async () => {
    account(null);
    process.env.B4_RPC_BASE_SEPOLIA = "http://127.0.0.1:8545";
    const { rpcFacts } = await facts();
    expect(rpcFacts("evm", "base-sepolia")).toBeUndefined();
  });
});

describe("page-facts: the agent binding noted by an owner plan", () => {
  it("passes on a signed or legacy verdict, and nothing else", async () => {
    vi.resetModules();
    const { noteBinding, bindingFacts } = (await import(new URL("../../budget/page-facts.mjs", import.meta.url).href)) as any;
    expect(bindingFacts()).toBeUndefined();
    noteBinding({ state: "signed", kind: "local", signedAt: "2026-10-16T10:00:00.000Z" });
    expect(bindingFacts()).toEqual({ state: "signed", signedAt: "2026-10-16T10:00:00.000Z" });
    noteBinding({ state: "legacy" });
    expect(bindingFacts()).toEqual({ state: "legacy" });
    // a refused binding ends the command before any page: it is never something a page can show
    noteBinding({ state: "refused", problem: "x" });
    expect(bindingFacts()).toBeUndefined();
  });
});
