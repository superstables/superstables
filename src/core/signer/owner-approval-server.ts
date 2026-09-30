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
//  5. Once the wallet was asked to send, nothing on the page can turn the outcome into "nothing
//     sent": a later rejection keeps `sending`, and the caller reads the chain.
//
// Three kinds of action:
//   connect              the wallet shares an account and signs a free sign-in message
//   evm-transaction      the wallet sends exactly { to, data, value } from the one allowed account
//   solana-transaction   the wallet signs a transaction the caller builds when the owner presses
//                        Approve; the caller checks the signed bytes and sends them itself
//
// Two wallet families: "evm" (MetaMask or any EIP-1193 wallet; also Tempo) and "solana" (a
// Wallet Standard wallet such as Phantom). This file imports no Solana library: an ed25519
// sign-in is checked with node:crypto, and building, checking and sending a Solana transaction
// is the caller's SolanaTransactionPort.

import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
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

/**
 * How a Solana owner action is built, checked and sent. The server never trusts the wallet with
 * sending: it hands the wallet a transaction the caller built, and gives the caller back what
 * the wallet signed.
 */
export interface SolanaTransactionPort {
  /**
   * A fresh unsigned transaction for the wallet to sign, as base64 wire bytes. Called each time
   * the owner presses Approve, so the blockhash is fresh.
   */
  prepare(): Promise<string>;
  /**
   * Check what the wallet signed (base64 wire bytes) against the last prepared transaction, then
   * send it. Call `broadcasting()` right before the send; if it returns false, send nothing and
   * refuse. "refused" means nothing was sent. "sent" carries the transaction signature, also
   * when the RPC answered with an error after the broadcast: the caller then reads the chain.
   */
  submit(signed: string, broadcasting: () => boolean): Promise<{ status: "sent"; hash: string } | { status: "refused"; reason: string }>;
}

const MAX_BODY_BYTES = 16 * 1024;
const SWEEP_MS = 500;
/** Once the wallet was asked to send, the link stays open this much longer for the hash to come back. */
const DEFAULT_SENDING_GRACE_MS = 120_000;

export type OwnerActionStatus =
  | "pending" // waiting for the owner
  | "ready" // an allowed account is connected (a transaction)
  | "sending" // evm: the page asked the wallet to send. solana: the server is sending what the wallet signed
  | "connected" // connect: the address is proven; waiting for the caller
  | "sent" // the page reported a transaction hash; waiting for the caller
  | "confirmed" // the caller checked the chain: done
  | "failed" // the caller checked the chain: it did not do what was planned
  | "rejected"
  | "expired";

export interface OwnerActionInput {
  kind: "connect" | "evm-transaction" | "solana-transaction";
  chain: OwnerChain;
  terms: OwnerTerms;
  /** A transaction: the only account that may approve it. */
  account?: string;
  /** evm-transaction: exactly what the wallet is asked to send. value is a hex quantity. */
  transaction?: { to: string; data: string; value: string };
  /** solana-transaction: builds, checks and sends the transaction. */
  solana?: SolanaTransactionPort;
  /** connect: the sign-in text. The server adds the approval id and the address to it. */
  signIn?: string;
  /**
   * The owner address the command has on record, shown prominently on the page so a person who
   * is not that owner stops. A transaction defaults to `account`; a first connect has none.
   */
  recordedOwner?: string;
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
  /** Resolves when the owner connected, sent, rejected, or the link expired (or was cancelled). */
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
  /** solana: a signed transaction is being checked or sent; a second one is refused meanwhile. */
  submitting?: boolean;
  resolve: (outcome: OwnerActionOutcome) => void;
}

export interface OwnerApprovalServerOptions {
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Append one JSON line per state change here. Never a signature. */
  auditPath?: string;
  /** How long a link stays open after the wallet was asked to send, for the hash to come back. */
  sendingGraceMs?: number;
}

