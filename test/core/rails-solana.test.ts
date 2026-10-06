// x402 exact on Solana devnet: the rail (src/core/rails/solana.ts) and the transaction it pays with
// (src/core/rails/solana-transaction.ts). The client builds the transaction without a Solana SDK, so every piece of the
// wire format is checked here against @solana/web3.js (a devDependency the budget uses): base58, the curve check behind
// program-derived addresses, the token accounts, the message and the transaction, byte for byte. Then the rail's own
// judgement: which offers it pays and which it refuses before the owner is asked, the credential, and what the chain
// must show for a payment to count.

import { randomBytes } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_DEVNET } from "../../src/core/chain.js";
import { SUPPORTED_NETWORKS, judgeAccept, judgeSignRequest, payableLabels } from "../../src/core/rails/index.js";
import { solanaRail } from "../../src/core/rails/solana.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  MEMO_PROGRAM,
  TOKEN_PROGRAM,
  base58Encode,
  buildPayment,
  checkSigned,
  isOnCurve,
  tokenAccountOf,
} from "../../src/core/rails/solana-transaction.js";
import type { Offer, PaymentFacts } from "../../src/core/rails/types.js";
import type { SolanaSignRequest, SolanaSignResult } from "../../src/core/signer/types.js";
import type { Challenge, RawAccept } from "../../src/core/x402.js";
import { MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet, type FakeSolanaDevnet, type RpcTx } from "../helpers/fake-solana-pay.js";

const P = 2n ** 255n - 19n;
const le32 = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
};

function goodAccept(over: Partial<RawAccept> = {}): RawAccept {
  return {
    scheme: "exact",
    network: SOLANA_DEVNET.caip2,
    amount: "10000",
    asset: MINT,
    payTo: randomAddress(),
    maxTimeoutSeconds: 60,
    extra: { feePayer: randomAddress() },
    ...over,
  };
}

describe("the Solana wire format, against @solana/web3.js", () => {
  it("writes base58 as bs58 does, leading zero bytes included", () => {
    for (let i = 0; i < 200; i += 1) {
      const bytes = randomBytes(4 + (i % 61));
      if (i % 5 === 0) bytes.fill(0, 0, 1 + (i % 3));
      expect(base58Encode(bytes)).toBe(bs58.encode(bytes));
    }
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
  });

  it("tells a point on the ed25519 curve from bytes that are not one, as PublicKey.isOnCurve does", () => {
    const vectors: Uint8Array[] = [];
    for (let i = 0; i < 600; i += 1) vectors.push(randomBytes(32));
    // the edges: y = 0, 1, p - 1, p, 2^255 - 1, each with and without the sign bit
    for (const y of [0n, 1n, P - 1n, P, P + 1n, 2n ** 255n - 1n]) {
      const bytes = le32(y);
      vectors.push(bytes);
      const signed = Uint8Array.from(bytes);
      signed[31] |= 0x80;
      vectors.push(signed);
    }
    for (let i = 0; i < 20; i += 1) vectors.push(new PublicKey(solanaKey().address).toBytes());
    let on = 0;
    for (const v of vectors) {
      const expected = PublicKey.isOnCurve(v);
      expect(isOnCurve(v), Buffer.from(v).toString("hex")).toBe(expected);
      if (expected) on += 1;
    }
    // both answers were exercised
    expect(on).toBeGreaterThan(50);
    expect(vectors.length - on).toBeGreaterThan(50);
  });

  it("derives the associated token account web3.js derives, for many owners", () => {
    const mint = new PublicKey(MINT);
    for (let i = 0; i < 60; i += 1) {
      const owner = i % 2 ? solanaKey().address : randomAddress();
      const [expected] = PublicKey.findProgramAddressSync(
        [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), mint.toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      );
      expect(tokenAccountOf(owner, MINT)).toBe(expected.toBase58());
    }
  });

  it("builds the exact SVM payment byte for byte as web3.js compiles it, with the fee payer's slot empty", () => {
    const owner = solanaKey().address;
    const recipient = randomAddress();
    const feePayer = randomAddress();
    const blockhash = bs58.encode(randomBytes(32));
    const built = buildPayment({ owner, recipient, mint: MINT, decimals: 6, amountAtomic: "12345", feePayer, blockhash, memo: "a memo" });

    const mint = new PublicKey(MINT);
    const ata = (o: string) =>
      PublicKey.findProgramAddressSync([new PublicKey(o).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), mint.toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM))[0];
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0);
    data.writeBigUInt64LE(12345n, 1);
    data.writeUInt8(6, 9);
    const message = new TransactionMessage({
      payerKey: new PublicKey(feePayer),
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        new TransactionInstruction({
          programId: new PublicKey(TOKEN_PROGRAM),
          keys: [
            { pubkey: ata(owner), isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: ata(recipient), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
          ],
          data,
        }),
        new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from("a memo", "utf8") }),
      ],
    }).compileToV0Message();
    expect(built.message).toBe(Buffer.from(message.serialize()).toString("base64"));
    expect(built.transaction).toBe(Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"));
    expect(built.signers).toBe(2);
    expect(message.staticAccountKeys[0].toBase58()).toBe(feePayer);
    expect(message.staticAccountKeys[built.ownerIndex].toBase58()).toBe(owner);
    // a fresh memo each time, so two payments of the same price to the same seller are never one transaction
    const again = buildPayment({ owner, recipient, mint: MINT, decimals: 6, amountAtomic: "12345", feePayer, blockhash });
    const third = buildPayment({ owner, recipient, mint: MINT, decimals: 6, amountAtomic: "12345", feePayer, blockhash });
    expect(again.memo).toMatch(/^[0-9a-f]{32}$/);
    expect(again.message).not.toBe(third.message);
    expect(() => buildPayment({ owner, recipient, mint: MINT, decimals: 6, amountAtomic: "1", feePayer: owner, blockhash })).toThrow(/fee payer is the owner/);
  });
});

