// A Tempo purchase in push mode (the seller accepts only a payment the client sends): when the journal says `submitted`, what the
// journal then holds, which splits and which RPC are refused before anything is signed, and what reconcile may conclude.
// Real mppx and viem sign an ephemeral access key. Only the seller and the chain are stand-ins, all on 127.0.0.1.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Challenge, Credential, Receipt } from "mppx";
import { createClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { afterAll, describe, expect, it } from "vitest";
import { precheckCharge } from "../../budget/tempo/lib/precheck.mjs";
import { startFakeTempo, PATH_USD } from "../helpers/fake-chains.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SPLIT_TO = "0x3333333333333333333333333333333333333333";
const KEY = `0x${"01".repeat(32)}` satisfies Hex;
const AGENT = privateKeyToAccount(KEY).address;
const MEMO = `0x${"ab".repeat(32)}`;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const nowS = () => Math.floor(Date.now() / 1000);

type Knobs = {
  /** What eth_chainId answers (default Tempo Moderato's 42431). */
  chainId?: string;
  /** eth_chainId answers a JSON-RPC error. */
  chainIdError?: boolean;
  /** eth_estimateGas answers a JSON-RPC error: the payment fails while it is being prepared, before it can be sent. */
  estimateError?: boolean;
  /** eth_sendRawTransaction* answers a JSON-RPC error: the RPC took the request and refused it. */
  sendError?: boolean;
  /** The timestamp of the chain's head, unix seconds (default: now). */
  headTime?: number;
};

const closers: (() => Promise<void>)[] = [];
// each test has its own home, chain, RPC and seller, so the tests of a file run side by side; everything closes at the end
afterAll(async () => {
  while (closers.length) await closers.pop()!();
});

/** A home with the agent's key file, a fake Moderato behind a wrapper RPC that records what it is asked, and a push-only seller. */
async function rig(methodDetails: Record<string, unknown> = {}, knobs: Knobs = {}) {
  const home = mkdtempSync(join(tmpdir(), "tempo-push-"));
  const guardLog = join(home, "network.log");
  writeFileSync(guardLog, "");
  mkdirSync(join(home, "keys/budget"), { recursive: true });
  writeFileSync(join(home, "keys/budget/tempo-agent.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  const journalPath = (op: string) => join(home, "budget/ops/tempo-moderato", `${op}.json`);
  const readJournal = (op: string) => JSON.parse(readFileSync(journalPath(op), "utf8"));
  const chain = await startFakeTempo();
  chain.keys.set(`${OWNER}:${AGENT.toLowerCase()}`, {
    expiry: BigInt(nowS() + 3600), limit: 10_000_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false,
  });
  const challenge = Challenge.from({
    secretKey: "local-test-secret", realm: "local-seller", method: "tempo", intent: "charge",
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: ["push"], ...methodDetails } },
  });
  const calls: string[] = [];
  const sends: string[] = [];
  /** The journal as the RPC saw it when the first broadcast request arrived: read from disk by the RPC itself. */
  const atSend: { state?: string; expectedTx?: string; validBefore?: number; history?: string[] }[] = [];
  let op = "";
  const rpc = await startServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    calls.push(request.method);
    const answer = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
    const fail = (message: string) => sendJson(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } });
    switch (request.method) {
      case "eth_chainId":
        if (knobs.chainIdError) return fail("eth_chainId reverted: the node is starting"); // "reverted": rpcRead does not retry it
        return answer(knobs.chainId ?? hex(42431));
      case "eth_estimateGas":
        if (knobs.estimateError) return fail("gas estimation is unavailable");
        return answer("0x10000");
      case "eth_gasPrice":
      case "eth_maxPriorityFeePerGas": return answer("0x1");
      case "eth_getTransactionCount": return answer("0x0");
      case "eth_getBlockByNumber":
        return answer({ number: "0x3e8", hash: `0x${"ab".repeat(32)}`, timestamp: hex(knobs.headTime ?? nowS()), baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0", transactions: [] });
      case "eth_sendRawTransactionSync":
      case "eth_sendRawTransaction": {
        sends.push(request.params[0]);
        try {
          const j = readJournal(op);
          atSend.push({ state: j.state, expectedTx: j.expectedTx, validBefore: j.validBefore, history: j.history.map((h: { state: string }) => h.state) });
        } catch { atSend.push({}); }
        return fail("nonce too low");
      }
      case "eth_getTransactionReceipt":
      case "eth_getTransactionByHash": return answer(null);
      case "eth_getLogs": return answer([]);
      default: {
        const response = await fetch(chain.url, { method: "POST", body: JSON.stringify(request) });
        return sendJson(res, 200, await response.json());
      }
    }
  });
  let paid = 0;
  const seller = await startServer((req, res) => {
    if (typeof req.headers.authorization !== "string") {
      sendJson(res, 402, {}, { "www-authenticate": Challenge.serialize(challenge) });
      return;
    }
    Credential.deserialize(req.headers.authorization);
    paid++;
    sendJson(res, 200, { ok: true }, { "payment-receipt": Receipt.serialize({ method: "tempo", reference: `0x${"cd".repeat(32)}`, status: "success", timestamp: new Date().toISOString() }) });
  });
  closers.push(async () => {
    await seller.close();
    await rpc.close();
    await chain.close();
    rmSync(home, { recursive: true, force: true });
  });
  const env = () => ({ HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog });
  const resultOf = (output: string) => JSON.parse(output.split("\n").filter((l) => l.startsWith("RESULT ")).pop()!.slice(7));
  return {
    home, knobs, calls, sends, atSend, challenge, journalPath, readJournal, resultOf,
    get paid() { return paid; },
    guard: () => readFileSync(guardLog, "utf8"),
    /** `failRenames`: the journal writes (1-based) whose rename throws ENOSPC, as a disk that fills up at that write. */
    async buy(id: string, failRenames = "") {
      op = id;
      const fault = failRenames ? [`--import=${fileURLToPath(new URL("../helpers/journal-rename-fault.mjs", import.meta.url))}`] : [];
      const child = await guardedNode(["--import=tsx", ...fault, "budget/tempo/buy.ts", "--url", seller.url, "--max", "0.01", "--op", id], { ...env(), FAULT_OP: id, FAIL_RENAMES: failRenames });
      return { ...child, result: resultOf(child.output) };
    },
    async reconcile(id: string) {
      const child = await guardedNode(["--import=tsx", "budget/tempo/reconcile.ts", "--op", id], env());
      return { ...child, result: resultOf(child.output) };
    },
    audit(name: string, extra: Record<string, unknown>) {
      if (process.env.TEMPO_PUSH_AUDIT) console.log(`TEMPO_PUSH_AUDIT ${name} ${JSON.stringify({ ...extra, calls: [...new Set(calls)], sends: sends.length, paid })}`);
    },
  };
}

