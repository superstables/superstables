// EVM recovery acts only on what is final, and never on a journal folder it could not read in full (budget/evm/ops.ts makeSafe,
// scanJournals, sweepBlockers; budget/evm/recover.ts). Harness A runs ops.ts against a mocked chain client; harness B runs
// recover.ts with its chain reads and the two owner steps replaced. Nothing here leaves the process.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWalletClient, decodeFunctionData, encodeEventTopics, http, parseAbi, erc20Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { guardedNode } from "../helpers/guarded-process.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const OTHER_AGENT = "0x5555555555555555555555555555555555555555";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const CANCEL: Hex = `0x${"13".repeat(32)}`;
const RETURN: Hex = `0x${"14".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"cd".repeat(32)}`;
const NONCE: Hex = `0x${"ef".repeat(32)}`;
const REVOKE_TX = `0x${"aa".repeat(32)}`;
const SELF_TX = `0x${"cc".repeat(32)}`;
const SWEEP_TX = `0x${"ee".repeat(32)}`;
const isRoot = process.getuid?.() === 0;

const abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
]);
const transfer = (from: Hex, to: Hex, value = 10000n) => ({ address: TOKEN, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }), data: `0x${value.toString(16).padStart(64, "0")}` });
const canceled = () => ({ address: TOKEN, topics: encodeEventTopics({ abi, eventName: "AuthorizationCanceled", args: { authorizer: AGENT, nonce: NONCE } }), data: "0x", transactionHash: CANCEL, blockNumber: 100n, blockHash: BLOCK_HASH, removed: false });
type Log = ReturnType<typeof transfer> | ReturnType<typeof canceled>;
const receipt = (hash: Hex, blockNumber: bigint, logs: Log[]) => ({ transactionHash: hash, blockNumber, blockHash: BLOCK_HASH, status: "success", logs });
const journal = (over: Record<string, unknown> = {}) => ({
  op: "me", rail: "base-sepolia", path: "approve", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  url: "https://seller.example", owner: OWNER, agent: AGENT, token: TOKEN, max: "1", pullTx: HASH, pullNonce: 7, pullBlock: "80", signed: true,
  auth: { from: AGENT, to: TO, value: "10000", nonce: NONCE, validBefore: 1000, validAfter: 0 }, delivered: null, notes: [], ...over,
});
const wallet = () => {
  const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
  return { account, client: createWalletClient({ account, transport: http("http://127.0.0.1:1") }) };
};

let dir: string;
const cleanup: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(d); return d; };
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { chmodSync(join(d, "locked"), 0o700); } catch {} // the blocked directory must be searchable again to be removed
    rmSync(d, { recursive: true, force: true });
  }
});
const put = (name: string, v: unknown, d = dir) => writeFileSync(join(d, name), typeof v === "string" ? v : JSON.stringify(v));

