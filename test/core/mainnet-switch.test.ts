// The mainnet switch (SUPERSTABLES_ALLOW_MAINNET, src/core/chain-gate.js): one strict reading of the environment, and every
// refusal of a mainnet asks it. A chain table that names a mainnet never turns signing on by itself, and neither does the switch:
// the owner's signed settings and the chain's prerequisites still decide (test/core/mainnet-prerequisites.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_ENV, chainGate, mainnetSwitch, mainnetSwitchRefusal, parseMainnetSwitch } from "../../src/core/chain-gate.js";
import { mainnetUnsupported } from "../../src/core/chain.js";
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
    expect(chainGate(BASE, { enabledChains: ["base"] })).toMatch(/^mainnet is off: .*SUPERSTABLES_ALLOW_MAINNET=1.*; the evm chain base is not marked as a testnet/);
    expect(networkRefusal("eip155:8453")).toContain(MAINNET_ENV);
    expect(mainnetUnsupported("Base (mainnet)")).toContain("mainnet is off");
  });

  it("enabled: chainGate moves on to the owner's signed settings, and an unknown mainnet says the tables hold no entry", () => {
    vi.stubEnv(MAINNET_ENV, "1");
    expect(mainnetSwitchRefusal()).toBe("");
    expect(chainGate(BASE, undefined)).toMatch(/signed settings do not enable signing on it/);
    expect(chainGate(BASE, { enabledChains: ["base"] })).toMatch(/is not ready for mainnet signing/);
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true }, undefined)).toBe("");
    expect(networkRefusal("eip155:8453")).toContain("the chain tables hold no entry for it");
    expect(networkRefusal("eip155:8453")).not.toContain("mainnet is off");
  });

  it("invalid: a mainnet is refused with the error, a testnet is untouched", () => {
    vi.stubEnv(MAINNET_ENV, "yes");
    expect(chainGate(BASE, { enabledChains: ["base"] })).toMatch(/^SUPERSTABLES_ALLOW_MAINNET is "yes", which is not a value/);
    expect(networkRefusal("eip155:8453")).toContain('SUPERSTABLES_ALLOW_MAINNET is "yes"');
    expect(chainGate({ rail: "evm", key: "base-sepolia", testnet: true }, undefined)).toBe("");
  });

  it("false and 0 keep it off like unset", () => {
    for (const v of ["", "0", "false"]) {
      vi.stubEnv(MAINNET_ENV, v);
      expect(chainGate(BASE, { enabledChains: ["base"] }), v).toMatch(/^mainnet is off: /);
    }
  });
});
