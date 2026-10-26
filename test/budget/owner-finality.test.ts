// An owner grant, revoke, gas transfer or recover revoke is reported `final` only when its block is final on the chain's rule and
// the effect reads the same through agreeing endpoints; before that it is `landed` (exit 0, final: false). A grant waits for the
// previous revoke to be final, and a setup that bundles a grant never grants over an allowance it cannot read. The real
// dispatcher (budget/cli.mjs) and rail scripts of a copy of the client whose endpoint table names the fakes, against in-memory
// chains (test/helpers/fake-evm.ts, fake-chains.ts) and a fake superstables.com on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes, encodeFunctionData, decodeFunctionData, parseAbi } from "viem";
import { Abis } from "viem/tempo";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { startFakeEvm, usdc, type FakeEvm, type FakeMirror } from "../helpers/fake-evm.js";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { startFakeSite, evmOwner, type FakeSite, type FakeRequest } from "../helpers/fake-site.js";
import { ataOf, startFakeSolana, startFakeTempo, USDC_MINT, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";

let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const scratch = join(homedir(), ".cache", "superstables-tests");
mkdirSync(scratch, { recursive: true });
/** Ends the approval waiters a case left in the background (a hosted setup returns while its waiter keeps running). Linux only. */
function stopWaiters(forHome: string) {
  if (process.platform !== "linux") return;
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`SUPERSTABLES_HOME=${forHome}`)) process.kill(Number(pid), "SIGKILL");
    } catch { /* gone, or not ours */ }
  }
}
const homeDir = (prefix: string) => { const h = mkdtempSync(join(scratch, prefix)); cleanups.push(() => { stopWaiters(h); rmSync(h, { recursive: true, force: true }); }); return h; };

type Run = { code: number | null; stdout: string; stderr: string; result: any };
function cli(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((done) => {
    const e: Record<string, string | undefined> = { ...process.env, B4_CHAIN: "", ...env };
    delete e.SUPERSTABLES_SITE;
    delete e.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env: e });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 140_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch {}
      done({ code, stdout, stderr, result });
    });
  });
}


