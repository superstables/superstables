// Signing with a browser wallet. This is the default signer, and the reason the person who
// runs an agent has no process of their own to start: the agent's process serves one approval
// page on loopback, the link goes back to the agent as part of its tool result, and the owner
// signs in MetaMask (or any other window.ethereum wallet) on that page.
//
// Like every signer here, this one holds no key and can approve nothing. What it adds is the
// two checks that happen before a person is ever asked: the requirement must be one this
// client can pay at all (the rail's own judging, src/core/rails/), and the owner's own spend
// policy must allow it. Only then does an approval exist, and only then is there a link to
// open. What the wallet is then asked to do is the rail's: sign an EIP-3009 authorization
// (EVM), send a pathUSD transfer (Tempo), or sign a token transfer (Solana).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_NETWORK, networkFor, usdcBalance, type Rail } from "../chain.js";
import { browserWalletPath, ensureDir, homeDir, policyPath, recordsDir } from "../home.js";
import { evaluatePolicy, formatMoney, loadPolicy, type Policy } from "../policy.js";
import { Records } from "../records.js";
import { judgeSignRequest } from "../rails/index.js";
import type { VerifiedTerms, WalletStatus } from "../types.js";
import { ApprovalServer } from "./approval-server.js";
import { SignRefused, type Eip3009SignRequest, type Eip3009SignResult, type SignHooks, type SignRequest, type SignResult, type Signer } from "./types.js";

/** How long an approval page waits for the person before the request expires. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** A balance is a nicety on a status line; never let a slow RPC hold up an answer. */
const BALANCE_TIMEOUT_MS = 5_000;
/** The owner approves every payment in this release; there is no unattended mode. */
const APPROVAL_MODE = "ask-every-payment" as const;

export interface BrowserWalletSignerOptions {
  /**
   * A port somebody chose (SUPERSTABLES_APPROVE_PORT), kept as chosen even when it is busy; 0
   * picks a free port (tests). Leave it out for DEFAULT_APPROVE_PORT, or a free port when
   * another payment is already waiting on that one.
   */
  port?: number;
  /** The port to try first when none was chosen. Defaults to DEFAULT_APPROVE_PORT. */
  preferredPort?: number;
  /** How long the person has to open the link and sign. */
  timeoutMs?: number;
  /** The owner's policy. Defaults to the policy file, or the built-in defaults. */
  policy?: Policy;
  /** Where the audit log and the remembered account live. Defaults to SUPERSTABLES_HOME. */
  home?: string;
  /** Read the on-chain balance for status(). Default true; false keeps the signer offline. */
  balance?: boolean;
}

interface RememberedAccount {
  address: string;
  connectedAt: string;
  /** The Solana account, when one has paid here: a Solana wallet is a different account from the EVM one above. */
  solana?: { address: string; connectedAt: string };
}

/** Which remembered account pays on a rail: the EVM one on EVM chains and Tempo, the Solana one on Solana. */
const accountKind = (rail: Rail): "evm" | "solana" => (rail === "solana" ? "solana" : "evm");

export class BrowserWalletSigner implements Signer {
  readonly kind = "browser" as const;

  get approvalWindowMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private readonly options: BrowserWalletSignerOptions;
  private readonly server: ApprovalServer;
  private readonly home: string;
  private readonly records: Records;
  private remembered?: RememberedAccount;

  constructor(options: BrowserWalletSignerOptions = {}) {
    this.options = options;
    this.home = options.home ?? homeDir();
    const dir = options.home ? join(options.home, "records") : recordsDir();
    this.records = new Records(dir);
    this.server = new ApprovalServer({
      port: options.port,
      preferredPort: options.preferredPort,
      recordsDirPath: dir,
      onAccount: (address, network) => this.remember(address, network),
    });
    this.remembered = this.readRemembered();
  }

  /** Where the approval pages live. Empty until the server has been started. */
  get url(): string {
    return this.server.port === 0 ? "" : this.server.url;
  }

  /** The default port, when it was busy and the page took a free one instead. */
  get movedFrom(): number | undefined {
    return this.server.movedFrom;
  }

