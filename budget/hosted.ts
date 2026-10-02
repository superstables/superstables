// Hosted owner approvals: the owner approves on superstables.com, signed in with their wallet, on any device. The same
// interface as the page on 127.0.0.1 (OwnerApprovalServer.request: { id, url, expiresAt, settled, finish }), so the owner
// commands, detached workers, `wait`, and the APPROVE and RESULT lines work unchanged. Rails: evm, tempo (moderato) and
// solana (devnet).
//
//   connect           POST /api/v1/budget/links       the owner links this agent to their superstables.com account.
//                                                     Settles as connected, with the account's address, once `linked`.
//   evm-transaction   POST /api/v1/budget/approvals   kind grant, revoke or fund_agent, and the exact transaction (evm and
//                                                     tempo). The owner's wallet sends it from the site; settles as sent
//                                                     with the hash on `sent` or `confirmed`. The command still reads the
//                                                     chain itself.
//   solana-intent     POST /api/v1/budget/approvals   kind grant, revoke or fund_agent, and the amount only (solana): a
//                                                     Solana transaction expires within a minute, so the site builds it
//                                                     when the owner is ready, the owner's wallet signs it and the site
//                                                     sends it. Settles as sent with the signature.
//   connect + then    POST /api/v1/budget/links       the link, then on the same page up to two wallet steps (fund_agent,
//                                                     grant), in that order. `bundle` settles once the link and every step
//                                                     are final, with each step's state and hash; the command reads each
//                                                     transaction from the chain itself. An agent already linked on the
//                                                     chain is refused (409 already_linked): its steps go one by one.
//
// Both are signed by the agent key (agentProof below): EIP-191 for an EVM key (evm, tempo), ed25519 for a Solana key. The
// site checks the signature and requires the signer to equal the agent in the headers and the body. The site answers with
// a request id, an access token (ssbt_...) for polling, the owner's link and a match code the owner picks on the page.
// The token goes to `onRecord` (the approval record, mode 600) and nowhere else: never a log line, never the audit file.
//
// The site says who the owner is. Every approval checks it against the owner recorded at setup (`account`): a request
// the site ties to another address is cancelled and refused before the link is shown, and at any later point.
// Once the site reports that the wallet was asked (`wallet_asked`) or a transaction hash exists, an unfinished outcome
// is never "nothing sent": it settles with `sending: true`, and the command reports it as unknown.
import { createHash, createPrivateKey, randomBytes, sign as signBytes } from "node:crypto";
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

/** A Solana agent key: the 64-byte secret (seed, then public key) and its base58 address. */
export type SolanaAgentKey = { ed25519: Uint8Array; address: string };
/** The key that signs the site requests: an EVM private key (evm, tempo), or a Solana key. */
export type AgentKey = Hex | SolanaAgentKey;
const isSolanaKey = (k: AgentKey): k is SolanaAgentKey => typeof k === "object" && k !== null;
/** The agent's address as the site knows it: 0x... (EVM) or base58 (Solana). */
export const agentAddressOf = (k: AgentKey): string => (isSolanaKey(k) ? k.address : privateKeyToAccount(k).address);

/** An ed25519 signature over `message` by a Solana secret key, 0x + 128 hex. */
function ed25519Sign(k: SolanaAgentKey, message: string): string {
  if (k.ed25519.length !== 64) throw new Error("a Solana agent key is 64 bytes");
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64(k.ed25519.subarray(0, 32)), x: b64(k.ed25519.subarray(32)) }, format: "jwk" });
  return `0x${signBytes(null, Buffer.from(message, "utf8"), key).toString("hex")}`;
}

/**
 * The three agent headers for one request: the address, the unix timestamp in seconds, and the signature of the text:
 * EIP-191 personal_sign for an EVM key, ed25519 over the text's UTF-8 bytes (0x + 128 hex) for a Solana key.
 */
