// Auto recovery for budget buys (evm and solana; tempo has none). Plain JavaScript with Node built-ins and the client's own
// plain modules only, so the dispatcher (cli.mjs) and the rail scripts share it and the standalone build bundles it.
//
// Two things happen when a budget buy cannot read the seller's terms, and both happen BEFORE any payment exists:
//
//   1. Retry (readTerms, used by the rail scripts). The unpaid read of the seller's terms is tried at most 3 times, waiting
//      250 ms and then 1 s plus a little jitter, and never less than the seller's Retry-After (up to 30 s; a longer one ends
//      the retries, since waiting it out would pass the cap). Only the unpaid read is ever retried, never a payment.
//   2. Advice (recoverOrder, used by the dispatcher). When the retries failed and the site lists `recovery_advice_v1`, the
//      client asks the site for advice (signed with the agent key), checks every candidate itself and pays the first valid
//      one with the agent key, inside that chain's own allowance, through the ordinary buy. The site only advises.
//
// The rules the client enforces locally, whatever the site says (each is marked INVARIANT n below):
//   1. One payment instruction per order. Once anything for the order was signed or handed to anything, there is no switch,
//      ever. The site's word that an order was "not paid" is never grounds to pay again.
//   2. The candidate's chain has a live allowance for this agent key, read from the chain by this client.
//   3. Price <= original x (1 + margin) and <= the remaining allowance and <= the --max the caller gave. Same pricing family.
//   4. Request parameters go to another seller only with a consent the site names AND the policy copy in the same answer covers.
//   5. At most max_offers offers per order, the original included.
//   6. Advice expires; stale or unparsable advice is no recovery.
//   7. Every switch is journaled (durably, before the new seller is contacted) and reported after the fact (best effort).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { journalProblem, writeJournalFile } from "./journal.mjs";
import { lockRecord } from "./op-lock.mjs";
import { STATE_DIR, opsDir } from "./paths.mjs";
import { EVM_CHAINS } from "./evm/chains.mjs";
import { sellerUrlProblem } from "../src/core/seller-url.mjs";

/** The site's announcement in GET /api/v1/budget/services `features`. */
export const RECOVERY_FEATURE = "recovery_advice_v1";
export const ADVICE_PATH = "/api/v1/recovery/advice";
export const REPORT_PATH = "/api/v1/recovery/report";
/** The contract version this client speaks. */
export const CONTRACT_VERSION = 1;
/** The most seconds ahead the client trusts an `expires_at`, whatever the site says. */
export const ADVICE_MAX_SECONDS = 120;
/** Offers per order, the original included: the site's policy says how many; this is the contract's own ceiling. */
export const MAX_OFFERS_CEILING = 3;
/** The most margin the contract allows: 5000 basis points, +50%. */
export const MAX_MARGIN_BPS = 5000;

// ---- 1. retry -------------------------------------------------------------------------------------------------------------

export const RETRY = Object.freeze({ maxReads: 3, delaysMs: Object.freeze([250, 1000]), jitter: 0.25, retryAfterCapMs: 30_000 });

/**
 * A Retry-After header in milliseconds: whole seconds, or an HTTP date (relative to `nowMs`). null when absent or unreadable.
 * @param {string | null | undefined} value
 * @param {number} [nowMs]
 */
export function retryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  if (!/[A-Za-z]/.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * How long to wait before read number `attempt + 1`, after read `attempt` (1-based) failed: the base delay (250 ms, then 1 s)
 * plus up to 25% jitter, and never less than the seller's Retry-After. null: do not retry, because the seller asked for longer
 * than the 30 s cap and an earlier retry would be early.
 * @param {number} attempt
 * @param {string | null | undefined} retryAfter
 * @param {{ random?: () => number, now?: () => number }} [o]
 */
export function nextWait(attempt, retryAfter, { random = Math.random, now = Date.now } = {}) {
  const base = RETRY.delaysMs[attempt - 1];
  if (base === undefined) return null;
  const jittered = base + Math.floor(random() * base * RETRY.jitter);
  const asked = retryAfterMs(retryAfter, now());
  if (asked === null) return jittered;
  if (asked > RETRY.retryAfterCapMs) return null;
  return Math.max(jittered, asked);
}

/**
 * Reads the seller's terms with the bounded retry. `readOnce(attempt)` returns { failure: null, value } for a read that
 * worked, or { failure: { stage, detail, retryAfter? } } for one that did not (stage: terms, seller_unreachable or
 * seller_error). Nothing but that read is ever repeated.
 * @returns {Promise<{ ok: boolean, value?: any, failure?: any, attemptsUsed: number, waits: number[] }>}
 */
export async function readTerms(readOnce, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, now = Date.now } = {}) {
  const waits = [];
  for (let attempt = 1; ; attempt++) {
    const out = await readOnce(attempt);
    if (!out.failure) return { ok: true, value: out.value, attemptsUsed: attempt, waits };
    if (attempt >= RETRY.maxReads) return { ok: false, failure: out.failure, value: out.value, attemptsUsed: attempt, waits };
    const wait = nextWait(attempt, out.failure.retryAfter, { random, now });
    if (wait === null) return { ok: false, failure: out.failure, value: out.value, attemptsUsed: attempt, waits };
    waits.push(wait);
    await sleep(wait);
  }
}

