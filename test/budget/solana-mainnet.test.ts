// Solana mainnet behind the operator's switch (SUPERSTABLES_ALLOW_MAINNET). Off: every new path is refused and devnet is as it
// was. On: the chain gate asks for the agent key in the OS keychain only of the scripts that sign with it, a seller on the other
// Solana chain is refused, and no script reaches a real RPC (a dead loopback port stands in for every endpoint). Nothing is
// signed or sent, and no key here holds funds.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAINNET_MANIFEST } from "../../src/core/mainnet-manifest.js";
import { budgetBundle } from "../helpers/budget-bundle.js";
import { fakeKeychain } from "../helpers/fake-keychain.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = budgetBundle();
const CLI = resolve(BUNDLE, "cli.mjs");
const MAIN = MAINNET_MANIFEST.chains.solana;

const DEAD = "http://127.0.0.1:9";
const KEYCHAIN = /the agent key kept in the OS keychain, not as plain text/;
const GATE = /not ready for mainnet signing|mainnet is off|is a mainnet|does not sign on|is not a Solana chain/;
const AGENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PLAIN = `SOLANA_AGENT_SECRET_BASE58=${"1".repeat(88)}\nSOLANA_AGENT_ADDRESS=${AGENT}\n`;
const KEYCHAINED = `SOLANA_AGENT_KEY_STORE=os-keychain\nSOLANA_AGENT_ADDRESS=${AGENT}\n`;
const ON = { SUPERSTABLES_ALLOW_MAINNET: "1", SUPERSTABLES_BUDGET_CHAIN: "solana", SUPERSTABLES_SOLANA_RPC: DEAD };

let home: string;
let keychainDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ss-solana-mainnet-"));
  keychainDir = mkdtempSync(join(tmpdir(), "ss-solana-mainnet-kc-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(keychainDir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, ...fakeKeychain(keychainDir, ["secret-tool"]).env({}) };
  for (const k of ["SUPERSTABLES_ALLOW_MAINNET", "SUPERSTABLES_BUDGET_CHAIN", "SUPERSTABLES_SOLANA_RPC", "SUPERSTABLES_SITE", "SUPERSTABLES_MAINNET_PAUSE"]) delete base[k];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...base, ...env }, encoding: "utf8", timeout: 40_000 });
  const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: line ? JSON.parse(line.slice(7)) : null };
}
const script = (name: string, args: string[], env: Record<string, string | undefined> = {}) => run([resolve(BUNDLE, `solana/${name}.mjs`), ...args], env);
const budget = (args: string[], env: Record<string, string | undefined> = {}) => run([CLI, ...args], env);
const agentFile = (text: string) => {
  mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "keys", "budget", "solana-agent.env"), text, { mode: 0o600 });
};
const said = (r: { stdout: string; stderr: string; result: any }) => `${r.result?.reason ?? ""}\n${r.stdout}\n${r.stderr}`;

describe("with the switch off", () => {
  it("the dispatcher refuses --chain solana for setup, grant, buy and preflight, before any script runs", () => {
    const commands = [
      ["setup", "--rail", "solana", "--chain", "solana"],
      ["grant", "--rail", "solana", "--chain", "solana", "--amount", "1"],
      ["buy", "--rail", "solana", "--chain", "solana", "--url", "https://seller.example/x", "--max", "1", "--op", "a1"],
      ["preflight", "--rail", "solana", "--chain", "solana", "--url", "https://seller.example/x"],
    ];
    for (const c of commands) {
      const r = budget(c);
      expect(r.code, c[0]).toBe(3);
      expect(r.result, c[0]).toMatchObject({ ok: false, state: "refused_precheck" });
      expect(said(r), c[0]).toMatch(/SUPERSTABLES_ALLOW_MAINNET|mainnet/);
    }
    expect(existsSync(join(home, "keys", "budget", "solana-agent.env"))).toBe(false);
  }, 60_000);

  it("every Solana script refuses SUPERSTABLES_BUDGET_CHAIN=solana as it loads, before a key file or an RPC", () => {
    agentFile(PLAIN);
    for (const name of ["setup", "setBudget", "buy", "readBudget", "reconcile", "revokeBudget", "fundAgent", "siteCall", "rotate"]) {
      const r = script(name, [], { SUPERSTABLES_BUDGET_CHAIN: "solana", SUPERSTABLES_SOLANA_RPC: DEAD });
      expect(r.code, name).toBe(3);
      expect(r.result, name).toMatchObject({ ok: false, rail: "solana", chain: "solana", state: "refused_precheck" });
      expect(r.result.reason, name).toMatch(/not a Solana chain this process holds/);
    }
  }, 120_000);

  it("devnet is unchanged: the same scripts get past the gate", () => {
    for (const name of ["readBudget", "buy"]) {
      const r = script(name, name === "buy" ? ["--url", "http://127.0.0.1:9/x", "--max", "1", "--op", "d1"] : [], { SUPERSTABLES_SOLANA_RPC: DEAD });
      expect(said(r), name).not.toMatch(GATE);
    }
  }, 60_000);
});

