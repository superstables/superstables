// How a receipt or an attempt is shown on each chain: a transaction and a payer are repeated only in their own chain's
// shape (a 0x hash and a 0x address on the EVM chains and Tempo, a base58 signature and a base58 address on Solana),
// the link is rebuilt from the chain the client checked, and anything else stays with the seller's own words.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTxHash, shownAttempt, shownPayer, shownReceipt, shownTransaction } from "../../src/core/pay.js";
import { Records } from "../../src/core/records.js";
import type { Attempt, PaymentTerms, Receipt } from "../../src/core/types.js";
import { attemptView } from "../../src/cli/views.js";

const SIGNATURE = "5".repeat(87) + "z";
const SOL_PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const SOL_RECIPIENT = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
const HASH = `0x${"ab".repeat(32)}`;
const EVM_PAYER = `0x${"11".repeat(20)}`;

const solanaTerms: PaymentTerms = {
  amountDecimal: 0.01,
  amountAtomic: "10000",
  asset: "USDC",
  assetAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  networkLabel: "Solana devnet (testnet)",
  recipient: SOL_RECIPIENT,
  scheme: "exact",
  x402Version: 2,
};
const tempoTerms: PaymentTerms = {
  amountDecimal: 0.01,
  amountAtomic: "10000",
  asset: "pathUSD",
  assetAddress: "0x20C0000000000000000000000000000000000000",
  network: "eip155:42431",
  networkLabel: "Tempo Moderato (testnet)",
  recipient: `0x${"22".repeat(20)}`,
  scheme: "charge",
};

function receipt(terms: PaymentTerms, transaction: string, payer: string): Receipt {
  return {
    id: "r1",
    at: new Date().toISOString(),
    quoteId: "q1",
    attemptId: "r1",
    url: "https://seller.example/paid",
    terms,
    payer,
    transaction,
    transactionKind: "hash",
    transactionUrl: "https://elsewhere.example/tx",
    network: terms.network,
    settlement: { success: true, transaction, network: terms.network as never, payer },
    chain: "verified",
    serviceOutcome: "ok",
    serviceStatus: 200,
    ms: 1,
  };
}

function attempt(terms: PaymentTerms, transaction: string, payer: string): Attempt {
  const at = new Date().toISOString();
  return { id: "a1", quoteId: "q1", createdAt: at, updatedAt: at, state: "settled", url: "https://seller.example/paid", terms, payer, transaction, receiptId: "r1", chain: "verified", history: [{ at, state: "settled" }] };
}

describe("transactions and payers as they are shown", () => {
  it("shows a Solana signature and a base58 payer, with the devnet explorer link", () => {
    expect(isTxHash(SIGNATURE, solanaTerms.network)).toBe(true);
    expect(isTxHash(SIGNATURE)).toBe(false);
    expect(shownTransaction(SIGNATURE, solanaTerms.network)).toEqual({ hash: SIGNATURE, url: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet` });
    expect(shownPayer(SOL_PAYER, solanaTerms.network)).toBe(SOL_PAYER);
    const shown = shownReceipt(receipt(solanaTerms, SIGNATURE, SOL_PAYER));
    expect(shown).toMatchObject({ transaction: SIGNATURE, transactionKind: "hash", transactionUrl: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`, payer: SOL_PAYER });
    expect(shownAttempt(attempt(solanaTerms, SIGNATURE, SOL_PAYER))).toMatchObject({ transaction: SIGNATURE, payer: SOL_PAYER });
  });

  it("keeps a transaction or payer in another chain's shape out of the checked fields", () => {
    // An EVM hash on a Solana payment, and a base58 signature on an EVM one, are the seller's words, not facts.
    expect(shownTransaction(HASH, solanaTerms.network)).toEqual({});
    expect(shownTransaction(SIGNATURE, "eip155:84532")).toEqual({});
    expect(shownPayer(EVM_PAYER, solanaTerms.network)).toBeUndefined();
    expect(shownPayer(SOL_PAYER, "eip155:84532")).toBeUndefined();
    const shown = shownAttempt(attempt(solanaTerms, HASH, EVM_PAYER));
    expect(shown.transaction).toBeUndefined();
    expect(shown.payer).toBeUndefined();
    expect(shown.untrusted_seller_data).toMatchObject({ transaction: HASH, payer: EVM_PAYER });
  });

  it("shows a Tempo payment with Tempo's explorer", () => {
    const shown = shownReceipt(receipt(tempoTerms, HASH, EVM_PAYER));
    expect(shown.transactionUrl).toBe(`https://explore.testnet.tempo.xyz/tx/${HASH}`);
    expect(shown.payer).toBe(EVM_PAYER);
    expect(shown.network).toBe("eip155:42431");
  });

  it("reads a Solana receipt from the records and shows it in the attempt view, counted toward the cap with USDC", () => {
    const records = new Records(mkdtempSync(join(tmpdir(), "superstables-views-")));
    records.saveReceipt(receipt(solanaTerms, SIGNATURE, SOL_PAYER));
    const a = records.saveAttempt(attempt(solanaTerms, SIGNATURE, SOL_PAYER));
    expect(records.getReceipt("r1")?.transaction).toBe(SIGNATURE);
    const view = attemptView({ records }, a) as Record<string, any>;
    expect(JSON.stringify(view)).toContain(`https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`);
    expect(JSON.stringify(view)).toContain(SOL_PAYER);
    expect(records.spentToday("USDC")).toBe(0.01);
    expect(records.spentToday("pathUSD")).toBe(0.01);
  });
});
