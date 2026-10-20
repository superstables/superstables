// Tempo budget purchases pay only plain, single-use, short-lived challenges: no machine-token (swap) route, one operation per
// challenge, a realm, an expiry within ten minutes, and a signed payment read back before it leaves. Pure cases first, then
// real `buy.ts` processes against a loopback seller and chain, with real mppx and viem signing.

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Challenge, Credential, Receipt } from "mppx";
import { Methods } from "mppx/tempo";
import { encodeFunctionData, encodeEventTopics, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Account, Transaction } from "viem/tempo";
import { afterAll, describe, expect, it, vi } from "vitest";
import { startFakeTempo, PATH_USD } from "../helpers/fake-chains.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";
import * as precheck from "../../budget/tempo/lib/precheck.mjs";

// The budget folders are fixed when the modules first load: point them at a scratch home before any import runs
const CLAIMS_HOME = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const base = join(homedir(), ".cache", "superstables-tests"); // not /tmp, which can be full
  require("node:fs").mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, "tempo-claims-"));
  process.env.SUPERSTABLES_HOME = home;
  return home;
});

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SPLIT = "0x3333333333333333333333333333333333333333";
const KEY = `0x${"01".repeat(32)}` satisfies Hex;
const AGENT = privateKeyToAccount(KEY).address;
const HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const MACHINE = "0x20c000000000000000000000f37de3740adec032";
const SWAP = "0xd05f8edfbb54da0d765c9fe9b2b3f7d2e3a8c466";
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const nowS = () => Math.floor(Date.now() / 1000);
const MEMO = `0x${"ab".repeat(32)}` as Hex;
const OTHER_MEMO = `0x${"ba".repeat(32)}` as Hex;

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [CLAIMS_HOME];
const SCRATCH = join(homedir(), ".cache", "superstables-tests");
const PRELOAD = {
  transfer: fileURLToPath(new URL("./fixtures/tempo-wrong-transfer.mjs", import.meta.url)),
  proof: fileURLToPath(new URL("./fixtures/tempo-proof-credential.mjs", import.meta.url)),
};
afterAll(async () => {
  while (closers.length) await closers.pop()!();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("precheckCharge and the machine-token route", () => {
  const request = (methodDetails: Record<string, unknown> = {}) => ({ amount: "1000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, ...methodDetails } });
  const opts = { maxBase: 10_000n };

  it.each([true, "true", 1, "false", "no"])("refuses machineTokenEnabled: %j", (flag) => {
    const r = precheck.precheckCharge(request({ machineTokenEnabled: flag }), opts);
    expect(r).toMatchObject({ ok: false, code: "machine_token" });
  });

  it.each([[undefined], [false], [null]])("accepts machineTokenEnabled: %j", (flag) => {
    expect(precheck.precheckCharge(request(flag === undefined ? {} : { machineTokenEnabled: flag }), opts)).toMatchObject({ ok: true });
  });
});

describe("precheckChallenge", () => {
  const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  const check = (c: unknown) => (precheck as any).precheckChallenge(c);

  it("refuses a challenge without a realm or an id", () => {
    expect(check({ id: "x", realm: "" })).toMatchObject({ ok: false, code: "bad_challenge" });
    expect(check({ id: "x" })).toMatchObject({ ok: false, code: "bad_challenge" });
    expect(check({ id: "", realm: "r" })).toMatchObject({ ok: false, code: "bad_challenge" });
    expect(check(undefined)).toMatchObject({ ok: false, code: "bad_challenge" });
  });

  it("refuses an expiry that is not a date", () => {
    expect(check({ id: "x", realm: "r", expires: "soon" })).toMatchObject({ ok: false, code: "bad_challenge" });
  });

  it("refuses a challenge open for more than 600 s, accepts 600 s or no expiry", () => {
    expect(check({ id: "x", realm: "r", expires: at(601) })).toMatchObject({ ok: false, code: "challenge_too_long" });
    expect(check({ id: "x", realm: "r", expires: at(3600) })).toMatchObject({ ok: false, code: "challenge_too_long" });
    expect(check({ id: "x", realm: "r", expires: at(600) })).toEqual({ ok: true });
    expect(check({ id: "x", realm: "r", expires: at(60) })).toEqual({ ok: true });
    expect(check({ id: "x", realm: "r" })).toEqual({ ok: true });
  });
});

describe("signedPayment", () => {
  const transferWithMemo = (to: string, amount: bigint, memo: Hex) => ({ to: PATH_USD as Hex, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [to as Hex, amount, memo] }) });
  const transfer = (to: string, amount: bigint) => ({ to: PATH_USD as Hex, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] }) });
  const sign = (calls: { to: Hex; data: Hex }[], validBefore: number | null = nowS() + 25, feePayer = false) =>
    Account.fromSecp256k1(KEY, { access: OWNER }).signTransaction({
      type: "tempo", chainId: 42431, calls, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0n, nonceKey: 2n ** 256n - 1n,
      ...(validBefore === null ? {} : { validBefore }), ...(feePayer ? { feePayer: true } : { feeToken: PATH_USD as Hex }),
    } as any);
  const quoted = { recipient: RECIPIENT, primary: 10_000n, memo: MEMO, splits: [] as { recipient: string; amount: string; memo?: string }[] };
  const read = async () => (await import(new URL("../../budget/tempo/lib/signed.ts", import.meta.url).href)).signedPayment;

  it("accepts the quoted transfer and returns the signed expiry", async () => {
    const signedPayment = await read();
    const vb = nowS() + 25;
    for (const feePayer of [false, true]) {
      const raw = await sign([transferWithMemo(RECIPIENT, 10_000n, MEMO)], vb, feePayer);
      expect(signedPayment(raw, quoted)).toEqual({ problem: "", validBefore: vb });
    }
  });

  it("accepts a split paid as a plain transfer and one with a memo, in quoted order", async () => {
    const signedPayment = await read();
    const q = { recipient: RECIPIENT, primary: 7_000n, memo: MEMO, splits: [{ recipient: SPLIT, amount: "2000" }, { recipient: SPLIT, amount: "1000", memo: OTHER_MEMO }] };
    const raw = await sign([transferWithMemo(RECIPIENT, 7_000n, MEMO), transfer(SPLIT, 2_000n), transferWithMemo(SPLIT, 1_000n, OTHER_MEMO)]);
    expect(signedPayment(raw, q).problem).toBe("");
  });

  it("refuses the machine-token route's approve and swapTo calls", async () => {
    const signedPayment = await read();
    const approve = { to: MACHINE as Hex, data: `0x095ea7b3${"00".repeat(64)}` as Hex };
    const swap = { to: SWAP as Hex, data: `0x34189fed${"00".repeat(128)}` as Hex };
    const raw = await sign([approve, swap]);
    expect(signedPayment(raw, quoted).problem).toMatch(/2 calls, not the 1 pathUSD transfer quoted/);
    const one = await sign([swap]);
    expect(signedPayment(one, quoted).problem).toMatch(/call 1 is not the quoted pathUSD transfer/);
  });

  it("refuses a wrong recipient, amount, memo or token, an extra call and a missing split", async () => {
    const signedPayment = await read();
    expect(signedPayment(await sign([transferWithMemo(SPLIT, 10_000n, MEMO)]), quoted).problem).toMatch(/call 1/);
    expect(signedPayment(await sign([transferWithMemo(RECIPIENT, 10_001n, MEMO)]), quoted).problem).toMatch(/call 1/);
    expect(signedPayment(await sign([transferWithMemo(RECIPIENT, 10_000n, OTHER_MEMO)]), quoted).problem).toMatch(/call 1/);
    expect(signedPayment(await sign([{ ...transferWithMemo(RECIPIENT, 10_000n, MEMO), to: SWAP as Hex }]), quoted).problem).toMatch(/call 1/);
    expect(signedPayment(await sign([transfer(RECIPIENT, 10_000n)]), quoted).problem).toMatch(/call 1/);
    expect(signedPayment(await sign([transferWithMemo(RECIPIENT, 10_000n, MEMO), transfer(SPLIT, 1n)]), quoted).problem).toMatch(/2 calls, not the 1/);
    const withSplit = { ...quoted, primary: 9_000n, splits: [{ recipient: SPLIT, amount: "1000" }] };
    expect(signedPayment(await sign([transferWithMemo(RECIPIENT, 9_000n, MEMO)]), withSplit).problem).toMatch(/1 calls, not the 2 pathUSD transfers/);
  });

  it("refuses a payment valid for more than 600 s, or with no expiry", async () => {
    const signedPayment = await read();
    const call = [transferWithMemo(RECIPIENT, 10_000n, MEMO)];
    expect(signedPayment(await sign(call, nowS() + 700), quoted).problem).toMatch(/valid for \d+ s; this client signs payments valid for at most 600 s/);
    expect(signedPayment(await sign(call, nowS() + 590), quoted).problem).toBe("");
    expect(signedPayment(await sign(call, null), quoted).problem).toBe("it has no expiry");
  });

  it("says so when the bytes are not a transaction", async () => {
    const signedPayment = await read();
    for (const raw of ["0x76deadbeef", "nonsense", undefined, 7]) expect(signedPayment(raw, quoted).problem).toBe("the signed payment could not be read");
  });
});

