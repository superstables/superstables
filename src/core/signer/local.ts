// A signer that holds a private key in memory. Two legitimate users: the wallet process
// (the only place a key lives in the product) and tests. An agent never gets one.
//
// It signs x402 exact payments on the EVM chains `pay` supports, and nothing else: on Tempo the owner's wallet sends the
// payment itself, and on Solana it is a Solana key that signs, so those are approved in a browser wallet on the approval
// page. What it signs is the client's own EIP-3009 typed data, the one the approval page builds: it judges the request
// again, pins the token's signing domain, signs for ten minutes at most, never pays the account itself, and checks its own
// signature before it returns one.

import { verifyTypedData } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { chainGate, chainGateSettings } from "../chain-gate.js";
import { evmNetworkFor, isSameAddress, networkFor } from "../chain.js";
import { judgeSignRequest, x402RailFor } from "../rails/index.js";
import { untrustedText } from "../text.js";
import { buildTypedData } from "./steps/eip3009.js";
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
    // The signing domain is USDC's own, from this client's chain table, never the seller's `extra`: quoting already
    // refuses an offer that names another one, and an offer that names none is signed with USDC's, as the approval page
    // does. `pay` pays on the chains its rails name only; quoting refuses any other before the owner is asked, and this
    // refuses it again rather than sign over a domain the client does not know.
    const network = evmNetworkFor(String(req.requirements.network ?? ""));
    if (!network || !x402RailFor(network)) throw new SignRefused("invalid", `this wallet does not sign on ${untrustedText(req.requirements.network ?? "an unnamed chain", 60)}`);
    const gate = chainGate({ rail: network.rail, key: network.key, testnet: network.testnet, token: network.token }, chainGateSettings()); if (gate) throw new SignRefused("invalid", gate);
    // Judged again here, as every signer must: the chain gate, the offer's `extra` allow-list, Permit2, the pinned domain,
    // the amount and the recipient. A request sent straight to the wallet gets no easier a check than one `pay` made.
    const judged = judgeSignRequest(req);
    if (!judged.supported) throw new SignRefused("invalid", judged.reason);
    if (req.x402Version === 1 && !network.v1Name) throw new SignRefused("invalid", `x402 v1 has no name for ${network.label}, so this wallet does not sign a v1 payment there`);
    if (isSameAddress(judged.offer.terms.recipient, this.account.address)) throw new SignRefused("invalid", "the recipient is the account paying, so this payment was not signed");
    // The seller's window is clamped to ten minutes in there, and validAfter is backdated for v1, as the page does.
    const typed = buildTypedData({ network, requirement: judged.offer.requirement, x402Version: req.x402Version }, this.account.address);
    const domain = { ...typed.domain, verifyingContract: typed.domain.verifyingContract as `0x${string}` };
    const message = {
      from: typed.message.from as `0x${string}`,
      to: typed.message.to as `0x${string}`,
      value: BigInt(typed.message.value),
      validAfter: BigInt(typed.message.validAfter),
      validBefore: BigInt(typed.message.validBefore),
      nonce: typed.message.nonce as `0x${string}`,
    };
    const types = { TransferWithAuthorization: typed.types.TransferWithAuthorization };
    const signature = await this.account.signTypedData({ domain, types, primaryType: "TransferWithAuthorization", message });
    const genuine = await verifyTypedData({ address: this.account.address, domain, types, primaryType: "TransferWithAuthorization", message, signature });
    if (!genuine) throw new SignRefused("invalid", "the wallet's signature did not verify; nothing was returned");
    return {
      kind: "eip3009",
      payload: { signature, authorization: { ...typed.message } },
      signer: this.account.address,
    };
  }
}