/** Runs one rail script (argv[0] is a script run by node, or an executable such as tsx) in the copy of the client under test. */
function script(argv: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const [first, ...rest] = argv;
    const isNode = first.endsWith(".mjs");
    const child = spawn(isNode ? process.execPath : first, isNode ? argv : rest, { cwd: tree.root, env: { ...process.env, B4_CHAIN: "", ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

// ---- evm --------------------------------------------------------------------------------------------------------------

/** An in-memory Base Sepolia whose `finalized` tag trails the head by `lag`, a second endpoint over it, an owner key file and a home. */
async function evmCase(o: { lag: number; allow?: string; agentFile?: boolean; recorded?: boolean } = { lag: 5 }) {
  const ownerKey = generatePrivateKey(), owner = privateKeyToAccount(ownerKey);
  const agentKey = generatePrivateKey(), agent = privateKeyToAccount(agentKey);
  const chain = await startFakeEvm({ finalizedLag: o.lag });
  chain.setUsdc(owner.address, usdc("100"));
  chain.setNative(owner.address, 10n ** 20n);
  chain.setNative(agent.address, 10n ** 17n);
  chain.setAllowance(owner.address, agent.address, usdc(o.allow ?? "1"));
  for (let i = 0; i < 8; i++) chain.mineEmpty(); // blocks that keep the state as it is now: an older final block reads it
  const mirror = await chain.mirror();
  cleanups.push(() => mirror.close(), () => chain.close());
  tree.set({ "base-sepolia": [{ url: chain.url, operator: "fake-a" }, { url: mirror.url, operator: "fake-b" }] });
  const home = homeDir("owner-finality-evm-");
  mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
  if (o.agentFile !== false) writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\n`, { mode: 0o600 });
  const pubFile = join(home, "budget", "public", "evm-base-sepolia.env");
  if (o.agentFile !== false) writeFileSync(pubFile, `B4_AGENT_ADDRESS=${agent.address}\n${o.recorded === false ? "" : `B4_OWNER_ADDRESS=${owner.address}\n`}`);
  writeFileSync(join(home, "owner.env"), `B4_OWNER_KEY=${ownerKey}\n`, { mode: 0o600 });
  const env = { SUPERSTABLES_HOME: home, B4_RPC: chain.url };
  const run = (args: string[], extra: Record<string, string> = {}) => cli(args, { ...env, ...extra });
  const keyArgs = ["--owner-key-file", join(home, "owner.env"), "--yes"];
  return { chain, mirror, owner, agent, home, run, keyArgs, pub: () => readFileSync(pubFile, "utf8") };
}
function ownHeadDrift(c: Pick<Awaited<ReturnType<typeof evmCase>>, "chain" | "mirror">) {
  const low = c.chain.blocks[c.chain.blocks.length - 1].number;
  const high = low + 1822n;
  const header = (n: bigint) => ({ number: `0x${n.toString(16)}`, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: "0x10" });
  c.chain.hook = (method, params) => method === "eth_getBlockByNumber"
    ? { result: header(params[0] === "finalized" || params[0] === "latest" ? low : BigInt(params[0])) }
    : method === "eth_call" ? { result: `0x${"0".repeat(64)}` } : undefined;
  c.mirror.hook = (method, params) => method === "eth_getBlockByNumber"
    ? { result: header(params[0] === "finalized" || params[0] === "latest" ? high : BigInt(params[0])) }
    : method === "eth_call" ? { result: `0x${(BigInt(params[1]?.blockHash ?? params[1]) > low ? 5n : 0n).toString(16).padStart(64, "0")}` } : undefined;
}

// Own-head drift the other way: a grant final on the leading endpoint only, so the latest block already reads it.
function ownHeadDriftLiveGrant(c: Pick<Awaited<ReturnType<typeof evmCase>>, "chain" | "mirror">) {
  ownHeadDrift(c);
  const base = c.chain.hook!;
  c.chain.hook = (method, params) => method === "eth_call" && params[1] === "latest" ? { result: `0x${(5n).toString(16).padStart(64, "0")}` } : base(method, params);
}

const APPROVE = "0x095ea7b3";
const approvals = (chain: FakeEvm) => chain.sentRaw.filter((t) => t.data.startsWith(APPROVE)).length;

describe("evm: a revoke is landed until the chain makes it final", () => {
  it("revoke with a final head five blocks behind: landed, final false, exit 0, the transaction recorded; status then says final once the lag clears", async () => {
    const c = await evmCase({ lag: 5 });
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "revoke", state: "landed", final: false, revoked: false });
    expect(r.result.tx.revoke).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.result.next).toMatch(/superstables budget status --rail evm later: the revoke is final when status says so/);
    expect(c.pub()).toMatch(new RegExp(`^B4_REVOKED_TX=${r.result.tx.revoke}$`, "m"));
    expect(c.pub()).toMatch(/^B4_REVOKED_BLOCK=\d+$/m);
    expect(c.pub()).toMatch(/^B4_REVOKED_AT=\d+$/m);
    // not final yet: status does not call it revoked, and says which action is waiting
    const early = await c.run(["status", "--rail", "evm"]);
    expect(early.result).toMatchObject({ state: "ok", revoked: false, lastOwnerAction: { action: "revoke", tx: r.result.tx.revoke, final: false } });
    expect(early.result.next).toMatch(/landed but the chain has not made it final yet: count the budget as live/);
    c.chain.finalizedLag = 0;
    const s = await c.run(["status", "--rail", "evm"]);
    expect(s.result).toMatchObject({ state: "ok", revoked: true, lastOwnerAction: { action: "revoke", tx: r.result.tx.revoke, final: true } });
    expect(s.stdout + s.stderr).toMatch(/last owner action: revoke 0x[0-9a-f]{64} \(final\)/);
  }, 150_000);

  it("revoke once the chain is final at once: revoked, final true", async () => {
    const c = await evmCase({ lag: 0 });
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", final: true, revoked: true });
  }, 150_000);

  it("grant under own-head drift waits for finality and points to status", async () => {
    const c = await evmCase({ lag: 0, allow: "0" });
    ownHeadDrift(c);
    const r = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringContaining("the previous revoke is not final yet"), next: "superstables budget status --rail evm, then grant again once the revoke is final" });
    expect(approvals(c.chain)).toBe(0);
  }, 150_000);

  it("grant under own-head drift with an allowance at the latest block is refused as a live allowance, not a revoke", async () => {
    const c = await evmCase({ lag: 0, allow: "0" });
    ownHeadDriftLiveGrant(c);
    const r = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/is already live for this agent/);
    expect(r.stdout).not.toMatch(/the previous revoke is not final yet/);
    expect(approvals(c.chain)).toBe(0);
  }, 150_000);

  it("a grant right after a landed revoke is refused: the allowance at the final block is not 0", async () => {
    const c = await evmCase({ lag: 5 });
    const rv = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(rv.result.state).toBe("landed");
    expect(approvals(c.chain)).toBe(1);
    const g = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g.code, g.stdout + g.stderr).toBe(3);
    expect(g.result).toMatchObject({ state: "refused_precheck" });
    expect(g.result.reason).toMatch(/the previous revoke is not final yet: the allowance reads 0 at the latest block but 1 USDC at the final block/);
    expect(approvals(c.chain)).toBe(1); // nothing more was sent
  }, 150_000);

  it("a grant then a revoke that landed but is not final, then a regrant: refused, nothing sent; once the revoke is final it is allowed", async () => {
    // the first grant is itself not final, so the final block reads 0 throughout: only the recorded revoke can tell
    const c = await evmCase({ lag: 5, allow: "0" });
    const g1 = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g1.result, g1.stdout + g1.stderr).toMatchObject({ state: "landed" });
    const rv = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(rv.result, rv.stdout + rv.stderr).toMatchObject({ state: "landed", final: false });
    expect(approvals(c.chain)).toBe(2);
    const g2 = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g2.code, g2.stdout + g2.stderr).toBe(3);
    expect(g2.result).toMatchObject({ state: "refused_precheck" });
    expect(g2.result.reason).toMatch(/the previous revoke is not final yet/);
    expect(approvals(c.chain)).toBe(2); // nothing more was sent
    c.chain.finalizedLag = 0;
    const g3 = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g3.code, g3.stdout + g3.stderr).toBe(0);
    expect(g3.result).toMatchObject({ state: "settled", final: true });
    expect(approvals(c.chain)).toBe(3);
  }, 250_000);

  it("a grant when the allowance is 0 at the final block: set, final true once the lag clears; landed while it does not", async () => {
    const c = await evmCase({ lag: 5, allow: "0" });
    const landed = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(landed.code, landed.stdout + landed.stderr).toBe(0);
    expect(landed.result).toMatchObject({ command: "grant", state: "landed", final: false });
    expect(c.pub()).toMatch(/^B4_CAP=500000$/m);
    expect(c.pub()).toMatch(/^B4_SET_TX=0x[0-9a-f]{64}$/m);
    const c2 = await evmCase({ lag: 0, allow: "0" });
    const set = await c2.run(["grant", "--rail", "evm", "--amount", "0.5", ...c2.keyArgs]);
    expect(set.result).toMatchObject({ state: "settled", final: true });
  }, 150_000);

  it("an endpoint that does not know the finalized tag: never final, never 'not revoked'", async () => {
    const c = await evmCase({ lag: 0 });
    c.mirror.hook = (method, params) => (method === "eth_getBlockByNumber" && params[0] === "finalized" ? { error: { code: -32602, message: "unknown block tag" } } : undefined);
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "landed", final: false });
    expect(r.result.state).not.toBe("not_revoked");
  }, 150_000);

  it("a reorganisation after landing: the block's hash changes, so status says not revoked and not final", async () => {
    const c = await evmCase({ lag: 5 });
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.result.state).toBe("landed");
    const block = BigInt(c.pub().match(/^B4_REVOKED_BLOCK=(\d+)$/m)![1]);
    c.chain.blocks.find((b: any) => b.number === block)!.hash = keccak256(toBytes("another block"));
    c.chain.finalizedLag = 0;
    const s = await c.run(["status", "--rail", "evm"]);
    expect(s.result).toMatchObject({ revoked: false, lastOwnerAction: { action: "revoke", final: false } });
  }, 150_000);
});

const approveAbi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);
const rawSend = (url: string, raw: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
const allowanceWord = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

describe("evm: records of the owner's last action, and the other paths that must not say final early", () => {
  it("a lying final head on one endpoint only: landed, never final", async () => {
    const c = await evmCase({ lag: 5 });
    // the primary names the latest block as final; the mirror keeps the real lag, so the endpoints do not agree
    c.chain.hook = (method, params) => { if (method === "eth_getBlockByNumber" && params[0] === "finalized") params[0] = "latest"; return undefined; };
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "landed", final: false, revoked: false });
  }, 150_000);

  // The fake chain's blocks run ahead of the wall clock whenever several are mined in one second (each is at least a second after
  // the one before), so how the chain's clock compares with the machine's is not fixed: the case runs with it level and an hour ahead.
  it.each([[0], [3600]])("a stale revoke record after a grant: status is not revoked while a later zeroing is not final (chain clock %i s ahead)", async (skew) => {
    const c = await evmCase({ lag: 0 });
    c.chain.advance(skew);
    const rv = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(rv.result.state).toBe("settled");
    expect(c.pub()).toMatch(/^B4_REVOKED_TX=/m);
    for (let i = 0; i < 8; i++) c.chain.mineEmpty();
    c.chain.finalizedLag = 5;
    const g = await c.run(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g.result.state).toBe("landed");
    // a grant drops the revoke's record, tx and block with it
    expect(c.pub()).not.toMatch(/^B4_REVOKED_(AT|TX|BLOCK)=/m);
    // the owner then zeroes the allowance above the final head
    const raw = await c.owner.signTransaction({ chainId: 84532, nonce: c.chain.sentRaw.filter((t) => t.from.toLowerCase() === c.owner.address.toLowerCase()).length, to: c.chain.usdcAddress as `0x${string}`, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [c.agent.address, 0n] }), gas: 100000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, type: "eip1559" });
    await rawSend(c.chain.url, raw);
    // the revoke is recorded at the time of the block that zeroed the allowance, which is after the final block whatever the chain's
    // clock says (the machine's clock is not comparable with a chain whose blocks can run ahead of it)
    const zeroedAt = c.chain.blocks[c.chain.blocks.length - 1].timestamp;
    writeFileSync(join(c.home, "budget", "public", "evm-base-sepolia.env"), `${c.pub()}B4_REVOKED_AT=${zeroedAt}\n`);
    const s = await c.run(["status", "--rail", "evm"]);
    expect(s.result.revoked).toBe(false);
    // and a new revoke drops the grant's record
    expect(c.pub()).toMatch(/^B4_SET_TX=/m);
    const rv2 = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(rv2.result.tx.revoke).toMatch(/^0x/);
    expect(c.pub()).not.toMatch(/^B4_SET_(TX|BLOCK)=/m);
  }, 200_000);

  it("a revoke by key file when both endpoints agree the allowance is above 0 at the final block: not revoked", async () => {
    const c = await evmCase({ lag: 0 });
    // latest reads 0 (the revoke worked there); every other block the endpoints are asked about reads 1
    const hook: FakeEvm["hook"] = (method, params) => (method === "eth_call" && params[1] !== undefined && params[1] !== "latest" ? { result: allowanceWord(1_000_000n) } : undefined);
    c.chain.hook = hook; c.mirror.hook = hook;
    const r = await c.run(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(5); // the dispatcher turns a failure after a send into unknown
    expect(r.result).toMatchObject({ state: "unknown", revoked: false, reason: "the allowance still reads above 0" });
    expect(r.stdout + r.stderr).toMatch(/the endpoints agree that the allowance reads 1 USDC at a final block at or after the revoke; it is not revoked/);
  }, 150_000);

  it("recover by key file when both endpoints agree the allowance is above 0 at the final block: stops before any funds move", async () => {
    const c = await evmCase({ lag: 0 });
    c.chain.setNative(c.agent.address, 0n); // no gas for the agent's own revoke: the owner's key file revokes
    const hook: FakeEvm["hook"] = (method, params) => (method === "eth_call" && params[1] !== undefined && params[1] !== "latest" ? { result: allowanceWord(1_000_000n) } : undefined);
    c.chain.hook = hook; c.mirror.hook = hook;
    const r = await c.run(["recover", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.stdout + r.stderr).toMatch(/the endpoints agree that the allowance reads 1 USDC at a final block at or after the owner's revoke/);
    expect(r.result.state).toBe("unknown");
    expect(Object.keys(r.result.tx)).toEqual(["ownerRevoke"]);
  }, 150_000);

  it("rotate --clear-agent drops the agent's grant and revoke records, with their blocks (evm)", async () => {
    const c = await evmCase({ lag: 0 });
    const keys = ["B4_CAP=1000000", "B4_SET_AT=1", "B4_SET_TX=0xa", "B4_SET_BLOCK=3", "B4_REVOKED_AT=2", "B4_REVOKED_TX=0xb", "B4_REVOKED_BLOCK=4", "LINK_ID=x", "LINK_CODE=y"];
    writeFileSync(join(c.home, "budget", "public", "evm-base-sepolia.env"), `${c.pub()}${keys.join("\n")}\n`);
    const r = await script([resolve(tree.root, "node_modules/.bin/tsx"), resolve(tree.root, "budget/evm/rotate.ts"), "--clear-agent", c.agent.address], { SUPERSTABLES_HOME: c.home, B4_RPC: c.chain.url });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(c.pub()).not.toMatch(/^(B4_AGENT_ADDRESS|B4_CAP|B4_SET_AT|B4_SET_TX|B4_SET_BLOCK|B4_REVOKED_AT|B4_REVOKED_TX|B4_REVOKED_BLOCK|LINK_ID|LINK_CODE)=/m);
    expect(c.pub()).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${c.owner.address}$`, "m"));
  }, 100_000);

  it("hosted revoke: the site says confirmed, the transaction is above the final head: landed, exit 0", async () => {
    const c = await evmCase({ lag: 5 });
    const site = await startFakeSite();
    cleanups.push(() => site.close());
    site.owner = c.owner.address;
    writeFileSync(join(c.home, "budget", "public", "evm-base-sepolia.env"), `${c.pub()}APPROVALS=hosted\nSITE=${site.url}\n`);
    const raw = await c.owner.signTransaction({ chainId: 84532, nonce: 0, to: c.chain.usdcAddress as `0x${string}`, data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [c.agent.address, 0n] }), gas: 100000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, type: "eip1559" });
    site.onPoll = (r) => { if (r.kind !== "revoke" || r.polls !== 2) return; void rawSend(c.chain.url, raw); Object.assign(r, { state: "confirmed", tx_hash: keccak256(raw), wallet_asked: true }); };
    const r = await c.run(["revoke", "--rail", "evm", "--wait", "--no-open"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "landed", revoked: false, final: false });
  }, 150_000);
});

