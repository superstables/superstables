// `superstables budget revoke` never reports a budget revoked from a read alone, and `status` says `revoked: true` only for
// a revoke this machine recorded that the chain still shows (tempo: the keychain's own flag). The real dispatcher and rail
// scripts, against a fake superstables.com and fake Moderato, devnet and EVM RPCs on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { evmOwner, startFakeRpc, startFakeSite, type FakeRequest, type FakeSite } from "../helpers/fake-site.js";
import { startFakeSolana, startFakeTempo, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";
import type { TestServer } from "../helpers/servers.js";
import { agreeingCopy, removeAgreeingCopy } from "../helpers/agreeing-copy.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = evmOwner("22");
const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
const TEMPO_AGENT = privateKeyToAddress(TEMPO_KEY);
const SOL_AGENT_KP = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_AGENT = SOL_AGENT_KP.publicKey.toBase58();
const SOL_OWNER_KP = Keypair.fromSeed(new Uint8Array(32).fill(4));
const SOL_OWNER = SOL_OWNER_KP.publicKey.toBase58();
const SOL_OTHER_KP = Keypair.fromSeed(new Uint8Array(32).fill(6));
const SOL_OTHER = SOL_OTHER_KP.publicKey.toBase58();
const EVM_AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

let home: string;
let site: FakeSite;
let tempo: FakeTempo;
let solana: FakeSolana;
let extraEnv: Record<string, string> = {};
let evmRpc: TestServer | undefined;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-revoke-always-"));
  site = await startFakeSite();
  tempo = await startFakeTempo();
  solana = await startFakeSolana();
  extraEnv = {};
});
afterEach(async () => {
  removeAgreeingCopy();
  await site.close();
  await tempo.close();
  await solana.close();
  await evmRpc?.close();
  evmRpc = undefined;
  rmSync(home, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function budget(args: string[]): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url, ...extraEnv };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [env.B4_RPC ? agreeingCopy(env.B4_RPC) : CLI, ...args], { cwd: ROOT, env }); // a fake evm RPC: a copy whose table names it twice, as two operators
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

/** Runs the CLI until its APPROVE line (then stops it) or its end; a timeout fails the test instead of hanging it. */
const untilApproveOrEnd = (args: string[], ms = 30_000) => new Promise<{ code: number | null; approved: boolean; result: any; stdout: string }>((done, fail) => {
  const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
  delete env.SUPERSTABLES_SITE;
  delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
  let stdout = "";
  let approved = false;
  const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`no APPROVE or RESULT within ${ms / 1000} s\n${stdout}`)); }, ms);
  child.stdout.on("data", (c) => {
    stdout += String(c);
    if (!approved && /^APPROVE \{/m.test(stdout)) { approved = true; child.kill("SIGTERM"); }
  });
  child.once("error", fail);
  child.once("close", (code) => {
    clearTimeout(timer);
    const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
    done({ code, approved, result: line ? JSON.parse(line.slice(7)) : null, stdout });
  });
});

