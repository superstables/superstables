// The local wallet and the owner's signed settings: its settings card signs with the wallet's own key, and it refuses to sign
// a payment once the policy file differs from the one signed. Over HTTP on a throwaway loopback port, with a throwaway key.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import {
  readOwnerSettings, settingsPayload, settingsSignedAt, settingsTypedData, signatureRecord, signedSettings, writeOwnerSettings,
} from "../../src/core/owner-settings.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { OWNER_PAGE_SCRIPT } from "../../src/core/signer/owner-approval-page.js";
import { WALLET_PAGE_SCRIPT, walletPage } from "../../src/wallet/page.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

const PAYEE = "0x2222222222222222222222222222222222222222";
const ROOMY = "caps:\n  per_call: 1\n  per_day: 100\n";
const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
const wallets: WalletHandle[] = [];

beforeEach(() => {
  for (const name of ["SUPERSTABLES_TEST_ACCOUNT_HOME", "SUPERSTABLES_HOME", "SUPERSTABLES_POLICY"]) saved[name] = process.env[name];
  process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = accountHomeWith({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true } });
  const home = mkdtempSync(join(tmpdir(), "superstables-signed-daemon-home-"));
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
  const dir = mkdtempSync(join(tmpdir(), "superstables-signed-daemon-"));
  dirs.push(dir);
  const policyFile = join(dir, "account-policy.yaml");
  writeFileSync(policyFile, ROOMY);
  process.env.SUPERSTABLES_POLICY = policyFile;
  const key = privateKeyToAccount(generatePrivateKey());
  const wallet = await startWallet({ port: 0, tcp: true, dir, account: key, policyFile, accountPolicyFile: policyFile, quiet: true, openBrowser: false, balance: false, launcherDir: join(dir, "open") });
  wallets.push(wallet);
  return { wallet, policyFile, key };
}

const call = (w: WalletHandle, path: string, token: string, method = "GET", body?: unknown) =>
  fetch(`${w.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

async function pending(w: WalletHandle): Promise<string> {
  const res = await call(w, "/requests", w.agentToken, "POST", { sign: { kind: "eip3009", x402Version: 2, requirements: usdcRequirement(0.01, PAYEE), context: { target: "https://seller.example/x" } } });
  const v = (await res.json()) as WalletRequestView;
  expect(v.status).toBe("pending");
  return v.id;
}
async function approve(w: WalletHandle, id: string) {
  const list = (await (await call(w, "/owner/requests", w.ownerSecret)).json()) as { requests: WalletRequestView[] };
  const shown = list.requests.find((r) => r.id === id)!.verified;
  return call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST", { amountAtomic: shown.amountAtomic, recipient: shown.recipient, network: shown.network });
}
async function cardView(w: WalletHandle) {
  return (await (await call(w, "/owner/settings", w.ownerSecret)).json()) as { preview: { settingsHash: string; policyHash: string; retiredHash: string }; signed: null | { signer: string; valid: boolean; policyMatches: boolean; thisWallet: boolean } };
}

describe("the settings card signs with the wallet's own key", () => {
  it("shows unsigned settings, signs what the card showed, and then shows who signed", async () => {
    const { wallet, key } = await start();
    const before = await cardView(wallet);
    expect(before.signed).toBeNull();
    const done = await call(wallet, "/owner/settings/sign", wallet.ownerSecret, "POST", before.preview);
    expect(done.status).toBe(200);
    const after = await cardView(wallet);
    expect(after.signed).toMatchObject({ signer: key.address, valid: true, policyMatches: true, thisWallet: true });
    expect(await signedSettings({ policyPath: undefined })).toMatchObject({ signer: key.address });
  });

  it("signs nothing when the policy changed after the card was drawn, or the confirmation is missing", async () => {
    const { wallet, policyFile } = await start();
    const shown = (await cardView(wallet)).preview;
    writeFileSync(policyFile, "caps:\n  per_call: 99\n");
    const stale = await call(wallet, "/owner/settings/sign", wallet.ownerSecret, "POST", shown);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain("not what the card showed");
    expect((await call(wallet, "/owner/settings/sign", wallet.ownerSecret, "POST", {})).status).toBe(409);
    expect((await cardView(wallet)).signed).toBeNull();
  });

  it("is the owner's: the agent token cannot read or sign", async () => {
    const { wallet } = await start();
    expect((await call(wallet, "/owner/settings", wallet.agentToken)).status).toBe(403);
    expect((await call(wallet, "/owner/settings/sign", wallet.agentToken, "POST", {})).status).toBe(403);
  });
});

describe("approving after a policy edit", () => {
  it("signs while the policy is the one signed, and refuses once it was edited, serving nothing", async () => {
    const { wallet, policyFile } = await start();
    await call(wallet, "/owner/settings/sign", wallet.ownerSecret, "POST", (await cardView(wallet)).preview);
    const first = await pending(wallet);
    expect((await approve(wallet, first)).status).toBe(200);

    const second = await pending(wallet);
    writeFileSync(policyFile, "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const res = await approve(wallet, second);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("The spend policy changed after the owner signed their settings");
    const after = (await (await call(wallet, `/requests/${second}`, wallet.agentToken)).json()) as WalletRequestView;
    expect(after.status).toBe("rejected");
    expect(after.result).toBeUndefined();
  });

  it("is not bound by settings another wallet's key signed", async () => {
    const { wallet, policyFile } = await start();
    const other = privateKeyToAccount(generatePrivateKey());
    const settings = readOwnerSettings();
    const payload = settingsPayload(settings, { policyPath: policyFile });
    const signedAt = settingsSignedAt();
    writeOwnerSettings({ ...settings, signature: signatureRecord({ scheme: "eip712", signer: other.address, signedAt, payload, value: await other.signTypedData(settingsTypedData(payload, signedAt)) }) });
    const id = await pending(wallet);
    writeFileSync(policyFile, "caps:\n  per_call: 1000\n  per_day: 100000\n");
    expect((await approve(wallet, id)).status).toBe(200);
  });
});

describe("signing needs an account policy file", () => {
  it("refuses to sign while the file is absent, and the card says why", async () => {
    const { wallet, policyFile } = await start();
    const shown = (await cardView(wallet)).preview;
    rmSync(policyFile);
    const res = await call(wallet, "/owner/settings/sign", wallet.ownerSecret, "POST", shown);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("superstables policy init");
    expect(readOwnerSettings().signature).toBeUndefined();
    expect(((await cardView(wallet)) as unknown as { problem: string }).problem).toContain("superstables policy init");
  });
});

describe("the pages' scripts", () => {
  it("parse, and the wallet page carries the settings card", () => {
    expect(() => new Function(WALLET_PAGE_SCRIPT)).not.toThrow();
    expect(() => new Function(OWNER_PAGE_SCRIPT)).not.toThrow();
    const html = walletPage();
    expect(html).toContain('id="settings-card"');
    expect(html).toContain("Sign these settings with this wallet");
  });
});
