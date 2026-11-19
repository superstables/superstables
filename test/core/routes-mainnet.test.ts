// Which budget rail a listing on Tempo or Solana mainnet is routed to (src/core/routes.ts): none while the operator's switch
// is off when the tables load, the tempo and solana rails' mainnet chains while it is on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const load = async (on: boolean) => {
  vi.resetModules();
  if (on) vi.stubEnv("SUPERSTABLES_TESTNET", "");
  else vi.stubEnv("SUPERSTABLES_TESTNET", "1");
  return import("../../src/core/routes.js");
};

describe("budget routes for Tempo and Solana mainnet listings", () => {
  it("switch off: no budget rail claims them; the testnets still route", async () => {
    const { routesFor } = await load(false);
    expect(routesFor(["mpp"], ["tempo"]).budget).toEqual([]);
    expect(routesFor(["x402"], ["solana", MAINNET_MANIFEST.chains.solana.caip2]).budget).toEqual([]);
    expect(routesFor(["mpp"], ["eip155:42431"]).budget).toEqual([{ rail: "tempo", chain: "moderato" }]);
    expect(routesFor(["x402"], ["solana-devnet"]).budget).toEqual([{ rail: "solana", chain: "devnet" }]);
  });

  it("switch on: Tempo mainnet routes to --rail tempo --chain tempo and Solana mainnet to --rail solana --chain solana", async () => {
    const { routesFor } = await load(true);
    expect(routesFor(["mpp"], ["eip155:4217"]).budget).toEqual([{ rail: "tempo", chain: "tempo" }]);
    expect(routesFor(["x402"], [MAINNET_MANIFEST.chains.solana.caip2]).budget).toEqual([{ rail: "solana", chain: "solana" }]);
    expect(routesFor(["x402"], ["solana"]).budget).toEqual([{ rail: "solana", chain: "solana" }]);
    // a Tempo listing over x402 is no MPP seller
    expect(routesFor(["x402"], ["eip155:4217"]).budget).toEqual([]);
  });
});
