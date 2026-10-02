import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
const ownerModulePath = ["..", "..", "budget", "solana", "owner.ts"].join("/");
const { transactionPort } = await import(ownerModulePath) as { transactionPort: (...args: any[]) => any };

function fixture() {
  const owner = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const sent: Buffer[] = [];
  const conn = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getBlockHeight: async () => 10,
    sendRawTransaction: async (raw: Buffer) => { sent.push(raw); return "sent"; },
  } as unknown as Connection;
  const { port } = transactionPort(conn, owner.publicKey, () => [
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: recipient, lamports: 10_000_000 }),
  ], () => {});
  return { owner, recipient, port, sent };
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
