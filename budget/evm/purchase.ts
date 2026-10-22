// purchase: one x402 `exact` purchase under a plain ERC-20 approve (B4), on the chain picked in chains.ts. Used by buy.ts (CLI).
// Chain-specific behavior is marked "CHAIN:" below.
//   1. GET the seller (free) -> 402 with the price.
//   2. Prechecks (rule 4), all before anything is signed or sent: token, decimals, precision, price vs --max,
//      recipient (not the zero address, the token, the agent or the owner) vs --pay-to, authorization lifetime (a whole number
//      of seconds, 30 to 600), then (unless `precheck: false`) the budget expiry, the allowance,
//      the owner's balance and the agent's own balance (must be 0, and have the gas for the pull and for the cancel and return a
//      failure would need, at the current fee; on a chain whose gas is the budget token, no earlier purchase's price may still be in
//      the agent key).
//   3. Journal the intent (rule 5), then the agent pulls exactly the price: USDC.transferFrom(owner, agent, price).
//      THIS PURCHASE'S OWN pull must land before it may pay. One purchase per agent key and chain at a time, from the balance
//      checks to its end (op-lock.mjs requireKeyLock).
//   4. Before the pull the x402 client builds the exact payment it would send and the signer checks it without signing; after the
//      pull it signs it, once, with from = agent (normal EOA signature). The EIP-3009 authorization is built here with the
//      operation's own nonce, which is marked with the seller's referral when the index gave one. The signer checks the whole
//      message (EIP-712 domain name, version, chain and token, recipient, amount, payer, lifetime, nonce) against the option that
//      passed the prechecks. The paid request carries that referral's token.
//   5. The settlement is read back from the chain (the operation's own authorization nonce), not from the seller.
//   6. If the pull landed and the payment did not settle: never re-pay. Cancel the open authorization on chain, then
//      return the price to the owner (USDC.transfer), after a fresh chain read. See ops.ts makeSafe.
import { requireRecordLock, requireKeyLock } from "../op-lock.mjs";
import { encodeFunctionData, getAddress, hashTypedData, isAddress, parseUnits, type Address, type Hex } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme, authorizationTypes } from "@x402/evm";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { refusedChainWords } from "../next-steps.mjs";
import { failureFact, readTerms, supersededNext, supersededWords, termsFailureOf, timedOut } from "../recovery.mjs";
import { nonceReferral, referralNonce } from "../../src/core/referral-nonce.ts";
import { referralFor, type ActiveReferral } from "../../src/core/referrals.ts";
import { authorizationTypedData } from "../../src/core/signer/steps/eip3009.ts";
import { PURCHASE_REF_HEADER, REFERRAL_HEADER } from "../../src/seller/referral.ts";
import {
  OPS_DIR, SYM, oneLine,
  sendJournaled, NETWORK, USDC, USDC_DECIMALS, CFG, GAS, cmd, erc20Abi, usdc, usdcBalance, allowanceOf, chainReason, publicClient, sleep,
  agentGas, gasWords, fundAgentNext, GasShort, ChainRefused, assertRpcChain,
  type AgentCtx, type Wallet, type GasNeed, type GasOp,
} from "./lib.ts";
import {
  newJournal, readJournal, writeJournal, reconcileJournal, readSettlement, readPull, makeSafe, otherOpWithTx, addFee, exitCodeFor, pendingJournalsFor, scanJournals, atomicUsdc, REUSABLE, PENDING,
  type Journal, type JournalReferral, type OpState,
} from "./ops.ts";

/** The longest authorization a budget purchase signs: a seller asking for longer is refused (the x402 client signs exactly the seller's window). */
export const MAX_AUTH_LIFETIME_S = 600;
// A shorter window can expire after the pull and before settlement, which costs gas for a cancel and a refund.
export const MIN_AUTH_LIFETIME_S = 30;
/** Seconds tolerated between the x402 client's `now` (validBefore = now + maxTimeoutSeconds, computed in this process right before it asks the signer) and the signer's. */
export const CLOCK_SLACK_S = 5;
/** How long a purchase waits for another purchase (or recover) on the same agent key and chain before it refuses. */
const KEY_WAIT_MS = 600_000;
/** The most of a 402 answer that is read: the x402 client reads the whole body of one, and a seller can send an endless one. */
const MAX_CHALLENGE_BYTES = 65_536;
/** The most of the seller's answer that is kept (buy saves it next to the journal). A longer answer is cut here and flagged. */
export const MAX_RESPONSE_BYTES = 1_000_000;

/** Reads at most `cap` bytes of a response body and stops reading after that, so a huge answer never sits in memory. */
async function readCapped(r: Response, cap: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!r.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = r.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (size + chunk.length > cap) {
        parts.push(chunk.subarray(0, cap - size));
        size = cap;
        truncated = true;
        break;
      }
      parts.push(chunk);
      size += chunk.length;
    }
  } catch {}
  if (truncated) reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(parts, size), truncated };
}

/**
 * Wraps `fetch` so that a 402 answer reaches @x402/fetch with at most 64 KB of body (it reads the whole of one with `.text()`),
 * rebuilt as a new Response with the same status and headers. Any other status is passed on as it is.
 */
