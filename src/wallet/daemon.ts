// The owner's wallet: a small HTTP server on 127.0.0.1 that holds the key and answers one
// question, "may this payment be signed?", with the owner in the loop.
//
// Three properties shape every line below.
//
//  1. The wallet trusts nothing the agent says about the payment. Everything the owner is
//     shown — amount, asset, network, recipient — is derived here, from the requirement that
//     will actually be signed, by the same termsFor() the payment core uses. The agent's own
//     description of the payment is kept apart, stored as `reported`, and labelled unverified
//     wherever it appears. An agent that lies about a payment can only lie about the label.
//  2. Asking and approving are different powers, so they are different credentials. The agent
//     token can create a request and read it back; it cannot reach any /owner route. The owner
//     secret lives in the approval page's URL fragment and never goes to an agent.
//  3. Nothing is signed without a fresh, explicit decision. Requests expire on their own, an
//     approval signs exactly the stored requirement once, and every state change is appended
//     to an audit log that never contains the key or the signature.

import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { PrivateKeyAccount } from "viem/accounts";
import { DEFAULT_NETWORK, fromAtomic, usdcBalance } from "../core/chain.js";
import { DEFAULT_WALLET_PORT, ensureDir, policyPath, walletDir } from "../core/home.js";
import { evaluatePolicy, formatMoney, loadPolicy, type Policy } from "../core/policy.js";
import { LocalKeySigner } from "../core/signer/local.js";
import type { SignRequest, SignResult } from "../core/signer/types.js";
import type {
  PaymentContext,
  VerifiedTerms,
  WalletRequestStatus,
  WalletRequestView,
  WalletStatus,
} from "../core/types.js";
import { termsFor, type RawAccept } from "../core/x402.js";
import { loadAccount, readOrCreateSecret } from "./keystore.js";
import { walletPage } from "./page.js";

/** The owner approves every payment in this release; there is no unattended mode. */
const APPROVAL_MODE = "ask-every-payment" as const;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** A balance is a nicety on the status page: never let a slow RPC hold up an answer. */
const BALANCE_TIMEOUT_MS = 5_000;
/** A sign request is a few hundred bytes; anything this large is not one. */
const MAX_BODY_BYTES = 256 * 1024;

export interface StartWalletOptions {
  /** 0 picks a free port (tests). Defaults to DEFAULT_WALLET_PORT. */
  port?: number;
  /** Where the key, the credentials and the audit log live. Defaults to walletDir(). */
  dir?: string;
  /** The owner's policy. Defaults to the policy file, or the built-in defaults. */
  policy?: Policy;
  /** The wallet's account. Defaults to the key in `dir`. */
  account?: PrivateKeyAccount;
  approvalTimeoutMs?: number;
  agentToken?: string;
  ownerSecret?: string;
  /** Print nothing at start. */
  quiet?: boolean;
  /** Open the approval page in the owner's browser. Default: true unless quiet or under test. */
  openBrowser?: boolean;
  /** Read the on-chain balance for GET /status. Default true; false keeps the wallet offline. */
  balance?: boolean;
}

export interface WalletHandle {
  port: number;
  url: string;
  agentToken: string;
  ownerSecret: string;
  /** The link the owner opens: the secret is in the fragment, so it never reaches the server. */
  ownerUrl: string;
  address: string;
  close(): Promise<void>;
}

interface WalletRequestRecord {
  id: string;
  status: WalletRequestStatus;
  createdAt: number;
  expiresAt: number;
  /** Derived here from the requirement, never from the agent. */
  verified: VerifiedTerms;
  /** What the agent said this payment is for. Shown as unverified, used for nothing but the policy's hostname. */
  reported?: PaymentContext;
  reason?: string;
  /** The seller's requirement verbatim: what an approval signs, byte for byte. */
  requirement?: PaymentRequirements;
  x402Version: 1 | 2;
  result?: SignResult;
}

type Caller = "agent" | "owner";

