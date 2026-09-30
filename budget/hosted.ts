// Hosted owner approvals: the owner approves on superstables.com, signed in with their wallet, on any device. The same
// interface as the page on 127.0.0.1 (OwnerApprovalServer.request: { id, url, expiresAt, settled, finish }), so the owner
// commands, detached workers, `wait`, and the APPROVE and RESULT lines work unchanged. EVM only.
//
//   connect           POST /api/v1/budget/links       the owner links this agent to their superstables.com account.
//                                                     Settles as connected, with the account's address, once `linked`.
//   evm-transaction   POST /api/v1/budget/approvals   kind grant, revoke or fund_agent, and the exact transaction. The
//                                                     owner's wallet sends it from the site; settles as sent with the hash
//                                                     on `sent` or `confirmed`. The command still reads the chain itself.
//
// Both are signed by the agent key (agentProof below): the site recovers the address and requires it to equal the agent in
// the headers and the body. The site answers with a request id, an access token (ssbt_...) for polling, the owner's link
// and a match code the owner picks on the page. The token goes to `onRecord` (the approval record, mode 600) and nowhere
// else: never a log line, never the audit file.
//
// The site says who the owner is. Every approval checks it against the owner recorded at setup (`account`): a request
// the site ties to another address is cancelled and refused before the link is shown, and at any later point.
// Once the site reports that the wallet was asked (`wallet_asked`) or a transaction hash exists, an unfinished outcome
// is never "nothing sent": it settles with `sending: true`, and the command reports it as unknown.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { OwnerActionOutcome, OwnerTerms } from "../src/core/signer/owner-approval-server.ts";
import { BUDGET_API, cancelSiteRequest, isSiteRequestId, isSiteToken, readSiteRequest, siteError, siteText } from "./site.mjs";

// ── agent proof ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first line of the text an agent signs for a site request. */
export const AGENT_PROOF_TITLE = "Superstables agent request";

/** SHA-256 of the exact bytes sent as the body, lowercase hex. */
export const bodyHash = (raw: string | Uint8Array) => createHash("sha256").update(typeof raw === "string" ? Buffer.from(raw, "utf8") : raw).digest("hex");

/** The exact text the agent signs: four lines, `\n` separated. `path` has no query. */
export function agentProofText(method: string, path: string, rawBody: string | Uint8Array, timestamp: number): string {
  return `${AGENT_PROOF_TITLE}\n${method.toUpperCase()} ${path}\n${bodyHash(rawBody)}\n${timestamp}`;
}

/** The three agent headers for one request: the address, the unix timestamp in seconds, the EIP-191 personal_sign of the text. */
export async function agentProof(key: Hex, method: string, path: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const account = privateKeyToAccount(key);
  const signature = await account.signMessage({ message: agentProofText(method, path, rawBody, timestamp) });
  return {
    agent: account.address,
    headers: {
      "Superstables-Agent": account.address,
      "Superstables-Agent-Timestamp": String(timestamp),
      "Superstables-Agent-Signature": signature,
    },
  };
}

// ── the client ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedKind = "grant" | "revoke" | "fund_agent";
/** The owner commands hosted approvals cover, by the action name the rails use. Anything else (recover) stays local. */
export const HOSTED_KIND: Record<string, HostedKind> = { grant: "grant", revoke: "revoke", "fund-agent": "fund_agent" };

/** What the approval record keeps (approvals.mjs). The token is the agent's access to this one request. */
export type HostedRecord = { site: string; requestId: string; token: string; kind: "link" | HostedKind; matchCode: string };

export interface HostedSettings {
  /** The site's origin, as recorded at setup (site.mjs siteOrigin). */
  site: string;
  rail: "evm";
  /** The client's chain key, e.g. base-sepolia. */
  chain: string;
  /** The agent key: it signs each request. */
  agentKey: Hex;
  /** Optional label for a link, at most 40 characters. */
  label?: string;
  /** One JSON line per state change here (owner-approvals.jsonl). Never a token or a signature. */
  auditPath?: string;
  /** Called once per request, before the link is announced: store it with the approval (mode 600). */
  onRecord?: (record: HostedRecord) => void;
  /** Seconds per long poll (0 to 20, default 20). */
  pollWaitS?: number;
  /** The least time between two reads of the request (default 1000 ms). */
  minPollMs?: number;
  /** Once the wallet was asked, how long past the expiry to keep reading for a hash (default 120 s). */
  sendingGraceMs?: number;
  fetchImpl?: typeof fetch;
}

