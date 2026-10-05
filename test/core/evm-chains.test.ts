// The six EVM testnets `pay` signs on. Their facts are written twice, once here (src/core/chain.ts) and once for the
// budget (budget/evm/chains.mjs), so the first test holds the two tables together field by field. The rest pin what the
// owner's wallet signs on each chain: the token's own EIP-712 domain (Arbitrum's is "USD Coin", SKALE's "Bridged USDC
// (SKALE Bridge)"), a seller that names any other is refused, and the chain a wallet is offered carries its own currency.

import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { EVM_CHAINS, EVM_CHAIN_KEYS } from "../../budget/evm/chains.mjs";
import { EVM_NETWORKS, shortLabel, txUrl, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { SUPPORTED_NETWORKS } from "../../src/core/rails/index.js";
import { checkSettlement } from "../../src/core/settlement.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { buildTypedData, eip3009Step } from "../../src/core/signer/steps/eip3009.js";
import type { StepRecord } from "../../src/core/signer/steps/types.js";
import { termsFor } from "../../src/core/x402.js";
import { paymentReceipt, startFakeBaseSepolia, type FakeBaseSepolia } from "../helpers/fake-base-sepolia.js";

const PAY_TO = `0x${"22".repeat(20)}`;
const budget = EVM_CHAINS as Record<string, any>;

/** What the six chains must be, written out once more: the vectors a reviewer checks against the chains themselves. */
const VECTORS: Record<string, { chainId: number; usdc: string; domain: { name: string; version: string }; native: { symbol: string; decimals: number } }> = {
  "base-sepolia": { chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", domain: { name: "USDC", version: "2" }, native: { symbol: "ETH", decimals: 18 } },
  "arc-testnet": { chainId: 5042002, usdc: "0x3600000000000000000000000000000000000000", domain: { name: "USDC", version: "2" }, native: { symbol: "USDC", decimals: 18 } },
  "arbitrum-sepolia": { chainId: 421614, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", domain: { name: "USD Coin", version: "2" }, native: { symbol: "ETH", decimals: 18 } },
  "polygon-amoy": { chainId: 80002, usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", domain: { name: "USDC", version: "2" }, native: { symbol: "POL", decimals: 18 } },
  "skale-base-sepolia": { chainId: 324705682, usdc: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD", domain: { name: "Bridged USDC (SKALE Bridge)", version: "2" }, native: { symbol: "CREDIT", decimals: 18 } },
  "ethereum-sepolia": { chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", domain: { name: "USDC", version: "2" }, native: { symbol: "ETH", decimals: 18 } },
};

function record(network: EvmNetwork, version: 1 | 2 = 2): StepRecord {
  const requirement = usdcRequirement(0.01, PAY_TO, network);
  const judged = termsFor(requirement, version);
  if (!judged.supported) throw new Error(judged.reason);
  return { id: "x", kind: "eip3009", network, verified: { ...judged.terms, payer: "" }, requirement: judged.requirement, x402Version: version, expiresAt: Date.now() + 60_000 };
}

describe("the EVM chain table", () => {
  it("agrees with the budget's chain table, field by field, in the same order", () => {
    expect(EVM_NETWORKS.map((n) => n.key)).toEqual(EVM_CHAIN_KEYS);
    for (const network of EVM_NETWORKS) {
      const b = budget[network.key];
      expect(shortLabel(network), network.key).toBe(b.label);
      expect(network.chainId, network.key).toBe(b.chainId);
      expect(network.caip2, network.key).toBe(`eip155:${b.chainId}`);
      expect(network.defaultRpc, network.key).toBe(b.rpc);
      expect(network.explorer, network.key).toBe(b.explorer);
      expect(network.usdc, network.key).toEqual({ address: b.token.address, decimals: b.token.decimals, eip712: b.token.domain });
      expect(network.token, network.key).toEqual({ symbol: b.token.symbol, address: b.token.address, decimals: b.token.decimals });
      expect(network.v1Name, network.key).toBe(b.legacy[0] ?? "");
      expect(network.wallet.nativeCurrency.symbol, network.key).toBe(b.gas.symbol);
      expect(network.wallet.nativeCurrency.decimals, network.key).toBe(b.gas.decimals);
      expect(network.testnet).toBe(true);
    }
  });

  it("holds the pinned vectors for every chain, and pay signs on all six", () => {
    expect(Object.keys(VECTORS)).toEqual(EVM_NETWORKS.map((n) => n.key));
    for (const network of EVM_NETWORKS) {
      const v = VECTORS[network.key];
      expect({ chainId: network.chainId, usdc: network.usdc.address, domain: network.usdc.eip712, native: { symbol: network.wallet.nativeCurrency.symbol, decimals: network.wallet.nativeCurrency.decimals } }, network.key).toEqual(v);
      expect(SUPPORTED_NETWORKS.map((n) => n.caip2)).toContain(network.caip2);
    }
  });
});

describe("judging an x402 offer on each EVM chain", () => {
  it("accepts the chain's USDC with its own domain, or with none, and derives the terms from the offer", () => {
    for (const network of EVM_NETWORKS) {
      const offer = usdcRequirement(0.01, PAY_TO, network);
      const judged = termsFor(offer, 2);
      expect(judged.supported, network.key).toBe(true);
      if (!judged.supported) continue;
      expect(judged.terms).toMatchObject({ asset: "USDC", assetAddress: network.usdc.address, network: network.caip2, networkLabel: network.label, amountAtomic: "10000" });
      expect(termsFor({ ...offer, extra: {} }, 2).supported, network.key).toBe(true);
      if (network.v1Name) expect(termsFor({ ...offer, network: network.v1Name, maxAmountRequired: "10000" }, 1).supported, network.key).toBe(true);
    }
  });

  it("refuses an offer whose signing domain is not that chain's USDC's, so the wallet never shows a name the seller chose", () => {
    for (const network of EVM_NETWORKS) {
      const offer = usdcRequirement(0.01, PAY_TO, network);
      const others = [
        { name: network.usdc.eip712.name === "USDC" ? "USD Coin" : "USDC", version: "2" },
        { name: network.usdc.eip712.name, version: "1" },
        { name: "Superstables Official Refund", version: "2" },
      ];
      for (const extra of others) {
        const judged = termsFor({ ...offer, extra }, 2);
        expect(judged.supported, `${network.key} ${JSON.stringify(extra)}`).toBe(false);
        if (judged.supported) continue;
        expect(judged.reason).toContain(`expected name "${network.usdc.eip712.name}", version "${network.usdc.eip712.version}"`);
      }
    }
  });

  it("refuses another chain's USDC, and every mainnet by name", () => {
    const arbitrum = EVM_NETWORKS.find((n) => n.key === "arbitrum-sepolia")!;
    const wrongToken = termsFor({ ...usdcRequirement(0.01, PAY_TO, arbitrum), asset: EVM_NETWORKS[0].usdc.address, extra: {} }, 2);
    expect(wrongToken).toMatchObject({ supported: false, reason: "asset 0x036CbD53842c5426634e7929541eC2318f3dCF7e is not USDC on Arbitrum Sepolia (testnet)" });
    for (const [network, name] of [
      ["eip155:8453", "Base (mainnet)"],
      ["base", "Base (mainnet)"],
      ["eip155:1", "Ethereum (mainnet)"],
      ["ethereum", "Ethereum (mainnet)"],
      ["eip155:42161", "Arbitrum One (mainnet)"],
      ["eip155:137", "Polygon (mainnet)"],
      ["polygon", "Polygon (mainnet)"],
      ["eip155:5042", "Arc (mainnet)"],
      ["eip155:1187947933", "SKALE Base (mainnet)"],
      ["eip155:4217", "Tempo (mainnet)"],
      ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "Solana (mainnet)"],
      ["solana", "Solana (mainnet)"],
    ]) {
      const judged = termsFor({ ...usdcRequirement(0.01, PAY_TO), network, extra: {} }, 2);
      expect(judged.supported, network).toBe(false);
      if (judged.supported) continue;
      expect(judged.reason, network).toContain(`chain ${name} is not supported: it is a mainnet, and this client pays on testnets only`);
    }
  });
});

describe("what the owner's wallet signs on each EVM chain", () => {
  it("builds the authorization over the chain's own USDC domain on the approval page, and a signature over it verifies", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    for (const network of EVM_NETWORKS) {
      const typed = buildTypedData(record(network), owner.address);
      expect(typed.domain, network.key).toEqual({ name: VECTORS[network.key].domain.name, version: "2", chainId: VECTORS[network.key].chainId, verifyingContract: VECTORS[network.key].usdc });
      const signature = await owner.signTypedData(typed as never);
      expect(await verifyTypedData({ address: owner.address, signature, ...typed } as never), network.key).toBe(true);
    }
  });

  it("signs the same domain in the local wallet, on every chain, v1 where the chain has a v1 name", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const signer = new LocalKeySigner(owner);
    for (const network of EVM_NETWORKS) {
      for (const version of [2, ...(network.v1Name ? [1] : [])] as (1 | 2)[]) {
        const r = record(network, version);
        const signed = await signer.sign({ kind: "eip3009", requirements: r.requirement as never, x402Version: version });
        const authorization = signed.payload.authorization as Record<string, string>;
        const valid = await verifyTypedData({
          address: owner.address,
          signature: signed.payload.signature as `0x${string}`,
          domain: { name: network.usdc.eip712.name, version: network.usdc.eip712.version, chainId: network.chainId, verifyingContract: network.usdc.address },
          types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
          primaryType: "TransferWithAuthorization",
          message: { from: authorization.from, to: authorization.to, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
        } as never);
        expect(valid, `${network.key} v${version}`).toBe(true);
      }
    }
    expect(await signer.address("eip155:421614")).toBe(owner.address);
    await expect(signer.address("eip155:42431")).rejects.toThrow(/EVM chains only/);
  });

  it("offers the wallet each chain with its own currency: ETH, Arc's 18-decimal USDC, POL, SKALE's CREDIT", () => {
    for (const network of EVM_NETWORKS) {
      const facts = eip3009Step.pageFacts(record(network));
      expect(facts, network.key).toEqual({
        chainIdHex: `0x${VECTORS[network.key].chainId.toString(16)}`,
        chainName: budget[network.key].label,
        rpcUrl: network.rpc,
        explorer: budget[network.key].explorer,
        nativeCurrency: { name: network.wallet.nativeCurrency.name, ...VECTORS[network.key].native },
      });
    }
  });

  it("links each chain's transactions to its own explorer", () => {
    const hash = `0x${"ab".repeat(32)}`;
    for (const network of EVM_NETWORKS) expect(txUrl(network.caip2, hash)).toBe(`${budget[network.key].explorer}/tx/${hash}`);
  });
});

describe("reading a settlement on each EVM chain", () => {
  let chain: FakeBaseSepolia | undefined;
  afterEach(async () => {
    await chain?.close();
    chain = undefined;
  });

  it("verifies a settlement only through that chain's own USDC contract", async () => {
    const payer = `0x${"11".repeat(20)}`;
    const nonce = `0x${"44".repeat(32)}`;
    const tx = `0x${"ab".repeat(32)}`;
    chain = await startFakeBaseSepolia();
    for (const network of EVM_NETWORKS) {
      const input = { transaction: tx, payer, recipient: PAY_TO, amountAtomic: "10000", nonce, network: network.caip2 };
      chain.receipts.set(tx, paymentReceipt({ payer, to: PAY_TO, value: 10000n, nonce, token: network.usdc.address }));
      expect(await checkSettlement(input, { rpcUrl: chain.url }), network.key).toEqual({ chain: "verified" });
      // The same logs from another chain's USDC contract are not this payment.
      const other = EVM_NETWORKS.find((n) => n.usdc.address !== network.usdc.address)!;
      chain.receipts.set(tx, paymentReceipt({ payer, to: PAY_TO, value: 10000n, nonce, token: other.usdc.address }));
      expect((await checkSettlement(input, { rpcUrl: chain.url })).chain, network.key).toBe("mismatch");
    }
    expect(await checkSettlement({ transaction: tx, payer, recipient: PAY_TO, amountAtomic: "10000", nonce, network: "eip155:42431" }, { rpcUrl: chain.url })).toEqual({ chain: "unchecked", reason: "this payment's chain is not one this client reads" });
  });
});
