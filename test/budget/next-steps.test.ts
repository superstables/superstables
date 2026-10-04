// What a settled purchase tells the agent next: nothing while the budget covers another at the same price, else report and stop.

import { describe, expect, it } from "vitest";
import { afterPurchase, ownerCheck, refusedChainWords } from "../../budget/next-steps.mjs";

describe("next after a purchase that settled", () => {
  it("is none while the budget left covers another purchase at this price", () => {
    expect(afterPurchase({ amount: "0.001", remaining: "0.001", unit: "pathUSD" })).toBe("none");
    expect(afterPurchase({ amount: "0.01", remaining: "0.19", unit: "USDC" })).toBe("none");
  });

  it("says to report and stop, with no grant offer, when what is left cannot cover another", () => {
    const next = afterPurchase({ amount: "0.001", remaining: "0.0005", unit: "pathUSD" });
    expect(next).toMatch(/^This purchase settled and was delivered\. The remaining budget is 0\.0005 pathUSD, less than this purchase's price of 0\.001 pathUSD\./);
    expect(next).toContain("use its preflight price");
    expect(next).toContain("end your turn");
    expect(next).toContain("Do not propose or start a revoke, a new or bigger grant, or more gas unless the owner explicitly asks for that action");
  });

  it("is none when the amount or what is left is unknown", () => {
    expect(afterPurchase({ amount: null, remaining: "0", unit: "USDC" })).toBe("none");
    expect(afterPurchase({ amount: "0.01", remaining: null, unit: "USDC" })).toBe("none");
  });
});

describe("the owner check after setup", () => {
  const owner = "0x1111111111111111111111111111111111111111";

  it("hosted on the default site: names the account and the exact recorded site in the replacement command", () => {
    const c = ownerCheck({ rail: "evm", chain: "base-sepolia", owner, site: "https://www.superstables.com" });
    const again = "superstables budget setup --rail evm --chain base-sepolia --hosted --site https://www.superstables.com --new-owner";
    expect(c.words).toBe(`AGENT ADDED to the superstables.com account ${owner}\n  Check that this is your own wallet's address. If it is not, someone else added this agent to their account: grant nothing. Once the agent is removed on that account's page on superstables.com, run ${again} yourself.`);
    expect(c.next).toContain(`The agent stays on that account until it is removed on that account's page on superstables.com; then run ${again} with the owner present`);
  });

  it("hosted on another site: names that site", () => {
    const c = ownerCheck({ rail: "tempo", chain: "moderato", owner, site: "https://staging.superstables.com" });
    expect(c.words).toContain("AGENT ADDED to the staging.superstables.com account");
    expect(c.next).toContain("superstables budget setup --rail tempo --chain moderato --hosted --site https://staging.superstables.com --new-owner");
  });

  it("on this computer: OWNER CONNECTED and setup --new-owner, unchanged", () => {
    const c = ownerCheck({ rail: "evm", chain: "arc-testnet", owner, site: null });
    expect(c.words).toBe(`OWNER CONNECTED: ${owner}\n  Check that this is your own wallet's address. If it is not, someone else completed setup: grant nothing, and run setup --new-owner yourself.`);
    expect(c.next).toBe(`the owner on record is now ${owner}: the owner checks that this is their own wallet's address. If it is not, stop: grant nothing, and run superstables budget setup --rail evm --chain arc-testnet --new-owner with the owner present`);
  });
});

describe("an evm purchase the chain refused at the pull", () => {
  it("says what happened to the reverted pull, with its hash, and never 'nothing was paid' beside it", () => {
    const hash = `0x${"5e".repeat(32)}`;
    const w = refusedChainWords(hash);
    expect(w.line).toBe(`PURCHASE REFUSED. The pull ${hash} reverted on chain: no USDC was pulled from the owner. Gas fees still apply.`);
    expect(w.next).toBe(`no payment tokens were pulled from the owner: the pull ${hash} reverted on chain; gas fees still apply`);
    expect(w.line + w.next).not.toMatch(/nothing was paid/i);
  });
  it("without a pull on chain, nothing was sent", () => {
    expect(refusedChainWords(undefined)).toEqual({ line: "PURCHASE REFUSED. Nothing was paid.", next: "nothing moved; the chain refused the pull" });
  });
});
