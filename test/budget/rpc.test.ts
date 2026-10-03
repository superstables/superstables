// The RPC replacements (budget/rpc.mjs) and the compute-budget bounds a wallet or a site may add to a Solana transaction
// (budget/solana/owner.ts). No network.
import { afterEach, describe, expect, it } from "vitest";
import { customRpc, refusedRpcEnv, rpcFromEnv, rpcUrlProblem } from "../../budget/rpc.mjs";
// the rail module imports .ts paths, which the test typecheck does not follow: load it by a computed path, as solana-owner.test.ts does
const ownerModulePath = ["..", "..", "budget", "solana", "owner.ts"].join("/");
const { computeBudgetProblem } = (await import(ownerModulePath)) as { computeBudgetProblem: (datas: Buffer[]) => string };
import { computeUnitLimit, computeUnitPrice } from "../helpers/fake-chains.js";

describe("RPC replacements", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["B4_RPC", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("https anywhere, http only on this computer, never credentials", () => {
    expect(rpcUrlProblem("https://rpc.example.com")).toBeNull();
    expect(rpcUrlProblem("http://127.0.0.1:8545")).toBeNull();
    expect(rpcUrlProblem("http://localhost:8899")).toBeNull();
    expect(rpcUrlProblem("http://[::1]:8545")).toBeNull();
    expect(rpcUrlProblem("http://rpc.example.com")).toMatch(/plain http is accepted only on 127\.0\.0\.1 or localhost/);
    expect(rpcUrlProblem("http://127.0.0.1.evil.example")).toMatch(/plain http/);
    expect(rpcUrlProblem("ws://rpc.example.com")).toMatch(/not an https URL/);
    expect(rpcUrlProblem("https://user:pw@rpc.example.com")).toMatch(/user name or password/);
    expect(rpcUrlProblem("not a url")).toMatch(/not a URL/);
  });

  it("a refused value falls back to the default and says why; a usable one is named for the RESULT", () => {
    process.env.SUPERSTABLES_TEMPO_RPC = "http://rpc.example.com";
    expect(rpcFromEnv("SUPERSTABLES_TEMPO_RPC", "https://rpc.moderato.tempo.xyz")).toMatchObject({ url: "https://rpc.moderato.tempo.xyz", custom: false, error: expect.stringMatching(/SUPERSTABLES_TEMPO_RPC is refused/) });
    expect(refusedRpcEnv("tempo")?.name).toBe("SUPERSTABLES_TEMPO_RPC");
    expect(refusedRpcEnv("evm")).toBeNull();
    expect(customRpc("tempo")).toBeUndefined();
    process.env.SUPERSTABLES_TEMPO_RPC = "https://my-node.example.com";
    expect(customRpc("tempo")).toBe("https://my-node.example.com");
    expect(refusedRpcEnv()).toBeNull();
  });
});

describe("Solana compute-budget additions", () => {
  it("at most one unit limit within 10,000 to 1,400,000 and one unit price, at most 0.001 SOL of priority fee", () => {
    expect(computeBudgetProblem([])).toBe("");
    expect(computeBudgetProblem([computeUnitLimit(200_000), computeUnitPrice(1_000n)])).toBe("");
    expect(computeBudgetProblem([computeUnitPrice(714_285n)])).toBe(""); // 1.4M units at 714,285 micro-lamports: 0.000999999 SOL
    expect(computeBudgetProblem([computeUnitPrice(714_286n)])).toMatch(/priority fee above 0\.001 SOL/);
    expect(computeBudgetProblem([computeUnitLimit(5_000)])).toMatch(/outside 10000 to 1400000/);
    expect(computeBudgetProblem([computeUnitLimit(1_400_001)])).toMatch(/outside/);
    expect(computeBudgetProblem([computeUnitLimit(200_000), computeUnitLimit(200_000)])).toMatch(/other than one unit limit and one unit price/);
    expect(computeBudgetProblem([Buffer.from([1, 0, 0, 0, 0])])).toMatch(/other than/);
  });
});
