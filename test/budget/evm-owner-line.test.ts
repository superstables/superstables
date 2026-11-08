// A stale B4_OWNER_ADDRESS line in the evm agent key file. No client version writes that line, but an older file can hold one, and
// buy refuses when it differs from the owner in the public file. Setup must fix that record when the owner has signed for the
// owner it records; doctor must say so; buy must keep refusing before it signs, and name the repair.
// The real dispatcher and rail scripts against a fake chain on 127.0.0.1. No network, no real key.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { budgetBundle } from "../helpers/budget-bundle.js";
import { startFakeEvm, startSeller, usdc, type FakeEvm, type Seller } from "../helpers/fake-evm.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(budgetBundle(), "cli.mjs");
const REPAIR = "superstables budget setup --rail evm";

let home: string;
let chain: FakeEvm;
const sellers: Seller[] = [];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-owner-line-"));
  chain = await startFakeEvm();
});
afterEach(async () => {
  await chain.close();
  for (const s of sellers.splice(0)) await s.close();
  rmSync(home, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any };
function run(args: string[]): Promise<Out> {
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: chain.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => {
      const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      done({ code: code ?? 0, stdout, stderr, result: line ? JSON.parse(line.slice(7)) : null });
    });
  });
}
const all = (o: Out) => `${o.stdout}\n${o.stderr}`;
const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 }); writeFileSync(path, text, { mode }); };
const agentFile = () => join(home, "keys", "budget", "evm-agent.env");
const publicFile = () => join(home, "budget", "public", "evm-base-sepolia.env");

const agentKey = generatePrivateKey();
const agent = privateKeyToAccount(agentKey).address;
const oldKey = generatePrivateKey();
const OLD = privateKeyToAccount(oldKey).address;
const newKey = generatePrivateKey();
const NEW = privateKeyToAccount(newKey).address;
const ownerFile = (key: string) => { const p = join(home, "owner.env"); write(p, `B4_OWNER_KEY=${key}\n`); return p; };

/** The lines that stay when the stale owner line goes, in this order. */
const OTHER_LINES = `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent}\n# kept\nB4_LABEL=mine\n`;
const staleFile = () => `B4_AGENT_KEY=${agentKey}\nB4_AGENT_ADDRESS=${agent}\nB4_OWNER_ADDRESS=${OLD}\n# kept\nB4_LABEL=mine\n`;
const seed = (o: { agentText?: string; publicOwner?: string; extraPublic?: string } = {}) => {
  write(agentFile(), o.agentText ?? staleFile());
  write(publicFile(), `# Base Sepolia public state\nB4_OWNER_ADDRESS=${o.publicOwner ?? NEW}\nB4_AGENT_ADDRESS=${agent}\n${o.extraPublic ?? ""}`, 0o644);
};
/** The chain as a grant leaves it for the owner NEW, and a seller that wants 0.01 USDC. */
async function fund(allow = "1", who: string = agent) {
  chain.setUsdc(NEW, usdc("100"));
  chain.setNative(NEW, 10n ** 20n);
  chain.setNative(who, 10n ** 17n);
  chain.setAllowance(NEW, who, usdc(allow));
  const seller = await startSeller(chain, 84532);
  sellers.push(seller);
  return seller;
}
const buy = (url: string, op: string) => run(["buy", "--rail", "evm", "--url", url, "--max", "0.05", "--op", op]);
const setup = (key: string, extra: string[] = []) => run(["setup", "--rail", "evm", "--owner-key-file", ownerFile(key), ...extra]);
/** Nothing was signed, sent or journaled, and the seller never got a payment. */
const nothingSigned = (seller: Seller, op: string) => {
  expect(chain.sentRaw).toEqual([]);
  expect(seller.creds).toEqual([]);
  expect(existsSync(join(home, "budget", "ops", "evm-base-sepolia", `${op}.json`))).toBe(false);
};

