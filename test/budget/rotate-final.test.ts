// `superstables budget rotate` completes only on a positive, final and agreed proof that the old agent has no authority left
// on every chain it covers: nothing is swapped, cleared or set up on a revoke that is merely in a block, and a run that stopped
// there polls the revoke it recorded instead of sending it again. The real dispatcher and rail scripts of a copy of the client
// whose endpoint table names loopback fakes: an in-memory Base Sepolia (two endpoints, `finalized` trailing the head) and a
// fake Solana devnet that reports "confirmed" until a test says "finalized". No network, no real key.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeEvm, usdc, type FakeEvm } from "../helpers/fake-evm.js";
import { startFakeSolana, type FakeSolana } from "../helpers/fake-chains.js";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";

let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const scratch = join(homedir(), ".cache", "superstables-tests");
mkdirSync(scratch, { recursive: true });
const homeDir = (prefix: string) => { const h = mkdtempSync(join(scratch, prefix)); cleanups.push(() => rmSync(h, { recursive: true, force: true })); return h; };

type Out = { code: number | null; stdout: string; stderr: string; result: any };
function budget(args: string[], env: Record<string, string>): Promise<Out> {
  return new Promise((done) => {
    const e: Record<string, string | undefined> = { ...process.env, B4_CHAIN: "", ...env };
    delete e.SUPERSTABLES_SITE;
    delete e.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env: e });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 280_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch {}
      done({ code, stdout, stderr, result });
    });
  });
}
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode }); };

// ---- evm --------------------------------------------------------------------------------------------------------------
const ownerKey = generatePrivateKey();
const OWNER = privateKeyToAccount(ownerKey);
const APPROVE = "0x095ea7b3";
const TRANSFER_FROM = "0x23b872dd";

/** Base Sepolia with the owner's 1 USDC allowance to the agent, `finalized` trailing the head by `lag`, a second endpoint over it. */
async function evmCase(o: { lag: number; gas?: boolean; held?: string }) {
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  const chain = await startFakeEvm({ finalizedLag: o.lag });
  chain.setUsdc(OWNER.address, usdc("100"));
  chain.setNative(OWNER.address, 10n ** 20n);
  chain.setNative(agent.address, o.gas === false ? 0n : 10n ** 17n);
  chain.setUsdc(agent.address, usdc(o.held ?? "0"));
  chain.setAllowance(OWNER.address, agent.address, usdc("1"));
  for (let i = 0; i < 8; i++) chain.mineEmpty();
  const mirror = await chain.mirror();
  cleanups.push(() => mirror.close(), () => chain.close());
  tree.set({ "base-sepolia": [{ url: chain.url, operator: "fake-a" }, { url: mirror.url, operator: "fake-b" }] });
  const home = homeDir("rotate-final-evm-");
  write(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent.address}\n`);
  const pubFile = join(home, "budget", "public", "evm-base-sepolia.env");
  write(pubFile, `# Base Sepolia public state\nB4_OWNER_ADDRESS=${OWNER.address}\nB4_AGENT_ADDRESS=${agent.address}\nB4_CAP=1000000\nB4_SET_AT=1760000000\n`, 0o644);
  write(join(home, "owner.env"), `B4_OWNER_KEY=${ownerKey}\n`);
  const env = { SUPERSTABLES_HOME: home, B4_RPC: chain.url };
  const rotate = () => budget(["rotate", "--rail", "evm", "--owner-key-file", join(home, "owner.env"), "--yes"], env);
  const keyFile = () => readFileSync(join(home, "keys", "budget", "evm-agent.env"), "utf8");
  const record = () => JSON.parse(readFileSync(join(home, "budget", "rotations", `evm-${agent.address.toLowerCase()}.json`), "utf8"));
  const fromAgent = () => chain.sentRaw.filter((t) => t.from.toLowerCase() === agent.address.toLowerCase()).length;
  const revokes = () => chain.sentRaw.filter((t) => (t.data.startsWith(APPROVE) && t.data.toLowerCase().includes(agent.address.slice(2).toLowerCase())) || t.data.startsWith(TRANSFER_FROM)).length;
  return { chain, agent, agentKey, home, rotate, keyFile, record, fromAgent, revokes, pub: () => readFileSync(pubFile, "utf8") };
}
type EvmCase = Awaited<ReturnType<typeof evmCase>>;
const untouched = (c: EvmCase) => {
  // the old key stays where it was, the public file still names the old agent, and nothing was put aside or set up
  expect(c.keyFile()).toContain(c.agentKey);
  expect(c.pub()).toContain(`B4_AGENT_ADDRESS=${c.agent.address}`);
  expect(existsSync(join(c.home, "keys", "budget", "retired", `evm-${c.agent.address.toLowerCase()}.env`))).toBe(false);
  expect(c.record().swappedAt).toBeUndefined();
  expect(c.record().finishedAt).toBeUndefined();
};