/** Constant-time comparison, so a wrong token cannot be found one character at a time. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Keeps only the context fields the wallet knows how to display, as short strings. The agent
 * chooses this content, so it is treated like any other untrusted input: bounded and copied,
 * never merged into anything the wallet derived itself.
 */
function sanitizeContext(input: unknown): PaymentContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 500) : undefined;
  const context: PaymentContext = {
    target: text(raw.target) ?? "",
    serviceId: text(raw.serviceId),
    serviceName: text(raw.serviceName),
    description: text(raw.description),
    quoteId: text(raw.quoteId),
    attemptId: text(raw.attemptId),
  };
  return context;
}

/** The hostname the policy judges: the URL the agent says it is calling, when it is a URL at all. */
function policyDomain(context?: PaymentContext): string {
  if (!context?.target) return "";
  try {
    const url = new URL(context.target);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : "";
  } catch {
    return "";
  }
}

export async function startWallet(options: StartWalletOptions = {}): Promise<WalletHandle> {
  const dir = ensureDir(options.dir ?? walletDir());
  const account = options.account ?? loadAccount(dir);
  const policy = options.policy ?? loadPolicy(policyPath());
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const quiet = options.quiet === true;
  const readBalance = options.balance !== false;
  const agentTokenFile = join(dir, "agent-token");
  const agentToken = options.agentToken ?? readOrCreateSecret(agentTokenFile);
  const ownerSecret = options.ownerSecret ?? readOrCreateSecret(join(dir, "owner-secret"));
  const auditPath = join(dir, "audit.jsonl");
  const signer = new LocalKeySigner(account);
  const requests = new Map<string, WalletRequestRecord>();

  // ── audit ────────────────────────────────────────────────────────────────────────────

  /** One line per state change. Never a key, never a signature: this file is for reading. */
  function audit(record: WalletRequestRecord): void {
    const line = {
      at: new Date().toISOString(),
      id: record.id,
      status: record.status,
      reason: record.reason,
      verified: record.verified,
      reported: record.reported,
    };
    try {
      appendFileSync(auditPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      // An unwritable audit file must not stop the owner from deciding; say so and carry on.
      if (!quiet) console.error(`wallet: could not write the audit log: ${(err as Error).message}`);
    }
  }

  /**
   * What this wallet has already signed today (UTC), per asset, read back from its own audit
   * log so a restart does not reset the day. Summed in atomic units: money is never added up
   * as floating point.
   */
  function spentTodayDecimal(asset: string): number {
    let total = 0n;
    let text: string;
    try {
      text = readFileSync(auditPath, "utf8");
    } catch {
      return 0;
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { at?: string; status?: string; verified?: VerifiedTerms };
        if (entry.status !== "signed" || !entry.verified) continue;
        if (!entry.at || entry.at.slice(0, 10) !== today) continue;
        if (entry.verified.asset.toUpperCase() !== asset.toUpperCase()) continue;
        total += BigInt(entry.verified.amountAtomic);
      } catch {
        // A truncated or hand-edited line is skipped rather than failing the payment path.
      }
    }
    // One asset, one network in this release: USDC's six decimals apply to every line above.
    return fromAtomic(total.toString(), DEFAULT_NETWORK.usdc.decimals);
  }

  // ── request lifecycle ────────────────────────────────────────────────────────────────

  function view(record: WalletRequestRecord, withResult: boolean): WalletRequestView {
    const out: WalletRequestView = {
      id: record.id,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      verified: record.verified,
      reported: record.reported,
      reason: record.reason,
    };
    if (withResult && record.result) out.result = record.result;
    return out;
  }

  /** Expiry is the wallet's own decision, not the agent's: nothing stays signable for ever. */
  function sweep(): void {
    const now = Date.now();
    for (const record of requests.values()) {
      if (record.status !== "pending" || record.expiresAt > now) continue;
      record.status = "expired";
      record.reason = `no answer from the owner within ${Math.round(approvalTimeoutMs / 1000)}s`;
      audit(record);
    }
  }

  const sweeper = setInterval(sweep, 1_000);
  // The wallet's own timer must never be the reason a process refuses to exit.
  sweeper.unref();

  function createRequest(sign: unknown): WalletRequestRecord {
    const id = randomUUID();
    const now = Date.now();
    const request = (sign ?? {}) as Partial<SignRequest>;
    const version: 1 | 2 = request.x402Version === 1 ? 1 : 2;
    const reported = sanitizeContext(request.context);
    // A rejected request still gets a record and an audit line: "nothing was signed" is a fact
    // the owner may want to see later, and the agent needs an id to talk about.
    const blank: VerifiedTerms = {
      amountDecimal: 0,
      amountAtomic: "0",
      asset: "",
      assetAddress: "",
      network: "",
      networkLabel: "",
      recipient: "",
      scheme: "",
      x402Version: version,
      payer: account.address,
    };
    const record: WalletRequestRecord = {
      id,
      status: "rejected",
      createdAt: now,
      expiresAt: now + approvalTimeoutMs,
      verified: blank,
      reported,
      x402Version: version,
    };
    requests.set(id, record);

    if (request.kind !== undefined && request.kind !== "eip3009") {
      record.reason = `this wallet signs eip3009 authorizations, not "${String(request.kind)}"`;
      audit(record);
      return record;
    }
    if (!request.requirements || typeof request.requirements !== "object") {
      record.reason = "the request carried no payment requirement to check";
      audit(record);
      return record;
    }

    // The single source of truth for what the owner is shown, and for what gets signed.
    const judged = termsFor(request.requirements as RawAccept, version);
    if (!judged.supported) {
      record.reason = judged.reason;
      audit(record);
      return record;
    }
    record.verified = { ...judged.terms, payer: account.address };
    record.requirement = judged.requirement;

    const verdict = evaluatePolicy(policy, {
      domain: policyDomain(reported),
      amountDecimal: judged.terms.amountDecimal,
      asset: judged.terms.asset,
      spentTodayDecimal: spentTodayDecimal(judged.terms.asset),
    });
    if (!verdict.allowed) {
      record.status = "denied";
      record.reason = verdict.reason;
      audit(record);
      return record;
    }

    record.status = "pending";
    record.reason = undefined;
    audit(record);
    return record;
  }

  async function approve(record: WalletRequestRecord): Promise<void> {
    record.status = "approved";
    audit(record);
    const result = await signer.sign({
      kind: "eip3009",
      // Exactly the requirement that was checked and shown, not a rebuilt one.
      requirements: record.requirement as PaymentRequirements,
      x402Version: record.x402Version,
    });
    record.result = result;
    record.status = "signed";
    audit(record);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────

  function send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("the request body is too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function balanceDecimal(): Promise<number | undefined> {
    if (!readBalance) return undefined;
    try {
      return await Promise.race([
        usdcBalance(account.address),
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

  async function status(): Promise<WalletStatus> {
    sweep();
    return {
      address: account.address,
      network: DEFAULT_NETWORK.caip2,
      networkLabel: DEFAULT_NETWORK.label,
      asset: "USDC",
      balanceDecimal: await balanceDecimal(),
      approvalMode: APPROVAL_MODE,
      pending: [...requests.values()].filter((r) => r.status === "pending").length,
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    // The approval page itself carries no secret: the owner's fragment stays in the browser.
    if (method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(walletPage());
      return;
    }

    const token = bearer(req);
    let caller: Caller | undefined;
    if (token && secretEquals(token, ownerSecret)) caller = "owner";
    else if (token && secretEquals(token, agentToken)) caller = "agent";
    if (!caller) {
      send(res, 401, { error: "this wallet needs a bearer token: the agent token to ask, the owner secret to decide" });
      return;
    }
    const ownerOnly = path.startsWith("/owner/");
    if (ownerOnly && caller !== "owner") {
      send(res, 403, { error: "only the owner can approve or deny; an agent token cannot" });
      return;
    }

    // Expiry is checked on every request as well as on the timer, so a reader never sees a
    // pending request that has in fact run out of time.
    sweep();

    if (method === "GET" && path === "/status") {
      send(res, 200, await status());
      return;
    }
    if (method === "GET" && path === "/address") {
      send(res, 200, { address: account.address, network: DEFAULT_NETWORK.caip2 });
      return;
    }
    if (method === "POST" && path === "/requests") {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch {
        send(res, 400, { error: "the request body is not JSON" });
        return;
      }
      const sign = (body as { sign?: unknown })?.sign;
      const record = createRequest(sign);
      send(res, 200, view(record, false));
      return;
    }
    if (method === "GET" && path === "/owner/requests") {
      const list = [...requests.values()]
        .sort((a, b) => a.createdAt - b.createdAt)
        // The owner's list is a list, not a place to hand out signatures.
        .map((record) => view(record, false));
      send(res, 200, { requests: list });
      return;
    }

    const single = /^\/requests\/([^/]+)$/.exec(path);
    if (method === "GET" && single) {
      const record = requests.get(decodeURIComponent(single[1]));
      if (!record) {
        send(res, 404, { error: "no such request" });
        return;
      }
      send(res, 200, view(record, true));
      return;
    }

    const decision = /^\/owner\/requests\/([^/]+)\/(approve|deny)$/.exec(path);
    if (method === "POST" && decision) {
      const record = requests.get(decodeURIComponent(decision[1]));
      if (!record) {
        send(res, 404, { error: "no such request" });
        return;
      }
      if (record.status !== "pending") {
        send(res, 409, { error: `this request is ${record.status}, so there is nothing to decide`, request: view(record, false) });
        return;
      }
      if (decision[2] === "deny") {
        record.status = "denied";
        record.reason = "denied by the owner in the wallet";
        audit(record);
        send(res, 200, view(record, false));
        return;
      }
      try {
        await approve(record);
      } catch (err) {
        record.status = "rejected";
        record.reason = `the wallet could not sign this request: ${(err as Error).message}`;
        audit(record);
        send(res, 500, view(record, false));
        return;
      }
      send(res, 200, view(record, false));
      return;
    }

    send(res, 404, { error: "no such route" });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      send(res, 500, { error: `the wallet could not handle that request: ${err.message}` });
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: this wallet is never reachable from another machine.
    server.listen(options.port ?? DEFAULT_WALLET_PORT, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const url = `http://127.0.0.1:${port}`;
  const ownerUrl = `${url}/#${ownerSecret}`;

  if (!quiet) {
    console.log(`Superstables wallet on ${url}`);
    console.log(`  address:        ${account.address}`);
    console.log(`  network:        ${DEFAULT_NETWORK.label}`);
    console.log(`  approval mode:  ask before every payment`);
    console.log(`  approve here:   ${ownerUrl}`);
    console.log(`  policy:         ${policySummary(policy)}`);
    console.log(`  agent token:    ${agentTokenFile}`);
  }

  const shouldOpen = options.openBrowser ?? (!quiet && !isUnderTest());
  if (shouldOpen) openInBrowser(ownerUrl);

  return {
    port,
    url,
    agentToken,
    ownerSecret,
    ownerUrl,
    address: account.address,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** One line the owner can check against what they meant to allow. */
export function policySummary(policy: Policy): string {
  if (policy.killSwitch) return "kill switch on: every payment is refused";
  const parts: string[] = [];
  if (policy.perCall) parts.push(`up to ${formatMoney(policy.perCall)} per payment`);
  if (policy.perDay) parts.push(`${formatMoney(policy.perDay)} per day`);
  if (policy.allow.length > 0) parts.push(`only ${policy.allow.join(", ")}`);
  if (policy.deny.length > 0) parts.push(`never ${policy.deny.join(", ")}`);
  return parts.length > 0 ? parts.join(", ") : "no caps set";
}

function isUnderTest(): boolean {
  return process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
}

/** Best effort, and only that: a browser that will not open is not a wallet failure. */
function openInBrowser(target: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(command, [target], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser, no display, no problem: the owner has the URL printed above.
  }
}
