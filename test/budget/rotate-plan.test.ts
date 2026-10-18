// The order of `budget rotate` (budget/rotate.mjs), driven with fake steps: what is called, in which order, what is recorded
// after each step, and where a run that stops continues. No process, no file, no chain.
import { describe, expect, it } from "vitest";
import { rotate, stoppedFinal } from "../../budget/rotate.mjs";

type Step = { code: number; result?: Record<string, any>; hosted?: string | null };
const OLD = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537";
const NEW = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd";
const SOL_OLD = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";

/** Fake steps that log every call; `fail` and `plans` change what a step answers. */
function harness(over: { fail?: Record<string, Step>; plans?: Record<string, Step>; stopped?: Record<string, boolean | "live">; provenBy?: Record<string, string>; ops?: string[]; opStates?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const saved: any[] = [];
  const answer = (name: string, def: Step): Step => over.fail?.[name] ?? def;
  const steps = {
    planChain: async (c: string) => { calls.push(`plan(${c})`); return over.plans?.[c] ?? { code: 0, result: { plan: { unreadable: [], openOps: over.ops ?? [] } }, hosted: null }; },
    retire: async () => { calls.push("retire"); return answer("retire", { code: 0 }); },
    recoverChain: async (c: string) => { calls.push(`recover(${c})`); return answer(`recover(${c})`, { code: 0, result: { tx: { sweep: "0xabc" }, revocation: { final: true, selfTx: "0xself", selfBlock: "10", ownerTx: null, ownerBlock: null } } }); },
    revoke: async () => { calls.push("revoke"); return answer("revoke", { code: 0, result: { revocation: { final: true, tx: "sigRevoke", slot: 7 } } }); },
    reconcile: async (op: string) => { calls.push(`reconcile(${op})`); return answer(`reconcile(${op})`, { code: 0, result: { state: over.opStates?.[op] ?? "settled" } }); },
    sweep: async () => { calls.push("sweep"); return answer("sweep", { code: 0, result: { final: true, tx: { usdc: "sigUsdc", sol: "sigSol" } } }); },
    confirmSweep: async (_c: string, tx: unknown) => { calls.push("confirmSweep"); return answer("confirmSweep", { code: 0, result: { final: true, tx } }); },
    readStopped: async (c: string) => { calls.push(`readStopped(${c})`); const v = over.stopped?.[c] ?? true; return { final: v === true, live: v === "live", ...(over.provenBy?.[c] ? { tx: over.provenBy[c] } : {}) }; },
    swapKey: async () => { calls.push("swap"); return answer("swap", { code: 0 }); },
    clearChain: async (c: string) => { calls.push(`clear(${c})`); return answer(`clear(${c})`, { code: 0 }); },
    setupChain: async (c: string) => { calls.push(`setup(${c})`); return answer(`setup(${c})`, { code: 0, result: { agent: NEW } }); },
    writeRecord: (r: any) => { calls.push("write"); saved.push(structuredClone(r)); },
  };
  return { calls, saved, steps };
}
const noWrites = (calls: string[]) => calls.filter((c) => c !== "write");
const base = { rail: "evm" as const, currentAgent: OLD, existing: null, chains: ["base-sepolia", "arc-testnet"] };

describe("the order", () => {
  it("plans every chain, retires, recovers every chain, swaps, clears every chain, sets up every chain", async () => {
    const h = harness();
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(0);
    expect(noWrites(h.calls)).toEqual([
      "plan(base-sepolia)", "plan(arc-testnet)", "retire",
      "recover(base-sepolia)", "recover(arc-testnet)", "swap",
      "clear(base-sepolia)", "clear(arc-testnet)", "setup(base-sepolia)", "setup(arc-testnet)",
    ]);
    expect(r.fields).toMatchObject({ state: "rotated", oldAgent: OLD, newAgent: NEW, retired: true });
    const proof = { final: true, selfTx: "0xself", selfBlock: "10", ownerTx: null, ownerBlock: null };
    expect(r.fields.chains).toEqual([{ chain: "base-sepolia", recovered: true, setUp: true, hosted: null, revocation: proof }, { chain: "arc-testnet", recovered: true, setUp: true, hosted: null, revocation: proof }]);
  });

  it("the old address is retired before the first send", async () => {
    const h = harness();
    await rotate({ ...base, steps: h.steps });
    expect(h.calls.indexOf("retire")).toBeLessThan(h.calls.findIndex((c) => c.startsWith("recover(")));
  });

  it("the record is written after each step, and ends finished", async () => {
    const h = harness();
    await rotate({ ...base, steps: h.steps, now: () => new Date("2026-10-16T12:00:00Z") });
    // retire, 2 recovers, swap, 2 clears, 2 setups, finish
    expect(h.calls.filter((c) => c === "write")).toHaveLength(9);
    expect(h.saved[0]).toMatchObject({ retiredAt: "2026-10-16T12:00:00.000Z" });
    expect(h.saved[0].chains["base-sepolia"].recoveredAt).toBeUndefined();
    expect(h.saved[1].chains["base-sepolia"].recoveredAt).toBeTruthy();
    expect(h.saved[3].swappedAt).toBeTruthy();
    expect(h.saved.at(-1)).toMatchObject({ version: 1, rail: "evm", oldAgent: OLD, newAgent: NEW });
    expect(h.saved.at(-1).finishedAt).toBeTruthy();
    // the writes sit between the steps, never ahead of them
    const order = h.calls.join(" ");
    expect(order).toMatch(/retire write recover\(base-sepolia\) write recover\(arc-testnet\) write swap write clear\(base-sepolia\) write/);
  });

  it("--plan runs only the plan steps and records nothing", async () => {
    const h = harness();
    const r = await rotate({ ...base, steps: h.steps, plan: true });
    expect(r.code).toBe(0);
    expect(r.fields).toMatchObject({ state: "planned", oldAgent: OLD, retired: false });
    expect(h.calls).toEqual(["plan(base-sepolia)", "plan(arc-testnet)"]);
  });

  it("a plan that finds a journal it cannot read refuses before the old address is retired", async () => {
    const h = harness({ plans: { "arc-testnet": { code: 0, result: { plan: { unreadable: [{ file: "ops/x.json", why: "it is not valid JSON" }] } } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.reason).toContain("ops/x.json");
    expect(noWrites(h.calls)).toEqual(["plan(base-sepolia)", "plan(arc-testnet)"]);
  });

  it("a plan that fails stops before anything is retired", async () => {
    const h = harness({ plans: { "base-sepolia": { code: 1, result: { reason: "no rpc" } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(1);
    expect(noWrites(h.calls)).toEqual(["plan(base-sepolia)"]);
  });

  it("a retire that fails sends nothing", async () => {
    const h = harness({ fail: { retire: { code: 1, result: { reason: "the list cannot be written" } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(1);
    expect(noWrites(h.calls)).toEqual(["plan(base-sepolia)", "plan(arc-testnet)", "retire"]);
  });

  it("a hosted chain is recorded with its site, and the result tells the owner to remove the old agent there", async () => {
    const h = harness({ plans: { "base-sepolia": { code: 0, result: { plan: { unreadable: [] } }, hosted: "https://www.superstables.com" } } });
    const r = await rotate({ ...base, chains: ["base-sepolia"], steps: h.steps });
    expect(r.fields.chains).toEqual([{ chain: "base-sepolia", recovered: true, setUp: true, hosted: "https://www.superstables.com", revocation: expect.objectContaining({ final: true }) }]);
    expect(r.fields.next).toContain(`remove agent ${OLD}`);
    expect(r.fields.next).toContain("https://www.superstables.com");
  });
});

describe("a rotation that stops, and the run after it", () => {
  it("recover failing on the second chain stops there: no swap, no clear, no setup", async () => {
    const h = harness({ fail: { "recover(arc-testnet)": { code: 5, result: { reason: "an operation can still move money" } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields).toMatchObject({ state: "incomplete", oldAgent: OLD, retired: true });
    expect(r.fields.reason).toContain("arc-testnet");
    expect(noWrites(h.calls)).toEqual(["plan(base-sepolia)", "plan(arc-testnet)", "retire", "recover(base-sepolia)", "recover(arc-testnet)"]);
    expect(h.saved.at(-1).chains["base-sepolia"].recoveredAt).toBeTruthy();
    expect(h.saved.at(-1).chains["arc-testnet"].recoveredAt).toBeUndefined();
    expect(h.saved.at(-1).swappedAt).toBeUndefined();
  });

  it("the next run recovers only the chain that was not recovered", async () => {
    const first = harness({ fail: { "recover(arc-testnet)": { code: 5 } } });
    await rotate({ ...base, steps: first.steps });
    const record = { ...first.saved.at(-1), path: "/rotations/evm.json" };
    const second = harness({ stopped: { "base-sepolia": true } });
    const r = await rotate({ ...base, existing: record, steps: second.steps });
    expect(r.code).toBe(0);
    expect(noWrites(second.calls)).toEqual([
      "plan(base-sepolia)", "plan(arc-testnet)", "retire", "readStopped(base-sepolia)", "recover(arc-testnet)", "swap",
      "clear(base-sepolia)", "clear(arc-testnet)", "setup(base-sepolia)", "setup(arc-testnet)",
    ]);
    expect(r.fields.resumed).toBe(true);
  });

  it("adversarial: a chain recorded as recovered whose allowance reads above 0 is recovered again", async () => {
    const first = harness({ fail: { "recover(arc-testnet)": { code: 5 } } });
    await rotate({ ...base, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": "live" } });
    await rotate({ ...base, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).toContain("recover(base-sepolia)");
    expect(second.calls).toContain("recover(arc-testnet)");
  });

  it("setup failing on the second chain after the swap: the next run repeats neither the swap nor a clear, and sets that chain up", async () => {
    const first = harness({ fail: { "setup(arc-testnet)": { code: 1, result: { reason: "the owner page timed out" } } } });
    const stopped = await rotate({ ...base, steps: first.steps });
    expect(stopped.code).toBe(1);
    expect(stopped.fields.state).toBe("incomplete");
    expect(first.saved.at(-1)).toMatchObject({ swappedAt: expect.any(String) });
    // after the swap the key file holds the new key
    const second = harness();
    const r = await rotate({ ...base, currentAgent: NEW, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.code).toBe(0);
    // the retire is repeated (it keeps an entry that is there, and puts back one that was removed); nothing else is
    expect(noWrites(second.calls)).toEqual(["retire", "setup(arc-testnet)"]);
    expect(r.fields).toMatchObject({ state: "rotated", oldAgent: OLD, newAgent: NEW });
  });

  it("a rotation that stopped between its clears continues with the chain not cleared", async () => {
    const first = harness({ fail: { "clear(arc-testnet)": { code: 1 } } });
    await rotate({ ...base, steps: first.steps });
    const second = harness();
    await rotate({ ...base, currentAgent: NEW, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(noWrites(second.calls)).toEqual(["retire", "clear(arc-testnet)", "setup(base-sepolia)", "setup(arc-testnet)"]);
  });

  it("an unfinished record for another old address is refused, and names its path", async () => {
    const record = { version: 1, rail: "evm", oldAgent: "0x1111111111111111111111111111111111111111", startedAt: "2026-10-01T00:00:00Z", chains: { "base-sepolia": {} }, path: "/home/rotations/evm-0x1111.json" };
    const h = harness();
    const r = await rotate({ ...base, existing: record, steps: h.steps });
    expect(r.code).toBe(3);
    expect(r.fields.state).toBe("refused_precheck");
    expect(r.fields.reason).toContain("/home/rotations/evm-0x1111.json");
    expect(h.calls).toEqual([]);
  });

  it("the record's old address is compared without case on evm", async () => {
    const record = { version: 1, rail: "evm", oldAgent: OLD.toLowerCase(), startedAt: "2026-10-01T00:00:00Z", chains: { "base-sepolia": {}, "arc-testnet": {} }, path: "/r.json" };
    const h = harness();
    const r = await rotate({ ...base, existing: record, steps: h.steps });
    expect(r.code).toBe(0);
  });
});

describe("solana", () => {
  const sol = { rail: "solana" as const, currentAgent: SOL_OLD, existing: null, chains: ["devnet"] };

  it("plan, retire, revoke, reconcile each open operation, sweep, swap, clear, set up", async () => {
    const h = harness({ ops: ["op-1", "op-2"] });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.code).toBe(0);
    expect(noWrites(h.calls)).toEqual(["plan(devnet)", "retire", "revoke", "reconcile(op-1)", "reconcile(op-2)", "sweep", "swap", "clear(devnet)", "setup(devnet)"]);
    expect(r.fields).toMatchObject({ state: "rotated", oldAgent: SOL_OLD, retired: true });
  });

  it("an operation that stays unknown stops it before the sweep", async () => {
    const h = harness({ ops: ["op-1"], opStates: { "op-1": "unknown" } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.state).toBe("incomplete");
    expect(h.calls).not.toContain("sweep");
    expect(h.calls).not.toContain("swap");
  });

  it("a revoke that fails stops it", async () => {
    const h = harness({ fail: { revoke: { code: 3, result: { reason: "the owner rejected it" } } } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.code).toBe(3);
    expect(h.calls).not.toContain("sweep");
    expect(h.calls).not.toContain("swap");
  });

  it("a run after the revoke landed does not ask the owner again while the delegate reads gone", async () => {
    const first = harness({ ops: ["op-1"], opStates: { "op-1": "unknown" } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: true } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.code).toBe(0);
    expect(second.calls).not.toContain("revoke");
    expect(second.calls).toContain("sweep");
  });
});

// ---- no swap, clear, setup or completion before a final, agreed zero-authority verdict ----------------------------------------
const landed = { final: false, selfTx: "0xself", selfBlock: "10", ownerTx: null, ownerBlock: null };
const NOT_AFTER_REVOKE = ["swap", "clear(base-sepolia)", "setup(base-sepolia)"];

describe("a revoke that is not final yet", () => {
  const evm = { rail: "evm" as const, currentAgent: OLD, existing: null, chains: ["base-sepolia"] };

  it("an evm self-revoke in a block but not final: no swap, clear or setup, and the record keeps the transaction", async () => {
    const h = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { tx: { sweep: "0xabc" }, revocation: landed } } } });
    const r = await rotate({ ...evm, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields).toMatchObject({ state: "incomplete", oldAgent: OLD, retired: true });
    expect(r.fields.reason).toMatch(/not final/);
    expect(r.fields.next).toMatch(/superstables budget status --rail evm --chain base-sepolia/);
    expect(r.fields.next).toMatch(/does not send them again/);
    for (const c of NOT_AFTER_REVOKE) expect(h.calls).not.toContain(c);
    const kept = h.saved.at(-1);
    expect(kept.swappedAt).toBeUndefined();
    expect(kept.finishedAt).toBeUndefined();
    expect(kept.chains["base-sepolia"].recoveredAt).toBeUndefined();
    expect(kept.chains["base-sepolia"].revocation).toMatchObject({ final: false, selfTx: "0xself", selfBlock: "10" });
    expect(r.fields.chains).toEqual([{ chain: "base-sepolia", recovered: false, setUp: false, hosted: null, revocation: expect.objectContaining({ final: false }) }]);
  });

  it("an evm owner revoke in a block but not final is the same", async () => {
    const owner = { final: false, selfTx: null, selfBlock: null, ownerTx: "0xowner", ownerBlock: "12" };
    const h = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: owner } } } });
    const r = await rotate({ ...evm, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.state).toBe("incomplete");
    for (const c of NOT_AFTER_REVOKE) expect(h.calls).not.toContain(c);
    expect(h.saved.at(-1).chains["base-sepolia"].revocation).toMatchObject({ ownerTx: "0xowner", ownerBlock: "12" });
  });

  it("a recover that says nothing about finality is not proof", async () => {
    const h = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { tx: { sweep: "0xabc" } } } } });
    const r = await rotate({ ...evm, steps: h.steps });
    expect(r.fields.state).toBe("incomplete");
    for (const c of NOT_AFTER_REVOKE) expect(h.calls).not.toContain(c);
  });

  it("on two chains, the chain that is not final stops it before any swap", async () => {
    const h = harness({ fail: { "recover(arc-testnet)": { code: 0, result: { revocation: landed } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.fields.state).toBe("incomplete");
    expect(r.fields.reason).toContain("arc-testnet");
    expect(h.calls).not.toContain("swap");
    expect(h.saved.at(-1).chains["base-sepolia"].recoveredAt).toBeTruthy();
    expect(h.saved.at(-1).chains["arc-testnet"].recoveredAt).toBeUndefined();
  });

  it("a chain that is not final does not hold back the revoke on the next chain", async () => {
    const h = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.state).toBe("incomplete");
    expect(noWrites(h.calls)).toEqual(["plan(base-sepolia)", "plan(arc-testnet)", "retire", "recover(base-sepolia)", "recover(arc-testnet)"]);
    for (const c of NOT_AFTER_REVOKE) expect(h.calls).not.toContain(c);
    expect(r.fields.reason).toContain("base-sepolia");
    expect(r.fields.reason).not.toContain("arc-testnet");
    expect(h.saved.at(-1).chains["base-sepolia"].recoveredAt).toBeUndefined();
    expect(h.saved.at(-1).chains["arc-testnet"].recoveredAt).toBeTruthy();
    expect(r.fields.chains.map((c: any) => [c.chain, c.recovered])).toEqual([["base-sepolia", false], ["arc-testnet", true]]);
  });

  it("when several chains wait, the reason and next name each of them", async () => {
    const h = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } }, "recover(arc-testnet)": { code: 0, result: { revocation: landed } } } });
    const r = await rotate({ ...base, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.reason).toMatch(/base-sepolia.*arc-testnet/);
    expect(r.fields.next).toContain("superstables budget status --rail evm --chain base-sepolia");
    expect(r.fields.next).toContain("superstables budget status --rail evm --chain arc-testnet");
    expect(h.calls).not.toContain("swap");
  });

  it("a recorded chain that is still not final does not stop the other chain from being checked", async () => {
    const first = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    await rotate({ ...base, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": false, "arc-testnet": "live" } });
    const r = await rotate({ ...base, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.fields.state).toBe("incomplete");
    expect(second.calls).toContain("readStopped(base-sepolia)");
    expect(second.calls).toContain("readStopped(arc-testnet)");
    expect(second.calls).toContain("recover(arc-testnet)");
    expect(second.calls).not.toContain("recover(base-sepolia)");
    expect(second.calls).not.toContain("swap");
  });

  it("resume: records the transaction that proved the revoke final when it is not the recorded one", async () => {
    const first = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    await rotate({ ...evm, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": true }, provenBy: { "base-sepolia": "0xhand" } });
    const r = await rotate({ ...evm, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.fields.state).toBe("rotated");
    expect(second.saved.at(-1).chains["base-sepolia"].revocation).toMatchObject({ selfTx: "0xself", provenBy: "0xhand" });
  });

  it("resume: polls the recorded revoke and does not send recover again; once final it swaps and finishes", async () => {
    const first = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    await rotate({ ...evm, steps: first.steps });
    const record = { ...first.saved.at(-1), path: "/r.json" };
    const waiting = harness({ stopped: { "base-sepolia": false } });
    const still = await rotate({ ...evm, existing: record, steps: waiting.steps });
    expect(still.fields.state).toBe("incomplete");
    expect(waiting.calls).toContain("readStopped(base-sepolia)");
    expect(waiting.calls).not.toContain("recover(base-sepolia)");
    for (const c of NOT_AFTER_REVOKE) expect(waiting.calls).not.toContain(c);
    const done = harness({ stopped: { "base-sepolia": true } });
    const r = await rotate({ ...evm, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: done.steps });
    expect(r.code).toBe(0);
    expect(r.fields.state).toBe("rotated");
    expect(done.calls).not.toContain("recover(base-sepolia)");
    expect(noWrites(done.calls)).toEqual(["plan(base-sepolia)", "retire", "readStopped(base-sepolia)", "swap", "clear(base-sepolia)", "setup(base-sepolia)"]);
  });

  it("a status read of another agent (a hand-edited public file) is not proof for the old agent: the rotation stays incomplete", async () => {
    const first = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    await rotate({ ...evm, steps: first.steps });
    // the read is final and agreed at 0, but of the agent the file names now
    const read = (agent: string | null) => ({ ok: true, agent, remaining: "0", revoked: true, lastOwnerAction: { action: "revoke", tx: "0xself", final: true } });
    const other = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd";
    const run = async (agent: string | null) => {
      const h = harness();
      h.steps.readStopped = async (c: string, entry?: any) => { h.calls.push(`readStopped(${c})`); return stoppedFinal(read(agent), entry?.revocation, "evm", OLD); };
      return { h, r: await rotate({ ...evm, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: h.steps }) };
    };
    for (const agent of [other, null]) {
      const { h, r } = await run(agent);
      expect(r.code).toBe(5);
      expect(r.fields.state).toBe("incomplete");
      for (const c of NOT_AFTER_REVOKE) expect(h.calls).not.toContain(c);
      expect(h.calls).not.toContain("recover(base-sepolia)");
    }
    // the old agent's own read, in another letter case, is the same agent
    const { h, r } = await run(OLD.toLowerCase());
    expect(r.fields.state).toBe("rotated");
    expect(h.calls).toContain("swap");
  });

  it("solana compares the agent exactly and evm without case", () => {
    const read = (agent: string) => ({ ok: true, agent, remaining: "0", revoked: true, lastOwnerAction: { action: "revoke", tx: "sig", final: true } });
    expect(stoppedFinal(read(SOL_OLD), { tx: "sig" }, "solana", SOL_OLD).final).toBe(true);
    expect(stoppedFinal(read(SOL_OLD.toLowerCase()), { tx: "sig" }, "solana", SOL_OLD).final).toBe(false);
    expect(stoppedFinal(read(OLD), { selfTx: "0xself" }, "evm", OLD.toUpperCase().replace("0X", "0x")).final).toBe(true);
    expect(stoppedFinal({ ...read(OLD), agent: undefined }, { selfTx: "0xself" }, "evm", OLD)).toEqual({ final: false, live: false });
  });

  it("reorg: the recorded revoke is gone and the allowance reads live again: no completion, recover runs again", async () => {
    const first = harness({ fail: { "recover(base-sepolia)": { code: 0, result: { revocation: landed } } } });
    await rotate({ ...evm, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": "live" } });
    const r = await rotate({ ...evm, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls.indexOf("recover(base-sepolia)")).toBeGreaterThan(second.calls.indexOf("readStopped(base-sepolia)"));
    expect(second.calls.indexOf("swap")).toBeGreaterThan(second.calls.indexOf("recover(base-sepolia)"));
    expect(r.fields.state).toBe("rotated");
  });

  it("reorg after a final record: a chain recorded as recovered that reads live again is not skipped", async () => {
    const first = harness({ fail: { "recover(arc-testnet)": { code: 5 } } });
    await rotate({ ...base, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": "live" } });
    await rotate({ ...base, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).toContain("recover(base-sepolia)");
  });

  it("a chain recorded as recovered whose final proof cannot be read stops it, without sending", async () => {
    const first = harness({ fail: { "recover(arc-testnet)": { code: 5 } } });
    await rotate({ ...base, steps: first.steps });
    const second = harness({ stopped: { "base-sepolia": false } });
    const r = await rotate({ ...base, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.fields.state).toBe("incomplete");
    expect(second.calls).not.toContain("recover(base-sepolia)");
    expect(second.calls).not.toContain("swap");
  });

  it("a record from an earlier version (recovered, no evidence) is accepted only when the chain proves the revoke final", async () => {
    const record = { version: 1, rail: "evm", oldAgent: OLD, startedAt: "2026-10-01T00:00:00Z", retiredAt: "2026-10-01T00:00:01Z", chains: { "base-sepolia": { recoveredAt: "2026-10-01T00:00:02Z" } }, path: "/r.json" };
    const h = harness({ stopped: { "base-sepolia": false } });
    const r = await rotate({ ...evm, existing: record, steps: h.steps });
    expect(r.fields.state).toBe("incomplete");
    expect(h.calls).not.toContain("swap");
  });
});

describe("solana: a revoke that landed but is not final", () => {
  const sol = { rail: "solana" as const, currentAgent: SOL_OLD, existing: null, chains: ["devnet"] };
  const landedSol = { final: false, tx: "sigRevoke", slot: 7 };

  it("no sweep, swap, clear or setup; the signature and slot are kept", async () => {
    const h = harness({ fail: { revoke: { code: 0, result: { revocation: landedSol } } } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields).toMatchObject({ state: "incomplete", retired: true });
    expect(r.fields.next).toMatch(/superstables budget status --rail solana/);
    for (const c of ["sweep", "swap", "clear(devnet)", "setup(devnet)"]) expect(h.calls).not.toContain(c);
    expect(h.saved.at(-1).chains.devnet.revocation).toMatchObject({ final: false, tx: "sigRevoke", slot: 7 });
    expect(h.saved.at(-1).chains.devnet.revokedAt).toBeUndefined();
  });

  it("resume polls the recorded signature: it does not send the revoke again, and goes on once final", async () => {
    const first = harness({ fail: { revoke: { code: 0, result: { revocation: landedSol } } } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: true } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).not.toContain("revoke");
    expect(second.calls).toContain("sweep");
    expect(r.fields.state).toBe("rotated");
  });

  it("resume while it is still not final stops without sending", async () => {
    const first = harness({ fail: { revoke: { code: 0, result: { revocation: landedSol } } } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: false } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(r.fields.state).toBe("incomplete");
    for (const c of ["revoke", "sweep", "swap"]) expect(second.calls).not.toContain(c);
  });

  it("reorg: a delegate that reads live again is revoked again before anything else", async () => {
    const first = harness({ fail: { revoke: { code: 0, result: { revocation: landedSol } } } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: "live" } });
    await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls.indexOf("revoke")).toBeGreaterThan(-1);
    expect(second.calls.indexOf("sweep")).toBeGreaterThan(second.calls.indexOf("revoke"));
  });

  it("a revoke result with no finality at all is not proof", async () => {
    const h = harness({ fail: { revoke: { code: 0, result: {} } } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.fields.state).toBe("incomplete");
    expect(h.calls).not.toContain("sweep");
  });
});

describe("solana: the sweep keeps its transactions and is final before the funds count as recovered", () => {
  const sol = { rail: "solana" as const, currentAgent: SOL_OLD, existing: null, chains: ["devnet"] };
  const sent = { usdc: "sigUsdc", sol: "sigSol" };

  it("a sweep whose transactions are not final leaves the rotation incomplete with the signatures kept", async () => {
    const h = harness({ fail: { sweep: { code: 0, result: { final: false, tx: sent } } } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.code).toBe(5);
    expect(r.fields.state).toBe("incomplete");
    expect(h.calls).not.toContain("swap");
    expect(h.saved.at(-1).chains.devnet.sweepTx).toEqual(sent);
    expect(h.saved.at(-1).chains.devnet.sweptAt).toBeUndefined();
  });

  it("resume reconciles the recorded signatures instead of sweeping again", async () => {
    const first = harness({ fail: { sweep: { code: 0, result: { final: false, tx: sent } } } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: true } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).toContain("confirmSweep");
    expect(second.calls).not.toContain("sweep");
    expect(r.fields.state).toBe("rotated");
    expect(second.saved.at(-1).chains.devnet.sweepTx).toEqual(sent);
  });

  it("a recorded transfer that no endpoint has is swept again; its signatures stay as evidence", async () => {
    const first = harness({ fail: { sweep: { code: 0, result: { final: false, tx: sent } } } });
    await rotate({ ...sol, steps: first.steps });
    const second = harness({ stopped: { devnet: true }, fail: { confirmSweep: { code: 0, result: { final: false, state: "not_found", tx: sent } } } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).toContain("confirmSweep");
    expect(second.calls).toContain("sweep");
    expect(r.fields.state).toBe("rotated");
    expect(second.saved.at(-1).chains.devnet.sweepEarlier).toEqual(["sigUsdc", "sigSol"]);
  });

  it("a recorded transfer that failed on chain moved nothing: it is swept again, and the failed signatures stay as evidence", async () => {
    const first = harness({ fail: { sweep: { code: 1, result: { state: "failed", tx: sent, reason: "a transfer failed on chain" } } } });
    await rotate({ ...sol, steps: first.steps });
    expect(first.saved.at(-1).chains.devnet.sweepTx).toEqual(sent);
    const second = harness({ stopped: { devnet: true }, fail: { confirmSweep: { code: 0, result: { final: false, state: "failed", tx: sent, reason: "a transfer failed on chain" } } } });
    const r = await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    expect(second.calls).toContain("sweep");
    expect(r.code).toBe(0);
    expect(r.fields.state).toBe("rotated");
    const entry = second.saved.at(-1).chains.devnet;
    expect(entry.sweepEarlier).toEqual(["sigUsdc", "sigSol"]);
    expect(entry.sweepTx).toEqual({ usdc: "sigUsdc", sol: "sigSol" });
  });

  it("two failed sweeps keep both sets of signatures", async () => {
    const first = harness({ fail: { sweep: { code: 1, result: { tx: sent } } } });
    await rotate({ ...sol, steps: first.steps });
    const later = { usdc: "sigUsdc2", sol: "sigSol2" };
    const second = harness({ fail: { confirmSweep: { code: 0, result: { state: "failed" } }, sweep: { code: 1, result: { tx: later } } } });
    await rotate({ ...sol, existing: { ...first.saved.at(-1), path: "/r.json" }, steps: second.steps });
    const third = harness({ fail: { confirmSweep: { code: 0, result: { state: "failed" } } } });
    await rotate({ ...sol, existing: { ...second.saved.at(-1), path: "/r.json" }, steps: third.steps });
    expect(third.saved.at(-1).chains.devnet.sweepEarlier).toEqual(["sigUsdc", "sigSol", "sigUsdc2", "sigSol2"]);
  });

  it("a sweep that sent nothing says so in the result", async () => {
    const h = harness({ fail: { sweep: { code: 0, result: { final: true, tx: { usdc: null, sol: null } } } } });
    const r = await rotate({ ...sol, steps: h.steps });
    expect(r.fields.state).toBe("rotated");
    expect(r.fields.reason).toMatch(/sweep on devnet sent nothing/);
    const other = await rotate({ ...sol, steps: harness().steps });
    expect(other.fields.reason).toBeUndefined();
  });

  it("a sweep that fails after sending keeps the signatures it sent", async () => {
    const first = harness({ fail: { sweep: { code: 5, result: { state: "unknown", tx: sent, reason: "late" } } } });
    await rotate({ ...sol, steps: first.steps });
    expect(first.saved.at(-1).chains.devnet.sweepTx).toEqual(sent);
  });
});
