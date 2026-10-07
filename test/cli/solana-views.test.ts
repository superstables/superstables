// A Solana payment as the CLI shows it: the owner's base58 address as the payer, the base58 transaction signature with
// its devnet explorer link, in `status`, `receipts` and their JSON. The records are written as a settled payment leaves
// them; the CLI runs as a real process and reads no chain for a payment the chain has already verified.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_DEVNET } from "../../src/core/chain.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { LOCAL_WALLET_EVM_ONLY } from "../../src/core/signer/types.js";
import { Records } from "../../src/core/records.js";
import type { Attempt, PaymentTerms, Receipt } from "../../src/core/types.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = resolve(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI = resolve(ROOT, "src/cli/main.ts");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-cli-solana-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, SUPERSTABLES_HOME: home, SUPERSTABLES_DOCTOR_OFFLINE: "1", SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}

describe("a Solana payment in the CLI", () => {
  it("names the base58 payer and transaction, with the devnet explorer link", async () => {
    const payer = bs58.encode(randomBytes(32));
    const recipient = bs58.encode(randomBytes(32));
    const transaction = bs58.encode(randomBytes(64));
    const url = `https://explorer.solana.com/tx/${transaction}?cluster=devnet`;
    const at = new Date().toISOString();
    const terms: PaymentTerms = { amountDecimal: 0.01, amountAtomic: "10000", asset: "USDC", assetAddress: SOLANA_DEVNET.token.address, network: SOLANA_DEVNET.caip2, networkLabel: SOLANA_DEVNET.label, recipient, scheme: "exact", x402Version: 2 };
    const records = new Records(join(home, "records"));
    const id = records.newId();
    const receipt: Receipt = {
      id, at, quoteId: "q1", attemptId: id, url: "https://seller.example/paid", terms, payer, transaction, transactionKind: "hash", transactionUrl: url,
      network: SOLANA_DEVNET.caip2, settlement: { success: true, transaction, network: SOLANA_DEVNET.caip2 } as Receipt["settlement"], chain: "verified", serviceOutcome: "ok", serviceStatus: 200, ms: 10,
    };
    records.saveReceipt(receipt);
    const attempt: Attempt = {
      id, quoteId: "q1", createdAt: at, updatedAt: at, state: "settled", url: receipt.url, terms, payer, transaction, transactionUrl: url,
      receiptId: id, chain: "verified", ownerSignature: bs58.encode(randomBytes(64)), lastValidBlockHeight: 1000, serviceStatus: 200, history: [{ at, state: "settled" }],
    };
    records.saveAttempt(attempt);

    const status = await run(["status", id]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toMatch(new RegExp(`payer\\s+${payer}`));
    expect(status.stdout).toContain(url);
    expect(status.stdout).toContain(`transaction ${transaction}`);

    const receipts = await run(["receipts"]);
    expect(receipts.stdout).toContain(url);
    const listed = JSON.parse((await run(["receipts", "--json"])).stdout) as Record<string, unknown>[];
    expect(listed[0]).toMatchObject({ payer, transaction, transactionUrl: url, network: SOLANA_DEVNET.caip2 });
    const json = JSON.parse((await run(["status", id, "--json"])).stdout) as { receipt: Record<string, unknown> };
    expect(json.receipt).toMatchObject({ payer, transaction, transaction_url: url });
  }, 60_000);

  it("the local wallet does not sign on Solana, and says where the owner approves it instead", async () => {
    const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
    await expect(signer.sign({ kind: "solana-transaction", requirements: {} as never, x402Version: 2 })).rejects.toThrow(LOCAL_WALLET_EVM_ONLY);
    expect(LOCAL_WALLET_EVM_ONLY).toContain("pay it in a browser wallet on your machine: `superstables --wallet browser pay <new-quote-id>`");
  });
});
