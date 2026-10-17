// Owner proof v2 (the text that names the account the agent joins), against a fake superstables.com that lists
// `owner_proof_v2` the way the site does: the client asks for it, only on a site that lists it, checks the echo, and
// accepts exactly the text it asked for.
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { HostedApprovals, HostedRefusal, OWNER_PROOF_TITLE_V2, ownerProofProblem, ownerProofText, type HostedRecord, type SolanaAgentKey } from "../../budget/hosted.js";
import { siteWord } from "../../budget/site.mjs";
import { ACCOUNT_ID, evmOwner, linkProofText, signLinkProof, solanaOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = evmOwner("22");
const OTHER_ACCOUNT = "9b2f5a3e-1c4d-4e6f-8a7b-0c1d2e3f4a5b";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TERMS = { title: "Add this agent", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT = { kind: "grant" as const, transaction: { to: USDC, data: "0x095ea7b3", value: "0x0" } };
const SOL_KP = Keypair.fromSeed(new Uint8Array(32).fill(7));
const SOL_KEY: SolanaAgentKey = { ed25519: SOL_KP.secretKey, address: SOL_KP.publicKey.toBase58() };
const SOL_OWNER = solanaOwner(8);

let site: FakeSite;
let records: HostedRecord[];
beforeEach(async () => {
  site = await startFakeSite();
  records = [];
});
afterEach(async () => {
  await site.close();
});
const evm = () => new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20, onRecord: (r) => records.push(r) });
const linkOnSecondRead = (owner: string = OWNER) => { site.onPoll = (r) => { if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner }); }; };
const connect = (c: HostedApprovals = evm(), extra: Record<string, unknown> = {}) => c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...extra } as any);

describe("owner proof v2 on a site that lists it", () => {
  it("V1: the body asks for version 2, and a v2 proof naming the account links", async () => {
    site.features = ["owner_proof_v2"];
    linkOnSecondRead();
    const h = await connect();
    expect(site.requests[0].body).toEqual({ rail: "evm", chain: "base-sepolia", agent: AGENT, owner_proof_version: 2 });
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
    // the signed text is the nine lines the protocol freezes
    const text = (site.requests[0].owner_proof as { message: string }).message.split("\n");
    expect(text).toHaveLength(9);
    expect(text[0]).toBe("Superstables: add an agent to my account (v2)");
    expect(text[8]).toBe(`account: ${ACCOUNT_ID}`);
    expect(text[8]).toMatch(/^account: [0-9a-f-]{36}$/);
  });

  it("V1b: a link with wallet steps (the bundle) accepts the v2 proof too", async () => {
    site.features = ["owner_proof_v2"];
    linkOnSecondRead();
    const h = await connect(evm(), { then: [GRANT] });
    expect(site.requests[0].body.owner_proof_version).toBe(2);
    site.requests[0].steps![0].state = "confirmed";
    expect((await h.bundle!).link).toEqual({ status: "connected", address: OWNER });
  });

  it("V1s: on Solana", async () => {
    site.features = ["owner_proof_v2"];
    linkOnSecondRead(SOL_OWNER);
    const c = new HostedApprovals({ site: site.url, rail: "solana", chain: "devnet", agentKey: SOL_KEY, pollWaitS: 0, minPollMs: 20 });
    const h = await connect(c);
    expect(site.requests[0].body.owner_proof_version).toBe(2);
    expect(await h.settled).toEqual({ status: "connected", address: SOL_OWNER });
  });

  it("V2 (adversarial): a v2 link answered with the v1 text is refused, and nothing is recorded", async () => {
    site.features = ["owner_proof_v2"];
    site.proofText = 1;
    linkOnSecondRead();
    const h = await connect();
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/for another add-agent request.*Nothing was recorded/) });
  });

  it("V2b (adversarial): the same in a bundle: the link is rejected and its steps are withdrawn", async () => {
    site.features = ["owner_proof_v2"];
    site.proofText = 1;
    linkOnSecondRead();
    const h = await connect(evm(), { then: [GRANT] });
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "rejected", sending: false });
    expect(b.steps[0].walletAsked).toBe(false);
  });

  it("V3 (adversarial): a link that did not ask for v2 and is answered with the v2 text is refused", async () => {
    // no feature: the client sends nothing, and a site that signs the nine lines anyway proves nothing for a v1 link
    site.proofText = 2;
    linkOnSecondRead();
    const h = await connect();
    expect(site.requests[0].body).toEqual({ rail: "evm", chain: "base-sepolia", agent: AGENT });
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/for another add-agent request/) });
  });

  it("V4 (adversarial): an account line that differs from the view's account_id is refused", async () => {
    site.features = ["owner_proof_v2"];
    site.proofAccount = OTHER_ACCOUNT;
    linkOnSecondRead();
    const h = await connect();
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/for another add-agent request/) });
  });

  it("V5: no account_id on a v2 link, or one that is not a UUID, is refused", async () => {
    site.features = ["owner_proof_v2"];
    site.omitAccountId = true;
    linkOnSecondRead();
    const h = await connect();
    expect(await h.settled).toMatchObject({ status: "rejected", reason: expect.stringMatching(/account/) });
    for (const bad of ["not-a-uuid", "0F8FAD5B-D9CB-469F-A165-70867728950E", `${ACCOUNT_ID}\nowner: x`]) {
      site.omitAccountId = false;
      site.viewAccountId = bad;
      site.proofAccount = bad;
      const g = await connect();
      expect(await g.settled, bad).toMatchObject({ status: "rejected" });
    }
  });

  it("V6: a site that lists nothing gets no field, and v1 links exactly as before", async () => {
    linkOnSecondRead();
    const h = await connect();
    expect(site.requests[0].body).toEqual({ rail: "evm", chain: "base-sepolia", agent: AGENT });
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
    expect((site.requests[0].owner_proof as { message: string }).message).toBe(linkProofText({ site: site.origin, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: site.requests[0].id, code: "ABC-DEF" }));
    // a list with other features only
    site.features = ["expected_owner"];
    await connect();
    expect(site.requests[1].body).not.toHaveProperty("owner_proof_version");
  });

  it("V8 (adversarial): a site that lists the feature and does not repeat the version is refused before a link is shown", async () => {
    site.features = ["owner_proof_v2"];
    site.echoProofVersion = false;
    const err = await connect().catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/did not confirm the owner proof that names the account; the request is not used/);
    expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
    expect(records).toEqual([]);
  });

  it("V8b (adversarial): an echo of version 1 for a request that asked for 2 is refused too", async () => {
    site.features = ["owner_proof_v2"];
    site.answerCreated = (b) => ({ ...b, owner_proof_version: 1 });
    const err = await connect().catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(site.requests[0]).toMatchObject({ state: "cancelled" });
    expect(records).toEqual([]);
  });
});

