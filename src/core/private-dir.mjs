// Private folders: the client's home folder and the folders under it that hold payment records and the local wallet's
// files. One rule for both builds. A private folder is a real folder owned by this user that no other user can write to;
// missing ones are created 0700. A folder under the root that others can read but not write is set back to 0700: nothing in
// it can have been changed by them. One they can write to is refused: someone else may have put files in it, so the owner
// should look first. The root (the client's home) may be a symlink to a folder that meets the rule, and its read bits are
// left as they are: it may be a folder the owner chose.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const UNSAFE_PRIVATE_DIR = "UNSAFE_PRIVATE_DIR";

function levels(path, root) {
  const target = resolve(path);
  if (root === undefined) return [{ dir: target, root: false }];
  const top = resolve(root);
  const rel = relative(top, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return [{ dir: target, root: false }];
  const out = [{ dir: top, root: true }];
  let at = top;
  for (const part of rel.split(sep).filter(Boolean)) {
    at = join(at, part);
    out.push({ dir: at, root: false });
  }
  return out;
}

function problemOf(dir, st) {
  if (st.isSymbolicLink()) return `${dir} is a symlink, not a folder`;
  if (!st.isDirectory()) return `${dir} is not a folder`;
  if (process.platform === "win32") return undefined;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${dir} belongs to another user`;
  if ((st.mode & 0o022) !== 0) return `other users can write to ${dir} (mode ${(st.mode & 0o777).toString(8)}): check what is in it, then chmod 700 ${dir}`;
  return undefined;
}

/**
 * Makes every folder from options.root down to `path` private, creating missing ones 0700. Without a root, or for a path
 * outside it, only `path` (checked as a folder under a root: not a symlink). Throws an Error with code UNSAFE_PRIVATE_DIR
 * naming the first folder that is not private; nothing below it is created. Returns the folders it created, top down.
 *
 * @param {string} path
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function ensurePrivateDir(path, options = {}) {
  const created = [];
  for (const { dir, root } of levels(path, options.root)) {
    const look = () => (root ? statSync(dir) : lstatSync(dir));
    let st;
    try {
      st = look();
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(dir, 0o700); // a umask may have taken more than it should
      created.push(dir);
      st = look();
    }
    const problem = problemOf(dir, st);
    if (problem) throw Object.assign(new Error(problem), { code: UNSAFE_PRIVATE_DIR });
    if (!root && process.platform !== "win32" && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  }
  return created;
}

/**
 * What ensurePrivateDir would refuse, without creating or changing anything; undefined when nothing (or it is missing).
 *
 * @param {string} path
 * @param {{ root?: string }} [options]
 * @returns {string | undefined}
 */
export function privateDirProblem(path, options = {}) {
  for (const { dir, root } of levels(path, options.root)) {
    let st;
    try {
      st = root ? statSync(dir) : lstatSync(dir);
    } catch (err) {
      return err?.code === "ENOENT" ? undefined : `${dir} could not be read (${err?.code ?? err?.message})`;
    }
    const problem = problemOf(dir, st);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * Flushes a folder so a new name in it survives a crash. Skipped where the platform or filesystem cannot.
 *
 * @param {string} dir
 */
export function syncDirectory(dir) {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (err) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EISDIR"].includes(err?.code)) throw err;
  } finally {
    closeSync(fd);
  }
}
