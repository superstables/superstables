// An EVM budget purchase signs once, over exactly the option that passed the prechecks, for at most ten minutes; purchases on one
// agent key take turns; on Arc a price left in the agent key is not gas reserve. Each case runs the real `budget` CLI against an
// in-memory chain (test/helpers/fake-evm.ts) and a seller on this computer.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationTypes } from "@x402/evm";
import { afterAll, describe, expect, it } from "vitest";
import {
  ARC_USDC, AGENT, OWNER, makeChain, makeHome, startSeller, usdc, type FakeEvm, type SellerOpts,
} from "../helpers/fake-evm.js";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "budget/cli.mjs");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const HELPERS = join(ROOT, "test/helpers");
const preload = (file: string) => `--import=${join(HELPERS, file)}`;
const { lockFile, requireKeyLock, keyLockFile } = (await import(new URL("../../budget/op-lock.mjs", import.meta.url).href)) as any;
const { createIdentitySource } = (await import(new URL("../../src/core/process-identity.mjs", import.meta.url).href)) as any;
const { checkAccept, typedDataProblem, MAX_AUTH_LIFETIME_S, MIN_AUTH_LIFETIME_S, CLOCK_SLACK_S, capChallengeBody } = (await import(new URL("../../budget/evm/purchase.ts", import.meta.url).href)) as any;
const lib = (await import(new URL("../../budget/evm/lib.ts", import.meta.url).href)) as any;

