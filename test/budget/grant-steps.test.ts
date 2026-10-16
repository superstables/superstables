// The EVM rail's allowance rule for a grant (budget/evm/owner.ts): from an allowance of 0 one approve(agent, cap); over a
// live allowance approve(agent, 0) first and then approve(agent, cap), on every token. A token that needs its allowance
// at 0 first (approveReset) is never granted through the approval site, which has no such step. And the rail's chain
// table refuses to load an entry that leaves out a token fact.
import { decodeFunctionData, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenFactsProblem } from "../../src/core/token-facts.js";

const AGENT = "0x1563915e194D8CfBA1943570603F7606A3115508" as const;
const ERC20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const approves = (steps: { to: string; data: `0x${string}` }[]) => steps.map((s) => decodeFunctionData({ abi: ERC20, data: s.data }).args as readonly [string, bigint]);

type Owner = {
  grantSteps(agent: string, cap: bigint, live: bigint): { to: string; data: `0x${string}` }[];
  approveResetHostedProblem(): string;
  useApprovalSite(site: string | null): void;
  CFG?: unknown;
};
/** owner.ts for base-sepolia, loaded fresh, with the table's approveReset set to `reset` (undefined: the real table). */
async function owner(reset?: boolean): Promise<Owner & { lib: { CFG: { approveReset: boolean } } }> {
  vi.resetModules();
  vi.doUnmock("../../budget/evm/chains.mjs");
  if (reset !== undefined) {
    vi.doMock("../../budget/evm/chains.mjs", async (importOriginal) => {
      const real = await importOriginal<any>();
      const entry = real.EVM_CHAINS["base-sepolia"];
      return { ...real, EVM_CHAINS: { ...real.EVM_CHAINS, "base-sepolia": { ...entry, token: { ...entry.token, approveReset: reset } } } };
    });
  }
  const before = process.env.B4_CHAIN;
  process.env.B4_CHAIN = "base-sepolia";
  try {
    const o = await import(new URL("../../budget/evm/owner.ts", import.meta.url).href);
    const lib = await import(new URL("../../budget/evm/lib.ts", import.meta.url).href);
    return { ...o, lib } as never;
  } finally {
    if (before === undefined) delete process.env.B4_CHAIN;
    else process.env.B4_CHAIN = before;
  }
}
afterEach(() => { vi.doUnmock("../../budget/evm/chains.mjs"); vi.resetModules(); });

describe("grantSteps", () => {
  it.each([false, true])("is one approve from 0 and approve(0) then approve(cap) over a live allowance (approveReset %s)", async (reset) => {
    const o = await owner(reset);
    const from0 = o.grantSteps(AGENT, 2_000_000n, 0n);
    expect(approves(from0)).toEqual([[AGENT, 2_000_000n]]);
    const over = o.grantSteps(AGENT, 2_000_000n, 1n);
    expect(approves(over)).toEqual([[AGENT, 0n], [AGENT, 2_000_000n]]);
    expect(new Set(over.map((s) => s.to.toLowerCase())).size).toBe(1);
  });
});

describe("approveResetHostedProblem", () => {
  it("names the site when the token needs approve(0) first and a site hosts the approval", async () => {
    const o = await owner(true);
    o.useApprovalSite("https://www.superstables.com");
    expect(o.approveResetHostedProblem()).toMatch(/^USDC on Base Sepolia needs its allowance set to 0 before a new one is approved, and approvals on www\.superstables\.com have no such step/);
    o.useApprovalSite(null);
    expect(o.approveResetHostedProblem()).toBe("");
  });

  it("is empty when the token does not need it", async () => {
    const o = await owner(false);
    o.useApprovalSite("https://www.superstables.com");
    expect(o.approveResetHostedProblem()).toBe("");
  });

  it("reads the table's approveReset", async () => {
    expect((await owner()).lib.CFG.approveReset).toBe(false);
    expect((await owner(true)).lib.CFG.approveReset).toBe(true);
  });
});

describe("the rail's chain table", () => {
  it("exposes decimals, domain and approveReset per chain, as the table states them", async () => {
    const { CHAINS } = await import(new URL("../../budget/evm/chains.ts", import.meta.url).href) as { CHAINS: Record<string, any> };
    const { EVM_CHAINS } = await import("../../budget/evm/chains.mjs") as { EVM_CHAINS: Record<string, any> };
    for (const [key, cfg] of Object.entries(CHAINS)) {
      const t = EVM_CHAINS[key].token;
      expect(tokenFactsProblem(t, "evm"), key).toBe("");
      expect({ usdc: cfg.usdc, symbol: cfg.symbol, decimals: cfg.decimals, domain: cfg.domain, approveReset: cfg.approveReset }, key)
        .toEqual({ usdc: t.address, symbol: t.symbol, decimals: t.decimals, domain: t.domain, approveReset: false });
    }
  });

  it("refuses to load an entry that leaves out approveReset or states decimals that are not a whole number", async () => {
    for (const token of [
      { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" } },
      { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: "6", domain: { name: "USDC", version: "2" }, approveReset: false },
    ]) {
      vi.resetModules();
      vi.doMock("../../budget/evm/chains.mjs", async (importOriginal) => {
        const real = await importOriginal<any>();
        return { ...real, EVM_CHAINS: { ...real.EVM_CHAINS, "base-sepolia": { ...real.EVM_CHAINS["base-sepolia"], token } } };
      });
      await expect(import(new URL("../../budget/evm/chains.ts", import.meta.url).href), JSON.stringify(token)).rejects.toThrow(/^chains\.mjs: base-sepolia: the token/);
    }
  });
});
