// The OS keychain module for budget agent keys, against fake `secret-tool` and `security` scripts on PATH. The secret reaches
// them on standard input only; the recorded argv never holds it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deleteAgentSecret, keychainTool, readAgentSecret, storeAgentSecret } from "../../budget/os-keychain.mjs";
import { fakeKeychain, type FakeKeychain } from "../helpers/fake-keychain.js";

let dir: string;
let kc: FakeKeychain;
let savedPath: string | undefined;
let savedDir: string | undefined;
const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;
const SOL_SECRET = "5".repeat(88);
const SOL_ADDRESS = "11111111111111111111111111111111";

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-keychain-"));
  kc = fakeKeychain(dir);
  savedPath = process.env.PATH;
  savedDir = process.env.FAKE_KEYCHAIN_DIR;
  Object.assign(process.env, kc.env({ PATH: savedPath }));
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedDir === undefined) delete process.env.FAKE_KEYCHAIN_DIR;
  else process.env.FAKE_KEYCHAIN_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("storeAgentSecret", () => {
  it("linux: the secret is on stdin, never in argv", () => {
    storeAgentSecret("evm", address, key, execFileSync, "linux");
    const store = kc.calls().find((c) => c.argv[0] === "store")!;
    expect(store.tool).toBe("secret-tool");
    expect(store.stdin).toBe(key);
    expect(store.argv).toEqual(["store", `--label=Superstables budget agent evm:${address}`, "service", "superstables-budget-agent", "account", `evm:${address}`]);
    for (const c of kc.calls()) expect(JSON.stringify(c.argv)).not.toContain(key.slice(2, 20));
    expect(kc.store()[`evm:${address}`]).toBe(key);
  });
  it("macos: argv is exactly -i, and the add command is on stdin", () => {
    storeAgentSecret("evm", address, key, execFileSync, "darwin");
    const add = kc.calls().find((c) => c.argv[0] === "-i")!;
    expect(add.tool).toBe("security");
    expect(add.argv).toEqual(["-i"]);
    expect(add.stdin).toBe(`add-generic-password -U -s superstables-budget-agent -a evm:${address} -w ${key}\n`);
    for (const c of kc.calls()) expect(JSON.stringify(c.argv)).not.toContain(key.slice(2, 20));
  });
  it("solana keys are taken too", () => {
    storeAgentSecret("solana", SOL_ADDRESS, SOL_SECRET, execFileSync, "linux");
    expect(readAgentSecret("solana", SOL_ADDRESS, execFileSync, "linux")).toBe(SOL_SECRET);
  });
  it("a secret holding a quote or a space is refused before anything is spawned", () => {
    for (const bad of [`${key} -w x`, `"${key}"`, `${key}\n`, "0x12", `${key.slice(0, 40)} ${key.slice(41)}`]) {
      expect(() => storeAgentSecret("evm", address, bad, execFileSync, "darwin")).toThrow(/not in a form the keychain can take/);
    }
    expect(() => storeAgentSecret("evm", `${address} -a x`, key, execFileSync, "darwin")).toThrow(/not an evm address/);
    expect(kc.calls()).toEqual([]);
  });
  it("the secret is never an argument to the injected runner", () => {
    const seen: { file: string; args: string[]; input: unknown }[] = [];
    const run = ((file: string, args: string[], opts: { input?: string }) => {
      seen.push({ file, args, input: opts?.input });
      return args[0] === "lookup" ? key : "";
    }) as unknown as typeof execFileSync;
    storeAgentSecret("evm", address, key, run, "linux");
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.args.join(" ")).not.toContain(key);
    expect(seen[0].input).toBe(key);
  });
  it("refuses when the keychain does not keep what it was given", () => {
    const run = ((file: string, args: string[]) => (args[0] === "lookup" ? "0x" + "1".repeat(64) : "")) as unknown as typeof execFileSync;
    expect(() => storeAgentSecret("evm", address, key, run, "linux")).toThrow(/differs/);
  });
  it("says so when the tool is locked", () => {
    process.env.FAKE_KEYCHAIN_FAIL = "1";
    try {
      expect(() => storeAgentSecret("evm", address, key, execFileSync, "linux")).toThrow(/did not take the key: keychain is locked/);
    } finally {
      delete process.env.FAKE_KEYCHAIN_FAIL;
    }
  });
  it("ignores PATH entries that are not absolute, so a project folder cannot supply the tool", () => {
    const bin = process.env.PATH!.split(delimiter)[0];
    expect(keychainTool("linux")?.path).toBe(join(bin, "secret-tool"));
    process.env.PATH = relative(process.cwd(), bin);
    expect(keychainTool("linux")).toBeNull();
    expect(() => storeAgentSecret("evm", address, key, execFileSync, "linux")).toThrow(/no keychain tool is installed/);
  });
  it("says so when no tool is installed", () => {
    process.env.PATH = join(dir, "empty");
    expect(keychainTool("linux")).toBeNull();
    expect(() => storeAgentSecret("evm", address, key, execFileSync, "linux")).toThrow(/no keychain tool is installed/);
  });
});

describe("readAgentSecret and deleteAgentSecret", () => {
  it("returns what was stored on both systems", () => {
    storeAgentSecret("evm", address, key, execFileSync, "linux");
    expect(readAgentSecret("evm", address, execFileSync, "linux")).toBe(key);
    kc.setStore({ [`evm:${address}`]: key });
    expect(readAgentSecret("evm", address, execFileSync, "darwin")).toBe(key);
  });
  it("a missing entry throws, naming the address", () => {
    expect(() => readAgentSecret("evm", address, execFileSync, "linux")).toThrow(`the agent key for ${address} is not in the keychain`);
    expect(() => readAgentSecret("evm", address, execFileSync, "darwin")).toThrow(/is not in the keychain/);
  });
  it("an entry that is not a key is refused", () => {
    kc.setStore({ [`evm:${address}`]: "hunter2" });
    expect(() => readAgentSecret("evm", address, execFileSync, "linux")).toThrow(/is not an agent key/);
  });
  it("delete removes the entry, and a second delete is not an error", () => {
    storeAgentSecret("evm", address, key, execFileSync, "linux");
    deleteAgentSecret("evm", address, execFileSync, "linux");
    expect(kc.store()).toEqual({});
    deleteAgentSecret("evm", address, execFileSync, "linux");
    deleteAgentSecret("evm", address, execFileSync, "darwin");
  });
});
