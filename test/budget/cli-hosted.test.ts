// `superstables budget` with hosted approvals, as an agent meets it: the real dispatcher (budget/cli.mjs) and the real evm
// rail scripts, against a fake superstables.com and a fake Base Sepolia RPC on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, parseAbi } from "viem";
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

function budget(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string; result: any; approve: any }> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc.url };
    delete env.SUPERSTABLES_SITE;
    Object.assign(env, extraEnv);
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

  it("wants an https site for --site, with or without --hosted", async () => {
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--site", "http://example.com"]);
    expect(r.code).toBe(2);
    expect(r.result.reason).toMatch(/https/);
    for (const args of [["setup", "--rail", "evm"], ["status", "--rail", "evm"], ["doctor", "--rail", "evm"], ["grant", "--rail", "evm", "--amount", "1"], ["fund-agent", "--rail", "evm"], ["revoke", "--rail", "evm"], ["recover", "--rail", "evm"], ["buy", "--rail", "evm", "--url", "https://x.example/a", "--max", "1"], ["wait", "--shown", "--id", "oa-20260930120000-1a2b3c4d"]]) {
      const bad = await budget([...args, "--site", "http://example.com"]);
      expect(bad.code, args.join(" ")).toBe(2);
      expect(bad.result.reason, args.join(" ")).toMatch(/--site: the site must be an https URL/);
    }
  });
});

