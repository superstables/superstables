// A stand-in for superstables.com's budget API (/api/v1/budget/), for the hosted approval tests. It checks each agent
// request the way the protocol says the site does (agent request proof v2): the signature over the exact six-line text
// (EIP-191 for an EVM agent, ed25519 for a Solana agent) naming this site's own origin, the agent in the headers and the
// body, the timestamp, and a nonce never seen before for that agent. When a link is linked, it answers with the owner's
// link proof, signed with that owner's test key (OWNER_KEYS), unless a test sets another `owner_proof`. Requests move
// through their states when a test (or `onPoll`) says so. No network, no real key. The texts are spelled out here from the
// protocol, not taken from the client, so a client that drifts from the protocol fails these tests.
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readBody, startServer, type TestServer } from "./servers.js";

// ── owners with test keys ────────────────────────────────────────────────────────────────────────────────

/** An EVM owner's test key: 32 bytes of `byte`. */
export const evmOwnerKey = (byte: string) => `0x${byte.repeat(32)}` as Hex;
/** An EVM owner's address, from evmOwnerKey(byte). */
export const evmOwner = (byte: string) => privateKeyToAccount(evmOwnerKey(byte)).address;
/** A Solana owner's keypair, from a 32-byte seed of `n`. */
export const solanaOwnerKeypair = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n));
/** A Solana owner's base58 address, from solanaOwnerKeypair(n). */
export const solanaOwner = (n: number) => solanaOwnerKeypair(n).publicKey.toBase58();

/** The owners the fake site can sign a link proof for, by address (EVM lowercase, Solana base58). */
export const OWNER_KEYS = new Map<string, Hex | Uint8Array>([
  ...["22", "33", "55", "66", "77", "88"].map((b) => [evmOwner(b).toLowerCase(), evmOwnerKey(b)] as [string, Hex]),
  ...Array.from({ length: 12 }, (_, i) => [solanaOwner(i + 1), solanaOwnerKeypair(i + 1).secretKey] as [string, Uint8Array]),
]);

export type LinkFacts = { site: string; owner: string; agent: string; rail: string; chain: string; linkId: string; code: string };

/** The owner link proof's text, exactly as the protocol spells it. */
export function linkProofText(f: LinkFacts): string {
  const owner = f.rail === "solana" ? f.owner : getAddress(f.owner);
  return `Superstables: link an agent to my account\nsite: ${f.site}\nowner: ${owner}\nagent: ${f.agent}\nrail: ${f.rail}\nchain: ${f.chain}\nlink: ${f.linkId}\ncode: ${f.code}`;
}

/** The owner's wallet signs the link: { scheme, message, signature }, with the owner's test key (or `key`). */
export async function signLinkProof(f: LinkFacts, opts: { key?: Hex | Uint8Array; message?: string } = {}) {
  const message = opts.message ?? linkProofText(f);
  const key = opts.key ?? OWNER_KEYS.get(f.rail === "solana" ? f.owner : f.owner.toLowerCase());
  if (!key) throw new Error(`fake site: no test key for owner ${f.owner}`);
  if (key instanceof Uint8Array) {
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
    const priv = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64(key.subarray(0, 32)), x: b64(key.subarray(32)) }, format: "jwk" });
    return { scheme: "ed25519", message, signature: `0x${signBytes(null, Buffer.from(message, "utf8"), priv).toString("hex")}` };
  }
  return { scheme: "eip191", message, signature: await privateKeyToAccount(key).signMessage({ message }) };
}

/** A wallet step after a link (`then`): the site asks the owner's wallet for it once the agent is linked. */
export interface FakeStep {
  index: number;
  kind: "fund_agent" | "grant";
  state: string;
  tx_hash: string | null;
  reason: string | null;
  reason_code: string | null;
  wallet_asked: boolean;
  transaction?: { to: string; data: string; value: string };
  solana?: { amount_atomic: string };
}

export interface FakeRequest {
  id: string;
  kind: "link" | "grant" | "revoke" | "fund_agent";
  token: string;
  body: Record<string, any>;
  state: string;
  owner: string | null;
  tx_hash: string | null;
  wallet_asked?: boolean;
  reason?: string | null;
  polls: number;
  cancels: number;
  /** A link with `then`: its wallet steps. The test (or onPoll) moves them along, with `owner` once linked. */
  steps?: FakeStep[];
  /** The match code this link showed. */
  matchCode?: string;
  /**
   * The owner link proof the site answers with once linked: undefined signs one with the owner's test key; null leaves it
   * out; anything else is sent as it is.
   */
  owner_proof?: unknown;
}