describe("evm: setup --hosted --grant grants only over an allowance it can read", () => {
  async function bundle(o: Parameters<typeof evmCase>[0]) {
    const c = await evmCase(o);
    const site = await startFakeSite();
    cleanups.push(() => site.close());
    const run = (...more: string[]) => c.run(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", ...more]);
    return { ...c, site, run, run0: c.run };
  }

  it("setup under own-head drift waits for finality and points to status", async () => {
    const c = await bundle({ lag: 0, allow: "0" });
    ownHeadDrift(c);
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringContaining("the previous revoke is not final yet"), next: "superstables budget status --rail evm, then grant again once the revoke is final" });
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("setup under own-head drift with an allowance at the latest block is refused as a live budget, not a revoke", async () => {
    const c = await bundle({ lag: 0, allow: "0" });
    ownHeadDriftLiveGrant(c);
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringContaining("a budget is live"), next: expect.stringContaining("revoke first") });
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("a reused key and an allowance read that fails: refused before any request to the site", async () => {
    const c = await bundle({ lag: 0, allow: "0" });
    c.mirror.hook = (method) => (method === "eth_call" ? { error: { code: -32000, message: "boom" } } : undefined);
    c.chain.hook = c.mirror.hook;
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/the allowance at the chain's final block could not be confirmed/);
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("a reused key and no recorded owner: refused, set up first (link), then grant", async () => {
    const c = await bundle({ lag: 0, allow: "0", recorded: false });
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/this agent key existed before this setup, and no owner is recorded for it here, so whether an older allowance is live cannot be read\. Set up first \(link\), then grant/);
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("a reused key with --new-owner: refused with its own wording, and the next step keeps the flag", async () => {
    const c = await bundle({ lag: 0, allow: "0" });
    const r = await c.run("--new-owner");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/this setup replaces the owner, so whether the new owner already gives this agent an allowance cannot be read before the link\. Set up first \(link\), then grant/);
    expect(r.result.reason).not.toMatch(/no owner is recorded/);
    expect(r.result.next).toMatch(/setup --rail evm --hosted --new-owner, then superstables budget grant/);
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("a reused key and a live allowance at the final block: refused", async () => {
    const c = await bundle({ lag: 0, allow: "1" });
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/a budget is live: the owner on record 0x[0-9a-fA-F]{40} still allows the agent 1 /);
    expect(c.site.posts).toEqual([]);
  }, 150_000);

  it("a grant then a revoke that landed but is not final, then setup --grant: refused, no request to the site", async () => {
    const c = await bundle({ lag: 5, allow: "0" });
    const g1 = await c.run0(["grant", "--rail", "evm", "--amount", "0.5", ...c.keyArgs]);
    expect(g1.result, g1.stdout + g1.stderr).toMatchObject({ state: "landed" });
    const rv = await c.run0(["revoke", "--rail", "evm", ...c.keyArgs]);
    expect(rv.result, rv.stdout + rv.stderr).toMatchObject({ state: "landed", final: false });
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/the previous revoke is not final yet/);
    expect(c.site.posts).toEqual([]);
  }, 250_000);

  it("a key created in this run: the grant is asked for, as before", async () => {
    const c = await bundle({ lag: 0, allow: "0", agentFile: false, recorded: false });
    const r = await c.run();
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "setup", state: "waiting_owner" });
    expect(c.site.posts.length).toBe(1);
    expect(existsSync(join(c.home, "keys", "budget", "evm-agent.env"))).toBe(true);
  }, 150_000);
});

// ---- solana -----------------------------------------------------------------------------------------------------------

const SOL_OWNER_KP = Keypair.fromSeed(new Uint8Array(32).fill(4));
const SOL_OWNER = SOL_OWNER_KP.publicKey.toBase58();
const SOL_AGENT = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));

