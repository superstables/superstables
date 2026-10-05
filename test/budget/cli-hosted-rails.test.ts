// `superstables budget` with hosted approvals on tempo (Moderato) and solana (devnet), as an agent meets it: the real
// dispatcher and rail scripts, against a fake superstables.com and fake Moderato and devnet RPCs on 127.0.0.1. The site
// reports what the owner's wallet did; the fake chain shows it; the command reads the chain before it reports. No network,
// no real key.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { evmOwner, startFakeSite, type FakeRequest, type FakeSite } from "../helpers/fake-site.js";
import { readBody, startServer } from "../helpers/servers.js";
import { KEYCHAIN, TOKEN_PROGRAM_ID, ataOf, computeUnitLimit, computeUnitPrice, startFakeSolana, startFakeTempo, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = evmOwner("22");
const OTHER = evmOwner("33");
const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
const TEMPO_AGENT = privateKeyToAddress(TEMPO_KEY);
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_AGENT = SOL_AGENT_KP.publicKey.toBase58();
const SOL_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const SOL_OTHER = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();

let home: string;
let site: FakeSite;
let tempo: FakeTempo;
let solana: FakeSolana;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-budget-rails-"));
  site = await startFakeSite();
  tempo = await startFakeTempo();
  solana = await startFakeSolana();
});
afterEach(async () => {
  await site.close();
  await tempo.close();
  await solana.close();
  rmSync(home, { recursive: true, force: true });
});

function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any; approve: any }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = (p: string) => stdout.split("\n").reverse().find((l) => l.startsWith(p));
      const parse = (p: string) => { const l = line(p); return l ? JSON.parse(l.slice(p.length)) : null; };
      done({ code: code ?? 0, stdout, stderr, result: parse("RESULT "), approve: parse("APPROVE ") });
    });
  });
}

const file = (...p: string[]) => join(home, ...p);
const publicOf = (rail: "tempo" | "solana") => readFileSync(file("budget", "public", rail === "tempo" ? "tempo-moderato.env" : "solana-devnet.env"), "utf8");
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
};
/** A tempo chain already set up with --hosted: the agent key file, and the public file with the owner and the site. */
const hostedTempo = (owner = OWNER) => {
  write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${owner}\n`);
  write(file("budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${owner}\nAGENT_ADDRESS=${TEMPO_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
};
/** A solana chain already set up with --hosted, with the owner's USDC account and SOL. */
const hostedSolana = (owner = SOL_OWNER) => {
  write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${owner}\n`);
  write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${owner}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
  solana.usdc.set(owner, { amount: 5_000_000n, delegate: null, delegated: 0n });
  solana.balances.set(owner, 1_000_000_000n);
};
/** The owner's wallet sends, on the site, whatever an approval asks for: the fake chain shows it, the site reports it. */
const ownerSends = (rail: "tempo" | "solana", over: Partial<Parameters<FakeSolana["land"]>[0]> = {}) => (r: FakeRequest) => {
  if (r.polls !== 2 || r.kind === "link") return;
  const hash = rail === "tempo"
    ? tempo.mine(r.owner!, r.body.transaction.data)
    : solana.land({ kind: r.kind as any, owner: r.owner!, agent: r.body.agent, amount: r.body.solana.amount_atomic ? BigInt(r.body.solana.amount_atomic) : undefined, ...over });
  Object.assign(r, { state: "confirmed", tx_hash: hash, wallet_asked: true });
};

/** The same, but the site then judges the transaction failed, with its hash: the command must never settle it. */
const ownerSendsSiteFails = (rail: "tempo" | "solana") => (r: FakeRequest) => {
  ownerSends(rail)(r);
  if (r.state === "confirmed") Object.assign(r, { state: "failed", reason: "The transaction is not the one planned.", reason_code: "mismatch" });
};
const SITE_FAILED = /^127\.0\.0\.1:\d+ reported this step as failed \(reason: mismatch\), so it is not counted as done \(transaction \S+\)$/;
const SITE_FAILED_REVERTED = /reported this step as failed \(reason: reverted\), so it is not counted as done/;

