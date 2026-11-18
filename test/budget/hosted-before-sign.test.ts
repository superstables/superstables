// HostedApprovals asks beforeSign right before each agent-key signature on a request to the site: the Tempo and Solana
// rails pass the mainnet boundary there, so a pause set after the command started stops the next signature, and nothing
// signed reaches the site. Against a fake superstables.com.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostedApprovals } from "../../budget/hosted.js";
import { startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const TERMS = { title: "Add this agent", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };

let site: FakeSite;
beforeEach(async () => {
  site = await startFakeSite();
});
afterEach(async () => {
  await site.close();
});

describe("beforeSign", () => {
  it("is asked before the request is signed; when it throws, nothing signed reaches the site", async () => {
    let asked = 0;
    const c = new HostedApprovals({
      site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20,
      beforeSign: () => { asked++; throw new Error("mainnet signing is paused"); },
    });
    await expect(c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 } as any)).rejects.toThrow(/paused/);
    expect(asked).toBeGreaterThan(0);
    expect(site.requests).toEqual([]);
  });

  it("lets the request through when it does not throw", async () => {
    let asked = 0;
    const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, beforeSign: () => { asked++; } });
    const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 } as any);
    expect(h.id).toBeTruthy();
    expect(asked).toBeGreaterThan(0);
  });
});
