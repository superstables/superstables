// The Solana payment transaction, without a Solana SDK: just as much of Solana's wire format as one x402 exact payment
// needs. base58, the associated token account (a program-derived address), one version 0 message with a fee payer and no
// lookup tables, and a transaction's signatures. The tests check each piece byte for byte against @solana/web3.js, which
// the budget uses; the client itself does not load it.
//
// The transaction is the one @x402/svm's exact scheme builds, as the hosted purchase on superstables.com builds it: a
// compute-unit limit of 20,000, a price of 1 micro-lamport, one TransferChecked of the mint from the owner's token account
// to the recipient's, signed by the owner, then a memo that makes it unique. The fee payer is the seller's facilitator
// (the offer's extra.feePayer): the owner's wallet signs as the token's owner only, and the facilitator adds its signature
// and sends it.

import { createHash, randomBytes } from "node:crypto";
import { base58Decode, verifyEd25519 } from "../signer/owner-approval-server.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** @x402/svm's exact scheme: these two compute-budget values, then the transfer, then a memo. */
export const COMPUTE_UNIT_LIMIT = 20_000;
export const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1n;
/** The SPL Token instruction TransferChecked. */
const TRANSFER_CHECKED = 12;
/** A version 0 message starts with this byte; a legacy one does not. */
const V0_PREFIX = 0x80;
const SIGNATURE_BYTES = 64;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58, as Solana writes addresses and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The 32 bytes of an address. Throws when it is not one. */
export function keyBytes(address: string): Uint8Array {
  const bytes = base58Decode(address);
  if (bytes?.length !== 32) throw new Error(`${address.slice(0, 50)} is not a Solana address`);
  return bytes;
}

// ── Program-derived addresses ────────────────────────────────────────────────────────────────────────────────

const P = 2n ** 255n - 19n;

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = ((base % P) + P) % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** ed25519's d = -121665 / 121666. */
const D = (((-121665n * modPow(121666n, P - 2n)) % P) + P) % P;

/**
 * Whether 32 bytes are a point on the ed25519 curve (RFC 8032 decoding): a key a wallet can sign for. A program-derived
 * address is one that is not, so that no key can ever sign for it.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const signBit = (bytes[31] & 0x80) !== 0;
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modPow(v, P - 2n)) % P;
  // x = 0 has no negative: a set sign bit there names no point.
  if (x2 === 0n) return !signBit;
  // x² must have a square root mod p (Euler's criterion).
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

/** The program-derived address of these seeds under a program: the first bump, from 255 down, that is off the curve. */
export function programAddress(seeds: Uint8Array[], program: string): string {
  const programBytes = keyBytes(program);
  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(programBytes);
    hash.update("ProgramDerivedAddress");
    const candidate = hash.digest();
    if (!isOnCurve(candidate)) return base58Encode(candidate);
  }
  throw new Error("no program-derived address for these seeds");
}

/** An owner's associated token account for a mint (the classic Token program): where its tokens are held. */
export function tokenAccountOf(owner: string, mint: string): string {
  return programAddress([keyBytes(owner), keyBytes(TOKEN_PROGRAM), keyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM);
}

// ── The message ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Instruction {
  program: string;
  accounts: { key: string; signer: boolean; writable: boolean }[];
  data: Uint8Array;
}

