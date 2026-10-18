// The approval site is the owner's setting (src/core/owner-settings.js), not the agent's environment: the real dispatcher
// (budget/cli.mjs) against fake sites on 127.0.0.1, with the owner's settings made per case. No network, no key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { evmOwner, startFakeRpc, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import { startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";
import { DEV_SETTINGS, accountHomeWith } from "../helpers/owner-settings.js";
import type { TestServer } from "../helpers/servers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
// a grant is asked for only when the endpoints agree, at a final block, that the allowance is 0: a copy names the fake twice
let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
const OWNER = evmOwner("22");

let home: string;
let site: FakeSite;
let purchases: FakePurchaseSite;
let rpc: TestServer;
const accounts: string[] = [];
const loopbackRpc = new Set<string>();
const account = (settings: object | null, opts?: { raw?: string }) => {
  const a = accountHomeWith(settings, opts);
  accounts.push(a);
  if ((settings as any)?.rpcEnv?.allowLoopback) loopbackRpc.add(a);
  return a;
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-site-anchor-"));
  site = await startFakeSite();
  purchases = await startFakePurchaseSite();
  rpc = await startFakeRpc(84532);
});
/** Ends the approval waiters a case left in the background (a hosted setup returns while its waiter keeps running). Linux only. */
function stopWaiters(forHome: string) {
  if (process.platform !== "linux") return;
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`SUPERSTABLES_HOME=${forHome}`)) process.kill(Number(pid), "SIGKILL");
    } catch { /* gone, or not ours */ }
  }
}
afterEach(async () => {
  stopWaiters(home);
  await site.close();
  await purchases.close();
  await rpc.close();
  rmSync(home, { recursive: true, force: true });
  for (const a of accounts.splice(0)) rmSync(a, { recursive: true, force: true });
});

type Run = { code: number; stdout: string; stderr: string; result: any; approve: any };
function budget(args: string[], acct: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_TEST_ACCOUNT_HOME: acct, B4_RPC: loopbackRpc.has(acct) ? rpc.url : "" };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_ALLOW_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    Object.assign(env, extraEnv);
      tree.set({ "base-sepolia": [{ url: rpc.url, operator: "fake-a" }, { url: `${rpc.url}/`, operator: "fake-b" }] });
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = (p: string) => stdout.split("\n").reverse().find((l) => l.startsWith(p));
      const parse = (p: string) => { const l = line(p); return l ? JSON.parse(l.slice(p.length)) : null; };
      done({ code: code ?? 0, stdout, stderr, result: parse("RESULT "), approve: parse("APPROVE ") });
    });
  });
}
const hostedChain = (siteUrl: string) => {
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\nB4_AGENT_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n`, { mode: 0o600 });
  writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\nAPPROVALS=hosted\nSITE=${siteUrl}\n`);
};
/** The owner's RPC is the fake chain (so reads work offline), and nothing on this computer is allowed as a site. */
const strict = () => account({ version: 1, rpc: { "base-sepolia": { urls: [rpc.url], ownNode: true } } });
const BUY = ["buy-once", "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01", "--detach"];

