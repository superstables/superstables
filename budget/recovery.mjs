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
//   4. Request parameters never go to another seller: this client cannot verify the owner's sharing consent itself (the site
//      states it, in the same answer that names the seller), so a candidate that is not the original seller is skipped. The
//      checks such a candidate would need are kept (validateAdvice with otherSellers) for when consent can be verified here.
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
export async function readTerms(readOnce, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random = Math.random, now = Date.now, maxReads = RETRY.maxReads, firstRead = 1, timeoutMs } = {}) {
  const waits = [];
  // All the reads together take no longer than the one read of a buy without retries: `timeoutMs` (--http-timeout) from the first.
  const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
  // `firstRead`: the number of this run's first read (the dispatcher asks for reads 2 and 3 once it knows recovery can follow)
  for (let attempt = firstRead; ; attempt++) {
    const out = await readOnce(attempt, deadline === undefined ? undefined : Math.max(1, deadline - now()));
    if (!out.failure) return { ok: true, value: out.value, attemptsUsed: attempt, waits };
    const stop = { ok: false, failure: out.failure, value: out.value, attemptsUsed: attempt, waits };
    // a read that ran out of time (or was aborted) is not tried again: it already used the whole time a read may take
    if (out.failure.final || attempt >= Math.min(maxReads, RETRY.maxReads)) return stop;
    const wait = nextWait(attempt, out.failure.retryAfter, { random, now });
    if (wait === null) return stop;
    if (deadline !== undefined && now() + wait >= deadline) return stop;
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
  if (read.timeout) return { stage: "seller_unreachable", detail: "no answer in time", final: true };
  if (read.error !== undefined) return { stage: "seller_unreachable", detail: oneLineText(`no answer (${read.error})`) };
  const status = Number(read.status);
  if (status >= 500) return { stage: "seller_error", detail: `HTTP ${status}`, retryAfter: read.retryAfter ?? null };
  if (status === 429) return { stage: "seller_error", detail: "HTTP 429", retryAfter: read.retryAfter ?? null };
  if (status === 402 && !termsReadable(read.paymentRequired, read.bodyText)) return { stage: "terms", detail: "HTTP 402 without readable payment requirements" };
  return null;
}

/** Whether a failed fetch ran out of time or was aborted: such a read is not retried (readTerms). */
export const timedOut = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";

/**
 * The part of a failed read that goes into a RESULT and into the advice request: stage, a short detail, how many reads. The rail's
 * RESULT also says whether the read may be tried again (`final`: it ran out of time) and the seller's Retry-After, for the dispatcher.
 */
export const failureFact = (failure, attemptsUsed) => ({ stage: failure.stage, detail: oneLineText(failure.detail), attempts_used: attemptsUsed, final: failure.final === true, retry_after: failure.retryAfter == null ? null : oneLineText(failure.retryAfter, 40) });

/**
 * The rails' --terms-reads: which reads of the seller's terms this run makes, "1", "1-3" or "2-3" (the read numbers of
 * readTerms). Without it a rail reads the terms once and reports no termsFailure, exactly as without auto recovery; the dispatcher
 * passes it only for a buy that auto recovery can follow. null when the text is not such a range.
 */
export function termsReadsOf(text) {
  const m = /^([1-3])(?:-([1-3]))?$/.exec(String(text ?? ""));
  if (!m) return null;
  const first = Number(m[1]), last = Number(m[2] ?? m[1]);
  return first <= last ? { first, last } : null;
}

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
    if (!(r && typeof r === "object" && !Array.isArray(r) && (r.version === 1 || r.version === 2) && Array.isArray(r.attempts) && typeof r.order_ref === "string")) return { unreadable: true };
    return migrateRecord(r);
  } catch { return { unreadable: true }; }
}

/**
 * Version 2 of the record keeps transaction kinds apart: `tx` is the settlement, `tx_pull` the owner-to-agent transfer. In a version 1
 * record a bare `tx` could be either, so it moves to `tx_unknown_kind` and is promoted only when a journal proves which kind it is.
 */
function migrateRecord(r) {
  if (r.version === 2) return r;
  for (const a of r.attempts) {
    if (a && typeof a === "object" && a.tx) { a.tx_unknown_kind = a.tx; a.tx = null; }
  }
  r.version = 2;
  r.legacy = true; // written before attempt journals were stamped: an unstamped signed journal at its attempts' names is its own
  return r;
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

/** An order reference as --recovery-order carries it to a rail (a UUID made by recoverOrder). */
export const RECOVERY_ORDER = /^[A-Za-z0-9-]{1,64}$/;
/**
 * Attempt op names are reserved: `<prefix>-<8 characters of the order reference>-r<n>`. Only a rail invocation that passes the matching
 * --recovery-order may buy one; any other invocation refuses it before it writes or signs anything, journal or not. Returns the
 * refusal in words, or "".
 */
export function reservedNameProblem(op, recoveryOrder) {
  const m = /^.+-([A-Za-z0-9]{8})-r\d+$/.exec(String(op));
  // --recovery-order is accepted only for an op name that is one of that order's own attempt names: never on an original or any other op
  if (!m) return recoveryOrder === undefined ? "" : `--recovery-order is only for an order's own attempt op, and ${op} is not one: an original or ordinary op is bought without it`;
  if (recoveryOrder !== undefined && String(recoveryOrder).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) === m[1]) return "";
  return `operation ${op} is reserved for an attempt of an auto-recovered order; it is bought only by that order. Use another --op for a purchase of your own`;
}

