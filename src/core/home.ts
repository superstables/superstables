// Where the client keeps its state. One directory, SUPERSTABLES_HOME (default ~/.superstables):
//
//   policy.yaml            the owner's spend policy (optional; defaults apply)
//   records/               quotes, attempts and receipts, append-only JSONL (the agent side)
//   browser-wallet.json    which browser account last connected, when one is used
//   wallet/                the local wallet's own state: key, owner secret, agent token, audit log
//
// The agent side reads wallet/agent-token and nothing else under wallet/. The owner secret
// and the key are the wallet process's alone; no code outside src/wallet opens them.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * SUPERSTABLES_HOME as an MCP client may hand it over: possibly blank, possibly with a `~`,
 * `$HOME` or `${HOME}` nobody expanded (a JSON config file is not a shell, and not every client
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

/** The wallet writes this; the agent side reads it. Bearer token for the agent-facing routes only. */
export function agentTokenPath(): string {
  return join(walletDir(), "agent-token");
}

export const DEFAULT_WALLET_PORT = 4411;
export const DEFAULT_DEMO_SERVICE_PORT = 4402;
/**
 * Where the agent's own process serves the browser-wallet approval page, when it is free. When
 * another payment is already waiting on it, the page takes a free port instead.
 */
export const DEFAULT_APPROVE_PORT = 4412;

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

export function walletUrl(): string {
  const raw = (process.env.SUPERSTABLES_WALLET_URL ?? "").trim();
  // Same caveat as SUPERSTABLES_HOME: an unexpanded "${...}" placeholder is not a URL.
  const configured = raw !== "" && !/\$\{[^}]*\}/.test(raw) ? raw : `http://127.0.0.1:${DEFAULT_WALLET_PORT}`;
  return configured.replace(/\/$/, "");
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