describe("setup --hosted: the site", () => {
  it("staging needs allowStaging", async () => {
    const args = ["setup", "--rail", "evm", "--hosted", "--site", "https://staging.superstables.com"];
    const r = await budget(args, account(null));
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/^--site: https:\/\/staging\.superstables\.com is not an approval site the owner allows/);
    expect(r.result.reason).toContain("superstables owner settings allow-staging on");
    const ok = await budget(args, account({ version: 1, site: { allowStaging: true } }));
    expect(ok.result?.reason ?? "").not.toMatch(/approval site the owner allows/);
  }, 60_000);

  it("SUPERSTABLES_SITE on this computer needs allowLoopback, and the site gets no request", async () => {
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--no-open"], account(null), { SUPERSTABLES_SITE: site.url });
    expect(r.code).toBe(2);
    expect(r.result.reason).toContain(`SUPERSTABLES_SITE: ${site.url} is not an approval site the owner allows`);
    expect(r.result.reason).toContain("superstables owner settings allow-loopback site on");
    expect(site.requests).toEqual([]);
    expect(site.posts).toEqual([]);
    const ok = await budget(["setup", "--rail", "evm", "--hosted", "--no-open"], account(DEV_SETTINGS), { SUPERSTABLES_SITE: site.url });
    expect(ok.result.state).toBe("waiting_owner");
  }, 60_000);

  it("SUPERSTABLES_ALLOW_SITE allows nothing, and says it is no longer read", async () => {
    const r = await budget(["setup", "--rail", "evm", "--hosted"], account(null), { SUPERSTABLES_ALLOW_SITE: "https://evil.example", SUPERSTABLES_SITE: "https://evil.example" });
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/SUPERSTABLES_SITE: https:\/\/evil\.example is not an approval site the owner allows/);
    expect(r.stderr).toContain("SUPERSTABLES_ALLOW_SITE is no longer read");
  }, 60_000);

  it("the apex is production; the apex on another port is not", async () => {
    const a = account(null);
    const ok = await budget(["setup", "--rail", "evm", "--hosted", "--site", "https://superstables.com"], a);
    expect(ok.result?.reason ?? "").not.toMatch(/approval site the owner allows/);
    const bad = await budget(["setup", "--rail", "evm", "--hosted", "--site", "https://superstables.com:8443"], a);
    expect(bad.code).toBe(2);
    expect(bad.result.reason).toMatch(/is not an approval site the owner allows/);
  }, 60_000);

  it("find reads from staging without a setting", async () => {
    const r = await budget(["find", "--site", "https://staging.superstables.com"], account(null));
    expect(r.result?.reason ?? r.stderr).not.toMatch(/not an approval site the owner allows/);
  }, 60_000);
});

describe("buy-once", () => {
  it("SUPERSTABLES_SITE on this computer is refused unless the owner allows it, and the site is never asked", async () => {
    const r = await budget(BUY, account(null), { SUPERSTABLES_SITE: purchases.url });
    expect(r.code).toBe(2);
    expect(r.result.reason).toContain(`SUPERSTABLES_SITE: ${purchases.url} is not an approval site the owner allows`);
    expect(purchases.purchases).toEqual([]);
  }, 60_000);

  it("allowed: the owner is told the link is on this computer", async () => {
    const r = await budget(BUY, account(DEV_SETTINGS), { SUPERSTABLES_SITE: purchases.url });
    expect(r.result.state).toBe("waiting_owner");
    expect(purchases.purchases.length).toBe(1);
    const host = new URL(purchases.url).host;
    expect(JSON.stringify(r.result)).toContain(`This approval link is on ${host}, a site on this computer, not www.superstables.com.`);
  }, 60_000);
});

