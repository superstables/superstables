// A purchase journal that is there but cannot be used is never read as "no purchase": that purchase may have paid. Every rail's
// reader stops the command with an unknown outcome (exit 5), signs and sends nothing, and leaves the file as it is.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardedNode } from "../helpers/guarded-process.js";

const DIRS = { evm: "evm-base-sepolia", tempo: "tempo-moderato", solana: "solana-devnet" } as const;
const DIRECT = {
  evm: ["--import=tsx", "budget/evm/reconcile.ts", "--op", "bad"],
  tempo: ["--import=tsx", "budget/tempo/reconcile.ts", "--op", "bad"],
  solana: ["budget/solana/reconcile.mjs", "--op", "bad"],
} as const;
const CUT = '{"state":"submit';

const homes: string[] = [];
// every test has its own home, so the tests of a file run side by side; the homes go at the end
afterAll(() => {
  for (const home of homes.splice(0)) {
    try { chmodSync(join(home, "locked"), 0o700); } catch {} // the blocked directory must be searchable again to be removed
    rmSync(home, { recursive: true, force: true });
  }
});

/** A home whose journal `bad` is `text` on every rail. */
function home(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "journal-unreadable-"));
  homes.push(dir);
  for (const d of Object.values(DIRS)) {
    mkdirSync(join(dir, "budget/ops", d), { recursive: true });
    writeFileSync(join(dir, "budget/ops", d, "bad.json"), text);
  }
  const guardLog = join(dir, "network.log");
  writeFileSync(guardLog, "");
  const file = (rail: keyof typeof DIRS) => join(dir, "budget/ops", DIRS[rail], "bad.json");
  return { dir, file, env: { HOME: dir, SUPERSTABLES_HOME: dir, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog }, guard: () => readFileSync(guardLog, "utf8") };
}
const resultOf = (output: string) => JSON.parse(output.split("\n").filter((l) => l.startsWith("RESULT ")).pop()!.slice(7));