/** Whether an op's journal belongs to this order: the rail stamped it for this order's attempt, or this order marked it. */
export const ownedBy = (journal, orderRef) => Boolean(journal) && (journal.recoveryOf?.order_ref === orderRef || journal.supersededBy?.order_ref === orderRef);
/** Whether a journal names another order: stamped by a rail for another order's attempt, or marked by another order. */
export const otherOrder = (journal, orderRef) => Boolean(journal) && ((journal.recoveryOf != null && journal.recoveryOf.order_ref !== orderRef) || (journal.supersededBy != null && journal.supersededBy.order_ref !== orderRef));
/**
 * Why a journal at an attempt op's name cannot be this order's evidence, or "": a different request (another url), a journal that
 * names another order, or (`signed`) a journal that may have signed without this order's stamp. Such a journal is never claimed as
 * this order's payment and never paid again: the order's outcome is unknown.
 */
export function notThisOrder(journal, orderRef, url, signed, legacy = false) {
  if (!journal) return "";
  if (collides(journal, url)) return "another_request";
  if (otherOrder(journal, orderRef)) return "other_order";
  // a record from before stamping (version 1) lists this op as its attempt: a signed journal at the same url is that order's payment
  if (signed && !ownedBy(journal, orderRef) && !legacy) return "not_stamped";
  return "";
}

const sameMark = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * INVARIANT 1, the rail boundary: durably marks one op of an order (its original op, or one of its attempts) under the op's
 * record lock, the lock every rail takes while it works on that op. Every rail entrypoint (evm/purchase.ts, solana/ops.mjs
 * gateExistingOp) refuses to pay an op whose journal carries the mark, so no direct script and no second dispatcher can pay it
 * afterwards. `mark` names the order and either the op the order continues as (op, rail, chain) or that it ended (closed); the
 * mark is permanent, and a later mark of the same order replaces it (the original always points at the live attempt).
 * Fails closed: a busy lock, a journal that is not provably unsigned, a mark of another order, or (evm) no journal and no `base`
 * means the op is not marked.
 *   attempt  the op is an attempt of this order: a journal for another url is a collision ({ ok: false, why: "collision" }), and one
 *            that names another order is { ok: false, why: "other_order" }; neither is ever marked.
 *   base     evm only: the journal to create for an op that has none (an attempt that was never run). evm journals name the
 *            owner and the agent, which this module does not know.
 * @returns {{ ok: boolean, why?: string }}
 */
export function freezeOp({ rail, chain, op }, mark, { attempt = false, base = null, url = null } = {}) {
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
    const now = new Date().toISOString();
    let start;
    if (cur !== null) {
      if (!cur || typeof cur !== "object" || journalProblem(rail, cur, op)) return { ok: false, why: "unreadable" };
      // an attempt op's name is derived from the order: whatever journal is at that name is this order's evidence. The one case that is
      // not is a request that clearly differs (another url): a collision, never marked and never skipped
      if (attempt && collides(cur, url)) return { ok: false, why: "collision" };
      if (otherOrder(cur, mark.order_ref)) return { ok: false, why: "other_order" };
      if (!provesUnsigned(rail, { present: true, journal: cur })) return { ok: false, why: "may_have_signed" };
      if (cur.supersededBy && sameMark(cur.supersededBy, mark)) return { ok: true };
      start = cur;
    } else if (rail === "solana") {
      start = { op, rail: "solana", kind: "buy", state: "refused_precheck", createdAt: now, history: [] };
    } else {
      if (!base) return { ok: false, why: "no_journal" };
      start = { ...base, op, state: "refused_precheck", createdAt: now, notes: Array.isArray(base.notes) ? base.notes : [] };
      if (journalProblem(rail, start, op)) return { ok: false, why: "no_journal" };
    }
    const note = mark.closed ? `closed by auto recovery: ${mark.closed}` : `superseded by auto recovery: the order continues as ${mark.op}`;
    const next = { ...start, supersededBy: mark, updatedAt: now, ...(Array.isArray(start.history) ? { history: [...start.history, { at: now, state: start.state, note }] } : {}) };
    writeJournalFile(file, JSON.stringify(next, null, 2) + "\n");
    return { ok: true };
  } catch { return { ok: false, why: "write_failed" }; } finally { try { lock.release(); } catch { /* released with the process */ } }
}

/** Whether a journal at an attempt op's name is for a different request than the attempt's: the one collision there can be. */
export const collides = (journal, url) => Boolean(journal) && typeof journal.url === "string" && typeof url === "string" && journal.url !== url;

/** What to do next with an op that auto recovery marked. */
export const supersededNext = (by) => (by?.closed ? "use a new --op for a new purchase; this --op is never paid" : "read the operation the order continues as; this --op is never paid");

