// What a settled purchase tells the agent next: nothing while the budget covers another at the same price, else report and stop.

import { describe, expect, it } from "vitest";
import { afterPurchase } from "../../budget/next-steps.mjs";

describe("next after a purchase that settled", () => {
  it("is none while the budget left covers another purchase at this price", () => {
    expect(afterPurchase({ amount: "0.001", remaining: "0.001", unit: "pathUSD" })).toBe("none");
    expect(afterPurchase({ amount: "0.01", remaining: "0.19", unit: "USDC" })).toBe("none");
  });

  it("says to report and stop, with no grant offer, when what is left cannot cover another", () => {
    const next = afterPurchase({ amount: "0.001", remaining: "0.0005", unit: "pathUSD" });
    expect(next).toMatch(/^none for this purchase\. The budget left \(0\.0005 pathUSD\) cannot cover another one at this price \(0\.001 pathUSD\)/);
    expect(next).toContain("end your turn");
    expect(next).toContain("Do not propose or start a new or bigger grant unless the owner explicitly asks for one");
  });

  it("is none when the amount or what is left is unknown", () => {
    expect(afterPurchase({ amount: null, remaining: "0", unit: "USDC" })).toBe("none");
    expect(afterPurchase({ amount: "0.01", remaining: null, unit: "USDC" })).toBe("none");
  });
});