describe.concurrent("a journal that is not valid JSON", () => {
  it.each(["evm", "tempo", "solana"] as const)("stops %s reconcile with unknown, exit 5, and keeps the file", async (rail) => {
    const h = home(CUT);
    const child = await guardedNode([...DIRECT[rail]], h.env);
    expect(child.code, child.output).toBe(5);
    expect(resultOf(child.output)).toMatchObject({ rail, op: "bad", state: "unknown", reason: expect.stringMatching(/^journal_unreadable/) });
    expect(child.output).not.toMatch(/SyntaxError|Unexpected|at .*\.(ts|mjs):\d+/);
    expect(readFileSync(h.file(rail), "utf8")).toBe(CUT);
    expect(h.guard()).toBe("");
  }, 60_000);

  it.each(["null", "[]", "7"])("treats %s as unreadable too", async (text) => {
    const h = home(text);
    const child = await guardedNode([...DIRECT.tempo], h.env);
    expect(child.code, child.output).toBe(5);
    expect(resultOf(child.output)).toMatchObject({ state: "unknown", reason: expect.stringMatching(/^journal_unreadable/) });
    expect(readFileSync(h.file("tempo"), "utf8")).toBe(text);
  }, 60_000);

  it("stops the tempo buy before it reads the agent's key, asks the seller or signs", async () => {
    const h = home(CUT);
    const child = await guardedNode(["--import=tsx", "budget/tempo/buy.ts", "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(resultOf(child.output)).toMatchObject({ state: "unknown", reason: expect.stringMatching(/^journal_unreadable/) });
    expect(readFileSync(h.file("tempo"), "utf8")).toBe(CUT);
    expect(h.guard()).toBe("");
  }, 60_000);

  it("stops the evm journal reader that buy and recover --op call before any send", async () => {
    const h = home(CUT);
    const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", 'const { readJournal } = await import("./budget/evm/ops.ts"); readJournal("bad"); console.log("READ");'], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).not.toContain("READ");
    expect(resultOf(child.output)).toMatchObject({ rail: "evm", state: "unknown", reason: expect.stringMatching(/^journal_unreadable/) });
    expect(readFileSync(h.file("evm"), "utf8")).toBe(CUT);
  }, 60_000);

  it.each(["evm", "tempo", "solana"] as const)("makes the dispatcher's reconcile --rail %s answer unknown, not 'no journal'", async (rail) => {
    const h = home(CUT);
    const child = await guardedNode(["budget/cli.mjs", "reconcile", "--rail", rail, "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).toMatch(/journal_unreadable/);
    expect(child.output).not.toMatch(/no journal for op/);
    expect(readFileSync(h.file(rail), "utf8")).toBe(CUT);
  }, 60_000);

  it("still calls a journal that is not there bad input", async () => {
    const h = home(CUT);
    const child = await guardedNode(["budget/cli.mjs", "reconcile", "--rail", "tempo", "--op", "missing"], h.env);
    expect(child.code, child.output).toBe(2);
    expect(child.output).toMatch(/no journal for op missing/);
  }, 60_000);

  it("keeps the dispatcher's buy answer op_already_unreadable", async () => {
    const h = home(CUT);
    const child = await guardedNode(["budget/cli.mjs", "buy", "--rail", "tempo", "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).toMatch(/op_already_unreadable/);
    expect(readFileSync(h.file("tempo"), "utf8")).toBe(CUT);
    expect(h.guard()).toBe("");
  }, 60_000);
});

// A journal path that cannot be reached is not a journal that is not there: the dispatcher must not call the op "no journal",
// or unused, because stat or open failed with something other than ENOENT. The symlinks stand in for a path the rail can
// neither read nor rule out. (As root, a directory without search permission still opens, so that case is skipped.)
const isRoot = process.getuid?.() === 0;
const BLOCKS = [
  ["a symlink loop (ELOOP)", "ELOOP", true],
  ["a link into a directory without search permission (EACCES)", "EACCES", !isRoot],
] as const;

function blockedHome(kind: "ELOOP" | "EACCES") {
  const h = home(CUT);
  for (const rail of ["evm", "tempo", "solana"] as const) {
    rmSync(h.file(rail));
    if (kind === "ELOOP") symlinkSync("bad.json", h.file(rail));
    else {
      mkdirSync(join(h.dir, "locked"), { recursive: true });
      writeFileSync(join(h.dir, "locked", `${rail}.json`), CUT);
      symlinkSync(join(h.dir, "locked", `${rail}.json`), h.file(rail));
    }
  }
  if (kind === "EACCES") chmodSync(join(h.dir, "locked"), 0o000);
  return h;
}

describe.concurrent.each(BLOCKS)("a journal behind %s", (_name, kind, runs) => {
  it.skipIf(!runs).each(["evm", "tempo", "solana"] as const)("makes the dispatcher's reconcile --rail %s answer unknown, not 'no journal'", async (rail) => {
    const h = blockedHome(kind);
    const child = await guardedNode(["budget/cli.mjs", "reconcile", "--rail", rail, "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).toMatch(new RegExp(`journal_unreadable.*${kind}`));
    expect(child.output).not.toMatch(/no journal for op/);
    expect(h.guard()).toBe("");
  }, 60_000);

  it.skipIf(!runs).each(["evm", "tempo", "solana"] as const)("makes the dispatcher's buy --rail %s unknown with no setup, never an unused op", async (rail) => {
    const h = blockedHome(kind);
    const child = await guardedNode(["budget/cli.mjs", "buy", "--rail", rail, "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).toMatch(/op_already_unreadable/);
    expect(child.output).toMatch(/"paid":null/);
    expect(child.output).not.toMatch(/Nothing was signed or paid|refused_precheck/);
    expect(h.guard()).toBe("");
  }, 60_000);
});

// A journal whose JSON is not an object is no journal the rail can use (journal.mjs readJournalFile), so the dispatcher must not
// read it as a journal with an unknown state, which lets the setup check call the op unpaid. No setup files here: that is the check.
describe.concurrent.each(["7", "[]", '"x"'])("a journal holding %s", (text) => {
  it.each(["evm", "tempo", "solana"] as const)("makes the dispatcher's buy --rail %s unknown with no setup, never an unused op", async (rail) => {
    const h = home(text);
    const child = await guardedNode(["budget/cli.mjs", "buy", "--rail", rail, "--url", "http://127.0.0.1:9/x", "--max", "0.01", "--op", "bad"], h.env);
    expect(child.code, child.output).toBe(5);
    expect(child.output).toMatch(/op_already_unreadable/);
    expect(child.output).toMatch(/"paid":null/);
    expect(child.output).not.toMatch(/Nothing was signed or paid|refused_precheck/);
    expect(readFileSync(h.file(rail), "utf8")).toBe(text);
    expect(h.guard()).toBe("");
  }, 60_000);
});

describe.concurrent("a journal that is not there", () => {
  it.each(["evm", "tempo", "solana"] as const)("is still bad input for the dispatcher's reconcile --rail %s", async (rail) => {
    const h = home(CUT);
    const child = await guardedNode(["budget/cli.mjs", "reconcile", "--rail", rail, "--op", "missing"], h.env);
    expect(child.code, child.output).toBe(2);
    expect(child.output).toMatch(/no journal for op missing/);
  }, 60_000);
});