const file = (...p: string[]) => join(home, ...p);
const PUBLIC_FILE = { tempo: "tempo-moderato.env", solana: "solana-devnet.env", evm: "evm-base-sepolia.env" } as const;
const publicOf = (rail: keyof typeof PUBLIC_FILE) => readFileSync(file("budget", "public", PUBLIC_FILE[rail]), "utf8");
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
};
const hostedTempo = (owner = OWNER) => {
  write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${owner}\n`);
  write(file("budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${owner}\nAGENT_ADDRESS=${TEMPO_AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
};
/** A solana chain with the owner's USDC account (no delegate) and SOL; hosted unless `hosted` is false. */
const solanaChain = (hosted = true, owner = SOL_OWNER) => {
  write(file("keys", "budget", "solana-agent.env"), `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT_KP.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\nSOLANA_OWNER_ADDRESS=${owner}\n`);
  write(file("budget", "public", "solana-devnet.env"), `SOLANA_OWNER_ADDRESS=${owner}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT}\n${hosted ? `APPROVALS=hosted\nSITE=${site.url}\n` : ""}`, 0o644);
  solana.usdc.set(owner, { amount: 5_000_000n, delegate: null, delegated: 0n });
  solana.balances.set(owner, 1_000_000_000n);
};
const ownerKeyFile = (which: "A" | "B") => {
  const path = join(home, `owner-${which}.env`);
  write(path, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode((which === "A" ? SOL_OWNER_KP : SOL_OTHER_KP).secretKey)}\n`);
  return path;
};
const REVOKED_AT = "REVOKED_AT=1760000000\n";
const ownerSends = (rail: "tempo" | "solana") => (r: FakeRequest) => {
  if (r.polls !== 2 || r.kind === "link") return;
  const hash = rail === "tempo"
    ? tempo.mine(r.owner!, r.body.transaction.data)
    : solana.land({ kind: r.kind as any, owner: r.owner!, agent: r.body.agent, amount: r.body.solana.amount_atomic ? BigInt(r.body.solana.amount_atomic) : undefined });
  Object.assign(r, { state: "confirmed", tx_hash: hash, wallet_asked: true });
};
const tempoKeyId = `${OWNER.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`;
const REVOKED_KEY = { expiry: 0n, limit: 0n, period: 0n, periodEnd: 0n, revoked: true, scoped: false };

describe("solana: revoke sends, status needs a record", () => {
  it("hosted, no delegate reads: the revoke goes to the site and is recorded; status then says revoked", async () => {
    solanaChain();
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana");
    const r = await budget(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ command: "revoke", rail: "solana", state: "settled", revoked: true, tx: { revoke: site.requests[0].tx_hash } });
    expect(site.requests[0].body).toEqual({ kind: "revoke", rail: "solana", chain: "devnet", agent: SOL_AGENT, solana: {} });
    expect(publicOf("solana")).toMatch(/^REVOKED_AT=\d+$/m);
    expect(r.stderr + r.stdout).toContain("revoke sends Revoke anyway");
    const s = await budget(["status", "--rail", "solana"]);
    expect(s.result).toMatchObject({ revoked: true, remaining: "0" });
  }, 120_000);

  it("on this computer, no delegate reads: the owner page is still offered", async () => {
    solanaChain(false);
    const r = await untilApproveOrEnd(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(r.approved, r.stdout).toBe(true);
  }, 60_000);

  it("owner key file, no delegate reads: the Revoke is sent (never 'already revoked'); with no USDC account nothing is sent and revoked is null", async () => {
    solanaChain(false);
    const key = ownerKeyFile("A");
    const r = await budget(["revoke", "--rail", "solana", "--owner-key-file", key, "--yes"]);
    expect(solana.calls).toContain("sendTransaction");
    expect(r.code, r.stdout + r.stderr).not.toBe(0);
    expect(r.result?.revoked).not.toBe(true);
    expect(r.stdout + r.stderr).not.toMatch(/already revoked|nothing to (send|revoke)/);

    solana.usdc.delete(SOL_OWNER);
    solana.calls.length = 0;
    const none = await budget(["revoke", "--rail", "solana", "--owner-key-file", key, "--yes"]);
    expect(none.code, none.stdout + none.stderr).toBe(0);
    expect(none.result).toMatchObject({ state: "ok", revoked: null, remaining: "0", tx: {} });
    expect(none.result.reason).toMatch(/no USDC account/);
    expect(solana.calls).not.toContain("sendTransaction");
  }, 120_000);

  it("status, no delegate and no record: remaining 0, not revoked", async () => {
    solanaChain(false);
    const s = await budget(["status", "--rail", "solana"]);
    expect(s.result).toMatchObject({ state: "ok", revoked: false, remaining: "0" });
    expect(s.result.next).toMatch(/spent, never granted, or revoked/);
  }, 60_000);

  it("status, no delegate and a recorded revoke: revoked", async () => {
    solanaChain(false);
    appendFileSync(file("budget", "public", "solana-devnet.env"), REVOKED_AT);
    const s = await budget(["status", "--rail", "solana"]);
    expect(s.result).toMatchObject({ state: "ok", revoked: true, remaining: "0" });
  }, 60_000);

  it("status, a live delegate and a stale record: not revoked", async () => {
    solanaChain(false);
    appendFileSync(file("budget", "public", "solana-devnet.env"), REVOKED_AT);
    solana.usdc.set(SOL_OWNER, { amount: 5_000_000n, delegate: SOL_AGENT, delegated: 50_000n });
    const s = await budget(["status", "--rail", "solana"]);
    expect(s.result).toMatchObject({ revoked: false, remaining: "0.05" });
  }, 60_000);

  it("a hosted grant drops a recorded revoke", async () => {
    solanaChain();
    appendFileSync(file("budget", "public", "solana-devnet.env"), REVOKED_AT);
    site.owner = SOL_OWNER;
    site.onPoll = ownerSends("solana");
    const g = await budget(["grant", "--rail", "solana", "--amount", "0.05", "--wait", "--no-open"]);
    expect(g.code, g.stdout + g.stderr).toBe(0);
    expect(publicOf("solana")).not.toMatch(/REVOKED_AT/);
  }, 120_000);

  it("setup --new-owner drops a recorded revoke", async () => {
    solanaChain(false);
    appendFileSync(file("budget", "public", "solana-devnet.env"), REVOKED_AT);
    solana.usdc.set(SOL_OTHER, { amount: 5_000_000n, delegate: null, delegated: 0n });
    solana.balances.set(SOL_OTHER, 1_000_000_000n);
    const out = await budget(["setup", "--rail", "solana", "--new-owner", "--owner-key-file", ownerKeyFile("B")]);
    expect(out.code, out.stdout + out.stderr).toBe(0);
    expect(publicOf("solana")).toMatch(new RegExp(`^SOLANA_OWNER_ADDRESS=${SOL_OTHER}$`, "m"));
    expect(publicOf("solana")).not.toMatch(/REVOKED_AT/);
  }, 120_000);
});

