// `superstables budget rotate` replaces an evm or solana agent key and retires the old one. The real dispatcher and rail scripts,
// against a fake EVM chain and a fake Solana devnet on 127.0.0.1, with the owner's steps signed by a test key file. No network,
// no real key. The order of the steps is checked with fake steps in rotate-plan.test.ts, the list in retired.test.ts.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lockFile } from "../../budget/op-lock.mjs";
import { startFakeEvm, usdc, type FakeEvm } from "../helpers/fake-evm.js";
import { startFakeSolana, type FakeSolana } from "../helpers/fake-chains.js";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "budget/cli.mjs");

type Out = { code: number; stdout: string; stderr: string; result: any };
let home: string;
const cleanups: (() => unknown)[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-rotate-")); });
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  rmSync(home, { recursive: true, force: true });
});

const file = (...p: string[]) => join(home, ...p);
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode });
};
function budget(args: string[], env: Record<string, string> = {}, killAfterMs = 0, root = ROOT): Promise<Out> {
  return new Promise((done, fail) => {
    const e: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, ...env };
    delete e.SUPERSTABLES_SITE;
    delete e.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [root === ROOT ? CLI : join(root, "budget/cli.mjs"), ...args], { cwd: root, env: e });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    const killer = killAfterMs ? setTimeout(() => child.kill("SIGKILL"), killAfterMs) : null;
    child.once("error", fail);
    child.once("close", (code) => {
      if (killer) clearTimeout(killer);
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;

// ---- evm ---------------------------------------------------------------------------------------------------------------
const PUBLIC_EVM = () => file("budget", "public", "evm-base-sepolia.env");
const ownerEvmKey = generatePrivateKey();
const OWNER = privateKeyToAccount(ownerEvmKey);

// The chain's verdicts need two endpoints run by different operators (a copy of the client whose endpoint table names the fakes).
let evmTree: EndpointTree;
beforeAll(() => { evmTree = endpointTree(); });
afterAll(() => evmTree.close());

type Evm = { chain: FakeEvm; env: Record<string, string>; agent: ReturnType<typeof privateKeyToAccount>; ownerFile: string; run: (args: string[]) => Promise<Out> };
/** A base-sepolia chain where the owner granted 1 USDC and the agent holds 0.5 USDC and gas, set up as `setup` leaves it. */
async function evmCase(opts: { allow?: string; held?: string } = {}): Promise<Evm> {
  const chain = await startFakeEvm();
  cleanups.push(() => chain.close());
  const agentKey = generatePrivateKey();
  const agent = privateKeyToAccount(agentKey);
  chain.setUsdc(OWNER.address, usdc("100"));
  chain.setNative(OWNER.address, 10n ** 20n);
  chain.setNative(agent.address, 10n ** 17n);
  chain.setUsdc(agent.address, usdc(opts.held ?? "0.5"));
  chain.setAllowance(OWNER.address, agent.address, usdc(opts.allow ?? "1"));
  write(file("keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent.address}\n`);
  write(PUBLIC_EVM(), `# Base Sepolia public state\nB4_OWNER_ADDRESS=${OWNER.address}\nB4_AGENT_ADDRESS=${agent.address}\nB4_CAP=1000000\nB4_SET_AT=1760000000\n`, 0o644);
  const ownerFile = file("owner.env");
  write(ownerFile, `B4_OWNER_KEY=${ownerEvmKey}\n`);
  const env = { B4_RPC: chain.url };
  const mirror = await chain.mirror();
  cleanups.push(() => mirror.close());
  evmTree.set({ "base-sepolia": [{ url: chain.url, operator: "fake-a" }, { url: mirror.url, operator: "fake-b" }] });
  return { chain, env, agent, ownerFile, run: (args) => budget(args, env, 0, evmTree.root) };
}
const sendsOf = (chain: FakeEvm) => chain.rpcLog.filter((c) => c.method === "eth_sendRawTransaction").length;
const retiredList = () => JSON.parse(readFileSync(file("keys", "budget", "retired.json"), "utf8"));

describe("rotate, evm", () => {
  it("replaces the key: the allowance ends, the funds go back, the old key is kept aside and retired", async () => {
    const e = await evmCase();
    const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ command: "rotate", rail: "evm", state: "rotated", oldAgent: e.agent.address, retired: true });
    expect(r.result.newAgent).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(r.result.newAgent.toLowerCase()).not.toBe(e.agent.address.toLowerCase());
    expect(r.result.chains).toEqual([{ chain: "base-sepolia", recovered: true, setUp: true, hosted: null, revocation: expect.objectContaining({ final: true }) }]);
    expect(r.result.next).toMatch(/budget grant --rail evm --chain base-sepolia --amount A/);
    // the chain: the allowance is 0, and the 0.5 USDC went back to the owner
    expect(e.chain.allowanceOf(OWNER.address, e.agent.address)).toBe(0n);
    expect(e.chain.usdcOf(e.agent.address)).toBe(0n);
    expect(e.chain.usdcOf(OWNER.address)).toBe(usdc("100") + usdc("0.5"));
    // the list, the kept key, the new key and the public file
    expect(retiredList().retired).toMatchObject([{ rail: "evm", address: e.agent.address, reason: "rotate" }]);
    expect(statSync(file("keys", "budget", "retired.json")).mode & 0o777).toBe(0o600);
    const kept = readFileSync(file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`), "utf8");
    expect(kept).toContain("B4_AGENT_KEY=");
    const now = readFileSync(file("keys", "budget", "evm-agent.env"), "utf8");
    expect(now).not.toBe(kept);
    expect(now).toContain(r.result.newAgent);
    const pub = readFileSync(PUBLIC_EVM(), "utf8");
    expect(pub).toContain(`B4_AGENT_ADDRESS=${r.result.newAgent}`);
    expect(pub).toContain(`B4_OWNER_ADDRESS=${OWNER.address}`);
    expect(pub).not.toMatch(/B4_CAP|B4_SET_AT/);
    // the record says it finished
    const rec = JSON.parse(readFileSync(file("budget", "rotations", `evm-${e.agent.address.toLowerCase()}.json`), "utf8"));
    expect(rec).toMatchObject({ version: 1, rail: "evm", oldAgent: e.agent.address, newAgent: r.result.newAgent });
    expect(rec.finishedAt).toBeTruthy();
  }, 240_000);

  it("--plan sends nothing and leaves nothing behind", async () => {
    const e = await evmCase();
    const r = await e.run(["rotate", "--rail", "evm", "--plan"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "planned", oldAgent: e.agent.address, retired: false });
    expect(sendsOf(e.chain)).toBe(0);
    expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
    expect(existsSync(file("budget", "rotations"))).toBe(false);
    expect(readFileSync(file("keys", "budget", "evm-agent.env"), "utf8")).toContain(e.agent.address);
  }, 120_000);

  it("without --yes the key file does not send either: it stops at the plan", async () => {
    const e = await evmCase();
    const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result.state).toBe("planned");
    expect(r.result.next).toMatch(/--yes/);
    expect(sendsOf(e.chain)).toBe(0);
    expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
  }, 120_000);

  it("a journal that cannot be read refuses before anything is sent or retired", async () => {
    const e = await evmCase();
    write(file("budget", "ops", "evm-base-sepolia", "broken.json"), "{garbage");
    const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(r.code, all(r)).toBe(5);
    expect(r.result.reason).toContain("broken.json");
    expect(sendsOf(e.chain)).toBe(0);
    expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
    expect(e.chain.allowanceOf(OWNER.address, e.agent.address)).toBe(usdc("1"));
  }, 120_000);

  it("a step that fails stops it with the old address already retired; the next run finishes", async () => {
    const e = await evmCase();
    e.chain.hook = (method) => (method === "eth_sendRawTransaction" ? { error: { code: -32000, message: "the node refuses" } } : undefined);
    const first = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect([1, 5], all(first)).toContain(first.code);
    expect(first.result).toMatchObject({ state: "incomplete", oldAgent: e.agent.address, retired: true, final: false });
    expect(retiredList().retired[0].address).toBe(e.agent.address);
    // the key file is still the old one, and the record exists
    expect(readFileSync(file("keys", "budget", "evm-agent.env"), "utf8")).toContain(e.agent.address);
    expect(existsSync(file("budget", "rotations", `evm-${e.agent.address.toLowerCase()}.json`))).toBe(true);
    e.chain.hook = undefined;
    const second = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(second.code, all(second)).toBe(0);
    expect(second.result).toMatchObject({ state: "rotated", oldAgent: e.agent.address });
    expect(e.chain.allowanceOf(OWNER.address, e.agent.address)).toBe(0n);
    expect(retiredList().retired).toHaveLength(1);
  }, 360_000);

  it("a retired address is never armed again: grant, fund-agent, buy and setup refuse, and nothing is sent", async () => {
    const e = await evmCase();
    const done = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(done.code, all(done)).toBe(0);
    const sent = sendsOf(e.chain);
    // a hostile edit: the public file names the old agent again
    const pub = readFileSync(PUBLIC_EVM(), "utf8");
    write(PUBLIC_EVM(), pub.replace(/B4_AGENT_ADDRESS=.*/, `B4_AGENT_ADDRESS=${e.agent.address}`), 0o644);
    for (const args of [
      ["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", e.ownerFile, "--yes"],
      ["fund-agent", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"],
      ["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.05", "--op", "after-rotation"],
    ]) {
      const r = await e.run(args);
      expect(r.code, `${args[0]}: ${all(r)}`).toBe(3);
      expect(r.result.state).toBe("refused_precheck");
      expect(r.result.reason).toMatch(/was retired by `budget rotate`/);
    }
    expect(sendsOf(e.chain)).toBe(sent);
    // setup with the retired key file put back
    write(file("keys", "budget", "evm-agent.env"), readFileSync(file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`), "utf8"));
    const s = await e.run(["setup", "--rail", "evm", "--owner-key-file", e.ownerFile]);
    expect(s.code, all(s)).toBe(3);
    expect(s.result.reason).toMatch(/was retired by `budget rotate`/);
    expect(sendsOf(e.chain)).toBe(sent);
  }, 480_000);

  it("the public file is read the way the rails read it: export, quotes, the last line, a large file, an unreadable file", async () => {
    const e = await evmCase();
    const done = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(done.code, all(done)).toBe(0);
    const sent = sendsOf(e.chain);
    const clean = readFileSync(PUBLIC_EVM(), "utf8");
    const old = e.agent.address;
    const edits: [string, string][] = [
      ["export prefix", clean.replace(/B4_AGENT_ADDRESS=.*/, `export B4_AGENT_ADDRESS=${old}`)],
      ["double quotes", clean.replace(/B4_AGENT_ADDRESS=.*/, `B4_AGENT_ADDRESS="${old}"`)],
      ["single quotes", clean.replace(/B4_AGENT_ADDRESS=.*/, `B4_AGENT_ADDRESS='${old}'`)],
      ["a later line", `${clean}B4_AGENT_ADDRESS=${old}\n`],
      ["a file past 64 KiB", `${"# padding\n".repeat(8000)}${clean.replace(/B4_AGENT_ADDRESS=.*/, `B4_AGENT_ADDRESS=${old}`)}`],
    ];
    for (const [name, text] of edits) {
      write(PUBLIC_EVM(), text, 0o644);
      for (const args of [
        ["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", e.ownerFile, "--yes"],
        ["fund-agent", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"],
      ]) {
        const r = await e.run(args);
        expect(r.code, `${name}, ${args[0]}: ${all(r)}`).toBe(3);
        expect(r.result.reason, name).toMatch(/was retired by `budget rotate`/);
      }
    }
    // a public file that cannot be read is a refusal, not a pass
    rmSync(PUBLIC_EVM());
    mkdirSync(PUBLIC_EVM());
    const unreadable = await e.run(["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(unreadable.code, all(unreadable)).toBe(3);
    expect(unreadable.result.reason).toMatch(/cannot be read/);
    // a FIFO has no writer: it must be refused at once, not waited for
    rmSync(PUBLIC_EVM(), { recursive: true });
    execFileSync("mkfifo", [PUBLIC_EVM()]);
    for (const args of [
      ["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", e.ownerFile, "--yes"],
      ["fund-agent", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"],
      ["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.05", "--op", "fifo"],
    ]) {
      const started = Date.now();
      const r = await budget(args, e.env, 15_000);
      expect(r.code, `${args[0]} on a FIFO: ${all(r)}`).toBe(3);
      expect(Date.now() - started, `${args[0]} on a FIFO`).toBeLessThan(15_000);
    }
    expect(sendsOf(e.chain)).toBe(sent);
  }, 480_000);

  for (const kind of ["mode 000", "a directory"]) {
    it(`rotate refuses when another chain's public file cannot be read (${kind})`, async () => {
      if (kind === "mode 000" && process.getuid?.() === 0) return; // root reads a mode 000 file
      const e = await evmCase();
      const other = file("budget", "public", "evm-arc-testnet.env");
      const same = readFileSync(PUBLIC_EVM(), "utf8");
      if (kind === "mode 000") { write(other, same, 0o644); chmodSync(other, 0o000); } else mkdirSync(other, { recursive: true });
      const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
      expect(r.code, all(r)).toBe(3);
      expect(r.result.state).toBe("refused_precheck");
      expect(r.result.reason).toMatch(/arc-testnet.*cannot be read/);
      expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
      expect(sendsOf(e.chain)).toBe(0);
      if (kind === "mode 000") chmodSync(other, 0o644);
    }, 120_000);
  }

  it("a key file moved by hand before recover is put back, not rotated around", async () => {
    const e = await evmCase();
    const kept = file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`);
    write(kept, readFileSync(file("keys", "budget", "evm-agent.env"), "utf8"));
    rmSync(file("keys", "budget", "evm-agent.env"));
    const at = "2026-10-01T00:00:01.000Z";
    write(file("budget", "rotations", `evm-${e.agent.address.toLowerCase()}.json`), `${JSON.stringify({ version: 1, rail: "evm", oldAgent: e.agent.address, startedAt: at, retiredAt: at, chains: { "base-sepolia": {} } })}\n`);
    const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result.next).toContain(`move ${kept} back to ${file("keys", "budget", "evm-agent.env")}`);
    expect(sendsOf(e.chain)).toBe(0);
  }, 120_000);

  it("buy refuses a retired key file put back next to a clean public file", async () => {
    const e = await evmCase();
    expect((await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"])).code).toBe(0);
    const sent = sendsOf(e.chain);
    write(file("keys", "budget", "evm-agent.env"), readFileSync(file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`), "utf8"));
    expect(readFileSync(PUBLIC_EVM(), "utf8")).not.toContain(e.agent.address);
    const r = await e.run(["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.05", "--op", "restored-key"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result.reason).toMatch(/was retired by `budget rotate`/);
    expect(sendsOf(e.chain)).toBe(sent);
  }, 240_000);

  /** The state a rotation leaves when it stops after the key file moved: retired, recovered, key file in keys/budget/retired/. */
  async function stoppedAfterSwap(swapped: boolean) {
    const e = await evmCase();
    const kept = file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`);
    write(kept, readFileSync(file("keys", "budget", "evm-agent.env"), "utf8"));
    rmSync(file("keys", "budget", "evm-agent.env"));
    write(file("keys", "budget", "retired.json"), `${JSON.stringify({ version: 1, retired: [{ rail: "evm", address: e.agent.address, retiredAt: "2026-10-01T00:00:00.000Z", reason: "rotate" }] })}\n`);
    const at = "2026-10-01T00:00:01.000Z";
    write(file("budget", "rotations", `evm-${e.agent.address.toLowerCase()}.json`), `${JSON.stringify({ version: 1, rail: "evm", oldAgent: e.agent.address, startedAt: at, retiredAt: at, ...(swapped ? { swappedAt: at } : {}), chains: { "base-sepolia": { recoveredAt: at } } })}\n`);
    // the revoke the record names was made and marked in the public file before the key file moved
    write(PUBLIC_EVM(), `${readFileSync(PUBLIC_EVM(), "utf8")}B4_REVOKED_AT=1760000001\n`, 0o644);
    e.chain.setAllowance(OWNER.address, e.agent.address, 0n);
    e.chain.setUsdc(e.agent.address, 0n);
    return e;
  }
  for (const swapped of [false, true]) {
    it(`a rotation that stopped after the key file moved (${swapped ? "swap recorded" : "swap not recorded"}) is finished by the next run`, async () => {
      const e = await stoppedAfterSwap(swapped);
      const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
      expect(r.code, all(r)).toBe(0);
      expect(r.result).toMatchObject({ state: "rotated", oldAgent: e.agent.address });
      expect(r.result.newAgent).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(r.result.newAgent.toLowerCase()).not.toBe(e.agent.address.toLowerCase());
      expect(readFileSync(file("keys", "budget", "evm-agent.env"), "utf8")).toContain(r.result.newAgent);
      expect(readFileSync(PUBLIC_EVM(), "utf8")).toContain(`B4_AGENT_ADDRESS=${r.result.newAgent}`);
      expect(readFileSync(file("keys", "budget", "retired", `evm-${e.agent.address.toLowerCase()}.env`), "utf8")).toContain("B4_AGENT_KEY=");
      const rec = JSON.parse(readFileSync(file("budget", "rotations", `evm-${e.agent.address.toLowerCase()}.json`), "utf8"));
      expect(rec.swappedAt && rec.finishedAt).toBeTruthy();
      expect(retiredList().retired).toHaveLength(1);
    }, 240_000);
  }

  it("two rotations at once: the second is refused while the first holds the lock", async () => {
    const e = await evmCase();
    mkdirSync(file("budget", "rotations"), { recursive: true, mode: 0o700 });
    const lock = lockFile(file("budget", "rotations", "evm.lock"));
    expect(lock.ok).toBe(true);
    const r = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(r.code, all(r)).toBe(3);
    expect(r.result.reason).toMatch(/another rotate/);
    expect(r.result.next).toContain(file("budget", "rotations", "evm.lock"));
    expect(sendsOf(e.chain)).toBe(0);
    expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
    if (lock.ok) lock.release();
  }, 120_000);

  it("a second address is retired next to the first, not instead of it", async () => {
    const e = await evmCase();
    expect((await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"])).code).toBe(0);
    const first = retiredList().retired[0].address;
    const again = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
    expect(again.code, all(again)).toBe(0);
    const list = retiredList().retired.map((x: { address: string }) => x.address);
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(first);
    expect(list[1].toLowerCase()).toBe(again.result.oldAgent.toLowerCase());
  }, 480_000);

  it("tempo has no rotation: it says what to run instead", async () => {
    const r = await budget(["rotate", "--rail", "tempo"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/setup --rail tempo --agent LABEL/);
  }, 60_000);

  it("--chain is not taken", async () => {
    const r = await budget(["rotate", "--rail", "evm", "--chain", "base-sepolia"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/every chain the key is set up on/);
  }, 60_000);

  it("--detach is not a flag of rotate", async () => {
    const r = await budget(["rotate", "--rail", "evm", "--detach"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/unknown flag --detach/);
  }, 60_000);

  it("nothing to rotate without an agent key", async () => {
    const r = await budget(["rotate", "--rail", "evm"]);
    expect(r.code).toBe(3);
    expect(r.result.reason).toMatch(/no agent key/);
  }, 60_000);
});

describe("a retired-keys list that cannot be trusted refuses at once", () => {
  const bad: [string, (path: string) => void][] = [
    ["a FIFO", (path) => execFileSync("mkfifo", [path])],
    ["a 2 MiB file", (path) => writeFileSync(path, `{"version":1,"retired":[],"pad":"${"x".repeat(2 * 1024 * 1024)}"}`)],
    ["version 2", (path) => writeFileSync(path, '{"version":2,"retired":[]}')],
    ["an entry without its fields", (path) => writeFileSync(path, '{"version":1,"retired":[{"rail":"evm"}]}')],
    ["not JSON", (path) => writeFileSync(path, "{garbage")],
  ];
  for (const [name, make] of bad) {
    it(`${name}: grant refuses (exit 3) within seconds and names the list`, async () => {
      const e = await evmCase();
      make(file("keys", "budget", "retired.json"));
      const began = Date.now();
      const r = await e.run(["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", e.ownerFile, "--yes"]);
      expect(r.code, all(r)).toBe(3);
      expect(r.result.reason).toMatch(/retired-keys list .*retired\.json cannot be read/);
      expect(Date.now() - began).toBeLessThan(15_000);
      expect(sendsOf(e.chain)).toBe(0);
      // and rotate does not start on it either
      const rot = await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"]);
      expect(rot.code, all(rot)).toBe(3);
      expect(sendsOf(e.chain)).toBe(0);
    }, 120_000);
  }
});

// ---- solana ------------------------------------------------------------------------------------------------------------
const SOL_OWNER_KP = Keypair.fromSeed(new Uint8Array(32).fill(4));
const SOL_OWNER = SOL_OWNER_KP.publicKey.toBase58();
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_AGENT = SOL_AGENT_KP.publicKey.toBase58();

describe("rotate, solana", () => {
  let solana: FakeSolana;
  // The client runs from a copy whose endpoint table names the fake devnet: the read after the revoke confirms it through the
  // table's endpoints, never through an RPC that only the environment names.
  let tree: EndpointTree;
  beforeAll(() => { tree = endpointTree(); });
  afterAll(() => tree.close());
  beforeEach(async () => {
    solana = await startFakeSolana({ websocket: true });
    solana.acceptTokenTransactions = true;
    tree.set({ "solana-devnet": [solana.url] });
    cleanups.push(() => solana.close());
  });
  const run = (args: string[]) => budget(args, { SUPERSTABLES_SOLANA_RPC: solana.url }, 0, tree.root);
  const ownerFile = () => {
    const path = file("owner-sol.env");
    write(path, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(SOL_OWNER_KP.secretKey)}\n`);
    return path;
  };
  /** The owner granted the agent a delegation; the agent holds 0.02 SOL and 0.3 USDC. */
  function chain() {
    write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${SOL_OWNER}\n`);
    write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`, 0o644);
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 1_000_000n });
    solana.usdc.set(SOL_AGENT, { amount: 300_000n, delegate: null, delegated: 0n });
    solana.balances.set(SOL_OWNER, 1_000_000_000n);
    solana.balances.set(SOL_AGENT, 20_000_000n);
  }

  it("revokes the delegate, returns the agent's USDC and SOL, and sets up a new key for the same owner", async () => {
    chain();
    const r = await run(["rotate", "--rail", "solana", "--owner-key-file", ownerFile(), "--yes"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ command: "rotate", rail: "solana", state: "rotated", oldAgent: SOL_AGENT, retired: true });
    expect(r.result.newAgent).not.toBe(SOL_AGENT);
    expect(solana.usdc.get(SOL_OWNER)).toMatchObject({ delegate: null, delegated: 0n });
    expect(solana.usdc.get(SOL_AGENT)!.amount).toBe(0n);
    expect(solana.usdc.get(SOL_OWNER)!.amount).toBe(5_300_000n);
    expect(solana.balances.get(SOL_AGENT)).toBe(0n);
    expect(solana.calls.filter((c) => c === "sendTransaction").length).toBeGreaterThanOrEqual(3);
    expect(retiredList().retired).toMatchObject([{ rail: "solana", address: SOL_AGENT, reason: "rotate" }]);
    expect(readFileSync(file("keys", "budget", "retired", `solana-${SOL_AGENT}.env`), "utf8")).toContain("SOLANA_AGENT_SECRET_BASE58=");
    const now = readFileSync(file("keys", "budget", "solana-agent.env"), "utf8");
    expect(now).toContain(`SOLANA_AGENT_ADDRESS=${r.result.newAgent}`);
    expect(now).toContain(`SOLANA_OWNER_ADDRESS=${SOL_OWNER}`);
    expect(readFileSync(file("budget", "public", "solana-devnet.env"), "utf8")).toContain(`SOLANA_AGENT_ADDRESS=${r.result.newAgent}`);
    // the old key can no longer be granted, funded or set up here
    write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`, 0o644);
    const sent = solana.calls.filter((c) => c === "sendTransaction").length;
    for (const args of [["grant", "--rail", "solana", "--amount", "0.05"], ["fund-agent", "--rail", "solana"]]) {
      const g = await run([...args, "--owner-key-file", ownerFile(), "--yes"]);
      expect(g.code, all(g)).toBe(3);
      expect(g.result.reason).toMatch(/was retired by `budget rotate`/);
    }
    expect(solana.calls.filter((c) => c === "sendTransaction").length).toBe(sent);
  }, 360_000);

  it("the public file's last agent line and a large file are read like the rail reads them; a retired key file is refused by buy", async () => {
    chain();
    const r = await run(["rotate", "--rail", "solana", "--owner-key-file", ownerFile(), "--yes"]);
    expect(r.code, all(r)).toBe(0);
    const sent = solana.calls.filter((c) => c === "sendTransaction").length;
    const publicPath = file("budget", "public", "solana-devnet.env");
    const clean = readFileSync(publicPath, "utf8");
    for (const [name, text] of [
      ["a later line", `${clean}SOLANA_AGENT_ADDRESS=${SOL_AGENT}\n`],
      ["a file past 64 KiB", `${"# padding\n".repeat(8000)}${clean.replace(/SOLANA_AGENT_ADDRESS=.*/, `SOLANA_AGENT_ADDRESS=${SOL_AGENT}`)}`],
    ]) {
      write(publicPath, text, 0o644);
      for (const args of [["grant", "--rail", "solana", "--amount", "0.05"], ["fund-agent", "--rail", "solana"]]) {
        const g = await run([...args, "--owner-key-file", ownerFile(), "--yes"]);
        expect(g.code, `${name}, ${args[0]}: ${all(g)}`).toBe(3);
        expect(g.result.reason, name).toMatch(/was retired by `budget rotate`/);
      }
    }
    write(publicPath, clean, 0o644);
    write(file("keys", "budget", "solana-agent.env"), readFileSync(file("keys", "budget", "retired", `solana-${SOL_AGENT}.env`), "utf8"));
    const b = await run(["buy", "--rail", "solana", "--url", "http://127.0.0.1:9/paid", "--max", "0.05", "--op", "restored-key"]);
    expect(b.code, all(b)).toBe(3);
    expect(b.result.reason).toMatch(/was retired by `budget rotate`/);
    expect(solana.calls.filter((c) => c === "sendTransaction").length).toBe(sent);
  }, 480_000);

  it("a rotation that stopped after the key file moved is finished by the next run", async () => {
    chain();
    const kept = file("keys", "budget", "retired", `solana-${SOL_AGENT}.env`);
    write(kept, readFileSync(file("keys", "budget", "solana-agent.env"), "utf8"));
    rmSync(file("keys", "budget", "solana-agent.env"));
    write(file("keys", "budget", "retired.json"), `${JSON.stringify({ version: 1, retired: [{ rail: "solana", address: SOL_AGENT, retiredAt: "2026-10-01T00:00:00.000Z", reason: "rotate" }] })}\n`);
    const at = "2026-10-01T00:00:01.000Z";
    write(file("budget", "rotations", `solana-${SOL_AGENT}.json`), `${JSON.stringify({ version: 1, rail: "solana", oldAgent: SOL_AGENT, startedAt: at, retiredAt: at, chains: { devnet: { revokedAt: at, sweptAt: at } } })}\n`);
    write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nREVOKED_AT=1760000001\n`, 0o644);
    solana.usdc.set(SOL_OWNER, { amount: 5_300_000n, delegate: null, delegated: 0n });
    solana.usdc.set(SOL_AGENT, { amount: 0n, delegate: null, delegated: 0n });
    const r = await run(["rotate", "--rail", "solana", "--owner-key-file", ownerFile(), "--yes"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "rotated", oldAgent: SOL_AGENT });
    expect(readFileSync(file("keys", "budget", "solana-agent.env"), "utf8")).toContain(`SOLANA_AGENT_ADDRESS=${r.result.newAgent}`);
    expect(readFileSync(file("budget", "public", "solana-devnet.env"), "utf8")).toContain(`SOLANA_AGENT_ADDRESS=${r.result.newAgent}`);
  }, 240_000);

  it("--plan names the agent's funds and sends nothing", async () => {
    chain();
    const r = await run(["rotate", "--rail", "solana", "--plan"]);
    expect(r.code, all(r)).toBe(0);
    expect(r.result).toMatchObject({ state: "planned", oldAgent: SOL_AGENT, retired: false });
    expect(solana.calls).not.toContain("sendTransaction");
    expect(existsSync(file("keys", "budget", "retired.json"))).toBe(false);
  }, 120_000);

  it("an operation that stays undecided stops it before the agent's funds move", async () => {
    chain();
    write(file("budget", "ops", "solana-devnet", "pending-1.json"), JSON.stringify({ op: "pending-1", state: "submitted", history: [{ at: "2026-10-01T00:00:00Z", state: "submitted" }], agent: SOL_AGENT, agentSig: bs58.encode(Buffer.alloc(64, 7)), blockhash: bs58.encode(Buffer.alloc(32, 9)), lastValidBlockHeight: 10 ** 9 }));
    const r = await run(["rotate", "--rail", "solana", "--owner-key-file", ownerFile(), "--yes"]);
    expect([1, 5], all(r)).toContain(r.code);
    expect(r.result).toMatchObject({ state: "incomplete", retired: true });
    expect(solana.usdc.get(SOL_AGENT)!.amount).toBe(300_000n);
    expect(readFileSync(file("keys", "budget", "solana-agent.env"), "utf8")).toContain(SOL_AGENT);
  }, 240_000);
});

