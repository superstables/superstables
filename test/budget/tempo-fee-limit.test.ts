// A Tempo network fee paid by the owner's account is paid in the access key's own limit token and counts against the limit
// (measured on Moderato, 16 October 2026): so a purchase is refused before signing when price plus the largest possible fee
// exceeds what is left, and a payment the chain refused is not described as one where no funds moved. Loopback fakes only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge } from "mppx";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { budgetShortfall, maxFeeUnits, ownerPaysFee } from "../../budget/tempo/lib/precheck.mjs";
import { PATH_USD, startFakeTempo } from "../helpers/fake-chains.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"01".repeat(32)}` satisfies Hex;
const AGENT = privateKeyToAccount(KEY).address;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const nowS = () => Math.floor(Date.now() / 1000);
const PRICE = 10_000n;

const { feeOf } = await import(new URL("../../budget/tempo/lib/chain.ts", import.meta.url).href);
const { failedNext, feeSentence, notFoundFee, notFoundNext } = await import(new URL("../../budget/tempo/lib/words.ts", import.meta.url).href);

const key = (remaining: bigint) => ({ spendPolicy: "limited", remaining, periodEnd: 0, expiry: 0 });

describe("the limit check", () => {
  it("measured numbers: fee = ceil(gasUsed * effectiveGasPrice / 1e12)", () => {
    expect(feeOf({ gasUsed: hex(54670), effectiveGasPrice: hex(600000001) })).toBe(33n);
    expect(feeOf({ gasUsed: hex(66258), effectiveGasPrice: hex(600000001) })).toBe(40n);
    expect(feeOf({ gasUsed: hex(40996), effectiveGasPrice: hex(600000001) })).toBe(25n);
    expect(feeOf({ gasUsed: hex(54670) })).toBeUndefined();
  });

  it("the bound is never below the reservation measured (45 units) for the plain-call estimate", () => {
    // a plain transfer estimates at least 34674 gas (21000 + the 13674 the key check and revert added): the measured reservation was 42 to 45 units
    expect(maxFeeUnits(34674n, 600000000n)).toBeGreaterThanOrEqual(45n);
    expect(maxFeeUnits(0n, 600000000n)).toBe(0n);
    expect(maxFeeUnits(70000n, 0n)).toBe(0n);
  });

  it("refuses when price plus the largest fee exceeds what is left, and says so", () => {
    expect(budgetShortfall(key(PRICE), PRICE, Date.now(), 101n)).toBe("price 0.01 pathUSD plus up to 0.000101 pathUSD for the network fee exceeds the remaining budget 0.01 pathUSD");
    expect(budgetShortfall(key(PRICE + 100n), PRICE, Date.now(), 101n)).not.toBeNull();
    expect(budgetShortfall(key(PRICE + 101n), PRICE, Date.now(), 101n)).toBeNull();
  });

  it("with no fee term it compares the price alone, as before", () => {
    expect(budgetShortfall(key(PRICE), PRICE)).toBeNull();
    expect(budgetShortfall(key(PRICE), PRICE, Date.now(), 0n)).toBeNull();
    expect(budgetShortfall(key(PRICE - 1n), PRICE)).toBe("price 0.01 pathUSD exceeds the remaining budget 0.009999 pathUSD");
    expect(budgetShortfall({ spendPolicy: "unlimited", remaining: 0n, periodEnd: 0 }, PRICE, Date.now(), 101n)).toBeNull();
  });

  it("the mode decides who pays the fee: only a pull payment with a fee payer is sponsored", () => {
    expect(ownerPaysFee("push", { feePayer: true })).toBe(true);
    expect(ownerPaysFee("push", {})).toBe(true);
    expect(ownerPaysFee("pull", {})).toBe(true);
    expect(ownerPaysFee("pull", { feePayer: true })).toBe(false);
  });
});