describe("an agent already linked, answered with a v2 proof", () => {
  const LINK = "bl_test0042";
  const CODE = "QRS-TUV";
  const prior = { owner: OWNER, linkId: LINK, linkCode: CODE };
  const facts = () => ({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: LINK, code: CODE });
  const answer = (extra: Record<string, unknown>) => () => ({ status: 200, body: { id: LINK, access_token: "ssbt_test_bl_test0042secret", state: "linked", final: true, owner: OWNER, approval: null, next_action: { type: "none" }, ...extra } });

  it("V7: the recorded link, proven over the answer's account_id, is accepted", async () => {
    site.features = ["owner_proof_v2"];
    site.reply = answer({ owner_proof: await signLinkProof({ ...facts(), account: ACCOUNT_ID }), owner_proof_version: 2, account_id: ACCOUNT_ID });
    const h = await connect(evm(), { prior });
    expect(h).toMatchObject({ alreadyLinked: true, link: { id: LINK, code: CODE } });
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
  });

  it("V7b: a v1 proof for the recorded link is accepted as well (the link is the client's own earlier one)", async () => {
    site.features = ["owner_proof_v2"];
    site.reply = answer({ owner_proof: await signLinkProof(facts()), owner_proof_version: 1 });
    expect(await (await connect(evm(), { prior })).settled).toEqual({ status: "connected", address: OWNER });
  });

  it("V7c (adversarial): a v2 proof whose account differs from the answer's account_id, or an answer with no account_id, is refused", async () => {
    site.features = ["owner_proof_v2"];
    site.reply = answer({ owner_proof: await signLinkProof({ ...facts(), account: ACCOUNT_ID }), owner_proof_version: 2, account_id: OTHER_ACCOUNT });
    const err = await connect(evm(), { prior }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/its answer does not prove it/);
    site.reply = answer({ owner_proof: await signLinkProof({ ...facts(), account: ACCOUNT_ID }), owner_proof_version: 2 });
    expect(await connect(evm(), { prior }).catch((e) => e)).toBeInstanceOf(HostedRefusal);
  });
});

describe("the texts", () => {
  const f = { site: "https://www.superstables.com", owner: OWNER, agent: AGENT, rail: "evm" as const, chain: "base-sepolia", linkId: "bl_x1234", code: "ABC-DEF" };
  it("v2 is the v2 title, the seven v1 field lines, then account:", async () => {
    expect(OWNER_PROOF_TITLE_V2).toBe("Superstables: add an agent to my account (v2)");
    const v1 = ownerProofText(f).split("\n");
    expect(ownerProofText(f, { version: 2, account: ACCOUNT_ID }).split("\n")).toEqual([OWNER_PROOF_TITLE_V2, ...v1.slice(1), `account: ${ACCOUNT_ID}`]);
    expect(ownerProofText(f, { version: 2, account: ACCOUNT_ID })).toBe(linkProofText({ ...f, account: ACCOUNT_ID }));
    expect(() => ownerProofText(f, { version: 2 })).toThrow();
    expect(() => ownerProofText(f, { version: 2, account: "x" })).toThrow();
  });
  it("a proof is checked as the version asked for, and only that", async () => {
    const v1 = await signLinkProof(f);
    const v2 = await signLinkProof({ ...f, account: ACCOUNT_ID });
    expect(await ownerProofProblem(v1, f)).toBe("");
    expect(await ownerProofProblem(v2, f, { version: 2, account: ACCOUNT_ID })).toBe("");
    expect(await ownerProofProblem(v1, f, { version: 2, account: ACCOUNT_ID })).toMatch(/for another add-agent request/);
    expect(await ownerProofProblem(v2, f)).toMatch(/for another add-agent request/);
    expect(await ownerProofProblem(v2, f, { version: 2, account: OTHER_ACCOUNT })).toMatch(/for another add-agent request/);
    expect(await ownerProofProblem(v2, f, { version: 2 })).toMatch(/account/);
    expect(await ownerProofProblem(v2, f, { version: 2, account: "not-a-uuid" })).toMatch(/account/);
  });
  it("the site's new words are named", () => {
    expect(siteWord("code", "invalid_owner_proof_version")).toBe("invalid_owner_proof_version");
    expect(siteWord("code", "token_expired")).toBe("token_expired");
  });
});
