// The evm owner reads (budget/evm/owner.ts: readSent, checkFundSent, checkGrantSent) on recorded Base Sepolia
// transactions, with the chain's answers replaced in-process: what every owner command, hosted or not, and every hosted
// setup bundle decides from a reported hash. A delegated step needs the pinned manager, its event and its effect; a
// top-up is settled only when the agent's balance shows it; a step the site judged failed is never settled; a read the
// chain does not answer is unknown. The waits between reads are taken out.
import { readFileSync } from "node:fs";
import { encodeFunctionData, encodePacked, encodeAbiParameters, formatTransaction, formatTransactionReceipt, parseAbi, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const CODE = fixture("base-delegation-code") as { manager: Hex; executor: Hex };
const OWNER = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537" as const;
const MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const IMPLEMENTATION = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
const RELAYER = "0x3333333333333333333333333333333333333333" as const;
const GAS_TOPUP = 100_000_000_000_000n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** lib.ts as it is, without the waits between reads. */
const fastLib = async (importOriginal: () => Promise<unknown>) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    sleep: async () => {},
    retry: async <T,>(fn: () => Promise<T>, tries = 4) => {
      let last: unknown;
      for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { last = e; }
      }
      throw last;
    },
    readUntil: async <T,>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 8) => {
      let v = await read();
      for (let i = 0; i < tries && !ok(v); i++) v = await read();
      return v;
    },
  };
};

/** What the tests use of owner.ts and lib.ts. */
type Sent = { status: string; problems: string[]; unresolved?: string } | null;
type Check = { state: string; tx: string; reason?: string; allowance?: bigint; agentGas?: bigint };
type Rail = {
  readSent(hash: string, want: { from: string; to: string; data?: Hex; value?: bigint; afterBlock: bigint; siteFailed?: string }): Promise<Sent>;
  checkFundSent(hash: string, o: { owner: string; agent: string; t: { to: string; data?: Hex; value?: bigint }; value: bigint; agentHad: bigint; afterBlock: bigint; siteFailed?: string }): Promise<Check>;
  checkGrantSent(hash: string, o: { owner: string; agent: string; cap: bigint; afterBlock: bigint; siteFailed?: string }): Promise<Check>;
  grantTx(agent: string, cap: bigint): { to: Hex; data: Hex };
  lib: { publicClient: object; CFG: { chainId: number } };
};

/** owner.ts and lib.ts for one chain, loaded fresh (the chain is chosen when chains.ts loads). */
async function rail(chain = "base-sepolia"): Promise<Rail> {
  vi.resetModules();
  vi.doMock("../../budget/evm/lib.js", fastLib);
  const before = process.env.B4_CHAIN;
  process.env.B4_CHAIN = chain;
  try {
    // loaded by URL, so the type check does not follow the rail's own imports (it runs them with tsx)
    const owner = await import(new URL("../../budget/evm/owner.ts", import.meta.url).href);
    const lib = await import(new URL("../../budget/evm/lib.ts", import.meta.url).href);
    return { ...owner, lib } as Rail;
  } finally {
    if (before === undefined) delete process.env.B4_CHAIN;
    else process.env.B4_CHAIN = before;
  }
}

type Answers = {
  tx: any;
  receipt: any;
  /** Code at an address and block: a value, or an Error for a read that fails. Defaults: the recorded code. */
  code?: (address: string, block: bigint) => Hex | Error | undefined;
  nonce?: (address: string, block: bigint) => number | Error | undefined;
  balance?: (address: string) => bigint | Error;
  allowance?: bigint;
};
/** The chain answers what `a` says, through the rail's own client. */
function chain(lib: Awaited<ReturnType<typeof rail>>["lib"], a: Answers) {
  const reads: string[] = [];
  const answer = <T,>(v: T | Error) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  Object.assign(lib.publicClient, {
    getTransaction: async () => a.tx,
    getTransactionReceipt: async () => a.receipt,
    getCode: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
      reads.push(`code ${address}`);
      const v = a.code?.(address, blockNumber);
      if (v !== undefined) return answer(v === "0x" ? undefined : v);
      if (same(address, MANAGER)) return CODE.manager;
      if (same(address, IMPLEMENTATION)) return CODE.executor;
      return undefined;
    },
    getTransactionCount: async ({ address, blockNumber }: { address: string; blockNumber: bigint }) => {
      reads.push(`nonce ${address}`);
      return answer(a.nonce?.(address, blockNumber) ?? 0);
    },
    getBalance: async ({ address }: { address: string }) => answer(a.balance ? a.balance(address) : 0n),
    readContract: async () => a.allowance ?? 0n,
    getBlockNumber: async () => BigInt(a.receipt.blockNumber),
    getLogs: async () => [],
  });
  return reads;
}

