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
// Both are signed by the agent key (agentProof below, proof v2): EIP-191 for an EVM key (evm, tempo), ed25519 for a Solana
// key, over a text that names the site's origin and a fresh nonce, so a request signed for one site cannot be replayed to
// another, or twice. The site checks the signature and requires the signer to equal the agent in the headers and the body.
// The site answers with a request id, an access token (ssbt_...) for polling, the owner's link and a match code the owner
// picks on the page. The link is used only as https://<site>/approve/budget/<that id>#<token>, re-serialized, never as the
// site's raw text. The token goes to `onRecord` (the approval record, mode 600) and nowhere else: never a log line, never
// the audit file.
//
// The site does not decide the owner alone. An added agent is recorded only with the owner's own signature over the
// add-agent request (the owner proof, ownerProofText): the site's origin, the owner, this agent, the rail and chain, the
// request id this client created and the match code it showed. The client rebuilds that text from its own values and
// verifies the signature for the owner address before anyone is recorded. An "already linked" answer is accepted only for
// the owner already recorded here, not with --new-owner, and only with a proof over the request id and match code stored
// when that owner was recorded.
//
// On a site that lists `owner_proof_v2` the link asks for the owner proof that also names the account the agent joins (nine
// lines, ownerProofText with version 2): the site must repeat the version, and only that text counts for such a link.
// A link that did not ask for it accepts only the eight-line text. An access token that the site expires
// (401 token_expired) is renewed once with a fresh agent signature (POST .../requests/{id}/token).
//
// A connect for an agent whose owner is recorded here names that owner (expected_owner) when the site announces the
// feature in GET /api/v1/budget/services, and the client checks that the site repeated it. On any site, a bundle whose
// agent the site adds to another account than the expected one is withdrawn before anything is recorded.
//
// A request can outlive the command that made it (a host may end every process of a command when the command ends). A later
// worker of the same approval takes it over (HostedSettings.resume) instead of creating one: it checks that it asks for the
// same thing (`intent`), reads the request from the site first, whatever the clock says, and polls it as the first worker would.
// It never creates a request, and it never cancels one just because the command that took it over ended.
//
// The sink rule. A restarted worker delivers an outcome (to `settled` and `bundle`) only through settleOne and settleBundle, and only
// with a `Confirmed` basis, which is one of these: a successful (2xx) read of the request with this request's own id (readSiteRequest
// with `own`, checked there once) that is `final: true`, or `sent` with a transaction hash (not final on the site: the rail reads the
// chain from the hash); or the site's confirmed cancel of it (cancelSiteRequest). A link with steps needs `final: true` as a whole: one
// step's `sent`, or the link's `linked`, says nothing of the others. No basis is built from a read that was not a 2xx: a 404, 410 or 400 (whatever its body: the site answers a wrong or stale token
// as it answers an unknown request), a 401 or 403, a 5xx, a cut-off or unparsable body, a timeout, an exception, close() all have no
// basis. The sink parks the client and calls `onUnresolved`, which does not return in a worker (it leaves with no result and the next
// `wait` reads the request again). A first worker has no sink: it settles as it always did.
// test/budget/hosted-sink.test.ts fails if any other code resolves a poll.
//
// Every approval checks the site's owner against the owner recorded at setup (`account`): a request the site ties to another
// address is cancelled and refused before the link is shown, and at any later point.
// Once the site reports that the wallet was asked (`wallet_asked`) or a transaction hash exists, an unfinished outcome
// is never "nothing sent": it settles with `sending: true`, and the command reports it as unknown.
//
// Signed here, sent by the connector (`signOnly`, then `adopt`). With signOnly the request is built and signed exactly as the create
// path would send it to a site that lists both features (expected_owner, owner_proof_v2), handed to signOnly with what the record
// keeps (intent, nonce, signing time, the exact body), and nothing is sent. The connector carries it to the site unchanged; it can
// delay or drop it, and anything else breaks the agent proof. With adopt a later command takes the id, link and match code the
// connector returned and checks them before anything is recorded: the command still builds the same body, the link is the site's own
// for that id, the site gives this agent's key a fresh token for it (another agent's request is refused there), and the site's read of
// it shows this agent, rail, chain and the exact transaction or steps that were signed. Only then is the request recorded
// (`onAdopt`, mode 600), and a restarted worker finishes it through the sink like any request it takes over. The connector may have
// sent the signed request whatever adopt is given, so only the site's complete answer that the given id is not it (another agent's,
// none, or this agent's with other terms), with no wallet asked, is a refusal (`notAdopted`). Anything else is kept (`onUnsettled`):
// it may be this one, so it is unknown, never "nothing sent", and a read showing the wallet was asked is kept with an adopted
// request too.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { WALLET_STATES, sentEvidence, viewEvidence } from "./site.mjs";
import type { OwnerActionOutcome, OwnerTerms, OwnerVerdict } from "../src/core/signer/owner-approval-server.ts";
import { isProof } from "../src/core/proofs.mjs";
import { readCapped } from "./response.mjs";
import { EVM_CHAIN_KEYS } from "./evm/chains.mjs";
import { BUDGET_API, LINK_FRAGMENT, MATCH_CODE, SITE_MAX_BYTES, UNSAFE_URL, accountRefusalNext, call, cancelSiteRequest, isSiteRequestId, isSiteToken, readSiteRequest, scrub, siteFailedWords, siteFailure, siteName, siteRequestProblem, siteText, siteWord } from "./site.mjs";

export { scrub, siteFailedWords, siteWord };

// ── agent proof v2 ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first line of the text an agent signs for a site request. */
export const AGENT_PROOF_TITLE = "Superstables agent request v2";

/** SHA-256 of the exact bytes sent as the body, lowercase hex. */
export const bodyHash = (raw: string | Uint8Array) => createHash("sha256").update(typeof raw === "string" ? Buffer.from(raw, "utf8") : raw).digest("hex");

/** A fresh nonce for one request: 16 random bytes, 32 lowercase hex characters. */
export const newNonce = () => randomBytes(16).toString("hex");

/**
 * The exact text the agent signs: six lines, `\n` separated, no trailing newline. `origin` is the site the request is sent
 * to (https://www.superstables.com), `path` has no query, `nonce` is 32 lowercase hex characters.
 */
export function agentProofText(origin: string, method: string, path: string, rawBody: string | Uint8Array, timestamp: number, nonce: string): string {
  return `${AGENT_PROOF_TITLE}\norigin: ${origin}\n${method.toUpperCase()} ${path}\n${bodyHash(rawBody)}\n${timestamp}\n${nonce}`;
}

// ── owner proof ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first line of the text the owner's wallet signs to add an agent to their account. */
export const OWNER_PROOF_TITLE = "Superstables: add an agent to my account";

/** The first line of the owner proof that also names the account the agent joins (version 2). */
export const OWNER_PROOF_TITLE_V2 = "Superstables: add an agent to my account (v2)";
/** An account id as the site gives it in a version 2 proof: a lowercase UUID. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The owner proof's version: 1, or 2 with the account the site says the agent joins. */
export type ProofVersion = { version?: 1 | 2; account?: string };
/** The owner-proof version the site announces in GET /api/v1/budget/services `features`. */
export const OWNER_PROOF_V2_FEATURE = "owner_proof_v2";

/** What the owner proof is about: every value comes from this client, except the owner the site names. */
export interface LinkFacts {
  site: string;
  owner: string;
  agent: string;
  rail: "evm" | "tempo" | "solana";
  chain: string;
  /** The add-agent request id this client created (bl_...). */
  linkId: string;
  /** The match code this client received when it created the request. */
  code: string;
}

/**
 * The exact text the owner's wallet signs: eight lines, `\n` separated, no trailing newline. Version 2 has its own title and
 * a ninth line, `account: <the account id>`. The owner and the agent are
 * checksummed (0x) on evm and tempo, base58 Solana addresses on solana.
 */
export function ownerProofText(f: LinkFacts, { version = 1, account }: ProofVersion = {}): string {
  const owner = f.rail === "solana" ? f.owner : getAddress(f.owner);
  const agent = f.rail === "solana" ? f.agent : getAddress(f.agent);
  const v2 = version === 2;
  if (v2 && (typeof account !== "string" || !ACCOUNT_ID.test(account))) throw new Error("a version 2 owner proof names the account, a lowercase UUID");
  return [v2 ? OWNER_PROOF_TITLE_V2 : OWNER_PROOF_TITLE, `site: ${f.site}`, `owner: ${owner}`, `agent: ${agent}`, `rail: ${f.rail}`, `chain: ${f.chain}`, `request: ${f.linkId}`, `code: ${f.code}`, ...(v2 ? [`account: ${account}`] : [])].join("\n");
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (Bitcoin alphabet) to bytes, or null. */
function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = BASE58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** An ed25519 signature (0x + 128 hex) over `message`'s UTF-8 bytes by the Solana address `address` (base58 public key). */
export function ed25519Verifies(address: string, message: string, signature: string): boolean {
  if (!/^0x[0-9a-fA-F]{128}$/.test(signature)) return false;
  const pub = base58Decode(address);
  if (!pub || pub.length !== 32) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" });
    return verifyBytes(null, Buffer.from(message, "utf8"), key, Buffer.from(signature.slice(2), "hex"));
  } catch {
    return false;
  }
}

/**
 * Why the site's `owner_proof` does not prove that `facts.owner` added this agent, or "" when it does: the text must equal
 * the one rebuilt here byte for byte, and the signature must verify for the owner (EIP-191 on evm and tempo, ed25519 on
 * solana).
 */
export async function ownerProofProblem(proof: unknown, facts: LinkFacts, opts: ProofVersion = {}): Promise<string> {
  if (!proof || typeof proof !== "object") return "the site sent no owner proof";
  const p = proof as { scheme?: unknown; message?: unknown; signature?: unknown };
  const scheme = facts.rail === "solana" ? "ed25519" : "eip191";
  if (p.scheme !== scheme) return `the owner proof is not ${scheme}`;
  if (typeof p.message !== "string" || typeof p.signature !== "string") return "the owner proof has no message or signature";
  if (opts.version === 2 && (typeof opts.account !== "string" || !ACCOUNT_ID.test(opts.account))) return "the site named no valid account for an owner proof that names the account";
  let want: string;
  try {
    want = ownerProofText(facts, opts);
  } catch {
    return "the owner is not an address of this rail";
  }
  if (p.message !== want) return "the owner proof is for another add-agent request";
  if (scheme === "ed25519") return ed25519Verifies(facts.owner, want, p.signature) ? "" : `the owner proof is not signed by ${facts.owner}`;
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(p.signature)) return "the owner proof's signature is not an EIP-191 signature";
  try {
    const signer = await recoverMessageAddress({ message: want, signature: p.signature as Hex });
    return signer.toLowerCase() === facts.owner.toLowerCase() ? "" : `the owner proof is signed by ${signer}, not ${getAddress(facts.owner)}`;
  } catch {
    return "the owner proof's signature cannot be read";
  }
}

/** The message and signature of an owner proof that ownerProofProblem has already accepted, or undefined. */
function proofOf(p: unknown): { message: string; signature: string } | undefined {
  const { message, signature } = (p ?? {}) as { message?: unknown; signature?: unknown };
  return typeof message === "string" && typeof signature === "string" ? { message, signature } : undefined;
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
 * The four agent headers for one request to `origin`: the address, the unix timestamp in seconds, the nonce, and the
 * signature of the text: EIP-191 personal_sign for an EVM key, ed25519 over the text's UTF-8 bytes (0x + 128 hex) for a
 * Solana key.
 */
export async function agentProof(key: AgentKey, origin: string, method: string, path: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000), nonce = newNonce()) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("the nonce is 32 lowercase hex characters");
  const text = agentProofText(origin, method, path, rawBody, timestamp, nonce);
  const agent = agentAddressOf(key);
  const signature = isSolanaKey(key) ? ed25519Sign(key, text) : await privateKeyToAccount(key).signMessage({ message: text });
  return {
    agent,
    headers: {
      "Superstables-Agent": agent,
      "Superstables-Agent-Timestamp": String(timestamp),
      "Superstables-Agent-Nonce": nonce,
      "Superstables-Agent-Signature": signature,
    },
  };
}

