// The seller commands as a seller meets them: the real CLI, the seller API on this machine, one exit code per case.
// The key comes from the environment and must not appear on either stream, whatever the site answers.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = resolve(ROOT, "src/cli/main.ts");
const KEY = `sssk_${"b".repeat(40)}`;
const ID = "3f1c9a2e-0000-4000-8000-000000000000";

interface Answer {
  status: number;
  body: unknown;
}

let site: string;
let server: ReturnType<typeof createServer>;
/** What the site answers: replaced by each test. */
let creditAnswer: () => Answer = () => ({ status: 500, body: {} });
let createAnswer: () => Answer = () => ({ status: 500, body: {} });
let creates = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (answer: Answer) => {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    };
    if (req.method === "POST" && req.url === "/api/v1/seller/top-ups") {
      creates += 1;
      // The body is read and discarded: the test is about what the CLI prints, not the JSON it sends.
      req.resume();
      req.on("end", () => send(createAnswer()));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/seller/top-ups") {
      req.resume();
      req.on("end", () => send(creditAnswer()));
      return;
    }
    send({ status: 404, body: { error: { code: "not_found" } } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the test server has no port");
  site = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "superstables-seller-test-"));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERSTABLES_HOME: home,
    SUPERSTABLES_SITE: site,
    SUPERSTABLES_SELLER_API_KEY: KEY,
    SUPERSTABLES_APPROVE_PORT: "0",
    SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1",
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[name];
    else childEnv[name] = value;
  }
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], { cwd: ROOT, env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => {
      rmSync(home, { recursive: true, force: true });
      done({ code: code ?? 0, stdout, stderr });
    });
  });
}

describe("superstables seller", () => {
  it("prints the balance and the top-ups it read, and never the key", async () => {
    creditAnswer = () => ({
      status: 200,
      body: {
        balance: "12.5",
        top_ups: [{ id: ID, amount: "10", status: "paid", created_at: "2026-10-20T00:00:00.000Z" }],
        entries: [{ at: "2026-10-20T00:00:00.000Z", kind: "fee", amount: "-0.40", reference: "sale-1" }],
      },
    });
    const result = await run(["seller", "credit"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("balance");
    expect(result.stdout).toContain("12.5 USDC");
    expect(result.stdout).toContain(ID);
    expect(result.stdout).toContain("Base Sepolia");
    expect(result.stdout).toContain("-0.40 USDC");
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it("prints the same as one JSON value with --json", async () => {
    creditAnswer = () => ({
      status: 200,
      body: { balance: "12.5", top_ups: [{ id: ID, amount: "10", status: "paid" }], entries: [] },
    });
    const result = await run(["seller", "credit", "--json"]);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout) as { balance: string; asset: string; top_ups: { id: string }[]; next: string };
    expect(value.balance).toBe("12.5");
    expect(value.asset).toBe("USDC");
    expect(value.top_ups[0]?.id).toBe(ID);
    expect(value.next).toBe("superstables seller top-up");
  });

  it("refuses a top-up whose pay link is another site, pays nothing and names that site", async () => {
    creates = 0;
    createAnswer = () => ({
      status: 201,
      body: {
        top_up: {
          id: ID,
          amount: "10",
          status: "open",
          pay_url: `https://evil.example/api/v1/seller/top-ups/${ID}/pay`,
        },
      },
    });
    const result = await run(["seller", "top-up", "10"]);
    expect(result.code).toBe(3);
    expect(creates).toBe(1);
    expect(result.stdout).toContain(ID);
    expect(result.stdout).toContain("evil.example");
    expect(result.stdout).toContain("Nothing was paid");
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it("checks the amount before it sends anything", async () => {
    creates = 0;
    const result = await run(["seller", "top-up", "0.5"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("smallest top-up is 1 USDC");
    expect(creates).toBe(0);
  });

  it("says which environment variable holds the key when there is none", async () => {
    const result = await run(["seller", "credit"], { SUPERSTABLES_SELLER_API_KEY: undefined });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("SUPERSTABLES_SELLER_API_KEY");
  });
});
