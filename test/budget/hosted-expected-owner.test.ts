// Hosted setup names the owner recorded on this machine (expected_owner) where the site announces it, checks the site took
// it, and withdraws a bundle that the site adds to another account. Against a fake superstables.com that refuses fields it
// does not list, as both deployments do.
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { HostedApprovals, HostedRefusal, type HostedRecord, type SolanaAgentKey } from "../../budget/hosted.js";
import { siteWord } from "../../budget/site.mjs";
import { evmOwner, solanaOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const OTHER = evmOwner("33");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TERMS = { title: "Add this agent", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT = { kind: "grant" as const, transaction: { to: USDC, data: "0x095ea7b3", value: "0x0" } };
const SOL_KP = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOL_KEY: SolanaAgentKey = { ed25519: SOL_KP.secretKey, address: SOL_KP.publicKey.toBase58() };
const SOL_OWNER = solanaOwner(8);
const SOL_OTHER = solanaOwner(9);

let site: FakeSite;
let records: HostedRecord[];
beforeEach(async () => {
  site = await startFakeSite();
  records = [];
});
afterEach(async () => {
  await site.close();
});
const evm = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
  new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, onRecord: (r) => records.push(r), ...over });
const connect = (c: HostedApprovals, expectedOwner?: string | null, extra: Record<string, unknown> = {}) =>
  c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, expectedOwner, ...extra } as any);

describe("expected owner on a link", () => {
  it("H1: a site that lists expected_owner gets it, checksummed from lowercase input, and the field is echoed", async () => {
    site.features = ["expected_owner"];
    const h = await connect(evm(), OWNER.toLowerCase());
    expect(site.requests[0].body).toMatchObject({ rail: "evm", agent: AGENT, expected_owner: getAddress(OWNER) });
    expect(h.id).toBeTruthy();
  });

  it("H1s: Solana's base58 owner is sent as it is", async () => {
    site.features = ["expected_owner"];
    await new HostedApprovals({ site: site.url, rail: "solana", chain: "devnet", agentKey: SOL_KEY, pollWaitS: 0, minPollMs: 20 }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, expectedOwner: SOL_OWNER } as any);
    expect(site.requests[0].body.expected_owner).toBe(SOL_OWNER);
  });

  it("H2: a site that announces nothing never gets the field (production refuses unknown fields)", async () => {
    // no /services answer at all
    const none = await connect(evm(), OWNER);
    expect(none.id).toBeTruthy();
    expect(site.requests[0].body).not.toHaveProperty("expected_owner");
    // features that are not a list
    site.services = { features: "expected_owner", services: [] };
    await connect(evm(), OWNER);
    expect(site.requests[1].body).not.toHaveProperty("expected_owner");
    // a list without it
    site.services = undefined;
    site.features = ["something_else"];
    await connect(evm(), OWNER);
    expect(site.requests[2].body).not.toHaveProperty("expected_owner");
    expect(site.posts.every((p) => p.ok)).toBe(true);
  });

  it("H2b: the features list is read once per client", async () => {
    site.features = ["expected_owner"];
    let reads = 0;
    const inner = fetch;
    const c = evm({ fetchImpl: (async (url: string, init?: RequestInit) => { if (String(url).endsWith("/services")) reads++; return inner(url, init); }) as typeof fetch });
    await connect(c, OWNER);
    await connect(c, OWNER);
    expect(reads).toBe(1);
  });

  it("H3: a site that lists the feature and drops the field is refused before a link is shown", async () => {
    site.features = ["expected_owner"];
    site.echoExpectedOwner = false;
    const err = await connect(evm(), OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`did not confirm that only the owner recorded on this machine \\(${getAddress(OWNER)}\\) may add this agent; the request is not used`));
    expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
    expect(records).toEqual([]);
  });

  it("H4: 409 expected_owner_mismatch is refused with the other account named and nothing created", async () => {
    site.features = ["expected_owner"];
    site.linked = { [AGENT.toLowerCase()]: OTHER };
    const err = await connect(evm(), OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`already belongs to another account \\(${getAddress(OTHER)}\\), not the owner recorded on this machine \\(${getAddress(OWNER)}\\); nothing was created or sent`));
    expect(err.next).toMatch(/--new-owner/);
    expect(site.requests).toEqual([]);
  });

  it("H5: a site that lists the feature and still answers unknown_parameter is refused, not retried without the field", async () => {
    site.features = ["expected_owner"];
    site.refuse = { status: 400, error: { code: "unknown_parameter", message: "x" } };
    const err = await connect(evm(), OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/unknown_parameter/);
    expect(site.posts).toHaveLength(1);
  });

  it("H7: with --new-owner nothing is sent", async () => {
    site.features = ["expected_owner"];
    await connect(evm(), OWNER, { newOwner: true });
    expect(site.requests[0].body).not.toHaveProperty("expected_owner");
  });

  it("H7b: a connect with no recorded owner sends nothing", async () => {
    site.features = ["expected_owner"];
    await connect(evm(), undefined);
    expect(site.requests[0].body).not.toHaveProperty("expected_owner");
  });
});

