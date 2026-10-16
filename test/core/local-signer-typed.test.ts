// The local key signer signs the client's own EIP-3009 typed data (the one the approval page builds), judges the request
// again before it signs, never signs for longer than ten minutes, never pays the account itself, and checks its own
// signature before it returns one.

import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA, DEFAULT_NETWORK, usdcRequirement } from "../../src/core/chain.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import type { Eip3009SignRequest } from "../../src/core/signer/types.js";

const PAYEE = `0x${"22".repeat(20)}`;
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const setup = () => {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, signer: new LocalKeySigner(account) };
};
const request = (requirements: Record<string, unknown>, x402Version: 1 | 2 = 2): Eip3009SignRequest =>
  ({ kind: "eip3009", x402Version, requirements }) as unknown as Eip3009SignRequest;
const authOf = (signed: Awaited<ReturnType<LocalKeySigner["sign"]>>) => signed.payload.authorization as Record<string, string>;

describe("LocalKeySigner signs the client's own typed data", () => {
  it("refuses an offer that asks for Permit2", async () => {
    const { signer } = setup();
    const requirements = { ...usdcRequirement(0.01, PAYEE), extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } };
    await expect(signer.sign(request(requirements))).rejects.toThrow(/EIP-3009 transfers only/);
  });

  it("refuses an offer with a signing field this client does not use", async () => {
    const { signer } = setup();
    const requirements = { ...usdcRequirement(0.01, PAYEE), extra: { name: "USDC", version: "2", sneaky: "1" } };
    await expect(signer.sign(request(requirements))).rejects.toThrow(/signing fields this client does not use/);
  });

  it("refuses an offer whose signing domain is not the token's, instead of signing the pinned one", async () => {
    const { signer } = setup();
    const requirements = { ...usdcRequirement(0.01, PAYEE), extra: { name: "Evil", version: "2" } };
    await expect(signer.sign(request(requirements))).rejects.toThrow(/signing domain/);
  });

  it("signs ten minutes at most, even for a request that names an hour", async () => {
    const { signer } = setup();
    const now = Math.floor(Date.now() / 1000);
    const signed = await signer.sign(request({ ...usdcRequirement(0.01, PAYEE), maxTimeoutSeconds: 3600 }));
    const left = Number(authOf(signed).validBefore) - now;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(601);
  });

  it("refuses to pay the account itself", async () => {
    const { signer, account } = setup();
    await expect(signer.sign(request(usdcRequirement(0.01, account.address)))).rejects.toThrow(/the account paying/);
  });

  it("returns the authorization the approval page would build, field for field", async () => {
    const { signer, account } = setup();
    const now = Math.floor(Date.now() / 1000);
    const signed = await signer.sign(request(usdcRequirement(0.01, PAYEE)));
    const auth = authOf(signed);
    expect(auth.from).toBe(account.address);
    expect(auth.to).toBe(PAYEE);
    expect(auth.value).toBe("10000");
    expect(auth.validAfter).toBe("0");
    expect(Number(auth.validBefore) - now).toBeGreaterThan(290);
    expect(Number(auth.validBefore) - now).toBeLessThanOrEqual(301);
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.signer).toBe(account.address);
  });

  it("signs over the token's own domain from the chain table", async () => {
    const { signer, account } = setup();
    const signed = await signer.sign(request(usdcRequirement(0.01, PAYEE)));
    const auth = authOf(signed);
    const valid = await verifyTypedData({
      address: account.address,
      domain: { name: DEFAULT_NETWORK.usdc.eip712.name, version: DEFAULT_NETWORK.usdc.eip712.version, chainId: DEFAULT_NETWORK.chainId, verifyingContract: DEFAULT_NETWORK.usdc.address },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
      signature: signed.payload.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
  });

  it("backdates validAfter by ten minutes for x402 v1, as the page does", async () => {
    const { signer } = setup();
    const now = Math.floor(Date.now() / 1000);
    const v1 = {
      scheme: "exact",
      network: BASE_SEPOLIA.v1Name,
      asset: BASE_SEPOLIA.usdc.address,
      maxAmountRequired: "10000",
      payTo: PAYEE,
      maxTimeoutSeconds: 300,
      extra: { name: BASE_SEPOLIA.usdc.eip712.name, version: BASE_SEPOLIA.usdc.eip712.version },
    };
    const signed = await signer.sign(request(v1, 1));
    expect(now - Number(authOf(signed).validAfter)).toBeGreaterThanOrEqual(599);
    expect(now - Number(authOf(signed).validAfter)).toBeLessThanOrEqual(601);
  });
});
