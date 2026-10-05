// The x402 exact rail on Solana devnet. The owner's Solana wallet partially signs one USDC transfer whose fee payer is the
// seller's facilitator (the offer's extra.feePayer); the facilitator adds its signature and sends it. The transaction is
// built and checked by the approval page's wallet step (../signer/steps/solana.ts, with ./solana-transaction.ts); this file
// judges the offer, carries the signed transaction to the seller, and reads the chain for it.
//
// Pinned in code (src/core/chain.ts): Solana devnet (its CAIP-2 id, and the RPC's genesis hash before anything is built)
// and Circle's devnet USDC mint. Refused before the owner is asked: another cluster or a mainnet, another token, an x402
// version other than 2, an offer whose seller does not pay the network fee, a malformed amount, recipient or fee payer.
//
// What ties a transaction on chain to this payment is the owner's signature: it is over the exact message that was built,
// so a transaction that carries it is this transfer. A settlement the seller names is checked for it, and for the
// transfer itself (that amount of that mint, from the owner's token account to the recipient's); an uncertain payment is
// looked for among the owner's token account's recent transactions.

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { SOLANA_DEVNET, fromAtomic, isTransactionId, type NetworkInfo } from "../chain.js";
import { chainRpc, rateLimited, rpcCall, type RpcOptions } from "../rpc.js";
import type { ChainCheck } from "../settlement.js";
import { base58Decode, isSolanaAddress } from "../signer/owner-approval-server.js";
import type { SignResult } from "../signer/types.js";
import { untrustedText } from "../text.js";
import type { PaymentTerms } from "../types.js";
import type { Challenge, RawAccept } from "../x402.js";
import { TOKEN_PROGRAM, tokenAccountOf } from "./solana-transaction.js";
import type { ChainReadOptions, FoundPayment, Judged, Offer, PaymentFacts, SignedFacts, X402Rail } from "./types.js";

const NETWORKS = [SOLANA_DEVNET] as const;
const MINT = SOLANA_DEVNET.token.address;
const DECIMALS = SOLANA_DEVNET.token.decimals;
const MAX_MEMO_BYTES = 256;
const MAX_TIMEOUT_SECONDS = 3_600;
const MAX_OFFER_CHARS = 4_000;
/** An uncertain payment is looked for among the owner's token account's transactions, this many to a page... */
const SEARCH_LIMIT = 100;
/** ...for at most this many pages... */
const SEARCH_PAGES = 10;
/** ...and at most this many of them, those in the payment's window, are read in full. */
const SEARCH_READS = 20;
/**
 * The blocks a transaction can land in after the slot it was built at: a blockhash is good for 150 blocks after the bank
 * it was read from (getLatestBlockhash's lastValidBlockHeight is that bank's height + 150), and the one after them.
 */
const WINDOW_BLOCKS = 151;
/** The most one block's answer may be (devnet's are tens of kilobytes), and how long reading it may take. */
const BLOCK_BYTES = 8_000_000;
const BLOCK_TIMEOUT_MS = 10_000;
/**
 * How long one search reads the window's blocks (ChainReadOptions.searchMs overrides it). The public devnet RPC serves
 * about six getBlock calls in ten seconds to one client, so the whole window takes it some four minutes: what a search
 * has read is kept on the attempt, and the next one reads on from there.
 */
const SEARCH_MS = 45_000;
/**
 * Once the RPC has limited a read, the search starts at most one read in this time, and waits as long as the RPC asks
 * (up to the longest wait) before the next: a read sooner counts against this client too. The public devnet RPC lets
 * one client read about six blocks in ten seconds.
 */
const PACE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** The newest transaction version a search reads: devnet blocks hold version 1 transactions, and a read for less fails. */
const CANDIDATE_VERSION = 1;

/**
 * An attempt recorded without the slot it was built at is searched back this long before it began, by the chain's
 * clock: far beyond any difference between that clock and this machine's.
 */
const LEGACY_SLACK_S = 3_600;

const refuse = (reason: string): Judged => ({ supported: false, reason });