describe("what the owner's wallet gives back", () => {
  const owner = solanaKey();
  const built = buildPayment({ owner: owner.address, recipient: randomAddress(), mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
  const expected = { ...built, owner: owner.address };

  /** The wallet signs, then something changes the bytes: a byte of the message, or a signature slot. */
  function tamper(edit: (tx: VersionedTransaction) => void, signFirst = true): string {
    const base = signFirst ? signAsOwner(built.transaction, owner) : built.transaction;
    const tx = VersionedTransaction.deserialize(Buffer.from(base, "base64"));
    edit(tx);
    return Buffer.from(tx.serialize()).toString("base64");
  }

  it("takes the transaction it built, signed by the owner alone, and names the owner's signature", () => {
    const signed = signAsOwner(built.transaction, owner);
    const checked = checkSigned(signed, expected);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
    expect(checked.signature).toBe(bs58.encode(tx.signatures[built.ownerIndex]));
    expect(checked.transaction).toBe(signed);
  });

  it("refuses a message the wallet changed: the amount, the fee payer, the blockhash or an added instruction", () => {
    const message = Buffer.from(built.message, "base64");
    const changes: ((m: Buffer) => void)[] = [
      // the amount: the TransferChecked data ends 36 bytes before the end (the memo instruction and the lookup count)
      (m) => { m[m.length - 45] ^= 1; },
      // the fee payer is the first account key, after the prefix, the header and the key count
      (m) => { m[5] ^= 1; },
      // the blockhash follows the keys
      (m) => { m[5 + 32 * 8] ^= 1; },
    ];
    for (const change of changes) {
      const changed = Buffer.from(message);
      change(changed);
      // signed by the owner over the changed message: a valid signature, over something else than was built
      const forged = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), Buffer.from(owner.sign(changed)), changed]).toString("base64");
      const checked = checkSigned(forged, expected);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.code).toBe("transaction_changed");
    }
    const longer = Buffer.concat([Buffer.from(signAsOwner(built.transaction, owner), "base64"), Buffer.from([0])]).toString("base64");
    expect(checkSigned(longer, expected)).toMatchObject({ ok: false, code: "transaction_changed" });
  });

  it("refuses a signature by another key, a missing one, one in the fee payer's slot, or bytes that are no transaction", () => {
    const other = solanaKey();
    const byOther = tamper((tx) => { tx.signatures[built.ownerIndex] = other.sign(tx.message.serialize()); }, false);
    expect(checkSigned(byOther, expected)).toMatchObject({ ok: false, code: "bad_signature" });
    expect(checkSigned(built.transaction, expected)).toMatchObject({ ok: false, code: "bad_signature" });
    const feePayerSigned = tamper((tx) => { tx.signatures[0] = Uint8Array.from(randomBytes(64)); });
    expect(checkSigned(feePayerSigned, expected)).toMatchObject({ ok: false, code: "transaction_changed" });
    const oneSlot = Buffer.concat([Buffer.from([1]), Buffer.from(owner.sign(Buffer.from(built.message, "base64"))), Buffer.from(built.message, "base64")]).toString("base64");
    expect(checkSigned(oneSlot, expected)).toMatchObject({ ok: false, code: "invalid_transaction" });
    expect(checkSigned("not base64!", expected)).toMatchObject({ ok: false, code: "invalid_transaction" });
    expect(checkSigned("AA==", expected)).toMatchObject({ ok: false, code: "invalid_transaction" });
  });
});

