// The mainnet manifest as this build ships it: valid, one entry for each testnet pair the client pays on, every fact
// cited, no chain id a testnet uses, and the chain tables holding testnets only while the operator's switch is off. Then
// the manifest check itself: one malformed fact closes every mainnet.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chainGate } from "../../src/core/chain-gate.js";
import { BASE_SEPOLIA, EVM_NETWORKS, KNOWN_NETWORKS } from "../../src/core/chain.js";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { mainnetChains, mainnetPauseReason, mainnetRefusal, manifestProblems, setMainnetPauseSource, shippedManifest, type MainnetManifest } from "../../src/core/mainnet-policy.js";
import { mainnetSendRefusal } from "../../src/core/mainnet-spend.js";

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());
const home = () => { const h = mkdtempSync(join(tmpdir(), "mainnet-manifest-")); homes.push(h); vi.stubEnv("SUPERSTABLES_HOME", h); return h; };

const ON = { SUPERSTABLES_TESTNET: "" };
const OFF = { SUPERSTABLES_TESTNET: "1" };
const copy = (): MainnetManifest => structuredClone(MAINNET_MANIFEST) as MainnetManifest;
const base = (m: MainnetManifest) => m.chains.base as unknown as Record<string, any>;
const baseRef = (m: MainnetManifest = MAINNET_MANIFEST as MainnetManifest) => ({ rail: "evm", key: "base", chainId: 8453, token: m.chains.base.token });

/** The testnet each mainnet pairs with: the same rail and token symbol. */
const PAIRS: Record<string, string> = {
  base: "base-sepolia", arc: "arc-testnet", arbitrum: "arbitrum-sepolia", polygon: "polygon-amoy", "skale-base": "skale-base-sepolia",
  ethereum: "ethereum-sepolia", robinhood: "robinhood-testnet", solana: "solana-devnet",
};

describe("the shipped mainnet manifest", () => {
  it("is valid and frozen", () => {
    expect(manifestProblems(shippedManifest())).toEqual([]);
    expect(Object.isFrozen(shippedManifest().chains.base.token)).toBe(true);
  });

  it("lists no Tempo mainnet", () => {
    expect(Object.hasOwn(MAINNET_MANIFEST.chains, "tempo")).toBe(false);
    expect(Object.values(MAINNET_MANIFEST.chains).some((c) => c.rail === "tempo" || c.chainId === 4217)).toBe(false);
  });

  it("has one mainnet for each testnet pair, on the same rail with the same token symbol and decimals", () => {
    expect(Object.keys(MAINNET_MANIFEST.chains).sort()).toEqual(Object.keys(PAIRS).sort());
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      const testnet = KNOWN_NETWORKS.find((n) => n.key === PAIRS[key])!;
      expect({ rail: c.rail, symbol: c.token.symbol, decimals: c.token.decimals }, key).toEqual({ rail: testnet.rail, symbol: testnet.token.symbol, decimals: testnet.token.decimals });
    }
  });

  it("reuses no testnet's chain id or CAIP-2 id", () => {
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      for (const n of KNOWN_NETWORKS) expect(n.caip2 === c.caip2 || (c.chainId !== 0 && n.chainId === c.chainId), `${key} and ${n.key}`).toBe(false);
    }
  });

  it("cites every fact with an https link", () => {
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      const links = [...c.rpc.map((r) => r.source), ...((c as { stateRpc?: { source: string }[] }).stateRpc ?? []).map((r) => r.source), ...c.token.source, ...Object.values(c.sources)];
      for (const l of links) expect(new URL(l).protocol, `${key}: ${l}`).toBe("https:");
    }
  });

  it("states the facts read on chain: Base's Circle USDC with domain USD Coin version 2, Robinhood's USDG version 1, Solana's genesis", () => {
    expect(MAINNET_MANIFEST.chains.base.token).toMatchObject({ address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, domain: { name: "USD Coin", version: "2" } });
    expect(MAINNET_MANIFEST.chains.robinhood.token).toMatchObject({ symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", domain: { name: "Global Dollar", version: "1" } });
    expect(MAINNET_MANIFEST.chains.solana).toMatchObject({ caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
  });

  it("leaves the chain tables as they were while the switch is off: testnets only", () => {
    expect(EVM_NETWORKS.map((n) => n.key)).toEqual(["base-sepolia", "arc-testnet", "arbitrum-sepolia", "polygon-amoy", "skale-base-sepolia", "ethereum-sepolia", "robinhood-testnet"]);
    expect(KNOWN_NETWORKS.map((n) => n.key)).toEqual([...EVM_NETWORKS.map((n) => n.key), "tempo-moderato", "solana-devnet"]);
    expect(KNOWN_NETWORKS.every((n) => n.testnet === true)).toBe(true);
    expect(mainnetChains(undefined, OFF)).toEqual([]);
    expect(mainnetChains(undefined, ON).map(([k]) => k)).toEqual(Object.keys(MAINNET_MANIFEST.chains));
    expect(mainnetChains("tempo", ON)).toEqual([]);
  });

  it("refuses Base at the gate in a testnet-only run, with the flag named", () => {
    expect(chainGate({ ...baseRef(), testnet: false })).toMatch(/^this run is testnet-only \(--testnet\), so mainnets are off/);
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true })).toBe("");
  });
});