describe("with the switch on, the agent key", () => {
  it("is required in the OS keychain by buy, setBudget and siteCall, and by setup unless it moves the key there", () => {
    agentFile(PLAIN);
    const calls: [string, string[]][] = [
      ["buy", ["--url", "http://127.0.0.1:9/x", "--max", "1", "--op", "m1"]],
      ["setBudget", ["--amount", "1"]],
      ["siteCall", ["--site", "http://127.0.0.1:9", "--path", "/api/v1/recovery/advice"]],
      ["setup", []],
    ];
    for (const [name, args] of calls) {
      const r = script(name, args, ON);
      expect(r.code, name).toBe(3);
      expect(r.result, name).toMatchObject({ chain: "solana", state: "refused_precheck" });
      expect(r.result.reason, name).toMatch(KEYCHAIN);
    }
  }, 120_000);

  it("setup writes no plain-text mainnet key when the file is absent", () => {
    const r = script("setup", [], ON);
    expect(r.code).toBe(3);
    expect(r.result.reason).toMatch(KEYCHAIN);
    expect(existsSync(join(home, "keys", "budget", "solana-agent.env"))).toBe(false);
  });

  it("is not asked of setup --key-store os-keychain, which moves or creates it there", () => {
    // a bad --site ends setup at its usage check, after the gate and before any key, wallet or RPC
    const r = script("setup", ["--key-store", "os-keychain", "--hosted", "--site", "not a url"], ON);
    expect(r.code).toBe(2);
    expect(said(r)).not.toMatch(KEYCHAIN);
    expect(existsSync(join(home, "keys", "budget", "solana-agent.env"))).toBe(false);
  });

  it("passes the gate for buy, setBudget and siteCall once the file names the keychain", () => {
    agentFile(KEYCHAINED);
    const calls: [string, string[]][] = [
      ["buy", ["--url", "http://127.0.0.1:9/x", "--max", "1", "--op", "m2"]],
      ["setBudget", ["--amount", "1"]],
      ["siteCall", ["--site", "http://127.0.0.1:9", "--path", "/api/v1/recovery/advice", "--method", "GET"]],
    ];
    for (const [name, args] of calls) {
      const r = script(name, args, ON);
      expect(said(r), name).not.toMatch(KEYCHAIN);
      expect(said(r), name).not.toMatch(GATE);
    }
  }, 120_000);

  it("is not asked of readBudget, reconcile, revokeBudget, fundAgent or buy --check, whatever the file holds", () => {
    agentFile(PLAIN);
    const calls: [string, string[]][] = [
      ["readBudget", []],
      ["reconcile", ["--op", "nothing-here"]],
      ["revokeBudget", ["--timeout", "10", "--no-open"]],
      ["fundAgent", ["--timeout", "10", "--no-open"]],
      ["buy", ["--check", "--url", "http://127.0.0.1:9/x"]],
    ];
    for (const [name, args] of calls) {
      const r = script(name, args, ON);
      expect(said(r), name).not.toMatch(KEYCHAIN);
      expect(said(r), name).not.toMatch(GATE);
    }
  }, 120_000);

  it("is refused by every mainnet script during a pause", () => {
    agentFile(KEYCHAINED);
    const r = script("readBudget", [], { ...ON, SUPERSTABLES_MAINNET_PAUSE: "1" });
    expect(r.code).toBe(3);
    expect(r.result.reason).toMatch(/mainnet signing is paused/);
  });
});

