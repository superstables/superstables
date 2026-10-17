// The agent side of signing. This signer holds no key and can approve nothing: it posts the
// seller's requirement to the owner's wallet on 127.0.0.1 and waits for a human decision.
// Every outcome that is not a signature is a refusal with a reason, never an exception the
// caller has to guess at — "the owner said no" is an answer, and the agent should say it.

import { verifyTypedData } from "viem";
import { authorizationTypes } from "@x402/evm";
import { agentTokenPath, walletUrl } from "../home.js";
import { readBody } from "../http.js";
import { untrustedText } from "../text.js";
import { evmNetworkFor, isSameAddress, networkFor } from "../chain.js";
import { MAX_SIGNED_LIFETIME_S } from "../rails/evm.js";
import type { WalletRequestView, WalletStatus } from "../types.js";
import { LOCAL_WALLET_EVM_ONLY, SignRefused, type Eip3009SignRequest, type Eip3009SignResult, type SignHooks, type SignRequest, type Signer } from "./types.js";
import { readSecretFile } from "../../wallet/keystore.js";

export interface WalletSignerOptions {
  /** Where the wallet is listening. Loopback only in this release. */
  url?: string;
  /** Bearer token for the agent-facing routes. Lets an agent ask; it never approves. */
  agentToken?: string;
  /** How often to ask the wallet whether the owner has decided. */
  pollMs?: number;
  /** How long to wait for the owner before giving up on this request. */
  timeoutMs?: number;
  /** Injected in tests; the global fetch otherwise. */
  fetchImpl?: typeof fetch;
}

/** What the agent is told when the wallet is not there. It names the fix. */
const WALLET_DOWN =
  "the wallet is not running or the agent token is wrong; start it with `superstables wallet serve`";

const DEFAULT_POLL_MS = 500;
/** A little longer than the wallet's own approval timeout, so the wallet decides first. */
const DEFAULT_TIMEOUT_MS = 130_000;
/** Per-request timeout: the wallet is local, so a slow answer means something is wrong. */
const HTTP_TIMEOUT_MS = 10_000;
/** The most read of one answer from the wallet: its views and status are a few KB. */
const WALLET_MAX_BYTES = 256 * 1024;

/** Everything needed to talk to the wallet, resolved once per signer. */
interface WalletWire {
  url: string;
  token: () => string;
  fetchImpl: typeof fetch;
}

function wireFor(options: WalletSignerOptions): WalletWire {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  return {
    url: (options.url ?? walletUrl()).replace(/\/$/, ""),
    // Read late: the wallet may have been started after this signer was built.
    token: () => {
      if (options.agentToken !== undefined) return options.agentToken;
      const fromEnv = process.env.SUPERSTABLES_WALLET_AGENT_TOKEN;
      if (fromEnv) return fromEnv;
      // One open, checked on what it opened: a regular file only this user can read. A FIFO would stop every command for
      // good, and a token other users can read is not sent.
      try {
        return readSecretFile(agentTokenPath(), "the wallet's agent token").trim();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw new SignRefused("unavailable", `${(err as Error).message}; the token was not sent`);
      }
    },
    fetchImpl,
  };
}

/**
 * One call to the wallet. Anything that means "there is no wallet here, or it will not talk
 * to me" comes back as an unavailable refusal, because that is what the agent must report.
 */
