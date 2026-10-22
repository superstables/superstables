// The page a real grant opens, read while the command waits: the facts a rail script hands the page. The real dispatcher and the
// rail script against a fake chain on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { evmOwner, evmOwnerKey, startFakeRpc } from "../helpers/fake-site.js";
import type { TestServer } from "../helpers/servers.js";

const ownerKey = evmOwnerKey("22");
const owner = evmOwner("22");
const agent = privateKeyToAddress(evmOwnerKey("44"));

let home: string;
let rpc: TestServer;
let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-page-facts-"));
  rpc = await startFakeRpc(84532);
});
afterEach(async () => {
  await stopApprovals(home);
  await rpc.close();
  rmSync(home, { recursive: true, force: true });
});

const validGroup = (g: unknown): g is number => Number.isInteger(g) && (g as number) > 1;

/**
 * Stops what the grants left behind. The test kills the command after it reads the page; the background worker it started
 * (its own process group, named in the approval record) and the rail script under it keep running until their timeout.
 * Each group is stopped with the product's stopGroup, which signals it only while its leader still has the start identity the
 * record names, so a record that is missing it, or whose number another process now holds, signals nothing.
 * The worker goes first so it cannot start a rail script after the record is read; the rail group is read after that.
 */
async function stopApprovals(forHome: string) {
  const { stopGroup, groupAlive } = await import("../../budget/approvals.mjs");
  const dir = join(forHome, "budget", "approvals");
  const records = (): any[] => { try { return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => { try { return [JSON.parse(readFileSync(join(dir, f), "utf8"))]; } catch { return []; } }); } catch { return []; } };
  const worker = (r: any) => ({ start: r.pidStart, startUtc: r.pidStartUtc, location: { ...r, createdAt: r.foreground ? r.createdAt : undefined } });
  const rail = (r: any) => ({ start: r.railPgidStart, startUtc: r.railPgidStartUtc, location: { ...r, selfStartedAt: r.railSelfStartedAt, namespace: "railNamespace" in r ? r.railNamespace : r.namespace, writtenAt: r.railWrittenAt, bootElapsedMs: r.railBootElapsedMs, createdAt: undefined } });
  for (const r of records()) if (validGroup(r.pid)) await stopGroup(r.pid, worker(r));
  for (const r of records()) if (validGroup(r.railPgid)) await stopGroup(r.railPgid, rail(r));
  // nothing of these may be left in any group the records name
  for (let i = 0; i < 50 && records().some((r) => (validGroup(r.pid) && groupAlive(r.pid, r.pidStart, r.pidStartUtc, worker(r).location)) || (validGroup(r.railPgid) && groupAlive(r.railPgid, r.railPgidStart, r.railPgidStartUtc, rail(r).location))); i++) await new Promise((x) => setTimeout(x, 100));
}

const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text, { mode }); };

/** Runs a budget command and returns what stdout said, plus the page its APPROVE line named (read while the command waits). */
function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; page: string }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc.url };
    delete env.SUPERSTABLES_SITE;
    tree.set({ "base-sepolia": [{ url: rpc.url, operator: "fake-a" }, { url: `${rpc.url}/`, operator: "fake-b" }] });
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
    let stdout = "";
    let stderr = "";
    let page: Promise<string> = Promise.resolve("");
    let seen = false;
    child.stdout.on("data", (c) => {
      stdout += String(c);
      const m = !seen ? stdout.match(/^APPROVE (\{.*\})$/m) : null;
      if (m) {
        seen = true;
        page = fetch(JSON.parse(m[1]).url as string).then((r) => r.text());
        setTimeout(() => child.kill("SIGKILL"), 300);
      }
    });
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", async (code) => done({ code: code ?? 0, stdout, stderr, page: await page.catch(() => "") }));
  });
}
const rowOf = (html: string, label: string) => {
  const m = html.match(new RegExp(`<dt[^>]*>${label}</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`));
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : undefined;
};

describe("a grant's owner page", () => {
  it("states the network, the RPC and its source, the page's own address, the agent binding and what the wallet will show", async () => {
    const setup = await budget(["setup", "--rail", "evm", "--owner-key-file", (() => { const p = join(home, "owner.env"); write(p, `B4_OWNER_KEY=${ownerKey}\n`); return p; })()]);
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "30"]);
    expect(out.page, out.stdout + out.stderr).toContain("What your wallet will show");
    expect(rowOf(out.page, "Network")).toBe("Base Sepolia (chain id 84532)");
    expect(rowOf(out.page, "RPC the command reads")).toMatch(/^127\.0\.0\.1:\d+ \(.+\)$/);
    expect(rowOf(out.page, "This page")).toMatch(/^http:\/\/127\.0\.0\.1:\d+, served by the command on this machine \(not superstables\.com\)$/);
    expect(rowOf(out.page, "Agent binding")).toBe("signed by you at setup");
    const setUp = readFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), "utf8").match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];
    expect(out.page).toContain(`approve(spender ${setUp}, amount 10000): 0.01 USDC`);
    expect(out.page).toContain('"token":{"address":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","symbol":"USDC","decimals":6}');
    // the APPROVE line itself is unchanged: no wallet block or page fact travels in it
    expect(out.stdout).not.toContain("walletShows");
  }, 90_000);

  it("a public file from before the signature was kept: the page warns in amber", async () => {
    write(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${evmOwnerKey("44")}\nB4_AGENT_ADDRESS=${agent}\n`);
    write(join(home, "budget", "public", "evm-base-sepolia.env"), `# Base Sepolia public state\nB4_OWNER_ADDRESS=${owner}\nB4_AGENT_ADDRESS=${agent}\n`, 0o644);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "30"]);
    expect(rowOf(out.page, "Agent binding"), out.stdout + out.stderr).toContain("not signed at setup");
    expect(rowOf(out.page, "Agent binding")).toContain("recorded by an older version, without your signature");
    expect(out.page).toContain('<span class="tag warn">not signed at setup</span>');
  }, 60_000);

  it("a binding that does not match opens no page and prints no APPROVE line", async () => {
    write(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${evmOwnerKey("44")}\nB4_AGENT_ADDRESS=${agent}\n`);
    write(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${owner}\nB4_AGENT_ADDRESS=${evmOwner("55")}\n`, 0o644);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    expect(out.stdout).not.toMatch(/^APPROVE /m);
    expect(out.page).toBe("");
    expect(out.code).toBe(3);
  }, 60_000);
});
