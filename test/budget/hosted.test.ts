// Hosted owner approvals (budget/hosted.ts, budget/site.mjs) against a fake superstables.com: the agent proof, and each way
// a link or an approval can end. No network, no real key.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentProof, agentProofText, bodyHash, HostedApprovals, HostedRefusal, ownerProofProblem, ownerProofText, type HostedRecord, type SolanaAgentKey } from "../../budget/hosted.js";
import { cancelSiteRequest, chosenSite, listSiteServices, siteName, siteOrigin, siteText } from "../../budget/site.mjs";
import { agentProofV2Text, evmOwner, evmOwnerKey, linkProofText, signLinkProof, solanaOwner, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { startServer } from "../helpers/servers.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
// owners with test keys: the fake site signs their link proofs
const OWNER = evmOwner("22");
const OTHER = evmOwner("33");
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };

describe("agent proof v2", () => {
  const body = JSON.stringify({ rail: "evm", chain: "base-sepolia", agent: AGENT });
  const NONCE = "0123456789abcdef0123456789abcdef";
  const SITE = "https://www.superstables.com";

  it("signs the exact six-line text: title, the site's origin, method and path, body hash, timestamp, nonce", () => {
    expect(agentProofText(SITE, "post", "/api/v1/budget/links", body, 1790000000, NONCE)).toBe(
      `Superstables agent request v2\norigin: https://www.superstables.com\nPOST /api/v1/budget/links\n${bodyHash(body)}\n1790000000\n${NONCE}`,
    );
    // the same text as the protocol spells it (the fake site's own copy)
    expect(agentProofText(SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE)).toBe(agentProofV2Text(SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE));
    expect(bodyHash(body)).toBe("13ab74767264fb6bd2284b40709ed621f7c83a9f11c12196c86ab7030c96c9c2");
    // the hash is over the bytes sent, so one changed byte changes it
    expect(bodyHash(body + " ")).not.toBe(bodyHash(body));
  });

  it("gives a fixed signature for a fixed key, site, timestamp and nonce, with the nonce header", async () => {
    const proof = await agentProof(KEY, SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE);
    expect(proof.headers).toEqual({
      "Superstables-Agent": "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      "Superstables-Agent-Timestamp": "1790000000",
      "Superstables-Agent-Nonce": NONCE,
      "Superstables-Agent-Signature":
        "0x2b45e60e64bc05c09ea16495d9c3ffc9f8739318c45da02e2c98c9337f3e78193666d6c10b72d2478345421cba3f3c588d7ec5dd4548dad0e9c2ff59fd22d2a01c",
    });
    const signer = await recoverMessageAddress({ message: agentProofText(SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE), signature: proof.headers["Superstables-Agent-Signature"] as `0x${string}` });
    expect(signer).toBe(AGENT);
    // signed for one site, it is not a proof for another: the text names the origin
    const other = await recoverMessageAddress({ message: agentProofText("https://evil.example", "POST", "/api/v1/budget/links", body, 1790000000, NONCE), signature: proof.headers["Superstables-Agent-Signature"] as `0x${string}` });
    expect(other).not.toBe(AGENT);
  });

  it("a fresh nonce for every request: 32 lowercase hex characters", async () => {
    const a = await agentProof(KEY, SITE, "POST", "/api/v1/budget/links", body);
    const b = await agentProof(KEY, SITE, "POST", "/api/v1/budget/links", body);
    expect(a.headers["Superstables-Agent-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(b.headers["Superstables-Agent-Nonce"]).not.toBe(a.headers["Superstables-Agent-Nonce"]);
    await expect(agentProof(KEY, SITE, "POST", "/x", body, 1, "ABC")).rejects.toThrow(/nonce/);
  });

  it("a site whose own origin is not the one signed refuses the request (a proof replayed to another site)", async () => {
    const site = await startFakeSite();
    try {
      // the agent signs for its site URL; this site's canonical origin is another one
      site.origin = "https://staging.superstables.com";
      const err = await new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      // the site's envelope: { error: { code: "agent_proof", reason: "signature", message } }; a wrong origin is a bad signature
      expect(err.message).toMatch(/HTTP 401 agent_proof \(signature\): The signature does not verify for https:\/\/staging\.superstables\.com.*nothing was sent/);
      expect(site.requests).toEqual([]);
    } finally {
      await site.close();
    }
  });

  it("the site sees the four headers, and a replayed nonce is refused", async () => {
    const site = await startFakeSite();
    try {
      const c = new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
      await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
      const h = site.headers[0];
      expect(h["superstables-agent"]).toBe(AGENT);
      expect(h["superstables-agent-nonce"]).toMatch(/^[0-9a-f]{32}$/);
      expect(h["superstables-agent-timestamp"]).toMatch(/^\d+$/);
      expect(h["superstables-agent-signature"]).toMatch(/^0x[0-9a-f]{130}$/);
      // the very same signed request again: the site names the request it created (409 proof_reused), and creates no other
      const same = (hd: Record<string, string>) => ({ ...Object.fromEntries(["superstables-agent", "superstables-agent-timestamp", "superstables-agent-nonce", "superstables-agent-signature"].map((k) => [k, hd[k]])), "content-type": "application/json" });
      const again = await fetch(`${site.url}/api/v1/budget/links`, { method: "POST", headers: same(h), body: JSON.stringify(site.requests[0].body) });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "proof_reused", id: "bl_test0001" } });
      // a request the site refused uses its nonce up: the same signed request again is replayed (401)
      site.refuse = { status: 503, error: "try again" };
      await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch(() => null);
      site.refuse = undefined;
      const replay = await fetch(`${site.url}/api/v1/budget/links`, { method: "POST", headers: same(site.headers[2]), body: JSON.stringify(site.requests[0].body) });
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ error: { code: "agent_proof", reason: "replayed" } });
      expect(site.requests).toHaveLength(1);
      await c.close();
    } finally {
      await site.close();
    }
  });
});