export interface FakeSite extends TestServer {
  requests: FakeRequest[];
  /** Each POST that reached the site, with whether its agent proof checked out. */
  posts: { path: string; ok: boolean; why?: string }[];
  /** The site's own canonical origin, which every agent proof must name (default: its URL). */
  origin: string;
  /** The headers of each POST, as received. */
  headers: Record<string, string>[];
  /** The account the next request belongs to (approvals: the owner from the first read). */
  owner: string | null;
  /** Called on every read, before the answer: move the request along. */
  onPoll?: (r: FakeRequest) => void;
  /** Answer POSTs with this status and error instead (a refusal). */
  refuse?: { status: number; error: string };
  /** Answer the next POST that checks out with this status and body instead of creating a request. */
  reply?: (path: string) => { status: number; body: unknown } | undefined;
  services?: unknown;
  /** Agents already linked, by address (lowercase), with their owner: a link with `then` for one of them is refused (409). */
  linked?: Record<string, string>;
  /** Answer every cancel with a 503, as a site that can't be reached at that moment. */
  cancelFails?: boolean;
  /** The approval URL the site answers with, instead of its own /approve/budget/<id>#<token>. */
  approvalUrl?: (id: string) => string;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const FINAL = new Set(["linked", "confirmed", "failed", "rejected", "expired", "cancelled", "unknown"]);
const STEP_FINAL = new Set(["confirmed", "failed", "rejected", "expired", "unknown", "skipped", "cancelled"]);
const LINK_ENDED = new Set(["rejected", "expired", "cancelled"]);

/**
 * The state of a link with steps, as the site reports it: the link's own state until it is linked; then confirmed when
 * every step is, else the first step that is not. Final once the link and every step are final.
 */
function bundleState(r: FakeRequest): { state: string; final: boolean } {
  const steps = r.steps!;
  if (!r.owner) return { state: r.state, final: LINK_ENDED.has(r.state) && steps.every((s) => STEP_FINAL.has(s.state)) };
  const open = steps.find((s) => s.state !== "confirmed");
  return { state: open ? open.state : "confirmed", final: steps.every((s) => STEP_FINAL.has(s.state)) };
}

/** Why a `then` is not valid, as the site checks it, or undefined. Solana steps carry an amount, the others a transaction. */
function thenProblem(then: unknown, rail: string): { step?: number; message: string } | undefined {
  if (!Array.isArray(then) || then.length === 0 || then.length > 2) return { message: "then has 1 or 2 steps" };
  const seen = new Set<string>();
  for (const [i, t] of then.entries()) {
    if (!t || !["fund_agent", "grant"].includes(t.kind) || seen.has(t.kind)) return { step: i, message: "each step is fund_agent or grant, at most once" };
    if (rail === "tempo" && t.kind === "fund_agent") return { step: i, message: "tempo has no fund_agent" };
    seen.add(t.kind);
    if (rail === "solana") {
      if (t.transaction !== undefined || !/^[1-9]\d*$/.test(String(t.solana?.amount_atomic ?? ""))) return { step: i, message: "a solana step is { kind, solana: { amount_atomic } }" };
      continue;
    }
    const x = t.transaction;
    if (!x || !/^0x[0-9a-fA-F]{40}$/.test(x.to) || !/^0x([0-9a-fA-F]{2})*$/.test(x.data) || !/^0x[0-9a-fA-F]+$/.test(x.value)) return { step: i, message: "not a transaction" };
  }
  return undefined;
}

export async function startFakeSite(): Promise<FakeSite> {
  let n = 0;
  const site = {} as FakeSite;
  site.requests = [];
  site.posts = [];
  site.headers = [];
  site.owner = null;
  /**
   * Nonces seen, by agent, with the request each one created (or null): an exact resend of a request that created one is
   * answered 409 proof_reused with its id; any other repeat is refused (401, reason "replayed").
   */
  const nonces = new Map<string, string | null>();
  const stepView = (s: FakeStep) => ({ ...s, ...(s.tx_hash ? { tx_url: `https://sepolia.basescan.org/tx/${s.tx_hash}` } : {}), terms: { title: s.kind } });
  /** A linked link carries the owner's proof over it, as the site stores it when the owner signs. */
  const proofOf = async (r: FakeRequest) => {
    if (r.kind !== "link" || !r.owner) return {};
    if (r.owner_proof === null) return {};
    if (r.owner_proof !== undefined) return { owner_proof: r.owner_proof };
    if (!OWNER_KEYS.has(r.body.rail === "solana" ? r.owner : r.owner.toLowerCase())) return {};
    r.owner_proof = await signLinkProof({ site: site.origin, owner: r.owner, agent: r.body.agent, rail: r.body.rail, chain: r.body.chain, linkId: r.id, code: r.matchCode ?? "ABC-DEF" });
    return { owner_proof: r.owner_proof };
  };
  const view = async (r: FakeRequest) => {
    if (r.steps) {
      const { state, final } = bundleState(r);
      const hashes = r.steps.map((s) => s.tx_hash).filter(Boolean);
      return { id: r.id, kind: r.kind, state, final, owner: r.owner, ...(await proofOf(r)), tx_hash: null, reason: r.reason ?? null, steps: r.steps.map(stepView), next_action: { type: ["confirmed", "unknown"].includes(state) ? "verify_on_chain" : final ? "stop" : "wait_for_owner", ...(["confirmed", "unknown"].includes(state) ? { tx_hashes: hashes } : {}) } };
    }
    return { id: r.id, kind: r.kind, state: r.state, final: FINAL.has(r.state), owner: r.owner, ...(r.state === "linked" ? await proofOf(r) : {}), tx_hash: r.tx_hash, reason: r.reason ?? null, ...(r.wallet_asked !== undefined ? { wallet_asked: r.wallet_asked } : {}), next_action: { type: FINAL.has(r.state) ? "stop" : "wait_for_owner" } };
  };
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    if (req.method === "POST" && (url.pathname === "/api/v1/budget/links" || url.pathname === "/api/v1/budget/approvals")) {
      site.headers.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])));
      const proof = await checkProof(req, site.origin, url.pathname, raw);
      const seen = proof.ok ? nonces.get(proof.nonceKey) : undefined;
      const why = !proof.ok ? proof.reason : seen !== undefined ? "replayed" : undefined;
      site.posts.push({ path: url.pathname, ok: !why, why });
      if (proof.ok && seen) return json(res, 409, { error: { code: "proof_reused", message: "This signed request was already used.", id: seen }, id: seen, state: site.requests.find((x) => x.id === seen)?.state });
      if (why) return json(res, 401, { error: { code: "agent_proof", reason: why, message: why === "signature" ? `The signature does not verify for ${site.origin}.` : `The agent proof was refused (${why}).` } });
      // the nonce is used now, whatever comes next
      if (proof.ok) nonces.set(proof.nonceKey, null);
      if (site.refuse) return json(res, site.refuse.status, { error: site.refuse.error });
      const custom = site.reply?.(url.pathname);
      if (custom) return json(res, custom.status, custom.body);
      const body = JSON.parse(raw);
      const link = url.pathname.endsWith("/links");
      if (link && body.then !== undefined) {
        const bad = thenProblem(body.then, body.rail);
        if (bad) return json(res, 400, { error: { code: "invalid_then", message: bad.message, ...(bad.step !== undefined ? { step: bad.step } : {}) } });
        const owner = site.linked?.[body.rail === "solana" ? String(body.agent) : String(body.agent).toLowerCase()];
        if (owner) return json(res, 409, { error: { code: "already_linked", message: "This agent is already linked on this chain. Ask for gas and a budget with separate approvals.", owner } });
      }
      const id = `${link ? "bl" : "ba"}_test${String(++n).padStart(4, "0")}`;
      const r: FakeRequest = { id, kind: link ? "link" : body.kind, token: `ssbt_test_${id}secret`, body, state: "awaiting_owner", owner: link ? null : site.owner, tx_hash: null, polls: 0, cancels: 0, matchCode: "ABC-DEF" };
      if (link && Array.isArray(body.then)) r.steps = body.then.map((t: any, index: number) => ({ index, kind: t.kind, state: "queued", tx_hash: null, reason: null, reason_code: null, wallet_asked: false, ...(t.solana ? { solana: t.solana } : { transaction: t.transaction }) }));
      site.requests.push(r);
      nonces.set(`${req.headers["superstables-agent"]}:${req.headers["superstables-agent-nonce"]}`, id);
      return json(res, 201, {
        id,
        access_token: r.token,
        kind: link ? "link" : body.kind,
        state: "awaiting_owner",
        final: false,
        approval: { url: site.approvalUrl?.(id) ?? `${server.url}/approve/budget/${id}#ssba_test_owner${n}`, match_code: "ABC-DEF", expires_at: new Date(Date.now() + 600_000).toISOString() },
        message_for_owner: "Open the link and pick ABC-DEF.",
        next_action: { type: "wait_for_owner", poll: `/api/v1/budget/requests/${id}` },
        ...(r.steps ? { steps: r.steps.map(stepView) } : {}),
      });
    }
    const m = /^\/api\/v1\/budget\/requests\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const r = site.requests.find((x) => x.id === m[1]);
      if (!r || req.headers.authorization !== `Bearer ${r.token}`) return json(res, 404, { error: "no such request" });
      if (m[2] && req.method === "POST") {
        r.cancels++;
        if (site.cancelFails) return json(res, 503, { error: { code: "unavailable", message: "try again" } });
        if (r.steps && r.owner) {
          // linked: the steps the wallet was not asked for are withdrawn; the others stay, as possibly sent
          for (const s of r.steps) {
            if (s.state === "queued" || (s.state === "awaiting_owner" && !s.wallet_asked)) Object.assign(s, { state: "cancelled", reason: "the agent cancelled this request before the owner's wallet was asked", reason_code: "agent_cancelled" });
          }
          return json(res, 200, await view(r));
        }
        if (r.state !== "awaiting_owner" || r.wallet_asked) return json(res, 409, { error: "the wallet was asked", state: r.state, wallet_asked: r.wallet_asked === true });
        r.state = "cancelled";
        return json(res, 200, await view(r));
      }
      r.polls++;
      site.onPoll?.(r);
      return json(res, 200, await view(r));
    }
    if (url.pathname === "/api/v1/budget/services" && site.services !== undefined) return json(res, 200, site.services);
    json(res, 404, { error: "not found" });
  });
  site.origin = server.url;
  return Object.assign(site, server);
}

