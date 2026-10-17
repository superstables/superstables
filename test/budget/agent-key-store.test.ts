// `budget setup --key-store os-keychain`: an evm or solana agent key lives in the OS keychain, only its address in the file; and
// the budget's folders are checked before anything is written. The real dispatcher and rail scripts against a fake chain on
// 127.0.0.1, with fake `secret-tool` and `security` tools first on PATH. No network, no real keychain, no real key.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFakeEvm, startSeller, usdc, type FakeEvm } from "../helpers/fake-evm.js";
import { startFakeSolana, type FakeSolana } from "../helpers/fake-chains.js";
import { fakeKeychain, type FakeKeychain } from "../helpers/fake-keychain.js";
import { rotate } from "../../budget/rotate.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const SOLANA_ROTATE = resolve(ROOT, "budget/solana/rotate.mjs");

let home: string;
let scratch: string;
let kc: FakeKeychain;
let chain: FakeEvm;
let solana: FakeSolana;
const cleanups: (() => unknown)[] = [];
const scratchBase = join(process.env.TMPDIR ?? tmpdir());
beforeEach(async () => {
  scratch = mkdtempSync(join(scratchBase, "ss-keystore-"));
  home = join(scratch, "home");
  mkdirSync(home, { mode: 0o700 });
  kc = fakeKeychain(join(scratch, "kc"));
  chain = await startFakeEvm();
  solana = await startFakeSolana();
});
afterEach(async () => {
  await chain.close();
  await solana.close();
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(scratch, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function run(args: string[], opts: { env?: Record<string, string | undefined>; bare?: boolean; script?: string } = {}): Promise<Out> {
  return new Promise((done, fail) => {
    const base: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: chain.url, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete base.SUPERSTABLES_SITE;
    delete base.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const env = opts.bare ? { ...base, PATH: bareBin() } : kc.env(base as Record<string, string>);
    Object.assign(env, opts.env);
    const child = spawn(process.execPath, [opts.script ?? CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch { /* not JSON */ }
      done({ code: code ?? 0, stdout, stderr, result });
    });
  });
}
/** A PATH with node and nothing else: no keychain tool. */
function bareBin(): string {
  const dir = join(scratch, "bare");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "node"))) symlinkSync(process.execPath, join(dir, "node"));
  return dir;
}
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode }); };
const read = (path: string) => readFileSync(path, "utf8");
const agentFile = () => join(home, "keys", "budget", "evm-agent.env");
const solAgentFile = () => join(home, "keys", "budget", "solana-agent.env");
const ownerKey = generatePrivateKey();
const owner = privateKeyToAccount(ownerKey);
const ownerFile = () => { const p = join(scratch, "owner.env"); write(p, `B4_OWNER_KEY=${ownerKey}\n`); return p; };
const setupEvm = (extra: string[] = []) => run(["setup", "--rail", "evm", "--key-store", "os-keychain", "--owner-key-file", ownerFile(), ...extra]);
const agentOf = (text: string) => text.match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];

/** The chain as `grant` leaves it, and a seller that wants 0.01 USDC. */
async function fund(agent: string) {
  chain.setUsdc(owner.address, usdc("100"));
  chain.setNative(owner.address, 10n ** 20n);
  chain.setNative(agent, 10n ** 17n);
  chain.setAllowance(owner.address, agent as `0x${string}`, usdc("1"));
  const seller = await startSeller(chain, 84532);
  cleanups.push(() => seller.close());
  return seller;
}
const buy = (url: string, op: string) => run(["buy", "--rail", "evm", "--url", url, "--max", "0.05", "--op", op]);