export function capChallengeBody(inner: typeof fetch): typeof fetch {
  return async (input: any, init?: any) => {
    const r = await inner(input, init);
    if (r.status !== 402) return r;
    const { bytes } = await readCapped(r, MAX_CHALLENGE_BYTES);
    const headers = new Headers(r.headers);
    // the body was decoded by fetch and may have been cut: these no longer describe it
    for (const h of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(h);
    return new Response(bytes, { status: 402, statusText: r.statusText, headers });
  };
}

/** What the unpaid read of the seller's terms came to once the retries ended: set only when the last read failed. */
export type TermsOutcome = { failure: { stage: string; detail: string; attempts_used: number } | null };

/**
 * Wraps `fetch` so that the UNPAID read of the seller's terms is tried at most 3 times (250 ms, then 1 s, with jitter, never
 * before the seller's Retry-After up to 30 s; recovery.mjs readTerms) when it fails before any payment exists: no answer, a
 * 5xx, a 429, or a 402 whose payment requirements cannot be read. A read that ran out of time is not tried again, and all the
 * reads together take no longer than `timeoutMs` (--http-timeout), the time one read takes without retries. A request that
 * carries a payment is passed on as it is, once, whatever it answers: a payment is never retried here. The last answer is
 * returned as it came (or its error thrown), so everything after behaves as it did before; `outcome.failure` says the read
 * failed for good. `inner` must honour `init.signal` (purchase's timedFetch does).
 */
export function withTermsRetry(inner: typeof fetch, outcome: TermsOutcome, opts: { sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; timeoutMs?: number } = {}): typeof fetch {
  return async (input: any, init?: any) => {
    const request = new Request(input, init);
    if (request.headers.has("PAYMENT-SIGNATURE") || request.headers.has("X-PAYMENT")) { outcome.failure = null; return inner(request); }
    // only a GET without a body is read again: an application request may not be safe to repeat just because no payment exists yet
    if (request.method !== "GET" || request.body !== null) { outcome.failure = null; return inner(request); }
    let last: Response | undefined;
    let thrown: unknown;
    const read = await readTerms(async (_attempt: number, leftMs?: number) => {
      if (last) await last.body?.cancel().catch(() => {});
      last = undefined; thrown = undefined;
      let r: Response;
      try { r = await inner(request.clone(), leftMs === undefined ? undefined : { signal: AbortSignal.timeout(leftMs) }); } catch (e: any) { thrown = e; return { failure: termsFailureOf({ error: String(e?.cause?.code ?? e?.message ?? e), timeout: timedOut(e) }) }; }
      last = r;
      // the 402 answer was already cut to 64 KB by capChallengeBody; reading a copy leaves the answer itself whole
      const bodyText = r.status === 402 ? await r.clone().text().catch(() => "") : "";
      return { failure: termsFailureOf({ status: r.status, retryAfter: r.headers.get("retry-after"), paymentRequired: r.headers.get("payment-required"), bodyText }) };
    }, opts);
    outcome.failure = read.ok ? null : failureFact(read.failure, read.attemptsUsed);
    if (last) return last;
    throw thrown;
  };
}

/** The rule 4 checks on one payment option. Returns the reason to refuse, or null. Pure. */
export function checkAccept(a: any, o: { max: bigint; payTo?: string; agent?: string; owner?: string }): string | null {
  const asset = String(a.asset ?? "");
  if (asset.toLowerCase() !== USDC.toLowerCase()) return `token ${asset || "(none)"} is not ${CFG.label} ${SYM} ${USDC}`;
  const dec = a.extra?.decimals;
  if (dec !== undefined && Number(dec) !== USDC_DECIMALS) return `seller says the token has ${dec} decimals; ${CFG.label} ${SYM} has ${USDC_DECIMALS}`;
  // CHAIN: the EIP-712 domain differs per chain ("USD Coin" on Base mainnet, "USDC" on Base Sepolia and Arc). The signature is built
  // from the seller's extra.name / extra.version, so refuse an option whose domain is not the token's own. This also skips Circle
  // Gateway entries (extra.name "GatewayWalletBatched": a batched payment that needs a Gateway deposit, not EIP-3009).
  const nm = a.extra?.name, ver = a.extra?.version;
  if (nm === "GatewayWalletBatched") return `option is a Circle Gateway batched payment (extra.name GatewayWalletBatched), not a plain EIP-3009 payment`;
  if (nm !== CFG.domain.name || String(ver) !== CFG.domain.version) return `seller's EIP-712 domain (${nm}/${ver}) is not ${CFG.label} ${SYM}'s (${CFG.domain.name}/${CFG.domain.version}); the signature would not verify`;
  const method = a.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return `seller wants assetTransferMethod ${method}; only eip3009 is supported`;
  const raw = String(a.amount ?? a.maxAmountRequired ?? "");
  if (!/^\d+$/.test(raw)) return `amount "${raw}" is not a whole number of ${SYM} base units (more precision than ${USDC_DECIMALS} decimals, or not a number)`;
  const price = BigInt(raw);
  if (price === 0n) return "price is zero";
  if (price > o.max) return `price ${usdc(price)} ${SYM} exceeds --max ${usdc(o.max)} ${SYM}`;
  if (!isAddress(String(a.payTo ?? ""))) return `recipient "${a.payTo}" is not an address`;
  const to = String(a.payTo).toLowerCase();
  if (/^0x0{40}$/.test(to)) return "recipient is the zero address";
  if (to === USDC.toLowerCase()) return `recipient is the ${SYM} token contract itself`;
  if (o.agent && to === o.agent.toLowerCase()) return "recipient is this agent's own key";
  if (o.owner && to === o.owner.toLowerCase()) return "recipient is the owner's wallet, which funds this budget";
  if (o.payTo && String(a.payTo).toLowerCase() !== o.payTo.toLowerCase()) return `recipient ${a.payTo} is not the expected --pay-to ${o.payTo}`;
  const t = a.maxTimeoutSeconds;
  if (typeof t !== "number" || !Number.isInteger(t) || t < MIN_AUTH_LIFETIME_S || t > MAX_AUTH_LIFETIME_S) return `authorization lifetime ${oneLine(JSON.stringify(t ?? null), 40)} is not a whole number of seconds from ${MIN_AUTH_LIFETIME_S} to ${MAX_AUTH_LIFETIME_S}`;
  return null;
}

/** JSON with object keys sorted at every level: two options are the same only if every field is. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as any)[k]])) : x));

/**
 * Whether two payment options are the same one: every field, `extra` included (deep equality). A seller can list two options that
 * differ only in one field (a 1 s lifetime first, a 60 s one second): only the one that passed the prechecks may be signed.
 * Pure.
 */
export function sameOption(a: any, b: any): boolean {
  return !!a && !!b && typeof a === "object" && typeof b === "object" && canonical(a) === canonical(b);
}

/** The options the x402 client may select: only the one that passed the prechecks (none before one has). Pure. */
export function onlyOption(reqs: any[], chosen: any): any[] {
  return chosen ? reqs.filter((r) => sameOption(r, chosen)) : [];
}

/**
 * The referral an operation pays under and the nonce it signs, decided when it first starts. A later run under the same
 * --op (one that signed nothing) keeps both, so an operation's attribution never changes. A referral that cannot be read
 * is no referral: it is never worth a payment.
 */
export function operationAttribution(prior: Journal | null, url: string, lookup: (url: string) => ActiveReferral | undefined = referralFor): Pick<Journal, "referral" | "authorizationNonce"> {
  if (prior?.authorizationNonce) return { ...(prior.referral ? { referral: prior.referral } : {}), authorizationNonce: prior.authorizationNonce };
  let referral: JournalReferral | undefined;
  try {
    const found = lookup(url);
    if (found) referral = { id: found.id, listingId: found.listingId, terms: found.terms, token: found.token };
  } catch {}
  return { ...(referral ? { referral } : {}), authorizationNonce: referralNonce(referral?.id) };
}

/**
 * The referral headers of an operation's paid request: the token and the operation id as the purchase reference. None
 * unless the operation's nonce carries the same referral, so the token never names another referral than the payment.
 */
export function referralHeaders(j: Pick<Journal, "op" | "referral" | "authorizationNonce">): Record<string, string> {
  if (!j.referral || !j.authorizationNonce || nonceReferral(j.authorizationNonce) !== j.referral.id) return {};
  return { [REFERRAL_HEADER]: j.referral.token, [PURCHASE_REF_HEADER]: j.op };
}

/** A fetch that adds `headers` to the paid request only, the one carrying the payment, never to the unpaid one. */
export function onPaidRequest(base: typeof fetch, headers: Record<string, string>): typeof fetch {
  return (input: any, init?: any) => {
    const request = new Request(input, init);
    if (request.headers.has("PAYMENT-SIGNATURE") || request.headers.has("X-PAYMENT")) {
      for (const [name, value] of Object.entries(headers)) request.headers.set(name, value);
    }
    return base(request);
  };
}

type TypedDataSigner = { address: Address; signTypedData(m: any): Promise<Hex> };

/**
 * The SDK's x402 exact scheme for this chain (v1 or v2), with an EIP-3009 payload built here: the same authorization the
 * SDK builds, over the token's own domain, but with `nonce` instead of one the SDK picks. Any other transfer method stays
 * the SDK's (checkAccept refuses those before anything is pulled).
 */
export function withNonce<S extends ExactEvmScheme | ExactEvmSchemeV1>(scheme: S, signer: TypedDataSigner, nonce: Hex): S {
  const sdk = scheme.createPaymentPayload.bind(scheme) as (x402Version: number, requirements: any, context?: any) => Promise<any>;
  return Object.assign(scheme, {
    async createPaymentPayload(x402Version: number, requirements: any, context?: any) {
      if (x402Version !== 1 && (requirements.extra?.assetTransferMethod ?? "eip3009") !== "eip3009") return sdk(x402Version, requirements, context);
      const typed = authorizationTypedData({
        domain: { name: CFG.domain.name, version: CFG.domain.version, chainId: CFG.chainId, verifyingContract: getAddress(String(requirements.asset)) },
        requirement: requirements,
        x402Version: x402Version === 1 ? 1 : 2,
        payer: signer.address,
        nonce,
      });
      const signature = await signer.signTypedData(typed);
      const payload = { authorization: { ...typed.message }, signature };
      // A v1 payload is sent as it is, so it names its scheme and chain itself, as the SDK's v1 scheme does.
      return x402Version === 1 ? { x402Version, scheme: requirements.scheme, network: requirements.network, payload } : { x402Version, payload };
    },
  });
}

export type PurchaseOpts = {
  url: string;
  c: AgentCtx;
  op: string;
  max: bigint;
  payTo?: string;
  /** agent wallet used for every transaction (a nonce manager gives parallel pulls distinct nonces) */
  agent?: Wallet;
  /** run the allowance / balance / expiry / agent-balance prechecks before the pull. The chain-refusal check turns it off so the chain does the refusing. */
  precheck?: boolean;
  /** stop after the prechecks: print the quote, sign and send nothing */
  quoteOnly?: boolean;
  /** give up on the paid request after this many ms (the chain is read after that; the payment is never retried) */
  httpTimeoutMs?: number;
  tag?: string;
  /** an attempt of an auto-recovered order (the dispatcher's --recovery-order): the journal names the order, and an op whose journal
   *  another command wrote is refused before anything is read or signed */
  recoveryOrder?: string;
  /** tests: the retry's clock and randomness (recovery.mjs readTerms) */
  retry?: { sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number };
};

export type PurchaseResult = {
  state: OpState;
  ok: boolean; // settled on chain AND delivered
  journal: Journal;
  price?: bigint;
  payTo?: string;
  pulled: bigint;
  pullTx?: string;
  pullRefusal?: string; // chain error when this purchase's pull did not land
  pullRevertTx?: string; // mined-revert hash, when the refusal came from a mined transaction
  signedPayment: boolean;
  status?: number;
  settle?: any;
  settleTx?: string;
  sellerError?: string;
  body?: string; // a one-line preview for the log
  response?: { bytes: Buffer; truncated: boolean; contentType?: string }; // what the seller answered (up to MAX_RESPONSE_BYTES): buy saves it
  error?: string;
  exitCode: number; // ops.ts exitCodeFor: 0 settled and delivered (or quoted); 1 failed / refused by the chain; 3 refused before signing; 4 paid, not delivered; 5 unknown
  /** The seller's terms could not be read after the bounded retries, before any payment existed (recovery.mjs). */
  termsFailure?: { stage: string; detail: string; attempts_used: number };
};

/** Thrown by the signer during the dry run before the pull: carries what it found wrong with the payment, or null. */
class ProbeDone extends Error { constructor(public problem: string | null) { super("probe"); } }

/** Why the signer refuses this EIP-712 request, or null. Pure. */
export function typedDataProblem(m: any, o: { chosen: any; selected: any; payer: string; now: number; nonce?: string }): string | null {
  const { chosen, selected, payer, now } = o;
  const d = m?.domain ?? {}, msg = m?.message ?? {};
  if (!chosen) return "no validated quote";
  if (!selected || !sameOption(selected, chosen)) return "the x402 client did not confirm it is signing the option that passed the prechecks";
  if (m?.primaryType !== "TransferWithAuthorization") return `the request is ${oneLine(String(m?.primaryType), 40)}, not an EIP-3009 TransferWithAuthorization`;
  if (d.name !== CFG.domain.name || String(d.version) !== CFG.domain.version)
    return `signing domain ${oneLine(String(d.name), 60)}/${oneLine(String(d.version), 20)} is not ${CFG.label} ${SYM}'s (${CFG.domain.name}/${CFG.domain.version})`;
  if (Number(d.chainId ?? 0) !== CFG.chainId) return `signing domain chainId is not ${CFG.chainId}`;
  if (String(d.verifyingContract ?? "").toLowerCase() !== USDC.toLowerCase()) return `signing domain is not ${CFG.label} ${SYM}`;
  if (String(msg.from ?? "").toLowerCase() !== payer.toLowerCase()) return "payer is not the agent";
  if (String(msg.to ?? "").toLowerCase() !== String(chosen.payTo).toLowerCase()) return "authorization recipient differs from the validated quote";
  let value: bigint, after: bigint, before: bigint;
  try { value = BigInt(msg.value); after = BigInt(msg.validAfter ?? 0); before = BigInt(msg.validBefore); }
  catch { return "authorization value or validity window is not a whole number"; }
  if (value !== BigInt(chosen.amount ?? chosen.maxAmountRequired)) return "authorization amount differs from the validated quote";
  if (after > BigInt(now)) return "authorization is not valid yet";
  if (before <= BigInt(now)) return "authorization has already expired";
  if (before > BigInt(now + Number(chosen.maxTimeoutSeconds) + CLOCK_SLACK_S)) return `authorization would stay valid longer than ${chosen.maxTimeoutSeconds} s`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(msg.nonce ?? ""))) return "authorization nonce is not 32 bytes";
  if (o.nonce !== undefined && String(msg.nonce).toLowerCase() !== o.nonce.toLowerCase()) return "authorization nonce is not this operation's";
  // The fields above are the ones that matter to a person; the digest pins the rest: no extra domain field (a salt), no overridden
  // EIP712Domain type, no extra or renamed struct field. What is signed is exactly the token's EIP-3009 authorization.
  try {
    const expected = {
      domain: { name: CFG.domain.name, version: CFG.domain.version, chainId: CFG.chainId, verifyingContract: USDC as Address },
      types: authorizationTypes, primaryType: "TransferWithAuthorization" as const,
      message: { from: msg.from as Address, to: msg.to as Address, value, validAfter: after, validBefore: before, nonce: msg.nonce as `0x${string}` },
    };
    if (hashTypedData(m) !== hashTypedData(expected)) return "the typed data is not the token's EIP-3009 authorization";
  } catch { return "the typed data is not the token's EIP-3009 authorization"; }
  return null;
}

