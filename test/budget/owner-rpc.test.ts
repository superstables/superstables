// An RPC variable counts for an owner action only when it names an RPC the owner set: the real dispatcher and rail scripts
// against fake chains on 127.0.0.1. No network, no key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evmOwnerKey, startFakeRpc } from "../helpers/fake-site.js";
import { startFakeSolana, type FakeSolana } from "../helpers/fake-chains.js";
import { MAINNET_GENESIS } from "../helpers/fake-solana-pay.js";
import { DEV_SETTINGS, accountHomeWith } from "../helpers/owner-settings.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const kp = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const agentKp = kp(3);
const ownerA = kp(4);
const agent = agentKp.publicKey.toBase58();

let home: string;
let solana: FakeSolana;
const accounts: string[] = [];
const account = (settings: object | null) => { const a = accountHomeWith(settings); accounts.push(a); return a; };
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-owner-rpc-"));
  solana = await startFakeSolana();
  const write = (p: string, t: string, mode = 0o600) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t, { mode }); };
  write(join(home, "keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agentKp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\nSOLANA_OWNER_ADDRESS=${ownerA.publicKey.toBase58()}\n`);
  write(join(home, "budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${ownerA.publicKey.toBase58()}\nSOLANA_AGENT_ADDRESS=${agent}\n`, 0o644);
  write(join(home, "owner-A.env"), `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(ownerA.secretKey)}\n`);
  solana.usdc.set(ownerA.publicKey.toBase58(), { amount: 5_000_000n, delegate: agent, delegated: 500_000n });
  solana.balances.set(ownerA.publicKey.toBase58(), 1_000_000_000n);
  solana.balances.set(agent, 100_000_000n);
});
afterEach(async () => {
  await solana.close();
  rmSync(home, { recursive: true, force: true });
  for (const a of accounts.splice(0)) rmSync(a, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function run(argv: string[], acct: string, env: Record<string, string> = {}, cmd: string[] = [process.execPath, CLI]): Promise<Out> {
  return new Promise((done, fail) => {
    const e: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEST_ACCOUNT_HOME: acct, ...env };
    delete e.SUPERSTABLES_SITE;
    const child = spawn(cmd[0], [...cmd.slice(1), ...argv], { cwd: ROOT, env: e });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const FUND = ["fund-agent", "--rail", "solana", "--owner-key-file", "OWNERKEY", "--yes"];
const fund = () => FUND.map((a) => (a === "OWNERKEY" ? join(home, "owner-A.env") : a));

describe("owner actions", () => {
  it("a variable the owner did not set is refused before anything is read or sent", async () => {
    const r = await run(fund(), account(null), { SUPERSTABLES_SOLANA_RPC: solana.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(/SUPERSTABLES_SOLANA_RPC \(http:\/\/127\.0\.0\.1:\d+\) is not an RPC the owner set for solana-devnet/);
    expect(r.result.next).toContain("superstables owner settings rpc solana-devnet");
    expect(solana.calls).toEqual([]);
  }, 60_000);

  // The fake answers another cluster's genesis hash: an owner command that gets past the RPC rule reads it and then stops on the
  // cluster check, before a blockhash is fetched. That read is the proof the RPC was accepted.
  const getsPast = (r: Out) => {
    expect(r.result?.reason, r.stdout + r.stderr).toMatch(/not on Solana devnet/);
    expect(solana.calls).toContain("getGenesisHash");
    expect(solana.calls).not.toContain("sendTransaction");
  };
  it("the owner's URL, or this computer when the owner allows it, proceeds", async () => {
    solana.genesis = MAINNET_GENESIS;
    getsPast(await run(fund(), account({ version: 1, rpc: { "solana-devnet": { urls: [solana.url] } } }), { SUPERSTABLES_SOLANA_RPC: solana.url }));
    solana.calls.length = 0;
    getsPast(await run(fund(), account(DEV_SETTINGS), { SUPERSTABLES_SOLANA_RPC: solana.url }));
  }, 60_000);

  it("the variable equal to the owner's URL with a slash added proceeds", async () => {
    solana.genesis = MAINNET_GENESIS;
    getsPast(await run(fund(), account({ version: 1, rpc: { "solana-devnet": { urls: [solana.url] } } }), { SUPERSTABLES_SOLANA_RPC: `${solana.url}/` }));
  }, 60_000);

  it("the rail script run directly refuses too", async () => {
    const r = await run(["--owner-key-file", join(home, "owner-A.env"), "--yes"], account(null), { SUPERSTABLES_SOLANA_RPC: solana.url }, [process.execPath, "--import", "tsx", join(ROOT, "budget/solana/fundAgent.ts")]);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toMatch(/REFUSED: .*is not an RPC the owner set for solana-devnet.*Nothing was asked or sent\./);
    expect(r.result).toMatchObject({ state: "refused_precheck" });
    expect(solana.calls).toEqual([]);
  }, 60_000);
});

const writePublicFiles = async (h: string) => {
  const { privateKeyToAddress } = await import("viem/accounts");
  const addr = privateKeyToAddress(evmOwnerKey("33") as `0x${string}`);
  mkdirSync(join(h, "budget", "public"), { recursive: true });
  writeFileSync(join(h, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${addr}\nB4_AGENT_ADDRESS=0x${"44".repeat(20)}\n`);
  writeFileSync(join(h, "budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${addr}\nAGENT_ADDRESS=0x${"44".repeat(20)}\n`);
};

describe("every rail", () => {
  it.each([
    ["evm", "B4_RPC", "base-sepolia", 84532, ["grant", "--rail", "evm", "--amount", "1"]],
    ["tempo", "SUPERSTABLES_TEMPO_RPC", "tempo-moderato", 42431, ["revoke", "--rail", "tempo"]],
  ])("%s: the dispatcher refuses a variable the owner did not set, the RPC hears nothing, and the owner's own URL goes through", async (_rail, name, key, chainId, args) => {
    const calls: string[] = [];
    const fake = await startFakeRpc(chainId, (m) => { calls.push(m); return undefined; });
    try {
      await writePublicFiles(home);
      const r = await run([...args, "--owner-key-file", join(home, "owner-A.env"), "--yes"], account(null), { [name]: fake.url });
      expect(r.code, r.stdout + r.stderr).toBe(3);
      expect(r.result).toMatchObject({ state: "refused_precheck" });
      expect(r.result.reason).toContain(`${name} (${fake.url}) is not an RPC the owner set for ${key}`);
      expect(r.result.next).toContain(`superstables owner settings rpc ${key} <url>`);
      expect(calls).toEqual([]);
      const own = await run([...args, "--owner-key-file", join(home, "owner-A.env"), "--yes"], account({ version: 1, rpc: { [key]: { urls: [fake.url] } } }), { [name]: fake.url });
      expect(own.result?.reason ?? "").not.toContain("is not an RPC the owner set");
    } finally { await fake.close(); }
  }, 90_000);

  it("solana: the dispatcher refuses a variable the owner did not set, and the RPC hears nothing", async () => {
    const args = ["grant", "--rail", "solana", "--amount", "1"];
    const r = await run([...args, "--owner-key-file", join(home, "owner-A.env"), "--yes"], account(null), { SUPERSTABLES_SOLANA_RPC: solana.url });
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toContain(`SUPERSTABLES_SOLANA_RPC (${solana.url}) is not an RPC the owner set for solana-devnet`);
    expect(r.result.next).toContain("superstables owner settings rpc solana-devnet <url>");
    expect(solana.calls).toEqual([]);
    const own = await run([...args, "--owner-key-file", join(home, "owner-A.env"), "--yes"], account({ version: 1, rpc: { "solana-devnet": { urls: [solana.url] } } }), { SUPERSTABLES_SOLANA_RPC: solana.url });
    expect(own.result?.reason ?? "").not.toContain("is not an RPC the owner set");
  }, 90_000);

  it.each([
    ["evm", "budget/evm/setBudget.ts", ["--cap", "1"], "B4_RPC", 84532],
    ["tempo", "budget/tempo/revokeBudget.ts", [], "SUPERSTABLES_TEMPO_RPC", 42431],
  ] as const)("%s: the owner script run directly refuses a variable the owner did not set, and the RPC hears nothing", async (_rail, script, extra, name, chainId) => {
    const calls: string[] = [];
    const fake = await startFakeRpc(chainId, (m) => { calls.push(m); return undefined; });
    try {
      const key = join(home, "owner-evm.env");
      writeFileSync(key, `B4_OWNER_KEY=${evmOwnerKey("33")}\nOWNER_PRIVATE_KEY=${evmOwnerKey("33")}\n`, { mode: 0o600 });
      await writePublicFiles(home);
      const r = await run([...extra, "--owner-key-file", key], account(null), { [name]: fake.url }, [process.execPath, "--import", "tsx", join(ROOT, script)]);
      expect(r.code, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/REFUSED: .*is not an RPC the owner set/);
      expect(calls).toEqual([]);
    } finally { await fake.close(); }
  }, 90_000);
});

describe("reads", () => {
  it("keep the variable", async () => {
    const r = await run(["status", "--rail", "solana"], account(null), { SUPERSTABLES_SOLANA_RPC: solana.url });
    expect(solana.calls.length, r.stdout + r.stderr).toBeGreaterThan(0);
  }, 60_000);

  it("with no variable use the owner's URL for the chain", async () => {
    const r = await run(["status", "--rail", "solana"], account({ version: 1, rpc: { "solana-devnet": { urls: [solana.url] } } }), { SUPERSTABLES_SOLANA_RPC: "" });
    expect(solana.calls.length, r.stdout + r.stderr).toBeGreaterThan(0);
  }, 60_000);
});