const oneLineText = (s, max = 120) => String(s ?? "").replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, max);

/** Whether a 402's payment requirements are readable: a payment-required header (x402 v2) or a JSON body (v1) with an accepts list. */
export function termsReadable(paymentRequiredHeader, bodyText) {
  const accepts = (o) => Boolean(o) && typeof o === "object" && Array.isArray(o.accepts);
  if (paymentRequiredHeader) {
    try { return accepts(JSON.parse(Buffer.from(String(paymentRequiredHeader), "base64").toString("utf8"))); } catch { return false; }
  }
  try { return accepts(JSON.parse(String(bodyText ?? ""))); } catch { return false; }
}

/**
 * What one unpaid read of the seller's terms came to. `read` is { status, retryAfter, paymentRequired, bodyText } or
 * { error } (the request itself failed). Returns null when the terms were read (or the seller gave a plain answer that is not
 * a failed read: a 200, a 4xx), else { stage, detail, retryAfter }.
 */
export function termsFailureOf(read) {
  if (read.error !== undefined) return { stage: "seller_unreachable", detail: oneLineText(`no answer (${read.error})`) };
  const status = Number(read.status);
  if (status >= 500) return { stage: "seller_error", detail: `HTTP ${status}`, retryAfter: read.retryAfter ?? null };
  if (status === 429) return { stage: "seller_error", detail: "HTTP 429", retryAfter: read.retryAfter ?? null };
  if (status === 402 && !termsReadable(read.paymentRequired, read.bodyText)) return { stage: "terms", detail: "HTTP 402 without readable payment requirements" };
  return null;
}

/** The part of a failed read that goes into a RESULT and into the advice request: stage, a short detail, how many reads. */
export const failureFact = (failure, attemptsUsed) => ({ stage: failure.stage, detail: oneLineText(failure.detail), attempts_used: attemptsUsed });

// ---- the chains recovery may use -------------------------------------------------------------------------------------------

/** Solana devnet USDC (budget/solana/lib.mjs USDC_MINT; written out here because that module is not plain Node). */
const SOLANA_DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** The one pricing family this version recovers across: the test USDC tokens, 6 decimals. Everything else never mixes. */
export const TEST_USDC_FAMILY = "test:USDC:6";
/** Recovery chains by the key the site uses: the rail, the token and the family. Tempo and every other chain are not here. */
export const RECOVERY_CHAINS = Object.freeze({
  "base-sepolia": { rail: "evm", asset: EVM_CHAINS["base-sepolia"].token.address, family: TEST_USDC_FAMILY },
  "arc-testnet": { rail: "evm", asset: EVM_CHAINS["arc-testnet"].token.address, family: TEST_USDC_FAMILY },
  devnet: { rail: "solana", asset: SOLANA_DEVNET_USDC, family: TEST_USDC_FAMILY },
});
export const recoveryChain = (rail, chain) => (Object.hasOwn(RECOVERY_CHAINS, chain) && RECOVERY_CHAINS[chain].rail === rail ? RECOVERY_CHAINS[chain] : null);

