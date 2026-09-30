// `superstables budget` with hosted approvals, as an agent meets it: the real dispatcher (budget/cli.mjs) and the real evm
// rail scripts, against a fake superstables.com and a fake Base Sepolia RPC on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeRpc, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import type { TestServer } from "../helpers/servers.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";

let home: string;
let site: FakeSite;
let rpc: TestServer;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-budget-hosted-"));
  site = await startFakeSite();
  rpc = await startFakeRpc(84532);
});
afterEach(async () => {
  await site.close();
  await rpc.close();
  rmSync(home, { recursive: true, force: true });
});

function budget(args: string[]): Promise<{ code: number; stdout: string; stderr: string; result: any; approve: any }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
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

const publicFile = () => readFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), "utf8");
const approvals = () => join(home, "budget", "approvals");

describe("setup --hosted: refusals before anything runs", () => {
  it("is EVM only for now", async () => {
    for (const rail of ["tempo", "solana"]) {
      const r = await budget(["setup", "--rail", rail, "--hosted"]);
      expect(r.code).toBe(2);
      expect(r.result.reason).toMatch(/hosted approvals are EVM only for now: run superstables budget setup --rail \w+ without --hosted/);
    }
  });

  it("wants --site only with --hosted, and an https site", async () => {
    expect((await budget(["setup", "--rail", "evm", "--site", "https://www.superstables.com"])).result.reason).toMatch(/--site goes with --hosted/);
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--site", "http://example.com"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/https/);
  });
});

describe("setup --hosted", () => {
  it("links the agent, records the account as the owner, and records APPROVALS=hosted and SITE", async () => {
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
    };
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ ok: true, command: "setup", rail: "evm", chain: "base-sepolia", state: "ok", owner: OWNER, approvals: "hosted", site: site.url });
    expect(r.approve).toMatchObject({ action: "setup", matchCode: "ABC-DEF" });
    expect(r.approve.url).toMatch(/\/approve\/budget\/bl_test0001#ssba_/);
    expect(r.stderr).toMatch(/match code: ABC-DEF/);
    expect(r.stderr).toMatch(/any device where the owner is signed in to/);
    expect(r.stderr).toMatch(/Write the code in your own message/);
    const pub = publicFile();
    expect(pub).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(pub).toMatch(/^APPROVALS=hosted$/m);
    expect(pub).toMatch(new RegExp(`^SITE=${site.url}$`, "m"));
    // the site checked the agent's signature on the link request
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].body.agent).toBe(pub.match(/^B4_AGENT_ADDRESS=(.*)$/m)![1]);
    // a blocking command's record is gone, and no token was written anywhere else
    const left = readdirSync(approvals()).filter((f) => f.endsWith(".json"));
    expect(left).toEqual([]);
    expect(readFileSync(join(home, "budget", "owner-approvals.jsonl"), "utf8")).not.toContain("ssbt_");
    expect(r.stdout + r.stderr).not.toContain("ssbt_");
  }, 60_000);

  it("run again for an agent already linked: no link, no wait; the owner is recorded, or checked against the one recorded", async () => {
    const linked = (owner: string) => () => ({ status: 200, body: { id: "bl_test0042", access_token: "ssbt_test_bl_test0042secret", state: "linked", final: true, owner, approval: null, next_action: { type: "none" } } });
    site.reply = linked(OWNER);
    // detached (stdout is not a terminal): it ends at once with the final result, not waiting_owner
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ state: "ok", owner: OWNER, approvals: "hosted", site: site.url });
    expect(r.approve).toBeNull();
    expect(r.stderr).toMatch(/already linked/);
    expect(publicFile()).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(publicFile()).toMatch(/^APPROVALS=hosted$/m);

    // the site now says another account: refused, the recorded owner stays
    site.reply = linked(OTHER);
    const other = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(other.code).toBe(3);
    expect(other.result.reason).toMatch(new RegExp(`linked this agent to ${OTHER}, but this computer records the owner ${OWNER}`));
    expect(publicFile()).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
  }, 60_000);

  it("a later setup without --hosted keeps the recorded owner and the hosted mode", async () => {
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "linked", owner: OWNER });
    };
    expect((await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--wait", "--no-open"])).code).toBe(0);
    const again = await budget(["setup", "--rail", "evm", "--wait", "--no-open"]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.result).toMatchObject({ owner: OWNER, approvals: "hosted", site: site.url });
    expect(publicFile()).toMatch(/^APPROVALS=hosted$/m);
  }, 60_000);

  it("detached: returns waiting_owner with the match code; the token is only in the record (mode 600); wait gives the final result", async () => {
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.result).toMatchObject({ state: "waiting_owner", matchCode: "ABC-DEF", action: "setup" });
    expect(first.result.next).toMatch(/match code ABC-DEF, written in your own message/);
    const id = first.result.id;
    const recordPath = join(approvals(), `${id}.json`);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.hosted).toMatchObject({ site: site.url, requestId: "bl_test0001", token: "ssbt_test_bl_test0001secret", kind: "link" });
    expect(readFileSync(join(approvals(), `${id}.log`), "utf8")).not.toContain("ssbt_");

    const pending = await budget(["wait", "--id", id, "--timeout", "0"]);
    expect(pending.result).toMatchObject({ state: "waiting_owner", matchCode: "ABC-DEF" });
    expect(pending.result.reason).toMatch(/superstables\.com.*match code/);

    Object.assign(site.requests[0], { state: "linked", owner: OWNER });
    const done = await budget(["wait", "--id", id, "--timeout", "30"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({ state: "ok", owner: OWNER, approvals: "hosted", id });
    // final: the token is removed from the record
    expect(readFileSync(recordPath, "utf8")).not.toContain("ssbt_");
  }, 90_000);

  it("--replace cancels the pending request on the site before starting a new one", async () => {
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(first.result.state).toBe("waiting_owner");
    const refused = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(refused.code).toBe(3);
    expect(refused.result).toMatchObject({ id: first.result.id, matchCode: "ABC-DEF" });

    const second = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--replace"]);
    expect(second.code, second.stderr).toBe(0);
    expect(second.result.state).toBe("waiting_owner");
    expect(site.requests[0]).toMatchObject({ state: "cancelled" });
    const old = await budget(["wait", "--id", first.result.id, "--timeout", "30"]);
    expect(old.code).toBe(3);
    expect(old.result.reason).toMatch(/nothing was sent/);

    // clean up the second worker: the site ends it
    site.requests[1].state = "expired";
    const end = await budget(["wait", "--id", second.result.id, "--timeout", "30"]);
    expect(end.code).toBe(3);
  }, 120_000);
});

