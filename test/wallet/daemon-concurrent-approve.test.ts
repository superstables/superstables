// Two answers to one request at the same moment (a double click, two tabs, a deny or the agent's cancel): exactly one wins. The
// signed-settings check at the start of an approval waits on a signature check; here it waits long enough for the second answer.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

vi.mock("../../src/core/owner-settings.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/owner-settings.js")>();
  return {
    ...real,
    signedPolicyCheck: async (...args: Parameters<typeof real.signedPolicyCheck>) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return real.signedPolicyCheck(...args);
    },
  };
});

const PAYEE = "0x2222222222222222222222222222222222222222";
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const wallets: WalletHandle[] = [];

beforeEach(() => {
  for (const name of ["SUPERSTABLES_TEST_ACCOUNT_HOME", "SUPERSTABLES_HOME", "SUPERSTABLES_POLICY"]) saved[name] = process.env[name];
  process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = accountHomeWith({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true } });
  const home = mkdtempSync(join(tmpdir(), "superstables-concurrent-home-"));
  dirs.push(home);
  process.env.SUPERSTABLES_HOME = home;
});
afterEach(async () => {
  while (wallets.length) await wallets.pop()!.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "superstables-concurrent-"));
  dirs.push(dir);
  const policyFile = join(dir, "account-policy.yaml");
  writeFileSync(policyFile, "caps:\n  per_call: 1\n  per_day: 100\n");
  process.env.SUPERSTABLES_POLICY = policyFile;
  const wallet = await startWallet({ port: 0, tcp: true, dir, account: privateKeyToAccount(generatePrivateKey()), policyFile, accountPolicyFile: policyFile, quiet: true, openBrowser: false, balance: false, launcherDir: join(dir, "open") });
  wallets.push(wallet);
  const call = (path: string, token: string, method = "GET", body?: unknown) =>
    fetch(`${wallet.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const made = (await (await call("/requests", wallet.agentToken, "POST", { sign: { kind: "eip3009", x402Version: 2, requirements: usdcRequirement(0.01, PAYEE), context: { target: "https://seller.example/x" } } })).json()) as WalletRequestView;
  const list = (await (await call("/owner/requests", wallet.ownerSecret)).json()) as { requests: WalletRequestView[] };
  const shown = list.requests.find((r) => r.id === made.id)!.verified;
  const approve = () => call(`/owner/requests/${made.id}/approve`, wallet.ownerSecret, "POST", { amountAtomic: shown.amountAtomic, recipient: shown.recipient, network: shown.network });
  const deny = () => call(`/owner/requests/${made.id}/deny`, wallet.ownerSecret, "POST", {});
  const cancel = () => call(`/requests/${made.id}/cancel`, wallet.agentToken, "POST", {});
  const state = async () => (await (await call(`/requests/${made.id}`, wallet.agentToken)).json()) as { status: string; result?: unknown };
  const approvedLines = () => readFileSync(join(dir, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes(made.id) && l.includes('"approved"'));
  return { approve, deny, cancel, state, approvedLines };
}
const later = (ms: number, fn: () => Promise<Response>) => new Promise<Response>((resolve) => setTimeout(() => void fn().then(resolve), ms));

describe("two answers at once", () => {
  it("two approvals sign once: every other answer is a conflict", async () => {
    const t = await start();
    const statuses = (await Promise.all([t.approve(), t.approve(), t.approve()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect(t.approvedLines()).toHaveLength(1);
  });

  it("a deny that lands during the signed-settings check wins: nothing is signed", async () => {
    const t = await start();
    const [approved, denied] = await Promise.all([t.approve(), later(100, t.deny)]);
    expect(denied.status).toBe(200);
    expect(approved.status).toBe(409);
    expect(((await approved.json()) as { error: string }).error).toBe("this request is denied, so there is nothing to decide");
    const final = await t.state();
    expect(final.status).toBe("denied");
    expect(final.result).toBeUndefined();
    expect(t.approvedLines()).toHaveLength(0);
  });

  it("the agent's cancel during the signed-settings check wins: nothing is signed", async () => {
    const t = await start();
    const [approved, cancelled] = await Promise.all([t.approve(), later(100, t.cancel)]);
    expect(cancelled.status).toBe(200);
    expect(approved.status).toBe(409);
    const final = await t.state();
    expect(final.status).toBe("expired");
    expect(final.result).toBeUndefined();
    expect(t.approvedLines()).toHaveLength(0);
  });
});
