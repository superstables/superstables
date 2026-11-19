// The budget is testnet by default. Robinhood Chain's testnet (robinhood-testnet, 46630) is a budget chain; its mainnet
// (robinhood, 4663) is refused before anything runs while the operator's switch is off, both by the dispatcher
// (budget/cli.mjs) and by the guard every EVM script imports first (budget/evm/cli-guard.mjs). With the switch on, the
// EVM mainnets are chains of the table, and the guard checks what each script needs. No network, no funded key.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVM_CHAIN_KEYS } from "../../budget/evm/chains.mjs";
import { budgetBundle } from "../helpers/budget-bundle.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = budgetBundle();
const CLI = resolve(BUNDLE, "cli.mjs");

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ss-chain-guard-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, ...extraEnv };
  if (!("B4_CHAIN" in extraEnv)) delete env.B4_CHAIN;
  const r = spawnSync(cmd, args, { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
  const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: line ? JSON.parse(line.slice(7)) : null };
}
const budget = (args: string[]) => run(process.execPath, [CLI, ...args]);
const script = (args: string[], env: Record<string, string> = {}) => run(process.execPath, [resolve(BUNDLE, "evm/read.mjs"), ...args], env);

const MAINNET = ["robinhood", "4663", "eip155:4663", "robinhood-mainnet"];

describe("Robinhood Chain in the budget", () => {
  it("is a budget chain under its testnet key", () => {
    expect(EVM_CHAIN_KEYS).toContain("robinhood-testnet");
    expect(EVM_CHAIN_KEYS).not.toContain("robinhood");
  });

  it("the dispatcher refuses Robinhood Chain's mainnet, by name or chain id, before anything runs", () => {
    for (const chain of MAINNET) {
      const r = budget(["status", "--rail", "evm", "--chain", chain]);
      expect(r.code, chain).toBe(3);
      expect(r.result, chain).toMatchObject({ ok: false, state: "refused_precheck" });
    }
  });

  it("the dispatcher takes --chain robinhood-testnet past the mainnet check", () => {
    const r = budget(["status", "--rail", "evm", "--chain", "robinhood-testnet"]);
    expect(r.result).toMatchObject({ chain: "robinhood-testnet", state: "failed" });
    expect(r.result.reason).toMatch(/no budget has been set up here for evm on robinhood-testnet/);
  });

  it("every EVM script refuses Robinhood Chain's mainnet from --chain or B4_CHAIN, before a key or the chain is read", () => {
    for (const chain of MAINNET) {
      const flag = script(["--chain", chain]);
      expect(flag.code, chain).toBe(3);
      expect(flag.result, chain).toMatchObject({ ok: false, state: "refused_precheck", reason: expect.stringMatching(/is a mainnet, and this run is testnet-only \(--testnet\), so mainnets are off/) });
      const env = script([], { B4_CHAIN: chain });
      expect(env.code, `B4_CHAIN=${chain}`).toBe(3);
    }
  }, 60_000); // one process per EVM script and per mainnet name, twice: every new script adds spawns

  it("with SUPERSTABLES_ALLOW_MAINNET=1 Robinhood Chain is a chain of the table, the guard stops refusing by name, and an unknown chain is still bad input", () => {
    const on = { SUPERSTABLES_TESTNET: "" };
    const s = script(["--chain", "robinhood"], on);
    expect(s.stderr).not.toMatch(/is a mainnet/);
    expect(s.stderr).not.toMatch(/unknown chain/);
    expect(script(["--chain", "optimism"], on).code).toBe(2);
    expect(script(["--mainnet"], on).code).toBe(2);
    const d = run(process.execPath, [CLI, "status", "--rail", "evm", "--chain", "robinhood"], on);
    expect(d.result?.reason ?? "").not.toMatch(/--chain for evm must be one of|is a mainnet/);
    const unknown = run(process.execPath, [CLI, "status", "--rail", "evm", "--chain", "optimism"], on);
    expect(unknown.code).toBe(2);
    expect(unknown.result?.reason).toMatch(/--chain for evm must be one of/);
    const flag = run(process.execPath, [CLI, "status", "--rail", "evm", "--mainnet"], on);
    expect(flag.result?.state).not.toBe("refused_precheck");
  }, 60_000);

  it("an invalid SUPERSTABLES_ALLOW_MAINNET refuses a mainnet with the error, and leaves a testnet alone", () => {
    const bad = { SUPERSTABLES_ALLOW_MAINNET: "yes" };
    const s = script(["--chain", "robinhood"], bad);
    expect(s.code).toBe(3);
    expect(s.result?.reason).toContain('SUPERSTABLES_ALLOW_MAINNET is "yes"');
    const d = run(process.execPath, [CLI, "status", "--rail", "evm", "--chain", "robinhood"], bad);
    expect(d.code).toBe(3);
    expect(d.result?.reason).toContain("SUPERSTABLES_ALLOW_MAINNET");
    expect(script(["--chain", "robinhood-testnet"], bad).code).not.toBe(3);
  }, 60_000);

  it("every EVM script takes --chain robinhood-testnet past the guard", () => {
    const r = script(["--chain", "robinhood-testnet"]);
    expect(r.code).not.toBe(3);
    expect(r.stderr).not.toMatch(/REFUSED/);
    expect(script(["--help"]).stdout).toContain("robinhood-testnet");
  }, 60_000);
});

