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
      "0.2 test USDC on Arc Testnet. Testnet only. Test tokens, no real money.",
      "This needs a superstables.com account: the link asks you to sign in with your wallet first (a message, no fee).",
      "Tell me when you've approved.",
    ].join("\n"));
  });

  it("names a gas token as it is, and says where to open a page on this machine", () => {
    const m = messageForOwner({ url: "http://127.0.0.1:4413/approve/x", chain: "base-sepolia", terms: { title: "Send gas to the agent", amount: "0.002", unit: "ETH" } });
    expect(m).toContain("0.002 ETH (testnet) on Base Sepolia.");
    expect(m).toContain("Open it in the browser that has your wallet, on this machine.");
    expect(m).not.toContain("Match code");
  });

  it("names the site when the link is not on www.superstables.com", () => {
    const m = messageForOwner({ url: "https://staging.superstables.com/approve/budget/ba_1#ssba_test_x", matchCode: "QRS-TUV", chain: "base-sepolia", terms: { title: "Approve a budget", amount: "0.2", unit: "USDC" } });
    expect(m!.split("\n").slice(0, 3)).toEqual([
      "Review and approve in your wallet: Approve a budget",
      "This approval link is on staging.superstables.com, not www.superstables.com.",
      "https://staging.superstables.com/approve/budget/ba_1#ssba_test_x",
    ]);
  });

  const inMin = (n: number) => new Date(Date.now() + n * 60_000 + 5_000).toISOString();
  const evmGrant = { enforced: ["Withdrawals under this allowance total at most 5 USDC. Spending the allowance does not recover funds already withdrawn.", "Each withdrawal is limited by your token balance at that time."], notEnforced: ["No expiry."] };

  it("a hosted evm setup with a grant has the account note, the total-cap-only line and the expiry", () => {
    const m = messageForOwner({ command: "setup", rail: "evm", url: "https://www.superstables.com/approve/budget/bl_1#ssba_x", matchCode: "ABC-DEF", chain: "base-sepolia", expires: inMin(10), hosted: { site: "https://www.superstables.com" }, terms: { title: "Add agent, gas and budget", amount: "5", unit: "USDC", ...evmGrant } })!.split("\n");
    expect(m).toContain("This needs a superstables.com account: the link asks you to sign in with your wallet first (a message, no fee).");
    expect(m).toContain("The chain enforces a total cap of 5 USDC only: no expiry, no seller list and no per-payment limit.");
    expect(m).toContain("The link expires in 10 minutes.");
    expect(m.at(-1)).toBe("Tell me when you've approved.");
  });

  it("a local grant has the ssh line and no account note", () => {
    const m = messageForOwner({ command: "grant", rail: "evm", url: "http://127.0.0.1:4413/approve/x", chain: "base-sepolia", expires: inMin(10), terms: { title: "Grant a budget", amount: "5", unit: "USDC", ...evmGrant } })!.split("\n");
    expect(m).toContain("Over SSH, forward the port first: ssh -L 4413:127.0.0.1:4413 user@this-host");
    expect(m).toContain("Open it in the browser that has your wallet, on this machine.");
    expect(m.join("\n")).not.toContain("account");
  });

  it("a tempo grant names the total cap and the expiry", () => {
    const m = messageForOwner({ command: "grant", rail: "tempo", url: "http://127.0.0.1:4413/approve/x", chain: "moderato", expires: inMin(10), terms: { title: "Grant a budget", amount: "5", unit: "pathUSD", enforced: ["A total limit of 5 pathUSD. Once the agent has used it, it can spend nothing more.", "The expiry. After 2026-10-19T12:00:00.000Z every payment the key signs is refused.", "These limits apply to transactions using this access key, even if the key is stolen."], notEnforced: ["No per-payment limit."] } })!;
    expect(m).toContain("The chain enforces a total cap of 5 pathUSD and an expiry (2026-10-19T12:00:00.000Z); no per-payment limit.");
    expect(m).toContain("The link expires in 10 minutes.");
  });

  it("buy-once has the account note and the expiry, and no enforcement line", () => {
    const m = messageForOwner({ command: "buy-once", rail: "evm", url: "https://www.superstables.com/approve/purchase/p_1#ssba_x", matchCode: "ABC-DEF", chain: "base-sepolia", expires: inMin(10), service: { id: "demo-market-data" }, hosted: { site: "https://www.superstables.com", requestId: "p_1", payTo: "0x1234567890abcdef1234567890abcdef12345678" }, terms: { title: "Buy once", amount: "0.01", unit: "USDC", enforced: ["Your wallet sends one transfer of exactly 0.01 USDC to 0x1234."], notEnforced: [] } })!;
    expect(m).toContain("This needs a superstables.com account");
    expect(m).toContain("The link expires in 10 minutes.");
    expect(m).toContain("Paid to 0x1234...5678 for demo-market-data");
    expect(m).not.toContain("The chain enforces");
  });

  it("names the other site in the account note", () => {
    const m = messageForOwner({ command: "setup", rail: "evm", url: "https://staging.superstables.com/approve/budget/ba_1#x", chain: "base-sepolia", hosted: { site: "https://staging.superstables.com" }, terms: { title: "Add agent" } });
    expect(m).toContain("This needs a staging.superstables.com account");
  });

  it("is null without a link", () => {
    expect(messageForOwner({ state: "failed" })).toBeNull();
  });
});
