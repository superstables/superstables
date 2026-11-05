// The next step the CLI prints after a payment: what to run, and above all what not to run. An attempt that may have
// paid is never quoted again until `superstables status` says it was not, and only the chain's word says that.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOLANA_DEVNET, TEMPO_MODERATO } from "../../src/core/chain.js";
import * as home from "../../src/core/home.js";
import { accountPolicyPath, policyPath } from "../../src/core/home.js";
import { exitCodeFor, nextFor, requoteCommand } from "../../src/cli/outcome.js";
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

describe("nextFor after a spend policy refusal", () => {
  let file: string;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "outcome-policy-")), "policy.yaml");
    vi.stubEnv("SUPERSTABLES_POLICY", file);
    writeFileSync(file, "caps:\n  per_call: 0.05 USDC\n");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("with no policy file, says the default limits refused and how the owner writes a file to change them", () => {
    writeFileSync(file, "");
    const missing = join(file, "..", "none.yaml");
    vi.stubEnv("SUPERSTABLES_POLICY", missing);
    const said = nextFor(attempt("failed", { refusal: "policy", reason: "the local spend policy refuses this payment: 0.5 USDC exceeds caps.per_call (0.05 USDC)" }));
    expect(said).toContain("(caps.per_call)");
    expect(said).toContain(`There is no policy file at ${missing}, so the default limits apply.`);
    expect(said).toContain("the owner runs `superstables policy init` and edits that file.");
    expect(said).not.toContain("set per_call there");
  });

  it("with no policy file in the default home, where the chosen file is the account's own, still says the defaults refused", () => {
    const missing = join(file, "..", "none.yaml");
    vi.stubEnv("SUPERSTABLES_POLICY", missing);
    vi.spyOn(home, "accountPolicyPath").mockReturnValue(missing);
    try {
      const said = nextFor(attempt("failed", { refusal: "policy", reason: "the local spend policy refuses this payment: 0.5 USDC exceeds caps.per_call (0.05 USDC)" }));
      expect(said).toContain(`There is no policy file at ${missing}, so the default limits apply.`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("names the account's policy file when that file refused, else the one the environment names", () => {
    const account = accountPolicyPath();
    const refused = (reason: string) => nextFor(attempt("failed", { refusal: "policy", reason }));
    expect(refused(`the local spend policy refuses this payment: kill_switch is on (in ${account})`)).toContain(`the owner edits ${account} if they are wrong`);
    expect(refused("the local spend policy refuses this payment: 0.5 USDC exceeds caps.per_call (0.05 USDC)")).toContain(`the owner edits ${policyPath()} if they are wrong`);
  });

  it("names the limit that refused and says how to change or remove it", () => {
    const refused = (reason: string) => nextFor(attempt("failed", { refusal: "policy", reason }));
    const perCall = refused("the local spend policy refuses this payment: 0.5 USDC exceeds caps.per_call (0.05 USDC)");
    expect(perCall).toContain("A spend policy refused it (caps.per_call).");
    expect(perCall).toContain("To change this limit, set per_call there to a new value, or to null to remove it.");
    expect(refused("the local spend policy refuses this payment: today's payments (1 USDC) plus 0.5 exceed caps.per_day (1 USDC)")).toContain("(caps.per_day)");
    expect(refused("the local spend policy refuses this payment: kill_switch is on")).toContain("(kill_switch)");
  });
});

describe("requoteCommand", () => {
  const terms = attempt("denied", {}, "eip155:46630").terms;
  const base = { url: "https://seller.example/x", terms };
  it("keeps the quote's chain when the seller offers several, or when the agent asked for one", () => {
    expect(requoteCommand({ ...base, otherChains: ["base-sepolia"] })).toBe("superstables quote https://seller.example/x --chain robinhood-testnet");
    expect(requoteCommand({ ...base, chain: "robinhood-testnet" })).toBe("superstables quote https://seller.example/x --chain robinhood-testnet");
    expect(requoteCommand({ ...base, serviceId: "svc", request: { method: "GET", url: "https://seller.example/x?a=1", params: { a: "1" } }, otherChains: ["base-sepolia"] })).toBe(
      "superstables quote --service svc --param a=1 --chain robinhood-testnet",
    );
  });
  it("quotes a seller's https address again, never the plain http one the client would itself refuse", () => {
    expect(requoteCommand({ ...base, url: "http://seller.example/x?a=1" })).toBe("superstables quote 'https://seller.example/x?a=1'");
    expect(requoteCommand({ ...base, url: "HTTP://seller.example/x" })).toBe("superstables quote https://seller.example/x");
    for (const local of ["http://127.0.0.1:3000/x", "http://localhost/x", "http://[::1]:3000/x"]) {
      expect(requoteCommand({ ...base, url: local }), local).toContain(local);
    }
    // An explicit :80 goes with the scheme; another port stays; credentials in the address are not carried over.
    expect(requoteCommand({ ...base, url: "http://seller.example:80/x" })).toBe("superstables quote https://seller.example/x");
    expect(requoteCommand({ ...base, url: "http://seller.example:8080/x" })).toBe("superstables quote https://seller.example:8080/x");
    expect(requoteCommand({ ...base, url: "http://user:secret@seller.example/x" })).not.toContain("https:");
    expect(requoteCommand({ ...base, url: "http://user@seller.example/x" })).not.toContain("https:");
    expect(requoteCommand({ ...base, url: "not a url" })).toContain("not a url");
  });
  it("adds no chain for a seller on one chain", () => {
    expect(requoteCommand(base)).toBe("superstables quote https://seller.example/x");
  });
});