describe("owner link proof", () => {
  const facts = { site: "https://www.superstables.com", owner: OWNER, agent: AGENT, rail: "evm" as const, chain: "base-sepolia", linkId: "bl_0123456789abcdef0123456789abcdef", code: "ABC-DEF" };

  it("is the exact eight-line text, with the owner checksummed", () => {
    expect(ownerProofText({ ...facts, owner: OWNER.toLowerCase() })).toBe(
      `Superstables: link an agent to my account\nsite: https://www.superstables.com\nowner: ${OWNER}\nagent: ${AGENT}\nrail: evm\nchain: base-sepolia\nlink: bl_0123456789abcdef0123456789abcdef\ncode: ABC-DEF`,
    );
    expect(ownerProofText(facts)).toBe(linkProofText(facts));
    const sol = { ...facts, owner: solanaOwner(8), agent: solanaOwner(7), rail: "solana" as const, chain: "devnet" };
    expect(ownerProofText(sol)).toBe(linkProofText(sol));
  });

  it("accepts the owner's own signature over that text, and nothing else", async () => {
    expect(await ownerProofProblem(await signLinkProof(facts), facts)).toBe("");
    // missing
    expect(await ownerProofProblem(undefined, facts)).toMatch(/no owner proof/);
    // another scheme
    expect(await ownerProofProblem({ ...(await signLinkProof(facts)), scheme: "ed25519" }, facts)).toMatch(/not eip191/);
    // signed by someone else
    expect(await ownerProofProblem(await signLinkProof(facts, { key: evmOwnerKey("33") }), facts)).toMatch(new RegExp(`signed by ${OTHER}, not ${OWNER}`));
    // a proof for another link id, another code, another agent, another site or another chain
    for (const over of [{ linkId: "bl_ffffffffffffffffffffffffffffffff" }, { code: "XYZ-UVW" }, { agent: OTHER }, { site: "https://staging.superstables.com" }, { chain: "arc-testnet" }]) {
      expect(await ownerProofProblem(await signLinkProof({ ...facts, ...over }), facts), JSON.stringify(over)).toMatch(/for another link/);
    }
    // a signed message that is not the text: refused even though the signature is the owner's
    expect(await ownerProofProblem(await signLinkProof(facts, { message: "hello" }), facts)).toMatch(/for another link/);
    // the same text with a trailing newline is another text
    expect(await ownerProofProblem(await signLinkProof(facts, { message: `${linkProofText(facts)}\n` }), facts)).toMatch(/for another link/);
  });

  it("solana: ed25519 by the base58 owner", async () => {
    const sol = { ...facts, owner: solanaOwner(8), agent: solanaOwner(7), rail: "solana" as const, chain: "devnet" };
    expect(await ownerProofProblem(await signLinkProof(sol), sol)).toBe("");
    expect(await ownerProofProblem(await signLinkProof(sol, { key: (await import("../helpers/fake-site.js")).solanaOwnerKeypair(9).secretKey }), sol)).toMatch(/not signed by/);
    expect(await ownerProofProblem({ ...(await signLinkProof(sol)), scheme: "eip191" }, sol)).toMatch(/not ed25519/);
  });
});

