// The owner approval server: the loopback page that lets a person do one owner action in their
// own browser wallet, while the command that asked for it waits. It is the sibling of the
// payment approval server (approval-server.ts) and follows the same rules:
//
//  1. Everything the page shows comes from the caller's plan (the terms) and everything the
//     wallet is asked to send comes from the caller's transaction. Nothing an agent typed is
//     shown or sent.
//  2. The id in the link is the capability: 128 random bits, bound to 127.0.0.1 on a random
//     port, good for one action. Requests whose Host is not this loopback address are refused.
//  3. Nothing is believed that the chain can check. A connect is believed only with a
//     signature from the address it names. A transaction hash the page reports is handed to
//     the caller as a pointer; the caller reads the chain and then says how it ended.
//  4. Nothing waits for ever. A link expires, an expiry is a refusal with a reason, and every
//     state change can be appended to an audit log that never holds a signature.
//
// Two kinds of action:
//   connect           the wallet shares an account and signs a free sign-in message
//   evm-transaction   the wallet sends exactly { to, data, value } from the one allowed account

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getAddress, isAddress, verifyMessage } from "viem";
import {
  ownerApprovalPage,
  ownerNotFoundPage,
  type OwnerChain,
  type OwnerPageFacts,
  type OwnerTerms,
} from "./owner-approval-page.js";

export type { OwnerChain, OwnerTerms, OwnerTermRow } from "./owner-approval-page.js";

const MAX_BODY_BYTES = 16 * 1024;
const SWEEP_MS = 500;
/** Once the wallet was asked to send, the link stays open this much longer for the hash to come back. */
const SENDING_GRACE_MS = 120_000;

export type OwnerActionStatus =
  | "pending" // waiting for the owner
  | "ready" // an allowed account is connected (evm-transaction)
  | "sending" // the page asked the wallet to send
  | "connected" // connect: the address is proven; waiting for the caller
  | "sent" // the page reported a transaction hash; waiting for the caller
  | "confirmed" // the caller checked the chain: done
  | "failed" // the caller checked the chain: it did not do what was planned
  | "rejected"
  | "expired";

export interface OwnerActionInput {
  kind: "connect" | "evm-transaction";
  chain: OwnerChain;
  terms: OwnerTerms;
  /** evm-transaction: the only account that may send it. */
  account?: string;
  /** evm-transaction: exactly what the wallet is asked to send. value is a hex quantity. */
  transaction?: { to: string; data: string; value: string };
  /** connect: the sign-in text. The server adds the approval id and the address to it. */
  signIn?: string;
  timeoutMs: number;
}

export type OwnerActionOutcome =
  | { status: "connected"; address: string }
  | { status: "sent"; address: string; hash: string }
  | { status: "rejected" | "expired"; reason: string; /** the wallet had been asked to send */ sending: boolean };

export interface OwnerActionHandle {
  id: string;
  url: string;
  expiresAt: number;
  /** Resolves when the owner connected, sent, rejected, or the link expired. */
  settled: Promise<OwnerActionOutcome>;
  /** The caller's verdict after reading the chain; the page shows it. */
  finish(verdict: { ok: boolean; message: string; hash?: string }): void;
}

interface OwnerRecord extends OwnerActionInput {
  id: string;
  status: OwnerActionStatus;
  expiresAt: number;
  message?: string;
  reason?: string;
  address?: string;
  hash?: string;
  sending: boolean;
  resolve: (outcome: OwnerActionOutcome) => void;
}

export interface OwnerApprovalServerOptions {
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Append one JSON line per state change here. Never a signature. */
  auditPath?: string;
}

/** The text a connect asks the wallet to sign. */
export function signInMessage(signIn: string, id: string): string {
  return `${signIn}\n\nApproval id: ${id}\nThis signature sends nothing and costs nothing.`;
}

export class OwnerApprovalServer {
  private readonly options: OwnerApprovalServerOptions;
  private readonly records = new Map<string, OwnerRecord>();
  private server?: Server;
  private sweeper?: NodeJS.Timeout;
  private boundPort = 0;

