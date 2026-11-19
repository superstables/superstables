// The network mode (SUPERSTABLES_TESTNET, src/core/mainnet-policy.js): one strict reading of the environment. Mainnet is the
// default; --testnet (SUPERSTABLES_TESTNET=1) makes a run testnet-only. Every refusal of either kind of chain asks it. This
// file loads the chain tables in a testnet-only run (test/setup-offline.ts); test/core/mainnet-prerequisites.test.ts
// loads them with the default, mainnet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_ENV, chainGate, mainnetOffReason, networkMode, parseNetworkMode, testnetOffReason } from "../../src/core/chain-gate.js";
import { KNOWN_NETWORKS, mainnetUnsupported } from "../../src/core/chain.js";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { networkRefusal } from "../../src/core/rails/index.js";

afterEach(() => vi.unstubAllEnvs());

const BASE = { rail: "evm", key: "base", testnet: false } as const;
const BASE_SEPOLIA = { rail: "evm", key: "base-sepolia", testnet: true } as const;
const TESTNET_ONLY = /^this run is testnet-only \(--testnet\), so mainnets are off/;

describe("parseNetworkMode", () => {
  it("makes a run testnet-only only for exactly 1 or true", () => {
    for (const raw of ["1", "true"]) expect(parseNetworkMode(raw), raw).toEqual({ testnet: true });
  });

  it("keeps the default, mainnet, when unset, empty, 0 or false", () => {
    for (const raw of [undefined, "", "0", "false"]) expect(parseNetworkMode(raw), String(raw)).toEqual({ testnet: false });
  });

  it("answers every other value with an error that names the variable and does not guess", () => {
    for (const raw of ["yes", "no", "on", "off", "TRUE", "True", "FALSE", " 1", "1 ", "01", "2", "-1", "ture", "null"]) {
      const s = parseNetworkMode(raw);
      expect(s, JSON.stringify(raw)).toHaveProperty("error");
      expect("error" in s && s.error).toContain(TESTNET_ENV);
    }
  });

  it("cuts a long value short in its error", () => {
    const s = parseNetworkMode("x".repeat(500));
    expect("error" in s && s.error.length).toBeLessThan(200);
  });
});

describe("networkMode", () => {
  it("reads the process environment, and a given one", () => {
    expect(networkMode({})).toEqual({ testnet: false });
    expect(networkMode({ [TESTNET_ENV]: "1" })).toEqual({ testnet: true });
    vi.stubEnv(TESTNET_ENV, "");
    expect(networkMode()).toEqual({ testnet: false });
  });
});

describe("the refusals", () => {
  it("testnet-only: a mainnet is refused by the gate, the rails and the listing text, and a testnet is signed on", () => {
    expect(mainnetOffReason()).toMatch(TESTNET_ONLY);
    expect(testnetOffReason()).toBe("");
    expect(chainGate(BASE)).toMatch(/^this run is testnet-only \(--testnet\), so mainnets are off; the evm chain base is not marked as a testnet/);
    expect(chainGate(BASE_SEPOLIA)).toBe("");
    expect(networkRefusal("eip155:8453")).toContain("testnet-only");
    expect(mainnetUnsupported("Base (mainnet)")).toContain("testnet-only");
  });

  it("the default, after the tables loaded testnet-only: a testnet is refused with the flag named, and a mainnet gets past the mode", () => {
    vi.stubEnv(TESTNET_ENV, "");
    expect(mainnetOffReason()).toBe("");
    expect(testnetOffReason()).toContain("--testnet");
    expect(chainGate(BASE_SEPOLIA)).toBe("the evm chain base-sepolia is a testnet, and testnets need --testnet (or SUPERSTABLES_TESTNET=1)");
    expect(chainGate(BASE)).not.toMatch(TESTNET_ONLY);
    expect(chainGate(BASE)).toMatch(/^this client does not sign on the evm chain base: /);
    expect(networkRefusal("eip155:8453")).toContain("the chain tables hold no entry for it");
  });

  it("invalid: both kinds of chain are refused with the error", () => {
    vi.stubEnv(TESTNET_ENV, "yes");
    const error = /^SUPERSTABLES_TESTNET is "yes", a value it does not take, so no chain is open/;
    expect(chainGate(BASE)).toMatch(error);
    expect(chainGate(BASE_SEPOLIA)).toMatch(/^the evm chain base-sepolia is a testnet, and SUPERSTABLES_TESTNET is "yes"/);
    expect(networkRefusal("eip155:8453")).toContain('SUPERSTABLES_TESTNET is "yes"');
  });

  it("testnet-only: no mainnet is in the chain table, and each one of the manifest is refused by the gate and by quoting", () => {
    expect(KNOWN_NETWORKS.every((n) => n.testnet === true)).toBe(true);
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      expect(chainGate({ rail: c.rail, key, chainId: c.chainId, testnet: false, token: c.token }), key).toMatch(new RegExp(`^this run is testnet-only \\(--testnet\\), so mainnets are off; the ${c.rail} chain ${key} is not marked as a testnet`));
      expect(networkRefusal(c.caip2), key).toContain("testnet-only");
    }
  });

  it("empty, 0 and false keep the default: a testnet is refused", () => {
    for (const v of ["", "0", "false"]) {
      vi.stubEnv(TESTNET_ENV, v);
      expect(chainGate(BASE_SEPOLIA), v).toMatch(/is a testnet, and testnets need --testnet/);
    }
  });
});