/** Solana's compact length: seven bits a byte, low bits first. */
function shortvec(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const low = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

function readShortvec(bytes: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const byte = bytes[at + i];
    if (byte === undefined) return undefined;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  return undefined;
}

export interface CompiledMessage {
  /** The message bytes: what every signer signs. */
  bytes: Uint8Array;
  /** The accounts in message order: signers first, the fee payer at 0. */
  keys: string[];
  /** How many signatures the transaction carries. */
  signers: number;
}

/**
 * A version 0 message with no address lookup tables, ordered as Solana orders it (and @solana/web3.js compiles it): the
 * fee payer, the other writable signers, the read-only signers, the writable accounts, the read-only ones, each group in
 * the order the instructions first name them, a program before its accounts.
 */
export function compileMessage(feePayer: string, blockhash: string, instructions: Instruction[]): CompiledMessage {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (key: string) => {
    let found = meta.get(key);
    if (!found) meta.set(key, (found = { signer: false, writable: false }));
    return found;
  };
  Object.assign(touch(feePayer), { signer: true, writable: true });
  for (const ix of instructions) {
    touch(ix.program);
    for (const account of ix.accounts) {
      const m = touch(account.key);
      m.signer ||= account.signer;
      m.writable ||= account.writable;
    }
  }
  const entries = [...meta];
  const group = (signer: boolean, writable: boolean) => entries.filter(([, m]) => m.signer === signer && m.writable === writable).map(([key]) => key);
  const writableSigners = group(true, true);
  const readonlySigners = group(true, false);
  const readonlyUnsigned = group(false, false);
  const keys = [...writableSigners, ...readonlySigners, ...group(false, true), ...readonlyUnsigned];
  const signers = writableSigners.length + readonlySigners.length;
  if (keys.length > 255) throw new Error("too many accounts for one message");

  const out: number[] = [V0_PREFIX, signers, readonlySigners.length, readonlyUnsigned.length, ...shortvec(keys.length)];
  for (const key of keys) out.push(...keyBytes(key));
  out.push(...keyBytes(blockhash));
  out.push(...shortvec(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.program), ...shortvec(ix.accounts.length));
    for (const account of ix.accounts) out.push(keys.indexOf(account.key));
    out.push(...shortvec(ix.data.length), ...ix.data);
  }
  out.push(...shortvec(0)); // no address lookup tables
  return { bytes: Uint8Array.from(out), keys, signers };
}

/** A transaction as it goes over the wire: its signatures, then the message they sign. */
export function serializeTransaction(signatures: Uint8Array[], message: Uint8Array): Uint8Array {
  const out = [...shortvec(signatures.length)];
  for (const signature of signatures) out.push(...signature);
  return Uint8Array.from([...out, ...message]);
}

/** A transaction's signatures and message bytes, or undefined when the bytes are not a transaction. */
export function parseTransaction(bytes: Uint8Array): { signatures: Uint8Array[]; message: Uint8Array } | undefined {
  const count = readShortvec(bytes, 0);
  if (!count || count.value === 0) return undefined;
  const messageAt = count.next + count.value * SIGNATURE_BYTES;
  if (messageAt >= bytes.length) return undefined;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < count.value; i += 1) {
    const at = count.next + i * SIGNATURE_BYTES;
    signatures.push(bytes.slice(at, at + SIGNATURE_BYTES));
  }
  return { signatures, message: bytes.slice(messageAt) };
}

// ── The payment ──────────────────────────────────────────────────────────────────────────────────────────────

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/** ComputeBudget SetComputeUnitLimit and SetComputeUnitPrice. */
const computeUnitLimit = (units: number): Instruction => ({ program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, ...u32(units)]) });
const computeUnitPrice = (microLamports: bigint): Instruction => ({ program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([3, ...u64(microLamports)]) });

/** SPL Token TransferChecked: `amount` of `mint` (with its decimals) from `source` to `destination`, `authority` signing. */
export function transferChecked(input: { source: string; mint: string; destination: string; authority: string; amount: bigint; decimals: number }): Instruction {
  return {
    program: TOKEN_PROGRAM,
    accounts: [
      { key: input.source, signer: false, writable: true },
      { key: input.mint, signer: false, writable: false },
      { key: input.destination, signer: false, writable: true },
      { key: input.authority, signer: true, writable: false },
    ],
    data: Uint8Array.from([TRANSFER_CHECKED, ...u64(input.amount), input.decimals]),
  };
}

