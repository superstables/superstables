// The owner's wallet: a small HTTP server that holds the key and answers one question, "may this payment be signed?",
// with the owner in the loop. The agent asks on a socket in the wallet's private folder; the owner's page is on
// 127.0.0.1.
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
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { PrivateKeyAccount } from "viem/accounts";
import { DEFAULT_NETWORK, evmNetworkFor, isSameAddress, networkFor, usdcBalance } from "../core/chain.js";
import { DEFAULT_WALLET_PORT, accountPolicyPath, ensureDir, policyPath, retiredListPath, walletDir, walletSocketPath } from "../core/home.js";
import {
  SIGN_COMMAND, readOwnerSettings, settingsPayload, settingsSignedAt, settingsTypedData, signatureRecord,
  requirePolicyFile, signedBy, signedPolicyCheck, signedSettings, writeOwnerSettings,
} from "../core/owner-settings.js";
import { capUnit, capUnits, evaluatePolicy, formatMoney, loadPaymentPolicy, policyAmount, type Policy, type Verdict } from "../core/policy.js";
import { syncDirectory } from "../core/private-dir.mjs";
import { LocalKeySigner } from "../core/signer/local.js";
import { LOCAL_WALLET_EVM_ONLY, type Eip3009SignRequest, type Eip3009SignResult } from "../core/signer/types.js";
import type {
  PaymentContext,
  VerifiedTerms,
  WalletRequestStatus,
  WalletRequestView,
  WalletStatus,
} from "../core/types.js";
import { termsFor, type RawAccept } from "../core/x402.js";
import { untrustedText } from "../core/text.js";
import { spentTodayFromAudit } from "./audit-total.js";
import { loadAccount, readOrCreateSecret, writeAllSync } from "./keystore.js";
import { pageCsp, scriptNonce } from "../core/signer/look.js";
import { signedLifetime } from "../core/rails/evm.js";
import { walletPage } from "./page.js";

/** The owner approves every payment in this release; there is no unattended mode. */
const APPROVAL_MODE = "ask-every-payment" as const;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** A balance is a nicety on the status page: never let a slow RPC hold up an answer. */
const BALANCE_TIMEOUT_MS = 5_000;
/** A sign request is a few hundred bytes; anything this large is not one. */
const MAX_BODY_BYTES = 256 * 1024;
/** Payment requests that may wait for the owner at once. */
const MAX_PENDING = 3;
/** How long after the client's own deadline the wallet still hands out a signature (a poll in flight, a slow loopback). */
const RESULT_GRACE_MS = 15_000;
/** The audit log is read whole on every request; a file past this is not one the wallet wrote. */
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;
/** The wait a client may announce for its request. */
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 3_600_000;

export interface StartWalletOptions {
  /** The TCP port of the owner's page: 0 picks a free port (tests). Defaults to DEFAULT_WALLET_PORT. */
  port?: number;
  /**
   * Also answer the agent's routes on the TCP port (`wallet serve --tcp`), for an agent that reaches the wallet over SSH
   * forwarding. Without it they are on the socket only. Windows has no socket, so there they are always on TCP.
   */
  tcp?: boolean;
  /** The agent's socket. Defaults to agent.sock in `dir` (walletSocketPath). */
  socketPath?: string;
  /** Where the key, the credentials and the audit log live. Defaults to walletDir(). */
  dir?: string;
  /**
   * A fixed policy, for tests and library callers: when set, no file is read. Otherwise the wallet reads the policy files
   * again whenever it judges a request (see policyFile and accountPolicyFile).
   */
  policy?: Policy;
  /** The selected policy file. Defaults to policyPath() (SUPERSTABLES_POLICY, or policy.yaml in the home folder). */
  policyFile?: string;
  /** The account's own policy file, which applies as well. Defaults to accountPolicyPath(). */
  accountPolicyFile?: string;
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
  /** How a file is opened in the owner's browser. Defaults to open / xdg-open / start; tests pass their own. */
  opener?: (target: string) => void;
  /** The folder for the page launcher. Default `~/Superstables-wallet-open` (see defaultLauncherDir). */
  launcherDir?: string;
  /** Tests only: file operations the launcher uses, to simulate failures. */
  launcherIo?: LauncherIo;
  /** Tests only: how long after a client's wait a signature is still handed out. Default 15 s. */
  resultGraceMs?: number;
  /** Tests only: file operations the audit log uses, to simulate failures. */
  auditIo?: AuditIo;
}

/** File operations the audit log uses; tests replace them to simulate failures. */
export interface AuditIo {
  openSync?: typeof openSync;
  writeSync?: typeof writeSync;
  fsyncSync?: typeof fsyncSync;
}

export interface WalletHandle {
  port: number;
  url: string;
  /** The socket the agent's routes are on; undefined on Windows, where they are on TCP. */
  socketPath?: string;
  agentToken: string;
  ownerSecret: string;
  /** The link the owner opens: the secret is in the fragment, so it never reaches the server. Never printed. */
  ownerUrl: string;
  /**
   * The launcher file that opens `ownerUrl` in a browser (mode 0600), or undefined when none was written. Deleted
   * when the wallet stops.
   */
  launcherPath?: string;
  address: string;
  close(): Promise<void>;
}

interface WalletRequestRecord {
  id: string;
  status: WalletRequestStatus;
  /** An approval of this request has begun: no other one starts. Set once, never cleared. */
  deciding?: boolean;
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
  result?: Eip3009SignResult;
  /** The latest time (ms) a signature is handed out: the client's wait plus a short grace. */
  serveUntil: number;
  /** The wallet will not hand out this signature: the client stopped waiting for it. */
  withheld?: boolean;
  /** The signature was handed to the agent token. */
  served?: boolean;
  /** The decimals of the token of verified.network: what the amount is counted in. 6 for a blank record. */
  decimals: number;
}

