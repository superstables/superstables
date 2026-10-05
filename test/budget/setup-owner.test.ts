// Who the owner on record is, on solana and tempo, and how setup changes it: the public file and the agent key file's
// owner binding both record it, and only --new-owner replaces it, refused while a budget is live. The real dispatcher and
// rail scripts against fake devnet and Moderato RPCs on 127.0.0.1, owners from --owner-key-file. No network, no real key.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { KEYCHAIN, startFakeSolana, startFakeTempo, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const SITE = "https://staging.superstables.com";
const evmKey = (b: string) => `0x${b.repeat(32)}` as const;

let home: string;
let tempo: FakeTempo;
let solana: FakeSolana;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-setup-owner-"));
  tempo = await startFakeTempo();
  solana = await startFakeSolana();
});
afterEach(async () => {
  await tempo.close();
  await solana.close();
  rmSync(home, { recursive: true, force: true });
});

function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
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
const write = (path: string, text: string, mode = 0o600) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
};
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
/**
 * A refusal's whole reason. The RESULT line keeps at most 300 characters of it, and a reason that names a file can be
 * longer (a long temporary directory): the rail's own REFUSED line has all of it, and the RESULT starts the same way.
 */
const expectReason = (out: { stdout: string; stderr: string; result: any }, reason: string) => {
  expect(out.stdout + out.stderr).toContain(`REFUSED: ${reason}.`);
  expect(reason.startsWith(out.result.reason), `RESULT reason ${out.result.reason}`).toBe(true);
};

/** One rail as setup sees it: the two files, the owners A, B and C, and how a budget is made live on an owner. */
type Rail = {
  name: "solana" | "tempo";
  A: string;
  B: string;
  C: string;
  agent: string;
  agentFile: string;
  publicFile: string;
  ownerVar: string;
  /** The agent key file, bound to `owner` or not. */
  agentText(owner?: string): string;
  /** The public file recording `owner` (with the hosted settings when `hosted`). */
  publicText(owner: string, hosted?: boolean): string;
  /** An --owner-key-file for A, B or C. */
  ownerKey(which: "A" | "B" | "C"): string;
  live(owner: string): void;
  ended(owner: string): void;
  isLive(owner: string): boolean;
};