export type HostedInput =
  | { kind: "connect"; terms: OwnerTerms; timeoutMs: number }
  | { kind: "evm-transaction"; action: string; terms: OwnerTerms; timeoutMs: number; account: string; transaction: { to: string; data: string; value: string } };

export interface HostedHandle {
  id: string;
  url: string;
  expiresAt: number;
  matchCode: string;
  /** The agent was already linked on this chain: no link, no match code, `settled` is already connected. */
  alreadyLinked?: boolean;
  settled: Promise<OwnerActionOutcome>;
  finish(verdict: { ok: boolean; message: string; hash?: string }): void;
}

/** A request the site did not take: nothing was requested, so nothing can be sent. */
export class HostedRefusal extends Error {
  constructor(message: string, readonly next: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
type Poll = { id: string; token: string; kind: HostedRecord["kind"]; title: string; expected?: string; localDeadline: number; siteExpiry: number; resolve: (o: OwnerActionOutcome) => void };
const FINAL_STATES = new Set(["linked", "confirmed", "failed", "rejected", "expired", "cancelled"]);

export class HostedApprovals {
  private readonly s: HostedSettings;
  private stopped = false;
  /** Requests created here without a final answer yet: close() cancels them. */
  private readonly open = new Map<string, { id: string; token: string }>();
  /** Every request this client created, by id: an idempotent retry answered with duplicate_request keeps polling it. */
  private readonly held = new Map<string, { linked: false; id: string; token: string; url: string; matchCode: string; expiresAt: number }>();

  constructor(settings: HostedSettings) {
    this.s = settings;
  }

  get site(): string {
    return this.s.site;
  }

  /** Create the request on the site and start polling it. Throws HostedRefusal when the site did not take it. */
  async request(input: HostedInput): Promise<HostedHandle> {
    const agent = privateKeyToAccount(this.s.agentKey).address;
    let path: string;
    let body: Record<string, unknown>;
    let kind: HostedRecord["kind"];
    if (input.kind === "connect") {
      path = `${BUDGET_API}/links`;
      kind = "link";
      body = { rail: this.s.rail, chain: this.s.chain, agent, ...(this.s.label ? { label: this.s.label.slice(0, 40) } : {}) };
    } else {
      const k = HOSTED_KIND[input.action];
      if (!k) throw new HostedRefusal(`"${input.action}" has no hosted approval`, "use the approval page on this computer");
      path = `${BUDGET_API}/approvals`;
      kind = k;
      body = { kind: k, rail: this.s.rail, chain: this.s.chain, agent, transaction: input.transaction };
    }
    const answer = await this.create(path, body, kind === "link" ? "bl_" : "ba_");
    if (answer.linked) {
      // already linked on this chain: nothing to show the owner and nothing to wait for; setup checks the owner as usual
      this.audit({ id: answer.id, kind, title: input.terms.title, status: "linked", address: answer.owner });
      return { id: answer.id, url: "", expiresAt: Date.now(), matchCode: "", alreadyLinked: true, settled: Promise.resolve({ status: "connected", address: answer.owner }), finish: () => {} };
    }
    const created = answer;
    const record: HostedRecord = { site: this.s.site, requestId: created.id, token: created.token, kind, matchCode: created.matchCode };
    const expected = input.kind === "evm-transaction" ? getAddress(input.account) : undefined;

    // an approval: the site must act for the owner recorded here, before the owner sees a link
    if (expected) {
      const first = await readSiteRequest({ site: this.s.site, id: created.id, token: created.token, wait: 0, fetchImpl: this.s.fetchImpl });
      const owner = first.ok ? first.view.owner : null;
      if (typeof owner === "string" && !same(owner, expected)) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: `owner mismatch: the site acts for ${owner}` });
        throw new HostedRefusal(
          `superstables.com would ask ${siteText(owner, 42)} to approve this, but the owner recorded on this computer is ${expected}. The request was ${c?.cancelled ? "cancelled" : "left to expire"}; nothing was sent`,
          "check which superstables.com account this agent is linked to (the account page lists it). If the owner changed, run superstables budget setup --rail evm --hosted --new-owner (refused while a budget is live)",
        );
      }
    }
    this.s.onRecord?.(record);

