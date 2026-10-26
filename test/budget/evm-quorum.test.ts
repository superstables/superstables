// Budget EVM verdicts need agreement, and every RPC read checks its chain. The first half runs the real `budget` CLI against
// in-memory chains (test/helpers/fake-evm.ts) on this computer; the second half runs reconcile and the authorization checks
// in-process against two chains over one state (two operators), one of which lies. Loopback only.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, pad, toHex, type Hex } from "viem";
import { ARC_USDC, AGENT, OWNER, makeChain, makeHome, startSeller, usdc, type FakeEvm, type FakeMirror } from "../helpers/fake-evm.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const scratch = join(homedir(), ".cache", "superstables-tests");
mkdirSync(scratch, { recursive: true });

const cleanups: (() => unknown)[] = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

type Run = { code: number | null; stdout: string; stderr: string; result: any };
/** The dispatcher, or one rail script of the same tree (`script`, run with tsx). */
function run(tree: string, argv: string[], env: Record<string, string>, script?: string): Promise<Run> {
  return new Promise((done) => {
    const [cmd, args] = script ? [join(tree, "node_modules/.bin/tsx"), [join(tree, script), ...argv]] : [process.execPath, [join(tree, "budget/cli.mjs"), ...argv]];
    const child = spawn(cmd, args, { cwd: tree, env: { ...process.env, B4_CHAIN: "", ...env } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch {}
      done({ code, stdout, stderr, result });
    });
  });
}

