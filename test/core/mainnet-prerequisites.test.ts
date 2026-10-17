// The chain gate's mainnet prerequisites (src/core/chain-gate.js): each of the four is missing only when its own check fails.
// Two checks need files and are registered by the modules that own those facts (src/core/rpc-endpoints.mjs and
// budget/os-keychain.mjs); the other two are computed in the gate. Mainnet signing is off in this build, so none of this
// changes what a command does today.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SKALE_BASE_SEPOLIA } from "../../src/core/chain.js";
import { MAINNET_PREREQUISITES, chainGate, chainPrerequisitesMissing, mainnetGate, setPrerequisiteCheck } from "../../src/core/chain-gate.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

const [RPC, TOKEN, FINALITY, KEYS] = MAINNET_PREREQUISITES;
const skale = { rail: "evm", key: "skale-base-sepolia", testnet: true, token: SKALE_BASE_SEPOLIA.token };
const yes = () => true;
const homes: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "superstables-prereq-")); homes.push(d); return d; };

afterEach(() => {
  setPrerequisiteCheck("ownerRpc", undefined);
  setPrerequisiteCheck("agentKeyStore", undefined);
  vi.unstubAllEnvs();
  vi.resetModules();
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

describe("chainPrerequisitesMissing", () => {
  it("lists nothing when every check passes", () => {
    setPrerequisiteCheck("ownerRpc", yes);
    setPrerequisiteCheck("agentKeyStore", yes);
    expect(chainPrerequisitesMissing(skale)).toEqual([]);
  });

  it("lists an item alone when only its own check fails", () => {
    setPrerequisiteCheck("ownerRpc", yes);
    setPrerequisiteCheck("agentKeyStore", yes);
    setPrerequisiteCheck("ownerRpc", () => false);
    expect(chainPrerequisitesMissing(skale)).toEqual([RPC]);
    setPrerequisiteCheck("ownerRpc", yes);
    expect(chainPrerequisitesMissing({ ...skale, token: undefined })).toEqual([TOKEN]);
    expect(chainPrerequisitesMissing({ ...skale, token: { ...SKALE_BASE_SEPOLIA.token, decimals: 6.5 } })).toEqual([TOKEN]);
    expect(chainPrerequisitesMissing({ ...skale, key: "base-sepolia" })).toEqual([FINALITY]);
    setPrerequisiteCheck("agentKeyStore", () => false);
    expect(chainPrerequisitesMissing(skale)).toEqual([KEYS]);
  });

  it("fails closed: an unregistered, throwing or non-true check is missing", () => {
    expect(chainPrerequisitesMissing(skale)).toEqual([RPC, KEYS]);
    setPrerequisiteCheck("ownerRpc", () => { throw new Error("boom"); });
    setPrerequisiteCheck("agentKeyStore", () => "yes");
    expect(chainPrerequisitesMissing(skale)).toEqual([RPC, KEYS]);
    setPrerequisiteCheck("agentKeyStore", () => 1);
    expect(chainPrerequisitesMissing(skale)).toEqual([RPC, KEYS]);
    expect(() => setPrerequisiteCheck("nothing" as never, yes)).toThrow(/no prerequisite check is named/);
    expect(chainPrerequisitesMissing({} as never)).toEqual([...MAINNET_PREREQUISITES]);
  });

  it("names a chain for finality the way finality-policy.js does", () => {
    expect(chainPrerequisitesMissing({ rail: "tempo", key: "tempo-moderato", testnet: true })).not.toContain(FINALITY);
    expect(chainPrerequisitesMissing({ rail: "solana", key: "solana-devnet", testnet: true })).toContain(FINALITY);
    expect(chainPrerequisitesMissing({ rail: "evm", key: "evm-x", testnet: true })).toContain(FINALITY);
  });
});

describe("the real RPC check", () => {
  const rpcItem = async (settings: object | null, opts: { raw?: string; mode?: number } = {}) => {
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith(settings, opts));
    vi.resetModules();
    await import("../../src/core/rpc-endpoints.mjs");
    const gate = await import("../../src/core/chain-gate.js");
    return gate.chainPrerequisitesMissing({ rail: "evm", key: "base-sepolia", testnet: true }).includes(RPC);
  };
  const withRpc = (rpc: object) => ({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true }, rpc });

  it("needs an entry the owner chose, and then an own node or two operators", async () => {
    // the built-in table has two operators for this chain, which is not the owner's choice
    expect(await rpcItem(withRpc({}))).toBe(true);
    expect(await rpcItem(withRpc({ "base-sepolia": { urls: ["http://127.0.0.1:1"], ownNode: true } }))).toBe(false);
    expect(await rpcItem(withRpc({ "base-sepolia": { urls: ["https://a.example"], ownNode: false, quorum: 1 } }))).toBe(true);
    expect(await rpcItem(withRpc({ "base-sepolia": { urls: ["https://a.example", "https://b.example.org"], ownNode: false } }))).toBe(false);
    expect(await rpcItem(withRpc({ "base-sepolia": { urls: ["https://a.one.example", "https://b.one.example"], ownNode: false } }))).toBe(true);
  });

  it("counts an unreadable settings file as missing, and nothing throws", async () => {
    expect(await rpcItem(withRpc({ "base-sepolia": { urls: ["http://127.0.0.1:1"], ownNode: true } }), { mode: 0o622 })).toBe(true);
  });
});

