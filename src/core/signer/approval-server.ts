// The approval server: a node:http server on 127.0.0.1 that the agent's own process runs, so
// the owner has nothing to start. It serves one page per pending payment, hands the browser
// wallet exactly what to do (typed data to sign, a call to send, a transaction to sign: the
// rail's wallet step, ./steps/), checks what comes back, and gives the payment core a
// SignResult — or a refusal.
//
// Four properties shape every line below.
//
//  1. The server derives everything it shows and everything it asks to be signed from the
//     seller's requirement. The agent's own account of the payment is stored apart, as
//     `reported`, and the page labels it unverified. An agent that lies can only lie about
//     the label.
//  2. The approval id is the capability. It is 128 bits of randomness that exists in exactly
//     two places — the agent's tool result and this process — so the page needs no login, and
//     a page opened under one id can only ever sign that one payment.
//  3. A signature is checked before it is believed: the recovered signer must be the account
//     the typed data was built for. A signature from any other key is rejected and the request
//     stays pending, so the person can simply try again with the right account. A wallet that
//     sends the payment itself (Tempo) is asked once per approval, after the payment core has
//     recorded that money may move; from then on an approval that ends without the transaction
//     ends "unknown", never as unpaid, a rejection the page reports included.
//  4. Nothing waits for ever. Requests expire on their own, an expiry is a refusal with a
//     reason, and every state change is appended to an audit log that never holds a signature.
//
// Like the owner approval page, it answers only to Host 127.0.0.1:PORT (or localhost:PORT), so a
// rebinding DNS name cannot reach it, and a state-changing POST must come from the page's own
// origin with a JSON body, so another web page in the owner's browser cannot reject or sign.

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkFor } from "../chain.js";
import { DEFAULT_APPROVE_PORT, approvalsPath, ensureDir, recordsDir } from "../home.js";
import type { RailRequirement } from "../rails/types.js";
import type { PaymentContext, VerifiedTerms } from "../types.js";
import { approvalNotFoundPage, approvalPage, type ApprovalPageFacts } from "./approval-page.js";
import { stepFor } from "./steps/index.js";
import type { StepRecord, WalletStep } from "./steps/types.js";
import { SignRefused, type RefusalCode, type SignKind, type SignResult, type WalletSendIntent } from "./types.js";

export type { ApprovalTypedData } from "./steps/eip3009.js";

/** An approval is small; anything larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024;
/** How often expiry is swept. The page also polls, so a second's granularity is plenty. */
const SWEEP_MS = 1_000;

export type ApprovalStatus = "pending" | "signed" | "denied" | "expired" | "abandoned" | "refused" | "unknown";

export interface ApprovalRequestInput {
  /** What the owner's wallet is asked to do: the rail's wallet step. Defaults to eip3009. */
  kind?: SignKind;
  /** Derived from the requirement by the caller, with the rail's own judging. Never agent-supplied. */
  verified: VerifiedTerms;
  /** What the agent says this is for. Shown as unverified; used for nothing else. */
  reported?: PaymentContext;
  /** The seller's requirement as it was judged: what the wallet's request is built from. */
  requirement: RailRequirement;
  x402Version: 1 | 2;
  /** How long the person has to decide. */
  timeoutMs: number;
  /** When the approval must end at the latest, if sooner than timeoutMs (a seller's challenge that expires sooner). */
  notAfter?: number;
  /** Push rails: awaited before the wallet is asked to send (the payment core records that money may move). */
  beforeWalletSends?: (intent: WalletSendIntent) => Promise<void>;
}

/** How an approval ended. `signed` carries the result; everything else carries a reason. */
export type ApprovalOutcome =
  | { status: "signed"; result: SignResult }
  | { status: "denied" | "expired" | "abandoned" | "unknown"; reason: string }
  | { status: "refused"; code: RefusalCode; reason: string };

export interface ApprovalHandle {
  id: string;
  /** The link the owner opens. The agent shows this to the person verbatim. */
  url: string;
  /** Resolves once the person has signed, rejected, or run out of time. */
  settled: Promise<ApprovalOutcome>;
}

interface ApprovalRecord extends StepRecord {
  status: ApprovalStatus;
  createdAt: number;
  timeoutMs: number;
  reason?: string;
  reported?: PaymentContext;
  step: WalletStep;
  beforeWalletSends?: (intent: WalletSendIntent) => Promise<void>;
  /** A POST is being answered: a second one is refused (409) rather than racing it. */
  busy?: boolean;
  finish: (outcome: ApprovalOutcome) => void;
}

