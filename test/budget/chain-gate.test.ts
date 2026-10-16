// The chain gate (src/core/chain-gate.js) in every budget rail. In process, each rail's own chokepoint asks the gate
// before it reads the chain: assertRpcChain (evm), clusterProblem (solana) and makeClient (tempo). Then, end to end, a
// copy of the client whose chain tables name a chain that is not a testnet: the evm table gains "gated-base" (Base's
// chain id, testnet: false), and the Solana and Tempo flags are turned off. Every budget command there refuses as it
// loads (exit 3, refused_precheck), before a key file is written or read and before any RPC or seller hears from it.
// No production switch is involved: the copy is edited on disk, as a later change to the tables would be.

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";

const gate = vi.hoisted(() => ({ refuse: false }));
vi.mock("../../src/core/chain-gate.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/chain-gate.js")>();
  return { ...real, chainGate: vi.fn((chain: Parameters<typeof real.chainGate>[0], settings: Parameters<typeof real.chainGate>[1]) => (gate.refuse ? "the test's gate refuses" : real.chainGate(chain, settings))) };
});
import { chainGate } from "../../src/core/chain-gate.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REFUSED = /^this client does not sign on mainnet chains: the (evm|solana|tempo) chain /;
const OWNER_KEY = `0x${"11".repeat(32)}`;
const OWNER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const AGENT_KEY = `0x${"22".repeat(32)}`;
const AGENT = "0x1563915e194D8CfBA1943570603F7606A3115508";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SENDS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sendRawTransactionSync", "sendTransaction"]);