class Stop extends Error {
  constructor(public kind: "precheck" | "chain" | "quote" | "reconciled", public reason: string, public next?: string) { super(reason); }
}
/** What one purchase may cost the agent in gas: the pull, and the cancel and return a failure after it would need. */
export const PURCHASE_GAS: GasOp[] = ["pull", "cancel", "return"];
/** The refusal for an agent short on gas (exit 3, nothing signed). */
const gasStop = (g: GasNeed) =>
  new Stop("precheck", `REFUSED: ${gasWords(g, "this purchase", ", including what a refund would cost")}. Nothing was signed or pulled.`, `${fundAgentNext(g)} (the owner approves it in their wallet), then buy again`);

export { exitCodeFor };

export async function purchase(o: PurchaseOpts): Promise<PurchaseResult> {
  const lock = requireRecordLock(OPS_DIR, o.op);
  const hold: { key: { release(): void } | null } = { key: null };
  try {
    const r = await purchaseLocked(o, hold);
    if (GAS.isUsdc && hold.key) await noteArrivals(r.journal, (o.agent ?? o.c.wallet).account.address, o.tag).catch(() => {});
    return r;
  } finally { hold.key?.release(); lock.release(); }   // key first: the reverse of acquisition
}

/** CHAIN (gas in USDC): after a purchase that settled, or failed with its price returned, the agent key holds at most what it held
 *  right before the pull less the gas it spent. Anything above that arrived from outside (a seller refund). Report it; it is not reserve. */