describe("tempo, hosted", () => {
  it("setup --hosted --new-owner refused while a key is live: the retry names --hosted and the recorded site", async () => {
    hostedTempo();
    tempo.keys.set(`${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
    const r = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--new-owner", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/a budget is live/);
    expect(r.result.next).toBe(`revoke it first (superstables budget revoke --rail tempo, approved by ${OWNER}), then superstables budget setup --rail tempo --hosted --site ${site.url} --new-owner`);
    expect(site.requests).toHaveLength(0);
  }, 60_000);

  it("setup --hosted with an unbound agent key file: an account other than the owner on record is refused, nothing changes", async () => {
    write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\n`);
    write(file("budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${TEMPO_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
    const before = [readFileSync(file("keys", "budget", "tempo-agent.env"), "utf8"), publicOf("tempo")];
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OTHER }); };
    const r = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", owner: OWNER });
    expect(r.result.next).toContain(`superstables budget setup --rail tempo --hosted --site ${site.url} --new-owner`);
    expect([readFileSync(file("keys", "budget", "tempo-agent.env"), "utf8"), publicOf("tempo")]).toEqual(before);
  }, 60_000);

  it("setup --hosted links the agent and records the account, APPROVALS=hosted and SITE", async () => {
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER }); };
    const r = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, command: "setup", rail: "tempo", chain: "moderato", state: "ok", owner: OWNER, approvals: "hosted", site: site.url });
    expect(r.approve).toMatchObject({ action: "setup", matchCode: "ABC-DEF" });
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    const pub = publicOf("tempo");
    expect(site.requests[0].body).toEqual({ rail: "tempo", chain: "moderato", agent: pub.match(/^AGENT_ADDRESS=(.*)$/m)![1] });
    expect(pub).toMatch(new RegExp(`^OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(pub).toMatch(/^APPROVALS=hosted$/m);
    expect(pub).toMatch(new RegExp(`^SITE=${site.url}$`, "m"));
    expect(readFileSync(file("keys", "budget", "tempo-agent.env"), "utf8")).toMatch(new RegExp(`^OWNER_ADDRESS=${OWNER}$`, "m"));
  }, 60_000);

  it("setup --hosted --grant: one link, then the grant; wait reads the key from the chain and reports it", async () => {
    write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\n`);
    const first = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--grant", "0.05"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.result).toMatchObject({ state: "waiting_owner", matchCode: "ABC-DEF", action: "setup" });
    expect(first.result.terms).toMatchObject({ title: "Add this agent and approve a budget of 0.05 pathUSD", amount: "0.05", unit: "pathUSD" });
    expect(first.result.message_for_owner).toContain("Match code: ABC-DEF");
    const r = site.requests[0];
    expect(r.body.then).toHaveLength(1);
    expect(r.body.then[0]).toMatchObject({ kind: "grant", transaction: { to: KEYCHAIN, value: "0x0" } });
    expect(r.body.then[0].transaction.data).toMatch(/^0x980a6025/);
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: tempo.mine(OWNER, r.body.then[0].transaction.data), wallet_asked: true });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ ok: true, state: "ok", owner: OWNER, agent: TEMPO_AGENT, linked: true, approvals: "hosted", amount: "0.05", remaining: "0.05", steps: [{ kind: "grant", state: "settled", amount: "0.05" }] });
    expect(done.result.tx.grant).toMatch(/^0x[0-9a-f]{64}$/);
  }, 180_000);

  it("grant asks the site for the exact authorizeKey, then reads the key on chain: same RESULT as on this computer", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = ownerSends("tempo");
    const r = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, command: "grant", rail: "tempo", chain: "moderato", state: "settled", amount: "0.05", remaining: "0.05" });
    expect(r.result.tx.grant).toBe(site.requests[0].tx_hash);
    expect(r.approve).toMatchObject({ action: "grant", matchCode: "ABC-DEF" });
    expect(site.requests[0].body).toMatchObject({ kind: "grant", rail: "tempo", chain: "moderato", agent: TEMPO_AGENT, transaction: { to: KEYCHAIN, value: "0x0" } });
    expect(site.requests[0].body.transaction.data).toMatch(/^0x980a6025/);
    expect(r.stderr).toMatch(/readback: type 0, expiry \d+, limits true, remaining 0\.05/);
  }, 90_000);

  it("the site judged the grant failed: never settled, standalone or after the link, though the key is on chain as planned", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = ownerSendsSiteFails("tempo");
    const g = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(g.code, g.stderr).toBe(3);
    expect(g.result.ok).toBe(false);
    expect(g.result.reason).toMatch(SITE_FAILED);

    rmSync(file("budget", "public", "tempo-moderato.env"));
    write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\n`);
    tempo.keys.clear();
    site.onPoll = undefined;
    const first = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--grant", "0.05"]);
    expect(first.code, first.stderr).toBe(0);
    const r = site.requests.at(-1)!;
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "failed", tx_hash: tempo.mine(OWNER, r.body.then[0].transaction.data), wallet_asked: true, reason: "The transaction is not the one planned.", reason_code: "mismatch" });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(3);
    expect(done.result).toMatchObject({ ok: false, linked: true, steps: [{ kind: "grant", state: "mismatch" }] });
    expect(done.result.steps[0].reason).toMatch(SITE_FAILED);
  }, 180_000);

  it("a revoke that reverted is never settled, even when another transaction already revoked the key", async () => {
    hostedTempo();
    site.owner = OWNER;
    const live = () => tempo.keys.set(`${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 50_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
    for (const [what, verdict] of [["the site judged it failed", { state: "failed", reason: "It reverted.", reason_code: "reverted" }], ["the site confirmed it", { state: "confirmed" }]] as const) {
      live();
      site.onPoll = (r) => {
        if (r.polls !== 2 || r.kind === "link") return;
        // another transaction revokes the key first; the one the site reports then reverts
        tempo.mine(OWNER, r.body.transaction.data);
        Object.assign(r, { ...verdict, tx_hash: tempo.mine(OWNER, r.body.transaction.data, { reverted: true }), wallet_asked: true });
      };
      const r = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
      expect(r.code, `${what}: ${r.stderr}`).toBe(1);
      expect(r.result.ok, what).toBe(false);
      expect(r.result.state, what).toBe("failed");
      expect(r.result.reason, what).toMatch(/the revoke transaction reverted on chain.*the key reads revoked on chain, but not by this transaction/);
      if (verdict.state === "failed") expect(r.result.reason).toMatch(SITE_FAILED_REVERTED);
      // the key does read revoked, and the RESULT says so, but not as this transaction's doing
      expect(r.result.revoked, what).toBe(true);
      expect(r.result.tx, what).toEqual({ revoke: expect.stringMatching(/^0x/) });
    }
    // reverted while the key is still live: failed, and revoke again
    live();
    site.onPoll = (r) => {
      if (r.polls !== 2 || r.kind === "link") return;
      Object.assign(r, { state: "failed", reason_code: "reverted", tx_hash: tempo.mine(OWNER, r.body.transaction.data, { reverted: true }), wallet_asked: true });
    };
    const still = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(still.code, still.stderr).toBe(1);
    expect(still.result).toMatchObject({ ok: false, state: "failed", revoked: false });
    expect(still.result.next).toMatch(/run superstables budget revoke again/);
  }, 180_000);

  it("--owner-key-file: a revoke or grant whose transaction reverted is failed with its hash, whatever the key reads", async () => {
    hostedTempo();
    const id = `${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`;
    const keyFor = (revoked: boolean) => ({ expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 50_000n, period: 0n, periodEnd: 0n, revoked, scoped: false });
    const HASH = `0x${"ab".repeat(32)}`;
    const tempoUrl = tempo.url;
    let onSend = () => {};
    // the real SDK signs and sends through this RPC: the send answers with a reverted receipt, after another transaction
    // has changed the key the way this one meant to
    const rpc = await startServer(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      const one = async (r: { id: number; method: string }) => {
        if (r.method === "eth_getTransactionCount") return { jsonrpc: "2.0", id: r.id, result: "0x0" };
        if (r.method === "eth_estimateGas") return { jsonrpc: "2.0", id: r.id, result: "0x100000" };
        if (r.method === "eth_gasPrice" || r.method === "eth_maxPriorityFeePerGas") return { jsonrpc: "2.0", id: r.id, result: "0x1" };
        if (r.method === "eth_sendRawTransactionSync") {
          onSend();
          return { jsonrpc: "2.0", id: r.id, result: { transactionHash: HASH, status: "0x0", blockNumber: "0x3ea", blockHash: `0x${"cd".repeat(32)}`, transactionIndex: "0x0", from: OWNER, to: KEYCHAIN, logs: [], gasUsed: "0x10000", cumulativeGasUsed: "0x10000", effectiveGasPrice: "0x1", logsBloom: `0x${"0".repeat(512)}`, type: "0x76", contractAddress: null } };
        }
        const v = await (await fetch(tempoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) })).json();
        if (r.method === "eth_getBlockByNumber" && v.result) Object.assign(v.result, { baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0" });
        return v;
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body)));
    });
    Object.defineProperty(tempo, "url", { value: rpc.url, configurable: true });
    write(file("owner.env"), `OWNER_PRIVATE_KEY=0x${"22".repeat(32)}\n`);
    try {
      tempo.keys.set(id, keyFor(false));
      onSend = () => { tempo.keys.get(id)!.revoked = true; };
      const r = await budget(["revoke", "--rail", "tempo", "--owner-key-file", file("owner.env"), "--yes"]);
      expect(r.code, r.stderr).toBe(1);
      expect(r.result).toMatchObject({ ok: false, state: "failed", revoked: true, tx: { revoke: HASH } });
      expect(r.result.reason).toMatch(/the revoke transaction reverted on chain; the key reads revoked on chain, but not by this transaction/);

      tempo.keys.clear();
      onSend = () => { tempo.keys.set(id, keyFor(false)); };
      const g = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--owner-key-file", file("owner.env"), "--yes"]);
      expect(g.code, g.stderr).toBe(1);
      expect(g.result).toMatchObject({ ok: false, state: "failed" });
      expect(g.result.reason).toMatch(/the authorizeKey transaction reverted on chain; it granted nothing/);
      expect(JSON.stringify(g.result.tx)).toContain(HASH);
    } finally {
      Object.defineProperty(tempo, "url", { value: tempoUrl, configurable: true });
      await rpc.close();
    }
  }, 120_000);

  it("a grant that reverted is failed, never set, even when the key already reads as planned", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls !== 2 || r.kind === "link") return;
      tempo.mine(OWNER, r.body.transaction.data);
      Object.assign(r, { state: "failed", reason_code: "reverted", tx_hash: tempo.mine(OWNER, r.body.transaction.data, { reverted: true }), wallet_asked: true });
    };
    const g = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(g.code, g.stderr).toBe(1);
    expect(g.result).toMatchObject({ ok: false, state: "failed" });
    expect(g.result.reason).toMatch(/reverted on chain/);
  }, 90_000);

  it("grant: refused when the site acts for another owner, before any link", async () => {
    hostedTempo();
    site.owner = OTHER;
    const r = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(new RegExp(`would ask ${OTHER} to approve this, but the owner recorded on this machine is ${OWNER}.*nothing was sent`));
    expect(r.approve).toBeNull();
    expect(site.requests[0].state).toBe("cancelled");
  }, 60_000);

  it("revoke goes to the site and reads the revocation on chain", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = ownerSends("tempo");
    expect((await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"])).code).toBe(0);
    const r = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "revoke", rail: "tempo", state: "settled", revoked: true });
    expect(site.requests[1].body).toMatchObject({ kind: "revoke", rail: "tempo", agent: TEMPO_AGENT, transaction: { to: KEYCHAIN } });
    expect(site.requests[1].body.transaction.data).toMatch(/^0x5ae7ab32/);
  }, 120_000);

  // Rotating the agent key on tempo, as docs/security.md describes it: a new access key, a grant to it, the old one
  // revoked. A revoked key can never be granted again, so the old one stays dead.
  it("rotation: setup --agent adds a key, grant --agent funds it, revoke ends the old key for good", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = ownerSends("tempo");
    expect((await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"])).code).toBe(0);
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER }); };
    const added = await budget(["setup", "--rail", "tempo", "--agent", "2", "--wait", "--no-open"]);
    expect(added.code, added.stderr).toBe(0);
    const key2 = publicOf("tempo").match(/^AGENT2_ADDRESS=(.*)$/m)![1];
    expect(key2).not.toBe(TEMPO_AGENT);
    site.onPoll = ownerSends("tempo");
    const granted = await budget(["grant", "--rail", "tempo", "--agent", "2", "--amount", "0.03", "--wait", "--no-open"]);
    expect(granted.code, granted.stderr).toBe(0);
    expect(granted.result).toMatchObject({ state: "settled", remaining: "0.03" });
    const revoked = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(revoked.code, revoked.stderr).toBe(0);
    expect(site.requests.at(-1)!.body).toMatchObject({ kind: "revoke", agent: TEMPO_AGENT });
    const old = await budget(["status", "--rail", "tempo"]);
    expect(old.result).toMatchObject({ revoked: true });
    const fresh = await budget(["status", "--rail", "tempo", "--agent", "2"]);
    expect(fresh.result).toMatchObject({ state: "ok", remaining: "0.03" });
    // the old key cannot come back
    const again = await budget(["grant", "--rail", "tempo", "--amount", "0.01", "--wait", "--no-open"]);
    expect(again.code).toBe(3);
    expect(`${again.result.reason} ${again.result.next}`).toMatch(/revoked/);
  }, 240_000);

  it("setup --agent on a hosted chain links the new key, signed by that key", async () => {
    hostedTempo();
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER }); };
    const r = await budget(["setup", "--rail", "tempo", "--agent", "2", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    const key2 = publicOf("tempo").match(/^AGENT2_ADDRESS=(.*)$/m)![1];
    expect(r.result).toMatchObject({ state: "ok", owner: OWNER, agent: key2, approvals: "hosted" });
    expect(site.requests[0].body).toEqual({ rail: "tempo", chain: "moderato", agent: key2 });
    // that key's own link, as the owner signed it
    expect(publicOf("tempo")).toMatch(/^AGENT2_LINK_ID=bl_test0001$/m);
    expect(publicOf("tempo")).toMatch(/^AGENT2_LINK_CODE=ABC-DEF$/m);
    expect(site.posts[0].ok).toBe(true);
  }, 60_000);
});

