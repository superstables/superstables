import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { SOLANA_DEVNET_GENESIS } from "../../src/core/finality-policy.js";
import { MAINNET_GENESIS } from "../helpers/fake-solana-pay.js";
const ownerModulePath = ["..", "..", "budget", "solana", "owner.ts"].join("/");
const { transactionPort } = await import(ownerModulePath) as { transactionPort: (...args: any[]) => any };

function fixture() {
  const owner = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const sent: Buffer[] = [];
  const calls: string[] = [];
  const cluster = { genesis: SOLANA_DEVNET_GENESIS as string | null };
  const conn = {
    getGenesisHash: async () => {
      calls.push("getGenesisHash");
      if (cluster.genesis === null) throw new Error("no genesis hash");
      return cluster.genesis;
    },
    getLatestBlockhash: async () => { calls.push("getLatestBlockhash"); return { blockhash, lastValidBlockHeight: 100 }; },
    getBlockHeight: async () => 10,
    sendRawTransaction: async (raw: Buffer) => { sent.push(raw); return "sent"; },
  } as unknown as Connection;
  const { port } = transactionPort(conn, owner.publicKey, () => [
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: recipient, lamports: 10_000_000 }),
  ], () => {});
  return { owner, recipient, port, sent, calls, cluster };
}

describe("Solana owner transaction with Phantom fee instructions", () => {
  it("accepts bounded compute-budget instructions prepended by the wallet", async () => {
    const { owner, port, sent } = fixture();
    const prepared = await port.prepare();
    const tx = Transaction.from(Buffer.from(prepared, "base64"));
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500 }),
    );
    tx.sign(owner);
    const result = await port.submit(tx.serialize().toString("base64"), () => true);
    expect(result.status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("accepts Phantom's observed price-before-limit order", async () => {
    const { owner, port, sent } = fixture();
    const prepared = await port.prepare();
    const tx = Transaction.from(Buffer.from(prepared, "base64"));
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 375_000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    );
    tx.sign(owner);
    const result = await port.submit(tx.serialize().toString("base64"), () => true);
    expect(result.status).toBe("sent");
    expect(sent).toHaveLength(1);
  });

  it("still refuses a changed recipient or transfer amount", async () => {
    const { owner, port, sent } = fixture();
    const prepared = await port.prepare();
    const tx = Transaction.from(Buffer.from(prepared, "base64"));
    tx.instructions[0] = SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10_000_000,
    });
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500 }),
    );
    tx.sign(owner);
    expect((await port.submit(tx.serialize().toString("base64"), () => true)).status).toBe("refused");
    expect(sent).toHaveLength(0);
  });

  it("refuses excessive wallet-added priority fees", async () => {
    const { owner, port, sent } = fixture();
    const prepared = await port.prepare();
    const tx = Transaction.from(Buffer.from(prepared, "base64"));
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
    );
    tx.sign(owner);
    expect((await port.submit(tx.serialize().toString("base64"), () => true)).status).toBe("refused");
    expect(sent).toHaveLength(0);
  });
});

describe("the cluster, before anything is built or sent", () => {
  it("builds nothing when the RPC is on another cluster", async () => {
    const { port, calls, cluster } = fixture();
    cluster.genesis = MAINNET_GENESIS;
    await expect(port.prepare()).rejects.toThrow(/not on Solana devnet.*nothing was built or sent/);
    expect(calls).not.toContain("getLatestBlockhash");
  });

  it("builds nothing when the genesis hash cannot be read", async () => {
    const { port, calls, cluster } = fixture();
    cluster.genesis = null;
    await expect(port.prepare()).rejects.toThrow(/could not read which Solana cluster/);
    expect(calls).not.toContain("getLatestBlockhash");
  });

  it("sends nothing when the RPC moved to another cluster after the transaction was built", async () => {
    const { owner, port, sent, cluster } = fixture();
    const prepared = await port.prepare();
    const tx = Transaction.from(Buffer.from(prepared, "base64"));
    tx.sign(owner);
    cluster.genesis = MAINNET_GENESIS;
    const result = await port.submit(tx.serialize().toString("base64"), () => { throw new Error("broadcasting() must not be asked"); });
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/not on Solana devnet/);
    expect(sent).toHaveLength(0);
  });
});