/** The words a rail gives for an op that auto recovery marked: never paid, and where the order went or that it ended. */
export function supersededWords(op, by) {
  if (by?.closed) return `operation ${op} was closed by auto recovery (order ${by.order_ref ?? "?"}): the order ended without a payment, and this operation is never paid. Buy again with a new --op`;
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
  // Rail needs unique decoded query names on BOTH sides (a percent-encoded duplicate is a duplicate): a parser that takes the first
  // or the last value of a repeated name would otherwise read a different request than the one the user made.
  const unique = (list) => new Set(list.map(([k]) => k)).size === list.length;
  const railBound = clean && target.origin === original.origin && Object.keys(fixed).length === 0 && unique(query) && unique(theirs)
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
 *   otherSellers       true only to check candidates of another seller (service); the dispatcher never sets it (INVARIANT 4)
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
    // a rail candidate is the same seller on ANOTHER chain: on the original's own chain it would be the order again, elsewhere
    if (bound.class === "rail" && chain === original.chain) return skip("same_chain");
    // INVARIANT 4: no request goes to another seller while the client cannot verify the owner's consent itself
    if (bound.class === "service" && ctx.otherSellers !== true) return skip("other_seller_off");
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

/**
 * The op id of an attempt: the order's op, 8 characters of the order's reference and the attempt number, within the 64-character
 * limit every rail accepts. Two orders whose ops share a prefix get different ids. A journal at that name is this order's evidence
 * only when it carries this order's stamp or mark (notThisOrder); anything else there is unknown, never claimed and never paid again.
 */
export const attemptOp = (op, attemptNo, orderRef) => `${op.slice(0, 52)}-${String(orderRef).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}-r${attemptNo}`;

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
 * Recovery for one order whose terms read failed after the retries, or a rerun of an order that has a record. Returns
 * { kind: "none" } (behave as today: the caller emits the first attempt's own answer), { kind: "none", closed: true } (the order
 * moved and ended without a payment, and every op it used is closed for good), { kind: "none", freezeFailed } (an op of the order
 * could not be marked: the order's outcome is unknown) or { kind: "result", code, fields } (the answer to give instead).
 *
 * `deps`:
 *   f                    the buy's flags { rail, chain, url, max, op, method?, body?, "pay-to"? }
 *   failure              the first attempt's termsFailure { stage, detail, attempts_used }; null on a rerun
 *   unsignedOriginal()   -> boolean   INVARIANT 1: the journal evidence for the original op (provesUnsigned)
 *   site()               -> origin | null   the site this agent's budget is linked to
 *   features()           -> Set | null      what the site lists; null: it did not answer
 *   funded()             -> Promise<Map chain -> remaining atomic>   this client's own chain reads
 *   siteCall(path, body) -> Promise<{ status, body }>   a request signed with the agent key
 *   freezeOp(target, mark, { attempt }) -> { ok, why? }   freezeOp with the evm journal base filled in
 *   attempt(flags, orderRef) -> Promise<{ code, fields, unsigned, termsFailure? }>   the ordinary buy of an attempt op
 *   attemptState(attempt, orderRef) -> Promise<{ exists, unsigned, collision?, code?, fields? }>   the attempt op's journal, read
 *                        under its record lock: a journal for another request is a collision (unknown); one that may have signed is reconciled
 *   now(), log(msg), otherSellers (tests only: see INVARIANT 4)
 */
export async function recoverOrder(deps) {
  const { f, failure } = deps;
  const none = { kind: "none" };
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  if (f.rail !== "evm" && f.rail !== "solana") return none;

  // An earlier run of this order, crashed or not: its record decides, whatever this run's flags say (--pay-to, --max, a method).
  // It is read BEFORE anything that decides whether a NEW recovery may start: those must never turn a moved order into "not paid".
  const earlier = readRecord(f.rail, f.chain, f.op);
  if (earlier?.unreadable) return none; // never guess: the caller answers from the op's own journal, or unknown when it moved
  if (earlier) return resume(deps, earlier);

  if (!failure) return none;
  if (f["pay-to"] !== undefined) return none; // the caller pinned a recipient: another seller or chain is not what they asked for
  const originalChain = recoveryChain(f.rail, f.chain);
  const maxAtomic = atomicOf(f.max);
  if (!originalChain || maxAtomic === null || maxAtomic === 0n) return none;
  const hasBody = (f.method !== undefined && String(f.method).toUpperCase() !== "GET") || f.body !== undefined;

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
    version: 2, order_ref: randomUUID(), rail: f.rail, chain: f.chain, op: f.op, url: f.url, max: f.max,
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
    funded, tried: [{ url: f.url, chain: f.chain }], alreadyOffered: 1, hasBody, otherSellers: deps.otherSellers === true,
  });
  if (!checked.ok) {
    log(`superstables budget: the site's recovery advice was not used (${checked.problem}); nothing was paid`);
    return none;
  }
  record.advice = { advice_id: checked.advice_id, expires_at_ms: checked.expiresAtMs, policy_version: checked.policy.version, max_offers: checked.policy.maxOffers, margin_bps: checked.policy.marginBps, rail_ok: checked.policy.rail, service_ok: checked.policy.service, allowed_chains: checked.policy.allowedChains };
  record.skipped = [...checked.skipped];
  for (const s of checked.skipped) log(`superstables budget: recovery candidate ${s.offer_id} skipped (${s.reason})`);
  if (!checked.valid.length) return { kind: "none", recovery: { switched: false, order_ref: record.order_ref, skipped: checked.skipped } };

  for (const candidate of checked.valid) {
    // INVARIANT 6: advice is not used after it expired
    if (now() >= checked.expiresAtMs) { record.skipped.push({ offer_id: candidate.offer_id, reason: "advice_expired" }); continue; }
    // INVARIANT 5: the original counts as an offer
    if (record.attempts.length + 1 >= checked.policy.maxOffers) { record.skipped.push({ offer_id: candidate.offer_id, reason: "over_max_offers" }); continue; }
    const attemptNo = record.attempts.length + 2;
    const attempt = {
      attempt_no: attemptNo, offer_id: candidate.offer_id, advice_id: checked.advice_id, kind: candidate.kind,
      rail: candidate.rail, chain: candidate.chain, url: candidate.url, op: attemptOp(f.op, attemptNo, record.order_ref),
      seller_id: candidate.sellerId, seller_name: candidate.sellerName, listed_atomic: candidate.listedAtomic.toString(), ceiling_atomic: candidate.ceilingAtomic.toString(),
      disclosed: candidate.disclosed, consent_id: candidate.consentId, params: candidate.params, fixed_params: candidate.fixedParams, why: candidate.why,
      journaledAt: new Date(now()).toISOString(), state: "journaled", outcome: null,
    };
    // INVARIANT 7: the switch is journaled, durably, BEFORE the new seller is contacted
    record.attempts.push(attempt);
    try {
      writeRecord(record);
    } catch (err) {
      // not journaled, so not contacted: the switch is dropped. Nothing was frozen for it; an earlier attempt's freeze stands.
      record.attempts.pop();
      log(`superstables budget: the recovery switch could not be journaled (${oneLineText(err?.code ?? err?.message ?? err, 80)}); nothing was paid`);
      break;
    }
    const done = await runAttempt(deps, record, attempt);
    if (done.kind === "result") return done;
    if (done.freezeFailed) return { kind: "none", freezeFailed: done.freezeFailed, recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped }) };
    if (done.blocked) break;
  }
  // Nothing was paid. An order that moved is over: every op it used is closed for good before that is said (closeOrder).
  if (!record.attempts.length) return { kind: "none", recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped }) };
  return endUnpaid(deps, record, record.closed ?? "no_attempt_paid");
}

