// The approval page has no build step and no test runner of its own, so this guards the two
// things that would be dangerous to lose: it must stay self-contained (nothing loaded from
// another origin, since this page authorises payments), and it must keep saying which facts
// the wallet verified and which ones the agent merely claimed. Both looks (look.ts) are checked.

import { describe, expect, it } from "vitest";
import { walletPage } from "../../src/wallet/page.js";

describe.each(["plain", "superstables"] as const)("the approval page, %s look", (look) => {
  const page = walletPage(look);

  it("loads nothing from anywhere else", () => {
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+href=/i);
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });

  it("says where the key is and that the owner decides", () => {
    expect(page).toContain("The wallet process uses a key file on this computer");
    expect(page).toContain("Approve or reject each payment request.");
  });

  it("labels the agent's own account of the payment as unverified", () => {
    expect(page).toContain("Reported by the agent (not verified)");
  });

  it("offers both decisions, and only those", () => {
    expect(page).toContain("Approve and sign");
    expect(page).toContain("Reject");
  });

  it("escapes everything it renders, reads the secret from the fragment and follows the system theme", () => {
    expect(page).toContain("function esc(value)");
    expect(page).toContain('location.hash.replace(/^#/, "")');
    expect(page).toContain("prefers-color-scheme");
  });
});
