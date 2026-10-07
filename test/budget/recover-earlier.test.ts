// recover asks the owner more than once (budget/evm/recover.ts): the rest of the allowance, then gas for the agent. When a
// later owner step expires, is rejected, fails or stays unknown, its RESULT keeps what earlier steps already did (the
// revoke transactions, the allowance at 0) and its next says so first, instead of "nothing was sent". Without earlier
// steps the RESULT is as before. The owner's wallet page is replaced by a fixed answer; the chain answers in-process.
import { describe, expect, it, vi } from "vitest";

const OWNER = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537" as const;
const AGENT = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd" as const;
const REVOKE_TX = `0x${"ab".repeat(32)}`;
const SELF_TX = `0x${"cd".repeat(32)}`;
const GAS_TX = `0x${"ef".repeat(32)}`;
const EARLIER = {
  result: { selfRevokeTx: null, ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0" },
  done: `the allowance read 0 after the owner's revoke ${REVOKE_TX} before this step. No funds were returned yet`,
  stepTx: "gasTx",
};

type Outcome = { status: "expired" | "rejected"; reason: string; sending?: boolean } | { status: "sent"; hash: string };
type Owner = {
  fundInWallet(command: string, owner: string, agent: string, value: bigint, amt: string, agentHas: bigint, earlier?: object): Promise<string>;
  revokeInWallet(command: string, owner: string, agent: string, title?: string, earlier?: object): Promise<string>;
  lib: { publicClient: object };
};

/** owner.ts with the wallet page answering `outcome`, and the chain answering from `allowance` and nothing else. */
async function load(outcome: Outcome, allowance = 0n): Promise<Owner> {
  vi.resetModules();
  vi.doMock("../../budget/evm/lib.js", async (importOriginal) => ({
    ...((await importOriginal()) as object),
    sleep: async () => {},
    retry: async <T,>(fn: () => Promise<T>) => fn(),
    readUntil: async <T,>(read: () => Promise<T>) => read(),
  }));
  vi.doMock("../../budget/owner-page.js", async (importOriginal) => {
    const real = (await importOriginal()) as { ownerPageFor: (r: unknown) => Record<string, unknown> };
    return {
      ...real,
      closeOwnerPage: async () => {},
      ownerPageFor: (r: unknown) => ({ ...real.ownerPageFor(r), askTransaction: async () => ({ handle: { finish: () => {} }, outcome }) }),
    };
  });
  const owner = await import(new URL("../../budget/evm/owner.ts", import.meta.url).href);
  const lib = await import(new URL("../../budget/evm/lib.ts", import.meta.url).href);
  Object.assign(lib.publicClient, {
    getBlockNumber: async () => 100n,
    getBalance: async () => 10n ** 18n,
    readContract: async () => allowance,
    // the reported transaction is not on chain: the step's outcome is unknown
    getTransaction: async () => { throw new Error("not found"); },
    getTransactionReceipt: async () => { throw new Error("not found"); },
    getLogs: async () => [],
    waitForTransactionReceipt: async () => { throw new Error("not found"); },
  });
  return { ...owner, lib } as Owner;
}

/** Runs `step` until its process.exit, and returns the exit code and the RESULT it printed. */
async function result(step: () => Promise<unknown>): Promise<{ code: number; r: Record<string, any> }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw Object.assign(new Error("exit"), { code }); }) as never);
  try {
    await step();
    throw new Error("the step returned instead of ending the command");
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === undefined) throw e;
    const line = lines.filter((l) => l.startsWith("RESULT ")).at(-1);
    expect(line, lines.join("\n")).toBeDefined();
    return { code, r: JSON.parse(line!.slice("RESULT ".length)) };
  } finally {
    log.mockRestore();
    exit.mockRestore();
  }
}