describe("the EVM mainnets with SUPERSTABLES_ALLOW_MAINNET=1", () => {
  // A dead RPC on this computer: a script that gets past the gate fails to read the chain, and nothing leaves this machine.
  const on = { SUPERSTABLES_TESTNET: "", B4_RPC_BASE: "http://127.0.0.1:9", B4_RPC_SKALE_BASE: "http://127.0.0.1:9" };
  const evm = (name: string, args: string[], env: Record<string, string> = {}) => run(process.execPath, [resolve(BUNDLE, `evm/${name}.mjs`), ...args], { ...on, ...env });
  const KEYCHAIN = /the agent key kept in the OS keychain, not as plain text/;
  const GATE = /not ready for mainnet signing|mainnet is off|is a mainnet|does not sign on/;
  const plainKey = () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\n`, { mode: 0o600 });
  };

  it("takes the mainnets as --chain keys", () => {
    const r = evm("read", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--chain [^\n]*\|base\|/);
  });

  it("setup refuses a mainnet agent key outside the OS keychain, before it writes one", () => {
    const r = evm("setup", ["--chain", "base"]);
    expect(r.code).toBe(3);
    expect(r.result?.reason).toMatch(KEYCHAIN);
    expect(existsSync(join(home, "keys", "budget", "evm-agent.env"))).toBe(false);
  });

  it("grant, buy and recover refuse an agent key kept as plain text", () => {
    plainKey();
    for (const name of ["setBudget", "buy", "recover"]) {
      const r = evm(name, ["--chain", "base"]);
      expect(r.code, name).toBe(3);
      expect(r.result?.reason, name).toMatch(KEYCHAIN);
    }
  });

  it("read and revoke (the owner's own transaction) get past the gate, whatever the agent key file holds", () => {
    plainKey();
    for (const [name, args] of [["read", ["--chain", "base"]], ["revoke", ["--chain", "base", "--plan"]]] as const) {
      const r = evm(name, [...args]);
      expect(`${r.result?.reason ?? ""}\n${r.stderr}`, name).not.toMatch(GATE);
    }
  });

  it("refuses SKALE Base until the owner names their own node, and every mainnet during a pause", () => {
    expect(evm("read", ["--chain", "skale-base"]).result?.reason).toMatch(/not ready for mainnet signing: RPC endpoints that can decide/);
    expect(evm("read", ["--chain", "base"], { SUPERSTABLES_MAINNET_PAUSE: "1" }).result?.reason).toMatch(/mainnet signing is paused/);
  });
});
