// The only file in the product that touches a private key. The key lives in one file,
// walletDir()/key, 0600, and it is decrypted by the wallet process alone: no agent, no CLI
// command other than `wallet init` and `wallet encrypt`, and nothing over HTTP ever sees it.
// By default the file holds the key encrypted with a passphrase the owner types at a terminal
// (scrypt, then AES-256-GCM), with the address in clear so the address can be shown without
// it. On a testnet, `--no-passphrase` keeps the key as a plain 0x-prefixed hex string.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ensureDir, walletDir } from "../core/home.js";
import { overwriteInPlace } from "../core/secret-overwrite.mjs";

/** Owner-only, like an SSH private key: anything laxer and the key is not really private. */
const SECRET_MODE = 0o600;

const ENVELOPE_TAG = "superstables-wallet-key";
/**
 * Format 1's key derivation, fixed: a file that asks for anything else is refused before scrypt runs, so a planted file
 * cannot make the wallet allocate gigabytes. N=2^17 needs 128 MiB, and Node needs maxmem above that, not equal to it.
 */
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** An encrypted wallet key, as stored in the key file (one JSON line). */
export interface KeyEnvelope {
  superstables: typeof ENVELOPE_TAG;
  v: 1;
  /** In clear, so `wallet address`, `setup` and `doctor` need no passphrase; it is bound in as associated data. */
  address: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ct: string;
}

export type ParsedKeyFile =
  | { kind: "plain"; key: `0x${string}`; address: string }
  | { kind: "encrypted"; envelope: KeyEnvelope };

/** The associated data: everything in the envelope but the cipher's own fields, so editing any of it breaks decryption. */
function associatedData(envelope: Pick<KeyEnvelope, "superstables" | "v" | "address" | "kdf">): Buffer {
  const { superstables, v, address, kdf } = envelope;
  // fixed field order, so a file whose keys were reordered still opens
  const { name, N, r, p, salt } = kdf;
  return Buffer.from(JSON.stringify({ superstables, v, address, kdf: { name, N, r, p, salt } }), "utf8");
}

/** Runs `use` with the key scrypt derives, and zeroes that buffer afterwards (the cipher keeps its own copy). */
function withDerivedKey<T>(passphrase: string, salt: Buffer, use: (key: Buffer) => T): T {
  const derived = scryptSync(passphrase.normalize("NFC"), salt, 32, SCRYPT);
  try {
    return use(derived);
  } finally {
    derived.fill(0);
  }
}

/** Encrypts a private key with a passphrase. Takes about half a second: scrypt is meant to be slow. */
export function encryptKey(privateKey: `0x${string}`, passphrase: string): KeyEnvelope {
  const key = normalizePrivateKey(privateKey);
  const address = privateKeyToAccount(key).address;
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const kdf = { name: "scrypt" as const, N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") };
  const head: Pick<KeyEnvelope, "superstables" | "v" | "address" | "kdf"> = { superstables: ENVELOPE_TAG, v: 1, address, kdf };
  const cipher = withDerivedKey(passphrase, salt, (derived) => createCipheriv("aes-256-gcm", derived, iv));
  cipher.setAAD(associatedData(head));
  const ct = Buffer.concat([cipher.update(Buffer.from(key.slice(2), "hex")), cipher.final()]);
  return { ...head, cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") }, ct: ct.toString("base64") };
}

const NOT_OURS = "the wallet key file is not a key file this client wrote";

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

function base64Of(value: unknown, bytes: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}

/** Checks an envelope exactly, the KDF parameters included, so nothing a file asks for reaches scrypt unchecked. */
function checkEnvelope(value: unknown): KeyEnvelope {
  if (!exactKeys(value, ["superstables", "v", "address", "kdf", "cipher", "ct"])) throw new Error(NOT_OURS);
  if (value.superstables !== ENVELOPE_TAG || value.v !== 1) throw new Error(`${NOT_OURS} (an unknown format version)`);
  if (typeof value.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.address)) throw new Error(`${NOT_OURS} (no address)`);
  const { kdf, cipher } = value;
  if (!exactKeys(kdf, ["name", "N", "r", "p", "salt"]) || kdf.name !== "scrypt") throw new Error(NOT_OURS);
  if (kdf.N !== SCRYPT.N || kdf.r !== SCRYPT.r || kdf.p !== SCRYPT.p) {
    throw new Error(`${NOT_OURS} (key derivation parameters this client does not use)`);
  }
  if (!base64Of(kdf.salt, SALT_BYTES)) throw new Error(NOT_OURS);
  if (!exactKeys(cipher, ["name", "iv", "tag"]) || cipher.name !== "aes-256-gcm") throw new Error(NOT_OURS);
  if (!base64Of(cipher.iv, IV_BYTES) || !base64Of(cipher.tag, TAG_BYTES) || !base64Of(value.ct, KEY_BYTES)) throw new Error(NOT_OURS);
  return value as unknown as KeyEnvelope;
}

/** Decrypts an envelope. A wrong passphrase and an edited file are the same failure: the cipher's tag does not match. */
export function decryptKey(envelope: KeyEnvelope, passphrase: string): `0x${string}` {
  const checked = checkEnvelope(envelope);
  const decipher = withDerivedKey(passphrase, Buffer.from(checked.kdf.salt, "base64"), (derived) =>
    createDecipheriv("aes-256-gcm", derived, Buffer.from(checked.cipher.iv, "base64")),
  );
  decipher.setAAD(associatedData(checked));
  decipher.setAuthTag(Buffer.from(checked.cipher.tag, "base64"));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(checked.ct, "base64")), decipher.final()]);
  } catch {
    throw new Error("the passphrase is not right");
  }
  const key = `0x${plain.toString("hex")}` as const;
  plain.fill(0);
  if (privateKeyToAccount(key).address !== checked.address) throw new Error(`${NOT_OURS} (its address is not its key's)`);
  return key;
}

