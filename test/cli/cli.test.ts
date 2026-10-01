// The CLI as a user meets it: a real process, real arguments, real exit codes. Spawning is
// slower than calling the functions directly, and it is the point — a CLI that typechecks but
// crashes on start, writes its key world-readable or hangs on a network call is broken, and
// only running it says so.
//
// Nothing here touches the network: SUPERSTABLES_DOCTOR_OFFLINE=1 makes doctor skip the remote
// checks, and the wallet URL points at a port nothing is listening on.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sendJson, startFacilitator, startPaidEndpoint, startServer, type TestServer } from "../helpers/servers.js";

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
    expect(result.code).toBe(0);
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
  });

  it("refuses a quote that names both a URL and a service, as bad input", async () => {
    const result = await run(["quote", "https://example.test/paid", "--service", "whatever"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not both and not neither");
  });

  it("exits 2 on an unknown flag, and answers --json errors with one JSON object", async () => {
    const flag = await run(["find", "--no-such-flag"]);
    expect(flag.code).toBe(2);
    expect(flag.stderr).toContain("--help");

    const missing = await run(["status", "no-such-attempt", "--json"]);
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout)).toEqual({
      error: expect.stringContaining("superstables attempts"),
      exit_code: 2,
    });
  });

  it("prints empty receipts and attempts as JSON arrays", async () => {
    for (const command of ["receipts", "attempts"]) {
      const result = await run([command, "--json"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
    }
  });
});

// ── Help: enough to use the CLI with nothing else ───────────────────────────────────────

const COMMANDS = [
  ["setup"],
  ["wallet"],
  ["wallet", "init"],
  ["wallet", "serve"],
  ["wallet", "status"],
  ["wallet", "address"],
  ["mcp"],
  ["find"],
  ["quote"],
  ["pay"],
  ["status"],
  ["receipts"],
  ["attempts"],
  ["demo-service"],
  ["doctor"],
  ["policy"],
  ["policy", "show"],
  ["policy", "init"],
];

describe("the help", () => {
  it("says, for every command, whether it moves money, who runs it, an example and its exit codes", async () => {
    const results = await Promise.all(COMMANDS.map((command) => run([...command, "--help"])));
    results.forEach((result, index) => {
      const name = COMMANDS[index].join(" ");
      expect(result.code, name).toBe(0);
      for (const section of ["Moves money:", "Run by:", "Example:", "Prints:", "Exit codes:"]) {
        expect(result.stdout, `${name} --help lacks ${section}`).toContain(section);
      }
      expect(result.stdout, name).toMatch(/^ {2}\$ \S/m);
    });
  }, 90_000);

  it("explains the two ways to pay, where to start each, the environment and the exit codes", async () => {
    const { stdout, code } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("no real money moves");
    expect(stdout).toContain("Two ways to pay");
    expect(stdout).toContain("superstables budget setup --rail evm");
    expect(stdout).toContain("`superstables setup` is for pay only");
    for (const sub of ["setup", "fund-agent", "doctor", "preflight", "status", "grant", "buy", "reconcile", "revoke", "recover", "wait"]) {
      expect(stdout).toMatch(new RegExp(`^ {4}${sub} `, "m"));
    }
    for (const env of [
      "SUPERSTABLES_HOME",
      "SUPERSTABLES_WALLET",
      "SUPERSTABLES_INDEX_URL",
      "SUPERSTABLES_CATALOGUE_URL",
      "SUPERSTABLES_DEMO_SERVICES",
      "SUPERSTABLES_RPC_URL",
    ]) {
      expect(stdout).toContain(env);
    }
    expect(stdout).toContain("https://www.superstables.com/api/v1/services");
    for (const exit of ["0  done", "1  failed", "2  bad input", "3  refused", "4  paid, not delivered", "5  unknown"]) {
      expect(stdout).toContain(exit);
    }
  }, 90_000);

  it("tells pay's reader how long it waits, how long the page lives, where the answer is and how to retry", async () => {
    const stdout = (await run(["pay", "--help"])).stdout.replace(/\s+/g, " ");
    expect(stdout).toContain("the browser page gives the owner 5 minutes");
    expect(stdout).toContain("the page works only while this command runs");
    expect(stdout).toContain("service_response");
    expect(stdout).toContain("take a new quote");
    expect(stdout).toContain("abandoned");
    expect(stdout).not.toMatch(/\.mcpb|Claude Desktop/);
  }, 90_000);
});

// ── Paying from the CLI, against a local seller ─────────────────────────────────────────