/** The wallet cannot do what it was asked to without breaking its own rules: the caller may ask again later. */
class WalletUnavailable extends Error {}
/** The policy as it reads now refuses an approval. */
class PolicyNow extends Error {}

type Caller = "agent" | "owner";
/** Which of the wallet's two listeners a request came in on: the agent's socket, or the TCP port of the owner's page. */
type Listener = "socket" | "tcp";

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
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const quiet = options.quiet === true;
  const readBalance = options.balance !== false;
  const agentTokenFile = join(dir, "agent-token");
  const agentToken = options.agentToken ?? readOrCreateSecret(agentTokenFile);
  const ownerSecret = options.ownerSecret ?? readOrCreateSecret(join(dir, "owner-secret"));
  const auditPath = join(dir, "audit.jsonl");
  const signer = new LocalKeySigner(account);
  const requests = new Map<string, WalletRequestRecord>();

  /**
   * The policy to judge by, read from its files every time it is needed: what counts is the policy at the moment of
   * signing, not the one the wallet started with. The selected file and, when it is another file, the account's own.
   * Throws when a file cannot be used, which refuses.
   */
  function currentPolicy(): Policy {
    if (options.policy) return options.policy;
    return loadPaymentPolicy(options.policyFile ?? policyPath(), options.accountPolicyFile ?? accountPolicyPath());
  }

  // ── audit ────────────────────────────────────────────────────────────────────────────

  let auditSynced = false;

  /**
   * One line per state change, written in full and flushed. Never a key, never a signature: this file is for reading.
   * Throws when the line is not safely on disk: a state the wallet cannot record is a state it does not enter.
   */
  function audit(record: WalletRequestRecord): void {
    const line = {
      at: new Date().toISOString(),
      id: record.id,
      status: record.status,
      reason: record.reason,
      verified: record.verified,
      reported: record.reported,
    };
    const io = options.auditIo ?? {};
    let fd: number | undefined;
    try {
      // Never a symlink, and never waited on: a FIFO in this place must not stop the wallet.
      fd = (io.openSync ?? openSync)(auditPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
      if (!fstatSync(fd).isFile()) throw new Error("the audit log is not a regular file");
      writeAllSync(fd, `${JSON.stringify(line)}\n`, io.writeSync);
      (io.fsyncSync ?? fsyncSync)(fd);
      if (!auditSynced) {
        syncDirectory(dir);
        auditSynced = true;
      }
    } catch (err) {
      throw new Error(`the wallet could not write its audit log ${auditPath} (${(err as Error).message}); nothing was asked or signed`, { cause: err });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** The line for a state that makes nothing signable (a refusal, an expiry): if it cannot be written, say so and carry on. */
  function tryAudit(record: WalletRequestRecord): void {
    try {
      audit(record);
    } catch (err) {
      if (!quiet) console.error(`wallet: ${(err as Error).message}`);
    }
  }

  /** The audit log's text; "" when there is none yet. Throws for anything that is not a regular file the wallet can read. */
  function readAuditText(): string {
    let fd: number;
    try {
      fd = openSync(auditPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error("it is not a regular file");
      if (st.size > MAX_AUDIT_BYTES) throw new Error("it is too large to read");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  /**
   * What this wallet has authorised today (UTC) in `asset`'s cap unit, in millionths: the audit log's approved and signed
   * requests, read back so a restart does not reset the day, and every request still waiting for the owner, which the
   * owner may approve any moment. `exclude` is the request being judged. Whole numbers only: money is never added up as
   * floating point. Throws when the total cannot be known, which refuses.
   */
  function spentTodayAtomic(asset: string, exclude?: string): bigint {
    let text: string;
    try {
      text = readAuditText();
    } catch (err) {
      throw new Error(`today's spending cannot be read from the audit log (${(err as Error).message}); until it is fixed nothing is signed`);
    }
    const today = new Date().toISOString().slice(0, 10);
    const counted = spentTodayFromAudit(text, asset, today, (caip2) => networkFor(caip2)?.token.decimals);
    if ("problem" in counted) {
      throw new Error(`today's spending cannot be read from the audit log (${counted.problem}); until it is fixed nothing is signed`);
    }
    let total = counted.total;
    for (const r of requests.values()) {
      if (r.status !== "pending" || r.id === exclude || capUnit(r.verified.asset) !== capUnit(asset)) continue;
      total += capUnits(BigInt(r.verified.amountAtomic), r.decimals);
    }
    return total;
  }

  /** The policy's verdict on a verified payment as the policy and the log read now. A policy or a log that cannot be read refuses. */
  function verdictFor(record: WalletRequestRecord, terms: VerifiedTerms): Verdict {
    try {
      return evaluatePolicy(currentPolicy(), {
        domain: policyDomain(record.reported),
        asset: terms.asset,
        ...policyAmount(terms),
        spentTodayAtomic: spentTodayAtomic(terms.asset, record.id),
      });
    } catch (err) {
      return { allowed: false, reason: (err as Error).message };
    }
  }

  // ── request lifecycle ────────────────────────────────────────────────────────────────

  function view(record: WalletRequestRecord, withResult: boolean, forCancel = false): WalletRequestView {
    const out: WalletRequestView = {
      id: record.id,
      status: record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      verified: record.verified,
      reported: record.reported,
      reason: record.reason,
    };
    if (record.requirement) out.validForSeconds = signedLifetime((record.requirement as { maxTimeoutSeconds?: unknown }).maxTimeoutSeconds);
    if (withResult && record.result) out.result = record.result;
    if (record.withheld) out.withheld = true;
    if (forCancel) out.served = record.served === true;
    return out;
  }

  /** Expiry is the wallet's own decision, not the agent's: nothing stays signable for ever. */
  function sweep(): void {
    const now = Date.now();
    for (const record of requests.values()) {
      if (record.status !== "pending" || record.expiresAt > now) continue;
      record.status = "expired";
      record.reason = record.expiresAt < record.createdAt + approvalTimeoutMs
        ? "the client's wait ended before the owner answered; nothing was signed"
        : `no answer from the owner within ${Math.round(approvalTimeoutMs / 1000)}s`;
      // an expiry happens in memory whatever the log says: a request that expires without a line was never counted
      tryAudit(record);
    }
  }

  const sweeper = setInterval(sweep, 1_000);
  // The wallet's own timer must never be the reason a process refuses to exit.
  sweeper.unref();

  function createRequest(sign: unknown, waitMs: number | undefined): WalletRequestRecord {
    const id = randomUUID();
    const now = Date.now();
    // The client says how long it will wait; a client that says nothing is waiting for the wallet's own window.
    const deadline = waitMs === undefined ? undefined : now + waitMs;
    const expiresAt = Math.min(now + approvalTimeoutMs, deadline ?? Infinity);
    const request = (sign ?? {}) as Partial<Eip3009SignRequest> & { kind?: string };
    // Only the two wire versions there are; anything else is refused below, never read as version 2.
    const named: unknown = request.x402Version;
    const version: 1 | 2 = named === 1 ? 1 : 2;
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
      expiresAt,
      serveUntil: (deadline ?? expiresAt) + (options.resultGraceMs ?? RESULT_GRACE_MS),
      verified: blank,
      reported,
      x402Version: version,
      decimals: DEFAULT_NETWORK.usdc.decimals,
    };
    requests.set(id, record);

    if (request.kind !== undefined && request.kind !== "eip3009") {
      record.reason = request.kind === "tempo-transfer" || request.kind === "solana-transaction"
        ? LOCAL_WALLET_EVM_ONLY
        : `this wallet signs eip3009 authorizations, not "${String(request.kind)}"`;
      tryAudit(record);
      return record;
    }
    if (named !== 1 && named !== 2) {
      record.reason = `x402 version ${untrustedText(String(named), 20)} is not supported (only 1 and 2)`;
      tryAudit(record);
      return record;
    }
    if (!request.requirements || typeof request.requirements !== "object") {
      record.reason = "the request carried no payment requirement to check";
      tryAudit(record);
      return record;
    }

    // The single source of truth for what the owner is shown, and for what gets signed.
    const judged = termsFor(request.requirements as RawAccept, version);
    if (!judged.supported) {
      record.reason = judged.reason;
      tryAudit(record);
      return record;
    }
    // One EVM key: an x402 payment on any other rail is approved in a browser wallet instead.
    if (!evmNetworkFor(judged.terms.network)) {
      record.reason = LOCAL_WALLET_EVM_ONLY;
      tryAudit(record);
      return record;
    }
    record.verified = { ...judged.terms, payer: account.address };
    record.requirement = judged.requirement;
    record.decimals = policyAmount(judged.terms).decimals ?? DEFAULT_NETWORK.usdc.decimals;
    // The recipient is never the account paying: the transfer would move nothing, yet the payment would count as paid.
    if (isSameAddress(judged.terms.recipient, account.address)) {
      record.reason = "the recipient is this wallet's own address, so this payment was refused; nothing was signed";
      tryAudit(record);
      return record;
    }

    const verdict = verdictFor(record, record.verified);
    if (!verdict.allowed) {
      record.status = "denied";
      record.reason = verdict.reason;
      tryAudit(record);
      return record;
    }

    record.status = "pending";
    record.reason = undefined;
    // Nothing waits for the owner without its line on disk: the line is what makes it count toward the day.
    try {
      audit(record);
    } catch (err) {
      requests.delete(record.id);
      throw new WalletUnavailable((err as Error).message);
    }
    return record;
  }

  /** What went wrong underneath a failed audit write, without audit()'s own "nothing was asked or signed". */
  function auditDetail(err: unknown): string {
    const cause = (err as Error).cause;
    return cause instanceof Error ? cause.message : (err as Error).message;
  }

  /** The files the owner's signed settings cover, as this wallet reads them (its account policy file may be set by a test). */
  const settingsFiles = () => ({ policyPath: options.accountPolicyFile ?? accountPolicyPath(), retiredPath: retiredListPath() });

  async function approve(record: WalletRequestRecord): Promise<void> {
    // Taken before the first await: a second approval of the same request (a double click) finds it deciding and stops, so one
    // request is signed once however the answers interleave.
    if (record.status !== "pending" || record.deciding) throw new PolicyNow(`this request is ${record.deciding && record.status === "pending" ? "already being decided" : record.status}, so there is nothing to decide`);
    record.deciding = true;
    // The owner's settings, when this wallet's own key signed them, cover the account's spend policy file: a policy that
    // differs from the signed one is not signed for until the owner signs again. Settings another wallet signed do not count.
    const signedPolicy = await signedPolicyCheck(account.address, settingsFiles());
    // The owner may have denied it, or the agent cancelled, while the signature was being checked: that answer stands.
    if (record.status !== "pending") throw new PolicyNow(`this request is ${record.status}, so there is nothing to decide`);
    if (signedPolicy.warn && !quiet) console.error(`wallet: warning: ${signedPolicy.warn}`);
    if (signedPolicy.refuse) {
      record.status = "rejected";
      record.reason = signedPolicy.refuse;
      tryAudit(record);
      throw new PolicyNow(record.reason);
    }
    // The policy as it reads now, and the day as the log and the other waiting requests make it: not what they were when
    // the request arrived.
    const verdict = verdictFor(record, record.verified);
    if (!verdict.allowed) {
      record.status = "rejected";
      record.reason = `the spend policy now refuses this payment: ${verdict.reason}`;
      tryAudit(record);
      throw new PolicyNow(record.reason);
    }
    // The decision is on disk, and counted, before anything is signed.
    record.status = "approved";
    try {
      audit(record);
    } catch (err) {
      record.status = "rejected";
      record.reason = "the wallet could not write its audit log, so it did not sign";
      throw new WalletUnavailable(`${record.reason} (${auditDetail(err)})`);
    }
    const result = await signer.sign({
      kind: "eip3009",
      // Exactly the requirement that was checked and shown, not a rebuilt one.
      requirements: record.requirement as PaymentRequirements,
      x402Version: record.x402Version,
    });
    record.result = result;
    record.status = "signed";
    try {
      audit(record);
    } catch (err) {
      // A signature the wallet cannot record is one it did not give. The approved line already on disk keeps the amount
      // counted, so nothing is written over it.
      record.result = undefined;
      record.status = "rejected";
      record.reason = "the wallet signed, but could not record it in its audit log, so the signature was discarded; nothing can be paid with it";
      if (!quiet) console.error(`wallet: ${(err as Error).message}`);
      throw new WalletUnavailable(`${record.reason} (${auditDetail(err)})`);
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────

  const CHANGED_REQUEST = "the request changed or is not the one you confirmed; nothing was signed";

  /** The JSON the owner's page posts with an approval; undefined when there is none or it is not JSON. */
  async function readConfirmation(req: IncomingMessage): Promise<unknown> {
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return undefined;
    try {
      return JSON.parse((await readBody(req)) || "null");
    } catch {
      return undefined;
    }
  }

  /** True when the owner confirmed exactly this request's amount, recipient and chain. */
  function confirmedByOwner(record: WalletRequestRecord, body: unknown): boolean {
    if (typeof body !== "object" || body === null) return false;
    const { amountAtomic, recipient, network } = body as Record<string, unknown>;
    const terms = record.verified;
    return (
      typeof amountAtomic === "string" && amountAtomic === terms.amountAtomic &&
      typeof recipient === "string" && isSameAddress(recipient, terms.recipient) &&
      typeof network === "string" && network === terms.network
    );
  }

  const TOO_MANY_PENDING = "three payment requests are already waiting for the owner; nothing was asked. Wait for the owner to decide one, then ask again";
  const tooManyPending = (): boolean => [...requests.values()].filter((r) => r.status === "pending").length >= MAX_PENDING;

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

  /** The file the wallet reads its policy from, when it reads one and the file is there; the page names it. */
  function selectedPolicyFile(): string | undefined {
    if (options.policy) return undefined;
    const file = options.policyFile ?? policyPath();
    return existsSync(file) ? file : undefined;
  }

  function shape(p: Policy): WalletStatus["policy"] {
    return {
      perCall: formatMoney(p.perCall),
      perDay: formatMoney(p.perDay),
      allow: p.allow,
      deny: p.deny,
      stablecoins: p.stablecoins,
      killSwitch: p.killSwitch,
    };
  }

  async function status(): Promise<WalletStatus> {
    sweep();
    let policy: Policy | undefined;
    let policyProblem: string | undefined;
    try {
      policy = currentPolicy();
    } catch (err) {
      policyProblem = (err as Error).message;
    }
    return {
      address: account.address,
      network: DEFAULT_NETWORK.caip2,
      networkLabel: DEFAULT_NETWORK.label,
      asset: "USDC",
      balanceDecimal: await balanceDecimal(),
      approvalMode: APPROVAL_MODE,
      pending: [...requests.values()].filter((r) => r.status === "pending").length,
      // With no usable policy nothing is signed, which is what a kill switch shows.
      policy: policy ? { ...shape(policy), file: selectedPolicyFile() } : { allow: [], deny: [], stablecoins: [], killSwitch: true },
      also: policy?.also ? { file: policy.also.file, policy: shape(policy.also.policy) } : undefined,
      policyProblem,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, listener: Listener): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    // The socket is the agent's: only this user can connect to it, so its Host header means nothing, and the owner's
    // page and routes are not on it.
    if (listener === "socket" && (path === "/" || path.startsWith("/owner/"))) {
      send(res, 404, { error: "no such route" });
      return;
    }

    // Answer only to the host this server is bound to, as the two approval servers do. Without it a web
    // page under a DNS name resolving to 127.0.0.1 can reach this one, which is the page that approves
    // payments outright: under `--wallet local` there is no wallet prompt to contradict what it shows.
    const host = String(req.headers.host ?? "");
    if (listener === "tcp" && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("This wallet answers to its own host only.\n");
      return;
    }
    // A web page can make the browser send a request here, with an Origin of its own. This wallet answers to its own page
    // only; callers that are not browsers send no Origin at all.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      send(res, 403, { error: "this wallet answers to its own page only" });
      return;
    }

    // The approval page itself carries no secret: the owner's fragment stays in the browser.
    if (method === "GET" && path === "/") {
      const nonce = scriptNonce();
      const proof = url.searchParams.get("proof");
      res.writeHead(200, {
        ...(proof && /^[0-9a-f]{16,128}$/.test(proof) ? { [PROOF_HEADER]: walletProof(ownerSecret, port, proof) } : {}),
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // this page decides money, so it is not framed and not embedded
        "x-frame-options": "DENY",
        // only the page's own script runs
        "content-security-policy": pageCsp(nonce),
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      res.end(walletPage(undefined, nonce));
      return;
    }

    const token = bearer(req);
    let caller: Caller | undefined;
    // the socket knows the agent token only
    if (listener === "tcp" && token && secretEquals(token, ownerSecret)) {
      caller = "owner";
    }
    else if (token && secretEquals(token, agentToken)) caller = "agent";
    if (!caller) {
      send(res, 401, { error: "this wallet needs a bearer token: the agent token to ask, the owner secret to decide" });
      return;
    }
    // Any process on this machine can reach the TCP port; the agent token is good only on the socket, which only this
    // user can, unless the owner opened TCP to it.
    if (caller === "agent" && listener === "tcp" && !agentOnTcp) {
      send(res, 403, { error: "agent routes are on the wallet's private socket; start the wallet with --tcp to allow them here" });
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
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        send(res, 415, { error: "the request body must be JSON (content-type: application/json)" });
        return;
      }
      if (tooManyPending()) {
        send(res, 429, { error: TOO_MANY_PENDING });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch {
        send(res, 400, { error: "the request body is not JSON" });
        return;
      }
      const sign = (body as { sign?: unknown })?.sign;
      const waitMs = (body as { waitMs?: unknown })?.waitMs;
      if (waitMs !== undefined && (typeof waitMs !== "number" || !Number.isInteger(waitMs) || waitMs < MIN_WAIT_MS || waitMs > MAX_WAIT_MS)) {
        send(res, 400, { error: "waitMs must be a whole number of milliseconds from 1000 to 3600000" });
        return;
      }
      // Again, now that the body is here: others may have arrived while it was read. Nothing awaits from here to the
      // record being stored, so this check and the new request are one step.
      if (tooManyPending()) {
        send(res, 429, { error: TOO_MANY_PENDING });
        return;
      }
      try {
        send(res, 200, view(createRequest(sign, waitMs), false));
      } catch (err) {
        if (!(err instanceof WalletUnavailable)) throw err;
        send(res, 503, { error: err.message });
      }
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

    if (method === "GET" && path === "/owner/settings") {
      send(res, 200, await settingsView());
      return;
    }
    if (method === "POST" && path === "/owner/settings/sign") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        send(res, 415, { error: "the request body must be JSON (content-type: application/json)" });
        return;
      }
      let confirmed: unknown;
      try {
        confirmed = JSON.parse((await readBody(req)) || "null");
      } catch {
        send(res, 400, { error: "the request body is not JSON" });
        return;
      }
      const done = await signSettings(confirmed);
      send(res, done.status, done.body);
      return;
    }

    /** The id in a path, decoded; "" (no request) when its escapes are malformed. */
    const idOf = (raw: string): string => { try { return decodeURIComponent(raw); } catch { return ""; } };
    const single = /^\/requests\/([^/]+)$/.exec(path);
    if (method === "GET" && single) {
      const record = requests.get(idOf(single[1]));
      if (!record) {
        send(res, 404, { error: "no such request" });
        return;
      }
      // A signature is handed out until the client's wait ends (plus a short grace), and never after it cancelled.
      const servable = record.status === "signed" && !record.withheld && Date.now() <= record.serveUntil;
      if (servable && record.result) record.served = true;
      if (record.status === "signed" && !servable && !record.withheld) {
        record.withheld = true;
        record.reason ??= "the client stopped waiting before this signature was collected, so the wallet will not hand it out";
        tryAudit(record);
      }
      send(res, 200, view(record, servable));
      return;
    }

    const cancel = /^\/requests\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      const record = requests.get(idOf(cancel[1]));
      if (!record) {
        send(res, 404, { error: "no such request" });
        return;
      }
      if (record.status === "pending") {
        record.status = "expired";
        record.reason = "the client stopped waiting and cancelled this request; nothing was signed";
        tryAudit(record);
        send(res, 200, view(record, false, true));
        return;
      }
      if (record.status === "approved" || record.status === "signed") {
        // While it is being signed as much as after: approve() never clears this, and GET never serves a withheld one.
        record.withheld = true;
        record.reason = "the client stopped waiting; this signature is withheld and will not be handed out";
        tryAudit(record);
        send(res, 200, view(record, false, true));
        return;
      }
      send(res, 409, { error: `this request is ${record.status}, so there is nothing to cancel`, request: view(record, false) });
      return;
    }

    const decision = /^\/owner\/requests\/([^/]+)\/(approve|deny)$/.exec(path);
    if (method === "POST" && decision) {
      const record = requests.get(idOf(decision[1]));
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
        tryAudit(record);
        send(res, 200, view(record, false));
        return;
      }
      // The owner confirmed one payment: the amount, the recipient and the chain they saw. A request that is not that
      // one, or a call that says nothing, signs nothing.
      if (!confirmedByOwner(record, await readConfirmation(req))) {
        send(res, 409, { error: CHANGED_REQUEST, request: view(record, false) });
        return;
      }
      try {
        await approve(record);
      } catch (err) {
        if (err instanceof PolicyNow) {
          send(res, 409, { error: err.message, request: view(record, false) });
          return;
        }
        if (err instanceof WalletUnavailable) {
          send(res, 503, { error: err.message });
          return;
        }
        record.status = "rejected";
        record.reason = `the wallet could not sign this request: ${(err as Error).message}`;
        tryAudit(record);
        send(res, 500, view(record, false));
        return;
      }
      send(res, 200, view(record, false));
      return;
    }

    send(res, 404, { error: "no such route" });
  }

  // ── the owner's settings, signed with this wallet's own key ──────────────────────────────────────────────────────────

  /** What the settings card shows: whether the settings are signed, by whom, and what signing now would cover. */
  async function settingsView(): Promise<Record<string, unknown>> {
    const files = settingsFiles();
    let settings;
    try {
      settings = readOwnerSettings();
    } catch (err) {
      return { problem: (err as Error).message };
    }
    let preview;
    try {
      requirePolicyFile(files.policyPath);
      preview = settingsPayload(settings, files);
    } catch (err) {
      return { problem: (err as Error).message };
    }
    const signed = settings.signature ? await signedSettings(files).catch(() => undefined) : undefined;
    return {
      wallet: account.address,
      policyFile: files.policyPath,
      preview,
      signed: signed
        ? { signer: signed.signer, signedAt: signed.signedAt, valid: signed.valid, policyMatches: signed.policyMatches, why: signed.why, thisWallet: signedBy(signed, account.address) }
        : null,
    };
  }

  /** Signs what the owner saw: the hashes in `confirmed` must be those of the files now, or nothing is signed. */
  async function signSettings(confirmed: unknown): Promise<{ status: number; body: unknown }> {
    const files = settingsFiles();
    let settings;
    let payload;
    try {
      settings = readOwnerSettings();
      requirePolicyFile(files.policyPath);
      payload = settingsPayload(settings, files);
    } catch (err) {
      return { status: 409, body: { error: `${(err as Error).message}; nothing was signed` } };
    }
    const c = confirmed as { settingsHash?: unknown; policyHash?: unknown; retiredHash?: unknown } | null;
    if (!c || c.settingsHash !== payload.settingsHash || c.policyHash !== payload.policyHash || c.retiredHash !== payload.retiredHash) {
      return { status: 409, body: { error: "the settings, the policy or the retired agent keys are not what the card showed; nothing was signed. Look at the card again" } };
    }
    const signedAt = settingsSignedAt();
    const value = await account.signTypedData(settingsTypedData(payload, signedAt));
    writeOwnerSettings({ ...settings, signature: signatureRecord({ scheme: "eip712", signer: account.address, signedAt, payload, value }) });
    const check = await signedSettings(files);
    if (!check?.valid) return { status: 500, body: { error: `the signature was written but does not verify (${check?.why ?? "unknown"}); run ${SIGN_COMMAND}` } };
    return { status: 200, body: await settingsView() };
  }

  const serverFor = (listener: Listener): Server =>
    createServer((req, res) => {
      handle(req, res, listener).catch((err: Error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        send(res, 500, { error: `the wallet could not handle that request: ${err.message}` });
      });
    });

  // The agent's socket, in the wallet's own folder (0700). Windows has none: there the agent stays on TCP.
  let socketPath: string | undefined;
  try {
    socketPath = options.socketPath ?? walletSocketPath(dir);
  } catch (err) {
    // a path too long for a socket: with --tcp the agent has TCP, and the wallet does without the socket
    if (options.tcp !== true) {
      clearInterval(sweeper);
      throw err;
    }
  }
  const agentOnTcp = options.tcp === true || socketPath === undefined;
  if (socketPath !== undefined) {
    await clearStaleSocket(socketPath).catch((err: unknown) => {
      clearInterval(sweeper);
      throw err;
    });
  }

  const server = serverFor("tcp");
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only: this wallet is never reachable from another machine.
    server.listen(options.port ?? DEFAULT_WALLET_PORT, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  let agentServer: Server | undefined;
  if (socketPath !== undefined) {
    const listening = serverFor("socket");
    try {
      await new Promise<void>((resolve, reject) => {
        listening.once("error", reject);
        listening.listen(socketPath, () => resolve());
      });
      // the folder already keeps other users out; the file does too
      chmodSync(socketPath, 0o600);
    } catch (err) {
      listening.close();
      server.close();
      throw err;
    }
    agentServer = listening;
  }

  const url = `http://127.0.0.1:${port}`;
  // where `wallet open` finds the page: written once the wallet is listening, removed when it stops
  const pagePortFile = join(dir, PAGE_PORT_FILE);
  try {
    writeFileSync(pagePortFile, `${port} ${process.pid}\n`, { mode: 0o600 });
    chmodSync(pagePortFile, 0o600);
  } catch {
    // without it `wallet open` says to start the wallet; the wallet itself does not need it
    // and a file left by an earlier wallet would name the wrong port
    try {
      unlinkSync(pagePortFile);
    } catch {
      // none there
    }
  }
  const removePagePort = (): void => {
    try {
      unlinkSync(pagePortFile);
    } catch {
      // gone already
    }
  };
  process.once("exit", removePagePort);
  const ownerUrl = `${url}/#${ownerSecret}`;
  const ownerSecretFile = join(dir, "owner-secret");

  // The owner secret is never printed and never put on a command line: a command line is readable by every user on
  // this machine (ps), and this process's output may be read by whoever started it, an agent included. The browser
  // gets it from a launcher file only this user can read, which redirects to the page with the secret in the fragment;
  // the opener is given the file's path. Anyone else opens the page bare and pastes the secret from its file.
  const shouldOpen = options.openBrowser ?? (!quiet && !isUnderTest());
  const launcherDir = options.launcherDir ?? defaultLauncherDir();
  // launcherPath: a file of ours that holds the secret and is still to be deleted. launcherReady: it was written in
  // full, so it may be printed and opened.
  let launcherPath: string | undefined;
  let launcherReady = false;
  let launcherProblem: string | undefined;
  if (!quiet || shouldOpen) {
    try {
      launcherPath = writeOwnerLauncher(launcherDir, ownerUrl, options.launcherIo);
      heldLaunchers.add(launcherPath);
      launcherReady = true;
    } catch (err) {
      launcherProblem = (err as Error).message;
      // a partly written launcher that could not be deleted is still ours to delete: close and exit try again
      launcherPath = (err as LauncherError).leftover;
    }
  }
  /** Deletes the launcher. The path is forgotten only once the file is gone, so a later call (close, exit) can retry. */
  function removeLauncher(): void {
    // the launchers `wallet open` wrote are named after this process and go with it
    try {
      for (const name of readdirSync(launcherDir)) {
        const m = LAUNCHER_NAME.exec(name);
        // (a launcher another wallet in this same process still holds is left to that wallet)
        if (m && Number(m[1]) === process.pid && join(launcherDir, name) !== launcherPath && !heldLaunchers.has(join(launcherDir, name))) {
          try {
            unlinkSync(join(launcherDir, name));
          } catch {
            // gone already
          }
        }
      }
    } catch {
      // no folder, nothing to delete
    }
    if (launcherPath === undefined) {
      removeEmptyFolder(launcherDir);
      return;
    }
    try {
      unlinkSync(launcherPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!quiet) console.error(`wallet: could not delete the page launcher ${launcherPath}: ${(err as Error).message}`);
        return;
      }
    }
    heldLaunchers.delete(launcherPath);
    launcherPath = undefined;
    launcherReady = false;
    removeEmptyFolder(launcherDir);
  }
  process.once("exit", removeLauncher);

  if (!quiet) {
    console.log(`Superstables wallet on ${url}`);
    console.log(`  address:        ${account.address}`);
    console.log(`  network:        ${DEFAULT_NETWORK.label}`);
    console.log(`  approval mode:  ask before every payment`);
    console.log(`  approve here:   ${url}/ (it asks for the owner secret)`);
    if (launcherReady) console.log(`  open signed in: ${launcherPath} (only you can read it; kept until the wallet stops)`);
    if (launcherProblem) console.log(`  open signed in: no launcher (${launcherProblem}); open the page and paste the secret`);
    console.log(`  owner secret:   ${ownerSecretFile} (paste it into the page; never share it)`);
    console.log(`  over SSH:       ssh -L ${port}:127.0.0.1:${port} <you>@<this machine>, open ${url}/ on your machine, paste the secret`);
    try {
      const policy = currentPolicy();
      console.log(`  policy:         ${policySummary(policy)}`);
      if (policy.also) console.log(`  also applies:   ${policy.also.file}: ${policySummary(policy.also.policy)}`);
    } catch (err) {
      console.log(`  policy:         cannot be used: ${(err as Error).message}`);
    }
    console.log(`  agent token:    ${agentTokenFile}`);
    if (socketPath !== undefined) console.log(`  agent socket:   ${socketPath}`);
    if (socketPath !== undefined && agentOnTcp) console.log(`  agent routes also on: ${url} (--tcp)`);
  }

  // without a launcher the browser still gets the page, without the secret: it asks for it
  if (shouldOpen) (options.opener ?? openInBrowser)(launcherReady && launcherPath ? launcherPath : `${url}/`);

  return {
    port,
    url,
    socketPath,
    agentToken,
    ownerSecret,
    ownerUrl,
    get launcherPath() {
      return launcherPath;
    },
    address: account.address,
    close: () =>
      new Promise<void>((resolve) => {
        removeLauncher();
        process.off("exit", removeLauncher);
        removePagePort();
        process.off("exit", removePagePort);
        clearInterval(sweeper);
        let open = agentServer ? 2 : 1;
        const closed = () => {
          if (--open === 0) resolve();
        };
        server.closeAllConnections?.();
        server.close(closed);
        if (agentServer) {
          agentServer.closeAllConnections?.();
          agentServer.close(() => {
            // node removes the socket file itself; this is for when it did not
            try {
              unlinkSync(socketPath as string);
            } catch {
              // gone already
            }
            closed();
          });
        }
      }),
  };
}

/**
 * Makes way for the wallet's socket. A socket of this user's that nothing answers on was left by a wallet that did not
 * stop cleanly, and is removed. One that answers is another wallet's for this home: starting a second is refused. Anything
 * else at that path is refused, and never removed.
 */
async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const mine = typeof process.getuid !== "function" || st.uid === process.getuid();
  if (st.isSymbolicLink() || !st.isSocket() || !mine) {
    throw new Error(`${path} is in the way of the wallet's socket and is not one this wallet left: check what it is, then remove it`);
  }
  const answers = await new Promise<boolean>((resolve, reject) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      // refused: nothing listens there any more. Anything else is not a socket to remove.
      if (err.code === "ECONNREFUSED") resolve(false);
      else reject(new Error(`${path} could not be checked (${err.code ?? err.message}); check what it is, then remove it`));
    });
  });
  if (answers) throw new Error(`another wallet is already running for this home (it answers on ${path})`);
  unlinkSync(path);
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

/**
 * Where the page launcher goes: `~/Superstables-wallet-open`. Not under ~/.superstables, because a browser installed as a
 * Snap (Ubuntu's default Firefox) cannot read hidden folders in the home folder, nor /tmp or $XDG_RUNTIME_DIR. The
 * folder exists only while a launcher is in it.
 */
export function defaultLauncherDir(): string {
  return join(homedir(), "Superstables-wallet-open");
}

/**
 * Makes sure `path` is a folder only this user can use: created 0700 when missing; when it exists, a real folder (not a
 * symlink) owned by this user with mode 0700. Throws a sentence saying what is wrong otherwise; nothing is changed then.
 */
function ensurePrivateFolder(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path, { mode: 0o700 }); // not recursive: the home folder must already exist
    chmodSync(path, 0o700); // a umask may have taken more than it should; this folder is ours
    st = lstatSync(path);
  }
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink, not a folder`);
  if (!st.isDirectory()) throw new Error(`${path} is not a folder`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} belongs to another user`);
  if ((st.mode & 0o777) !== 0o700) throw new Error(`${path} has mode ${(st.mode & 0o777).toString(8)}, not 700 (chmod 700 ${path})`);
}