const cleanups: (() => unknown)[] = [];
afterAll(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

type Run = { code: number | null; stdout: string; stderr: string; result: any };
function run(argv: string[], env: Record<string, string>, extraNodeOptions = "", script = CLI): Promise<Run> & { child: ReturnType<typeof spawn>; out: () => string } {
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} ${extraNodeOptions}`.trim();
  const child = spawn(script === CLI ? process.execPath : TSX, script === CLI ? [CLI, ...argv] : [script, ...argv], { cwd: ROOT, env: { ...process.env, ...env, NODE_OPTIONS: nodeOptions } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const p: any = new Promise((res, rej) => {
    child.once("error", rej);
    child.once("close", (code) => {
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      let result: any = null;
      try { result = line ? JSON.parse(line.slice(7)) : null; } catch {}
      res({ code, stdout, stderr, result });
    });
  });
  p.child = child;
  p.out = () => stdout + stderr;
  return p;
}

type Setup = { chain: FakeEvm; home: ReturnType<typeof makeHome>; chainKey: string; chainId: number };
async function setup(o: { arc?: boolean; allow?: string } = {}): Promise<Setup> {
  const arc = !!o.arc;
  const chainId = arc ? 5042002 : 84532;
  const chain = await makeChain({ chainId, usdc: arc ? ARC_USDC : undefined, gasIsToken: arc, allow: o.allow ?? "1" });
  const home = arc ? makeHome("arc-testnet", "Arc Testnet") : makeHome();
  cleanups.push(() => chain.close(), home.cleanup);
  return { chain, home, chainKey: arc ? "arc-testnet" : "base-sepolia", chainId };
}
async function seller(s: Setup, opts: SellerOpts = {}) {
  const sel = await startSeller(s.chain, s.chainId, opts);
  cleanups.push(() => sel.close());
  return sel;
}
const buy = (s: Setup, url: string, op: string, env: Record<string, string> = {}, nodeOptions = "") =>
  run(["buy", "--rail", "evm", ...(s.chainKey === "base-sepolia" ? [] : ["--chain", s.chainKey]), "--url", url, "--max", "0.05", "--op", op],
    { SUPERSTABLES_HOME: s.home.home, B4_RPC: s.chain.url, ...env }, nodeOptions);
const sentKinds = (chain: FakeEvm) => chain.sentRaw.map((t) => t.data.slice(0, 10));
const TRANSFER_FROM = "0x23b872dd", CANCEL = "0x5a049a70";

describe("the signer checks the whole payment before the pull", () => {
  it.concurrent("a library that signs over another domain version is refused before anything is pulled", async () => {
    const s = await setup(), sel = await seller(s);
    const r = await buy(s, sel.url, "t1a", {}, preload("x402-domain-version.mjs"));
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toContain("signing domain USDC/1 is not Base Sepolia USDC's (USDC/2)");
    expect(s.chain.sentRaw).toEqual([]);
    expect(sel.creds).toEqual([]);
    expect(s.chain.nativeOf(AGENT.address)).toBe(10n ** 17n);
  }, 90_000);

  it.concurrent("a seller that names another domain version is refused before the pull (regression guard)", async () => {
    const s = await setup(), sel = await seller(s, { mutate: (req) => ({ ...req, extra: { name: "USDC", version: "1" } }) });
    const r = await buy(s, sel.url, "t1b");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(s.chain.sentRaw).toEqual([]);
    expect(sel.creds).toEqual([]);
  }, 90_000);

  it.concurrent("a second payment signature is refused; the first authorization stands", async () => {
    const s = await setup(), sel = await seller(s);
    const r = await buy(s, sel.url, "t3", {}, preload("x402-payment-retry.mjs"));
    const journal = JSON.parse(readFileSync(join(s.home.opsDir, "t3.json"), "utf8"));
    expect(sel.creds).toHaveLength(1);
    expect(journal.state, r.stdout + r.stderr).toBe("settled");
    expect(r.code).toBe(4);
    expect(journal.auth.nonce).toBe(sel.creds[0].payload.authorization.nonce);
    expect(journal.notes.join("\n")).toContain("second payment signature");
    expect(sentKinds(s.chain)).toEqual([TRANSFER_FROM]);
    expect(sentKinds(s.chain)).not.toContain(CANCEL);
  }, 90_000);
});

describe("the authorization lifetime is 600 seconds at most", () => {
  it.concurrent("a seller asking for 900 seconds is refused before anything is signed", async () => {
    const s = await setup(), sel = await seller(s, { mutate: (req) => ({ ...req, maxTimeoutSeconds: 900 }) });
    const r = await buy(s, sel.url, "t2a");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toContain("authorization lifetime 900 is not a whole number of seconds from 30 to 600");
    expect(s.chain.sentRaw).toEqual([]);
    expect(sel.creds).toEqual([]);
  }, 90_000);

  it.concurrent("600 seconds is accepted and signs a window of 600", async () => {
    const s = await setup(), sel = await seller(s, { mutate: (req) => ({ ...req, maxTimeoutSeconds: 600 }) });
    const before = Math.floor(Date.now() / 1000);
    const r = await buy(s, sel.url, "t2b");
    const after = Math.floor(Date.now() / 1000);
    expect(r.result?.state, r.stdout + r.stderr).toBe("settled");
    expect(sel.creds).toHaveLength(1);
    const validBefore = Number(sel.creds[0].payload.authorization.validBefore);
    // the window is the seller's 600 s from the moment of signing (somewhere between the start and the end of the run)
    expect(validBefore).toBeLessThanOrEqual(after + 600 + CLOCK_SLACK_S);
    expect(validBefore).toBeGreaterThanOrEqual(before + 600 - 1);
  }, 90_000);

  it.concurrent("preflight skips the 900 s option and says what buy accepts", async () => {
    const s = await setup(), sel = await seller(s, { mutate: (req) => ({ ...req, maxTimeoutSeconds: 900 }) });
    // async: the seller lives in this process, so the event loop must stay free while preflight runs
    const out = await run(["--url", sel.url, "--max", "0.05"], { SUPERSTABLES_HOME: s.home.home, B4_RPC: s.chain.url }, "", join(ROOT, "budget/evm/preflight.ts"));
    expect(out.stdout + out.stderr).toContain("SKIP: authorization lifetime 900");
    expect(out.stdout).toContain("buy accepts an authorization lifetime (maxTimeoutSeconds) of 30 to 600 seconds");
    expect(out.stdout).not.toContain("USABLE");
  }, 90_000);

  it("checkAccept takes 30, 60 and 600 and refuses 29, 601, 900 and 3600", () => {
    expect([MIN_AUTH_LIFETIME_S, MAX_AUTH_LIFETIME_S]).toEqual([30, 600]);
    const option = (t: number) => ({ asset: lib.USDC, amount: "1000", payTo: "0xFD24114C3981Aba78aE2441991B1BdB89329c556", maxTimeoutSeconds: t, extra: { name: lib.CFG.domain.name, version: lib.CFG.domain.version } });
    for (const t of [30, 60, 600]) expect(checkAccept(option(t), { max: 10n ** 6n }), String(t)).toBeNull();
    for (const t of [29, 601, 900, 3600]) expect(checkAccept(option(t), { max: 10n ** 6n }), String(t)).toContain("from 30 to 600");
  });
});

describe("typedDataProblem", () => {
  const payer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", payTo = "0xFD24114C3981Aba78aE2441991B1BdB89329c556";
  const now = 1_800_000_000;
  const chosen = { scheme: "exact", network: lib.NETWORK, asset: lib.USDC, amount: "1000", payTo, maxTimeoutSeconds: 300, extra: { name: lib.CFG.domain.name, version: lib.CFG.domain.version } };
  const good = () => ({
    primaryType: "TransferWithAuthorization",
    domain: { name: lib.CFG.domain.name, version: lib.CFG.domain.version, chainId: lib.CFG.chainId, verifyingContract: lib.USDC },
    types: authorizationTypes,
    message: { from: payer, to: payTo, value: 1000n, validAfter: BigInt(now - 600), validBefore: BigInt(now + 300), nonce: "0x" + "ab".repeat(32) },
  });
  const problem = (m: any, o: Record<string, unknown> = {}) => typedDataProblem(m, { chosen, selected: chosen, payer, now, ...o });
  const withDomain = (d: Record<string, unknown>) => ({ ...good(), domain: { ...good().domain, ...d } });
  const withMessage = (d: Record<string, unknown>) => ({ ...good(), message: { ...good().message, ...d } });

  it("accepts the checked payment", () => expect(problem(good())).toBeNull());
  it("refuses each way the payment differs from the checked option", () => {
    expect(problem(good(), { chosen: null })).toBe("no validated quote");
    expect(problem(good(), { selected: null })).toContain("did not confirm it is signing the option that passed the prechecks");
    expect(problem(good(), { selected: { ...chosen, maxTimeoutSeconds: 1 } })).toContain("did not confirm");
    expect(problem({ ...good(), primaryType: "Permit" })).toContain("not an EIP-3009 TransferWithAuthorization");
    expect(problem(withDomain({ version: "1" }))).toBe(`signing domain ${lib.CFG.domain.name}/1 is not ${lib.CFG.label} ${lib.SYM}'s (${lib.CFG.domain.name}/${lib.CFG.domain.version})`);
    expect(problem(withDomain({ name: "Other" }))).toContain("Other/");
    expect(problem(withDomain({ chainId: 1 }))).toBe(`signing domain chainId is not ${lib.CFG.chainId}`);
    expect(problem(withDomain({ verifyingContract: payTo }))).toBe(`signing domain is not ${lib.CFG.label} ${lib.SYM}`);
    expect(problem(withMessage({ from: payTo }))).toBe("payer is not the agent");
    expect(problem(withMessage({ to: payer }))).toBe("authorization recipient differs from the validated quote");
    expect(problem(withMessage({ value: "1001" }))).toBe("authorization amount differs from the validated quote");
    expect(problem(withMessage({ value: "x" }))).toBe("authorization value or validity window is not a whole number");
    expect(problem(withMessage({ validAfter: String(now + 5) }))).toBe("authorization is not valid yet");
    expect(problem(withMessage({ validBefore: String(now) }))).toBe("authorization has already expired");
    expect(problem(withMessage({ validBefore: BigInt(now + 300 + CLOCK_SLACK_S + 1) }))).toBe("authorization would stay valid longer than 300 s");
    expect(problem(withMessage({ validBefore: BigInt(now + 300 + CLOCK_SLACK_S) }))).toBeNull();
    // 600 s is the most a purchase signs: a 600 s option never gets 660
    expect(problem(withMessage({ validBefore: BigInt(now + 660) }), { chosen: { ...chosen, maxTimeoutSeconds: 600 }, selected: { ...chosen, maxTimeoutSeconds: 600 } })).toBe("authorization would stay valid longer than 600 s");
    expect(problem(withMessage({ nonce: "0x12" }))).toBe("authorization nonce is not 32 bytes");
  });
  it("refuses typed data whose digest is not the token's EIP-3009 authorization", () => {
    const digest = "the typed data is not the token's EIP-3009 authorization";
    expect(problem(withDomain({ salt: "0x" + "11".repeat(32) }))).toBe(digest);
    expect(problem({ ...good(), types: { ...authorizationTypes, EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }] } })).toBe(digest);
    expect(problem({ ...good(), types: { TransferWithAuthorization: [...authorizationTypes.TransferWithAuthorization, { name: "extra", type: "uint256" }] }, message: { ...good().message, extra: 1n } })).toBe(digest);
    expect(problem({ ...good(), types: { TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.slice(0, 5) } })).toBe(digest);
  });
});

