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
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { PaymentRequirements } from "@x402/core/types";
import type { PrivateKeyAccount } from "viem/accounts";
import { DEFAULT_NETWORK, evmNetworkFor, fromAtomic, usdcBalance } from "../core/chain.js";
import { DEFAULT_WALLET_PORT, ensureDir, policyPath, walletDir } from "../core/home.js";
import { evaluatePolicy, formatMoney, loadPolicy, type Policy } from "../core/policy.js";
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
import { loadAccount, readOrCreateSecret, writeAllSync } from "./keystore.js";
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
  /** How a file is opened in the owner's browser. Defaults to open / xdg-open / start; tests pass their own. */
  opener?: (target: string) => void;
  /** The folder for the page launcher. Default `~/Superstables-wallet-open` (see defaultLauncherDir). */
  launcherDir?: string;
  /** Tests only: file operations the launcher uses, to simulate failures. */
  launcherIo?: LauncherIo;
}

export interface WalletHandle {
  port: number;
  url: string;
  agentToken: string;
  ownerSecret: string;
  /** The link the owner opens: the secret is in the fragment, so it never reaches the server. Never printed. */
  ownerUrl: string;
  /**
   * The launcher file that opens `ownerUrl` in a browser (mode 0600), or undefined when none was written. Deleted once
   * the page has signed in with the owner secret, and when the wallet stops.
   */
  launcherPath?: string;
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
  result?: Eip3009SignResult;
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
    // This wallet signs USDC only, which has six decimals on every chain it signs on.
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
      expiresAt: now + approvalTimeoutMs,
      verified: blank,
      reported,
      x402Version: version,
    };
    requests.set(id, record);

    if (request.kind !== undefined && request.kind !== "eip3009") {
      record.reason = request.kind === "tempo-transfer" || request.kind === "solana-transaction"
        ? LOCAL_WALLET_EVM_ONLY
        : `this wallet signs eip3009 authorizations, not "${String(request.kind)}"`;
      audit(record);
      return record;
    }
    if (named !== 1 && named !== 2) {
      record.reason = `x402 version ${untrustedText(String(named), 20)} is not supported (only 1 and 2)`;
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
    // One EVM key: an x402 payment on any other rail is approved in a browser wallet instead.
    if (!evmNetworkFor(judged.terms.network)) {
      record.reason = LOCAL_WALLET_EVM_ONLY;
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

    // Answer only to the host this server is bound to, as the two approval servers do. Without it a web
    // page under a DNS name resolving to 127.0.0.1 can reach this one, which is the page that approves
    // payments outright: under `--wallet local` there is no wallet prompt to contradict what it shows.
    const host = String(req.headers.host ?? "");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(421, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("This wallet answers to its own host only.\n");
      return;
    }

    // The approval page itself carries no secret: the owner's fragment stays in the browser.
    if (method === "GET" && path === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // this page decides money, so it is not framed and not embedded
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      });
      res.end(walletPage());
      return;
    }

    const token = bearer(req);
    let caller: Caller | undefined;
    if (token && secretEquals(token, ownerSecret)) {
      caller = "owner";
      // the page is open and signed in: the launcher that carried the secret to it has done its job
      removeLauncher();
    }
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
      launcherReady = true;
    } catch (err) {
      launcherProblem = (err as Error).message;
      // a partly written launcher that could not be deleted is still ours to delete: close and exit try again
      launcherPath = (err as LauncherError).leftover;
    }
  }
  /** Deletes the launcher. The path is forgotten only once the file is gone, so a later call (close, exit) can retry. */
  function removeLauncher(): void {
    if (launcherPath === undefined) return;
    try {
      unlinkSync(launcherPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!quiet) console.error(`wallet: could not delete the page launcher ${launcherPath}: ${(err as Error).message}`);
        return;
      }
    }
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
    if (launcherReady) console.log(`  open signed in: ${launcherPath} (only you can read it; deleted once the page is open)`);
    if (launcherProblem) console.log(`  open signed in: no launcher (${launcherProblem}); open the page and paste the secret`);
    console.log(`  owner secret:   ${ownerSecretFile} (paste it into the page; never share it)`);
    console.log(`  over SSH:       ssh -L ${port}:127.0.0.1:${port} <you>@<this machine>, open ${url}/ on your machine, paste the secret`);
    console.log(`  policy:         ${policySummary(policy)}`);
    console.log(`  agent token:    ${agentTokenFile}`);
  }

  // without a launcher the browser still gets the page, without the secret: it asks for it
  if (shouldOpen) (options.opener ?? openInBrowser)(launcherReady && launcherPath ? launcherPath : `${url}/`);

  return {
    port,
    url,
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
export function writeOwnerLauncher(dir: string, ownerUrl: string, io: LauncherIo = {}): string {
  const unlink = io.unlinkSync ?? unlinkSync;
  ensurePrivateFolder(dir);
  for (const name of readdirSync(dir)) {
    const m = LAUNCHER_NAME.exec(name);
    if (m && Number(m[1]) !== process.pid && !processAlive(Number(m[1]))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // gone already
      }
    }
  }
  const path = join(dir, `owner-${process.pid}-${randomBytes(16).toString("hex")}.html`);
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
