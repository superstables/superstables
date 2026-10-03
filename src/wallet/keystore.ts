// The only file in the product that touches a private key. The key lives in one file,
// walletDir()/key, 0600, a 0x-prefixed hex string, and it is read by the wallet process
// alone: no agent, no CLI command other than `wallet init`, and nothing over HTTP ever
// sees it. Keeping it in a file (rather than a keychain or an encrypted store) is a
// deliberate choice for a testnet release: it is easy to inspect, easy to delete, and it
// holds test funds only.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ensureDir, walletDir } from "../core/home.js";

/** Owner-only, like an SSH private key: anything laxer and the key is not really private. */
const SECRET_MODE = 0o600;

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
}

export interface InitKeyResult {
  address: string;
  /** True when a fresh key was generated, false when an existing key was imported. */
  created: boolean;
}

function normalizePrivateKey(input: string): `0x${string}` {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("that is not a private key: expected 64 hexadecimal characters, optionally prefixed with 0x");
  }
  return `0x${hex.toLowerCase()}`;
}

/**
 * Writes a file only the owner can read. Never into an existing file: `--force` replaces a key file whose mode may be
 * anything (one restored from a backup, say), and writing into it would put the new key, for a moment, in a file other
 * users can read. The contents go to a new file in the same directory, created exclusively with mode 0600 and flushed to
 * disk, which is then renamed over the old one: a crash leaves the old file or the new one, never a truncated one.
 */
export function writeSecretFile(path: string, contents: string, io: { writeSync?: typeof writeSync } = {}): void {
  const dir = ensureDir(dirname(path));
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, SECRET_MODE);
    writeAllSync(fd, contents, io.writeSync);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    // the original file is untouched: only the temporary file was written
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already failing */ }
    }
    try { unlinkSync(tmp); } catch { /* never created */ }
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

/**
 * Creates the wallet's key, or imports one. Refuses to overwrite a key that already exists
 * unless `force` is set: losing a key silently is the one failure this file must not have.
 */
export function initKey(options: InitKeyOptions = {}): InitKeyResult {
  const dir = options.dir ?? walletDir();
  const path = keyPath(dir);
  if (existsSync(path) && !options.force) {
    throw new Error(`a wallet key already exists at ${path}; delete it, or pass --force to replace it (the old key cannot be recovered)`);
  }
  const key = options.importKey ? normalizePrivateKey(options.importKey) : generatePrivateKey();
  writeSecretFile(path, `${key}\n`);
  return { address: privateKeyToAccount(key).address, created: !options.importKey };
}

/**
 * The wallet's account. Throws a sentence the user can act on when there is no key yet, and refuses a key file other
 * users on this machine can read. The mode is set when the key is written, but that is a fact about that moment: a `cp`
 * without -p, a restore from a backup, an editor that rewrites the file, or a different umask can leave it group- or
 * world-readable, and every later signature would then be made with a key anyone on the box can take. Say so and stop
 * rather than quietly re-tightening it, so a copied key file is visible instead of silent.
 */
export function loadAccount(dir: string = walletDir()): PrivateKeyAccount {
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
  return privateKeyToAccount(normalizePrivateKey(contents));
}

/**
 * Reads a 32-byte secret from a file, or creates one. Used for the wallet's two bearer
 * credentials: they must survive a restart, so the agent's token and the owner's approval
 * URL keep working, and they must never be readable by another user on the machine.
 */
export function readOrCreateSecret(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) {
      // An older file may predate the 0600 convention, or have been copied with a laxer mask.
      if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, SECRET_MODE);
      return existing;
    }
  }
  const secret = randomBytes(32).toString("hex");
  writeSecretFile(path, `${secret}\n`);
  return secret;
}
