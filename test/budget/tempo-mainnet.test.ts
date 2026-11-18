// Tempo mainnet budgets behind the operator's switch (SUPERSTABLES_ALLOW_MAINNET). Off: every mainnet path is refused as it
// loads. On: the scripts that sign with, or grant, the agent key need it in the OS keychain (the mainnet file names the
// keychain and holds addresses only); the scripts that read the chain or revoke do not. Moderato stays as it was.
// The real dispatcher and the built rail scripts, with a fake secret-tool first on PATH and a dead RPC on this computer
// (a script that gets past the gate fails to read the chain; nothing leaves this machine, and no mainnet RPC is asked).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { budgetBundle } from "../helpers/budget-bundle.js";
import { fakeKeychain, type FakeKeychain } from "../helpers/fake-keychain.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = budgetBundle();
const CLI = resolve(BUNDLE, "cli.mjs");

const AGENT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const SECRET = generatePrivateKey();
const SECRET_ADDRESS = privateKeyToAddress(SECRET);
const KEYCHAIN_PREREQ = /the agent key kept in the OS keychain, not as plain text/;
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
const ON = { SUPERSTABLES_ALLOW_MAINNET: "1", SUPERSTABLES_TEMPO_RPC: "http://127.0.0.1:9" };
function run(cmd: string, args: string[], env: Record<string, string> = {}): Out {
  const base: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home };
  for (const k of ["SUPERSTABLES_MAINNET_PAUSE", "SUPERSTABLES_ALLOW_MAINNET", "SUPERSTABLES_BUDGET_CHAIN", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SITE"]) delete base[k];
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { ...kc.env(base as Record<string, string>), ...env }, encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result: line ? JSON.parse(line.slice(7)) : null };
}
const budget = (args: string[], env: Record<string, string> = {}) => run(process.execPath, [CLI, ...args], env);
/** A rail script run directly, on the chain the dispatcher would name for it. */
const script = (name: string, args: string[], env: Record<string, string> = {}) => run(process.execPath, [resolve(BUNDLE, `tempo/${name}.mjs`), ...args], env);
const onMainnet = (name: string, args: string[], env: Record<string, string> = {}) => script(name, args, { SUPERSTABLES_BUDGET_CHAIN: "tempo", ...ON, ...env });

const keysDir = () => join(home, "keys", "budget");
const mainnetFile = () => join(keysDir(), "tempo-tempo-agent.env");
const moderatoFile = () => join(keysDir(), "tempo-agent.env");
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode: 0o600 }); };
const keychainFile = (address = AGENT) => put(mainnetFile(), `AGENT_KEY_STORE=os-keychain\nAGENT_ADDRESS=${address}\nOWNER_ADDRESS=${OWNER}\n`);
const plainFile = () => put(mainnetFile(), `AGENT_PRIVATE_KEY=${SECRET}\nAGENT_ADDRESS=${SECRET_ADDRESS}\nOWNER_ADDRESS=${OWNER}\n`);
const reasonOf = (o: Out) => String(o.result?.reason ?? "");

const BUY = ["--url", "http://127.0.0.1:9/paid", "--max", "0.01", "--op", "m1"];
const GRANT = ["--amount", "0.05", "--expiry-seconds", "86400"];

