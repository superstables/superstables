// A hosted request asks for the --timeout it was given where the site announces timeout_seconds, shows the expiry the site
// set, and relays the site's notice when it held the request to its limits. Against a fake superstables.com that refuses
// fields it does not list, as both deployments do.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals } from "../../budget/hosted.js";
import { startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const TERMS = { title: "Add this agent", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const GRANT = { kind: "evm-transaction" as const, action: "grant", account: privateKeyToAccount(KEY).address, transaction: { to: USDC, data: "0x095ea7b3", value: "0x0" }, terms: TERMS };

let site: FakeSite;
beforeEach(async () => {
  site = await startFakeSite();
});
afterEach(async () => {
  await site.close();
});
const client = () => new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
const connect = (timeoutMs: number) => client().request({ kind: "connect", terms: TERMS, timeoutMs } as any);
const secondsLeft = (expiresAt: number) => (expiresAt - Date.now()) / 1000;

describe("--timeout on a hosted approval", () => {
  it("asks for the timeout, and the link lasts that long, when the site lists timeout_seconds", async () => {
    site.features = ["timeout_seconds"];
    const h = await connect(1_800_000);
    expect(site.requests[0].body.timeout_seconds).toBe(1800);
    expect(secondsLeft(h.expiresAt)).toBeGreaterThan(1795);
    expect(h.notice).toBeUndefined();
  });

  it("asks for it on a transaction approval too", async () => {
    site.features = ["timeout_seconds"];
    site.owner = privateKeyToAccount(KEY).address;
    const h = await client().request({ ...GRANT, timeoutMs: 900_000 } as any);
    expect(site.requests[0].body.timeout_seconds).toBe(900);
    expect(secondsLeft(h.expiresAt)).toBeGreaterThan(895);
  });

  it("relays the site's notice when it held the timeout to its cap", async () => {
    site.features = ["timeout_seconds"];
    const h = await connect(7_200_000);
    expect(site.requests[0].body.timeout_seconds).toBe(7200);
    expect(secondsLeft(h.expiresAt)).toBeLessThanOrEqual(3600);
    expect(h.notice).toBe("timeout_seconds 7200 is above the most this server allows (10 to 3600 seconds), so the link expires after 3600 seconds");
  });

  it("reports the site's minimum window, not the shorter wait it was given", async () => {
    site.features = ["timeout_seconds"];
    const h = await connect(1_000);
    expect(site.requests[0].body.timeout_seconds).toBe(1);
    expect(secondsLeft(h.expiresAt)).toBeGreaterThan(9);
    expect(h.notice).toContain("below the least");
  });

  it("sends nothing extra to a site that does not list it (production refuses unknown fields)", async () => {
    site.features = ["expected_owner"];
    const h = await connect(1_800_000);
    expect(site.requests[0].body).not.toHaveProperty("timeout_seconds");
    expect(site.posts.every((p) => p.ok)).toBe(true);
    expect(secondsLeft(h.expiresAt)).toBeLessThanOrEqual(600);
  });
});