/** The token account as a node answers getAccountInfo at `finalized`, with a live delegate (the fake answers the same for every commitment). */
function accountWithDelegate(slot: number, delegate: string, delegated: bigint) {
  const d = Buffer.alloc(165);
  USDC_MINT.toBuffer().copy(d, 0);
  Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(5_000_000n, 64);
  d.writeUInt32LE(1, 72);
  Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBuffer().copy(d, 76);
  void delegate;
  d.writeUInt8(1, 108);
  d.writeBigUInt64LE(delegated, 121);
  return { context: { slot }, value: { data: [d.toString("base64"), "base64"], executable: false, lamports: 2039280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", rentEpoch: 0, space: 165 } };
}

async function solanaCase(o: { delegate?: boolean } = {}) {
  const solana = await startFakeSolana({ websocket: true });
  solana.acceptTokenTransactions = true;
  cleanups.push(() => solana.close());
  tree.set({ "solana-devnet": [solana.url] });
  const home = homeDir("owner-finality-sol-");
  mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${SOL_OWNER}\n`, { mode: 0o600 });
  const pubFile = join(home, "budget", "public", "solana-devnet.env");
  writeFileSync(pubFile, `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`);
  writeFileSync(join(home, "owner.env"), `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(SOL_OWNER_KP.secretKey)}\n`, { mode: 0o600 });
  solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: o.delegate === false ? null : SOL_AGENT, delegated: o.delegate === false ? 0n : 50_000n });
  solana.balances.set(SOL_OWNER, 1_000_000_000n);
  // The client process does not spend the real minute `finalizedOf` waits for a signature that is only confirmed (see the helper).
  const NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${fileURLToPath(new URL("../helpers/skip-finality-wait.mjs", import.meta.url))}`].filter(Boolean).join(" ");
  const run = (args: string[]) => cli(args, { SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: solana.url, NODE_OPTIONS });
  const keyArgs = ["--owner-key-file", join(home, "owner.env"), "--yes"];
  return { solana, home, run, keyArgs, pub: () => readFileSync(pubFile, "utf8") };
}
const statusIs = (solana: FakeSolana, confirmationStatus: "confirmed" | "finalized") => { solana.confirmationStatus = confirmationStatus; };