describe("a 402 answer is read up to 64 KB", () => {
  it("never pulls a 10 MB 402 body past about 64 KB, and keeps what it read", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16_384).fill(0x20);
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (pulled >= 10 * 1024 * 1024) return c.close(); pulled += chunk.length; c.enqueue(chunk); } });
    const upstream = async () => new Response(body, { status: 402, statusText: "Payment Required", headers: { "payment-required": "abc", "content-length": "10485760" } });
    const wrapped = capChallengeBody(upstream as any) as typeof fetch;
    const r = await wrapped("http://127.0.0.1:1/x");
    expect(r.status).toBe(402);
    expect(r.statusText).toBe("Payment Required");
    expect(r.headers.get("payment-required")).toBe("abc");
    expect((await r.arrayBuffer()).byteLength).toBe(65_536);
    expect(pulled).toBeLessThanOrEqual(65_536 + 2 * 16_384);
  });

  it("passes every other status on untouched", async () => {
    const original = new Response("x".repeat(100_000), { status: 200 });
    const wrapped = capChallengeBody((async () => original) as any) as typeof fetch;
    expect(await wrapped("http://127.0.0.1:1/x")).toBe(original);
  });

  it("buy against a seller whose 402 never ends hangs up long before the end", async () => {
    const s = await setup(), sel = await seller(s, { hugeBody: 256 * 1024 * 1024 });
    const r = await buy(s, sel.url, "huge402");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(s.chain.sentRaw).toEqual([]);
    expect(sel.sent.bytes).toBeLessThan(64 * 1024 * 1024);
  }, 90_000);
});

