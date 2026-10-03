// Reading and rewriting the files that hold a private key: each rail's agent key file, and an owner key file named with
// --owner-key-file. Plain JavaScript so the .mjs and the .ts rail code can both import it.
//
// Reading opens the file once and checks what it opened, not the path: a regular file (not a FIFO, which would block, or a
// device), readable by this user only, and small. The path may be a symlink; the checks apply to the file it leads to,
// and a swap of the link between the check and the read cannot change which file was checked.
//
// Rewriting never writes into the existing file. The new contents go to a new file in the same directory, created
// exclusively with mode 600 and flushed to disk, which is then renamed over the old one: a crash leaves the old file or
// the new one, never a truncated one, and the new key is never in a file other users can read, whatever the old file's
// mode was.
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

/** A key file is a few lines. Anything larger is not one. */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** The `code` of the Error readSecretFile throws for a file that must not be used. */
export const UNSAFE_SECRET_FILE = "UNSAFE_SECRET_FILE";

function unsafe(message) {
  return Object.assign(new Error(message), { code: UNSAFE_SECRET_FILE });
}

function readChecked(path, what, secret) {
  // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer forever. It changes nothing for a regular file.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw unsafe(`${what} ${path} is not a regular file`);
    if (secret && (st.mode & 0o077) !== 0) throw unsafe(`${what} ${path} can be read by other users on this machine: chmod 600 ${path}`);
    if (st.size > MAX_SECRET_FILE_BYTES) throw unsafe(`${what} ${path} is larger than a key file (${st.size} bytes)`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The text of a secret file. Throws an Error with code UNSAFE_SECRET_FILE naming what is wrong with a file that must not
 * be used; an error opening it (ENOENT, EACCES) passes through unchanged.
 * @param {string} path
 * @param {string} what
 * @returns {string}
 */
export function readSecretFile(path, what) {
  return readChecked(path, what, true);
}

/**
 * The text of a key or state file for a command that only looks at it (doctor, status): the same single open, regular
 * file and size checks as readSecretFile, but any mode, so the caller can report a mode that is wrong. Throws an Error
 * with code UNSAFE_SECRET_FILE for a FIFO, a device, a directory or an oversized file.
 * @param {string} path
 * @param {string} what
 * @returns {string}
 */
export function readRegularFile(path, what) {
  return readChecked(path, what, false);
}

/**
 * Writes all of `data` to `fd`. writeSync may write fewer bytes than asked (a full disk, a file-size limit); a key file
 * cut short is worse than none, so keep writing, and throw when no progress is made.
 * @param {number} fd
 * @param {string} data
 * @param {typeof writeSync} [write]
 */
export function writeAllSync(fd, data, write = writeSync) {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = write(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes written`);
    off += n;
  }
}

/** After a rename, flush the directory so the new name survives a crash. Best effort: not every platform can. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Windows cannot open a directory this way, and some filesystems refuse fsync on one; the rename itself has happened.
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/**
 * Replace (or create) a secret file with `text`, mode 600, atomically. See the top of this file. On any error the
 * temporary file is removed and the original is left as it was. `io.writeSync` is for tests.
 * @param {string} path
 * @param {string} text
 * @param {{ writeSync?: typeof writeSync }} [io]
 */
export function replaceSecretFile(path, text, io = {}) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeAllSync(fd, text, io.writeSync);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  fsyncDir(dir);
}
