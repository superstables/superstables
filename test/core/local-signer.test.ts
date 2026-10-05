// The local key signer (the wallet process) signs over USDC's own EIP-712 domain, from this client's network table,
// whatever the offer's `extra` says or leaves out. The approval page does the same, so both signers agree.

import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK, usdcRequirement } from "../../src/core/chain.js";
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

  it("refuses a network outside this client's table rather than sign over a domain it does not know", async () => {
    const signer = new LocalKeySigner(privateKeyToAccount(generatePrivateKey()));
    // A chain this client does not know (a local devnet's id); the six EVM testnets are in the table.
    const requirements = { ...usdcRequirement(0.01, `0x${"22".repeat(20)}`), network: "eip155:31337", extra: {} };
    await expect(
      signer.sign({ kind: "eip3009", x402Version: 2, requirements } as Parameters<LocalKeySigner["sign"]>[0]),
    ).rejects.toThrow(/does not sign on eip155:31337/);
  });
});
