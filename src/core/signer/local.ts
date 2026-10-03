// A signer that holds a private key in memory. Two legitimate users: the wallet process
// (the only place a key lives in the product) and tests. An agent never gets one.

import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import type { PrivateKeyAccount } from "viem/accounts";
import { networkFor } from "../chain.js";
import { untrustedText } from "../text.js";
import { SignRefused, type SignHooks, type SignRequest, type SignResult, type Signer } from "./types.js";

export class LocalKeySigner implements Signer {
  readonly kind = "local" as const;
  constructor(private readonly account: PrivateKeyAccount) {}

  get addressSync(): string {
    return this.account.address;
  }

  async address(network: string): Promise<string> {
    if (!networkFor(network)) throw new Error(`no identity on ${network}`);
    return this.account.address;
  }

  async sign(req: SignRequest, _hooks?: SignHooks): Promise<SignResult> {
    if (req.kind !== "eip3009") throw new SignRefused("invalid", `cannot sign ${(req as { kind: string }).kind}`);
    // v1 requirements carry maxAmountRequired and a vernacular network name; the SDK has a
    // separate scheme for them. Both produce the same {signature, authorization} payload.
    const scheme = req.x402Version === 1 ? new ExactEvmSchemeV1(this.account) : new ExactEvmScheme(this.account);
    // The signing domain is USDC's own, from this client's network table, never the seller's `extra`: quoting already
    // refuses an offer that names another one, and an offer that names none is signed with USDC's, as the approval page
    // does. Only the signature is taken from what the SDK builds; the requirement sent back to the seller is unchanged.
    // `pay` pays on the networks in this client's table only (Base Sepolia today); quoting refuses any other before the
    // owner is asked, and this refuses it again rather than sign over a domain the client does not know.
    const network = networkFor(String(req.requirements.network ?? ""));
    if (!network) throw new SignRefused("invalid", `this wallet does not sign on ${untrustedText(req.requirements.network ?? "an unnamed network", 60)}`);
    const requirements = { ...req.requirements, extra: { ...(req.requirements.extra ?? {}), name: network.usdc.eip712.name, version: network.usdc.eip712.version } };
    const created = await scheme.createPaymentPayload(req.x402Version, requirements);
    return {
      kind: "eip3009",
      payload: created.payload as { signature: string; authorization: Record<string, unknown> },
      signer: this.account.address,
    };
  }
}
