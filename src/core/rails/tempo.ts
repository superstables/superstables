import { finalityFor } from "../finality-policy.js";
import { inclusion } from "../finality.js";
// The MPP tempo.charge rail on Tempo Moderato, push mode: the owner's own wallet sends one pathUSD transferWithMemo,
// with the memo bound to the seller's challenge, and the seller is then shown the transaction's hash. Pinned in code:
// Tempo Moderato and its pathUSD. A challenge that asks for anything else is refused before the owner is asked: another
// chain or token, a split between several recipients, a memo of the seller's own, a seller that will not take a payment
// the owner's wallet sends (pull only), a credential in a header of the seller's choosing, or an expiry that leaves no
// time to approve.
//
// The memo is what makes the payment findable: it is an indexed topic of pathUSD's TransferWithMemo event, and it is
// bound to one challenge. A seller can issue the same challenge twice, though, so the engine never asks a wallet to send
// for a memo another attempt already used, and records the memo and the chain's head block before the wallet is asked:
// a payment whose hash never reached this machine is then found on chain (findPayment) in a later block only.

import { encodeFunctionData, getAddress, keccak256, toBytes, toHex, type Hex } from "viem";
import { TEMPO_MODERATO, fromAtomic, isAddress, isTransactionId, mainnetName } from "../chain.js";
import { hashCredential, type MppChallenge } from "../mpp.js";
import { chainRpc, rpcCall } from "../rpc.js";
import type { ChainCheck } from "../settlement.js";
import { untrustedText } from "../text.js";
import type { SignResult } from "../signer/types.js";
import type { PaymentTerms } from "../types.js";
import type { ChainReadOptions, FoundPayment, Judged, Offer, PaymentFacts, PushRail, SignedFacts } from "./types.js";

/** A challenge must leave the owner time to approve, and not bind them for longer than an hour (as on superstables.com). */
const MIN_CHALLENGE_SECONDS = 60;
const MAX_CHALLENGE_SECONDS = 3_600;
/** The owner's wallet is not asked to send later than this before the challenge expires: the seller must still take it. */
export const TEMPO_SEND_MARGIN_MS = 60_000;
/** How long the engine waits for the owner's transaction to show on chain before it gives up calling the seller. */
const CONFIRM_WAIT_MS = 30_000;
/** A challenge larger than this, as JSON without its raw request (mppx's own shape), is not one this client acts on. */
const MAX_CHALLENGE_CHARS = 4_000;

const TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));
const TRANSFER_WITH_MEMO_ABI = [
  {
    type: "function",
    name: "transferWithMemo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "memo", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

/**
 * The memo mppx puts on a tempo.charge payment (its Attribution.encode, no client id): a 4-byte "mpp" tag, version 1,
 * a 10-byte fingerprint of the realm, 10 zero bytes and a 7-byte nonce of the challenge id. The seller accepts a
 * transfer only with this memo, so the payment for one challenge can be found on chain.
 */
export function mppMemo(challengeId: string, realm: string): Hex {
  const buf = new Uint8Array(32);
  buf.set(toBytes(keccak256(toBytes("mpp"))).slice(0, 4), 0);
  buf[4] = 1;
  buf.set(toBytes(keccak256(toBytes(realm))).slice(0, 10), 5);
  buf.set(toBytes(keccak256(toBytes(challengeId))).slice(0, 7), 25);
  return toHex(buf);
}

/** The one call the owner's wallet sends: pathUSD.transferWithMemo(recipient, amount, memo), no value. */
export function transferCall(input: { from: string; recipient: string; amountAtomic: string; memo: Hex }): { from: string; to: string; data: Hex; value: "0x0" } {
  return {
    from: getAddress(input.from),
    to: getAddress(TEMPO_MODERATO.token.address),
    data: encodeFunctionData({ abi: TRANSFER_WITH_MEMO_ABI, functionName: "transferWithMemo", args: [getAddress(input.recipient), BigInt(input.amountAtomic), input.memo] }),
    value: "0x0",
  };
}

/**
 * Judge one tempo.charge challenge. Everything the owner is shown comes from the challenge's request, and only when it
 * is exactly what this client pays: Tempo Moderato, pathUSD, one positive whole amount to one well-formed recipient.
 */
export function judgeTempoCharge(challenge: MppChallenge, now: number = Date.now()): Judged {
  if (challenge.method !== "tempo" || challenge.intent !== "charge") {
    return { supported: false, reason: `MPP ${untrustedText(challenge.method, 30)}.${untrustedText(challenge.intent, 30)} is not supported (only tempo.charge)` };
  }
  if (JSON.stringify({ ...challenge, requestRaw: undefined }).length > MAX_CHALLENGE_CHARS) return { supported: false, reason: "the challenge is too large" };
  const request = challenge.request ?? {};
  const details = (request.methodDetails && typeof request.methodDetails === "object" ? request.methodDetails : {}) as Record<string, unknown>;
  if (typeof details.chainId !== "number") return { supported: false, reason: "the challenge's chain id is missing or malformed" };
  if (details.chainId !== TEMPO_MODERATO.chainId) {
    const named = `eip155:${details.chainId}`;
    const mainnet = mainnetName(named);
    return {
      supported: false,
      reason: mainnet
        ? `chain ${mainnet} is not supported: it is a mainnet, and this client pays on testnets only`
        : `chain ${untrustedText(named, 40)} is not supported for MPP (only ${TEMPO_MODERATO.label}, chain ${TEMPO_MODERATO.chainId})`,
    };
  }
  if (typeof request.currency !== "string" || request.currency.toLowerCase() !== TEMPO_MODERATO.token.address.toLowerCase()) {
    return { supported: false, reason: `the currency is not pathUSD on ${TEMPO_MODERATO.label}` };
  }
  if (request.decimals !== undefined && request.decimals !== TEMPO_MODERATO.token.decimals) {
    return { supported: false, reason: `the challenge quotes ${untrustedText(request.decimals, 10)} decimals; pathUSD has ${TEMPO_MODERATO.token.decimals}` };
  }
  const amount = typeof request.amount === "string" ? request.amount : "";
  if (!/^[1-9]\d{0,17}$/.test(amount)) return { supported: false, reason: "the amount is missing or malformed" };
  if (typeof request.recipient !== "string" || !isAddress(request.recipient)) return { supported: false, reason: "the recipient is missing or malformed" };
  if (details.splits !== undefined && !(Array.isArray(details.splits) && details.splits.length === 0)) {
    return { supported: false, reason: "a payment split between several recipients is not supported" };
  }
  // Any memo field at all, null included: the memo is the client's, bound to the challenge (as on superstables.com).
  if (details.memo !== undefined) return { supported: false, reason: "a memo chosen by the seller is not supported" };
  const modes = details.supportedModes;
  if (modes !== undefined && !(Array.isArray(modes) && modes.includes("push"))) {
    return { supported: false, reason: "the seller does not accept a payment the owner's wallet sends (push mode)" };
  }
  if (challenge.header !== undefined) return { supported: false, reason: "the seller wants the credential in a header of its own, which is not supported" };
  const expires = challenge.expires ? Date.parse(challenge.expires) : NaN;
  if (!Number.isFinite(expires)) return { supported: false, reason: "the challenge has no expiry" };
  const left = Math.floor((expires - now) / 1000);
  if (left < MIN_CHALLENGE_SECONDS) return { supported: false, reason: `the challenge expires in ${left} seconds, too soon to approve` };
  if (left > MAX_CHALLENGE_SECONDS) return { supported: false, reason: `the challenge stays open for ${left} seconds, longer than this client approves (at most ${MAX_CHALLENGE_SECONDS})` };
  const terms: PaymentTerms = {
    amountDecimal: fromAtomic(amount, TEMPO_MODERATO.token.decimals),
    amountAtomic: amount,
    asset: TEMPO_MODERATO.token.symbol,
    assetAddress: TEMPO_MODERATO.token.address,
    network: TEMPO_MODERATO.caip2,
    networkLabel: TEMPO_MODERATO.label,
    recipient: request.recipient,
    scheme: "charge",
  };
  return { supported: true, offer: { rail: "tempo", terms, requirement: challenge } };
}

const topicOf = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const isHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

interface RpcLog {
  removed?: boolean;
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  blockNumber?: string;
}

function rpcOf(options: ChainReadOptions): { url: string } | { error: string } {
  const override = options.rpcUrlFor?.(TEMPO_MODERATO);
  return override ? { url: override } : chainRpc(TEMPO_MODERATO);
}

/** Does this TransferWithMemo log show exactly this payment? */
function showsPayment(log: RpcLog, facts: PaymentFacts): boolean {
  if (!same(log.address, TEMPO_MODERATO.token.address) || !Array.isArray(log.topics) || log.topics.length !== 4) return false;
  const [topic0, from, to, memo] = log.topics;
  if (!same(topic0, TRANSFER_WITH_MEMO_TOPIC) || !same(from, topicOf(facts.payer)) || !same(to, topicOf(facts.recipient)) || !same(memo, facts.memo ?? "")) return false;
  try {
    return BigInt((log.data ?? "").slice(0, 66)) === BigInt(facts.amountAtomic);
  } catch {
    return false;
  }
}

/**
 * Read the owner's transaction and say whether it is this payment: it succeeded, and pathUSD logged
 * TransferWithMemo(owner, recipient, amount, memo) with exactly this payment's facts. The effect is read, not the
 * envelope, as on superstables.com: a wallet may send the owner's call through a sponsor or a smart account. Never throws.
 */
async function checkTempoPayment(facts: PaymentFacts, options: ChainReadOptions): Promise<ChainCheck> {
  if (!isHash(facts.transaction)) return { chain: "unchecked", reason: "no transaction hash was given" };
  if (!facts.memo || !isHash(facts.memo) || !isAddress(facts.payer) || !isAddress(facts.recipient)) {
    return { chain: "unchecked", reason: "this payment's memo was not recorded, so it cannot be matched" };
  }
  const rpc = rpcOf(options);
  if ("error" in rpc) return { chain: "unchecked", reason: `the chain was not read: ${rpc.error}` };
  let receipt: { status?: string; transactionHash?: string; blockNumber?: string; blockHash?: string; logs?: RpcLog[] } | null;
  try {
    receipt = await rpcCall(rpc.url, "eth_getTransactionReceipt", [facts.transaction], options);
  } catch {
    return { chain: "unchecked", reason: "the chain could not be read: the RPC did not give a usable answer" };
  }
  if (!receipt) return { chain: "unchecked", missing: true, reason: "the chain does not show the transaction yet" };
  if (!isHash(receipt.transactionHash) || receipt.transactionHash.toLowerCase() !== facts.transaction.toLowerCase()) {
    return { chain: "unchecked", reason: "the chain could not be read: the RPC answered with a receipt for another transaction" };
  }
  // Tempo Moderato uses committed BFT blocks with instant finality, but still requires canonical inclusion.
  const proof = await inclusion(rpc.url, receipt, finalityFor("tempo", "moderato"), options);
  if (proof === "removed") return { chain: "unchecked", missing: true, reason: "The earlier payment inclusion was removed; outcome unknown. Do not pay again." };
  if (proof === "unread") return { chain: "unchecked", reason: "the transaction has not reached a final block on chain" };
  if (receipt.status !== "0x1") return { chain: "mismatch", mismatchKind: proof === "final" ? "final_execution" : "provisional_execution", reason: "the transaction failed on chain" };
  // Mined before the wallet was asked to send: an older transfer, whatever it shows, is not this payment.
  const boundary = /^\d+$/.test(facts.searchFromBlock ?? "") ? BigInt(facts.searchFromBlock!) : undefined;
  const block = blockOf(receipt.blockNumber);
  if (boundary !== undefined && (block === undefined || block <= boundary)) {
    return block === undefined
      ? { chain: "unchecked", reason: "the chain could not be read: the RPC did not say which block the transaction is in" }
      : { chain: "mismatch", reason: "the transaction was mined before the owner's wallet was asked to send this payment" };
  }
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  if (!logs.some((log) => showsPayment(log, facts))) {
    return { chain: "mismatch", reason: "the transaction does not carry this payment: its payer, amount, recipient, token or memo differ" };
  }
  return proof === "final" ? { chain: "verified" } : { chain: "unchecked", included: true, reason: "the payment landed, but is not final on chain yet" };
}

/** Tempo Moderato's blocks are well under a second apart; the search errs on the side of more blocks. */
const BLOCKS_PER_SECOND = 4;
/** The public Moderato RPC answers log searches of up to 100,000 blocks. */
const LOG_RANGE = 100_000n;
/** At most this many log searches for one payment: about three million blocks, days of Moderato. */
const MAX_LOG_SEARCHES = 30;

/**
 * Look for a payment whose hash never reached this machine, or did but did not show yet: first the hash, then every
 * TransferWithMemo(owner, recipient, memo) the owner sent after the wallet was asked. That moment is a block: the head
 * the client read right before the wallet was asked (searchFromBlock), so a transfer in it or before it is never taken
 * for this payment, however alike. A transaction already recorded as another attempt's payment is never this one's.
 * (An attempt recorded before the head was read is searched from when the wallet was asked, by the chain's clock.)
 * Never throws.
 */
async function findTempoPayment(facts: PaymentFacts, options: ChainReadOptions): Promise<FoundPayment> {
  if (!facts.memo || !isHash(facts.memo) || !isAddress(facts.payer) || !isAddress(facts.recipient)) {
    return { found: false, reason: "this payment's memo was not recorded, so it cannot be looked for" };
  }
  const attributed = new Set((facts.attributed ?? []).map((tx) => tx.toLowerCase()));
  const boundary = /^\d+$/.test(facts.searchFromBlock ?? "") ? BigInt(facts.searchFromBlock!) : undefined;
  const since = facts.since ? Date.parse(facts.since) / 1000 : NaN;
  const rpc = rpcOf(options);
  if ("error" in rpc) return { found: false, unreadable: true, reason: `the chain was not read: ${rpc.error}` };
  try {
    /** Is this transaction, mined in this block, after the wallet was asked? */
    const after = async (block: bigint | undefined): Promise<boolean> => {
      if (block === undefined) return false;
      if (boundary !== undefined) return block > boundary;
      if (!Number.isFinite(since)) return false;
      const mined = await rpcCall<{ timestamp?: string } | null>(rpc.url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false], options);
      return mined?.timestamp !== undefined && Number(BigInt(mined.timestamp)) >= since;
    };
    if (isHash(facts.transaction) && !attributed.has(facts.transaction.toLowerCase())) {
      // checkTempoPayment holds the transaction to the block the wallet was asked after, when that was recorded.
      const byHash = await checkTempoPayment(facts, options);
      const receipt = (byHash.chain === "verified" || byHash.included) && boundary === undefined
        ? await rpcCall<{ blockNumber?: string } | null>(rpc.url, "eth_getTransactionReceipt", [facts.transaction], options)
        : undefined;
      if ((byHash.chain === "verified" || byHash.included) && (boundary !== undefined || (await after(blockOf(receipt?.blockNumber))))) {
        return { found: true, transaction: facts.transaction, ...(byHash.included ? { final: false } : {}) };
      }
    }
    const latest = await rpcCall<{ number?: string; timestamp?: string } | null>(rpc.url, "eth_getBlockByNumber", ["latest", false], options);
    const head = blockOf(latest?.number);
    if (head === undefined) return { found: false, unreadable: true, reason: "the chain could not be read: the RPC did not give a usable answer" };
    const cap = LOG_RANGE * BigInt(MAX_LOG_SEARCHES);
    let from: bigint;
    let reaches = true;
    if (boundary !== undefined) {
      from = boundary + 1n;
    } else {
      const chainTime = Number(BigInt(latest?.timestamp ?? ""));
      const seconds = Number.isFinite(since) ? Math.max(0, chainTime - since) + 120 : 3_600;
      const wanted = BigInt(Math.ceil(seconds * BLOCKS_PER_SECOND));
      reaches = wanted <= cap;
      const span = wanted > cap ? cap : wanted;
      from = head > span ? head - span : 0n;
    }
    const until = from + cap - 1n < head ? from + cap - 1n : head;
    if (until < head) reaches = false;
    while (from <= until) {
      const to = from + LOG_RANGE - 1n > until ? until : from + LOG_RANGE - 1n;
      const logs = await rpcCall<RpcLog[]>(
        rpc.url,
        "eth_getLogs",
        [{ address: TEMPO_MODERATO.token.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_WITH_MEMO_TOPIC, topicOf(facts.payer), topicOf(facts.recipient), facts.memo] }],
        options,
      );
      for (const log of Array.isArray(logs) ? logs : []) {
        if (!showsPayment(log, facts) || !isHash(log.transactionHash) || attributed.has(log.transactionHash.toLowerCase())) continue;
        if (!(await after(blockOf(log.blockNumber)))) continue;
        // The log is the chain's own answer to a search by memo; the receipt is read again to be sure it succeeded.
        const check = await checkTempoPayment({ ...facts, transaction: log.transactionHash }, options);
        if (check.chain === "verified" || check.included) return { found: true, transaction: log.transactionHash, ...(check.included ? { final: false } : {}) };
      }
      from = to + 1n;
    }
    return {
      found: false,
      reason: reaches
        ? "the chain shows no transfer with this payment's memo"
        : "the chain shows no transfer with this payment's memo in the blocks searched, which do not cover the whole time since the owner was asked",
    };
  } catch {
    return { found: false, unreadable: true, reason: "the chain could not be read: the RPC did not give a usable answer" };
  }
}