describe("which Solana offers the rail pays", () => {
  it("pays devnet USDC with the seller's fee payer, terms from the offer alone, the offer sent back as made", () => {
    const accept = goodAccept({ extra: { feePayer: randomAddress(), memo: "order 7" }, someField: "kept" });
    const judged = judgeAccept(accept, 2);
    expect(judged.supported).toBe(true);
    if (!judged.supported) return;
    expect(judged.offer.rail).toBe("solana");
    expect(judged.offer.terms).toEqual({
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "USDC",
      assetAddress: MINT,
      network: SOLANA_DEVNET.caip2,
      networkLabel: "Solana devnet (testnet)",
      recipient: accept.payTo,
      scheme: "exact",
      x402Version: 2,
    });
    expect(judged.offer.requirement).toEqual(accept);
    // the x402 v1 name of the chain is the same chain
    expect(judgeAccept(goodAccept({ network: "solana-devnet" }), 2).supported).toBe(true);
  });

  it("refuses, before the owner is asked, everything it does not pay", () => {
    const payTo = randomAddress();
    const refusals: [RawAccept, 1 | 2, RegExp][] = [
      [goodAccept({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), 2, /Solana \(mainnet\).*mainnet, and this client pays on testnets only/],
      [goodAccept({ network: "solana" }), 2, /mainnet/],
      // Solana testnet: another cluster, another genesis
      [goodAccept({ network: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" }), 2, /chain Solana is not supported \(only .*Solana devnet/],
      [goodAccept({ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), 2, /is not USDC on Solana devnet/],
      [goodAccept({ asset: undefined }), 2, /is not USDC on Solana devnet/],
      [goodAccept({ extra: { feePayer: randomAddress(), decimals: 9 } }), 2, /decimals are not USDC's/],
      [goodAccept({ amount: "0" }), 2, /amount is missing or malformed/],
      [goodAccept({ amount: "1.5" }), 2, /amount is missing or malformed/],
      [goodAccept({ amount: undefined }), 2, /amount is missing or malformed/],
      [goodAccept({ amount: "1".repeat(19) }), 2, /amount is missing or malformed/],
      // A number is not converted: x402 v2 (and superstables.com) take the amount as a string only.
      [goodAccept({ amount: 10000 as unknown as string }), 2, /amount is missing or malformed/],
      [goodAccept({ maxTimeoutSeconds: "60" as unknown as number }), 2, /payment window/],
      [goodAccept({ payTo: "0x1111111111111111111111111111111111111111" }), 2, /recipient \(payTo\) is missing or malformed/],
      [goodAccept({ extra: {} }), 2, /names no fee payer \(extra.feePayer\): this client pays on Solana only when the seller pays the network fee/],
      [goodAccept({ extra: undefined }), 2, /names no fee payer/],
      [goodAccept({ extra: { feePayer: "not an address" } }), 2, /fee payer \(extra.feePayer\) is malformed/],
      [goodAccept({ payTo, extra: { feePayer: payTo } }), 2, /fee payer is its recipient/],
      [goodAccept({ extra: { feePayer: randomAddress(), memo: "x".repeat(257) } }), 2, /memo is malformed/],
      [goodAccept({ maxTimeoutSeconds: 86_400 }), 2, /payment window/],
      [goodAccept({ scheme: "upto" }), 2, /scheme "upto" is not supported/],
      [goodAccept({ padding: "x".repeat(5_000) }), 2, /too large/],
      [goodAccept(), 1, /x402 version 1 is not supported on Solana devnet \(testnet\) \(only 2\)/],
    ];
    for (const [accept, version, reason] of refusals) {
      const judged = judgeAccept(accept, version);
      expect(judged.supported, JSON.stringify(accept).slice(0, 120)).toBe(false);
      if (!judged.supported) expect(judged.reason).toMatch(reason);
    }
  });

  it("is a chain pay pays on, and the CAIP-2 id is the start of the devnet genesis hash", () => {
    expect(SUPPORTED_NETWORKS.map((n) => n.caip2)).toContain(SOLANA_DEVNET.caip2);
    expect(payableLabels()).toContain("Solana devnet");
    expect(SOLANA_DEVNET.caip2).toBe(`solana:${SOLANA_DEVNET.genesisHash.slice(0, 32)}`);
  });

  it("asks the wallet for a Solana transaction, and a signer re-judges the request by its kind", () => {
    const accept = goodAccept();
    const judged = judgeAccept(accept, 2);
    if (!judged.supported) throw new Error(judged.reason);
    const req = solanaRail.signRequest(judged.offer, 2, { target: "https://s.example/x", attemptId: "a1" }) as SolanaSignRequest;
    expect(req).toEqual({ kind: "solana-transaction", requirements: accept, x402Version: 2, context: { target: "https://s.example/x", attemptId: "a1" } });
    expect(judgeSignRequest(req).supported).toBe(true);
    // the same requirement as an EIP-3009 request is not one this chain's wallet step answers, and vice versa
    expect(judgeSignRequest({ kind: "eip3009", requirements: accept as never, x402Version: 2 })).toMatchObject({ supported: false, reason: expect.stringMatching(/a eip3009 request cannot pay on Solana devnet/) });
    expect(judgeSignRequest({ ...req, requirements: { ...accept, asset: "x" } as never }).supported).toBe(false);
  });

  it("carries the signed transaction to the seller as x402 v2 does, with the offer as made and the 402's resource", () => {
    const accept = goodAccept();
    const judged = judgeAccept(accept, 2);
    if (!judged.supported) throw new Error(judged.reason);
    const signed: SolanaSignResult = { kind: "solana-transaction", transaction: "AQID", signature: bs58.encode(randomBytes(64)), lastValidBlockHeight: 123, signer: randomAddress() };
    const challenge: Challenge = { version: 2, resource: "https://s.example/x", description: "", accepts: [accept], resourceInfo: { url: "https://s.example/x", description: "d" }, extensions: { bazaar: { a: 1 } } };
    const headers = solanaRail.credentialHeaders(judged.offer as Offer, signed, challenge);
    expect(Object.keys(headers)).toEqual(["PAYMENT-SIGNATURE"]);
    expect(decodePaymentSignatureHeader(headers["PAYMENT-SIGNATURE"])).toEqual({
      x402Version: 2,
      resource: { url: "https://s.example/x", description: "d" },
      accepted: accept,
      payload: { transaction: "AQID" },
      extensions: { bazaar: { a: 1 } },
    });
    expect(solanaRail.signedFacts(signed)).toEqual({ ownerSignature: signed.signature, lastValidBlockHeight: 123 });
    expect(() => solanaRail.credentialHeaders(judged.offer as Offer, { kind: "eip3009", payload: { signature: "0x", authorization: {} }, signer: "0x" }, challenge)).toThrow();
    expect(solanaRail.isTransaction(signed.signature)).toBe(true);
    expect(solanaRail.isTransaction(`0x${"a".repeat(64)}`)).toBe(false);
  });
});

describe("what the chain must show", () => {
  let chain: FakeSolanaDevnet;
  const owner = solanaKey();
  let recipient: string;
  let built: ReturnType<typeof buildPayment>;
  let signed: string;
  let ownerSignature: string;
  /** The block height and the slot devnet had reached when the payment was built. */
  let builtHeight: number;
  let builtAt: number;
  /** An earlier transfer from the owner's token account (its funding, on a real cluster): older than the payment. */
  let funding: string;

  beforeEach(async () => {
    chain = await startFakeDevnet();
    recipient = randomAddress();
    const earlier = buildPayment({ owner: owner.address, recipient: randomAddress(), mint: MINT, decimals: 6, amountAtomic: "1", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    funding = chain.land(signAsOwner(earlier.transaction, owner));
    // Minutes of blocks pass before the payment is built.
    chain.height += 400;
    builtHeight = chain.height;
    builtAt = chain.height + 10;
    built = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    signed = signAsOwner(built.transaction, owner);
    const checked = checkSigned(signed, { ...built, owner: owner.address });
    if (!checked.ok) throw new Error(checked.reason);
    ownerSignature = checked.signature;
  });
  afterEach(async () => {
    await chain.close();
  });

  const options = () => ({ rpcUrlFor: () => chain.url });
  /** The finalized chain one block past the blockhash's last valid height: nothing can land any more. */
  const expire = () => {
    chain.height = builtHeight + 151;
  };
  const facts = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
    network: SOLANA_DEVNET.caip2,
    payer: owner.address,
    recipient,
    amountAtomic: "10000",
    ownerSignature,
    lastValidBlockHeight: builtHeight + 150,
    searchFromSlot: builtAt,
    since: new Date(Date.now() - 5_000).toISOString(),
    ...over,
  });

  it("verifies the transaction that carries the owner's signed transfer", async () => {
    const tx = chain.land(signed);
    expect(await solanaRail.checkPayment(facts({ transaction: tx }), options())).toEqual({ chain: "verified" });
  });

  it("does not count a transaction for another amount, recipient, token or source, nor a failed one", async () => {
    const tokenIx = (t: RpcTx) =>
      t.transaction.message.instructions.find((ix) => t.transaction.message.accountKeys[ix.programIdIndex] === TOKEN_PROGRAM)!;
    // the facts the client recorded differ from what the chain shows
    const tx = chain.land(signed);
    expect(await solanaRail.checkPayment(facts({ transaction: tx, amountAtomic: "10001" }), options())).toEqual({ chain: "mismatch", reason: "the transaction did not transfer the signed amount" });
    expect(await solanaRail.checkPayment(facts({ transaction: tx, recipient: randomAddress() }), options())).toEqual({ chain: "mismatch", reason: "the transaction did not pay the checked recipient" });
    // what the chain shows differs from what was built (an RPC that lies, or a test of the check itself)
    const otherMint = chain.land(signed, { edit: (t) => { const i = tokenIx(t).accounts[1]; t.transaction.message.accountKeys[i] = randomAddress(); } });
    expect(await solanaRail.checkPayment(facts({ transaction: otherMint }), options())).toEqual({ chain: "mismatch", reason: "the transaction moved another token than USDC on Solana devnet" });
    const otherSource = chain.land(signed, { edit: (t) => { const i = tokenIx(t).accounts[0]; t.transaction.message.accountKeys[i] = randomAddress(); } });
    expect(await solanaRail.checkPayment(facts({ transaction: otherSource }), options())).toEqual({ chain: "mismatch", reason: "the transaction did not move the tokens from the owner's account" });
    const notChecked = chain.land(signed, { edit: (t) => { const ix = tokenIx(t); const d = Buffer.from(bs58.decode(ix.data)); d[0] = 3; ix.data = bs58.encode(d); } });
    expect(await solanaRail.checkPayment(facts({ transaction: notChecked }), options())).toMatchObject({ chain: "mismatch", reason: expect.stringMatching(/not the TransferChecked/) });
    const twice = chain.land(signed, { edit: (t) => { t.transaction.message.instructions.push({ ...tokenIx(t) }); } });
    expect(await solanaRail.checkPayment(facts({ transaction: twice }), options())).toMatchObject({ chain: "mismatch", reason: "the transaction does not make exactly one token transfer" });
    const failed = chain.land(signed, { err: { InstructionError: [2, { Custom: 1 }] } });
    expect(await solanaRail.checkPayment(facts({ transaction: failed }), options())).toEqual({ chain: "mismatch", reason: "the transaction failed on chain" });
    const withoutOwner = chain.land(signed, { edit: (t) => { t.transaction.signatures[built.ownerIndex] = bs58.encode(randomBytes(64)); } });
    expect(await solanaRail.checkPayment(facts({ transaction: withoutOwner }), options())).toEqual({ chain: "mismatch", reason: "the transaction does not carry the owner's signature over this payment" });
  });

  it("leaves a payment unchecked when the chain cannot say: no transaction yet, nothing to match, another answer, no RPC", async () => {
    expect(await solanaRail.checkPayment(facts({ transaction: bs58.encode(randomBytes(64)) }), options())).toEqual({ chain: "unchecked", missing: true, reason: "the chain does not show the transaction yet" });
    expect(await solanaRail.checkPayment(facts({ transaction: "pending" }), options())).toEqual({ chain: "unchecked", reason: "no transaction signature was given" });
    const tx = chain.land(signed);
    expect(await solanaRail.checkPayment(facts({ transaction: tx, ownerSignature: undefined }), options())).toMatchObject({ chain: "unchecked", reason: expect.stringMatching(/not recorded/) });
    chain.txs.set("x".repeat(88), chain.txs.get(tx)!);
    expect(await solanaRail.checkPayment(facts({ transaction: "x".repeat(88) }), options())).toMatchObject({ chain: "unchecked", reason: expect.stringMatching(/another transaction/) });
    chain.down = true;
    expect(await solanaRail.checkPayment(facts({ transaction: tx }), options())).toMatchObject({ chain: "unchecked", reason: expect.stringMatching(/could not be read/) });
    // with no RPC named, SUPERSTABLES_SOLANA_RPC is read: in tests an address where nothing listens
    expect(await solanaRail.checkPayment(facts({ transaction: tx }), {})).toMatchObject({ chain: "unchecked" });
  });

  it("finds an unreported payment by the owner's signature among the owner's token account's transactions", async () => {
    // other transfers of the owner's, before and after
    const other = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    chain.land(signAsOwner(other.transaction, owner));
    const tx = chain.land(signed);
    const later = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
    chain.land(signAsOwner(later.transaction, owner));
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({ found: true, transaction: tx });
    expect(chain.calls).toContain("getSignaturesForAddress");
    // a transaction the seller named comes first, and counts only when it is this payment
    chain.calls.length = 0;
    expect(await solanaRail.findPayment!(facts({ transaction: tx }), options())).toEqual({ found: true, transaction: tx });
    expect(chain.calls).toEqual(["getTransaction"]);
  });

  it("says when nothing was found: still able to land, and only once every block of the window was read without it, never", async () => {
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({ found: false, reason: `no transaction carrying the owner's signature was found yet; it can still land until block height ${builtHeight + 150}` });
    expire();
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({
      found: false,
      never: true,
      reason: `no transaction carrying the owner's signature succeeded, and its blockhash expired at block height ${builtHeight + 150} (the chain is at ${builtHeight + 151}): none of the 151 blocks it could land in holds one that did, so it can no longer land`,
    });
    // Without the last valid height, nothing is ever called final.
    expect(await solanaRail.findPayment!(facts({ lastValidBlockHeight: undefined }), options())).toEqual({ found: false, reason: "no transaction carrying the owner's signature was found yet" });
    expect(await solanaRail.findPayment!(facts({ ownerSignature: undefined }), options())).toMatchObject({ found: false, reason: expect.stringMatching(/not recorded/) });
    chain.down = true;
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
  });

  it("says a payment that landed and failed is not paid, and never once its blockhash has expired", async () => {
    const failed = chain.land(signed, { err: { InstructionError: [2, { Custom: 1 }] } });
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({ found: false, reason: `transaction ${failed} carries the owner's signature, but the transaction failed on chain` });
    expire();
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, never: true, reason: expect.stringMatching(/^transaction .* carries the owner's signature, but the transaction failed on chain, and its blockhash expired/) });
  });

  it("does not look before the payment was built: by its slot, or for an older record an hour before it began", async () => {
    const hash = chain.land(signed);
    const tx = chain.txs.get(hash)!;
    expect(await solanaRail.findPayment!(facts({ searchFromSlot: tx.slot }), options())).toMatchObject({ found: false });
    tx.blockTime -= 7_200;
    expect(await solanaRail.findPayment!(facts({ searchFromSlot: undefined }), options())).toMatchObject({ found: false });
  });

  it("finds a landed payment the address index has not caught up with, in the window's blocks, and never calls it unpaid", async () => {
    const tx = chain.land(signed);
    expire();
    const landed = chain.txs.get(tx)!;
    // The node lists the account's signatures before it has written this transaction's status, and serves the blocks after.
    chain.onCall = (method) => {
      if (method === "getSignaturesForAddress") chain.txs.delete(tx);
      if (method === "getBlock") chain.txs.set(tx, landed);
    };
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({ found: true, transaction: tx });
    chain.onCall = undefined;
  });

  it("never calls a payment unpaid on another clock, an unreadable transaction or block, a gap, another cluster or a node behind", async () => {
    const tx = chain.land(signed);
    expire();
    // This machine's clock three minutes fast: the slot decides, not the time, and the payment is found.
    expect(await solanaRail.findPayment!(facts({ since: new Date(Date.now() + 180_000).toISOString() }), options())).toEqual({ found: true, transaction: tx });
    // Listed, then not readable: nothing is decided.
    chain.unreadable.add(tx);
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
    chain.unreadable.clear();
    // A node whose ledger lacks the payment's slot: it neither lists nor serves it. The blocks it lists run one too far.
    const landedAt = chain.txs.get(tx)!.slot;
    chain.missingSlots.add(landedAt);
    chain.height += 5;
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/missing blocks from this payment's window/) });
    chain.missingSlots.clear();
    chain.height -= 5;
    // A block of the window it lists but will not serve: nothing is decided.
    chain.txs.delete(tx);
    chain.blockFails.add(builtAt + 40);
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
    chain.blockFails.clear();
    // Another cluster's RPC: not searched.
    chain.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/not on Solana devnet/) });
    chain.genesis = SOLANA_DEVNET.genesisHash;
    // A node behind the finalized slot the search started from: it refuses, and nothing is decided.
    chain.contextSlot = builtAt + 151 - 1;
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
    chain.contextSlot = undefined;
    // An older record without the slot it was built at: never called final.
    expect(await solanaRail.findPayment!(facts({ searchFromSlot: undefined }), options())).toMatchObject({ found: false, unreadable: true });
    // With all of it in order, and the payment never landed: never, from the blocks, whatever the address list held.
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, never: true });
    chain.txs.delete(funding);
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, never: true });
  });

  it("decides from the window's blocks when the owner's account has more transactions than the list search reads", async () => {
    for (let i = 0; i < 25; i += 1) {
      const other = buildPayment({ owner: owner.address, recipient, mint: MINT, decimals: 6, amountAtomic: "10000", feePayer: randomAddress(), blockhash: bs58.encode(randomBytes(32)) });
      chain.land(signAsOwner(other.transaction, owner));
    }
    // Too many to read one by one, before the blockhash expired: undecided.
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true });
    // The payment among them, past the blockhash: found in its block.
    const tx = chain.land(signed);
    expire();
    expect(await solanaRail.findPayment!(facts(), options())).toEqual({ found: true, transaction: tx });
    // Without it: never. A transaction already recorded as another attempt's payment is never this one's.
    expect(await solanaRail.findPayment!(facts({ transaction: tx, attributed: [tx] }), options())).not.toMatchObject({ found: true });
  });

  it("decides nothing when the RPC will not list the window's blocks", async () => {
    expire();
    chain.refuses.add("getBlocksWithLimit");
    const refused = await solanaRail.findPayment!(facts(), options());
    expect(refused).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/did not list the blocks/) });
    expect(refused).not.toHaveProperty("never");
  });

  /** Options that note when each getBlock request was sent. */
  const timed = (over: { searchMs?: number } = {}) => {
    const sent: number[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).method === "getBlock") sent.push(Date.now());
      return fetch(input, init);
    }) as typeof fetch;
    return { sent, options: { rpcUrlFor: () => chain.url, fetchImpl, ...over } };
  };

  it("waits as long as the RPC asks when it limits block reads, then reads at its pace, and reads the whole window", async () => {
    expire();
    // 149 reads, then "too many requests, retry after 3 seconds", as the public devnet RPC answers getBlock.
    chain.limit = { method: "getBlock", after: 149, times: 1, retryAfter: 3 };
    const asked = timed();
    expect(await solanaRail.findPayment!(facts(), asked.options)).toMatchObject({ found: false, never: true });
    expect(asked.sent).toHaveLength(152);
    expect(asked.sent[150] - asked.sent[149]).toBeGreaterThanOrEqual(2_950);
    // From then on, a read every two seconds at most.
    expect(asked.sent[151] - asked.sent[150]).toBeGreaterThanOrEqual(1_950);
    // Limited without saying for how long: it waits before trying again.
    chain.limit = { method: "getBlock", after: 150, times: 1 };
    const unsaid = timed();
    expect(await solanaRail.findPayment!(facts(), unsaid.options)).toMatchObject({ found: false, never: true });
    expect(unsaid.sent).toHaveLength(152);
    expect(unsaid.sent[151] - unsaid.sent[150]).toBeGreaterThanOrEqual(1_950);
  });

  it("stops reading when its time runs out, says how far it read the window, and the next search reads on from there", async () => {
    expire();
    // Forty blocks, then limited for longer than the search may take.
    chain.limit = { method: "getBlock", after: 40, times: 1_000, retryAfter: 5 };
    const stopped = await solanaRail.findPayment!(facts(), { ...options(), searchMs: 1_500 });
    expect(stopped).toEqual({
      found: false,
      unreadable: true,
      searchedToSlot: builtAt + 40,
      reason: "the RPC limits how fast blocks can be read; 40 of the 151 blocks this payment could have landed in are read, and the next search reads the rest",
    });
    // On from the block after: only the rest of the window is read.
    chain.limit = undefined;
    const rest = timed();
    expect(await solanaRail.findPayment!(facts({ searchedToSlot: builtAt + 40 }), rest.options)).toMatchObject({ found: false, never: true });
    expect(rest.sent).toHaveLength(111);
    // Read on from the mark, the blocks must still run at consecutive heights to the window's end.
    chain.missingSlots.add(builtAt + 100);
    chain.height += 1;
    expect(await solanaRail.findPayment!(facts({ searchedToSlot: builtAt + 40 }), options())).toMatchObject({ found: false, unreadable: true, searchedToSlot: builtAt + 99, reason: expect.stringMatching(/missing blocks from this payment's window/) });
    chain.missingSlots.clear();
    chain.height -= 1;
    // A slot that is not one of the window's blocks is not taken: the whole window is read.
    for (const readTo of [builtAt, builtAt + 152, builtAt + 40.5]) {
      const all = timed();
      expect(await solanaRail.findPayment!(facts({ searchedToSlot: readTo }), all.options)).toMatchObject({ found: false, never: true });
      expect(all.sent).toHaveLength(151);
    }
    // Out of time before any block: nothing read, nothing kept.
    const none = await solanaRail.findPayment!(facts(), { ...options(), searchMs: 0 });
    expect(none).toMatchObject({ found: false, unreadable: true, reason: expect.stringMatching(/^the search ran out of time; 0 of the 151 blocks/) });
    expect(none).not.toHaveProperty("searchedToSlot");
    // A block read that does not end: the search's time ends it.
    let reads = 0;
    const hanging = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).method !== "getBlock" || ++reads <= 30) return fetch(input, init);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }) as typeof fetch;
    const began = Date.now();
    expect(await solanaRail.findPayment!(facts(), { ...options(), fetchImpl: hanging, searchMs: 1_000 })).toMatchObject({
      found: false,
      unreadable: true,
      searchedToSlot: builtAt + 30,
      reason: expect.stringMatching(/^the search ran out of time; 30 of the 151 blocks/),
    });
    expect(Date.now() - began).toBeLessThan(3_000);
    // A block the RPC will not serve: what was read before it is kept.
    chain.blockFails.add(builtAt + 40);
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, unreadable: true, searchedToSlot: builtAt + 39, reason: expect.stringMatching(/did not serve the block at slot/) });
  });

  it("reads on past a block whose transaction carrying the owner's signature failed, never past one it could not read", async () => {
    // The payment landed, and failed, in the window's first block: read and judged, the search reads on past it.
    const failed = chain.land(signed, { err: { InstructionError: [2, { Custom: 1 }] } });
    expire();
    expect(chain.txs.get(failed)!.slot).toBe(builtAt + 1);
    chain.limit = { method: "getBlock", after: 40, times: 1_000, retryAfter: 5 };
    expect(await solanaRail.findPayment!(facts(), { ...options(), searchMs: 1_500 })).toMatchObject({ found: false, unreadable: true, searchedToSlot: builtAt + 40 });
    chain.limit = undefined;
    expect(await solanaRail.findPayment!(facts({ searchedToSlot: builtAt + 40 }), options())).toMatchObject({
      found: false,
      never: true,
      reason: expect.stringMatching(new RegExp(`^transaction ${failed} carries the owner's signature, but the transaction failed on chain, and its blockhash expired`)),
    });
    // One in the window's twentieth block that the address index does not list yet, and that cannot be read: the
    // search's mark stays before its block.
    chain.txs.delete(failed);
    const unread = chain.land(signed);
    chain.height = builtHeight + 151;
    const landed = chain.txs.get(unread)!;
    landed.slot = builtAt + 20;
    chain.onCall = (method) => {
      if (method === "getSignaturesForAddress") chain.txs.delete(unread);
      if (method === "getBlock") chain.txs.set(unread, landed);
    };
    chain.unreadable.add(unread);
    chain.limit = { method: "getBlock", after: 40, times: 1_000, retryAfter: 5 };
    expect(await solanaRail.findPayment!(facts(), { ...options(), searchMs: 1_500 })).toMatchObject({ found: false, unreadable: true, searchedToSlot: builtAt + 19 });
    // Readable, in a window read in part: found in its block.
    chain.unreadable.clear();
    chain.limit = { method: "getBlock", after: 40, times: 1_000, retryAfter: 5 };
    expect(await solanaRail.findPayment!(facts(), { ...options(), searchMs: 1_500 })).toEqual({ found: true, transaction: unread });
    chain.onCall = undefined;
  });

  it("reads a window whose blocks hold version 1 transactions, as devnet's do", async () => {
    expire();
    for (let slot = builtAt + 1; slot <= builtAt + 151; slot += 7) chain.versionOneSlots.add(slot);
    expect(await solanaRail.findPayment!(facts(), options())).toMatchObject({ found: false, never: true });
  });

  it("reads each block of the window whole, with every transaction's signatures, in order", async () => {
    expire();
    const requests: unknown[] = [];
    const watched = { rpcUrlFor: () => chain.url, fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return fetch(input, init);
    }) as typeof fetch };
    expect(await solanaRail.findPayment!(facts(), watched)).toMatchObject({ never: true });
    const calls = requests.flatMap((r) => (Array.isArray(r) ? r : [r])) as { method: string; params: unknown[] }[];
    expect(calls.slice(0, 2).map((c) => c.method)).toEqual(["getGenesisHash", "getEpochInfo"]);
    const list = calls.find((c) => c.method === "getSignaturesForAddress")!;
    expect(list.params[1]).toMatchObject({ minContextSlot: builtAt + 151 });
    const blocks = calls.filter((c) => c.method === "getBlock");
    expect(blocks.map((c) => c.params[0])).toEqual(Array.from({ length: 151 }, (_, i) => builtAt + 1 + i));
    for (const block of blocks) expect(block.params[1]).toEqual({ commitment: "finalized", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 1 });
  });
});