describe("Arc: a stranded price is not gas reserve", () => {
  const strandedJournal = (s: Setup) => {
    mkdirSync(s.home.opsDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    writeFileSync(join(s.home.opsDir, "earlier.json"), JSON.stringify({
      op: "earlier", rail: "arc-testnet", path: "approve", state: "unknown", createdAt: now, updatedAt: now, url: "http://127.0.0.1:1/x",
      owner: OWNER.address, agent: AGENT.address, token: ARC_USDC, max: "2", price: "1.5", payTo: "0x00000000000000000000000000000000000a11ce",
      pullTx: "0x" + "ab".repeat(32), pullStatus: "success", pulled: "1.5", signed: false, delivered: null, notes: [],
    }, null, 2), { mode: 0o600 });
  };

  it.concurrent("a journaled price still in the agent key is refused at any amount", async () => {
    const s = await setup({ arc: true, allow: "5" }), sel = await seller(s);
    s.chain.setUsdc(AGENT.address, usdc("1.6")); // 0.1 reserve + 1.5 an earlier purchase pulled
    strandedJournal(s);
    const r = await buy(s, sel.url, "arc-next");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toMatch(/earlier.*1\.5 USDC/);
    expect(s.chain.sentRaw).toEqual([]);
  }, 90_000);

  it.concurrent("a journal that cannot be read is not gas reserve either", async () => {
    const s = await setup({ arc: true, allow: "5" }), sel = await seller(s);
    s.chain.setUsdc(AGENT.address, usdc("0.1"));
    mkdirSync(s.home.opsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(s.home.opsDir, "garbled.json"), "{ not json", { mode: 0o600 });
    const r = await buy(s, sel.url, "arc-blind");
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.reason).toContain("garbled.json");
    expect(r.result.reason).toContain("cannot be read; on Arc Testnet any money it holds is not gas reserve");
    expect(s.chain.sentRaw).toEqual([]);
  }, 90_000);

  it.concurrent("the same balance with no journal is still tolerated up to the reserve", async () => {
    const s = await setup({ arc: true, allow: "5" }), sel = await seller(s);
    s.chain.setUsdc(AGENT.address, usdc("1.6"));
    const r = await buy(s, sel.url, "arc-plain");
    expect(r.result?.state, r.stdout + r.stderr).toBe("settled");
    expect(sentKinds(s.chain)).toEqual([TRANSFER_FROM]);
  }, 90_000);

  it.concurrent("money that arrives during a purchase is reported, not counted as reserve", async () => {
    const s = await setup({ arc: true, allow: "5" }), sel = await seller(s, { refund: 500_000n });
    s.chain.setUsdc(AGENT.address, usdc("0.1"));
    const r = await buy(s, sel.url, "arc-refund");
    expect(r.result?.state, r.stdout + r.stderr).toBe("settled");
    const journal = JSON.parse(readFileSync(join(s.home.opsDir, "arc-refund.json"), "utf8"));
    expect(journal.notes.join("\n")).toContain("holds 0.5 USDC more than before this purchase");
    expect(r.stdout + r.stderr).toContain("holds 0.5 USDC more than before this purchase");
  }, 90_000);
});