describe("site URL", () => {
  it("takes superstables.com, its subdomains and this computer; another site only with the owner's exact opt-in", () => {
    const before = process.env.SUPERSTABLES_ALLOW_SITE;
    try {
      delete process.env.SUPERSTABLES_ALLOW_SITE;
      expect(siteOrigin("https://superstables.com").origin).toBe("https://superstables.com");
      expect(siteOrigin("https://staging.superstables.com").origin).toBe("https://staging.superstables.com");
      expect(siteOrigin("https://localhost:8443").origin).toBe("https://localhost:8443");
      for (const bad of ["https://evil.example", "https://superstables.com.evil.example", "https://evilsuperstables.com", "https://xn--superstables-xyz.com"]) {
        expect(siteOrigin(bad).error, bad).toMatch(/is not superstables\.com.*SUPERSTABLES_ALLOW_SITE=.*an agent never sets it/);
      }
      process.env.SUPERSTABLES_ALLOW_SITE = "https://approvals.example.org";
      expect(siteOrigin("https://approvals.example.org").origin).toBe("https://approvals.example.org");
      expect(siteOrigin("https://approvals.example.org:8443").error).toMatch(/is not superstables\.com/);
      expect(siteOrigin("https://evil.example").error).toMatch(/is not superstables\.com/);
      // the opt-in never makes plain http acceptable off this computer
      process.env.SUPERSTABLES_ALLOW_SITE = "http://approvals.example.org";
      expect(siteOrigin("http://approvals.example.org").error).toMatch(/https/);
      expect(chosenSite(undefined).origin).toBe("https://www.superstables.com");
    } finally {
      if (before === undefined) delete process.env.SUPERSTABLES_ALLOW_SITE;
      else process.env.SUPERSTABLES_ALLOW_SITE = before;
    }
  });

  it("names the site: superstables.com for the default, else its host", () => {
    expect(siteName("https://www.superstables.com")).toBe("superstables.com");
    expect(siteName("https://staging.superstables.com")).toBe("staging.superstables.com");
    expect(siteName("http://127.0.0.1:4000")).toBe("127.0.0.1:4000");
  });

  it("site text loses control, zero-width and bidi characters", () => {
    expect(siteText("a\u001b[31mb\nc")).toBe("a [31mb c");
    expect(siteText("pay\u202eevil\u202c to \u200bme\u2066x\u2069\ufeff")).toBe("payevil to mex");
  });

  it("takes an https origin, or http on this computer only", () => {
    expect(siteOrigin("https://www.superstables.com").origin).toBe("https://www.superstables.com");
    expect(siteOrigin("https://www.superstables.com/").origin).toBe("https://www.superstables.com");
    expect(siteOrigin("http://127.0.0.1:3000").origin).toBe("http://127.0.0.1:3000");
    expect(siteOrigin("http://example.com").error).toMatch(/https/);
    expect(siteOrigin("https://www.superstables.com/api").error).toMatch(/origin only/);
    expect(siteOrigin("https://user:pw@www.superstables.com").error).toMatch(/password/);
  });

  it("defaults to superstables.com, and SUPERSTABLES_SITE overrides it", () => {
    const before = process.env.SUPERSTABLES_SITE;
    try {
      delete process.env.SUPERSTABLES_SITE;
      expect(chosenSite(undefined).origin).toBe("https://www.superstables.com");
      process.env.SUPERSTABLES_SITE = "http://localhost:4000";
      expect(chosenSite(undefined).origin).toBe("http://localhost:4000");
      expect(chosenSite("https://staging.superstables.com").origin).toBe("https://staging.superstables.com");
    } finally {
      if (before === undefined) delete process.env.SUPERSTABLES_SITE;
      else process.env.SUPERSTABLES_SITE = before;
    }
  });
});