  constructor(options: OwnerApprovalServerOptions = {}) {
    this.options = options;
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}`;
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err: Error) => {
        if (res.headersSent) return void res.end();
        this.json(res, 500, { error: `the owner page could not handle that: ${err.message}` });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.boundPort = typeof address === "object" && address ? address.port : 0;
    this.server = server;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  /** Register one owner action and hand back its link. start() first. */
  request(input: OwnerActionInput): OwnerActionHandle {
    if (!this.server) throw new Error("start the owner approval server first");
    if (input.kind === "evm-transaction" && (!input.transaction || !input.account || !isAddress(input.account))) {
      throw new Error("an evm-transaction needs the transaction and the one account allowed to send it");
    }
    if (input.kind === "connect" && !input.signIn) throw new Error("a connect needs its sign-in text");
    const id = randomBytes(16).toString("hex");
    let resolve!: (outcome: OwnerActionOutcome) => void;
    const settled = new Promise<OwnerActionOutcome>((done) => {
      let answered = false;
      resolve = (outcome) => {
        if (answered) return;
        answered = true;
        done(outcome);
      };
    });
    const record: OwnerRecord = {
      ...input,
      account: input.account ? getAddress(input.account) : undefined,
      id,
      status: "pending",
      expiresAt: Date.now() + input.timeoutMs,
      sending: false,
      resolve,
    };
    this.records.set(id, record);
    this.audit(record);
    return {
      id,
      url: `${this.url}/owner/${id}`,
      expiresAt: record.expiresAt,
      settled,
      finish: (verdict) => {
        if (record.status !== "sent" && record.status !== "connected") return;
        record.status = verdict.ok ? "confirmed" : "failed";
        record.message = verdict.message;
        if (verdict.hash) record.hash = verdict.hash;
        this.audit(record);
      },
    };
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
    for (const record of this.records.values()) {
      if (!["pending", "ready", "sending"].includes(record.status)) continue;
      this.end(record, "rejected", "the command stopped before this was approved");
    }
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────

  private end(record: OwnerRecord, status: "rejected" | "expired", reason: string): void {
    record.status = status;
    record.reason = reason;
    this.audit(record);
    record.resolve({ status, reason, sending: record.sending });
  }

  private sweep(): void {
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status === "pending" || record.status === "ready") {
        if (record.expiresAt <= now) this.end(record, "expired", `nobody approved this within ${Math.round(record.timeoutMs / 1000)} s. Nothing was sent.`);
      } else if (record.status === "sending" && record.expiresAt + SENDING_GRACE_MS <= now) {
        this.end(record, "expired", "the wallet was asked to send, but no transaction came back to this page");
      }
    }
  }

  private audit(record: OwnerRecord): void {
    if (!this.options.auditPath) return;
    const line = {
      at: new Date().toISOString(),
      id: record.id,
      kind: record.kind,
      title: record.terms.title,
      status: record.status,
      reason: record.reason,
      address: record.address,
      hash: record.hash,
    };
    try {
      mkdirSync(dirname(this.options.auditPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.options.auditPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch {
      // an unwritable audit file never stops the owner from deciding
    }
  }

  private facts(record: OwnerRecord): OwnerPageFacts {
    return {
      id: record.id,
      kind: record.kind,
      chain: record.chain,
      chainIdHex: `0x${record.chain.chainId.toString(16)}`,
      account: record.account,
      transaction: record.transaction,
      message: record.kind === "connect" ? signInMessage(record.signIn!, record.id) : undefined,
      expiresAt: record.expiresAt,
    };
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────────────────

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private html(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      // Framing only. A stricter connect-src would break wallets whose injected provider calls RPC from the page.
      "content-security-policy": "frame-ancestors 'none'",
    });
    res.end(html);
  }

  private body(req: IncomingMessage): Promise<Record<string, unknown>> {
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
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
        } catch {
          reject(new Error("the request body is not JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on another name that resolves here must not reach these routes.
    const host = String(req.headers.host ?? "");
    if (host !== `127.0.0.1:${this.boundPort}` && host !== `localhost:${this.boundPort}`) {
      this.json(res, 421, { error: "this page answers on 127.0.0.1 only" });
      return;
    }
    this.sweep();
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const match = /^\/owner\/([0-9a-f]{32})(\/state|\/account|\/connect|\/sending|\/sent|\/reject)?$/.exec(path);
    const record = match ? this.records.get(match[1]) : undefined;
    const leaf = match?.[2];
    if (!record) {
      if (!leaf && method === "GET") return this.html(res, 404, ownerNotFoundPage());
      return this.json(res, 404, { error: "nothing is waiting under this link" });
    }
    if (!leaf && method === "GET") return this.html(res, 200, ownerApprovalPage(this.facts(record), record.terms));
    if (leaf === "/state" && method === "GET") {
      return this.json(res, 200, {
        status: record.status,
        reason: record.reason,
        message: record.message,
        address: record.address,
        hash: record.hash,
        expiresAt: record.expiresAt,
      });
    }
    if (method !== "POST") return this.json(res, 405, { error: "that route takes a POST" });
    let body: Record<string, unknown>;
    try {
      body = await this.body(req);
    } catch (err) {
      return this.json(res, 400, { error: (err as Error).message });
    }
    const address = typeof body.address === "string" && isAddress(body.address) ? getAddress(body.address) : undefined;

    if (leaf === "/reject") {
      if (!["pending", "ready", "sending"].includes(record.status)) {
        return this.json(res, 409, { error: `this is already ${record.status}`, status: record.status });
      }
      const reason = body.by === "wallet" ? "the owner rejected it in the wallet. Nothing was sent." : "the owner rejected it on the page. Nothing was sent.";
      this.end(record, "rejected", reason);
      return this.json(res, 200, { status: record.status, reason: record.reason });
    }

    if (leaf === "/connect") {
      if (record.kind !== "connect") return this.json(res, 404, { error: "this link is for a transaction, not a connect" });
      if (record.status !== "pending") return this.json(res, 409, { error: `this is already ${record.status}` });
      const signature = typeof body.signature === "string" ? body.signature : "";
      if (!address || !/^0x[0-9a-fA-F]+$/.test(signature)) return this.json(res, 400, { error: "that is not an address and a signature" });
      let valid = false;
      try {
        valid = await verifyMessage({ address, message: signInMessage(record.signIn!, record.id), signature: signature as `0x${string}` });
      } catch {
        valid = false;
      }
      // a wrong signature is a mistake, not a decision: the link stays open
      if (!valid) return this.json(res, 400, { error: `that signature was not made by ${address}; nothing was recorded, and you can sign again` });
      record.address = address;
      record.status = "connected";
      this.audit(record);
      record.resolve({ status: "connected", address });
      return this.json(res, 200, { status: record.status });
    }

    if (record.kind !== "evm-transaction") return this.json(res, 404, { error: "no such route for a connect" });

    if (leaf === "/account") {
      if (record.status !== "pending" && record.status !== "ready") return this.json(res, 409, { error: `this is already ${record.status}` });
      if (!address) return this.json(res, 400, { error: "that is not an account address" });
      if (address !== record.account) {
        record.status = "pending";
        return this.json(res, 403, { error: `this must be sent from ${record.account}, the owner address this budget was set up with. Switch to that account in your wallet and connect again.` });
      }
      record.address = address;
      record.status = "ready";
      this.audit(record);
      return this.json(res, 200, { status: record.status, transaction: record.transaction });
    }

    if (leaf === "/sending") {
      if (record.status !== "ready" || address !== record.address) return this.json(res, 409, { error: "connect the owner account first" });
      record.status = "sending";
      record.sending = true;
      this.audit(record);
      return this.json(res, 200, { status: record.status });
    }

    if (leaf === "/sent") {
      if (record.status !== "sending" || address !== record.address) return this.json(res, 409, { error: `this is ${record.status}; it takes no transaction now` });
      const hash = typeof body.hash === "string" ? body.hash : "";
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return this.json(res, 400, { error: "that is not a transaction hash" });
      record.hash = hash;
      record.status = "sent";
      this.audit(record);
      record.resolve({ status: "sent", address: record.address!, hash });
      return this.json(res, 200, { status: record.status });
    }

    this.json(res, 404, { error: "no such route" });
  }
}