/** A journal that `reconcile` reads: an operation whose pull was signed and never seen. */
const journalText = (op: string, extra: object = {}) => JSON.stringify({
  op, rail: "base-sepolia", path: "approve", state: "unknown", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  url: "https://seller.example/x", owner: OWNER.address, agent: AGENT.address, token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", max: "1",
  pullTx: `0x${"11".repeat(32)}`, pullNonce: 0, notes: [], ...extra,
}, null, 2);
function writeJournal(opsDir: string, op: string, extra: object = {}) {
  mkdirSync(opsDir, { recursive: true, mode: 0o700 });
  const file = join(opsDir, `${op}.json`);
  writeFileSync(file, journalText(op, extra), { mode: 0o600 });
  return file;
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("a budget RPC on another chain is refused, with nothing read from it (the real CLI)", () => {
  it("reconcile: the RPC answers chain id 1, so it exits 3 and the journal is untouched", async () => {
    const wrong = await makeChain({ chainId: 1 });
    const h = makeHome();
    cleanups.push(() => wrong.close(), h.cleanup);
    const file = writeJournal(h.opsDir, "b4-demo");
    const before = sha(file);
    const r = await run(ROOT, ["reconcile", "--rail", "evm", "--op", "b4-demo"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stderr + r.stdout).toMatch(/REFUSED: the RPC 127\.0\.0\.1:\d+ answers chain id 1, not 84532 \(Base Sepolia\)\. Nothing was read from another chain\./);
    expect(sha(file)).toBe(before);
    expect(wrong.rpcLog.map((m) => m.method).filter((m) => m !== "eth_chainId")).toEqual([]);
  }, 120_000);

  it("read: the same RPC is refused (state refused_precheck), where it used to print chain 1's numbers", async () => {
    const wrong = await makeChain({ chainId: 1 });
    const h = makeHome();
    cleanups.push(() => wrong.close(), h.cleanup);
    const r = await run(ROOT, [], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toContain("answers chain id 1, not 84532");
    expect(r.result.reason).toContain("Nothing was read from another chain");
  }, 120_000);

  it("status through the dispatcher does not call a refused read a budget that reads empty", async () => {
    const wrong = await makeChain({ chainId: 1 });
    const h = makeHome();
    cleanups.push(() => wrong.close(), h.cleanup);
    const r = await run(ROOT, ["status", "--rail", "evm"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.result).toMatchObject({ ok: false, state: "failed", reason: "setup is done, but the budget could not be read from the chain" });
    expect(r.stdout + r.stderr).toContain("Nothing was read from another chain");
  }, 120_000);

  it("B4_RPC set for Base Sepolia does not serve --chain arc-testnet: the chain id check refuses it", async () => {
    const base = await makeChain();
    const h = makeHome("arc-testnet", "Arc Testnet");
    cleanups.push(() => base.close(), h.cleanup);
    const r = await run(ROOT, ["--chain", "arc-testnet"], { SUPERSTABLES_HOME: h.home, B4_RPC: base.url }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(r.result.reason).toContain("answers chain id 84532, not 5042002");
  }, 120_000);

  it("B4_RPC_ARC_TESTNET is read for --chain arc-testnet", async () => {
    const arc = await makeChain({ chainId: 5042002, usdc: ARC_USDC, gasIsToken: true });
    const h = makeHome("arc-testnet", "Arc Testnet");
    cleanups.push(() => arc.close(), h.cleanup);
    const r = await run(ROOT, ["--chain", "arc-testnet"], { SUPERSTABLES_HOME: h.home, B4_RPC_ARC_TESTNET: arc.url }, "budget/evm/read.ts");
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, state: "ok", chain: "arc-testnet" });
    expect(arc.rpcLog.length).toBeGreaterThan(0);
  }, 120_000);

  it("a chain's own variable wins over B4_RPC, and a refused value of either stops the command (exit 2)", async () => {
    const arc = await makeChain({ chainId: 5042002, usdc: ARC_USDC, gasIsToken: true });
    const wrong = await makeChain({ chainId: 1 });
    const h = makeHome("arc-testnet", "Arc Testnet");
    cleanups.push(() => arc.close(), () => wrong.close(), h.cleanup);
    const ok = await run(ROOT, ["--chain", "arc-testnet"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url, B4_RPC_ARC_TESTNET: arc.url }, "budget/evm/read.ts");
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(wrong.rpcLog).toEqual([]);
    const bad = await run(ROOT, ["--chain", "arc-testnet"], { SUPERSTABLES_HOME: h.home, B4_RPC_ARC_TESTNET: "http://example.com/rpc" }, "budget/evm/read.ts");
    expect(bad.code, bad.stdout + bad.stderr).toBe(2);
    expect(bad.stdout + bad.stderr).toContain("B4_RPC_ARC_TESTNET is refused");
  }, 120_000);

  it("buy: a wrong chain is refused before the seller is called and before any journal exists (exit 3, not unknown)", async () => {
    const wrong = await makeChain({ chainId: 1, allow: "1" });
    const seller = await startSeller(wrong, 84532);
    const h = makeHome();
    cleanups.push(() => seller.close(), () => wrong.close(), h.cleanup);
    const r = await run(ROOT, ["buy", "--rail", "evm", "--url", seller.url, "--max", "0.05", "--op", "b4-wrongchain"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(wrong.sentRaw).toEqual([]);
    expect(existsSync(h.opsDir) ? readdirSync(h.opsDir) : []).toEqual([]);
  }, 120_000);
});

describe("every command that reads checks the chain id first, strictly (the real CLI)", () => {
  const asked = (c: FakeEvm) => c.rpcLog.map((m) => m.method).filter((m) => m !== "eth_chainId");

  for (const shown of ["zz", "0x", "0xzz", "84532", ""]) {
    it(`read: an RPC whose chain id answer is ${JSON.stringify(shown)} is refused, not trusted (exit 3, nothing else asked)`, async () => {
      const odd = await makeChain();
      odd.hook = (method) => (method === "eth_chainId" ? { result: shown } : undefined);
      const h = makeHome();
      cleanups.push(() => odd.close(), h.cleanup);
      const r = await run(ROOT, [], { SUPERSTABLES_HOME: h.home, B4_RPC: odd.url }, "budget/evm/read.ts");
      expect(r.code, r.stdout + r.stderr).toBe(3);
      expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
      expect(r.result.reason).toMatch(/answers (an unreadable chain id|chain id)/);
      expect(asked(odd)).toEqual([]);
    }, 120_000);
  }

  it("buy: the wrong chain is refused before the first balance read", async () => {
    const wrong = await makeChain({ chainId: 1, allow: "1" });
    const seller = await startSeller(wrong, 84532);
    const h = makeHome();
    cleanups.push(() => seller.close(), () => wrong.close(), h.cleanup);
    const r = await run(ROOT, ["buy", "--rail", "evm", "--url", seller.url, "--max", "0.05", "--op", "b4-wrongchain2"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(asked(wrong)).toEqual([]);
    expect(r.stdout).not.toMatch(/^before:/m);
  }, 120_000);

  it("recover --plan: the wrong chain prints no plan from it (exit 3, nothing but the chain id asked)", async () => {
    const wrong = await makeChain({ chainId: 1, allow: "1" });
    const h = makeHome();
    cleanups.push(() => wrong.close(), h.cleanup);
    const r = await run(ROOT, ["--plan"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url }, "budget/evm/recover.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain("PLAN");
    expect(asked(wrong)).toEqual([]);
  }, 120_000);

  it("setup --new-owner: the wrong chain is refused before the recorded owner's allowance is read", async () => {
    const wrong = await makeChain({ chainId: 1, allow: "1" });
    const h = makeHome();
    cleanups.push(() => wrong.close(), h.cleanup);
    const r = await run(ROOT, ["--new-owner"], { SUPERSTABLES_HOME: h.home, B4_RPC: wrong.url }, "budget/evm/setup.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout + r.stderr).toContain("answers chain id 1, not 84532");
    expect(asked(wrong)).toEqual([]);
  }, 120_000);

  it("doctor reads the chain's own variable like the commands do (B4_RPC_BASE_SEPOLIA wins over B4_RPC)", async () => {
    const chain = await makeChain();
    const h = makeHome();
    cleanups.push(() => chain.close(), h.cleanup);
    const r = await run(ROOT, ["doctor", "--rail", "evm"], { SUPERSTABLES_HOME: h.home, B4_RPC_BASE_SEPOLIA: chain.url, B4_RPC: "http://127.0.0.1:1" });
    expect(r.stderr + r.stdout).toContain("RPC answers: chain id 84532");
    expect(chain.rpcLog.map((m) => m.method)).toContain("eth_chainId");
  }, 120_000);
});

describe("status: an allowance of 0 is a revoke only when the endpoints agree (a copy of the client with two endpoints)", () => {
  const tree = mkdtempSync(join(scratch, "evm-quorum-tree-"));
  for (const dir of ["budget", "src"]) cpSync(join(ROOT, dir), join(tree, dir), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(tree, file));
  symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
  cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
  const table = join(tree, "src/core/rpc-endpoints.mjs");
  const original = readFileSync(table, "utf8");
  /** The copy's Base Sepolia endpoints become these two, run by two operators. */
  function useEndpoints(a: string, b: string) {
    const from = /"base-sepolia": \[[^\]]*\],/s;
    expect(from.test(original)).toBe(true);
    writeFileSync(table, original.replace(from, `"base-sepolia": [{ url: "${a}", operator: "op-a" }, { url: "${b}", operator: "op-b" }],`));
  }
  const allowanceCall = (m: string, p: any[]) => m === "eth_call" && String(p[0]?.data).startsWith("0xdd62ed3e");
  const word = (n: bigint) => pad(toHex(n), { size: 32 });

  async function status(second: (c: FakeEvm, m: FakeMirror) => void) {
    const chain = await makeChain({ allow: "1" });
    chain.setAllowance(OWNER.address, AGENT.address, 0n);
    const m = await chain.mirror();
    second(chain, m);
    const h = makeHome();
    appendFileSync(join(h.home, "budget", "public", "evm-base-sepolia.env"), `B4_REVOKED_AT=${Math.floor(Date.now() / 1000) - 3600}\n`);
    cleanups.push(() => m.close(), () => chain.close(), h.cleanup);
    useEndpoints(chain.url, m.url);
    return run(tree, [], { SUPERSTABLES_HOME: h.home, B4_RPC: chain.url }, "budget/evm/read.ts");
  }

  it("the second endpoint says 50 USDC: not revoked, and the words say the endpoints disagree", async () => {
    const r = await status((_c, m) => { m.hook = (method, params) => (allowanceCall(method, params) ? { result: word(usdc("50")) } : undefined); });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", allowanceZero: true, revoked: false, agreement: "the RPC endpoints disagree" });
    expect(r.stdout).toContain("revoked: no: the allowance reads 0 on this RPC, but the RPC endpoints disagree");
  }, 120_000);

  it("both read 0: revoked, agreed by a quorum", async () => {
    const r = await status(() => {});
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", allowanceZero: true, revoked: true, agreement: "quorum" });
  }, 120_000);

  it("a non-zero allowance asks nobody else (agreement null)", async () => {
    const chain = await makeChain({ allow: "1" });
    const m = await chain.mirror();
    const h = makeHome();
    cleanups.push(() => m.close(), () => chain.close(), h.cleanup);
    useEndpoints(chain.url, m.url);
    const r = await run(tree, [], { SUPERSTABLES_HOME: h.home, B4_RPC: chain.url }, "budget/evm/read.ts");
    expect(r.result).toMatchObject({ allowanceZero: false, revoked: false, agreement: null });
    expect(m.rpcLog).toEqual([]);
  }, 120_000);
});

// ---- in-process: reconcile and the authorization checks against two endpoints ----

const NONCE: Hex = `0x${"ab".repeat(32)}`;
const T_CANCELED = keccak256(toBytes("AuthorizationCanceled(address,bytes32)"));
const T_TRANSFER = keccak256(toBytes("Transfer(address,address,uint256)"));
const R_TX: Hex = `0x${"22".repeat(32)}`;
const PULL: Hex = `0x${"11".repeat(32)}`;
const CANCEL_TX: Hex = `0x${"33".repeat(32)}`;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

describe("verdicts against two endpoints, one of which lies (in-process)", () => {
  let chain: FakeEvm, mirror: FakeMirror, home: ReturnType<typeof makeHome>;
  let set: any;
  const ep = (url: string, operator: string) => ({ url, operator, source: "builtin", id: operator });
  const saved = { ...process.env };

  beforeEach(async () => {
    chain = await makeChain({ allow: "1" });
    mirror = await chain.mirror();
    chain.mineEmpty(); chain.mineEmpty(); chain.mineEmpty();
    home = makeHome();
    set = { primary: ep(chain.url, "op-a"), verdict: [ep(chain.url, "op-a"), ep(mirror.url, "op-b")], quorum: 2, agreement: "quorum" };
    process.env.SUPERSTABLES_HOME = home.home;
    process.env.B4_RPC = chain.url;
    delete process.env.B4_CHAIN;
    vi.resetModules();
    vi.doMock("../../src/core/rpc-endpoints.mjs", async (original) => ({ ...(await original<object>()), endpointSet: () => set }));
  });
  afterEach(async () => {
    vi.doUnmock("../../src/core/rpc-endpoints.mjs");
    process.env = { ...saved };
    await mirror.close();
    await chain.close();
    home.cleanup();
  });
  const ops = () => import(new URL("../../budget/evm/ops.ts", import.meta.url).href);

  const block = () => chain.blocks[chain.blocks.length - 2];
  const journal = (extra: object = {}) => ({ ...JSON.parse(journalText("b4-t")), pullBlock: String(chain.blocks[0].number), ...extra });
  const receiptOf = (hash: Hex, status: "0x0" | "0x1", logs: object[] = []) => ({
    transactionHash: hash, transactionIndex: "0x0", blockHash: block().hash, blockNumber: hex(block().number), from: AGENT.address, to: chain.usdcAddress,
    cumulativeGasUsed: "0xea60", gasUsed: "0xea60", effectiveGasPrice: "0x3b9aca00", contractAddress: null, logs, logsBloom: `0x${"00".repeat(256)}`, status, type: "0x2",
  });
  const txOf = (hash: Hex) => ({
    hash, from: AGENT.address, to: chain.usdcAddress, input: "0x", nonce: "0x0", blockHash: block().hash, blockNumber: hex(block().number), transactionIndex: "0x0",
    value: "0x0", gas: "0x30d40", gasPrice: "0x3b9aca00", type: "0x2",
  });
  /** A transaction that took the pull's nonce, as one endpoint would show it. */
  const invented = (): NonNullable<FakeEvm["hook"]> => (method, params) => {
    if (method === "eth_getLogs") return { result: [{ address: chain.usdcAddress, topics: [T_TRANSFER, pad(AGENT.address.toLowerCase() as Hex, { size: 32 }), pad("0x00000000000000000000000000000000000a11ce", { size: 32 })], data: pad(toHex(1n), { size: 32 }), blockNumber: hex(block().number), blockHash: block().hash, transactionHash: R_TX, logIndex: "0x0", transactionIndex: "0x0", removed: false }] };
    if (method === "eth_getTransactionByHash" && String(params[0]).toLowerCase() === R_TX) return { result: txOf(R_TX) };
    if (method === "eth_getTransactionReceipt" && String(params[0]).toLowerCase() === R_TX) return { result: receiptOf(R_TX, "0x1") };
    return undefined;
  };

  const agreementPaths = ["allowanceAgreed", "authorizationStateAgreed", "receiptAgreed", "txAgreed"] as const;
  it.each(agreementPaths)("%s: accepts Base's 1,822-block finality batch but never proves a later block final", async (path) => {
    const low = 50210845n;
    const high = low + 1822n;
    const header = (n: bigint) => ({ number: hex(n), hash: pad(toHex(n)), timestamp: hex(1792964037n + (n - low) / 5n) });
    const blockReply = (head: bigint): NonNullable<FakeEvm["hook"]> => (m, p) => m === "eth_getBlockByNumber"
      ? { result: header(p[0] === "finalized" ? head : BigInt(p[0])) }
      : m === "eth_call" ? { result: pad("0x0") } : undefined;
    chain.hook = blockReply(low);
    mirror.hook = blockReply(high);
    const lib = await import("../../budget/evm/lib.js");
    const invoke = (atLeast?: bigint) => {
      switch (path) {
        case "allowanceAgreed": return lib.allowanceAgreed(OWNER.address, AGENT.address, atLeast);
        case "authorizationStateAgreed": return lib.authorizationStateAgreed(OWNER.address, NONCE, atLeast);
        case "receiptAgreed": return lib.receiptAgreed(PULL, atLeast);
        case "txAgreed": return lib.txAgreed(PULL, atLeast);
      }
    };
    expect(await invoke()).toMatchObject({ agreed: true, block: { number: low, highest: high } });
    expect(await invoke(low + 1n)).toMatchObject({ agreed: false, why: "not_final_yet" });
    // A contradictory endpoint cannot be outvoted or replaced by a common historical answer.
    mirror.hook = (m, p) => {
      if (m === "eth_call") return { result: pad("0x1") };
      if (m === "eth_getTransactionReceipt") return { result: { ...receiptOf(PULL, "0x0"), blockNumber: hex(high), blockHash: pad(toHex(high)) } };
      if (m === "eth_getTransactionByHash") return { result: { ...txOf(PULL), blockNumber: hex(high), blockHash: pad(toHex(high)) } };
      return blockReply(high)(m, p);
    };
    expect(await invoke()).toMatchObject({ agreed: false, why: "disagree" });
    expect(await lib.finalityOf(PULL, { blockNumber: high, blockHash: pad(toHex(high)) })).toMatchObject({ final: false });
  });

  it.each(agreementPaths.flatMap((path) => [undefined, 50210844n, 50210845n].map((atLeast) => ({ path, atLeast }))))("$path: own-head-only drift never agrees a stale value with atLeast $atLeast", async ({ path, atLeast }) => {
    const low = 50210845n, high = low + 1822n;
    const header = (n: bigint) => ({ number: hex(n), hash: pad(toHex(n)), timestamp: hex(1792964037n) });
    const hooks = (head: bigint): NonNullable<FakeEvm["hook"]> => {
      let receiptReads = 0, txReads = 0;
      return (method, params) => {
        if (method === "eth_getBlockByNumber") {
          return { result: header(params[0] === "finalized" ? head : BigInt(params[0])) };
        }
        if (method === "eth_call") {
          const at = BigInt(params[1].blockHash);
          return { result: pad(toHex(path === "allowanceAgreed" ? (at <= low ? 5 : 2) : (at <= low ? 0 : 1))) };
        }
        if (method === "eth_getTransactionReceipt") return { result: (++receiptReads === 1 || head === low) ? null : { ...receiptOf(PULL, "0x0"), blockNumber: hex(high), blockHash: pad(toHex(high)) } };
        if (method === "eth_getTransactionByHash") return { result: (++txReads === 1 || head === low) ? null : { ...txOf(PULL), blockNumber: hex(high), blockHash: pad(toHex(high)) } };
        return undefined;
      };
    };
    chain.hook = hooks(low);
    mirror.hook = hooks(high);
    const lib = await import("../../budget/evm/lib.js");
    const got = await (path === "allowanceAgreed" ? lib.allowanceAgreed(OWNER.address, AGENT.address, atLeast)
      : path === "authorizationStateAgreed" ? lib.authorizationStateAgreed(OWNER.address, NONCE, atLeast)
      : path === "receiptAgreed" ? lib.receiptAgreed(PULL, atLeast) : lib.txAgreed(PULL, atLeast));
    expect(got).toMatchObject({ agreed: false, why: "not_final_yet" });
  });

  it("a replacement transaction that only the primary shows leaves the purchase unknown, not not_found", async () => {
    chain.hook = invented();
    const { reconcileJournal } = await ops();
    const { j, verdict } = await reconcileJournal(journal(), { quiet: true });
    expect(verdict).toBe("unknown");
    expect(j.state).toBe("unknown");
    expect(j.reason).toContain("a different transaction used the pull's nonce on one RPC, but the RPC endpoints disagree");
    expect(j.next).toContain("Do not pay again");
  }, 60_000);

  it("the same replacement shown by both endpoints is not_found", async () => {
    chain.hook = invented();
    mirror.hook = invented();
    const { reconcileJournal } = await ops();
    const { j, verdict } = await reconcileJournal(journal(), { quiet: true });
    expect(verdict).toBe("not_found");
    expect(j.reason).toContain(`a different final transaction ${R_TX} consumed the pull nonce 0`);
  }, 60_000);

  it("a replacement that is not the agent's transaction at the pull's nonce is not accepted, even when both show it", async () => {
    const wrongNonce: NonNullable<FakeEvm["hook"]> = (m, p) => {
      const r = invented()(m, p);
      return m === "eth_getTransactionByHash" && r ? { result: { ...(r.result as object), nonce: "0x5" } } : r;
    };
    chain.hook = wrongNonce;
    mirror.hook = wrongNonce;
    const { reconcileJournal } = await ops();
    const { verdict } = await reconcileJournal(journal(), { quiet: true });
    expect(verdict).toBe("unknown");
  }, 60_000);

  const revertedPull: NonNullable<FakeEvm["hook"]> = (method, params) => (method === "eth_getTransactionReceipt" && String(params[0]).toLowerCase() === PULL ? { result: receiptOf(PULL, "0x0") } : undefined);

  it("a pull that only the primary shows as reverted is unknown, not failed", async () => {
    chain.hook = revertedPull;
    const { reconcileJournal } = await ops();
    const { j, verdict } = await reconcileJournal(journal(), { quiet: true });
    expect(verdict).toBe("unknown");
    expect(j.reason).toContain("the pull reads as reverted on one RPC, but the RPC endpoints disagree");
    expect(j.pulled).toBeUndefined();
  }, 60_000);

  it("a pull that both endpoints show as reverted is failed", async () => {
    chain.hook = revertedPull;
    mirror.hook = revertedPull;
    const { reconcileJournal } = await ops();
    const { j, verdict } = await reconcileJournal(journal(), { quiet: true });
    expect(verdict).toBe("failed");
    expect(j.pulled).toBe("0");
  }, 60_000);

  const auth = (validBefore: number) => ({ from: AGENT.address, to: "0x00000000000000000000000000000000000a11ce", value: "10000", nonce: NONCE, validBefore, validAfter: 0 });
  const stateCall = (m: string, p: any[]) => m === "eth_call" && String(p[0]?.data).startsWith("0xe94a0102");
  const word = (b: boolean) => pad(toHex(b ? 1n : 0n), { size: 32 });
  const usedKey = `${AGENT.address.toLowerCase()}:${NONCE.toLowerCase()}`;

  it("an expired authorization is dead when both endpoints read it unused at a block past validBefore", async () => {
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) - 3600) }), { kind: "unused", used: false, canceled: false })).toBe(true);
  }, 60_000);

  it("an authorization one endpoint reads as unused and the other as used is not dead", async () => {
    chain.st.used.set(usedKey, "used"); // the shared state: used. The primary says otherwise.
    chain.hook = (m, p) => (stateCall(m, p) ? { result: word(false) } : undefined);
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) - 3600) }), { kind: "unused", used: false, canceled: false })).toBe(false);
  }, 60_000);

  it("an authorization that is not yet expired at the agreed block is not dead", async () => {
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) + 3600) }), { kind: "unused", used: false, canceled: false })).toBe(false);
  }, 60_000);

  const cancelReceipt = () => receiptOf(CANCEL_TX, "0x1", [{ address: chain.usdcAddress, topics: [T_CANCELED, pad(AGENT.address.toLowerCase() as Hex, { size: 32 }), NONCE], data: "0x" }]);
  const cancelOnly: NonNullable<FakeEvm["hook"]> = (m, p) => (m === "eth_getTransactionReceipt" && String(p[0]).toLowerCase() === CANCEL_TX ? { result: cancelReceipt() } : undefined);
  const canceled = { kind: "canceled", used: false, canceled: true, final: true } as const;

  it("a cancellation that only the primary shows is not a dead authorization", async () => {
    chain.st.used.set(usedKey, "canceled");
    chain.hook = cancelOnly;
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) + 3600), cancelTx: CANCEL_TX }), canceled)).toBe(false);
  }, 60_000);

  it("a cancellation both endpoints show, with the nonce used there, is dead", async () => {
    chain.st.used.set(usedKey, "canceled");
    chain.hook = cancelOnly;
    mirror.hook = cancelOnly;
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) + 3600), cancelTx: CANCEL_TX }), canceled)).toBe(true);
  }, 60_000);

  it("a cancel receipt that cancels another nonce is not a dead authorization, even when both endpoints show it", async () => {
    chain.st.used.set(usedKey, "canceled");
    const other: NonNullable<FakeEvm["hook"]> = (m, p) => {
      const r = cancelOnly(m, p);
      return r ? { result: { ...(r.result as any), logs: [{ ...(cancelReceipt().logs[0] as any), topics: [T_CANCELED, pad(AGENT.address.toLowerCase() as Hex, { size: 32 }), `0x${"cd".repeat(32)}`] }] } } : r;
    };
    chain.hook = other;
    mirror.hook = other;
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) + 3600), cancelTx: CANCEL_TX }), canceled)).toBe(false);
  }, 60_000);

  // The usual shape of a harness or an own-node user: B4_RPC names a URL that is not built in, so the primary is outside the set that
  // decides ([mirror, second], both honest). Only the primary lies, and nothing it says may move a verdict.
  describe("the primary lies and is not one of the agreeing endpoints", () => {
    beforeEach(async () => {
      const second = await chain.mirror();
      set = { primary: ep(chain.url, "own-node"), verdict: [ep(mirror.url, "op-b"), ep(second.url, "op-c")], quorum: 2, agreement: "quorum" };
    });

    it("a pull that only the primary shows as reverted stays unknown (an agreed 'no receipt' is not an agreed revert)", async () => {
      chain.hook = revertedPull;
      const { reconcileJournal } = await ops();
      const { j, verdict } = await reconcileJournal(journal(), { quiet: true });
      expect(verdict).toBe("unknown");
      expect(j.pulled).toBeUndefined();
    }, 60_000);

    it("a replacement that only the primary shows stays unknown, not not_found", async () => {
      chain.hook = invented();
      const { reconcileJournal } = await ops();
      const { verdict } = await reconcileJournal(journal(), { quiet: true });
      expect(verdict).toBe("unknown");
    }, 60_000);

    it("an authorization that only the primary reads as unused is not dead", async () => {
      chain.st.used.set(usedKey, "used");
      chain.hook = (m, p) => (stateCall(m, p) ? { result: word(false) } : undefined);
      const { authDead } = await ops();
      expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) - 3600) }), { kind: "unused", used: false, canceled: false })).toBe(false);
    }, 60_000);

    it("a cancellation that only the primary shows is not a dead authorization", async () => {
      chain.st.used.set(usedKey, "canceled");
      chain.hook = cancelOnly;
      const { authDead } = await ops();
      expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) + 3600), cancelTx: CANCEL_TX }), canceled)).toBe(false);
    }, 60_000);
  });

  it("a set that cannot be built (an unreadable owner settings file) is never a dead authorization", async () => {
    set = { error: "the owner settings could not be read: broken" };
    const { authDead } = await ops();
    expect(await authDead(journal({ auth: auth(Math.floor(Date.now() / 1000) - 3600) }), { kind: "unused", used: false, canceled: false })).toBe(false);
  }, 60_000);

  it("the scan of purchase records applies the field checks of reading one record", async () => {
    const dir = join(home.home, "budget", "ops", "evm-base-sepolia");
    writeJournal(dir, "b4-good");
    // the lightweight shape the scan used to accept: no owner, creation time or notes
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "b4-thin.json"), JSON.stringify({ path: "approve", op: "b4-thin", agent: AGENT.address, state: "unknown" }), { mode: 0o600 });
    const { scanJournals, sweepBlockers } = await ops();
    const scan = scanJournals();
    expect(scan.journals.map((j: any) => j.op)).toEqual(["b4-good"]);
    expect(scan.unreadable).toEqual([{ file: "b4-thin.json", why: "its owner or agent is not an address" }]);
    const blockers = await sweepBlockers(AGENT.address);
    expect(blockers.unreadable.map((u: any) => u.file)).toEqual(["b4-thin.json"]);
  }, 60_000);
});