function closeRecord(record, why) {
  record.closed = why;
  try { writeRecord(record); } catch { /* the order is over either way */ }
}

/** INVARIANT 6 at the last moment: the persisted advice has run out. */
const adviceRanOut = (deps, record) => Boolean(record.advice) && (deps.now ?? Date.now)() >= record.advice.expires_at_ms;

/** Closes an unsigned attempt that was not contacted, and says the order goes no further. */
function closeUncontacted(record, attempt, why) {
  attempt.state = "done"; attempt.outcome = "failed_before_payment"; attempt.note = `not contacted: ${why}`;
  record.closed = why;
  try { writeRecord(record); } catch { /* nothing was contacted either way */ }
  return { kind: "continue", unsigned: true, blocked: true };
}

const rootOf = (record) => ({ rail: record.rail, chain: record.chain, op: record.op });
/** The mark that says the order continues as `attempt`. */
const movedTo = (record, attempt) => ({ order_ref: record.order_ref, root: rootOf(record), op: attempt.op, rail: attempt.rail, chain: attempt.chain, attempt_no: attempt.attempt_no });
/** The mark that says the order ended without a payment. */
const closedMark = (record, why) => ({ order_ref: record.order_ref, root: rootOf(record), closed: why });

/**
 * INVARIANT 1, before `attempt` is contacted: every earlier attempt of the order, and then the original, is marked as superseded by
 * it, permanently and under each op's record lock, so none of them can be paid by anything once the order moves on. Returns null,
 * or the op that could not be marked { op, rail, chain, why }: then nothing of `attempt` is contacted and the outcome is unknown.
 */
/** One durable mark of the original per run and mark: the same mark is not written again by the next path that wants it. */
function markRoot(deps, record, mark) {
  const key = JSON.stringify(mark);
  deps.__rootMarked ??= new Set();
  if (deps.__rootMarked.has(key)) return { ok: true };
  const r = deps.freezeOp(rootOf(record), mark, { attempt: false });
  if (r.ok) deps.__rootMarked.add(key);
  return r;
}

function moveOrderTo(deps, record, attempt) {
  const mark = movedTo(record, attempt);
  // the original FIRST: before any attempt op is touched, the original is durably superseded under its own record lock
  const root = markRoot(deps, record, mark);
  if (!root.ok) return { ...rootOf(record), why: root.why };
  for (const a of record.attempts) {
    if (a === attempt) continue;
    const r = deps.freezeOp({ rail: a.rail, chain: a.chain, op: a.op }, mark, { attempt: true, url: a.url });
    if (!r.ok) return { op: a.op, rail: a.rail, chain: a.chain, why: r.why };
  }
  return null;
}

/**
 * The order ends without a payment: every op it used (its attempts, then the original) is marked closed under its record lock,
 * which only works while its journal proves nothing was signed. After that no command can pay any of them, so "not paid" stays
 * true. Returns null, or the first op that could not be closed { op, rail, chain, why, attempt? }.
 */
function closeOrder(deps, record, why) {
  if (!record.closed) closeRecord(record, why);
  const mark = closedMark(record, record.closed);
  // the original FIRST, then the attempts
  const root = markRoot(deps, record, mark);
  if (!root.ok) return { ...rootOf(record), why: root.why };
  for (const a of record.attempts) {
    const r = deps.freezeOp({ rail: a.rail, chain: a.chain, op: a.op }, mark, { attempt: true, url: a.url });
    if (!r.ok) return { op: a.op, rail: a.rail, chain: a.chain, why: r.why, attempt: a };
  }
  record.sealed = true;
  try { writeRecord(record); } catch { /* the marks are the truth; the record only repeats them */ }
  return null;
}

