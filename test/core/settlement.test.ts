// The chain check on a `pay` settlement, against a fake Base Sepolia: the seller's transaction counts as this payment
// only when its receipt succeeded and the USDC contract logged both the owner's nonce being used and the exact transfer.

import { afterEach, describe, expect, it } from "vitest";
import { BASE_SEPOLIA, EVM_NETWORKS, POLYGON_AMOY, SKALE_BASE_SEPOLIA } from "../../src/core/chain.js";
import { checkSettlement, findAuthorization, settlementRpc } from "../../src/core/settlement.js";
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

  it("reads only an RPC that uses HTTPS, or HTTP on this machine", () => {
    expect(settlementRpc({})).toEqual({ url: "https://sepolia.base.org" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "https://rpc.example/x" })).toEqual({ url: "https://rpc.example/x" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "http://127.0.0.1:8545" })).toEqual({ url: "http://127.0.0.1:8545" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "http://rpc.example" })).toEqual({ error: "SUPERSTABLES_RPC_URL must use HTTPS, or HTTP on this machine" });
    expect(settlementRpc({ SUPERSTABLES_RPC_URL: "https://u:p@rpc.example" })).toHaveProperty("error");
  });
});

describe("findAuthorization", () => {
  const find = (over: Record<string, unknown> = {}, fetchImpl?: typeof fetch) =>
    findAuthorization(
      {
        network: "eip155:84532",
        payer: PAYER,
        recipient: PAY_TO,
        amountAtomic: "10000",
        nonce: NONCE,
        validBefore: new Date(Date.now() + 300_000).toISOString(),
        since: new Date(Date.now() - 60_000).toISOString(),
        ...over,
      },
      { rpcUrl: chain!.url, ...(fetchImpl ? { fetchImpl } : {}) },
    );

  it("finds the transaction that used the nonce the owner signed, whichever transaction a seller named", async () => {
    chain = await startFakeBaseSepolia();
    // Days of blocks before the attempt began: the search finds where it began by the blocks' times, not from block 0.
    chain.advance(5 * 24 * 3600);
    const since = new Date((chain.head.timestamp - 60) * 1000).toISOString();
    const tx = chain.settle({ from: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE });
    chain.advance(600);
    expect(await find({ since })).toEqual({ found: true, transaction: tx });
    expect(await find({ since, transaction: `0x${"cd".repeat(32)}` })).toEqual({ found: true, transaction: tx });
    // A transfer of the same amount to the same recipient with another nonce is not this payment.
    const other = `0x${"55".repeat(32)}`;
    expect(await find({ since, nonce: other, validBefore: new Date((chain.head.timestamp - 500) * 1000).toISOString() })).toMatchObject({ found: false, never: true });
  });

  it("says unused while the authorization can still be used, and never once the chain's time is past validBefore", async () => {
    chain = await startFakeBaseSepolia();
    const validBefore = new Date((chain.head.timestamp + 300) * 1000).toISOString();
    const open = await find({ validBefore });
    expect(open).toEqual({ found: false, reason: `the chain shows the owner's authorization unused so far; it can still be used until ${validBefore}` });
    // The latest block is past validBefore, but the finalized one is not: a reorg could still bring a use. Not yet.
    chain.finalizedLag = 300; // ten minutes of blocks
    chain.advance(360);
    expect(await find({ validBefore })).not.toHaveProperty("never");
    // The finalized chain is past it: never.
    chain.advance(600);
    expect(await find({ validBefore })).toMatchObject({ found: false, never: true, reason: expect.stringMatching(/never used, and it can no longer be/) });
    // An RPC that answers no finalized block, or fails to: nothing is decided, however long ago validBefore was.
    chain.finalizedLag = undefined;
    const later = new Date((chain.head.timestamp - 500) * 1000).toISOString();
    chain.advance(3_600);
    const unfinal = await find({ validBefore: later });
    expect(unfinal).toMatchObject({ found: false, reason: expect.stringMatching(/no final block confirms that yet/) });
    expect(unfinal).not.toHaveProperty("never");
    // No validBefore recorded: never called final.
    expect(await find({ validBefore: undefined })).toEqual({ found: false, reason: "the chain shows the owner's authorization unused so far" });
  });

  it("calls a cancelled authorization final only in a final block, and decides nothing when the chain cannot be read", async () => {
    chain = await startFakeBaseSepolia();
    chain.settle({ from: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE });
    chain.used.get(NONCE)!.cancelled = true;
    // The cancellation is two blocks past the finalized block: a reorg could still remove it.
    chain.finalizedLag = 2;
    const recent = await find();
    expect(recent).toMatchObject({ found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" });
    expect(recent).not.toHaveProperty("never");
    chain.advance(10);
    expect(await find()).toMatchObject({ found: false, never: true, reason: expect.stringMatching(/cancelled, in a final block/) });
    // The same final cancellation, with the finalized block unreadable for a moment: nothing is decided, and the reason
    // does not say the block is not final.
    const noFinal = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { id: number; params: unknown[] };
      if (call.params[0] === "finalized") return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "busy" } }));
      return fetch(input, init);
    }) as typeof fetch;
    const unread = await find({}, noFinal);
    expect(unread).toEqual({ found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" });
    chain.down = true;
    expect(await find()).toMatchObject({ found: false, unreadable: true });
    expect(await find({ nonce: undefined })).toMatchObject({ found: false, reason: expect.stringMatching(/not recorded/) });
  });

  /** A fetch that runs `then` once, right after the chain answers the first call matching `when`, and before it is used. */
  const after = (when: (call: { method: string; params: unknown[] }) => boolean, then: () => void, rewrite?: (result: unknown) => unknown) => {
    let done = false;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const answer = await fetch(input, init);
      if (done || !when(call)) return answer;
      done = true;
      const body = (await answer.json()) as { result: unknown };
      then();
      return new Response(JSON.stringify({ ...body, result: rewrite ? rewrite(body.result) : body.result }));
    }) as typeof fetch;
  };

  it("never takes a cancellation that a reorganisation replaced with the payment as final, whatever the final block says", async () => {
    // As the round-3 review reproduced it, on Polygon Amoy: the cancellation is read above the finalized block; then a
    // reorganisation replaces it with the facilitator's payment of the same authorization, and finality passes it.
    chain = await startFakeBaseSepolia();
    const token = POLYGON_AMOY.usdc.address;
    const cancelled = chain.settle({ from: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE, token });
    chain.used.get(NONCE)!.cancelled = true;
    chain.finalizedLag = 2;
    let paid = "";
    const reorg = () => {
      const at = chain!.used.get(NONCE)!.block;
      chain!.used.delete(NONCE);
      chain!.receipts.delete(cancelled);
      chain!.head = { number: at - 1n, timestamp: chain!.head.timestamp - chain!.secondsPerBlock };
      paid = chain!.settle({ from: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE, token });
      chain!.advance(8);
      chain!.finalizedLag = 0;
    };
    const amoy = { network: POLYGON_AMOY.caip2 };
    const first = await find(amoy, after((c) => c.method === "eth_getLogs", reorg));
    expect(first).toEqual({ found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" });
    expect(await find(amoy)).toEqual({ found: true, transaction: paid });
  });

  it("calls a cancellation final only while its block is still the chain's block at that height, read after the final block", async () => {
    chain = await startFakeBaseSepolia();
    chain.settle({ from: PAYER, to: PAY_TO, value: 10000n, nonce: NONCE });
    const used = chain.used.get(NONCE)!;
    used.cancelled = true;
    chain.advance(20);
    // The cancellation's block is replaced with the payment after the logs were read (a node that served the logs from
    // another view of the chain than the one it now serves): the block's hash no longer matches.
    const replaced = await find({}, after((c) => c.method === "eth_getLogs", () => (used.cancelled = false)));
    expect(replaced).toEqual({ found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" });
    // A log the node marks removed, or one that names no block hash, is not in the chain's history.
    used.cancelled = true;
    const notFinal = { found: false, reason: "the chain shows the owner's authorization cancelled, but the client could not confirm that the cancellation is final" };
    const removed = await find({}, after((c) => c.method === "eth_getLogs", () => {}, (logs) => (logs as object[]).map((l) => ({ ...l, removed: true }))));
    expect(removed).toEqual(notFinal);
    const unnamed = await find({}, after((c) => c.method === "eth_getLogs", () => {}, (logs) => (logs as object[]).map((l) => ({ ...l, blockHash: undefined }))));
    expect(unnamed).toEqual(notFinal);
    // A cancellation above the final block is not final, even from an RPC whose token says the nonce is used there.
    chain.finalizedLag = 15;
    const used15 = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (call.method !== "eth_call") return fetch(input, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: `0x${"0".repeat(63)}1` }));
    }) as typeof fetch;
    expect(await find({}, used15)).toEqual(notFinal);
    chain.finalizedLag = 0;
    // The final block is read before the logs: a cancellation that only became final after them is not taken as final.
    chain.finalizedLag = 30;
    const finalLater = await find({}, after((c) => c.method === "eth_getLogs", () => (chain!.finalizedLag = 0)));
    expect(finalLater).not.toHaveProperty("never");
    // As it is: final.
    expect(await find()).toMatchObject({ found: false, never: true, reason: "the chain shows the owner's authorization was cancelled, in a final block, so it can never be used" });
  });
});