// ── the client ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type HostedKind = "grant" | "revoke" | "fund_agent";
/** The owner commands hosted approvals cover, by the action name the rails use. Anything else (recover) stays local. */
export const HOSTED_KIND: Record<string, HostedKind> = { grant: "grant", revoke: "revoke", "fund-agent": "fund_agent" };

/** What the approval record keeps (approvals.mjs). The token is the agent's access to this one request. */
export type HostedRecord = {
  site: string; requestId: string; token: string; kind: "link" | HostedKind; matchCode: string;
  /** a link with wallet steps: their kinds, in order */ then?: HostedStep["kind"][];
  /** a later worker may take this request over (HostedSettings.resumable), with what it needs to do that */
  resumable?: true;
  /** a digest of what was asked (kind, rail, chain, agent, the transaction or steps): a worker that takes the request over must ask for the same */
  intent?: string;
  /** when the site ends the request, and when this command's own wait ends (ms since the epoch) */
  expiresAt?: number; deadline?: number;
  /** a link: the owner-proof version it asked for */ proofVersion?: 2;
  /** signed here and sent by the connector (--sign-only): what was signed, kept once the request is adopted */
  signed?: SignedFacts;
};
export type HostedRail = "evm" | "tempo" | "solana";

/** A request signed here for someone else to send (--sign-only), as submit_budget_request takes it: header names lowercased, `body` the exact bytes signed. */
export type SignedRequest = { method: "POST"; path: string; headers: Record<string, string>; body: string };
/** What the approval record keeps of a signed request: its route and exact body, the proof's nonce and timestamp (unix seconds). */
export type SignedFacts = { path: string; body: string; nonce: string; signedAt: number; /** a read while adopting it showed the owner's wallet was asked */ walletAsked?: true };
/** The approval record's request before a site request is adopted for it: no id, token or match code yet. */
export type SignedRecord = Pick<HostedRecord, "site" | "kind" | "then" | "intent" | "proofVersion"> & { resumable: true; signed: SignedFacts };

/** request() signed the request (signOnly) and sent nothing. */
export class HostedSigned extends Error {
  constructor(readonly request: SignedRequest) {
    super("signed, not sent");
  }
}
/** request() checked and recorded the request the connector created from the signed record (adopt); it polls nothing. */
export class HostedAdopted extends Error {
  constructor() {
    super("adopted");
  }
}

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
  /** A link with steps nobody has been asked about: how long past the expiry to keep reading for a final answer (default 30 s). */
  quietGraceMs?: number;
  fetchImpl?: typeof fetch;
  /** The command can be run again to finish this request later: the record keeps what a worker needs to take it over. */
  resumable?: boolean;
  /** This worker finishes the recorded request an earlier worker made: it creates none (see the header). */
  resume?: HostedRecord;
  /** Called once the site has answered about the recorded request (after the check that it is the one this command asks for): from then on this worker's results count. */
  onTakeover?: () => void;
  /**
   * The sink's exit (see the header). Called when a restarted worker's outcome rests on nothing the site confirmed (time ran out,
   * the site could not be read or refused the agent's token, an exception, the client was closed). Required with `resume`.
   * In a worker it does not return: the worker leaves with no result and the next wait reads the request again.
   */
  onUnresolved?: (why: string) => void;
  /** --sign-only: sign the request this command would create and hand it here with what the record keeps; nothing is sent. */
  signOnly?: (request: SignedRequest, record: SignedRecord) => void;
  /**
   * wait --site-request: the request the connector created from `signed`, as it returned it. Checked (see the header), then
   * handed to onAdopt to record; nothing is polled and nothing is created. `walletAsked`: the read showed the owner's wallet was asked.
   * A request that is not adopted and that the site did not show is another one goes to onUnsettled, with what was seen, before
   * the refusal: it may be this request, open on the site.
   */
  adopt?: {
    signed: SignedRecord; requestId: string; link: string; matchCode: string;
    onAdopt: (record: HostedRecord, shown: { url: string; expires: number; terms: OwnerTerms }, walletAsked: boolean) => void;
    onUnsettled: (u: { requestId: string; link: string; matchCode: string; walletAsked: boolean }) => void;
  };
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

/** The link recorded with the owner on this computer (LINK_ID, LINK_CODE in the public file): an "already linked" answer is checked against it. */
export type PriorLink = { owner: string; linkId: string; linkCode: string };

export type HostedInput =
  | {
      kind: "connect";
      terms: OwnerTerms;
      timeoutMs: number;
      then?: HostedStep[];
      /** The owner and link recorded here for this agent on this site, if any. */
      prior?: PriorLink | null;
      /** setup --new-owner: an "already linked" answer is never taken; the owner signs a fresh link. */
      newOwner?: boolean;
      /** The owner recorded on this machine for this agent, rail and chain (not with --new-owner). Sent as expected_owner where the site accepts it; a bundle for another account is withdrawn. */
      expectedOwner?: string | null;
    }
  | { kind: "evm-transaction"; action: string; terms: OwnerTerms; timeoutMs: number; account: string; transaction: { to: string; data: string; value: string } }
  | { kind: "solana-intent"; action: string; terms: OwnerTerms; timeoutMs: number; account: string; solana: { amount_atomic?: string } };

export interface HostedHandle {
  id: string;
  url: string;
  expiresAt: number;
  matchCode: string;
  /** The agent was already linked on this chain: no link to show, `settled` is already connected (with a verified proof). */
  alreadyLinked?: boolean;
  /** An earlier worker made this request and this one finishes it: the link was shown then, so it is not announced again. */
  adopted?: boolean;
  /** A link: the id and match code the owner signed, for LINK_ID and LINK_CODE in the public file. */
  link?: { id: string; code: string };
  settled: Promise<OwnerActionOutcome>;
  /** A link with steps (`then`): settles once the link and every step are final. `settled` then settles at the same time. */
  bundle?: Promise<HostedBundleOutcome>;
  finish(verdict: OwnerVerdict): void;
}

/** A request the site did not take: nothing was requested, so nothing can be sent. */
export class HostedRefusal extends Error {
  readonly next: string;
  /** The site reports the owner's wallet was asked: the outcome is unknown (exit 5), never "nothing sent". */
  readonly sending: boolean;
  /** adopt: the site's well-formed answer shows the request given is not the one signed here, and no wallet was asked for it. */
  readonly notAdopted: boolean;
  constructor(message: string, next: string, opts: { sending?: boolean; notAdopted?: boolean } = {}) {
    super(scrub(message));
    this.next = scrub(next);
    this.sending = opts.sending === true;
    this.notAdopted = opts.notAdopted === true;
  }
}

/** The next step after a refusal whose outcome is unknown (the dispatcher names the rail's own status command). */
const CHECK_CHAIN = "read whether anything landed (superstables budget status) before running this again";
/** The site's refusals of a token renewal (renewAccess): 403 another agent's key made the request, 404 there is no such request. */
const RENEW_REFUSED: Record<number, string> = { 403: "not_your_request", 404: "not_found" };
/**
 * What the client has seen of a request so far, from every answer: the creation, the first reads, each poll and the cancel.
 * It only grows: once an answer showed the wallet was asked, or a transaction, no later answer takes it back.
 */
type Seen = { asked: boolean; hash: string | null };
const NOT_SEEN: Seen = { asked: false, hash: null };
const seenOf = (w: { isTx: (h: unknown) => boolean }, v: unknown): Seen => {
  const hash = w.isTx((v as { tx_hash?: unknown } | null)?.tx_hash) ? ((v as { tx_hash: string }).tx_hash) : null;
  return { asked: viewEvidence(v) || hash !== null, hash };
};
const seenPlus = (a: Seen, b: Seen): Seen => ({ asked: a.asked || b.asked, hash: a.hash ?? b.hash });
/** The words of a reason once the wallet may have been asked: never "nothing was sent". */
const unsaid = (reason: string) => {
  const r = reason.replace(/nothing was sent/gi, "whether anything was sent is unknown");
  return /unknown/.test(r) ? r : `${r}; whether the owner's wallet was asked is not settled, so whether anything was sent is unknown; read the chain`;
};

/**
 * What this client may say after it cancelled a request no link was shown for: "nothing was sent" only when the site
 * confirms the cancel (an explicit, coherent answer for this request) and no earlier answer (`earlier`) showed the wallet
 * was asked; an unknown outcome when any answer reports the wallet was asked, and, for a request that can move funds
 * (`movesFunds`), when its answer is anything else or there is none.
 */
function afterCancel(c: { cancelled?: boolean; walletAsked?: boolean; state?: string | null } | null, movesFunds: boolean, earlier: Seen = NOT_SEEN): { words: string; sending: boolean } {
  if (movesFunds && earlier.asked) return { words: "The site reported earlier that the owner's wallet was asked, so a transaction may have been sent; a later cancel answer does not change that", sending: true };
  if (c?.cancelled) return { words: "The request was cancelled on the site before the wallet was asked; nothing was sent", sending: false };
  if (c?.walletAsked) {
    return { words: `The site would not cancel it: it reports the owner's wallet was asked${c.state ? ` (state ${siteWord("state", c.state)})` : ""}, so a transaction may have been sent`, sending: true };
  }
  if (movesFunds) {
    return c
      ? { words: "The site did not confirm the request was cancelled before the owner's wallet was asked, so whether anything was sent is unknown; read the chain before retrying", sending: true }
      : { words: "The site did not answer the cancel, so the request may still be open there and whether anything was sent is unknown; read the chain before retrying", sending: true };
  }
  return { words: "This command did not show an approval link. Check wallet activity before retrying", sending: false };
}

/**
 * The shortest piece of a token's secret that counts as carrying it. The site's secrets are 43 base64url characters (256
 * random bits); 12 characters are 72 bits, so an accidental 12-character match anywhere in a link of about a hundred
 * characters has a chance near 100 x 32 / 64^12, about 7e-19. A shorter secret (a test one) counts whole.
 */
export const TOKEN_PIECE = 12;
/**
 * Whether a link carries `token`: the whole token, or any TOKEN_PIECE characters of its secret part (after ssbt_ and
 * test_), anywhere in the link, or a fragment that is itself part of the secret.
 */
