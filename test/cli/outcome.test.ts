// The next step the CLI prints after a payment: what to run, and above all what not to run. An attempt that may have
// paid is never quoted again until `superstables status` says it was not, and only the chain's word says that.

import { describe, expect, it } from "vitest";
import { SOLANA_DEVNET, TEMPO_MODERATO } from "../../src/core/chain.js";
import { exitCodeFor, nextFor } from "../../src/cli/outcome.js";
import type { Attempt, AttemptState } from "../../src/core/types.js";

function attempt(state: AttemptState, extra: Partial<Attempt> = {}, network = "eip155:84532"): Attempt {
  return {
    id: "a-1",
    quoteId: "q-1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    state,
    url: "https://seller.example/x",
    terms: { amountDecimal: 0.01, amountAtomic: "10000", asset: "USDC", assetAddress: "x", network, networkLabel: "x", recipient: "x", scheme: "exact" },
    history: [],
    ...extra,
  };
}

describe("nextFor", () => {
  it("never sends an uncertain payment back to quote: status searches the chain first, on the payment's own explorer", () => {
    for (const network of ["eip155:84532", TEMPO_MODERATO.caip2, SOLANA_DEVNET.caip2]) {
      const said = nextFor(attempt("uncertain", {}, network));
      expect(said, network).toMatch(/^Do not pay again yet\. Run `superstables status a-1`: it searches the chain for this payment\./);
      expect(said, network).toContain("only quote again once `superstables status` says this payment was not made");
    }
    expect(nextFor(attempt("uncertain", {}, SOLANA_DEVNET.caip2))).toContain("https://explorer.solana.com/?cluster=devnet");
    expect(nextFor(attempt("uncertain"))).toContain("https://sepolia.basescan.org;");
    // On Tempo nothing on chain ever says "never": the owner decides, and the cap keeps counting it.
    expect(nextFor(attempt("uncertain", {}, TEMPO_MODERATO.caip2))).toContain("paying again is the owner's decision, and this attempt keeps counting against the daily cap");
    expect(nextFor(attempt("uncertain"))).not.toContain("owner's decision");
  });

  it("says nothing was paid only for a failure the chain or this machine vouches for", () => {
    expect(nextFor(attempt("failed", { chain: "unpaid", transaction: `0x${"ab".repeat(32)}` }))).toMatch(/^Nothing was paid: the chain shows it, and this attempt can no longer settle\./);
    expect(nextFor(attempt("failed", { transaction: `0x${"ab".repeat(32)}` }))).toMatch(/^Do not pay again yet/);
    expect(nextFor(attempt("failed"))).toMatch(/^Nothing was paid\./);
    expect(exitCodeFor(attempt("failed", { chain: "unpaid" }))).toBe(1);
  });

  it("names the check that was unavailable, and the browser wallet with its flag", () => {
    const open = { id: "q-1", status: "open", url: "https://seller.example/x" } as never;
    const used = { id: "q-1", status: "used", url: "https://seller.example/x" } as never;
    // Each retry names its wallet: a flag on `wallet serve` does not carry over to the next command.
    const local = nextFor(attempt("failed", { refusal: "unavailable" }), open);
    expect(local).toBe(
      "The local wallet did not answer. The owner starts it with `superstables --wallet local wallet serve`, then pays the same quote again with `superstables --wallet local pay q-1`. To approve in a browser wallet instead, run `superstables --wallet browser pay q-1`.",
    );
    expect(nextFor(attempt("failed", { refusal: "unavailable" }), used)).toBe(
      "The local wallet did not answer. The owner starts it with `superstables --wallet local wallet serve`. Take a new quote with `superstables quote https://seller.example/x`, then run `superstables --wallet local pay <new-quote-id>`. To approve in a browser wallet instead, run `superstables --wallet browser pay <new-quote-id>` after taking the new quote.",
    );
    const cap = nextFor(attempt("failed", { refusal: "cap_check" }), open);
    expect(cap).toBe("The daily cap could not be checked, so the owner was not asked and nothing was signed. If another `pay` is running, let it finish; then pay the same quote again: `superstables pay q-1`.");
    expect(cap).not.toMatch(/local wallet/);
    const chain = nextFor(attempt("failed", { refusal: "chain" }, TEMPO_MODERATO.caip2), used);
    expect(chain).toContain("`SUPERSTABLES_TEMPO_RPC` when it is set, otherwise https://rpc.moderato.tempo.xyz");
    expect(chain).not.toMatch(/local wallet/);
  });

  it("points a payment the seller reported, and the chain has not confirmed, at status", () => {
    expect(nextFor(attempt("settled", { chain: "verified" }))).toBe("Nothing to do: the service's answer is above, and `superstables receipts` lists the payment.");
    expect(nextFor(attempt("settled", { chain: "unchecked" }))).toContain("The seller reported the payment and the chain has not confirmed it yet; `superstables status a-1` checks again.");
  });
});
