// The few SPL Token calls the solana rail makes, built directly on @solana/web3.js (no
// @solana/spl-token). Classic Token program only: devnet USDC is a classic SPL token.
//
// Layouts and instruction encodings follow the SPL Token program
// (https://github.com/solana-program/token): a token account is 165 bytes, a mint 82 bytes,
// integers little-endian.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const ACCOUNT_SIZE = 165;
const MINT_SIZE = 82;
const ACCOUNT_STATE = { UNINITIALIZED: 0, INITIALIZED: 1, FROZEN: 2 };
const IX = { REVOKE: 5, TRANSFER_CHECKED: 12, APPROVE_CHECKED: 13 };
const ATA_CREATE_IDEMPOTENT = 1;

export class TokenAccountNotFoundError extends Error {
  constructor() {
    super("token account not found");
    this.name = "TokenAccountNotFoundError";
  }
}

// Associated token address of `owner` for `mint`. Refuses an owner off the ed25519 curve (a
// program address), as spl-token does by default.
export function getAssociatedTokenAddressSync(mint, owner) {
  if (!PublicKey.isOnCurve(owner.toBuffer())) throw new Error(`token owner ${owner.toBase58()} is off curve (a program address)`);
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

async function readTokenProgramAccount(conn, address, minSize, what) {
  const info = await conn.getAccountInfo(address);
  if (!info) throw new TokenAccountNotFoundError();
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) throw new Error(`${what} ${address.toBase58()} is not owned by the SPL Token program`);
  if (info.data.length < minSize) throw new Error(`${what} ${address.toBase58()} has ${info.data.length} bytes, expected ${minSize}`);
  return Buffer.from(info.data);
}

// Same fields as spl-token's getAccount for the classic program.
export async function getAccount(conn, address) {
  const d = await readTokenProgramAccount(conn, address, ACCOUNT_SIZE, "token account");
  const state = d.readUInt8(108);
  return {
    address,
    mint: new PublicKey(d.subarray(0, 32)),
    owner: new PublicKey(d.subarray(32, 64)),
    amount: d.readBigUInt64LE(64),
    delegate: d.readUInt32LE(72) ? new PublicKey(d.subarray(76, 108)) : null,
    delegatedAmount: d.readBigUInt64LE(121),
    isInitialized: state !== ACCOUNT_STATE.UNINITIALIZED,
    isFrozen: state === ACCOUNT_STATE.FROZEN,
    closeAuthority: d.readUInt32LE(129) ? new PublicKey(d.subarray(133, 165)) : null,
  };
}

export async function getMint(conn, address) {
  const d = await readTokenProgramAccount(conn, address, MINT_SIZE, "mint");
  return { address, supply: d.readBigUInt64LE(36), decimals: d.readUInt8(44), isInitialized: d.readUInt8(45) !== 0 };
}

function amountData(tag, amount, decimals) {
  const data = Buffer.alloc(decimals === undefined ? 9 : 10);
  data.writeUInt8(tag, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  if (decimals !== undefined) data.writeUInt8(decimals, 9);
  return data;
}

export function createTransferCheckedInstruction(source, mint, destination, authority, amount, decimals) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: amountData(IX.TRANSFER_CHECKED, amount, decimals),
  });
}

export function createApproveCheckedInstruction(account, mint, delegate, owner, amount, decimals) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: amountData(IX.APPROVE_CHECKED, amount, decimals),
  });
}

export function createRevokeInstruction(account, owner) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([IX.REVOKE]),
  });
}

export function createAssociatedTokenAccountIdempotentInstruction(payer, associatedToken, owner, mint) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_CREATE_IDEMPOTENT]),
  });
}
