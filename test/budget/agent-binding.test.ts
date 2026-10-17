// The agent address an owner plan names is the one the owner signed for. Setup keeps the text the owner's wallet signed and the
// signature; grant, fund-agent and recover check them, the agent key file on this machine and the retired list before they build
// anything. Unit tests of budget/owner-binding.mjs, then the real dispatcher and rail scripts against fake chains on 127.0.0.1.
// No network, no real key.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { endpointTree, type EndpointTree } from "../helpers/endpoint-tree.js";
import { startFakeSolana, startFakeTempo, type FakeSolana, type FakeTempo } from "../helpers/fake-chains.js";
import { evmOwner, evmOwnerKey, linkProofText, signLinkProof, solanaOwner, solanaOwnerKeypair, startFakeRpc, startFakeSite, type FakeSite } from "../helpers/fake-site.js";
import type { TestServer } from "../helpers/servers.js";
import { OwnerApprovalServer, signInMessage } from "../../src/core/signer/owner-approval-server.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = resolve(ROOT, "budget/cli.mjs");
const DEAD = "0x000000000000000000000000000000000000dEaD";

// retired.mjs reads the keys folder at import: point it at a scratch home first
const unitHome = mkdtempSync(join(tmpdir(), "ss-binding-unit-"));
process.env.SUPERSTABLES_HOME = unitHome;
const binding = await import("../../budget/owner-binding.mjs");
const { agentBinding, bindingLines, setupKeys, signLocalBinding, signedNames, localSetupMessage, legacyWarning, hostedFlags, SETUP_KEYS } = binding as any;
afterAll(() => rmSync(unitHome, { recursive: true, force: true }));

const ownerKey = evmOwnerKey("22");
const owner = privateKeyToAccount(ownerKey);
const agentA = privateKeyToAddress(evmOwnerKey("44"));
const agentB = privateKeyToAddress(evmOwnerKey("55"));
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const pubOf = (o: string, a: string, lines: Record<string, string> = {}) => ({ owner: o, agent: a, lines });
const linesFor = async (text: string, key = ownerKey, at = "2026-10-16T10:00:00.000Z") => bindingLines({ message: text, signature: await privateKeyToAccount(key).signMessage({ message: text }), signedAt: new Date(at) });
const retiredFile = join(unitHome, "keys", "budget", "retired.json");
beforeEach(() => rmSync(retiredFile, { force: true }));

describe("owner-binding: the local sign-in text", () => {
  const text = (agent: string) => localSetupMessage(agent, "Base Sepolia (testnet)", "0123456789abcdef0123456789abcdef");

  it("a text for agent A signed by owner O is signed", async () => {
    const lines = await linesFor(text(agentA));
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines), { file: "F" })).toEqual({ state: "signed", kind: "local", signedAt: "2026-10-16T10:00:00.000Z" });
    expect(Object.keys(lines)).toEqual(SETUP_KEYS);
  });

  it("the same text with agent B in the public file is refused", async () => {
    const lines = await linesFor(text(agentA));
    expect(await agentBinding("evm", pubOf(owner.address, agentB, lines))).toEqual({ state: "refused", problem: `the owner signed for agent ${agentA}, not ${agentB}` });
  });

  it("a signature by another key is refused", async () => {
    const lines = await linesFor(text(agentA), evmOwnerKey("66"));
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines))).toEqual({ state: "refused", problem: `the setup signature was not made by the owner ${owner.address}` });
  });

  it("a deleted signature line is refused, never legacy", async () => {
    const lines = await linesFor(text(agentA));
    delete (lines as any).SETUP_SIGNATURE;
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines), { file: "F" })).toEqual({ state: "refused", problem: "the owner's setup signature in F is incomplete" });
  });

  it("a signed-at that is not a date is refused as incomplete", async () => {
    const lines = { ...(await linesFor(text(agentA))), SETUP_SIGNED_AT: "yesterday" };
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines), { file: "F" })).toMatchObject({ state: "refused", problem: "the owner's setup signature in F is incomplete" });
  });

  it("the message re-encoded with a trailing newline is refused", async () => {
    const lines = await linesFor(text(agentA));
    const tampered = { ...lines, SETUP_MESSAGE: b64(`${text(agentA)}\n`) };
    expect(await agentBinding("evm", pubOf(owner.address, agentA, tampered), { file: "F" })).toEqual({ state: "refused", problem: "the owner's setup signature in F is not a setup text this client knows" });
  });

  it("a 3 KiB message is refused", async () => {
    const big = `${text(agentA)}${" ".repeat(3072)}`;
    const lines = await linesFor(big);
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines), { file: "F" })).toMatchObject({ state: "refused", problem: "the owner's setup signature in F is not a setup text this client knows" });
  });

  it("an address that differs only in case is the same agent on evm", async () => {
    const lines = await linesFor(text(agentA));
    expect((await agentBinding("evm", pubOf(owner.address.toLowerCase(), agentA.toLowerCase(), lines))).state).toBe("signed");
  });
});