describe("a stale owner line in the agent key file", () => {
  it("plain setup on a fresh key writes no owner line, and buy passes", async () => {
    const out = await setup(newKey);
    expect(out.code, all(out)).toBe(0);
    expect(readFileSync(agentFile(), "utf8")).not.toContain("B4_OWNER_ADDRESS");
    const seller = await fund("1", readFileSync(agentFile(), "utf8").match(/^B4_AGENT_ADDRESS=(.*)$/m)![1]);
    const r = await buy(seller.url, "fresh1");
    expect(r.code, all(r)).toBe(0);
    expect(seller.creds).toHaveLength(1);
  }, 120_000);

  it("setup --new-owner with an owner key file removes the stale line and keeps every other line", async () => {
    seed({ publicOwner: OLD });
    const out = await setup(newKey, ["--new-owner"]);
    expect(out.code, all(out)).toBe(0);
    expect(readFileSync(agentFile(), "utf8")).toBe(OTHER_LINES);
    expect(statSync(agentFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(publicFile(), "utf8")).toContain(`B4_OWNER_ADDRESS=${NEW}`);
    expect(all(out)).toContain(`removed the stale owner line ${OLD} from`);
    expect(all(out)).not.toContain(agentKey);
    const seller = await fund();
    const r = await buy(seller.url, "newowner1");
    expect(r.code, all(r)).toBe(0);
    expect(seller.creds).toHaveLength(1);
  }, 120_000);

  it("setup that records an owner with no signature keeps the line", async () => {
    seed({ extraPublic: "APPROVALS=hosted\nSITE=https://staging.superstables.com\nLINK_ID=bl_test0001\nLINK_CODE=ABC-DEF\n" });
    const out = await run(["setup", "--rail", "evm"]);
    expect(out.code, all(out)).toBe(0);
    expect(all(out)).toContain("no owner signature naming agent");
    expect(readFileSync(agentFile(), "utf8")).toBe(staleFile());
  }, 120_000);

  it("doctor fails with both owners and the repair command, and reports the allowance the recorded owner gives", async () => {
    seed();
    await fund("0.5");
    const live = await run(["doctor", "--rail", "evm"]);
    expect(live.code, all(live)).toBe(1);
    expect(live.stderr).toMatch(/FAIL\s+owner on record: .*/);
    expect(live.stderr).toContain(OLD);
    expect(live.stderr).toContain(NEW);
    expect(live.stderr).toContain(`Run ${REPAIR}`);
    expect(live.stderr).toMatch(/info\s+allowance: 0\.5 USDC .*0 means none was granted, or it is spent or revoked/);
    // revoked: the stale line is still reported, and the allowance reads 0
    chain.setAllowance(NEW, agent, 0n);
    const revoked = await run(["doctor", "--rail", "evm"]);
    expect(revoked.code, all(revoked)).toBe(1);
    expect(revoked.stderr).toMatch(/FAIL\s+owner on record: /);
    expect(revoked.stderr).toMatch(/info\s+allowance: 0 USDC /);
  }, 120_000);

  it("doctor names no owner-line problem when the files agree", async () => {
    seed({ agentText: OTHER_LINES });
    await fund();
    const out = await run(["doctor", "--rail", "evm"]);
    expect(out.stderr).not.toMatch(/owner on record:/);
    expect(out.stderr).toMatch(/info\s+allowance: 1 USDC /);
  }, 120_000);

  it("buy refuses before it signs, naming both owners and the repair", async () => {
    seed();
    const seller = await fund();
    const r = await buy(seller.url, "stale1");
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toContain(OLD);
    expect(r.result.reason).toContain(NEW);
    expect(r.result.reason).toContain("Nothing was signed");
    expect(r.result.next).toContain(REPAIR);
    expect(r.result.next).not.toMatch(/respect the refusal/);
    nothingSigned(seller, "stale1");
  }, 120_000);

  it("buy after a revoke still refuses for the owner mismatch, before it signs", async () => {
    seed({ extraPublic: "B4_REVOKED_AT=1760000000\n" });
    const seller = await fund("0");
    const r = await buy(seller.url, "stale2");
    expect(r.code, all(r)).toBe(3);
    expect(r.result).toMatchObject({ ok: false, state: "refused_precheck" });
    expect(r.result.reason).toContain(OLD);
    expect(r.result.next).toContain(REPAIR);
    nothingSigned(seller, "stale2");
  }, 120_000);

  it("the repair removes the line, then buy passes", async () => {
    seed();
    const seller = await fund();
    const refused = await buy(seller.url, "stale3");
    expect(refused.code, all(refused)).toBe(3);
    const fixed = await setup(newKey);
    expect(fixed.code, all(fixed)).toBe(0);
    expect(readFileSync(agentFile(), "utf8")).toBe(OTHER_LINES);
    const r = await buy(seller.url, "stale4");
    expect(r.code, all(r)).toBe(0);
    expect(seller.creds).toHaveLength(1);
  }, 120_000);
});