    const now = Date.now();
    const expiresAt = Math.min(now + input.timeoutMs, created.expiresAt);
    this.audit({ id: created.id, kind, title: input.terms.title, status: "awaiting_owner" });
    let resolve!: (o: OwnerActionOutcome) => void;
    const settled = new Promise<OwnerActionOutcome>((done) => {
      let answered = false;
      resolve = (o) => {
        if (answered) return;
        answered = true;
        done(o);
      };
    });
    this.open.set(created.id, { id: created.id, token: created.token });
    void this.poll({ id: created.id, token: created.token, kind, title: input.terms.title, expected, localDeadline: now + input.timeoutMs, siteExpiry: created.expiresAt, resolve }).catch((err: Error) =>
      resolve({ status: "expired", reason: `the command stopped reading the request: ${siteText(err.message)}`, sending: kind !== "link" }),
    );
    return {
      id: created.id,
      url: created.url,
      expiresAt,
      matchCode: created.matchCode,
      settled,
      // the site reads the receipt itself; this only records the command's own verdict locally
      finish: (verdict) => this.audit({ id: created.id, kind, title: input.terms.title, status: verdict.ok ? "confirmed" : "failed", reason: verdict.ok ? undefined : siteText(verdict.message), hash: verdict.hash }),
    };
  }

  /**
   * The command is ending: stop polling, and cancel every request still open on the site (the site refuses once the wallet
   * was asked; such a request then ends on the site by itself).
   */
  async close(): Promise<void> {
    this.stopped = true;
    const open = [...this.open.values()];
    this.open.clear();
    await Promise.all(open.map((o) => cancelSiteRequest({ site: this.s.site, id: o.id, token: o.token, fetchImpl: this.s.fetchImpl }).catch(() => null)));
  }

  private async create(path: string, body: Record<string, unknown>, prefix: string) {
    const raw = JSON.stringify(body);
    const { headers } = await agentProof(this.s.agentKey, "POST", path, raw);
    const idempotency = randomBytes(16).toString("hex");
    const f = this.s.fetchImpl ?? fetch;
    let res: Response | undefined;
    let network = "";
    // one retry on a network error: the idempotency key makes it the same request
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await f(`${this.s.site}${path}`, {
          method: "POST",
          redirect: "error",
          headers: { ...headers, "content-type": "application/json", accept: "application/json", "idempotency-key": idempotency },
          body: raw,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        network = siteText((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
        if (attempt === 0) await sleep(1000);
      }
    }
    if (!res) throw new HostedRefusal(`could not reach ${this.s.site} (${network}); nothing was requested or sent`, `check the network and ${this.s.site}, then run the same command again`);
    let json: any = null;
    try {
      json = await res.json();
    } catch {}
    const code = typeof json?.reason_code === "string" ? json.reason_code : typeof json?.code === "string" ? json.code : typeof json?.error?.code === "string" ? json.error.code : "";
    if (res.status === 409 && code === "duplicate_request") {
      // an idempotent retry of a request the site already created: keep polling it if this client holds it
      const held = typeof json?.id === "string" ? this.held.get(json.id) : undefined;
      if (held) return held;
      throw new HostedRefusal(
        `${this.s.site} already has request ${siteText(json?.id ?? "(no id)", 80)} from an earlier attempt whose answer never arrived here (${siteError(res.status, json)}). Without its link nobody can approve it, and it expires by itself; nothing was sent`,
        "run the same command again after that request expires (10 minutes)",
      );
    }
    if (!res.ok) throw new HostedRefusal(`${this.s.site} did not take the request (${siteError(res.status, json)}); nothing was sent`, res.status >= 500 ? "try again later" : "read reason; fix what it names before trying again");
    // a link that already exists for this agent on this chain: an already-final request, with no link to show
    if (res.status === 200 && prefix === "bl_" && json?.state === "linked" && json?.final === true && !json?.approval) {
      const owner = typeof json.owner === "string" && isAddress(json.owner) ? getAddress(json.owner) : null;
      if (!isSiteRequestId(json.id) || !String(json.id).startsWith(prefix) || !owner) {
        throw new HostedRefusal(`${this.s.site} says this agent is already linked, but its answer has no ${owner ? "request id" : "owner address"}; nothing was recorded or sent`, "try again later");
      }
      return { linked: true as const, id: json.id as string, owner };
    }
    const id = json?.id;
    const token = json?.access_token;
    const url = json?.approval?.url;
    const matchCode = json?.approval?.match_code;
    const expires = Date.parse(json?.approval?.expires_at ?? "");
    let urlOk = false;
    try {
      urlOk = typeof url === "string" && new URL(url).origin === this.s.site;
    } catch {}
    const problem = !isSiteRequestId(id) || !String(id).startsWith(prefix) ? "no request id"
      : !isSiteToken(token) ? "no access token"
      : !urlOk ? "an approval link on another site"
      : typeof matchCode !== "string" || !/^[A-Z0-9]{2,8}(-[A-Z0-9]{2,8}){0,3}$/.test(matchCode) ? "no match code"
      : !Number.isFinite(expires) || expires <= Date.now() ? "no expiry in the future"
      : "";
    if (problem) throw new HostedRefusal(`${this.s.site} answered with ${problem}; the request is not used and nothing was sent`, "try again later");
    const created = { linked: false as const, id: id as string, token: token as string, url: url as string, matchCode: matchCode as string, expiresAt: expires };
    this.held.set(created.id, created);
    return created;
  }

  private async poll(p: Poll) {
    const grace = this.s.sendingGraceMs ?? 120_000;
    const tx = p.kind !== "link";
    const expiry = Math.min(p.localDeadline, p.siteExpiry);
    let walletAsked = false;
    let hash: string | null = null;
    let lastState = "awaiting_owner";
    let lastContact = Date.now();
    let cancelTried = false;
    let readAt = 0;
    const end = (status: "rejected" | "expired", reason: string, sending: boolean) => {
      this.open.delete(p.id);
      this.audit({ id: p.id, kind: p.kind, title: p.title, status, reason, hash: hash ?? undefined, sending: sending || undefined });
      p.resolve({ status, reason, sending });
    };
    const done = (o: OwnerActionOutcome) => {
      this.open.delete(p.id);
      p.resolve(o);
    };
    for (;;) {
      // a long poll that returns at once (wait=0 near the expiry, or a site that does not hold): at most one read a second
      const gap = this.s.minPollMs ?? 1000;
      const since = Date.now() - readAt;
      if (since < gap) await sleep(gap - since);
      if (this.stopped) return end("rejected", "the command stopped before this approval completed; check wallet activity before retrying", tx);
      const now = Date.now();
      // the command's own --timeout came first: cancel on the site, which works only while the wallet was not asked
      if (now >= expiry && !cancelTried && !walletAsked && lastState === "awaiting_owner") {
        cancelTried = true;
        const c = await cancelSiteRequest({ site: this.s.site, id: p.id, token: p.token, fetchImpl: this.s.fetchImpl });
        if (c?.cancelled) return end("expired", "the approval link expired without a completed approval, and the request was cancelled on superstables.com; nothing was sent", false);
        if (c?.walletAsked) walletAsked = true;
      }
      // past the expiry (and, once the wallet was asked, the time for its hash to come back) without a final answer: the
      // request may still be open on the site, so a transaction is never reported as "nothing sent"
      if (now > expiry + (walletAsked ? grace : 30_000)) {
        return end("expired", walletAsked ? "the wallet was asked to send, but no transaction came back from superstables.com" : `no final answer from ${this.s.site} by the time the link expired; the request may still be open there`, tx);
      }
      const waitS = Math.max(0, Math.min(this.s.pollWaitS ?? 20, Math.ceil((expiry - now) / 1000)));
      readAt = Date.now();
      const r = await readSiteRequest({ site: this.s.site, id: p.id, token: p.token, wait: waitS, fetchImpl: this.s.fetchImpl });
      if (!r.ok) {
        if ([401, 403, 404, 410].includes(r.status ?? 0)) return end(tx ? "expired" : "rejected", `${this.s.site} no longer answers for this request (${r.reason})`, tx);
        await sleep(Math.min(5000, 1000 + (Date.now() - lastContact) / 10));
        continue;
      }
      lastContact = Date.now();
      const v = r.view;
      const state = String(v.state);
      if (v.wallet_asked === true || state === "sending") walletAsked = true;
      if (typeof v.tx_hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(v.tx_hash)) {
        hash = v.tx_hash;
        walletAsked = true;
      }
      const owner = typeof v.owner === "string" && isAddress(v.owner) ? getAddress(v.owner) : null;
      const reason = typeof v.reason === "string" && v.reason ? siteText(v.reason) : "";
      if (state !== lastState) {
        lastState = state;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: state, reason: reason || undefined, address: owner ?? undefined, hash: hash ?? undefined, sending: walletAsked || undefined });
      }
      // the site acts for another address than the owner recorded here: refuse. Once a transaction exists, the command
      // reads it from the chain instead, where the other sender is a mismatch.
      if (p.expected && owner && !same(owner, p.expected) && !hash) {
        const c = FINAL_STATES.has(state) ? null : await cancelSiteRequest({ site: this.s.site, id: p.id, token: p.token, fetchImpl: this.s.fetchImpl });
        if (c?.walletAsked) walletAsked = true;
        return end("rejected", `superstables.com acts for ${owner}, not the owner recorded on this computer (${p.expected}); the request was ${c?.cancelled ? "cancelled" : "not used"}`, walletAsked);
      }
      switch (state) {
        case "awaiting_owner":
        case "sending":
          continue;
        case "linked":
          if (tx) break;
          if (!owner) return end("rejected", "superstables.com reported the link without an owner address", false);
          this.audit({ id: p.id, kind: p.kind, title: p.title, status: "connected", address: owner });
          return done({ status: "connected", address: owner });
        case "sent":
        case "confirmed":
        case "failed":
          if (!tx) break;
          if (hash) return done({ status: "sent", address: owner ?? p.expected!, hash });
          if (state === "failed") return end("rejected", reason || "superstables.com reports the transaction failed, without a hash", true);
          continue;
        case "rejected":
          return end("rejected", reason || (walletAsked ? "a rejection was reported after the wallet was asked to send; the chain must be checked" : "the owner rejected the request on superstables.com"), tx && walletAsked);
        case "expired":
          return end("expired", reason || "the approval link expired on superstables.com without a completed approval", tx && walletAsked);
        case "cancelled":
          return end("rejected", reason || "the request was cancelled on superstables.com before the wallet was asked; nothing was sent", tx && walletAsked);
      }
      if (v.final === true) return end("rejected", `superstables.com ended the request in state "${siteText(state, 40)}"${reason ? `: ${reason}` : ""}`, tx);
    }
  }

  private audit(line: { id: string; kind: string; title: string; status: string; reason?: string; address?: string; hash?: string; sending?: boolean }) {
    if (!this.s.auditPath) return;
    try {
      mkdirSync(dirname(this.s.auditPath), { recursive: true, mode: 0o700 });
      appendFileSync(this.s.auditPath, `${JSON.stringify({ at: new Date().toISOString(), site: this.s.site, ...line })}\n`, { mode: 0o600 });
    } catch {
      // an unwritable audit file never stops the owner from deciding
    }
  }
}