describe("evm: setup --key-store os-keychain", () => {
  it("keeps the key out of the file and out of argv, and buy signs with the key from the keychain", async () => {
    const out = await setupEvm();
    expect(out.code, all(out)).toBe(0);
    const text = read(agentFile());
    const agent = agentOf(text);
    expect(text).toBe(`B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${agent}\n`);
    expect(statSync(agentFile()).mode & 0o777).toBe(0o600);
    const key = kc.store()[`evm:${agent}`];
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    expect(privateKeyToAccount(key as `0x${string}`).address).toBe(agent);
    expect(all(out)).not.toContain(key);
    expect(out.result).toMatchObject({ state: "ok", agent });
    expect(all(out)).toContain("created the agent key in the OS keychain");
    for (const c of kc.calls()) expect(JSON.stringify(c.argv)).not.toContain(key.slice(2, 24));
    // the key reaches buy from the keychain
    const seller = await fund(agent);
    const r = await buy(seller.url, "ks1");
    expect(r.code, all(r)).toBe(0);
    expect(seller.creds).toHaveLength(1);
  }, 120_000);

  it("a keychain entry for another key is refused before anything is signed", async () => {
    const out = await setupEvm();
    expect(out.code, all(out)).toBe(0);
    const agent = agentOf(read(agentFile()));
    kc.setStore({ [`evm:${agent}`]: generatePrivateKey() });
    const seller = await fund(agent);
    const r = await buy(seller.url, "ks2");
    expect(r.code, all(r)).not.toBe(0);
    expect(all(r)).toContain("does not match the agent address");
    expect(seller.creds).toEqual([]);
    expect(chain.sentRaw).toEqual([]);
  }, 120_000);

  it("a missing entry is refused, and the other way round: a file that names the keychain and holds a key", async () => {
    const out = await setupEvm();
    const agent = agentOf(read(agentFile()));
    kc.setStore({});
    const seller = await fund(agent);
    const gone = await buy(seller.url, "ks3");
    expect(gone.code, all(gone)).not.toBe(0);
    expect(all(gone)).toContain(`the agent key for ${agent} is not in the keychain`);
    expect(seller.creds).toEqual([]);
    write(agentFile(), `B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${agent}\nB4_AGENT_KEY=${generatePrivateKey()}\n`);
    const both = await buy(seller.url, "ks3b");
    expect(both.code, all(both)).not.toBe(0);
    expect(all(both)).toContain("names the keychain and also holds a key");
    expect(out.code).toBe(0);
  }, 120_000);

  it("no keychain tool: setup refuses (exit 3) and writes no file", async () => {
    const out = await run(["setup", "--rail", "evm", "--key-store", "os-keychain", "--owner-key-file", ownerFile()], { bare: true });
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toMatch(/no keychain tool \(secret-tool or security\) answered/);
    expect(existsSync(agentFile())).toBe(false);
    expect(existsSync(join(home, "budget", "public", "evm-base-sepolia.env"))).toBe(false);
  }, 60_000);

  it("a locked keychain: setup refuses and writes no file", async () => {
    const out = await run(["setup", "--rail", "evm", "--key-store", "os-keychain", "--owner-key-file", ownerFile()], { env: { FAKE_KEYCHAIN_FAIL: "1" } });
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toContain("keychain is locked");
    expect(all(out)).toContain("the keychain refused the key");
    expect(all(out)).not.toContain("no keychain tool");
    expect(existsSync(agentFile())).toBe(false);
  }, 60_000);

  it("--key-store takes file or os-keychain only, and not on tempo", async () => {
    const bad = await run(["setup", "--rail", "evm", "--key-store", "vault", "--owner-key-file", ownerFile()]);
    expect(bad.code, all(bad)).toBe(2);
    const tempo = await run(["setup", "--rail", "tempo", "--key-store", "os-keychain", "--owner-key-file", ownerFile()]);
    expect(tempo.code, all(tempo)).toBe(2);
    expect(all(tempo)).toContain("tempo");
    expect(existsSync(agentFile())).toBe(false);
  }, 60_000);

  it("an existing file key moves to the keychain; a hard link to the old file then holds zeros", async () => {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key).address;
    write(agentFile(), `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=${agent}\n`);
    const size = statSync(agentFile()).size;
    const link = join(scratch, "backup.env");
    linkSync(agentFile(), link);
    const out = await setupEvm();
    expect(out.code, all(out)).toBe(0);
    expect(all(out)).toContain("moved the agent key into the keychain; the file's old bytes were overwritten");
    expect(read(agentFile())).toBe(`B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${agent}\n`);
    expect(kc.store()[`evm:${agent}`]).toBe(key);
    const old = readFileSync(link);
    expect(old.length).toBe(size);
    expect(old.every((b) => b === 0)).toBe(true);
    expect(all(out)).not.toContain(key);
  }, 120_000);

  it("a key file that cannot be replaced is refused with the file untouched; a rerun after chmod moves it", async () => {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key).address;
    const body = `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=${agent}\n`;
    write(agentFile(), body);
    const dir = join(home, "keys", "budget");
    chmodSync(dir, 0o500);
    try {
      const out = await setupEvm();
      expect(out.code, all(out)).toBe(3);
      expect(all(out)).toContain("the key file was not changed");
      expect(read(agentFile())).toBe(body);
      expect(all(out)).not.toContain(key);
    } finally {
      chmodSync(dir, 0o700);
    }
    const again = await setupEvm();
    expect(again.code, all(again)).toBe(0);
    expect(read(agentFile())).toBe(`B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${agent}\n`);
    expect(kc.store()[`evm:${agent}`]).toBe(key);
  }, 120_000);

  it("setup run again reuses the key in the keychain", async () => {
    const first = await setupEvm();
    const agent = agentOf(read(agentFile()));
    const again = await setupEvm();
    expect(first.code, all(first)).toBe(0);
    expect(again.code, all(again)).toBe(0);
    expect(all(again)).toContain(`reusing it (agent ${agent}); the key is in the OS keychain`);
    expect(Object.keys(kc.store())).toEqual([`evm:${agent}`]);
  }, 120_000);
});

