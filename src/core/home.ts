// Where the client keeps its state. One directory, SUPERSTABLES_HOME (default ~/.superstables):
//
//   policy.yaml            the owner's spend policy (optional; defaults apply). ~/.superstables/policy.yaml of the
//                          account itself applies as well when it exists, whichever home is in use
//   records/               quotes, attempts and receipts, append-only JSONL (the agent side)
//   browser-wallet.json    which browser account last connected, when one is used
//   approve-port           the port pay's approval page tries first, chosen once for this home
//   wallet/                the local wallet's own state: key, owner secret, agent token, audit log, and agent.sock,
//                          the socket the agent reaches it on
//
// The agent side reads wallet/agent-token and nothing else under wallet/. The owner secret
// and the key are the wallet process's alone; no code outside src/wallet opens them.
//
// Every folder the client writes here is checked first (ensureDir): see private-dir.mjs.

import { randomBytes, randomInt } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { ensurePrivateDir, syncDirectory } from "./private-dir.mjs";

/**
 * SUPERSTABLES_HOME as an agent's host may hand it over: possibly blank, possibly with a `~`,
 * `$HOME` or `${HOME}` nobody expanded (a JSON config file is not a shell, and not every host
 * substitutes variables in it). Blank means "the default"; those placeholders mean the user's
 * home directory.
 */
export function expandHome(value: string | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  // Any other unexpanded "${...}" (a variable the client does not substitute, or substitutes
  // only when it is set) is not a path either: it means "no setting", not a directory with that
  // name in whatever the working directory happens to be.
  if (/\$\{[^}]*\}/.test(raw.replace(/^\/?\$\{HOME\}/, ""))) return undefined;
  const home = homedir();
  const expanded = raw
    .replace(/^\/?\$\{HOME\}/, home)
    .replace(/^\/?\$HOME(?=\/|$)/, home)
    .replace(/^~(?=\/|$)/, home);
  return expanded;
}

export function homeDir(): string {
  return resolve(expandHome(process.env.SUPERSTABLES_HOME) ?? join(homedir(), ".superstables"));
}

export function recordsDir(): string {
  return join(homeDir(), "records");
}

export function walletDir(): string {
  return join(homeDir(), "wallet");
}

export function policyPath(): string {
  return process.env.SUPERSTABLES_POLICY ?? join(homeDir(), "policy.yaml");
}

/**
 * policy.yaml in the account's own ~/.superstables: the home directory the operating system records for this user, not
 * $HOME, SUPERSTABLES_HOME or SUPERSTABLES_POLICY, which whoever starts the process sets.
 */
export function accountPolicyPath(): string {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    home = homedir();
  }
  return join(home, ".superstables", "policy.yaml");
}

/** The wallet writes this; the agent side reads it. Bearer token for the agent-facing routes only. */
export function agentTokenPath(): string {
  return join(walletDir(), "agent-token");
}

export const DEFAULT_WALLET_PORT = 4411;
export const DEFAULT_DEMO_SERVICE_PORT = 4402;
/**
 * The approval page's port when no home is known (the SDK's default). The CLI tries the home's own port first (see
 * approvePort); either way, when another payment is already waiting on it, the page takes a free port instead.
 */
export const DEFAULT_APPROVE_PORT = 4412;

/** The range a home's approval port is chosen from: below every system's ephemeral ports, and clear of 4402, 4411 and 4412. */
const APPROVE_PORT_MIN = 20_000;
const APPROVE_PORT_SPAN = 10_000;

/**
 * The port pay's approval page tries first in this home: chosen at random in 20000-29999 on first use and kept in
 * `<home>/approve-port`, so a browser wallet's remembered connection to the page carries over from one payment to the
 * next, and another account on this machine cannot know it in advance and wait on it. The file is read only when it is
 * a regular file of this user's that no one else can read; one that others can read, or that holds no port, is replaced
 * with a fresh choice. A symlink, or a file of another user's, is refused (throws), and left as it is.
 */
