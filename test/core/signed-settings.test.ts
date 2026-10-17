// The owner's signed settings (src/core/owner-settings.js, "Signed settings"): what is signed, whom it binds, what a changed
// policy does to `pay`, and what the chain gate reads from a signature. Signatures are made here with throwaway keys; nothing
// reaches a network.
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chainGateSettings } from "../../src/core/chain-gate.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import {
  EMPTY_HASH, canonicalJson, fileHash, ownerPolicyPath, ownerRetiredPath, parseOwnerSettings, primeSignedSettings, readOwnerSettings, requirePolicyFile,
  settingsFor, settingsHash, settingsMessage, settingsPayload, settingsSignedAt, settingsTypedData, signatureRecord, signedPolicyCheck,
  signedSettings, signedSettingsChecked, writeOwnerSettings,
} from "../../src/core/owner-settings.js";
import { judgeSignRequest } from "../../src/core/rails/index.js";
import { ApprovalServer } from "../../src/core/signer/approval-server.js";
import { BrowserWalletSigner, settingsNoteFor } from "../../src/core/signer/browser.js";
import { SignRefused, type Signer } from "../../src/core/signer/types.js";
import { accountHomeWith } from "../helpers/owner-settings.js";
import { startFacilitator, startPaidEndpoint, type TestServer } from "../helpers/servers.js";

const saved = process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
const dirs: string[] = [];
let account: string;
const owner = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());