export async function agentProof(key: AgentKey, method: string, path: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const text = agentProofText(method, path, rawBody, timestamp);
  const agent = agentAddressOf(key);
  const signature = isSolanaKey(key) ? ed25519Sign(key, text) : await privateKeyToAccount(key).signMessage({ message: text });
  return {
    agent,
    headers: {
      "Superstables-Agent": agent,
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
export type HostedRecord = { site: string; requestId: string; token: string; kind: "link" | HostedKind; matchCode: string; /** a link with wallet steps: their kinds, in order */ then?: HostedStep["kind"][] };
export type HostedRail = "evm" | "tempo" | "solana";

export interface HostedSettings {
  /** The site's origin, as recorded at setup (site.mjs siteOrigin). */
  site: string;
  rail: HostedRail;
  /** The client's chain key, e.g. base-sepolia, moderato or devnet. */
  chain: string;
  /** The agent key: it signs each request. */
  agentKey: AgentKey;
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

/**
 * A wallet step that follows the link on the same page (`then`), validated by the site like an approval: the exact
 * transaction (evm, tempo), or on solana the amount (USDC atomic for a grant, lamports for fund_agent).
 */
export type HostedStep = { kind: "fund_agent" | "grant"; transaction?: { to: string; data: string; value: string }; solana?: { amount_atomic: string } };

/** What became of one step, as the site reports it. The command reads the chain before it believes any of it. */
export interface HostedStepOutcome {
  kind: HostedStep["kind"];
  /** queued, awaiting_owner, sending, sent, confirmed, failed, rejected, expired, unknown, skipped; or "stopped" when the command stopped reading. */
  state: string;
  hash: string | null;
  reason: string;
  reasonCode: string | null;
  /** The owner's wallet was asked to send it (or a hash exists): never "nothing sent". */
  walletAsked: boolean;
}

/** The link and its steps, once all of them are final (or the command stopped reading). */
export interface HostedBundleOutcome {
  link: OwnerActionOutcome;
  steps: HostedStepOutcome[];
}

export type HostedInput =
  | { kind: "connect"; terms: OwnerTerms; timeoutMs: number; then?: HostedStep[] }
  | { kind: "evm-transaction"; action: string; terms: OwnerTerms; timeoutMs: number; account: string; transaction: { to: string; data: string; value: string } }
  | { kind: "solana-intent"; action: string; terms: OwnerTerms; timeoutMs: number; account: string; solana: { amount_atomic?: string } };

export interface HostedHandle {
  id: string;
  url: string;
  expiresAt: number;
  matchCode: string;
  /** The agent was already linked on this chain: no link, no match code, `settled` is already connected. */
  alreadyLinked?: boolean;
  settled: Promise<OwnerActionOutcome>;
  /** A link with steps (`then`): settles once the link and every step are final. `settled` then settles at the same time. */
  bundle?: Promise<HostedBundleOutcome>;
  finish(verdict: { ok: boolean; message: string; hash?: string }): void;
}

/** A request the site did not take: nothing was requested, so nothing can be sent. */
export class HostedRefusal extends Error {
  constructor(message: string, readonly next: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/**
 * How a rail spells an owner and a transaction id. EVM addresses compare without case; Solana's base58 is case-sensitive.
 * owner(): the site's owner in its one spelling, or null when it is not an address of this rail.
 */
function railWords(rail: HostedRail) {
  const solana = rail === "solana";
  return {
    owner: (v: unknown): string | null => (solana ? (typeof v === "string" && SOLANA_ADDRESS.test(v) ? v : null) : typeof v === "string" && isAddress(v) ? getAddress(v) : null),
    same: (a?: string | null, b?: string | null) => !!a && !!b && (solana ? a === b : a.toLowerCase() === b.toLowerCase()),
    isTx: (h: unknown): h is string => typeof h === "string" && (solana ? SOLANA_SIGNATURE.test(h) : /^0x[0-9a-fA-F]{64}$/.test(h)),
  };
}
type Poll = { id: string; token: string; kind: HostedRecord["kind"]; title: string; expected?: string; localDeadline: number; siteExpiry: number; resolve: (o: OwnerActionOutcome) => void };
const FINAL_STATES = new Set(["linked", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown"]);
const STEP_FINAL = new Set(["confirmed", "failed", "rejected", "expired", "unknown", "skipped", "cancelled"]);
/** The rail and chain flags of a command: no --chain on a rail's default chain. */
const railFlags = (rail: HostedRail, chain: string) => (rail === "evm" ? `--rail evm${chain === "base-sepolia" ? "" : ` --chain ${chain}`}` : `--rail ${rail}`);

export class HostedApprovals {
  private readonly s: HostedSettings;
  private stopped = false;
  /** Requests created here without a final answer yet: close() cancels them. */
  private readonly open = new Map<string, { id: string; token: string }>();
  /** Every request this client created, by id: a retry answered with duplicate_request or proof_reused keeps polling it. */
  private readonly held = new Map<string, { linked: false; id: string; token: string; url: string; matchCode: string; expiresAt: number; steps?: unknown[] }>();

  private readonly w: ReturnType<typeof railWords>;

  constructor(settings: HostedSettings) {
    this.s = settings;
    this.w = railWords(settings.rail);
  }

  get site(): string {
    return this.s.site;
  }

  /** Create the request on the site and start polling it. Throws HostedRefusal when the site did not take it. */
  async request(input: HostedInput): Promise<HostedHandle> {
    const agent = agentAddressOf(this.s.agentKey);
    let path: string;
    let body: Record<string, unknown>;
    let kind: HostedRecord["kind"];
    const then = input.kind === "connect" && input.then?.length ? input.then : undefined;
    if (input.kind === "connect") {
      path = `${BUDGET_API}/links`;
      kind = "link";
      body = { rail: this.s.rail, chain: this.s.chain, agent, ...(this.s.label ? { label: this.s.label.slice(0, 40) } : {}), ...(then ? { then } : {}) };
    } else {
      const k = HOSTED_KIND[input.action];
      if (!k) throw new HostedRefusal(`"${input.action}" has no hosted approval`, "use the approval page on this computer");
      path = `${BUDGET_API}/approvals`;
      kind = k;
      body = { kind: k, rail: this.s.rail, chain: this.s.chain, agent, ...(input.kind === "solana-intent" ? { solana: input.solana } : { transaction: input.transaction }) };
    }
    const answer = await this.create(path, body, kind === "link" ? "bl_" : "ba_");
    if (answer.linked && then) {
      // the site must refuse a link with steps for an agent it already linked (409); a 200 here would skip every step
      throw new HostedRefusal(alreadyLinkedWords(this.s.site, answer.owner, this.s.rail), alreadyLinkedNext(this.s.rail, this.s.chain));
    }
    if (answer.linked) {
      // already linked on this chain: nothing to show the owner and nothing to wait for; setup checks the owner as usual
      this.audit({ id: answer.id, kind, title: input.terms.title, status: "linked", address: answer.owner });
      return { id: answer.id, url: "", expiresAt: Date.now(), matchCode: "", alreadyLinked: true, settled: Promise.resolve({ status: "connected", address: answer.owner }), finish: () => {} };
    }
    const created = answer;
    if (then) {
      // the steps the site will ask the owner's wallet for must be exactly the ones sent, in the same order
      const problem = stepsProblem(then, created.steps);
      if (problem) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        throw new HostedRefusal(`${this.s.site} answered with steps other than the ones asked for (${problem}). The request was ${c?.cancelled ? "cancelled" : "left to expire"}; nothing was sent`, "try again later");
      }
    }
    const record: HostedRecord = { site: this.s.site, requestId: created.id, token: created.token, kind, matchCode: created.matchCode, ...(then ? { then: then.map((t) => t.kind) } : {}) };
    const expected = input.kind === "connect" ? undefined : this.w.owner(input.account) ?? input.account;

    // an approval: the site must act for the owner recorded here, before the owner sees a link
    if (expected) {
      const first = await readSiteRequest({ site: this.s.site, id: created.id, token: created.token, wait: 0, fetchImpl: this.s.fetchImpl });
      const owner = first.ok ? first.view.owner : null;
      if (typeof owner === "string" && !this.w.same(owner, expected)) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: `owner mismatch: the site acts for ${owner}` });
        throw new HostedRefusal(
          `superstables.com would ask ${siteText(owner, 44)} to approve this, but the owner recorded on this computer is ${expected}. The request was ${c?.cancelled ? "cancelled" : "left to expire"}; nothing was sent`,
          `check which superstables.com account this agent is linked to (the account page lists it). If the owner changed, run superstables budget setup ${railFlags(this.s.rail, this.s.chain)} --hosted --new-owner (refused while a budget is live)`,
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
    if (then) {
      let settle!: (b: HostedBundleOutcome) => void;
      const bundle = new Promise<HostedBundleOutcome>((done) => (settle = done));
      const base = { id: created.id, token: created.token, kind, title: input.terms.title, localDeadline: now + input.timeoutMs, siteExpiry: created.expiresAt, resolve };
      const kinds = then.map((t) => t.kind);
      void this.pollBundle({ ...base, timeoutMs: input.timeoutMs, kinds, settle }).catch((err: Error) => {
        const reason = `the command stopped reading the request: ${siteText(err.message)}`;
        const out: HostedBundleOutcome = { link: { status: "expired", reason, sending: true }, steps: kinds.map((k) => ({ kind: k, state: "stopped", hash: null, reason, reasonCode: null, walletAsked: true })) };
        resolve(out.link);
        settle(out);
      });
      return {
        id: created.id,
        url: created.url,
        expiresAt,
        matchCode: created.matchCode,
        settled,
        bundle,
        finish: (verdict) => this.audit({ id: created.id, kind, title: input.terms.title, status: verdict.ok ? "confirmed" : "failed", reason: verdict.ok ? undefined : siteText(verdict.message), hash: verdict.hash }),
      };
    }
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
    // One retry on a network error, with the same proof, key and body: if the first attempt reached the site, the site
    // answers 409 proof_reused (or duplicate_request) with its id instead of creating a second request. Both are handled
    // below: this client holds no token for a request whose answer it never received, so it refuses with guidance.
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
    if (!res) throw new HostedRefusal(`could not reach ${this.s.site} (${network}); nothing was sent. If an attempt did reach it, that request cannot be approved without its link and expires by itself in 10 minutes`, `check the network and ${this.s.site}, then run the same command again`);
    let json: any = null;
    try {
      json = await res.json();
    } catch {}
    const code = typeof json?.reason_code === "string" ? json.reason_code : typeof json?.code === "string" ? json.code : typeof json?.error?.code === "string" ? json.error.code : "";
    if (res.status === 409 && (code === "duplicate_request" || code === "proof_reused")) {
      // a retry of a request the site already created (same key and body, or the same signed proof): keep polling it
      // if this client holds it; otherwise nobody here has its link or token
      const held = typeof json?.id === "string" ? this.held.get(json.id) : undefined;
      if (held) return held;
      const what = code === "proof_reused" ? "with the same signed proof" : "with the same request key";
      throw new HostedRefusal(
        `${this.s.site} already has request ${siteText(json?.id ?? "(no id)", 80)}${typeof json?.state === "string" ? ` (${siteText(json.state, 30)})` : ""}, created ${what} by an earlier attempt whose answer never arrived here (${siteError(res.status, json)}). It cannot be approved without its link, which only that answer carried; it expires by itself in 10 minutes, and the owner can see it on their superstables.com account page. Nothing was sent`,
        "run the same command again after that request expires (10 minutes)",
      );
    }
    if (res.status === 409 && code === "already_linked") {
      // a link with steps for an agent already linked on this chain: nothing was created; gas and a budget go one by one
      const owner = this.w.owner(json?.error?.owner) ?? this.w.owner(json?.owner);
      throw new HostedRefusal(alreadyLinkedWords(this.s.site, owner, this.s.rail), alreadyLinkedNext(this.s.rail, this.s.chain));
    }
    if (!res.ok) throw new HostedRefusal(`${this.s.site} did not take the request (${siteError(res.status, json)}); nothing was sent`, res.status >= 500 ? "try again later" : "read reason; fix what it names before trying again");
    // a link that already exists for this agent on this chain: an already-final request, with no link to show
    if (res.status === 200 && prefix === "bl_" && json?.state === "linked" && json?.final === true && !json?.approval) {
      const owner = this.w.owner(json.owner);
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
    const created = { linked: false as const, id: id as string, token: token as string, url: url as string, matchCode: matchCode as string, expiresAt: expires, steps: Array.isArray(json?.steps) ? (json.steps as unknown[]) : undefined };
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
      if (this.w.isTx(v.tx_hash)) {
        hash = v.tx_hash;
        walletAsked = true;
      }
      const owner = this.w.owner(v.owner);
      const reason = typeof v.reason === "string" && v.reason ? siteText(v.reason) : "";
      if (state !== lastState) {
        lastState = state;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: state, reason: reason || undefined, address: owner ?? undefined, hash: hash ?? undefined, sending: walletAsked || undefined });
      }
      // the site acts for another address than the owner recorded here: refuse. Once a transaction exists, the command
      // reads it from the chain instead, where the other sender is a mismatch.
      if (p.expected && owner && !this.w.same(owner, p.expected) && !hash) {
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
        case "unknown":
          // the site cannot tell whether the wallet sent it: never "nothing sent"; the command reads the chain
          if (hash && tx) return done({ status: "sent", address: owner ?? p.expected!, hash });
          return end("expired", reason || "superstables.com cannot tell whether the wallet sent the transaction; the chain must be checked", true);
      }
      if (v.final === true) return end("rejected", `superstables.com ended the request in state "${siteText(state, 40)}"${reason ? `: ${reason}` : ""}`, tx);
    }
  }

  /**
   * A link with steps: read until the site says the link and every step are final. Before the link is done the request
   * expires like a link; once it is done, the steps get the command's own --timeout again, from that moment, and a step
   * the wallet was asked for gets the send grace on top. Whatever is not final then is reported as it stands, and a step
   * the wallet was asked for is never "nothing sent".
   */
  private async pollBundle(p: Omit<Poll, "expected"> & { timeoutMs: number; kinds: HostedStep["kind"][]; settle: (b: HostedBundleOutcome) => void }) {
    const grace = this.s.sendingGraceMs ?? 120_000;
    const steps: HostedStepOutcome[] = p.kinds.map((kind) => ({ kind, state: "queued", hash: null, reason: "", reasonCode: null, walletAsked: false }));
    let owner: string | null = null;
    let linkedAt = 0;
    let linkState = "awaiting_owner";
    let linkReason = "";
    let lastState = "awaiting_owner";
    let lastContact = Date.now();
    let cancelTried = false;
    let readAt = 0;
    const asked = () => steps.some((s) => s.walletAsked);
    /** The site's word on each step (a read, or the answer to a cancel). */
    const absorb = (seen: any[]) =>
      steps.forEach((s, i) => {
        const w = seen.find((x) => x && x.index === i) ?? seen[i];
        if (!w || w.kind !== s.kind) return;
        const before = s.state;
        s.state = typeof w.state === "string" ? siteText(w.state, 40) : s.state;
        if (this.w.isTx(w.tx_hash)) s.hash = w.tx_hash;
        if (w.wallet_asked === true || s.state === "sending" || s.hash) s.walletAsked = true;
        s.reason = typeof w.reason === "string" ? siteText(w.reason) : s.reason;
        s.reasonCode = typeof w.reason_code === "string" ? siteText(w.reason_code, 60) : s.reasonCode;
        if (s.state !== before) this.audit({ id: p.id, kind: s.kind, title: p.title, status: s.state, reason: s.reason || undefined, hash: s.hash ?? undefined, sending: s.walletAsked || undefined });
      });
    const finish = (why: string | null) => {
      this.open.delete(p.id);
      // a step without a final state: as it stands, never "nothing sent" once the wallet was asked
      for (const s of steps) {
        if (STEP_FINAL.has(s.state)) continue;
        if (s.hash) continue; // sent: the command reads it from the chain
        if (s.walletAsked) Object.assign(s, { state: "unknown", reason: s.reason || why || "the wallet was asked to send, but no transaction came back from superstables.com" });
        // linked, and the site did not confirm the step closed: it can still hand it to the owner's wallet, so it is
        // never "nothing sent" here
        else if (owner) Object.assign(s, { state: "unknown", reason: `the command stopped watching while ${this.s.site} could still ask the owner's wallet for this step, and withdrawing it did not succeed${why ? ` (${why})` : ""}; it may still be sent, so read the chain later` });
        else Object.assign(s, { state: "skipped", reason: s.reason || why || "the agent was not linked, so this step was never asked" });
      }
      const link: OwnerActionOutcome = owner
        ? { status: "connected", address: owner }
        : linkState === "expired" || why
          ? { status: "expired", reason: linkReason || why || "the approval link expired on superstables.com without a completed approval", sending: false }
          : { status: "rejected", reason: linkReason || (linkState === "cancelled" ? "the request was cancelled on superstables.com; nothing was sent" : "the owner rejected the request on superstables.com"), sending: false };
      this.audit({ id: p.id, kind: p.kind, title: p.title, status: owner ? "connected" : link.status, address: owner ?? undefined, reason: owner ? undefined : (link as { reason?: string }).reason });
      for (const s of steps) this.audit({ id: p.id, kind: s.kind, title: p.title, status: s.state, reason: s.reason || undefined, hash: s.hash ?? undefined, sending: s.walletAsked || undefined });
      p.resolve(link);
      p.settle({ link, steps });
    };
    for (;;) {
      const gap = this.s.minPollMs ?? 1000;
      const since = Date.now() - readAt;
      if (since < gap) await sleep(gap - since);
      if (this.stopped) return finish("the command stopped before this request completed; check wallet activity before retrying");
      const now = Date.now();
      // before the link: the link's expiry. After it: --timeout again for the steps, from the moment it was linked.
      const deadline = linkedAt ? Math.max(Math.min(p.localDeadline, p.siteExpiry), linkedAt + p.timeoutMs) : Math.min(p.localDeadline, p.siteExpiry);
      // Once linked, the steps the wallet was not asked for are withdrawn on the site (the ones it was asked for stay,
      // as possibly sent): only the site's answer makes a step "nothing sent".
      if (now >= deadline && !cancelTried && (owner || !asked())) {
        cancelTried = true;
        const c = await cancelSiteRequest({ site: this.s.site, id: p.id, token: p.token, fetchImpl: this.s.fetchImpl });
        if (owner) {
          if (Array.isArray(c?.view?.steps)) {
            absorb(c.view.steps);
            if (c.view.final === true) return finish(null);
          }
          // a step still with the wallet, or no answer: read on until the grace below
        } else if (c?.cancelled) {
          linkState = "expired";
          return finish("the approval link expired without a completed approval, and the request was cancelled on superstables.com; nothing was sent");
        }
        if (c?.walletAsked) for (const s of steps) if (!STEP_FINAL.has(s.state) && s.state !== "queued") s.walletAsked = true;
      }
      if (now > deadline + (asked() ? grace : 30_000)) return finish(`no final answer from ${this.s.site} in time; the request may still be open there`);
      const waitS = Math.max(0, Math.min(this.s.pollWaitS ?? 20, Math.ceil((deadline - now) / 1000)));
      readAt = Date.now();
      const r = await readSiteRequest({ site: this.s.site, id: p.id, token: p.token, wait: waitS, fetchImpl: this.s.fetchImpl });
      if (!r.ok) {
        if ([401, 403, 404, 410].includes(r.status ?? 0)) return finish(`${this.s.site} no longer answers for this request (${r.reason})`);
        await sleep(Math.min(5000, 1000 + (Date.now() - lastContact) / 10));
        continue;
      }
      lastContact = Date.now();
      const v = r.view;
      const state = String(v.state);
      const reason = typeof v.reason === "string" && v.reason ? siteText(v.reason) : "";
      if (!owner && this.w.owner(v.owner)) {
        owner = this.w.owner(v.owner);
        linkedAt = Date.now();
      }
      if (!owner) {
        linkState = state;
        linkReason = reason;
      }
      absorb(Array.isArray(v.steps) ? (v.steps as any[]) : []);
      if (state !== lastState) {
        lastState = state;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: state, reason: reason || undefined, address: owner ?? undefined });
      }
      if (v.final === true) {
        if (!owner && state === "linked") linkReason = "superstables.com reported the link without an owner address";
        return finish(null);
      }
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

/** The words for an agent already linked on this chain, when a link with steps was asked for. */
function alreadyLinkedWords(site: string, owner: string | null, rail: HostedRail): string {
  return `this agent is already linked on ${site}${owner ? ` to the account ${owner}` : ""}, so there is nothing to link and no request was created. ${rail === "tempo" ? "A budget is then asked for separately, with its own link" : "Gas and a budget are then asked for separately, each with its own link"}; nothing was sent`;
}
function alreadyLinkedNext(rail: HostedRail, chain: string): string {
  const r = railFlags(rail, chain);
  const steps = rail === "tempo"
    ? `A budget is a separate owner step: superstables budget grant ${r} --amount A (one link)`
    : `Gas and a budget are separate owner steps: superstables budget fund-agent ${r}, then superstables budget grant ${r} --amount A (each one link)`;
  return `tell the owner this agent is already linked and end your turn. ${steps}. If this computer has no owner on record yet, superstables budget setup ${r} --hosted without ${rail === "tempo" ? "--grant" : "--grant and --fund"} records it, with no link`;
}

/** Why the site's steps are not the ones asked for, or "" when they are (same kinds, order and transactions or amounts). */
function stepsProblem(sent: HostedStep[], got: unknown[] | undefined): string {
  if (!Array.isArray(got)) return "no steps";
  if (got.length !== sent.length) return `${got.length} steps instead of ${sent.length}`;
  const low = (x: unknown) => String(x ?? "").toLowerCase();
  for (let i = 0; i < sent.length; i++) {
    const g = got[i] as any;
    if (!g || g.kind !== sent[i].kind) return `step ${i} is ${siteText(g?.kind ?? "missing", 40)}, not ${sent[i].kind}`;
    const want = sent[i];
    if (want.solana) {
      // solana: the site builds the transaction later; the amount it echoes must be the one asked for
      const amount = g.solana?.amount_atomic;
      if (amount !== undefined && String(amount) !== want.solana.amount_atomic) return `step ${i} (${want.kind}) has another amount`;
      continue;
    }
    const t = g.transaction;
    if (!t || !want.transaction) continue;
    let value: bigint | null = null;
    try { value = BigInt(t.value ?? "0x0"); } catch {}
    if (low(t.to) !== low(want.transaction.to) || low(t.data ?? "0x") !== low(want.transaction.data) || value !== BigInt(want.transaction.value)) return `step ${i} (${want.kind}) has another transaction`;
  }
  return "";
}