describe("solana, hosted", () => {
  it("setup --hosted --new-owner refused while a budget is live: the retry names --hosted and the recorded site", async () => {
    hostedSolana();
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 1_000_000n });
    const r = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--new-owner", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/a budget is live/);
    expect(r.result.next).toBe(`revoke first (superstables budget revoke --rail solana, approved by ${SOL_OWNER}), then superstables budget setup --rail solana --hosted --site ${site.url} --new-owner`);
    expect(site.requests).toHaveLength(0);
  }, 60_000);

  it("setup --hosted with an unbound agent key file: an account other than the owner on record is refused, nothing changes", async () => {
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
    const before = [readFileSync(file("keys", "budget", "solana-agent.env"), "utf8"), publicOf("solana")];
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: SOL_OTHER }); };
    const r = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", owner: SOL_OWNER });
    expect(r.result.next).toContain(`superstables budget setup --rail solana --hosted --site ${site.url} --new-owner`);
    expect([readFileSync(file("keys", "budget", "solana-agent.env"), "utf8"), publicOf("solana")]).toEqual(before);
  }, 60_000);

  it("setup --hosted links the agent with its ed25519 proof; the owner is the Solana address the site names", async () => {
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: SOL_OWNER }); };
    const r = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, rail: "solana", chain: "devnet", state: "ok", owner: SOL_OWNER, approvals: "hosted", site: site.url });
    // the fake site verified the ed25519 signature over the four-line text
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    const pub = publicOf("solana");
    expect(site.requests[0].body).toEqual({ rail: "solana", chain: "devnet", agent: pub.match(/^SOLANA_AGENT_ADDRESS=(.*)$/m)![1] });
    expect(pub).toMatch(new RegExp(`^SOLANA_OWNER_ADDRESS=${SOL_OWNER}$`, "m"));
    expect(pub).toMatch(/^APPROVALS=hosted$/m);
    expect(pub).toMatch(new RegExp(`^SITE=${site.url}$`, "m"));
  }, 60_000);

  it("setup --hosted --fund --grant: one link, then SOL and the budget; wait reads both from the chain", async () => {
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    const first = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--grant", "0.05", "--fund"]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.result).toMatchObject({ state: "waiting_owner", action: "setup" });
    expect(first.result.terms).toMatchObject({ title: "Add this agent, send it SOL for fees and approve a budget of 0.05 test USDC", amount: "0.05", unit: "USDC" });
    const r = site.requests[0];
    expect(r.body.then).toEqual([{ kind: "fund_agent", solana: { amount_atomic: "10000000" } }, { kind: "grant", solana: { amount_atomic: "50000" } }]);
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    Object.assign(r, { state: "linked", owner: SOL_OWNER });
    Object.assign(r.steps![0], { state: "confirmed", wallet_asked: true, tx_hash: solana.land({ kind: "fund_agent", owner: SOL_OWNER, agent: SOL_AGENT, amount: 10_000_000n }) });
    Object.assign(r.steps![1], { state: "confirmed", wallet_asked: true, tx_hash: solana.land({ kind: "grant", owner: SOL_OWNER, agent: SOL_AGENT, amount: 50_000n }) });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({
      ok: true, state: "ok", owner: SOL_OWNER, agent: SOL_AGENT, linked: true, approvals: "hosted", amount: "0.05", remaining: "0.05",
      steps: [{ kind: "fund_agent", state: "settled", amount: "0.01" }, { kind: "grant", state: "settled", amount: "0.05" }],
      tx: { fundAgent: r.steps![0].tx_hash, grant: r.steps![1].tx_hash },
    });
  }, 180_000);

  it("grant sends the intent; the command reads the delegate and its amount on chain", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana");
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, command: "grant", rail: "solana", chain: "devnet", state: "settled", amount: "0.05", remaining: "0.05", tx: { grant: site.requests[0].tx_hash } });
    expect(site.requests[0].body).toEqual({ kind: "grant", rail: "solana", chain: "devnet", agent: SOL_AGENT, solana: { amount_atomic: "50000" } });
    expect(site.posts[0].ok).toBe(true);
  }, 90_000);

  // docs/security.md: a revoke ends the delegate, not the key. There is no command for a new agent key on solana, and the
  // owner can grant the same key again, so after a suspected leak the owner does not grant it again.
  it("a revoked agent key can be granted again: revoke is not rotation", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana");
    expect((await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"])).code).toBe(0);
    const rv = await budget(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(rv.code, rv.stderr).toBe(0);
    expect(solana.usdc.get(SOL_OWNER)!.delegate).toBeNull();
    const again = await budget(["grant", "--rail", "solana", "--amount", "0.02", "--wait", "--no-open"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.result).toMatchObject({ state: "settled", remaining: "0.02" });
    expect(site.requests.at(-1)!.body).toMatchObject({ kind: "grant", agent: SOL_AGENT });
    // and setup --agent, which makes a new key on tempo, is refused here
    const extra = await budget(["setup", "--rail", "solana", "--agent", "2"]);
    expect(extra.code).toBe(2);
    expect(extra.result.reason).toMatch(/--agent is for tempo only/);
  }, 180_000);

  it("revoke and fund-agent go to the site too, each read from the chain", async () => {
    hostedSolana();
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 50_000n });
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana");
    const rv = await budget(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(rv.code, rv.stderr).toBe(0);
    expect(rv.result).toMatchObject({ command: "revoke", rail: "solana", state: "settled", tx: { revoke: site.requests[0].tx_hash } });
    expect(site.requests[0].body).toEqual({ kind: "revoke", rail: "solana", chain: "devnet", agent: SOL_AGENT, solana: {} });
    const fa = await budget(["fund-agent", "--rail", "solana", "--amount", "0.02", "--wait", "--no-open"]);
    expect(fa.code, fa.stderr).toBe(0);
    expect(fa.result).toMatchObject({ command: "fund-agent", rail: "solana", state: "settled", amount: "0.02", tx: { fundAgent: site.requests[1].tx_hash } });
    expect(site.requests[1].body).toEqual({ kind: "fund_agent", rail: "solana", chain: "devnet", agent: SOL_AGENT, solana: { amount_atomic: "20000000" } });
  }, 120_000);

  it("the site judged a step failed: never settled, standalone or after the link, though the chain shows the plan", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSendsSiteFails("solana");
    for (const command of [["grant", "--rail", "solana", "--amount", "0.05"], ["fund-agent", "--rail", "solana", "--amount", "0.02"]]) {
      const r = await budget([...command, "--wait", "--no-open"]);
      expect(r.code, `${command[0]}: ${r.stderr}`).toBe(3);
      expect(r.result.ok).toBe(false);
      expect(r.result.reason, command[0]).toMatch(SITE_FAILED);
    }

    rmSync(file("budget", "public", "solana-devnet.env"));
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    site.onPoll = undefined;
    const first = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--grant", "0.05", "--fund"]);
    expect(first.code, first.stderr).toBe(0);
    const r = site.requests.at(-1)!;
    Object.assign(r, { state: "linked", owner: SOL_OWNER });
    const failed = { state: "failed", wallet_asked: true, reason: "The transaction is not the one planned.", reason_code: "mismatch" };
    Object.assign(r.steps![0], { ...failed, tx_hash: solana.land({ kind: "fund_agent", owner: SOL_OWNER, agent: SOL_AGENT, amount: 10_000_000n }) });
    Object.assign(r.steps![1], { ...failed, tx_hash: solana.land({ kind: "grant", owner: SOL_OWNER, agent: SOL_AGENT, amount: 50_000n }) });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(3);
    expect(done.result).toMatchObject({ ok: false, linked: true, steps: [{ kind: "fund_agent", state: "mismatch" }, { kind: "grant", state: "mismatch" }] });
    for (const step of done.result.steps) expect(step.reason).toMatch(SITE_FAILED);
  }, 240_000);

  it("a grant signed by another wallet than the owner on record is a mismatch (exit 3), never settled", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana", { signer: SOL_OTHER });
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(new RegExp(`signed and paid for by ${SOL_OTHER}, not the owner ${SOL_OWNER}`));
  }, 90_000);

  it("a lying site: a grant whose transaction carries another instruction too is a mismatch (exit 3), never settled", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    // the planned ApproveChecked, plus an SPL transfer out of the owner's USDC account
    const drain = { program: TOKEN_PROGRAM_ID, accounts: [ataOf(SOL_OWNER).toBase58(), ataOf(SOL_OTHER).toBase58(), SOL_OWNER], data: Buffer.from([3, 0x40, 0x4b, 0x4c, 0, 0, 0, 0, 0]) };
    site.onPoll = ownerSends("solana", { extra: [drain] });
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck") // the dispatcher reports a rail mismatch as refused_precheck (exit 3);
    expect(r.result.reason).toMatch(/it has 2 instructions besides compute budget, not 1/);
    expect(r.result.next).toMatch(/revoke/);
    expect(r.result.rpc).toBe(solana.url);
  }, 90_000);

  it("a lying site: an instruction with another amount than planned is a mismatch, even when the account reads right", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana", { instructionAmount: 60_000n });
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/its instruction is not the one planned/);
  }, 90_000);

  it("a lying site: a grant that needs a second signer, or loads accounts from a lookup table, is a mismatch (exit 3)", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana", { signers: 2 });
    const two = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(two.code, two.stderr).toBe(3);
    expect(two.result.reason).toMatch(/it has 2 signers, not one \(the owner\)/);

    // the first grant did land on the fake chain: clear its delegate, so the second is judged on its transaction alone
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    site.onPoll = ownerSends("solana", { lookupTable: SOL_OTHER });
    const table = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(table.code, table.stderr).toBe(3);
    expect(table.result.reason).toMatch(/it loads accounts from address lookup tables/);
  }, 120_000);

  it("a wallet's bounded compute-budget instructions are accepted; an unbounded priority fee is not", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana", { budget: [computeUnitLimit(200_000), computeUnitPrice(1_000n)] });
    const ok = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.result.state).toBe("settled");
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    // 1,400,000 units at 10,000,000 micro-lamports each: 0.014 SOL of priority fee
    site.onPoll = ownerSends("solana", { budget: [computeUnitLimit(1_400_000), computeUnitPrice(10_000_000n)] });
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/a priority fee above 0\.001 SOL/);
  }, 120_000);

  it("a lying site: a revoke that also does something else is a mismatch (exit 3), and fund-agent with extra instructions too", async () => {
    hostedSolana();
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 50_000n });
    site.owner = SOL_OWNER;
    const transfer = { program: "11111111111111111111111111111111", accounts: [SOL_OWNER, SOL_OTHER], data: Buffer.from([2, 0, 0, 0, 0, 0xca, 0x9a, 0x3b, 0, 0, 0, 0]) };
    site.onPoll = ownerSends("solana", { extra: [transfer] });
    const rv = await budget(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(rv.code, rv.stderr).toBe(3);
    expect(rv.result).toMatchObject({ state: "refused_precheck" });
    expect(rv.result.reason).toMatch(/^the transaction was not accepted as the planned step: /);
    const fa = await budget(["fund-agent", "--rail", "solana", "--amount", "0.02", "--wait", "--no-open"]);
    expect(fa.code, fa.stderr).toBe(3);
    expect(fa.result.state).toBe("refused_precheck");
  }, 120_000);

  it("setup --hosted --grant: a step whose transaction carries another instruction is reported as a mismatch", async () => {
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    const first = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--grant", "0.05"]);
    expect(first.code, first.stderr).toBe(0);
    const r = site.requests[0];
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    Object.assign(r, { state: "linked", owner: SOL_OWNER });
    const extra = { program: "11111111111111111111111111111111", accounts: [SOL_OWNER, SOL_OTHER], data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
    Object.assign(r.steps![0], { state: "confirmed", wallet_asked: true, tx_hash: solana.land({ kind: "grant", owner: SOL_OWNER, agent: SOL_AGENT, amount: 50_000n, extra: [extra] }) });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(3);
    expect(done.result).toMatchObject({ state: "refused_precheck", linked: true, steps: [{ kind: "grant", state: "mismatch" }] });
    // the link itself was recorded, with the link the owner signed
    expect(publicOf("solana")).toMatch(/^LINK_ID=bl_test0001$/m);
  }, 180_000);

  it("the site acts for another Solana owner: refused before any link", async () => {
    hostedSolana();
    site.owner = SOL_OTHER;
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/owner recorded on this machine is .*nothing was sent/);
    expect(r.approve).toBeNull();
  }, 60_000);

  it("the site cannot tell whether the wallet signed: unknown (exit 5), never nothing sent", async () => {
    hostedSolana();
    site.owner = SOL_OWNER;
    site.onPoll = (r) => {
      if (r.polls === 2) r.state = "sending";
      if (r.polls >= 3) Object.assign(r, { state: "unknown", reason: "the wallet was asked and never answered" });
    };
    const r = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(5);
    expect(r.result.state).toBe("unknown");
  }, 60_000);

  it("an agent already linked, with --grant: refused, with fund-agent and grant one by one", async () => {
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    site.linked = { [SOL_AGENT]: SOL_OWNER };
    const r = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--grant", "0.05"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.reason).toMatch(new RegExp(`already belongs to an account on .* \\(${SOL_OWNER}\\).*nothing was sent`));
    expect(r.result.next).toMatch(/superstables budget fund-agent --rail solana, then superstables budget grant --rail solana --amount A/);
  }, 60_000);
});