function carriesToken(link: URL, token: string): boolean {
  const secret = token.replace(/^ssbt_(?:test_)?/, "");
  const fragment = link.hash.slice(1);
  if (link.href.includes(token) || secret.includes(fragment)) return true;
  const n = Math.min(TOKEN_PIECE, secret.length);
  for (let i = 0; i + n <= secret.length; i++) if (link.href.includes(secret.slice(i, i + n))) return true;
  return false;
}
/** The site's reason for a state, as its documented code in this client's words, or "" when it gave none. */
function siteReason(site: string, v: any): string {
  if (v?.reason_code === undefined || v?.reason_code === null) return "";
  const next = accountRefusalNext(v.reason_code);
  return `${site} gives the reason ${siteWord("code", v.reason_code)}${next ? `; ${next}` : ""}`;
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
type Poll = { /** a request taken over: read it before any expiry is acted on */ fresh?: boolean; /** what earlier answers showed */ seen?: Seen; /** a link: the owner-proof version it asked for */ proofVersion?: 1 | 2; /** what the approval record holds, so a renewed token replaces it */ record?: HostedRecord; id: string; token: string; kind: HostedRecord["kind"]; title: string; expected?: string; matchCode: string; localDeadline: number; siteExpiry: number; resolve: (o: OwnerActionOutcome) => void };
const FINAL_STATES = new Set(["linked", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown"]);
const STEP_FINAL = new Set(["confirmed", "failed", "rejected", "expired", "unknown", "skipped", "cancelled"]);
/** The rail and chain flags of a command: no --chain on a rail's default chain. */
const railFlags = (rail: HostedRail, chain: string) => (rail === "evm" ? `--rail evm${chain === "base-sepolia" ? "" : ` --chain ${chain}`}` : `--rail ${rail}`);

/** The budget API's announcement that a link may name its owner (superstables-app lib/budget/features.ts). */
export const EXPECTED_OWNER_FEATURE = "expected_owner";

/**
 * What a restarted worker's outcome rests on. Only the factories below make one, each from an answer of the site that is about
 * this request (its id). null is "rests on nothing the site said": the sink parks instead of delivering.
 */
export class Confirmed {
  private constructor(readonly by: "view" | "whole" | "cancel") {}
  /**
   * A successful read of a single request, under this request's id, that is `final: true`, or `sent` with a transaction hash (the
   * site does not call `sent` final: the rail reads the chain from the hash). `v` is the view of a read that was ok (r.view): never
   * the result of a failed read, and no factory here takes one.
   */
  static ofView(id: string, v: unknown): Confirmed | null {
    const view = v as { id?: unknown; state?: unknown; final?: unknown; tx_hash?: unknown } | null;
    if (!view || typeof view !== "object" || view.id !== id || typeof view.state !== "string") return null;
    const sentWithHash = view.state === "sent" && typeof view.tx_hash === "string" && view.tx_hash !== "";
    return view.final === true || sentWithHash ? new Confirmed("view") : null;
  }
  /**
   * A successful read of a link with steps that the site calls final as a whole (`final: true`), under this request's id. One
   * step's state (sent, linked, confirmed) says nothing about the others, so it is not enough for a bundle.
   */
  static ofWhole(id: string, v: unknown): Confirmed | null {
    const view = v as { id?: unknown; state?: unknown; final?: unknown } | null;
    return view && typeof view === "object" && view.id === id && typeof view.state === "string" && view.final === true ? new Confirmed("whole") : null;
  }
  /** The site's confirmed cancel of this request (cancelSiteRequest checks its id and that the wallet was not asked). */
  static ofCancel(c: { cancelled?: boolean } | null | undefined): Confirmed | null {
    return c?.cancelled === true ? new Confirmed("cancel") : null;
  }
}
type Basis = Confirmed | null;

export class HostedApprovals {
  private readonly s: HostedSettings;
  private stopped = false;
  /** Requests created here without a final answer yet: close() cancels them. */
  private readonly open = new Map<string, { id: string; token: string }>();
  /**
   * One cancellation per open request: close(), the deadline, a refused owner or read and a stop all share its answer, so
   * a later, cleaner answer never stands in for the first. `learners` take each answer into the request's own evidence,
   * and write it to the approvals log, the moment it is in, before whoever asked is told.
   */
  private readonly cancellations = new Map<string, Promise<Awaited<ReturnType<typeof cancelSiteRequest>>>>();
  private readonly learners = new Map<string, (c: Awaited<ReturnType<typeof cancelSiteRequest>>) => void>();
  /** Every request this client created, by id: a retry answered with duplicate_request or proof_reused keeps polling it. */
  private readonly held = new Map<string, { linked: false; id: string; token: string; url: string; matchCode: string; expiresAt: number; steps?: unknown[]; seen: Seen; answer?: unknown }>();

  private readonly w: ReturnType<typeof railWords>;

  /** A restarted worker's client that was parked by the sink: it delivers nothing more. */
  private parked = false;

  constructor(settings: HostedSettings) {
    // a restarted worker is only safe with its sink wired: without onUnresolved an outcome with no basis could not be held back
    if (settings.resume && !settings.onUnresolved) throw new Error("a client that finishes a recorded request needs onUnresolved");
    this.s = settings;
    this.w = railWords(settings.rail);
  }

  /**
   * The sink's gate. A restarted worker's outcome without a basis is not delivered: the client is parked and onUnresolved is
   * told why (in a worker it does not return). True when the caller must not deliver. A first worker has no gate.
   */
  private parks(basis: Basis, why: string): boolean {
    if (!this.s.resume) return false;
    if (this.parked) return true;
    if (basis) return false;
    this.parked = true;
    this.s.onUnresolved!(why);
    return true;
  }

  /** The one place a single request's outcome is delivered (the sink). */
  private settleOne(p: Poll, basis: Basis, why: string, outcome: OwnerActionOutcome) {
    if (this.parks(basis, why)) return;
    p.resolve(outcome);
  }

  /** The one place a link with steps delivers its outcome (the sink). */
  private settleBundle(p: { resolve: (o: OwnerActionOutcome) => void; settle: (b: HostedBundleOutcome) => void }, basis: Basis, why: string, out: HostedBundleOutcome) {
    if (this.parks(basis, why)) return;
    p.resolve(out.link);
    p.settle(out);
  }

  get site(): string {
    return this.s.site;
  }

  /** The site in words: superstables.com, or the host when it is another site. */
  private get name(): string {
    return siteName(this.s.site);
  }

  private featureList?: Promise<Set<string>>;

  /** What the site says its budget API accepts beyond the first fields: GET /api/v1/budget/services `features`. Any failure: none. */
  private features(): Promise<Set<string>> {
    this.featureList ??= call(`${this.s.site}${BUDGET_API}/services`, { headers: { accept: "application/json" } }, 10_000, this.s.fetchImpl)
      .then((r: { ok: boolean; body: any }) => new Set<string>(r.ok && Array.isArray(r.body?.features) ? r.body.features.filter((x: unknown) => typeof x === "string" && /^[a-z0-9_]{1,64}$/.test(x)).slice(0, 50) : []))
      .catch(() => new Set<string>());
    return this.featureList;
  }

  /** The facts of a link this client made (or recorded), for the owner proof. */
  private facts(owner: string, linkId: string, code: string): LinkFacts {
    return { site: this.s.site, owner, agent: agentAddressOf(this.s.agentKey), rail: this.s.rail, chain: this.s.chain, linkId, code };
  }

  /** Create the request on the site and start polling it. Throws HostedRefusal when the site did not take it. */
  async request(input: HostedInput): Promise<HostedHandle> {
    const agent = agentAddressOf(this.s.agentKey);
    let path: string;
    let body: Record<string, unknown>;
    let kind: HostedRecord["kind"];
    let expectedOwner: string | null = null;
    let sentOwner = false;
    let askedV2 = false;
    const then = input.kind === "connect" && input.then?.length ? input.then : undefined;
    if (input.kind === "connect") {
      path = `${BUDGET_API}/links`;
      kind = "link";
      // the owner recorded here (not with --new-owner), named to the site only when it says it takes the field
      expectedOwner = !input.newOwner ? this.w.owner(input.expectedOwner) : null;
      // a request signed for the connector reads nothing from the site: it is signed for a site that lists both features, as the site does
      const features = this.s.signOnly || this.s.adopt ? new Set([EXPECTED_OWNER_FEATURE, OWNER_PROOF_V2_FEATURE]) : await this.features();
      sentOwner = Boolean(expectedOwner) && features.has(EXPECTED_OWNER_FEATURE);
      // the owner proof that names the account, only where the site says it takes the field
      askedV2 = features.has(OWNER_PROOF_V2_FEATURE);
      body = { rail: this.s.rail, chain: this.s.chain, agent, ...(this.s.label ? { label: this.s.label.slice(0, 40) } : {}), ...(sentOwner ? { expected_owner: expectedOwner } : {}), ...(askedV2 ? { owner_proof_version: 2 } : {}), ...(then ? { then } : {}) };
    } else {
      const k = HOSTED_KIND[input.action];
      if (!k) throw new HostedRefusal(`"${input.action}" has no hosted approval`, "use the approval page on this machine");
      path = `${BUDGET_API}/approvals`;
      kind = k;
      body = { kind: k, rail: this.s.rail, chain: this.s.chain, agent, ...(input.kind === "solana-intent" ? { solana: input.solana } : { transaction: input.transaction }) };
    }
    const taken = this.s.resume;
    const intent = bodyHash(JSON.stringify({ kind, rail: this.s.rail, chain: this.s.chain, agent, then: then ?? null, transaction: (body as { transaction?: unknown }).transaction ?? null, solana: (body as { solana?: unknown }).solana ?? null }));
    if (taken) {
      // the request an earlier worker made is the only one this worker may finish, and only for the same ask
      const problem = taken.kind !== kind ? `it is a ${taken.kind} request and this command asks for a ${kind}`
        : taken.site !== this.s.site ? "it was made on another site"
        : taken.intent !== intent ? "this command asks for something other than the recorded request"
        : "";
      if (problem) throw new HostedRefusal(`the recorded request ${taken.requestId} cannot be finished: ${problem}. No new request was created; whether the owner approved it is not known here`, CHECK_CHAIN, { sending: true });
    }
    const proofAsked = askedV2 ? (2 as const) : undefined;
    if (this.s.signOnly) return this.signOnly(path, JSON.stringify(body), { site: this.s.site, kind, ...(then ? { then: then.map((t) => t.kind) } : {}), intent, ...(proofAsked ? { proofVersion: proofAsked } : {}) });
    if (this.s.adopt) return this.adopt(this.s.adopt, { path, raw: JSON.stringify(body), body, kind, intent, then, terms: input.terms, timeoutMs: input.timeoutMs });
    const answer = taken
      // a read made while adopting it may already have shown the wallet asked (adopt): a worker that takes it over starts from that
      ? { linked: false as const, id: taken.requestId, token: taken.token, url: "", matchCode: taken.matchCode, expiresAt: taken.expiresAt ?? Date.now(), steps: undefined, seen: taken.signed?.walletAsked ? { asked: true, hash: null } : NOT_SEEN, answer: undefined as unknown }
      : await this.create(path, body, kind === "link" ? "bl_" : "ba_");
    if (answer.linked && then) {
      // the site must refuse a link with steps for an agent it already linked (409); a 200 here would skip every step
      throw new HostedRefusal(alreadyLinkedWords(this.s.site, answer.owner, this.s.rail), alreadyLinkedNext(this.s.rail, this.s.chain, this.s.site));
    }
    if (answer.linked) {
      // already linked on this chain: accepted only for the owner recorded here, with a proof over the link recorded here
      const prior = input.kind === "connect" ? input.prior : null;
      const fresh = `ask the owner to remove this agent from their account on ${this.name} (account page), then run superstables budget setup ${railFlags(this.s.rail, this.s.chain)} --hosted --site ${this.s.site} again: the owner adds the agent again and signs a new owner proof`;
      const refuse = (why: string): never => {
        this.audit({ id: answer.id, kind, title: input.terms.title, status: "refused", reason: why });
        throw new HostedRefusal(`${this.name}: this agent already belongs to the account ${answer.owner}, but ${why}; nothing was recorded or sent. The owner removes it on their ${this.name} account page and adds it again`, fresh);
      };
      if (input.kind === "connect" && input.newOwner) refuse("a new owner is recorded only when the owner adds the agent again and signs a new owner proof, not from an earlier one");
      if (!prior) return refuse("this machine has no record of the add-agent request that added it, so the site's word alone cannot make an owner");
      if (!this.w.same(prior.owner, answer.owner)) refuse(`this machine records the owner ${prior.owner}`);
      // the recorded link is this client's own earlier one: its proof is the eight-line text, or the nine-line text naming the account the answer gives
      const facts = this.facts(answer.owner, prior.linkId, prior.linkCode);
      let problem = await ownerProofProblem(answer.proof, facts);
      if (problem && typeof answer.accountId === "string") problem = await ownerProofProblem(answer.proof, facts, { version: 2, account: answer.accountId }) && problem;
      if (problem) refuse(`its answer does not prove it: ${problem}`);
      this.audit({ id: answer.id, kind, title: input.terms.title, status: "linked", address: answer.owner });
      return { id: answer.id, url: "", expiresAt: Date.now(), matchCode: "", alreadyLinked: true, link: { id: prior.linkId, code: prior.linkCode }, settled: Promise.resolve({ status: "connected", address: answer.owner, proof: proofOf(answer.proof) }), finish: () => {} };
    }
    const created = answer;
    // what the first worker checked before it showed the link is not checked again; the polls check the owner on every read
    if (then && !taken) {
      // the steps the site will ask the owner's wallet for must be exactly the ones sent, in the same order
      const problem = stepsProblem(then, created.steps);
      if (problem) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: "steps other than the ones asked for", sending: created.seen.asked || undefined });
        const a = afterCancel(c, true, created.seen);
        throw new HostedRefusal(`${this.s.site} answered with steps other than the ones asked for (${problem}). ${a.words}`, a.sending ? CHECK_CHAIN : "try again later", { sending: a.sending });
      }
    }
    if (!taken && sentOwner && !this.w.same((created.answer as any)?.expected_owner, expectedOwner)) {
      // the site listed the feature and did not take the field: the request is not used
      const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
      this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: "expected owner not confirmed", sending: created.seen.asked || undefined });
      const a = afterCancel(c, !!then, created.seen);
      throw new HostedRefusal(`${this.s.site} did not confirm that only the owner recorded on this machine (${expectedOwner}) may add this agent; the request is not used. ${a.words}`, a.sending ? CHECK_CHAIN : "try again later", { sending: a.sending });
    }
    if (!taken && askedV2 && (created.answer as any)?.owner_proof_version !== 2) {
      // the site listed the feature and did not take the field: the request is not used
      const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
      this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: "owner proof version not confirmed", sending: created.seen.asked || undefined });
      const a = afterCancel(c, !!then, created.seen);
      throw new HostedRefusal(`${this.s.site} did not confirm the owner proof that names the account; the request is not used. ${a.words}`, a.sending ? CHECK_CHAIN : "try again later", { sending: a.sending });
    }
    const proofVersion = taken ? taken.proofVersion : askedV2 ? (2 as const) : undefined;
    const record: HostedRecord = taken ?? { site: this.s.site, requestId: created.id, token: created.token, kind, matchCode: created.matchCode, ...(then ? { then: then.map((t) => t.kind) } : {}), ...(this.s.resumable ? { resumable: true as const, intent, expiresAt: created.expiresAt, ...(proofVersion ? { proofVersion } : {}) } : {}) };
    const expected = input.kind === "connect" ? undefined : this.w.owner(input.account) ?? input.account;
    let seen = created.seen;

    // an approval: the site must act for the owner recorded here, before the owner sees a link
    if (expected && !taken) {
      const read = () => readSiteRequest({ site: this.s.site, id: created.id, token: created.token, wait: 0, fetchImpl: this.s.fetchImpl });
      let first = await read();
      // everything the creation answer and these reads showed, a failed read's error included: a later, cleaner answer never takes it back
      if (!first.ok) {
        if (first.asked) seen = seenPlus(seen, { asked: true, hash: null });
        await sleep(1000);
        first = await read();
        if (!first.ok && first.asked) seen = seenPlus(seen, { asked: true, hash: null });
      }
      if (first.ok) seen = seenPlus(seen, seenOf(this.w, first.view));
      const owner = first.ok ? first.view.owner : null;
      // the site names the account the approval is for; one that names none (or cannot be read) is not shown to anyone
      if (typeof owner !== "string" || !owner) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        const why = first.ok ? `${this.name} did not say which account would approve this` : `${this.name} could not be read back (${first.reason})`;
        this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: first.ok ? "no owner: the site named no account" : "no owner: the request could not be read", hash: seen.hash ?? undefined, sending: seen.asked || undefined });
        const a = afterCancel(c, true, seen);
        throw new HostedRefusal(`${why}, so the command cannot check it is the owner recorded on this machine (${expected}). ${a.words}`, a.sending ? CHECK_CHAIN : (!first.ok && accountRefusalNext(first.code)) || (first.ok ? "try again later; if it repeats, check which account this agent belongs to on the account page" : "try again later"), { sending: a.sending });
      }
      if (!this.w.same(owner, expected)) {
        const c = await cancelSiteRequest({ site: this.s.site, id: created.id, token: created.token, fetchImpl: this.s.fetchImpl });
        this.audit({ id: created.id, kind, title: input.terms.title, status: "refused", reason: `owner mismatch: the site acts for ${this.w.owner(owner) ?? "an account that is not an address"}`, hash: seen.hash ?? undefined, sending: seen.asked || undefined });
        const a = afterCancel(c, true, seen);
        throw new HostedRefusal(
          `${this.name} would ask ${this.w.owner(owner) ?? "an account that is not an address"} to approve this, but the owner recorded on this machine is ${expected}. ${a.words}`,
          a.sending ? CHECK_CHAIN : `check which ${this.name} account this agent belongs to (the account page lists it). If the owner changed, run superstables budget setup ${railFlags(this.s.rail, this.s.chain)} --hosted --site ${this.s.site} --new-owner (refused while a budget is live)`,
          { sending: a.sending },
        );
      }
    }
    const now = Date.now();
    const localDeadline = taken ? taken.deadline ?? now : now + input.timeoutMs;
    if (!taken) {
      // what a later worker needs to finish this request: when this command's own wait ends, with the rest of the record
      if (record.resumable) record.deadline = localDeadline;
      this.s.onRecord?.(record);
    }

    const expiresAt = Math.min(localDeadline, created.expiresAt);
    if (!taken) this.audit({ id: created.id, kind, title: input.terms.title, status: "awaiting_owner", hash: seen.hash ?? undefined, sending: seen.asked || undefined });
    let resolve!: (o: OwnerActionOutcome) => void;
    const settled = new Promise<OwnerActionOutcome>((deliverOnce) => {
      let answered = false;
      resolve = (o) => {
        if (answered) return;
        answered = true;
        deliverOnce(o);
      };
    });
    // a request taken over is left open when this command ends: the next one finishes it
    if (!taken) this.open.set(created.id, { id: created.id, token: created.token });
    if (then) {
      let settle!: (b: HostedBundleOutcome) => void;
      const bundle = new Promise<HostedBundleOutcome>((deliverBundle) => (settle = deliverBundle));
      const base = { id: created.id, token: created.token, kind, title: input.terms.title, matchCode: created.matchCode, localDeadline, siteExpiry: created.expiresAt, resolve, record, ...(taken ? { fresh: true } : {}), ...(proofVersion ? { proofVersion } : {}) };
      const kinds = then.map((t) => t.kind);
      const bundlePoll = { ...base, expected: expectedOwner ?? undefined, timeoutMs: input.timeoutMs, kinds, settle, answer: created.answer };
      void this.pollBundle(bundlePoll).catch((err: Error) => {
        this.learners.delete(created.id);
        this.cancellations.delete(created.id);
        const reason = `the command stopped reading the request: ${scrub(siteText(err.message))}`;
        const out: HostedBundleOutcome = { link: { status: "expired", reason, sending: true }, steps: kinds.map((k) => ({ kind: k, state: "stopped", hash: null, reason, reasonCode: null, walletAsked: true })) };
        this.settleBundle(bundlePoll, null, reason, out);
      });
      return {
        id: created.id,
        url: created.url,
        expiresAt,
        matchCode: created.matchCode,
        link: { id: created.id, code: created.matchCode },
        ...(taken ? { adopted: true } : {}),
        settled,
        bundle,
        finish: (verdict) => this.audit(verdictLine(created.id, kind, input.terms.title, verdict)),
      };
    }
    const singlePoll = { seen, id: created.id, token: created.token, kind, title: input.terms.title, expected, matchCode: created.matchCode, localDeadline, siteExpiry: created.expiresAt, resolve, record, ...(taken ? { fresh: true } : {}), ...(proofVersion ? { proofVersion } : {}) };
    void this.poll(singlePoll).catch((err: Error) => {
      this.learners.delete(created.id);
      this.cancellations.delete(created.id);
      const reason = `the command stopped reading the request: ${scrub(siteText(err.message))}`;
      this.settleOne(singlePoll, null, reason, { status: "expired", reason, sending: kind !== "link" });
    });
    return {
      id: created.id,
      url: created.url,
      expiresAt,
      matchCode: created.matchCode,
      ...(kind === "link" ? { link: { id: created.id, code: created.matchCode } } : {}),
      ...(taken ? { adopted: true } : {}),
      settled,
      // the site reads the receipt itself; this only records the command's own verdict locally
      finish: (verdict) => this.audit(verdictLine(created.id, kind, input.terms.title, verdict)),
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
    await Promise.all(open.map((o) => this.cancelOnce(o.id, o.token)));
  }

  /** The request's one cancellation: asked once, its answer taken into the evidence and the log, then shared. */
  private cancelOnce(id: string, token: string) {
    let once = this.cancellations.get(id);
    if (!once) {
      once = cancelSiteRequest({ site: this.s.site, id, token, fetchImpl: this.s.fetchImpl })
        .catch(() => null)
        .then((c) => {
          this.learners.get(id)?.(c);
          return c;
        });
      this.cancellations.set(id, once);
    }
    return once;
  }

  /** What a link's owner proof is checked as: the version it asked for, and for version 2 the account the site's view names. */
  private proofOf(p: { proofVersion?: 1 | 2 }, view: any): ProofVersion {
    return p.proofVersion === 2 ? { version: 2, account: typeof view?.account_id === "string" ? view.account_id : undefined } : {};
  }

  /**
   * A fresh access token for a request whose token the site expired: POST .../requests/{id}/token, signed with the agent's
   * key over the body { agent }. The token is `ssbt_...` and the id is the request's own, or there is none.
   */
  private async renew(p: { id: string }): Promise<string | null> {
    const r = await this.renewToken(p.id);
    return "token" in r ? r.token : null;
  }

  /**
   * renew(), with the site's answer when it gave no token: its status (0 for none), the reason in words, whether the answer
   * showed the owner's wallet was asked (an error's `money_moved`, say), and `notOurs`: the answer is the site's own complete
   * refusal that this agent made no request with that id (RENEW_REFUSED), names no other request, and shows no wallet asked.
   */
  private async renewToken(id: string): Promise<{ token: string } | { status: number; why: string; asked: boolean; notOurs: boolean }> {
    const path = `${BUDGET_API}/requests/${id}/token`;
    const raw = JSON.stringify({ agent: agentAddressOf(this.s.agentKey) });
    try {
      const { headers } = await agentProof(this.s.agentKey, this.s.site, "POST", path, raw);
      const res = await (this.s.fetchImpl ?? fetch)(`${this.s.site}${path}`, { method: "POST", redirect: "error", headers: { ...headers, "content-type": "application/json", accept: "application/json" }, body: raw, signal: AbortSignal.timeout(20_000) });
      const { bytes, truncated } = await readCapped(res, SITE_MAX_BYTES);
      if (truncated) return { status: res.status, why: "an answer that was cut off", asked: false, notOurs: false };
      let json: any = null;
      try { json = JSON.parse(bytes.toString("utf8")); } catch {}
      const asked = viewEvidence(json);
      // a refusal that names an id (itself or in its error) other than this one is about another request, as readSiteRequest `own`
      if ([json?.id, json?.error?.id].some((x) => x !== undefined && x !== null && x !== id)) return { status: res.status, why: "an answer about another request", asked, notOurs: false };
      if (!res.ok) return { status: res.status, why: siteFailure(res.status, json), asked, notOurs: !asked && RENEW_REFUSED[res.status] !== undefined && json?.error?.code === RENEW_REFUSED[res.status] };
      return json && json.id === id && isSiteToken(json.access_token) ? { token: json.access_token as string } : { status: res.status, why: "an answer with no token for that request", asked, notOurs: false };
    } catch (err) {
      return { status: 0, why: `no answer (${siteText((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message, 120)})`, asked: false, notOurs: false };
    }
  }

  /** --sign-only: sign the body the create path would send, hand it over with what the record keeps, and send nothing. */
  private async signOnly(path: string, raw: string, record: Omit<SignedRecord, "resumable" | "signed">): Promise<never> {
    const signedAt = Math.floor(Date.now() / 1000);
    const nonce = newNonce();
    const { headers } = await agentProof(this.s.agentKey, this.s.site, "POST", path, raw, signedAt, nonce);
    const request: SignedRequest = { method: "POST", path, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body: raw };
    // recorded before it is shown, so a request the connector sends always has a record here to adopt it into
    this.s.signOnly!(request, { ...record, resumable: true, signed: { path, body: raw, nonce, signedAt } });
    throw new HostedSigned(request);
  }

  /**
   * wait --site-request: check the request the connector created from the signed record, then record it (see the header). A
   * refusal is `notAdopted` only on the site's complete answer that the id is not this agent's request, or is this agent's with
   * other terms, and no wallet asked. Any other refusal after the values check out keeps the request (onUnsettled): it may be
   * this one.
   */
  private async adopt(a: NonNullable<HostedSettings["adopt"]>, ask: { path: string; raw: string; body: Record<string, unknown>; kind: HostedRecord["kind"]; intent: string; then?: HostedStep[]; terms: OwnerTerms; timeoutMs: number }): Promise<never> {
    const id = a.requestId;
    const values = siteRequestProblem(this.s.site, ask.kind, a);
    if (values) throw new HostedRefusal(`that request was not adopted: ${values}. Nothing was recorded`, "use the request_id, approval_link and match_code that submit_budget_request returned for this signed request");
    const link = new URL(a.link);
    const notAdopted = (why: string): never => {
      throw new HostedRefusal(`${id} was not adopted: ${why}. Nothing was recorded`, "use the request_id, approval_link and match_code that submit_budget_request returned for this signed request", { notAdopted: true });
    };
    const kept = (why: string, walletAsked: boolean): never => {
      a.onUnsettled({ requestId: id, link: link.href, matchCode: a.matchCode, walletAsked });
      throw new HostedRefusal(`${id} was not adopted: ${why}. It is kept with this approval as a request that may be this one${walletAsked ? ", and the owner's wallet may have sent its transaction" : ""}; a later wait checks it again`, CHECK_CHAIN, { sending: true });
    };
    const s = a.signed;
    if (s.site !== this.s.site) return kept("the signed request is for another site", false);
    if (s.kind !== ask.kind || s.intent !== ask.intent || s.signed.path !== ask.path || s.signed.body !== ask.raw) return kept("this command no longer asks for what was signed", false);
    // the site gives a token only to the key that made the request: another agent's request ends here
    const renewed = await this.renewToken(id);
    if (!("token" in renewed)) {
      if (renewed.notOurs) return notAdopted(renewed.status === 403 ? "another agent's key made that request" : `${this.name} has no request with that id`);
      return kept(`${this.name} gave this agent no token for it (${renewed.why})`, renewed.asked);
    }
    const token = renewed.token;
    if (carriesToken(link, token)) return kept("the link carries the request's access token", false);
    const r = await readSiteRequest({ site: this.s.site, id, token, wait: 0, own: true, fetchImpl: this.s.fetchImpl });
    if (!r.ok) return kept(`it could not be read back (${r.reason})`, r.asked === true);
    const walletAsked = viewEvidence(r.view);
    const want = { id, kind: ask.kind, rail: this.s.rail, chain: this.s.chain, agent: agentAddressOf(this.s.agentKey), body: ask.body, then: ask.then };
    const problem = signedProblem(r.view, want, this.w.same);
    if (problem && !readComplete(r.view, want, this.w.owner)) return kept("the site's read of it leaves out, or garbles, what was signed", walletAsked);
    if (problem) return walletAsked ? kept(problem, true) : notAdopted(problem);
    const now = Date.now();
    const siteExpiry = Date.parse(typeof r.view.expires_at === "string" ? r.view.expires_at : "");
    const expiresAt = Number.isFinite(siteExpiry) ? siteExpiry : now + ask.timeoutMs;
    a.onAdopt(
      { site: this.s.site, requestId: id, token, kind: ask.kind, matchCode: a.matchCode, ...(s.then ? { then: s.then } : {}), resumable: true, intent: ask.intent, expiresAt, deadline: Math.min(expiresAt, now + ask.timeoutMs), ...(s.proofVersion ? { proofVersion: s.proofVersion } : {}), signed: s.signed },
      { url: link.href, expires: expiresAt, terms: ask.terms },
      walletAsked,
    );
    throw new HostedAdopted();
  }

  /** Renew `p`'s token and take the new one in everywhere this client holds the old one: the poll, the open and held requests, the approval record. */
  private async renewed(p: { id: string; token: string; record?: HostedRecord }): Promise<boolean> {
    const fresh = await this.renew(p);
    if (!fresh) return false;
    p.token = fresh;
    if (this.open.has(p.id)) this.open.set(p.id, { id: p.id, token: fresh });
    const held = this.held.get(p.id);
    if (held) held.token = fresh;
    if (p.record) {
      p.record = { ...p.record, token: fresh };
      this.s.onRecord?.(p.record);
    }
    return true;
  }

  private async create(path: string, body: Record<string, unknown>, prefix: string) {
    const raw = JSON.stringify(body);
    const idempotency = randomBytes(16).toString("hex");
    const f = this.s.fetchImpl ?? fetch;
    // proof v2: bound to this site's origin, with a fresh nonce
    let { headers } = await agentProof(this.s.agentKey, this.s.site, "POST", path, raw);
    const send = () => f(`${this.s.site}${path}`, {
      method: "POST",
      redirect: "error",
      headers: { ...headers, "content-type": "application/json", accept: "application/json", "idempotency-key": idempotency },
      body: raw,
      signal: AbortSignal.timeout(20_000),
    });
    let res: Response | undefined;
    let network = "";
    // One retry on a network error, with the same proof (and nonce), key and body: if the first attempt reached the site
    // and created the request, the site answers 409 proof_reused (or duplicate_request) with its id instead of creating a
    // second one; this client holds no token for a request whose answer it never received, so it refuses with guidance.
    // If the first attempt reached the site and failed there, its nonce is used up (401 agent_proof, reason "replayed"):
    // nothing was created, so the request is signed again with a new nonce and sent once more.
    let retried = false;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      retried = attempt > 0;
      try {
        res = await send();
      } catch (err) {
        network = siteText((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message);
        if (attempt === 0) await sleep(1000);
      }
    }
    if (!res) throw new HostedRefusal(`could not reach ${this.s.site} (${network}); nothing was sent. If an attempt did reach it, that request cannot be approved without its approval link and expires by itself in 10 minutes`, `check the network and ${this.s.site}, then run the same command again`);
    // the site's answer, read up to the cap: one cut off or longer is no answer to act on, and never a body that reads as empty.
    // Whether the site created the request is then unknown, and its link and token were in that answer: the same as an answer that never came.
    const answer = async (r: Response): Promise<any> => {
      const { bytes, truncated } = await readCapped(r, SITE_MAX_BYTES);
      if (truncated) throw new HostedRefusal(`the answer from ${this.s.site} was cut off or longer than ${SITE_MAX_BYTES} bytes, so it was not read; nothing was sent. If it created the request, that request cannot be approved without its approval link and expires by itself in 10 minutes`, `check the network and ${this.s.site}, then run the same command again`);
      try {
        return JSON.parse(bytes.toString("utf8"));
      } catch {
        return null;
      }
    };
    let json: any = await answer(res);
    if (retried && res.status === 401 && proofReason(json) === "replayed") {
      headers = (await agentProof(this.s.agentKey, this.s.site, "POST", path, raw)).headers;
      try {
        res = await send();
      } catch (err) {
        throw new HostedRefusal(`could not reach ${this.s.site} (${siteText((err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message)}); nothing was sent. If an attempt did reach it, that request cannot be approved without its approval link and expires by itself in 10 minutes`, `check the network and ${this.s.site}, then run the same command again`);
      }
      json = await answer(res);
    }
    const code = typeof json?.reason_code === "string" ? json.reason_code : typeof json?.code === "string" ? json.code : typeof json?.error?.code === "string" ? json.error.code : "";
    if (res.status === 409 && (code === "duplicate_request" || code === "proof_reused")) {
      // a retry of a request the site already created (same key and body, or the same signed proof): keep polling it
      // if this client holds it; otherwise nobody here has its link or token
      const otherId = typeof json?.id === "string" ? json.id : typeof json?.error?.id === "string" ? json.error.id : undefined;
      const held = otherId ? this.held.get(otherId) : undefined;
      if (held) return held;
      const what = code === "proof_reused" ? "with the same signed proof" : "with the same request key";
      throw new HostedRefusal(
        `${this.s.site} already has request ${isSiteRequestId(otherId) ? otherId : "(no usable id)"}${typeof json?.state === "string" ? ` (${siteWord("state", json.state)})` : ""}, created ${what} by an earlier attempt whose answer never arrived here (${siteFailure(res.status, json)}). It cannot be approved without its approval link, which only that answer carried; it expires by itself in 10 minutes, and the owner can see it on their ${this.name} account page. Nothing was sent`,
        "run the same command again after that request expires (10 minutes)",
      );
    }
    if (res.status === 409 && code === "expected_owner_mismatch") {
      const owner = this.w.owner(json?.error?.owner) ?? this.w.owner(json?.owner);
      throw new HostedRefusal(`${this.s.site} says this agent already belongs to another account${owner ? ` (${owner})` : ""}, not the owner recorded on this machine (${(body as any).expected_owner}); nothing was created or sent`,
        `if ${owner ?? "that account"} is the right owner: superstables budget setup ${railFlags(this.s.rail, this.s.chain)} --hosted --site ${this.s.site} --new-owner (refused while a budget is live). If not, remove this agent from that account on ${this.name}`);
    }
    if (res.status === 409 && code === "already_linked") {
      // a link with steps for an agent already linked on this chain: nothing was created; gas and a budget go one by one
      const owner = this.w.owner(json?.error?.owner) ?? this.w.owner(json?.owner);
      throw new HostedRefusal(alreadyLinkedWords(this.s.site, owner, this.s.rail), alreadyLinkedNext(this.s.rail, this.s.chain, this.s.site));
    }
    if (!res.ok) throw new HostedRefusal(`${this.s.site} did not take the request (${siteFailure(res.status, json)}); nothing was sent`, accountRefusalNext(code) ?? (res.status >= 500 ? "try again later" : "read reason; fix what it names before trying again"));
    // a link that already exists for this agent on this chain: an already-final request, with no link to show
    if (res.status === 200 && prefix === "bl_" && json?.state === "linked" && json?.final === true && !json?.approval) {
      const owner = this.w.owner(json.owner);
      if (!isSiteRequestId(json.id) || !String(json.id).startsWith(prefix) || !owner) {
        throw new HostedRefusal(`${this.s.site} says this agent has already been added to an account, but its answer has no ${owner ? "request id" : "owner address"}; nothing was recorded or sent`, "try again later");
      }
      return { linked: true as const, id: json.id as string, owner, proof: json.owner_proof as unknown, accountId: json.account_id as unknown };
    }
    const id = json?.id;
    const token = json?.access_token;
    const url = json?.approval?.url;
    const matchCode = json?.approval?.match_code;
    const expires = Date.parse(json?.approval?.expires_at ?? "");
    // The link is shown to the owner and written in the APPROVE and RESULT lines: only https://<site>/approve/budget/<id>#<token>,
    // re-serialized, and never a string with control characters, spaces or invisible characters in it.
    let link: URL | null = null;
    try {
      link = typeof url === "string" && !UNSAFE_URL.test(url) ? new URL(url) : null;
    } catch {}
    const problem = !isSiteRequestId(id) || !String(id).startsWith(prefix) ? "no request id"
      : !isSiteToken(token) ? "no access token"
      : !link || link.origin !== this.s.site ? "an approval link on another site"
      : link.pathname !== `/approve/budget/${id}` || link.search || !LINK_FRAGMENT.test(link.hash) ? "an approval link that is not /approve/budget/<its id>#<token>"
      // the link is shown to the owner and printed: it must not carry the agent's access token, whole or in part
      : carriesToken(link, token) ? "an approval link that carries the request's access token"
      : typeof matchCode !== "string" || !MATCH_CODE.test(matchCode) ? "no match code"
      : !Number.isFinite(expires) || expires <= Date.now() ? "no expiry in the future"
      : "";
    if (problem) {
      // the site may still have made the request: cancel it whenever its id and token are usable, so it does not wait for an
      // owner who never sees it
      const usable = isSiteRequestId(id) && isSiteToken(token);
      const c = usable ? await cancelSiteRequest({ site: this.s.site, id, token, fetchImpl: this.s.fetchImpl }) : null;
      // no id and token: nothing can be cancelled, and no link was shown
      const a = usable ? afterCancel(c, prefix === "ba_" || Array.isArray(body.then), seenOf(this.w, json)) : { words: "This command did not show an approval link. Check wallet activity before retrying", sending: false };
      throw new HostedRefusal(`${this.s.site} answered with ${problem}; the request is not used. ${a.words}`, a.sending ? CHECK_CHAIN : "try again later", { sending: a.sending });
    }
    const created = { linked: false as const, id: id as string, token: token as string, url: link!.href, matchCode: matchCode as string, expiresAt: expires, steps: Array.isArray(json?.steps) ? (json.steps as unknown[]) : undefined, seen: seenOf(this.w, json), answer: json as unknown };
    this.held.set(created.id, created);
    return created;
  }

  private async poll(p: Poll) {
    const grace = this.s.sendingGraceMs ?? 120_000;
    const tx = p.kind !== "link";
    const expiry = Math.min(p.localDeadline, p.siteExpiry);
    // seeded with what the creation answer and the first reads showed, and only ever added to
    let walletAsked = p.seen?.asked ?? false;
    let hash: string | null = p.seen?.hash ?? null;
    let lastState = "awaiting_owner";
    // whether the audit line (the page log wait and --replace read) already says the wallet was asked
    let loggedAsked = walletAsked;
    let lastContact = Date.now();
    let cancelTried = false;
    let renewed = false;
    let readAt = 0;
    // A request an earlier worker made may be past its expiry already, with the owner's answer on the site: it is read before any
    // expiry is acted on, however long that takes (a site that cannot be read decides nothing; the worker's own deadline ends it).
    let freshUntil = p.fresh ? Infinity : 0;
    // when the first read of a request taken over succeeded: the time the owner has to send is counted from then at the earliest
    let readFrom = 0;
    const tookOver = () => {
      if (freshUntil !== Infinity) return;
      freshUntil = 0;
      readFrom = Date.now();
      this.s.onTakeover?.();
    };
    // Every cancellation of this approval (the deadline, a refused owner, close()) is the one shared call. What its answer
    // shows of the wallet is taken in, and written to the log, before the call resolves: close() may be followed by an exit.
    this.learners.set(p.id, (c) => {
      if (!tx || !c) return;
      // a restarted worker takes a transaction only from an answer about this request
      const found = this.w.isTx((c.body as { tx_hash?: unknown } | undefined)?.tx_hash) && (c.same === true || !this.s.resume) ? (c.body as { tx_hash: string }).tx_hash : null;
      if (found) hash = found;
      if (!c.walletAsked && !found) return;
      walletAsked = true;
      if (!loggedAsked || found) {
        loggedAsked = true;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: siteWord("state", lastState), hash: hash ?? undefined, sending: true });
      }
    });
    const end = async (status: "rejected" | "expired", why: string, sending: boolean, basis: Basis) => {
      if (this.parks(basis, why)) return;
      // a cancellation still in flight (close()) is waited for: its answer can show the wallet was asked
      const pending = this.cancellations.get(p.id);
      if (pending) {
        await pending;
        if (tx && walletAsked && !sending) {
          sending = true;
          // the end it was about to report said nothing about the wallet: it may have been asked before
          why = `${this.name} ended the request, but the owner's wallet may have been asked before, so whether anything was sent is unknown; the chain must be checked`;
        }
      }
      this.learners.delete(p.id);
      this.cancellations.delete(p.id);
      const reason = scrub(sending && /nothing was sent/i.test(why) ? unsaid(why) : why);
      this.open.delete(p.id);
      this.audit({ id: p.id, kind: p.kind, title: p.title, status, reason, hash: hash ?? undefined, sending: sending || undefined });
      this.settleOne(p, basis, why, { status, reason, sending });
    };
    const done = (o: OwnerActionOutcome, basis: Basis) => {
      if (this.parks(basis, "a result")) return;
      this.learners.delete(p.id);
      this.cancellations.delete(p.id);
      this.open.delete(p.id);
      this.settleOne(p, basis, "a result", o);
    };
    for (;;) {
      // a long poll that returns at once (wait=0 near the expiry, or a site that does not hold): at most one read a second
      const gap = this.s.minPollMs ?? 1000;
      const since = Date.now() - readAt;
      if (since < gap) await sleep(gap - since);
      if (this.stopped) return end("rejected", "the command stopped before this approval completed; check wallet activity before retrying", tx, null);
      const now = Date.now();
      // the command's own --timeout came first: cancel on the site, which works only while the wallet was not asked
      if (now >= expiry && !cancelTried && !walletAsked && lastState === "awaiting_owner" && now >= freshUntil) {
        cancelTried = true;
        const c = await this.cancelOnce(p.id, p.token);
        if (c?.cancelled) return end("expired", `the approval link expired without a completed approval, and the request was cancelled on ${this.name}; nothing was sent`, false, Confirmed.ofCancel(c));
        if (c?.walletAsked) walletAsked = true;
      }
      // past the expiry (and, once the wallet was asked, the time for its hash to come back) without a final answer: the
      // request may still be open on the site, so a transaction is never reported as "nothing sent"
      if (now > Math.max(expiry, readFrom) + (walletAsked ? grace : 30_000) && now >= freshUntil) {
        return end("expired", walletAsked ? `the wallet was asked to send, but no transaction came back from ${this.name}` : `no final answer from ${this.s.site} by the time the approval link expired; the request may still be open there`, tx, null);
      }
      const waitS = Math.max(0, Math.min(this.s.pollWaitS ?? 20, Math.ceil((expiry - now) / 1000)));
      readAt = Date.now();
      const r = await readSiteRequest({ site: this.s.site, id: p.id, token: p.token, wait: waitS, own: !!this.s.resume, fetchImpl: this.s.fetchImpl });
      if (!r.ok) {
        // an error answer can show the wallet was asked too (money_moved), and is logged like any other evidence
        if (r.asked) {
          walletAsked = true;
          if (!loggedAsked) {
            loggedAsked = true;
            this.audit({ id: p.id, kind: p.kind, title: p.title, status: siteWord("state", lastState), hash: hash ?? undefined, sending: true });
          }
        }
        // an access token the site expired: one renewal with a fresh agent signature, then the same read again
        if (r.status === 401 && r.code === "token_expired" && (!renewed || freshUntil === Infinity)) {
          renewed = true;
          if (await this.renewed(p)) continue;
        }
        // Before a request taken over has been read once, a token that cannot be renewed or a refused read is no answer about the
        // request: only the site saying it does not know the request (404, 410) or its documented refusal is.
        // A restarted worker settles on no read that was not a success: a 400, 404 or 410 (whatever its body) is not the site saying it
        // does not know the request, because the site answers a wrong or stale token the same way. It parks (the sink has no basis).
        if (this.s.resume && [400, 404, 410].includes(r.status ?? 0)) return end(tx ? "expired" : "rejected", `${this.s.site} no longer answers for this request (${r.reason})`, tx, null);
        // an answer about another request decides nothing about this one: its evidence is kept, nothing else (readSiteRequest `own`)
        const foreign = "foreign" in r && r.foreign === true;
        const answered = !foreign && ([404, 410].includes(r.status ?? 0) || (r.status === 400 && accountRefusalNext(r.code)));
        if (answered || (!foreign && [401, 403].includes(r.status ?? 0) && freshUntil !== Infinity)) {
          return end(tx ? "expired" : "rejected", `${this.s.site} no longer answers for this request (${r.reason})`, tx, null);
        }
        await sleep(Math.min(5000, 1000 + (Date.now() - lastContact) / 10));
        continue;
      }
      lastContact = Date.now();
      const v = r.view;
      tookOver();
      const state = String(v.state);
      const seenNow = seenOf(this.w, v);
      if (seenNow.asked) walletAsked = true;
      if (seenNow.hash) hash = seenNow.hash;
      const owner = this.w.owner(v.owner);
      const reason = siteReason(this.name, v);
      // evidence seen without a change of state is logged too, so a later reader of the log does not take it for nothing sent
      if (state !== lastState || (walletAsked && !loggedAsked)) {
        lastState = state;
        loggedAsked ||= walletAsked;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: siteWord("state", state), reason: reason || undefined, address: owner ?? undefined, hash: hash ?? undefined, sending: walletAsked || undefined });
      }
      // the site acts for another address than the owner recorded here, or names none (or none readable): refuse, on
      // every read. Once a transaction exists, the command reads it from the chain instead, where the sender must be the
      // owner recorded here.
      if (p.expected && !hash && (!owner || !this.w.same(owner, p.expected))) {
        const c = FINAL_STATES.has(state) ? null : await this.cancelOnce(p.id, p.token);
        if (c?.walletAsked) walletAsked = true;
        const who = owner ? `acts for ${owner}` : "no longer names the account this approval is for";
        return end("rejected", `${this.name} ${who}, not the owner recorded on this machine (${p.expected}); the request was ${c?.cancelled ? "cancelled" : "not used"}`, walletAsked || (tx && !FINAL_STATES.has(state) && c?.cancelled !== true), FINAL_STATES.has(state) ? Confirmed.ofView(p.id, v) : Confirmed.ofCancel(c));
      }
      switch (state) {
        case "awaiting_owner":
        case "sending":
          continue;
        case "linked":
          if (tx) break;
          if (!owner) return end("rejected", `${this.name} reported the agent as added without an owner address`, false, Confirmed.ofView(p.id, v));
          {
            // the owner is recorded only with their own signature over this link
            const problem = await ownerProofProblem(v.owner_proof, this.facts(owner, p.id, p.matchCode), this.proofOf(p, v));
            if (problem) return end("rejected", `${this.name} reported the agent as added to ${owner}, but ${problem}. Nothing was recorded`, false, Confirmed.ofView(p.id, v));
          }
          this.audit({ id: p.id, kind: p.kind, title: p.title, status: "connected", address: owner });
          return done({ status: "connected", address: owner, proof: proofOf(v.owner_proof) }, Confirmed.ofView(p.id, v));
        case "sent":
        case "confirmed":
        case "failed":
          if (!tx) break;
          // a hash the site reported as failed is still read from the chain, but it never settles there
          if (hash) return done({ status: "sent", address: owner ?? p.expected!, hash, ...(state === "failed" ? { siteFailed: siteFailedWords(this.name, v.reason_code) } : {}) }, Confirmed.ofView(p.id, v));
          if (state === "failed") return end("rejected", reason || `${this.name} reports the transaction failed, without a hash`, true, Confirmed.ofView(p.id, v));
          continue;
        case "rejected":
          return end("rejected", reason || (walletAsked ? "a rejection was reported after the wallet was asked to send; the chain must be checked" : `the owner rejected the request on ${this.name}`), tx && walletAsked, Confirmed.ofView(p.id, v));
        case "expired":
          return end("expired", reason || `the approval link expired on ${this.name} without a completed approval`, tx && walletAsked, Confirmed.ofView(p.id, v));
        case "cancelled":
          // cancelled, but the wallet may have been asked before: never "before the wallet was asked; nothing was sent"
          return end("rejected", tx && walletAsked ? `${reason ? `${reason}; ` : ""}the request was cancelled on ${this.name}, but the owner's wallet may have been asked before, so whether anything was sent is unknown; the chain must be checked` : reason || `the request was cancelled on ${this.name} before the wallet was asked; nothing was sent`, tx && walletAsked, Confirmed.ofView(p.id, v));
        case "unknown":
          // the site cannot tell whether the wallet sent it: never "nothing sent"; the command reads the chain
          if (hash && tx) return done({ status: "sent", address: owner ?? p.expected!, hash }, Confirmed.ofView(p.id, v));
          return end("expired", reason || `${this.name} cannot tell whether the wallet sent the transaction; the chain must be checked`, true, Confirmed.ofView(p.id, v));
      }
      if (v.final === true) return end("rejected", `${this.name} ended the request in state "${siteWord("state", state)}"${reason ? `: ${reason}` : ""}`, tx, Confirmed.ofView(p.id, v));
    }
  }

  /**
   * A link with steps: read until the site says the link and every step are final. Before the link is done the request
   * expires like a link; once it is done, the steps get the command's own --timeout again, from that moment, and a step
   * the wallet was asked for gets the send grace on top. Whatever is not final then is reported as it stands, and a step
   * the wallet was asked for is never "nothing sent".
   */
  private async pollBundle(p: Omit<Poll, "expected"> & { expected?: string; answer?: unknown; timeoutMs: number; kinds: HostedStep["kind"][]; settle: (b: HostedBundleOutcome) => void }) {
    const grace = this.s.sendingGraceMs ?? 120_000;
    const steps: HostedStepOutcome[] = p.kinds.map((kind) => ({ kind, state: "queued", hash: null, reason: "", reasonCode: null, walletAsked: false }));
    let owner: string | null = null;
    let linkProof: { message: string; signature: string } | undefined;
    let renewed = false;
    let linkedAt = 0;
    let linkState = "awaiting_owner";
    let linkReason = "";
    let lastState = "awaiting_owner";
    let lastContact = Date.now();
    let cancelTried = false;
    let timedOut = false;
    let readAt = 0;
    // as in poll(): a request taken over is read before any expiry is acted on
    let freshUntil = p.fresh ? Infinity : 0;
    let readFrom = 0;
    const tookOver = () => {
      if (freshUntil !== Infinity) return;
      freshUntil = 0;
      readFrom = Date.now();
      this.s.onTakeover?.();
    };
    /** The link was refused (no valid owner proof): its steps were withdrawn when the site confirmed it, else unknown. */
    let refusedLink: { withdrawn: boolean } | null = null;
    const asked = () => steps.some((s) => s.walletAsked);
    // Positive proof. A step is "nothing sent" only when an answer about this request (its id, at both envelope levels)
    // gave it a state that says it was never asked, with no evidence on it, and no answer showed evidence that cannot be
    // pinned on a step. An unlinked link is also proven when the site confirmed it withdrawn or ended.
    /** Per step: the last answer about this request said it ended without being asked. */
    const proven = steps.map(() => false);
    /** Evidence no step accounts for: from here on no step is proven. Only ever set. */
    let unexplained = false;
    /** The site confirmed this request cancelled or final. */
    let withdrawn = false;
    /** The site's confirmed cancel of this request, once it has given one. */
    let cancelConfirmed: Basis = null;
    const NOT_ASKED = new Set(["skipped", "cancelled", "rejected", "expired"]);
    /** An answer about this request: its id, and no other id in its error. */
    const own = (v: any) => !!v && typeof v === "object" && v.id === p.id && !(v.error && typeof v.error === "object" && v.error.id != null && v.error.id !== p.id);
    const unexplain = () => {
      if (!unexplained) this.audit({ id: p.id, kind: p.kind, title: p.title, status: siteWord("state", lastState), sending: true });
      unexplained = true;
      steps.forEach((s, i) => {
        proven[i] = false;
        if (s.walletAsked) return;
        s.walletAsked = true;
        this.audit({ id: p.id, kind: s.kind, title: p.title, status: s.state, reason: s.reason || undefined, hash: s.hash ?? undefined, sending: true });
      });
    };
    /**
     * One list of steps from an answer. Evidence on an entry goes to its step (by index and kind), and an entry with
     * evidence that matches no step is the request's. Only an answer about this request (`trusted`) changes a step's
     * state, or proves it. Returns the steps whose evidence it carried.
     */
    const absorb = (list: unknown, trusted: boolean): Set<number> => {
      const carried = new Set<number>();
      if (!Array.isArray(list)) return carried;
      const clean = steps.map(() => true);
      const listed = steps.map(() => false);
      list.forEach((w: any, pos) => {
        if (!w || typeof w !== "object") return;
        const i = Number.isInteger(w.index) ? w.index : pos;
        const s = steps[i];
        const ev = sentEvidence(w);
        if (!s || w.kind !== s.kind) {
          if (ev) unexplain();
          return;
        }
        listed[i] = true;
        const before = s.state;
        const wasAsked = s.walletAsked;
        if (ev) {
          carried.add(i);
          s.walletAsked = true;
          // a restarted worker takes a transaction only from an answer about this request
          if (this.w.isTx(w.tx_hash) && (trusted || !this.s.resume)) s.hash = w.tx_hash;
        }
        if (trusted) {
          s.state = typeof w.state === "string" ? siteWord("state", w.state) : s.state;
          s.reason = siteReason(this.name, w) || s.reason;
          s.reasonCode = typeof w.reason_code === "string" ? siteWord("code", w.reason_code) : s.reasonCode;
        }
        if (ev || !trusted || !NOT_ASKED.has(w.state)) clean[i] = false;
        if (s.state !== before || (s.walletAsked && !wasAsked)) this.audit({ id: p.id, kind: s.kind, title: p.title, status: s.state, reason: s.reason || undefined, hash: s.hash ?? undefined, sending: s.walletAsked || undefined });
      });
      if (trusted) steps.forEach((_, i) => { if (listed[i]) proven[i] = clean[i] && !unexplained; });
      return carried;
    };
    /**
     * Everything an answer shows, before anything else is done with it: its steps and its error's steps, then what its
     * envelope says. A summary (wallet_asked, tx_hash, a sending state) is explained only by a step of the same answer
     * that carries evidence; money_moved never is.
     */
    const learn = (v: any, trusted: boolean) => {
      if (!v || typeof v !== "object") return;
      const inner = v.error && typeof v.error === "object" ? v.error : undefined;
      const carried = absorb(v.steps, trusted);
      for (const i of absorb(inner?.steps, false)) carried.add(i);
      for (const x of [v, inner]) {
        if (!x) continue;
        const moved = x.money_moved !== undefined && x.money_moved !== null && x.money_moved !== false;
        const flag = x.wallet_asked === true || (typeof x.tx_hash === "string" && x.tx_hash !== "");
        const sendState = WALLET_STATES.has(x.state) && ![...carried].some((i) => steps[i].state === x.state || x.state === "unknown" || x.state === "confirmed");
        if (moved || (flag && carried.size === 0) || sendState) unexplain();
      }
    };
    /** The answer to a cancel: its evidence always, its states and finality only when it is about this request. */
    const learnCancel = (c: Awaited<ReturnType<typeof cancelSiteRequest>>) => {
      if (!c) return;
      // a confirmed cancel has no evidence in it; its view, when it has one, is this request's
      if (c.cancelled) {
        learn(c.view, true);
        withdrawn = true;
        cancelConfirmed = Confirmed.ofCancel(c);
        return;
      }
      learn(c.body, c.same === true);
      if (c.same === true && (c.body as any)?.final === true) withdrawn = true;
    };
    // a cancellation another caller sends (close()) is taken in here the moment its answer arrives
    this.learners.set(p.id, learnCancel);
    /** A step as it ends: proven, sent (its hash is read from the chain), or unknown. */
    const isClean = (i: number) => !unexplained && !steps[i].walletAsked && !steps[i].hash && (proven[i] || (withdrawn && !owner && !refusedLink));
    const finish = async (why: string | null, basis: Basis) => {
      // a cancellation still in flight (close()) is waited for: its answer is learned before anything is concluded
      const pending = this.cancellations.get(p.id);
      if (pending) await pending;
      if (this.parks(basis, why ?? "the request was refused")) return;
      this.open.delete(p.id);
      this.learners.delete(p.id);
      this.cancellations.delete(p.id);
      steps.forEach((s, i) => {
        if (s.hash) {
          // sent: the command reads it from the chain. A state that says it was never asked contradicts the hash.
          if (NOT_ASKED.has(s.state)) Object.assign(s, { state: "unknown", reason: `${this.name} gave this step a transaction and also said it was never asked; read the chain` });
          return;
        }
        if (isClean(i)) {
          if (!NOT_ASKED.has(s.state)) Object.assign(s, { state: "skipped", reason: s.reason || why || "the agent was not added, so this step was never asked" });
          return;
        }
        Object.assign(s, {
          state: "unknown",
          reason: s.walletAsked
            ? STEP_FINAL.has(s.state) ? `${this.name} showed the owner's wallet may have been asked, so whether this step was sent is unknown; read the chain` : s.reason || why || `the wallet was asked to send, but no transaction came back from ${this.name}`
            : `${this.s.site} did not confirm this step was withdrawn or never asked${why ? ` (${why})` : ""}; it may still be sent, so read the chain later`,
        });
      });
      const sending = unexplained || steps.some((s, i) => !isClean(i));
      const link: OwnerActionOutcome = owner
        ? { status: "connected", address: owner, proof: linkProof }
        : linkState === "expired" || why
          ? { status: "expired", reason: linkReason || why || `the approval link expired on ${this.name} without a completed approval`, sending }
          : { status: "rejected", reason: linkReason || (linkState === "cancelled" ? `the request was cancelled on ${this.name}; nothing was sent` : `the owner rejected the request on ${this.name}`), sending };
      if ("reason" in link && sending) link.reason = unsaid(link.reason);
      this.audit({ id: p.id, kind: p.kind, title: p.title, status: owner ? "connected" : link.status, address: owner ?? undefined, reason: owner ? undefined : (link as { reason?: string }).reason, sending: sending || undefined });
      for (const s of steps) this.audit({ id: p.id, kind: s.kind, title: p.title, status: s.state, reason: s.reason || undefined, hash: s.hash ?? undefined, sending: s.walletAsked || s.state === "unknown" || undefined });
      if ("reason" in link) link.reason = scrub(link.reason);
      for (const s of steps) s.reason = scrub(s.reason);
      this.settleBundle(p, basis, why ?? "", { link, steps });
    };
    /**
     * What a refusal of the link (a different owner, an owner proof that fails) rests on: the whole bundle final in the read, the
     * site's confirmed cancel, or the cancel's own-id answer when that is the bundle final as a whole. A step's `sent` or the link's
     * `linked` is none of these.
     */
    const refusalBasis = (v: unknown, c: Awaited<ReturnType<typeof cancelSiteRequest>>): Basis =>
      Confirmed.ofWhole(p.id, v) ?? Confirmed.ofCancel(c) ?? (c?.same === true ? Confirmed.ofWhole(p.id, c.body) : null);
    /**
     * An answer about this request, as it stands: the link's owner proof, the steps' states, finality. True when it ended the
     * request (finish was called). Used for every read, and in a restarted worker for the site's answer to the cancel.
     */
    const view = async (v: any): Promise<boolean> => {
      const state = String(v.state);
      const reason = siteReason(this.name, v);
      const named: string | null = owner ? null : this.w.owner(v.owner);
      if (named && p.expected && !this.w.same(named, p.expected)) {
        // the site added the agent to another account than the owner recorded here: its steps are withdrawn, nothing is recorded
        refusedLink = { withdrawn: false };
        const c = await this.cancelOnce(p.id, p.token);
        learnCancel(c);
        refusedLink.withdrawn = steps.every((s, i) => !s.hash && isClean(i));
        linkState = "rejected";
        linkReason = `${this.name} reported the agent as added to ${named}, but this machine records the owner ${p.expected}. Nothing was recorded; its wallet steps were ${refusedLink.withdrawn ? "withdrawn" : "not confirmed withdrawn"}`;
        await finish(null, refusalBasis(v, c));
        return true;
      }
      if (named) {
        // the owner is recorded only with their own signature over this link; without it the steps are withdrawn
        const problem = await ownerProofProblem(v.owner_proof, this.facts(named, p.id, p.matchCode), this.proofOf(p, v));
        if (problem) {
          refusedLink = { withdrawn: false };
          const c = await this.cancelOnce(p.id, p.token);
          learnCancel(c);
          refusedLink.withdrawn = steps.every((s, i) => !s.hash && isClean(i));
          linkState = "rejected";
          linkReason = `${this.name} reported the agent as added to ${named}, but ${problem}. Nothing was recorded; its wallet steps were ${refusedLink.withdrawn ? "withdrawn" : "not confirmed withdrawn"}`;
          await finish(null, refusalBasis(v, c));
          return true;
        }
        owner = named;
        linkProof = proofOf(v.owner_proof);
        linkedAt = Date.now();
      }
      if (!owner) {
        // the cancel at the command's own timeout ends the link as expired, not as rejected
        linkState = timedOut && state === "cancelled" ? "expired" : state;
        linkReason = reason;
      }
      if (state !== lastState) {
        lastState = state;
        this.audit({ id: p.id, kind: p.kind, title: p.title, status: siteWord("state", state), reason: reason || undefined, address: owner ?? undefined });
      }
      if (v.final === true) {
        if (!owner && state === "linked") linkReason = `${this.name} reported the agent as added without an owner address`;
        else withdrawn = true;
        await finish(null, Confirmed.ofWhole(p.id, v));
        return true;
      }
      return false;
    };
    // the creation answer, before any read
    learn(p.answer, own(p.answer));
    for (;;) {
      const gap = this.s.minPollMs ?? 1000;
      const since = Date.now() - readAt;
      if (since < gap) await sleep(gap - since);
      if (this.stopped) {
        // close() cancels through the same shared call, so this one reuses its answer. A request taken over is left open.
        if (!cancelTried && !this.s.resume) {
          cancelTried = true;
          learnCancel(await this.cancelOnce(p.id, p.token));
        }
        return finish("the command stopped before this request completed; check wallet activity before retrying", null);
      }
      const now = Date.now();
      // before the link: the link's expiry. After it: --timeout again for the steps, from the moment it was linked.
      const deadline = linkedAt ? Math.max(Math.min(p.localDeadline, p.siteExpiry), linkedAt + p.timeoutMs) : Math.min(p.localDeadline, p.siteExpiry);
      // at the deadline the request is withdrawn on the site (the steps it asked the wallet for stay, as possibly sent)
      if (now >= deadline && !cancelTried && now >= freshUntil) {
        cancelTried = true;
        const c = await this.cancelOnce(p.id, p.token);
        learnCancel(c);
        // The site's answer to the cancel can be the request as it stands: linked, its steps sent, final. A restarted worker takes
        // that as it takes a read (the owner proof is checked, the steps are taken in) before anything reads as expired.
        if (this.s.resume && c?.same === true && !c.cancelled && (await view(c.body))) return;
        if (!owner && c) {
          timedOut = true;
          linkState = "expired";
        }
        if (withdrawn) return finish(owner ? null : `the approval link expired without a completed approval, and the request was cancelled on ${this.name}; nothing was sent`, cancelConfirmed);
      }
      if (now > Math.max(deadline, readFrom) + (asked() ? grace : (this.s.quietGraceMs ?? 30_000)) && now >= freshUntil) return finish(`no final answer from ${this.s.site} in time; the request may still be open there`, null);
      const waitS = Math.max(0, Math.min(this.s.pollWaitS ?? 20, Math.ceil((deadline - now) / 1000)));
      readAt = Date.now();
      const r = await readSiteRequest({ site: this.s.site, id: p.id, token: p.token, wait: waitS, own: !!this.s.resume, fetchImpl: this.s.fetchImpl });
      if (!r.ok) {
        if (r.asked) unexplain();
        // an access token the site expired: one renewal with a fresh agent signature, then the same read again
        if (r.status === 401 && r.code === "token_expired" && (!renewed || freshUntil === Infinity)) {
          renewed = true;
          if (await this.renewed(p)) continue;
        }
        // as in poll(): before the request has been read once, only the site's own "unknown request" or refusal is an answer, and
        // an answer that names another request (readSiteRequest `own`) is none
        const foreign = "foreign" in r && r.foreign === true;
        const answered = !foreign && ([404, 410].includes(r.status ?? 0) || (r.status === 400 && accountRefusalNext(r.code)));
        // a restarted worker settles on no read that was not a success (as in poll()): a 400, 404 or 410 parks, whatever its body
        const refusedRead = this.s.resume ? [400, 404, 410].includes(r.status ?? 0) : answered;
        if (refusedRead || (!foreign && [401, 403].includes(r.status ?? 0) && freshUntil !== Infinity)) {
          // withdraw it first: an answer that confirms it is the only proof the steps were never asked
          if (!cancelTried && !this.s.resume) {
            cancelTried = true;
            learnCancel(await this.cancelOnce(p.id, p.token));
          }
          return finish(`${this.s.site} no longer answers for this request (${r.reason})`, null);
        }
        await sleep(Math.min(5000, 1000 + (Date.now() - lastContact) / 10));
        continue;
      }
      lastContact = Date.now();
      const v = r.view;
      const trusted = own(v);
      // first of all: what this answer shows of the wallet, before its owner proof, step states or finality are looked at
      learn(v, trusted);
      if (!trusted) continue; // about another request: its evidence is kept, nothing else
      tookOver();
      if (await view(v)) return;
    }
  }

  private audit(line: { id: string; kind: string; title: string; status: string; reason?: string; address?: string; hash?: string; sending?: boolean; proof?: string }) {
    if (!this.s.auditPath) return;
    try {
      mkdirSync(dirname(this.s.auditPath), { recursive: true, mode: 0o700 });
      // a second layer: nothing shaped like an access token reaches the audit file, whatever a line carries
      appendFileSync(this.s.auditPath, `${scrub(JSON.stringify({ at: new Date().toISOString(), site: this.s.site, ...line }))}\n`, { mode: 0o600 });
    } catch {
      // an unwritable audit file never stops the owner from deciding
    }
  }
}