describe("quote, pay and status against a local seller", () => {
  const servers: TestServer[] = [];
  let url = "";

  beforeAll(async () => {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    servers.push(facilitator, seller);
    url = `${seller.url}/v1/market?asset=BTC`;
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  // Browser mode on a free port, so nothing here collides with a real approval page.
  const env = { SUPERSTABLES_APPROVE_PORT: "0" };

  it("shows each policy rule a quote was checked against, and exits 3 when the policy refuses", async () => {
    const allowed = await run(["quote", url, "--json"], env);
    expect(allowed.code).toBe(0);
    const quote = JSON.parse(allowed.stdout) as { id: string; policy: { allowed: boolean; checks: { rule: string; ok: boolean }[] }; next: string };
    expect(quote.policy.allowed).toBe(true);
    expect(quote.policy.checks.map((c) => c.rule)).toContain("caps.per_call");
    expect(quote.next).toBe(`superstables pay ${quote.id}`);

    const text = await run(["quote", url], env);
    expect(text.stdout).toMatch(/caps\.per_call\s+0\.01 USDC, at most 0\.05 USDC/);

    const policyFile = join(home, "tight.yaml");
    writeFileSync(policyFile, "caps:\n  per_call: 0.001 USDC\n");
    const refused = await run(["quote", url], { ...env, SUPERSTABLES_POLICY: policyFile });
    expect(refused.code).toBe(3);
    expect(refused.stdout).toMatch(/REFUSED\s+caps\.per_call/);
    expect(refused.stdout).toContain("superstables policy show");
  }, 90_000);

  it("ends a payment nobody decided on as abandoned, never as rejected, and says what to run next", async () => {
    const quote = JSON.parse((await run(["quote", url, "--json"], env)).stdout) as { id: string };

    const paid = await run(["pay", quote.id, "--wait", "1", "--json"], env);
    expect(paid.code).toBe(1);
    const outcome = JSON.parse(paid.stdout) as Record<string, unknown>;
    expect(outcome).toMatchObject({ quote_id: quote.id, state: "abandoned", final: true, exit_code: 1 });
    expect(outcome.message).toContain("This is not a rejection");
    expect(String(outcome.message)).not.toMatch(/owner rejected/i);
    expect(outcome.next).toContain(`superstables quote '${url}'`);
    expect(outcome.approval_url).toBeUndefined();
    // Progress and the link went to stderr, the link exactly once.
    const links = paid.stderr.match(/http:\/\/127\.0\.0\.1:\d+\/approve\/[0-9a-f]+/g) ?? [];
    expect(links).toHaveLength(1);
    expect(paid.stderr).not.toContain("payment_status");

    const status = await run(["status", String(outcome.attempt_id)], env);
    expect(status.code).toBe(1);
    expect(status.stdout).toContain("abandoned");
    expect(status.stdout).not.toMatch(/owner rejected/i);
    expect(status.stdout).toContain("Next: To ask again, take a new quote");

    const statusJson = JSON.parse((await run(["status", String(outcome.attempt_id), "--json"], env)).stdout) as Record<string, unknown>;
    expect(statusJson.state).toBe("abandoned");
    expect(Object.keys(statusJson).sort()).toEqual(Object.keys(outcome).sort());

    // The quote is spent: paying it again is bad input, and the error names the payment that
    // exists, how to look it up, and the command to requote.
    const again = await run(["pay", quote.id], env);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain(`A payment for this quote already exists: attempt ${String(outcome.attempt_id)}, abandoned.`);
    expect(again.stderr).toContain(`\`superstables status ${String(outcome.attempt_id)}\` shows how it ended`);
    expect(again.stderr).toContain("superstables quote");

    const attempts = JSON.parse((await run(["attempts", "--json"], env)).stdout) as { state: string }[];
    expect(attempts[0]?.state).toBe("abandoned");
  }, 90_000);

  it("prints the approval link once in text mode", async () => {
    const quote = JSON.parse((await run(["quote", url, "--json"], env)).stdout) as { id: string };
    const paid = await run(["pay", quote.id, "--wait", "1"], env);
    expect(paid.code).toBe(1);
    const links = paid.stdout.match(/http:\/\/127\.0\.0\.1:\d+\/approve\/[0-9a-f]+/g) ?? [];
    expect(links).toHaveLength(1);
    expect(paid.stdout).toContain("Nobody decided");
  }, 90_000);

  it("fails at once on a chosen approval port that is busy, says not to stop what holds it, and keeps the quote", async () => {
    // Something already serving on the chosen port, as another waiting `pay` would be.
    const holder = createServer();
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done));
    const address = holder.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const quote = JSON.parse((await run(["quote", url, "--json"], env)).stdout) as { id: string };
      const busy = await run(["pay", quote.id, "--json"], { SUPERSTABLES_APPROVE_PORT: String(port) });
      expect(busy.code).toBe(1);
      const outcome = JSON.parse(busy.stdout) as Record<string, unknown>;
      expect(outcome).toMatchObject({ state: "failed", refusal: "approval_page", final: true });
      expect(String(outcome.reason)).toContain(`port ${port} on 127.0.0.1 is already in use`);
      expect(String(outcome.reason)).toContain("do not stop it");
      expect(String(outcome.next)).toContain(`superstables pay ${quote.id}`);
      expect(busy.stderr).not.toMatch(/approve\/[0-9a-f]+/);

      // The same quote pays once the port is left to pay: a link, then --wait ends it.
      const again = await run(["pay", quote.id, "--wait", "1", "--json"], env);
      expect(again.code).toBe(1);
      expect(again.stderr).toMatch(/http:\/\/127\.0\.0\.1:\d+\/approve\/[0-9a-f]+/);
      const waited = JSON.parse(again.stdout) as Record<string, unknown>;
      expect(waited).toMatchObject({ quote_id: quote.id, state: "abandoned", abandoned_by: "wait" });
      expect(String(waited.reason)).toContain("--wait 1 s");
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  }, 90_000);

  it("records a pay stopped by a signal as stopped by its process, not by the owner", async () => {
    const quote = JSON.parse((await run(["quote", url, "--json"], env)).stdout) as { id: string };
    const child = spawn(process.execPath, [TSX, CLI, "pay", quote.id, "--json"], {
      cwd: ROOT,
      env: {
        ...process.env,
        SUPERSTABLES_HOME: home,
        SUPERSTABLES_DOCTOR_OFFLINE: "1",
        SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    const closed = new Promise<number>((done) => child.once("close", (code) => done(code ?? 0)));
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no link: ${stderr}`)), 60_000);
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (/approve\/[0-9a-f]+/.test(stderr)) {
          clearTimeout(timer);
          done();
        }
      });
    });
    // While it waits, a second pay of the same quote points at the one that is waiting.
    const attemptId = /\(attempt ([0-9a-f-]+)\)/.exec(stderr)?.[1];
    expect(attemptId).toBeDefined();
    const second = await run(["pay", quote.id, "--json"], env);
    expect(second.code).toBe(2);
    expect(second.stderr + second.stdout).toContain(
      `A payment for this quote already exists: attempt ${String(attemptId)}, awaiting_approval (not final).`,
    );
    expect(second.stderr + second.stdout).toContain(`Follow that one: \`superstables status ${String(attemptId)}\`.`);
    expect(second.stderr + second.stdout).not.toContain("superstables quote");

    child.kill("SIGTERM");
    expect(await closed).toBe(1);

    const outcome = JSON.parse(stdout) as Record<string, unknown>;
    expect(outcome).toMatchObject({ state: "abandoned", abandoned_by: "stopped" });
    expect(String(outcome.reason)).toContain("process was stopped (SIGTERM) before the owner decided");
    expect(String(outcome.message)).not.toMatch(/owner rejected/i);
    expect(String(outcome.next)).toContain("leave pay running until it ends");
  }, 90_000);
});

// ── find: the commands for each listing fit the ways it can be paid ──────────────────

describe("find against a local index", () => {
  let index: TestServer;
  const rows = [
    { id: "sats.example", name: "Satellites", endpoint: "https://sats.example/api", rails: ["x402"], chains: ["base-sepolia"], live: true },
    { id: "arc.example", name: "Arc weather", endpoint: "https://arc.example/weather", rails: ["x402"], chains: ["arc-testnet"], live: true },
    { id: "tempo.example", name: "Tempo news", endpoint: "https://tempo.example/news", rails: ["mpp"], chains: ["tempo-moderato"], live: true },
    { id: "main.example", name: "Mainnet only", endpoint: "https://main.example/x", rails: ["x402"], chains: ["base", "solana"], live: true },
  ];

  // A prepared demo listing in a local hosted catalogue: the seller says its output is simulated.
  const catalogueRows = () => [
    {
      id: "briefing.example",
      name: "Sample briefing",
      description: "A briefing on a sample wallet. Simulated service output.",
      endpoint: `${index.url}/paid/briefing`,
      method: "GET",
      params: [],
      payment: { rail: "x402", scheme: "exact", network: "eip155:84532", asset: "USDC", price: { amountDecimal: 0.003, asset: "USDC", display: "0.003 USDC per request" } },
      testnet: true,
      mock: true,
    },
  ];

  beforeAll(async () => {
    index = await startServer((req, res) => {
      if (req.url?.startsWith("/catalogue")) return sendJson(res, 200, { services: catalogueRows() });
      if (req.url?.startsWith("/paid/")) return sendJson(res, 402, {});
      return sendJson(res, 200, { services: rows });
    });
  });

  afterAll(async () => {
    await index.close();
  });

  // A query no built-in listing matches, so only the index rows come back and nothing is probed.
  const find = (...args: string[]) =>
    run(["find", "zzqx", ...args], { SUPERSTABLES_INDEX_URL: `${index.url}/api/v1/services`, SUPERSTABLES_DEMO_SERVICES: "off" });

  it("prints budget commands for budget-only listings, and both ways for one pay can also take", async () => {
    const { code, stdout } = await find("--budget");
    expect(code).toBe(0);
    const section = (id: string) => stdout.split(`\n  ${id}\n`)[1]?.split(/\n(?: {2})?\S/)[0] ?? "";

    const sats = section("sats.example");
    expect(sats.indexOf("with pay")).toBeGreaterThanOrEqual(0);
    expect(sats.indexOf("with pay")).toBeLessThan(sats.indexOf("with a budget, evm on base-sepolia"));
    expect(sats).toContain("superstables quote 'https://sats.example/api?<parameters>'");
    expect(sats).toContain("superstables budget preflight --rail evm --chain base-sepolia --url 'https://sats.example/api?<parameters>'");

    const arc = section("arc.example");
    expect(arc).not.toContain("quote");
    expect(arc).toContain("superstables budget preflight --rail evm --chain arc-testnet");
    expect(arc).toContain("--max <ceiling> --pay-to <payTo> --op <new id>");

    const tempo = section("tempo.example");
    expect(tempo).not.toContain("budget preflight");
    expect(tempo).toContain("superstables budget buy --rail tempo --chain moderato --url 'https://tempo.example/news?<parameters>' --max <ceiling>");

    expect(stdout).not.toContain("main.example");
  });

  it("always says whether a listing is simulated: yes, no, or not said, in the table and in --json", async () => {
    const env = {
      SUPERSTABLES_INDEX_URL: `${index.url}/api/v1/services`,
      SUPERSTABLES_CATALOGUE_URL: `${index.url}/catalogue`,
    };
    const table = await run(["find", "briefing", "--demo", "--all"], env);
    expect(table.code).toBe(0);
    const lines = table.stdout.split("\n");
    expect(lines[0]).toMatch(/\blive\s+simulated\s*$/);
    expect(lines.find((l) => l.startsWith("briefing.example"))).toMatch(/\byes\s*$/);
    expect(lines.find((l) => l.startsWith("sats.example"))).toMatch(/\bnot said\s*$/);

    const { services } = JSON.parse((await run(["find", "briefing", "--demo", "--all", "--json"], env)).stdout) as {
      services: { id: string; mock: boolean | null }[];
    };
    expect(services.find((s) => s.id === "briefing.example")?.mock).toBe(true);
    expect(services.find((s) => s.id === "sats.example")?.mock).toBeNull();

    // The built-in demo service returns live prices: it says so with mock false.
    const builtIn = JSON.parse((await run(["find", "btc", "--json"], { SUPERSTABLES_INDEX_URL: "off", SUPERSTABLES_DEMO_SERVICES: "off", SUPERSTABLES_DEMO_SERVICE_URL: `${index.url}/paid/market` })).stdout) as {
      services: { id: string; mock: boolean | null }[];
    };
    expect(builtIn.services.find((s) => s.id === "superstables-demo-market-data")?.mock).toBe(false);
  });

  it("gives each service commands and next in --json, and none for a mainnet listing", async () => {
    const { code, stdout } = await find("--all", "--json");
    expect(code).toBe(0);
    const { services } = JSON.parse(stdout) as {
      services: { id: string; next: string | null; commands: { way: string; rail?: string; chain?: string; run: string[] }[] }[];
    };
    const by = (id: string) => services.find((s) => s.id === id);
    expect(by("sats.example")?.commands.map((c) => c.way)).toEqual(["pay", "budget"]);
    expect(by("sats.example")?.next).toBe("superstables quote 'https://sats.example/api?<parameters>'");
    expect(by("arc.example")?.commands).toEqual([
      expect.objectContaining({
        way: "budget",
        rail: "evm",
        chain: "arc-testnet",
        run: [expect.stringContaining("budget preflight"), expect.stringContaining("budget buy")],
      }),
    ]);
    expect(by("arc.example")?.next).toMatch(/^superstables budget preflight --rail evm --chain arc-testnet /);
    expect(by("tempo.example")?.next).toMatch(/^superstables budget buy --rail tempo --chain moderato /);
    expect(by("main.example")?.commands).toEqual([]);
    expect(by("main.example")?.next).toBeNull();
  });
});