export interface ApprovalServerOptions {
  /**
   * A port somebody chose (SUPERSTABLES_APPROVE_PORT), or 0 for any free one (tests). It is
   * kept as chosen: when it is busy, start() fails with ApprovalPortBusy rather than moving.
   * Leave it out to use `preferredPort`.
   */
  port?: number;
  /**
   * The port to try when none was chosen. Defaults to DEFAULT_APPROVE_PORT. When it is busy,
   * usually because another payment is waiting there for its owner, the page takes a free
   * port instead and `movedFrom` says which one was busy.
   */
  preferredPort?: number;
  /** Where the audit log lives. Defaults to the records directory under SUPERSTABLES_HOME. */
  recordsDirPath?: string;
  /** Remember the connected account here, so `status` can name a payer later. */
  onAccount?: (address: string, network: string) => void;
}

/** What an approval whose wallet was asked to send ends with, when nothing came back. */
const MAY_HAVE_SENT =
  "your wallet was asked to send this payment and the page did not report a transaction, so whether it was sent is unknown";

/** What an approval whose wallet was asked to send ends with, when the page reports that the wallet rejected it. */
const WALLET_SAID_NO =
  "the approval page reported that the owner rejected this payment in their wallet after the wallet was asked to send it; " +
  "that report cannot be checked against the wallet, so whether it was sent is unknown until the chain shows it";

/**
 * The port somebody chose is taken. Most likely another `superstables pay` (or MCP server) is
 * serving its own approval page there and waiting for its owner, so the message says to leave
 * it alone: stopping that process would end someone else's payment.
 */
export class ApprovalPortBusy extends Error {
  constructor(readonly port: number) {
    super(
      `port ${port} on 127.0.0.1 is already in use, so the approval page could not start. Another ` +
        "`superstables pay` or MCP server is probably serving its own approval page there and waiting " +
        "for its owner: do not stop it. Unset SUPERSTABLES_APPROVE_PORT to let pay pick a free port, " +
        "or set it to a different one",
    );
    this.name = "ApprovalPortBusy";
  }
}

export class ApprovalServer {
  private readonly options: ApprovalServerOptions;
  private readonly records = new Map<string, ApprovalRecord>();
  private server?: Server;
  private starting?: Promise<void>;
  private sweeper?: NodeJS.Timeout;
  private boundPort = 0;
  private busyPort?: number;

  constructor(options: ApprovalServerOptions = {}) {
    this.options = options;
  }

  /** Where the pages live. Only meaningful once start() has resolved. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  get port(): number {
    return this.boundPort;
  }

  /** The preferred port, when it was busy and the page took a free one instead. */
  get movedFrom(): number | undefined {
    return this.busyPort;
  }

  get pending(): number {
    this.sweep();
    return [...this.records.values()].filter((record) => record.status === "pending").length;
  }

  /** Binds once. Safe to call twice: the second caller waits for the first one's listen(). */
  async start(): Promise<void> {
    if (this.server) return;
    if (this.starting) return this.starting;
    this.starting = this.listen();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async listen(): Promise<void> {
    const chosen = this.options.port;
    const preferred = this.options.preferredPort ?? DEFAULT_APPROVE_PORT;
    let server: Server;
    try {
      server = await this.bind(chosen ?? preferred);
    } catch (err) {
      if (!isAddressInUse(err)) throw err;
      // A port somebody chose stays chosen; only the default gives way.
      if (chosen !== undefined) throw new ApprovalPortBusy(chosen);
      server = await this.bind(0);
      this.busyPort = preferred;
    }
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    // The agent's own process must never be held open by this timer.
    this.sweeper.unref();
  }

  /** A fresh server on one port, or the listen error. Node does not reuse a server that failed. */
  private async bind(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: Error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        this.sendJson(res, 500, { error: `the approval page could not handle that: ${err.message}` });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // 127.0.0.1 only: an approval page is never reachable from another machine.
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  /** Register one payment for approval and hand back the link and the promise to wait on. */
  request(input: ApprovalRequestInput): ApprovalHandle {
    const kind = input.kind ?? "eip3009";
    const step = stepFor(kind);
    const network = networkFor(input.verified.network);
    // The caller judged the request; a kind with no step here, or a chain this client does not know, is a bug upstream.
    if (!step || !network) throw new SignRefused("invalid", `the approval page cannot ask a wallet for a ${kind} payment on ${input.verified.networkLabel || "an unknown chain"}`);
    const id = randomBytes(16).toString("hex");
    const now = Date.now();
    let finish!: (outcome: ApprovalOutcome) => void;
    const settled = new Promise<ApprovalOutcome>((resolve) => {
      let answered = false;
      finish = (outcome) => {
        if (answered) return;
        answered = true;
        resolve(outcome);
      };
    });
    const record: ApprovalRecord = {
      id,
      kind,
      network,
      step,
      verified: input.verified,
      reported: input.reported,
      requirement: input.requirement,
      x402Version: input.x402Version,
      timeoutMs: input.timeoutMs,
      beforeWalletSends: input.beforeWalletSends,
      status: "pending",
      createdAt: now,
      expiresAt: Math.min(now + input.timeoutMs, input.notAfter ?? Number.POSITIVE_INFINITY),
      finish,
    };
    const deadline = step.deadline?.(record);
    if (deadline !== undefined) record.expiresAt = Math.min(record.expiresAt, deadline);
    this.records.set(id, record);
    this.audit(record);
    return { id, url: `${this.url}/approve/${id}`, settled };
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    // Closing is not a decision: nobody approved and nobody rejected, the page simply goes
    // away with this process. Recording it as a rejection would put words in the owner's mouth.
    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      if (record.step.mayHaveSent?.(record)) {
        this.end(record, "unknown", `the process serving the approval page stopped, and ${MAY_HAVE_SENT}`);
        continue;
      }
      this.end(record, "abandoned", "the process serving the approval page stopped before anyone approved or rejected this payment");
    }
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────

  /** Expiry is this process's decision, not the page's: nothing stays signable for ever. */
  private sweep(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status !== "pending" || record.expiresAt > now || record.busy) continue;
      if (record.step.mayHaveSent?.(record)) {
        this.end(record, "unknown", `the approval window ended, and ${MAY_HAVE_SENT}`);
        continue;
      }
      this.end(record, "expired", `nobody approved this payment within ${Math.round((record.expiresAt - record.createdAt) / 1000)} s`);
    }
  }