/** The text a connect asks the wallet to sign. */
export function signInMessage(signIn: string, id: string): string {
  return `${signIn}\n\nApproval id: ${id}\nThis signature grants no spending permission and has no network fee.`;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bytes of a base58 string (Solana addresses), or undefined if it is not base58. */
export function base58Decode(text: string): Uint8Array | undefined {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) return undefined;
  let n = 0n;
  for (const ch of text) n = n * 58n + BigInt(BASE58.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A Solana address: base58 of 32 bytes. */
export function isSolanaAddress(text: unknown): text is string {
  return typeof text === "string" && text.length >= 32 && text.length <= 44 && base58Decode(text)?.length === 32;
}

/** Whether `signature` (64 bytes) is `address`'s ed25519 signature over `message`. */
export function verifyEd25519(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  const key = base58Decode(address);
  if (key?.length !== 32 || signature.length !== 64) return false;
  try {
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") }, format: "jwk" });
    return verifySignature(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

const isSolana = (chain: OwnerChain) => chain.family === "solana";
/** The account in its one canonical spelling, or undefined if it is not an account of this family. */
function accountOf(chain: OwnerChain, value: unknown): string | undefined {
  if (isSolana(chain)) return isSolanaAddress(value) ? value : undefined;
  return typeof value === "string" && isAddress(value) ? getAddress(value) : undefined;
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
    if (input.kind === "evm-transaction" && (isSolana(input.chain) || !input.transaction || !accountOf(input.chain, input.account))) {
      throw new Error("an evm-transaction needs an EVM chain, the transaction and the one account allowed to send it");
    }
    if (input.kind === "solana-transaction" && (!isSolana(input.chain) || !input.solana || !accountOf(input.chain, input.account))) {
      throw new Error("a solana-transaction needs a Solana chain, its port and the one account allowed to sign it");
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
      account: input.account ? accountOf(input.chain, input.account) : undefined,
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
      this.end(record, "rejected", "the command stopped before this approval completed; check wallet activity before retrying");
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
        if (record.expiresAt <= now) this.end(record, "expired", `the approval link expired after ${Math.round(record.timeoutMs / 1000)} seconds without a completed approval`);
      } else if (record.status === "sending" && record.expiresAt + (this.options.sendingGraceMs ?? DEFAULT_SENDING_GRACE_MS) <= now) {
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
      // whether the wallet had been asked to send: a later reader must not call this "nothing sent"
      sending: record.sending || undefined,
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
      chainIdHex: isSolana(record.chain) ? "" : `0x${record.chain.chainId.toString(16)}`,
      account: record.account,
      recordedOwner: record.recordedOwner ?? record.account,
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
    const match = /^\/owner\/([0-9a-f]{32})(\/state|\/account|\/connect|\/sending|\/sent|\/prepare|\/signed|\/reject|\/cancel)?$/.exec(path);
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
    // CSRF defenses for every state-changing route: the request must come from this page's own
    // origin (exactly http://<the Host checked above>) and carry a JSON body, which a cross-site
    // form or a "simple" cross-origin request cannot. These stop other web pages in the owner's
    // browser. They are not human authentication: any local process that holds the link can set
    // these headers. Nothing here trusts the page with the outcome: the chain decides that.
    const origin = String(req.headers.origin ?? "");
    if (origin !== `http://${host}`) return this.json(res, 403, { error: "this route answers only to the approval page itself" });
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      return this.json(res, 415, { error: "send JSON (content-type: application/json)" });
    }
    let body: Record<string, unknown>;
    try {
      body = await this.body(req);
    } catch (err) {
      return this.json(res, 400, { error: (err as Error).message });
    }
    const address = accountOf(record.chain, body.address);

    if (leaf === "/reject") {
      if (!["pending", "ready", "sending"].includes(record.status)) {
        return this.json(res, 409, { error: `this is already ${record.status}`, status: record.status });
      }
      // solana: once the server is sending what the wallet signed, there is nothing left to reject
      if (record.kind === "solana-transaction" && (record.status === "sending" || record.submitting)) {
        return this.json(res, 409, { error: "this is being sent already", status: record.status });
      }
      // Once the wallet was asked to send, a rejection reported through this page cannot prove that
      // nothing was sent: anyone holding the link can post it, and a wallet popup may still be open.
      // `sending` stays true, so the caller reports the outcome as unknown until the chain says otherwise.
      const reason = record.sending
        ? "a rejection was reported after the wallet was asked to send; the page cannot prove nothing was submitted, so the chain must be checked"
        : body.by === "wallet"
          ? "the wallet reported a rejection before it was asked to send"
          : "the request was rejected on the page; cancel any open wallet request and check wallet activity";
      this.end(record, "rejected", reason);
      return this.json(res, 200, { status: record.status, reason: record.reason });
    }

    if (leaf === "/cancel") {
      // The command's own replacement (superstables budget ... --replace) asks first. One step,
      // so it cannot interleave with /sending or /signed: either the wallet was never asked and
      // this link ends now, or the answer is 409 and the old approval stays as it is.
      const asked = record.sending || record.submitting || !["pending", "ready"].includes(record.status);
      if (asked) return this.json(res, 409, { cancelled: false, status: record.status, sending: record.sending, error: "the wallet may already have been asked; this approval is not cancelled" });
      const by = typeof body.replacedBy === "string" && /^oa-\d{14}-[0-9a-f]{8}$/.test(body.replacedBy) ? body.replacedBy : undefined;
      this.end(record, "rejected", `${by ? `replaced by ${by}: ` : ""}cancelled by the command before the wallet was asked; nothing was sent`);
      return this.json(res, 200, { cancelled: true, status: record.status });
    }

    if (leaf === "/connect") {
      if (record.kind !== "connect") return this.json(res, 404, { error: "this link is for a transaction, not a connect" });
      if (record.status !== "pending") return this.json(res, 409, { error: `this is already ${record.status}` });
      const signature = typeof body.signature === "string" ? body.signature : "";
      const message = signInMessage(record.signIn!, record.id);
      let valid = false;
      if (isSolana(record.chain)) {
        // Wallet Standard solana:signMessage: base64 of the signed bytes and of the 64-byte signature
        const signed = typeof body.signedMessage === "string" ? Buffer.from(body.signedMessage, "base64") : Buffer.alloc(0);
        if (!address || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return this.json(res, 400, { error: "that is not an address and a signature" });
        if (!signed.equals(Buffer.from(message, "utf8"))) return this.json(res, 400, { error: "the wallet signed a different message; nothing was recorded, and you can sign again" });
        valid = verifyEd25519(address, signed, Buffer.from(signature, "base64"));
      } else {
        if (!address || !/^0x[0-9a-fA-F]+$/.test(signature)) return this.json(res, 400, { error: "that is not an address and a signature" });
        try {
          valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
        } catch {
          valid = false;
        }
      }
      // a wrong signature is a mistake, not a decision: the link stays open
      if (!valid) return this.json(res, 400, { error: `that signature was not made by ${address}; nothing was recorded, and you can sign again` });
      record.address = address;
      record.status = "connected";
      this.audit(record);
      record.resolve({ status: "connected", address });
      return this.json(res, 200, { status: record.status });
    }

    if (record.kind === "connect") return this.json(res, 404, { error: "no such route for a connect" });

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

    if (record.kind === "solana-transaction") return this.solanaRoute(record, leaf, address, body, res);

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

  /** /prepare and /signed: the server builds on each Approve, the wallet only signs, the caller checks and sends. */
  private async solanaRoute(record: OwnerRecord, leaf: string | undefined, address: string | undefined, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const port = record.solana!;
    if (leaf !== "/prepare" && leaf !== "/signed") return this.json(res, 404, { error: "no such route for a Solana transaction" });
    if (record.status !== "ready" || address !== record.address) return this.json(res, 409, { error: record.status === "ready" ? "connect the owner account first" : `this is ${record.status}; it takes no transaction now` });
    if (record.submitting) return this.json(res, 409, { error: "a signed transaction is being checked already" });

    if (leaf === "/prepare") {
      try {
        return this.json(res, 200, { status: record.status, transaction: await port.prepare() });
      } catch (err) {
        return this.json(res, 502, { error: `the command could not build the transaction: ${(err as Error).message}` });
      }
    }

    const signed = typeof body.signedTransaction === "string" ? body.signedTransaction : "";
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signed)) return this.json(res, 400, { error: "that is not a signed transaction" });
    record.submitting = true;
    let result: Awaited<ReturnType<SolanaTransactionPort["submit"]>>;
    try {
      result = await port.submit(signed, () => {
        // the link may have expired while the wallet was signing: then nothing is sent
        if (record.status !== "ready") return false;
        record.status = "sending";
        record.sending = true;
        this.audit(record);
        return true;
      });
    } catch (err) {
      record.submitting = false;
      if (record.sending) {
        // it may have gone out: the caller must read the chain before anything is tried again
        this.end(record, "expired", `the command stopped tracking the transaction after sending it (${(err as Error).message})`);
        return this.json(res, 502, { error: "the transaction may have been submitted; check the command result and chain before retrying", status: record.status });
      }
      result = { status: "refused", reason: `the command could not check it: ${(err as Error).message}.` };
    } finally {
      record.submitting = false;
    }
    if (result.status === "refused") {
      // broadcasting() may have moved it to sending; the port says nothing went out, so the owner can try again
      const wasSending = (record.status as OwnerActionStatus) === "sending";
      if (wasSending) record.status = "ready";
      record.sending = false;
      if (wasSending) this.audit(record);
      return this.json(res, 409, { error: `${result.reason} Nothing was sent.`, status: record.status });
    }
    record.hash = result.hash;
    record.status = "sent";
    this.audit(record);
    record.resolve({ status: "sent", address: record.address!, hash: result.hash });
    return this.json(res, 200, { status: record.status, hash: result.hash });
  }
}