describe("hosted approvals", () => {
  let site: FakeSite;
  let dir: string;
  let records: HostedRecord[];
  const client = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    new HostedApprovals({ site: site.url, rail: "evm", chain: "base-sepolia", agentKey: KEY, auditPath: join(dir, "audit.jsonl"), onRecord: (r) => records.push(r), pollWaitS: 0, minPollMs: 20, ...over });
  const grant = (c: HostedApprovals, timeoutMs = 60_000) =>
    c.request({ kind: "evm-transaction", action: "grant", account: OWNER, transaction: GRANT_TX, terms: TERMS, timeoutMs });

  beforeEach(async () => {
    site = await startFakeSite();
    dir = mkdtempSync(join(tmpdir(), "ss-hosted-"));
    records = [];
  });
  afterEach(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links the agent and settles as connected with the account's address", async () => {
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
    };
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    expect(h.url).toMatch(new RegExp(`^${site.url}/approve/budget/bl_test0001#ssba_`));
    expect(h.matchCode).toBe("ABC-DEF");
    expect(h.link).toEqual({ id: "bl_test0001", code: "ABC-DEF" });
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
    // the site sent the owner's proof over this very link, and the client checked it
    expect(site.requests[0].owner_proof).toMatchObject({ scheme: "eip191", message: linkProofText({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: "bl_test0001", code: "ABC-DEF" }) });
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].body).toEqual({ rail: "evm", chain: "base-sepolia", agent: AGENT });
    // the token goes to the record, never to the audit file
    expect(records).toEqual([{ site: site.url, requestId: "bl_test0001", token: "ssbt_test_bl_test0001secret", kind: "link", matchCode: "ABC-DEF" }]);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("ssbt_");
  });

  describe("an agent already linked on this chain", () => {
    const LINK = "bl_test0042";
    const CODE = "QRS-TUV";
    const facts = () => ({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: LINK, code: CODE });
    const answer = (owner: string, owner_proof: unknown) => () => ({ status: 200, body: { id: LINK, access_token: "ssbt_test_bl_test0042secret", state: "linked", final: true, owner, owner_proof, approval: null, next_action: { type: "none" } } });
    const connect = (over: Record<string, unknown> = {}) => client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, ...over } as any);

    it("accepted for the owner recorded here, with a proof over the link recorded here: no link, no wait", async () => {
      site.reply = answer(OWNER, await signLinkProof(facts()));
      const h = await connect({ prior: { owner: OWNER, linkId: LINK, linkCode: CODE } });
      expect(h).toMatchObject({ id: LINK, url: "", matchCode: "", alreadyLinked: true, link: { id: LINK, code: CODE } });
      expect(await h.settled).toEqual({ status: "connected", address: OWNER });
      expect(site.posts[0]).toMatchObject({ path: "/api/v1/budget/links", ok: true });
      // nothing to poll, nothing stored
      expect(site.requests).toEqual([]);
      expect(records).toEqual([]);
    });

    it("refused when no owner is recorded here: the site's word alone makes no owner", async () => {
      site.reply = answer(OWNER, await signLinkProof(facts()));
      const err = await connect().catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.message).toMatch(/already linked to .*but this computer has no record of that link.*nothing was recorded or sent\. The owner removes it on their .* account page and links it again/);
      expect(err.next).toMatch(/remove this agent from their account.*fresh link/);
    });

    it("refused with --new-owner, even with a valid proof", async () => {
      site.reply = answer(OWNER, await signLinkProof(facts()));
      const err = await connect({ prior: { owner: OWNER, linkId: LINK, linkCode: CODE }, newOwner: true }).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.message).toMatch(/a new owner is recorded only from a fresh link the owner signs/);
    });

    it("refused for another owner than the one recorded, even with that owner's valid proof", async () => {
      site.reply = answer(OTHER, await signLinkProof({ ...facts(), owner: OTHER }));
      const err = await connect({ prior: { owner: OWNER, linkId: LINK, linkCode: CODE } }).catch((e) => e);
      expect(err).toBeInstanceOf(HostedRefusal);
      expect(err.message).toMatch(new RegExp(`this computer records the owner ${OWNER}`));
    });

    it("refused without a proof, with a proof for another link or code, or signed by someone else", async () => {
      const prior = { owner: OWNER, linkId: LINK, linkCode: CODE };
      for (const [proof, why] of [
        [undefined, /no owner proof/],
        [await signLinkProof({ ...facts(), linkId: "bl_test0043" }), /for another link/],
        [await signLinkProof({ ...facts(), code: "ABC-DEF" }), /for another link/],
        [await signLinkProof(facts(), { key: evmOwnerKey("33") }), /signed by/],
      ] as const) {
        site.reply = answer(OWNER, proof);
        const err = await connect({ prior }).catch((e) => e);
        expect(err, String(why)).toBeInstanceOf(HostedRefusal);
        expect(err.message).toMatch(why);
      }
    });
  });

  it("an already-linked answer without an owner is refused", async () => {
    site.reply = () => ({ status: 200, body: { id: "bl_test0042", state: "linked", final: true, owner: null, approval: null } });
    const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/no owner address/);
  });

  it("409 is a refusal with the site's message", async () => {
    site.reply = () => ({ status: 409, body: { error: "this agent is linked to another account", reason_code: "linked_elsewhere" } });
    const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/HTTP 409 linked_elsewhere: this agent is linked to another account.*nothing was sent/);
  });

  it("409 duplicate_request for a request this client does not hold: the conflict is reported, nothing sent", async () => {
    site.owner = OWNER;
    site.reply = () => ({ status: 409, body: { error: "a request with this key exists", reason_code: "duplicate_request", id: "ba_test0999" } });
    const err = await grant(client()).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/already has request ba_test0999, created with the same request key by an earlier attempt.*Nothing was sent/);
  });

  it("a lost answer to a request the site refused: the retry's nonce is used up (replayed), so it signs again with a new one", async () => {
    site.owner = OWNER;
    const sent: Record<string, string>[] = [];
    let calls = 0;
    // the first POST reaches the site, which refuses it (its nonce is now used), and the answer is lost on the way back
    site.refuse = { status: 503, error: "busy" };
    const lossy: typeof fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/approvals")) {
        sent.push({ ...(init.headers as Record<string, string>) });
        const res = await fetch(input, init);
        if (++calls === 1) {
          site.refuse = undefined;
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        }
        return res;
      }
      return fetch(input, init);
    };
    const h = await grant(client({ fetchImpl: lossy }));
    expect(h.id).toBe("ba_test0001");
    expect(sent).toHaveLength(3);
    // the retry re-sent the very same proof; the site refused it as replayed; the third is signed anew
    expect(sent[1]).toEqual(sent[0]);
    expect(site.posts.map((x) => x.why)).toEqual([undefined, "replayed", undefined]);
    expect(sent[2]["Superstables-Agent-Nonce"]).not.toBe(sent[0]["Superstables-Agent-Nonce"]);
    expect(sent[2]["idempotency-key"]).toBe(sent[0]["idempotency-key"]);
  });

  it("a lost answer, then 409 proof_reused on the retry of the same proof: refused with guidance, nothing sent", async () => {
    site.owner = OWNER;
    const sent: Record<string, string>[] = [];
    let calls = 0;
    // the first POST reaches the site and creates the request, but its answer is lost on the way back
    const lossy: typeof fetch = async (input, init) => {
      if (init?.method === "POST" && String(input).endsWith("/approvals")) {
        sent.push({ ...(init.headers as Record<string, string>) });
        calls++;
        const res = await fetch(input, init);
        if (calls === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        return res;
      }
      return fetch(input, init);
    };
    // the site answers the exact resend of the request it created with 409 proof_reused and that request's id
    const err = await grant(client({ fetchImpl: lossy })).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/already has request ba_test0001 \(awaiting_owner\), created with the same signed proof by an earlier attempt/);
    expect(err.message).toMatch(/cannot be approved without its link.*expires by itself in 10 minutes.*account page\. Nothing was sent/);
    expect(err.next).toMatch(/after that request expires/);
    // the retry re-sent the very same proof and key
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(records).toEqual([]);
  });

  it("409 proof_reused for a request this client holds: it keeps polling that request", async () => {
    site.owner = OWNER;
    const c = client();
    const first = await grant(c);
    const held = site.requests[0];
    site.reply = () => ({ status: 409, body: { reason_code: "proof_reused", id: held.id, kind: "grant", state: "awaiting_owner" } });
    const again = await grant(c);
    expect(again.id).toBe(held.id);
    expect(again.url).toBe(first.url);
    held.state = "rejected";
    expect(await again.settled).toMatchObject({ status: "rejected", sending: false });
  });

  it("409 duplicate_request for a request this client holds: it keeps polling that request", async () => {
    site.owner = OWNER;
    const c = client();
    const first = await grant(c);
    const held = site.requests[0];
    site.reply = () => ({ status: 409, body: { reason_code: "duplicate_request", id: held.id } });
    const again = await grant(c);
    expect(again.id).toBe(held.id);
    expect(again.url).toBe(first.url);
    held.state = "rejected";
    expect(await again.settled).toMatchObject({ status: "rejected", sending: false });
  });

  it("asks for the exact transaction and settles as sent, then confirmed, with the hash", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls === 3) Object.assign(r, { state: "sent", tx_hash: HASH });
      if (r.polls >= 4) r.state = "confirmed";
    };
    const h = await grant(client());
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
    expect(site.requests[0].body).toEqual({ kind: "grant", rail: "evm", chain: "base-sepolia", agent: AGENT, transaction: GRANT_TX });
    expect(site.posts[0]).toMatchObject({ path: "/api/v1/budget/approvals", ok: true });
  });

  it("settles as sent when the first state it sees is confirmed", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "confirmed", tx_hash: HASH });
    };
    const c = client();
    const h = await c.request({ kind: "evm-transaction", action: "revoke", account: OWNER, transaction: { ...GRANT_TX }, terms: TERMS, timeoutMs: 60_000 });
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
    expect(site.requests[0].kind).toBe("revoke");
  });

  it("a rejection before the wallet was asked: nothing sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "rejected", reason: "the owner rejected it" });
    };
    const h = await grant(client());
    expect(await h.settled).toEqual({ status: "rejected", reason: "the owner rejected it", sending: false });
  });

  it("a rejection after the site reports the wallet was asked: never nothing sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls === 2) r.wallet_asked = true;
      if (r.polls >= 3) r.state = "rejected";
    };
    const h = await grant(client());
    const o = await h.settled;
    expect(o).toMatchObject({ status: "rejected", sending: true });
  });

  it("the site's final unknown (the wallet may have sent): an unknown outcome, never nothing sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls === 2) r.state = "sending";
      if (r.polls >= 3) Object.assign(r, { state: "unknown", reason: "the wallet was asked and never answered" });
    };
    const h = await grant(client());
    expect(await h.settled).toEqual({ status: "expired", reason: "the wallet was asked and never answered", sending: true });
  });

  it("unknown with a hash: sent, so the command reads the chain", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "unknown", tx_hash: HASH });
    };
    const h = await grant(client());
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
  });

  it("a rejection after the site reported sending: never nothing sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls === 2) r.state = "sending";
      if (r.polls >= 3) r.state = "rejected";
    };
    const h = await grant(client());
    expect(await h.settled).toMatchObject({ status: "rejected", sending: true });
  });

  it("an expired link: nothing sent", async () => {
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) r.state = "expired";
    };
    const h = await grant(client());
    expect(await h.settled).toMatchObject({ status: "expired", sending: false });
  });

  it("cancel: the site cancels before the wallet was asked, and the request ends with nothing sent", async () => {
    site.owner = OWNER;
    const h = await grant(client());
    const r = site.requests[0];
    expect(await cancelSiteRequest({ site: site.url, id: r.id, token: r.token })).toEqual({ cancelled: true, state: "cancelled" });
    expect(await h.settled).toMatchObject({ status: "rejected", sending: false });
    // once the wallet was asked, the site refuses to cancel
    const h2 = await grant(client());
    site.requests[1].wallet_asked = true;
    expect(await cancelSiteRequest({ site: site.url, id: site.requests[1].id, token: site.requests[1].token })).toMatchObject({ cancelled: false, walletAsked: true });
    site.requests[1].state = "expired";
    expect(await h2.settled).toMatchObject({ status: "expired", sending: true });
  });

  it("the command's --timeout cancels the request on the site", async () => {
    site.owner = OWNER;
    const h = await grant(client(), 300);
    expect(await h.settled).toMatchObject({ status: "expired", sending: false });
    expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
  });

  it("refuses an approval the site ties to another owner, before any link is shown", async () => {
    site.owner = OTHER;
    const err = await grant(client()).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`owner recorded on this computer is ${OWNER}`));
    expect(err.message).toMatch(/nothing was sent/);
    expect(site.requests[0]).toMatchObject({ state: "cancelled", cancels: 1 });
    expect(records).toEqual([]);
  });

  it("refuses when the site names another owner later, while nothing was sent", async () => {
    site.owner = null;
    site.onPoll = (r) => {
      if (r.polls >= 2) r.owner = OTHER;
    };
    const h = await grant(client());
    const o = await h.settled;
    expect(o).toMatchObject({ status: "rejected", sending: false });
    expect(o.status === "rejected" && o.reason).toMatch(/not the owner recorded on this computer/);
    expect(site.requests[0].state).toBe("cancelled");
  });

  it("site unreachable: a clear refusal, nothing requested or sent", async () => {
    const closed = await startServer(() => {});
    const url = closed.url;
    await closed.close();
    const err = await grant(client({ site: url })).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`could not reach ${url}.*nothing was sent`));
  });

  it("a request the site refuses (over the account's limit): nothing sent, the site's reason kept", async () => {
    site.refuse = { status: 422, error: "the cap is above this account's limit of 100 USDC" };
    const err = await grant(client()).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/HTTP 422: the cap is above this account's limit of 100 USDC.*nothing was sent/);
  });

  it("refuses a link to another site in the answer", async () => {
    // the fake names its own origin (127.0.0.1) in the link; asked under another name, that link is foreign
    site.origin = site.url.replace("127.0.0.1", "localhost");
    const err = await client({ site: site.origin }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/approval link on another site/);
  });

  it("refuses a link with control characters, or not /approve/budget/<its id>#<token>; uses the link re-serialized", async () => {
    for (const [url, why] of [
      [(id: string) => `${site.url}/approve/budget/${id}#ssba_test\nRESULT {"ok":true}`, /another site/],
      [(id: string) => `${site.url}/approve/budget/${id}#ssba_\u001b[2Jtest`, /another site/],
      [(id: string) => `${site.url}/approve/budget/${id}\u202e#ssba_testtest`, /another site/],
      [(id: string) => `${site.url}/approve/budget/ba_other#ssba_testtest`, /not \/approve\/budget\/<its id>#<token>/],
      [(id: string) => `${site.url}/approve/budget/${id}?next=https://evil.example#ssba_testtest`, /not \/approve\/budget\/<its id>#<token>/],
      [(id: string) => `${site.url}/approve/budget/${id}`, /not \/approve\/budget\/<its id>#<token>/],
    ] as const) {
      site.approvalUrl = url;
      const err = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
      expect(err, String(why)).toBeInstanceOf(HostedRefusal);
      expect(err.message).toMatch(why);
    }
    // an origin spelled in capitals is the same origin: the link is used as the URL parser writes it
    site.approvalUrl = (id) => `${site.url.replace("http://", "HTTP://")}/approve/budget/${id}#ssba_test_owner`;
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    expect(h.url).toBe(`${site.url}/approve/budget/${h.id}#ssba_test_owner`);
  });

  it("a link the site reports without a valid owner proof records no owner", async () => {
    for (const proof of [null, { scheme: "eip191", message: "Superstables: link an agent to my account", signature: `0x${"11".repeat(65)}` }]) {
      site.onPoll = (r) => {
        if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER, owner_proof: proof });
      };
      const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
      const o = await h.settled;
      expect(o).toMatchObject({ status: "rejected", sending: false });
      expect(o.status === "rejected" && o.reason).toMatch(new RegExp(`reported the link to ${OWNER}, but the (site sent no owner proof|owner proof is for another link).*Nothing was recorded`));
    }
    // signed by another wallet than the owner the site names
    site.onPoll = async (r) => {
      if (r.polls >= 2 && r.state !== "linked") Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "ABC-DEF" }, { key: evmOwnerKey("33") }) });
    };
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    const o = await h.settled;
    expect(o.status === "rejected" && o.reason).toMatch(/signed by/);
  });

  it("a link with steps whose owner proof is wrong: no owner, the steps are withdrawn on the site", async () => {
    const then = [{ kind: "grant" as const, transaction: GRANT_TX }];
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER, owner_proof: await signLinkProof({ site: site.url, owner: OWNER, agent: AGENT, rail: "evm", chain: "base-sepolia", linkId: r.id, code: "XYZ-UVW" }) });
    const b = await h.bundle!;
    expect(b.link).toMatchObject({ status: "rejected", sending: false });
    expect(b.link.status === "rejected" && b.link.reason).toMatch(/owner proof is for another link.*steps were withdrawn/);
    expect(r.cancels).toBe(1);
    expect(b.steps).toMatchObject([{ kind: "grant", state: "cancelled" }]);
  });

  it("close() cancels a request still open on the site", async () => {
    site.owner = OWNER;
    const c = client();
    const h = await grant(c);
    await c.close();
    expect(site.requests[0].state).toBe("cancelled");
    expect(await h.settled).toMatchObject({ status: "rejected" });
  });
});