describe("tempo: a revoke is skipped only when the keychain refuses it", () => {
  const revokeArgs = ["revoke", "--rail", "tempo", "--wait", "--no-open"];

  it("the key reads revoked and the keychain refuses a simulated revoke: revoked, nothing sent", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", revoked: true, tx: {} });
    expect(r.result.reason).toMatch(/keychain refuses a simulated revokeKey/);
    expect(tempo.simulations).toHaveLength(1);
    expect(tempo.simulations[0].from.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(tempo.simulations[0].key.toLowerCase()).toBe(TEMPO_AGENT.toLowerCase());
    expect(site.requests).toHaveLength(0);
  }, 90_000);

  it("the same without --wait (an agent's call)", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    const r = await budget(["revoke", "--rail", "tempo", "--no-open"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", revoked: true, tx: {} });
    expect(tempo.simulations).toHaveLength(1);
    expect(site.requests).toHaveLength(0);
  }, 90_000);

  it("the key reads revoked but the keychain would take a revoke (a lying read): the revoke is sent", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    tempo.revokeSimulation = () => "ok";
    site.onPoll = ownerSends("tempo");
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", revoked: true });
    expect(r.result.tx.revoke).toMatch(/^0x/);
    expect(site.requests[0].body.transaction.data).toMatch(/^0x5ae7ab32/);
  }, 90_000);

  it("the key reads revoked and the keychain answers KeyNotFound: also already done", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    tempo.revokeSimulation = () => "KeyNotFound";
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", revoked: true });
    expect(r.result.tx).toEqual({});
    expect(tempo.simulations).toHaveLength(1);
    expect(site.requests).toHaveLength(0);
  }, 90_000);

  it("the simulation cannot be read: unknown (exit 5), nothing sent", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    tempo.revokeSimulation = () => "unreadable";
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
    expect(r.result.reason).toMatch(/could not be simulated/);
    expect(site.requests).toHaveLength(0);
  }, 90_000);

  it("with the owner key file, a simulation that cannot be read is unknown too: nothing sent, never revoked", async () => {
    write(file("keys", "budget", "tempo-agent.env"), `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\nOWNER_ADDRESS=${OWNER}\n`);
    write(file("budget", "public", "tempo-moderato.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${TEMPO_AGENT}\n`, 0o644);
    write(file("owner.env"), `OWNER_PRIVATE_KEY=0x${"22".repeat(32)}\n`);
    tempo.keys.set(tempoKeyId, REVOKED_KEY);
    tempo.revokeSimulation = () => "unreadable";
    const r = await budget(["revoke", "--rail", "tempo", "--owner-key-file", file("owner.env"), "--yes"]);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown", revoked: false });
    expect(r.result.next).toMatch(/check the Moderato RPC/);
    expect(r.stdout).not.toMatch(/^SENDING /m);
  }, 90_000);

  it("the key reads never authorized but the keychain would take a revoke: the revoke is sent", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.revokeSimulation = () => "ok";
    site.onPoll = (r) => {
      if (r.polls !== 2 || r.kind === "link") return;
      tempo.keys.set(tempoKeyId, { ...REVOKED_KEY, revoked: false, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400) });
      Object.assign(r, { state: "confirmed", tx_hash: tempo.mine(r.owner!, r.body.transaction.data), wallet_asked: true });
    };
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "settled", revoked: true });
    expect(site.requests).toHaveLength(1);
  }, 90_000);

  it("the key reads never authorized and the keychain says KeyNotFound: refused", async () => {
    hostedTempo();
    site.owner = OWNER;
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: "the key was never authorized on this owner; there is nothing to revoke" });
    expect(tempo.simulations).toHaveLength(1);
  }, 90_000);

  it("the key reads never authorized and the keychain says KeyAlreadyRevoked: the reads disagree, unknown", async () => {
    hostedTempo();
    site.owner = OWNER;
    tempo.revokeSimulation = () => "KeyAlreadyRevoked";
    const r = await budget(revokeArgs);
    expect(r.code, r.stdout + r.stderr).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown" });
  }, 90_000);
});