describe("owner-binding: the site's owner proof", () => {
  const facts = (o: string, a: string, rail = "evm") => ({ site: "https://staging.superstables.com", owner: o, agent: a, rail, chain: "base-sepolia", linkId: "bl_test0001", code: "ABC-DEF" });

  it("a hosted v1 text is signed", async () => {
    const proof = await signLinkProof(facts(owner.address, agentA));
    const lines = bindingLines({ message: proof.message, signature: proof.signature });
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines))).state).toBe("signed");
  });

  it("the owner line names O, the public file says P, the signature is by O: refused naming O", async () => {
    const other = evmOwner("33");
    const proof = await signLinkProof(facts(owner.address, agentA));
    const lines = bindingLines({ message: proof.message, signature: proof.signature });
    expect(await agentBinding("evm", pubOf(other, agentA, lines))).toEqual({ state: "refused", problem: `the owner's signature names the owner ${owner.address}, not ${other}` });
  });

  it("a rail: tempo text on an evm file is refused", async () => {
    const proof = await signLinkProof(facts(owner.address, agentA, "tempo"));
    const lines = bindingLines({ message: proof.message, signature: proof.signature });
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines))).toEqual({ state: "refused", problem: "the owner's signature is for the tempo rail, not evm" });
  });

  it("a hosted v2 text (nine lines) is signed; a v2 title without the account line is refused", async () => {
    const v1 = linkProofText(facts(owner.address, agentA));
    const v2 = v1.replace("Superstables: add an agent to my account", "Superstables: add an agent to my account (v2)");
    const withAccount = `${v2}\naccount: 5b1f2f6e-0b51-4a8a-9d41-6b1d4a9c0a11`;
    expect((await agentBinding("evm", pubOf(owner.address, agentA, await linesFor(withAccount)))).state).toBe("signed");
    expect(signedNames("evm", withAccount)).toMatchObject({ kind: "hosted", version: 2, agent: agentA });
    expect(signedNames("evm", v2)).toBeNull();
    expect((await agentBinding("evm", pubOf(owner.address, agentA, await linesFor(v2)), { file: "F" })).state).toBe("refused");
  });

  it("a text with a line before, after or between is not known", () => {
    const v1 = linkProofText(facts(owner.address, agentA));
    expect(signedNames("evm", `${v1}\nextra: 1`)).toBeNull();
    expect(signedNames("evm", `note\n${v1}`)).toBeNull();
    expect(signedNames("evm", v1.replace("\nrail: evm", ""))).toBeNull();
    expect(signedNames("evm", v1)).toMatchObject({ kind: "hosted", agent: agentA, rail: "evm" });
  });
});

describe("owner-binding: solana and tempo", () => {
  const kp = solanaOwnerKeypair(4);
  const agentSol = solanaOwner(5);

  it("solana: an ed25519 signature over a local text is signed; another keypair or a 63-byte signature is refused", async () => {
    const signed = await signLocalBinding("solana", kp.secretKey, agentSol, "Solana devnet (testnet)");
    const lines = bindingLines(signed);
    expect(lines.SETUP_SIGNATURE).toMatch(/^0x[0-9a-f]{128}$/);
    expect((await agentBinding("solana", pubOf(kp.publicKey.toBase58(), agentSol, lines))).state).toBe("signed");
    const other = await signLocalBinding("solana", solanaOwnerKeypair(9).secretKey, agentSol, "Solana devnet (testnet)");
    expect((await agentBinding("solana", pubOf(kp.publicKey.toBase58(), agentSol, bindingLines(other)))).state).toBe("refused");
    const short = { ...lines, SETUP_SIGNATURE: lines.SETUP_SIGNATURE.slice(0, -2) };
    expect(await agentBinding("solana", pubOf(kp.publicKey.toBase58(), agentSol, short), { file: "F" })).toEqual({ state: "refused", problem: `the setup signature was not made by the owner ${kp.publicKey.toBase58()}` });
  });

  it("solana: a base58 agent address compares exactly", async () => {
    const signed = await signLocalBinding("solana", kp.secretKey, agentSol, "Solana devnet (testnet)");
    expect((await agentBinding("solana", pubOf(kp.publicKey.toBase58(), agentSol.toLowerCase(), bindingLines(signed)))).state).toBe("refused");
  });

  it("tempo label 2: AGENT2_SETUP_* bind AGENT2_ADDRESS, and the primary's lines do not", async () => {
    expect(setupKeys("2")).toEqual(["AGENT2_SETUP_MESSAGE", "AGENT2_SETUP_SIGNATURE", "AGENT2_SETUP_SIGNED_AT"]);
    const signed = await signLocalBinding("tempo", ownerKey, agentA, "Tempo Testnet (Moderato)");
    const two = bindingLines(signed, "2");
    expect(Object.keys(two)).toEqual(setupKeys("2"));
    expect((await agentBinding("tempo", pubOf(owner.address, agentA, two), { label: "2" })).state).toBe("signed");
    // the primary's lines name another agent: for label 2 the file has no lines of its own, so it is legacy, not signed
    const primary = bindingLines(await signLocalBinding("tempo", ownerKey, agentB, "Tempo Testnet (Moderato)"));
    expect(await agentBinding("tempo", pubOf(owner.address, agentA, primary), { label: "2", testnet: true })).toEqual({ state: "legacy" });
  });
});