export const solanaRail: X402Rail = {
  rail: "solana",
  flow: "x402",
  signKind: "solana-transaction",
  networks: NETWORKS,

  judgeAccept(accept: RawAccept, version: 1 | 2, network: NetworkInfo): Judged {
    if (network.rail !== "solana" || network.caip2 !== SOLANA_DEVNET.caip2) {
      return refuse(`${network.label} is not a Solana chain this client signs on`);
    }
    if (version !== 2) return refuse(`x402 version ${version} is not supported on ${network.label} (only 2)`);
    if (accept.asset !== MINT) {
      return refuse(`asset ${untrustedText(accept.extra?.name ?? accept.asset ?? "unknown", 60)} is not USDC on ${network.label} (mint ${MINT})`);
    }
    if (accept.extra?.decimals !== undefined && Number(accept.extra.decimals) !== DECIMALS) {
      return refuse(`the offer's token decimals are not USDC's (${DECIMALS})`);
    }
    // A string, as x402 v2 writes it (and as superstables.com takes it): a number is not converted.
    const amountAtomic = typeof accept.amount === "string" ? accept.amount : "";
    if (!/^[1-9]\d{0,17}$/.test(amountAtomic)) return refuse("the offered amount is missing or malformed");
    if (!isSolanaAddress(accept.payTo)) return refuse("the recipient (payTo) is missing or malformed");
    const timeout = accept.maxTimeoutSeconds ?? 300;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
      return refuse(`the offer's payment window is outside what is signed (at most ${MAX_TIMEOUT_SECONDS} seconds)`);
    }
    // The seller's facilitator pays the network fee and sends the transaction; the owner's wallet only signs the transfer.
    // An offer without a fee payer would have the owner pay and send it, which this client does not do.
    const feePayer = accept.extra?.feePayer;
    if (feePayer === undefined) return refuse("the offer names no fee payer (extra.feePayer): this client pays on Solana only when the seller pays the network fee");
    if (!isSolanaAddress(feePayer)) return refuse("the offer's fee payer (extra.feePayer) is malformed");
    if (feePayer === accept.payTo) return refuse("the offer's fee payer is its recipient");
    const memo = accept.extra?.memo;
    if (memo !== undefined && (typeof memo !== "string" || Buffer.byteLength(memo, "utf8") > MAX_MEMO_BYTES)) return refuse("the offer's memo is malformed");
    if (JSON.stringify(accept).length > MAX_OFFER_CHARS) return refuse("the offer is too large");

    const terms: PaymentTerms = {
      amountDecimal: fromAtomic(amountAtomic, DECIMALS),
      amountAtomic,
      asset: "USDC",
      assetAddress: MINT,
      network: network.caip2,
      networkLabel: network.label,
      recipient: accept.payTo,
      scheme: "exact",
      x402Version: 2,
    };
    // Sent back exactly as offered: the seller's facilitator settles only the requirement the seller wrote. What is signed
    // is built from the terms above and the pinned mint, not from this.
    const requirement = { ...accept } as unknown as PaymentRequirements;
    return { supported: true, offer: { rail: "solana", terms, requirement } };
  },

  signRequest(offer, _x402Version, context) {
    return { kind: "solana-transaction", requirements: offer.requirement as PaymentRequirements, x402Version: 2, context };
  },

  signedFacts(signed: SignResult): SignedFacts {
    if (signed.kind !== "solana-transaction" || !isTransactionId(SOLANA_DEVNET.caip2, signed.signature)) return {};
    return {
      ownerSignature: signed.signature,
      ...(Number.isSafeInteger(signed.lastValidBlockHeight) ? { lastValidBlockHeight: signed.lastValidBlockHeight } : {}),
      ...(Number.isSafeInteger(signed.searchFromSlot) ? { searchFromSlot: signed.searchFromSlot } : {}),
    };
  },

  credentialHeaders(offer: Offer, signed: SignResult, challenge: Challenge): Record<string, string> {
    if (signed.kind !== "solana-transaction") throw new Error("a Solana x402 payment carries a signed Solana transaction");
    // As x402 v2's SVM client sends it: the 402's resource and extensions, the offer as it was made, the transaction.
    const payload: PaymentPayload = {
      x402Version: 2,
      ...(challenge.resourceInfo ? { resource: challenge.resourceInfo as PaymentPayload["resource"] } : {}),
      accepted: offer.requirement as PaymentRequirements,
      payload: { transaction: signed.transaction },
      ...(challenge.extensions ? { extensions: challenge.extensions } : {}),
    };
    return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };
  },

  isTransaction(value: unknown): value is string {
    return isTransactionId(SOLANA_DEVNET.caip2, value);
  },

  async checkPayment(facts: PaymentFacts, options: ChainReadOptions): Promise<ChainCheck> {
    if (!isTransactionId(SOLANA_DEVNET.caip2, facts.transaction)) return { chain: "unchecked", reason: "no transaction signature was given" };
    if (!matchable(facts)) return { chain: "unchecked", reason: "this payment's signed transaction was not recorded, so it cannot be matched" };
    const rpc = rpcFor(options);
    if ("error" in rpc) return { chain: "unchecked", reason: `the chain was not read: ${rpc.error}` };
    let found: RpcTransaction | null;
    try {
      found = await readTransaction(rpc.url, facts.transaction, options);
    } catch {
      // The RPC's own error text is not repeated: it is somebody else's words.
      return { chain: "unchecked", reason: "the chain could not be read: the RPC did not give a usable answer" };
    }
    if (!found) return { chain: "unchecked", reason: "the chain does not show the transaction yet" };
    return judgeTransaction(found, facts.transaction, facts);
  },

  /**
   * Look for the payment by the owner's signature: first a transaction the seller named, then the owner's token account's
   * transactions since the payment was built (the transfer is from that account), newest first. Found and verified: paid.
   *
   * That list is an index the node writes after the blocks, so it can lag them: it is never taken as proof that the
   * payment is not there. "Never" is the word of the blocks themselves, decided only when all of this holds, and anything
   * short of it decides nothing:
   *
   *   1. The RPC is Solana devnet (its genesis hash), and its finalized block height is past the blockhash's last valid
   *      height: nothing can land any more.
   *   2. The window is read whole: the blockhash was read at a bank of height L - 150 (L the last valid height, 150 its
   *      age limit) at the slot the payment was built at, so it can only land in the 151 blocks after that slot, the last
   *      at height L + 1. Each of those finalized blocks is read in full (getBlock, every transaction's signatures; a node
   *      serves a block only once it has written all of its transactions' statuses), and their heights run L - 149 to
   *      L + 1 without a gap.
   *   3. None of them holds this payment: each transaction in them that carries the owner's signature is read and
   *      judged. The transfer signed, succeeded: paid. One that failed on chain, or is not that transfer, or is
   *      recorded as another attempt's payment: not paid by it.
   *
   * The RPC may limit how fast blocks are read (the public devnet RPC does): a limited read waits as long as the RPC asks
   * and is tried again, and the search reads no faster than one block every two seconds from then on, for up to
   * `searchMs`. A search that runs out of time says how far it read the window with no
   * payment in it (`searchedToSlot`), and the next one reads on from the block after it: finalized blocks do not change.
   *
   * A transaction already recorded as another attempt's payment is never this one's. An attempt recorded without the
   * slot it was built at is searched back to an hour before it began, and is never called "never".
   */
  async findPayment(facts: PaymentFacts, options: ChainReadOptions): Promise<FoundPayment> {
    if (!matchable(facts)) return { found: false, reason: "the owner's signature was not recorded, so the payment cannot be looked for" };
    const rpc = rpcFor(options);
    if ("error" in rpc) return { found: false, reason: `the chain was not read: ${rpc.error}`, unreadable: true };
    const unreadable: FoundPayment = { found: false, reason: "the chain could not be read: the RPC did not give a usable answer", unreadable: true };
    const attributed = new Set(facts.attributed ?? []);
    // A transaction the seller named comes first; it counts only if it carries the owner's signature.
    if (isTransactionId(SOLANA_DEVNET.caip2, facts.transaction) && !attributed.has(facts.transaction)) {
      const named = await solanaRail.checkPayment(facts, options);
      if (named.chain === "verified") return { found: true, transaction: facts.transaction };
    }
    /** A transaction carrying the owner's signature, read and judged: paid, or why not. */
    const judge = async (signature: string): Promise<FoundPayment | "unreadable"> => {
      const found = await readTransaction(rpc.url, signature, options, CANDIDATE_VERSION);
      if (!found) return "unreadable";
      if (!found.transaction?.signatures?.includes(facts.ownerSignature!)) return { found: false, reason: "" };
      const check = judgeTransaction(found, signature, facts);
      if (check.chain === "verified") return { found: true, transaction: signature };
      if (check.chain === "unchecked") return "unreadable";
      return { found: false, reason: `transaction ${signature} carries the owner's signature, but ${check.reason}` };
    };
    try {
      const genesis = await rpcCall<unknown>(rpc.url, "getGenesisHash", [], options);
      if (genesis !== SOLANA_DEVNET.genesisHash) {
        return { found: false, reason: "the Solana RPC this client reads is not on Solana devnet (its genesis hash differs), so it was not searched", unreadable: true };
      }
      const epoch = await rpcCall<{ absoluteSlot?: unknown; blockHeight?: unknown } | null>(rpc.url, "getEpochInfo", [{ commitment: "finalized" }], options);
      const finalizedSlot = epoch?.absoluteSlot;
      const height = epoch?.blockHeight;
      if (!isCount(finalizedSlot) || !isCount(height)) return unreadable;

      const last = facts.lastValidBlockHeight;
      const expired = last !== undefined && height > last;
      const fromSlot = isCount(facts.searchFromSlot) ? facts.searchFromSlot : undefined;
      const fromTime = facts.since ? Date.parse(facts.since) / 1000 - LEGACY_SLACK_S : NaN;
      if (fromSlot === undefined && !Number.isFinite(fromTime)) {
        return { found: false, reason: "this payment's start was not recorded, so the search cannot tell where to stop; look for the payment in the explorer", unreadable: true };
      }
      // Older than the payment: at or before the slot it was built at (it lands only after it), or for an older record a time.
      const older = (entry: { slot?: unknown; blockTime?: unknown }) =>
        fromSlot !== undefined ? (entry.slot as number) <= fromSlot : typeof entry.blockTime === "number" && entry.blockTime < fromTime;

      // The account's transactions since the payment was built, newest first, page by page: where a payment is found.
      const candidates: string[] = [];
      let listed = true;
      let before: string | undefined;
      for (let page = 0, done = false; page < SEARCH_PAGES && !done; page += 1) {
        const recent = await rpcCall<unknown>(
          rpc.url,
          "getSignaturesForAddress",
          [tokenAccountOf(facts.payer, MINT), { limit: SEARCH_LIMIT, commitment: "confirmed", minContextSlot: finalizedSlot, ...(before ? { before } : {}) }],
          options,
        );
        if (!Array.isArray(recent)) return unreadable;
        for (const entry of recent as { signature?: unknown; slot?: unknown; blockTime?: unknown }[]) {
          if (!isTransactionId(SOLANA_DEVNET.caip2, entry?.signature) || (fromSlot !== undefined && !isCount(entry.slot))) return unreadable;
          if (older(entry)) {
            done = true;
            break;
          }
          candidates.push(entry.signature);
        }
        if (recent.length < SEARCH_LIMIT) done = true;
        else before = (recent[recent.length - 1] as { signature: string }).signature;
      }
      let landedUnpaid: string | undefined;
      if (candidates.length > SEARCH_READS) {
        listed = false;
      } else {
        for (const signature of candidates) {
          if (attributed.has(signature)) continue;
          const judged = await judge(signature);
          // Listed, and then not readable: it might be this payment.
          if (judged === "unreadable") return unreadable;
          if (judged.found) return judged;
          if (judged.reason) landedUnpaid = judged.reason;
        }
      }
      if (!expired) {
        if (landedUnpaid) return { found: false, reason: landedUnpaid };
        if (!listed) return { found: false, reason: `the owner's token account has more transactions since this payment was built than are read (${SEARCH_READS}); look for the payment in the explorer`, unreadable: true };
        return { found: false, reason: `no transaction carrying the owner's signature was found yet${last === undefined ? "" : `; it can still land until block height ${last}`}` };
      }
      if (fromSlot === undefined) {
        return { found: false, reason: "no transaction carrying the owner's signature was found, but this payment was recorded without the slot it was built at, so the search cannot show it never landed; look for the payment in the explorer", unreadable: true };
      }

      // Past the blockhash: read the blocks it could have landed in, on from where an earlier search stopped. How far
      // they are read with no payment in them: that mark, then each block read whole whose transactions carrying the
      // owner's signature, each read and judged, are not this payment (another's, or failed on chain).
      const window = await readWindow(rpc.url, fromSlot, last!, facts.ownerSignature!, facts.searchedToSlot, options);
      let searchedTo = window.readTo;
      const progress = () => (searchedTo !== undefined ? { searchedToSlot: searchedTo } : {});
      for (const block of window.blocks) {
        for (const signature of block.carrying) {
          if (attributed.has(signature)) continue;
          const judged = await judge(signature).catch(() => "unreadable" as const);
          if (judged === "unreadable") return { ...unreadable, ...progress() };
          if (judged.found) return judged;
          if (judged.reason) landedUnpaid = judged.reason;
        }
        searchedTo = block.slot;
      }
      if (window.incomplete !== undefined) return { found: false, reason: window.incomplete, unreadable: true, ...progress() };
      return {
        found: false,
        never: true,
        reason: landedUnpaid
          ? `${landedUnpaid}, and its blockhash expired at block height ${last} (the chain is at ${height}), so it can no longer land`
          : `no transaction carrying the owner's signature succeeded, and its blockhash expired at block height ${last} (the chain is at ${height}): none of the ${WINDOW_BLOCKS} blocks it could land in holds one that did, so it can no longer land`,
      };
    } catch {
      return unreadable;
    }
  },
};

