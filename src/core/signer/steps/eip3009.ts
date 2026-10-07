// The wallet step for x402 exact on an EVM chain: the page connects an account, the server builds the exact EIP-3009
// TransferWithAuthorization for it over the chain's USDC domain, the wallet signs it with eth_signTypedData_v4, and the
// server checks the signature is that account's before it is believed. The page's main script does the wallet side.

import { randomBytes } from "node:crypto";
import type { PaymentRequirements } from "@x402/core/types";
import { authorizationTypes } from "@x402/evm";
import { getAddress, toHex, verifyTypedData } from "viem";
import { isAddress, shortLabel } from "../../chain.js";
import type { StepAnswer, StepRecord, WalletStep } from "./types.js";

/** The EIP-712 payload, in the JSON-safe shape a browser wallet's signTypedData_v4 expects. */
export interface ApprovalTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "TransferWithAuthorization";
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/**
 * Builds exactly the authorization the x402 exact scheme signs, for the account the page
 * reported. The values match what the SDK's own client produces field for field, because the
 * facilitator that settles this credential checks all of them: a v1 requirement backdates
 * validAfter by ten minutes and carries its amount as maxAmountRequired, a v2 one does not.
 */
export function buildTypedData(record: StepRecord, payer: string): ApprovalTypedData {
  const network = record.network;
  if (network.rail !== "evm") throw new Error(`${network.label} is not an x402 EVM chain`);
  const requirement = record.requirement as PaymentRequirements & { maxAmountRequired?: string };
  const now = Math.floor(Date.now() / 1000);
  const timeout = Number(requirement.maxTimeoutSeconds ?? 300);
  return {
    domain: {
      // USDC's own domain, never the seller's `extra`: the wallet shows the domain name as the signing application,
      // and quoting refuses an offer whose `extra` names another one (rails/evm.ts).
      name: network.usdc.eip712.name,
      version: network.usdc.eip712.version,
      chainId: network.chainId,
      verifyingContract: getAddress(String(requirement.asset)),
    },
    // Copied rather than referenced: this object is serialised to the page as JSON, and the
    // SDK's own table is frozen and read-only.
    types: {
      EIP712Domain: EIP712_DOMAIN_TYPE,
      TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(payer),
      to: getAddress(String(requirement.payTo)),
      value: String(requirement.amount ?? requirement.maxAmountRequired ?? "0"),
      validAfter: record.x402Version === 1 ? String(now - 600) : "0",
      validBefore: String(now + timeout),
      nonce: toHex(randomBytes(32)),
    },
  };
}

export const eip3009Step: WalletStep = {
  kind: "eip3009",
  routes: ["/account", "/signature"],

  account(value: unknown): string | undefined {
    return typeof value === "string" && isAddress(value) ? getAddress(value) : undefined;
  },

  async prepare(record: StepRecord, account: string): Promise<StepAnswer> {
    // A person may switch accounts before signing, so this rebuilds rather than refusing.
    const typedData = buildTypedData(record, account);
    record.prepared = typedData;
    return {
      http: 200,
      body: {
        typedData,
        summary: `${record.verified.amountDecimal} ${record.verified.asset} to ${record.verified.recipient} on ${record.verified.networkLabel}`,
      },
    };
  },

  async answer(record: StepRecord, leaf: string, body: Record<string, unknown>): Promise<StepAnswer> {
    if (leaf !== "/signature") return { http: 404, body: { error: "no such route" } };
    const address = typeof body.address === "string" ? body.address : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const typedData = record.prepared as ApprovalTypedData | undefined;
    if (!typedData || !record.account) {
      return { http: 409, body: { error: "connect an account first: there is nothing prepared to sign" } };
    }
    if (!isAddress(address) || getAddress(address) !== record.account) {
      return { http: 400, body: { error: `this payment was prepared for ${record.account}; connect that account again, or reconnect to prepare a new one` } };
    }
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) return { http: 400, body: { error: "that is not a signature" } };
    let valid = false;
    try {
      // viem's typed-data types are built from literal type tables; ours is the JSON shape
      // the page signs, so the argument is checked here by construction rather than by TS.
      valid = await verifyTypedData({
        address: record.account as `0x${string}`,
        signature: signature as `0x${string}`,
        ...typedData,
      } as unknown as Parameters<typeof verifyTypedData>[0]);
    } catch {
      valid = false;
    }
    if (!valid) {
      // The request stays pending on purpose: a wrong account is a mistake, not a decision.
      return { http: 400, body: { error: `that signature was not made by ${record.account}; nothing was accepted, and you can sign again` } };
    }
    return {
      http: 200,
      body: { status: "signed" },
      signed: { kind: "eip3009", payload: { signature, authorization: { ...typedData.message } }, signer: record.account },
    };
  },

  pageFacts(record: StepRecord) {
    const network = record.network;
    return {
      chainIdHex: `0x${network.chainId.toString(16)}`,
      chainName: network.wallet.chainName || shortLabel(network),
      rpcUrl: network.rpc,
      explorer: network.explorer,
      nativeCurrency: network.wallet.nativeCurrency,
    };
  },

  words: {
    lede: "Check the amount and the recipient, then sign with your browser wallet, or reject. Your wallet keeps its key.",
    fineprint: (facts) =>
      `Your wallet shows this amount in the token's smallest unit: ${facts.amountAtomic} is ${facts.amountDecimal} ${facts.asset}. Signing authorises this one transfer and nothing else.`,
  },

  script: "",
};
