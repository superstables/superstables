// The agent side of signing. This signer holds no key and can approve nothing: it posts the
// seller's requirement to the owner's wallet on 127.0.0.1 and waits for a human decision.
// Every outcome that is not a signature is a refusal with a reason, never an exception the
// caller has to guess at — "the owner said no" is an answer, and the agent should say it.

import { readFileSync } from "node:fs";
import { agentTokenPath, walletUrl } from "../home.js";
import { evmNetworkFor, networkFor } from "../chain.js";
import type { WalletRequestView, WalletStatus } from "../types.js";
import { LOCAL_WALLET_EVM_ONLY, SignRefused, type Eip3009SignResult, type SignHooks, type SignRequest, type Signer } from "./types.js";

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
      try {
        return readFileSync(agentTokenPath(), "utf8").trim();
      } catch {
        return "";
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
  } catch {
    throw new SignRefused("unavailable", WALLET_DOWN);
  }
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    throw new SignRefused("unavailable", WALLET_DOWN);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new SignRefused("invalid", `the wallet refused the request (HTTP ${res.status})${text ? `: ${text}` : ""}`);
  }
  try {
    return (await res.json()) as T;
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
    let view = await walletRequest<WalletRequestView>(this.wire, "POST", "/requests", { sign: req });

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

    while (view.status !== "signed") {
      if (Date.now() >= deadline) {
        throw new SignRefused(
          "expired",
          `the wallet did not answer within ${Math.round(this.timeoutMs / 1000)} s`,
          view.id,
        );
      }
      await sleep(Math.max(0, Math.min(this.pollMs, deadline - Date.now())));
      view = await walletRequest<WalletRequestView>(
        this.wire,
        "GET",
        `/requests/${encodeURIComponent(view.id)}`,
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

    if (!view.result) {
      throw new SignRefused("invalid", "the wallet reported a signature but returned no payload", view.id);
    }
    return { kind: "eip3009", payload: view.result.payload, signer: view.result.signer };
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