/** The answer when an op of the order could not be marked: unknown, never "not paid". */
function stuckResult(record, stuck) {
  return {
    kind: "result", code: 5,
    fields: {
      command: "buy", rail: stuck.rail, chain: stuck.chain, op: stuck.op, state: "unknown", final: false, paid: null, delivered: null, amount: null, remaining: null, tx: {},
      recovery: recoveryFact(record, null, { switched: record.attempts.length > 0, skipped: record.skipped ?? [] }),
      next: `wait for any command on operation ${stuck.op} to end, then run this buy again with the same --op; never pay again for this order while its outcome is unknown`,
      reason: `auto recovery could not close operation ${stuck.op} of this order (${stuck.why}): a command may be using it or it may have paid, so the order's outcome is unknown`,
    },
  };
}

/** Ends an order that moved and was not paid: closes every op first; an op that may have signed since is that order's answer. */
async function endUnpaid(deps, record, why) {
  const stuck = closeOrder(deps, record, why);
  if (stuck) {
    if (stuck.attempt && stuck.why === "may_have_signed") {
      const probe = await deps.attemptState(stuck.attempt, record.order_ref, { legacy: record.legacy === true });
      if (probe.exists && !probe.unsigned) return decided(deps, record, stuck.attempt, probe);
    }
    return stuckResult(record, stuck);
  }
  return { kind: "none", closed: true, recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped ?? [] }) };
}

/** Evidence only gets stronger: paid beats unknown, and unknown beats failed_before_payment. Never downgraded. */
const RANK = { failed_before_payment: 0, unknown: 1, paid: 2 };

/**
 * A settlement's delivery and chain finality, as the rail said them, kept with the attempt: without its journal, a payment on record
 * is reported with exactly these, never as delivered or final when that was not seen. Returns whether anything changed.
 */
function keepDelivery(attempt, fields) {
  if (fields?.state !== "settled") return false;
  let changed = false;
  if (typeof fields.delivered === "boolean" && attempt.delivered !== fields.delivered) { attempt.delivered = fields.delivered; changed = true; }
  const final = fields.chain_final === true || fields.chain_final === false ? fields.chain_final : null;
  if (fields.chain_final !== undefined && attempt.chain_final !== final) { attempt.chain_final = final; changed = true; }
  return changed;
}

/** Records what was observed about an attempt, also when it is already done: the stronger outcome, and its transaction. */
function learn(record, attempt, fields) {
  const seen = fields?.state === undefined ? null : outcomeOf(fields.state);
  const settle = fields?.tx && typeof fields.tx === "object" && fields.tx.settle ? fields.tx.settle : null;
  const pull = fields?.tx && typeof fields.tx === "object" && fields.tx.pull ? fields.tx.pull : null;
  let changed = false;
  if (attempt.state !== "done") { attempt.state = "done"; changed = true; }
  if (seen !== null && (attempt.outcome == null || RANK[seen] > (RANK[attempt.outcome] ?? -1))) { attempt.outcome = seen; changed = true; }
  // transaction kinds stay apart: `tx` is the settlement (the seller's payment), `tx_pull` the owner-to-agent transfer. A settlement
  // replaces anything stored as `tx` before; a pull never becomes `tx`.
  if (settle && attempt.tx !== settle) { attempt.tx = settle; changed = true; }
  if (pull && attempt.tx_pull !== pull) { attempt.tx_pull = pull; changed = true; }
  // a transaction recorded without its kind is promoted only when a journal proves which kind it is
  if (attempt.tx_unknown_kind && (attempt.tx_unknown_kind === settle || attempt.tx_unknown_kind === pull)) { delete attempt.tx_unknown_kind; changed = true; }
  if (keepDelivery(attempt, fields)) changed = true;
  if (changed) { try { writeRecord(record); } catch { /* the answer is the same; the rail's journal is the evidence */ } }
}

/**
 * Whether an order's record owns its original op, so that a buy of the original is answered from the order and never bought
 * again: once the original was marked, once any attempt was answered (decided), recorded as paid or unknown or with a
 * transaction, while a journaled switch waits to be carried on, and once the order was sealed. Also when the record cannot be
 * read: it exists only once a switch was journaled. A record whose only switch was never contacted because the original could
 * not be marked owns nothing: the original is answered, and bought, as any other op.
 */
export function recordOwns(record) {
  if (!record) return false;
  if (record.unreadable) return true;
  if (record.owns === true || record.sealed === true) return true;
  const last = record.attempts[record.attempts.length - 1];
  if (last && last.state === "journaled" && !record.closed) return true;
  return record.attempts.some((a) => recordedSigned(a) || a.freeze === "done");
}

/**
 * The rail boundary for an original whose journal lost its mark: when the order's recovery record owns the op (recordOwns), a rail
 * script run directly refuses it, with these words; "" when there is no such record. The rails call it under the op's record lock.
 */
