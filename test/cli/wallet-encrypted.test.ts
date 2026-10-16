// The wallet key at rest, as the owner meets it: a real process, a pretend terminal, real exit codes.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "src/cli/main.ts");
const TERMINAL = resolve(ROOT, "test/helpers/wallet-terminal.mjs");
const PASS = "correct horse battery";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let home: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-wallet-enc-test-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
});

/** One process, not tsx's launcher and a child: a test that kills it kills the wallet. */
function start(args: string[], options: { terminal?: boolean } = {}): ChildProcess {
  const preload = options.terminal ? ["--import", TERMINAL] : [];
  const child = spawn(process.execPath, ["--import", "tsx", ...preload, CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERSTABLES_HOME: home,
      SUPERSTABLES_DOCTOR_OFFLINE: "1",
      SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1",
    },
  });
  children.push(child);
  return child;
}

function run(args: string[], options: { terminal?: boolean; input?: string } = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = start(args, options);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
    child.stdin!.end(options.input ?? "");
  });
}

const keyFile = () => join(home, "wallet", "key");
const typed = (...lines: string[]) => lines.map((line) => `${line}\n`).join("");

describe("wallet init and the passphrase", () => {
  it("refuses without a terminal unless told to store the key unencrypted, and writes no file", async () => {
    const result = await run(["wallet", "init"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--no-passphrase");
    expect(existsSync(keyFile())).toBe(false);
  }, 30_000);

  it("--no-passphrase stores a plaintext key", async () => {
    const result = await run(["wallet", "init", "--no-passphrase"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("unencrypted");
    expect(readFileSync(keyFile(), "utf8")).toMatch(/^0x[0-9a-f]{64}\n$/);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("at a terminal, writes an envelope, and the address needs no passphrase", async () => {
    const init = await run(["wallet", "init"], { terminal: true, input: typed(PASS, PASS) });
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("encrypted with your passphrase");
    const text = readFileSync(keyFile(), "utf8");
    expect(text.trimStart().startsWith("{")).toBe(true);
    expect(text).not.toMatch(/0x[0-9a-f]{64}/);
    const address = JSON.parse(text).address as string;

    const shown = await run(["wallet", "address"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout.trim()).toBe(address);

    const doctor = await run(["--wallet", "local", "doctor"]);
    expect(doctor.stdout).toContain("(encrypted)");
  }, 60_000);

  it("--force says the old key was overwritten in place", async () => {
    await run(["wallet", "init", "--no-passphrase"]);
    const forced = await run(["wallet", "init", "--no-passphrase", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain("overwritten in place, then replaced");
  }, 30_000);

  it("setup --wallet local without a terminal creates no key, and says how to make one", async () => {
    const result = await run(["--wallet", "local", "setup"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("not created: setup needs a terminal to ask for the key's passphrase");
    expect(result.stdout).toContain("superstables wallet init --no-passphrase");
    expect(existsSync(keyFile())).toBe(false);
  }, 30_000);

  it("wallet encrypt converts a plaintext key and keeps its address", async () => {
    const plain = await run(["wallet", "init", "--no-passphrase"]);
    const address = /0x[0-9a-fA-F]{40}/.exec(plain.stdout)![0];
    const refused = await run(["wallet", "encrypt"], { input: "" });
    expect(refused.code).toBe(2);
    const done = await run(["wallet", "encrypt"], { terminal: true, input: typed(PASS, PASS) });
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain(address);
    expect(done.stdout).toContain("overwritten in place");
    expect(JSON.parse(readFileSync(keyFile(), "utf8")).address).toBe(address);
    const again = await run(["wallet", "encrypt"], { terminal: true, input: typed(PASS, PASS) });
    expect(again.code).toBe(1);
  }, 60_000);
});

describe("wallet encrypt over a key it cannot overwrite", () => {
  it("warns on stderr, naming the symlink's target, and still encrypts", async () => {
    const vault = join(home, "vault-key");
    const key = `0x${"ab".repeat(32)}`;
    writeFileSync(vault, `${key}\n`, { mode: 0o600 });
    mkdirSync(join(home, "wallet"), { mode: 0o700 });
    symlinkSync(vault, keyFile());
    const done = await run(["wallet", "encrypt"], { terminal: true, input: typed(PASS, PASS) });
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toContain("the old key was not overwritten");
    expect(done.stderr).toContain(vault);
    expect(readFileSync(vault, "utf8")).toBe(`${key}\n`);
    expect(done.stdout).not.toContain("overwritten in place");
  }, 60_000);

  it("checks the home folder before it asks for a passphrase", async () => {
    mkdirSync(join(home, "wallet"), { mode: 0o700 });
    writeFileSync(keyFile(), `0x${"ab".repeat(32)}\n`, { mode: 0o600 });
    const { chmodSync } = await import("node:fs");
    chmodSync(home, 0o777);
    const done = await run(["wallet", "encrypt"], { terminal: true, input: typed(PASS, PASS) });
    expect(done.code).not.toBe(0);
    expect(done.stderr).not.toContain("New passphrase");
  }, 60_000);

  it("wallet init without a terminal still mentions a leftover .tmp", async () => {
    mkdirSync(join(home, "wallet"), { mode: 0o700 });
    writeFileSync(join(home, "wallet", ".key.1.abcd1234.tmp"), "{}", { mode: 0o600 });
    const result = await run(["wallet", "init"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/\.key\.1\.abcd1234\.tmp/);
  }, 30_000);
});

describe("wallet serve with an encrypted key", () => {
  it("does not start without a terminal", async () => {
    await run(["wallet", "init"], { terminal: true, input: typed(PASS, PASS) });
    const result = await run(["wallet", "serve", "--port", "0", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("encrypted");
    expect(result.stdout).not.toContain("Superstables wallet on");
  }, 60_000);

  it("gives up after three wrong passphrases, and starts on the right one", async () => {
    await run(["wallet", "init"], { terminal: true, input: typed(PASS, PASS) });
    const wrong = await run(["wallet", "serve", "--port", "0", "--no-open"], { terminal: true, input: typed("nope nope nope", "nope nope nope", "nope nope nope") });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain("the passphrase is not right; the wallet did not start");
    expect(wrong.stdout).not.toContain("Superstables wallet on");

    const child = start(["wallet", "serve", "--port", "0", "--no-open"], { terminal: true });
    let stdout = "";
    child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    child.stdin!.write(typed(PASS));
    const url = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the wallet did not start: ${stdout}`)), 30_000);
      const look = () => {
        const found = /Superstables wallet on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
        if (found) {
          clearTimeout(timer);
          done(found[1]!);
        } else setTimeout(look, 100);
      };
      look();
    });
    // the started wallet signs with the decrypted key: it answers with the envelope's address
    const token = readFileSync(join(home, "wallet", "agent-token"), "utf8").trim();
    const answer = await fetch(`${url}/address`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(await answer.json())).toContain(JSON.parse(readFileSync(keyFile(), "utf8")).address);
    child.kill("SIGTERM");
    await new Promise((done) => child.once("close", done));
  }, 90_000);

  it("says so, and starts, when the key is not encrypted", async () => {
    await run(["wallet", "init", "--no-passphrase"]);
    const child = start(["wallet", "serve", "--port", "0", "--no-open"]);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr!.on("data", (chunk) => (stderr += String(chunk)));
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the wallet did not start: ${stdout}${stderr}`)), 30_000);
      const look = () => {
        if (stdout.includes("Superstables wallet on")) {
          clearTimeout(timer);
          done();
        } else setTimeout(look, 100);
      };
      look();
    });
    expect(stderr).toContain("the key file is not encrypted");
    child.kill("SIGTERM");
    await new Promise((done) => child.once("close", done));
  }, 60_000);
});
