// The retired-keys list (budget/retired.mjs): where `budget rotate` records an agent address it replaced, and what every check
// that reads it does with a list it cannot trust.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const home = mkdtempSync(join(tmpdir(), "ss-retired-"));
process.env.SUPERSTABLES_HOME = home;
const { RETIRED_PATH, isRetired, readRetired, retire, retiredProblem } = (await import(new URL("../../budget/retired.mjs", import.meta.url).href)) as typeof import("../../budget/retired.mjs");
afterAll(() => rmSync(home, { recursive: true, force: true }));

const EVM = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537";
const SOL = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";
const clear = () => rmSync(RETIRED_PATH, { force: true, recursive: true });
beforeEach(clear);

describe("the list", () => {
  it("is where the plan says: keys/budget/retired.json under the home", () => {
    expect(RETIRED_PATH).toBe(join(home, "keys", "budget", "retired.json"));
  });

  it("an absent file means none retired", () => {
    expect(readRetired()).toEqual({ version: 1, retired: [] });
    expect(isRetired("evm", EVM)).toBe(false);
    expect(retiredProblem("evm", EVM)).toBe("");
  });

  it("retire writes a version 1 list, mode 600, with the rail, address, time and reason", () => {
    const at = new Date("2026-10-16T12:00:00Z");
    const entry = retire("evm", EVM, "rotate", at);
    expect(entry).toEqual({ rail: "evm", address: EVM, retiredAt: "2026-10-16T12:00:00.000Z", reason: "rotate" });
    expect(readRetired()).toEqual({ version: 1, retired: [entry] });
    expect(statSync(RETIRED_PATH).mode & 0o777).toBe(0o600);
  });

  it("retiring twice keeps the first entry", () => {
    const first = retire("evm", EVM, "rotate", new Date("2026-10-16T12:00:00Z"));
    const second = retire("evm", EVM.toLowerCase(), "rotate", new Date("2026-10-17T12:00:00Z"));
    expect(second).toEqual(first);
    expect(readRetired().retired).toHaveLength(1);
  });

  it("evm addresses compare without case", () => {
    retire("evm", EVM, "rotate");
    expect(isRetired("evm", EVM.toLowerCase())).toBe(true);
    expect(isRetired("evm", EVM.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("solana addresses compare exactly", () => {
    retire("solana", SOL, "rotate");
    expect(isRetired("solana", SOL)).toBe(true);
    expect(isRetired("solana", SOL.toLowerCase())).toBe(false);
  });

  it("a rail's address is not another rail's", () => {
    retire("evm", EVM, "rotate");
    expect(isRetired("solana", EVM)).toBe(false);
    expect(isRetired("tempo", EVM)).toBe(false);
  });

  it("the problem names the address and when it was retired", () => {
    retire("evm", EVM, "rotate", new Date("2026-10-16T12:00:00Z"));
    expect(retiredProblem("evm", EVM)).toBe(`agent ${EVM} was retired by \`budget rotate\` on 2026-10-16T12:00:00.000Z; it is never granted, funded, set up or used again`);
  });
});

describe("a list that cannot be trusted refuses, whatever the check", () => {
  const bad: [string, () => void][] = [
    ["not JSON", () => writeFileSync(RETIRED_PATH, "{garbage")],
    ["an array", () => writeFileSync(RETIRED_PATH, "[]")],
    ["version 2", () => writeFileSync(RETIRED_PATH, '{"version":2,"retired":[]}')],
    ["no retired array", () => writeFileSync(RETIRED_PATH, '{"version":1}')],
    ["an entry without an address", () => writeFileSync(RETIRED_PATH, '{"version":1,"retired":[{"rail":"evm","retiredAt":"x","reason":"rotate"}]}')],
    ["an entry on an unknown rail", () => writeFileSync(RETIRED_PATH, '{"version":1,"retired":[{"rail":"btc","address":"a","retiredAt":"x","reason":"rotate"}]}')],
    ["an entry that is not an object", () => writeFileSync(RETIRED_PATH, '{"version":1,"retired":["0x"]}')],
    ["larger than a megabyte", () => writeFileSync(RETIRED_PATH, `{"version":1,"retired":[],"pad":"${"x".repeat(1024 * 1024 + 10)}"}`)],
    ["a FIFO", () => execFileSync("mkfifo", [RETIRED_PATH])],
    ["a folder", () => mkdirSync(RETIRED_PATH)],
  ];
  for (const [name, make] of bad) {
    it(name, () => {
      mkdirSync(join(home, "keys", "budget"), { recursive: true });
      make();
      expect(() => readRetired()).toThrow(/retired-keys list .*retired\.json cannot be read/);
      expect(() => isRetired("evm", EVM)).toThrow(/cannot be read/);
      expect(retiredProblem("evm", EVM)).toMatch(/cannot be read/);
      expect(() => retire("evm", EVM, "rotate")).toThrow(/cannot be read/);
    });
  }

  it("a file that cannot be opened is not read as none retired", () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(RETIRED_PATH, '{"version":1,"retired":[]}');
    chmodSync(RETIRED_PATH, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root opens anything
      expect(retiredProblem("evm", EVM)).toMatch(/cannot be read/);
    } finally {
      chmodSync(RETIRED_PATH, 0o600);
    }
  });

  it("a FIFO is refused at once, without waiting for a writer", () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    execFileSync("mkfifo", [RETIRED_PATH]);
    const began = Date.now();
    expect(retiredProblem("evm", EVM)).toMatch(/not a regular file/);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(existsSync(RETIRED_PATH)).toBe(true);
  });
});