describe("hosted approvals on tempo and solana", () => {
  // Solana: the agent key is ed25519, the owner a base58 address, a transaction id a base58 signature
  const SOL_KP = Keypair.fromSeed(new Uint8Array(32).fill(7));
  const SOL_KEY: SolanaAgentKey = { ed25519: SOL_KP.secretKey, address: SOL_KP.publicKey.toBase58() };
  const SOL_OWNER = solanaOwner(8);
  const SOL_OTHER = solanaOwner(9);
  const SIG = bs58.encode(new Uint8Array(64).fill(5));
  const KEYCHAIN = "0xaAAAaaAA00000000000000000000000000000000";
  let site: FakeSite;
  let dir: string;
  const solana = (over: Partial<ConstructorParameters<typeof HostedApprovals>[0]> = {}) =>
    new HostedApprovals({ site: site.url, rail: "solana", chain: "devnet", agentKey: SOL_KEY, auditPath: join(dir, "audit.jsonl"), pollWaitS: 0, minPollMs: 20, ...over });
  const tempo = () => new HostedApprovals({ site: site.url, rail: "tempo", chain: "moderato", agentKey: KEY, pollWaitS: 0, minPollMs: 20 });
  const intent = (c: HostedApprovals, action: string, amount?: string, account = SOL_OWNER) =>
    c.request({ kind: "solana-intent", action, account, solana: amount === undefined ? {} : { amount_atomic: amount }, terms: TERMS, timeoutMs: 60_000 });

  beforeEach(async () => {
    site = await startFakeSite();
    dir = mkdtempSync(join(tmpdir(), "ss-hosted-rails-"));
  });
  afterEach(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the Solana agent proof is ed25519 over the same six-line text, 0x and 128 hex, from the base58 key", async () => {
    const body = JSON.stringify({ rail: "solana", chain: "devnet", agent: SOL_KEY.address });
    const SITE = "https://www.superstables.com";
    const NONCE = "fedcba9876543210fedcba9876543210";
    const proof = await agentProof(SOL_KEY, SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE);
    expect(proof.agent).toBe(SOL_KEY.address);
    expect(proof.headers["Superstables-Agent"]).toBe(SOL_KEY.address);
    expect(proof.headers["Superstables-Agent-Timestamp"]).toBe("1790000000");
    expect(proof.headers["Superstables-Agent-Nonce"]).toBe(NONCE);
    const sig = proof.headers["Superstables-Agent-Signature"];
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(SOL_KP.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
    const text = Buffer.from(agentProofText(SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE), "utf8");
    expect(verify(null, text, key, Buffer.from(sig.slice(2), "hex"))).toBe(true);
    // ed25519 is deterministic: the same key, text, time and nonce give the same signature
    expect((await agentProof(SOL_KEY, SITE, "POST", "/api/v1/budget/links", body, 1790000000, NONCE)).headers["Superstables-Agent-Signature"]).toBe(sig);
    // one changed byte of the body, or another site, and it no longer verifies
    expect(verify(null, Buffer.from(agentProofText(SITE, "POST", "/api/v1/budget/links", body + " ", 1790000000, NONCE), "utf8"), key, Buffer.from(sig.slice(2), "hex"))).toBe(false);
    expect(verify(null, Buffer.from(agentProofText("https://staging.superstables.com", "POST", "/api/v1/budget/links", body, 1790000000, NONCE), "utf8"), key, Buffer.from(sig.slice(2), "hex"))).toBe(false);
  });

  it("solana: links the agent; the owner is the base58 Solana address the site records", async () => {
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: SOL_OWNER });
    };
    const h = await solana().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    expect(await h.settled).toEqual({ status: "connected", address: SOL_OWNER });
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].body).toEqual({ rail: "solana", chain: "devnet", agent: SOL_KEY.address });
  });

  it("solana: a grant sends the intent, not a transaction, and settles as sent with the signature", async () => {
    site.owner = SOL_OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 3) Object.assign(r, { state: "confirmed", tx_hash: SIG });
    };
    const h = await intent(solana(), "grant", "50000");
    expect(await h.settled).toEqual({ status: "sent", address: SOL_OWNER, hash: SIG });
    expect(site.requests[0].body).toEqual({ kind: "grant", rail: "solana", chain: "devnet", agent: SOL_KEY.address, solana: { amount_atomic: "50000" } });
    expect(site.posts[0]).toMatchObject({ path: "/api/v1/budget/approvals", ok: true });
  });

  it("solana: revoke carries no amount; fund-agent carries lamports", async () => {
    site.owner = SOL_OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "confirmed", tx_hash: SIG });
    };
    const c = solana();
    expect(await (await intent(c, "revoke")).settled).toMatchObject({ status: "sent", hash: SIG });
    expect(await (await intent(c, "fund-agent", "10000000")).settled).toMatchObject({ status: "sent", hash: SIG });
    expect(site.requests.map((r) => [r.body.kind, r.body.solana])).toEqual([["revoke", {}], ["fund_agent", { amount_atomic: "10000000" }]]);
  });

  it("solana: an approval the site ties to another owner is refused before any link, and base58 case counts", async () => {
    site.owner = SOL_OTHER;
    const err = await intent(solana(), "grant", "1").catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`would ask ${SOL_OTHER} to approve this, but the owner recorded on this computer is ${SOL_OWNER}.*nothing was sent`));
    expect(err.next).toMatch(/superstables budget setup --rail solana --hosted --new-owner/);
    expect(site.requests[0].state).toBe("cancelled");
    // the same letters in another case are another Solana address
    const swapped = SOL_OWNER.replace(/[a-z]/, (c) => c.toUpperCase());
    site.owner = swapped;
    expect(await intent(solana(), "grant", "1").catch((e) => e)).toBeInstanceOf(HostedRefusal);
  });

  it("solana: a link with fund_agent then grant sends the amounts and reads each step's signature", async () => {
    const c = solana();
    const then = [{ kind: "fund_agent" as const, solana: { amount_atomic: "10000000" } }, { kind: "grant" as const, solana: { amount_atomic: "50000" } }];
    const h = await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then });
    expect(site.requests[0].body.then).toEqual(then);
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: SOL_OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: SIG, wallet_asked: true });
    Object.assign(r.steps![1], { state: "rejected", reason: "the owner rejected it", reason_code: "owner_rejected" });
    const b = await h.bundle!;
    expect(b.link).toEqual({ status: "connected", address: SOL_OWNER });
    expect(b.steps).toMatchObject([{ kind: "fund_agent", state: "confirmed", hash: SIG }, { kind: "grant", state: "rejected", hash: null, reasonCode: "owner_rejected" }]);
  });

  it("solana: already linked, with steps asked: refused, with fund-agent and grant one by one", async () => {
    site.linked = { [SOL_KEY.address]: SOL_OWNER };
    const err = await solana().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: [{ kind: "grant", solana: { amount_atomic: "1" } }] }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(new RegExp(`already linked on .* to the account ${SOL_OWNER}`));
    expect(err.next).toMatch(/superstables budget fund-agent --rail solana, then superstables budget grant --rail solana --amount A/);
  });

  it("tempo: links and asks for the exact keychain transaction, signed EIP-191 as on evm", async () => {
    site.onPoll = (r) => {
      if (r.kind === "link" && r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
      if (r.kind !== "link" && r.polls >= 2) Object.assign(r, { state: "confirmed", tx_hash: HASH });
    };
    const c = tempo();
    expect(await (await c.request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 })).settled).toEqual({ status: "connected", address: OWNER });
    site.owner = OWNER;
    const tx = { to: KEYCHAIN, data: "0x5ae7ab32" + "0".repeat(24) + AGENT.slice(2).toLowerCase(), value: "0x0" };
    const h = await c.request({ kind: "evm-transaction", action: "revoke", account: OWNER, transaction: tx, terms: TERMS, timeoutMs: 60_000 });
    expect(await h.settled).toEqual({ status: "sent", address: OWNER, hash: HASH });
    expect(site.requests.map((r) => r.body)).toEqual([{ rail: "tempo", chain: "moderato", agent: AGENT }, { kind: "revoke", rail: "tempo", chain: "moderato", agent: AGENT, transaction: tx }]);
    expect(site.posts.every((p) => p.ok)).toBe(true);
  });

  it("tempo: already linked, with a grant asked: refused, with the grant on its own (no gas on tempo)", async () => {
    site.linked = { [AGENT.toLowerCase()]: OWNER };
    const err = await tempo().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000, then: [{ kind: "grant", transaction: { to: KEYCHAIN, data: "0x980a6025", value: "0x0" } }] }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.next).toMatch(/A budget is a separate owner step: superstables budget grant --rail tempo --amount A/);
    expect(err.next).not.toMatch(/fund-agent/);
  });
});