beforeEach(() => {
  account = accountHomeWith({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true } });
  process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = account;
  mkdirSync(join(account, ".superstables", "keys", "budget"), { recursive: true, mode: 0o700 });
  writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1\n  per_day: 100\n");
});
afterEach(() => {
  if (saved === undefined) delete process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
  else process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Signs the settings as they are now with an EVM key and writes the signature into the settings file. */
async function signEvm(key = owner, enabledChains: string[] = []) {
  const settings = readOwnerSettings();
  const payload = settingsPayload(settings, { enabledChains });
  const signedAt = settingsSignedAt();
  const value = await key.signTypedData(settingsTypedData(payload, signedAt));
  writeOwnerSettings({ ...settings, signature: signatureRecord({ scheme: "eip712", signer: key.address, signedAt, payload, value }) });
  return { payload, signedAt, value };
}

function solanaKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x as string;
  return { address: bs58.encode(Buffer.from(raw, "base64url")), sign: (text: string) => ed25519Sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64") };
}

describe("the canonical hash", () => {
  it("is the same for the same settings with their keys reordered, and another for a changed RPC URL", () => {
    const a = parseOwnerSettings(JSON.stringify({ version: 1, site: { allowStaging: true }, rpc: { "base-sepolia": { urls: ["https://a.example/k", "https://b.example"], ownNode: false } }, sellers: { allowLoopback: false } }));
    const b = parseOwnerSettings(JSON.stringify({ sellers: { allowLoopback: false }, rpc: { "base-sepolia": { ownNode: false, quorum: 2, urls: ["https://a.example/k", "https://b.example"] } }, site: { allowStaging: true }, version: 1 }));
    expect(settingsHash(a)).toBe(settingsHash(b));
    expect(settingsHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const c = parseOwnerSettings(JSON.stringify({ version: 1, site: { allowStaging: true }, rpc: { "base-sepolia": { urls: ["https://a.example/other", "https://b.example"], ownNode: false } }, sellers: { allowLoopback: false } }));
    expect(settingsHash(c)).not.toBe(settingsHash(a));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it("does not depend on the signature that is stored next to the settings", async () => {
    const before = settingsHash(readOwnerSettings());
    await signEvm();
    expect(settingsHash(readOwnerSettings())).toBe(before);
  });

  it("hashes a file's bytes, and an absent file as nothing", () => {
    expect(fileHash(join(account, "nothing-here"))).toBe(EMPTY_HASH);
    expect(fileHash(ownerPolicyPath())).not.toBe(EMPTY_HASH);
    expect(() => fileHash(account)).toThrow(/not a regular file/);
  });
});

describe("verifying a signature", () => {
  it("accepts an EVM owner's EIP-712 signature, and reports a changed policy without calling the signature invalid", async () => {
    await signEvm();
    const s = await signedSettings();
    expect(s).toMatchObject({ valid: true, policyMatches: true, scheme: "eip712", signer: owner.address });
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 50\n");
    const after = await signedSettings();
    expect(after?.valid).toBe(true);
    expect(after?.policyMatches).toBe(false);
    expect(after?.why).toContain("is not the one signed");
    expect(after?.why).toContain(s!.payload!.policyHash);
  });

  it("is not valid once the settings or the retired agent keys changed", async () => {
    await signEvm();
    const raw = JSON.parse(readFileSync(join(account, ".superstables", "owner", "settings.json"), "utf8"));
    raw.site = { allowStaging: true };
    writeFileSync(join(account, ".superstables", "owner", "settings.json"), JSON.stringify(raw), { mode: 0o600 });
    const s = await signedSettings();
    expect(s?.valid).toBe(false);
    expect(s?.why).toContain("owner settings are not the ones signed");

    await signEvm();
    writeFileSync(ownerRetiredPath(), '{"version":1,"retired":[]}\n');
    expect((await signedSettings())?.valid).toBe(false);
    expect((await signedSettings())?.why).toContain("retired agent keys are not the ones signed");
  });

  it("refuses a signature from another key, a changed field, and a malformed record", async () => {
    await signEvm();
    const file = join(account, ".superstables", "owner", "settings.json");
    const good = JSON.parse(readFileSync(file, "utf8"));
    const write = (signature: unknown) => writeFileSync(file, JSON.stringify({ ...good, signature }), { mode: 0o600 });
    // the same signature, claimed by another address
    write({ ...good.signature, signer: agent.address });
    expect((await signedSettings())?.valid).toBe(false);
    // a changed enabled-chains list under the same signature
    write({ ...good.signature, payload: { ...good.signature.payload, enabledChains: ["base"] } });
    expect((await signedSettings())?.valid).toBe(false);
    // another time
    write({ ...good.signature, signedAt: "2030-01-01T00:00:00.000Z" });
    expect((await signedSettings())?.valid).toBe(false);
    // not a signature at all
    write({ ...good.signature, value: "0x1234" });
    expect((await signedSettings())?.valid).toBe(false);
    write({ scheme: "eip712" });
    expect((await signedSettings())?.why).toContain("malformed");
    write(["x"]);
    await expect(signedSettings()).rejects.toThrow(/signature must be an object/);
    write(good.signature);
    expect((await signedSettings())?.valid).toBe(true);
  });

  it("verifies a Solana signMessage over the fixed text, and nothing else", async () => {
    const key = solanaKey();
    const other = solanaKey();
    const settings = readOwnerSettings();
    const payload = settingsPayload(settings);
    const signedAt = settingsSignedAt();
    const text = settingsMessage(payload, signedAt);
    expect(text.split("\n")).toEqual([
      "Superstables owner settings, version 1",
      `Site: ${payload.site}`,
      "Chains enabled for signing: none",
      `Policy: ${payload.policyHash}`,
      `Retired agents: ${payload.retiredHash}`,
      `Settings: ${payload.settingsHash}`,
      `Signed at: ${signedAt}`,
    ]);
    const record = (over: object) => signatureRecord({ scheme: "ed25519", signer: key.address, signedAt, payload, value: key.sign(text), ...over });
    writeOwnerSettings({ ...settings, signature: record({}) });
    expect(await signedSettings()).toMatchObject({ valid: true, scheme: "ed25519", signer: key.address });
    // one changed character in the signed text
    writeOwnerSettings({ ...settings, signature: record({ value: key.sign(text.replace("version 1", "version 2")) }) });
    expect((await signedSettings())?.valid).toBe(false);
    // another key's signature under this signer
    writeOwnerSettings({ ...settings, signature: record({ value: other.sign(text) }) });
    expect((await signedSettings())?.valid).toBe(false);
    // the same signature claimed by the other key
    writeOwnerSettings({ ...settings, signature: record({ signer: other.address }) });
    expect((await signedSettings())?.valid).toBe(false);
  });
});

describe("whom the signature binds", () => {
  it("settingsFor returns the signed payload only for the wallet that signed", async () => {
    await signEvm(agent);
    expect(await settingsFor(owner.address)).toBeUndefined();
    expect(await settingsFor(agent.address.toLowerCase())).toMatchObject({ signer: agent.address });
    expect(await settingsFor("not a wallet")).toBeUndefined();
  });

  it("the agent re-signing the settings binds nothing the owner's wallet does: no policy refusal for the owner, one for the agent's own key", async () => {
    await signEvm(agent);
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 500\n");
    expect(await signedPolicyCheck(owner.address)).toEqual({});
    const forAgent = await signedPolicyCheck(agent.address);
    expect(forAgent.refuse).toContain("changed after the owner signed");
  });

  it("a signature that does not hold is treated as unsigned, with a warning, and never refuses", async () => {
    await signEvm();
    const file = join(account, ".superstables", "owner", "settings.json");
    const good = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...good, site: { allowStaging: true } }), { mode: 0o600 });
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 500\n");
    const check = await signedPolicyCheck(owner.address);
    expect(check.refuse).toBeUndefined();
    expect(check.warn).toContain("treated as unsigned");
  });
});

describe("what the approval page says about a connecting wallet", () => {
  it("shows the owner's signature as theirs only while the policy is the one signed", async () => {
    await signEvm(owner);
    expect(await settingsNoteFor(owner.address)).toMatchObject({ applies: "yours", signer: owner.address });
    expect(await settingsNoteFor(agent.address)).toMatchObject({ applies: "other" });
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 500\n");
    expect(await settingsNoteFor(owner.address)).toBeUndefined();
  });

  it("refuses in plain sentences, with no hashes", async () => {
    await signEvm(owner);
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 500\n");
    const { refuse } = await signedPolicyCheck(owner.address);
    expect(refuse).toBe("The spend policy changed after the owner signed their settings, so nothing was signed. The owner runs superstables owner settings sign to sign the policy in use.");
    expect(() => requirePolicyFile(join(account, "missing.yaml"))).toThrow(`There is no spend policy file at ${join(account, "missing.yaml")}. The owner writes one there, then signs.`);
  });
});

describe("the chain gate", () => {
  it("reads the enabled chains from a valid signature, with what each still lacks", async () => {
    expect(chainGateSettings()).toBeUndefined();
    await signEvm(owner, ["base", "arbitrum"]);
    // not checked in this process yet: not enabled
    expect(chainGateSettings()).toBeUndefined();
    await primeSignedSettings();
    const gate = chainGateSettings();
    expect(gate?.enabledChains).toEqual(["arbitrum", "base"]);
    expect(gate?.missing.base.length).toBeGreaterThan(0);
  });

  it("a forged chain list with a broken signature is not enabled", async () => {
    await signEvm(owner, []);
    const file = join(account, ".superstables", "owner", "settings.json");
    const good = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...good, signature: { ...good.signature, payload: { ...good.signature.payload, enabledChains: ["base"] } } }), { mode: 0o600 });
    await primeSignedSettings();
    expect(chainGateSettings()).toBeUndefined();
    // an unsigned list is nothing either
    const { signature: _gone, ...unsigned } = good;
    writeFileSync(file, JSON.stringify({ ...unsigned, enabledChains: ["base"] }), { mode: 0o600 });
    expect(chainGateSettings()).toBeUndefined();
  });

  it("a signature that was valid and then covered a changed file is no longer read", async () => {
    await signEvm(owner, ["base"]);
    await primeSignedSettings();
    expect(chainGateSettings()).toBeDefined();
    const file = join(account, ".superstables", "owner", "settings.json");
    const good = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...good, sellers: { allowLoopback: true } }), { mode: 0o600 });
    expect(chainGateSettings()).toBeUndefined();
    expect(signedSettingsChecked()?.valid).toBe(false);
  });
});

