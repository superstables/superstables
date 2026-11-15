// The report of a settled budget purchase, sent best effort to the site the budget is linked to (POST /api/v1/budget/purchases,
// v1), signed with the agent key like every hosted budget request. The dispatcher calls reportSettled after a buy's journal is
// final and before its RESULT is written; nothing here changes what the buy answers. A report goes out only when the buy settled
// and paid in this run, the budget on that rail and chain is linked to a site, the site lists purchase_reports_v1 in the features
// of GET /api/v1/budget/services, and SUPERSTABLES_PURCHASE_REPORTS is not off.
//
// Every field of the body comes from this machine: the purchase's own journal and its RESULT, never from the site.
//   rail, chain, op   the RESULT's (the rail, chain and op that actually paid; after auto recovery, the attempt's)
//   url               the journal's seller URL (evm and solana `url`, tempo `intent.url`), cut to scheme, host and path
//   amount_atomic     the RESULT's `amount` (the rail's debit, a decimal of the budget token) in atomic units
//   pay_to            the journal's payee (evm and solana `payTo`, tempo `intent.recipient`), else null
//   tx                the RESULT's tx.settle: the transaction that paid the seller (evm's tx also holds pull, cancel and return)
//   delivered         the RESULT's `delivered`
// The agent address is not in the body: the proof headers name it. Nothing else leaves: not the request body, the seller's
// answer, the query string, the owner address or the journal.

export const PURCHASE_FEATURE = "purchase_reports_v1";
export const PURCHASE_PATH = "/api/v1/budget/purchases";
/** The most time a report may add to a buy: the features read and the report together. The signed call itself allows 15 s. */
export const REPORT_BUDGET_MS = 10_000;
/** The most any one call waits on the site, so that the second still has its turn. */
const CALL_MAX_MS = 5_000;
/** What starting a rail script costs before its request goes out: left out of the time the request may take. */
const START_MS = 2_000;

/** Is reporting on? On unless SUPERSTABLES_PURCHASE_REPORTS is off (or 0, false, no), as SUPERSTABLES_REFERRALS is read. */
export function purchaseReportsOn(env = process.env) {
  const raw = (env.SUPERSTABLES_PURCHASE_REPORTS ?? "").trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false" || raw === "no");
}

const OP = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_TX = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** The seller URL without query string, fragment or userinfo, or null when it is not http(s) or is over 500 characters. */
export function strippedUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.username = ""; u.password = ""; u.search = ""; u.hash = "";
  const out = u.href;
  return out.length <= 500 ? out : null;
}

/** A decimal of the budget token ("0.05") in atomic units ("50000"), or null when it is not one with at most `decimals` places. */
export function atomicDigits(decimal, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(decimal ?? ""));
  if (!m || (m[2] ?? "").length > decimals) return null;
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0")).toString();
}

/** The transaction the journal records as the one that paid the seller, per rail. */
const journalSettleTx = (rail, j) => (rail === "evm" ? j.settleTx : rail === "tempo" ? j.tx : j.tx);
const journalUrl = (rail, j) => (rail === "tempo" ? j.intent?.url : j.url);
const journalPayTo = (rail, j) => (rail === "tempo" ? j.intent?.recipient : j.payTo);

/**
 * The v1 body for a settled purchase, or null when anything cannot be shown from the journal and the RESULT (a report is then not sent
 * at all, never sent with a guess). `fields` is the RESULT's fields, `journal` the purchase's own journal, `decimals` the budget
 * token's.
 */
export function reportBody(fields, journal, decimals) {
  if (!fields || fields.state !== "settled" || fields.paid !== true) return null;
  const rail = fields.rail;
  if (rail !== "evm" && rail !== "tempo" && rail !== "solana") return null;
  if (typeof fields.chain !== "string" || !fields.chain || typeof fields.op !== "string" || !OP.test(fields.op)) return null;
  if (!journal || typeof journal !== "object" || journal.state !== "settled" || journal.op !== fields.op) return null;
  const tx = fields.tx?.settle;
  const txOk = typeof tx === "string" && (rail === "solana" ? tx.length >= 64 && tx.length <= 96 && BASE58.test(tx) : HEX_TX.test(tx));
  if (!txOk || journalSettleTx(rail, journal) !== tx) return null;
  const url = strippedUrl(journalUrl(rail, journal));
  const amount = atomicDigits(fields.amount, decimals);
  if (url === null || amount === null) return null;
  const payee = journalPayTo(rail, journal);
  const payTo = typeof payee === "string" && (rail === "solana" ? payee.length >= 32 && payee.length <= 44 && BASE58.test(payee) : EVM_ADDRESS.test(payee)) ? payee : null;
  const delivered = fields.delivered === true || fields.delivered === false ? fields.delivered : null;
  return { version: 1, rail, chain: fields.chain, op: fields.op, url, amount_atomic: amount, pay_to: payTo, tx, delivered };
}

/**
 * Sends the report for a purchase whose RESULT is `fields`, when every condition holds. Never throws and never waits past the budget.
 * deps: { on(), journal(target), decimals(target), site(target) -> origin|null, call(target, method, path, body, timeoutMs) -> reply,
 *         interrupted(), stop(), log(line), now() }. `stop` ends the call in flight when the budget runs out.
 */
export async function reportSettled(fields, deps) {
  const done = { timer: null, over: false };
  try {
    if (!deps.on() || deps.interrupted() || fields?.state !== "settled" || fields.paid !== true) return;
    const target = { rail: fields.rail, chain: fields.chain, op: fields.op };
    const body = reportBody(fields, deps.journal(target), deps.decimals(target));
    if (!body) return;
    const origin = deps.site(target);
    if (!origin) return;
    const started = deps.now();
    const left = () => REPORT_BUDGET_MS - (deps.now() - started);
    const callMs = () => Math.min(CALL_MAX_MS, Math.max(1_000, left() - START_MS));
    const work = (async () => {
      const read = await deps.call(target, "GET", "/api/v1/budget/services", undefined, callMs());
      const features = read?.status === 200 && Array.isArray(read.body?.features) ? read.body.features : [];
      if (!features.includes(PURCHASE_FEATURE)) return;
      if (deps.interrupted() || left() < START_MS + 500) return;
      const reply = await deps.call(target, "POST", PURCHASE_PATH, body, callMs());
      if (done.over) return;
      const host = (() => { try { return new URL(origin).host; } catch { return "the site"; } })();
      if (reply?.status === 202 && reply.body?.accepted === true) deps.log(`superstables budget: purchase reported to ${host}; SUPERSTABLES_PURCHASE_REPORTS=off stops this.`);
      else if (typeof reply?.status === "number") deps.log(`superstables budget: ${host} did not confirm the purchase report (HTTP ${reply.status}); the purchase is unaffected.`);
      else deps.log(`superstables budget: could not confirm the purchase report to ${host} (${String(reply?.network ?? "no answer").slice(0, 80)}); the purchase is unaffected.`);
    })();
    const late = new Promise((resolve) => { done.timer = setTimeout(() => { done.over = true; try { deps.stop(); } catch { /* the call ends on its own limit */ } resolve("late"); }, REPORT_BUDGET_MS); });
    const how = await Promise.race([work.then(() => "done", () => "failed"), late]);
    if (how === "late") deps.log("superstables budget: purchase reporting timed out; the purchase is unaffected.");
  } catch {
    // best effort: nothing here may change the answer
  } finally {
    if (done.timer) clearTimeout(done.timer);
  }
}