describe("claimChallenge", () => {
  // The claim names the challenge, not the referral: bytes 15 to 24 of the memo (hex characters 30 to 50) are zeroed
  const memo = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  const claimName = (m: string) => `${m.slice(2, 32)}${"0".repeat(20)}${m.slice(52)}`.toLowerCase();
  let loaded: Promise<any> | undefined;
  // OPS_DIR is fixed when the module first loads, so every case shares one home and takes its own memos
  const load = () => (loaded ??= (async () => {
    const mod = await import(new URL("../../budget/tempo/lib/claim.ts", import.meta.url).href);
    if (!mod.CLAIMS_DIR.startsWith(CLAIMS_HOME)) throw new Error(`the claims folder ${mod.CLAIMS_DIR} is not under the scratch home`);
    return mod;
  })());

  it("lets the first operation take a challenge, the same operation again, and refuses another", async () => {
    const { claimChallenge } = await load();
    expect(claimChallenge(memo(1), "a")).toBe("");
    expect(claimChallenge(memo(1), "a")).toBe("");
    expect(claimChallenge(memo(1), "b")).toBe("operation a");
    expect(claimChallenge(memo(2), "b")).toBe("");
  });

  it("keeps one private file per challenge, named by its memo without the referral's bytes", async () => {
    const { CLAIMS_DIR, claimChallenge } = await load();
    const name = claimName(`0x${"0A".repeat(32)}`);
    expect(name).toBe(`${"0a".repeat(15)}${"00".repeat(10)}${"0a".repeat(7)}`);
    claimChallenge(`0x${"0A".repeat(32)}`, "a");
    const file = join(CLAIMS_DIR, name);
    expect(readdirSync(CLAIMS_DIR)).toContain(name);
    expect(statSync(CLAIMS_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("a\n");
  });

  it("never trusts a planted file or link", async () => {
    const { CLAIMS_DIR, claimChallenge } = await load();
    claimChallenge(memo(3), "x"); // makes the folder
    writeFileSync(join(CLAIMS_DIR, claimName(memo(4))), "");
    expect(claimChallenge(memo(4), "a")).toBe("another operation");
    const target = join(CLAIMS_DIR, "..", "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(CLAIMS_DIR, claimName(memo(5))));
    expect(claimChallenge(memo(5), "a")).toBe("another operation");
    expect(lstatSync(join(CLAIMS_DIR, claimName(memo(5)))).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("holds a challenge for the operation whatever referral a later memo carries, or none", async () => {
    const { claimChallenge } = await load();
    const withClient = (base: string, fill: string) => `${base.slice(0, 32)}${fill.repeat(20)}${base.slice(52)}`;
    const plain = withClient(memo(6), "0");
    expect(claimChallenge(withClient(memo(6), "a"), "a")).toBe("");
    expect(claimChallenge(withClient(memo(6), "b"), "b")).toBe("operation a");
    expect(claimChallenge(plain, "b")).toBe("operation a");
    expect(claimChallenge(plain, "a")).toBe("");
    // another challenge (a different id or realm) is not held
    expect(claimChallenge(`${plain.slice(0, 52)}${"cd".repeat(6)}ef`, "b")).toBe("");
    expect(claimChallenge(`${plain.slice(0, 12)}${"cd".repeat(5)}${plain.slice(22)}`, "b")).toBe("");
  });

  it("holds a challenge that an earlier build claimed under the whole memo, referred or not", async () => {
    const { CLAIMS_DIR, claimChallenge } = await load();
    const withClient = (base: string, fill: string) => `${base.slice(0, 32)}${fill.repeat(20)}${base.slice(52)}`;
    claimChallenge(memo(7), "x"); // makes the folder
    // an earlier build named the file by the memo as paid, referral bytes included
    const legacy = (base: string, op: string) => writeFileSync(join(CLAIMS_DIR, base.slice(2).toLowerCase()), `${op}\n`, { mode: 0o600 });
    legacy(withClient(memo(8), "a"), "old-referred");
    expect(claimChallenge(withClient(memo(8), "b"), "new")).toBe("operation old-referred");
    expect(claimChallenge(withClient(memo(8), "0"), "new")).toBe("operation old-referred");
    expect(claimChallenge(withClient(memo(8), "a"), "old-referred")).toBe("");
    expect(claimChallenge(withClient(memo(8), "c"), "old-referred")).toBe("");
    expect(readdirSync(CLAIMS_DIR)).not.toContain(claimName(memo(8)));
    // a name that was already the challenge's key is the same file as before
    legacy(withClient(memo(9), "0"), "old-plain");
    expect(claimChallenge(withClient(memo(9), "a"), "new")).toBe("operation old-plain");
    expect(claimChallenge(withClient(memo(9), "0"), "old-plain")).toBe("");
    // an unreadable earlier claim holds the challenge too
    writeFileSync(join(CLAIMS_DIR, withClient(memo(11), "a").slice(2)), "");
    expect(claimChallenge(withClient(memo(11), "b"), "new")).toBe("another operation");
  });

  it("refuses a memo that is not 32 bytes of hex", async () => {
    const { claimChallenge } = await load();
    for (const bad of ["", "0x12", "../../etc/passwd", `0x${"zz".repeat(32)}`]) expect(() => claimChallenge(bad, "a")).toThrow(/32 bytes/);
  });
});

// ---- real buy.ts processes ----

const memoOf = (id: string, realm: string) => {
  const b = Buffer.alloc(32);
  Buffer.from(keccak256(stringToHex("mpp")).slice(2, 10), "hex").copy(b, 0);
  b[4] = 1;
  Buffer.from(keccak256(stringToHex(realm)).slice(2, 22), "hex").copy(b, 5);
  Buffer.from(keccak256(stringToHex(id)).slice(2, 16), "hex").copy(b, 25);
  return `0x${b.toString("hex")}` as Hex;
};

async function rig(o: { realm?: string; methodDetails?: Record<string, unknown>; expiresIn?: number; headTime?: number; receipt?: boolean; patch?: "transfer" | "proof"; modes?: string[] } = {}) {
  mkdirSync(SCRATCH, { recursive: true });
  const home = mkdtempSync(join(SCRATCH, "tempo-challenges-"));
  const guardLog = join(home, "network.log");
  writeFileSync(guardLog, "");
  mkdirSync(join(home, "keys/budget"), { recursive: true });
  writeFileSync(join(home, "keys/budget/tempo-agent.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  const chain = await startFakeTempo();
  chain.keys.set(`${OWNER}:${AGENT.toLowerCase()}`, { expiry: BigInt(nowS() + 3600), limit: 10_000_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
  const challenge = Challenge.from({
    secretKey: "local-test-secret", realm: o.realm ?? "local-seller", method: "tempo", intent: "charge",
    expires: new Date(Date.now() + (o.expiresIn ?? 60) * 1000).toISOString(),
    request: { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: o.modes ?? ["pull"], ...o.methodDetails } },
  });
  const memo = memoOf(challenge.id, challenge.realm);
  const log = (eventName: "Transfer" | "TransferWithMemo") => ({
    address: PATH_USD,
    topics: encodeEventTopics({ abi: Abis.tip20, eventName, args: { from: OWNER, to: RECIPIENT, ...(eventName === "TransferWithMemo" ? { memo } : {}) } }),
    data: `0x${10000n.toString(16).padStart(64, "0")}`, transactionHash: HASH, blockNumber: "0x3e8", blockHash: BLOCK_HASH, transactionIndex: "0x0", logIndex: "0x0", removed: false,
  });
  const receipt = { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: "0x3e8", status: "0x1", from: OWNER, to: PATH_USD, logs: [log("Transfer"), log("TransferWithMemo")], transactionIndex: "0x0", cumulativeGasUsed: "0x10000", gasUsed: "0x10000", effectiveGasPrice: "0x1", type: "0x76", logsBloom: `0x${"00".repeat(256)}` };
  const calls: { method: string; to?: string }[] = [];
  let broadcast = false;
  const rpc = await startServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    calls.push({ method: request.method, to: request.params?.[0]?.to });
    let result: unknown;
    switch (request.method) {
      case "eth_estimateGas": result = "0x10000"; break;
      case "eth_gasPrice": case "eth_maxPriorityFeePerGas": result = "0x1"; break;
      case "eth_getTransactionCount": result = "0x0"; break;
      case "eth_getBlockByNumber": result = { number: "0x3e8", hash: BLOCK_HASH, timestamp: hex(o.headTime ?? nowS()), baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0", transactions: [] }; break;
      case "eth_sendRawTransactionSync": broadcast = true; result = receipt; break;
      case "eth_sendRawTransaction": broadcast = true; result = HASH; break;
      case "eth_getTransactionReceipt": result = broadcast ? receipt : null; break;
      case "eth_getTransactionByHash": result = broadcast ? { from: OWNER, signature: { keyId: AGENT } } : null; break;
      case "eth_getLogs": result = broadcast ? [log("TransferWithMemo")] : []; break;
      default: { const r = await fetch(chain.url, { method: "POST", body: JSON.stringify(request) }); sendJson(res, 200, await r.json()); return; }
    }
    sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
  });
  const signed: string[][] = [];
  const signedVB: number[] = [];
  const credentialsSeen: string[] = [];
  const seller = await startServer((req, res) => {
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string") { sendJson(res, 402, {}, { "www-authenticate": Challenge.serialize(challenge) }); return; }
    credentialsSeen.push(authorization);
    const payload = Methods.charge.schema.credential.payload.parse(Credential.deserialize(authorization).payload);
    if (payload.type === "transaction") {
      const tx = Transaction.deserialize(payload.signature as `0x76${string}`) as any;
      signed.push(tx.calls.map((c: any) => `${String(c.to).toLowerCase()}:${String(c.data).slice(0, 10)}`));
      signedVB.push(Number(tx.validBefore));
    }
    broadcast = true;
    sendJson(res, 200, { ok: true }, o.receipt === false ? {} : { "payment-receipt": Receipt.serialize({ method: "tempo", reference: HASH, status: "success", timestamp: new Date().toISOString() }) });
  });
  closers.push(async () => { await seller.close(); await rpc.close(); await chain.close(); rmSync(home, { recursive: true, force: true }); });
  const env = { HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog };
  const resultOf = (out: string) => JSON.parse(out.split("\n").filter((l) => l.startsWith("RESULT ")).pop()!.slice(7));
  return {
    calls, signed, signedVB, credentialsSeen, home,
    async buy(op: string) { const c = await guardedNode(["--import=tsx", ...(o.patch ? [`--import=${PRELOAD[o.patch]}`] : []), "budget/tempo/buy.ts", "--url", seller.url, "--max", "0.01", "--op", op], env); return { ...c, result: resultOf(c.output) }; },
    async reconcile(op: string) { const c = await guardedNode(["--import=tsx", "budget/tempo/reconcile.ts", "--op", op], env); return { ...c, result: resultOf(c.output) }; },
    journalPath: (op: string) => join(home, "budget/ops/tempo-moderato", `${op}.json`),
    readJournal: (op: string) => JSON.parse(readFileSync(join(home, "budget/ops/tempo-moderato", `${op}.json`), "utf8")),
  };
}

describe.concurrent("Tempo budget purchases against a loopback seller", () => {
  it("refuses a challenge that turns on the machine-token route, signing and calling nothing", async () => {
    const t = await rig({ methodDetails: { machineTokenEnabled: true } });
    const b = await t.buy("mt");
    expect(b.result, b.output).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^machine_token: /) });
    expect(b.code).toBe(3);
    expect(t.signed).toEqual([]);
    expect(t.calls.filter((c) => [MACHINE, SWAP].includes(String(c.to).toLowerCase()))).toEqual([]);
  }, 120_000);

  it("lets one operation use a challenge and refuses a second one, with one payment signed", async () => {
    const t = await rig();
    const one = await t.buy("one");
    expect(one.result, one.output).toMatchObject({ state: "settled" });
    const two = await t.buy("two");
    expect(two.code, two.output).toBe(3);
    expect(two.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^challenge_used: operation one /) });
    expect(t.signed.length).toBe(1);
  }, 120_000);

  it("lets exactly one of two simultaneous operations use a challenge", async () => {
    const t = await rig();
    const [a, b] = await Promise.all([t.buy("a"), t.buy("b")]);
    expect(t.signed.length, a.output + b.output).toBe(1);
    const states = [a.result, b.result].map((r) => r.state).sort();
    expect(states).toEqual(["refused_precheck", "settled"]);
    expect([a.result, b.result].find((r) => r.state === "refused_precheck").reason).toMatch(/^challenge_used: /);
  }, 120_000);

  it("refuses a challenge without a realm before signing, instead of ending not_found after the seller was paid", async () => {
    const t = await rig({ realm: "", receipt: false, headTime: nowS() + 3600 });
    const b = await t.buy("norealm");
    expect(b.result, b.output).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^bad_challenge: /) });
    expect(b.code).toBe(3);
    expect(t.signed).toEqual([]);
  }, 120_000);

  it("refuses a challenge open for an hour before signing", async () => {
    const t = await rig({ expiresIn: 3600 });
    const b = await t.buy("long");
    expect(b.result, b.output).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^challenge_too_long: /) });
    expect(t.signed).toEqual([]);
  }, 120_000);

  it("journals the expiry that was signed into the payment", async () => {
    const t = await rig();
    const b = await t.buy("vb");
    expect(b.result, b.output).toMatchObject({ state: "settled" });
    expect(t.signedVB.length).toBe(1);
    expect(t.readJournal("vb").validBefore).toBe(t.signedVB[0]);
  }, 120_000);

  it("never reports a journal without a memo or a hash not_found: reconcile leaves it unknown", async () => {
    const t = await rig({ receipt: false, headTime: nowS() + 3600 });
    mkdirSync(join(t.home, "budget/ops/tempo-moderato"), { recursive: true, mode: 0o700 });
    const journal = {
      op: "old", rail: "tempo", kind: "buy", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      intent: { amount: "10000", amountDecimal: "0.01", token: PATH_USD, recipient: RECIPIENT, chainId: 42431, owner: OWNER, agent: AGENT, challengeId: "abc", mode: "pull" },
      startBlock: "900", validBefore: nowS() - 600, history: [],
    };
    writeFileSync(t.journalPath("old"), JSON.stringify(journal), { mode: 0o600 });
    const r = await t.reconcile("old");
    expect(r.result, r.output).toMatchObject({ state: "unknown" });
    expect(r.code).toBe(5);
  }, 120_000);
});

