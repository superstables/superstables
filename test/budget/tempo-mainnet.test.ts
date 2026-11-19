// Tempo mainnet (chain 4217) is not a chain this client holds. The dispatcher refuses --chain tempo as it refuses any
// chain it does not know, and a rail script told to run on it refuses as it loads, before it reads a key or an RPC.
// Moderato, with --testnet, stays as it was. The real dispatcher and the built rail scripts, with a fake secret-tool
// first on PATH and a dead RPC on this computer (nothing leaves this machine).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetBundle } from "../helpers/budget-bundle.js";
import { fakeKeychain, type FakeKeychain } from "../helpers/fake-keychain.js";
import { TEMPO_CHAIN_KEYS, TEMPO_DEFAULT_CHAIN } from "../../budget/tempo/lib/constants.mjs";
import { mainnetChains, mainnetEntry } from "../../src/core/mainnet-policy.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = budgetBundle();
const CLI = resolve(BUNDLE, "cli.mjs");
const GATE = /not ready for mainnet signing|mainnet is off|does not sign on|is a mainnet/;

let scratch: string;
let home: string;
let kc: FakeKeychain;
beforeEach(() => {
  scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ss-tempo-mainnet-"));
  home = join(scratch, "home");
  mkdirSync(home, { mode: 0o700 });
  kc = fakeKeychain(join(scratch, "kc"), ["secret-tool"]);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

type Out = { code: number | null; stdout: string; stderr: string; result: any };
const MAINNET = { SUPERSTABLES_TESTNET: "", SUPERSTABLES_TEMPO_RPC: "http://127.0.0.1:9" };
function run(cmd: string, args: string[], env: Record<string, string> = {}): Out {
  const base: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
  for (const k of ["SUPERSTABLES_MAINNET_PAUSE", "SUPERSTABLES_BUDGET_CHAIN", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SITE"]) delete base[k];
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...kc.env(base as Record<string, string>), ...env }, encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: line ? JSON.parse(line.slice(7)) : null };
}
const budget = (args: string[], env: Record<string, string> = {}) => run(process.execPath, [CLI, ...args], env);
/** A rail script run directly, on the chain the dispatcher would name for it. */
const script = (name: string, args: string[], env: Record<string, string> = {}) => run(process.execPath, [resolve(BUNDLE, `tempo/${name}.mjs`), ...args], env);
const keysDir = () => join(home, "keys", "budget");
const reasonOf = (o: Out) => String(o.result?.reason ?? "");

const COMMANDS: [string, (chain: string) => string[]][] = [
  ["setup", (c) => ["setup", "--rail", "tempo", "--chain", c]],
  ["grant", (c) => ["grant", "--rail", "tempo", "--chain", c, "--amount", "0.05"]],
  ["buy", (c) => ["buy", "--rail", "tempo", "--chain", c, "--url", "http://127.0.0.1:9/p", "--max", "0.01", "--op", "m1"]],
  ["preflight", (c) => ["preflight", "--rail", "tempo", "--chain", c, "--url", "http://127.0.0.1:9/p"]],
  ["status", (c) => ["status", "--rail", "tempo", "--chain", c]],
];

describe("Tempo mainnet is not a chain the client holds", () => {
  it("the manifest, the chain tables and the default name no Tempo mainnet", () => {
    expect(mainnetEntry("tempo")).toBeUndefined();
    expect(mainnetChains("tempo", { SUPERSTABLES_TESTNET: "" })).toEqual([]);
    expect(TEMPO_CHAIN_KEYS).toEqual(["moderato"]);
    expect(TEMPO_DEFAULT_CHAIN).toBe("moderato");
  });

  it.each(COMMANDS)("without --testnet, the dispatcher refuses --chain tempo for %s as it refuses a chain it does not know", (_name, args) => {
    const tempo = budget(args("tempo"), MAINNET);
    const unknown = budget(args("optimism"), MAINNET);
    expect(tempo.code).toBe(2);
    expect(tempo.result).toMatchObject({ ok: false, rail: "tempo", state: "failed" });
    expect(reasonOf(tempo)).toBe("--chain for tempo must be one of: moderato");
    expect({ code: tempo.code, result: tempo.result }).toEqual({ code: unknown.code, result: unknown.result });
    expect(existsSync(keysDir())).toBe(false);
  }, 60_000);

  it.each(COMMANDS)("with --testnet, the dispatcher refuses --chain tempo for %s as it refuses a chain it does not know", (_name, args) => {
    const tempo = budget([...args("tempo"), "--testnet"]);
    const unknown = budget([...args("bogus"), "--testnet"]);
    expect(tempo.code).toBe(2);
    expect(reasonOf(tempo)).toBe("--chain for tempo must be one of: moderato");
    expect({ code: tempo.code, result: tempo.result }).toEqual({ code: unknown.code, result: unknown.result });
    expect(existsSync(keysDir())).toBe(false);
  }, 60_000);

  it.each([
    ["buy", ["--url", "http://127.0.0.1:9/paid", "--max", "0.01", "--op", "m1"]],
    ["setBudget", ["--amount", "0.05", "--expiry-seconds", "86400"]],
    ["setup", []],
    ["preflight", ["--url", "http://127.0.0.1:9/p"]],
    ["readBudget", []],
    ["reconcile", ["--op", "x"]],
    ["revokeBudget", []],
    ["siteCall", ["--site", "https://example.invalid", "--path", "/api/v1/budget/services", "--method", "GET"]],
  ])("%s refuses as it loads when SUPERSTABLES_BUDGET_CHAIN names tempo, signing and writing nothing", (name, args) => {
    for (const env of [{ ...MAINNET, SUPERSTABLES_BUDGET_CHAIN: "tempo" }, { SUPERSTABLES_BUDGET_CHAIN: "tempo", SUPERSTABLES_TEMPO_RPC: "http://127.0.0.1:9" }]) {
      const r = script(name, args as string[], env);
      expect(r.code).toBe(3);
      expect(r.result).toMatchObject({ ok: false, state: "refused_precheck", rail: "tempo" });
      expect(reasonOf(r)).toMatch(/not a Tempo chain this process holds \(moderato\)/);
    }
    expect(existsSync(keysDir())).toBe(false);
    expect(kc.calls()).toEqual([]);
  }, 60_000);

  it("without --testnet, a tempo command with no --chain is refused as Moderato, a testnet", () => {
    const r = budget(["status", "--rail", "tempo"], MAINNET);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ ok: false, chain: "moderato", state: "refused_precheck" });
    expect(reasonOf(r)).toMatch(/"moderato" is a testnet, and testnets need --testnet/);
  }, 60_000);

  it("Moderato is unaffected: preflight gets past the gate and ends on the unreachable seller", () => {
    const r = script("preflight", ["--url", "http://127.0.0.1:9/p"]);
    expect(reasonOf(r)).not.toMatch(GATE);
    expect(r.result?.chain).toBeUndefined();
  }, 60_000);
});