describe("budget doctor", () => {
  it("reports the keychain, and fails when the entry is gone", async () => {
    await setupEvm();
    const agent = agentOf(read(agentFile()));
    const ok = await run(["doctor", "--rail", "evm"]);
    expect(ok.stderr).toMatch(/ok\s+agent key in the OS keychain/);
    expect(ok.stderr).toContain("key storage: OS keychain");
    expect(ok.stderr).toMatch(/ok\s+budget folders/);
    expect(ok.stderr).not.toMatch(/FAIL\s+agent key file/);
    kc.setStore({});
    const gone = await run(["doctor", "--rail", "evm"]);
    expect(gone.stderr).toMatch(/FAIL\s+agent key in the OS keychain: the agent key for .* is not in the keychain/);
    expect(gone.code).not.toBe(0);
    expect(agent).toMatch(/^0x/);
  }, 120_000);

  it("a key file says it is a file key: the storage line says so", async () => {
    const key = generatePrivateKey();
    write(agentFile(), `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=${privateKeyToAccount(key).address}\n`);
    const r = await run(["doctor", "--rail", "evm"]);
    expect(r.stderr).toContain("key storage: file (testnet only; mainnet will require the OS keychain)");
  }, 60_000);
});

describe("the budget folders are checked before anything is written", () => {
  it("keys/budget as a symlink: setup refuses and writes nothing through it", async () => {
    const elsewhere = join(scratch, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(home, "keys"), { mode: 0o700 });
    symlinkSync(elsewhere, join(home, "keys", "budget"));
    const out = await run(["setup", "--rail", "evm", "--owner-key-file", ownerFile()]);
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toContain("symlink");
    expect(existsSync(join(elsewhere, "evm-agent.env"))).toBe(false);
  }, 60_000);

  it("budget/public writable by others: setup refuses", async () => {
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "budget", "public"), 0o777);
    const out = await run(["setup", "--rail", "evm", "--owner-key-file", ownerFile()]);
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toContain("other users can write to");
    expect(existsSync(agentFile())).toBe(false);
  }, 60_000);

  it("budget/ops writable by others: buy refuses before it signs", async () => {
    const out = await run(["setup", "--rail", "evm", "--owner-key-file", ownerFile()]);
    expect(out.code, all(out)).toBe(0);
    const agent = agentOf(read(join(home, "budget", "public", "evm-base-sepolia.env")));
    const seller = await fund(agent);
    mkdirSync(join(home, "budget", "ops", "evm-base-sepolia"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "budget", "ops", "evm-base-sepolia"), 0o777);
    const r = await buy(seller.url, "ks9");
    expect(r.code, all(r)).not.toBe(0);
    expect(all(r)).toContain("other users can write to");
    expect(seller.creds).toEqual([]);
    expect(chain.sentRaw).toEqual([]);
  }, 120_000);

  it("doctor names an unsafe budget folder", async () => {
    mkdirSync(join(home, "budget", "approvals"), { recursive: true, mode: 0o700 });
    chmodSync(join(home, "budget", "approvals"), 0o777);
    const r = await run(["doctor", "--rail", "evm"]);
    expect(r.stderr).toMatch(/FAIL\s+budget folders: .*other users can write to/);
  }, 60_000);
});

