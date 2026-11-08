// The mainnet manifest as this build ships it: valid, signing off, Base a candidate with every fact cited, and the chain
// tables holding testnets only. Then the manifest check itself: one malformed or borrowed fact closes every mainnet.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_SIGNING, chainGate } from "../../src/core/chain-gate.js";
import { BASE_SEPOLIA, EVM_NETWORKS, KNOWN_NETWORKS } from "../../src/core/chain.js";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import {
  approvedMainnetChains, mainnetCaps, mainnetPauseReason, mainnetRefusal, manifestProblems, manifestState, setMainnetPauseSource, shippedManifest,
  type MainnetManifest,
} from "../../src/core/mainnet-policy.js";
import { MAINNET_LEDGER, MAINNET_PAUSE_FILE, MainnetRefused, mainnetSendRefusal, reserveMainnetSpend } from "../../src/core/mainnet-spend.js";

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());
const home = () => { const h = mkdtempSync(join(tmpdir(), "mainnet-manifest-")); homes.push(h); vi.stubEnv("SUPERSTABLES_HOME", h); return h; };

const copy = (): MainnetManifest => structuredClone(MAINNET_MANIFEST) as MainnetManifest;
const base = (m: MainnetManifest) => m.chains.base as unknown as Record<string, any>;
const approvedLive = (): MainnetManifest => {
  const m = copy();
  m.signing = "live";
  Object.assign(base(m), { status: "approved", approval: { by: "a human", date: "2026-10-29", evidence: "https://example.com/review" } });
  return m;
};

describe("the shipped mainnet manifest", () => {
  it("is valid, says signing is off, and approves no chain", () => {
    expect(manifestProblems(shippedManifest())).toEqual([]);
    expect(MAINNET_MANIFEST.signing).toBe("off");
    expect(manifestState()).toEqual({ state: "off", reason: expect.stringMatching(/testnets only/) });
    expect(MAINNET_SIGNING).toBe(false);
    expect(approvedMainnetChains()).toEqual([]);
    expect(mainnetCaps("base")).toBeUndefined();
    expect(Object.values(MAINNET_MANIFEST.chains).every((c) => c.status === "candidate")).toBe(true);
    expect(Object.isFrozen(shippedManifest().chains.base.caps)).toBe(true);
  });

  it("leaves the chain tables as they were: testnets only, the same seven EVM chains, Tempo Moderato and Solana devnet", () => {
    expect(EVM_NETWORKS.map((n) => n.key)).toEqual(["base-sepolia", "arc-testnet", "arbitrum-sepolia", "polygon-amoy", "skale-base-sepolia", "ethereum-sepolia", "robinhood-testnet"]);
    expect(KNOWN_NETWORKS.map((n) => n.key)).toEqual([...EVM_NETWORKS.map((n) => n.key), "tempo-moderato", "solana-devnet"]);
    expect(KNOWN_NETWORKS.every((n) => n.testnet === true)).toBe(true);
    expect(BASE_SEPOLIA.token.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  it("refuses Base and any other mainnet at the gate: the operator switch first, then the manifest, with the wording this build always used", () => {
    const base = { rail: "evm", key: "base", chainId: 8453, testnet: false, token: MAINNET_MANIFEST.chains.base.token };
    expect(chainGate(base, { enabledChains: ["base"] })).toMatch(/^mainnet is off: .*SUPERSTABLES_ALLOW_MAINNET=1/);
    vi.stubEnv("SUPERSTABLES_ALLOW_MAINNET", "1");
    expect(chainGate(base, { enabledChains: ["base"] }))
      .toMatch(/^this client does not sign on mainnet chains: .* this build signs on testnets only$/);
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true }, undefined)).toBe("");
  });

  it("states Base's facts as read and cited: chain 8453, Circle's USDC, domain USD Coin version 2, canonical Permit2 refused", () => {
    const b = MAINNET_MANIFEST.chains.base;
    expect(b).toMatchObject({ rail: "evm", chainId: 8453, rpc: { url: "https://mainnet.base.org" }, allowanceSpenders: [] });
    expect(b.token).toMatchObject({ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, domain: { name: "USD Coin", version: "2" }, approveReset: false });
    expect(b.permit2).toMatchObject({ address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", use: "refused" });
    const links = [b.rpc.source, ...b.token.source, b.permit2.source, ...Object.values(b.sources)];
    for (const l of links) expect(new URL(l).protocol, l).toBe("https:");
    expect(BigInt(b.caps.perGrantAtomic) <= BigInt(b.caps.perDayAtomic)).toBe(true);
  });

  it("keeps a candidate closed even when a manifest says live", () => {
    const m = copy();
    m.signing = "live";
    expect(manifestProblems(m)).toEqual([]);
    expect(approvedMainnetChains(m)).toEqual([]);
    expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: m.chains.base.token }, m, {})).toMatch(/candidate .* not approved/);
  });
});