/**
 * The page log's line for the command's verdict on a transaction the site reported, so always after the wallet was asked:
 * failed only with the chain's proof (../src/core/proofs.mjs), else unknown, as on the page on this machine.
 */
function verdictLine(id: string, kind: string, title: string, verdict: OwnerVerdict) {
  const status = verdict.outcome === "failed" && !isProof(verdict.proof) ? "unknown" : verdict.outcome;
  return { id, kind, title, status, ...(status === "failed" ? { proof: verdict.proof } : {}), reason: status === "confirmed" ? undefined : scrub(siteText(verdict.message)), hash: verdict.hash };
}

/** The reason of a 401 agent_proof answer: { error: { code: "agent_proof", reason } }, or "". */
function proofReason(json: any): string {
  const e = json?.error;
  return e && typeof e === "object" && e.code === "agent_proof" && typeof e.reason === "string" ? e.reason : "";
}

/** The words for an agent already added on this chain, when an add-agent request with steps was asked for. */
function alreadyLinkedWords(site: string, owner: string | null, rail: HostedRail): string {
  return `this agent already belongs to an account on ${site}${owner ? ` (${owner})` : ""}, so there is nothing to add and no request was created. ${rail === "tempo" ? "A budget is then asked for separately, with its own approval link" : "Gas and a budget are then asked for separately, each with its own approval link"}; nothing was sent`;
}
function alreadyLinkedNext(rail: HostedRail, chain: string, site: string): string {
  const r = railFlags(rail, chain);
  const steps = rail === "tempo"
    ? `A budget is a separate owner step: superstables budget grant ${r} --amount A (one approval link)`
    : `Gas and a budget are separate owner steps: superstables budget fund-agent ${r}, then superstables budget grant ${r} --amount A (one approval link each)`;
  return `tell the owner the site reports that this agent already belongs to an account and end your turn. ${steps}. If this machine has no owner on record yet, setup cannot take the site's word for it: the owner removes the agent on that account's page on the site, then superstables budget setup ${r} --hosted --site ${site} asks them to add it again and sign a new owner proof`;
}