// ---------------------------------------------------------------- harness A: ops.ts against a mocked chain client
const sendJournaled = vi.fn();
const usdcBalance = vi.fn();
const rpc = {
  getTransactionReceipt: vi.fn(), getTransaction: vi.fn(), getTransactionCount: vi.fn(),
  getBlock: vi.fn(), getBlockNumber: vi.fn(), readContract: vi.fn(), getLogs: vi.fn(),
};
/** The chain: the head is 110, the finalized block `finalized`, and its time `finalTime` (the head's is 2000). */
function chain(o: { finalized: bigint; finalTime?: bigint; pullAt?: bigint; cancelAt?: bigint; pullValue?: bigint; nonceUsedAtHead?: boolean }) {
  const finalTime = o.finalTime ?? 900n;
  rpc.getBlockNumber.mockResolvedValue(110n);
  rpc.getBlock.mockImplementation(async ({ blockTag, blockNumber }) => {
    const number = blockNumber ?? (blockTag === "finalized" ? o.finalized : 110n);
    return { number, timestamp: number === o.finalized ? finalTime : 2000n, hash: BLOCK_HASH, transactions: [] };
  });
  rpc.readContract.mockImplementation(async ({ blockNumber }) => !!o.nonceUsedAtHead && blockNumber >= (o.cancelAt ?? 100n)); // the cancel is in block 100
  rpc.getLogs.mockResolvedValue([]);
  rpc.getTransactionReceipt.mockImplementation(async ({ hash }) => hash === HASH ? receipt(HASH, o.pullAt ?? 80n, [transfer(OWNER, AGENT, o.pullValue)])
    : hash === CANCEL ? receipt(CANCEL, o.cancelAt ?? 100n, [canceled()]) : receipt(hash, 105n, [transfer(AGENT, OWNER, o.pullValue)]));
}
const harnessA = () => {
  beforeEach(() => {
    dir = tmp("recover-finality-");
    vi.resetModules();
    sendJournaled.mockReset();
    usdcBalance.mockReset().mockResolvedValue(10000n);
    for (const fn of Object.values(rpc)) fn.mockReset();
    rpc.getTransactionCount.mockResolvedValue(8);
    rpc.getTransaction.mockRejectedValue(new Error("not found"));
    chain({ finalized: 90n });
    vi.doMock("../../budget/evm/lib.js", async (original) => ({ ...await original<object>(), OPS_DIR: dir, publicClient: rpc, sendJournaled, usdcBalance, allowanceOf: async () => 10000n, USDC: TOKEN, sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f(), readUntil: async <T,>(read: () => Promise<T>) => read() }));
  });
  afterEach(() => { vi.doUnmock("../../budget/evm/lib.js"); });
};
const ops = () => import(new URL("../../budget/evm/ops.ts", import.meta.url).href);
/** sendJournaled that mines what it is given: the return lands, a cancel would land too. */
const sends = () => sendJournaled.mockImplementation(async (_w, _to, _data, label, before) => {
  const hash = String(label).includes("cancel") ? CANCEL : RETURN;
  before({ hash, nonce: 9 });
  return { hash, feeWei: 1n };
});

describe("makeSafe returns the price only when the authorization is dead at a final block", () => {
  harnessA();
  it("keeps the price while a cancellation already on chain is not final", async () => {
    const m = await ops();
    chain({ finalized: 90n, nonceUsedAtHead: true }); // the cancel is at block 100, past the finalized block 90
    sends();
    const result = await m.makeSafe(journal({ cancelTx: CANCEL }), wallet(), { log: () => {} });
    expect(sendJournaled).not.toHaveBeenCalled();
    expect(result.returned).toBeUndefined();
    expect(result).toMatchObject({ state: "unknown", reason: "the cancellation landed, but is not final on chain yet" });
  });
  it("returns the price once that cancellation is final", async () => {
    const m = await ops();
    chain({ finalized: 105n, nonceUsedAtHead: true });
    sends();
    const result = await m.makeSafe(journal({ cancelTx: CANCEL }), wallet(), { log: () => {} });
    expect(sendJournaled).toHaveBeenCalledTimes(1);
    expect(result.returned).toBe("0.01");
  });
  it("returns exactly the pulled atomic amount", async () => {
    const m = await ops();
    chain({ finalized: 90n, pullValue: 9007199254740993n });
    usdcBalance.mockResolvedValue(9007199254740995n);
    sends();
    await m.makeSafe(journal({ signed: false, auth: undefined }), wallet(), { log: () => {} });
    expect(sendJournaled).toHaveBeenCalledTimes(1);
    const sent = decodeFunctionData({ abi: erc20Abi, data: sendJournaled.mock.calls[0]![2] });
    expect(sent.functionName).toBe("transfer");
    expect(sent.args![1]).toBe(9007199254740993n);
  });
});

describe("resultLine", () => {
  harnessA();
  it("debits exact units and leaves a non-amount unknown", async () => {
    const m = await ops();
    const debit = async (pulled: string) => JSON.parse((await m.resultLine(journal({ pulled }), "reconcile", { remaining: "0" })).slice("RESULT ".length)).debit;
    expect(await debit("9007199254.740993")).toBe("9007199254.740993");
    expect(await debit("1e3")).toBeNull();
  });
});