describe("what a refused payment is said to have cost", () => {
  it("a reverted payment names its fee and does not say no funds moved", () => {
    const words = feeSentence(25n, undefined, OWNER);
    expect(words).toBe("a network fee of 0.000025 pathUSD was still charged to the owner's account and counts against the budget.");
    expect(feeSentence(undefined, undefined, OWNER)).toContain("a network fee was still charged");
    expect(feeSentence(25n, "0x3333333333333333333333333333333333333333", OWNER)).toContain("fee payer paid");
    expect(words).not.toMatch(/no funds moved/i);
  });

  it("a missing payment names the fall in the budget when it is known, and only the chance of a fee otherwise", () => {
    expect(notFoundFee(25n, "pull")).toBe("The price was not paid. The budget fell by 0.000025 pathUSD while this purchase was open: a payment the chain refused still costs its network fee, and other purchases with this key count too.");
    expect(notFoundNext(25n, "pull")).toBe("the price was not paid; the budget fell by 0.000025 pathUSD while this purchase was open (a refused payment's network fee, or other purchases with this key); safe to retry with a new op id");
    expect(notFoundFee(0n, "pull")).toMatch(/If the seller sent the payment.*may still have been charged/);
    expect(notFoundFee(0n, "pull")).not.toMatch(/no funds moved/i);
  });

  it("in push mode the client sends, so nothing is said about the seller sending", () => {
    expect(notFoundFee(0n, "push")).toBe("The price was not paid, and the signed payment can no longer land.");
    expect(notFoundNext(0n, "push")).toBe("the price was not paid; safe to retry with a new op id");
    expect(notFoundFee(0n, "push")).not.toMatch(/seller/);
  });

  it("the next of a reverted payment follows who paid the fee", () => {
    const sponsor = "0x3333333333333333333333333333333333333333";
    expect(failedNext(sponsor, OWNER)).toBe("read the tx on the explorer; the price was not paid and the seller's fee payer paid the network fee; safe to retry with a new op id");
    expect(failedNext(undefined, OWNER)).toContain("a network fee was charged to the owner's account");
    expect(failedNext(OWNER, OWNER)).toContain("charged to the owner's account");
  });
});

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  while (closers.length) await closers.pop()!();
});

type Setup = { limit: bigint; modes: string[]; feePayer?: boolean; estimate?: "ok" | "throw"; gasPrice?: string };

