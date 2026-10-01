import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { EVM_CHAINS } from "../../budget/evm/chains.mjs";

// A pull is one USDC transferFrom, up to about 100,000 gas, priced at 1 gwei or more by some nodes.
const PULL_COST = 100_000n * 1_000_000_000n;
const CEILING = parseUnits("0.05", 18); // the most the website accepts for a fund-agent request

describe("agent gas defaults on the ETH testnets", () => {
  for (const key of ["base-sepolia", "arbitrum-sepolia"] as const) {
    it(`${key}: fund-agent pays for about 20 purchases, within the website's ceiling`, () => {
      const c = (EVM_CHAINS as Record<string, any>)[key];
      const fund = parseUnits(c.doctor.fundAgent, 18);
      expect(fund / PULL_COST).toBeGreaterThanOrEqual(20n);
      expect(fund).toBeLessThanOrEqual(CEILING);
      // doctor's minimum for the agent and the refusal before a buy are one pull
      expect(parseUnits(c.doctor.minAgentGas, 18)).toBeGreaterThanOrEqual(PULL_COST);
      expect(parseUnits(c.gas.minAgent, 18)).toBeGreaterThanOrEqual(PULL_COST);
      // the owner keeps what fund-agent sends, plus a grant and a revoke
      expect(parseUnits(c.doctor.minOwnerGas, 18)).toBeGreaterThan(fund);
    });
  }
});