describe("owner commands on a hosted chain", () => {
  const hostedChain = (owner = OWNER) => {
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    const key = `0x${"11".repeat(32)}`;
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=${key}\nB4_AGENT_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n`, { mode: 0o600 });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${owner}\nB4_AGENT_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\nAPPROVALS=hosted\nSITE=${site.url}\n`);
  };

  it("grant asks the site for the exact approve, and refuses when the site acts for another owner", async () => {
    hostedChain();
    site.owner = OTHER;
    const r = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(/owner recorded on this computer is 0x2222.*nothing was sent/);
    expect(r.approve).toBeNull();
    expect(site.requests[0].body).toMatchObject({
      kind: "grant", rail: "evm", chain: "base-sepolia", agent: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      // USDC.approve(agent, 10000)
      transaction: { to: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", data: "0x095ea7b300000000000000000000000019e7e376e7c213b7e7e7e46cc70a5dd086daff2a0000000000000000000000000000000000000000000000000000000000002710", value: "0x0" },
    });
    expect(site.requests[0].state).toBe("cancelled");
  }, 60_000);

  it("a site that cannot be reached: a clear refusal, nothing sent", async () => {
    hostedChain();
    const url = site.url;
    await site.close();
    site = await startFakeSite(); // for afterEach; the recorded site stays closed
    const g = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(g.code).toBe(3);
    expect(g.result.reason).toMatch(new RegExp(`could not reach ${url}.*nothing was requested or sent`));
  }, 60_000);
});

describe("find", () => {
  it("lists the site's services, with the chain named as --chain takes it", async () => {
    site.services = [{ name: "Weather", price: "0.001", network: "eip155:84532", url: "https://seller.example/w" }];
    const r = await budget(["find", "--site", site.url]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Weather\s+0\.001 USDC\s+base-sepolia\s+https:\/\/seller\.example\/w/);
    expect(r.result).toMatchObject({ command: "find", state: "ok", services: [{ name: "Weather", chain: "base-sepolia", url: "https://seller.example/w" }] });
    const j = await budget(["find", "--json", "--site", site.url]);
    expect(JSON.parse(j.stdout.split("\n")[0])).toEqual(r.result.services);
  }, 30_000);

  it("says any seller URL still works when the site has no list", async () => {
    const r = await budget(["find", "--site", site.url]);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ state: "failed", services: [] });
    expect(r.result.next).toMatch(/any seller URL works too/);
  }, 30_000);
});