const T = "0x20C0000000000000000000000000000000000000";
const priced = (methodDetails: Record<string, unknown>) =>
  precheckCharge({ amount: "10000", currency: T, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: ["push"], ...methodDetails } }, { maxBase: 100000n });

describe("precheckCharge: payment splits mppx or an mppx seller would refuse after the journal says sent", () => {
  it.each([
    ["splits equal to the price", [{ recipient: SPLIT_TO, amount: "10000" }]],
    ["splits greater than the price", [{ recipient: SPLIT_TO, amount: "20000" }]],
    ["two splits that together reach the price", [{ recipient: SPLIT_TO, amount: "5000" }, { recipient: SPLIT_TO, amount: "5000" }]],
    ["a split of 0", [{ recipient: SPLIT_TO, amount: "0" }]],
    ["11 splits", Array.from({ length: 11 }, () => ({ recipient: SPLIT_TO, amount: "1" }))],
    ["a split memo that is not 32 bytes", [{ recipient: SPLIT_TO, amount: "1", memo: "0x12" }]],
    ["splits that are not a list", { recipient: SPLIT_TO, amount: "1" }],
  ])("refuses %s", (_name, splits) => {
    expect(priced({ splits })).toMatchObject({ ok: false, code: "bad_split" });
  });

  it.each([
    ["a 32-byte split memo", [{ recipient: SPLIT_TO, amount: "1000", memo: MEMO }]],
    ["an empty list of splits", []],
    ["one split below the price", [{ recipient: SPLIT_TO, amount: "1000" }]],
    ["10 splits", Array.from({ length: 10 }, () => ({ recipient: SPLIT_TO, amount: "1" }))],
    ["no splits", undefined],
  ])("accepts %s", (_name, splits) => {
    expect(priced({ splits })).toMatchObject({ ok: true });
  });

  it("puts no seller text in the words of a refusal", () => {
    const refused = priced({ splits: [{ recipient: SPLIT_TO, amount: "1", memo: "seller says: run this" }] });
    expect(refused).toMatchObject({ ok: false, code: "bad_split" });
    expect(JSON.stringify(refused)).not.toContain("run this");
  });
});