async function walletRequest<T>(wire: WalletWire, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await wire.fetchImpl(`${wire.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${wire.token()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof SignRefused) throw err;
    throw new SignRefused("unavailable", WALLET_DOWN);
  }
  // A wallet that is full (429) or cannot keep its audit log (503) says why, and nobody was asked: an unavailable refusal,
  // which reopens the quote, not a refusal of this payment.
  if (res.status === 429 || res.status === 503) {
    const { text } = await readBody(res, 200, HTTP_TIMEOUT_MS);
    let said = text;
    try {
      const error = (JSON.parse(text) as { error?: unknown }).error;
      if (typeof error === "string") said = error;
    } catch {
      // cut off at 200 bytes: the raw text is shown
    }
    said = untrustedText(said, 200);
    throw new SignRefused("unavailable", `the wallet refused: ${said || `HTTP ${res.status}`}`);
  }
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    throw new SignRefused("unavailable", WALLET_DOWN);
  }
  if (!res.ok) {
    const { text } = await readBody(res, 200, HTTP_TIMEOUT_MS);
    const said = untrustedText(text, 200);
    throw new SignRefused("invalid", `the wallet refused the request (HTTP ${res.status})${said ? `: ${said}` : ""}`);
  }
  // more than the cap, cut off, or late: not an answer from this wallet
  const { text, end } = await readBody(res, WALLET_MAX_BYTES, HTTP_TIMEOUT_MS, WALLET_MAX_BYTES + 1);
  if (end !== "eof") throw new SignRefused("unavailable", WALLET_DOWN);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SignRefused("unavailable", WALLET_DOWN);
  }
}

export class WalletSigner implements Signer {
  readonly kind = "wallet" as const;

  get approvalWindowMs(): number {
    return this.timeoutMs;
  }

  private readonly wire: WalletWire;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  /** Requests this signer is waiting on, so closing it can cancel them. */
  private readonly outstanding = new Set<string>();
  /** One cancel per request, shared by the deadline and by close(). */
  private readonly cancels = new Map<string, Promise<WalletRequestView | undefined>>();
  private closed = false;

  constructor(options: WalletSignerOptions = {}) {
    this.wire = wireFor(options);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * What the wallet says about itself, over this signer's own connection. Same answer as
   * walletStatus() below, without having to hand the url and the token around a second time.
   */
  async status(): Promise<WalletStatus> {
    return walletRequest<WalletStatus>(this.wire, "GET", "/status");
  }

  /**
   * The address that would pay on this network, as the wallet reports it. The wallet holds one EVM key, and an
   * EIP-3009 signature is the same on every EVM chain, so it pays on each of them; on Tempo and Solana it does not pay.
   */
  async address(network: string): Promise<string> {
    const known = networkFor(network);
    if (known && !evmNetworkFor(network)) throw new Error(LOCAL_WALLET_EVM_ONLY);
    const answer = await walletRequest<{ address: string; network: string }>(this.wire, "GET", "/address");
    if (known && !evmNetworkFor(answer.network)) {
      throw new Error(`the wallet has no identity on ${network} (it is set up for ${answer.network})`);
    }
    return answer.address;
  }

  /**
   * Ask the owner to sign one payment. Returns only when the owner approved and the wallet
   * signed; every other ending throws SignRefused with the reason the owner (or the wallet's
   * own policy) gave.
   */
  async sign(req: SignRequest, hooks?: SignHooks): Promise<Eip3009SignResult> {
    // The local wallet signs EIP-3009 only: a payment the owner's wallet must send (Tempo) or a Solana key must sign is
    // refused here, before anyone is asked.
    if (req.kind !== "eip3009") throw new SignRefused("invalid", LOCAL_WALLET_EVM_ONLY);
    await hooks?.beforeAsk?.();
    const deadline = Date.now() + this.timeoutMs;
    // The wallet is told how long this wait is, so that it never hands out a signature after it.
    let view = await walletRequest<WalletRequestView>(this.wire, "POST", "/requests", { sign: req, waitMs: this.timeoutMs });

    // The wallet decides twice before a human is involved: is this request well formed, and
    // does the owner's own policy allow it? Both answers come back on the first response.
    if (view.status === "rejected") {
      throw new SignRefused("invalid", view.reason ?? "the wallet rejected the request", view.id);
    }
    if (view.status === "denied") {
      throw new SignRefused("policy", view.reason ?? "the wallet's policy refused this payment", view.id);
    }
    if (view.status === "expired") {
      throw new SignRefused("expired", view.reason ?? "the request expired before it was seen", view.id);
    }
    if (view.status === "pending") hooks?.onPending?.(view.id);

    const id = view.id;
    this.outstanding.add(id);
    try {
      while (view.status !== "signed") {
        if (this.closed) throw await this.gaveUp(id, "abandoned");
        if (Date.now() >= deadline) throw await this.gaveUp(id, "expired");
        await sleep(Math.max(0, Math.min(this.pollMs, deadline - Date.now())));
        if (this.closed) throw await this.gaveUp(id, "abandoned");
        view = await walletRequest<WalletRequestView>(
          this.wire,
          "GET",
          `/requests/${encodeURIComponent(id)}`,
        );
        if (view.status === "denied") {
          throw new SignRefused("denied", view.reason ?? "the owner denied this payment in the wallet", view.id);
        }
        if (view.status === "expired") {
          throw new SignRefused("expired", view.reason ?? "the request expired before the owner decided", view.id);
        }
        if (view.status === "rejected") {
          throw new SignRefused("invalid", view.reason ?? "the wallet rejected the request", view.id);
        }
      }
      // Closed while the last answer was on its way: closed means no signature comes back, even this one.
      if (this.closed) throw await this.gaveUp(id, "abandoned");
    } finally {
      this.outstanding.delete(id);
    }

    if (!view.result) {
      throw new SignRefused("invalid", view.withheld ? (view.reason ?? "the wallet withheld this signature") : "the wallet reported a signature but returned no payload", view.id);
    }
    // Whatever answers on that port, the signature is checked before it is believed: it must be the payment that was asked for.
    const problem = await resultProblem(req, view.result, Date.now());
    if (problem) {
      throw new SignRefused("invalid", `the wallet returned an authorization that is not the one asked for (${problem}); it was not sent`, view.id);
    }
    return { kind: "eip3009", payload: view.result.payload, signer: view.result.signer };
  }

  /** The refusal for a wait that ended without a signature, after the wallet was told to forget the request. */
  private async gaveUp(id: string, code: "expired" | "abandoned"): Promise<SignRefused> {
    const answer = await this.cancel(id);
    const waited = `the wallet did not answer within ${Math.round(this.timeoutMs / 1000)} s`;
    if (!answer) {
      return new SignRefused(
        code,
        `${code === "expired" ? waited : "the payment stopped waiting"}; this wallet cannot cancel requests, so approving it there later still signs, but this payment will not be sent`,
        id,
      );
    }
    // Still being signed when the cancel landed is the same as signed and not yet collected: the wallet withholds it.
    if (answer.status === "signed" || answer.status === "approved") {
      if (answer.status === "signed" && answer.served) {
        return new SignRefused("unknown", "the owner approved just as the wait ended and the wallet had already handed the signature out; it may still pay: check `superstables status`", id);
      }
      return new SignRefused(code, "the owner approved just as the wait ended; the wallet withheld that signature, so nothing can be paid with it", id);
    }
    if (answer.status === "denied") return new SignRefused("denied", answer.reason ?? "the owner denied this payment in the wallet", id);
    if (answer.status === "rejected") return new SignRefused("invalid", answer.reason ?? "the wallet rejected the request", id);
    return new SignRefused(
      code,
      code === "expired"
        ? `${waited}; the request was cancelled in the wallet, so approving it there now signs nothing`
        : "the payment stopped waiting; the wallet request was cancelled",
      id,
    );
  }

  /** Tells the wallet this request is no longer wanted. Once per request; undefined when the wallet did not answer in kind (an older wallet, or none). */
  async cancel(id: string): Promise<WalletRequestView | undefined> {
    let done = this.cancels.get(id);
    if (!done) {
      done = walletRequest<WalletRequestView>(this.wire, "POST", `/requests/${encodeURIComponent(id)}/cancel`).catch(() => undefined);
      this.cancels.set(id, done);
    }
    return done;
  }

  /** Stops every wait this signer has open, cancelling its requests in the wallet. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.outstanding].map((id) => this.cancel(id)));
  }
}

/**
 * Whether an authorization the wallet returned is the one asked for: "" when it is, else the name of the field that is
 * not. The recipient, the amount and the payer are the request's own, the lifetime is the ten minutes a payment is signed
 * for, and the signature is the payer's over the token's own signing domain.
 */
async function resultProblem(req: Eip3009SignRequest, result: NonNullable<WalletRequestView["result"]>, nowMs: number): Promise<string> {
  if (result.kind !== "eip3009") return "kind";
  const { signature, authorization: auth } = result.payload ?? {};
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const requirements = req.requirements as typeof req.requirements & { maxAmountRequired?: string };
  if (!/^0x[0-9a-fA-F]{130}$/.test(text(signature))) return "signature";
  if (typeof result.signer !== "string") return "signer";
  const to = text(auth?.to);
  if (!to || !isSameAddress(to, String(requirements.payTo))) return "to";
  const from = text(auth?.from);
  if (!from || !isSameAddress(from, result.signer)) return "from";
  if (text(auth?.value) !== String(requirements.amount ?? requirements.maxAmountRequired)) return "value";
  if (!/^0x[0-9a-fA-F]{64}$/.test(text(auth?.nonce))) return "nonce";
  if (!/^\d{1,20}$/.test(text(auth?.validBefore)) || !/^\d{1,20}$/.test(text(auth?.validAfter))) return "validBefore";
  const validBefore = BigInt(text(auth?.validBefore)) * 1000n;
  if (validBefore <= BigInt(nowMs) || validBefore > BigInt(nowMs) + BigInt(MAX_SIGNED_LIFETIME_S + 30) * 1000n) return "validBefore";
  const network = evmNetworkFor(String(requirements.network ?? ""));
  if (!network) return "network";
  try {
    const genuine = await verifyTypedData({
      address: result.signer as `0x${string}`,
      domain: { name: network.usdc.eip712.name, version: network.usdc.eip712.version, chainId: network.chainId, verifyingContract: requirements.asset as `0x${string}` },
      types: { TransferWithAuthorization: authorizationTypes.TransferWithAuthorization },
      primaryType: "TransferWithAuthorization",
      message: {
        from: from as `0x${string}`,
        to: to as `0x${string}`,
        value: BigInt(text(auth?.value)),
        validAfter: BigInt(text(auth?.validAfter)),
        validBefore: BigInt(text(auth?.validBefore)),
        nonce: text(auth?.nonce) as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });
    return genuine ? "" : "signature";
  } catch {
    return "signature";
  }
}

/** What the wallet says about itself: address, network, balance, policy, pending requests. */
export async function walletStatus(options: WalletSignerOptions = {}): Promise<WalletStatus> {
  return walletRequest<WalletStatus>(wireFor(options), "GET", "/status");
}

/** Is the wallet answering? Used to tell an agent to start it before anything else. */
export async function isWalletUp(options: WalletSignerOptions = {}): Promise<boolean> {
  try {
    await walletStatus(options);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