describe("the files rotate leaves", () => {
  it("the folders it creates are private", async () => {
    const e = await evmCase();
    expect((await e.run(["rotate", "--rail", "evm", "--owner-key-file", e.ownerFile, "--yes"])).code).toBe(0);
    for (const d of [file("keys", "budget", "retired")]) expect(statSync(d).mode & 0o077).toBe(0);
    for (const f of readdirSync(file("keys", "budget", "retired"))) expect(statSync(file("keys", "budget", "retired", f)).mode & 0o077).toBe(0);
  }, 240_000);
});


describe("--clear-agent forgets the owner's signature for the old agent", () => {
  const TSX = resolve(ROOT, "node_modules/.bin/tsx");
  const setupLines = "SETUP_MESSAGE=abc\nSETUP_SIGNATURE=0xdead\nSETUP_SIGNED_AT=2026-10-16T10:00:00.000Z\n";
  it("evm: no SETUP_* line is left, the owner stays", () => {
    const agent = privateKeyToAccount(generatePrivateKey()).address;
    write(PUBLIC_EVM(), `B4_OWNER_ADDRESS=${OWNER.address}\nB4_AGENT_ADDRESS=${agent}\n${setupLines}`, 0o644);
    execFileSync(TSX, [resolve(ROOT, "budget/evm/rotate.ts"), "--clear-agent", agent], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: home } });
    const pub = readFileSync(PUBLIC_EVM(), "utf8");
    expect(pub).not.toMatch(/^SETUP_/m);
    expect(pub).toContain(`B4_OWNER_ADDRESS=${OWNER.address}`);
  }, 60_000);
  it("solana: no SETUP_* line is left, the owner stays", () => {
    const pubPath = file("budget", "public", "solana-devnet.env");
    write(pubPath, `SOLANA_OWNER_ADDRESS=${SOL_OWNER}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n${setupLines}`, 0o644);
    execFileSync(process.execPath, [resolve(ROOT, "budget/solana/rotate.mjs"), "--clear-agent", SOL_AGENT], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: home } });
    const pub = readFileSync(pubPath, "utf8");
    expect(pub).not.toMatch(/^SETUP_/m);
    expect(pub).toContain(`SOLANA_OWNER_ADDRESS=${SOL_OWNER}`);
  }, 60_000);
});