  /** Bind the approval server. Called for you on the first sign(); safe to call twice. */
  async start(): Promise<void> {
    await this.server.start();
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  /**
   * The account that would pay: the last one a browser wallet connected with. There is no way
   * to know before someone has connected one, and pretending otherwise would name the wrong
   * payer on a quote.
   */
  async address(network: string): Promise<string> {
    const known = network ? networkFor(network) : DEFAULT_NETWORK;
    if (!known) throw new Error(`no identity on ${network}`);
    const address = this.rememberedOn(known.rail);
    if (!address) {
      throw new Error("no browser wallet connected yet: the account is chosen when you open the approval link");
    }
    return address;
  }

  /** The account a browser wallet last paid with on this rail. */
  private rememberedOn(rail: Rail): string | undefined {
    const remembered = this.remembered ?? this.readRemembered();
    return accountKind(rail) === "solana" ? remembered?.solana?.address : remembered?.address;
  }

  /** What this signer says about itself. It never throws: there is nothing here to be down. */
  async status(): Promise<WalletStatus> {
    const policy = this.policy();
    const address = this.rememberedOn("evm") || undefined;
    return {
      mode: "browser",
      address,
      network: DEFAULT_NETWORK.caip2,
      networkLabel: DEFAULT_NETWORK.label,
      asset: "USDC",
      balanceDecimal: address ? await this.balanceOf(address) : undefined,
      approvalMode: APPROVAL_MODE,
      pending: this.server.pending,
      policy: {
        perCall: formatMoney(policy.perCall),
        perDay: formatMoney(policy.perDay),
        allow: policy.allow,
        deny: policy.deny,
        stablecoins: policy.stablecoins,
        killSwitch: policy.killSwitch,
      },
    };
  }

  /**
   * Ask the owner to sign one payment in their browser wallet. Returns only once they have;
   * every other ending is a SignRefused carrying the reason, because "they said no" and "the
   * policy would not allow it" are answers an agent should repeat, not errors to guess at.
   */
  sign(req: Eip3009SignRequest, hooks?: SignHooks): Promise<Eip3009SignResult>;
  sign(req: SignRequest, hooks?: SignHooks): Promise<SignResult>;
  async sign(req: SignRequest, hooks?: SignHooks): Promise<SignResult> {
    // The single source of truth for what the page shows and for what the wallet is asked: the rail's own judging of
    // the seller's requirement, never the caller's account of it.
    const judged = judgeSignRequest(req);
    if (!judged.supported) throw new SignRefused("invalid", judged.reason);
    const { terms, requirement } = judged.offer;
    const network = networkFor(terms.network);
    if (!network) throw new SignRefused("invalid", `${terms.networkLabel} is not a chain this client knows`);

    const policy = this.policy();
    const verdict = evaluatePolicy(policy, {
      domain: policyDomain(req.context?.target),
      amountDecimal: terms.amountDecimal,
      asset: terms.asset,
      // What this machine has already paid today, from its own receipts: the per-day cap is
      // checked again here, at the gate, and not only when the quote was taken.
      // The attempt being signed has already reserved its amount (pay.ts): it is left out, so it does not count twice.
      spentTodayDecimal: this.records.spentToday(terms.asset, new Date(), { exclude: req.context?.attemptId }),
    });
    // A payment the owner's policy refuses never becomes an approval: nobody is asked, and
    // there is no link to open.
    if (!verdict.allowed) {
      throw new SignRefused("policy", verdict.reason ?? "the owner's spend policy refuses this payment");
    }

    try {
      await this.start();
    } catch (err) {
      // Nobody has been asked and there is no link: a refusal the caller can act on, not a
      // crash, and one that leaves the quote usable.
      throw new SignRefused("approval_page", err instanceof Error ? err.message : String(err));
    }
    // Last word before the page exists: the page's start may have taken long enough for the caller's cap reservation
    // to lapse (pay.ts renews it, or refuses).
    await hooks?.beforeAsk?.();
    const verified: VerifiedTerms = { ...terms, payer: this.rememberedOn(network.rail) ?? "" };
    const approval = this.server.request({
      kind: req.kind,
      verified,
      reported: req.context,
      requirement,
      x402Version: req.kind === "eip3009" && req.x402Version === 1 ? 1 : 2,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(hooks?.beforeWalletSends ? { beforeWalletSends: hooks.beforeWalletSends } : {}),
    });
    hooks?.onPending?.(approval.id, approval.url);

    const outcome = await approval.settled;
    if (outcome.status === "signed") return outcome.result;
    if (outcome.status === "refused") throw new SignRefused(outcome.code, outcome.reason, approval.id);
    if (outcome.status === "unknown") throw new SignRefused("unknown", outcome.reason, approval.id);
    if (outcome.status === "expired") throw new SignRefused("expired", outcome.reason, approval.id);
    if (outcome.status === "abandoned") throw new SignRefused("abandoned", outcome.reason, approval.id);
    throw new SignRefused("denied", outcome.reason, approval.id);
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────────────

  /** Read late: the owner may have edited their policy since this signer was built. */
  private policy(): Policy {
    return this.options.policy ?? loadPolicy(policyPath());
  }

  private async balanceOf(address: string): Promise<number | undefined> {
    if (this.options.balance === false) return undefined;
    try {
      return await Promise.race([
        usdcBalance(address),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), BALANCE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch {
      // A balance the RPC would not give is simply not shown; it is never a reason to fail.
      return undefined;
    }
  }

  private readRemembered(): RememberedAccount | undefined {
    try {
      const parsed = JSON.parse(readFileSync(browserWalletPath(this.home), "utf8")) as RememberedAccount;
      return typeof parsed?.address === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** The account is a name, not a secret — but it is still nobody else's business. */
  private remember(address: string, network: string): void {
    const rail = networkFor(network)?.rail ?? "evm";
    const now = new Date().toISOString();
    const previous = this.remembered ?? this.readRemembered();
    const record: RememberedAccount =
      accountKind(rail) === "solana"
        ? { address: previous?.address ?? "", connectedAt: previous?.connectedAt ?? now, solana: { address, connectedAt: now } }
        : { address, connectedAt: now, ...(previous?.solana ? { solana: previous.solana } : {}) };
    this.remembered = record;
    try {
      ensureDir(this.home);
      writeFileSync(browserWalletPath(this.home), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Remembering is a convenience: a home directory that will not take it changes nothing.
    }
  }
}

/** The hostname the policy judges: the URL the agent says it is calling, when it is a URL. */
function policyDomain(target?: string): string {
  if (!target) return "";
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : "";
  } catch {
    return "";
  }
}