// ── Reading devnet ───────────────────────────────────────────────────────────────────────────────────────────

/** The RPC is not on Solana devnet: nothing may be built on its blockhash. */
export class NotDevnetError extends Error {
  constructor() {
    super("the Solana RPC this client reads is not on Solana devnet (its genesis hash differs), so nothing was built");
    this.name = "NotDevnetError";
  }
}

/** Where Solana devnet is read: the engine's choice (tests), or SUPERSTABLES_SOLANA_RPC, or the public devnet RPC. */
function rpcFor(options: Pick<ChainReadOptions, "rpcUrlFor">): { url: string } | { error: string } {
  const chosen = options.rpcUrlFor?.(SOLANA_DEVNET);
  return chosen ? { url: chosen } : chainRpc(SOLANA_DEVNET);
}

/**
 * A fresh blockhash to build a payment on, after checking that the RPC is Solana devnet (its genesis hash). Throws
 * NotDevnetError when it is another cluster, and any other error when it could not be read.
 */
export async function devnetBlockhash(options: ChainReadOptions = {}): Promise<{ blockhash: string; lastValidBlockHeight: number; slot?: number }> {
  const rpc = rpcFor(options);
  if ("error" in rpc) throw new Error(rpc.error);
  const genesis = await rpcCall<unknown>(rpc.url, "getGenesisHash", [], options);
  if (genesis !== SOLANA_DEVNET.genesisHash) throw new NotDevnetError();
  const latest = await rpcCall<{ context?: { slot?: unknown }; value?: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(rpc.url, "getLatestBlockhash", [{ commitment: "confirmed" }], options);
  const blockhash = latest?.value?.blockhash;
  const lastValidBlockHeight = latest?.value?.lastValidBlockHeight;
  if (typeof blockhash !== "string" || base58Decode(blockhash)?.length !== 32 || typeof lastValidBlockHeight !== "number" || !Number.isSafeInteger(lastValidBlockHeight)) {
    throw new Error("the RPC answered getLatestBlockhash with something else");
  }
  // The slot the RPC had reached: a transaction built on this blockhash, after this answer, lands in a later slot.
  const slot = latest?.context?.slot;
  return { blockhash, lastValidBlockHeight, ...(typeof slot === "number" && Number.isSafeInteger(slot) ? { slot } : {}) };
}

/** Devnet's block height now. Throws when it could not be read. */
export async function devnetBlockHeight(options: ChainReadOptions = {}): Promise<number> {
  const rpc = rpcFor(options);
  if ("error" in rpc) throw new Error(rpc.error);
  const height = await rpcCall<unknown>(rpc.url, "getBlockHeight", [{ commitment: "confirmed" }], options);
  if (typeof height !== "number" || !Number.isSafeInteger(height)) throw new Error("the RPC answered getBlockHeight with something else");
  return height;
}

/** A finalized transaction as getTransaction answers it (json encoding). */
interface RpcTransaction {
  meta?: { err?: unknown; loadedAddresses?: { writable?: unknown; readonly?: unknown } } | null;
  transaction?: {
    signatures?: unknown[];
    message?: {
      accountKeys?: unknown[];
      instructions?: { programIdIndex?: unknown; accounts?: unknown; data?: unknown }[];
    };
  };
}

function readTransaction(url: string, signature: string, options: RpcOptions, version = 0): Promise<RpcTransaction | null> {
  return rpcCall<RpcTransaction | null>(url, "getTransaction", [signature, { commitment: "finalized", maxSupportedTransactionVersion: version, encoding: "json" }], options);
}

/** What a search read of the blocks a payment could have landed in. */
interface WindowRead {
  /** An earlier search's mark it read on from: the window's blocks up to this slot hold no payment. */
  readTo?: number;
  /** The blocks read whole after it, in order, with the transactions in each that carry the owner's signature, by id. */
  blocks: { slot: number; carrying: string[] }[];
  /** Why the rest of the window is not read, when it is not: nothing is decided. */
  incomplete?: string;
}

/**
 * The finalized blocks a transaction built at `fromSlot` on a blockhash good until height `last` could land in, read
 * whole, one at a time: on from the block after `readTo` when an earlier search read the window that far (a slot that is
 * not one of the window's blocks is not taken), until the window ends or `searchMs` runs out.
 */
async function readWindow(url: string, fromSlot: number, last: number, ownerSignature: string, readTo: number | undefined, options: ChainReadOptions): Promise<WindowRead> {
  let slots: unknown;
  try {
    slots = await rpcCall<unknown>(url, "getBlocksWithLimit", [fromSlot + 1, WINDOW_BLOCKS, { commitment: "finalized" }], options);
  } catch {
    slots = undefined;
  }
  if (!Array.isArray(slots) || slots.length !== WINDOW_BLOCKS || !slots.every(isCount)) {
    return { blocks: [], incomplete: "the RPC did not list the blocks this payment could have landed in, so the search cannot show it never landed; look for the payment in the explorer" };
  }
  const window = slots as number[];
  const config = { commitment: "finalized", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: CANDIDATE_VERSION };
  const deadline = Date.now() + (options.searchMs ?? SEARCH_MS);
  // The block at window[i] is at height first + i: the window's blocks are consecutive, the last at height last + 1.
  const first = last - WINDOW_BLOCKS + 2;
  const resumed = readTo === undefined ? -1 : window.indexOf(readTo);
  const read: WindowRead = { ...(resumed >= 0 ? { readTo } : {}), blocks: [] };
  const stopped = (i: number, why: string): WindowRead => ({ ...read, incomplete: `${why}; ${i} of the ${WINDOW_BLOCKS} blocks this payment could have landed in are read, and the next search reads the rest` });
  // When the next read may start: from the first time the RPC limits a read, as late as it asks, and at its pace.
  let limited = false;
  let next = 0;
  for (let i = resumed + 1; i < window.length; i += 1) {
    let block: unknown;
    for (;;) {
      if (next >= deadline) return stopped(i, "the RPC limits how fast blocks can be read");
      if (next > Date.now()) await new Promise((resolve) => setTimeout(resolve, next - Date.now()));
      if (Date.now() >= deadline) return stopped(i, "the search ran out of time");
      const started = Date.now();
      try {
        // No read outlasts the search's time.
        const timeoutMs = Math.min(options.timeoutMs ?? BLOCK_TIMEOUT_MS, deadline - started);
        block = await rpcCall<unknown>(url, "getBlock", [window[i], config], { ...options, timeoutMs, maxBytes: BLOCK_BYTES });
        if (limited) next = started + PACE_MS;
        break;
      } catch (err) {
        if (Date.now() >= deadline) return stopped(i, "the search ran out of time");
        if (!rateLimited(err)) return stopped(i, `the RPC did not serve the block at slot ${window[i]}, so the search cannot show yet that the payment never landed`);
        limited = true;
        next = Math.max(started + PACE_MS, Date.now() + Math.min(err.retryAfterMs ?? 0, RETRY_MAX_MS));
      }
    }
    const answer = block as { blockHeight?: unknown; transactions?: unknown } | null;
    // Heights first + 0 .. first + 150 in order: every block of the window, none missing.
    if (!answer || answer.blockHeight !== first + i || !Array.isArray(answer.transactions)) {
      return { ...read, incomplete: "the RPC's ledger is missing blocks from this payment's window, or did not serve them whole, so the search cannot show it never landed; look for the payment in the explorer" };
    }
    const carrying: string[] = [];
    for (const entry of answer.transactions as { transaction?: { signatures?: unknown } }[]) {
      const signatures = entry?.transaction?.signatures;
      if (!Array.isArray(signatures) || !isTransactionId(SOLANA_DEVNET.caip2, signatures[0])) {
        return { ...read, incomplete: "the RPC served a block of this payment's window without its transactions' signatures, so the search cannot show it never landed" };
      }
      if (signatures.includes(ownerSignature)) carrying.push(signatures[0] as string);
    }
    read.blocks.push({ slot: window[i], carrying });
  }
  return read;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The facts carry what a transaction is matched by: the owner's signature, and the owner and recipient as addresses. */
function matchable(facts: PaymentFacts): boolean {
  return isTransactionId(SOLANA_DEVNET.caip2, facts.ownerSignature) && isSolanaAddress(facts.payer) && isSolanaAddress(facts.recipient) && /^\d+$/.test(facts.amountAtomic);
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Whether a finalized transaction is this payment: it is the transaction asked for, it carries the owner's signature, it
 * succeeded, and its one token instruction is a TransferChecked of the amount of devnet USDC from the owner's token
 * account to the recipient's, by the owner.
 */
function judgeTransaction(found: RpcTransaction, signature: string, facts: PaymentFacts): ChainCheck {
  const signatures = found.transaction?.signatures;
  if (!Array.isArray(signatures) || signatures[0] !== signature) {
    return { chain: "unchecked", reason: "the chain could not be read: the RPC answered with another transaction" };
  }
  if (!signatures.includes(facts.ownerSignature)) return { chain: "mismatch", reason: "the transaction does not carry the owner's signature over this payment" };
  if (!found.meta) return { chain: "unchecked", reason: "the chain could not be read: the RPC did not say whether the transaction succeeded" };
  if (found.meta.err !== null && found.meta.err !== undefined) return { chain: "mismatch", reason: "the transaction failed on chain" };

  const message = found.transaction?.message;
  const keys = [
    ...(Array.isArray(message?.accountKeys) ? message.accountKeys : []).map((k) => (typeof k === "string" ? k : typeof (k as { pubkey?: unknown })?.pubkey === "string" ? (k as { pubkey: string }).pubkey : "")),
    ...strings(found.meta.loadedAddresses?.writable),
    ...strings(found.meta.loadedAddresses?.readonly),
  ];
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  const token = instructions.filter((ix) => typeof ix?.programIdIndex === "number" && keys[ix.programIdIndex] === TOKEN_PROGRAM);
  if (token.length !== 1) return { chain: "mismatch", reason: "the transaction does not make exactly one token transfer" };
  const ix = token[0];
  const data = typeof ix.data === "string" ? base58Decode(ix.data) : undefined;
  const accounts = (Array.isArray(ix.accounts) ? ix.accounts : []).map((i) => (typeof i === "number" ? keys[i] : undefined));
  if (!data || data.length !== 10 || data[0] !== 12 || accounts.length !== 4) {
    return { chain: "mismatch", reason: "the transaction's token instruction is not the TransferChecked the owner signed" };
  }
  if (accounts[1] !== MINT || data[9] !== DECIMALS) return { chain: "mismatch", reason: "the transaction moved another token than USDC on Solana devnet" };
  if (accounts[0] !== tokenAccountOf(facts.payer, MINT) || accounts[3] !== facts.payer) {
    return { chain: "mismatch", reason: "the transaction did not move the tokens from the owner's account" };
  }
  if (accounts[2] !== tokenAccountOf(facts.recipient, MINT)) return { chain: "mismatch", reason: "the transaction did not pay the checked recipient" };
  if (Buffer.from(data).readBigUInt64LE(1) !== BigInt(facts.amountAtomic)) {
    return { chain: "mismatch", reason: "the transaction did not transfer the signed amount" };
  }
  return { chain: "verified" };
}