describe("find: the site's list of services", () => {
  it("lists services with name, price, chain and URL", async () => {
    const site = await startFakeSite();
    try {
      site.services = { services: [
        { name: "Weather", price: { amount: "0.001", asset: "USDC" }, network: "eip155:84532", url: "https://seller.example/weather" },
        { name: "No URL" },
        { name: "Bad\nname", price: "0.01", chain: "arc-testnet", url: "https://arc.example/x" },
        { name: "Briefing", price: "0.003", network: "eip155:84532", sample: true, url: "https://seller.example/briefing" },
        { name: "Market", price: "0.01", network: "eip155:84532", simulated: false, sample: "yes", url: "https://seller.example/market" },
      ] };
      const r = await listSiteServices({ site: site.url, chainByNetwork: { "eip155:84532": "base-sepolia" } });
      // simulated: the site's simulated, mock or sample flag when it is true or false; null when it gives none
      expect(r).toEqual({ ok: true, services: [
        { name: "Weather", price: "0.001 USDC", chain: "base-sepolia", network: "eip155:84532", rail: "evm", simulated: null, url: "https://seller.example/weather" },
        { name: "Bad name", price: "0.01 USDC", chain: "arc-testnet", network: null, rail: null, simulated: null, url: "https://arc.example/x" },
        { name: "Briefing", price: "0.003 USDC", chain: "base-sepolia", network: "eip155:84532", rail: "evm", simulated: true, url: "https://seller.example/briefing" },
        { name: "Market", price: "0.01 USDC", chain: "base-sepolia", network: "eip155:84532", rail: "evm", simulated: false, url: "https://seller.example/market" },
      ] });
    } finally {
      await site.close();
    }
  });

  it("says so when the site has no list", async () => {
    const site = await startFakeSite();
    try {
      expect(await listSiteServices({ site: site.url })).toMatchObject({ ok: false, absent: true });
    } finally {
      await site.close();
    }
  });
});