describe("solana: confirmed is not finalized", () => {
  it("revoke whose signature is only confirmed for the whole wait: landed, final false (the recorded slot and signature kept)", async () => {
    const c = await solanaCase();
    statusIs(c.solana, "confirmed");
    const r = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "revoke", state: "landed", final: false, revoked: false });
    expect(c.pub()).toMatch(/^REVOKED_TX=\S+$/m);
    expect(c.pub()).toMatch(/^REVOKED_SLOT=\d+$/m);
    expect(c.pub()).toMatch(/^REVOKED_AT=\d+$/m);
    // the client polled through the minute it waits (every two seconds, skipped in time by the helper; polls that take real time
    // shorten it a little), not once or twice: a wait that ended early would show far fewer than 20
    expect(c.solana.calls.filter((m) => m === "getSignatureStatuses").length).toBeGreaterThanOrEqual(20);
  }, 150_000);

  it("revoke finalized: revoked, final true", async () => {
    const c = await solanaCase();
    statusIs(c.solana, "finalized");
    const r = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", final: true, revoked: true });
  }, 150_000);

  it("the record keys: a grant drops the revoke's, a revoke drops the grant's, and status names the grant (not final) after it", async () => {
    const c = await solanaCase();
    statusIs(c.solana, "finalized");
    const rv = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(rv.result.state, rv.stdout + rv.stderr).toBe("settled");
    expect(c.pub()).toMatch(/^REVOKED_TX=\S+$/m);
    expect(c.pub()).toMatch(/^REVOKED_SLOT=\d+$/m);
    expect(c.pub()).toMatch(/^REVOKED_AT=\d+$/m);
    statusIs(c.solana, "confirmed");
    // the revoke is finalized (a grant waits for that); the grant that follows is only confirmed
    const revokeSig = rv.result.tx.revoke;
    c.solana.overrides = { getSignatureStatuses: (p) => (p[0][0] === revokeSig ? { context: { slot: c.solana.slot }, value: [{ slot: c.solana.slot, confirmations: null, err: null, confirmationStatus: "finalized" }] } : undefined) };
    const g = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    c.solana.overrides = undefined;
    expect(g.result, g.stdout + g.stderr).toMatchObject({ state: "landed" });
    expect(c.pub()).not.toMatch(/^REVOKED_(AT|TX|SLOT)=/m);
    expect(c.pub()).toMatch(/^GRANT_TX=\S+$/m);
    expect(c.pub()).toMatch(/^GRANT_SLOT=\d+$/m);
    const s = await c.run(["status", "--rail", "solana"]);
    expect(s.result.lastOwnerAction).toMatchObject({ action: "grant", final: false });
    const rv2 = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(rv2.result.state, rv2.stdout + rv2.stderr).toBe("landed");
    expect(c.pub()).not.toMatch(/^GRANT_(TX|SLOT)=/m);
    expect(c.pub()).toMatch(new RegExp(`^REVOKED_TX=${rv2.result.tx.revoke}$`, "m"));
  }, 200_000);

  it("a grant then a revoke that is not finalized, then a regrant: refused, nothing sent; once the revoke is finalized it is allowed", async () => {
    const c = await solanaCase({ delegate: false });
    statusIs(c.solana, "confirmed");
    const g1 = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    expect(g1.result, g1.stdout + g1.stderr).toMatchObject({ state: "landed" });
    const rv = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(rv.result, rv.stdout + rv.stderr).toMatchObject({ state: "landed", final: false });
    const sends = () => c.solana.calls.filter((m) => m === "sendTransaction").length;
    const before = sends();
    const g2 = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    expect(g2.code, g2.stdout + g2.stderr).toBe(3);
    expect(g2.result).toMatchObject({ state: "refused_precheck" });
    expect(g2.result.reason).toMatch(/the previous revoke is not finalized yet/);
    expect(sends()).toBe(before);
    expect(c.pub()).toMatch(/^REVOKED_TX=\S+$/m); // the record is kept
    statusIs(c.solana, "finalized");
    const g3 = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    expect(g3.code, g3.stdout + g3.stderr).toBe(0);
    expect(sends()).toBe(before + 1);
  }, 250_000);

  it("a grant then a revoke that is not finalized, then setup --grant: refused, no request to the site, nothing sent", async () => {
    const c = await solanaCase({ delegate: false });
    const site = await startFakeSite();
    cleanups.push(() => site.close());
    statusIs(c.solana, "confirmed");
    const g1 = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    expect(g1.result, g1.stdout + g1.stderr).toMatchObject({ state: "landed" });
    const rv = await c.run(["revoke", "--rail", "solana", ...c.keyArgs]);
    expect(rv.result, rv.stdout + rv.stderr).toMatchObject({ state: "landed", final: false });
    const sends = () => c.solana.calls.filter((m) => m === "sendTransaction").length;
    const before = sends();
    const r = await c.run(["setup", "--rail", "solana", "--hosted", "--site", site.url, "--grant", "0.05"]);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/the previous revoke is not finalized yet/);
    expect(site.posts).toEqual([]);
    expect(sends()).toBe(before);
  }, 250_000);

  it("rotate --clear-agent drops the agent's grant and revoke records (solana)", async () => {
    const c = await solanaCase();
    const keys = ["REVOKED_AT=1", "REVOKED_TX=sigR", "REVOKED_SLOT=5", "GRANT_TX=sigG", "GRANT_SLOT=4", "LINK_ID=x", "LINK_CODE=y"];
    writeFileSync(join(c.home, "budget", "public", "solana-devnet.env"), `${c.pub()}${keys.join("\n")}\n`);
    const r = await script([resolve(tree.root, "budget/solana/rotate.mjs"), "--clear-agent", SOL_AGENT], { SUPERSTABLES_HOME: c.home });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(c.pub()).not.toMatch(/^(SOLANA_AGENT_ADDRESS|REVOKED_AT|REVOKED_TX|REVOKED_SLOT|GRANT_TX|GRANT_SLOT|LINK_ID|LINK_CODE)=/m);
    expect(c.pub()).toMatch(new RegExp(`^SOLANA_OWNER_ADDRESS=${SOL_OWNER}$`, "m"));
  }, 100_000);

  it("a grant while the finalized view still has the old delegate: refused, the previous revoke is not finalized yet", async () => {
    const c = await solanaCase({ delegate: false });
    const ata = ataOf(SOL_OWNER).toBase58();
    c.solana.overrides = { getAccountInfo: (p) => (p[0] === ata && (p[1] as any)?.commitment === "finalized" ? accountWithDelegate(c.solana.slot, SOL_AGENT, 50_000n) : undefined) };
    const r = await c.run(["grant", "--rail", "solana", "--amount", "0.05", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toMatch(/the previous revoke is not finalized yet/);
    expect(c.solana.calls).not.toContain("sendTransaction");
  }, 150_000);
});

