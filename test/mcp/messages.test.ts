// The sentence each attempt state is reported with, on both surfaces. The words matter more
// than anything else here: "rejected" is a claim about what the owner did, and it may only be
// made when the owner did it.

import { describe, expect, it } from "vitest";
import type { Attempt, AttemptState } from "../../src/core/types.js";
import { FINAL_ATTEMPT_STATES } from "../../src/core/types.js";
import { messageFor } from "../../src/mcp/server.js";

function attempt(state: AttemptState, extra: Partial<Attempt> = {}): Attempt {
  return {
    id: "a-1",
    quoteId: "q-1",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    state,
    url: "https://seller.example/price?symbol=BTC",
    terms: {
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "USDC",
      assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      recipient: "0x0000000000000000000000000000000000000001",
      scheme: "exact",
      x402Version: 2,
    },
    history: [],
    ...extra,
  };
}

describe("messageFor", () => {
  it("says the owner rejected a payment only when the state is denied", () => {
    for (const state of FINAL_ATTEMPT_STATES) {
      const said = messageFor(attempt(state));
      if (state === "denied") expect(said).toContain("The owner rejected this payment");
      else expect(said).not.toMatch(/owner rejected/i);
    }
  });

  it("reports an abandoned attempt as nobody deciding, with nothing paid", () => {
    const said = messageFor(attempt("abandoned"), undefined, "cli");
    expect(said).toContain("Nobody decided");
    expect(said).toContain("This is not a rejection");
    expect(said).toContain("nothing was paid");
  });

  it("names payment_status on MCP and `superstables status` on the CLI, and the link only on MCP", () => {
    const waiting = attempt("awaiting_approval", { approvalUrl: "http://127.0.0.1:4412/approve/abc" });
    const mcp = messageFor(waiting);
    expect(mcp).toContain("Call payment_status with this attempt_id");
    expect(mcp).toContain("http://127.0.0.1:4412/approve/abc");

    const cli = messageFor(waiting, undefined, "cli");
    expect(cli).toContain("superstables status a-1");
    expect(cli).not.toContain("payment_status");
    // The CLI prints the link once on its own line; the sentence does not repeat it.
    expect(cli).not.toContain("http://127.0.0.1:4412/approve/abc");

    for (const state of ["approved", "submitting"] as const) {
      expect(messageFor(attempt(state), undefined, "cli")).not.toContain("payment_status");
    }
  });
});
