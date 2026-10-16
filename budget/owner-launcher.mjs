// Opens a budget owner approval link in the browser without putting it on a command line. The link is a capability
// (http://127.0.0.1:P/owner/<id>, or the hosted https://…/approve/budget/<id>#<token>): in the arguments of xdg-open, open
// or cmd /c start, every user on this machine could read it with ps while the opener ran. So the browser is given only the
// path of a small launcher file, mode 0600 in a folder only this user can use, which sends it on to the link with
// location.replace (no history entry, and no Referer from a file: page; the file also says no-referrer).
//
// The folder, ~/Superstables-budget-open, is not hidden on purpose: a Snap browser cannot read hidden folders in the home
// folder, in /tmp or in $XDG_RUNTIME_DIR. It exists only while a launcher is in it. The form is the local wallet's launcher
// (src/wallet/daemon.ts, writeOwnerLauncher), copied rather than imported: src/wallet/ is the wallet's own code.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir } from "./paths.mjs";
import { writeAllSync } from "./secret-file.mjs";

/** ~/Superstables-budget-open: not hidden (a Snap browser cannot read hidden folders), exists only while a launcher is in it. */
export const launcherDir = () => join(homedir(), "Superstables-budget-open");
/** link-<pid of the command that wrote it>-<random>.html */
const LAUNCHER_NAME = /^link-(\d+)-[0-9a-f]+\.html$/;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
};
const removeEmpty = (dir) => {
  try {
    rmdirSync(dir);
  } catch {
    // not empty, or gone
  }
};

/**
 * Writes a 0600 file in `dir` (made private first) that sends the browser to `url`. Launchers of dead commands are removed
 * first. Throws when the folder is not private or the file cannot be written in full; no file is left behind then.
 *
 * @param {string} dir
 * @param {string} url
 * @param {{ fsyncSync?: typeof fsyncSync }} [io]
 */
export function writeLauncher(dir, url, io = {}) {
  ensurePrivateDir(dir);
  for (const name of readdirSync(dir)) {
    const m = LAUNCHER_NAME.exec(name);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // gone already
      }
    }
  }
  const path = join(dir, `link-${process.pid}-${randomBytes(16).toString("hex")}.html`);
  // JSON is a valid JavaScript string literal; "<" is escaped so the value cannot close the script element
  const target = JSON.stringify(url).replace(/</g, "\\u003c");
  const html = `<!doctype html>\n<meta charset="utf-8">\n<meta name="referrer" content="no-referrer">\n<title>Superstables approval</title>\n<p>Opening the approval page&hellip;</p>\n<script>location.replace(${target});</script>\n`;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeAllSync(fd, html);
    (io.fsyncSync ?? fsyncSync)(fd);
  } catch (err) {
    // a file that holds the link is never left behind, written in full or not
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // gone already
    }
    removeEmpty(dir);
    throw err;
  }
  closeSync(fd);
  return path;
}

/**
 * Deletes a launcher, then its folder once empty. False when the file is still there.
 *
 * @param {string} path
 * @param {string} [dir]
 */
export function removeLauncher(path, dir = launcherDir()) {
  try {
    unlinkSync(path);
  } catch (err) {
    if (err?.code !== "ENOENT") return false;
  }
  removeEmpty(dir);
  return true;
}

/**
 * Best effort, and only that: a browser that will not open is not a failure. Given a file path, never a link.
 *
 * @param {string} path
 */
export function openFile(path) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [path]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no opener on this machine
  }
}

/**
 * Opens `url` in the browser through a launcher file. Returns { path } when it was opened, or { problem } when no launcher
 * could be written. Then nothing is opened: the link itself never goes to the opener.
 *
 * @param {string} url
 * @param {{ dir?: string, opener?: (path: string) => void, io?: { fsyncSync?: typeof fsyncSync } }} [options]
 * @returns {{ path: string } | { problem: string }}
 */
export function openLink(url, { dir = launcherDir(), opener = openFile, io } = {}) {
  let path;
  try {
    path = writeLauncher(dir, url, io);
  } catch (err) {
    return { problem: err.message };
  }
  opener(path);
  return { path };
}
