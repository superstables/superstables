// Solana and Tempo budget verdicts that let an agent pay again, or end a budget, need agreeing RPC endpoints: a delegate or
// a token account gone, a key revoked, a purchase that never happened or failed. The real dispatcher and rail scripts, in a
// copy of the client whose endpoint table names loopback fakes (test/helpers/endpoint-tree.ts), against fake Solana and
// Moderato servers over one ledger, some of which lie. No network, no real key.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { decodeFunctionData, encodeFunctionResult, keccak256, toBytes } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { Abis } from "viem/tempo";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";
import { accountHomeWith, DEV_SETTINGS } from "../helpers/owner-settings.js";
import { endpointTree, scratchDir, type EndpointTree } from "../helpers/endpoint-tree.js";
import { ataOf, startFakeSolana, startFakeTempo, USDC_MINT, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";
import { evmOwner, startFakeSite, type FakeRequest, type FakeSite } from "../helpers/fake-site.js";
import { MAINNET_GENESIS } from "../helpers/fake-solana-pay.js";

const OWNER_EVM = evmOwner("22");
const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
const TEMPO_AGENT = privateKeyToAddress(TEMPO_KEY);
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_AGENT = SOL_AGENT_KP.publicKey.toBase58();
const SOL_OWNER_KP = Keypair.fromSeed(new Uint8Array(32).fill(4));
const SOL_OWNER = SOL_OWNER_KP.publicKey.toBase58();
const REVOKED_AT = "REVOKED_AT=1760000000\n";
const TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

let tree: EndpointTree;
let home: string;
let site: FakeSite;
const toClose: { close(): Promise<void> }[] = [];
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
beforeEach(async () => {
  home = scratchDir("ss-quorum-");
  site = await startFakeSite();
});
afterEach(async () => {
  await site.close();
  for (const s of toClose.splice(0)) await s.close();
  rmSync(home, { recursive: true, force: true });
});

const solana = async () => { const s = await startFakeSolana(); toClose.push(s); return s; };
const tempo = async () => { const s = await startFakeTempo(); toClose.push(s); return s; };
const track = <T extends { close(): Promise<void> }>(s: T): T => { toClose.push(s); return s; };

type Out = { code: number; stdout: string; stderr: string; result: any };
function spawnIn(argv: string[], env: Record<string, string>): Promise<Out> {
  return new Promise((done, fail) => {
    const all: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, ...env };
    delete all.SUPERSTABLES_SITE;
    delete all.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(argv[0], argv.slice(1), { cwd: tree.root, env: all });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const budget = (args: string[], env: Record<string, string>) => spawnIn([process.execPath, resolve(tree.root, "budget/cli.mjs"), ...args], env);
const script = (file: string, args: string[], env: Record<string, string>) =>
  spawnIn(file.endsWith(".ts") ? [resolve(tree.root, "node_modules/.bin/tsx"), resolve(tree.root, file), ...args] : [process.execPath, resolve(tree.root, file), ...args], env);

const file = (...p: string[]) => join(home, ...p);
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
};

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────────────

const solEnv = (primary: FakeSolana) => ({ SUPERSTABLES_SOLANA_RPC: primary.url });
/** The agent key file and the public file of a Solana setup on this computer, and the owner's accounts on the chain. */
function solanaSetup(chain: FakeSolana, { delegate = null as string | null, revoked = false } = {}) {
  write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${SOL_OWNER}\n`);
  write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n${revoked ? REVOKED_AT : ""}`, 0o644);
  chain.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate, delegated: delegate ? 500_000n : 0n });
  chain.balances.set(SOL_OWNER, 1_000_000_000n);
  chain.balances.set(SOL_AGENT, 100_000_000n);
}
const ownerKeyFile = () => {
  const path = file("owner-A.env");
  write(path, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(SOL_OWNER_KP.secretKey)}\n`);
  return path;
};
/** What a liar answers to getAccountInfo for the owner's USDC account: the token account with no delegate. */
const noDelegateAccount = (slot: number) => {
  const d = Buffer.alloc(165);
  USDC_MINT.toBuffer().copy(d, 0);
  new PublicKey(SOL_OWNER).toBuffer().copy(d, 32);
  d.writeBigUInt64LE(5_000_000n, 64);
  d.writeUInt8(1, 108);
  return { context: { slot }, value: { data: [d.toString("base64"), "base64"], executable: false, lamports: 2039280, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 165 } };
};
/** What a liar answers to getAccountInfo: a delegate (the agent) that can move `delegated`. */
const delegatedAccount = (slot: number, delegated: bigint) => {
  const out = noDelegateAccount(slot);
  const d = Buffer.from(out.value.data[0], "base64");
  d.writeUInt32LE(1, 72);
  new PublicKey(SOL_AGENT).toBuffer().copy(d, 76);
  d.writeBigUInt64LE(delegated, 121);
  out.value.data[0] = d.toString("base64");
  return out;
};
const absentAccount = (slot: number) => ({ context: { slot }, value: null });
const sent = (c: FakeSolana) => c.calls.filter((m) => m === "sendTransaction" || m === "getLatestBlockhash");
const SIG = bs58.encode(Buffer.alloc(64, 77));

/** A purchase journal the agent paid the fee of (its signature is the transaction id), long expired. */
function writeSolanaOp(op: string, extra: Record<string, unknown> = {}) {
  write(file("budget", "ops", "solana-devnet", `${op}.json`), JSON.stringify({
    op, kind: "purchase", state: "unknown", agent: SOL_AGENT, agentSig: SIG, tx: SIG, feePayer: SOL_AGENT, payTo: SOL_OWNER, amountUsdc: "0.01",
    searchFromSlot: 3900, lastValidBlockHeight: 4000, submittedAt: new Date(Date.now() - 3_600_000).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [], ...extra,
  }, null, 2) + "\n");
}

describe("solana: a second endpoint on another cluster", () => {
  it("is left out of the agreement, so a recorded revoke is not called revoked", async () => {
    const a = await solana();
    const b = track(await a.mirror({ genesis: MAINNET_GENESIS }));
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { revoked: true });
    const r = await script("budget/solana/readBudget.mjs", ["--owner", SOL_OWNER], solEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("revoked: false");
    expect(r.stdout).toMatch(/agreement: a second RPC endpoint was not available/);
    expect(b.calls).not.toContain("getAccountInfo");
    const s = await budget(["status", "--rail", "solana"], solEnv(a));
    expect(s.result).toMatchObject({ revoked: false });
  }, 120_000);
});

describe("verdicts with an RPC that only the environment names", () => {
  const needle = /is not an RPC the owner set.*unset it, or ask the owner to add it in the owner settings/;
  it("solana: a recorded revoke both table endpoints agree on stays unknown, and the words say why and what to do", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    const env = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { revoked: true });
    const s = await budget(["status", "--rail", "solana"], { ...solEnv(env), SUPERSTABLES_TEST_ACCOUNT_HOME: accountHomeWith(null) });
    expect(s.result, s.stdout + s.stderr).toMatchObject({ revoked: false, atRisk: null });
    expect(s.result.reason).toMatch(needle);
    expect(s.result.next).toMatch(needle);
    expect(s.result.next).toMatch(/count it as live/);
  }, 120_000);

  it("tempo: a revoked key both table endpoints agree on stays unknown, and the words say why and what to do", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    const env = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, REVOKED_KEY);
    const home2 = accountHomeWith(null);
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], { ...tempoEnv(env), SUPERSTABLES_TEST_ACCOUNT_HOME: home2 });
    expect(r.stdout).toMatch(/isRevoked:\s+unknown/);
    expect(r.stdout).toMatch(needle);
    const s = await budget(["status", "--rail", "tempo"], { ...tempoEnv(env), SUPERSTABLES_TEST_ACCOUNT_HOME: home2 });
    expect(s.result, s.stdout + s.stderr).toMatchObject({ revoked: false, atRisk: null });
    expect(s.result.reason).toMatch(needle);
  }, 120_000);
});

describe("solana: status after a recorded revoke", () => {
  it("the primary shows no delegate and a second endpoint a live one: not revoked, and the endpoints disagree", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { delegate: SOL_AGENT, revoked: true });
    a.overrides = { getAccountInfo: () => noDelegateAccount(a.slot) };
    const r = await script("budget/solana/readBudget.mjs", ["--owner", SOL_OWNER], solEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("revoked: false");
    expect(r.stdout).toMatch(/agreement: the RPC endpoints disagree/);
    expect(r.stdout).toContain("maximum the delegate can still move: unknown");
    const s = await budget(["status", "--rail", "solana"], solEnv(a));
    expect(s.result).toMatchObject({ revoked: false, remaining: null, atRisk: null, reason: expect.stringMatching(/disagree/) });
    expect(s.result.next).toMatch(/could not be confirmed on chain \(.*disagree.*\): count it as live; run superstables budget status --rail solana again later/);
  }, 120_000);

  it("the primary shows a delegate that can move 0 and a second endpoint shows 0.5 USDC: unknown, not 'nothing to spend'", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { delegate: SOL_AGENT });
    a.overrides = { getAccountInfo: () => delegatedAccount(a.slot, 0n) };
    const r = await script("budget/solana/readBudget.mjs", ["--owner", SOL_OWNER], solEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("delegatedAmount (remaining): unknown");
    expect(r.stdout).toContain("maximum the delegate can still move: unknown");
    const s = await budget(["status", "--rail", "solana"], solEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ state: "ok", remaining: null, atRisk: null });
    expect(s.result.next).toMatch(/count it as live; run superstables budget status --rail solana again later/);
    expect(s.result.reason).toMatch(/disagree/);
  }, 120_000);

  it("both endpoints show a delegate that can move 0: the budget is spent", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { delegate: SOL_AGENT });
    a.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 0n });
    const s = await budget(["status", "--rail", "solana"], solEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ state: "ok", remaining: "0", atRisk: "0" });
    expect(s.result.next).toMatch(/nothing to spend/);
  }, 120_000);

  it("both endpoints agree on no delegate: revoked, with the agreement named", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a, { revoked: true });
    const r = await script("budget/solana/readBudget.mjs", ["--owner", SOL_OWNER], solEnv(a));
    expect(r.stdout).toContain("revoked: true");
    expect(r.stdout).toMatch(/agreement: quorum/);
  }, 120_000);
});

describe("solana: revoke when the owner's USDC account reads as absent", () => {
  it("on the primary only: unknown (exit 5), nothing sent", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a);
    a.overrides = { getAccountInfo: () => absentAccount(a.slot) };
    const r = await budget(["revoke", "--rail", "solana", "--owner-key-file", ownerKeyFile(), "--yes"], solEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.reason).toMatch(/reads as absent on one RPC, but the RPC endpoints disagree/);
    expect(sent(a)).toEqual([]);
    expect(sent(b)).toEqual([]);
  }, 120_000);

  it("on both: nothing to clear, with the agreement named", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a);
    a.usdc.delete(SOL_OWNER);
    const r = await budget(["revoke", "--rail", "solana", "--owner-key-file", ownerKeyFile(), "--yes"], solEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", revoked: null, agreement: "quorum" });
    expect(sent(a)).toEqual([]);
    expect(sent(b)).toEqual([]);
  }, 120_000);
});

describe("solana: reconcile of an expired purchase", () => {
  it("the primary hides the landed transaction and a second endpoint shows it: settled", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a);
    a.land({ kind: "revoke", owner: SOL_OWNER, agent: SOL_AGENT, signature: SIG });
    a.overrides = { getSignatureStatuses: (p) => ({ context: { slot: a.slot }, value: (p[0] as string[]).map(() => null) }) };
    writeSolanaOp("sol-liar");
    const r = await budget(["reconcile", "--rail", "solana", "--op", "sol-liar"], solEnv(a));
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "settled", tx: { settle: SIG } });
  }, 120_000);

  it("both clean: not found, with the agreement named", async () => {
    const a = await solana();
    const b = track(await a.mirror());
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a);
    writeSolanaOp("sol-clean");
    const r = await budget(["reconcile", "--rail", "solana", "--op", "sol-clean"], solEnv(a));
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "not_found", agreement: "quorum" });
    expect(b.calls).toContain("getSignatureStatuses");
  }, 120_000);

  it("the second endpoint is on another cluster: unknown, not found is not claimed", async () => {
    const a = await solana();
    const b = track(await a.mirror({ genesis: MAINNET_GENESIS }));
    tree.set({ "solana-devnet": [a.url, b.url] });
    solanaSetup(a);
    writeSolanaOp("sol-wrong");
    const r = await budget(["reconcile", "--rail", "solana", "--op", "sol-wrong"], solEnv(a));
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "unknown" });
    expect(r.result.reason).toMatch(/second RPC endpoint was not available/);
  }, 120_000);
});

describe("solana: owner commands use the owner's endpoints", () => {
  it("an RPC set only in the environment is refused by default, and gets nothing from fund-agent", async () => {
    const owners = await solana();
    const env = await solana();
    tree.set({ "solana-devnet": [owners.url] });
    solanaSetup(owners);
    const r = await budget(["fund-agent", "--rail", "solana", "--amount", "0.01", "--owner-key-file", ownerKeyFile(), "--yes"], { ...solEnv(env), SUPERSTABLES_TEST_ACCOUNT_HOME: accountHomeWith(null) });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/is not an RPC the owner set/);
    expect(env.calls).toEqual([]);
    expect(owners.calls).toEqual([]);
  }, 120_000);

  it("an RPC set only in the environment is used when the owner allows this computer's RPCs", async () => {
    const owners = await solana();
    const env = await solana();
    tree.set({ "solana-devnet": [owners.url] });
    solanaSetup(owners);
    await budget(["fund-agent", "--rail", "solana", "--amount", "0.01", "--owner-key-file", ownerKeyFile(), "--yes"], { ...solEnv(env), SUPERSTABLES_TEST_ACCOUNT_HOME: accountHomeWith(DEV_SETTINGS) });
    expect(env.calls).toContain("getGenesisHash");
    expect(env.calls).toContain("getBalance");
  }, 120_000);

  it("an RPC set in the environment that is the owner's own is used", async () => {
    const owners = await solana();
    tree.set({ "solana-devnet": [owners.url] });
    solanaSetup(owners);
    await budget(["fund-agent", "--rail", "solana", "--amount", "0.01", "--owner-key-file", ownerKeyFile(), "--yes"], solEnv(owners));
    expect(owners.calls).toContain("getLatestBlockhash");
  }, 120_000);
});

// ── Tempo ────────────────────────────────────────────────────────────────────────────────────────────────

const tempoEnv = (primary: FakeTempo) => ({ SUPERSTABLES_TEMPO_RPC: primary.url });
const tempoKeyId = `${OWNER_EVM.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`;
const REVOKED_KEY = { expiry: 0n, limit: 0n, period: 0n, periodEnd: 0n, revoked: true, scoped: false };
function tempoSetup(hosted = false) {
  write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${OWNER_EVM}\n`);
  write(file("budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER_EVM}\nAGENT_ADDRESS=${TEMPO_AGENT}\n${hosted ? `APPROVALS=hosted\nSITE=${site.url}\n` : ""}`, 0o644);
}
const LIVE_KEY = { expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), limit: 5_000_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false };
/** A liar's getKey: the live key, with `expiry` instead of its own. Other calls are left to the fake. */
const keyAnswer = (params: any[], over: { expiry: bigint }) => {
  let call;
  try { call = decodeFunctionData({ abi: Abis.accountKeychain, data: params[0].data }); } catch { return undefined; }
  if (call.functionName !== "getKey") return undefined;
  const a = call.args as unknown as any[];
  return encodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getKey", result: { signatureType: 0, keyId: a[1], expiry: over.expiry, enforceLimits: true, isRevoked: false } });
};
/** A liar's remaining limit: 0, for both view functions that read it. */
const zeroRemaining = (params: any[]) => {
  let call;
  try { call = decodeFunctionData({ abi: Abis.accountKeychain, data: params[0].data }); } catch { return undefined; }
  if (call.functionName === "getRemainingLimit") return encodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getRemainingLimit", result: 0n });
  if (call.functionName === "getRemainingLimitWithPeriod") return encodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getRemainingLimitWithPeriod", result: [0n, 0n] });
  return undefined;
};
/** A liar's getKey: the key reads not revoked, with an expiry. */
const liveKeyAnswer = (params: any[]) => {
  let call;
  try { call = decodeFunctionData({ abi: Abis.accountKeychain, data: params[0].data }); } catch { return undefined; }
  if (call.functionName !== "getKey") return undefined;
  const a = call.args as unknown as any[];
  return encodeFunctionResult({ abi: Abis.accountKeychain, functionName: "getKey", result: { signatureType: 0, keyId: a[1], expiry: BigInt(Math.floor(Date.now() / 1000) + 86_400), enforceLimits: true, isRevoked: false } });
};

describe("tempo: readBudget", () => {
  it("two endpoints disagree on isRevoked: unknown, and status counts the budget as not revoked", async () => {
    const a = await tempo();
    const b = track(await a.mirror({ overrides: { eth_call: (p) => liveKeyAnswer(p) ?? zeroRemaining(p) } }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, REVOKED_KEY);
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/isRevoked:\s+unknown \(the key reads revoked on one RPC, but the RPC endpoints disagree\)/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ revoked: false, remaining: null, atRisk: null, expired: false });
    expect(s.result.reason).toMatch(/disagree/);
    expect(s.result.next).toMatch(/count it as live; run superstables budget status --rail tempo again later/);
  }, 120_000);

  it("the primary says the key expired and a second endpoint says it is live: unknown, never atRisk 0", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, LIVE_KEY);
    a.overrides = { eth_call: (p) => keyAnswer(p, { expiry: 1_700_000_000n }) };
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(a));
    expect(r.stdout).toMatch(/expired:\s+unknown \(the key reads expired on one RPC, but the RPC endpoints disagree\)/);
    expect(r.stdout).not.toMatch(/EXPIRED/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ expired: false, atRisk: "5", remaining: "5" });
    expect(s.result.atRisk).not.toBe("0");
    expect(s.result.next).toMatch(/count it as live; run superstables budget status --rail tempo again later/);
    expect(s.result.reason).toMatch(/disagree/);
  }, 120_000);

  it("the primary says 0 remains and a second endpoint says 5: unknown, never 'the budget is spent'", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, LIVE_KEY);
    a.overrides = { eth_call: zeroRemaining };
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(a));
    expect(r.stdout).toMatch(/remaining:\s+unknown \(the remaining limit reads 0 on one RPC, but the RPC endpoints disagree\)/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ remaining: null, atRisk: null });
    expect(s.result.next).not.toMatch(/spent/);
    expect(s.result.next).toMatch(/count it as live/);
  }, 120_000);

  it("the primary says the key was never granted and a second endpoint has it: not 'no budget granted yet'", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, LIVE_KEY);
    a.overrides = { eth_call: (p) => keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p) };
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(a));
    expect(r.stdout).not.toMatch(/granted:\s+no\b/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ atRisk: null });
    expect(s.result.next).not.toMatch(/no budget granted yet/);
    expect(s.result.next).toMatch(/count it as live/);
  }, 120_000);

  /**
   * A table [a, b], primary b. `a` is honest at head 1000 and granted the key at block 900: asked about an earlier block it
   * answers as before the grant. `b` is 500 blocks behind (head 500), so the engine reads every member at block 500.
   */
  async function lateGrant(lie: (p: any[]) => unknown) {
    const a = await tempo();
    a.keys.set(tempoKeyId, LIVE_KEY);
    let asked = 0n;
    a.overrides = {
      eth_getBlockByNumber: (p) => { if (p[0] !== "latest") asked = BigInt(p[0]); return undefined; },
      eth_call: (p) => (p[1]?.blockHash && asked < 900n ? keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p) : undefined),
    };
    const b = track(await a.mirror({ overrides: {
      eth_getBlockByNumber: (p) => (p[0] === "latest" ? { number: "0x1f4", timestamp: "0x1", hash: `0x${"ab".repeat(32)}`, transactions: [] } : undefined),
      eth_blockNumber: () => "0x1f4",
      eth_call: lie,
    } }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    return b;
  }

  it("never granted on an endpoint 500 blocks behind and on the old block of an honest one: not 'no budget granted yet'", async () => {
    const b = await lateGrant((p) => keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p));
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(b));
    expect(r.stdout).not.toMatch(/granted:\s+no\b/);
    expect(r.stdout).toMatch(/not final on chain yet/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(b));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ atRisk: null });
    expect(s.result.next).not.toMatch(/no budget granted yet/);
    expect(s.result.next).toMatch(/count it as live/);
  }, 120_000);

  it("0 remaining on an endpoint 500 blocks behind and on the old block of an honest one: not 'the budget is spent'", async () => {
    // the live expiry and 0 remaining at the latest block, the pre-grant key at the block it names
    const b = await lateGrant((p) => (p[1]?.blockHash ? keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p) : liveKeyAnswer(p) ?? zeroRemaining(p)));
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(b));
    expect(r.stdout).toMatch(/remaining:\s+unknown/);
    expect(r.stdout).toMatch(/not final on chain yet/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(b));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ remaining: null, atRisk: null });
    expect(s.result.next).not.toMatch(/spent/);
    expect(s.result.next).toMatch(/count it as live/);
  }, 120_000);

  it("0 remaining on an endpoint 50 blocks behind (within 64), the agreed block before the grant: not 'the budget is spent'", async () => {
    const a = await tempo();
    a.keys.set(tempoKeyId, LIVE_KEY);
    let asked = 0n;
    a.overrides = {
      eth_getBlockByNumber: (p) => { if (p[0] !== "latest") asked = BigInt(p[0]); return undefined; },
      eth_call: (p) => (p[1]?.blockHash && asked < 990n ? keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p) : undefined),
    };
    const b = track(await a.mirror({ overrides: {
      eth_getBlockByNumber: (p) => (p[0] === "latest" ? { number: "0x3b6", timestamp: "0x1", hash: `0x${"ab".repeat(32)}`, transactions: [] } : undefined),
      eth_blockNumber: () => "0x3b6",
      eth_call: (p) => (p[1]?.blockHash ? keyAnswer(p, { expiry: 0n }) ?? zeroRemaining(p) : liveKeyAnswer(p) ?? zeroRemaining(p)),
    } }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(b));
    expect(r.stdout).toMatch(/remaining:\s+unknown/);
    const s = await budget(["status", "--rail", "tempo"], tempoEnv(b));
    expect(s.result, s.stdout + s.stderr).toMatchObject({ remaining: null, atRisk: null });
    expect(s.result.next).not.toMatch(/spent/);
  }, 120_000);

  it("every endpoint shows the key spent, expired or never granted: believed", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, { ...LIVE_KEY, limit: 0n });
    const spent = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(spent.result, spent.stdout + spent.stderr).toMatchObject({ remaining: "0", atRisk: "0" });
    expect(spent.result.next).toMatch(/spent/);
    a.keys.set(tempoKeyId, { ...LIVE_KEY, expiry: 1_700_000_000n });
    const expired = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(expired.result, expired.stdout + expired.stderr).toMatchObject({ expired: true, atRisk: "0" });
    a.keys.delete(tempoKeyId);
    const never = await budget(["status", "--rail", "tempo"], tempoEnv(a));
    expect(never.result, never.stdout + never.stderr).toMatchObject({ atRisk: "0" });
    expect(never.result.next).toMatch(/no budget granted yet/);
  }, 180_000);

  it("both endpoints read it revoked: true, with the agreement named", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    a.keys.set(tempoKeyId, REVOKED_KEY);
    const r = await script("budget/tempo/readBudget.ts", ["--owner", OWNER_EVM, "--key", TEMPO_AGENT], tempoEnv(a));
    expect(r.stdout).toMatch(/isRevoked:\s+true \(agreement: quorum\)/);
  }, 120_000);
});