export function recordOwnsWords(rail, chain, op) {
  try { recordPath(rail, chain, op); } catch { return ""; } // not an op that can have a record
  const record = readRecord(rail, chain, op);
  if (!recordOwns(record)) return "";
  return `operation ${op} belongs to an auto-recovered order (its recovery record says so) and is never bought again here. Rerun the original buy with superstables budget buy and the same --op: it answers from the order`;
}

/**
 * INVARIANT 1, before any attempt's evidence is returned: every other op of the order (the original, and every other attempt) is
 * marked as superseded by `attempt` under its record lock, so none can be paid afterwards. The record says it owns the original
 * before the marks are tried, so a crash or a failed mark never hands the original back. Returns null, or the op not marked.
 */
function retireOthers(deps, record, attempt) {
  if (record.owns !== true) { record.owns = true; try { writeRecord(record); } catch { /* the marks below decide */ } }
  return moveOrderTo(deps, record, attempt);
}

/** The answer when an attempt's evidence is in hand but another op of the order could not be marked: unknown, never more. */
function heldResult(record, attempt, fields, stuck) {
  const did = fields.state === "settled" ? "was paid" : "may have paid";
  return {
    kind: "result", code: 5,
    fields: switchedFields(record, attempt, {
      ...fields, state: "unknown", final: false, paid: null, delivered: null,
      next: `wait for any command on operation ${stuck.op} to end, then run the original buy again with the same --op; never pay again for this order while its outcome is unknown`,
      reason: `operation ${attempt.op} of this order ${did}, but auto recovery could not mark operation ${stuck.op} as superseded (${stuck.why}): a command may be using or paying it, so the order's outcome is unknown`,
    }),
  };
}

/**
 * An attempt whose own journal shows it did something: its answer (reconciled from the chain) is the order's, and is kept. Every
 * other op of the order is marked first; if one cannot be, the order is unknown.
 */
async function decided(deps, record, attempt, probe) {
  // the order owns its original from the first sight of an attempt's journal, durably (recordOwns), so reruns return here
  if (record.owns !== true) { record.owns = true; try { writeRecord(record); } catch { /* the marks below decide */ } }
  // the original is superseded FIRST, then the payment is learned; if it cannot be, the answer is unknown
  const held = rootFirst(deps, record, attempt);
  if (held) return held;
  // a busy candidate says nothing about the outcome yet, but the order has met it: at least unknown on record, so reruns return here
  if (probe.busy) learn(record, attempt, { state: "unknown", tx: {} }, true);
  else learn(record, attempt, probe.fields, true);
  const stuck = retireOthers(deps, record, attempt);
  if (stuck) return heldResult(record, attempt, probe.fields, stuck);
  return { kind: "result", code: probe.code, fields: switchedFields(record, attempt, probe.fields) };
}

/**
 * THE gate for every path that returns a candidate's paid or unknown result (a journal read, a recorded payment whose journal is
 * gone): the original op is durably superseded under its record lock first. Returns null when it is, else the unknown answer; the
 * attempt is then recorded as at least unknown (saved evidence is kept, never downgraded), so every rerun goes back to the order.
 */
function rootFirst(deps, record, attempt) {
  const frozen = markRoot(deps, record, record.sealed ? closedMark(record, record.closed) : movedTo(record, attempt));
  if (frozen.ok) return null;
  // the order has met this attempt: it owns the original from now on, and the attempt is at least unknown, so every rerun returns here
  record.owns = true;
  learn(record, attempt, { state: "unknown", tx: {} }, true);
  const quiet = { command: "buy", rail: attempt.rail, chain: attempt.chain, op: attempt.op, state: "unknown", paid: null, delivered: null, amount: null, tx: { ...(attempt.tx ? { settle: attempt.tx } : {}), ...(attempt.tx_pull ? { pull: attempt.tx_pull } : {}), ...(attempt.tx_unknown_kind ? { recorded: attempt.tx_unknown_kind } : {}) } };
  return heldResult(record, attempt, quiet, { ...rootOf(record), why: frozen.why });
}