  /** End a pending approval: record it, audit it, and answer whoever waits on it. */
  private end(record: ApprovalRecord, status: Exclude<ApprovalStatus, "pending" | "signed" | "refused">, reason: string): void {
    record.status = status;
    record.reason = reason;
    this.audit(record);
    record.finish({ status, reason });
  }

  /** One line per state change. Never a signature, never a key: this file is for reading. */
  private audit(record: ApprovalRecord): void {
    const dir = this.options.recordsDirPath ?? recordsDir();
    const line = {
      at: new Date().toISOString(),
      id: record.id,
      status: record.status,
      reason: record.reason,
      verified: record.verified,
      reported: record.reported,
      address: record.account,
    };
    try {
      ensureDir(dir);
      appendFileSync(approvalsPath(dir), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // An unwritable audit file must never stop a person from deciding about their own money.
    }
  }

  private facts(record: ApprovalRecord): ApprovalPageFacts {
    return {
      id: record.id,
      step: record.kind,
      amountDecimal: record.verified.amountDecimal,
      asset: record.verified.asset,
      amountAtomic: record.verified.amountAtomic,
      recipient: record.verified.recipient,
      network: record.verified.network,
      networkLabel: record.verified.networkLabel,
      assetAddress: record.verified.assetAddress,
      expiresAt: record.expiresAt,
      ...record.step.pageFacts(record),
      reported: record.reported,
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────────────

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html);
  }

  private readBody(req: IncomingMessage): Promise<string> {
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 must not reach these
    // routes. The link names 127.0.0.1 and this port; localhost on the same port is the same page.
    const host = String(req.headers.host ?? "");
    if (host !== `127.0.0.1:${this.boundPort}` && host !== `localhost:${this.boundPort}`) {
      this.sendJson(res, 421, { error: "this page answers on 127.0.0.1 only" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    this.sweep();

    const match = /^\/approve\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (!match) {
      this.sendJson(res, 404, { error: "no such route" });
      return;
    }
    const record = this.records.get(decodeURIComponent(match[1]));
    const leaf = match[2];

    if (!record) {
      // An id nobody holds is the same to this server as an id that never existed.
      if (!leaf && method === "GET") {
        this.sendHtml(res, 404, approvalNotFoundPage());
        return;
      }
      this.sendJson(res, 404, { error: "there is no payment waiting under this approval link" });
      return;
    }
    if (leaf && leaf !== "/state" && leaf !== "/reject" && !record.step.routes.includes(leaf)) {
      this.sendJson(res, 404, { error: "no such route" });
      return;
    }

    if (!leaf && method === "GET") {
      this.sendHtml(res, 200, approvalPage(this.facts(record), record.step));
      return;
    }
    if (leaf === "/state" && method === "GET") {
      this.sendJson(res, 200, {
        id: record.id,
        status: record.status,
        verified: record.verified,
        reported: record.reported,
        reason: record.reason,
        expiresAt: record.expiresAt,
        address: record.account,
      });
      return;
    }
    if (method !== "POST" || !leaf) {
      this.sendJson(res, 405, { error: "that route takes a POST" });
      return;
    }
    // CSRF defences for every state-changing route, as on the owner approval page: the request
    // must come from this page's own origin (exactly http://<the Host checked above>) and carry
    // a JSON body, which a cross-site form or a "simple" cross-origin request cannot. These stop
    // other web pages in the owner's browser; they are not authentication. The signature check
    // below is what decides whether anything was signed.
    if (String(req.headers.origin ?? "") !== `http://${host}`) {
      this.sendJson(res, 403, { error: "this route answers only to the approval page itself" });
      return;
    }
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      this.sendJson(res, 415, { error: "send JSON (content-type: application/json)" });
      return;
    }

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse((await this.readBody(req)) || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "the request body is not JSON" });
      return;
    }

    if (record.status !== "pending") {
      this.sendJson(res, 409, { error: `this payment is already ${record.status}`, status: record.status, reason: record.reason });
      return;
    }
    // One state change at a time per approval: a wallet step may wait on the payment core (Tempo), and a second POST
    // meanwhile must see its result, not race it.
    if (record.busy) {
      this.sendJson(res, 409, { error: "the approval page is already handling a request for this payment; wait for it" });
      return;
    }
    record.busy = true;
    try {
      await this.post(record, leaf, body, res);
    } finally {
      record.busy = false;
    }
  }

  private async post(record: ApprovalRecord, leaf: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    if (leaf === "/reject") {
      const byWallet = body.by === "wallet";
      // A wallet that was asked to send may still send while this page says "rejected". The page's button is not an
      // answer from the wallet at all.
      if (record.walletAsked && !byWallet) {
        this.sendJson(res, 409, { error: "your wallet was asked to send this payment: reject it in your wallet, or check its activity" });
        return;
      }
      // The page says the wallet rejected the send. That is a line in a request body, which anything holding this link
      // can post, and nothing here can check it against the wallet: it ends the approval, as unknown, never as unpaid.
      // The chain decides whether the transfer happened.
      if (record.walletAsked) {
        this.end(record, "unknown", WALLET_SAID_NO);
        this.sendJson(res, 200, { status: record.status, reason: record.reason });
        return;
      }
      record.status = "denied";
      // The page posts { by: "wallet" } when the wallet answered the signature request with a rejection: nothing was
      // signed, and a signature that came later could not be used, because only a pending payment takes one.
      record.reason = byWallet ? "rejected by the owner in their wallet" : "rejected by the owner on the approval page";
      this.audit(record);
      record.finish({ status: "denied", reason: record.reason });
      this.sendJson(res, 200, { status: record.status, reason: record.reason });
      return;
    }

    if (leaf === "/account") {
      const address = record.step.account(body.address);
      if (!address) {
        this.sendJson(res, 400, { error: "that is not an account address" });
        return;
      }
      if (record.walletAsked) {
        this.sendJson(res, 409, { error: "your wallet was already asked to send this payment; it is not prepared again" });
        return;
      }
      const answer = await record.step.prepare(record, address);
      if (answer.http === 200) {
        // A person may switch accounts before signing, so this rebuilds rather than refusing.
        record.account = address;
        record.verified = { ...record.verified, payer: address };
      }
      this.sendJson(res, answer.http, answer.body);
      return;
    }

    let answer;
    try {
      answer = await record.step.answer(record, leaf, body, {
        beforeWalletSends: async (intent) => {
          if (!record.beforeWalletSends) throw new SignRefused("invalid", "nobody is recording this payment, so the wallet is not asked to send it");
          await record.beforeWalletSends(intent);
        },
      });
    } catch (err) {
      // The payment core said no before the wallet was asked (a spend policy, nobody waiting any more): nothing was sent.
      const code: RefusalCode = err instanceof SignRefused ? err.code : "invalid";
      const reason = err instanceof Error ? err.message : String(err);
      if (record.status === "pending") {
        record.status = "refused";
        record.reason = reason;
        this.audit(record);
        record.finish({ status: "refused", code, reason });
      }
      this.sendJson(res, 409, { error: reason, status: record.status, reason: record.reason });
      return;
    }
    // The approval may have ended while the step waited (the process serving it closed): then nothing the step
    // prepared is handed out, and the page hears how it ended instead.
    if (record.status !== "pending") {
      this.sendJson(res, 409, { error: `this payment is already ${record.status}`, status: record.status, reason: record.reason });
      return;
    }
    if (answer.signed) {
      record.status = "signed";
      record.reason = undefined;
      this.audit(record);
      if (record.account) this.options.onAccount?.(record.account, record.verified.network);
      record.finish({ status: "signed", result: answer.signed });
    }
    this.sendJson(res, answer.http, answer.body);
  }
}

function isAddressInUse(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE";
}