/**
 * Why the site's steps are not the ones asked for, or "" when they are: same kinds and order, and for each step the same
 * transaction (to, data and value, each present and in the site's format: a 20-byte 0x address, 0x hex data, a 0x hex
 * quantity) or, on Solana, the same amount (a string of digits, as sent). Anything missing or of another type is refused.
 */
export function stepsProblem(sent: HostedStep[], got: unknown[] | undefined): string {
  if (!Array.isArray(got)) return "no steps";
  if (got.length !== sent.length) return `${got.length} steps instead of ${sent.length}`;
  for (let i = 0; i < sent.length; i++) {
    const g = got[i] as any;
    if (!g || typeof g !== "object" || g.kind !== sent[i].kind) return `step ${i} is ${g?.kind === "fund_agent" || g?.kind === "grant" ? g.kind : g?.kind === undefined ? "missing" : "unexpected"}, not ${sent[i].kind}`;
    const want = sent[i];
    if (want.solana) {
      // solana: the site builds the transaction later; it must echo the amount asked for, as the same string of digits
      const amount = g.solana?.amount_atomic;
      if (amount === undefined || amount === null) return `step ${i} (${want.kind}) has no amount`;
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) return `step ${i} (${want.kind}) has an amount that is not a string of digits`;
      if (amount !== want.solana.amount_atomic) return `step ${i} (${want.kind}) has another amount`;
      continue;
    }
    if (!want.transaction) continue;
    const problem = txProblem(want.transaction, g.transaction);
    if (problem) return `step ${i} (${want.kind}) has ${problem}`;
  }
  return "";
}