/** Removes the launcher folder when nothing is left in it, so nothing lingers in the home folder. */
function removeEmptyFolder(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // not empty, or gone already
  }
}

/** File operations the launcher uses; tests replace them to simulate failures. */
export interface LauncherIo {
  fsyncSync?: typeof fsyncSync;
  unlinkSync?: typeof unlinkSync;
}

/** A launcher that could not be written, and, when it could not be deleted either, the file left behind. */
export type LauncherError = Error & { leftover?: string };

/** owner-<pid of the wallet that wrote it>-<random>.html */
/** The serve launchers of the wallets running in this process; `wallet open` launchers are the others of its name. */
const heldLaunchers = new Set<string>();
const LAUNCHER_NAME = /^owner-(\d+)-[0-9a-f]+\.html$/;

/** Whether a process with this pid exists. EPERM means it does, under another user. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Writes the page launcher: a small HTML file that sends the browser to the owner URL, secret included. It goes in
 * `dir` (see ensurePrivateFolder), under a name with this process's pid and a random part, created exclusively with mode
 * 0600, so only this user can read it. Launchers whose wallet process is gone (it did not stop cleanly) are removed
 * first; another wallet's, still running, are left alone. A file that cannot be written in full is removed again; if
 * that fails too, the error's `leftover` names it, for the caller to delete later. Returns the file's path.
 *
 * The folder is checked, then used by path. Someone who could swap it in between needs write access to the home
 * folder, which already gives them this account, so the check does not try to close that gap.
 */