/** Runs one journaled attempt through the ordinary buy, reports it, and decides whether the order goes on. */
async function runAttempt(deps, record, attempt) {
  const { f } = deps;
  // INVARIANT 6: immediately before the handoff (and again after the freeze), the advice must still hold
  if (adviceRanOut(deps, record)) return closeUncontacted(record, attempt, "advice_expired");
  // INVARIANT 1: every earlier op of the order is frozen at the rail boundary before anything of this attempt is contacted
  const stuck = moveOrderTo(deps, record, attempt);
  if (stuck) {
    // The freeze did not complete. An op this record could not mark is not owned by it: its own journal (under its lock) is the truth.
    attempt.freeze = `failed:${stuck.why}`;
    const out = closeUncontacted(record, attempt, "freeze_failed");
    return { ...out, freezeFailed: stuck };
  }
  attempt.freeze = "done";
  // the original is marked: from now on the order owns it, whatever happens to its journal (recordOwns)
  record.owns = true;
  try { writeRecord(record); } catch { /* the marks are the truth; the record only repeats them */ }
  // an attempt op that already did something is never run again: its own journal is the answer, read only after the original is marked
  const before = await deps.attemptState(attempt, record.order_ref, { legacy: record.legacy === true });
  if (before.exists && !before.unsigned) return decided(deps, record, attempt, before);

  // A freeze is permanent: if the advice ran out after it, the order ends here and the original stays superseded
  if (adviceRanOut(deps, record)) return closeUncontacted(record, attempt, "advice_expired");
  const flags = { ...f, rail: attempt.rail, chain: attempt.chain, url: attempt.url, max: decimalOf(attempt.ceiling_atomic), op: attempt.op, method: undefined, body: undefined, agent: undefined, "pay-to": undefined };
  const got = await deps.attempt(flags, record.order_ref);
  const state = got.fields?.state;
  const outcome = state === undefined ? "unknown" : outcomeOf(state);
  const tx = got.fields?.tx && typeof got.fields.tx === "object" ? (got.fields.tx.settle ?? got.fields.tx.pull ?? null) : null;
  // Nothing is recorded or reported as "failed before payment" until THIS attempt's op is closed for good under its record lock:
  // after that no command can pay it, so no snapshot of it goes stale. If something was signed meanwhile, or a command holds it,
  // that is the answer, never unpaid.
  if (outcome === "failed_before_payment" && got.unsigned === true) {
    const shut = deps.freezeOp({ rail: attempt.rail, chain: attempt.chain, op: attempt.op }, closedMark(record, "attempt_refused"), { attempt: true, url: attempt.url });
    if (!shut.ok) {
      if (shut.why === "may_have_signed") {
        const probe = await deps.attemptState(attempt, record.order_ref, { legacy: record.legacy === true });
        if (probe.exists && !probe.unsigned) { record.closed = "attempt_decided"; return decided(deps, record, attempt, probe); }
      }
      record.closed = "attempt_decided";
      return stuckResult(record, { op: attempt.op, rail: attempt.rail, chain: attempt.chain, why: shut.why });
    }
  }
  attempt.state = "done";
  attempt.outcome = attempt.outcome && RANK[attempt.outcome] > RANK[outcome] ? attempt.outcome : outcome;
  const gotSettle = got.fields?.tx?.settle ?? null, gotPull = got.fields?.tx?.pull ?? null;
  if (gotSettle) attempt.tx = gotSettle;
  else attempt.tx = attempt.tx ?? null;
  if (gotPull) attempt.tx_pull = gotPull;
  keepDelivery(attempt, got.fields);
  // a refusal before payment that left no signature behind: the order may go on to the next candidate
  const unsigned = outcome === "failed_before_payment" && got.unsigned === true && got.termsFailure !== undefined;
  if (!unsigned) record.closed = "attempt_decided";
  try { writeRecord(record); } catch { /* the outcome below is the answer; the journal of the purchase itself is the rail's */ }
  attempt.reported = await report(deps, record, attempt, outcome, tx);
  try { writeRecord(record); } catch { /* the report is best effort */ }
  if (unsigned) return { kind: "continue", unsigned: true };
  // refused before payment for another reason, with nothing signed: the order ends unpaid, so every op of it is closed first
  if (outcome === "failed_before_payment" && got.unsigned === true) {
    const end = await endUnpaid(deps, record, "attempt_refused");
    if (end.kind === "result") return end;
  }
  // paid, unknown, or refused: the order ends with this attempt's own answer
  return { kind: "result", code: got.code, fields: switchedFields(record, attempt, got.fields) };
}

function switchedFields(record, attempt, fields) {
  const where = `${attempt.rail === "evm" ? attempt.chain : "solana devnet"}`;
  const host = (() => { try { return new URL(attempt.url).host; } catch { return "the candidate seller"; } })();
  const state = fields.state;
  const what = state === "settled" ? `paid ${host} on ${where}` : state === "unknown" ? `may have paid ${host} on ${where} (outcome unknown, do not pay again)` : `tried ${host} on ${where}`;
  return {
    ...fields,
    ...(state === "unknown" ? { final: false } : {}),
    recovery: recoveryFact(record, attempt, {
      switched: true, kind: attempt.kind, why: `the first seller could not be paid: ${stageWords(record.failure.stage)} after ${record.failure.attempts_used} read${record.failure.attempts_used === 1 ? "" : "s"}`,
      paid_to: { host, rail: attempt.rail, chain: attempt.chain, ...(attempt.seller_name ? { seller_name: attempt.seller_name } : {}) },
      disclosed: attempt.disclosed, params: attempt.params ?? {}, fixed_params: attempt.fixed_params ?? {},
      note: `The agent switched on its own: it ${what}. The owner was not asked about this switch; it stayed inside the budget the owner granted on ${where}.`,
    }),
  };
}

/**
 * The exit of a payment on record without its journal, as budget/cli.mjs exitFor gives it for a settled buy: 0 only when the record
 * holds the seller's delivery, 4 when it was not delivered or the record does not say; 5 for anything short of a payment.
 */
const recordedExit = (a) => (a.outcome !== "paid" ? 5 : a.delivered === true ? 0 : 4);

