// The CLI as a user meets it: a real process, real arguments, real exit codes. Spawning is
// slower than calling the functions directly, and it is the point — a CLI that typechecks but
// crashes on start, writes its key world-readable or hangs on a network call is broken, and
// only running it says so.
//
// Nothing here touches the network: SUPERSTABLES_DOCTOR_OFFLINE=1 makes doctor skip the remote
// checks, and the wallet URL points at a port nothing is listening on.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = resolve(ROOT, "src/cli/main.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-cli-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        SUPERSTABLES_HOME: home,
        SUPERSTABLES_DOCTOR_OFFLINE: "1",
        SUPERSTABLES_APPROVE_PORT: "0",
        // Nothing listens here, so "is the wallet running?" has one deterministic answer.
        SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}

describe("the superstables CLI", () => {
  it("prints the version of the build that is running", async () => {
    // The shortest answer to "which build is this?", and the one a person reaches for after
    // installing over an older copy.
    const result = await run(["--version"]);
    expect(result.code).toBe(0);
    const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
    expect(result.stdout.trim()).toBe(version);
  });

  it("prints its own help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    for (const command of ["setup", "wallet", "mcp", "find", "quote", "pay", "doctor", "policy"]) {
      expect(result.stdout).toContain(command);
    }
    // The one sentence a reader must not miss.
    expect(result.stdout).toContain("no real money moves");
  });

  it("writes a policy file and reads it back", async () => {
    const written = await run(["policy", "init"]);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain("policy.yaml");

    const shown = await run(["policy", "show"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("per_call");
    expect(shown.stdout).toContain("up to 0.05 USDC per payment");

    // A second init must not quietly replace the owner's own caps.
    const again = await run(["policy", "init"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("--force");
  });

  it("creates a wallet key only its owner can read", async () => {
    const result = await run(["wallet", "init"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/0x[0-9a-fA-F]{40}/);
    expect(result.stdout).toContain("faucet.circle.com");

    const key = statSync(join(home, "wallet", "key"));
    expect(key.mode & 0o777).toBe(0o600);

    const address = await run(["wallet", "address"]);
    expect(address.code).toBe(0);
    expect(address.stdout.trim()).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // The same key twice would be a silently lost wallet.
    const twice = await run(["wallet", "init"]);
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("--force");
  });

  it("diagnoses a machine with no key and no wallet, without touching the network", async () => {
    const empty = await run(["--wallet", "local", "doctor", "--json"]);
    expect(empty.code).toBe(1);
    const report = JSON.parse(empty.stdout) as {
      ok: boolean;
      offline: boolean;
      mode: string;
      checks: { name: string; ok: boolean; essential: boolean; skipped?: boolean; detail: string }[];
    };
    expect(report.offline).toBe(true);
    expect(report.mode).toBe("local");
    expect(report.ok).toBe(false);
    const by = (name: string) => report.checks.find((check) => check.name === name);
    expect(by("home directory")?.ok).toBe(true);
    expect(by("spend policy")?.ok).toBe(true);
    expect(by("wallet key")?.ok).toBe(false);
    expect(by("wallet")?.ok).toBe(false);
    expect(by("Superstables index")?.skipped).toBe(true);
    expect(by("demo service")?.detail).toContain("SUPERSTABLES_DOCTOR_OFFLINE");
  });

  it("reports a set-up machine as healthy apart from the wallet not running", async () => {
    expect((await run(["--wallet", "local", "setup"])).code).toBe(0);

    const result = await run(["--wallet", "local", "doctor"]);
    expect(result.code).toBe(0);
    // Which build, and which directory, before any check: a report without them cannot be read.
    const { version } = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
    const [first, second] = result.stdout.split("\n");
    expect(first).toContain("client version");
    expect(first).toContain(version);
    expect(second).toContain("home");
    expect(second).toContain(home);
    expect(result.stdout).toContain("✓ wallet key");
    expect(result.stdout).toContain("✗ wallet");
    expect(result.stdout).toContain("superstables wallet serve");
    expect(result.stdout).toContain("Everything this machine needs is in place.");
  });

  it("needs no key and no wallet process in browser mode, and says so", async () => {
    // The default: the person runs nothing of their own, and MetaMask holds the key.
    const setUp = await run(["setup"]);
    expect(setUp.code).toBe(0);
    expect(setUp.stdout).toContain("https://metamask.io/download");
    expect(setUp.stdout).toContain("--wallet local");
    expect(setUp.stdout).not.toContain("superstables wallet serve");

    const result = await run(["doctor", "--json"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      mode: string;
      version: string;
      home: string;
      checks: { name: string; ok: boolean; detail: string }[];
    };
    expect(report.mode).toBe("browser");
    expect(report.ok).toBe(true);
    expect(report.home).toBe(home);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    const by = (name: string) => report.checks.find((check) => check.name === name);
    expect(by("wallet key")).toBeUndefined();
    expect(by("browser wallet")?.detail).toContain("MetaMask connects when the first approval link opens");
    expect(by("approval page")?.ok).toBe(true);
    expect(by("approval page")?.detail).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d* is free;/);
  });

  it("reports an explicitly occupied approval port as unhealthy", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a TCP address");
      const result = await run(["--wallet", "browser", "doctor", "--json"], {
        SUPERSTABLES_APPROVE_PORT: String(address.port),
      });
      expect(result.code, result.stdout + result.stderr).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "approval page",
            ok: false,
            essential: true,
            detail: expect.stringContaining(`port ${address.port} is taken (listen EADDRINUSE:`),
          }),
        ]),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a quote that names both a URL and a service", async () => {
    const result = await run(["quote", "https://example.test/paid", "--service", "whatever"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not both and not neither");
  });
});