describe("the manifest check", () => {
  const cases: [string, (m: MainnetManifest) => void, RegExp][] = [
    ["another schema", (m) => { (m as any).schema = 1; }, /schema must be 2/],
    ["an unknown rail", (m) => { base(m).rail = "cosmos"; }, /rail must be one of/],
    ["a CAIP-2 id that is not its chain id", (m) => { base(m).caip2 = "eip155:84532"; }, /caip2 is not eip155:<chainId>/],
    ["a token with no source", (m) => { base(m).token.source = []; }, /token needs at least one https source/],
    ["an http RPC", (m) => { base(m).rpc[0].url = "http://mainnet.base.org"; }, /rpc needs at least one/],
    ["an RPC with no source", (m) => { delete base(m).rpc[0].source; }, /rpc needs at least one/],
    ["a source that is not a link", (m) => { base(m).sources.chainId = "the docs"; }, /sources need https links/],
    ["a token with no domain", (m) => { delete base(m).token.domain; }, /EIP-712 domain/],
    ["no finality profile", (m) => { delete base(m).finality; }, /finality needs/],
    ["a finality kind it does not know", (m) => { base(m).finality.kind = "soon"; }, /finality needs/],
    ["a label naming a testnet", (m) => { base(m).label = "Base Sepolia"; }, /names a testnet/],
    ["a Solana CAIP-2 id that is not its genesis hash", (m) => { (m.chains.solana as any).caip2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"; }, /caip2 is not solana:/],
    ["the same chain twice", (m) => { (m.chains as any).other = structuredClone(m.chains.base); }, /appears twice/],
  ];
  for (const [what, mutate, problem] of cases) {
    it(`refuses ${what}, and closes every mainnet while it is there`, () => {
      const m = copy();
      expect(manifestProblems(m)).toEqual([]);
      mutate(m);
      expect(manifestProblems(m).join("; ")).toMatch(problem);
      expect(mainnetChains(undefined, ON, m)).toEqual([]);
      expect(mainnetRefusal(baseRef(), m, ON)).toMatch(/not valid/);
    });
  }

  it("refuses a chain table entry whose facts differ from the manifest's", () => {
    const m = copy();
    const token = { ...m.chains.base.token, domain: { ...m.chains.base.token.domain! } };
    setMainnetPauseSource(() => "");
    try {
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token }, m, ON)).toBe("");
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token }, m, OFF)).toMatch(/^this run is testnet-only/);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 1, token }, m, ON)).toMatch(/chain id 1 here/);
      expect(mainnetRefusal({ rail: "tempo", key: "base", chainId: 8453, token }, m, ON)).toMatch(/on the tempo rail here/);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: { ...token, domain: { name: "USDC", version: "2" } } }, m, ON)).toMatch(/token here is not the one/);
      expect(mainnetRefusal({ rail: "evm", key: "base", chainId: 8453, token: { ...token, address: BASE_SEPOLIA.token.address } }, m, ON)).toMatch(/token here is not the one/);
      expect(mainnetRefusal({ rail: "evm", key: "optimism", chainId: 10, token }, m, ON)).toMatch(/does not list optimism/);
      const sol = m.chains.solana.token;
      expect(mainnetRefusal({ rail: "solana", key: "solana", chainId: 0, token: { ...sol } }, m, ON)).toBe("");
      expect(mainnetRefusal({ rail: "solana", key: "solana", chainId: 0, token: { ...sol, address: sol.address.toLowerCase() } }, m, ON)).toMatch(/token here is not the one/);
    } finally {
      setMainnetPauseSource(undefined);
    }
  });
});

describe("the pause", () => {
  it("counts as paused when no pause check is loaded, when the check fails, and when the variable is set", () => {
    setMainnetPauseSource(undefined);
    expect(mainnetPauseReason({})).toMatch(/not loaded .* counts as paused/);
    expect(mainnetRefusal(baseRef(), undefined, ON)).toMatch(/^mainnet signing is paused/);
    setMainnetPauseSource(() => { throw new Error("disk"); });
    expect(mainnetPauseReason({})).toMatch(/check failed/);
    setMainnetPauseSource(() => "");
    expect(mainnetPauseReason({})).toBe("");
    expect(mainnetPauseReason({ SUPERSTABLES_MAINNET_PAUSE: "1" })).toMatch(/SUPERSTABLES_MAINNET_PAUSE is set/);
    expect(mainnetPauseReason({ SUPERSTABLES_MAINNET_PAUSE: "0" })).toMatch(/is set/);
    setMainnetPauseSource(undefined);
  });

  it("never touches a testnet, and closes a mainnet send while the switch is off", () => {
    home();
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "1");
    expect(mainnetSendRefusal(BASE_SEPOLIA)).toBe("");
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "");
    expect(mainnetSendRefusal({ ...baseRef(), testnet: false })).toMatch(/^this run is testnet-only/);
  });
});
