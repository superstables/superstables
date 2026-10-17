// `superstables owner settings sign`: the page, the server's checks and what is written. A simulated wallet plays the part
// MetaMask or Phantom play: it reads the typed data (or the text) from the page, signs it with a throwaway key and posts the
// signature back. Nothing is written unless the wallet signed exactly what the page showed.
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import bs58 from "bs58";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signOwnerSettings, type SignRail } from "../../src/cli/owner-settings-sign.js";
import { signatureLine } from "../../src/cli/owner-settings.js";
import {
  ownerPolicyPath, readOwnerSettings, settingsMessage, settingsPayload, settingsSignedAt, signedSettings,
} from "../../src/core/owner-settings.js";
import { OwnerApprovalServer } from "../../src/core/signer/owner-approval-server.js";
import { accountHomeWith } from "../helpers/owner-settings.js";

const saved = process.env.SUPERSTABLES_TEST_ACCOUNT_HOME;
const savedHome = process.env.SUPERSTABLES_HOME;
const owner = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
let account: string;
const settingsFile = () => join(account, ".superstables", "owner", "settings.json");

beforeEach(() => {
  account = accountHomeWith({ version: 1, site: { allowLoopback: true }, rpcEnv: { allowLoopback: true } });
  process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = account;
  process.env.SUPERSTABLES_HOME = join(account, ".superstables");
  mkdirSync(join(account, ".superstables", "keys", "budget"), { recursive: true, mode: 0o700 });
  writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1\n");
});
afterEach(() => {
  for (const [k, v] of [["SUPERSTABLES_TEST_ACCOUNT_HOME", saved], ["SUPERSTABLES_HOME", savedHome]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Typed = { domain: object; types: Record<string, unknown>; primaryType: string; message: Record<string, string> };
/** What a wallet does with eth_signTypedData_v4's JSON. */
function signTyped(key: typeof owner, typed: Typed): Promise<`0x${string}`> {
  const { EIP712Domain: _domain, ...types } = typed.types;
  return key.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: { ...typed.message, signedAt: BigInt(typed.message.signedAt) } } as never);
}
const origin = (url: string) => new URL(url).origin;
async function facts(url: string) {
  const html = await (await fetch(url)).text();
  const raw = /<script id="owner-facts" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1];
  return { html, facts: JSON.parse(raw) as { typedData?: string; message?: string; kind: string } };
}
const postSigned = (url: string, body: object) =>
  fetch(`${url}/signed`, { method: "POST", headers: { origin: origin(url), "content-type": "application/json" }, body: JSON.stringify(body) });

/** Runs the command with a wallet that does `act` on the page. */
function run(rail: SignRail, act: (url: string) => Promise<void>) {
  const lines: string[] = [];
  let resolveUrl!: (url: string) => void;
  const url = new Promise<string>((r) => (resolveUrl = r));
  const done = signOwnerSettings({ rail, open: (u) => resolveUrl(u), say: (l) => lines.push(l), lingerMs: 0, timeoutMs: 8_000 });
  const wallet = url.then(act);
  return { done, wallet, lines };
}

describe("an EVM wallet", () => {
  it("signs the typed data on the page, and the signature is written and reads back", async () => {
    const { done, wallet, lines } = run("evm", async (url) => {
      const { html, facts: f } = await facts(url);
      expect(f.kind).toBe("settings");
      expect(html).toContain("Sign your settings");
      expect(html).toContain("What your wallet will show");
      expect(html).toContain("none: this build signs on testnets only");
      const typed = JSON.parse(f.typedData!) as Typed;
      expect(typed.domain).toEqual({ name: "Superstables owner settings", version: "1" });
      expect(typed.domain).not.toHaveProperty("chainId");
      const signature = await signTyped(owner, typed);
      const res = await postSigned(url, { address: owner.address, signature });
      expect(res.status).toBe(200);
    });
    const result = await done;
    await wallet;
    expect(result.signer).toBe(owner.address);
    const signed = await signedSettings();
    expect(signed).toMatchObject({ valid: true, policyMatches: true, signer: owner.address, scheme: "eip712" });
    expect(lines.join("\n")).toContain("Policy:");
    expect(signatureLine(readOwnerSettings(), signed)).toBe(`signature: signed by ${owner.address} on ${signed!.signedAt!.slice(0, 10)}; policy matches`);
    writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 9\n");
    expect(signatureLine(readOwnerSettings(), await signedSettings())).toContain("policy changed since signing (sign again)");
  });

  it("writes nothing when the policy changes while the page is open", async () => {
    const before = readFileSync(settingsFile(), "utf8");
    const { done, wallet } = run("evm", async (url) => {
      const { facts: f } = await facts(url);
      const signature = await signTyped(owner, JSON.parse(f.typedData!));
      writeFileSync(ownerPolicyPath(), "caps:\n  per_call: 1000\n");
      await postSigned(url, { address: owner.address, signature });
    });
    await expect(done).rejects.toThrow(/changed while the page was open/);
    await wallet;
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
  });

  it("writes nothing when the owner rejects, and says so", async () => {
    const before = readFileSync(settingsFile(), "utf8");
    const { done, wallet } = run("evm", async (url) => {
      await fetch(`${url}/reject`, { method: "POST", headers: { origin: origin(url), "content-type": "application/json" }, body: JSON.stringify({ by: "page" }) });
    });
    await expect(done).rejects.toThrow(/Nothing was written/);
    await wallet;
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
  });
});

describe("a Solana wallet", () => {
  it("signs the fixed text, and a signature over another text is refused", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const address = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
    const sign = (text: string) => ed25519Sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
    const { done, wallet } = run("solana", async (url) => {
      const { html, facts: f } = await facts(url);
      expect(html).toContain("Seven lines of text");
      expect(f.message!.split("\n")).toHaveLength(7);
      const bad = await postSigned(url, { address, signature: sign(f.message!.replace("version 1", "version 2")), signedMessage: Buffer.from(f.message!.replace("version 1", "version 2")).toString("base64") });
      expect(bad.status).toBe(400);
      const wrongKey = await postSigned(url, { address, signature: sign("something else"), signedMessage: Buffer.from(f.message!).toString("base64") });
      expect(wrongKey.status).toBe(400);
      const good = await postSigned(url, { address, signature: sign(f.message!), signedMessage: Buffer.from(f.message!).toString("base64") });
      expect(good.status).toBe(200);
    });
    const result = await done;
    await wallet;
    expect(result.signer).toBe(address);
    expect(await signedSettings()).toMatchObject({ valid: true, scheme: "ed25519", signer: address });
  });
});