export function writeOwnerLauncher(dir: string, ownerUrl: string, io: LauncherIo = {}, pid: number = process.pid): string {
  const unlink = io.unlinkSync ?? unlinkSync;
  ensurePrivateFolder(dir);
  for (const name of readdirSync(dir)) {
    const m = LAUNCHER_NAME.exec(name);
    if (m && Number(m[1]) !== pid && Number(m[1]) !== process.pid && !processAlive(Number(m[1]))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // gone already
      }
    }
  }
  const path = join(dir, `owner-${pid}-${randomBytes(16).toString("hex")}.html`);
  // JSON is a valid JavaScript string literal; "<" is escaped so the value cannot close the script element
  const target = JSON.stringify(ownerUrl).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Superstables wallet</title>
<p>Opening the wallet's approval page&hellip;</p>
<script>location.replace(${target});</script>
`;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeAllSync(fd, html);
    (io.fsyncSync ?? fsyncSync)(fd);
  } catch (err) {
    // a file that holds the secret is never left behind untracked, written in full or not
    closeSync(fd);
    try {
      unlink(path);
    } catch (unlinkErr) {
      if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") (err as LauncherError).leftover = path;
    }
    removeEmptyFolder(dir);
    throw err;
  }
  closeSync(fd);
  return path;
}

/** The header that proves a page's server holds the owner secret: HMAC-SHA256 of the port it was asked on and the caller's nonce. */
const PROOF_HEADER = "x-superstables-proof";
function walletProof(secret: string, port: number, nonce: string): string {
  return createHmac("sha256", secret).update(`wallet-open:127.0.0.1:${port}:${nonce}`).digest("hex");
}

/** The file in the wallet's folder that names the port its page is on and the wallet's pid, for `wallet open`. */
const PAGE_PORT_FILE = "page-port";

/**
 * Opens the running wallet's page signed in: writes a fresh launcher from the owner secret in the wallet's folder and
 * hands the browser its path. Returns that path. Throws a sentence when no wallet is running for this folder.
 */
export async function openWalletPage(options: { dir?: string; launcherDir?: string; opener?: (target: string) => void } = {}): Promise<string> {
  const dir = options.dir ?? walletDir();
  const notRunning = new Error("The wallet is not running; start it first with `superstables --wallet local wallet serve`.");
  let port: number;
  let walletPid: number;
  let secret: string;
  try {
    const [portText, pidText] = readFileSync(join(dir, PAGE_PORT_FILE), "utf8").trim().split(/\s+/);
    port = Number(portText);
    walletPid = Number(pidText);
    secret = readFileSync(join(dir, "owner-secret"), "utf8").trim();
  } catch {
    throw notRunning;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(walletPid) || walletPid < 1 || secret === "") throw notRunning;
  // a page-port file outlives a wallet that crashed: only a wallet that answers with its page counts
  // and the secret goes only to a page whose server shows it knows the secret
  const nonce = randomBytes(16).toString("hex");
  const answered = await fetch(`http://127.0.0.1:${port}/?proof=${nonce}`, { signal: AbortSignal.timeout(2000), redirect: "error" })
    .then(async (res) => {
      if (!res.ok || !(await res.text()).includes("Local wallet")) return false;
      const given = res.headers.get(PROOF_HEADER) ?? "";
      const expected = walletProof(secret, port, nonce);
      return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    })
    .catch(() => false);
  if (!answered) throw notRunning;
  // named after the wallet's process, so the wallet deletes it when it stops
  const launcher = writeOwnerLauncher(options.launcherDir ?? defaultLauncherDir(), `http://127.0.0.1:${port}/#${secret}`, {}, walletPid);
  (options.opener ?? openInBrowser)(launcher);
  return launcher;
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
    // No browser, no display, no problem: the owner has the page's address printed above.
  }
}