// ---- tempo ------------------------------------------------------------------------------------------------------------

describe("tempo: a receipt whose block is not the chain's is not accepted", () => {
  it("a revoke whose receipt names another block hash than the block at that number: a problem, not revoked", async () => {
    const OWNER = evmOwner("22");
    const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
    const TEMPO_AGENT = privateKeyToAddress(TEMPO_KEY);
    const tempo: FakeTempo = await startFakeTempo();
    const site: FakeSite = await startFakeSite();
    cleanups.push(() => tempo.close(), () => site.close());
    tree.set({ "tempo-moderato": [tempo.url] });
    const home = homeDir("owner-finality-tempo-");
    mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${OWNER}\n`, { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${TEMPO_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`);
    site.owner = OWNER;
    tempo.keys.set(`${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1000000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
    site.onPoll = (r: FakeRequest) => {
      if (r.polls !== 2 || r.kind === "link") return;
      Object.assign(r, { state: "confirmed", tx_hash: tempo.mine(r.owner!, r.body.transaction.data), wallet_asked: true });
    };
    // the block at the receipt's number is another block than the one the receipt names
    tempo.overrides = { eth_getBlockByNumber: (p) => (p[0] !== "latest" ? { number: p[0], hash: `0x${"cd".repeat(32)}`, timestamp: "0x1", transactions: [] } : undefined) };
    const r = await cli(["revoke", "--rail", "tempo", "--wait", "--no-open"], { SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url });
    expect(r.result?.state, r.stdout + r.stderr).not.toBe("settled");
    expect(r.result.revoked).not.toBe(true);
    expect(r.result.reason).toMatch(/it is not in a committed block on chain/);
  }, 150_000);
});

describe("tempo: a revoked key reads as revoked even though getRemainingLimit reverts for it", () => {
  async function tempoCase(opts: { mirror?: boolean } = {}) {
    const OWNER = evmOwner("22");
    const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
    const TEMPO_AGENT = privateKeyToAddress(TEMPO_KEY);
    const tempo: FakeTempo = await startFakeTempo();
    const site: FakeSite = await startFakeSite();
    cleanups.push(() => tempo.close(), () => site.close());
    const urls = [tempo.url];
    let mirror: FakeTempo | null = null;
    if (opts.mirror) { mirror = await tempo.mirror(); cleanups.push(() => mirror!.close()); urls.push(mirror.url); }
    tree.set({ "tempo-moderato": urls });
    const home = homeDir("owner-finality-tempo-");
    mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${OWNER}\n`, { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${TEMPO_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`);
    site.owner = OWNER;
    tempo.keys.set(`${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1000000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
    site.onPoll = (r: FakeRequest) => {
      if (r.polls !== 2 || r.kind === "link") return;
      Object.assign(r, { state: "confirmed", tx_hash: tempo.mine(r.owner!, r.body.transaction.data), wallet_asked: true });
    };
    const run = (args: string[]) => cli(args, { SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url });
    return { tempo, mirror, run };
  }

  it("revoke: settled, revoked true, and status then says revoked", async () => {
    const c = await tempoCase({ mirror: true });
    const r = await c.run(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "settled", revoked: true });
    expect(r.code).toBe(0);
    const s = await c.run(["status", "--rail", "tempo"]);
    expect(s.result, s.stdout + s.stderr).toMatchObject({ state: "ok", revoked: true });
    expect(s.result.next).not.toMatch(/count it as live/);
  }, 150_000);

  it("the agreed read uses getRemainingLimitWithPeriod: a chain whose getRemainingLimit always reverts still settles the revoke", async () => {
    const c = await tempoCase({ mirror: true });
    const reverts = { eth_call: (p: any[]) => {
      let call;
      try { call = decodeFunctionData({ abi: Abis.accountKeychain, data: p[0].data }); } catch { return undefined; }
      if (call.functionName === "getRemainingLimit") throw Object.assign(new Error("execution reverted"), { rpc: { code: 3, message: "execution reverted", data: "0x" } });
      return undefined;
    } };
    c.mirror!.overrides = reverts;
    c.tempo.overrides = reverts;
    const r = await c.run(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "settled", revoked: true });
    const s = await c.run(["status", "--rail", "tempo"]);
    expect(s.result, s.stdout + s.stderr).toMatchObject({ state: "ok", revoked: true });
  }, 150_000);

  it("a revoked key whose confirming endpoints cannot be read stays unknown, never revoked", async () => {
    const c = await tempoCase({ mirror: true });
    const r = await c.run(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(r.result, r.stdout + r.stderr).toMatchObject({ state: "settled", revoked: true });
    const down = () => { throw new Error("fake tempo: endpoint down"); };
    // every confirming endpoint is unreachable at the agreed block: the key reads revoked on the primary alone
    const reads = { eth_call: (p: any[]) => (p[1] && typeof p[1] === "object" ? down() : undefined) };
    c.mirror!.overrides = reads;
    c.tempo.overrides = reads;
    const s = await c.run(["status", "--rail", "tempo"]);
    expect(s.result.revoked).not.toBe(true);
    expect(s.result.next).toMatch(/count it as live/);
  }, 150_000);
});

// ---- the dispatcher ---------------------------------------------------------------------------------------------------

describe("the dispatcher maps a rail's landed", () => {
  it("fund-agent on evm with the final head behind: landed, exit 0, never failed", async () => {
    const c = await evmCase({ lag: 5 });
    const r = await c.run(["fund-agent", "--rail", "evm", ...c.keyArgs]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "fund-agent", state: "landed", final: false });
    expect(r.result.tx.fundAgent).toMatch(/^0x/);
  }, 150_000);
});
