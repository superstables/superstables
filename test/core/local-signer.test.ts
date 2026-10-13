// The local key signer (the wallet process) signs over USDC's own EIP-712 domain, from this client's network table,
// whatever the offer's `extra` says or leaves out. The approval page does the same, so both signers agree.

import { recoverTypedDataAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK, usdcRequirement } from "../../src/core/chain.js";
import { nonceReferral, referralNonce } from "../../src/core/referral-nonce.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";

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

describe("LocalKeySigner", () => {
  it("signs an offer that names no domain with USDC's own", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signer = new LocalKeySigner(account);
    const requirements = { ...usdcRequirement(0.01, `0x${"22".repeat(20)}`), extra: {} };

    const signed = await signer.sign({ kind: "eip3009", x402Version: 2, requirements } as Parameters<LocalKeySigner["sign"]>[0]);

    const auth = signed.payload.authorization as Record<string, string>;
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: DEFAULT_NETWORK.usdc.eip712.name,
        version: DEFAULT_NETWORK.usdc.eip712.version,
        chainId: DEFAULT_NETWORK.chainId,
        verifyingContract: DEFAULT_NETWORK.usdc.address,
      },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: signed.payload.signature as `0x${string}`,
    });
    expect(valid).toBe(true);
    // The requirement it was handed is left as it was.
    expect(requirements.extra).toEqual({});
  });

  it("signs the nonce it is handed, so a marked authorization recovers to the key and names its referral", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signer = new LocalKeySigner(account);
    const nonce = referralNonce("ref_AAECAwQFBgcICQoLDA0ODw", (size) => Buffer.alloc(size, 0xaa));
    const requirements = usdcRequirement(0.01, `0x${"22".repeat(20)}`);

    const signed = await signer.sign({ kind: "eip3009", x402Version: 2, requirements, nonce } as Parameters<LocalKeySigner["sign"]>[0]);

    const auth = signed.payload.authorization as Record<string, string>;
    expect(auth.nonce).toBe("0x53535246000102030405060708090a0b0c0d0e0faaaaaaaaaaaaaaaaaaaaaaaa");
    expect(nonceReferral(auth.nonce)).toBe("ref_AAECAwQFBgcICQoLDA0ODw");
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: DEFAULT_NETWORK.usdc.eip712.name,
        version: DEFAULT_NETWORK.usdc.eip712.version,
        chainId: DEFAULT_NETWORK.chainId,
        verifyingContract: DEFAULT_NETWORK.usdc.address,
      },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: signed.payload.signature as `0x${string}`,
    });
    expect(recovered).toBe(account.address);
    expect(auth).toMatchObject({ from: account.address, to: `0x${"22".repeat(20)}`, value: "10000", validAfter: "0" });
  });

  it("leaves a Permit2 offer to the x402 SDK: a Permit2 authorization with a nonce of its own, as before", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signer = new LocalKeySigner(account);
    const base = usdcRequirement(0.01, `0x${"22".repeat(20)}`);
    const requirements = { ...base, extra: { ...base.extra, assetTransferMethod: "permit2" } };
    const nonce = referralNonce("ref_AAECAwQFBgcICQoLDA0ODw", (size) => Buffer.alloc(size, 0xaa));

    const signed = await signer.sign({ kind: "eip3009", x402Version: 2, requirements, nonce } as Parameters<LocalKeySigner["sign"]>[0]);

    expect(signed.kind).toBe("eip3009");
    expect(Object.keys(signed.payload).sort()).toEqual(["permit2Authorization", "signature"]);
    const permit = (signed.payload as unknown as { permit2Authorization: Record<string, unknown> }).permit2Authorization;
    expect(permit).toMatchObject({ from: account.address, permitted: { token: DEFAULT_NETWORK.usdc.address, amount: "10000" } });
    expect(String(permit.nonce)).not.toContain("53535246");
  });

  it("refuses a network outside this client's table rather than sign over a domain it does not know", async () => {
    const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
    // A chain this client does not know (a local devnet's id); the seven EVM testnets are in the table.
    const requirements = { ...usdcRequirement(0.01, `0x${"22".repeat(20)}`), network: "eip155:31337", extra: {} };
    await expect(
      signer.sign({ kind: "eip3009", x402Version: 2, requirements } as Parameters<LocalKeySigner["sign"]>[0]),
    ).rejects.toThrow(/does not sign on eip155:31337/);
  });
});