describe("solana: setup --key-store os-keychain", () => {
  const solOwner = Keypair.fromSeed(new Uint8Array(32).fill(4));
  const solOwnerFile = () => { const p = join(scratch, "owner-sol.env"); write(p, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(solOwner.secretKey)}\n`); return p; };
  const setupSol = () => run(["setup", "--rail", "solana", "--key-store", "os-keychain", "--owner-key-file", solOwnerFile()]);

  it("keeps the key out of the file, which keeps the owner's address; the rail loads the key from the keychain", async () => {
    const out = await setupSol();
    expect(out.code, all(out)).toBe(0);
    const text = read(solAgentFile());
    expect(text).toContain("SOLANA_AGENT_KEY_STORE=os-keychain");
    expect(text).not.toContain("SOLANA_AGENT_SECRET_BASE58");
    expect(text).toContain(`SOLANA_OWNER_ADDRESS=${solOwner.publicKey.toBase58()}`);
    const agent = text.match(/^SOLANA_AGENT_ADDRESS=(.*)$/m)![1];
    const secret = kc.store()[`solana:${agent}`];
    expect(Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58()).toBe(agent);
    expect(all(out)).not.toContain(secret);
    for (const c of kc.calls()) expect(JSON.stringify(c.argv)).not.toContain(secret.slice(0, 30));
    const who = await run(["--address"], { script: SOLANA_ROTATE });
    expect(who.code, all(who)).toBe(0);
    expect(who.stdout + who.stderr).toContain(agent);
  }, 120_000);

  it("an entry for another key is refused; a missing one too", async () => {
    await setupSol();
    const agent = read(solAgentFile()).match(/^SOLANA_AGENT_ADDRESS=(.*)$/m)![1];
    kc.setStore({ [`solana:${agent}`]: bs58.encode(Keypair.generate().secretKey) });
    const other = await run(["--address"], { script: SOLANA_ROTATE });
    expect(other.code, all(other)).not.toBe(0);
    expect(all(other)).toContain("does not match");
    kc.setStore({});
    const gone = await run(["--address"], { script: SOLANA_ROTATE });
    expect(gone.code, all(gone)).not.toBe(0);
    expect(all(gone)).toContain("is not in the keychain");
  }, 120_000);

  it("an existing file key moves to the keychain and a hard link to the old file holds zeros", async () => {
    const kp = Keypair.generate();
    const agent = kp.publicKey.toBase58();
    write(solAgentFile(), `# Solana devnet AGENT key.\nSOLANA_AGENT_SECRET_BASE58=${bs58.encode(kp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n`);
    const size = statSync(solAgentFile()).size;
    const link = join(scratch, "backup-sol.env");
    linkSync(solAgentFile(), link);
    const out = await setupSol();
    expect(out.code, all(out)).toBe(0);
    expect(kc.store()[`solana:${agent}`]).toBe(bs58.encode(kp.secretKey));
    expect(read(solAgentFile())).not.toContain("SOLANA_AGENT_SECRET_BASE58");
    const old = readFileSync(link);
    expect(old.length).toBe(size);
    expect(old.every((b) => b === 0)).toBe(true);
  }, 120_000);

  it("a key file that cannot be replaced is refused with the file untouched; a rerun after chmod moves it", async () => {
    const kp = Keypair.generate();
    const agent = kp.publicKey.toBase58();
    const body = `# Solana devnet AGENT key.\nSOLANA_AGENT_SECRET_BASE58=${bs58.encode(kp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n`;
    write(solAgentFile(), body);
    const dir = join(home, "keys", "budget");
    chmodSync(dir, 0o500);
    try {
      const out = await setupSol();
      expect(out.code, all(out)).toBe(3);
      expect(all(out)).toContain("the key file was not changed");
      expect(read(solAgentFile())).toBe(body);
    } finally {
      chmodSync(dir, 0o700);
    }
    const again = await setupSol();
    expect(again.code, all(again)).toBe(0);
    expect(read(solAgentFile())).not.toContain("SOLANA_AGENT_SECRET_BASE58");
    expect(kc.store()[`solana:${agent}`]).toBe(bs58.encode(kp.secretKey));
  }, 120_000);

  it("a file that names the keychain and also holds a key is refused", async () => {
    const out = await setupSol();
    expect(out.code, all(out)).toBe(0);
    const agent = read(solAgentFile()).match(/^SOLANA_AGENT_ADDRESS=(.*)$/m)![1];
    const secret = kc.store()[`solana:${agent}`];
    write(solAgentFile(), `SOLANA_AGENT_KEY_STORE=os-keychain\nSOLANA_AGENT_ADDRESS=${agent}\nSOLANA_AGENT_SECRET_BASE58=${secret}\n`);
    const both = await run(["--address"], { script: SOLANA_ROTATE });
    expect(both.code, all(both)).not.toBe(0);
    expect(all(both)).toContain("names the keychain and also holds a key");
  }, 120_000);

  it("no keychain tool: refused, no file", async () => {
    const out = await run(["setup", "--rail", "solana", "--key-store", "os-keychain", "--owner-key-file", solOwnerFile()], { bare: true });
    expect(out.code, all(out)).toBe(3);
    expect(existsSync(solAgentFile())).toBe(false);
  }, 60_000);
});