/** buy.ts on loopback against a fake chain and a fake seller; the fake node refuses every send, so nothing is left in flight. */
async function run(setup: Setup, name: string, script = "budget/tempo/buy.ts", extra: string[] = ["--max", "0.01"]) {
  const home = mkdtempSync(join(tmpdir(), "tempo-fee-limit-"));
  const guardLog = join(home, "network.log");
  writeFileSync(guardLog, "");
  mkdirSync(join(home, "keys/budget"), { recursive: true });
  writeFileSync(join(home, "keys/budget/tempo-agent.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  const chain = await startFakeTempo();
  chain.keys.set(`${OWNER}:${AGENT.toLowerCase()}`, { expiry: BigInt(nowS() + 3600), limit: setup.limit, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
  const challenge = Challenge.from({
    secretKey: "local-test-secret", realm: "seller.example", method: "tempo", intent: "charge",
    expires: new Date(Date.now() + 60_000).toISOString(),
    request: { amount: PRICE.toString(), currency: PATH_USD, recipient: RECIPIENT, methodDetails: { chainId: 42431, supportedModes: setup.modes, ...(setup.feePayer ? { feePayer: true } : {}) } },
  });
  const calls: string[] = [];
  const feeEstimates: unknown[] = [];
  const rpc = await startServer(async (req, res) => {
    const request = JSON.parse(await readBody(req));
    calls.push(request.method);
    const answer = (result: unknown) => sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
    switch (request.method) {
      case "eth_chainId": return answer(hex(42431));
      case "eth_estimateGas": {
        const p = request.params?.[0] ?? {};
        // the client's own fee read: one flat call on the token from the owner (mppx estimates a whole transaction instead)
        if (p.to?.toLowerCase() === PATH_USD.toLowerCase() && typeof p.data === "string" && !p.calls) {
          feeEstimates.push(p);
          if (setup.estimate === "throw") return sendJson(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: 3, message: "execution reverted" } });
        }
        return answer("0x10000");
      }
      case "eth_gasPrice": return answer(setup.gasPrice ?? "0x3b9aca00");
      case "eth_maxPriorityFeePerGas": return answer("0x1");
      case "eth_getTransactionCount": return answer("0x0");
      case "eth_getBlockByNumber":
        return answer({ number: "0x3e8", hash: `0x${"ab".repeat(32)}`, timestamp: hex(nowS()), baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0", transactions: [] });
      case "eth_sendRawTransactionSync":
      case "eth_sendRawTransaction": return sendJson(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "nonce too low" } });
      case "eth_getTransactionReceipt":
      case "eth_getTransactionByHash": return answer(null);
      case "eth_getLogs": return answer([]);
    }
    const response = await fetch(chain.url, { method: "POST", body: JSON.stringify(request) });
    return sendJson(res, 200, await response.json());
  });
  const seller = await startServer((req, res) => {
    if (typeof req.headers.authorization !== "string") return sendJson(res, 402, {}, { "www-authenticate": Challenge.serialize(challenge) });
    return sendJson(res, 200, { ok: true });
  });
  closers.push(async () => {
    await seller.close();
    await rpc.close();
    await chain.close();
    rmSync(home, { recursive: true, force: true });
  });
  const child = await guardedNode(script === "budget/cli.mjs"
    ? [script, "buy", "--rail", "tempo", "--url", seller.url, "--max", "0.01", "--op", name]
    : ["--import=tsx", script, "--url", seller.url, ...extra, "--op", name], {
    HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog,
  });
  const line = child.output.split("\n").filter((l) => l.startsWith("RESULT ")).pop();
  const result = line ? JSON.parse(line.slice(7)) : null;
  return { child, result, sends: calls.filter((c) => c.startsWith("eth_sendRawTransaction")), feeEstimates, guard: readFileSync(guardLog, "utf8") };
}

describe("budget buy on Tempo, the owner paying the fee", () => {
  it("push: remaining equal to the price is refused before signing, with the fee in the words", async () => {
    const r = await run({ limit: PRICE, modes: ["push"] }, "fee-push-equal");
    expect(r.child.code, r.child.output).toBe(3);
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^budget_too_low: price 0\.01 pathUSD plus up to 0\.000197 pathUSD for the network fee exceeds the remaining budget 0\.01 pathUSD$/) });
    expect(r.sends).toEqual([]);
    expect(r.feeEstimates).toHaveLength(1);
    expect(r.guard).toBe("");
  }, 120_000);

  it("through the CLI, the refusal keeps budget_spent and tells the owner about the fee", async () => {
    const r = await run({ limit: PRICE, modes: ["push"] }, "fee-push-cli", "budget/cli.mjs");
    expect(r.result.reason).toContain("for the network fee exceeds the remaining budget");
    expect(r.result.budget_spent).toBe(true);
    expect(r.result.message_for_owner).toContain("and its network fee (up to 0.000197 pathUSD), which counts against the budget. Nothing was paid.");
    expect(r.sends).toEqual([]);
  }, 120_000);

  it("push: a budget that covers price plus the largest fee goes on to sign", async () => {
    const r = await run({ limit: 10_000_000n, modes: ["push"] }, "fee-push-ample");
    expect(r.result.reason ?? "").not.toMatch(/budget_too_low/);
    expect(r.sends.length).toBeGreaterThan(0);
  }, 120_000);

  it("a seller claiming feePayer but offering push only is treated as unsponsored", async () => {
    const r = await run({ limit: PRICE, modes: ["push"], feePayer: true }, "fee-push-claim");
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/^budget_too_low: .*for the network fee/) });
    expect(r.sends).toEqual([]);
  }, 120_000);

  it("an estimate that fails leaves the old path: it says so and the chain decides", async () => {
    const r = await run({ limit: PRICE, modes: ["push"], estimate: "throw" }, "fee-push-throw");
    expect(r.child.output).toContain("could not estimate the network fee; the chain still checks the limit");
    expect(r.result.reason ?? "").not.toMatch(/budget_too_low/);
    expect(r.sends.length).toBeGreaterThan(0);
  }, 120_000);

  it("a fee estimate of 0 changes nothing", async () => {
    const r = await run({ limit: PRICE, modes: ["push"], gasPrice: "0x0" }, "fee-push-zero");
    expect(r.result.reason ?? "").not.toMatch(/budget_too_low/);
    expect(r.sends.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("budget buy on Tempo, the owner paying the fee in pull mode", () => {
  it("pull without a fee payer: remaining equal to the price is refused before signing", async () => {
    const r = await run({ limit: PRICE, modes: ["pull"] }, "fee-pull-unsponsored");
    expect(r.result).toMatchObject({ state: "refused_precheck", reason: expect.stringMatching(/for the network fee exceeds the remaining budget/) });
    expect(r.sends).toEqual([]);
    expect(r.feeEstimates).toHaveLength(1);
  }, 120_000);
});

describe("budget buy on Tempo, the seller paying the fee", () => {
  it("pull with a fee payer: the fee is ignored and no fee estimate is asked for", async () => {
    const r = await run({ limit: PRICE, modes: ["pull"], feePayer: true }, "fee-pull-sponsored");
    expect(r.result.reason ?? "").not.toMatch(/budget_too_low/);
    expect(r.child.output).toContain("credential created: mode=pull");
    expect(r.feeEstimates).toEqual([]);
  }, 180_000);
});