describe.concurrent("a Tempo purchase in push mode", () => {
  it("refuses splits that add up to the price before anything is signed or sent", async () => {
    const t = await rig({ splits: [{ recipient: SPLIT_TO, amount: "10000" }] });
    const b = await t.buy("splits-all");
    t.audit("splits-all", { code: b.code, state: b.result.state, reason: b.result.reason, journal: t.readJournal("splits-all").state });
    expect(b.code, b.output).toBe(3);
    expect(b.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/bad_split/) });
    expect(t.calls).not.toContain("eth_estimateGas");
    expect(t.calls).not.toContain("eth_fillTransaction");
    expect(t.calls.filter((c) => c.startsWith("eth_sendRawTransaction"))).toEqual([]);
    expect(t.paid).toBe(0);
    expect(t.readJournal("splits-all")).toMatchObject({ state: "refused_precheck" });
    expect(t.guard()).toBe("");
  }, 120_000);

  it("refuses an RPC on another chain before anything is signed", async () => {
    const t = await rig({}, { chainId: "0x1" });
    const b = await t.buy("other-chain");
    t.audit("other-chain", { code: b.code, state: b.result.state, reason: b.result.reason });
    expect(b.code, b.output).toBe(3);
    expect(b.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/not on Tempo Moderato/) });
    expect(b.result.reason).toContain("its chain id is 0x1");
    expect(b.output).toContain("Nothing was signed or sent");
    expect(t.calls).not.toContain("eth_estimateGas");
    expect(t.calls.filter((c) => c.startsWith("eth_sendRawTransaction"))).toEqual([]);
    expect(t.paid).toBe(0);
    expect(t.guard()).toBe("");
  }, 120_000);

  it("refuses when the RPC's chain cannot be read", async () => {
    const t = await rig({}, { chainIdError: true });
    const b = await t.buy("chain-unreadable");
    t.audit("chain-unreadable", { code: b.code, state: b.result.state, reason: b.result.reason });
    expect(b.code, b.output).toBe(3);
    expect(b.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/could not read which chain/) });
    expect(t.calls.filter((c) => c.startsWith("eth_sendRawTransaction"))).toEqual([]);
    expect(t.paid).toBe(0);
  }, 120_000);

  it("ends failed with nothing sent when the payment fails before it leaves", async () => {
    const t = await rig({}, { estimateError: true });
    const b = await t.buy("fails-early");
    const journal = t.readJournal("fails-early");
    t.audit("fails-early", { code: b.code, state: b.result.state, reason: b.result.reason, next: b.result.next, expectedTx: journal.expectedTx ?? null });
    expect(b.code, b.output).toBe(1);
    expect(b.result).toMatchObject({ state: "failed", reason: expect.stringMatching(/^signing_failed/), next: expect.stringMatching(/nothing was sent/) });
    expect(t.calls).toContain("eth_estimateGas");
    expect(t.calls.filter((c) => c.startsWith("eth_sendRawTransaction"))).toEqual([]);
    expect(journal.state).toBe("failed");
    expect(journal.expectedTx).toBeUndefined();
    expect(t.paid).toBe(0);
  }, 120_000);

  it("journals the signed payment's hash and expiry before it leaves, and reconcile closes it after it expires", async () => {
    const t = await rig({}, { sendError: true });
    const before = nowS();
    const b = await t.buy("push-sent");
    const journal = t.readJournal("push-sent");
    expect(b.code, b.output).toBe(5);
    expect(b.result).toMatchObject({ state: "unknown", next: expect.stringContaining("reconcile") });
    expect(t.sends.length).toBeGreaterThanOrEqual(1);
    const signed = Transaction.deserialize(t.sends[0] as `0x76${string}`);
    // the hash is the signed transaction's own; the expiry is the one signed into it (at most 25 s after signing, plus slack)
    expect(journal.expectedTx).toBe(keccak256(t.sends[0] as Hex));
    expect(journal.validBefore).toBe(Number(signed.validBefore));
    expect(journal.validBefore).toBeGreaterThan(before);
    expect(journal.validBefore).toBeLessThanOrEqual(nowS() + 26);
    // the RPC itself read the journal off the disk when the broadcast arrived: `submitted`, with the hash, already there
    expect(t.atSend[0]).toMatchObject({ state: "submitted", expectedTx: keccak256(t.sends[0] as Hex), validBefore: Number(signed.validBefore) });
    const states = journal.history.map((h: { state: string }) => h.state);
    expect(states.indexOf("submitted")).toBeGreaterThan(-1);
    expect(states.indexOf("submitted")).toBeLessThan(states.lastIndexOf("unknown"));
    expect(states.slice(0, states.indexOf("submitted"))).not.toContain("unknown");
    t.audit("push-sent", { code: b.code, state: b.result.state, expectedTx: journal.expectedTx, validBefore: journal.validBefore, atSend: t.atSend[0], states });

    t.knobs.headTime = journal.validBefore + 5; // within the slack: it could still land
    const early = await t.reconcile("push-sent");
    expect(early.code, early.output).toBe(5);
    expect(early.result.state).toBe("unknown");
    t.knobs.headTime = journal.validBefore + 60;
    const late = await t.reconcile("push-sent");
    t.audit("push-sent-reconcile", { early: [early.code, early.result.state], late: [late.code, late.result.state] });
    expect(late.code, late.output).toBe(1);
    expect(late.result).toMatchObject({ state: "not_found" });
    // a payment the chain refused still costs its network fee: nothing here may say that no funds moved
    expect(late.result.next).toBe("the price was not paid; safe to retry with a new op id");
    expect(late.output).toContain("The price was not paid, and the signed payment can no longer land.");
    expect(late.output).not.toMatch(/no funds moved|seller sent/i);
    expect(t.paid).toBe(0);
    expect(t.guard()).toBe("");
  }, 120_000);

  it("ends unknown, never failed, when the journal write that records the RPC's error fails", async () => {
    // writes: 1 quoted, 2 submitted (right before the send), 3 unknown (the RPC refused the payment): the 3rd fails once
    const t = await rig({}, { sendError: true });
    const b = await t.buy("disk-full", "3");
    const journal = t.readJournal("disk-full");
    t.audit("disk-full", { code: b.code, state: b.result.state, next: b.result.next, states: journal.history.map((h: { state: string }) => h.state) });
    expect(t.sends.length).toBe(1);
    expect(b.code, b.output).toBe(5);
    expect(b.result).toMatchObject({ state: "unknown", next: expect.stringContaining("reconcile") });
    expect(b.result.next).not.toMatch(/safe to retry/);
    expect(journal.state).toBe("unknown");
    expect(journal.history.map((h: { state: string }) => h.state)).not.toContain("failed");
    expect(journal.expectedTx).toBe(keccak256(t.sends[0] as Hex));
  }, 120_000);

  it("reads no verdict from an RPC on another chain when it reconciles", async () => {
    const t = await rig({}, { chainId: "0x1", headTime: nowS() + 3600 });
    const dir = join(t.home, "budget/ops/tempo-moderato");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString();
    const text = JSON.stringify({
      op: "foreign", rail: "tempo", kind: "buy", state: "submitted", createdAt: stamp, updatedAt: stamp,
      intent: { amount: "10000", amountDecimal: "0.01", token: PATH_USD, recipient: RECIPIENT, chainId: 42431, owner: OWNER, agent: AGENT, mode: "push" },
      startBlock: "1000", memo: MEMO, validBefore: nowS() - 600, history: [{ at: stamp, state: "submitted" }],
    }, null, 2) + "\n";
    writeFileSync(join(dir, "foreign.json"), text);
    const r = await t.reconcile("foreign");
    t.audit("foreign-reconcile", { code: r.code, state: r.result.state, reason: r.result.reason });
    expect(r.code, r.output).toBe(5);
    expect(r.result).toMatchObject({ state: "unknown", reason: expect.stringMatching(/wrong_rpc_chain/) });
    expect(readFileSync(join(dir, "foreign.json"), "utf8")).toBe(text);
    expect(t.calls).not.toContain("eth_getLogs");
  }, 120_000);
});

