// `superstables budget` with hosted approvals on tempo (Moderato) and solana (devnet), as an agent meets it: the real
// dispatcher and rail scripts, against a fake superstables.com and fake Moderato and devnet RPCs on 127.0.0.1. The site
// reports what the owner's wallet did; the fake chain shows it; the command reads the chain before it reports. No network,
// no real key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { evmOwner, startFakeSite, type FakeRequest, type FakeSite } from "../helpers/fake-site.js";
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

describe("tempo, hosted", () => {
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
    expect(first.result.terms).toMatchObject({ title: "Link this agent and approve a budget of 0.05 pathUSD", amount: "0.05", unit: "pathUSD" });
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

  it("grant: refused when the site acts for another owner, before any link", async () => {
    hostedTempo();
    site.owner = OTHER;
    const r = await budget(["grant", "--rail", "tempo", "--amount", "0.05", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(new RegExp(`would ask ${OTHER} to approve this, but the owner recorded on this computer is ${OWNER}.*nothing was sent`));
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
    expect(first.result.terms).toMatchObject({ title: "Link this agent, send it SOL for fees and approve a budget of 0.05 test USDC", amount: "0.05", unit: "USDC" });
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
    expect(rv.result.reason).toMatch(/not the one planned/);
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
    expect(r.result.reason).toMatch(/owner recorded on this computer is .*nothing was sent/);
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
    expect(r.result.reason).toMatch(new RegExp(`already linked on .* to the account ${SOL_OWNER}.*nothing was sent`));
    expect(r.result.next).toMatch(/superstables budget fund-agent --rail solana, then superstables budget grant --rail solana --amount A/);
  }, 60_000);
});