describe("evm: rotate needs the old allowance to be final at 0", () => {
  it("self-revoke with the final block five behind (two endpoints, 1 USDC): not rotated; the old key and records stay; the transaction is recorded", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    const r = await c.rotate();
    expect(r.result, all(r)).toMatchObject({ state: "incomplete", oldAgent: c.agent.address, retired: true, final: false });
    expect(r.result.state).not.toBe("rotated");
    expect(r.code).toBe(5);
    expect(r.result.next).toMatch(/superstables budget status --rail evm --chain base-sepolia/);
    expect(r.result.chains[0]).toMatchObject({ chain: "base-sepolia", recovered: false, setUp: false });
    untouched(c);
    expect(c.chain.allowanceOf(OWNER.address, c.agent.address)).toBe(0n); // the head has it; the final block does not yet
    const entry = c.record().chains["base-sepolia"];
    expect(entry.recoveredAt).toBeUndefined();
    expect(entry.revocation).toMatchObject({ final: false, selfTx: expect.stringMatching(/^0x[0-9a-f]{64}$/), selfBlock: expect.stringMatching(/^\d+$/) });
    // the public file is bound to that transaction, so status cannot call the budget revoked before it is final
    expect(c.pub()).toContain(`B4_REVOKED_TX=${entry.revocation.selfTx}`);
  }, 280_000);

  it("resume: once the chain makes it final the next run polls the record, sends no revoke again, and rotates", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    await c.rotate();
    const sentBefore = c.revokes();
    c.chain.finalizedLag = 0;
    const r = await c.rotate();
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "rotated", oldAgent: c.agent.address });
    expect(c.revokes()).toBe(sentBefore);
    expect(c.fromAgent()).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(c.home, "keys", "budget", "retired", `evm-${c.agent.address.toLowerCase()}.env`))).toBe(true);
  }, 400_000);

  it("resume while the chain is still behind: stays incomplete and sends nothing", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    await c.rotate();
    const sent = c.chain.sentRaw.length;
    const r = await c.rotate();
    expect(r.result, all(r)).toMatchObject({ state: "incomplete", final: false });
    expect(c.chain.sentRaw.length).toBe(sent);
    untouched(c);
  }, 400_000);

  it("owner revoke (the agent has no gas) with the final block five behind: not rotated", async () => {
    const c = await evmCase({ lag: 5, gas: false });
    const r = await c.rotate();
    expect(r.result, all(r)).toMatchObject({ state: "incomplete", retired: true, final: false });
    expect(r.code).toBe(5);
    untouched(c);
    expect(c.record().chains["base-sepolia"].revocation).toMatchObject({ final: false, ownerTx: expect.stringMatching(/^0x[0-9a-f]{64}$/), ownerBlock: expect.stringMatching(/^\d+$/) });
  }, 280_000);

  it("reorg: the allowance reads live again before the next run: it is revoked again, never completed on the old record", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    await c.rotate();
    const sentBefore = c.revokes();
    c.chain.setAllowance(OWNER.address, c.agent.address, usdc("1")); // the revoke was undone
    c.chain.finalizedLag = 0;
    const r = await c.rotate();
    expect(r.code, all(r)).toBe(0);
    expect(r.result.state).toBe("rotated");
    expect(c.revokes()).toBeGreaterThan(sentBefore);
    expect(c.chain.allowanceOf(OWNER.address, c.agent.address)).toBe(0n);
  }, 400_000);

  it("a later revoke by hand, final, is proof: rotate goes on instead of waiting for the one it recorded", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    const first = await c.rotate();
    expect(first.result, all(first)).toMatchObject({ state: "incomplete", final: false });
    const recorded = c.record().chains["base-sepolia"].revocation.selfTx;
    // the owner sees "landed, not final" and revokes again by hand: that overwrites the revoke in the public file
    const hand = await budget(["revoke", "--rail", "evm", "--owner-key-file", join(c.home, "owner.env"), "--yes"], { SUPERSTABLES_HOME: c.home, B4_RPC: c.chain.url });
    expect(hand.result, all(hand)).toMatchObject({ state: "landed" });
    expect(c.pub()).not.toContain(`B4_REVOKED_TX=${recorded}`);
    c.chain.finalizedLag = 0;
    const status = await budget(["status", "--rail", "evm"], { SUPERSTABLES_HOME: c.home, B4_RPC: c.chain.url });
    expect(status.result, all(status)).toMatchObject({ revoked: true, lastOwnerAction: { action: "revoke", final: true } });
    const r = await c.rotate();
    expect(r.code, all(r)).toBe(0);
    expect(r.result.state).toBe("rotated");
    expect(c.record().chains["base-sepolia"].revocation.provenBy).toBe(status.result.lastOwnerAction.tx);
    expect(c.record().chains["base-sepolia"].revocation.selfTx).toBe(recorded);
  }, 600_000);

  it("status names the agent's own revoke as such, and an owner's revoke as the owner's", async () => {
    const c = await evmCase({ lag: 5, held: "0.5" });
    await c.rotate();
    const env = { SUPERSTABLES_HOME: c.home, B4_RPC: c.chain.url };
    const own = await budget(["status", "--rail", "evm"], env);
    expect(own.result, all(own)).toMatchObject({ lastOwnerAction: { action: "revoke", final: false, by: "agent" } });
    expect(all(own)).toMatch(/last owner action: revoke \(the agent's own\) 0x[0-9a-f]{64} \(landed, not final yet\)/);
    expect(own.result.next).toMatch(/^the agent's own revoke 0x[0-9a-f]{64} landed but the chain has not made it final yet/);
    await budget(["revoke", "--rail", "evm", "--owner-key-file", join(c.home, "owner.env"), "--yes"], env);
    const hand = await budget(["status", "--rail", "evm"], env);
    expect(hand.result, all(hand)).toMatchObject({ lastOwnerAction: { action: "revoke", by: "owner" } });
    expect(all(hand)).toMatch(/last owner action: revoke 0x[0-9a-f]{64} /);
    expect(hand.result.next).toMatch(/^the revoke 0x[0-9a-f]{64} landed/);
  }, 600_000);

  it("a final chain at once: rotated in one run (the existing behaviour)", async () => {
    const c = await evmCase({ lag: 0, held: "0.5" });
    const r = await c.rotate();
    expect(r.code, all(r)).toBe(0);
    expect(r.result.state).toBe("rotated");
    expect(c.record().chains["base-sepolia"].revocation).toMatchObject({ final: true });
  }, 280_000);
});

// ---- solana -----------------------------------------------------------------------------------------------------------
const SOL_OWNER_KP = Keypair.fromSeed(new Uint8Array(32).fill(4));
const SOL_OWNER = SOL_OWNER_KP.publicKey.toBase58();
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_AGENT = SOL_AGENT_KP.publicKey.toBase58();

async function solCase() {
  const solana = await startFakeSolana({ websocket: true });
  solana.acceptTokenTransactions = true;
  cleanups.push(() => solana.close());
  tree.set({ "solana-devnet": [solana.url] });
  const home = homeDir("rotate-final-sol-");
  write(join(home, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${SOL_OWNER}\n`);
  write(join(home, "budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`, 0o644);
  write(join(home, "owner-sol.env"), `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(SOL_OWNER_KP.secretKey)}\n`);
  solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 1_000_000n });
  solana.usdc.set(SOL_AGENT, { amount: 300_000n, delegate: null, delegated: 0n });
  solana.balances.set(SOL_OWNER, 1_000_000_000n);
  solana.balances.set(SOL_AGENT, 20_000_000n);
  const env = { SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: solana.url };
  const rotate = () => budget(["rotate", "--rail", "solana", "--owner-key-file", join(home, "owner-sol.env"), "--yes"], env);
  const sends = () => solana.calls.filter((m) => m === "sendTransaction").length;
  const record = () => JSON.parse(readFileSync(join(home, "budget", "rotations", `solana-${SOL_AGENT}.json`), "utf8"));
  return { solana, home, rotate, sends, record, keyFile: () => readFileSync(join(home, "keys", "budget", "solana-agent.env"), "utf8"), pub: () => readFileSync(join(home, "budget", "public", "solana-devnet.env"), "utf8") };
}

