// A signer that holds a private key in memory. Two legitimate users: the wallet process
// (the only place a key lives in the product) and tests. An agent never gets one.
//
// It signs x402 exact payments on the EVM chains `pay` supports, and nothing else: on Tempo the owner's wallet sends the
// payment itself, and on Solana it is a Solana key that signs, so those are approved in a browser wallet on the approval
// page.

import { ExactEvmScheme } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import type { PrivateKeyAccount } from "viem/accounts";
import { evmNetworkFor, networkFor } from "../chain.js";
import { x402RailFor } from "../rails/index.js";
import { untrustedText } from "../text.js";
import { LOCAL_WALLET_EVM_ONLY, SignRefused, type Eip3009SignResult, type SignHooks, type SignRequest, type Signer } from "./types.js";

export class LocalKeySigner implements Signer {
  readonly kind = "local" as const;
  constructor(private readonly account: PrivateKeyAccount) {}

  get addressSync(): string {
    return this.account.address;
  }

  async address(network: string): Promise<string> {
    const known = networkFor(network);
    if (!known) throw new Error(`no identity on ${network}`);
    if (known.rail !== "evm") throw new Error(LOCAL_WALLET_EVM_ONLY);
    return this.account.address;
  }

  async sign(req: SignRequest, _hooks?: SignHooks): Promise<Eip3009SignResult> {
    if (req.kind !== "eip3009") {
      const kind = (req as { kind: unknown }).kind;
      throw new SignRefused("invalid", kind === "tempo-transfer" || kind === "solana-transaction" ? LOCAL_WALLET_EVM_ONLY : `cannot sign ${String(kind)}`);
    }
    // v1 requirements carry maxAmountRequired and a vernacular network name; the SDK has a
    // separate scheme for them. Both produce the same {signature, authorization} payload.
    const scheme = req.x402Version === 1 ? new ExactEvmSchemeV1(this.account) : new ExactEvmScheme(this.account);
    // The signing domain is USDC's own, from this client's chain table, never the seller's `extra`: quoting already
    // refuses an offer that names another one, and an offer that names none is signed with USDC's, as the approval page
    // does. Only the signature is taken from what the SDK builds; the requirement sent back to the seller is unchanged.
    // `pay` pays on the chains its rails name only; quoting refuses any other before the owner is asked, and this refuses
    // it again rather than sign over a domain the client does not know.
    const network = evmNetworkFor(String(req.requirements.network ?? ""));
    if (!network || !x402RailFor(network)) throw new SignRefused("invalid", `this wallet does not sign on ${untrustedText(req.requirements.network ?? "an unnamed chain", 60)}`);
    const requirements = {
      ...req.requirements,
      // The x402 v1 SDK knows a chain by its v1 name only; a v1 offer that names the chain by CAIP-2 is signed under it.
      ...(req.x402Version === 1 && network.v1Name ? { network: network.v1Name } : {}),
      extra: { ...(req.requirements.extra ?? {}), name: network.usdc.eip712.name, version: network.usdc.eip712.version },
    } as typeof req.requirements;
    if (req.x402Version === 1 && !network.v1Name) throw new SignRefused("invalid", `x402 v1 has no name for ${network.label}, so this wallet does not sign a v1 payment there`);
    const created = await scheme.createPaymentPayload(req.x402Version, requirements);
    return {
      kind: "eip3009",
      payload: created.payload as { signature: string; authorization: Record<string, unknown> },
      signer: this.account.address,
    };
  }
}
