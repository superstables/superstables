// The real dispatcher against loopback servers that misbehave: an RPC that sends escape sequences, a faucet that never stops,
// an RPC that answers with a web page, a seller whose 402 never ends. Nothing leaves this computer.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "budget", "cli.mjs");
const OWNER = `0x${"22".repeat(20)}`;
const AGENT = `0x${"33".repeat(20)}`;
const EVM_KEY = `0x${"11".repeat(32)}` as const;

let home: string;
const servers: Server[] = [];
const children: ChildProcess[] = [];
beforeAll(() => { home = mkdtempSync(join(tmpdir(), "superstables-read-caps-cli-")); });
afterEach(async () => {
  // a command a test gave up on (its timeout) must not go on running, with the rail it started
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.closeAllConnections(); s.close(done); })));
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

async function listen(handler: (req: { method: string; id: unknown; body: any }, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(b || "{}"); } catch { /* not JSON */ }
      res.on("error", () => {});
      handler({ method: body.method, id: body.id, body }, res);
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const answer = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/** A home with the rail's files, as setup leaves them, one per test. */
function homeWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(home, "h-"));
  for (const [rel, text] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: rel.startsWith("keys/") ? 0o600 : 0o644 });
  }
  return dir;
}

/** Run the real budget CLI. stdout is a pipe, as it is for an agent. */
function budget(dir: string, env: Record<string, string>, args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: Record<string, any> }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { detached: true, env: { ...process.env, SUPERSTABLES_HOME: dir, ...env } });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 1, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : {} });
    });
  });
}

describe("what the dispatcher prints and reads", () => {
  it("35. status --rail tempo prints an RPC's error text without escape sequences", async () => {
    const rpc = await listen(({ method, id }, res) =>
      answer(res, method === "eth_chainId"
        ? { jsonrpc: "2.0", id, result: "0xa5bf" }
        : { jsonrpc: "2.0", id, error: { code: -32000, message: "node says \u001b]0;pwned\u0007\u001b[31mRED\u001b[0m" } }));
    const dir = homeWith({
      "budget/public/tempo-moderato.env": `OWNER_ADDRESS=${OWNER}\nAGENT_ADDRESS=${AGENT}\n`,
      "keys/budget/tempo-agent.env": `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${EVM_KEY}\nAGENT_ADDRESS=${AGENT}\n`,
    });
    const r = await budget(dir, { SUPERSTABLES_TEMPO_RPC: rpc }, ["status", "--rail", "tempo"]);
    expect(r.stderr).not.toContain("\u001b");
    expect(r.stderr).not.toContain("\u0007");
    expect(r.result.state).toBe("failed");
  }, 60_000);

  it("36. setup --rail tempo --fund-only stops reading a faucet answer that never ends", async () => {
    let written = 0;
    const rpc = await listen(({ method, id }, res) => {
      if (method !== "tempo_fundAddress") return answer(res, { jsonrpc: "2.0", id, result: "0xa5bf" });
      res.writeHead(200, { "content-type": "application/json" });
      res.write(`{"jsonrpc":"2.0","id":${id},"result":["0x${"ab".repeat(32)}"],"pad":"`);
      const chunk = Buffer.alloc(1 << 20, 120);
      let n = 0;
      const more = (): void => {
        while (n < 64 && !res.destroyed) {
          n++;
          written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", more);
        }
        if (!res.destroyed) res.end('"}');
      };
      more();
    });
    const dir = homeWith({ "budget/public/tempo-moderato.env": `OWNER_ADDRESS=${OWNER}\n` });
    const r = await budget(dir, { SUPERSTABLES_TEMPO_RPC: rpc }, ["setup", "--rail", "tempo", "--fund-only"]);
    await new Promise((done) => setTimeout(done, 300));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tempo_fundAddress failed for 0x2{40}: the RPC answer was cut off or longer than 4000000 bytes/);
    expect(written).toBeLessThan(32 * (1 << 20));
  }, 60_000);

  it("37. buy --rail evm against an RPC that answers with a web page gives that as the reason, not Node's version line", async () => {
    const rpc = await listen(({ method, id }, res) => {
      res.setHeader("content-type", "application/json");
      res.end(method === "eth_chainId" ? JSON.stringify({ jsonrpc: "2.0", id, result: "0x14a34" }) : "<html>not json</html>");
    });
    const dir = homeWith({
      "keys/budget/evm-agent.env": `B4_AGENT_KEY=${EVM_KEY}\n`,
      "budget/public/evm-base-sepolia.env": `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${privateKeyToAddress(EVM_KEY)}\n`,
    });
    const r = await budget(dir, { B4_RPC: rpc }, ["buy", "--rail", "evm", "--url", "http://127.0.0.1:9/paid", "--max", "0.01", "--op", "g1"]);
    expect(r.result.reason).toMatch(/stopped before it recorded a purchase: the RPC answer is not JSON/);
    expect(r.result.reason).not.toMatch(/Node\.js/);
  }, 150_000);

  it("38. preflight --rail evm reads no more than 64 KB of a 402 body that never ends", async () => {
    const rpc = await listen(({ method, id }, res) => {
      const result = method === "eth_chainId" ? "0x14a34"
        : method === "eth_blockNumber" ? "0x1"
        : method === "eth_gasPrice" ? "0x1"
        : method === "eth_call" ? encodeAbiParameters([{ type: "string" }], ["USD Coin"])
        : "0x0";
      answer(res, { jsonrpc: "2.0", id, result });
    });
    let written = 0;
    const seller = createServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.on("error", () => {});
      const chunk = Buffer.alloc(64 * 1024, 32);
      // the body ends after 8 MB, so a reader without a cap finishes and fails on `written` below, not on a timeout
      const timer = setInterval(() => {
        if (res.destroyed) return clearInterval(timer);
        written += chunk.length;
        res.write(chunk);
        if (written >= 8 * (1 << 20)) { clearInterval(timer); res.end(); }
      }, 10);
      res.on("close", () => clearInterval(timer));
    });
    servers.push(seller);
    await new Promise<void>((ready) => seller.listen(0, "127.0.0.1", ready));
    const url = `http://127.0.0.1:${(seller.address() as AddressInfo).port}/paid`;
    const dir = homeWith({
      "keys/budget/evm-agent.env": `B4_AGENT_KEY=${EVM_KEY}\n`,
      "budget/public/evm-base-sepolia.env": `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${privateKeyToAddress(EVM_KEY)}\n`,
    });
    const r = await budget(dir, { B4_RPC: rpc }, ["preflight", "--rail", "evm", "--url", url]);
    expect(written).toBeLessThan(2 * (1 << 20));
    // the dispatcher passes a rail's log lines on to stderr; stdout carries only the RESULT
    expect(r.stderr).toContain("FAIL -- seller answers 402");
  }, 60_000);
});
