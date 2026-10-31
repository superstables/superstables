// The settle pause that waits for an RPC node or a facilitator to see what was just sent (budget/rpc-pause.mjs).
// Only a finite, non-negative SUPERSTABLES_TEST_RPC_WAIT_MS replaces its length; anything else leaves the pause as the rail wrote it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcPause } from "../../budget/rpc-pause.mjs";

const delayOf = (ms: number): number | undefined => {
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => { fn(); return 0; }) as unknown as typeof setTimeout);
  void rpcPause(ms);
  const delay = spy.mock.calls[0]?.[1] as number | undefined;
  spy.mockRestore();
  return delay;
};

describe("rpcPause", () => {
  afterEach(() => { delete process.env.SUPERSTABLES_TEST_RPC_WAIT_MS; });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["not a number", "soon"],
    ["negative", "-1"],
    ["infinite", "Infinity"],
  ])("keeps the rail's own length when the override is %s", (_name, value) => {
    if (value !== undefined) process.env.SUPERSTABLES_TEST_RPC_WAIT_MS = value;
    expect(delayOf(2500)).toBe(2500);
  });

  it.each([["0", 0], ["40", 40]])("uses %s ms from the override, longer or shorter than the rail's", (value, want) => {
    process.env.SUPERSTABLES_TEST_RPC_WAIT_MS = value;
    expect(delayOf(2500)).toBe(want);
    expect(delayOf(10)).toBe(want);
  });
});