describe("recover's gas step after the revoke landed (fundInWallet with earlier steps)", () => {
  it("an expired gas link keeps the owner's revoke in the RESULT and says the allowance read 0 before it", async () => {
    const o = await load({ status: "expired", reason: "the approval link expired" });
    const { code, r } = await result(() => o.fundInWallet("recover", OWNER, AGENT, 10n ** 15n, "0.001", 0n, EARLIER));
    expect(code).toBe(3);
    expect(r).toMatchObject({ command: "recover", state: "refused_precheck", ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0" });
    expect(r.next).toMatch(/^the allowance read 0 after the owner's revoke 0xab.* before this step/);
    expect(r.next).toMatch(/this step sent nothing: the approval link expired/);
    expect(r.next).not.toMatch(/^nothing was sent/);
  });

  it("a rejected gas step says the same, and asks again only if the owner asks", async () => {
    const o = await load({ status: "rejected", reason: "the owner rejected it" });
    const { code, r } = await result(() => o.fundInWallet("recover", OWNER, AGENT, 10n ** 15n, "0.001", 0n, EARLIER));
    expect(code).toBe(3);
    expect(r.ownerRevokeTx).toBe(REVOKE_TX);
    expect(r.next).toMatch(/^the allowance read 0.*this step sent nothing\. Request a new approval only if the owner asks$/);
  });

  it("a gas link that ended while the wallet may be sending is unknown, with the revoke kept", async () => {
    const o = await load({ status: "expired", reason: "the approval link expired", sending: true });
    const { code, r } = await result(() => o.fundInWallet("recover", OWNER, AGENT, 10n ** 15n, "0.001", 0n, EARLIER));
    expect(code).toBe(5);
    expect(r).toMatchObject({ state: "unknown", ownerRevokeTx: REVOKE_TX });
    expect(r.next).toMatch(/^the allowance read 0.*read whether it landed/);
  });

  it("a gas transfer the chain does not show is unknown: its hash is reported as gasTx, next to the revoke", async () => {
    const o = await load({ status: "sent", hash: GAS_TX });
    // readSent waits up to two minutes by the clock: let every read of it move the clock half a minute on
    let clock = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => (clock += 30_000));
    const { code, r } = await result(() => o.fundInWallet("recover", OWNER, AGENT, 10n ** 15n, "0.001", 0n, EARLIER)).finally(() => now.mockRestore());
    expect(code).toBe(5);
    expect(r).toMatchObject({ state: "unknown", tx: GAS_TX, gasTx: GAS_TX, ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0" });
    expect(r.next).toMatch(/^the allowance read 0/);
  });

  it("without earlier steps (fund-agent), an expired link still says nothing was sent", async () => {
    const o = await load({ status: "expired", reason: "the approval link expired" });
    const { code, r } = await result(() => o.fundInWallet("fund-agent", OWNER, AGENT, 10n ** 15n, "0.001", 0n));
    expect(code).toBe(3);
    expect(r.next).toMatch(/^nothing was sent: the approval link expired/);
    expect(r).not.toHaveProperty("ownerRevokeTx");
    expect(r).not.toHaveProperty("gasTx");
  });
});

describe("recover's owner revoke after the agent's own partial revoke (revokeInWallet with earlier steps)", () => {
  it("an expired revoke link keeps selfRevokeTx and says the agent's revoke landed", async () => {
    const o = await load({ status: "expired", reason: "the approval link expired" }, 5_000_000n);
    const earlier = { result: { selfRevokeTx: SELF_TX }, done: `the agent's own revoke ${SELF_TX} landed (partial) and lowered the allowance; only the rest needs the owner`, stepTx: "ownerRevokeTx" };
    const { code, r } = await result(() => o.revokeInWallet("recover", OWNER, AGENT, "Revoke before recovering funds", earlier));
    expect(code).toBe(3);
    expect(r).toMatchObject({ state: "refused_precheck", selfRevokeTx: SELF_TX, allowance: "5" });
    expect(r.next).toMatch(/^the agent's own revoke 0xcd.* landed \(partial\).*this step sent nothing: the approval link expired/);
  });

  it("with only stepTx (nothing earlier), the next is unchanged", async () => {
    const o = await load({ status: "expired", reason: "the approval link expired" }, 5_000_000n);
    const { r } = await result(() => o.revokeInWallet("recover", OWNER, AGENT, "Revoke before recovering funds", { result: {}, stepTx: "ownerRevokeTx" }));
    expect(r.next).toMatch(/^nothing was sent: the approval link expired/);
  });
});

// recover.ts itself, with its chain reads and the two owner steps replaced: what it hands each owner step, and what it reports
// when the gas step fails with an error after the revoke landed.
describe("recover.ts hands the completed revoke to the later owner steps", () => {
  type Run = { code: number; r?: Record<string, any>; revokeCalls: unknown[][]; fundCalls: unknown[][] };

  async function recover(o: { gasError?: Error; ownerKeyRevert?: string } = {}): Promise<Run> {
    vi.resetModules();
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const agentFile = join(mkdtempSync(join(tmpdir(), "recover-earlier-")), "agent.env");
    writeFileSync(agentFile, "", { mode: 0o600 });
    const revokeCalls: unknown[][] = [];
    const fundCalls: unknown[][] = [];
    // the allowance: 5 before, 2 after the agent's partial self-revoke, 0 after the owner's revoke
    const allowances = [5_000_000n, 2_000_000n, 0n];
    vi.doMock("../../budget/evm/lib.js", async (importOriginal) => ({
      ...((await importOriginal()) as object),
      AGENT_ENV: agentFile,
      OWNER_KEY_FILE: o.ownerKeyRevert ? agentFile : undefined,
      ownerCtx: async () => ({ owner: OWNER, wallet: { account: { address: OWNER } } }),
      // with an owner key file the owner's steps are sent directly: the revoke lands, the gas transfer reverts
      send: async () => ({ hash: REVOKE_TX, blockNumber: 101n, feeWei: 0n }),
      sendNative: async () => { throw Object.assign(new Error(`gas top-up owner -> agent reverted on chain: ${o.ownerKeyRevert}`), { txHash: o.ownerKeyRevert, blockNumber: 102n }); },
      sleep: async () => {},
      readCtx: () => ({ owner: OWNER, agent: AGENT }),
      usdcBalance: async () => 1_000_000n, // the agent holds 1 USDC to return
      allowanceOf: async () => (allowances.length > 1 ? allowances.shift()! : allowances[0]),
      nativeBalance: async () => 0n,
      agentGas: async (_a: string, ops: string[]) => {
        if (ops.length === 1 && ops[0] === "selfRevoke") return { ok: true, have: 10n ** 15n, need: 1n, gas: 1n, fee: 1n, ops };
        if (o.gasError && !ops.includes("selfRevoke")) throw o.gasError;
        return { ok: false, have: 0n, need: 10n ** 14n, gas: 1n, fee: 1n, ops };
      },
      assertRpcChain: async () => {},
      agentCtx: async () => ({ owner: OWNER, agent: AGENT, wallet: { account: { address: AGENT } } }),
      selfRevokeCore: async () => ({ state: "partial", before: 5_000_000n, after: 2_000_000n, used: 3_000_000n, ownerBalance: 3_000_000n, tx: SELF_TX, note: "lowered the allowance by what the owner holds" }),
      readUntil: async <T,>(read: () => Promise<T>) => read(),
      writePublic: () => {},
    }));
    vi.doMock("../../budget/evm/ops.js", async (importOriginal) => ({ ...((await importOriginal()) as object), pendingJournalsFor: () => [] }));
    vi.doMock("../../budget/evm/owner.js", async (importOriginal) => ({
      ...((await importOriginal()) as object),
      revokeInWallet: async (...a: unknown[]) => { revokeCalls.push(a); return REVOKE_TX; },
      fundInWallet: async (...a: unknown[]) => { fundCalls.push(a); process.exit(3); },
    }));
    const argv = process.argv;
    process.argv = [argv[0]!, new URL("../../budget/evm/recover.ts", import.meta.url).pathname];
    try {
      const { code, r } = await result(() => import(new URL("../../budget/evm/recover.ts", import.meta.url).href));
      return { code, r, revokeCalls, fundCalls };
    } finally {
      process.argv = argv;
    }
  }

  it("the owner's revoke gets the agent's self-revoke, and the gas step gets both revokes, said as what was read before it", async () => {
    const run = await recover();
    expect(run.revokeCalls).toHaveLength(1);
    expect(run.revokeCalls[0]![4]).toMatchObject({ result: { selfRevokeTx: SELF_TX }, stepTx: "ownerRevokeTx" });
    expect(run.fundCalls).toHaveLength(1);
    const earlier = run.fundCalls[0]![6] as { result: Record<string, unknown>; done: string; stepTx: string };
    expect(earlier.result).toEqual({ selfRevokeTx: SELF_TX, ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0" });
    expect(earlier.stepTx).toBe("gasTx");
    expect(earlier.done).toBe(`the allowance read 0 after the agent's own revoke ${SELF_TX} and the owner's revoke ${REVOKE_TX} before this step. No funds were returned yet`);
  });

  it("a gas transfer the chain shows reverted ends failed, with its hash next to both revokes", async () => {
    const run = await recover({ ownerKeyRevert: GAS_TX });
    expect(run.revokeCalls).toHaveLength(0); // the key file sent the owner's revoke
    expect(run.code).toBe(1);
    expect(run.r).toMatchObject({ command: "recover", state: "failed", selfRevokeTx: SELF_TX, ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0", gasTx: GAS_TX });
    expect(run.r!.reason).toMatch(/reverted on chain/);
  });

  it("an error at the gas step after the revoke landed ends unknown, with both revoke transactions", async () => {
    const run = await recover({ gasError: new Error("RPC timed out") });
    expect(run.fundCalls).toHaveLength(0);
    expect(run.code).toBe(5);
    expect(run.r).toMatchObject({ command: "recover", state: "unknown", selfRevokeTx: SELF_TX, ownerRevokeTx: REVOKE_TX, allowanceAfterRevoke: "0", gasTx: null });
    expect(run.r!.reason).toMatch(/recover stopped at the gas step: RPC timed out/);
    expect(run.r!.next).toMatch(/^the allowance read 0 after .* before this step\. No funds were returned yet\. superstables budget doctor --rail evm/);
  });
});