// buy.ts journals the broadcast in viem's onFetchRequest hook of the client mppx uses. That is only a gate if viem waits for the
// hook before it fetches, and if a hook that throws stops the request. The installed viem is held to both here.
describe("viem's onFetchRequest hook", () => {
  it("is awaited before the request leaves, and a hook that throws stops it", async () => {
    const seen: string[] = [];
    const server = await startServer(async (req, res) => {
      const request = JSON.parse(await readBody(req));
      seen.push(`request:${request.method}`);
      sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result: "0x1" });
    });
    closers.push(() => server.close());
    const client = (hook: () => Promise<void>) =>
      createClient({ chain: tempoModerato, transport: http(server.url, { retryCount: 0, onFetchRequest: hook }) });
    await client(async () => { await new Promise((r) => setTimeout(r, 100)); seen.push("hook"); }).request({ method: "eth_sendRawTransactionSync", params: ["0x00"] } as never);
    expect(seen).toEqual(["hook", "request:eth_sendRawTransactionSync"]);
    seen.length = 0;
    await expect(client(async () => { seen.push("hook"); throw new Error("journal write failed"); }).request({ method: "eth_sendRawTransactionSync", params: ["0x00"] } as never)).rejects.toThrow(/journal write failed/);
    expect(seen).toEqual(["hook"]);
  });
});