describe("a recorded site", () => {
  it("a hostile public file naming this computer: grant is refused, nothing reaches the site", async () => {
    hostedChain(site.url);
    const r = await budget(["grant", "--rail", "evm", "--amount", "1", "--no-open"], strict());
    expect(r.code, r.stdout + r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(/the recorded site is not usable/);
    expect(r.result.reason).toContain("superstables owner settings allow-loopback site on");
    expect(site.requests).toEqual([]);
    // allowed: the site is asked (it acts for another owner, so the command stops right after the request)
    site.owner = evmOwner("33");
    const ok = await budget(["grant", "--rail", "evm", "--amount", "1", "--wait", "--no-open"], account(DEV_SETTINGS));
    expect(ok.result.reason ?? "").not.toMatch(/recorded site is not usable/);
    expect(site.requests.length).toBe(1);
  }, 120_000);

  it("revoke is never blocked: it asks on the page on this computer", async () => {
    hostedChain(site.url);
    const r = await budget(["revoke", "--rail", "evm", "--no-open", "--timeout", "10"], strict());
    expect(r.stderr).toMatch(/revoke: the site recorded for this chain \(.*\) is not an approval site the owner allows, so this revoke asks on the page on this machine \(127\.0\.0\.1\) instead/);
    expect(r.approve?.url ?? r.stdout).toMatch(/127\.0\.0\.1/);
    expect(site.requests).toEqual([]);
  }, 60_000);

  it("wait on a buy-once made on a site the owner no longer allows reads nothing", async () => {
    const made = await budget(BUY, account(DEV_SETTINGS), { SUPERSTABLES_SITE: purchases.url });
    expect(made.result.state).toBe("waiting_owner");
    const polls = purchases.purchases.length;
    let gets = 0;
    purchases.onPoll = () => { gets += 1; };
    const r = await budget(["wait", "--shown", "--id", made.result.id], account(null));
    expect(r.code).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown", paid: null, final: false });
    expect(r.result.reason).toMatch(/not an approval site the owner allows now; nothing was read from it/);
    expect(gets).toBe(0);
    expect(purchases.purchases.length).toBe(polls);
  }, 60_000);

  const madeThenDenied = async () => {
    const made = await budget(BUY, account(DEV_SETTINGS), { SUPERSTABLES_SITE: purchases.url });
    expect(made.result.state).toBe("waiting_owner");
    // the site, which the owner does not allow now, would answer: final, not paid
    Object.assign(purchases.purchases[0], { state: "denied", final: true, reason_code: "owner_rejected", reason: "rejected", payment: { status: "not_paid" }, delivery: { status: "not_called" } });
    return made.result.id as string;
  };
  const neverPaid = async (id: string) => {
    const after = await budget(["wait", "--shown", "--id", id], account(null));
    expect(after.code).toBe(5);
    expect(after.result).toMatchObject({ state: "unknown", paid: null });
    expect(after.result.paid).not.toBe(false);
  };

  it("wait --abandon reads nothing from it and records no verdict from it", async () => {
    const id = await madeThenDenied();
    let gets = 0;
    purchases.onPoll = () => { gets += 1; };
    const r = await budget(["wait", "--abandon", "--id", id], account(null));
    expect(r.code).toBe(5);
    expect(gets).toBe(0);
    await neverPaid(id);
    expect(gets).toBe(0);
  }, 90_000);

  it("the next buy-once (findOpenOnce) reads nothing from it, and is refused one at a time", async () => {
    const id = await madeThenDenied();
    let gets = 0;
    purchases.onPoll = () => { gets += 1; };
    const polls = purchases.purchases.length;
    const r = await budget(BUY, account(null));
    expect(r.code).toBe(3);
    expect(r.result.reason).toMatch(/no new purchase was started.*nothing was read from it/);
    expect(r.result.next).toContain(`wait --id ${id} --abandon`);
    expect(gets).toBe(0);
    expect(purchases.purchases.length).toBe(polls);
    await neverPaid(id);
    expect(gets).toBe(0);
  }, 90_000);

  it("buy-once --replace sends no cancel to it", async () => {
    const id = await madeThenDenied();
    let gets = 0;
    purchases.onPoll = () => { gets += 1; };
    const r = await budget([...BUY, "--replace"], account(null));
    expect(r.code).toBe(3);
    expect(r.result.next).toContain(`wait --id ${id} --abandon`);
    expect(gets).toBe(0);
    expect(purchases.purchases[0].state).toBe("denied");
    expect(purchases.purchases[0].cancels).toBe(0);
    await neverPaid(id);
  }, 90_000);

  it("a read from a site that is not an approval site at all is refused", async () => {
    const r = await budget(["status", "--rail", "evm", "--site", "https://evil.example"], account(null));
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/is not an approval site the owner allows/);
  }, 60_000);
});

describe("an unusable settings file", () => {
  it("refuses owner commands, names the check, and does not stop doctor or unlock", async () => {
    const bad = account(null, { raw: "{" });
    const r = await budget(["grant", "--rail", "evm", "--amount", "1"], bad);
    expect(r.code).toBe(3);
    expect(r.result.reason).toContain("superstables owner settings show");
    expect(await fileCount(home)).toBe(0);
    const d = await budget(["doctor", "--rail", "evm"], bad);
    expect(d.stderr).toMatch(/warning: the owner settings at .* cannot be used/);
    const u = await budget(["unlock", "--cap"], bad);
    expect(u.result?.reason ?? "").not.toContain("owner settings");
  }, 60_000);
});

async function fileCount(h: string): Promise<number> {
  try { return readdirSync(join(h, "budget", "approvals")).length; } catch { return 0; }
}
