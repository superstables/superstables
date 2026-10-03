// message_for_owner: the reply an agent sends word for word when a link needs the owner.
import { describe, expect, it } from "vitest";
import { messageForOwner } from "../../budget/once.mjs";

describe("message_for_owner", () => {
  it("has the exact link, the code, the amount on the network, the testnet line and what to do next", () => {
    const m = messageForOwner({ url: "https://www.superstables.com/approve/budget/ba_1#ssba_test_x", matchCode: "QRS-TUV", chain: "arc-testnet", terms: { title: "Approve a budget", amount: "0.2", unit: "USDC" } });
    expect(m).toBe([
      "Review and approve in your wallet: Approve a budget",
      "https://www.superstables.com/approve/budget/ba_1#ssba_test_x",
      "Match code: QRS-TUV (pick it on the page)",
      "0.2 test USDC on Arc Testnet. Testnet only: test USDC, no real money.",
      "Tell me when you've approved.",
    ].join("\n"));
  });

  it("names a gas token as it is, and says where to open a page on this computer", () => {
    const m = messageForOwner({ url: "http://127.0.0.1:4413/approve/x", chain: "base-sepolia", terms: { title: "Send gas to the agent", amount: "0.002", unit: "ETH" } });
    expect(m).toContain("0.002 ETH (testnet) on Base Sepolia.");
    expect(m).toContain("Open it in the browser that has your wallet, on this computer.");
    expect(m).not.toContain("Match code");
  });

  it("names the site when the link is not on www.superstables.com", () => {
    const m = messageForOwner({ url: "https://staging.superstables.com/approve/budget/ba_1#ssba_test_x", matchCode: "QRS-TUV", chain: "base-sepolia", terms: { title: "Approve a budget", amount: "0.2", unit: "USDC" } });
    expect(m!.split("\n").slice(0, 3)).toEqual([
      "Review and approve in your wallet: Approve a budget",
      "This link is on staging.superstables.com, not www.superstables.com.",
      "https://staging.superstables.com/approve/budget/ba_1#ssba_test_x",
    ]);
  });

  it("is null without a link", () => {
    expect(messageForOwner({ state: "failed" })).toBeNull();
  });
});
