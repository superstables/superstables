// A seller's payment split must not carry a memo in mppx's own format: a transfer with such a memo reads, to reconcile and to the
// memo search, as the payment for the purchase it was made for. The check is pure; one test runs the whole buy script on loopback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge } from "mppx";
import { keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { MPP_MEMO_TAG, precheckCharge } from "../../budget/tempo/lib/precheck.mjs";
import { PATH_USD, startFakeTempo } from "../helpers/fake-chains.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const SPLIT_TO = "0x3333333333333333333333333333333333333333";
const KEY = `0x${"01".repeat(32)}` satisfies Hex;
const AGENT = privateKeyToAccount(KEY).address;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const nowS = () => Math.floor(Date.now() / 1000);

// loaded by URL, so the type check does not follow the rail's own imports (it runs them with tsx)
const { mppMemo } = await import(new URL("../../budget/tempo/lib/chain.ts", import.meta.url).href);
// the memo mppx puts on a payment for another challenge
const OTHER: string = mppMemo("other-challenge", "seller.example");

const priced = (splits: unknown) =>
  precheckCharge({ amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: ["push"], splits } }, { maxBase: 100000n });
const split = (memo?: string) => [{ recipient: SPLIT_TO, amount: "1000", ...(memo === undefined ? {} : { memo }) }];

describe("a payment split that carries a purchase memo", () => {
  it("MPP_MEMO_TAG is the first 4 bytes of keccak256('mpp'), the tag of every memo this client searches for", () => {
    expect(MPP_MEMO_TAG).toBe(keccak256(toBytes("mpp")).slice(0, 10));
    expect(OTHER.slice(0, 10)).toBe(MPP_MEMO_TAG);
  });

  it("is refused: a transfer with that memo would read as another purchase's payment", () => {
    const refused = priced(split(OTHER));
    expect(refused).toMatchObject({ ok: false, code: "bad_split" });
    expect((refused as { reason: string }).reason).toContain("could be counted as another purchase's payment");
  });

  it("is refused in upper case and whatever the version byte", () => {
    expect(priced(split(`0x${OTHER.slice(2).toUpperCase()}`))).toMatchObject({ ok: false, code: "bad_split" });
    expect(priced(split(`0xEF1ED712${OTHER.slice(10)}`))).toMatchObject({ ok: false, code: "bad_split" });
    expect(priced(split(`0x${OTHER.slice(2, 10)}02${OTHER.slice(12)}`))).toMatchObject({ ok: false, code: "bad_split" });
    expect(priced(split(`0x${OTHER.slice(2, 10)}ff${OTHER.slice(12)}`))).toMatchObject({ ok: false, code: "bad_split" });
  });

  it("is refused when it is only the second of two splits", () => {
    const splits = [{ recipient: SPLIT_TO, amount: "500" }, { recipient: SPLIT_TO, amount: "500", memo: OTHER }];
    expect(priced(splits)).toMatchObject({ ok: false, code: "bad_split" });
  });

  it("does not put the memo in the words of the refusal", () => {
    expect(JSON.stringify(priced(split(OTHER)), (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain(OTHER.slice(2));
  });

  it("leaves other 32-byte memos and splits without one alone", () => {
    expect(priced(split(`0x${"ab".repeat(32)}`))).toMatchObject({ ok: true });
    expect(priced(split(`0x${"00".repeat(32)}`))).toMatchObject({ ok: true });
    expect(priced(split(`0xef1ed711${"00".repeat(28)}`))).toMatchObject({ ok: true });
    expect(priced(split())).toMatchObject({ ok: true });
  });
});

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  while (closers.length) await closers.pop()!();
});

describe("budget buy on Tempo", () => {
  it("ends refused_precheck, signing and sending nothing, when a split carries a purchase memo", async () => {
    const home = mkdtempSync(join(tmpdir(), "tempo-split-memo-"));
    const guardLog = join(home, "network.log");
    writeFileSync(guardLog, "");
    mkdirSync(join(home, "keys/budget"), { recursive: true });
    writeFileSync(join(home, "keys/budget/tempo-agent.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
    const chain = await startFakeTempo();
    chain.keys.set(`${OWNER}:${AGENT.toLowerCase()}`, {
      expiry: BigInt(nowS() + 3600), limit: 10_000_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false,
    });
    const challenge = Challenge.from({
      secretKey: "local-test-secret", realm: "seller.example", method: "tempo", intent: "charge",
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: { amount: "10000", currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: ["push", "pull"], splits: split(OTHER) } },
    });
    const calls: string[] = [];
    const rpc = await startServer(async (req, res) => {
      const request = JSON.parse(await readBody(req));
      calls.push(request.method);
      const answer = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
      switch (request.method) {
        case "eth_chainId": return answer(hex(42431));
        case "eth_estimateGas": return answer("0x10000");
        case "eth_gasPrice":
        case "eth_maxPriorityFeePerGas": return answer("0x1");
        case "eth_getTransactionCount": return answer("0x0");
        case "eth_getBlockByNumber":
          return answer({ number: "0x3e8", hash: `0x${"ab".repeat(32)}`, timestamp: hex(nowS()), baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0", transactions: [] });
        // a payment that gets this far is signed and sent: the fake node refuses it, so nothing is left in flight
        case "eth_sendRawTransactionSync":
        case "eth_sendRawTransaction": return sendJson(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "nonce too low" } });
        case "eth_getTransactionReceipt":
        case "eth_getTransactionByHash": return answer(null);
        case "eth_getLogs": return answer([]);
      }
      const response = await fetch(chain.url, { method: "POST", body: JSON.stringify(request) });
      return sendJson(res, 200, await response.json());
    });
    let paid = 0;
    const seller = await startServer((req, res) => {
      if (typeof req.headers.authorization !== "string") return sendJson(res, 402, {}, { "www-authenticate": Challenge.serialize(challenge) });
      paid++;
      return sendJson(res, 200, { ok: true });
    });
    closers.push(async () => {
      await seller.close();
      await rpc.close();
      await chain.close();
      rmSync(home, { recursive: true, force: true });
    });
    const child = await guardedNode(["--import=tsx", "budget/tempo/buy.ts", "--url", seller.url, "--max", "0.01", "--op", "split-memo"], {
      HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog,
    });
    const result = JSON.parse(child.output.split("\n").filter((l) => l.startsWith("RESULT ")).pop()!.slice(7));
    expect(child.code, child.output).toBe(3);
    expect(result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^bad_split: .*could be counted as another purchase's payment/) });
    expect(calls.filter((c) => c.startsWith("eth_sendRawTransaction"))).toEqual([]);
    expect(calls).not.toContain("eth_estimateGas");
    expect(paid).toBe(0);
    expect(JSON.parse(readFileSync(join(home, "budget/ops/tempo-moderato/split-memo.json"), "utf8"))).toMatchObject({ state: "refused_precheck" });
    expect(readFileSync(guardLog, "utf8")).toBe("");
  }, 120_000);
});