/** A loopback JSON-RPC for one EVM chain id, good enough for an owner approve or an agent pull to reach the broadcast; it refuses every broadcast. `methods` records every call, and `hits` every HTTP request. */
async function fakeRpc(chainId: number, o: { allowance?: bigint } = {}) {
  const methods: string[] = [];
  let hits = 0;
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
  const block = { number: "0x64", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"aa".repeat(32)}`, timestamp: "0x68000000", baseFeePerGas: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: `0x${"00".repeat(20)}`, extraData: "0x", logsBloom: `0x${"00".repeat(256)}`, nonce: "0x0000000000000000", difficulty: "0x0", sha3Uncles: `0x${"00".repeat(32)}`, size: "0x1", stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, mixHash: `0x${"00".repeat(32)}`, transactions: [], uncles: [] };
  const call = (data: string) => {
    const sel = data.slice(0, 10);
    if (sel === "0x313ce567") return word(6n); // decimals()
    if (sel === "0xdd62ed3e") return word(o.allowance ?? 0n); // allowance(owner, agent)
    if (sel === "0x70a08231") return word(data.slice(34, 74).toLowerCase() === OWNER.slice(2).toLowerCase() ? 1_000_000n : 0n); // balanceOf
    return word(0n);
  };
  const answer = (m: string, params: any[]): object => {
    if (SENDS.has(m)) return { error: { code: -32000, message: "refused by the loopback test RPC" } };
    const results: Record<string, unknown> = {
      eth_chainId: `0x${chainId.toString(16)}`, eth_getBalance: "0xde0b6b3a7640000", eth_getTransactionCount: "0x0", eth_estimateGas: "0x10000",
      eth_maxPriorityFeePerGas: "0x1", eth_gasPrice: "0x2", eth_blockNumber: "0x64", eth_getBlockByNumber: block, eth_getCode: "0x", eth_getLogs: [],
    };
    if (m === "eth_call") return { result: call(String(params?.[0]?.data ?? params?.[0]?.input ?? "")) };
    return m in results ? { result: results[m] } : { error: { code: -32601, message: "not in this fake" } };
  };
  const server: Server = createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: any;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      const one = (c: any) => { methods.push(String(c.method)); return { jsonrpc: "2.0", id: c.id, ...answer(String(c.method), c.params) }; };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, methods, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A loopback x402 seller that answers every request with one exact offer on `network`, and counts the requests. */
async function fakeSeller(network: string) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    const pr = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [{ scheme: "exact", network, asset: BASE_SEPOLIA_USDC, amount: "10000", payTo: `0x${"aa".padStart(40, "0")}`, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }] };
    res.writeHead(402, { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/x`, hits: () => hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("each rail's chokepoint asks the gate first", () => {
  const servers: { close(): Promise<void> }[] = [];
  afterAll(async () => { gate.refuse = false; await Promise.all(servers.map((s) => s.close())); });

  it("evm assertRpcChain: refuses with exit 3 before it asks the RPC anything", async () => {
    const rpc = await fakeRpc(84532);
    servers.push(rpc);
    vi.stubEnv("B4_RPC", rpc.url);
    vi.stubEnv("B4_CHAIN", "");
    const evm = await import(new URL("../../budget/evm/lib.ts", import.meta.url).href);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    try {
      gate.refuse = true;
      await expect(evm.assertRpcChain()).rejects.toThrow("exit 3");
      expect(rpc.hits()).toBe(0);
      gate.refuse = false;
      await evm.assertRpcChain();
      expect(rpc.methods).toContain("eth_chainId");
      expect(chainGate).toHaveBeenCalledWith({ rail: "evm", key: "base-sepolia", testnet: true }, undefined);
    } finally {
      exit.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("solana clusterProblem: the gate's reason, and the genesis hash is never read", async () => {
    const sol = await import("../../budget/solana/lib.mjs");
    const conn = { getGenesisHash: vi.fn(async () => SOLANA_DEVNET_GENESIS) };
    gate.refuse = true;
    expect(await sol.clusterProblem(conn)).toBe("the test's gate refuses");
    expect(conn.getGenesisHash).not.toHaveBeenCalled();
    gate.refuse = false;
    expect(await sol.clusterProblem(conn)).toBe("");
    expect(chainGate).toHaveBeenCalledWith({ rail: "solana", key: "solana-devnet", testnet: true }, undefined);
  });

  it("tempo makeClient: throws instead of building a client", async () => {
    const tempo = await import(new URL("../../budget/tempo/lib/common.ts", import.meta.url).href);
    gate.refuse = true;
    expect(() => tempo.makeClient()).toThrow("the test's gate refuses; nothing was signed or sent");
    gate.refuse = false;
    expect(tempo.makeClient()).toBeTruthy();
    expect(chainGate).toHaveBeenCalledWith({ rail: "tempo", key: "tempo-moderato", testnet: true }, undefined);
  });
});

describe("tempo buy asks the gate itself", () => {
  // buy.ts signs through mppx's own client, not makeClient, so its one gate call must stay between the wrong-RPC-chain
  // refusal and the journal that comes before anything is signed.
  it("calls tempoGate after the rpcChainProblem refusal and before the intent is journaled", () => {
    const src = readFileSync(join(ROOT, "budget/tempo/buy.ts"), "utf8");
    const wrongChain = src.indexOf("await rpcChainProblem()");
    const gateCall = src.indexOf("tempoGate()");
    const journal = src.indexOf("writeOp(op, 'quoted')");
    expect(wrongChain).toBeGreaterThan(0);
    expect(gateCall).toBeGreaterThan(wrongChain);
    expect(journal).toBeGreaterThan(gateCall);
    expect(src.match(/tempoGate\(\)/g)).toHaveLength(1);
  });
});

describe("a copy of the client whose chain tables name chains that are not testnets", () => {
  let tree: string;
  const servers: { close(): Promise<void> }[] = [];
  const homes: string[] = [];

  /** Edit one file of the copy: exactly one occurrence of `from` must be there. */
  function edit(rel: string, from: string, to: string) {
    const path = join(tree, rel);
    const text = readFileSync(path, "utf8");
    if (text.split(from).length !== 2) throw new Error(`${rel}: expected exactly one ${JSON.stringify(from)}`);
    writeFileSync(path, text.replace(from, to));
  }

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "ss-chain-gate-tree-"));
    for (const dir of ["budget", "src"]) cpSync(join(ROOT, dir), join(tree, dir), { recursive: true });
    for (const file of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, file), join(tree, file));
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"), "dir");
    // A copy of Base Sepolia's entry under Base's chain id (viem's preset "base"), not marked as a testnet.
    edit("budget/evm/chains.mjs", "};\n\nexport const EVM_CHAIN_KEYS", `  "gated-base": {
    label: "Gated Base", chainId: 8453, viem: "base", testnet: false,
    rpc: "https://mainnet.base.org", explorer: "https://basescan.org",
    token: { address: "${BASE_SEPOLIA_USDC}", symbol: "USDC", decimals: 6, domain: { name: "USDC", version: "2" }, approveReset: false },
    legacy: [],
    gas: { symbol: "ETH", decimals: 18, isToken: false, limits: FIAT_TOKEN_GAS, minAgent: "0.000002", topUp: "0.00003" },
    doctor: { minOwnerToken: "0.01", minOwnerGas: "0.00003", minAgentGas: "0.00003", fundAgent: "0.0001", tokenFaucet: "none", gasFaucet: "none" },
  },
};

export const EVM_CHAIN_KEYS`);
    edit("budget/solana/lib.mjs", "export const TESTNET = true;", "export const TESTNET = false;");
    edit("budget/tempo/lib/constants.mjs", "export const TESTNET = true", "export const TESTNET = false");
  }, 60_000);
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    rmSync(tree, { recursive: true, force: true });
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  });

  /** A fresh home with this chain's public file, the agent key file and an owner key file. */
  function home(evmChain: string) {
    const h = mkdtempSync(join(tmpdir(), "ss-chain-gate-home-"));
    homes.push(h);
    mkdirSync(join(h, "budget", "public"), { recursive: true });
    writeFileSync(join(h, "budget", "public", `evm-${evmChain}.env`), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`);
    mkdirSync(join(h, "keys", "budget"), { recursive: true, mode: 0o700 });
    writeFileSync(join(h, "owner.env"), `B4_OWNER_KEY=${OWNER_KEY}\nOWNER_PRIVATE_KEY=${OWNER_KEY}\nOWNER_ADDRESS=${OWNER}\nSOLANA_OWNER_SECRET_BASE58=unused\n`, { mode: 0o600 });
    return h;
  }
  /** Runs the copy's dispatcher, or one of its rail scripts, without blocking: the fake RPC and seller live in this process. */
  function run(h: string, args: string[], env: Record<string, string>, script?: string): Promise<{ code: number | null; stdout: string; stderr: string; result: any }> {
    const [cmd, argv] = script ? [resolve(tree, "node_modules/.bin/tsx"), [resolve(tree, script), ...args]] : [process.execPath, [resolve(tree, "budget/cli.mjs"), ...args]];
    return new Promise((done) => {
      const child = spawn(cmd, argv, { cwd: tree, env: { ...process.env, B4_CHAIN: "", SUPERSTABLES_HOME: h, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
        done({ code, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
      });
    });
  }

  it("evm: grant with an owner key file refuses before anything is signed or sent", async () => {
    const rpc = await fakeRpc(8453);
    servers.push(rpc);
    const h = home("gated-base");
    const r = await run(h, ["grant", "--rail", "evm", "--chain", "gated-base", "--amount", "0.01", "--owner-key-file", join(h, "owner.env"), "--yes"], { B4_RPC: rpc.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toMatch(/^this client does not sign on mainnet chains: the evm chain gated-base /);
    expect(rpc.methods.filter((m) => SENDS.has(m))).toEqual([]);
  }, 120_000);

  it("evm: buy refuses before the seller is called, before the pull, and leaves no journal", async () => {
    const rpc = await fakeRpc(8453, { allowance: 1_000_000n });
    const seller = await fakeSeller("eip155:8453");
    servers.push(rpc, seller);
    const h = home("gated-base");
    writeFileSync(join(h, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${AGENT_KEY}\nB4_AGENT_ADDRESS=${AGENT}\nB4_OWNER_ADDRESS=${OWNER}\n`, { mode: 0o600 });
    const r = await run(h, ["buy", "--rail", "evm", "--chain", "gated-base", "--url", seller.url, "--max", "0.05", "--op", "g1"], { B4_RPC: rpc.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toMatch(REFUSED);
    expect(seller.hits()).toBe(0);
    expect(rpc.methods.filter((m) => SENDS.has(m))).toEqual([]);
    expect(existsSync(join(h, "budget", "ops", "evm-gated-base", "g1.json"))).toBe(false);
  }, 120_000);

  it("evm: setup refuses before it writes an agent key", async () => {
    const h = home("gated-base");
    const r = await run(h, ["--chain", "gated-base", "--owner-key-file", join(h, "owner.env")], {}, "budget/evm/setup.ts");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, command: "setup", rail: "evm", chain: "gated-base", state: "refused_precheck" });
    expect(existsSync(join(h, "keys", "budget", "evm-agent.env"))).toBe(false);
  }, 120_000);

  it("evm control: on Base Sepolia in the same copy, fund-agent gets as far as the broadcast", async () => {
    const rpc = await fakeRpc(84532);
    servers.push(rpc);
    const h = home("base-sepolia");
    await run(h, ["fund-agent", "--rail", "evm", "--owner-key-file", join(h, "owner.env"), "--yes"], { B4_RPC: rpc.url });
    expect(rpc.methods).toContain("eth_sendRawTransaction");
  }, 120_000);

  it.each([
    { rail: "solana", args: ["fund-agent", "--rail", "solana"], script: undefined },
    { rail: "solana", args: ["--url", "SELLER", "--max", "0.01", "--op", "s1"], script: "budget/solana/buy.mjs" },
    { rail: "tempo", args: ["grant", "--rail", "tempo", "--amount", "0.05"], script: undefined },
    { rail: "tempo", args: ["--url", "SELLER", "--max", "0.01", "--op", "t1"], script: "budget/tempo/buy.ts" },
  ])("$rail $args.0: refused as it loads, and neither the RPC nor the seller hears anything", async ({ rail, args, script }) => {
    const rpc = await fakeRpc(42431);
    const seller = await fakeSeller("eip155:42431");
    servers.push(rpc, seller);
    const h = home("base-sepolia");
    const full = [...args.map((a) => (a === "SELLER" ? seller.url : a)), ...(script ? [] : ["--owner-key-file", join(h, "owner.env"), "--yes"])];
    const r = await run(h, full, { SUPERSTABLES_SOLANA_RPC: rpc.url, SUPERSTABLES_TEMPO_RPC: rpc.url }, script);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toMatch(new RegExp(`^this client does not sign on mainnet chains: the ${rail} chain`));
    expect(rpc.hits()).toBe(0);
    expect(seller.hits()).toBe(0);
  }, 120_000);
});