export interface BuiltPayment {
  /** The message the owner signs, base64: what the signed transaction must still carry, byte for byte. */
  message: string;
  /** The whole transaction with empty signatures, base64: what the wallet is given. */
  transaction: string;
  /** Where the owner's signature goes: its index among the signers. The fee payer's (0) stays empty for the facilitator. */
  ownerIndex: number;
  signers: number;
  memo: string;
}

/** The payment transaction for these terms, from `owner`, with the seller's `feePayer` paying the network fee. */
export function buildPayment(input: {
  owner: string;
  recipient: string;
  mint: string;
  decimals: number;
  amountAtomic: string;
  feePayer: string;
  blockhash: string;
  memo?: string;
}): BuiltPayment {
  if (input.feePayer === input.owner) throw new Error("the fee payer is the owner's own address");
  const memo = input.memo ?? randomBytes(16).toString("hex");
  const message = compileMessage(input.feePayer, input.blockhash, [
    computeUnitLimit(COMPUTE_UNIT_LIMIT),
    computeUnitPrice(COMPUTE_UNIT_PRICE_MICROLAMPORTS),
    transferChecked({
      source: tokenAccountOf(input.owner, input.mint),
      mint: input.mint,
      destination: tokenAccountOf(input.recipient, input.mint),
      authority: input.owner,
      amount: BigInt(input.amountAtomic),
      decimals: input.decimals,
    }),
    { program: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode(memo) },
  ]);
  const empty = Array.from({ length: message.signers }, () => new Uint8Array(SIGNATURE_BYTES));
  return {
    message: Buffer.from(message.bytes).toString("base64"),
    transaction: Buffer.from(serializeTransaction(empty, message.bytes)).toString("base64"),
    ownerIndex: message.keys.indexOf(input.owner),
    signers: message.signers,
    memo,
  };
}

export type SignedCheck =
  | { ok: true; signature: string; transaction: string }
  | { ok: false; code: "invalid_transaction" | "transaction_changed" | "bad_signature"; reason: string };

/**
 * The transaction the wallet gave back, checked against the one that was built: the message unchanged byte for byte (fee
 * payer, instructions, accounts, blockhash), the owner's signature valid over it, and no other signature in it (the fee
 * payer's slot stays empty for the facilitator). Returns the owner's signature (base58) and the transaction to send on.
 * Nothing is sent here.
 */
export function checkSigned(signedBase64: string, built: Pick<BuiltPayment, "message" | "ownerIndex" | "signers"> & { owner: string }): SignedCheck {
  const parsed = /^[A-Za-z0-9+/]+={0,2}$/.test(signedBase64) ? parseTransaction(Buffer.from(signedBase64, "base64")) : undefined;
  if (!parsed) return { ok: false, code: "invalid_transaction", reason: "that is not a Solana transaction" };
  const expected = Buffer.from(built.message, "base64");
  if (!Buffer.from(parsed.message).equals(expected)) {
    return { ok: false, code: "transaction_changed", reason: "your wallet changed the transaction (its fee payer, instructions, accounts or blockhash)" };
  }
  if (parsed.signatures.length !== built.signers || built.ownerIndex < 1 || built.ownerIndex >= built.signers) {
    return { ok: false, code: "invalid_transaction", reason: "the transaction does not carry the signatures this payment needs" };
  }
  const signature = parsed.signatures[built.ownerIndex];
  if (!verifyEd25519(built.owner, expected, signature)) {
    return { ok: false, code: "bad_signature", reason: `that signature was not made by ${built.owner} over this payment` };
  }
  for (let i = 0; i < parsed.signatures.length; i += 1) {
    if (i !== built.ownerIndex && parsed.signatures[i].some((b) => b !== 0)) {
      return { ok: false, code: "transaction_changed", reason: "the transaction came back signed by another key as well" };
    }
  }
  return { ok: true, signature: base58Encode(signature), transaction: Buffer.from(serializeTransaction(parsed.signatures, expected)).toString("base64") };
}