describe("scanJournals", () => {
  harnessA();
  it("names every file it cannot use, and changes none", async () => {
    const m = await ops();
    const blocked = tmp("recover-finality-blocked-");
    put("good.json", journal({ op: "good" }));
    put("foreign.json", journal({ op: "foreign", agent: OTHER_AGENT }));
    put("broken.json", "{garbage");
    put("arr.json", "[]");
    put("other.json", journal({ op: "other", path: "exact" }));
    put("named.json", journal({ op: "different" }));
    put("noagent.json", journal({ op: "noagent", agent: undefined }));
    put("exp.json", journal({ op: "exp", pulled: "1e3" }));
    mkdirSync(join(dir, "dir.json"));
    put("big.json", "x".repeat(1_100_000));
    symlinkSync("loop.json", join(dir, "loop.json"));
    symlinkSync(join(dir, "missing-target"), join(dir, "dangling.json"));
    put("x.response", "ignored");
    put("x.json.lock", "ignored");
    if (!isRoot) {
      mkdirSync(join(blocked, "locked"));
      writeFileSync(join(blocked, "locked", "target.json"), "{still-garbage");
      symlinkSync(join(blocked, "locked", "target.json"), join(dir, "acc.json"));
      chmodSync(join(blocked, "locked"), 0o000);
    }
    const bytes = readFileSync(join(dir, "broken.json"), "utf8");

    const own = m.scanJournals(AGENT);
    expect(own.journals.map((j: { op: string }) => j.op)).toEqual(["good"]);
    expect(m.scanJournals().journals.map((j: { op: string }) => j.op).sort()).toEqual(["foreign", "good"]);
    const why = Object.fromEntries(own.unreadable.map((u: { file: string; why: string }) => [u.file, u.why]));
    expect(why["broken.json"]).toMatch(/not valid JSON/);
    expect(why["arr.json"]).toMatch(/does not hold a journal/);
    expect(why["other.json"]).toMatch(/not an evm budget/);
    expect(why["named.json"]).toMatch(/another operation/);
    expect(why["noagent.json"]).toMatch(/no agent/);
    expect(why["exp.json"]).toMatch(/pulled amount/);
    expect(why["dir.json"]).toMatch(/not a regular file/);
    expect(why["big.json"]).toMatch(/larger than a journal/);
    expect(why["loop.json"]).toMatch(/ELOOP/);
    expect(why["dangling.json"]).toMatch(/link to nothing/);
    if (!isRoot) expect(why["acc.json"]).toMatch(/EACCES/);
    expect(Object.keys(why)).not.toContain("x.response");
    expect(Object.keys(why)).not.toContain("x.json.lock");
    expect(Object.keys(why)).not.toContain("good.json");

    // nothing was written: the links still point where they did, the files hold their bytes
    expect(readlinkSync(join(dir, "loop.json"))).toBe("loop.json");
    expect(readlinkSync(join(dir, "dangling.json"))).toBe(join(dir, "missing-target"));
    expect(readFileSync(join(dir, "broken.json"), "utf8")).toBe(bytes);
    if (!isRoot) {
      chmodSync(join(blocked, "locked"), 0o700);
      expect(readFileSync(join(blocked, "locked", "target.json"), "utf8")).toBe("{still-garbage");
      expect(readlinkSync(join(dir, "acc.json"))).toBe(join(blocked, "locked", "target.json"));
    }
  });

  it.skipIf(!(() => { try { execFileSync("mkfifo", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })())(
    "a FIFO in the journal folder does not hang the scan",
    async () => {
      const home = tmp("recover-finality-home-");
      const ops = join(home, "budget/ops/evm-base-sepolia");
      mkdirSync(ops, { recursive: true });
      execFileSync("mkfifo", [join(ops, "f.json")]);
      const script = `const o = await import("./budget/evm/ops.ts"); console.log("PENDING", o.pendingJournalsFor("${AGENT}").length); console.log(JSON.stringify(o.scanJournals().unreadable));`;
      const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", script], { HOME: home, SUPERSTABLES_HOME: home });
      expect(child.code, child.output).toBe(0);
      expect(child.output).toMatch(/PENDING 0/);
      expect(child.output).toMatch(/"file":"f\.json".*not a regular file/);
    },
    70_000, // longer than guardedNode's 60 s kill, so a child blocked on the FIFO is always killed by it before the test ends
  );
});

describe("atomicUsdc", () => {
  harnessA();
  it("is exact, and refuses everything parseUnits would round, sign or trim", async () => {
    const { atomicUsdc } = await ops();
    expect(atomicUsdc("0.29")).toBe(290000n);
    expect(atomicUsdc("1")).toBe(1000000n);
    expect(atomicUsdc("9007199254.740993")).toBe(9007199254740993n);
    expect(atomicUsdc("0.000001")).toBe(1n);
    for (const bad of ["-1", "+1", ".5", "1.", "0.0000005", " 1", "1 ", "1e3", "1,5", "", "0x10", "1.5.2"]) expect(atomicUsdc(bad), bad).toBeNull();
    for (const bad of [1, null, undefined, {}, ["1"]]) expect(atomicUsdc(bad)).toBeNull();
  });
});

describe("otherOpWithTx", () => {
  harnessA();
  it("throws while a journal cannot be read, and still finds a twin", async () => {
    const m = await ops();
    put("other.json", journal({ op: "other", pullTx: `0x${"01".repeat(32)}` }));
    put("broken.json", "{garbage");
    put("me.json", "{garbage"); // the operation's own file is not another operation
    expect(() => m.otherOpWithTx("pullTx", HASH, "me")).toThrow(m.JournalsUnreadable);
    try { m.otherOpWithTx("pullTx", HASH, "me"); } catch (e: any) { expect(e.files.map((f: { file: string }) => f.file)).toEqual(["broken.json"]); expect(e.message).toMatch(/broken\.json/); }
    put("twin.json", journal({ op: "twin", pullTx: HASH.toUpperCase().replace("0X", "0x") }));
    expect(m.otherOpWithTx("pullTx", HASH, "me")).toBe("twin");
  });
  it("answers null only after reading every journal", async () => {
    const m = await ops();
    put("other.json", journal({ op: "other", pullTx: `0x${"01".repeat(32)}` }));
    expect(m.otherOpWithTx("pullTx", HASH, "me")).toBeNull();
  });
});

describe("sweepBlockers", () => {
  harnessA();
  const run = async (j: Record<string, unknown>, c: Parameters<typeof chain>[0] = { finalized: 90n }) => {
    const m = await ops();
    chain(c);
    put(`${j.op}.json`, j);
    return m.sweepBlockers(AGENT);
  };
  it("blocks on a submitted operation", async () => {
    expect((await run(journal({ op: "s1", state: "submitted" }))).undecided).toEqual([{ op: "s1", why: expect.stringMatching(/still being sent/) }]);
  });
  it("blocks on an unknown one whose authorization may still settle", async () => {
    const r = await run(journal({ op: "u1", state: "unknown", pullStatus: "success" }), { finalized: 90n, finalTime: 900n });
    expect(r.undecided).toEqual([{ op: "u1", why: expect.stringMatching(/may still be settled until/) }]);
  });
  it("blocks on an unknown one with a cancellation that is not final", async () => {
    const r = await run(journal({ op: "u2", state: "unknown", pullStatus: "success", cancelTx: CANCEL }), { finalized: 90n, nonceUsedAtHead: true });
    expect(r.undecided).toEqual([{ op: "u2", why: expect.stringMatching(/cancellation is not final/) }]);
  });
  it("does not block on an unknown one whose pull is final and whose authorization is dead", async () => {
    const r = await run(journal({ op: "u3", state: "unknown", pullStatus: "success" }), { finalized: 90n, finalTime: 2000n });
    expect(r.undecided).toEqual([]);
  });
  it("blocks on a settled one that is not final, not on one without a final flag", async () => {
    expect((await run(journal({ op: "t1", state: "settled", final: false }))).undecided).toHaveLength(1);
    expect((await run(journal({ op: "t2", state: "settled" }))).undecided).toHaveLength(1); // t1 is still in the folder
    rmSync(join(dir, "t1.json"));
    expect((await (await ops()).sweepBlockers(AGENT)).undecided).toEqual([]);
  });
  it("does not block on a failed one", async () => {
    expect((await run(journal({ op: "f1", state: "failed" }))).undecided).toEqual([]);
  });
  it("ignores another agent's operation, and lists a file it cannot read", async () => {
    const m = await ops();
    put("o1.json", journal({ op: "o1", agent: OTHER_AGENT, state: "submitted" }));
    put("broken.json", "{garbage");
    const r = await m.sweepBlockers(AGENT);
    expect(r.undecided).toEqual([]);
    expect(r.unreadable).toEqual([{ file: "broken.json", why: expect.stringMatching(/not valid JSON/) }]);
  });
  it("blocks on a state recover does not know", async () => {
    expect((await run(journal({ op: "w1", state: "weird" }))).undecided).toEqual([{ op: "w1", why: expect.stringMatching(/not one recover knows/) }]);
  });
});

// ---------------------------------------------------------------- harness B: recover.ts with its chain and owner steps replaced
type Run = { code: number; r: Record<string, any>; revokeCalls: unknown[][]; sends: { to: string; data: Hex }[]; ops: string; lines: string[] };
type SelfRevokeStub = { state: "nothing" | "revoked" | "partial" | "blocked"; before: bigint; after: bigint; used: bigint; ownerBalance: bigint; tx?: string; note: string };
const proven: SelfRevokeStub = { state: "revoked", before: 1_000_000n, after: 0n, used: 1_000_000n, ownerBalance: 5_000_000n, tx: SELF_TX, note: "lowered the allowance to 0" };

async function recover(o: { ops?: Record<string, string>; allowances: bigint[]; held?: bigint; selfRevoke?: SelfRevokeStub; ownerKeyFile?: boolean; makeSafe?: (j: any) => Promise<any>; args?: string[]; prepare?: (opsDir: string, root: string) => void; onRevoke?: (opsDir: string) => void }): Promise<Run> {
  vi.resetModules();
  const root = tmp("recover-finality-b-");
  const opsDir = join(root, "ops");
  mkdirSync(opsDir);
  for (const [name, text] of Object.entries(o.ops ?? {})) writeFileSync(join(opsDir, name), text);
  o.prepare?.(opsDir, root);
  const agentFile = join(root, "agent.env");
  writeFileSync(agentFile, "", { mode: 0o600 });
  const revokeCalls: unknown[][] = [];
  const sent: { to: string; data: Hex }[] = [];
  const allowances = [...o.allowances];
  let held = o.held ?? 0n;
  vi.doMock("../../budget/evm/lib.js", async (importOriginal) => ({
    ...((await importOriginal()) as object),
    OPS_DIR: opsDir,
    AGENT_ENV: agentFile,
    OWNER_KEY_FILE: o.ownerKeyFile ? agentFile : undefined,
    ownerCtx: async () => ({ owner: OWNER, wallet: { account: { address: OWNER } } }),
    send: async (_w: unknown, to: string, data: Hex) => {
      sent.push({ to, data });
      const selector = data.slice(0, 10);
      if (selector === "0xa9059cbb") held = 0n;
      return { hash: selector === "0x095ea7b3" ? REVOKE_TX : SWEEP_TX, blockNumber: 101n, feeWei: 0n };
    },
    sleep: async () => {},
    readCtx: () => ({ owner: OWNER, agent: AGENT }),
    ownerPlanCtx: async () => ({ owner: OWNER, agent: AGENT }),
    usdcBalance: async () => held,
    allowanceOf: async () => (allowances.length > 1 ? allowances.shift()! : allowances[0]!),
    nativeBalance: async () => 10n ** 15n,
    agentGas: async (_a: string, ops: string[]) => ({ ok: true, have: 10n ** 15n, need: 1n, gas: 1n, fee: 1n, ops }),
    assertRpcChain: async () => {},
    agentCtx: async () => ({ owner: OWNER, agent: AGENT, wallet: { account: { address: AGENT } } }),
    selfRevokeCore: async () => o.selfRevoke ?? { state: "nothing", before: 0n, after: 0n, used: 0n, ownerBalance: 0n, note: "allowance is already 0" },
    readUntil: async <T,>(read: () => Promise<T>) => read(),
    writePublic: () => {},
  }));
  vi.doMock("../../budget/op-lock.mjs", async (importOriginal) => ({ ...((await importOriginal()) as object), requireRecordLock: () => ({ release() {} }) }));
  vi.doMock("../../budget/evm/owner.js", async (importOriginal) => ({
    ...((await importOriginal()) as object),
    revokeInWallet: async (...a: unknown[]) => { revokeCalls.push(a); o.onRevoke?.(opsDir); return REVOKE_TX; }, // onRevoke: something happens in the folder after the first scan
    fundInWallet: async () => process.exit(3),
  }));
  if (o.makeSafe) vi.doMock("../../budget/evm/ops.js", async (importOriginal) => ({ ...((await importOriginal()) as object), makeSafe: o.makeSafe }));
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw Object.assign(new Error("exit"), { code }); }) as never);
  const argv = process.argv;
  process.argv = [argv[0]!, new URL("../../budget/evm/recover.ts", import.meta.url).pathname, ...(o.args ?? [])];
  try {
    await import(new URL("../../budget/evm/recover.ts", import.meta.url).href);
    throw new Error("recover returned instead of ending the command");
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === undefined) throw e;
    const line = lines.filter((l) => l.startsWith("RESULT ")).at(-1);
    expect(line, lines.join("\n")).toBeDefined();
    return { code, r: JSON.parse(line!.slice("RESULT ".length)), revokeCalls, sends: sent, ops: opsDir, lines };
  } finally {
    process.argv = argv;
    log.mockRestore();
    exit.mockRestore();
    vi.doUnmock("../../budget/evm/lib.js");
    vi.doUnmock("../../budget/op-lock.mjs");
    vi.doUnmock("../../budget/evm/owner.js");
    vi.doUnmock("../../budget/evm/ops.js");
  }
}
const sweeps = (run: Run) => run.sends.filter((s) => s.data.startsWith("0xa9059cbb"));