describe("rotate and a key in the keychain", () => {
  it("the new key goes to the keychain too, and the old entry stays", async () => {
    const out = await setupEvm();
    expect(out.code, all(out)).toBe(0);
    const old = agentOf(read(agentFile()));
    const oldKey = kc.store()[`evm:${old}`];
    chain.setUsdc(owner.address, usdc("100"));
    chain.setNative(owner.address, 10n ** 20n);
    chain.setNative(old as `0x${string}`, 10n ** 17n);
    chain.setAllowance(owner.address, old as `0x${string}`, usdc("1"));
    const r = await run(["rotate", "--rail", "evm", "--owner-key-file", ownerFile(), "--yes"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "rotated", oldAgent: old });
    const fresh = r.result.newAgent as string;
    expect(read(agentFile())).toBe(`B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${fresh}\n`);
    // the old key's entry stays (funds left at the retired address can still be moved), the new one is there, and the retired file holds no key
    expect(Object.keys(kc.store()).sort()).toEqual([`evm:${fresh}`, `evm:${old}`].sort());
    expect(kc.store()[`evm:${old}`]).toBe(oldKey);
    const kept = read(join(home, "keys", "budget", "retired", `evm-${old.toLowerCase()}.env`));
    expect(kept).toContain("B4_AGENT_KEY_STORE=os-keychain");
    expect(kept).not.toContain(oldKey);
    expect(all(r)).not.toContain(oldKey);
  }, 240_000);

  it("rotate() never asks to forget the old key: the retired key stays in the keychain", async () => {
    const calls: string[] = [];
    const rec: any[] = [];
    const steps = {
      planChain: async () => ({ code: 0, result: { plan: { unreadable: [], openOps: [] } }, hosted: null }),
      retire: async () => ({ code: 0 }), recoverChain: async () => ({ code: 0, result: {} }), readStopped: async () => true,
      swapKey: async () => ({ code: 0 }), clearChain: async () => ({ code: 0 }),
      setupChain: async () => ({ code: 0, result: { agent: "0x5A7E31B9ab6D47Ca3F195Ff737ffe6105bAe3FEd" } }),
      writeRecord: (r: any) => { rec.push(structuredClone(r)); },
      forgetOldKey: async () => { calls.push("forget"); },
    };
    const OLD = "0x37DeDeEa845A7772BD4decfe573EaaBf660ad537";
    const ok = await rotate({ rail: "evm", currentAgent: OLD, existing: null, chains: ["base-sepolia"], steps });
    expect(ok.code).toBe(0);
    expect(rec.at(-1)?.finishedAt).toBeTruthy();
    expect(calls).toEqual([]);
  }, 30_000);
});