/** A key file's contents: an envelope (trimmed text starting with "{"), or a plain hex key as before. */
export function parseKeyFile(text: string): ParsedKeyFile {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(NOT_OURS);
    }
    return { kind: "encrypted", envelope: checkEnvelope(value) };
  }
  const key = normalizePrivateKey(trimmed);
  return { kind: "plain", key, address: privateKeyToAccount(key).address };
}

/** Reads and parses the key file through the checked reader; a missing one says how to make it. */
function readKeyFile(dir: string): ParsedKeyFile {
  const path = keyPath(dir);
  let contents: string;
  try {
    contents = readSecretFile(path, "the wallet key");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("no wallet key yet: run `superstables wallet init`");
    }
    throw err;
  }
  try {
    return parseKeyFile(contents);
  } catch (err) {
    const leftover = leftoverKeyFile(dir);
    if (leftover) throw new Error(`${(err as Error).message}\n${leftoverHint(leftover, dir)}`);
    throw err;
  }
}

/** What to do about a temporary key file a stopped `wallet init --force` or `wallet encrypt` left behind. */
export function leftoverHint(leftover: string, dir: string = walletDir()): string {
  return (
    `${leftover} is a key file a stopped \`wallet init --force\` or \`wallet encrypt\` left behind; ` +
    `if the key file is all zeros, finish by renaming it: mv ${leftover} ${keyPath(dir)}`
  );
}

/** The wallet's address, from the key file, encrypted or not. Needs no passphrase. */
export function keyFileAddress(dir: string = walletDir()): string {
  const parsed = readKeyFile(dir);
  return parsed.kind === "plain" ? parsed.address : parsed.envelope.address;
}

/** How the key is stored, for `doctor`. Reads the file only as far as telling an envelope from a plain key. */
export function keyStorage(dir: string = walletDir()): "encrypted" | "plaintext" | "absent" {
  if (!keyExists(dir)) return "absent";
  return readKeyFile(dir).kind === "encrypted" ? "encrypted" : "plaintext";
}

export function keyPath(dir: string = walletDir()): string {
  return join(dir, "key");
}

export function keyExists(dir: string = walletDir()): boolean {
  return existsSync(keyPath(dir));
}

export interface InitKeyOptions {
  /** Where the key file lives. Defaults to walletDir(). */
  dir?: string;
  /** Use this key instead of generating one. With or without the 0x prefix. */
  importKey?: string;
  /** Replace an existing key. The old key, and anything it holds, becomes unreachable. */
  force?: boolean;
  /** Encrypt the key with this passphrase. Absent: a plain key file (`--no-passphrase`, and tests). */
  passphrase?: string;
}

