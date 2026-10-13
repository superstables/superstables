// A seller URL must be https, or http on this computer. `budget buy` and `budget preflight` refuse any other before the
// first request (exit 2, one sentence naming --url), the rail scripts say the same when run directly, and preflight
// follows no redirect: the 402 it reads is the one the seller it was pointed at gave.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { domainSeparator, encodeAbiParameters, parseAbiParameters, toHex } from "viem";
import { listenOrSkip } from "../helpers/listen-or-skip.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "budget", "cli.mjs");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const servers: Server[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-seller-url-B4-"));
});

afterEach(async () => {
  rmSync(home, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  result: Record<string, any>;
}

function run(argv: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, argv, {
      env: { ...process.env, SUPERSTABLES_HOME: home, DISPLAY: "", B4_RPC: "http://127.0.0.1:9/", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => {
      const last = stdout.trimEnd().split("\n").pop() ?? "";
      done({ code: code ?? 1, stdout, stderr, result: last.startsWith("RESULT {") ? JSON.parse(last.slice(7)) : {} });
    });
  });
}

const budget = (args: string[], env?: Record<string, string>) => run([CLI, ...args], env);

async function listen(context: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void, host = "127.0.0.1"): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  if (host === "127.0.0.1") await listenOrSkip(server, context);
  else {
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => resolveListen());
      });
    } catch {
      context.skip(`cannot listen on ${host} here`);
    }
  }
  return `http://${host}:${(server.address() as AddressInfo).port}`;
}

describe("budget buy and budget preflight, on every rail", () => {
  for (const rail of ["evm", "tempo", "solana"] as const) {
    for (const command of ["buy", "preflight"] as const) {
      it(`refuse a plain-http seller on ${rail} (${command}) before any request, exit 2`, async (context) => {
        const hits: string[] = [];
        // 127.0.0.2 is this computer's, but not one of the three names the rule accepts.
        const base = await listen(context, (req, res) => { hits.push(String(req.url)); res.writeHead(402).end(); }, "127.0.0.2");
        for (const url of [`${base}/x`, "http://example.com/x", "http://user:pw@127.0.0.1:9/x", "ftp://a.example/x"]) {
          const r = await budget([command, "--rail", rail, "--url", url, ...(command === "buy" ? ["--max", "0.01"] : [])]);
          expect(r.code, url).toBe(2);
          expect(r.result, url).toMatchObject({ ok: false, command, rail, final: true });
          expect(r.result.reason, url).toMatch(/^--url (is plain http|carries a user name or password|is not an https URL)/);
        }
        expect(hits).toEqual([]);
      });
    }
  }
});

describe("the rail scripts, run directly", () => {
  it("evm buy.ts refuses a plain-http seller (exit 2)", async () => {
    const r = await run([TSX, join(ROOT, "budget/evm/buy.ts"), "--url", "http://127.0.0.2:9/x", "--max", "0.01"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error: --url is plain http: only https is accepted/);
  });

  it("evm preflight.ts refuses a plain-http seller before it reads the chain (exit 2)", async () => {
    const r = await run([TSX, join(ROOT, "budget/evm/preflight.ts"), "--url", "http://127.0.0.2:9/x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error: --url is plain http: only https is accepted/);
    expect(r.stdout).not.toMatch(/^chain /m);
  });

  it("solana buy.mjs refuses a plain-http seller (exit 2), even with --check", async () => {
    const r = await run([join(ROOT, "budget/solana/buy.mjs"), "--check", "--url", "http://127.0.0.2:9/x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--url is plain http: only https is accepted/);
  });

  it("tempo preflight.ts and buy.ts refuse a plain-http seller (exit 2)", async () => {
    const pre = await run([TSX, join(ROOT, "budget/tempo/preflight.ts"), "--url", "http://127.0.0.2:9/x"]);
    expect(pre.code).toBe(2);
    expect(pre.stderr).toMatch(/--url: is plain http: only https is accepted/);
    const buy = await run([TSX, join(ROOT, "budget/tempo/buy.ts"), "--url", "http://127.0.0.2:9/x", "--max", "0.01"]);
    expect(buy.code).toBe(2);
    expect(buy.stderr).toMatch(/--url: is plain http: only https is accepted/);
  });
});

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x31318a21867C86E4DeF03419316D58eB635Ab0b4";

/** A node that answers what evm preflight reads about Base Sepolia's USDC, and nothing else. */
function fakeBaseSepoliaNode(req: IncomingMessage, res: ServerResponse): void {
  let raw = "";
  req.on("data", (c) => (raw += String(c)));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(raw || "{}");
    const text = (s: string) => encodeAbiParameters(parseAbiParameters("string"), [s]);
    const selectors: Record<string, string> = {
      "0x06fdde03": text("USDC"),
      "0x54fd4d50": text("2"),
      "0x313ce567": encodeAbiParameters(parseAbiParameters("uint8"), [6]),
      "0x3644e515": domainSeparator({ domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC } }),
    };
    const answers: Record<string, unknown> = {
      eth_chainId: toHex(84532),
      eth_blockNumber: toHex(1),
      eth_gasPrice: toHex(1_000_000),
      eth_call: selectors[String(params?.[0]?.data).slice(0, 10)],
    };
    const result = answers[method];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "not here" } } : { jsonrpc: "2.0", id, result }));
  });
}

const x402Header = (resource: string) => Buffer.from(JSON.stringify({
  x402Version: 2,
  resource: { url: resource },
  accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
})).toString("base64");

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tempoChallenge = `Payment id="c1", realm="seller.example", method="tempo", intent="charge", request="${b64url({ amount: "1000", currency: "0x20c0000000000000000000000000000000000000", recipient: PAY_TO, methodDetails: { chainId: 42431 } })}"`;

describe("budget preflight follows no redirect", () => {
  /** A seller that answers every request with a 302 to a loopback path that is a 402, and that path, counting what reaches it. */
  async function redirecting(context: TestContext, challenge: Record<string, string>): Promise<{ url: string; reached: string[] }> {
    const reached: string[] = [];
    const paid = await listen(context, (req, res) => { reached.push(String(req.url)); res.writeHead(402, challenge).end("{}"); });
    const url = await listen(context, (_req, res) => { res.writeHead(302, { location: `${paid}/paid` }).end(); });
    return { url: `${url}/r`, reached };
  }

  it("on evm", async (context) => {
    const node = await listen(context, fakeBaseSepoliaNode);
    const s = await redirecting(context, { "payment-required": x402Header("http://seller.example/paid") });
    const r = await budget(["preflight", "--rail", "evm", "--url", s.url], { B4_RPC: node });
    const said = r.stdout + r.stderr;
    expect(said).toMatch(/^FAIL -- GET http:\/\/127\.0\.0\.1:\d+\/r:/m);
    expect(said).not.toMatch(/HTTP 402/);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ command: "preflight", rail: "evm", state: "failed", final: true });
    expect(s.reached).toEqual([]);
  });

  it("on tempo", async (context) => {
    const s = await redirecting(context, { "www-authenticate": tempoChallenge });
    const r = await budget(["preflight", "--rail", "tempo", "--url", s.url]);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ command: "preflight", rail: "tempo", state: "failed", final: true });
    expect(r.result.reason).toMatch(/^seller unreachable/);
    expect(s.reached).toEqual([]);
  });
});