/** A recorded transaction as viem returns it, with the owner's code and nonce around its block from the recording. */
function recorded(name: string, over: Partial<Answers> = {}): Answers & { block: bigint; f: any } {
  const f = fixture(name);
  const receipt = formatTransactionReceipt(f.receipt);
  const block = receipt.blockNumber;
  const o = f.owner;
  return {
    f, block, tx: formatTransaction(f.tx), receipt,
    code: (address, at) => (o && same(address, OWNER) ? (at === block - 1n ? o.codeBefore : o.codeAfter) : undefined),
    nonce: (address, at) => (o && same(address, OWNER) ? Number(at === block - 1n ? o.nonceBefore : o.nonceAfter) : 0),
    balance: (address) => BigInt(f.balances?.[address.toLowerCase()]?.after ?? 0),
    ...over,
  };
}

describe("a gas top-up the wallet sent (checkFundSent)", () => {
  const AGENT = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd" as const;
  const FIRST_AGENT = "0x7fc2aE5b9739FA788D11f3Bb07a67D6b80445999" as const;
  const DIRECT_AGENT = "0xcef1fac5270ad5f173e8c38f6034c27d93ff04a2" as const;
  const fund = (r: Awaited<ReturnType<typeof rail>>, a: { block: bigint }, agent: string, extra: { siteFailed?: string } = {}) =>
    r.checkFundSent(`0x${"a".repeat(64)}`, { owner: OWNER, agent: agent as Hex, t: { to: agent as Hex, value: GAS_TOPUP }, value: GAS_TOPUP, agentHad: 0n, afterBlock: a.block - 1n, ...extra });

  it("MetaMask sponsored it (a relayer sent it): settled, with MetaMask's implementation proven for the owner's account", async () => {
    const r = await rail();
    for (const [name, agent] of [["base-sponsored-fund", AGENT], ["base-sponsored-fund-2", FIRST_AGENT]] as const) {
      const a = recorded(name);
      const reads = chain(r.lib, a);
      expect(a.tx.from.toLowerCase()).not.toBe(OWNER.toLowerCase());
      expect(await fund(r, a, agent), name).toMatchObject({ state: "settled", agentGas: GAS_TOPUP });
      expect(reads, name).toEqual(expect.arrayContaining([`code ${MANAGER}`, `code ${IMPLEMENTATION}`, `code ${OWNER}`, `nonce ${OWNER}`]));
    }
  });

  it("sponsored, without the implementation proof: a mismatch, never settled", async () => {
    const r = await rail();
    const a = recorded("base-sponsored-fund", { code: (address) => (same(address, OWNER) ? "0x" : undefined) });
    chain(r.lib, a);
    const c = await fund(r, a, AGENT);
    expect(c).toMatchObject({ state: "mismatch" });
    expect(c.reason).toMatch(/the owner's account was not MetaMask's smart account in that transaction/);
  });

  it("sponsored, and the chain does not answer the code or nonce reads: unknown, never settled or a mismatch", async () => {
    const r = await rail();
    for (const broken of [{ code: () => new Error("503") }, { nonce: () => new Error("503") }] as Partial<Answers>[]) {
      const a = recorded("base-sponsored-fund", broken);
      chain(r.lib, a);
      const c = await fund(r, a, AGENT);
      expect(c.state).toBe("unknown");
      expect(c.reason).toMatch(/whether it moved the funds is not known yet/);
    }
  });

  it("the owner sent it directly: settled; the agent's balance not showing the amount: unknown, never settled", async () => {
    const r = await rail();
    const a = recorded("base-direct-fund");
    chain(r.lib, a);
    expect(await fund(r, a, DIRECT_AGENT)).toMatchObject({ state: "settled", agentGas: GAS_TOPUP });
    chain(r.lib, { ...a, balance: () => 0n });
    const flat = await fund(r, a, DIRECT_AGENT);
    expect(flat).toMatchObject({ state: "unknown", agentGas: 0n });
    expect(flat.reason).toMatch(/the agent's balance reads 0 ETH, not at least 0\.0001 ETH/);
    chain(r.lib, { ...a, balance: () => new Error("503") });
    expect(await fund(r, a, DIRECT_AGENT)).toMatchObject({ state: "unknown", reason: "the transaction is on chain, but the agent's balance could not be read" });
  });

  it("the site judged it failed: a mismatch, even though the chain shows the planned transfer", async () => {
    const r = await rail();
    const a = recorded("base-direct-fund");
    chain(r.lib, a);
    const c = await fund(r, a, DIRECT_AGENT, { siteFailed: "superstables.com reported this step as failed (reason: mismatch), so it is not counted as done" });
    expect(c.state).toBe("mismatch");
    // the site's verdict in its own words, with the transaction: never "not accepted as the planned step"
    expect(c.reason).toBe(`superstables.com reported this step as failed (reason: mismatch), so it is not counted as done (transaction 0x${"a".repeat(64)})`);
    // reverted on chain as well: failed
    chain(r.lib, { ...a, receipt: { ...a.receipt, status: "reverted" } });
    expect((await fund(r, a, DIRECT_AGENT, { siteFailed: "x reported this step as failed" })).state).toBe("failed");
  });
});

describe("a grant or revoke the wallet sent (checkGrantSent, readSent)", () => {
  const AGENT = "0x7fc2aE5b9739FA788D11f3Bb07a67D6b80445999" as const;
  const DIRECT_AGENT = "0xcef1fac5270ad5f173e8c38f6034c27d93ff04a2" as const;
  const CAP = 20_000n;

  it("MetaMask sponsored it: settled; the same without its Approval in the receipt: a mismatch, even when the allowance reads right", async () => {
    const r = await rail();
    const a = recorded("base-sponsored-grant", { allowance: CAP });
    chain(r.lib, a);
    expect(await r.checkGrantSent(`0x${"b".repeat(64)}`, { owner: OWNER, agent: AGENT, cap: CAP, afterBlock: a.block - 1n })).toMatchObject({ state: "settled", allowance: CAP });
    chain(r.lib, { ...a, receipt: { ...a.receipt, logs: a.receipt.logs.filter((l: any) => !same(l.address, "0x036CbD53842c5426634e7929541eC2318f3dCF7e")) } });
    const c = await r.checkGrantSent(`0x${"b".repeat(64)}`, { owner: OWNER, agent: AGENT, cap: CAP, afterBlock: a.block - 1n });
    expect(c.state).toBe("mismatch");
    expect(c.reason).toMatch(/its receipt has no Approval from the owner to this spender/);
  });

  it("the sponsored revoke reads as the owner's approve(agent, 0) with its effect", async () => {
    const r = await rail();
    const a = recorded("base-sponsored-revoke");
    chain(r.lib, a);
    const data = r.grantTx(AGENT, 0n).data;
    expect(await r.readSent(`0x${"c".repeat(64)}`, { from: OWNER, to: r.grantTx(AGENT, 0n).to, data, afterBlock: a.block - 1n })).toMatchObject({ status: "success", problems: [] });
  });

  it("sponsored, and the manager's code cannot be read: unknown, never settled", async () => {
    const r = await rail();
    const a = recorded("base-sponsored-grant", { allowance: CAP, code: (address) => (same(address, MANAGER) ? new Error("503") : undefined) });
    chain(r.lib, a);
    const c = await r.checkGrantSent(`0x${"b".repeat(64)}`, { owner: OWNER, agent: AGENT, cap: CAP, afterBlock: a.block - 1n });
    expect(c.state).toBe("unknown");
    expect(c.reason).toMatch(/the delegation manager's code could not be read/);
  });

  it("the owner's own grant: settled; the site judged it failed: a mismatch, never settled", async () => {
    const r = await rail();
    const a = recorded("base-direct-grant", { allowance: CAP });
    chain(r.lib, a);
    const args = { owner: OWNER, agent: DIRECT_AGENT as Hex, cap: CAP, afterBlock: a.block - 1n };
    expect(await r.checkGrantSent(`0x${"d".repeat(64)}`, args)).toMatchObject({ state: "settled" });
    const c = await r.checkGrantSent(`0x${"d".repeat(64)}`, { ...args, siteFailed: "superstables.com reported this step as failed (reason: stale_tx), so it is not counted as done" });
    expect(c.state).toBe("mismatch");
    expect(c.reason).toBe(`superstables.com reported this step as failed (reason: stale_tx), so it is not counted as done (transaction 0x${"d".repeat(64)}). The budget was not recorded.`);
  });
});

describe("a fabricated redemption: the manager's call with an unsigned delegation, which does nothing where no manager is", () => {
  const AGENT = "0x2222222222222222222222222222222222222222" as const;
  const delegationsType = [{
    type: "tuple[]",
    components: [
      { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
      { name: "caveats", type: "tuple[]", components: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }, { name: "args", type: "bytes" }] },
      { name: "salt", type: "uint256" }, { name: "signature", type: "bytes" },
    ],
  }] as const;
  const fabricated = (t: { to: Hex; value: bigint; data: Hex }, chainId: number) => ({
    hash: `0x${"a".repeat(64)}`, from: RELAYER, to: MANAGER, value: 0n, chainId,
    input: encodeFunctionData({
      abi: parseAbi(["function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)"]),
      args: [[encodeAbiParameters(delegationsType, [[{ delegate: RELAYER, delegator: OWNER, authority: `0x${"f".repeat(64)}`, caveats: [], salt: 0n, signature: "0x" }]])], [`0x${"0".repeat(64)}`], [encodePacked(["address", "uint256", "bytes"], [t.to, t.value, t.data])]],
    }),
  });
  const noop = { status: "success", blockNumber: 101n, logs: [] };

  for (const chainKey of ["skale-base-sepolia", "base-sepolia"]) {
    it(`${chainKey}: the top-up, the grant and the revoke are mismatches, with the balance and the allowance already as planned`, async () => {
      const r = await rail(chainKey);
      const chainId = r.lib.CFG.chainId;
      // nothing at the manager's address on SKALE; on Base Sepolia the receipt has none of the manager's events
      const answers = { receipt: noop, code: () => "0x" as Hex, balance: () => GAS_TOPUP, allowance: 20_000n };
      chain(r.lib, { ...answers, tx: fabricated({ to: AGENT, value: GAS_TOPUP, data: "0x" }, chainId) });
      const fund = await r.checkFundSent(`0x${"a".repeat(64)}`, { owner: OWNER, agent: AGENT, t: { to: AGENT, value: GAS_TOPUP }, value: GAS_TOPUP, agentHad: GAS_TOPUP, afterBlock: 100n });
      expect(fund.state).toBe("mismatch");
      chain(r.lib, { ...answers, tx: fabricated({ ...r.grantTx(AGENT, 20_000n), value: 0n }, chainId) });
      const grant = await r.checkGrantSent(`0x${"a".repeat(64)}`, { owner: OWNER, agent: AGENT, cap: 20_000n, afterBlock: 100n });
      expect(grant.state).toBe("mismatch");
      const revoke = r.grantTx(AGENT, 0n);
      chain(r.lib, { ...answers, allowance: 0n, tx: fabricated({ ...revoke, value: 0n }, chainId) });
      const sent = await r.readSent(`0x${"a".repeat(64)}`, { from: OWNER, to: revoke.to, data: revoke.data, afterBlock: 100n });
      expect(sent!.problems.length).toBeGreaterThan(0);
      if (chainKey === "skale-base-sepolia") expect(sent!.problems.join()).toMatch(/not accepted on SKALE Base Sepolia/);
      else expect(sent!.problems.join()).toMatch(/no Approval from the owner/);
    });
  }
});