function solanaRail(): Rail {
  const kp = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
  const agentKp = kp(3);
  const owners = { A: kp(4), B: kp(6), C: kp(7) };
  const agent = agentKp.publicKey.toBase58();
  const r: Rail = {
    name: "solana", agent,
    A: owners.A.publicKey.toBase58(), B: owners.B.publicKey.toBase58(), C: owners.C.publicKey.toBase58(),
    agentFile: join(home, "keys", "budget", "solana-agent.env"),
    publicFile: join(home, "budget", "public", "solana-devnet.env"),
    ownerVar: "SOLANA_OWNER_ADDRESS",
    agentText: (owner) => `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(agentKp.secretKey)}\nSOLANA_AGENT_ADDRESS=${agent}\n${owner ? `SOLANA_OWNER_ADDRESS=${owner}\n` : ""}`,
    publicText: (owner, hosted) => `SOLANA_OWNER_ADDRESS=${owner}\nSOLANA_AGENT_ADDRESS=${agent}\n${hosted ? `APPROVALS=hosted\nSITE=${SITE}\nLINK_ID=bl_test0001\nLINK_CODE=ABC-DEF\n` : ""}`,
    ownerKey: (which) => {
      const path = join(home, `owner-${which}.env`);
      write(path, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(owners[which].secretKey)}\n`);
      return path;
    },
    live: (owner) => solana.usdc.set(owner, { amount: 5_000_000n, delegate: agent, delegated: 500_000n }),
    ended: (owner) => solana.usdc.set(owner, { amount: 5_000_000n, delegate: null, delegated: 0n }),
    isLive: (owner) => solana.usdc.get(owner)?.delegate === agent,
  };
  for (const o of [r.A, r.B, r.C]) r.ended(o);
  return r;
}

function tempoRail(): Rail {
  const agentKey = evmKey("44");
  const agent = privateKeyToAddress(agentKey);
  const keys = { A: evmKey("22"), B: evmKey("33"), C: evmKey("55") };
  const id = (owner: string) => `${owner.toLowerCase()}:${agent.toLowerCase()}`;
  return {
    name: "tempo", agent,
    A: privateKeyToAddress(keys.A), B: privateKeyToAddress(keys.B), C: privateKeyToAddress(keys.C),
    agentFile: join(home, "keys", "budget", "tempo-agent.env"),
    publicFile: join(home, "budget", "public", "tempo-moderato.env"),
    ownerVar: "OWNER_ADDRESS",
    agentText: (owner) => `AGENT_PRIVATE_KEY=${agentKey}\nAGENT_ADDRESS=${agent}\n${owner ? `OWNER_ADDRESS=${owner}\n` : ""}`,
    publicText: (owner, hosted) => `OWNER_ADDRESS=${owner}\nAGENT_ADDRESS=${agent}\n${hosted ? `APPROVALS=hosted\nSITE=${SITE}\nLINK_ID=bl_test0001\nLINK_CODE=ABC-DEF\n` : ""}`,
    ownerKey: (which) => {
      const path = join(home, `owner-${which}.env`);
      write(path, `OWNER_PRIVATE_KEY=${keys[which]}\n`);
      return path;
    },
    live: (owner) => tempo.keys.set(id(owner), { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 500_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false }),
    ended: (owner) => tempo.keys.delete(id(owner)),
    isLive: (owner) => tempo.keys.has(id(owner)),
  };
}

const setup = (r: Rail, ...extra: string[]) => budget(["setup", "--rail", r.name, ...extra]);
const owned = (text: string | null, r: Rail, owner: string) => text !== null && new RegExp(`^${r.ownerVar}=${owner}$`, "m").test(text);

for (const make of [solanaRail, tempoRail]) {
  describe(`${make === solanaRail ? "solana" : "tempo"}: the owner on record`, () => {
    it("the issue: an unbound agent key file does not let another owner replace the public file's owner, with a live budget", async () => {
      const r = make();
      for (const hosted of [true, false]) {
        write(r.agentFile, r.agentText());
        write(r.publicFile, r.publicText(r.A, hosted), 0o644);
        r.live(r.A);
        const before = { agent: read(r.agentFile), pub: read(r.publicFile) };
        const out = await setup(r, "--owner-key-file", r.ownerKey("B"));
        expect(out.code, out.stderr).toBe(3);
        expect(out.result).toMatchObject({ ok: false, state: "refused_precheck", owner: r.A });
        expect(out.result.reason).toBe(`another owner (${r.A}) is recorded for this agent`);
        // the retry keeps the chain where its approvals are: hosted on the recorded site, or on this computer
        expect(out.result.next).toBe(`superstables budget setup --rail ${r.name}${hosted ? ` --hosted --site ${SITE}` : ""} --new-owner replaces it (refused while a budget is live)`);
        expect(read(r.agentFile)).toBe(before.agent);
        expect(read(r.publicFile)).toBe(before.pub);
        expect(r.isLive(r.A)).toBe(true);
        const status = await budget(["status", "--rail", r.name]);
        expect(status.stdout + status.stderr).toContain(r.A);
        expect(status.stdout + status.stderr).not.toContain(r.B);
      }
    }, 120_000);

    it("the recorded owner again, with an unbound agent key file: accepted, and the binding is written", async () => {
      const r = make();
      write(r.agentFile, r.agentText());
      write(r.publicFile, r.publicText(r.A, true), 0o644);
      const out = await setup(r, "--owner-key-file", r.ownerKey("A"));
      expect(out.code, out.stderr).toBe(0);
      expect(out.result).toMatchObject({ state: "ok", owner: r.A });
      expect(out.result.replacedOwner).toBeUndefined();
      expect(owned(read(r.agentFile), r, r.A)).toBe(true);
      expect(owned(read(r.publicFile), r, r.A)).toBe(true);
      expect(read(r.publicFile)).toMatch(/^APPROVALS=hosted$/m);
      // and from then on the binding protects it too
      write(r.publicFile, "", 0o644);
      const other = await setup(r, "--owner-key-file", r.ownerKey("B"));
      expect(other.code, other.stderr).toBe(3);
      expect(other.result.owner).toBe(r.A);
    }, 120_000);

    it("first setup, no owner anywhere: the supplied owner is recorded in both files", async () => {
      const r = make();
      const out = await setup(r, "--owner-key-file", r.ownerKey("B"));
      expect(out.code, out.stderr).toBe(0);
      expect(out.result).toMatchObject({ state: "ok", owner: r.B });
      expect(owned(read(r.agentFile), r, r.B)).toBe(true);
      expect(owned(read(r.publicFile), r, r.B)).toBe(true);
    }, 120_000);

    it("an interrupted first setup (the binding, no public file): another owner is refused, the bound one completes it", async () => {
      const r = make();
      write(r.agentFile, r.agentText(r.A));
      const refused = await setup(r, "--owner-key-file", r.ownerKey("B"));
      expect(refused.code, refused.stderr).toBe(3);
      expect(refused.result.owner).toBe(r.A);
      expect(read(r.publicFile)).toBeNull();
      const done = await setup(r, "--owner-key-file", r.ownerKey("A"));
      expect(done.code, done.stderr).toBe(0);
      expect(owned(read(r.publicFile), r, r.A)).toBe(true);
    }, 120_000);

    it("files that name different owners: refused without --new-owner; --new-owner checks both for a live budget", async () => {
      const r = make();
      write(r.agentFile, r.agentText(r.C));
      write(r.publicFile, r.publicText(r.A), 0o644);
      const before = { agent: read(r.agentFile), pub: read(r.publicFile) };
      for (const who of ["A", "C"] as const) {
        const out = await setup(r, "--owner-key-file", r.ownerKey(who));
        expect(out.code, out.stderr).toBe(3);
        expectReason(out, `the owner files disagree: ${r.publicFile} records the owner ${r.A}, and ${r.agentFile} is bound to ${r.C}`);
        expect(out.result.next).toBe(`superstables budget setup --rail ${r.name} --new-owner records one owner again (refused while a budget is live on either)`);
      }
      expect(read(r.agentFile)).toBe(before.agent);
      expect(read(r.publicFile)).toBe(before.pub);
      // a live budget on the bound owner, not the public one, still blocks --new-owner, and the way out names that owner and
      // their own wallet: superstables budget revoke acts for the public file's owner
      r.live(r.C);
      const blocked = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(blocked.code, blocked.stderr).toBe(3);
      expect(blocked.result).toMatchObject({ owner: r.C });
      expect(blocked.result.reason).toMatch(/a budget is live/);
      expect(blocked.result.next).toBe(r.name === "solana"
        ? `ask the owner ${r.C} to sign a transaction in their wallet on Solana devnet that removes the agent's spending permission from their associated USDC token account (mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU), using a tool that supports the SPL Token Revoke instruction; superstables budget revoke acts only for the owner in the public file, and refuses while the two files disagree. Then superstables budget setup --rail solana --new-owner`
        : `ask the owner ${r.C} to sign a transaction in their wallet on Tempo Moderato that revokes access key ${r.agent}, using a tool that can call AccountKeychain.revokeKey(${r.agent}) at ${KEYCHAIN}; superstables budget revoke acts only for the owner in the public file, and refuses while the two files disagree. Then superstables budget setup --rail tempo --new-owner`);
      // and revoke refuses rather than report on the public file's owner ("already revoked", "never authorized")
      const revoke = await budget(["revoke", "--rail", r.name, "--wait", "--no-open"]);
      expect(revoke.code, revoke.stderr).toBe(3);
      expect(revoke.result).toMatchObject({ ok: false, state: "refused_precheck" });
      expect(revoke.result.reason).toBe(`the owner files disagree: the public file records the owner ${r.A}, and the agent key file is bound to ${r.C}. revoke would act for the first only, so it does not say whether a budget is live on either; nothing was sent`);
      expect(revoke.result.next).toBe(`superstables budget setup --rail ${r.name} --new-owner checks both owners for a live budget and names the owner who must revoke it, and how; it records one owner again once neither has one`);
      expect(JSON.stringify(revoke.result)).not.toMatch(/already revoked|never authorized/);
      expect(r.isLive(r.C)).toBe(true);
      r.ended(r.C);
      const moved = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(moved.code, moved.stderr).toBe(0);
      expect(owned(read(r.agentFile), r, r.B)).toBe(true);
      expect(owned(read(r.publicFile), r, r.B)).toBe(true);
    }, 180_000);

    it("--new-owner: refused while a budget is live on the recorded owner, then replaces it", async () => {
      const r = make();
      write(r.agentFile, r.agentText());
      write(r.publicFile, r.publicText(r.A), 0o644);
      r.live(r.A);
      const blocked = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(blocked.code, blocked.stderr).toBe(3);
      expect(blocked.result).toMatchObject({ state: "refused_precheck", owner: r.A });
      expect(blocked.result.reason).toMatch(/a budget is live/);
      expect(owned(read(r.publicFile), r, r.A)).toBe(true);
      r.ended(r.A);
      const moved = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(moved.code, moved.stderr).toBe(0);
      expect(moved.result).toMatchObject({ state: "ok", owner: r.B });
      expect(owned(read(r.agentFile), r, r.B)).toBe(true);
      expect(owned(read(r.publicFile), r, r.B)).toBe(true);
    }, 180_000);

    it("a public file that names no agent still records its owner", async () => {
      const r = make();
      write(r.agentFile, r.agentText());
      write(r.publicFile, `${r.ownerVar}=${r.A}\n`, 0o644);
      const out = await setup(r, "--owner-key-file", r.ownerKey("B"));
      expect(out.code, out.stderr).toBe(3);
      expect(out.result.owner).toBe(r.A);
    }, 60_000);
  });
}

