// A referred EVM budget buy: the operation freezes the seller's referral and a nonce marked with it when it starts, the
// x402 client signs that nonce, and only the paid request carries the referral's token and the operation id.

import type { AddressInfo } from "node:net";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { wrapFetchWithPayment } from "@x402/fetch";
import { recoverTypedDataAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import type { ActiveReferral } from "../../src/core/referrals.js";

// Loaded by URL, as the other budget tests load budget/ sources: tsc does not check budget/.
const { onPaidRequest, operationAttribution, referralHeaders, withNonce } = await import(new URL("../../budget/evm/purchase.ts", import.meta.url).href);
type Journal = { op: string; state: string; referral?: { id: string; listingId: string; terms: string; token: string }; authorizationNonce?: Hex };

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ID = "ref_AAECAwQFBgcICQoLDA0ODw";
const REFERRAL: ActiveReferral = { id: ID, token: "header.payload.signature", listingId: "seller.example", terms: "terms-1", expiresAt: "2099-01-01T00:00:00.000Z" };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A seller that asks for 0.01 USDC on Base Sepolia in x402 `version`, and records every request's headers. */
async function seller(version: 1 | 2): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const requirement = version === 2
    ? { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }
    : { scheme: "exact", network: "base-sepolia", asset: USDC, maxAmountRequired: "10000", payTo: PAY_TO, maxTimeoutSeconds: 300, resource: "http://seller/", description: "", mimeType: "application/json", extra: { name: "USDC", version: "2" } };
  const server = createServer((req, res) => {
    seen.push({ ...req.headers });
    if (req.headers["payment-signature"] || req.headers["x-payment"]) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    const challenge = { x402Version: version, error: "payment required", resource: { url: "http://seller/" }, accepts: [requirement] };
    if (version === 2) res.writeHead(402, { "payment-required": encodePaymentRequiredHeader(challenge as never) }).end();
    else res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify(challenge));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/data`, seen };
}

/** Pay `url` the way purchase() wires the x402 client, under an operation with this attribution. */
async function buy(url: string, j: Pick<Journal, "op" | "referral" | "authorizationNonce">) {
  const agent = privateKeyToAccount(generatePrivateKey());
  const signer = { address: agent.address, signTypedData: (m: any) => agent.signTypedData(m) };
  const nonce = j.authorizationNonce!;
  const core = new x402Client()
    .register("eip155:84532", withNonce(new ExactEvmScheme(signer as any), signer, nonce))
    .registerV1("base-sepolia", withNonce(new ExactEvmSchemeV1(signer as any), signer, nonce));
  const res = await wrapFetchWithPayment(onPaidRequest(fetch, referralHeaders(j)), new x402HTTPClient(core))(url);
  return { agent: agent.address, status: res.status };
}

function signedPayload(headers: IncomingHttpHeaders) {
  const raw = String(headers["payment-signature"] ?? headers["x-payment"]);
  return (decodePaymentSignatureHeader(raw) as unknown as { payload: { authorization: Record<string, string>; signature: Hex } }).payload;
}

async function recover(payload: ReturnType<typeof signedPayload>) {
  const a = payload.authorization;
  return recoverTypedDataAddress({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from as Hex, to: a.to as Hex, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex },
    signature: payload.signature,
  });
}

describe("a referred EVM budget buy", () => {
  it("sends the referral's token and the operation id on the paid request only, with the marked nonce the agent signed", async () => {
    for (const version of [2, 1] as const) {
      const s = await seller(version);
      const j = { op: "b4-test-op", ...operationAttribution(null, s.url, () => REFERRAL) };
      expect(j.referral).toEqual({ id: ID, listingId: "seller.example", terms: "terms-1", token: "header.payload.signature" });
      expect(j.authorizationNonce!.slice(0, 42)).toBe("0x53535246000102030405060708090a0b0c0d0e0f");

      const { agent, status } = await buy(s.url, j);
      expect(status, `v${version}`).toBe(200);
      expect(s.seen).toHaveLength(2);
      expect(s.seen[0]!["superstables-referral"]).toBeUndefined();
      expect(s.seen[0]!["superstables-purchase-ref"]).toBeUndefined();
      expect(s.seen[1]!["superstables-referral"]).toBe("header.payload.signature");
      expect(s.seen[1]!["superstables-purchase-ref"]).toBe("b4-test-op");
      const payload = signedPayload(s.seen[1]!);
      expect(payload.authorization.nonce).toBe(j.authorizationNonce);
      expect(payload.authorization).toMatchObject({ from: agent, to: PAY_TO, value: "10000" });
      expect(payload.authorization.validAfter === "0", `v${version}`).toBe(version === 2);
      expect(await recover(payload)).toBe(agent);
    }
  });

  it("pays with a random nonce and no referral headers when the seller's origin has no referral", async () => {
    const s = await seller(2);
    const j = { op: "b4-plain", ...operationAttribution(null, s.url, () => undefined) };
    expect(j.referral).toBeUndefined();
    expect((await buy(s.url, j)).status).toBe(200);
    expect(s.seen[1]!["superstables-referral"]).toBeUndefined();
    expect(s.seen[1]!["superstables-purchase-ref"]).toBeUndefined();
    expect(signedPayload(s.seen[1]!).authorization.nonce).toBe(j.authorizationNonce);
    expect(j.authorizationNonce!.startsWith("0x53535246")).toBe(false);
  });

  it("sends no referral headers when the operation's nonce does not carry its referral", () => {
    const referral = { id: ID, listingId: "seller.example", terms: "terms-1", token: "header.payload.signature" };
    expect(referralHeaders({ op: "b4-op", referral, authorizationNonce: `0x53535246000102030405060708090a0b0c0d0e0f${"aa".repeat(12)}` }))
      .toEqual({ "superstables-referral": "header.payload.signature", "superstables-purchase-ref": "b4-op" });
    expect(referralHeaders({ op: "b4-op", referral, authorizationNonce: `0x${"aa".repeat(32)}` })).toEqual({});
    expect(referralHeaders({ op: "b4-op", referral: { ...referral, id: "ref_EBESExQVFhcYGRobHB0eHw" }, authorizationNonce: `0x53535246000102030405060708090a0b0c0d0e0f${"aa".repeat(12)}` })).toEqual({});
    expect(referralHeaders({ op: "b4-op", referral })).toEqual({});
    // A referral id in another format gets a random nonce, and so no headers.
    expect(referralHeaders({ op: "b4-op", ...operationAttribution(null, "http://seller/", () => ({ ...REFERRAL, id: "ref_short" })) })).toEqual({});
  });

  it("keeps the journaled referral and nonce for a later run under the same operation", () => {
    const first = operationAttribution(null, "http://seller/v1/data", () => REFERRAL);
    const prior = { state: "quoted", ...first } as Journal;
    const other: ActiveReferral = { ...REFERRAL, id: "ref_EBESExQVFhcYGRobHB0eHw", token: "another.token.here" };
    expect(operationAttribution(prior, "http://seller/v1/data", () => other)).toEqual(first);
    // A run that found no referral stays without one, even when the index has given one since.
    const plain = operationAttribution(null, "http://seller/v1/data", () => undefined);
    expect(operationAttribution({ state: "refused_precheck", ...plain } as Journal, "http://seller/v1/data", () => other)).toEqual(plain);
  });

  it("pays without a referral when reading it fails", () => {
    const j = operationAttribution(null, "http://seller/v1/data", () => {
      throw new Error("unreadable");
    });
    expect(j.referral).toBeUndefined();
    expect(j.authorizationNonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