/** 6-decimal amounts: "0.05" -> 50000n. null when it is not a plain decimal with at most 6 places. */
export function atomicOf(decimal) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(decimal ?? ""));
  return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : null;
}
/** 50000n -> "0.05" */
export function decimalOf(atomic) {
  const a = BigInt(atomic);
  const whole = a / 1_000_000n;
  const frac = String(a % 1_000_000n).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// ---- 2. the order's journal --------------------------------------------------------------------------------------------------

export const recoveryDir = () => join(STATE_DIR, "recovery");
const OP_NAME = /^[A-Za-z0-9._-]{1,64}$/;
export function recordPath(rail, chain, op) {
  if (!OP_NAME.test(String(op)) || !/^[a-z0-9-]{1,40}$/.test(String(chain)) || !/^[a-z]{1,10}$/.test(String(rail))) throw new Error("not an order that can have a record");
  return join(recoveryDir(), `${rail}-${chain}-${op}.json`);
}

/** The order's recovery record, or null when there is none. A file that is there but unusable is { unreadable: true }. */
export function readRecord(rail, chain, op) {
  let text;
  try { text = readFileSync(recordPath(rail, chain, op), "utf8"); } catch (err) { return err?.code === "ENOENT" ? null : { unreadable: true }; }
  try {
    const r = JSON.parse(text);
    return r && typeof r === "object" && !Array.isArray(r) && r.version === 1 && Array.isArray(r.attempts) && typeof r.order_ref === "string" ? r : { unreadable: true };
  } catch { return { unreadable: true }; }
}
/** Durable: the file and its folder are flushed before this returns (journal.mjs writeJournalFile). */
export function writeRecord(record) {
  writeJournalFile(recordPath(record.rail, record.chain, record.op), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * INVARIANT 1, the evidence half: whether a purchase journal proves that nothing was signed or handed to anything. Only a
 * journal that is absent (the rail refused before it wrote one), or one that says refused_precheck and holds no signature, no
 * authorization, no transaction of any kind, proves it. A journal that cannot be read, or says anything else, proves nothing.
 * @param {"evm" | "solana"} rail
 * @param {{ present: boolean, journal: any }} read  present: the file may exist; journal: its parsed content or null
 */
export function provesUnsigned(rail, read) {
  if (!read.present) return true;
  const j = read.journal;
  if (!j || typeof j !== "object") return false;
  if (j.state !== "refused_precheck") return false;
  const marks = rail === "evm"
    ? ["signed", "auth", "pullTx", "pulled", "settleTx", "cancelTx", "returnTx"]
    : ["agentSig", "tx", "submittedAt", "sellerTx", "signature", "blockhash"];
  return !marks.some((k) => j[k] !== undefined && j[k] !== null && j[k] !== false);
}

/**
 * INVARIANT 1, the rail boundary: durably marks the ORIGINAL op's own journal as superseded by this order, under the op's
 * record lock (the lock every rail takes while it works on that op). Every rail entrypoint (evm/purchase.ts, solana/ops.mjs
 * gateExistingOp) refuses to pay an op whose journal carries the mark, so no direct script and no second dispatcher can pay the
 * original once the order has moved. Fails closed: a busy lock, a journal that is not provably unsigned, or none to mark (evm
 * always leaves one after a refusal) means the order does not move. Idempotent for the same order.
 * @returns {{ ok: boolean, why?: string }}
 */
export function freezeOriginal({ rail, chain, op }, by) {
  let dir, lock;
  try {
    dir = opsDir(rail, chain);
    lock = lockRecord(dir, op);
  } catch { return { ok: false, why: "no_lock" }; }
  if (!lock.ok) return { ok: false, why: "busy" };
  try {
    const file = join(dir, `${op}.json`);
    let cur = null;
    try { cur = JSON.parse(readFileSync(file, "utf8")); } catch (err) { if (err?.code !== "ENOENT") return { ok: false, why: "unreadable" }; }
    if (cur !== null) {
      if (!cur || typeof cur !== "object" || journalProblem(rail, cur, op)) return { ok: false, why: "unreadable" };
      if (cur.supersededBy) return cur.supersededBy.order_ref === by.order_ref ? { ok: true } : { ok: false, why: "other_order" };
      if (!provesUnsigned(rail, { present: true, journal: cur })) return { ok: false, why: "may_have_signed" };
    } else if (rail !== "solana") return { ok: false, why: "no_journal" };
    const now = new Date().toISOString();
    const base = cur ?? { op, rail: "solana", kind: "buy", state: "refused_precheck", createdAt: now, history: [] };
    const next = { ...base, supersededBy: by, updatedAt: now, ...(Array.isArray(base.history) ? { history: [...base.history, { at: now, state: base.state, note: "superseded by auto recovery" }] } : {}) };
    writeJournalFile(file, JSON.stringify(next, null, 2) + "\n");
    return { ok: true };
  } catch { return { ok: false, why: "write_failed" }; } finally { try { lock.release(); } catch { /* released with the process */ } }
}

/** The words a rail gives for an op that auto recovery superseded: never paid, and where the order went. */
export function supersededWords(op, by) {
  return `operation ${op} was superseded by auto recovery (order ${by?.order_ref ?? "?"}) and is never paid again. The order continues as operation ${by?.op ?? "?"} on ${by?.rail ?? "?"} ${by?.chain ?? "?"}: read it with superstables budget reconcile --rail ${by?.rail ?? "R"} --chain ${by?.chain ?? "C"} --op ${by?.op ?? "ID"}`;
}

// ---- 3. validating the site's advice -------------------------------------------------------------------------------------

const isObj = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const isoMs = (v) => (typeof v === "string" ? Date.parse(v) : NaN);

/**
 * Parses the policy block of an advice answer. Anything that is not exactly the contract is no policy (null).
 */
function policyOf(p) {
  if (!isObj(p) || p.enabled !== true) return null;
  const maxOffers = p.max_offers;
  const margin = p.margin_bps;
  if (!Number.isInteger(maxOffers) || maxOffers < 1 || maxOffers > MAX_OFFERS_CEILING) return null;
  if (!Number.isInteger(margin) || margin < 0 || margin > MAX_MARGIN_BPS) return null;
  if (!Array.isArray(p.allowed_chains) || !p.allowed_chains.every((c) => typeof c === "string") || p.allowed_chains.length > 50) return null;
  if (!Array.isArray(p.sharing) || p.sharing.length > 200) return null;
  const sharing = [];
  for (const s of p.sharing) {
    if (!isObj(s)) return null;
    const consent = str(s.consent_id), seller = str(s.seller_id), capability = str(s.capability), origin = str(s.seller_origin, 300);
    if (!consent || !seller || !capability || !origin) return null;
    sharing.push({ capability, seller_id: seller, seller_origin: origin, consent_id: consent });
  }
  return { version: Number.isInteger(p.version) ? p.version : null, rail: p.rail === true, service: p.service === true, maxOffers, marginBps: margin, allowedChains: p.allowed_chains, sharing };
}

/**
 * Whether a candidate URL is the original request on another chain (a "rail" candidate) or a different request (a "service"
 * candidate, which needs a consent). Rail: the same ORIGIN as the original (the same seller) and exactly the original's query
 * (same names, same values, nothing extra, no duplicates); the path may differ, since a seller serves each chain at its own
 * path, and a rail candidate has no fixed_params. Any difference in the query makes it a service candidate. Service: its query
 * is exactly params plus fixed_params, once each, with no name in both.
 */
function bindCandidate(target, original, params, fixed) {
  const entries = (u) => [...u.searchParams.entries()];
  const sorted = (list) => [...list].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = sorted(entries(target));
  const clean = target.hash === "" && target.username === "" && target.password === "";
  const theirs = sorted(entries(original));
  const railBound = clean && target.origin === original.origin && Object.keys(fixed).length === 0
    && query.length === theirs.length && query.every((e, i) => e[0] === theirs[i][0] && e[1] === theirs[i][1]);
  const names = [...Object.keys(params), ...Object.keys(fixed)];
  const collide = Object.keys(fixed).some((k) => Object.hasOwn(params, k));
  const expected = { ...params, ...fixed };
  const paramsExact = clean && !collide && query.length === names.length && new Set(query.map(([k]) => k)).size === query.length && query.every(([k, v]) => Object.hasOwn(expected, k) && expected[k] === v);
  return { class: railBound ? "rail" : "service", paramsExact };
}

/**
 * Checks the site's answer against every rule the client enforces on its own (invariants 2 to 6). `ctx`:
 *   now                ms; receivedAt  ms when the answer arrived
 *   original           { rail, chain, url, maxAtomic }  maxAtomic: the --max the caller gave, a ceiling and never the original price (the
 *                      margin base is advice.original.listed_price_atomic; without it there is no priced recovery)
 *   funded             Map "<chain key>" -> remaining allowance in atomic units, from this client's own chain reads (live only)
 *   tried              [{ url, chain }] already tried in this order, the original first
 *   alreadyOffered     offers already made in this order, the original included (invariant 5)
 *   hasBody            the request carries a method other than GET or a body: it is never sent to another seller or chain
 * Returns { ok: false, problem } when the whole answer is unusable (unparsable, expired, policy off), else
 * { ok: true, advice_id, expiresAtMs, policy, valid: [...], skipped: [{ offer_id, reason }] }. Never throws.
 */
export function validateAdvice(advice, ctx) {
  try {
    return validate(advice, ctx);
  } catch {
    return { ok: false, problem: "unparsable" };
  }
}

function validate(advice, ctx) {
  if (!isObj(advice) || advice.version !== CONTRACT_VERSION) return { ok: false, problem: "unparsable" };
  const adviceId = str(advice.advice_id, 100);
  if (!adviceId) return { ok: false, problem: "unparsable" };
  // INVARIANT 6: advice expires. The client also never trusts more than 120 s from the moment the answer arrived.
  const expires = isoMs(advice.expires_at);
  if (!Number.isFinite(expires)) return { ok: false, problem: "unparsable" };
  const expiresAtMs = Math.min(expires, ctx.receivedAt + ADVICE_MAX_SECONDS * 1000);
  if (ctx.now >= expiresAtMs) return { ok: false, problem: "expired" };
  const policy = policyOf(advice.policy);
  if (!policy) return { ok: false, problem: "policy_off" };
  if (!Array.isArray(advice.candidates) || advice.candidates.length > 50) return { ok: false, problem: "unparsable" };

  const original = ctx.original;
  const originFamily = recoveryChain(original.rail, original.chain)?.family ?? null;
  const originalUrl = new URL(original.url);
  // INVARIANT 3: the margin applies to the original's listed (curated) price, which the site names in `original`. The caller's
  // --max is a ceiling, never the original price: with no listed price there is no priced recovery at all (fail closed).
  const orig = advice.original;
  if (!isObj(orig)) return { ok: false, problem: "unparsable" };
  if (orig.origin !== undefined && orig.origin !== originalUrl.origin) return { ok: false, problem: "unparsable" };
  if (orig.listed_price_atomic === null || orig.listed_price_atomic === undefined) return { ok: false, problem: "no_original_price" };
  if (typeof orig.listed_price_atomic !== "string" || !/^\d{1,18}$/.test(orig.listed_price_atomic) || BigInt(orig.listed_price_atomic) === 0n) return { ok: false, problem: "unparsable" };
  const originalCapability = str(orig.capability, 100);
  const known = BigInt(orig.listed_price_atomic);
  const marginCap = (known * BigInt(10_000 + policy.marginBps)) / 10_000n;
  const valid = [];
  const skipped = [];
  // INVARIANT 5: the original is one of the max_offers, so at most max_offers - 1 others may be tried, and the ones the site
  // lists past that are not looked at.
  const room = Math.max(0, policy.maxOffers - ctx.alreadyOffered);
  const seen = new Set();
  advice.candidates.forEach((raw, index) => {
    const offer = isObj(raw) ? str(raw.offer_id, 100) : null;
    const skip = (reason) => skipped.push({ offer_id: offer ?? `#${index + 1}`, reason });
    if (!offer || !isObj(raw)) return skip("unparsable_candidate");
    if (seen.has(offer)) return skip("duplicate_offer");
    seen.add(offer);
    if (valid.length >= room) return skip("over_max_offers");
    if (ctx.hasBody) return skip("request_has_body");
    const kind = raw.kind;
    if (kind !== "rail" && kind !== "service") return skip("unparsable_candidate");
    const chain = str(raw.chain, 60);
    const url = str(raw.url, 2000);
    const asset = str(raw.asset, 100);
    const listed = typeof raw.listed_price_atomic === "string" && /^\d{1,18}$/.test(raw.listed_price_atomic) ? BigInt(raw.listed_price_atomic) : null;
    if (!chain || !url || !asset || listed === null || listed === 0n || !isObj(raw.seller)) return skip("unparsable_candidate");
    const sellerId = str(raw.seller.id, 200);
    if (!sellerId) return skip("unparsable_candidate");
    const sellerOrigin = typeof raw.seller.origin === "string" ? raw.seller.origin : null;
    const strMap = (m) => (isObj(m) && Object.values(m).every((v) => typeof v === "string") ? m : null);
    const params = strMap(raw.params);
    const fixed = raw.fixed_params === undefined ? {} : strMap(raw.fixed_params);
    if (params === null || fixed === null) return skip("unparsable_candidate");
    const there = Object.hasOwn(RECOVERY_CHAINS, chain) ? RECOVERY_CHAINS[chain] : null;
    if (!there) return skip("unsupported_chain");
    // INVARIANT 3, same pricing family: the client's own table decides, and the site must agree with it
    if (originFamily === null || there.family !== originFamily || raw.pricing_family !== there.family) return skip("pricing_family");
    if (asset.toLowerCase() !== there.asset.toLowerCase() && asset !== there.asset) return skip("wrong_asset");
    if (!policy.allowedChains.includes(chain)) return skip("chain_not_allowed");
    let target;
    try { target = new URL(url); } catch { return skip("invalid_url"); }
    if (sellerUrlProblem(url, there.rail === "evm" ? EVM_CHAINS[chain] : { testnet: true }) !== undefined) return skip("invalid_url");
    if (ctx.tried.some((t) => t.chain === chain && t.url === url)) return skip("already_tried");
    // INVARIANT 2: a live allowance for this agent key on that chain, read by this client
    const remaining = ctx.funded.get(chain);
    if (remaining === undefined || remaining <= 0n) return skip("not_funded");
    // INVARIANT 3: the price
    if (listed > marginCap) return skip("over_margin");
    if (listed > original.maxAtomic) return skip("over_max");
    if (listed > remaining) return skip("over_allowance");
    // INVARIANT 4: the destination is bound to the original request before anything is sent. The class of the candidate is worked
    // out here from its URL, not taken from its label: a label that disagrees is refused.
    const bound = bindCandidate(target, originalUrl, params, fixed);
    if (kind === "rail" && bound.class !== "rail") return skip("rail_binding");
    if (kind === "service" && bound.class === "rail") return skip("kind_mismatch");
    if (bound.class === "rail" ? !policy.rail : !policy.service) return skip("kind_not_enabled");
    let consent = null;
    if (bound.class === "service") {
      // the destination must be the seller the site names, serve exactly the parameters it lists, and carry only values of the original request
      // INVARIANT 4: no service recovery for a request whose capability is not known
      if (originalCapability === null) return skip("no_original_capability");
      if (sellerOrigin === null || target.origin !== sellerOrigin) return skip("seller_origin");
      if (str(raw.capability, 100) !== originalCapability) return skip("capability_mismatch");
      if (!bound.paramsExact) return skip("params_not_exact");
      const fromOriginal = new Set([...originalUrl.searchParams.values()]);
      if (!Object.values(params).every((v) => fromOriginal.has(v))) return skip("param_not_from_original");
      const d = raw.disclosure;
      consent = isObj(d) && d.allowed === true ? str(d.consent_id, 200) : null;
      if (!consent) return skip("disclosure_not_allowed");
      // the consent must match on all four: the capability asked for, the seller, the origin it serves from, the consent itself
      if (!policy.sharing.some((s) => s.capability === originalCapability && s.seller_id === sellerId && s.seller_origin === sellerOrigin && s.consent_id === consent)) return skip("no_consent");
    }
    valid.push({
      offer_id: offer, kind: bound.class, rail: there.rail, chain, url, sellerId,
      fixedParams: fixed, sellerName: isObj(raw.seller) && typeof raw.seller.name === "string" ? oneLineText(raw.seller.name, 80) : null,
      listedAtomic: listed, disclosed: bound.class === "service", consentId: consent, params,
      why: isObj(raw.rank) && typeof raw.rank.why === "string" ? oneLineText(raw.rank.why, 160) : "",
    });
  });
  // the price a candidate may cost, whatever it listed: the margin on the original, the caller's --max, the allowance
  const ceilingFor = (c) => [marginCap, original.maxAtomic, ctx.funded.get(c.chain) ?? 0n].reduce((a, b) => (a < b ? a : b));
  return {
    ok: true, advice_id: adviceId, expiresAtMs, policy,
    valid: valid.map((c) => ({ ...c, ceilingAtomic: ceilingFor(c) })),
    skipped,
  };
}

// ---- 4. the order -----------------------------------------------------------------------------------------------------------

/** A short, honest account of why the first seller could not be paid, for the agent. */
const stageWords = (stage) => ({ terms: "its payment terms could not be read", seller_unreachable: "it did not answer", seller_error: "it answered with a server error" })[stage] ?? "it could not be read";

/** The op id of an attempt: the order's op with the attempt number, within the 64-character limit every rail accepts. */
export const attemptOp = (op, attemptNo) => `${op.slice(0, 58)}-r${attemptNo}`;

/**
 * The best-effort report of one attempt after the fact. It never throws and never blocks an outcome for long.
 */
async function report(deps, record, attempt, outcome, tx) {
  try {
    const answer = await deps.siteCall(REPORT_PATH, {
      version: CONTRACT_VERSION, order_ref: record.order_ref, advice_id: attempt.advice_id, attempt_no: attempt.attempt_no, offer_id: attempt.offer_id,
      outcome, tx: tx ?? null, disclosed: attempt.disclosed === true,
    });
    return Boolean(answer && answer.status >= 200 && answer.status < 300);
  } catch {
    return false;
  }
}

const outcomeOf = (state) => (state === "settled" ? "paid" : state === "refused_precheck" ? "failed_before_payment" : "unknown");

/**
 * The words for the agent. Truthful about who was paid on which chain and why, and never says the owner approved anything.
 */
function recoveryFact(record, attempt, extra = {}) {
  return {
    order_ref: record.order_ref,
    original: { rail: record.rail, chain: record.chain, op: record.op, url: record.url },
    attempts: record.attempts.map((a) => ({ attempt_no: a.attempt_no, kind: a.kind, rail: a.rail, chain: a.chain, url: a.url, op: a.op, outcome: a.outcome ?? "in_progress", disclosed: a.disclosed })),
    decided_by: "agent",
    ...extra,
    ...(attempt ? { advice_id: attempt.advice_id } : {}),
  };
}

/**
 * Recovery for one order whose terms read failed after the retries. Returns { kind: "none" } (behave as today: the caller
 * emits the first attempt's own answer) or { kind: "result", code, fields } (the answer to give instead).
 *
 * `deps`:
 *   f                    the buy's flags { rail, chain, url, max, op, method?, body?, "pay-to"? }
 *   failure              the first attempt's termsFailure { stage, detail, attempts_used }
 *   unsignedOriginal()   -> boolean   INVARIANT 1: the journal evidence for the original op (provesUnsigned)
 *   site()               -> origin | null   the site this agent's budget is linked to
 *   features()           -> Set | null      what the site lists; null: it did not answer
 *   funded()             -> Promise<Map chain -> remaining atomic>   this client's own chain reads
 *   siteCall(path, body) -> Promise<{ status, body }>   a request signed with the agent key
 *   attempt(flags)       -> Promise<{ code, fields, rr, unsigned }>   the ordinary buy on another rail, chain or seller
 *   now(), log(msg)
 */
export async function recoverOrder(deps) {
  const { f, failure } = deps;
  const none = { kind: "none" };
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  if (f.rail !== "evm" && f.rail !== "solana") return none;
  if (f["pay-to"] !== undefined) return none; // the caller pinned a recipient: another seller or chain is not what they asked for
  const originalChain = recoveryChain(f.rail, f.chain);
  const maxAtomic = atomicOf(f.max);
  if (!originalChain || maxAtomic === null || maxAtomic === 0n) return none;
  const hasBody = (f.method !== undefined && String(f.method).toUpperCase() !== "GET") || f.body !== undefined;

  // an earlier run of this order, crashed or not: its record decides, no new advice
  const earlier = readRecord(f.rail, f.chain, f.op);
  if (earlier?.unreadable) return none; // never guess: the order's own answer stands, which is not a payment
  if (earlier) return resume(deps, earlier);

  // INVARIANT 1: nothing for this order was signed or handed to anything
  if (!deps.unsignedOriginal()) return none;
  const site = deps.site();
  if (!site) return none;
  const features = await deps.features();
  if (!features || !features.has(RECOVERY_FEATURE)) return none;
  const funded = await deps.funded();
  if (!(funded instanceof Map) || funded.size === 0) return none;

  // The order's reference is made here and written with the first switch, not before: until a switch is journaled nothing
  // for this order has happened anywhere, so a crash before it leaves nothing to resume and the next run asks again.
  const record = {
    version: 1, order_ref: randomUUID(), rail: f.rail, chain: f.chain, op: f.op, url: f.url, max: f.max,
    failure, createdAt: new Date(now()).toISOString(), advice: null, attempts: [], skipped: [],
  };

  const request = {
    version: CONTRACT_VERSION, order_ref: record.order_ref,
    original: { url: f.url, chain: f.chain, asset: originalChain.asset, amount_atomic: maxAtomic.toString(), pay_to: null },
    failure: { stage: failure.stage, detail: failure.detail, attempts_used: failure.attempts_used },
    tried: [{ url: f.url, chain: f.chain }],
    funded_chains: [...funded.keys()],
  };
  // The original's terms could not be read, so its price and recipient are unknown to this client: amount_atomic is the caller's
  // --max, an UPPER BOUND on what this order may cost and never the margin base (the site's curated original.listed_price_atomic
  // is), and pay_to is null, rather than a guess.
  const answer = await deps.siteCall(ADVICE_PATH, request);
  const receivedAt = now();
  // 403 (agent not linked, policy off) and 404 (feature off) and any other non-answer: exactly as today
  if (!answer || answer.status !== 200) return none;
  const checked = validateAdvice(answer.body, {
    now: receivedAt, receivedAt,
    original: { rail: f.rail, chain: f.chain, url: f.url, maxAtomic },
    funded, tried: [{ url: f.url, chain: f.chain }], alreadyOffered: 1, hasBody,
  });
  if (!checked.ok) {
    log(`superstables budget: the site's recovery advice was not used (${checked.problem}); nothing was paid`);
    return none;
  }
  record.advice = { advice_id: checked.advice_id, expires_at_ms: checked.expiresAtMs, policy_version: checked.policy.version, max_offers: checked.policy.maxOffers, margin_bps: checked.policy.marginBps, rail_ok: checked.policy.rail, service_ok: checked.policy.service, allowed_chains: checked.policy.allowedChains };
  record.skipped = [...checked.skipped];
  for (const s of checked.skipped) log(`superstables budget: recovery candidate ${s.offer_id} skipped (${s.reason})`);
  if (!checked.valid.length) return { kind: "none", recovery: { switched: false, order_ref: record.order_ref, skipped: checked.skipped } };

  let previous = { unsigned: true };
  for (const candidate of checked.valid) {
    // INVARIANT 1, again before every switch: everything this order did so far is proven unsigned
    if (!previous.unsigned) break;
    // INVARIANT 6: advice is not used after it expired
    if (now() >= checked.expiresAtMs) { record.skipped.push({ offer_id: candidate.offer_id, reason: "advice_expired" }); continue; }
    // INVARIANT 5: the original counts as an offer
    if (record.attempts.length + 1 >= checked.policy.maxOffers) { record.skipped.push({ offer_id: candidate.offer_id, reason: "over_max_offers" }); continue; }
    const attempt = {
      attempt_no: record.attempts.length + 2, offer_id: candidate.offer_id, advice_id: checked.advice_id, kind: candidate.kind,
      rail: candidate.rail, chain: candidate.chain, url: candidate.url, op: attemptOp(f.op, record.attempts.length + 2),
      seller_id: candidate.sellerId, seller_name: candidate.sellerName, listed_atomic: candidate.listedAtomic.toString(), ceiling_atomic: candidate.ceilingAtomic.toString(),
      disclosed: candidate.disclosed, consent_id: candidate.consentId, params: candidate.params, fixed_params: candidate.fixedParams, why: candidate.why,
      journaledAt: new Date(now()).toISOString(), state: "journaled", outcome: null,
    };
    // INVARIANT 7: the switch is journaled, durably, BEFORE the new seller is contacted
    record.attempts.push(attempt);
    try {
      writeRecord(record);
    } catch (err) {
      // not journaled, so not contacted: the switch is dropped and the order's own answer stands
      record.attempts.pop();
      log(`superstables budget: the recovery switch could not be journaled (${oneLineText(err?.code ?? err?.message ?? err, 80)}); nothing was paid`);
      break;
    }
    const done = await runAttempt(deps, record, attempt);
    if (done.kind === "result") return done;
    if (done.blocked) break;
    previous = done;
  }
  if (record.attempts.length) closeRecord(record, "no_attempt_paid");
  return { kind: "none", recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped }) };
}

function closeRecord(record, why) {
  record.closed = why;
  try { writeRecord(record); } catch { /* the order is over either way */ }
}

/** Runs one journaled attempt through the ordinary buy, reports it, and decides whether the order goes on. */
async function runAttempt(deps, record, attempt) {
  const { f } = deps;
  // INVARIANT 1: the original op is frozen at the rail boundary before anything of this attempt is contacted
  const frozen = deps.freezeOriginal ? deps.freezeOriginal({ rail: f.rail, chain: f.chain, op: f.op }, { order_ref: record.order_ref, op: attempt.op, rail: attempt.rail, chain: attempt.chain, attempt_no: attempt.attempt_no }) : { ok: false, why: "no_freeze" };
  if (!frozen.ok) {
    attempt.state = "done"; attempt.outcome = "failed_before_payment"; attempt.note = `not contacted: the original could not be frozen (${frozen.why})`;
    record.closed = "freeze_failed";
    try { writeRecord(record); } catch { /* nothing was contacted either way */ }
    return { kind: "continue", unsigned: true, blocked: true };
  }
  const flags = { ...f, rail: attempt.rail, chain: attempt.chain, url: attempt.url, max: decimalOf(attempt.ceiling_atomic), op: attempt.op, method: undefined, body: undefined, agent: undefined };
  const got = await deps.attempt(flags);
  const state = got.fields?.state;
  const outcome = state === undefined ? "unknown" : outcomeOf(state);
  attempt.state = "done";
  attempt.outcome = outcome;
  const tx = got.fields?.tx && typeof got.fields.tx === "object" ? (got.fields.tx.settle ?? got.fields.tx.pull ?? null) : null;
  attempt.tx = tx;
  // a refusal before payment that left no signature behind: the order may go on to the next candidate
  const unsigned = outcome === "failed_before_payment" && got.unsigned === true && got.termsFailure !== undefined;
  if (!unsigned) record.closed = "attempt_decided";
  try { writeRecord(record); } catch { /* the outcome below is the answer; the journal of the purchase itself is the rail's */ }
  attempt.reported = await report(deps, record, attempt, outcome, tx);
  try { writeRecord(record); } catch { /* the report is best effort */ }
  if (unsigned) return { kind: "continue", unsigned: true };
  // paid, unknown, or refused for another reason: the order ends with this attempt's own answer
  return { kind: "result", code: got.code, fields: switchedFields(record, attempt, got.fields) };
}

function switchedFields(record, attempt, fields) {
  const where = `${attempt.rail === "evm" ? attempt.chain : "solana devnet"}`;
  const host = (() => { try { return new URL(attempt.url).host; } catch { return "the candidate seller"; } })();
  const state = fields.state;
  const what = state === "settled" ? `paid ${host} on ${where}` : state === "unknown" ? `may have paid ${host} on ${where} (outcome unknown, do not pay again)` : `tried ${host} on ${where}`;
  return {
    ...fields,
    recovery: recoveryFact(record, attempt, {
      switched: true, kind: attempt.kind, why: `the first seller could not be paid: ${stageWords(record.failure.stage)} after ${record.failure.attempts_used} read${record.failure.attempts_used === 1 ? "" : "s"}`,
      paid_to: { host, rail: attempt.rail, chain: attempt.chain, ...(attempt.seller_name ? { seller_name: attempt.seller_name } : {}) },
      disclosed: attempt.disclosed, params: attempt.params ?? {}, fixed_params: attempt.fixed_params ?? {},
      note: `The agent switched on its own: it ${what}. The owner was not asked about this switch; it stayed inside the budget the owner granted on ${where}.`,
    }),
  };
}

/**
 * An order that has a record: a crash (or a rerun) found it. No new advice. The attempt that was journaled decides:
 * its own purchase journal says whether anything was signed (then that purchase's answer stands, read from the chain by
 * reconcile), and if nothing was, the attempt is carried on.
 */
async function resume(deps, record) {
  const last = record.attempts[record.attempts.length - 1];
  if (!last) return { kind: "none" }; // advice was never acted on
  // INVARIANT 1: an attempt that may have signed is never run again; what its own journal says stands
  const probe = await deps.attemptState(last);
  if (probe.exists && !probe.unsigned) {
    if (last.state !== "done") { last.state = "done"; last.outcome = outcomeOf(probe.fields?.state); try { writeRecord(record); } catch { /* the answer below is the same */ } }
    return { kind: "result", code: probe.code, fields: switchedFields(record, last, probe.fields) };
  }
  // decided before the crash, and nothing was signed: the order is over, and no new advice is asked for it
  if (last.state === "done" || record.closed) return { kind: "none", recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped ?? [] }) };
  // Journaled before the crash, nothing signed since. INVARIANT 6 binds this contact and payment too: the persisted advice must not
  // have expired, the site must still list the feature, and the persisted policy must still allow this kind of switch on this chain.
  const stale = await resumeProblem(deps, record, last);
  if (stale) {
    last.state = "done"; last.outcome = "failed_before_payment"; last.note = `not contacted: ${stale}`;
    closeRecord(record, stale);
    return { kind: "none", recovery: recoveryFact(record, null, { switched: false, skipped: [...(record.skipped ?? []), { offer_id: last.offer_id, reason: stale }] }) };
  }
  const done = await runAttempt(deps, record, last);
  if (done.kind === "result") return done;
  closeRecord(record, "no_attempt_paid");
  return { kind: "none", recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped ?? [] }) };
}

/** Why an unsigned, journaled attempt may not be carried on after a crash, or "". Nothing is contacted or paid when it is not "". */
async function resumeProblem(deps, record, attempt) {
  const now = deps.now ?? Date.now;
  const a = record.advice;
  if (!a || !Number.isFinite(a.expires_at_ms) || now() >= a.expires_at_ms) return "advice_expired";
  const features = await deps.features();
  if (!features || !features.has(RECOVERY_FEATURE)) return "feature_off";
  const kindOk = attempt.disclosed ? a.service_ok === true : a.rail_ok === true;
  if (!kindOk || !Array.isArray(a.allowed_chains) || !a.allowed_chains.includes(attempt.chain)) return "policy_off";
  return "";
}
