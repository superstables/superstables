import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { EVM_CHAINS } from "../../budget/evm/chains.mjs";

// fund-agent's default top-up pays for about 20 purchases even when a node prices gas at 1 gwei, within what the website
// accepts for a fund-agent request. What one purchase needs is checked at the current fee before the agent signs
// (evm/lib.ts) and by doctor, so the fixed floors only cover what the limits leave out.
const GWEI = 1_000_000_000n;
const CEILING = parseUnits("0.05", 18); // the most the website accepts for a fund-agent request

describe("agent gas defaults on the ETH testnets", () => {
  for (const key of ["base-sepolia", "arbitrum-sepolia"] as const) {
    it(`${key}: fund-agent pays for about 20 purchases, within the website's ceiling`, () => {
      const c = (EVM_CHAINS as Record<string, any>)[key];
      const pullAt1Gwei = BigInt(c.gas.limits.pull) * GWEI;
      const fund = parseUnits(c.doctor.fundAgent, 18);
      // about 20: 23 pulls at Base Sepolia's limit, 17 at Arbitrum Sepolia's (both limits carry a margin over the gas used)
      expect(fund / pullAt1Gwei).toBeGreaterThanOrEqual(15n);
      expect(fund).toBeLessThanOrEqual(CEILING);
      // the fixed floors stay below what fund-agent sends, so one default top-up clears doctor
      expect(parseUnits(c.doctor.minAgentGas, 18)).toBeLessThan(fund);
      expect(parseUnits(c.gas.minAgent, 18)).toBeLessThan(fund);
    });
  }
});