describe("the switch is off", () => {
  it.each([
    ["setup", ["setup", "--rail", "tempo", "--chain", "tempo"]],
    ["grant", ["grant", "--rail", "tempo", "--chain", "tempo", "--amount", "0.05"]],
    ["buy", ["buy", "--rail", "tempo", "--chain", "tempo", "--url", "http://127.0.0.1:9/p", "--max", "0.01"]],
    ["preflight", ["preflight", "--rail", "tempo", "--chain", "tempo", "--url", "http://127.0.0.1:9/p"]],
  ])("the dispatcher refuses --chain tempo for %s before anything runs", (_name, args) => {
    const r = budget(args);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(reasonOf(r)).toMatch(/SUPERSTABLES_ALLOW_MAINNET|mainnet/);
    expect(existsSync(keysDir())).toBe(false);
  }, 60_000);

  it.each([
    ["buy", BUY],
    ["setBudget", GRANT],
    ["setup", []],
    ["preflight", ["--url", "http://127.0.0.1:9/p"]],
    ["readBudget", []],
    ["reconcile", ["--op", "x"]],
    ["revokeBudget", []],
    ["siteCall", ["--site", "https://example.invalid", "--path", "/api/v1/budget/services", "--method", "GET"]],
  ])("%s refuses as it loads when SUPERSTABLES_BUDGET_CHAIN names the mainnet", (name, args) => {
    const r = script(name, args, { SUPERSTABLES_BUDGET_CHAIN: "tempo", SUPERSTABLES_TEMPO_RPC: "http://127.0.0.1:9" });
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck", rail: "tempo" });
    expect(reasonOf(r)).toMatch(/not a Tempo chain this process holds/);
    expect(existsSync(keysDir())).toBe(false);
  }, 60_000);

  it("Moderato is unaffected: preflight gets past the gate and ends on the unreachable seller", () => {
    const r = script("preflight", ["--url", "http://127.0.0.1:9/p"]);
    expect(reasonOf(r)).not.toMatch(GATE);
    expect(r.result?.chain).toBeUndefined();
  }, 60_000);

  it("setup refuses --key-store on Moderato, where the agent key stays in its file", () => {
    const r = script("setup", ["--key-store", "os-keychain"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--key-store is for Tempo mainnet/);
    expect(existsSync(moderatoFile())).toBe(false);
    expect(kc.calls()).toEqual([]);
  }, 60_000);
});

describe("the switch is on: the agent key must be in the keychain where it signs", () => {
  it("setup without --key-store os-keychain is refused, naming the flag, and writes nothing", () => {
    const r = onMainnet("setup", []);
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(KEYCHAIN_PREREQ);
    expect(r.result.next).toMatch(/--chain tempo --key-store os-keychain/);
    expect(existsSync(mainnetFile())).toBe(false);
    expect(kc.calls()).toEqual([]);
  }, 60_000);

  it("setup --key-store file is refused too", () => {
    const r = onMainnet("setup", ["--key-store", "file"]);
    expect(r.code).toBe(3);
    expect(existsSync(mainnetFile())).toBe(false);
  }, 60_000);

  it("setup --fund-only is refused: the mainnet has no faucet", () => {
    keychainFile();
    const r = onMainnet("setup", ["--fund-only"]);
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/no faucet/);
  }, 60_000);

  it("buy, grant and the site call refuse while the mainnet file is missing", () => {
    for (const [name, args] of [["buy", BUY], ["setBudget", GRANT], ["siteCall", ["--site", "https://example.invalid", "--path", "/api/v1/budget/services", "--method", "GET"]]] as const) {
      const r = onMainnet(name, [...args]);
      expect(r.code, name).toBe(3);
      expect(reasonOf(r), name).toMatch(KEYCHAIN_PREREQ);
      expect(r.result.chain, name).toBe("tempo");
    }
    expect(existsSync(join(home, "budget", "ops"))).toBe(false);
  }, 120_000);

  it("buy, grant and the site call refuse an agent file that holds a plain key", () => {
    plainFile();
    for (const [name, args] of [["buy", BUY], ["setBudget", GRANT], ["siteCall", ["--site", "https://example.invalid", "--path", "/api/v1/budget/services", "--method", "GET"]]] as const) {
      const r = onMainnet(name, [...args]);
      expect(r.code, name).toBe(3);
      expect(reasonOf(r), name).toMatch(KEYCHAIN_PREREQ);
    }
  }, 120_000);

  it("a file that names the keychain passes the gate; buy then refuses, signing nothing, when the keychain has no key", () => {
    keychainFile();
    const r = onMainnet("buy", BUY);
    expect(reasonOf(r)).not.toMatch(GATE);
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/agent_key_unavailable.*not in the keychain/);
    expect(r.result).toMatchObject({ state: "refused_precheck", chain: "tempo" });
    expect(r.result.next).toMatch(/--chain tempo/);
  }, 60_000);

  it("a locked keychain refuses buy (exit 3) and the site call, signing nothing", () => {
    keychainFile(SECRET_ADDRESS);
    kc.setStore({ [`tempo:${SECRET_ADDRESS}`]: SECRET });
    for (const [name, args] of [["buy", BUY], ["siteCall", ["--site", "https://example.invalid", "--path", "/api/v1/budget/services", "--method", "GET"]]] as const) {
      const r = onMainnet(name, [...args], { FAKE_KEYCHAIN_FAIL: "1" });
      expect(r.code, name).toBe(3);
      expect(r.result, name).toMatchObject({ state: "refused_precheck" });
      expect(reasonOf(r), name).toMatch(/not in the keychain|keychain/);
    }
  }, 120_000);

  it("a keychain entry for another key than the file's address is refused", () => {
    keychainFile(AGENT);
    kc.setStore({ [`tempo:${AGENT}`]: SECRET }); // derives to SECRET_ADDRESS, not AGENT
    const r = onMainnet("buy", BUY);
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/keychain holds a key for/);
  }, 60_000);

  it("a pause refuses buy even with the keychain in place", () => {
    keychainFile();
    const r = onMainnet("buy", BUY, { SUPERSTABLES_MAINNET_PAUSE: "1" });
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/paused/);
  }, 60_000);

  it("the scripts that read or revoke need no agent key: they get past the gate with no file, and with a plain one", () => {
    for (const setup of [() => undefined, plainFile]) {
      setup();
      const cases: [string, string[]][] = [["readBudget", []], ["reconcile", ["--op", "nothing"]], ["revokeBudget", []], ["preflight", ["--url", "http://127.0.0.1:9/p"]]];
      for (const [name, args] of cases) {
        const r = onMainnet(name, args);
        expect(`${reasonOf(r)}\n${r.stderr}`, name).not.toMatch(GATE);
        expect(`${reasonOf(r)}\n${r.stderr}`, name).not.toMatch(KEYCHAIN_PREREQ);
      }
    }
  }, 180_000);

  it("revoke finds its public file for the mainnet, on the mainnet's own name", () => {
    const r = onMainnet("revokeBudget", []);
    expect(r.code).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", chain: "tempo", reason: "the public file names no owner or no agent" });
    expect(r.result.next).toBe("superstables budget setup --rail tempo --chain tempo");
  }, 60_000);

  it("doctor reads the mainnet's own files: the keychain entry is checked, a plain key fails, and no faucet is offered", () => {
    keychainFile(SECRET_ADDRESS);
    kc.setStore({ [`tempo:${SECRET_ADDRESS}`]: SECRET });
    const ok = budget(["doctor", "--rail", "tempo", "--chain", "tempo"], ON);
    expect(ok.stderr).toContain(mainnetFile());
    expect(ok.stderr).toMatch(/ok\s+agent key in the OS keychain/);
    expect(ok.stderr).toContain("key storage: OS keychain");
    expect(ok.stderr).not.toMatch(/--fund-only|faucet/);
    expect(ok.stderr).not.toContain(SECRET);
    plainFile();
    const plain = budget(["doctor", "--rail", "tempo", "--chain", "tempo"], ON);
    expect(plain.stderr).toMatch(/FAIL\s+key storage: .*plain-text file.*--chain tempo --key-store os-keychain/);
  }, 90_000);

  it("an owner key file is a plain-text key and is refused on the mainnet", () => {
    keychainFile();
    const r = onMainnet("setBudget", [...GRANT, "--owner-key-file", join(scratch, "owner.env")]);
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/plain-text owner key/);
  }, 60_000);
});

