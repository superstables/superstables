// The order of `budget rotate` (budget/rotate.mjs), driven with fake steps: what is called, in which order, what is recorded
// after each step, and where a run that stops continues. No process, no file, no chain.
import { describe, expect, it } from "vitest";
import { rotate } from "../../budget/rotate.mjs";

type Step = { code: number; result?: Record<string, any>; hosted?: string | null };
const OLD = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537";
const NEW = "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd";
const SOL_OLD = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";

/** Fake steps that log every call; `fail` and `plans` change what a step answers. */
function harness(over: { fail?: Record<string, Step>; plans?: Record<string, Step>; stopped?: Record<string, boolean>; ops?: string[]; opStates?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const saved: any[] = [];
  const answer = (name: string, def: Step): Step => over.fail?.[name] ?? def;
  const steps = {
    planChain: async (c: string) => { calls.push(`plan(${c})`); return over.plans?.[c] ?? { code: 0, result: { plan: { unreadable: [], openOps: over.ops ?? [] } }, hosted: null }; },
    retire: async () => { calls.push("retire"); return answer("retire", { code: 0 }); },
    recoverChain: async (c: string) => { calls.push(`recover(${c})`); return answer(`recover(${c})`, { code: 0, result: { tx: { sweep: "0xabc" } } }); },
    revoke: async () => { calls.push("revoke"); return answer("revoke", { code: 0, result: {} }); },
    reconcile: async (op: string) => { calls.push(`reconcile(${op})`); return answer(`reconcile(${op})`, { code: 0, result: { state: over.opStates?.[op] ?? "settled" } }); },
    sweep: async () => { calls.push("sweep"); return answer("sweep", { code: 0, result: {} }); },
    readStopped: async (c: string) => { calls.push(`readStopped(${c})`); return over.stopped?.[c] ?? true; },
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
    expect(r.fields.chains).toEqual([{ chain: "base-sepolia", recovered: true, setUp: true, hosted: null }, { chain: "arc-testnet", recovered: true, setUp: true, hosted: null }]);
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
    expect(r.fields.chains).toEqual([{ chain: "base-sepolia", recovered: true, setUp: true, hosted: "https://www.superstables.com" }]);
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
    const second = harness({ stopped: { "base-sepolia": false } });
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