describe("--site on every command", () => {
  const COMMANDS: string[][] = [
    ["setup", "--rail", "evm", "--new-owner"], ["status", "--rail", "evm"], ["doctor", "--rail", "evm"], ["grant", "--rail", "evm", "--amount", "0.01"],
    ["fund-agent", "--rail", "evm"], ["revoke", "--rail", "evm"], ["recover", "--rail", "evm"], ["preflight", "--rail", "evm", "--url", "https://x.example/a"],
    ["buy", "--rail", "evm", "--url", "https://x.example/a", "--max", "1"], ["reconcile", "--rail", "evm", "--op", "none"],
  ];

  // An owner command would start an approval. --timeout 1 is refused after --site is checked, so it stands in for "accepted" without one.
  const OWNER_COMMANDS = new Set(["setup", "grant", "fund-agent", "revoke", "recover"]);
  const run = (args: string[], site: string) => budget(OWNER_COMMANDS.has(args[0]) ? [...args, "--timeout", "1", "--site", site] : [...args, "--site", site]);
  const accepted = (r: { result: any }, args: string[]) => expect(r.result.reason ?? "", args.join(" ")).toMatch(OWNER_COMMANDS.has(args[0]) ? /^--timeout must be/ : /^(?!.*(--site|unknown flag))/);

  it("is accepted and ignored where no site is recorded (a chain that approves on this computer, or tempo and solana)", async () => {
    for (const args of COMMANDS) accepted(await run(args, "https://staging.superstables.com"), args);
    const t = await budget(["status", "--rail", "tempo", "--site", "https://staging.superstables.com"]);
    expect(t.result.reason ?? "").not.toMatch(/--site|unknown flag/);
  }, 60_000);

  it("is refused clearly where the chain's approvals are hosted on another site, and accepted on the same one", async () => {
    mkdirSync(join(home, "budget", "public"), { recursive: true });
    writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\nAPPROVALS=hosted\nSITE=${site.url}\n`);
    for (const args of COMMANDS) {
      const other = await run(args, "https://staging.superstables.com");
      expect(other.code, args.join(" ")).toBe(2);
      expect(other.result.reason, args.join(" ")).toMatch(new RegExp(`--site https://staging.superstables.com is not the site this chain's approvals are hosted on \\(${site.url.replace(/[.]/g, "\\.")}\\): use --site ${site.url.replace(/[.]/g, "\\.")}, or leave --site out`));
      accepted(await run(args, site.url), args);
    }
  }, 120_000);

  it("wait: refused when the approval was made on another site, accepted on the same one", async () => {
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(first.result.state).toBe("waiting_owner");
    const other = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0", "--site", "https://staging.superstables.com"]);
    expect(other.code).toBe(2);
    expect(other.result.reason).toMatch(/is not the site this approval was made on/);
    const same = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "0", "--site", site.url]);
    expect(same.result).toMatchObject({ state: "waiting_owner", id: first.result.id });
    // the refusal comes before the --shown check: nothing is read for a request that is not on this site
    const noShown = await budget(["wait", "--id", first.result.id, "--site", "https://staging.superstables.com"]);
    expect(noShown.result.reason).toMatch(/is not the site this approval was made on/);
  }, 60_000);
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
    expect(r.stderr).toMatch(/Write this link, the match code ABC-DEF and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call/);
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
    expect(first.result.next).toMatch(/^reply to the owner with message_for_owner, word for word \(it has the link, the code and the amount\), and end your turn there\. When they say they've approved, run superstables budget wait --id oa-\S+ --shown\. .*Testnet only: test USDC, no real money\.$/);
    expect(first.stderr).toMatch(/Testnet only: test USDC, no real money\./);
    // the reply the agent sends word for word: the exact link (with the part after #), the code, the network, the testnet line
    const msg = first.result.message_for_owner;
    expect(msg).toContain(first.result.url);
    expect(msg).toContain("Match code: ABC-DEF");
    expect(msg).toMatch(/On Base Sepolia\. Testnet only: test USDC, no real money\./);
    expect(msg.endsWith("Tell me when you've approved.")).toBe(true);
    const id = first.result.id;
    const recordPath = join(approvals(), `${id}.json`);
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.hosted).toMatchObject({ site: site.url, requestId: "bl_test0001", token: "ssbt_test_bl_test0001secret", kind: "link" });
    expect(readFileSync(join(approvals(), `${id}.log`), "utf8")).not.toContain("ssbt_");

    // without --shown, wait refuses and prints no state (the background worker keeps reading the site on its own)
    const refused = await budget(["wait", "--id", id, "--timeout", "0"]);
    expect(refused.code).toBe(2);
    expect(refused.result).toMatchObject({ ok: false, state: "show_owner_first", id, matchCode: "ABC-DEF", action: "setup" });
    expect(refused.result.next).toMatch(/--shown/);

    const pending = await budget(["wait", "--shown", "--id", id, "--timeout", "0"]);
    expect(pending.result).toMatchObject({ state: "waiting_owner", matchCode: "ABC-DEF" });
    expect(pending.result.reason).toMatch(/superstables\.com.*match code/);

    Object.assign(site.requests[0], { state: "linked", owner: OWNER });
    const done = await budget(["wait", "--shown", "--id", id, "--timeout", "30"]);
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
    const old = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "30"]);
    expect(old.code).toBe(3);
    expect(old.result.reason).toMatch(/nothing was sent/);

    // clean up the second worker: the site ends it
    site.requests[1].state = "expired";
    const end = await budget(["wait", "--shown", "--id", second.result.id, "--timeout", "30"]);
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

  it("the site's final unknown ends the grant as unknown (exit 5): read the chain, never nothing sent", async () => {
    hostedChain();
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls === 2) r.state = "sending";
      if (r.polls >= 3) Object.assign(r, { state: "unknown", reason: "the wallet was asked and never answered" });
    };
    const r = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(5);
    expect(r.result.state).toBe("unknown");
    expect(r.result.next).toMatch(/superstables budget status --rail evm/);
    expect(r.approve).toMatchObject({ action: "grant", matchCode: "ABC-DEF" });
  }, 60_000);

  it("a confirmed transaction mined before the request started is refused, even when the site confirms it", async () => {
    hostedChain();
    const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
    const HASH = `0x${"cd".repeat(32)}`;
    // exactly the planned approve(agent, 0.01 USDC), from the owner, but in block 50 while the chain is at block 100
    const data = encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 value) returns (bool)"]), functionName: "approve", args: [AGENT, 10000n] });
    const blockHash = `0x${"ef".repeat(32)}`;
    await rpc.close();
    rpc = await startFakeRpc(84532, (method) => {
      if (method === "eth_blockNumber") return "0x64";
      if (method === "eth_getTransactionByHash") return { hash: HASH, blockHash, blockNumber: "0x32", from: OWNER, to: USDC, input: data, value: "0x0", gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
      if (method === "eth_getTransactionReceipt") return { transactionHash: HASH, blockHash, blockNumber: "0x32", from: OWNER, to: USDC, status: "0x1", logs: [], gasUsed: "0x10000", cumulativeGasUsed: "0x10000", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
      return undefined;
    });
    site.owner = OWNER;
    site.onPoll = (r) => {
      if (r.polls >= 2) Object.assign(r, { state: "confirmed", tx_hash: HASH });
    };
    const r = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toBe("the transaction on chain is not the one planned: it was mined in block 50, before this request started (block 100). The budget was not recorded.");
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
  }, 60_000);

  it("a site that cannot be reached: a clear refusal, nothing sent", async () => {
    hostedChain();
    const url = site.url;
    await site.close();
    site = await startFakeSite(); // for afterEach; the recorded site stays closed
    const g = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"]);
    expect(g.code).toBe(3);
    expect(g.result.reason).toMatch(new RegExp(`could not reach ${url}.*nothing was sent`));
  }, 60_000);
});