describe("an agent key file other users can read signs nothing", () => {
  it("tempo: grant and setup --agent are refused before the site is asked, and the mode is left as found", async () => {
    hostedTempo();
    const agentFile = file("keys", "budget", "tempo-agent.env");
    chmodSync(agentFile, 0o644);
    site.owner = OWNER;
    const grant = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(grant.code, grant.stderr).toBe(3);
    expect(grant.result).toMatchObject({ state: "refused_precheck" });
    expect(grant.result.reason).toMatch(/tempo-agent\.env can be read by other users on this machine: chmod 600/);
    const extra = await budget(["setup", "--rail", "tempo", "--agent", "2", "--no-open"]);
    expect(extra.code, extra.stderr).toBe(3);
    expect(extra.result).toMatchObject({ state: "refused_precheck" });
    expect(site.requests).toHaveLength(0);
    expect(readFileSync(agentFile, "utf8")).not.toMatch(/AGENT2_/);
    expect(statSync(agentFile).mode & 0o777).toBe(0o644);
  }, 90_000);

  it("solana: grant and setup are refused before the site is asked", async () => {
    hostedSolana();
    chmodSync(file("keys", "budget", "solana-agent.env"), 0o644);
    site.owner = SOL_OWNER;
    const grant = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(grant.code, grant.stderr).toBe(3);
    expect(grant.result).toMatchObject({ state: "refused_precheck" });
    expect(grant.result.reason).toMatch(/solana-agent\.env can be read by other users on this machine: chmod 600/);
    const setup = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(setup.code, setup.stderr).toBe(3);
    expect(setup.result).toMatchObject({ state: "refused_precheck" });
    expect(site.requests).toHaveLength(0);
  }, 90_000);

  // setup reads the agent file again after the owner approves, to record the owner in it: a file that became readable
  // while it waited is refused there too, not replaced by a 0600 copy that hides it
  it("solana: setup --hosted refuses when the agent file became readable while it waited for the owner", async () => {
    const agentFile = file("keys", "budget", "solana-agent.env");
    write(agentFile, `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
    site.onPoll = (r) => {
      if (r.polls === 1) chmodSync(agentFile, 0o644);
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: SOL_OWNER });
    };
    const r = await budget(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/solana-agent\.env can be read by other users on this machine: chmod 600/);
    expect(statSync(agentFile).mode & 0o777).toBe(0o644);
    expect(readFileSync(agentFile, "utf8")).not.toMatch(/SOLANA_OWNER_ADDRESS/);
  }, 60_000);

  it("tempo: setup --hosted refuses when the agent file became readable while it waited for the owner", async () => {
    const agentFile = file("keys", "budget", "tempo-agent.env");
    write(agentFile, `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\n`);
    site.onPoll = (r) => {
      if (r.polls === 1) chmodSync(agentFile, 0o644);
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
    };
    const r = await budget(["setup", "--rail", "tempo", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/tempo-agent\.env can be read by other users on this machine: chmod 600/);
    expect(statSync(agentFile).mode & 0o777).toBe(0o644);
    expect(readFileSync(agentFile, "utf8")).not.toMatch(/OWNER_ADDRESS/);
  }, 60_000);
});

describe("hosted revoke when the agent key file cannot sign", () => {
  const WALLET = {
    solana: `ask the owner ${SOL_OWNER} to sign a transaction in their wallet on Solana devnet that removes the agent's spending permission from their associated USDC token account (mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU), using a tool that supports the SPL Token Revoke instruction`,
    tempo: `ask the owner ${OWNER} to sign a transaction in their wallet on Tempo Moderato that revokes access key ${TEMPO_AGENT}, using a tool that can call AccountKeychain.revokeKey(${TEMPO_AGENT}) at ${KEYCHAIN}`,
  };
  for (const rail of ["solana", "tempo"] as const) {
    it(`${rail}: missing, readable by others, a FIFO or not a key: ends at once with where to revoke, nothing requested`, async () => {
      const keyFile = file("keys", "budget", `${rail}-agent.env`);
      const setUp = () => {
        if (rail === "tempo") {
          hostedTempo();
          tempo.keys.set(`${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
        } else {
          hostedSolana();
          solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 50_000n });
        }
        site.owner = rail === "tempo" ? OWNER : SOL_OWNER;
      };
      const broken: [string, () => void][] = [
        ["missing", () => rmSync(keyFile)],
        ["readable by others", () => chmodSync(keyFile, 0o644)],
        ["a FIFO", () => { rmSync(keyFile); execFileSync("mkfifo", [keyFile]); }],
        ["not a key", () => write(keyFile, rail === "tempo" ? `AGENT_PRIVATE_KEY=0xnotakey\nAGENT_ADDRESS=${TEMPO_AGENT}\n` : `SOLANA_AGENT_SECRET_BASE58=notakey0\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`)],
        // 32 (Solana: 64) bytes of the right shape that are no key: 0, and all ff (above secp256k1's order)
        ["a zero key", () => write(keyFile, rail === "tempo" ? `AGENT_PRIVATE_KEY=0x${"00".repeat(32)}\nAGENT_ADDRESS=${TEMPO_AGENT}\n` : `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(new Uint8Array(64))}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`)],
        ["an all-ff key", () => write(keyFile, rail === "tempo" ? `AGENT_PRIVATE_KEY=0x${"ff".repeat(32)}\nAGENT_ADDRESS=${TEMPO_AGENT}\n` : `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(new Uint8Array(64).fill(255))}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`)],
      ];
      for (const [what, breakIt] of broken) {
        setUp();
        breakIt();
        const started = Date.now();
        const r = await budget(["revoke", "--rail", rail, "--wait", "--no-open"]);
        expect(r.code, `${what}: ${r.stdout}${r.stderr}`).toBe(3);
        expect(Date.now() - started, what).toBeLessThan(30_000);
        expect(r.result.state, what).toBe("refused_precheck");
        // the whole reason is in the rail's REFUSED line; the RESULT keeps at most 300 characters of it, and it names a file
        expect(r.stdout + r.stderr, what).toMatch(/REFUSED: .*; a hosted revoke is signed by the agent key, so nothing was requested\./);
        expect(r.result.reason.length, what).toBeGreaterThan(0);
        expect(r.result.next, what).toContain(`revoke without the agent key: with Revoke on the owner's account page on ${new URL(site.url).host}, or ${WALLET[rail]}. Then restore `);
        expect(site.requests, what).toHaveLength(0);
        rmSync(keyFile, { force: true });
      }
    }, 180_000);
  }
});

describe("tempo labels: one syntax in every command", () => {
  it("a label with an underscore works for setup --agent, a hosted grant (signed by that key) and revoke; one too long is refused everywhere", async () => {
    hostedTempo();
    site.owner = OWNER;
    site.onPoll = (r) => { if (r.polls >= 2 && r.kind === "link") Object.assign(r, { state: "linked", owner: OWNER }); };
    const added = await budget(["setup", "--rail", "tempo", "--agent", "ops_team", "--wait", "--no-open"]);
    expect(added.code, added.stderr).toBe(0);
    const key = added.result.agent;
    expect(publicOf("tempo")).toMatch(new RegExp(`^AGENTops_team_ADDRESS=${key}$`, "m"));
    // the hosted grant for that key reaches the site, signed by it
    site.onPoll = ownerSends("tempo");
    const g = await budget(["grant", "--rail", "tempo", "--agent", "ops_team", "--amount", "0.05", "--wait", "--no-open"]);
    expect(g.code, g.stderr).toBe(0);
    expect(site.requests.at(-1)!.body).toMatchObject({ kind: "grant", agent: key });
    const rv = await budget(["revoke", "--rail", "tempo", "--agent", "ops_team", "--wait", "--no-open"]);
    expect(rv.code, rv.stderr).toBe(0);
    expect(site.requests.at(-1)!.body).toMatchObject({ kind: "revoke", agent: key });
    const long = await budget(["status", "--rail", "tempo", "--agent", "a".repeat(41)]);
    expect(long.code).toBe(2);
    expect(long.result.reason).toBe("--agent must be 1 to 40 letters, digits or underscores");
    expect((await budget(["status", "--rail", "tempo", "--agent", "a".repeat(40)])).code).not.toBe(2);
  }, 180_000);
});