/** A transaction in the site's format: to, data and value each 0x hex. */
const isTx = (t: any): boolean => !!t && typeof t === "object" && typeof t.to === "string" && /^0x[0-9a-fA-F]{40}$/.test(t.to) && typeof t.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(t.data) && typeof t.value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(t.value);

/** Why the site's transaction `t` is not `want`, or "": each of to, data and value present, in the site's format, and the same. */
function txProblem(want: { to: string; data: string; value: string }, t: any): string {
  if (!t || typeof t !== "object") return "no transaction";
  if (!isTx(t)) return "an incomplete transaction (to, data and value must each be 0x hex)";
  return t.to.toLowerCase() !== want.to.toLowerCase() || t.data.toLowerCase() !== want.data.toLowerCase() || BigInt(t.value) !== BigInt(want.value) ? "another transaction" : "";
}

/**
 * Why the site's read of a request the connector created is not the request signed here (`body`), or "": this request's id and
 * kind, this agent, rail and chain, and the exact transaction (or Solana amount), or for a link the same steps, the owner it
 * names and the owner-proof version it asks for. A field the read leaves out is a mismatch: it cannot be checked.
 */
type SignedWant = { id: string; kind: string; rail: HostedRail; chain: string; agent: string; body: Record<string, any>; then?: HostedStep[] };
function signedProblem(v: any, f: SignedWant, same: (a?: string | null, b?: string | null) => boolean): string {
  if (!v || typeof v !== "object" || v.id !== f.id) return "the site's answer is about another request";
  if (v.kind !== f.kind) return "it is another kind of request";
  if (!same(v.agent, f.agent)) return "it is another agent's request";
  if (v.rail !== f.rail || (v.chain && typeof v.chain === "object" ? v.chain.key : v.chain) !== f.chain) return "it is for another chain";
  if (f.kind !== "link") {
    if (f.body.transaction) {
      const problem = txProblem(f.body.transaction, v.transaction);
      return problem ? `it has ${problem}` : "";
    }
    return (v.solana?.amount_atomic ?? null) === (f.body.solana?.amount_atomic ?? null) ? "" : "it has another amount";
  }
  const steps = f.then ? stepsProblem(f.then, v.steps) : Array.isArray(v.steps) && v.steps.length ? "steps that were not signed" : "";
  if (steps) return `its wallet steps are not the ones signed (${steps})`;
  if (f.body.expected_owner !== undefined && !same(v.expected_owner, f.body.expected_owner)) return "it does not name the owner recorded on this machine";
  if (f.body.owner_proof_version === 2 && v.owner_proof_version !== 2) return "it does not ask for the owner proof that names the account";
  return "";
}