describe("owner-binding: a local text belongs to its rail", () => {
  const evmText = localSetupMessage(agentA, "Base Sepolia (testnet)");
  const tempoText = localSetupMessage(agentA, "Tempo Testnet (Moderato)");
  const wrongRail = (rail: string) => ({ state: "refused", problem: `the owner's signature is for another rail, not ${rail}` });

  it("an evm text signed by the owner of a tempo file is refused, for the primary key and for a label", async () => {
    const primary = await linesFor(evmText);
    expect(await agentBinding("tempo", pubOf(owner.address, agentA, primary))).toEqual(wrongRail("tempo"));
    const labelled = bindingLines({ message: evmText, signature: await owner.signMessage({ message: evmText }) }, "7");
    expect(await agentBinding("tempo", pubOf(owner.address, agentA, labelled), { label: "7" })).toEqual(wrongRail("tempo"));
  });

  it("a tempo text on an evm file is refused; each rail accepts its own text", async () => {
    expect(await agentBinding("evm", pubOf(owner.address, agentA, await linesFor(tempoText)))).toEqual(wrongRail("evm"));
    expect((await agentBinding("evm", pubOf(owner.address, agentA, await linesFor(evmText)))).state).toBe("signed");
    expect((await agentBinding("tempo", pubOf(owner.address, agentA, await linesFor(tempoText)))).state).toBe("signed");
  });

  it("a solana text on an evm file or an evm text on a solana file is refused", async () => {
    const kp = solanaOwnerKeypair(4);
    const sol = solanaOwner(5);
    const solText = await signLocalBinding("solana", kp.secretKey, sol, "Solana devnet (testnet)");
    expect((await agentBinding("solana", pubOf(kp.publicKey.toBase58(), sol, bindingLines(solText)))).state).toBe("signed");
    const asEvm = await signLocalBinding("solana", kp.secretKey, sol, "Base Sepolia (testnet)");
    expect(await agentBinding("solana", pubOf(kp.publicKey.toBase58(), sol, bindingLines(asEvm)))).toEqual(wrongRail("solana"));
    const asSolana = await signLocalBinding("evm", ownerKey, agentA, "Solana devnet (testnet)");
    expect(await agentBinding("evm", pubOf(owner.address, agentA, bindingLines(asSolana)))).toEqual(wrongRail("evm"));
  });
});