describe("solana: rotate needs the revoke finalized", () => {
  it("a revoke that landed but is not finalized: no sweep, no swap, the signature and slot are recorded; the next run polls it and goes on", async () => {
    const c = await solCase();
    c.solana.confirmationStatus = "confirmed";
    const r = await c.rotate();
    expect(r.result, all(r)).toMatchObject({ state: "incomplete", oldAgent: SOL_AGENT, retired: true, final: false });
    expect(r.result.state).not.toBe("rotated");
    expect(r.code).toBe(5);
    expect(c.sends()).toBe(1); // the revoke only: the agent's funds did not move
    expect(c.solana.usdc.get(SOL_AGENT)!.amount).toBe(300_000n);
    expect(c.keyFile()).toContain(`SOLANA_AGENT_ADDRESS=${SOL_AGENT}`);
    expect(c.pub()).toContain(`SOLANA_AGENT_ADDRESS=${SOL_AGENT}`);
    expect(c.record().swappedAt).toBeUndefined();
    expect(c.record().chains.devnet.revokedAt).toBeUndefined();
    expect(c.record().chains.devnet.revocation).toMatchObject({ final: false, tx: expect.any(String), slot: expect.any(Number) });
    // final now: the recorded signature is polled, not sent again
    c.solana.confirmationStatus = "finalized";
    const before = c.sends();
    const again = await c.rotate();
    expect(again.code, all(again)).toBe(0);
    expect(again.result.state).toBe("rotated");
    expect(c.sends() - before).toBe(2); // the sweep's USDC and SOL transfers; no second revoke
    expect(c.solana.usdc.get(SOL_AGENT)!.amount).toBe(0n);
  }, 480_000);

  it("reorg: the delegate reads live again before the next run: it is revoked again before any sweep", async () => {
    const c = await solCase();
    c.solana.confirmationStatus = "confirmed";
    await c.rotate();
    c.solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 1_000_000n });
    c.solana.confirmationStatus = "finalized";
    const before = c.sends();
    const r = await c.rotate();
    expect(r.code, all(r)).toBe(0);
    expect(r.result.state).toBe("rotated");
    expect(c.sends() - before).toBe(3); // a new revoke, then the sweep
    expect(c.solana.usdc.get(SOL_OWNER)).toMatchObject({ delegate: null, delegated: 0n });
  }, 480_000);

  it("the sweep script says whether its transfers are finalized, and keeps their signatures", async () => {
    const c = await solCase();
    c.solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    c.solana.confirmationStatus = "confirmed";
    const env = { ...process.env, SUPERSTABLES_HOME: c.home, SUPERSTABLES_SOLANA_RPC: c.solana.url } as Record<string, string>;
    const sweep = (args: string[]) => new Promise<Out>((done) => {
      const child = spawn(process.execPath, [resolve(tree.root, "budget/solana/rotate.mjs"), ...args], { cwd: tree.root, env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("close", (code) => {
        const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
        done({ code, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
      });
    });
    const s = await sweep(["--sweep"]);
    expect(s.code, all(s)).toBe(0);
    expect(s.result).toMatchObject({ state: "ok", final: false });
    expect(s.result.tx.usdc).toEqual(expect.any(String));
    expect(s.result.tx.sol).toEqual(expect.any(String));
    const sigs = `${s.result.tx.usdc},${s.result.tx.sol}`;
    const pending = await sweep(["--confirm", sigs]);
    expect(pending.result).toMatchObject({ state: "pending", final: false });
    c.solana.confirmationStatus = "finalized";
    const done = await sweep(["--confirm", sigs]);
    expect(done.code, all(done)).toBe(0);
    expect(done.result).toMatchObject({ state: "final", final: true });
    const unknown = await sweep(["--confirm", bs58.encode(Buffer.alloc(64, 9))]);
    expect(unknown.result).toMatchObject({ state: "not_found", final: false });
  }, 240_000);

  it("a sweep whose USDC transfer is confirmed and whose SOL transfer failed is pending until the USDC transfer is finalized", async () => {
    const c = await solCase();
    const usdcSig = bs58.encode(Buffer.alloc(64, 7));
    const solSig = bs58.encode(Buffer.alloc(64, 8));
    let usdcStatus = "confirmed";
    c.solana.overrides = {
      getSignatureStatuses: (params) => ({ context: { slot: c.solana.slot }, value: (params[0] as string[]).map((s) => (s === solSig ? { slot: 1, confirmations: null, err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" } : { slot: 1, confirmations: null, err: null, confirmationStatus: usdcStatus })) }),
    };
    const env = { ...process.env, SUPERSTABLES_HOME: c.home, SUPERSTABLES_SOLANA_RPC: c.solana.url } as Record<string, string>;
    const confirm = () => new Promise<Out>((done) => {
      const child = spawn(process.execPath, [resolve(tree.root, "budget/solana/rotate.mjs"), "--confirm", `${usdcSig},${solSig}`], { cwd: tree.root, env });
      let stdout = "", stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("close", (code) => {
        const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
        done({ code, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
      });
    });
    const waiting = await confirm();
    expect(waiting.result, all(waiting)).toMatchObject({ state: "pending", final: false });
    usdcStatus = "finalized";
    const done = await confirm();
    expect(done.result, all(done)).toMatchObject({ state: "failed", final: false });
  }, 240_000);
});
