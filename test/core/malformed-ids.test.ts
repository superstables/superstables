// A request id with a malformed percent-escape names no request: the same 404 as an id nobody holds, never a 500.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalServer } from "../../src/core/signer/approval-server.js";
import type { Policy } from "../../src/core/policy.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";

const POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: [],
  stablecoins: ["USDC"],
  killSwitch: false,
  approval: "ask-every-payment",
};
const BAD_IDS = ["%E0%A4%A", "%", "%ZZ"];

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "malformed-ids-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe.each(BAD_IDS)("the id %s", (id) => {
  it("is an unknown approval link to the approval server", async () => {
    const server = new ApprovalServer({ port: 0, recordsDirPath: join(tmp(), "records") });
    await server.start();
    closers.push(() => server.close());
    const page = await fetch(`${server.url}/approve/${id}`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("This approval link is unavailable");
    expect((await fetch(`${server.url}/approve/${id}/state`)).status).toBe(404);
    expect((await fetch(`${server.url}/approve/${id}/reject`, { method: "POST" })).status).toBe(404);
  });

  it("is an unknown request to the wallet", async () => {
    const dir = tmp();
    const wallet: WalletHandle = await startWallet({
      port: 0, dir, account: privateKeyToAccount(generatePrivateKey()), policy: POLICY, quiet: true, openBrowser: false, balance: false,
      launcherDir: join(dir, "Superstables-wallet-open"),
    });
    closers.push(() => wallet.close());
    const one = await fetch(`${wallet.url}/requests/${id}`, { headers: { authorization: `Bearer ${wallet.agentToken}` } });
    expect(one.status).toBe(404);
    expect(await one.json()).toEqual({ error: "no such request" });
    for (const verb of ["approve", "deny"]) {
      const decided = await fetch(`${wallet.url}/owner/requests/${id}/${verb}`, { method: "POST", headers: { authorization: `Bearer ${wallet.ownerSecret}` } });
      expect(decided.status).toBe(404);
    }
  });
});
