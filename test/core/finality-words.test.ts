import { describe, expect, it } from "vitest";
import { finalWords, finalityFor, finalityProfile } from "../../src/core/finality-policy.js";

describe("how long a chain takes to make a block final, in words", () => {
  it("says about 20 minutes for Base Sepolia and still reads its final block at the finalized tag", () => {
    expect(finalWords("evm", "base-sepolia")).toBe("about 20 minutes");
    expect(finalityProfile("evm", "base-sepolia")).toEqual({ kind: "finalized", typicalSeconds: 1200 });
    expect(finalityFor("evm", "base-sepolia")).toBe("finalized");
  });

  it("leaves the time out for a chain nobody measured", () => {
    expect(finalWords("evm", "polygon-amoy")).toBe("");
  });

  it("keeps the instant chains instant", () => {
    expect(finalWords("evm", "skale-base-sepolia")).toBe("a few seconds");
    expect(finalityFor("evm", "skale-base-sepolia")).toBe("instant");
  });
});