/** The answer from the record alone, when the attempt's journal no longer shows what it did: no more than what was recorded. */
function recordedFields(a) {
  const paidOnRecord = a.outcome === "paid";
  const delivered = paidOnRecord && typeof a.delivered === "boolean" ? a.delivered : null;
  const chainFinal = paidOnRecord && typeof a.chain_final === "boolean" ? a.chain_final : null;
  const what = paidOnRecord
    ? `was paid${delivered === true ? " and delivered" : delivered === false ? " and not delivered" : ", and its delivery is not known"}${chainFinal === true ? "" : ", and whether the payment is final on chain is not known"}`
    : "may have paid";
  return {
    command: "buy", rail: a.rail, chain: a.chain, op: a.op, state: paidOnRecord ? "settled" : "unknown", ...(paidOnRecord ? { chain_final: chainFinal } : {}),
    paid: paidOnRecord ? true : null, delivered, amount: null,
    tx: { ...(a.tx ? { settle: a.tx } : {}), ...(a.tx_pull ? { pull: a.tx_pull } : {}), ...(a.tx_unknown_kind ? { recorded: a.tx_unknown_kind } : {}) },
    next: `superstables budget reconcile --rail ${a.rail} --chain ${a.chain} --op ${a.op} (never pay again for this order${paidOnRecord && delivered !== true ? "; if it was not delivered, report the transaction to the seller" : ""})`,
    reason: `the recovery record says operation ${a.op} ${what}${a.tx ? ` (transaction ${a.tx})` : a.tx_pull ? ` (pull ${a.tx_pull})` : a.tx_unknown_kind ? ` (recorded transaction ${a.tx_unknown_kind}, kind unknown)` : ""}, but its journal cannot be read: this is what was recorded, and it is never paid again`,
  };
}

/** What the record says an attempt did, when its own journal no longer shows it: paid, unknown, or a transaction. */
const recordedSigned = (a) => (a.state === "done" && (a.outcome === "paid" || a.outcome === "unknown")) || Boolean(a.tx) || Boolean(a.tx_pull) || Boolean(a.tx_unknown_kind);

/**
 * An order that has a record: a crash or a rerun found it. No new advice. Every op the order used is read first, under its record
 * lock: one whose own journal shows it did something is the order's answer (reconciled from the chain); one the record says paid
 * or may have paid, but whose journal shows nothing, is unknown. Only then is a journaled switch that was never contacted carried
 * on (if its advice still holds), and an order that ends without a payment is closed for good before it says so.
 */
async function resume(deps, record) {
  const last = record.attempts[record.attempts.length - 1];
  if (!last) return { kind: "none" }; // advice was never acted on
  // The original is durably superseded FIRST, before any attempt journal is read or any attempt lock is tried. If it cannot be, the
  // answer is unknown (the attempt recorded as at least unknown, so every rerun returns here) and no attempt is touched.
  const firstHeld = rootFirst(deps, record, last);
  if (firstHeld) return firstHeld;
  // INVARIANT 1: every attempt, the newest first; an attempt that may have signed is never run again, and what its journal says stands
  for (const a of [...record.attempts].reverse()) {
    const probe = await deps.attemptState(a, record.order_ref, { legacy: record.legacy === true });
    // a journal at an attempt op's name is this order's evidence when it carries this order's stamp, else unknown; rechecked on every rerun
    if (probe.exists && !probe.unsigned) return decided(deps, record, a, probe);
    // Losing local proof never erases what was recorded: the payment, or the unknown, with the evidence that was recorded.
    if (recordedSigned(a)) {
      const fields = recordedFields(a);
      const stuck = retireOthers(deps, record, a);
      if (stuck) return heldResult(record, a, fields, stuck);
      return { kind: "result", code: recordedExit(a), fields: switchedFields(record, a, fields) };
    }
  }
  // Journaled before the crash, nothing signed since. INVARIANT 6 binds this contact and payment too: the persisted advice must not
  // have expired, the site must still list the feature, and the persisted policy must still allow this kind of switch on this chain.
  if (last.state === "journaled" && !record.closed) {
    const stale = await resumeProblem(deps, record, last);
    if (stale) {
      last.state = "done"; last.outcome = "failed_before_payment"; last.note = `not contacted: ${stale}`;
      record.skipped = [...(record.skipped ?? []), { offer_id: last.offer_id, reason: stale }];
      closeRecord(record, stale);
    } else {
      const done = await runAttempt(deps, record, last);
      if (done.kind === "result") return done;
      if (done.freezeFailed) return { kind: "none", freezeFailed: done.freezeFailed, recovery: recoveryFact(record, null, { switched: false, skipped: record.skipped ?? [] }) };
    }
  }
  // Decided before (or just now), and nothing was signed: the order is over. Every op is closed under its lock before that is said:
  // a candidate that settled meanwhile (during the feature read, say) is that settlement, a busy one is unknown.
  return endUnpaid(deps, record, record.closed ?? "no_attempt_paid");
}

/** Why an unsigned, journaled attempt may not be carried on after a crash, or "". Nothing is contacted or paid when it is not "". */
async function resumeProblem(deps, record, attempt) {
  const now = deps.now ?? Date.now;
  const a = record.advice;
  if (!a || !Number.isFinite(a.expires_at_ms) || now() >= a.expires_at_ms) return "advice_expired";
  const features = await deps.features();
  // the feature read can take long: the expiry is checked again after it, not only before
  if (now() >= a.expires_at_ms) return "advice_expired";
  if (!features || !features.has(RECOVERY_FEATURE)) return "feature_off";
  // INVARIANT 4: a switch to another seller journaled by an earlier version is not carried on while this client keeps them off
  if (attempt.kind === "service" && deps.otherSellers !== true) return "other_seller_off";
  const kindOk = attempt.disclosed ? a.service_ok === true : a.rail_ok === true;
  if (!kindOk || !Array.isArray(a.allowed_chains) || !a.allowed_chains.includes(attempt.chain)) return "policy_off";
  return "";
}