describe("find", () => {
  it("lists the site's services, with the chain named as --chain takes it", async () => {
    site.services = [{ name: "Weather", price: "0.001", network: "eip155:84532", url: "https://seller.example/w" }];
    const r = await budget(["find", "--site", site.url]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Weather\s+0\.001 USDC\s+base-sepolia\s+https:\/\/seller\.example\/w/);
    expect(r.result).toMatchObject({ command: "find", state: "ok", services: [{ name: "Weather", chain: "base-sepolia", url: "https://seller.example/w" }] });
    // --json: stdout is the RESULT object alone (no table), which carries the services
    const j = await budget(["find", "--json", "--site", site.url]);
    expect(j.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(j.stdout).services).toEqual(r.result.services);
  }, 30_000);

  describe("which site", () => {
    let other: FakeSite;
    const record = (chain: string, url: string, hosted = true) => {
      mkdirSync(join(home, "budget", "public"), { recursive: true });
      writeFileSync(join(home, "budget", "public", `evm-${chain}.env`), `B4_OWNER_ADDRESS=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A\n${hosted ? "APPROVALS=hosted\n" : ""}SITE=${url}\n`);
    };
    beforeEach(async () => {
      other = await startFakeSite();
      site.services = [{ name: "Recorded", price: "0.001", network: "eip155:84532", url: "https://seller.example/recorded" }];
      other.services = [{ name: "Other", price: "0.002", network: "eip155:84532", url: "https://seller.example/other" }];
    });
    afterEach(() => other.close());

    it("uses the site recorded by setup --hosted when no site is given", async () => {
      record("base-sepolia", site.url);
      const r = await budget(["find"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.result).toMatchObject({ state: "ok", site: site.url, services: [{ name: "Recorded" }] });
    }, 30_000);

    it("without --chain, uses the first hosted chain recorded; with --chain, that chain's site", async () => {
      record("arbitrum-sepolia", other.url);
      expect((await budget(["find"])).result).toMatchObject({ site: other.url, services: [{ name: "Other" }] });
      record("base-sepolia", site.url);
      expect((await budget(["find", "--chain", "base-sepolia"])).result).toMatchObject({ site: site.url });
      expect((await budget(["find", "--chain", "arbitrum-sepolia"])).result).toMatchObject({ site: other.url });
    }, 60_000);

    it("a file that is not hosted records no site; --site and SUPERSTABLES_SITE come first", async () => {
      record("arbitrum-sepolia", other.url, false);
      record("base-sepolia", site.url);
      expect((await budget(["find"])).result.site).toBe(site.url);
      expect((await budget(["find", "--site", other.url])).result).toMatchObject({ site: other.url, services: [{ name: "Other" }] });
      expect((await budget(["find"], { SUPERSTABLES_SITE: other.url })).result.site).toBe(other.url);
    }, 60_000);

    it("refuses a rail or chain that cannot record a site", async () => {
      expect((await budget(["find", "--rail", "tempo"])).code).toBe(2);
      expect((await budget(["find", "--chain", "moderato"])).code).toBe(2);
    }, 30_000);
  });

  it("says any seller URL still works when the site has no list", async () => {
    const r = await budget(["find", "--site", site.url]);
    expect(r.code).toBe(1);
    expect(r.result).toMatchObject({ state: "failed", services: [] });
    expect(r.result.next).toMatch(/any seller URL works too/);
  }, 30_000);
});

describe("setup --hosted --grant --fund: one link for the link, the gas and the budget", () => {
  const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
  const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const FUND_HASH = `0x${"a1".repeat(32)}`;
  const GRANT_HASH = `0x${"b2".repeat(32)}`;
  const approve = encodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 value) returns (bool)"]), functionName: "approve", args: [AGENT, 10000n] });
  // fund-agent's default on Base Sepolia: 0.0001 ETH
  const FUND_VALUE = 100_000_000_000_000n;

  /** The agent key setup reuses, and a chain that shows the owner's two transactions in block 0x20 (the head is 0x10 before). */
  const prepare = async () => {
    mkdirSync(join(home, "keys", "budget"), { recursive: true });
    writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
    const txs: Record<string, { to: string; input: string; value: bigint }> = {
      [FUND_HASH]: { to: AGENT, input: "0x", value: FUND_VALUE },
      [GRANT_HASH]: { to: USDC, input: approve, value: 0n },
    };
    let funded = false;
    let granted = false;
    const blockHash = `0x${"ef".repeat(32)}`;
    await rpc.close();
    rpc = await startFakeRpc(84532, (method, params) => {
      if (method === "eth_blockNumber") return funded || granted ? "0x20" : "0x10";
      const t = txs[params[0]];
      if (method === "eth_getTransactionByHash" && t) return { hash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, input: t.input, value: `0x${t.value.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
      if (method === "eth_getTransactionReceipt" && t) {
        if (params[0] === FUND_HASH) funded = true;
        if (params[0] === GRANT_HASH) granted = true;
        return { transactionHash: params[0], blockHash, blockNumber: "0x20", from: OWNER, to: t.to, status: "0x1", logs: [], gasUsed: "0x10000", cumulativeGasUsed: "0x10000", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
      }
      // allowance(owner, agent): the cap once the grant is mined
      if (method === "eth_call" && String(params[0]?.data).startsWith("0xdd62ed3e")) return `0x${(granted ? 10000n : 0n).toString(16).padStart(64, "0")}`;
      if (method === "eth_getBalance" && String(params[0]).toLowerCase() === AGENT.toLowerCase()) return `0x${(10n ** 18n + (funded ? FUND_VALUE : 0n)).toString(16)}`;
      return undefined;
    });
  };

  const start = async () => {
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund"]);
    expect(first.code, first.stderr).toBe(0);
    return first;
  };

  it("asks once, with the gas and the grant after the link; wait verifies both transactions and records everything", async () => {
    await prepare();
    const first = await start();
    expect(first.result).toMatchObject({ command: "setup", state: "waiting_owner", final: false, action: "setup", matchCode: "ABC-DEF" });
    expect(first.result.terms).toMatchObject({ title: "Link this agent, send it gas and approve a budget of 0.01 test USDC", amount: "0.01", unit: "USDC" });
    expect(first.result.terms.summary).toMatch(/1\. Link this agent.*2\. Send 0\.0001 ETH.*3\. Allow the agent to withdraw up to 0\.01 USDC/);
    expect(first.result.terms.notEnforced.join(" ")).toMatch(/No expiry/);
    expect(first.result.message_for_owner).toContain(first.result.url);
    expect(first.result.message_for_owner).toContain("Link this agent, send it gas and approve a budget of 0.01 test USDC");
    expect(first.result.message_for_owner).toContain("Match code: ABC-DEF");
    // one request: the link, then the gas, then the grant, built as fund-agent and grant build them
    expect(site.posts).toEqual([{ path: "/api/v1/budget/links", ok: true, why: undefined }]);
    expect(site.requests[0].body.then).toEqual([
      { kind: "fund_agent", transaction: { to: AGENT, data: "0x", value: `0x${FUND_VALUE.toString(16)}` } },
      { kind: "grant", transaction: { to: USDC, data: approve, value: "0x0" } },
    ]);
    // the background approval knows wallet steps follow the link
    expect(JSON.parse(readFileSync(join(approvals(), `${first.result.id}.json`), "utf8")).hosted).toMatchObject({ kind: "link", then: ["fund_agent", "grant"] });

    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "confirmed", tx_hash: GRANT_HASH, wallet_asked: true });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.result).toMatchObject({
      ok: true, command: "setup", state: "ok", final: true, owner: OWNER, agent: AGENT, approvals: "hosted", site: site.url, linked: true,
      amount: "0.01", remaining: "0.01", tx: { fundAgent: FUND_HASH, grant: GRANT_HASH },
      steps: [{ kind: "fund_agent", state: "settled", tx: FUND_HASH, amount: "0.0001" }, { kind: "grant", state: "settled", tx: GRANT_HASH, amount: "0.01" }],
    });
    const pub = publicFile();
    expect(pub).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(pub).toMatch(/^APPROVALS=hosted$/m);
    expect(pub).toMatch(new RegExp(`^SITE=${site.url}$`, "m"));
    expect(pub).toMatch(/^B4_CAP=10000$/m);
    expect(readFileSync(join(approvals(), `${first.result.id}.json`), "utf8")).not.toContain("ssbt_");
  }, 180_000);

  it("a grant the owner rejects after the link: the link and the gas are recorded and reported, the budget is not", async () => {
    await prepare();
    const first = await start();
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "rejected", reason: "The owner rejected this in their wallet.", reason_code: "owner_rejected" });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(3);
    expect(done.result).toMatchObject({
      ok: false, state: "refused_precheck", final: true, owner: OWNER, linked: true, approvals: "hosted", tx: { fundAgent: FUND_HASH },
      steps: [{ kind: "fund_agent", state: "settled", tx: FUND_HASH }, { kind: "grant", state: "refused_precheck", reasonCode: "owner_rejected" }],
    });
    expect(done.result.reason).toMatch(/^linked: yes; gas: 0\.0001 ETH sent; budget: nothing was sent: rejected: The owner rejected this in their wallet\.$/);
    expect(done.result.amount).toBeUndefined();
    expect(done.result.next).toMatch(/the agent is linked and has gas\. Tell the owner .* only if the owner asks: superstables budget grant --rail evm --amount A$/);
    const pub = publicFile();
    expect(pub).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(pub).toMatch(/^APPROVALS=hosted$/m);
    expect(pub).not.toMatch(/^B4_CAP=/m);
  }, 180_000);

  it("a step the site cannot account for is unknown (exit 5), never nothing sent; the link is still recorded", async () => {
    await prepare();
    const first = await start();
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "unknown", wallet_asked: true, reason: "The wallet was asked and never answered." });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(done.code, done.stderr).toBe(5);
    expect(done.result).toMatchObject({ state: "unknown", linked: true, owner: OWNER, steps: [{ kind: "fund_agent", state: "settled" }, { kind: "grant", state: "unknown" }] });
    expect(done.result.next).toMatch(/^superstables budget status --rail evm and the owner's wallet activity/);
    expect(publicFile()).toMatch(new RegExp(`^B4_OWNER_ADDRESS=${OWNER}$`, "m"));
    expect(publicFile()).not.toMatch(/^B4_CAP=/m);
  }, 180_000);

  it("stops waiting after the link: the grant the wallet was not asked for is withdrawn on the site before it is called unsent", async () => {
    await prepare();
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund", "--timeout", "10"]);
    expect(first.code, first.stderr).toBe(0);
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND_HASH, wallet_asked: true });
    Object.assign(r.steps![1], { state: "awaiting_owner" });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "120"]);
    expect(r.cancels).toBe(1);
    expect(r.steps![1].state).toBe("cancelled");
    expect(done.code, done.stderr).toBe(3);
    expect(done.result).toMatchObject({ state: "refused_precheck", linked: true, steps: [{ kind: "fund_agent", state: "settled" }, { kind: "grant", state: "refused_precheck" }] });
    expect(done.result.steps[1].reason).toMatch(/^nothing was sent: withdrawn on superstables\.com/);
  }, 180_000);

  it("stops waiting after the link and can't withdraw the steps: they are unknown (exit 5), never nothing sent", async () => {
    await prepare();
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund", "--timeout", "10"]);
    expect(first.code, first.stderr).toBe(0);
    site.cancelFails = true;
    const r = site.requests[0];
    Object.assign(r, { state: "linked", owner: OWNER });
    Object.assign(r.steps![0], { state: "awaiting_owner" });
    const done = await budget(["wait", "--shown", "--id", first.result.id, "--timeout", "150"]);
    expect(r.cancels).toBe(1);
    expect(done.code, done.stderr).toBe(5);
    expect(done.result).toMatchObject({ state: "unknown", linked: true, steps: [{ kind: "fund_agent", state: "unknown" }, { kind: "grant", state: "unknown" }] });
    expect(done.result.steps[1].reason).toMatch(/may still be sent/);
    expect(JSON.stringify(done.result)).not.toMatch(/nothing was sent/);
  }, 240_000);

  it("--grant or --fund without --hosted is refused before anything runs; without them setup is unchanged", async () => {
    for (const extra of [["--grant", "5"], ["--fund"], ["--fund", "0.001"]]) {
      const r = await budget(["setup", "--rail", "evm", ...extra]);
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.result.reason).toMatch(/^--grant and --fund go with --hosted/);
    }
    const bad = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0"]);
    expect(bad.code).toBe(2);
    expect(site.posts).toEqual([]);
    // plain setup --hosted sends no then
    const plain = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url]);
    expect(plain.result.state).toBe("waiting_owner");
    expect(site.requests[0].body.then).toBeUndefined();
    site.requests[0].state = "expired";
    expect((await budget(["wait", "--shown", "--id", plain.result.id, "--timeout", "30"])).code).toBe(3);
  }, 120_000);

  it("an agent already linked on the chain: refused, with gas and a budget asked for separately", async () => {
    await prepare();
    site.linked = { [AGENT.toLowerCase()]: OWNER };
    const r = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--grant", "0.01", "--fund"]);
    expect(r.code, r.stderr).toBe(3);
    expect(r.result.state).toBe("refused_precheck");
    expect(r.result.reason).toMatch(/this agent is already linked on .* to the account 0x2222.*nothing was sent/);
    expect(r.result.next).toMatch(/superstables budget fund-agent --rail evm, then superstables budget grant --rail evm --amount A/);
    expect(r.approve).toBeNull();
  }, 60_000);
});