function blockOf(value: unknown): bigint | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : undefined;
}

/** The head block's number, read right before the owner's wallet is asked to send. Throws when it cannot be read. */
async function tempoHeadBlock(options: ChainReadOptions): Promise<string> {
  const rpc = rpcOf(options);
  if ("error" in rpc) throw new Error(rpc.error);
  const latest = await rpcCall<{ number?: string } | null>(rpc.url, "eth_getBlockByNumber", ["latest", false], options);
  const head = blockOf(latest?.number);
  if (head === undefined) throw new Error("the RPC did not give a usable answer");
  return head.toString();
}

export const tempoRail: PushRail = {
  rail: "tempo",
  flow: "push",
  signKind: "tempo-transfer",
  networks: [TEMPO_MODERATO],
  confirmWaitMs: CONFIRM_WAIT_MS,

  judgeChallenge: judgeTempoCharge,

  signRequest(offer, _x402Version, context) {
    return { kind: "tempo-transfer", challenge: offer.requirement as MppChallenge, context };
  },

  signedFacts(signed: SignResult): SignedFacts {
    return signed.kind === "tempo-transfer" ? { paymentMemo: signed.memo } : {};
  },

  credentialHeaders(offer: Offer, signed: SignResult): Record<string, string> {
    if (signed.kind !== "tempo-transfer") throw new Error("a Tempo payment carries the hash of the owner's transfer");
    return { Authorization: hashCredential(offer.requirement as MppChallenge, signed.hash, { address: getAddress(signed.signer), chainId: TEMPO_MODERATO.chainId }) };
  },

  paymentMemo(offer: Offer): string {
    const challenge = offer.requirement as MppChallenge;
    return mppMemo(challenge.id, challenge.realm);
  },

  isTransaction(value: unknown): value is string {
    return isTransactionId(TEMPO_MODERATO.caip2, value);
  },

  checkPayment: checkTempoPayment,
  findPayment: findTempoPayment,
  headBlock: tempoHeadBlock,
};