describe("evm: status needs a record", () => {
  const evmChain = async (extra = "", rpcExtra?: (m: string, p: any[]) => unknown) => {
    // the chain has a final block, at time 2000, for the endpoints to agree on
    const block = (m: string, p: any[]) => m === "eth_getBlockByNumber" ? { number: "0x64", hash: `0x${"ef".repeat(32)}`, timestamp: "0x7d0", transactions: [] } : rpcExtra?.(m, p);
    evmRpc = await startFakeRpc(84532, block);
    extraEnv = { B4_RPC: evmRpc.url };
    write(file("keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\nB4_AGENT_ADDRESS=${EVM_AGENT}\n`);
    write(file("budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${EVM_AGENT}\n${extra}`, 0o644);
  };

  it("allowance 0 and no recorded revoke: remaining 0, not revoked", async () => {
    await evmChain();
    const s = await budget(["status", "--rail", "evm"]);
    expect(s.code, s.stdout + s.stderr).toBe(0);
    expect(s.result).toMatchObject({ state: "ok", revoked: false, remaining: "0" });
    expect(s.result.next).toMatch(/spent, never granted, or revoked/);
  }, 60_000);

  it("allowance 0 and a recorded revoke: revoked", async () => {
    await evmChain("B4_REVOKED_AT=1000\n"); // before the fake chain's final block (time 2000)
    const s = await budget(["status", "--rail", "evm"]);
    expect(s.result).toMatchObject({ state: "ok", revoked: true, remaining: "0" });
  }, 60_000);

  it("allowance 0 and a revoke recorded after the final block: not revoked yet", async () => {
    await evmChain("B4_REVOKED_AT=1760000000\n");
    const s = await budget(["status", "--rail", "evm"]);
    expect(s.result).toMatchObject({ state: "ok", revoked: false, remaining: "0" });
  }, 60_000);

  it("a live allowance and a stale record: not revoked", async () => {
    await evmChain("B4_REVOKED_AT=1760000000\n", (m, p) => m === "eth_call" && String(p[0]?.data).startsWith("0xdd62ed3e") ? `0x${(10000n).toString(16).padStart(64, "0")}` : undefined);
    const s = await budget(["status", "--rail", "evm"]);
    expect(s.result).toMatchObject({ revoked: false, remaining: "0.01" });
  }, 60_000);
});
