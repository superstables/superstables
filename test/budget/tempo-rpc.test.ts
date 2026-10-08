import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential, Receipt } from "mppx";
import { encodeEventTopics, isHex, keccak256, stringToHex, type Hex } from "viem";
import { Methods } from "mppx/tempo";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startFakeTempo, PATH_USD } from "../helpers/fake-chains.js";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"01".repeat(32)}` satisfies Hex;
const AGENT = privateKeyToAccount(KEY).address;
const HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

const signedTempoTransaction = z.templateLiteral([z.enum(["0x76", "0x78"]), z.string()]).refine((value) => isHex(value));

function signedFeeToken(signature: string): string | undefined {
  return Transaction.deserialize(signedTempoTransaction.parse(signature)).feeToken?.toString();
}

// Real mppx and viem sign an ephemeral access key. Only the seller and the chain are stand-ins.
describe("Tempo budget payment RPC", () => {
  it.each([
    { mode: "pull", feePayer: false },
    { mode: "pull", feePayer: true },
    { mode: "push", feePayer: false },
  ] as const)("uses the replacement RPC for $mode with feePayer=$feePayer", async ({ mode, feePayer }) => {
    const home = mkdtempSync(join(tmpdir(), "tempo-rpc-"));
    const guardLog = join(home, "network.log");
    writeFileSync(guardLog, "");
    mkdirSync(join(home, "keys/budget"), { recursive: true });
    writeFileSync(join(home, "keys/budget/tempo-agent.env"), `OWNER_ADDRESS=${OWNER}\nAGENT_PRIVATE_KEY=${KEY}\nAGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
    const chain = await startFakeTempo();
    chain.keys.set(`${OWNER}:${AGENT.toLowerCase()}`, {
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), limit: 10_000_000n,
      period: 0n, periodEnd: 0n, revoked: false, scoped: false,
    });
    const challenge = Challenge.from({
      secretKey: "local-test-secret", realm: "local-seller", method: "tempo", intent: "charge",
      expires: new Date(Date.now() + 60_000).toISOString(),
      request: { amount: "10000", currency: PATH_USD, recipient: RECIPIENT,
        methodDetails: { chainId: 42431, feePayer, supportedModes: [mode] } },
    });
    // mppx attribution memo: version and fingerprints bind this transfer to this challenge.
    const memoBytes = Buffer.alloc(32);
    Buffer.from(keccak256(stringToHex("mpp")).slice(2, 10), "hex").copy(memoBytes, 0);
    memoBytes[4] = 1;
    Buffer.from(keccak256(stringToHex(challenge.realm)).slice(2, 22), "hex").copy(memoBytes, 5);
    Buffer.from(keccak256(stringToHex(challenge.id)).slice(2, 16), "hex").copy(memoBytes, 25);
    const memo = `0x${memoBytes.toString("hex")}` satisfies Hex;
    const log = (eventName: "Transfer" | "TransferWithMemo") => ({
      address: PATH_USD,
      topics: encodeEventTopics({ abi: Abis.tip20, eventName, args: { from: OWNER, to: RECIPIENT, ...(eventName === "TransferWithMemo" ? { memo } : {}) } }),
      data: `0x${10000n.toString(16).padStart(64, "0")}`,
      transactionHash: HASH, blockNumber: "0x3e8", blockHash: BLOCK_HASH,
      transactionIndex: "0x0", logIndex: "0x0", removed: false,
    });
    const receipt = {
      transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: "0x3e8", status: "0x1",
      from: OWNER, to: PATH_USD, logs: [log("Transfer"), log("TransferWithMemo")],
      transactionIndex: "0x0", cumulativeGasUsed: "0x10000", gasUsed: "0x10000",
      effectiveGasPrice: "0x1", type: "0x76", logsBloom: `0x${"00".repeat(256)}`,
    };
    const calls: string[] = [];
    const hosts: string[] = [];
    const feeTokens: (string | undefined)[] = [];
    let broadcast = false;
    const rpc = await startServer(async (req, res) => {
      const request = JSON.parse(await readBody(req));
      calls.push(request.method);
      hosts.push(req.headers.host ?? "");
      let result: unknown;
      switch (request.method) {
        case "eth_estimateGas": result = "0x10000"; break;
        case "eth_gasPrice": result = "0x1"; break;
        case "eth_maxPriorityFeePerGas": result = "0x1"; break;
        case "eth_getTransactionCount": result = "0x0"; break;
        case "eth_getBlockByNumber": result = { number: "0x3e8", hash: BLOCK_HASH, timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: "0x1", gasLimit: "0x1000000", gasUsed: "0x0", transactions: [] }; break;
        case "eth_sendRawTransactionSync": feeTokens.push(signedFeeToken(request.params[0])); broadcast = true; result = receipt; break;
        case "eth_sendRawTransaction": broadcast = true; result = HASH; break;
        case "eth_getTransactionReceipt": result = broadcast ? receipt : null; break;
        case "eth_getTransactionByHash": result = broadcast ? { from: OWNER, signature: { keyId: AGENT } } : null; break;
        case "eth_getLogs": result = broadcast ? [log("TransferWithMemo")] : []; break;
        default: {
          const response = await fetch(chain.url, { method: "POST", body: JSON.stringify(request) });
          sendJson(res, 200, await response.json());
          return;
        }
      }
      sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result });
    });
    let paid = 0;
    const seller = await startServer((req, res) => {
      const authorization = req.headers.authorization;
      if (typeof authorization !== "string") {
        sendJson(res, 402, {}, { "www-authenticate": Challenge.serialize(challenge) });
        return;
      }
      const payload = Methods.charge.schema.credential.payload.parse(Credential.deserialize(authorization).payload);
      expect(payload).toMatchObject({ type: mode === "push" ? "hash" : "transaction" });
      if (mode === "pull" && payload.type === "transaction") {
        feeTokens.push(signedFeeToken(payload.signature));
        broadcast = true;
      }
      paid++;
      sendJson(res, 200, { ok: true }, { "payment-receipt": Receipt.serialize({ method: "tempo", reference: HASH, status: "success", timestamp: new Date().toISOString() }) });
    });
    try {
      const child = await guardedNode(["--import=tsx", "budget/tempo/buy.ts", "--url", seller.url, "--max", "0.01", "--op", "rpc-test"], {
        HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog,
      });
      expect({ ...child, guard: readFileSync(guardLog, "utf8") }, child.output).toMatchObject({ code: 0, guard: "" });
      expect(child.output).toContain('"state":"settled"');
      expect(paid).toBe(1);
      if (process.env.TEMPO_RPC_AUDIT) console.log(JSON.stringify({ mode, feePayer, feeToken: feeTokens[0] ?? "(absent)", hosts: [...new Set(hosts)], calls }));
      expect(feeTokens).toEqual([undefined]);
      expect(new Set(hosts)).toEqual(new Set([new URL(rpc.url).host]));
      if (mode === "pull") {
        expect(calls).toContain("eth_chainId");
        expect(calls).toContain("eth_fillTransaction");
      }
      expect(calls).toContain("eth_getLogs");
      expect(calls).toContain("eth_getTransactionByHash");
      expect(calls).toContain("eth_estimateGas");
      expect(calls.some((method) => ["eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(method))).toBe(true);
      expect(calls).toContain("eth_getBlockByNumber");
      expect(calls).toContain("eth_getTransactionReceipt");
      expect(calls).toContain("eth_call");
      if (mode === "push") expect(calls).toContain("eth_sendRawTransactionSync");
      else expect(calls).not.toContain("eth_sendRawTransactionSync");
      const reconciled = await guardedNode(["--import=tsx", "budget/tempo/reconcile.ts", "--op", "rpc-test"], {
        HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog,
      });
      expect(reconciled.code, reconciled.output).toBe(0);
      expect(reconciled.output).toContain('"state":"settled"');
      expect(readFileSync(guardLog, "utf8")).toBe("");
    } finally {
      await seller.close();
      await rpc.close();
      await chain.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps the Moderato default when the variable is unset, without connecting", async () => {
    const child = await guardedNode(["--input-type=module", "-e", 'const { RPC_URL } = await import("./budget/tempo/lib/constants.mjs"); console.log(RPC_URL)'], {
      SUPERSTABLES_TEMPO_RPC: undefined,
    });
    expect(child).toEqual({ code: 0, output: "https://rpc.moderato.tempo.xyz\n" });
  });
});