describe("the page's server", () => {
  it("refuses a signature from another account, and records nothing", async () => {
    const server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    try {
      const settings = readOwnerSettings();
      const payload = settingsPayload(settings);
      const signedAt = settingsSignedAt();
      const handle = server.request({
        kind: "settings",
        chain: { chainId: 84532, chainName: "x", rpcUrl: "https://x.example", explorer: "https://x.example", nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, testnet: true },
        terms: { title: "Sign your settings", summary: "s", rows: [], enforced: [], notEnforced: [], notes: [] },
        settingsSigning: { payload, signedAt },
        account: owner.address,
        timeoutMs: 5_000,
      });
      const { facts: f } = await facts(handle.url);
      const typed = JSON.parse(f.typedData!);
      const make = (key: typeof owner) => signTyped(key, typed);
      // another wallet signs and says so
      expect((await postSigned(handle.url, { address: other.address, signature: await make(other) })).status).toBe(403);
      // another wallet signs and claims to be the owner
      expect((await postSigned(handle.url, { address: owner.address, signature: await make(other) })).status).toBe(400);
      // the owner signs something else
      const wrong = await owner.signMessage({ message: "hello" });
      expect((await postSigned(handle.url, { address: owner.address, signature: wrong })).status).toBe(400);
      const state = (await (await fetch(`${handle.url}/state`)).json()) as { status: string; address?: string };
      expect(state).toMatchObject({ status: "pending" });
      expect(state.address).toBeUndefined();
      const outcome = await Promise.race([handle.settled, new Promise((r) => setTimeout(() => r("nothing"), 150))]);
      expect(outcome).toBe("nothing");
      // the owner's own signature is accepted, once
      expect((await postSigned(handle.url, { address: owner.address, signature: await make(owner) })).status).toBe(200);
      expect((await postSigned(handle.url, { address: owner.address, signature: await make(owner) })).status).toBe(409);
      expect(await handle.settled).toMatchObject({ status: "connected", address: owner.address });
    } finally {
      await server.close();
    }
  });
});

describe("the command", () => {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const MAIN = resolve(ROOT, "src/cli/main.ts");
  function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--import", "tsx", MAIN, "owner", "settings", ...args], { cwd: ROOT, env: { ...process.env, SUPERSTABLES_TEST_ACCOUNT_HOME: account } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += String(c)));
      child.stderr.on("data", (c) => (stderr += String(c)));
      child.once("error", fail);
      child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
      child.stdin.end("");
    });
  }

  it("sign needs the owner's own terminal and writes nothing without one", async () => {
    const before = readFileSync(settingsFile(), "utf8");
    const r = await cli(["sign"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("refused: changing the owner settings needs the owner's own terminal (stdin is not a terminal). Nothing was signed.");
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
  }, 60_000);

  it("show says unsigned, and who signed once someone did", async () => {
    expect((await cli(["show"])).stdout).toContain("signature: none");
    const { done, wallet } = run("evm", async (url) => {
      const { facts: f } = await facts(url);
      const signature = await signTyped(owner, JSON.parse(f.typedData!));
      await postSigned(url, { address: owner.address, signature });
    });
    await done;
    await wallet;
    const shown = await cli(["show"]);
    expect(shown.stdout).toContain(`signature: signed by ${owner.address} on `);
    expect(shown.stdout).toContain("; policy matches");
    const json = JSON.parse((await cli(["show", "--json"])).stdout);
    expect(json).toMatchObject({ signature: true, signedBy: owner.address, signatureValid: true, policyMatches: true });
  }, 60_000);
});