/** The agent request proof v2 text, exactly as the protocol spells it. */
export const agentProofV2Text = (origin: string, method: string, path: string, raw: string, ts: number | string, nonce: string) =>
  `Superstables agent request v2\norigin: ${origin}\n${method} ${path}\n${createHash("sha256").update(raw).digest("hex")}\n${ts}\n${nonce}`;

/**
 * The site's check of an agent request (proof v2), with the site's reasons: missing, malformed, stale, signature (a wrong
 * origin shows as this too), agent_mismatch. The nonce's use is the caller's.
 */
async function checkProof(req: IncomingMessage, origin: string, path: string, raw: string): Promise<{ ok: true; nonceKey: string } | { ok: false; reason: string }> {
  const agent = String(req.headers["superstables-agent"] ?? "");
  const tsText = String(req.headers["superstables-agent-timestamp"] ?? "");
  const nonce = String(req.headers["superstables-agent-nonce"] ?? "");
  const sig = String(req.headers["superstables-agent-signature"] ?? "") as Hex;
  if (!agent || !sig || !tsText || !nonce) return { ok: false, reason: "missing" };
  if (!/^\d+$/.test(tsText) || !/^[0-9a-f]{32}$/.test(nonce)) return { ok: false, reason: "malformed" };
  if (Math.abs(Number(tsText) - Date.now() / 1000) > 300) return { ok: false, reason: "stale" };
  const text = agentProofV2Text(origin, "POST", path, raw, tsText, nonce);
  const why = await verifyAgent(agent, text, sig, raw);
  return why ? { ok: false, reason: why } : { ok: true, nonceKey: `${agent}:${nonce}` };
}