describe.skipIf(process.platform === "darwin")("setup on the mainnet makes the key in the keychain", () => {
  // the owner page is asked after the key exists; a one second approval link ends the command there, which is all this needs
  const setup = (env: Record<string, string> = {}) => onMainnet("setup", ["--key-store", "os-keychain", "--no-open", "--timeout", "1"], env);

  it("stores the key first, then writes a file that holds addresses and the keychain's name, never a key", () => {
    const r = setup();
    expect(existsSync(mainnetFile()), r.stdout + r.stderr).toBe(true);
    const text = readFileSync(mainnetFile(), "utf8");
    expect(text).toMatch(/^AGENT_KEY_STORE=os-keychain$/m);
    const address = text.match(/^AGENT_ADDRESS=(0x[0-9a-fA-F]{40})$/m)![1];
    expect(text).not.toMatch(/PRIVATE|0x[0-9a-fA-F]{64}/);
    expect(statSync(mainnetFile()).mode & 0o777).toBe(0o600);
    const secret = kc.store()[`tempo:${address}`];
    expect(privateKeyToAddress(secret as `0x${string}`)).toBe(address);
    // the key went in on stdin, never in an argument, and nothing printed it
    expect(JSON.stringify(kc.calls().map((c) => c.argv))).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(existsSync(moderatoFile())).toBe(false);
  }, 90_000);

  it("a keychain that refuses leaves no file and no key", () => {
    const r = setup({ FAKE_KEYCHAIN_FAIL: "1" });
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/the keychain refused the key/);
    expect(existsSync(mainnetFile())).toBe(false);
    expect(kc.store()).toEqual({});
  }, 90_000);

  it("a second run reuses the key it made, and the gate then lets buy and grant load", () => {
    setup();
    const first = readFileSync(mainnetFile(), "utf8");
    setup();
    expect(readFileSync(mainnetFile(), "utf8").match(/^AGENT_ADDRESS=.*$/m)![0]).toBe(first.match(/^AGENT_ADDRESS=.*$/m)![0]);
    expect(Object.keys(kc.store())).toHaveLength(1);
    const r = onMainnet("buy", BUY);
    expect(reasonOf(r)).not.toMatch(GATE);
  }, 120_000);

  it("a mainnet file that holds a key is refused by setup, and its key is not moved anywhere", () => {
    plainFile();
    const r = setup();
    expect(r.code).toBe(3);
    expect(reasonOf(r)).toMatch(/plain-text key/);
    expect(readFileSync(mainnetFile(), "utf8")).toContain(SECRET);
    expect(kc.store()).toEqual({});
  }, 90_000);
});