describe("recover stops authority and sweeps only what is safe", () => {
  it("asks the owner to approve 0 when the allowance already reads 0", async () => {
    const run = await recover({ allowances: [0n] });
    expect(run.code).toBe(0);
    expect(run.r).toMatchObject({ state: "ok", ownerRevokeTx: REVOKE_TX });
    expect(run.revokeCalls).toHaveLength(1);
    expect(run.revokeCalls[0]![4]).toEqual({ result: {}, stepTx: "ownerRevokeTx" });
  });
  it("...and with an owner key file, sends approve(agent, 0)", async () => {
    const run = await recover({ allowances: [0n], ownerKeyFile: true });
    expect(run.code).toBe(0);
    expect(run.sends).toHaveLength(1);
    const call = decodeFunctionData({ abi: erc20Abi, data: run.sends[0]!.data });
    expect(call.functionName).toBe("approve");
    expect(call.args).toEqual([AGENT, 0n]);
  });
  it("the agent's own proven revoke needs no owner step", async () => {
    const run = await recover({ allowances: [1_000_000n, 0n], selfRevoke: proven });
    expect(run.code).toBe(0);
    expect(run.revokeCalls).toHaveLength(0);
    expect(run.r).toMatchObject({ state: "ok", selfRevokeTx: SELF_TX });
  });
  it("a partial selfRevoke followed by a read of 0 still asks the owner", async () => {
    const partial: SelfRevokeStub = { ...proven, state: "partial", after: 400_000n, used: 600_000n, ownerBalance: 600_000n, note: "partial" };
    const run = await recover({ allowances: [1_000_000n, 0n], selfRevoke: partial });
    expect(run.revokeCalls).toHaveLength(1);
  });
  it("a journal written after the first scan, still being sent, stops the sweep", async () => {
    const run = await recover({ allowances: [0n], held: 5_000_000n, onRevoke: (d) => writeFileSync(join(d, "late.json"), JSON.stringify(journal({ op: "late", state: "submitted" }))) });
    expect(sweeps(run)).toHaveLength(0);
    expect(run.code).toBe(5);
    expect(run.r.undecided).toEqual([{ op: "late", why: expect.stringMatching(/still being sent/) }]);
  });
  it("a file that becomes unreadable after the first scan stops the sweep", async () => {
    const run = await recover({ allowances: [0n], held: 5_000_000n, onRevoke: (d) => writeFileSync(join(d, "late.json"), "{garbage") });
    expect(sweeps(run)).toHaveLength(0);
    expect(run.code).toBe(5);
    expect(run.r.unreadable.map((u: any) => u.file)).toEqual(["late.json"]);
  });
  it("a skipped sweep logs every blocker on its own line, and next points at that log", async () => {
    const run = await recover({
      allowances: [0n], held: 5_000_000n,
      ops: { "bad1.json": "{garbage" },
      onRevoke: (d) => {
        writeFileSync(join(d, "bad2.json"), "[]");
        writeFileSync(join(d, "bad3.json"), "7");
        writeFileSync(join(d, "bad4.json"), "{x");
        for (const n of ["a", "b", "c", "d", "e"]) writeFileSync(join(d, `op-${n}.json`), JSON.stringify(journal({ op: `op-${n}`, state: "submitted" })));
      },
    });
    expect(run.code).toBe(5);
    expect(sweeps(run)).toHaveLength(0);
    const sweepLines = run.lines.slice(run.lines.findIndex((l) => l === "== 3. sweep"));
    for (const f of ["bad1", "bad2", "bad3", "bad4"]) expect(sweepLines.filter((l) => l.startsWith(`journal "${f}.json" cannot be read: `))).toHaveLength(1);
    for (const n of ["a", "b", "c", "d", "e"]) expect(sweepLines.filter((l) => l.startsWith(`operation "op-${n}" can still move money: `))).toHaveLength(1);
    expect(run.r.next).not.toMatch(/unreadable|undecided|RESULT/);
    expect(run.r.next).toMatch(/listed above/);
  });
  it("an unreadable journal stops the sweep", async () => {
    const run = await recover({ ops: { "broken.json": "{garbage" }, allowances: [1_000_000n, 0n], selfRevoke: proven, held: 5_000_000n });
    expect(run.code).toBe(5);
    expect(run.r).toMatchObject({ state: "unknown", swept: "0", unreadable: [{ file: "broken.json", why: expect.stringMatching(/not valid JSON/) }] });
    expect(run.r.reason).toMatch(/^sweep skipped: /);
    expect(sweeps(run)).toHaveLength(0);
    expect(readFileSync(join(run.ops, "broken.json"), "utf8")).toBe("{garbage");
  });
  it("an operation still being sent stops the sweep", async () => {
    const sending = JSON.stringify(journal({ op: "s1", state: "submitted" }));
    const run = await recover({ ops: { "s1.json": sending }, allowances: [1_000_000n, 0n], selfRevoke: proven, held: 5_000_000n, makeSafe: async (j) => j });
    expect(run.code).toBe(5);
    expect(sweeps(run)).toHaveLength(0);
    expect(run.r.undecided).toEqual([{ op: "s1", why: expect.stringMatching(/still being sent/) }]);
  });
  it("planted links and an inaccessible target stay as they are", async () => {
    let target = "";
    const run = await recover({
      ops: { "broken.json": "{garbage" }, allowances: [1_000_000n, 0n], selfRevoke: proven, held: 5_000_000n,
      prepare: (opsDir, root) => {
        symlinkSync("loop.json", join(opsDir, "loop.json"));
        if (isRoot) return;
        mkdirSync(join(root, "locked"));
        target = join(root, "locked", "target.json");
        writeFileSync(target, "{still-garbage");
        symlinkSync(target, join(opsDir, "acc.json"));
        chmodSync(join(root, "locked"), 0o000);
      },
    });
    expect(run.code).toBe(5);
    expect(sweeps(run)).toHaveLength(0);
    const files = run.r.unreadable.map((u: { file: string }) => u.file).sort();
    expect(files).toEqual(isRoot ? ["broken.json", "loop.json"] : ["acc.json", "broken.json", "loop.json"]);
    expect(run.r.unreadable.find((u: { file: string }) => u.file === "loop.json").why).toMatch(/ELOOP/);
    expect(readlinkSync(join(run.ops, "loop.json"))).toBe("loop.json");
    if (!isRoot) {
      expect(run.r.unreadable.find((u: { file: string }) => u.file === "acc.json").why).toMatch(/EACCES/);
      chmodSync(join(target, ".."), 0o700);
      expect(readFileSync(target, "utf8")).toBe("{still-garbage");
    }
  });
  it("--plan lists unreadable journals and the owner revoke at 0", async () => {
    const run = await recover({ ops: { "broken.json": "{garbage" }, allowances: [0n], args: ["--plan"] });
    expect(run.code).toBe(0);
    expect(run.r.state).toBe("planned");
    expect(run.r.plan.unreadable).toHaveLength(1);
    expect(run.r.plan).toMatchObject({ sweep: false, ownerRevoke: true });
  });
});
