// The chain check on a `pay` settlement, against a fake Base Sepolia: the seller's transaction counts as this payment
// only when its receipt succeeded and the USDC contract logged both the owner's nonce being used and the exact transfer.

import { afterEach, describe, expect, it } from "vitest";
import { checkSettlement, settlementRpc } from "../../src/core/settlement.js";
import { paymentReceipt, startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";

const PAYER = `0x${"11".repeat(20)}`;
const PAY_TO = `0x${"22".repeat(20)}`;
const OTHER = `0x${"33".repeat(20)}`;
const NONCE = `0x${"44".repeat(32)}`;
const TX = `0x${"ab".repeat(32)}`;
const PAYMENT = { transaction: TX, payer: PAYER, recipient: PAY_TO, amountAtomic: "10000", nonce: NONCE };

let chain: FakeBaseSepolia | undefined;
afterEach(async () => {
  await chain?.close();
  chain = undefined;
});

async function withReceipt(receipt: unknown) {
  chain = await startFakeBaseSepolia();
  if (receipt !== undefined) chain.receipts.set(TX, receipt);
  return checkSettlement(PAYMENT, { rpcUrl: chain.url });
}

describe("checkSettlement", () => {
  it("verifies the transaction that used the signed nonce and paid the exact amount to the checked recipient", async () => {
    expect(await withReceipt(paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE }))).toEqual({ chain: "verified" });
  });

  it("reports a mismatch for the wrong amount, recipient or nonce, or a reverted transaction", async () => {
    const cases = [
      paymentReceipt({ payer: PAYER, to: PAY_TO, value: 9999n, nonce: NONCE }),
      paymentReceipt({ payer: PAYER, to: OTHER, value: 10000n, nonce: NONCE }),
      paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: `0x${"55".repeat(32)}` }),
      paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE, status: "0x0" }),
      paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE, token: OTHER }),
    ];
    for (const receipt of cases) {
      const result = await withReceipt(receipt);
      expect(result.chain, JSON.stringify(receipt)).toBe("mismatch");
      expect(result.reason).toBeTruthy();
      await chain?.close();
      chain = undefined;
    }
  });

  it("does not read a receipt that is for another transaction, or names none", async () => {
    for (const transactionHash of [`0x${"cd".repeat(32)}`, "", "not a hash", null]) {
      const receipt = { ...(paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE }) as object), transactionHash };
      const result = await withReceipt(receipt);
      expect(result.chain, String(transactionHash)).toBe("unchecked");
      expect(result.reason).toContain("a receipt for another transaction");
      await chain?.close();
      chain = undefined;
    }
    // The same hash in other letter case is the same transaction.
    expect(await withReceipt({ ...(paymentReceipt({ payer: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE }) as object), transactionHash: TX.toUpperCase().replace("0X", "0x") })).toEqual({ chain: "verified" });
  });

  it("leaves it unchecked when the chain does not show the transaction yet", async () => {
    expect(await withReceipt(undefined)).toEqual({ chain: "unchecked", reason: "the chain does not show the transaction yet" });
  });

  it("leaves it unchecked when the RPC is down or does not answer", async () => {
    chain = await startFakeBaseSepolia();
    chain.down = true;
    expect((await checkSettlement(PAYMENT, { rpcUrl: chain.url })).chain).toBe("unchecked");
    const unreachable = await checkSettlement(PAYMENT, { rpcUrl: "http://127.0.0.1:9/" });
    expect(unreachable.chain).toBe("unchecked");
    expect(unreachable.reason).toContain("the chain could not be read");
  });

  it("leaves it unchecked without reading anything when no hash was given", async () => {
    chain = await startFakeBaseSepolia();
    for (const transaction of [undefined, "", "pending-123", "Superstables: owner approved"]) {
      expect(await checkSettlement({ ...PAYMENT, transaction }, { rpcUrl: chain.url })).toEqual({ chain: "unchecked", reason: "no transaction hash was given" });
    }
    expect(chain.calls).toBe(0);
  });

  it("reads only an RPC that is https, or http on this computer", () => {
    expect(settlementRpc({})).toEqual({ url: "https://sepolia.base.org" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "https://rpc.example/x" })).toEqual({ url: "https://rpc.example/x" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "http://127.0.0.1:8545" })).toEqual({ url: "http://127.0.0.1:8545" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "http://rpc.example" })).toHaveProperty("error");
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "https://u:p@rpc.example" })).toHaveProperty("error");
  });
});