describe("tempo setup --agent: a new key for the owner on record only", () => {
  it("refused when the agent key file is bound to another owner; an unbound file is bound to the owner on record", async () => {
    const r = tempoRail();
    write(r.agentFile, r.agentText(r.C));
    write(r.publicFile, r.publicText(r.A), 0o644);
    const refused = await budget(["setup", "--rail", "tempo", "--agent", "2"]);
    expect(refused.code, refused.stderr).toBe(3);
    expect(refused.result.reason).toMatch(/^the owner files disagree/);
    expect(refused.result.next).toBe("superstables budget setup --rail tempo --new-owner records one owner again (refused while a budget is live on either), then superstables budget setup --rail tempo --agent 2");
    expect(read(r.agentFile)).toBe(r.agentText(r.C));
    write(r.agentFile, r.agentText());
    const added = await budget(["setup", "--rail", "tempo", "--agent", "2"]);
    expect(added.code, added.stderr).toBe(0);
    expect(owned(read(r.agentFile), r, r.A)).toBe(true);
    expect(read(r.agentFile)).toMatch(/^AGENT2_ADDRESS=0x[0-9a-fA-F]{40}$/m);
  }, 60_000);
});

describe("tempo --new-owner: every key the agent file holds, by the address of its private key", () => {
  it("a missing or wrong address line for a stored key is refused, so a live key cannot hide behind it", async () => {
    const r = tempoRail();
    write(r.publicFile, r.publicText(r.A), 0o644);
    r.live(r.A);
    const key = `AGENT_PRIVATE_KEY=${evmKey("44")}\n`;
    for (const [what, text, problem] of [
      ["missing", `${key}OWNER_ADDRESS=${r.A}\n`, `AGENT_ADDRESS is missing for its key ${r.agent}`],
      ["another address", `${key}AGENT_ADDRESS=${r.C}\nOWNER_ADDRESS=${r.A}\n`, `AGENT_ADDRESS is ${r.C}, not the address of its key (${r.agent})`],
      ["an added key that is no key (zero)", `${key}AGENT_ADDRESS=${r.agent}\nAGENT2_PRIVATE_KEY=0x${"00".repeat(32)}\nAGENT2_ADDRESS=${r.C}\nOWNER_ADDRESS=${r.A}\n`, "AGENT2_PRIVATE_KEY is not a private key"],
      ["an added key that is no key (all ff)", `${key}AGENT_ADDRESS=${r.agent}\nAGENT2_PRIVATE_KEY=0x${"ff".repeat(32)}\nAGENT2_ADDRESS=${r.C}\nOWNER_ADDRESS=${r.A}\n`, "AGENT2_PRIVATE_KEY is not a private key"],
    ] as const) {
      write(r.agentFile, text);
      const out = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(out.code, `${what}: ${out.stderr}`).toBe(3);
      expect(out.result.reason, what).toBe(`the agent key file does not match its keys: ${problem}; the owner is not replaced`);
      expect(read(r.agentFile), what).toBe(text);
      expect(owned(read(r.publicFile), r, r.A), what).toBe(true);
    }
  }, 120_000);

  it("a live added key (AGENT2) on the public file's owner: revoke it with --agent 2", async () => {
    const r = tempoRail();
    const extraKey = evmKey("66");
    const extra = privateKeyToAddress(extraKey);
    write(r.agentFile, `${r.agentText(r.A)}AGENT2_PRIVATE_KEY=${extraKey}\nAGENT2_ADDRESS=${extra}\n`);
    write(r.publicFile, `${r.publicText(r.A)}AGENT2_ADDRESS=${extra}\n`, 0o644);
    tempo.keys.set(`${r.A.toLowerCase()}:${extra.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
    const out = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
    expect(out.code, out.stderr).toBe(3);
    expect(out.result.next).toBe(`revoke it first (superstables budget revoke --rail tempo --agent 2, approved by ${r.A}), then superstables budget setup --rail tempo --new-owner`);
  }, 60_000);
});

describe("revoke while the owner files disagree", () => {
  it("on a hosted chain the way out keeps --hosted and the site", async () => {
    for (const r of [solanaRail(), tempoRail()]) {
      write(r.agentFile, r.agentText(r.C));
      write(r.publicFile, r.publicText(r.A, true), 0o644);
      const out = await budget(["revoke", "--rail", r.name, "--wait", "--no-open"]);
      expect(out.code, out.stderr).toBe(3);
      expect(out.result.next).toBe(`superstables budget setup --rail ${r.name} --hosted --site ${SITE} --new-owner checks both owners for a live budget and names the owner who must revoke it, and how; it records one owner again once neither has one`);
    }
  }, 60_000);

  it("the rail's revoke script, run by itself, refuses too", async () => {
    for (const r of [solanaRail(), tempoRail()]) {
      write(r.agentFile, r.agentText(r.C));
      write(r.publicFile, r.publicText(r.A), 0o644);
      const out = await new Promise<{ code: number; stdout: string }>((done, fail) => {
        const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
        const child = spawn(resolve(ROOT, "node_modules/.bin/tsx"), [resolve(ROOT, "budget", r.name, "revokeBudget.ts"), "--no-open"], { cwd: resolve(ROOT, "budget", r.name), env });
        let stdout = "";
        child.stdout.on("data", (c) => (stdout += String(c)));
        child.once("error", fail);
        child.once("close", (code) => done({ code: code ?? 0, stdout }));
      });
      expect(out.code, out.stdout).toBe(3);
      expect(out.stdout).toContain(`REFUSED: the owner files disagree: the public file records the owner ${r.A}, and the agent key file is bound to ${r.C}. Nothing was sent.`);
      expect(out.stdout).not.toMatch(/already revoked|never authorized|nothing to revoke/);
    }
  }, 60_000);
});

describe("revoke never waits on the agent key file", () => {
  /** Runs the CLI until its APPROVE line (then stops it) or its end; a timeout fails the test instead of hanging it. */
  const untilApproveOrEnd = (args: string[], ms = 30_000) => new Promise<{ code: number | null; approved: boolean; result: any; stdout: string }>((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let approved = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error(`no APPROVE or RESULT within ${ms / 1000} s: revoke is waiting on something\n${stdout}`)); }, ms);
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

  it("no agent key file at all: the revoke on this computer still reaches its approval link, on both rails", async () => {
    for (const r of [solanaRail(), tempoRail()]) {
      rmSync(r.agentFile, { force: true });
      write(r.publicFile, r.publicText(r.A), 0o644);
      r.live(r.A);
      solana.balances.set(r.A, 1_000_000_000n);
      const out = await untilApproveOrEnd(["revoke", "--rail", r.name, "--wait", "--no-open"]);
      expect(out.approved, `${r.name}: ${out.stdout}`).toBe(true);
    }
  }, 120_000);

  it("a FIFO where the agent key file should be: revoke reaches its result or its approval link, on both rails", async () => {
    const sol = solanaRail();
    mkdirSync(join(sol.agentFile, ".."), { recursive: true });
    execFileSync("mkfifo", [sol.agentFile]);
    write(sol.publicFile, sol.publicText(sol.A), 0o644);
    sol.live(sol.A);
    solana.balances.set(sol.A, 1_000_000_000n);
    // with the owner's key: to its RESULT, past the owner check (the fake chain takes no transaction, so the send itself
    // fails there, never the agent key file)
    const signed = await untilApproveOrEnd(["revoke", "--rail", "solana", "--owner-key-file", sol.ownerKey("A"), "--yes"]);
    expect(signed.result, signed.stdout).toMatchObject({ command: "revoke", rail: "solana" });
    expect(JSON.stringify(signed.result)).not.toMatch(/agent key file|owner files disagree/);
    // in the owner's wallet: the approval link comes up
    const asked = await untilApproveOrEnd(["revoke", "--rail", "solana", "--wait", "--no-open"]);
    expect(asked.approved, asked.stdout).toBe(true);

    const t = tempoRail();
    execFileSync("mkfifo", [t.agentFile]);
    write(t.publicFile, t.publicText(t.A), 0o644);
    t.live(t.A);
    const tAsked = await untilApproveOrEnd(["revoke", "--rail", "tempo", "--wait", "--no-open"]);
    expect(tAsked.approved, tAsked.stdout).toBe(true);
  }, 120_000);
});

describe("tempo --new-owner: every recorded key, by the public file's labels too", () => {
  const liveOn = (owner: string, key: string) => tempo.keys.set(`${owner.toLowerCase()}:${key.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 1n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });

  it("a live key that only the public file records (AGENT2_ADDRESS) blocks --new-owner; revoke --agent 2 reaches it", async () => {
    const r = tempoRail();
    const extra = privateKeyToAddress(evmKey("66"));
    write(r.agentFile, r.agentText(r.A));
    write(r.publicFile, `${r.publicText(r.A)}AGENT2_ADDRESS=${extra}\n`, 0o644);
    liveOn(r.A, extra);
    const out = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
    expect(out.code, out.stderr).toBe(3);
    expect(out.result.reason).toMatch(new RegExp(`access key ${extra} is authorized on the recorded owner ${r.A}`));
    expect(out.result.next).toBe(`revoke it first (superstables budget revoke --rail tempo --agent 2, approved by ${r.A}), then superstables budget setup --rail tempo --new-owner`);
    expect(owned(read(r.publicFile), r, r.A)).toBe(true);
  }, 60_000);

  it("setup --agent never replaces a key the public file records under that label; the live grant still blocks --new-owner", async () => {
    const r = tempoRail();
    const extra = privateKeyToAddress(evmKey("66"));
    write(r.agentFile, r.agentText(r.A));
    const pub = `${r.publicText(r.A)}AGENT2_ADDRESS=${extra}\n`;
    write(r.publicFile, pub, 0o644);
    liveOn(r.A, extra);
    const agentBefore = read(r.agentFile);
    const out = await budget(["setup", "--rail", "tempo", "--agent", "2"]);
    expect(out.code, out.stderr).toBe(3);
    expectReason(out, `${r.publicFile} already records the access key ${extra} under the label 2, and ${r.agentFile} holds no key for it; setup --agent never replaces a recorded key`);
    expect(out.result.next).toBe(`pick another label (superstables budget setup --rail tempo --agent OTHER). If ${extra} may still hold a budget, revoke it: superstables budget revoke --rail tempo --agent 2, approved by ${r.A}`);
    expect(read(r.publicFile)).toBe(pub);
    expect(read(r.agentFile)).toBe(agentBefore);
    const moved = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
    expect(moved.code, moved.stderr).toBe(3);
    expect(moved.result.reason).toMatch(new RegExp(`access key ${extra} is authorized on the recorded owner ${r.A}`));
    // another label works
    const other = await budget(["setup", "--rail", "tempo", "--agent", "3"]);
    expect(other.code, other.stderr).toBe(0);
    expect(read(r.publicFile)).toMatch(new RegExp(`^AGENT2_ADDRESS=${extra}$`, "m"));
  }, 90_000);

  it("a key whose label has an underscore (ops_team) is checked like any other", async () => {
    const r = tempoRail();
    const extraKey = evmKey("77");
    const extra = privateKeyToAddress(extraKey);
    write(r.agentFile, `${r.agentText(r.A)}AGENTops_team_PRIVATE_KEY=${extraKey}\nAGENTops_team_ADDRESS=${extra}\n`);
    write(r.publicFile, `${r.publicText(r.A)}AGENTops_team_ADDRESS=${extra}\n`, 0o644);
    liveOn(r.A, extra);
    const out = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
    expect(out.code, out.stderr).toBe(3);
    expect(out.result.next).toBe(`revoke it first (superstables budget revoke --rail tempo --agent ops_team, approved by ${r.A}), then superstables budget setup --rail tempo --new-owner`);
    // and a wrong address line under that label is caught too
    write(r.agentFile, `${r.agentText(r.A)}AGENTops_team_PRIVATE_KEY=${extraKey}\nAGENTops_team_ADDRESS=${r.C}\n`);
    const wrong = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
    expect(wrong.code, wrong.stderr).toBe(3);
    expect(wrong.result.reason).toBe(`the agent key file does not match its keys: AGENTops_team_ADDRESS is ${r.C}, not the address of its key (${extra}); the owner is not replaced`);
  }, 60_000);

  it("revoke --agent LABEL is named only when the public file's label resolves to exactly the live key", async () => {
    const r = tempoRail();
    const extraKey = evmKey("66");
    const extra = privateKeyToAddress(extraKey);
    write(r.agentFile, `${r.agentText(r.A)}AGENT2_PRIVATE_KEY=${extraKey}\nAGENT2_ADDRESS=${extra}\n`);
    liveOn(r.A, extra);
    const wallet = `ask the owner ${r.A} to sign a transaction in their wallet on Tempo Moderato that revokes access key ${extra}, using a tool that can call AccountKeychain.revokeKey(${extra}) at ${KEYCHAIN}; superstables budget revoke acts only for the owner in the public file, and refuses while the two files disagree. Then superstables budget setup --rail tempo --new-owner`;
    // the public file has no AGENT2_ADDRESS, or another address under it: revoke --agent 2 would not reach this key
    for (const pub of [r.publicText(r.A), `${r.publicText(r.A)}AGENT2_ADDRESS=${r.C}\n`]) {
      write(r.publicFile, pub, 0o644);
      const out = await setup(r, "--new-owner", "--owner-key-file", r.ownerKey("B"));
      expect(out.code, out.stderr).toBe(3);
      expect(out.result.next).toBe(wallet);
    }
  }, 60_000);
});

describe("tempo setup with an agent key that is no key", () => {
  it("refused (exit 3) with what to do, never a crash", async () => {
    const r = tempoRail();
    for (const bad of ["00".repeat(32), "ff".repeat(32)]) {
      write(r.agentFile, `AGENT_PRIVATE_KEY=0x${bad}\nAGENT_ADDRESS=${r.agent}\n`);
      const out = await setup(r, "--owner-key-file", r.ownerKey("A"));
      expect(out.code, out.stderr).toBe(3);
      expect(out.result.state).toBe("refused_precheck");
      expect(out.result.reason).toMatch(/holds an AGENT_PRIVATE_KEY that is not a key$/);
    }
  }, 60_000);
});