describe("owner-binding: legacy, retired and the key file", () => {
  it("a file with none of the lines is legacy", async () => {
    expect(await agentBinding("evm", pubOf(owner.address, agentA, { B4_CAP: "1" }), { testnet: true })).toEqual({ state: "legacy" });
  });

  it("a file without the signature is refused on a chain not marked testnet, and when the option is left out", async () => {
    const refusal = { state: "refused", problem: `F has no owner signature naming agent ${agentA}, and only testnets accept such files` };
    expect(await agentBinding("evm", pubOf(owner.address, agentA, { B4_CAP: "1" }), { file: "F", testnet: false })).toEqual(refusal);
    expect(await agentBinding("evm", pubOf(owner.address, agentA, { B4_CAP: "1" }), { file: "F" })).toEqual(refusal);
    // a signed file does not depend on the flag
    const lines = await linesFor(localSetupMessage(agentA, "Base Sepolia (testnet)"));
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines), { testnet: false })).state).toBe("signed");
  });

  it("retiredOk skips the retired list and nothing else", async () => {
    const lines = await linesFor(localSetupMessage(agentA, "Base Sepolia (testnet)"));
    mkdirSync(join(unitHome, "keys", "budget"), { recursive: true });
    writeFileSync(retiredFile, JSON.stringify({ version: 1, retired: [{ rail: "evm", address: agentA, retiredAt: "2026-10-01T00:00:00.000Z", reason: "rotate" }] }));
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines), { retiredOk: true })).state).toBe("signed");
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines))).state).toBe("refused");
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines), { retiredOk: true, keyAgent: agentB })).state).toBe("refused");
    expect((await agentBinding("evm", pubOf(evmOwner("33"), agentA, lines), { retiredOk: true })).state).toBe("refused");
  });

  it("the hosted words: a hosted file's warning and fix name setup --hosted --site", () => {
    expect(hostedFlags({ APPROVALS: "hosted", SITE: "http://127.0.0.1:4000" })).toBe(" --hosted --site http://127.0.0.1:4000");
    expect(hostedFlags({ APPROVALS: "hosted" })).toBe("");
    expect(hostedFlags({ SITE: "http://127.0.0.1:4000" })).toBe("");
    expect(legacyWarning("evm", "F", agentA, hostedFlags({ APPROVALS: "hosted", SITE: "http://127.0.0.1:4000" }))).toContain("run superstables budget setup --rail evm --hosted --site http://127.0.0.1:4000 again");
  });

  it("a retired agent is refused even with a valid signature; a retired.json that is not JSON is refused", async () => {
    const lines = await linesFor(localSetupMessage(agentA, "Base Sepolia (testnet)"));
    mkdirSync(join(unitHome, "keys", "budget"), { recursive: true });
    writeFileSync(retiredFile, JSON.stringify({ version: 1, retired: [{ rail: "evm", address: agentA, retiredAt: "2026-10-01T00:00:00.000Z", reason: "rotate" }] }));
    const r = await agentBinding("evm", pubOf(owner.address, agentA, lines));
    expect(r.state).toBe("refused");
    expect(r.problem).toContain(`agent ${agentA} was retired by \`budget rotate\``);
    writeFileSync(retiredFile, "not json");
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines))).toMatchObject({ state: "refused", problem: expect.stringContaining("cannot be read") });
  });

  it("the key on this machine, B, against a public file naming A is refused; with no key file here the check is skipped", async () => {
    const lines = await linesFor(localSetupMessage(agentA, "Base Sepolia (testnet)"));
    expect(await agentBinding("evm", pubOf(owner.address, agentA, lines), { keyAgent: agentB, file: "F" })).toEqual({ state: "refused", problem: `the agent key on this machine is ${agentB}, but F names ${agentA}` });
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines), { keyAgent: null })).state).toBe("signed");
    expect((await agentBinding("evm", pubOf(owner.address, agentA, lines), { keyAgent: agentA.toLowerCase() })).state).toBe("signed");
    expect(await agentBinding("evm", pubOf(owner.address, agentA), { keyAgent: agentB, file: "F" })).toMatchObject({ state: "refused" });
  });

  it("the legacy warning is one line", () => {
    const w = legacyWarning("evm", "F", agentA, " --chain arc-testnet");
    expect(w).toBe(`warning: F has no owner signature naming agent ${agentA} (it was set up before this check existed). Testnet goes on; run superstables budget setup --rail evm --chain arc-testnet again, where the agent key is, to record one.`);
    expect(w).not.toContain("\n");
  });

  it("signLocalBinding builds the text signInMessage builds, for the same approval id", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const signIn = `Superstables budget: record this wallet as the owner of agent ${agentA} on Base Sepolia (testnet).`;
    expect(localSetupMessage(agentA, "Base Sepolia (testnet)", id)).toBe(signInMessage(signIn, id));
    const signed = await signLocalBinding("evm", ownerKey, agentA, "Base Sepolia (testnet)");
    expect(signed.message).toMatch(/\n\nApproval id: [0-9a-f]{32}\n/);
    expect(signedNames("evm", signed.message)).toEqual({ kind: "local", agent: agentA, chain: "Base Sepolia (testnet)" });
  });
});

