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
import { agentProof, agentProofText, bodyHash, HostedApprovals, HostedRefusal, type HostedRecord, type SolanaAgentKey } from "../../budget/hosted.js";
import { cancelSiteRequest, chosenSite, listSiteServices, siteOrigin } from "../../budget/site.mjs";
import { startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { startServer } from "../helpers/servers.js";

const KEY = `0x${"11".repeat(32)}` as const;
const AGENT = privateKeyToAccount(KEY).address;
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const TERMS = { title: "Grant a spending budget", summary: "test", rows: [], enforced: [], notEnforced: [], notes: [] };
const GRANT_TX = { to: USDC, data: "0x095ea7b3", value: "0x0" };

describe("agent proof", () => {
  const body = JSON.stringify({ rail: "evm", chain: "base-sepolia", agent: AGENT });

  it("signs the exact four-line text", () => {
    expect(agentProofText("post", "/api/v1/budget/links", body, 1790000000)).toBe(
      `Superstables agent request\nPOST /api/v1/budget/links\n${bodyHash(body)}\n1790000000`,
    );
    expect(bodyHash(body)).toBe("13ab74767264fb6bd2284b40709ed621f7c83a9f11c12196c86ab7030c96c9c2");
    // the hash is over the bytes sent, so one changed byte changes it
    expect(bodyHash(body + " ")).not.toBe(bodyHash(body));
  });

  it("gives a fixed signature for a fixed key and timestamp", async () => {
    const proof = await agentProof(KEY, "POST", "/api/v1/budget/links", body, 1790000000);
    expect(proof.headers).toEqual({
      "Superstables-Agent": "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      "Superstables-Agent-Timestamp": "1790000000",
      "Superstables-Agent-Signature":
        "0x5c60ceb19a3765b05afa23cd5e68133a75aaaf66134eaf8f2e66f1314b67db1835f8462ff8f799a4183b2c8a43b2a0546e6cf11903d4e2ae390bb45d2246bbb31c",
    });
    const signer = await recoverMessageAddress({ message: agentProofText("POST", "/api/v1/budget/links", body, 1790000000), signature: proof.headers["Superstables-Agent-Signature"] as `0x${string}` });
    expect(signer).toBe(AGENT);
  });
});

describe("site URL", () => {
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
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].body).toEqual({ rail: "evm", chain: "base-sepolia", agent: AGENT });
    // the token goes to the record, never to the audit file
    expect(records).toEqual([{ site: site.url, requestId: "bl_test0001", token: "ssbt_test_bl_test0001secret", kind: "link", matchCode: "ABC-DEF" }]);
    expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain("ssbt_");
  });

  it("an agent already linked on this chain: no link, no wait, the site's owner as the outcome", async () => {
    site.reply = (path) => path.endsWith("/links") ? { status: 200, body: { id: "bl_test0042", access_token: "ssbt_test_bl_test0042secret", state: "linked", final: true, owner: OWNER, approval: null, next_action: { type: "none" } } } : undefined;
    const h = await client().request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 });
    expect(h).toMatchObject({ id: "bl_test0042", url: "", matchCode: "", alreadyLinked: true });
    expect(await h.settled).toEqual({ status: "connected", address: OWNER });
    expect(site.posts[0]).toMatchObject({ path: "/api/v1/budget/links", ok: true });
    // nothing to poll, nothing stored
    expect(site.requests).toEqual([]);
    expect(records).toEqual([]);
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
        if (calls === 1) {
          site.reply = () => ({ status: 409, body: { error: "this proof was used", reason_code: "proof_reused", id: site.requests[0].id, kind: "grant", state: "awaiting_owner" } });
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        }
        return res;
      }
      return fetch(input, init);
    };
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
    expect(err.message).toMatch(/owner recorded on this computer is 0x2222/);
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
    const err = await client({ site: site.url.replace("127.0.0.1", "localhost") }).request({ kind: "connect", terms: TERMS, timeoutMs: 60_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(HostedRefusal);
    expect(err.message).toMatch(/approval link on another site/);
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
  const SOL_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
  const SOL_OTHER = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
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

  it("the Solana agent proof is ed25519 over the same four-line text, 0x and 128 hex, from the base58 key", async () => {
    const body = JSON.stringify({ rail: "solana", chain: "devnet", agent: SOL_KEY.address });
    const proof = await agentProof(SOL_KEY, "POST", "/api/v1/budget/links", body, 1790000000);
    expect(proof.agent).toBe(SOL_KEY.address);
    expect(proof.headers["Superstables-Agent"]).toBe(SOL_KEY.address);
    expect(proof.headers["Superstables-Agent-Timestamp"]).toBe("1790000000");
    const sig = proof.headers["Superstables-Agent-Signature"];
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/);
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(SOL_KP.publicKey.toBytes()).toString("base64url") }, format: "jwk" });
    const text = Buffer.from(agentProofText("POST", "/api/v1/budget/links", body, 1790000000), "utf8");
    expect(verify(null, text, key, Buffer.from(sig.slice(2), "hex"))).toBe(true);
    // ed25519 is deterministic: the same key, text and time give the same signature
    expect((await agentProof(SOL_KEY, "POST", "/api/v1/budget/links", body, 1790000000)).headers["Superstables-Agent-Signature"]).toBe(sig);
    // one changed byte of the body, and it no longer verifies
    expect(verify(null, Buffer.from(agentProofText("POST", "/api/v1/budget/links", body + " ", 1790000000), "utf8"), key, Buffer.from(sig.slice(2), "hex"))).toBe(false);
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
      ] };
      const r = await listSiteServices({ site: site.url, chainByNetwork: { "eip155:84532": "base-sepolia" } });
      expect(r).toEqual({ ok: true, services: [
        { name: "Weather", price: "0.001 USDC", chain: "base-sepolia", network: "eip155:84532", rail: "evm", url: "https://seller.example/weather" },
        { name: "Bad name", price: "0.01 USDC", chain: "arc-testnet", network: null, rail: null, url: "https://arc.example/x" },
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