async function verifyAgent(agent: string, text: string, sig: Hex, raw: string): Promise<string | undefined> {
  if (JSON.parse(raw).rail === "solana") {
    // ed25519 over the text's UTF-8 bytes; base58 keys are case-sensitive
    if (!/^0x[0-9a-f]{128}$/i.test(sig)) return "malformed";
    let ok = false;
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bs58.decode(agent)).toString("base64url") }, format: "jwk" });
      ok = verify(null, Buffer.from(text, "utf8"), key, Buffer.from(sig.slice(2), "hex"));
    } catch {}
    if (!ok) return "signature";
    if (String(JSON.parse(raw).agent) !== agent) return "agent_mismatch";
    return undefined;
  }
  // evm and tempo: the agent is the checksummed address, in the header and the body
  if (agent !== getAddress(agent)) return "malformed";
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message: text, signature: sig });
  } catch {
    return "malformed";
  }
  if (signer !== agent) return "signature";
  if (String(JSON.parse(raw).agent) !== agent) return "agent_mismatch";
  return undefined;
}

/**
 * A JSON-RPC stand-in for an EVM testnet: every token balance and allowance is 0; every account holds 1 of the gas token.
 * `extra` answers a method first (for example a transaction and its receipt); undefined falls through to the defaults.
 */
export async function startFakeRpc(chainId: number, extra?: (method: string, params: any[]) => unknown): Promise<TestServer> {
  return startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const answer = (c: { id: number; method: string; params?: any[] }) => ({
      jsonrpc: "2.0",
      id: c.id,
      result: extra?.(c.method, c.params ?? []) ?? (c.method === "eth_chainId" ? `0x${chainId.toString(16)}` : c.method === "eth_call" ? `0x${"0".repeat(64)}` : c.method === "eth_blockNumber" ? "0x1" : c.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x0"),
    });
    json(res, 200, Array.isArray(body) ? body.map(answer) : answer(body));
  });
}