// A move into the keychain that was killed after the key file was overwritten and before the replacement was renamed over it
// leaves: the key in the keychain, a key file of zeros, and the hidden replacement. `setup` finishes it, or says where the key is.
describe("an interrupted move into the keychain", () => {
  const solOwner = Keypair.fromSeed(new Uint8Array(32).fill(4));
  const solOwnerFile = () => { const p = join(scratch, "owner-sol.env"); write(p, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(solOwner.secretKey)}\n`); return p; };
  /** The pid of a process that has ended. */
  const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;
  const keysDir = () => join(home, "keys", "budget");
  const zeros = (path: string, size: number) => writeFileSync(path, Buffer.alloc(size), { mode: 0o600 });
  const noKey = new RegExp("B4_AGENT_KEY=|SOLANA_AGENT_SECRET_BASE58=");

  function crashEvm(o: { pid?: number; entry?: string | null } = {}) {
    const key = generatePrivateKey();
    const agent = privateKeyToAccount(key).address;
    const replacement = join(keysDir(), `.evm-agent.env.${o.pid ?? deadPid()}.0123abcd.tmp`);
    const text = `B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${agent}\nB4_OWNER_SIGNATURE=x\n`;
    write(replacement, text);
    zeros(agentFile(), 120);
    if (o.entry !== null) kc.setStore({ [`evm:${agent}`]: o.entry ?? key });
    return { key, agent, replacement, text };
  }
  function crashSol(o: { pid?: number } = {}) {
    const kp = Keypair.generate();
    const agent = kp.publicKey.toBase58();
    const replacement = join(keysDir(), `.solana-agent.env.${o.pid ?? deadPid()}.0123abcd.tmp`);
    const text = `# Solana devnet AGENT key, kept in the OS keychain. Only buy opens this file. No owner secret here.\nSOLANA_AGENT_KEY_STORE=os-keychain\nSOLANA_AGENT_ADDRESS=${agent}\nSOLANA_OWNER_ADDRESS=${solOwner.publicKey.toBase58()}\n`;
    write(replacement, text);
    zeros(solAgentFile(), 200);
    kc.setStore({ [`solana:${agent}`]: bs58.encode(kp.secretKey) });
    return { secret: bs58.encode(kp.secretKey), agent, replacement, text };
  }
  const setupAgain = (rail: "evm" | "solana", env: Record<string, string | undefined> = {}) =>
    run(["setup", "--rail", rail, "--owner-key-file", rail === "evm" ? ownerFile() : solOwnerFile()], { env });
  const stillZeros = (path: string) => readFileSync(path).every((b) => b === 0) && readFileSync(path).length > 0;

  it("evm: setup finishes a move a killed setup left half done", async () => {
    const c = crashEvm();
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(0);
    expect(all(out)).toContain("finished moving the agent key into the keychain");
    expect(all(out)).toContain("the key is in the OS keychain");
    expect(read(agentFile())).toContain(c.text.split("\n")[2]);
    expect(read(agentFile()).startsWith(`B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${c.agent}\nB4_OWNER_SIGNATURE=x\n`)).toBe(true);
    expect(existsSync(c.replacement)).toBe(false);
    expect(all(out)).not.toContain(c.key);
  }, 120_000);

  it("evm: a locked keychain: setup refuses, changes nothing, and says where the key is", async () => {
    const c = crashEvm();
    const out = await setupAgain("evm", { FAKE_KEYCHAIN_FAIL: "1" });
    expect(out.code, all(out)).toBe(3);
    expect(out.result.state).toBe("refused_precheck");
    // the RESULT line's reason is cut at 300 characters by the dispatcher; the whole of it is on stderr
    expect(all(out)).toContain(c.replacement);
    expect(all(out)).toContain(`names agent ${c.agent}`);
    expect(out.result.next).toMatch(/^unlock the keychain/);
    expect(out.result.next).toContain("do not start a new agent");
    expect(stillZeros(agentFile())).toBe(true);
    expect(read(c.replacement)).toBe(c.text);
  }, 120_000);

  it("evm: no replacement left: setup names the keychain entry from the public file", async () => {
    const c = crashEvm();
    rmSync(c.replacement);
    write(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_AGENT_ADDRESS=${c.agent}\n`, 0o644);
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(3);
    // the RESULT line cuts its words at 300 characters: the warning leads `next`, and the whole text is on stderr
    expect(out.result.next).toMatch(/^Do not start a new agent/);
    expect(all(out)).toContain(`account evm:${c.agent}`);
    expect(all(out)).toContain(`secret-tool lookup service superstables-budget-agent account evm:${c.agent}`);
    expect(all(out)).toContain("B4_AGENT_KEY_STORE=os-keychain");
    expect(stillZeros(agentFile())).toBe(true);
  }, 120_000);

  it("evm: no replacement and no public file: the entry is named by its pattern", async () => {
    const c = crashEvm();
    rmSync(c.replacement);
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toContain("account evm:<the agent's address>");
    expect(all(out)).toContain("B4_AGENT_ADDRESS=ADDRESS");
    expect(stillZeros(agentFile())).toBe(true);
  }, 120_000);

  it("evm: a keychain entry of another key is not trusted", async () => {
    const c = crashEvm({ entry: generatePrivateKey() });
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(3);
    expect(out.result.reason).toContain("holds the key of another address");
    expect(stillZeros(agentFile())).toBe(true);
    expect(read(c.replacement)).toBe(c.text);
  }, 120_000);

  it("evm: a replacement whose process is alive is left to it", async () => {
    const c = crashEvm({ pid: process.pid });
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(3);
    expect(out.result.reason).toContain("another setup (process");
    expect(stillZeros(agentFile())).toBe(true);
    expect(read(c.replacement)).toBe(c.text);
  }, 120_000);

  it("evm: a stray replacement beside a good key file changes nothing", async () => {
    const first = await setupEvm();
    expect(first.code, all(first)).toBe(0);
    const before = read(agentFile());
    const stray = join(keysDir(), `.evm-agent.env.${deadPid()}.0123abcd.tmp`);
    write(stray, `B4_AGENT_KEY_STORE=os-keychain\nB4_AGENT_ADDRESS=${privateKeyToAccount(generatePrivateKey()).address}\n`);
    const out = await setupAgain("evm");
    expect(out.code, all(out)).toBe(0);
    expect(all(out)).toContain("reusing it");
    expect(read(agentFile())).toBe(before);
    expect(existsSync(stray)).toBe(true);
  }, 120_000);

  it("solana: setup finishes a move a killed setup left half done", async () => {
    const c = crashSol();
    const out = await setupAgain("solana");
    expect(out.code, all(out)).toBe(0);
    expect(all(out)).toContain("finished moving the agent key into the keychain");
    expect(all(out)).toContain("the key is in the OS keychain");
    expect(read(solAgentFile())).toBe(c.text);
    expect(existsSync(c.replacement)).toBe(false);
    expect(all(out)).not.toContain(c.secret);
  }, 120_000);

  it("solana: a locked keychain: setup refuses, changes nothing, and never says to start over", async () => {
    const c = crashSol();
    const out = await setupAgain("solana", { FAKE_KEYCHAIN_FAIL: "1" });
    expect(out.code, all(out)).toBe(3);
    expect(all(out)).toContain(c.replacement);
    expect(all(out)).toContain(`names agent ${c.agent}`);
    expect(out.result.next).toMatch(/^unlock the keychain/);
    expect(all(out)).not.toContain("start over");
    expect(stillZeros(solAgentFile())).toBe(true);
    expect(read(c.replacement)).toBe(c.text);
    expect(noKey.test(read(c.replacement))).toBe(false);
  }, 120_000);
});