describe("pay and the signed policy", () => {
  const open: TestServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });

  async function run(payer: string | null, kind: "local" | "browser" = "local") {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    open.push(facilitator, seller);
    const asked: unknown[] = [];
    const signer: Signer = {
      kind,
      address: async () => {
        if (payer === null) throw new Error("this wallet has not connected yet");
        return payer;
      },
      sign: async (req) => {
        asked.push(req);
        throw new SignRefused("denied", "the test signer says no");
      },
    };
    const home = mkdtempSync(join(tmpdir(), "superstables-signed-pay-"));
    dirs.push(home);
    const records = new Records(home);
    const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer });
    const url = `${seller.url}/v1/market?asset=BTC`;
    const q = await quote({ url }, { records, policy: DEFAULT_POLICY });
    const final = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
    return { final, asked, facilitator };
  }

  it("asks the owner while the policy is the one signed", async () => {
    await signEvm();
    const { final, asked } = await run(owner.address);
    expect(asked).toHaveLength(1);
    expect(final.state).toBe("denied");
  });

  it("refuses, asking nobody, once the policy file differs from the signed one", async () => {
    await signEvm();
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const { final, asked, facilitator } = await run(owner.address);
    expect(asked).toHaveLength(0);
    expect(final.state).toBe("failed");
    expect(final.refusal).toBe("policy");
    expect(final.reason).toContain("The spend policy changed after the owner signed their settings");
    expect(final.reason).toContain("nothing was signed");
    expect(final.reason).toContain("superstables owner settings sign");
    expect(facilitator.calls.settle).toBe(0);
  });

  it("does not refuse for a wallet other than the one that signed (the agent signed with its own key)", async () => {
    await signEvm(agent);
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const { final, asked } = await run(owner.address);
    expect(asked).toHaveLength(1);
    expect(final.refusal).toBeUndefined();
    // the agent's own key is bound by what the agent signed
    const again = await run(agent.address);
    expect(again.asked).toHaveLength(0);
    expect(again.final.refusal).toBe("policy");
  });

  it("refuses when the payer is not known yet and the policy differs from the signed one", async () => {
    await signEvm();
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const { final, asked } = await run(null);
    expect(asked).toHaveLength(0);
    expect(final.refusal).toBe("policy");
    expect(final.reason).toContain("changed after the owner signed");
  });

  it("does not refuse early on the address a browser wallet remembered: the page checks the wallet that connects", async () => {
    await signEvm();
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const { final, asked } = await run(owner.address, "browser");
    expect(asked).toHaveLength(1);
    expect(final.refusal).toBeUndefined();
  });

  it("refuses a signature made over no policy file, however the agent's environment chooses the policy", async () => {
    rmSync(ownerPolicyPath());
    await signEvm();
    const looser = join(account, "looser.yaml");
    writeFileSync(looser, "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const saved = process.env.SUPERSTABLES_POLICY;
    process.env.SUPERSTABLES_POLICY = looser;
    try {
      const { final, asked } = await run(owner.address);
      expect(asked).toHaveLength(0);
      expect(final.refusal).toBe("policy");
      expect(final.reason).toContain("no spend policy file");
      expect(final.reason).toContain("The owner writes a policy file, for example with superstables policy init, then runs superstables owner settings sign.");
    } finally {
      if (saved === undefined) delete process.env.SUPERSTABLES_POLICY;
      else process.env.SUPERSTABLES_POLICY = saved;
    }
  });

  it("changes nothing when the settings are not signed", async () => {
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const { asked } = await run(owner.address);
    expect(asked).toHaveLength(1);
  });
});