describe("the owner page carries the signature out", () => {
  const servers: OwnerApprovalServer[] = [];
  afterEach(async () => { while (servers.length) await servers.pop()!.close(); });
  const post = async (url: string, body: unknown) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) })).status;
  const action = (chain: any) => ({
    kind: "connect" as const, chain, terms: { title: "Connect your wallet", summary: "s", rows: [], enforced: [], notEnforced: [], notes: [] },
    signIn: "Superstables budget: record this wallet as the owner of agent X on Y.", timeoutMs: 5_000,
  });

  it("evm: the outcome holds the exact text and the signature the page posted", async () => {
    const server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    servers.push(server);
    const handle = server.request(action({ chainId: 84532, chainName: "Base Sepolia", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, testnet: true }));
    const message = signInMessage(action(null).signIn, handle.id);
    const signature = await owner.signMessage({ message });
    expect(await post(`${handle.url}/connect`, { address: owner.address, signature })).toBe(200);
    expect(await handle.settled).toEqual({ status: "connected", address: owner.address, proof: { message, signature } });
  });

  it("solana: the signature is stored as 0x hex of the 64 bytes the wallet signed", async () => {
    const server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    servers.push(server);
    const kp = solanaOwnerKeypair(4);
    const chain = { family: "solana" as const, chainId: 0, chainName: "Solana devnet", rpcUrl: "https://api.devnet.solana.com", explorer: "https://explorer.solana.com", explorerQuery: "?cluster=devnet", walletChain: "solana:devnet", nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 }, testnet: true };
    const handle = server.request(action(chain));
    const message = signInMessage(action(null).signIn, handle.id);
    const { sign } = await import("node:crypto");
    const { createPrivateKey } = await import("node:crypto");
    const seed = Buffer.from(kp.secretKey).subarray(0, 32);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const sig = sign(null, Buffer.from(message), key);
    expect(await post(`${handle.url}/connect`, { address: kp.publicKey.toBase58(), signature: sig.toString("base64"), signedMessage: Buffer.from(message).toString("base64") })).toBe(200);
    expect(await handle.settled).toEqual({ status: "connected", address: kp.publicKey.toBase58(), proof: { message, signature: `0x${sig.toString("hex")}` } });
  });
});

// ---- the rail scripts, spawned -------------------------------------------------------------------------------------------------

let home: string;
let site: FakeSite;
let rpc: TestServer;
let solana: FakeSolana;
let tempo: FakeTempo;
// a grant is asked for only when the endpoints agree the allowance is 0 at a final block: the copy names the fake RPC as two operators
let tree: EndpointTree;
beforeAll(() => { tree = endpointTree(); });
afterAll(() => tree.close());
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "ss-binding-"));
  site = await startFakeSite();
  rpc = await startFakeRpc(84532);
  solana = await startFakeSolana();
  tempo = await startFakeTempo();
});
afterEach(async () => {
  await site.close();
  await rpc.close();
  await solana.close();
  await tempo.close();
  rmSync(home, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string; result: any; approve: any };
let lastPage = "";
const pages: Promise<unknown>[] = [];
function budget(args: string[], extraEnv: Record<string, string> = {}): Promise<Out> {
  let seenPage = false;
  return new Promise((done, fail) => {
    const env: Record<string, string | undefined> = { ...process.env, SUPERSTABLES_HOME: home, B4_RPC: rpc.url, SUPERSTABLES_TEMPO_RPC: tempo.url, SUPERSTABLES_SOLANA_RPC: solana.url };
    delete env.SUPERSTABLES_SITE;
    delete env.SUPERSTABLES_BUDGET_APPROVAL_ID;
    Object.assign(env, extraEnv);
    tree.set({ "base-sepolia": [{ url: rpc.url, operator: "fake-a" }, { url: `${rpc.url}/`, operator: "fake-b" }] });
    const child = spawn(process.execPath, [resolve(tree.root, "budget/cli.mjs"), ...args], { cwd: tree.root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += String(c);
      // the page of a setup is read while it is open
      const m = args[0] === "setup" && !seenPage ? stdout.match(/^APPROVE (\{.*\})$/m) : null;
      if (m) {
        seenPage = true;
        try { const u = JSON.parse(m[1]).url as string; pages.push(fetch(u).then((r) => r.text()).then((t) => fetch(`${u.replace(/\/$/, "")}/state`).then((r) => r.text()).catch(() => "").then((s) => { lastPage = `${t}\n${s}`; })).catch(() => undefined)); } catch { /* not JSON */ }
      }
      // a page that opened is the failure on the base: stop waiting for its timeout
      if (args[0] !== "setup" && /^APPROVE /m.test(stdout)) setTimeout(() => child.kill("SIGKILL"), 300);
    });
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", async (code) => {
      await Promise.all(pages.splice(0));
      const line = (p: string) => stdout.split("\n").reverse().find((l) => l.startsWith(p));
      const parse = (p: string) => { const l = line(p); try { return l ? JSON.parse(l.slice(p.length)) : null; } catch { return null; } };
      done({ code: code ?? 0, stdout, stderr, result: parse("RESULT "), approve: parse("APPROVE ") });
    });
  });
}
const write = (path: string, text: string, mode = 0o600) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text, { mode }); };
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const edit = (path: string, from: RegExp, to: string) => write(path, read(path).replace(from, to), 0o644);