describe("tempo: revoke", () => {
  it("the primary simulates KeyAlreadyRevoked and a second endpoint success: the revoke is sent", async () => {
    const a = await tempo();
    const b = track(await a.mirror({ revokeSimulation: () => "ok" }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup(true);
    site.owner = OWNER_EVM;
    a.keys.set(tempoKeyId, REVOKED_KEY);
    a.revokeSimulation = () => "KeyAlreadyRevoked";
    site.onPoll = (r: FakeRequest) => {
      if (r.polls !== 2 || r.kind === "link") return;
      Object.assign(r, { state: "confirmed", tx_hash: a.mine(r.owner!, r.body.transaction.data), wallet_asked: true });
    };
    const r = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", revoked: true });
    expect(site.requests).toHaveLength(1);
  }, 120_000);

  it("both refuse with KeyAlreadyRevoked: already revoked, nothing sent, with the agreement named", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup(true);
    site.owner = OWNER_EVM;
    a.keys.set(tempoKeyId, REVOKED_KEY);
    const r = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", revoked: true, agreement: "quorum" });
    expect(site.requests).toHaveLength(0);
  }, 120_000);

  it("the two simulations differ without either succeeding: unknown (exit 5), nothing sent", async () => {
    const a = await tempo();
    const b = track(await a.mirror({ revokeSimulation: () => "KeyNotFound" }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup(true);
    site.owner = OWNER_EVM;
    a.keys.set(tempoKeyId, REVOKED_KEY);
    a.revokeSimulation = () => "KeyAlreadyRevoked";
    const r = await budget(["revoke", "--rail", "tempo", "--wait", "--no-open"], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(site.requests).toHaveLength(0);
  }, 120_000);
});

describe("tempo: reconcile of an expired purchase", () => {
  const MEMO = `0x${"6d".repeat(32)}`;
  const writeTempoOp = (op: string) => write(file("budget", "ops", "tempo-moderato", `${op}.json`), JSON.stringify({
    op, rail: "tempo", kind: "buy", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    intent: { amount: "10000", amountDecimal: "0.01", token: "0x20C0000000000000000000000000000000000000", recipient: RECIPIENT, chainId: 42431, owner: OWNER_EVM, agent: TEMPO_AGENT },
    startBlock: "900", memo: MEMO, validBefore: Math.floor(Date.now() / 1000) - 3600, history: [],
  }, null, 2) + "\n");
  const memoHit = (params: any[]) => (params[0]?.topics?.[3] === MEMO ? [{ transactionHash: `0x${"cd".repeat(32)}`, address: params[0].address, topics: params[0].topics, data: "0x", blockNumber: "0x3e8", blockHash: `0x${"ab".repeat(32)}`, removed: false }] : undefined);

  it("the primary's memo search is empty past validBefore and a second endpoint has the transfer: not 'not found'", async () => {
    const a = await tempo();
    const b = track(await a.mirror({ overrides: { eth_getLogs: memoHit } }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    writeTempoOp("tempo-liar");
    const r = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-liar"], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
  }, 120_000);

  // A purchase the chain shows bound to this operation (memo, owner, agent key), whose receipt each server names with `status`.
  const bound = (status: "0x0" | "0x1") => {
    const hash = `0x${"cd".repeat(32)}`;
    const padded = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
    const log = { address: "0x20C0000000000000000000000000000000000000", topics: [TRANSFER_WITH_MEMO_TOPIC, padded(OWNER_EVM), padded(RECIPIENT), MEMO], data: `0x${(10_000).toString(16).padStart(64, "0")}`, blockNumber: "0x3e8", blockHash: `0x${"ab".repeat(32)}`, transactionHash: hash, removed: false };
    return {
      eth_getLogs: (p: any[]) => (p[0]?.topics?.[3] === MEMO ? [log] : undefined),
      eth_getTransactionByHash: () => ({ hash, from: OWNER_EVM, signature: { keyId: TEMPO_AGENT } }),
      eth_getTransactionReceipt: () => ({ transactionHash: hash, status, blockNumber: "0x3e8", blockHash: `0x${"ab".repeat(32)}`, from: OWNER_EVM, logs: [log], gasUsed: "0x1" }),
    };
  };

  it("the primary names a reverted receipt and a second endpoint a successful one: unknown (exit 5), never failed", async () => {
    const a = await tempo();
    a.overrides = bound("0x0");
    const b = track(await a.mirror({ overrides: bound("0x1") }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    writeTempoOp("tempo-revert-liar");
    const r = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-revert-liar"], tempoEnv(a));
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.reason).toMatch(/reverted on one RPC, but .*Do not pay again/);
  }, 120_000);

  it("both endpoints name the reverted receipt: failed, with the agreement named", async () => {
    const a = await tempo();
    a.overrides = bound("0x0");
    const b = track(await a.mirror({ overrides: bound("0x0") }));
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    writeTempoOp("tempo-revert-both");
    const r = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-revert-both"], tempoEnv(a));
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "failed" });
  }, 120_000);

  it("both endpoints are clean past validBefore: not found", async () => {
    const a = await tempo();
    const b = track(await a.mirror());
    tree.set({ "tempo-moderato": [a.url, b.url] });
    tempoSetup();
    writeTempoOp("tempo-clean");
    const r = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-clean"], tempoEnv(a));
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "not_found" });
  }, 120_000);

  it("a second endpoint on another chain is left out: with one public endpoint the verdict stands, with two named it does not", async () => {
    const a = await tempo();
    const b = track(await a.mirror({ overrides: { eth_chainId: () => "0x1" } }));
    tempoSetup();
    tree.set({ "tempo-moderato": [a.url] });
    writeTempoOp("tempo-single");
    const single = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-single"], tempoEnv(a));
    expect(single.result, single.stdout + single.stderr).toMatchObject({ state: "not_found" });

    tree.set({ "tempo-moderato": [a.url, b.url] });
    writeTempoOp("tempo-two");
    const two = await budget(["reconcile", "--rail", "tempo", "--op", "tempo-two"], tempoEnv(a));
    expect(two.result, two.stdout + two.stderr).toMatchObject({ state: "unknown" });
    expect(b.calls).not.toContain("eth_getLogs");
  }, 120_000);
});

// The journal of a Solana purchase keeps what each confirming endpoint has read apart from the primary's.
describe("solana: assessAgreed in process", () => {
  const LAST = 4000;
  const FROM = 3900;
  const GENESIS = SOLANA_DEVNET_GENESIS;
  let ops: typeof import("../../budget/solana/ops.mjs");
  let previousHome: string | undefined;
  beforeAll(async () => {
    previousHome = process.env.SUPERSTABLES_HOME;
    process.env.SUPERSTABLES_HOME = scratchDir("ss-quorum-ops-");
    ops = await import("../../budget/solana/ops.mjs");
  });
  afterAll(() => {
    rmSync(process.env.SUPERSTABLES_HOME!, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.SUPERSTABLES_HOME;
    else process.env.SUPERSTABLES_HOME = previousHome;
  });

  /** A connection whose chain has no transaction of ours; getBlock fails from `failFrom` on (an RPC that rate limits). */
  const conn = (url: string, o: { failFrom?: number; genesis?: string } = {}) => ({
    rpcEndpoint: url,
    getGenesisHash: async () => o.genesis ?? GENESIS,
    getEpochInfo: async () => ({ blockHeight: LAST + 50, absoluteSlot: 9000 }),
    getFirstAvailableBlock: async () => 0,
    getSignatureStatuses: async (s: string[]) => ({ context: { slot: 9000 }, value: s.map(() => null) }),
    getSignaturesForAddress: async () => [],
    getBlocks: async (from: number) => Array.from({ length: 200 }, (_, i) => from + i),
    getBlock: async (slot: number) => {
      if (o.failFrom !== undefined && slot >= o.failFrom) throw new Error("429");
      return { blockHeight: LAST - 149 + (slot - (FROM + 1)), transactions: [] };
    },
  });
  const set = { verdict: [{ url: "http://p.test", operator: "p" }, { url: "http://c.test", operator: "c" }], quorum: 2, agreement: "quorum" as const };
  const facilitated = (op: string) => ({ op, state: "unknown", agent: SOL_AGENT, agentSig: "ours", tx: "theirs", feePayer: "someone-else", searchFromSlot: FROM, lastValidBlockHeight: LAST, submittedAt: new Date(Date.now() - 3_600_000).toISOString(), history: [] as unknown[] });
  const options = (extra: Record<string, unknown> = {}) => ({ paceMs: 0, pause: async () => {}, searchMs: 60_000, set, call: async () => GENESIS, ...extra });

  it("keeps a confirming endpoint's progress under confirm.<id>, never in the primary's fields, and resumes from it", async () => {
    const { endpointId } = await import("../../src/core/rpc-endpoints.mjs");
    const rec = facilitated("sol-progress");
    ops.writeOp(rec.op, rec);
    const primary = conn("http://p.test");
    // the confirmer reads five blocks, then rate limits: pending, with its own progress
    const first = await ops.assessAgreed(primary, ops.readOp(rec.op), { ...options(), connect: () => conn("http://c.test", { failFrom: FROM + 6 }) });
    expect(first.verdict).toBe("pending");
    expect((first as any).reason).toMatch(/second RPC endpoint has not finished reading the landing blocks/);
    const saved = ops.readOp(rec.op);
    expect(saved.confirm[endpointId("http://c.test")].searchedToSlot).toBe(FROM + 5);
    expect(saved.searchedToSlot).toBe(FROM + 151);
    // the next run resumes the confirmer where it stopped, and the primary's own progress is not borrowed
    const reads: number[] = [];
    const resumed = { ...conn("http://c.test"), getBlock: async (slot: number) => { reads.push(slot); return { blockHeight: LAST - 149 + (slot - (FROM + 1)), transactions: [] }; } };
    const second = await ops.assessAgreed(primary, saved, { ...options(), connect: () => resumed });
    expect(second).toMatchObject({ verdict: "not_found", agreement: "quorum" });
    expect(reads[0]).toBe(FROM + 6);
  });

  it("a failed verdict is believed only when the confirmer names the same failed transaction", async () => {
    const err = { InstructionError: [0, "Custom"] };
    /** A chain on which the transaction `target` landed and failed. */
    const failing = (url: string, target: string) => ({
      ...conn(url),
      getSignatureStatuses: async (sigs: string[]) => ({ context: { slot: 9000 }, value: sigs.map((x) => (x === target ? { slot: 3950, confirmations: null, err, confirmationStatus: "finalized" } : null)) }),
      getTransaction: async (sig: string) => ({ slot: 3950, meta: { err }, transaction: { signatures: [sig, "ours"] } }),
    });
    const run = async (op: string, confirmer: any) => {
      const rec = facilitated(op);
      ops.writeOp(rec.op, rec);
      return ops.assessAgreed(failing("http://p.test", "theirs"), ops.readOp(rec.op), { ...options(), connect: () => confirmer });
    };
    const clean = await run("sol-failed-clean", conn("http://c.test"));
    expect(clean.verdict, JSON.stringify(clean)).toBe("pending");
    expect((clean as any).reason).toMatch(/the transaction failed on one RPC, but the RPC endpoints disagree/);
    const elsewhere = await run("sol-failed-other", failing("http://c.test", "ours"));
    expect(elsewhere.verdict, JSON.stringify(elsewhere)).toBe("pending");
    expect((elsewhere as any).reason).toMatch(/the transaction failed on one RPC, but the RPC endpoints disagree/);
    const same = await run("sol-failed-same", failing("http://c.test", "theirs"));
    expect(same).toMatchObject({ verdict: "failed", tx: "theirs", agreement: "quorum" });
  });

  it("a confirmer on another cluster is left out, and its verdict is not counted", async () => {
    const rec = facilitated("sol-cluster");
    ops.writeOp(rec.op, rec);
    const out = await ops.assessAgreed(conn("http://p.test"), ops.readOp(rec.op), { ...options({ call: async () => MAINNET_GENESIS }), connect: () => conn("http://c.test", { genesis: MAINNET_GENESIS }) });
    expect(out.verdict).toBe("pending");
    expect((out as any).reason).toMatch(/second RPC endpoint was not available/);
  });

  it("with one operator in the set (a single public endpoint) the primary's verdict stands, labelled single", async () => {
    const rec = facilitated("sol-single");
    ops.writeOp(rec.op, rec);
    const one = { verdict: [{ url: "http://p.test", operator: "p" }], quorum: 1, agreement: "single" as const };
    const out = await ops.assessAgreed(conn("http://p.test"), ops.readOp(rec.op), options({ set: one }));
    expect(out).toMatchObject({ verdict: "not_found", agreement: "single" });
  });

  it("finds a facilitator-paid purchase behind six newer transactions of the agent", async () => {
    const newer = Array.from({ length: 6 }, (_, i) => ({ signature: `other-${i}`, blockTime: Math.floor(Date.now() / 1000) }));
    const ours = { signature: "theirs", blockTime: Math.floor(Date.now() / 1000) - 5 };
    const rec = { ...facilitated("sol-discover") };
    const c = {
      ...conn("http://p.test"),
      getSignaturesForAddress: async (_a: unknown, o: { limit: number }) => [...newer, ours].slice(0, o.limit),
      getTransaction: async (sig: string) => ({ slot: 7, meta: { err: null }, transaction: { signatures: sig === "theirs" ? ["theirs", "ours"] : [sig, "unrelated"] } }),
    };
    const found = await ops.findOwnTx(c, rec, { paceMs: 0, pause: async () => {} });
    expect(found).toMatchObject({ sig: "theirs", err: null, final: true });
  });

  it("reads nothing when the window holds more than twenty candidates: the listing is incomplete, never absence", async () => {
    const stamp = Math.floor(Date.now() / 1000);
    const reads: string[] = [];
    const c = {
      ...conn("http://p.test"),
      getSignaturesForAddress: async (_a: unknown, o: { limit: number }) => Array.from({ length: o.limit }, (_, i) => ({ signature: `n-${i}`, blockTime: stamp })),
      getTransaction: async (sig: string) => { reads.push(sig); return { slot: 7, meta: { err: null }, transaction: { signatures: [sig, "unrelated"] } }; },
    };
    expect(await ops.findOwnTx(c, facilitated("sol-long"), { paceMs: 0, pause: async () => {} })).toBeNull();
    expect(reads).toEqual([]);
  });

  it("stops listing at the start of the window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = Array.from({ length: 150 }, (_, i) => ({ signature: `old-${i}`, blockTime: now - 7200 }));
    const reads: string[] = [];
    const c = {
      ...conn("http://p.test"),
      getSignaturesForAddress: async () => [{ signature: "recent", blockTime: now - 5 }, ...old].slice(0, 100),
      getTransaction: async (sig: string) => { reads.push(sig); return { slot: 7, meta: { err: null }, transaction: { signatures: [sig, "unrelated"] } }; },
    };
    expect(await ops.findOwnTx(c, facilitated("sol-window"), { paceMs: 0, pause: async () => {} })).toBeNull();
    expect(reads).toEqual(["recent"]);
  });
});