export interface InitKeyResult {
  address: string;
  /** True when a fresh key was generated, false when an existing key was imported. */
  created: boolean;
  /** True when the file holds the key encrypted with the passphrase. */
  encrypted: boolean;
  /** True when an old key file was there and its bytes were overwritten in place before it was replaced. */
  overwritten: boolean;
  /** Why the old key was not overwritten, when one was there and was not (a symlink, say): for the owner to read. */
  notOverwritten?: string;
}

function normalizePrivateKey(input: string): `0x${string}` {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("that is not a private key: expected 64 hexadecimal characters, optionally prefixed with 0x");
  }
  return `0x${hex.toLowerCase()}`;
}

/** Overwrites the old key file in place and says how it went; for a file that is not ours to zero, why not. */
function overwriteOldKey(path: string): { overwritten: boolean; notOverwritten?: string } {
  let link: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
  } catch { /* nothing there */ }
  let status: string;
  try {
    status = overwriteInPlace(path);
  } catch (err) {
    status = `failed: ${(err as Error).message}`;
  }
  if (status === "overwritten") return { overwritten: true };
  if (status === "absent") return { overwritten: false };
  if (link !== undefined) {
    return { overwritten: false, notOverwritten: `${path} was a symbolic link to ${link}; that file still holds the old key: delete it` };
  }
  return { overwritten: false, notOverwritten: `${path}: ${status}; the old key's bytes are still on disk` };
}

/**
 * Writes a file only the owner can read. Never into an existing file: `--force` replaces a key file whose mode may be
 * anything (one restored from a backup, say), and writing into it would put the new key, for a moment, in a file other
 * users can read. The contents go to a new file in the same directory, created exclusively with mode 0600 and flushed to
 * disk, which is then renamed over the old one: a crash leaves the old file or the new one, never a truncated one.
 */
export function writeSecretFile(
  path: string,
  contents: string,
  io: { writeSync?: typeof writeSync; /** Runs once the new file is complete on disk, just before the rename. */ beforeRename?: () => void } = {},
): void {
  const dir = ensureDir(dirname(path));
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, SECRET_MODE);
    writeAllSync(fd, contents, io.writeSync);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (err) {
    // the original file is untouched: only the temporary file was written
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  // The new file is complete and flushed. From here the hook may have zeroed the old file, so the temporary file is the
  // only copy of the key and must never be removed: the rename always happens, and the hook must not throw.
  try {
    io.beforeRename?.();
  } catch { /* a hook reports its own failures */ }
  try {
    renameSync(tmp, path);
  } catch (err) {
    if (!io.beforeRename) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
    throw err;
  }
  fsyncDir(dir);
}

/**
 * Writes all of `data` to `fd`. writeSync may write fewer bytes than asked (a full disk, a file-size limit); a key file
 * cut short is worse than none, so keep writing, and throw when no progress is made.
 */
