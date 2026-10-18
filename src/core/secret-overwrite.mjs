// Overwriting a secret before it is replaced. A rename over a key file drops its name, not its bytes: the old key stays in
// the disk's free blocks, and in full under any other name the file has (a hard link, a backup tool's copy by inode).
// Plain JavaScript, so the budget programs can use it too.
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";

/**
 * Overwrites a file's bytes in place with zeros, then flushes, before the caller replaces or removes it. Only a regular
 * file owned by this user, opened without following a symlink; anything else is left alone and reported. A read-only
 * file of ours is made writable first (the checks are on the open file, not the path). It never throws: the caller is
 * about to replace the file, and a failure here must not stop that. It does not erase copies a copy-on-write or
 * journalling file system, or flash storage, keeps elsewhere.
 *
 * @param {string} path
 * @returns {"overwritten" | "not a regular file" | "not writable" | "absent" | `failed: ${string}`}
 */
export function overwriteInPlace(path) {
  const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const ours = (st) => typeof process.getuid !== "function" || st.uid === process.getuid();
  let fd;
  try {
    try {
      // O_NOFOLLOW: a symlink at the key's name is not the key, and whatever it points to is not ours to zero.
      fd = openSync(path, constants.O_WRONLY | noFollow);
    } catch (err) {
      const code = err && err.code;
      if (code === "ENOENT") return "absent";
      if (code === "ELOOP" || code === "EISDIR" || code === "ENXIO") return "not a regular file";
      if (code !== "EACCES" && code !== "EPERM") throw err;
      // A read-only key (chmod 400, as for an SSH key). Check the file we opened, make it ours to write, then reopen
      // and make sure it is the same file before writing.
      let rd;
      try {
        rd = openSync(path, constants.O_RDONLY | noFollow);
      } catch (e2) {
        const c2 = e2 && e2.code;
        if (c2 === "ELOOP" || c2 === "EISDIR" || c2 === "ENXIO") return "not a regular file";
        if (c2 === "EACCES" || c2 === "EPERM") return "not writable";
        throw e2;
      }
      let first;
      try {
        first = fstatSync(rd);
        if (!first.isFile() || !ours(first)) return first.isFile() ? "not writable" : "not a regular file";
        fchmodSync(rd, 0o600);
      } finally {
        closeSync(rd);
      }
      fd = openSync(path, constants.O_WRONLY | noFollow);
      const again = fstatSync(fd);
      if (again.dev !== first.dev || again.ino !== first.ino) return "not a regular file";
    }
    const st = fstatSync(fd);
    if (!st.isFile()) return "not a regular file";
    if (!ours(st)) return "not writable";
    const zeros = Buffer.alloc(Math.min(st.size, 64 * 1024));
    let off = 0;
    while (off < st.size) {
      const n = writeSync(fd, zeros, 0, Math.min(zeros.length, st.size - off), off);
      if (!(n > 0)) return `failed: short write, ${off} of ${st.size} bytes overwritten`;
      off += n;
    }
    fsyncSync(fd);
    return "overwritten";
  } catch (err) {
    return `failed: ${err && err.message ? err.message : String(err)}`;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already reporting */
      }
    }
  }
}