describe("purchases on one agent key take turns", () => {
  it("a second buy waits for the first instead of signing its nonce", async () => {
    const s = await setup(), a = await seller(s, { price: "10000" }), b = await seller(s, { price: "20000" });
    let open!: () => void;
    s.chain.gate = new Promise<void>((res) => (open = res));
    const sends = () => s.chain.rpcLog.filter((c) => c.method === "eth_sendRawTransaction").length;
    // both start together: whichever takes the key lock first sends its pull and is held at the chain; the other must wait for it
    const first = buy(s, a.url, "race-a"), second = buy(s, b.url, "race-b");
    const waited = () => /waiting for another purchase on this agent key to finish/.test(first.out() + second.out());
    for (let i = 0; i < 1500 && sends() < 2 && !waited(); i++) await new Promise((res) => setTimeout(res, 50));
    open(); s.chain.gate = undefined;
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra.result?.state, ra.stdout + ra.stderr).toBe("settled");
    expect(rb.result?.state, rb.stdout + rb.stderr).toBe("settled");
    expect(ra.stdout + ra.stderr + rb.stdout + rb.stderr).toContain("waiting for another purchase on this agent key to finish");
    expect(s.chain.sentRaw.filter((t) => t.data.startsWith(TRANSFER_FROM)).map((t) => t.nonce)).toEqual([0, 1]);
    expect(ra.stdout + ra.stderr + rb.stdout + rb.stderr).not.toContain("nonce too low");
  }, 120_000);
});
describe("the key lock", () => {
  const dirs: string[] = [];
  const opsDir = () => { const s = makeHome(); cleanups.push(s.cleanup); mkdirSync(s.opsDir, { recursive: true }); dirs.push(s.opsDir); return s.opsDir; };
  const address = AGENT.address;
  const lockPath = (dir: string) => keyLockFile(dir, address);

  it("a second taker gets the lock as soon as the holder releases it", async () => {
    const dir = opsDir();
    const held = lockFile(lockPath(dir));
    expect(held.ok).toBe(true);
    setTimeout(() => held.release(), 200);
    const waits: unknown[] = [];
    const got = await requireKeyLock(dir, address, { waitMs: 5000, pollMs: 50, onWait: (busy: unknown) => waits.push(busy) });
    expect(got.ok).toBe(true);
    expect(waits).toHaveLength(1);
    got.release();
  });

  it("a holder that never releases ends the wait with a busy answer", async () => {
    const dir = opsDir();
    const held = lockFile(lockPath(dir));
    const got = await requireKeyLock(dir, address, { waitMs: 300, pollMs: 50 });
    expect(got.ok).toBe(false);
    expect(got.holder).toBe(process.pid);
    held.release();
  });

  it("a dead holder's lock is taken over at once", async () => {
    const dir = opsDir();
    const source = createIdentitySource();
    writeFileSync(lockPath(dir), JSON.stringify({ ...source.record(), pid: 2147483647, ...source.starts?.(2147483647) }));
    const got = await requireKeyLock(dir, address, { waitMs: 1000, pollMs: 50 });
    expect(got.ok).toBe(true);
    got.release();
  });

  it("refuses something that is not an address", async () => {
    await expect(requireKeyLock(opsDir(), "../../etc/passwd")).rejects.toThrow("not an EVM address");
  });

  it("an unverifiable holder is waited for, kept, and cleared only by the owner's typed override", () => {
    const s = makeHome(); cleanups.push(s.cleanup);
    mkdirSync(s.opsDir, { recursive: true });
    const path = lockPath(s.opsDir);
    const record = { ...createIdentitySource().record(), pid: 2147483646, bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", writtenAt: Date.now() - 40 * 86_400_000, heartbeatAt: Date.now() - 40 * 86_400_000 };
    const bytes = JSON.stringify(record);
    writeFileSync(path, bytes);
    const unlock = (answer: string, unverified: boolean) => spawnSync(process.execPath, ["--import", join(HELPERS, "budget-owner-terminal.mjs"), CLI, "unlock", "--rail", "evm", "--agent-key", "--confirm", ...(unverified ? ["--unverified"] : [])], {
      cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: s.home }, input: `${answer}\n`, encoding: "utf8", timeout: 30_000,
    });
    const plain = unlock("agent-key", false);
    expect(plain.status, plain.stderr).toBe(5);
    expect(JSON.parse(plain.stdout.trim().split("\n").pop()!.slice(7)).reason).toBe("agent_key_in_use");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const wrong = unlock("agent-key", true);
    expect(wrong.status).toBe(3);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const override = unlock("agent-key unverified", true);
    expect(override.status, override.stderr).toBe(0);
    expect(JSON.parse(override.stdout.trim().split("\n").pop()!.slice(7)).reason).toBe("locks_cleared");
    expect(existsSync(path)).toBe(false);
  }, 60_000);

  it("unlock --agent-key needs --rail evm and takes no other target", () => {
    const go = (...args: string[]) => {
      const r = spawnSync(process.execPath, [CLI, "unlock", ...args, "--confirm"], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: opsDir() }, encoding: "utf8", timeout: 60_000 });
      const line = r.stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      return { status: r.status, reason: String(line ? JSON.parse(line.slice(7)).reason : r.stderr) };
    };
    for (const args of [["--agent-key"], ["--rail", "solana", "--agent-key"]]) {
      const r = go(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.reason).toContain("--agent-key needs --rail evm");
    }
    const both = go("--rail", "evm", "--agent-key", "--op", "x");
    expect(both.status).toBe(2);
    expect(both.reason).toContain("choose exactly one unlock target");
    expect(both.reason).toContain("--agent-key");
  }, 90_000);

  it("recover waits for a purchase on the agent key before it sends anything", async () => {
    const s = await setup({ allow: "0" });
    mkdirSync(s.home.opsDir, { recursive: true });
    const lock = lockFile(keyLockFile(s.home.opsDir, address));
    expect(lock.ok).toBe(true);
    const pending = run(["recover", "--rail", "evm"], { SUPERSTABLES_HOME: s.home.home, B4_RPC: s.chain.url });
    // release once recover reports that it waits (it starts a plan run first, which takes no key lock)
    for (let i = 0; i < 1200 && !/waiting for a purchase on this agent key/.test(pending.out()); i++) await new Promise((res) => setTimeout(res, 50));
    lock.release();
    const r = await pending;
    // recover runs on in the background to the owner's page and waits there: stop it, so no process outlives the test
    const approvals = join(s.home.home, "budget", "approvals");
    for (const f of existsSync(approvals) ? readdirSync(approvals).filter((n) => n.endsWith(".json")) : []) {
      const rec = JSON.parse(readFileSync(join(approvals, f), "utf8")) as { pid?: number; railPgid?: number };
      for (const group of [rec.railPgid, rec.pid]) if (group) try { process.kill(-group, "SIGKILL"); } catch {}
    }
    expect(r.stdout + r.stderr).toContain("waiting for a purchase on this agent key to finish before recover sends anything");
    expect(r.stdout).not.toContain("agent_key_busy");
  }, 90_000);
});