const evmPublic = () => join(home, "budget", "public", "evm-base-sepolia.env");
const evmAgent = () => join(home, "keys", "budget", "evm-agent.env");
const evmOwnerFile = () => { const p = join(home, "owner-evm.env"); write(p, `B4_OWNER_KEY=${ownerKey}\n`); return p; };
const evmSetup = async () => {
  const out = await budget(["setup", "--rail", "evm", "--owner-key-file", evmOwnerFile()]);
  expect(out.code, out.stdout + out.stderr).toBe(0);
  return out;
};
/** A file the way 0.4.0 wrote it: owner and agent, no signature. */
const legacyEvm = (agent: string) => {
  write(evmAgent(), `B4_AGENT_KEY=${evmOwnerKey("44")}\nB4_AGENT_ADDRESS=${agent}\n`);
  write(evmPublic(), `# Base Sepolia public state\nB4_OWNER_ADDRESS=${owner.address}\nB4_AGENT_ADDRESS=${agent}\n`, 0o644);
};
const noApprove = (out: Out) => expect(out.stdout).not.toMatch(/^APPROVE /m);
const said = (out: Out) => `${out.stdout}\n${out.stderr}`;

describe("evm: the PoC and its neighbours", () => {
  it("setup keeps the owner's signed text and signature; the file then verifies", async () => {
    await evmSetup();
    const text = read(evmPublic());
    expect(text).toMatch(/^SETUP_MESSAGE=[A-Za-z0-9_-]+$/m);
    expect(text).toMatch(/^SETUP_SIGNATURE=0x[0-9a-f]{130}$/m);
    expect(text).toMatch(/^SETUP_SIGNED_AT=\d{4}-\d\d-\d\dT/m);
    const agent = text.match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];
    const lines = Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect((await agentBinding("evm", pubOf(owner.address, agent, lines))).state).toBe("signed");
  }, 60_000);

  it("an edited B4_AGENT_ADDRESS, the agent key file here: grant is refused before any page", async () => {
    await evmSetup();
    const agent = read(evmPublic()).match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];
    edit(evmPublic(), /^B4_AGENT_ADDRESS=.*$/m, `B4_AGENT_ADDRESS=${DEAD}`);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    noApprove(out);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result).toMatchObject({ state: "refused_precheck" });
    expect(said(out)).toContain(`REFUSED: the agent key on this machine is ${agent}, but ${evmPublic()} names ${DEAD}`);
    expect(said(out)).toContain("Nothing was asked or sent.");
  }, 60_000);

  it("the same edit with the agent key file moved away, as on an owner machine: refused because the signature names the original agent", async () => {
    await evmSetup();
    const agent = read(evmPublic()).match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];
    edit(evmPublic(), /^B4_AGENT_ADDRESS=.*$/m, `B4_AGENT_ADDRESS=${DEAD}`);
    rmSync(evmAgent());
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    noApprove(out);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(said(out)).toContain(`REFUSED: the owner signed for agent ${agent}, not ${DEAD}`);
  }, 60_000);

  it("fund-agent and recover are refused after the same edit", async () => {
    await evmSetup();
    edit(evmPublic(), /^B4_AGENT_ADDRESS=.*$/m, `B4_AGENT_ADDRESS=${DEAD}`);
    const fund = await budget(["fund-agent", "--rail", "evm", "--no-open", "--timeout", "10"]);
    noApprove(fund);
    expect(fund.code, fund.stdout + fund.stderr).toBe(3);
    expect(fund.result).toMatchObject({ state: "refused_precheck" });
    const recover = await budget(["recover", "--rail", "evm"]);
    expect(recover.code, recover.stdout + recover.stderr).toBe(3);
    expect(recover.result).toMatchObject({ state: "refused_precheck" });
    expect(recover.result.next).toContain("superstables budget revoke --rail evm");
  }, 90_000);

  it("an edited owner with the signature kept is refused: the signature is by the old owner", async () => {
    await evmSetup();
    edit(evmPublic(), /^B4_OWNER_ADDRESS=.*$/m, `B4_OWNER_ADDRESS=${evmOwner("33")}`);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    noApprove(out);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(said(out)).toContain(`REFUSED: the setup signature was not made by the owner ${evmOwner("33")}`);
  }, 60_000);

  it("a legacy file: grant goes on to the owner page with the one warning line on stderr", async () => {
    const agent = privateKeyToAddress(evmOwnerKey("44"));
    legacyEvm(agent);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    expect(out.stdout).toMatch(/^APPROVE /m);
    expect(out.stderr).toContain(`warning: ${evmPublic()} has no owner signature naming agent ${agent} (it was set up before this check existed). Testnet goes on;`);
    expect(out.stderr.split("\n").filter((l) => l.startsWith("warning: ") && l.includes("owner signature")).length).toBe(1);
    expect(said(out)).not.toContain("REFUSED: the owner");
  }, 60_000);

  it("a setup re-run on the legacy file with --owner-key-file writes the three lines and asks nothing; then grant has no warning", async () => {
    const agent = privateKeyToAddress(evmOwnerKey("44"));
    legacyEvm(agent);
    expect(read(evmPublic())).not.toContain("SETUP_MESSAGE");
    const again = await budget(["setup", "--rail", "evm", "--owner-key-file", evmOwnerFile()]);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(said(again)).toContain(`the owner's signature naming agent ${agent} is recorded in ${evmPublic()}`);
    noApprove(again);
    for (const k of SETUP_KEYS) expect(read(evmPublic())).toContain(`${k}=`);
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    expect(out.stdout).toMatch(/^APPROVE /m);
    expect(out.stderr).not.toContain("owner signature naming agent");
  }, 90_000);

  it("a setup re-run on a legacy file without an owner key file asks once, on the existing connect page, for the recorded owner", async () => {
    legacyEvm(privateKeyToAddress(evmOwnerKey("44")));
    const out = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10"]);
    expect(out.approve).toMatchObject({ action: "setup" });
    expect(out.approve.terms?.title ?? "Connect your wallet").toBe("Connect your wallet");
    // the page names the owner on record and does not say that setup replaces it
    expect(lastPage).toContain("Owner on record");
    expect(lastPage).toContain(owner.address);
    expect(lastPage).toContain("Connect this wallet. Any other wallet is refused, and nothing changes.");
    expect(lastPage).not.toContain("replaces it");
  }, 60_000);

  it("recover accepts a retired key (rotate needs it); grant and fund-agent still refuse it", async () => {
    await evmSetup();
    const agent = read(evmPublic()).match(/^B4_AGENT_ADDRESS=(.*)$/m)![1];
    write(join(home, "keys", "budget", "retired.json"), JSON.stringify({ version: 1, retired: [{ rail: "evm", address: agent, retiredAt: "2026-10-01T00:00:00.000Z", reason: "rotate" }] }));
    for (const args of [["grant", "--amount", "0.01", "--no-open", "--timeout", "10"], ["fund-agent", "--no-open", "--timeout", "10"]]) {
      const out = await budget([args[0], "--rail", "evm", ...args.slice(1)]);
      noApprove(out);
      expect(out.code, out.stdout + out.stderr).toBe(3);
      expect(said(out)).toContain(`agent ${agent} was retired by`);
    }
    const recover = await budget(["recover", "--rail", "evm", "--no-open", "--timeout", "10"]);
    expect(said(recover)).not.toContain("was retired by");
    expect(recover.result?.state, recover.stdout + recover.stderr).not.toBe("refused_precheck");
    expect(recover.code, recover.stdout + recover.stderr).not.toBe(3);
    expect((recover.approve ?? recover.result)?.action).toBe("recover-revoke"); // it got as far as asking the owner
  }, 120_000);

  it("a hosted legacy file: the warning and the refusal name setup --hosted --site, and a plain re-run says what records the signature", async () => {
    const agent = privateKeyToAddress(evmOwnerKey("44"));
    legacyEvm(agent);
    write(evmPublic(), `${read(evmPublic())}APPROVALS=hosted\nSITE=${site.url}\n`, 0o644);
    const flags = `--hosted --site ${site.url}`;
    const out = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    expect(out.stderr).toContain(`run superstables budget setup --rail evm ${flags} again`);
    const again = await budget(["setup", "--rail", "evm", "--no-open", "--timeout", "10"]);
    expect(said(again)).toContain(`no owner signature naming agent ${agent} is recorded yet: superstables budget setup --rail evm ${flags} records it from the site's owner proof`);
    edit(evmPublic(), /^B4_AGENT_ADDRESS=.*$/m, `B4_AGENT_ADDRESS=${DEAD}`);
    write(evmAgent(), "", 0o600);
    rmSync(evmAgent());
    write(evmPublic(), `${read(evmPublic())}SETUP_MESSAGE=x\n`, 0o644);
    const refused = await budget(["grant", "--rail", "evm", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    expect(refused.result.next).toContain(`run superstables budget setup --rail evm ${flags} where the agent key is, to record the owner's signature again`);
  }, 120_000);

  it("a setup re-run with another owner key on a legacy file is refused and changes nothing", async () => {
    legacyEvm(privateKeyToAddress(evmOwnerKey("44")));
    const before = read(evmPublic());
    const other = join(home, "owner-other.env");
    write(other, `B4_OWNER_KEY=${evmOwnerKey("33")}\n`);
    const out = await budget(["setup", "--rail", "evm", "--owner-key-file", other]);
    expect(out.code).toBe(3);
    expect(read(evmPublic())).toBe(before);
  }, 60_000);

  it("hosted setup stores the site's owner proof text, and an already-linked re-run keeps a valid binding", async () => {
    site.onPoll = (r) => { if (r.polls >= 2) Object.assign(r, { state: "linked", owner: owner.address }); };
    const first = await budget(["setup", "--rail", "evm", "--hosted", "--site", site.url, "--wait", "--no-open"]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const text = read(evmPublic());
    expect(text, first.stdout + first.stderr).toContain("SETUP_MESSAGE=");
    const stored = Buffer.from(text.match(/^SETUP_MESSAGE=(.*)$/m)![1], "base64url").toString("utf8");
    expect(stored).toBe((site.requests[0].owner_proof as { message: string; signature: string }).message);
    expect(text.match(/^SETUP_SIGNATURE=(.*)$/m)![1]).toBe((site.requests[0].owner_proof as { message: string; signature: string }).signature);
    expect(stored.split("\n")[0]).toBe("Superstables: add an agent to my account");
    const lines = Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect((await agentBinding("evm", pubOf(owner.address, lines.B4_AGENT_ADDRESS, lines))).state).toBe("signed");
  }, 90_000);
});

describe("solana and tempo", () => {
  it("solana: an edited SOLANA_AGENT_ADDRESS is refused before the page", async () => {
    const ownerKp = solanaOwnerKeypair(4);
    const f = join(home, "owner-sol.env");
    write(f, `SOLANA_OWNER_SECRET_BASE58=${bs58.encode(ownerKp.secretKey)}\n`);
    const setup = await budget(["setup", "--rail", "solana", "--owner-key-file", f]);
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    const pub = join(home, "budget", "public", "solana-devnet.env");
    expect(read(pub)).toMatch(/^SETUP_SIGNATURE=0x[0-9a-f]{128}$/m);
    const other = Keypair.generate().publicKey.toBase58();
    edit(pub, /^SOLANA_AGENT_ADDRESS=.*$/m, `SOLANA_AGENT_ADDRESS=${other}`);
    solana.usdc.set(ownerKp.publicKey.toBase58(), { amount: 5_000_000n, delegate: null, delegated: 0n });
    const out = await budget(["grant", "--rail", "solana", "--amount", "0.01", "--no-open", "--timeout", "10"]);
    noApprove(out);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result).toMatchObject({ state: "refused_precheck" });
    expect(said(out)).toContain(`but ${pub} names ${other}`);
  }, 90_000);

  it("tempo: setup --agent 2 signs for the new key; an edited AGENT2_ADDRESS is refused", async () => {
    const f = join(home, "owner-tempo.env");
    write(f, `OWNER_PRIVATE_KEY=${ownerKey}\n`);
    const setup = await budget(["setup", "--rail", "tempo", "--owner-key-file", f]);
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    const two = await budget(["setup", "--rail", "tempo", "--agent", "2", "--owner-key-file", f]);
    expect(two.code, two.stdout + two.stderr).toBe(0);
    const pub = join(home, "budget", "public", "tempo-moderato.env");
    expect(read(pub)).toMatch(/^AGENT2_SETUP_SIGNATURE=0x[0-9a-f]{130}$/m);
    expect(read(pub)).toMatch(/^SETUP_SIGNATURE=0x/m);
    edit(pub, /^AGENT2_ADDRESS=.*$/m, `AGENT2_ADDRESS=${DEAD}`);
    const out = await budget(["grant", "--rail", "tempo", "--agent", "2", "--amount", "0.05", "--no-open", "--timeout", "10"]);
    noApprove(out);
    expect(out.code, out.stdout + out.stderr).toBe(3);
    expect(out.result).toMatchObject({ state: "refused_precheck" });
  }, 120_000);
});

void generatePrivateKey;