describe("the manifest check", () => {
  const cases: [string, (m: MainnetManifest) => void, RegExp][] = [
    ["an unknown signing state", (m) => { (m as any).signing = "on"; }, /signing must be one of/],
    ["another schema", (m) => { (m as any).schema = 2; }, /schema must be 1/],
    ["a testnet's chain id", (m) => { base(m).chainId = 84532; }, /chainId 84532 is a testnet's/],
    ["a testnet's token", (m) => { base(m).token.address = BASE_SEPOLIA.token.address; }, /token address is a testnet's/],
    ["a rail other than evm", (m) => { base(m).rail = "solana"; }, /rail must be evm/],
    ["a token with no source", (m) => { base(m).token.source = []; }, /token needs at least one https source/],
    ["an http RPC", (m) => { base(m).rpc.url = "http://mainnet.base.org"; }, /rpc needs an https url/],
    ["a source that is not a link", (m) => { base(m).sources.chainId = "the docs"; }, /sources need https links/],
    ["a token with no domain", (m) => { delete base(m).token.domain; }, /EIP-712 domain/],
    ["Permit2 allowed", (m) => { base(m).permit2.use = "allowed"; }, /permit2 needs/],
    ["an allowance spender with no source", (m) => { base(m).allowanceSpenders = [{ address: `0x${"11".repeat(20)}` }]; }, /allowanceSpenders/],
    ["a zero cap", (m) => { base(m).caps.perDayAtomic = "0"; }, /caps need/],
    ["a cap written as a number", (m) => { base(m).caps.perGrantAtomic = 5000000; }, /caps need/],
    ["a grant cap above the day's", (m) => { base(m).caps.perGrantAtomic = "30000000"; }, /perGrantAtomic is above caps.perDayAtomic/],
    ["approved with no approval record", (m) => { delete base(m).approval; }, /approved chain needs approval/],
    ["a label naming a testnet", (m) => { base(m).label = "Base Sepolia"; }, /names a testnet/],
    ["the same chain twice", (m) => { (m.chains as any).other = structuredClone(m.chains.base); (m.chains as any).other.token.address = `0x${"12".repeat(20)}`; }, /appears twice/],
  ];
  for (const [what, mutate, problem] of cases) {
    it(`refuses ${what}, and closes every mainnet while it is there`, () => {
      const m = approvedLive();
      expect(manifestProblems(m)).toEqual([]);
      expect(approvedMainnetChains(m).map(([k]) => k)).toEqual(["base"]);
      mutate(m);
      expect(manifestProblems(m).join("; ")).toMatch(problem);
      expect(manifestState(m).state).toBe("invalid");
      expect(approvedMainnetChains(m)).toEqual([]);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: MAINNET_MANIFEST.chains.base.token }, m, {})).toMatch(/not valid/);
    });
  }

  it("refuses a chain table entry whose facts differ from the manifest's", () => {
    const m = approvedLive();
    const token = { ...m.chains.base.token, domain: { ...m.chains.base.token.domain } };
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "");
    setMainnetPauseSource(() => "");
    try {
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token }, m, {})).toBe("");
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 1, token }, m, {})).toMatch(/chain id 1 here/);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: { ...token, domain: { name: "USDC", version: "2" } } }, m, {})).toMatch(/token here is not the one/);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: { ...token, address: BASE_SEPOLIA.token.address } }, m, {})).toMatch(/token here is not the one/);
      expect(mainnetRefusal({ rail: "evm", key: "optimism", chainId: 10, token }, m, {})).toMatch(/does not list optimism/);
    } finally {
      setMainnetPauseSource(undefined);
    }
  });
});

describe("the pause", () => {
  it("counts as paused when no pause check is loaded, when the check fails, and when the variable is set", () => {
    const m = approvedLive();
    const chain = { rail: "evm", key: "base", chainId: 8453, token: m.chains.base.token };
    setMainnetPauseSource(undefined);
    expect(mainnetPauseReason({})).toMatch(/not loaded .* counts as paused/);
    expect(mainnetRefusal(chain, m, {})).toMatch(/^mainnet signing is paused/);
    setMainnetPauseSource(() => { throw new Error("disk"); });
    expect(mainnetPauseReason({})).toMatch(/check failed/);
    setMainnetPauseSource(() => "");
    expect(mainnetPauseReason({})).toBe("");
    expect(mainnetPauseReason({ SUPERSTABLES_MAINNET_PAUSE: "1" })).toMatch(/SUPERSTABLES_MAINNET_PAUSE is set/);
    expect(mainnetPauseReason({ SUPERSTABLES_MAINNET_PAUSE: "0" })).toMatch(/is set/);
    setMainnetPauseSource(undefined);
  });

  it("is in the manifest too: paused keeps approved chains known, and signs nothing on them", () => {
    const m = approvedLive();
    m.signing = "paused";
    expect(manifestState(m).state).toBe("paused");
    expect(approvedMainnetChains(m).map(([k]) => k)).toEqual(["base"]);
    expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: m.chains.base.token }, m, {})).toMatch(/paused in the mainnet manifest/);
  });
});

describe("the spending ledger in this build", () => {
  it("reserves nothing on a testnet, even while paused, and writes no ledger", async () => {
    const h = home();
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "1");
    await expect(reserveMainnetSpend(BASE_SEPOLIA, 10n ** 12n, "op-1")).resolves.toEqual({ held: false });
    expect(mainnetSendRefusal(BASE_SEPOLIA)).toBe("");
    expect(existsSync(join(h, MAINNET_LEDGER))).toBe(false);
    expect(existsSync(join(h, MAINNET_PAUSE_FILE))).toBe(false);
  });

  it("refuses every mainnet reservation and send while the manifest says off", async () => {
    const h = home();
    const chain = { rail: "evm", key: "base", chainId: 8453, testnet: false, token: MAINNET_MANIFEST.chains.base.token };
    await expect(reserveMainnetSpend(chain, 1n, "op-1")).rejects.toBeInstanceOf(MainnetRefused);
    expect(mainnetSendRefusal(chain)).toMatch(/signing is off/);
    expect(existsSync(join(h, MAINNET_LEDGER))).toBe(false);
  });
});
