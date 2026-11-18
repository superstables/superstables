// The mainnet switch (SUPERSTABLES_ALLOW_MAINNET, src/core/chain-gate.js): one strict reading of the environment, and every
// refusal of a mainnet asks it. This file loads the chain tables with the switch off; test/core/mainnet-prerequisites.test.ts
// loads them with it on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_ENV, chainGate, mainnetSwitch, mainnetSwitchRefusal, parseMainnetSwitch } from "../../src/core/chain-gate.js";
import { KNOWN_NETWORKS, mainnetUnsupported } from "../../src/core/chain.js";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { networkRefusal } from "../../src/core/rails/index.js";

afterEach(() => vi.unstubAllEnvs());

const BASE = { rail: "evm", key: "base", testnet: false } as const;

describe("parseMainnetSwitch", () => {
  it("allows mainnet only for exactly 1 or true", () => {
    for (const raw of ["1", "true"]) expect(parseMainnetSwitch(raw), raw).toEqual({ enabled: true });
  });

  it("keeps mainnet off when unset, empty, 0 or false", () => {
    for (const raw of [undefined, "", "0", "false"]) expect(parseMainnetSwitch(raw), String(raw)).toEqual({ enabled: false });
  });

  it("answers every other value with an error that names the variable and does not guess", () => {
    for (const raw of ["yes", "no", "on", "off", "TRUE", "True", "FALSE", " 1", "1 ", "01", "2", "-1", "ture", "null"]) {
      const s = parseMainnetSwitch(raw);
      expect(s, JSON.stringify(raw)).toHaveProperty("error");
      expect("error" in s && s.error).toContain(MAINNET_ENV);
    }
  });

  it("cuts a long value short in its error", () => {
    const s = parseMainnetSwitch("x".repeat(500));
    expect("error" in s && s.error.length).toBeLessThan(200);
  });
});

describe("mainnetSwitch", () => {
  it("reads the process environment, and a given one", () => {
    expect(mainnetSwitch({})).toEqual({ enabled: false });
    expect(mainnetSwitch({ [MAINNET_ENV]: "1" })).toEqual({ enabled: true });
    vi.stubEnv(MAINNET_ENV, "true");
    expect(mainnetSwitch()).toEqual({ enabled: true });
  });
});

describe("the refusals", () => {
  it("unset: chainGate, the rails and the listing text refuse and name the variable", () => {
    expect(mainnetSwitchRefusal()).toContain(MAINNET_ENV);
    expect(chainGate(BASE)).toMatch(/^mainnet is off: .*SUPERSTABLES_ALLOW_MAINNET=1.*; the evm chain base is not marked as a testnet/);
    expect(networkRefusal("eip155:8453")).toContain(MAINNET_ENV);
    expect(mainnetUnsupported("Base (mainnet)")).toContain("mainnet is off");
  });

  it("enabled after the tables loaded: chainGate moves past the switch, and the tables, built with it off, still hold no mainnet", () => {
    vi.stubEnv(MAINNET_ENV, "1");
    expect(mainnetSwitchRefusal()).toBe("");
    expect(chainGate(BASE)).not.toMatch(/mainnet is off/);
    expect(chainGate(BASE)).toMatch(/^this client does not sign on the evm chain base: /);
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true })).toBe("");
    expect(networkRefusal("eip155:8453")).toContain("the chain tables hold no entry for it");
    expect(networkRefusal("eip155:8453")).not.toContain("mainnet is off");
  });

  it("invalid: a mainnet is refused with the error, a testnet is untouched", () => {
    vi.stubEnv(MAINNET_ENV, "yes");
    expect(chainGate(BASE)).toMatch(/^SUPERSTABLES_ALLOW_MAINNET is "yes", which is not a value/);
    expect(networkRefusal("eip155:8453")).toContain('SUPERSTABLES_ALLOW_MAINNET is "yes"');
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true })).toBe("");
  });

  it("off: no mainnet is in the chain table, and each one of the manifest is refused by the gate and by quoting", () => {
    expect(KNOWN_NETWORKS.every((n) => n.testnet === true)).toBe(true);
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      expect(chainGate({ rail: c.rail, key, chainId: c.chainId, testnet: false, token: c.token }), key).toMatch(new RegExp(`^mainnet is off: .*SUPERSTABLES_ALLOW_MAINNET=1.*; the ${c.rail} chain ${key} is not marked as a testnet`));
      expect(networkRefusal(c.caip2), key).toContain("mainnet is off");
    }
  });

  it("false and 0 keep it off like unset", () => {
    for (const v of ["", "0", "false"]) {
      vi.stubEnv(MAINNET_ENV, v);
      expect(chainGate(BASE), v).toMatch(/^mainnet is off: /);
    }
  });
});