describe("the real agent key store check", () => {
  const ADDR = `0x${"ab".repeat(20)}`;
  async function keyItem(rail: string, name: string, text: string | { fifo: true } | null) {
    const home = scratch();
    const keys = join(home, "keys", "budget");
    mkdirSync(keys, { recursive: true, mode: 0o700 });
    const file = join(keys, name);
    if (text && typeof text === "object") execFileSync("mkfifo", [file]);
    else if (text !== null) { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600); }
    vi.stubEnv("SUPERSTABLES_HOME", home);
    vi.resetModules();
    const keychain = await import("../../budget/os-keychain.mjs");
    const gate = await import("../../src/core/chain-gate.js");
    const state = keychain.agentKeyStorage(rail);
    const missing = gate.chainPrerequisitesMissing({ rail, key: `${rail}-x`, testnet: true }).includes(gate.MAINNET_PREREQUISITES[3]);
    return { state, missing };
  }

  it("is satisfied only by a file that names the keychain and holds no key", async () => {
    expect(await keyItem("evm", "evm-agent.env", `B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${ADDR}\n`)).toEqual({ state: "os-keychain", missing: false });
    expect(await keyItem("evm", "evm-agent.env", `B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_KEY=0x${"11".repeat(32)}\n`)).toEqual({ state: "file", missing: true });
    expect(await keyItem("evm", "evm-agent.env", `B4_AGENT_KEY=0x${"11".repeat(32)}\n`)).toEqual({ state: "file", missing: true });
    expect(await keyItem("evm", "evm-agent.env", null)).toEqual({ state: "absent", missing: true });
  });

  it("returns at once for a FIFO, and reads Solana's names", async () => {
    const t = Date.now();
    expect(await keyItem("evm", "evm-agent.env", { fifo: true })).toEqual({ state: "unreadable", missing: true });
    expect(Date.now() - t).toBeLessThan(5000);
    expect(await keyItem("solana", "solana-agent.env", "SOLANA_AGENT_KEY_STORE=os-keychain\nSOLANA_AGENT_ADDRESS=x\n")).toEqual({ state: "os-keychain", missing: false });
    expect(await keyItem("solana", "solana-agent.env", "SOLANA_AGENT_SECRET_BASE58=x\n")).toEqual({ state: "file", missing: true });
  });

  it("never passes for tempo: its keys stay in files", async () => {
    expect((await keyItem("tempo", "tempo-agent.env", "TEMPO_AGENT_KEY_STORE=os-keychain\n")).missing).toBe(true);
  });
});

describe("load order", () => {
  it("the gate alone reads no file: the two file checks read missing", () => {
    const code = `import { chainPrerequisitesMissing } from ${JSON.stringify(new URL("../../src/core/chain-gate.js", import.meta.url).href)};
      console.log(JSON.stringify(chainPrerequisitesMissing({ rail: "evm", key: "skale-base-sepolia", testnet: true, token: ${JSON.stringify(SKALE_BASE_SEPOLIA.token)} })));`;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(JSON.parse(out.stdout)).toEqual([RPC, KEYS]);
  });
});

describe("mainnetGate", () => {
  const chain = { rail: "evm", key: "base", testnet: false, token: SKALE_BASE_SEPOLIA.token };
  beforeEach(() => {
    setPrerequisiteCheck("ownerRpc", yes);
    setPrerequisiteCheck("agentKeyStore", yes);
  });

  it("refuses a chain the owner did not enable", () => {
    expect(mainnetGate({ ...chain, key: "skale-base-sepolia" }, { enabledChains: [] })).toMatch(/do not enable signing on it$/);
    expect(mainnetGate({ ...chain, key: "skale-base-sepolia" }, undefined)).toMatch(/do not enable signing on it$/);
  });

  it("passes an enabled chain with everything present, and names what is missing", () => {
    const ready = { ...chain, key: "skale-base-sepolia" };
    expect(mainnetGate(ready, { enabledChains: ["skale-base-sepolia"] })).toBe("");
    setPrerequisiteCheck("ownerRpc", () => false);
    expect(mainnetGate(ready, { enabledChains: ["skale-base-sepolia"] })).toBe(`the evm chain skale-base-sepolia is not ready for mainnet signing: ${RPC}`);
  });

  it("chainGate still stops at the build's own switch", () => {
    expect(chainGate({ ...chain, key: "skale-base-sepolia" }, { enabledChains: ["skale-base-sepolia"] })).toMatch(/^this client does not sign on mainnet chains/);
  });
});