describe("the approval page's row", () => {
  it("says who signed the settings, and that another wallet's do not apply", async () => {
    await signEvm(agent);
    const home = mkdtempSync(join(tmpdir(), "superstables-signed-page-"));
    dirs.push(home);
    const signer = new BrowserWalletSigner({ port: 0, home, policy: DEFAULT_POLICY, timeoutMs: 5_000, balance: false });
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    open.push(facilitator, seller);
    try {
      const { usdcRequirement } = await import("../../src/core/chain.js");
      let url = "";
      const pending = signer.sign({ kind: "eip3009", requirements: usdcRequirement(0.01, privateKeyToAccount(generatePrivateKey()).address), x402Version: 2 }, { onPending: (_id, u) => { url = u ?? ""; } }).catch(() => undefined);
      while (!url) await new Promise((r) => setTimeout(r, 10));
      const post = async (address: string) => {
        const res = await fetch(`${url}/account`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: JSON.stringify({ address }) });
        const body = (await res.json()) as { signedSettings?: { applies: string; signer: string } };
        if (res.status !== 200) throw new Error(`${res.status} ${JSON.stringify(body)}`);
        return body;
      };
      expect((await post(owner.address)).signedSettings).toMatchObject({ applies: "other", signer: agent.address });
      expect((await post(agent.address)).signedSettings).toMatchObject({ applies: "yours", signer: agent.address });
      const html = await (await fetch(url)).text();
      expect(html).toContain('id="settings-note"');
      await fetch(`${url}/reject`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: "{}" });
      await pending;
    } finally {
      await signer.close();
    }
  });

  it("refuses the wallet that signed once the policy differs, even when another wallet was remembered, and shows no signature row", async () => {
    await signEvm(owner);
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n  per_day: 100000\n");
    const home = mkdtempSync(join(tmpdir(), "superstables-signed-page-"));
    dirs.push(home);
    // the address remembered from an earlier payment is another wallet's: it is only a hint
    writeFileSync(join(home, "browser-wallet.json"), `${JSON.stringify({ address: agent.address, connectedAt: new Date().toISOString() })}\n`);
    const signer = new BrowserWalletSigner({ port: 0, home, policy: DEFAULT_POLICY, timeoutMs: 5_000, balance: false });
    try {
      const { usdcRequirement } = await import("../../src/core/chain.js");
      let url = "";
      const pending = signer.sign({ kind: "eip3009", requirements: usdcRequirement(0.01, privateKeyToAccount(generatePrivateKey()).address), x402Version: 2 }, { onPending: (_id, u) => { url = u ?? ""; } }).then(() => "signed", (e: Error) => e.message);
      while (!url) await new Promise((r) => setTimeout(r, 10));
      const res = await fetch(`${url}/account`, { method: "POST", headers: { origin: new URL(url).origin, "content-type": "application/json" }, body: JSON.stringify({ address: owner.address }) });
      const body = (await res.json()) as { error?: string; signedSettings?: unknown };
      expect(res.status).toBe(409);
      expect(body.error).toContain("The spend policy changed after the owner signed their settings");
      expect(body.signedSettings).toBeUndefined();
      expect(await pending).toContain("changed after the owner signed");
    } finally {
      await signer.close();
    }
  });

  it("prepares nothing when the approval ended while the connecting wallet was being checked", async () => {
    const { usdcRequirement } = await import("../../src/core/chain.js");
    const judged = judgeSignRequest({ kind: "eip3009", requirements: usdcRequirement(0.01, privateKeyToAccount(generatePrivateKey()).address), x402Version: 2 });
    if (!judged.supported) throw new Error(judged.reason);
    let checked!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((r) => { checked = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let noted = 0;
    const home = mkdtempSync(join(tmpdir(), "superstables-signed-page-"));
    dirs.push(home);
    const server = new ApprovalServer({
      port: 0,
      recordsDirPath: join(home, "records"),
      accountRefusal: async () => {
        checked();
        await gate;
        return undefined;
      },
      settingsNote: async () => {
        noted += 1;
        return undefined;
      },
    });
    await server.start();
    const handle = server.request({ kind: "eip3009", verified: { ...judged.offer.terms, payer: "" }, requirement: judged.offer.requirement, x402Version: 2, timeoutMs: 60_000 });
    const answered = fetch(`${handle.url}/account`, { method: "POST", headers: { origin: new URL(handle.url).origin, "content-type": "application/json" }, body: JSON.stringify({ address: owner.address }) }).then(
      (res) => res.status,
      () => "closed",
    );
    await seen;
    // the process serving the page stops while the check waits: the approval ends as abandoned
    const closing = server.close();
    release();
    await closing;
    expect(await answered).not.toBe(200);
    expect(await handle.settled).toMatchObject({ status: "abandoned" });
    // let the handler finish: a prepare would have answered 200 and asked for the settings note
    await new Promise((r) => setTimeout(r, 100));
    expect(noted).toBe(0);
  });

  const open: TestServer[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => s.close()));
  });
});

describe("signing needs an account policy file", () => {
  it("refuses to sign while the file is absent, and tells the owner to create it", async () => {
    const { signOwnerSettings } = await import("../../src/cli/owner-settings-sign.js");
    rmSync(ownerPolicyPath());
    await expect(signOwnerSettings({ rail: "evm", open: () => undefined, say: () => undefined, timeoutMs: 1_000 })).rejects.toThrow(/superstables policy init/);
    expect(readOwnerSettings().signature).toBeUndefined();
  });
});