describe("rotation", () => {
  it("refuses while a Solana mainnet public file names an agent, and says what to do", () => {
    mkdirSync(join(home, "budget", "public"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "budget", "public", "solana-solana.env"), `SOLANA_OWNER_ADDRESS=${AGENT}\nSOLANA_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
    agentFile(PLAIN);
    for (const flag of ["--balances", "--sweep"]) {
      const r = script("rotate", [flag]);
      expect(r.code, flag).toBe(3);
      expect(r.result.reason, flag).toMatch(/a Solana mainnet budget is set up/);
      expect(r.result.next, flag).toMatch(/revoke --rail solana --chain solana/);
    }
    // --address only reads: the retired-key checks of every command still work
    expect(script("rotate", ["--address"]).result?.reason ?? "").not.toMatch(/mainnet budget/);
  }, 60_000);
});

describe("the seller's chain (precheck)", () => {
  const DEVNET = { caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", v1: "solana-devnet", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };
  const MAIN_FACTS = { caip2: MAIN.caip2, v1: MAIN.v1Name, mint: MAIN.token.address };
  const PAY_TO = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";

  /** For each offer, whether selectRequirement picks it and what checkOffer says, on the chain the process is set to. */
  function precheck(env: Record<string, string>) {
    const code = `
      const { selectRequirement, checkOffer } = await import(${JSON.stringify(new URL("../../budget/solana/precheck.mjs", import.meta.url).href)});
      const offer = (network, asset) => ({ scheme: "exact", network, asset, amount: "10000", payTo: ${JSON.stringify(PAY_TO)} });
      const facts = ${JSON.stringify({ DEVNET, MAIN_FACTS })};
      const out = {};
      for (const [name, f] of Object.entries(facts)) {
        for (const [how, network] of [["caip2", f.caip2], ["v1", f.v1]]) {
          const o = offer(network, f.mint);
          const picked = selectRequirement([o]);
          out[name + "/" + how] = { picked: Boolean(picked), ok: picked ? checkOffer(picked, { maxBase: 20000n }).ok : false };
        }
      }
      // this chain's network with the other chain's mint
      const mixed = selectRequirement([offer(${JSON.stringify(env.SUPERSTABLES_BUDGET_CHAIN === "solana" ? MAIN.caip2 : DEVNET.caip2)}, ${JSON.stringify(env.SUPERSTABLES_BUDGET_CHAIN === "solana" ? DEVNET.mint : MAIN.token.address)})]);
      out.mixed = checkOffer(mixed, { maxBase: 20000n });
      out.none = checkOffer(selectRequirement([]), { maxBase: 1n });
      console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? String(v) : v)));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_SOLANA_RPC: DEAD, ...env }, encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) throw new Error(`precheck run failed: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
  }

  it("on mainnet takes the mainnet's CAIP-2 and v1 name with its mint, and never devnet's", () => {
    const out = precheck({ SUPERSTABLES_ALLOW_MAINNET: "1", SUPERSTABLES_BUDGET_CHAIN: "solana" });
    expect(out["MAIN_FACTS/caip2"]).toEqual({ picked: true, ok: true });
    expect(out["MAIN_FACTS/v1"]).toEqual({ picked: true, ok: true });
    expect(out["DEVNET/caip2"].picked).toBe(false);
    expect(out["DEVNET/v1"].picked).toBe(false);
    expect(out.mixed.ok).toBe(false);
    expect(out.mixed.reasons.join(" ")).toMatch(/is not the Solana USDC mint/);
    expect(out.none.reasons.join(" ")).toMatch(/no exact-scheme Solana offer/);
  });

  it("on devnet takes devnet's and never mainnet's", () => {
    const out = precheck({});
    expect(out["DEVNET/caip2"]).toEqual({ picked: true, ok: true });
    expect(out["DEVNET/v1"]).toEqual({ picked: true, ok: true });
    expect(out["MAIN_FACTS/caip2"].picked).toBe(false);
    expect(out["MAIN_FACTS/v1"].picked).toBe(false);
    expect(out.mixed.ok).toBe(false);
    expect(out.none.reasons.join(" ")).toMatch(/no exact-scheme Solana devnet offer/);
  });
});