async function noteArrivals(j: Journal, agent: Address, tag?: string) {
  if (!j.agentUsdcBefore || !(j.state === "settled" || (j.state === "failed" && j.returned))) return;
  const before = parseUnits(j.agentUsdcBefore, USDC_DECIMALS);                                   // ERC-20 view = floor(native / 1e12)
  const gas = BigInt(j.agentFeeWei ?? "0") / 10n ** BigInt(GAS.decimals - USDC_DECIMALS);        // native wei -> token units, rounded down
  const now = await usdcBalance(agent);
  const extra = now - (before - gas);   // before - floor(fee/1e12) is the HIGHEST balance the purchase can leave: never a false report
  if (extra <= 0n) return;
  const note = `the agent key holds ${usdc(extra)} ${SYM} more than before this purchase less its gas: money arrived from outside (a seller refund?). It is not gas reserve; the owner returns it with superstables budget recover --rail evm --chain ${CFG.key}`;
  j.notes.push(note); writeJournal(j);
  console.log(oneLine(tag ? `[${tag}] ${note}` : note, 2000));
}

async function purchaseLocked(o: PurchaseOpts, hold: { key: { release(): void } | null }): Promise<PurchaseResult> {
  const { c, url, max } = o;
  // one line per call: reasons can quote the seller's 402 (asset, payTo, domain name)
  const log = (s: string) => console.log(oneLine(o.tag ? `[${o.tag}] ${s}` : s, 2000));
  const agent = o.agent ?? c.wallet;
  const precheck = o.precheck ?? true;
  const httpTimeoutMs = o.httpTimeoutMs ?? 60_000;
  await assertRpcChain(); // a wrong chain is refused here, before any record exists

  const j = newJournal({ op: o.op, url, owner: c.owner, agent: agent.account.address, token: USDC, max: usdc(max), expectPayTo: o.payTo });
  const res: PurchaseResult = { state: "quoted", ok: false, journal: j, pulled: 0n, signedPayment: false, exitCode: 0 };
  const finish = (state: OpState, reason?: string, next?: string): PurchaseResult => {
    j.state = state;
    if (reason) j.reason = oneLine(reason, 1000);
    if (next) j.next = oneLine(next, 1000);
    writeJournal(j);
    res.state = state;
    res.ok = state === "settled" && j.delivered === true;
    res.exitCode = exitCodeFor(state, j.delivered);
    return res;
  };
  /** After the pull landed: read the chain, make the pulled price safe, fill the result from the journal. Never pays. */
  const settleFromChain = async (why: string): Promise<PurchaseResult> => {
    log(why);
    const after = await makeSafe(j, agent, { log });
    res.pulled = parseUnits(after.pulled ?? "0", USDC_DECIMALS);
    res.signedPayment = after.signed;
    res.settleTx = after.settleTx;
    res.state = after.state;
    res.ok = after.state === "settled" && after.delivered === true;
    res.exitCode = exitCodeFor(after.state, after.delivered);
    return res;
  };

  // An operation id that already did something is never run again (rule 5).
  const prior = readJournal(o.op);
  if (prior && !REUSABLE.includes(prior.state)) {
    const why = PENDING.includes(prior.state)
      ? `operation ${o.op} is ${prior.state}: run "${cmd("reconcile.ts", `--op ${o.op}`)}" and read the chain before doing anything else`
      : `operation ${o.op} already ended as ${prior.state}: use a new --op for a new purchase`;
    log(`REFUSED: ${why}`);
    return { ...res, state: "refused_precheck", journal: { ...j, state: "refused_precheck", reason: why, next: PENDING.includes(prior.state) ? `run reconcile --op ${o.op}` : "use a new --op" }, exitCode: 3 };
  }

  // INVARIANT 1: an op that auto recovery superseded is never paid, whoever starts it (this check runs under the op's record lock)
  if ((prior as any)?.supersededBy) {
    const why = supersededWords(o.op, (prior as any).supersededBy);
    log(`REFUSED: ${why}`);
    return { ...res, state: "refused_precheck", journal: { ...j, state: "refused_precheck", reason: why, next: supersededNext((prior as any).supersededBy), supersededBy: (prior as any).supersededBy } as any, exitCode: 3 };
  }

  // An attempt of an auto-recovered order stamps its journal with the order (the stamp is kept on every rewrite)
  if (o.recoveryOrder !== undefined) {
    // the op's name is derived from the order: a journal at that name is this order's, stamped or not, and the stamp is written now
    (j as any).recoveryOf = { order_ref: o.recoveryOrder };
  } else if ((prior as any)?.recoveryOf) {
    // an op that belongs to an auto-recovered order is run only as that order's attempt (--recovery-order with its reference)
    const why = `operation ${o.op} belongs to an auto-recovered order; it is run only by that order. Rerun the original buy of the order, which reads and continues it`;
    log(`REFUSED: ${why}`);
    return { ...res, state: "refused_precheck", journal: { ...j, state: "refused_precheck", reason: why, next: "rerun the original buy of the order with its own --op" }, exitCode: 3 };
  }

  // Frozen for this operation before anything is signed: a later run under the same --op pays under the same referral.
  Object.assign(j, operationAttribution(prior, url));
  if (j.referral) log(`referral ${j.referral.id} for listing ${j.referral.listingId}`);

  let chosen: any = null;
  let stop: Stop | null = null;
  let selected: any = null;   // what onBeforePaymentCreation confirmed, deep-equal to chosen
  let probing = false;        // the dry run before the pull: check, never sign
  let signatures = 0;
  const signer = {
    address: agent.account.address,
    async signTypedData(m: any) {
      // One payment signature per purchase: a second one would replace the journaled authorization while the first may be with the seller.
      if (!probing && signatures > 0) {
        stop = new Stop("reconciled", "signer refused: the x402 client asked for a second payment signature in one purchase; the first authorization stands and the chain decides");
        j.notes.push(stop.reason); writeJournal(j);
        throw stop;
      }
      // last gate before a signature exists: the message must be exactly the quote that passed the prechecks
      const bad = typedDataProblem(m, { chosen, selected, payer: agent.account.address, now: Math.floor(Date.now() / 1000), nonce: j.authorizationNonce });
      if (probing) throw new ProbeDone(bad);
      if (bad || res.pulled === 0n) {
        stop = new Stop("precheck", bad ? `signer refused: ${bad}` : "signer refused: this purchase's own pull has not landed");
        throw stop;
      }
      signatures++;
      const msg = m.message;
      // journal the authorization BEFORE the signature exists outside this process
      j.auth = { nonce: msg.nonce, validBefore: Number(msg.validBefore), validAfter: Number(msg.validAfter ?? 0), value: String(msg.value), to: msg.to, from: msg.from };
      j.signed = true;
      writeJournal(j);
      res.signedPayment = true;
      return agent.account.signTypedData(m);
    },
  };
  const nonce = j.authorizationNonce!;
  // the client can only ever select the option that passed the prechecks: its selector, its policy, and a hook before it builds a payment
  const core = new x402Client((_v: number, reqs: any[]) => {
    const same = reqs.filter((r) => sameOption(r, chosen));
    if (!same.length) throw new Error("no option equals the one that passed the prechecks");
    return same[0];
  }).register(NETWORK as `${string}:${string}`, withNonce(new ExactEvmScheme(signer as any), signer, nonce));
  // x402 v1 sellers name the chain the old way ("base-sepolia") and have their own table and scheme class. register() takes
  // no version argument: a v1 name registered there is never matched, and every v1 seller was refused.
  for (const legacy of CFG.legacyNetworks) core.registerV1(legacy, withNonce(new ExactEvmSchemeV1(signer as any), signer, nonce));
  // only the option that passed the prechecks can be selected
  core.registerPolicy((_v: number, reqs: any[]) => onlyOption(reqs, chosen));
  core.onBeforePaymentCreation(async ({ selectedRequirements }: any) => {
    if (!chosen || !sameOption(selectedRequirements, chosen)) return { abort: true, reason: "the client selected an option other than the one that passed the prechecks" };
    selected = selectedRequirements;
  });
  // CHAIN: the SDK signs only "default assets" (a table inside @x402/evm 2.27.0 that does not list Arc's USDC yet) or assets named in
  // spendControls.allowedAssets. Without this entry the client refuses Arc AFTER the pull has landed (seen on Arc Testnet: the pull was
  // returned, gas wasted). So the chain's USDC is allowed explicitly, capped at --max. The same call is dry-run before the pull below.
  // The v1 names get the same entry and the same --max cap.
  core.setSpendControls({ allowedAssets: [NETWORK, ...CFG.legacyNetworks].map((network) => ({ network: network as `${string}:${string}`, asset: USDC, maxAmountPerPayment: String(max) })) });
  const http = new x402HTTPClient(core);

  let hookCalls = 0;
  http.onPaymentRequired(async ({ paymentRequired }: any) => {
    try {
      if (++hookCalls > 1) throw new Stop("precheck", "the seller asked for payment a second time; not paying twice");
      const opts: any[] = (paymentRequired.accepts ?? []).filter((x: any) => (x.network === NETWORK || CFG.legacyNetworks.includes(x.network)) && x.scheme === "exact");
      if (!opts.length) throw new Stop("precheck", `seller has no usable exact ${CFG.label} option`);
      const reasons: string[] = [];
      let pick: any = null;
      for (const x of opts) {
        const why = checkAccept(x, { max, payTo: o.payTo, agent: o.c.agent, owner: o.c.owner });
        if (!why) { pick = x; break; }
        reasons.push(why);
      }
      if (!pick) throw new Stop("precheck", reasons[0]);
      const price = BigInt(pick.amount ?? pick.maxAmountRequired);
      res.price = price;
      res.payTo = pick.payTo;
      j.price = usdc(price);
      j.payTo = pick.payTo;
      log(`seller asks ${usdc(price)} ${SYM}, payTo ${pick.payTo}`);
      const onchainDecimals = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" }).catch(() => null);
      if (onchainDecimals !== USDC_DECIMALS) throw new Stop("precheck", `could not confirm ${SYM} has ${USDC_DECIMALS} decimals on chain (read ${onchainDecimals})`);
      chosen = pick;
      // Dry run BEFORE the pull: the x402 client builds the exact payment it would send (selection, spend controls, policy, the
      // hook, the scheme) and hands the message to the signer, which checks it and stops without signing. A refusal after a landed
      // pull would cost gas for the cancel and the return.
      probing = true;
      try {
        await core.createPaymentPayload(paymentRequired);
        throw new Error("the x402 client built a payment without asking the signer");
      } catch (e: any) {
        if (!(e instanceof ProbeDone)) throw new Stop("precheck", `the x402 client would not sign this option (${oneLine(String(e?.message ?? e).split("\n")[0], 300)}); nothing was pulled`);
        if (e.problem) throw new Stop("precheck", `REFUSED: the payment the x402 client would sign does not match the checked option: ${e.problem}. Nothing was signed or pulled.`);
      } finally {
        probing = false;
        selected = null; // the real payment is confirmed again
      }
      if (o.quoteOnly) throw new Stop("quote", `quote only: ${usdc(price)} ${SYM} to ${pick.payTo}`);
      // One purchase (or recover) at a time per agent key and chain, from the balance checks to the end of the purchase (released
      // in purchase()): two would read the same agent balance and sign the same nonce.
      const key = await requireKeyLock(OPS_DIR, agent.account.address, {
        waitMs: KEY_WAIT_MS,
        onWait: (busy: any) => log(`waiting for another purchase on this agent key to finish (${busy.holder ? `process ${busy.holder}` : "holder unknown"}); nothing is signed meanwhile`),
      });
      if (!key.ok) throw new Stop("precheck",
        `REFUSED: another purchase is still using this agent key on ${CFG.label} after ${KEY_WAIT_MS / 1000} s (${oneLine(key.details, 300)}). Nothing was signed or pulled.`,
        `buy again with the same --op once it has ended; if none is running, the owner checks in their own terminal and runs "superstables budget unlock --rail evm --chain ${CFG.key} --agent-key --confirm"`);
      hold.key = key;
      if (precheck) {
        const now = Math.floor(Date.now() / 1000);
        if (c.expiry && now > c.expiry) throw new Stop("precheck", `REFUSED: the budget expired at ${new Date(c.expiry * 1000).toISOString()} (public state file; the chain does not enforce it). The owner should revoke. No pull was made.`);
        const allowance = await allowanceOf(c.owner, agent.account.address);
        log(`allowance ${usdc(allowance)} ${SYM}`);
        if (allowance === 0n) throw new Stop("precheck", "REFUSED AT THE PULL: the allowance is 0 (revoked, spent or never set). No transferFrom was sent.");
        if (price > allowance) throw new Stop("precheck", `REFUSED AT THE PULL: price ${usdc(price)} exceeds the allowance ${usdc(allowance)}. No transferFrom was sent.`);
        const ownerBal = await usdcBalance(c.owner);
        if (price > ownerBal) throw new Stop("precheck", `REFUSED AT THE PULL: price ${usdc(price)} exceeds the owner's ${SYM} balance ${usdc(ownerBal)} (the allowance is ${usdc(allowance)}). No transferFrom was sent.`);
        const held = await usdcBalance(agent.account.address);
        // CHAIN: where USDC is also the gas token (Arc) the agent always holds a gas reserve, so 0 is the wrong test. A price an earlier
        // purchase pulled into the agent key and has not settled or returned is never gas reserve: it is refused by its journal, at
        // any amount. What no journal explains may be gas the owner sent; up to reserveMax of it is tolerated, as before.
        if (GAS.isUsdc) {
          // a journal that cannot be read could be one that holds a stranded price: it is never counted as gas reserve either
          const scan = scanJournals(agent.account.address);
          const blind = scan.unreadable.filter((u) => u.file !== `${o.op}.json`);
          if (blind.length) throw new Stop("precheck",
            `REFUSED: journal ${oneLine(blind.slice(0, 3).map((u) => `${u.file} (${u.why})`).join(", "), 300)} cannot be read; on ${CFG.label} any money it holds is not gas reserve. Nothing was signed or pulled.`,
            `the owner looks at the file(s) in ${OPS_DIR} (reconcile --op reads a journal), then buy again`);
          const open = pendingJournalsFor(agent.account.address, scan).filter((p) => p.op !== o.op);
          if (open.length) {
            let owed = 0n, unreadable = false;
            for (const p of open) {
              const pulled = atomicUsdc(p.pulled ?? p.price ?? "0"), back = atomicUsdc(p.returned ?? "0");
              if (pulled === null || back === null) { unreadable = true; continue; }
              owed += pulled > back ? pulled - back : 0n;
            }
            const ops = open.slice(0, 5).map((p) => p.op).join(", ");
            throw new Stop("precheck",
              `REFUSED: ${open.length === 1 ? "operation" : "operations"} ${ops} pulled ${unreadable ? "an unknown amount of" : usdc(owed)} ${SYM} into the agent key and ${open.length === 1 ? "is" : "are"} not settled or returned in the journal; on ${CFG.label} that money is not gas reserve. Nothing was signed or pulled.`,
              `run "${cmd("reconcile.ts", `--op ${open[0].op}`)}"; if it is still not settled, the owner runs "superstables budget recover --rail evm --chain ${CFG.key} --op ${open[0].op}", then buy again`);
          }
        }
        if (GAS.isUsdc ? held > GAS.reserveMax! : held > 0n) {
          const recover = `superstables budget recover --rail evm --chain ${CFG.key}`;
          throw new Stop("precheck",
            `REFUSED: the agent key already holds ${usdc(held)} ${SYM}${GAS.isUsdc ? ` (more than the ${usdc(GAS.reserveMax!)} ${SYM} gas reserve it should hold)` : ""}: a seller refund or funds stranded by an earlier purchase arrived there. Nothing was signed or pulled.`,
            `owner: run "${recover}" to return the ${usdc(held)} ${SYM} to the owner (the agent key sends it back; the owner approves in their wallet only if something is left for them to do), then buy again with a new --op`);
        }
        // The pull, and what a failure after it would need (cancel the authorization, return the price), at the current fee.
        const g = await agentGas(agent.account.address, PURCHASE_GAS);
        if (!g.ok) throw gasStop(g);
      }
      j.agentUsdcBefore = usdc(await usdcBalance(agent.account.address));
      // intent, before anything is sent
      j.state = "submitted";
      j.next = `run reconcile --op ${o.op}`;
      writeJournal(j);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [c.owner, agent.account.address, price] });
      try {
        const sent = await sendJournaled(agent, USDC, data, `${o.tag ? `[${o.tag}] ` : ""}pull ${usdc(price)} ${SYM} owner -> agent (transferFrom)`, ({ hash, nonce }) => {
          j.pullTx = hash;
          j.pullNonce = nonce;
          writeJournal(j);
        }, { op: "pull", then: ["cancel", "return"] });
        j.pullBlock = String(sent.blockNumber);
        j.pullStatus = "success";
        addFee(j, sent.feeWei);
      } catch (e: any) {
        let why: string;
        if (e?.txHash) {
          // mined and reverted: the chain refused this pull
          res.pullRevertTx = e.txHash;
          j.pullStatus = "reverted";
          if (e.feeWei) addFee(j, e.feeWei);
          why = `mined revert ${e.txHash}: ${await replayRevert(agent.account.address, data, e.blockNumber)}`;
        } else if (j.pullTx) {
          // failed after the hash was recorded (broadcast or wait): the transaction may or may not be in the pool.
          // Read the chain instead of guessing.
          const twin = otherOpWithTx("pullTx", j.pullTx, o.op);
          const rec = twin ? { verdict: "not_found" as const } : await reconcileJournal(j, { quiet: true });
          if (twin) j.notes.push(`the signed pull ${j.pullTx} is byte-identical to the one operation ${twin} recorded (same nonce in two processes); it belongs to ${twin}, not to this operation`);
          if (rec.verdict !== "not_found") {
            throw (stop = new Stop("reconciled", `the pull ${j.pullTx} failed to report (${chainReason(e)}); the chain says: ${j.reason ?? j.state}`));
          }
          j.notes.push(`pull ${j.pullTx} was signed but never reached the chain (${chainReason(e)})`);
          delete j.pullTx;
          delete j.pullNonce;
          res.pullRefusal = twin
            ? `not sent: byte-identical to operation ${twin}'s pull (the same agent nonce in two processes; run one process per agent key)`
            : `the network did not accept the transaction: ${chainReason(e)}`;
          throw new Stop("chain", `PULL NOT SENT: ${res.pullRefusal}`);
        } else if (e instanceof GasShort) {
          throw gasStop(e.g); // the fee rose after the precheck: nothing was signed
        } else if (e instanceof ChainRefused) {
          why = e.reason; // the pull reverts with enough gas (or with the token's revert data): nothing was signed
        } else {
          // an RPC error while preparing: nothing was signed, and the chain has refused nothing
          throw new Stop("precheck", `PULL NOT SENT: could not prepare the pull (${chainReason(e)}). Nothing was signed.`, "try again; if it keeps failing, check the RPC (superstables budget doctor)");
        }
        res.pullRefusal = why;
        throw new Stop("chain", `REFUSED ON CHAIN at the pull: ${why}`);
      }
      // The pull is only good if the chain shows exactly the price leaving the owner.
      // A provisional canonical pull can fund the original payment; permanent conclusions wait for reconcile finality.
      const seen = await readPull(j, { final: false });
      if (!seen.found || seen.moved !== price) {
        throw (stop = new Stop("reconciled", `the pull landed but the chain shows ${seen.found ? usdc(seen.moved ?? 0n) : "no"} ${SYM} moving from the owner instead of ${usdc(price)}; not paying`));
      }
      res.pulled = price; // set only after the pull landed: this purchase may now pay
      res.pullTx = j.pullTx;
      j.pulled = usdc(price);
      writeJournal(j);
      await sleep(4000); // give the seller's facilitator RPC time to see the new balance
    } catch (e: any) {
      if (e instanceof Stop) stop = e;
      throw e;
    }
  });

  // one deadline per request: a seller that never answers must not hang the purchase. No redirects: the paid retry
  // carries PAYMENT-SIGNATURE, which fetch would take to whatever host a redirect names.
  const terms: TermsOutcome = { failure: null };
  const timedFetch: typeof fetch = withTermsRetry(capChallengeBody((input: any, init?: any) => fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(httpTimeoutMs)]) : AbortSignal.timeout(httpTimeoutMs) })), terms, { timeoutMs: httpTimeoutMs, ...o.retry });
  const pay = wrapFetchWithPayment(onPaidRequest(timedFetch, referralHeaders(j)), http);
  let r: Response;
  try {
    r = await pay(url);
  } catch (e: any) {
    const st = stop as Stop | null;
    res.error = oneLine(e.message ?? e, 300);
    if (st?.kind === "quote") { log(st.reason); return finish("quoted", st.reason, "buy again without --quote-only to purchase"); }
    if (st?.kind === "precheck" && !j.pullTx) { log(st.reason); return finish("refused_precheck", st.reason, st.next ?? "nothing was signed or sent"); }
    if (st?.kind === "chain") { log(st.reason); return finish("refused_chain", st.reason, refusedChainWords(j.pullTx).next); }
    if (st?.kind === "reconciled" || j.pullTx) {
      // something went wrong after the pull was sent (or the chain could not confirm it): read the chain, never re-pay
      if (st?.kind === "reconciled" && !j.pulled && j.state !== "settled") { j.reason = st.reason; writeJournal(j); }
      return settleFromChain(`error after the pull was sent (${st?.reason ?? res.error}); reading the chain, never re-paying`);
    }
    log(res.error);
    if (terms.failure && !j.pullTx && !j.signed) res.termsFailure = terms.failure;
    return finish("refused_precheck", `seller unreachable or no usable challenge: ${res.error}`, "nothing was signed or sent");
  }

  const hdr = r.headers.get("payment-response") ?? r.headers.get("x-payment-response");
  if (hdr) try { res.settle = decodePaymentResponseHeader(hdr); } catch {}
  res.status = r.status;
  const got = await readCapped(r, MAX_RESPONSE_BYTES);
  res.response = { ...got, contentType: r.headers.get("content-type") ?? undefined };
  res.body = oneLine(got.bytes.subarray(0, 4096).toString("utf8").replace(/\s+/g, " "), 160);
  res.settleTx = res.settle?.transaction;
  if (!res.settle && r.status === 402) {
    const pr = r.headers.get("payment-required");
    if (pr) try { res.sellerError = oneLine(JSON.parse(Buffer.from(pr, "base64").toString()).error); } catch {}
    // a v1 seller says why in its 402 body
    else try { const b = JSON.parse(got.bytes.toString("utf8")); if (b?.x402Version === 1 && typeof b.error === "string") res.sellerError = oneLine(b.error); } catch {}
  }
  j.httpStatus = r.status;
  j.delivered = r.ok;

  if (!j.pullTx) {
    // the seller never asked for payment: nothing was pulled or signed
    if (terms.failure && !j.signed) res.termsFailure = terms.failure;
    return finish("refused_precheck", `seller did not ask for payment (HTTP ${r.status})`, "nothing was signed or sent");
  }

  // The seller's word is not evidence. Read the chain (own authorization nonce). RPC lag: a few short retries.
  let s = await readSettlement(j);
  for (let i = 0; !s.used && !s.canceled && i < 5 && (res.settle?.success || r.ok); i++) { await sleep(3000); s = await readSettlement(j); }
  if (s.used && s.settleTx) {
    const rec = await reconcileJournal(j, { quiet: true });
    res.settleTx = rec.j.settleTx;
    res.state = rec.j.state;
    res.ok = rec.j.state === "settled" && j.delivered === true;
    res.exitCode = exitCodeFor(rec.j.state, j.delivered);
    j.delivered = r.ok; // reconcile does not touch delivery; keep what the seller answered
    writeJournal(j);
    return res;
  }
  if (r.ok) {
    // The seller delivered but the chain does not show the payment yet. Do not cancel it (that would take the goods without paying):
    // the authorization stays valid until validBefore. Reconcile after that.
    const rec = await reconcileJournal(j, { quiet: !!o.tag });
    res.state = rec.j.state;
    res.settleTx = rec.j.settleTx;
    res.exitCode = exitCodeFor(rec.j.state, j.delivered);
    return res;
  }
  // The seller did not deliver and the chain shows no settlement: cancel the open authorization, then return the price.
  return settleFromChain(`seller answered HTTP ${r.status}; the chain does not show this purchase's authorization as used. Reading the chain (never re-paying).`);
}

/** After a mined revert, replay the same call at the block that mined it to read the reason. */
export async function replayRevert(from: Address, data: `0x${string}`, blockNumber: bigint): Promise<string> {
  try {
    await publicClient.call({ account: from, to: USDC, data, blockNumber });
    return "replay did not revert";
  } catch (e: any) {
    return chainReason(e);
  }
}
