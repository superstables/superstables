// What doctor asks the owner and the agent to hold for gas on evm. The owner: twice what a grant, a revoke and a fund-agent
// cost at the current fee, and the chain's fixed minimum only when the fee cannot be read. On Base Sepolia that minimum
// (0.00003 ETH) is many times the real cost, and an owner who could pay for every step was told to find a faucet first.
// The agent keeps the fixed minimum as a floor: it buys alone, and a fee spike after doctor would stop it (see the Amoy
// case in test/core/browser-signer.test.ts).

import { describe, expect, it } from "vitest";
import { evmAgentGasNeed, evmOwnerGasNeed } from "../../budget/doctor.mjs";
import { DOCTOR_SPIKE, EVM_CHAINS } from "../../budget/evm/chains.mjs";

const base = EVM_CHAINS["base-sepolia"].doctor;
// a grant, a revoke and a fund-agent (136000 gas) at 0.007 gwei, as on Base Sepolia on 1 Oct 2026
const ownerNow = (136_000 * 7_000_000) / 1e18;

describe("doctor's owner gas minimum on evm", () => {
  it("is twice what the owner's steps cost now, even below the chain's fixed minimum", () => {
    expect(DOCTOR_SPIKE).toBe(2);
    expect(evmOwnerGasNeed(ownerNow, base.minOwnerGas)).toBe(0.000002);
    // the owner balance doctor refused in the macOS run
    expect(0.000011526594351504).toBeGreaterThanOrEqual(evmOwnerGasNeed(ownerNow, base.minOwnerGas));
    expect(evmOwnerGasNeed(0.0001, base.minOwnerGas)).toBe(0.0002);
  });

  it("is the chain's fixed minimum when the fee could not be read", () => {
    expect(evmOwnerGasNeed(null, base.minOwnerGas)).toBe(0.00003);
    expect(evmOwnerGasNeed(null, EVM_CHAINS["arc-testnet"].doctor.minOwnerGas)).toBe(0);
  });
});

describe("doctor's agent gas minimum on evm", () => {
  it("never goes below the chain's fixed minimum, and grows with the fee above it", () => {
    expect(evmAgentGasNeed((225_000 * 7_000_000) / 1e18, base.minAgentGas)).toBe(0.00003);
    expect(evmAgentGasNeed(null, base.minAgentGas)).toBe(0.00003);
    expect(evmAgentGasNeed(0.001, base.minAgentGas)).toBe(0.002);
  });
});
