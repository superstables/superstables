// The budget is testnet only. Robinhood Chain's testnet (robinhood-testnet, 46630) is a budget chain; its mainnet
// (robinhood, 4663) is refused before anything runs, both by the dispatcher (budget/cli.mjs) and by the guard every EVM
// script imports first (budget/evm/cli-guard.mjs). No network, no key: the refusals happen before either is touched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVM_CHAIN_KEYS } from "../../budget/evm/chains.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/.bin/tsx");

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
const budget = (args: string[]) => run(process.execPath, [resolve(ROOT, "budget/cli.mjs"), ...args]);
const script = (args: string[], env: Record<string, string> = {}) => run(TSX, [resolve(ROOT, "budget/evm/read.ts"), ...args], env);

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
      expect(flag.result, chain).toMatchObject({ ok: false, state: "refused_precheck", reason: "mainnet is refused: testnet only" });
      const env = script([], { B4_CHAIN: chain });
      expect(env.code, `B4_CHAIN=${chain}`).toBe(3);
    }
  });

  it("every EVM script takes --chain robinhood-testnet past the guard", () => {
    const r = script(["--chain", "robinhood-testnet"]);
    expect(r.code).not.toBe(3);
    expect(r.stderr).not.toMatch(/REFUSED/);
    expect(script(["--help"]).stdout).toContain("robinhood-testnet");
  });
});