describe.concurrent("the signed payment is read back before it leaves", () => {
  for (const mode of ["pull", "push"]) {
    it(`refuses a payment mppx built differently from the quote (${mode}), sending nothing`, async () => {
      const t = await rig({ patch: "transfer", modes: [mode] });
      const b = await t.buy(`readback-${mode}`);
      expect(b.result, b.output).toMatchObject({ state: "failed", reason: expect.stringMatching(/^signing_failed: the payment mppx (signed|built) was not sent: call 1 is not the quoted pathUSD transfer/) });
      expect(b.code).toBe(1);
      expect(t.calls.filter((c) => /^eth_sendRawTransaction/.test(c.method))).toEqual([]);
      expect(t.credentialsSeen).toEqual([]);
    }, 120_000);
  }

  it("refuses a credential that is neither a signed transaction nor a hash, sending nothing", async () => {
    const t = await rig({ patch: "proof" });
    const b = await t.buy("readback-proof");
    expect(b.result, b.output).toMatchObject({ state: "failed", reason: expect.stringMatching(/^signing_failed: the payment mppx signed was not sent: it is a proof credential, not a pathUSD transfer/) });
    expect(t.credentialsSeen).toEqual([]);
  }, 120_000);

  it("lets the quoted payment through in push mode", async () => {
    const t = await rig({ modes: ["push"] });
    const b = await t.buy("readback-control");
    expect(b.result, b.output).toMatchObject({ state: "settled" });
    expect(t.calls.some((c) => /^eth_sendRawTransaction/.test(c.method))).toBe(true);
  }, 120_000);
});