describe("a bundle the site adds to another account", () => {
  it("H6: evm, on a site without the feature: withdrawn, nothing recorded, no wallet step", async () => {
    site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: OTHER }); };
    const h = await connect(evm(), OWNER, { then: [GRANT] });
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "rejected", sending: false });
    expect(b.link.status === "rejected" && b.link.reason).toMatch(new RegExp(`reported the agent as added to ${OTHER}, but this machine records the owner ${getAddress(OWNER)}\\. Nothing was recorded; its wallet steps were withdrawn`));
    expect(b.steps[0].state).toMatch(/skipped|cancelled/);
    expect(b.steps[0].walletAsked).toBe(false);
    expect(site.requests[0].cancels).toBeGreaterThanOrEqual(1);
  });

  it("H6s: solana", async () => {
    site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: SOL_OTHER }); };
    const c = new HostedApprovals({ site: site.url, rail: "solana", chain: "devnet", agentKey: SOL_KEY, pollWaitS: 0, minPollMs: 20 });
    const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, expectedOwner: SOL_OWNER, then: [{ kind: "grant", solana: { amount_atomic: "1" } }] } as any);
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "rejected", sending: false });
    expect(b.steps[0].walletAsked).toBe(false);
  });

  it("H6t: tempo", async () => {
    site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: OTHER }); };
    const c = new HostedApprovals({ site: site.url, rail: "tempo", chain: "moderato", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
    const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, expectedOwner: OWNER, then: [{ kind: "grant", transaction: { to: USDC, data: "0x980a6025", value: "0x0" } }] } as any);
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "rejected", sending: false });
  });

  it("the expected owner itself is accepted", async () => {
    site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER }); };
    const h = await connect(evm(), OWNER, { then: [GRANT] });
    // the owner proof is signed by the fake site; the first step is then the wallet's
    site.requests[0].steps![0].state = "confirmed";
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "connected" });
  });

  it("H7c: with --new-owner the bundle may link any owner", async () => {
    site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: OTHER }); };
    const h = await connect(evm(), OWNER, { then: [GRANT], newOwner: true });
    site.requests[0].steps![0].state = "confirmed";
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "connected", address: OTHER });
  });
});

describe("words", () => {
  it("H8: every code the budget API documents is named, allowance_live included", () => {
    for (const c of ["expected_owner_mismatch", "expected_owner_unproven", "invalid_expected_owner", "invalid_request", "key_live", "owner_unknown", "owner_wallet_removed", "owner_wallet_required", "allowance_live", "page_stopped_before_send"]) {
      expect(siteWord("code", c)).toBe(c);
    }
    expect(siteWord("code", "made_up")).toBe("unexpected");
  });
});