export function writeAllSync(fd: number, data: string, write: typeof writeSync = writeSync): void {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes written`);
    off += n;
  }
}

/** After a rename, flush the directory so the new name survives a crash. Best effort: not every platform can. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory this way, and some filesystems refuse fsync on one; the rename has happened.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* nothing to do */ }
    }
  }
}

/** A key file is one line. Anything larger is not one. */
const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * Reads a secret file, checking the file it opened rather than the path: it must be a regular file (a FIFO would block,
 * a device is not a key), readable by this user only, and small. The path may be a symlink: the checks apply to the
 * file it leads to, and swapping the link between a check and the read cannot change which file was checked, because
 * there is one open and the checks are on it.
 */
export function readSecretFile(path: string, what: string): string {
  // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer forever. It changes nothing for a file.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${what} at ${path} is not a regular file`);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`${what} at ${path} can be read by other users on this machine: chmod 600 ${path}`);
    }
    if (st.size > MAX_SECRET_FILE_BYTES) throw new Error(`${what} at ${path} is larger than a key file (${st.size} bytes)`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Throws when a key is there already: the check `initKey` makes, for a caller that asks a passphrase first. */
export function refuseExistingKey(dir: string = walletDir()): void {
  const path = keyPath(dir);
  if (existsSync(path)) {
    throw new Error(`a wallet key already exists at ${path}; delete it, or pass --force to replace it (the old key cannot be recovered)`);
  }
}

/**
 * Creates the wallet's key, or imports one. Refuses to overwrite a key that already exists
 * unless `force` is set: losing a key silently is the one failure this file must not have.
 */
export function initKey(options: InitKeyOptions = {}): InitKeyResult {
  const dir = options.dir ?? walletDir();
  const path = keyPath(dir);
  if (!options.force) refuseExistingKey(dir);
  const key = options.importKey ? normalizePrivateKey(options.importKey) : generatePrivateKey();
  const encrypted = options.passphrase !== undefined;
  const contents = encrypted ? `${JSON.stringify(encryptKey(key, options.passphrase!))}\n` : `${key}\n`;
  let old: { overwritten: boolean; notOverwritten?: string } = { overwritten: false };
  // With --force, the old key's bytes are zeroed once the new key is safely on disk, and only then is it replaced.
  const beforeRename = options.force ? () => void (old = overwriteOldKey(path)) : undefined;
  writeSecretFile(path, contents, { beforeRename });
  const result: InitKeyResult = { address: privateKeyToAccount(key).address, created: !options.importKey, encrypted, overwritten: old.overwritten };
  if (old.notOverwritten) result.notOverwritten = old.notOverwritten;
  return result;
}

/**
 * Encrypts an existing plain key file with a passphrase, in place: the encrypted copy is written and flushed first, then
 * the plain file's bytes are overwritten, then the copy is renamed over it. A crash between the last two steps leaves a
 * zeroed key file next to a complete `.key.*.tmp` that holds the encrypted key.
 */
export function encryptKeyFile(dir: string = walletDir(), passphrase: string): { address: string; overwritten: boolean; notOverwritten?: string } {
  const parsed = readKeyFile(dir);
  if (parsed.kind === "encrypted") throw new Error(`the wallet key at ${keyPath(dir)} is already encrypted`);
  const contents = `${JSON.stringify(encryptKey(parsed.key, passphrase))}\n`;
  const path = keyPath(dir);
  let old: { overwritten: boolean; notOverwritten?: string } = { overwritten: false };
  writeSecretFile(path, contents, { beforeRename: () => void (old = overwriteOldKey(path)) });
  return { address: parsed.address, ...old };
}

/** A temporary key file a crash between the overwrite and the rename left behind, if any. */
export function leftoverKeyFile(dir: string = walletDir()): string | undefined {
  try {
    const name = readdirSync(dir).find((entry) => /^\.key\.\d+\.[0-9a-f]+\.tmp$/.test(entry));
    return name === undefined ? undefined : join(dir, name);
  } catch {
    return undefined;
  }
}

/**
 * The wallet's account. Throws a sentence the user can act on when there is no key yet, and refuses a key file other
 * users on this machine can read. The mode is set when the key is written, but that is a fact about that moment: a `cp`
 * without -p, a restore from a backup, an editor that rewrites the file, or a different umask can leave it group- or
 * world-readable, and every later signature would then be made with a key anyone on the box can take. Say so and stop
 * rather than quietly re-tightening it, so a copied key file is visible instead of silent.
 */
export function loadAccount(dir: string = walletDir(), passphrase?: string): PrivateKeyAccount {
  const parsed = readKeyFile(dir);
  if (parsed.kind === "plain") return privateKeyToAccount(parsed.key);
  if (passphrase === undefined) {
    throw new Error("the wallet key is encrypted: start `superstables wallet serve` in a terminal to enter its passphrase");
  }
  return privateKeyToAccount(decryptKey(parsed.envelope, passphrase));
}

/**
 * Reads a 32-byte secret from a file, or creates one. Used for the wallet's two bearer
 * credentials: they must survive a restart, so the agent's token and the owner's approval
 * URL keep working, and they must never be readable by another user on the machine.
 */
export function readOrCreateSecret(path: string): string {
  // Through the checked reader, like the key: a FIFO here would hang the wallet, and a file other users can read is a
  // credential they may already have, so it is refused rather than quietly tightened.
  try {
    const existing = readSecretFile(path, "a wallet secret").trim();
    if (existing.length > 0) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const secret = randomBytes(32).toString("hex");
  writeSecretFile(path, `${secret}\n`);
  return secret;
}