export function approvePort(home: string = homeDir(), random: () => number = () => APPROVE_PORT_MIN + randomInt(APPROVE_PORT_SPAN)): number {
  ensurePrivateDir(home, { root: home });
  const path = join(home, "approve-port");
  for (let tries = 0; tries < 3; tries++) {
    let kept: number | undefined;
    try {
      kept = readApprovePort(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const port = random();
      try {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          writeFileSync(fd, `${port}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        syncDirectory(home);
        return port;
      } catch (createErr) {
        // another pay chose first: read its choice
        if ((createErr as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw createErr;
      }
    }
    if (kept !== undefined) return kept;
    // unreadable to us alone, or not a port: a fresh choice, written whole and renamed over it
    const port = random();
    const tmp = join(home, `.approve-port.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        writeFileSync(fd, `${port}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* never created */ }
      throw err;
    }
    syncDirectory(home);
    return port;
  }
  throw new Error(`${path} keeps changing; set SUPERSTABLES_APPROVE_PORT instead`);
}

/** The port in an approve-port file; undefined when the file must be replaced. Throws ENOENT when there is none. */
function readApprovePort(path: string): number | undefined {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symlink, not the file pay keeps its approval page's port in`);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${path} belongs to another user`);
    if ((st.mode & 0o077) !== 0) return undefined;
  }
  // the file checked is the file read: one open, with no link followed
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let text: string;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.size > 64) return undefined;
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const match = /^\s*(\d{1,5})\s*$/.exec(text);
  const port = match ? Number(match[1]) : NaN;
  return port >= 1024 && port <= 65_535 ? port : undefined;
}

/** The longest socket path every system the wallet runs on allows: macOS's sun_path is 104 bytes, with its NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The socket the agent reaches the local wallet on: `agent.sock` in the wallet's own folder, which only this user can
 * use. Undefined on Windows, where the wallet keeps to TCP. Throws when the path is too long for a socket.
 */
export function walletSocketPath(dir: string = walletDir()): string | undefined {
  if (process.platform === "win32") return undefined;
  const path = join(dir, "agent.sock");
  const length = Buffer.byteLength(path);
  if (length > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `the wallet's socket path is ${length} bytes, longer than this system allows (${MAX_SOCKET_PATH_BYTES + 1}); set a shorter SUPERSTABLES_HOME, or run the wallet with --tcp and set SUPERSTABLES_WALLET_URL for the agent`,
    );
  }
  return path;
}

/**
 * The approval port the owner chose with SUPERSTABLES_APPROVE_PORT, or undefined when they
 * chose none (or wrote something that is not a port). A chosen port is kept as chosen: when it
 * is busy the page says so instead of moving. 0 means any free port.
 */
export function approvePortFromEnvironment(): number | undefined {
  const raw = process.env.SUPERSTABLES_APPROVE_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
}

/**
 * Which account a browser wallet last connected with. Not a key and not a credential: only a
 * name, so `status` can say who would pay before a page has been opened.
 */
export function browserWalletPath(home: string = homeDir()): string {
  return join(home, "browser-wallet.json");
}

/** The approval server's audit log: one line per state change, never a signature. */
export function approvalsPath(dir: string = recordsDir()): string {
  return join(dir, "approvals.jsonl");
}

/**
 * The local wallet's TCP address: SUPERSTABLES_WALLET_URL, or the wallet's own port on 127.0.0.1. The agent uses it only
 * when SUPERSTABLES_WALLET_URL is set (see walletUrlFromEnvironment); otherwise it reaches the wallet on its private
 * socket (walletSocketPath), and this is where the owner's page is.
 */
export function walletUrl(): string {
  return walletUrlFromEnvironment() ?? `http://127.0.0.1:${DEFAULT_WALLET_PORT}`;
}

/** SUPERSTABLES_WALLET_URL, checked; undefined when it is not set. */
export function walletUrlFromEnvironment(): string | undefined {
  const raw = (process.env.SUPERSTABLES_WALLET_URL ?? "").trim();
  // Same caveat as SUPERSTABLES_HOME: an unexpanded "${...}" placeholder is not a URL.
  if (raw === "" || /\$\{[^}]*\}/.test(raw)) return undefined;
  const configured = raw.replace(/\/$/, "");
  // The client attaches the wallet's bearer token to whatever this names, and that token can read
  // every payment request the wallet has, including the signed authorization. So only loopback, or
  // https: an origin the operator did not choose must not be able to collect the credential.
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`SUPERSTABLES_WALLET_URL is not a URL (got "${raw}")`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      `SUPERSTABLES_WALLET_URL must be https, or plain http on 127.0.0.1 or localhost, because the client's wallet token is sent there (got "${raw}")`,
    );
  }
  return configured;
}

/**
 * Makes `path` a private folder (src/core/private-dir.mjs): the home and every folder from it down to `path` are real
 * folders owned by this user that no other user can write to; missing ones are created 0700. Throws a sentence naming
 * what is wrong otherwise.
 */
export function ensureDir(path: string): string {
  ensurePrivateDir(path, { root: homeDir() });
  return path;
}