/** The request kinds, rails and chain keys the site's budget API sends, so a read naming anything else is garbled, not other terms. */
const SITE_KINDS = new Set(["link", "grant", "revoke", "fund_agent"]);
const SITE_CHAINS: Record<string, readonly string[]> = { evm: EVM_CHAIN_KEYS, tempo: ["moderato"], solana: ["devnet"] };

/**
 * Whether the site's read carries every field signedProblem compares, each in the site's format: a kind, rail and chain the API
 * sends, an agent address of this rail (`address`). Only then does a difference show another request; a read that leaves one out,
 * or garbles it, shows nothing.
 */
function readComplete(v: any, f: SignedWant, address: (v: unknown) => string | null): boolean {
  if (!v || typeof v !== "object" || v.id !== f.id || !SITE_KINDS.has(v.kind) || !address(v.agent) || !Object.hasOwn(SITE_CHAINS, v.rail)) return false;
  if (!SITE_CHAINS[v.rail].includes(v.chain && typeof v.chain === "object" ? v.chain.key : v.chain)) return false;
  const amount = (x: any) => typeof x?.solana?.amount_atomic === "string" && /^\d+$/.test(x.solana.amount_atomic);
  if (f.kind !== "link") return f.body.transaction ? isTx(v.transaction) : amount(v);
  const then = f.then ?? [];
  if (then.length && !(Array.isArray(v.steps) && v.steps.every((g: any, i: number) => g && typeof g === "object" && typeof g.kind === "string" && (g.kind !== then[i]?.kind || (then[i].transaction ? isTx(g.transaction) : !then[i].solana || amount(g)))))) return false;
  if (f.body.expected_owner !== undefined && typeof v.expected_owner !== "string") return false;
  return f.body.owner_proof_version !== 2 || typeof v.owner_proof_version === "number";
}
