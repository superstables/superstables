// The chain gate's mainnet prerequisites (src/core/chain-gate.js): each is missing only when its own check fails. Two checks
// need files and are registered by the modules that own those facts (src/core/rpc-endpoints.mjs and budget/os-keychain.mjs);
// the other two are computed in the gate. The last part loads the chain tables with the operator's switch on, as a process
// started without --testnet does, and checks every mainnet of the manifest end to end, short of signing.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge } from "mppx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKALE_BASE_SEPOLIA } from "../../src/core/chain.js";
import { MAINNET_PREREQUISITES, chainPrerequisitesMissing, setPrerequisiteCheck } from "../../src/core/chain-gate.js";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

const [RPC, TOKEN, FINALITY, KEYS] = MAINNET_PREREQUISITES;
const skale = { rail: "evm", key: "skale-base-sepolia", testnet: true, token: SKALE_BASE_SEPOLIA.token };
const yes = () => true;
const homes: string[] = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "superstables-prereq-")); homes.push(d); return d; };

afterEach(() => {
  setPrerequisiteCheck("verdictRpc", undefined);
  setPrerequisiteCheck("agentKeyStore", undefined);
  vi.unstubAllEnvs();
  vi.resetModules();
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

describe("chainPrerequisitesMissing", () => {
  it("lists nothing when every check passes", () => {
    setPrerequisiteCheck("verdictRpc", yes);
    setPrerequisiteCheck("agentKeyStore", yes);
    expect(chainPrerequisitesMissing(skale)).toEqual([]);
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([]);
  });

  it("lists an item alone when only its own check fails", () => {
    setPrerequisiteCheck("verdictRpc", yes);
    setPrerequisiteCheck("agentKeyStore", yes);
    setPrerequisiteCheck("verdictRpc", () => false);
    expect(chainPrerequisitesMissing(skale)).toEqual([RPC]);
    setPrerequisiteCheck("verdictRpc", yes);
    expect(chainPrerequisitesMissing({ ...skale, token: undefined })).toEqual([TOKEN]);
    expect(chainPrerequisitesMissing({ ...skale, token: { ...SKALE_BASE_SEPOLIA.token, decimals: 6.5 } })).toEqual([TOKEN]);
    expect(chainPrerequisitesMissing({ ...skale, key: "polygon-amoy" })).toEqual([FINALITY]);
    setPrerequisiteCheck("agentKeyStore", () => false);
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([KEYS]);
  });

  it("asks for the agent key only where an agent key signs: `pay` holds none", () => {
    setPrerequisiteCheck("verdictRpc", yes);
    expect(chainPrerequisitesMissing(skale)).toEqual([]);
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([KEYS]);
  });

  it("fails closed: an unregistered, throwing or non-true check is missing", () => {
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([RPC, KEYS]);
    setPrerequisiteCheck("verdictRpc", () => { throw new Error("boom"); });
    setPrerequisiteCheck("agentKeyStore", () => "yes");
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([RPC, KEYS]);
    setPrerequisiteCheck("agentKeyStore", () => 1);
    expect(chainPrerequisitesMissing({ ...skale, agentKey: true })).toEqual([RPC, KEYS]);
    expect(() => setPrerequisiteCheck("nothing" as never, yes)).toThrow(/no prerequisite check is named/);
    expect(chainPrerequisitesMissing({ agentKey: true } as never)).toEqual([...MAINNET_PREREQUISITES]);
  });

  it("names a chain for finality the way finality-policy.js does, and knows every mainnet's", () => {
    expect(chainPrerequisitesMissing({ rail: "tempo", key: "tempo-moderato", testnet: true })).not.toContain(FINALITY);
    expect(chainPrerequisitesMissing({ rail: "solana", key: "solana-devnet", testnet: true })).toContain(FINALITY);
    expect(chainPrerequisitesMissing({ rail: "evm", key: "evm-x", testnet: true })).toContain(FINALITY);
    for (const [key, c] of Object.entries(MAINNET_MANIFEST.chains)) {
      expect(chainPrerequisitesMissing({ rail: c.rail, key, testnet: false }), key).not.toContain(FINALITY);
    }
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

  it("passes on the built-in table's two operators, or the owner's own node or two operators; one operator is not enough", async () => {
    expect(await rpcItem(null)).toBe(false);
    expect(await rpcItem(withRpc({}))).toBe(false);
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
    const missing = gate.chainPrerequisitesMissing({ rail, key: `${rail}-x`, testnet: true, agentKey: true }).includes(gate.MAINNET_PREREQUISITES[3]);
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
      console.log(JSON.stringify(chainPrerequisitesMissing({ rail: "evm", key: "skale-base-sepolia", testnet: true, agentKey: true, token: ${JSON.stringify(SKALE_BASE_SEPOLIA.token)} })));`;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(JSON.parse(out.stdout)).toEqual([RPC, KEYS]);
  });
});

describe("with the default, mainnet, when the tables load", () => {
  const PAY_TO_EVM = `0x${"22".repeat(20)}`;
  const PAY_TO_SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
  async function load(env: Record<string, string> = {}) {
    vi.stubEnv("SUPERSTABLES_TESTNET", "");
    vi.stubEnv("SUPERSTABLES_HOME", scratch());
    vi.stubEnv("SUPERSTABLES_TEST_ACCOUNT_HOME", accountHomeWith(null));
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.resetModules();
    await import("../../src/core/mainnet-spend.js");
    await import("../../src/core/rpc-endpoints.mjs");
    return {
      chain: await import("../../src/core/chain.js"),
      gate: await import("../../src/core/chain-gate.js"),
      rails: await import("../../src/core/rails/index.js"),
    };
  }
  const gateOf = (gate: typeof import("../../src/core/chain-gate.js"), n: { rail: string; key: string; chainId: number; testnet: boolean; token: unknown }) =>
    gate.chainGate({ rail: n.rail, key: n.key, chainId: n.chainId, testnet: n.testnet, token: n.token });

  it("puts every mainnet of the manifest in the table, after the testnets, which are unchanged", async () => {
    const off = (await import("../../src/core/chain.js")).KNOWN_NETWORKS.map((n) => n.key);
    const { chain } = await load();
    const keys = chain.KNOWN_NETWORKS.map((n) => n.key);
    expect(keys.filter((k) => off.includes(k))).toEqual(off);
    expect(chain.KNOWN_NETWORKS.filter((n) => n.testnet).map((n) => n.key)).toEqual(off);
    expect(chain.KNOWN_NETWORKS.filter((n) => !n.testnet).map((n) => n.key).sort()).toEqual(Object.keys(MAINNET_MANIFEST.chains).sort());
    for (const n of chain.KNOWN_NETWORKS.filter((k) => !k.testnet)) {
      const m = MAINNET_MANIFEST.chains[n.key as keyof typeof MAINNET_MANIFEST.chains];
      expect({ caip2: n.caip2, chainId: n.chainId, rail: n.rail, token: n.token.address }, n.key).toEqual({ caip2: m.caip2, chainId: m.chainId, rail: m.rail, token: m.token.address });
    }
  });

  // SKALE Base has one public RPC operator, and on Robinhood Chain only dRPC answers state reads at the finalized block:
  // neither has two operators that can agree on a verdict, so each needs the owner's own node.
  const OWN_NODE = ["skale-base", "robinhood"];

  it("lets every mainnet through the gate, except the two whose public RPCs cannot decide a verdict without the owner's node", async () => {
    const { chain, gate } = await load();
    for (const n of chain.KNOWN_NETWORKS) {
      const why = gateOf(gate, n);
      if (n.testnet) expect(why, n.key).toBe(`the ${n.rail} chain ${n.key} is a testnet, and testnets need --testnet (or SUPERSTABLES_TESTNET=1)`);
      else if (OWN_NODE.includes(n.key)) expect(why, n.key).toBe(`the evm chain ${n.key} is not ready for mainnet signing: ${RPC}`);
      else expect(why, n.key).toBe("");
    }
  });

  it("lets those two through once the owner names their own node for each", async () => {
    const rpc = Object.fromEntries(OWN_NODE.map((k) => [k, { urls: [`https://${k}.node.owner.example`], ownNode: true }]));
    const own = { version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true }, rpc };
    const { chain, gate } = await load({ SUPERSTABLES_TEST_ACCOUNT_HOME: accountHomeWith(own) });
    for (const id of ["eip155:1187947933", "eip155:4663"]) expect(gateOf(gate, chain.networkFor(id)!), id).toBe("");
  });

  it("judges an offer on each mainnet as payable: x402 on the EVM chains and Solana, MPP on Tempo", async () => {
    const { chain, rails } = await load();
    for (const n of chain.EVM_NETWORKS.filter((k) => !k.testnet && !OWN_NODE.includes(k.key))) {
      const judged = rails.judgeAccept(chain.usdcRequirement(0.01, PAY_TO_EVM, n) as never, 2);
      expect(judged.supported ? judged.offer.terms.network : judged.reason, n.key).toBe(n.caip2);
    }
    const sol = chain.networkFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")!;
    const solana = rails.judgeAccept({ scheme: "exact", network: sol.caip2, asset: sol.token.address, amount: "10000", payTo: PAY_TO_SOL, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } } as never, 2);
    expect(solana.supported ? solana.offer.terms : solana.reason).toMatchObject({ network: sol.caip2, assetAddress: sol.token.address, amountAtomic: "10000" });
    const issued = Challenge.from({
      id: "c-1", realm: "seller.example", method: "tempo", intent: "charge",
      request: { amount: "10000", currency: "0x20C0000000000000000000000000000000000000", recipient: PAY_TO_EVM, methodDetails: { chainId: 4217 } },
      expires: new Date(Date.now() + 300_000).toISOString(),
    } as Parameters<typeof Challenge.from>[0]);
    const { parseMppChallenges } = await import("../../src/core/mpp.js");
    const tempo = rails.judgeMppChallenge(parseMppChallenges(Challenge.serialize(issued))[0]);
    expect(tempo.supported ? tempo.offer.terms : tempo.reason).toMatchObject({ network: "eip155:4217", networkLabel: "Tempo", asset: "pathUSD" });
  });

  it("gives the budget's EVM table the same mainnet facts as the pay table", async () => {
    const { chain } = await load();
    const { EVM_CHAINS } = await import("../../budget/evm/chains.mjs");
    const mainnets = chain.EVM_NETWORKS.filter((k) => !k.testnet);
    expect(mainnets.length).toBe(7);
    for (const n of mainnets) {
      const b = (EVM_CHAINS as Record<string, any>)[n.key];
      expect({ label: b.label, chainId: b.chainId, testnet: b.testnet, rpc: b.rpc, explorer: b.explorer, token: b.token, blockSeconds: b.blockSeconds, logRange: b.logRange, legacy: b.legacy }, n.key)
        .toEqual({ label: n.label, chainId: n.chainId, testnet: false, rpc: n.rpc, explorer: n.explorer, token: n.token, blockSeconds: n.blockSeconds, logRange: n.logRange, legacy: n.v1Name ? [n.v1Name] : [] });
    }
  });

  it("still refuses a mainnet offer whose token is not the manifest's", async () => {
    const { chain, rails } = await load();
    const base = chain.networkFor("eip155:8453") as import("../../src/core/chain.js").EvmNetwork;
    const wrong = { ...chain.usdcRequirement(0.01, PAY_TO_EVM, base), asset: chain.BASE_SEPOLIA.token.address };
    expect(rails.judgeAccept(wrong as never, 2).supported).toBe(false);
  });

  it("stops every mainnet during a pause, and every one again in a testnet-only run, while testnets go on there", async () => {
    const { chain, gate } = await load({ SUPERSTABLES_MAINNET_PAUSE: "1" });
    for (const n of chain.KNOWN_NETWORKS) {
      expect(gateOf(gate, n), n.key).toMatch(n.testnet ? /is a testnet, and testnets need --testnet/ : /mainnet signing is paused: SUPERSTABLES_MAINNET_PAUSE is set/);
    }
    vi.stubEnv("SUPERSTABLES_MAINNET_PAUSE", "");
    vi.stubEnv("SUPERSTABLES_TESTNET", "1");
    for (const n of chain.KNOWN_NETWORKS) expect(gateOf(gate, n), n.key).toMatch(n.testnet ? /^$/ : /^this run is testnet-only \(--testnet\), so mainnets are off/);
  });
});