describe("finality on each EVM chain", () => {
  it("reads finality from the finalized tag on every EVM chain but SKALE's, whose blocks are final once in the chain", () => {
    for (const network of EVM_NETWORKS) expect(network.finality, network.key).toBe(network.key === "skale-base-sepolia" ? "instant" : "finalized");
  });

  it("decides on SKALE by its latest block, which its RPC does not tag finalized", async () => {
    chain = await startFakeBaseSepolia();
    chain.finalizedLag = undefined; // SKALE's RPC refuses the finalized tag
    const validBefore = new Date((chain.head.timestamp + 60) * 1000).toISOString();
    chain.advance(120);
    const skale = await findAuthorization(
      { network: SKALE_BASE_SEPOLIA.caip2, payer: PAYER, recipient: PAY_TO, amountAtomic: "10000", nonce: NONCE, validBefore, since: new Date().toISOString() },
      { rpcUrl: chain.url },
    );
    expect(skale).toMatchObject({ found: false, never: true });
    // The same answers from a chain that needs a finalized block: undecided.
    const base = await findAuthorization(
      { network: BASE_SEPOLIA.caip2, payer: PAYER, recipient: PAY_TO, amountAtomic: "10000", nonce: NONCE, validBefore, since: new Date().toISOString() },
      { rpcUrl: chain.url },
    );
    expect(base).not.toHaveProperty("never");
  });

  it("decides nothing when the finalized block cannot be read for a moment", async () => {
    chain = await startFakeBaseSepolia();
    const validBefore = new Date((chain.head.timestamp + 300) * 1000).toISOString();
    chain.advance(1_000);
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = JSON.parse(String(init?.body));
      if (req.method === "eth_getBlockByNumber" && req.params[0] === "finalized") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "temporary finalized-read failure" } }), { status: 200 });
      }
      return fetch(input, init);
    };
    const result = await findAuthorization(
      { network: BASE_SEPOLIA.caip2, payer: PAYER, recipient: PAY_TO, amountAtomic: "10000", nonce: NONCE, validBefore },
      { rpcUrl: chain.url, fetchImpl },
    );
    expect(result).not.toHaveProperty("never");
  });
});
