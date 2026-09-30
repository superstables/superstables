// The owner's page, shared by every rail. An owner command builds the transaction and the terms, opens the owner page on
// 127.0.0.1 (the client's OwnerApprovalServer, src/core/signer/owner-approval-server.ts), prints the link and waits. The page
// asks the owner's own wallet to approve exactly that transaction. The command then reads the chain itself: the hash the page
// reports is only a pointer. The agent's machine never holds the owner key.
//
// The link is printed as one stdout line `APPROVE {"action","url","expires","terms"}` (cli.mjs passes it on) and as a sentence
// on stderr. The default browser opens it too, unless --no-open. --timeout <seconds> sets how long the link stays open
// (default 600). Each rail binds these helpers to its chain with ownerPageFor (evm/owner.ts, tempo/owner.ts, solana/owner.ts).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import {
  OwnerApprovalServer,
  type OwnerActionHandle,
  type OwnerActionOutcome,
  type OwnerChain,
  type OwnerTerms,
  type SolanaTransactionPort,
} from "../src/core/signer/owner-approval-server.ts";
import { ownerApprovalsLog } from "./paths.mjs";

const argv = process.argv.slice(2);
const argValue = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function timeoutMs(): number {
  const raw = argValue("timeout") ?? "600";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 3600) {
    process.stderr.write(`error: --timeout must be a whole number of seconds from 1 to 3600 (got "${raw}")\n`);
    process.exit(2);
  }
  return Number(raw) * 1000;
}
/** How long a link stays open (--timeout, seconds; default 600). */
export const OWNER_TIMEOUT_MS = timeoutMs();
/** The owner key file given with --owner-key-file, or undefined (the default: the owner approves in their wallet). */
export const OWNER_KEY_FILE: string | undefined = argValue("owner-key-file");

/** Refuse an owner key file that is missing or that other users can read. Tests and automation only. */
export function checkOwnerKeyFile(path: string): void {
  if (!existsSync(path)) {
    process.stderr.write(`error: --owner-key-file ${path} does not exist\n`);
    process.exit(2);
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    process.stderr.write(`error: --owner-key-file ${path} can be read by other users: chmod 600 ${path}\n`);
    process.exit(2);
  }
}

let server: OwnerApprovalServer | undefined;
async function page(): Promise<OwnerApprovalServer> {
  if (!server) {
    server = new OwnerApprovalServer({ auditPath: ownerApprovalsLog() });
    await server.start();
  }
  return server;
}

/** Keep the page up a moment so it can show the final state, then stop it. */
export async function closeOwnerPage(lingerMs = 4000) {
  if (!server) return;
  await sleep(lingerMs);
  await server.close();
  server = undefined;
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

/** What a rail tells the shared page helpers. */
export interface OwnerRail {
  chain: OwnerChain;
  /** Named in the stderr sentence: "MetaMask or another" or "Phantom or another Solana wallet". */
  walletWords: string;
  /** The read-only command that shows whether something landed, for an unknown outcome. */
  statusCommand: string;
  /** The rail's RESULT line printer: returns the exit code. */
  emit: (command: string, exit: number, fields: Record<string, unknown>) => number;
}

export type Unapproved = Extract<OwnerActionOutcome, { status: "rejected" | "expired" }>;

/** The page helpers bound to one rail and chain. */
export function ownerPageFor(rail: OwnerRail) {
  function announce(action: string, h: OwnerActionHandle, t: OwnerTerms) {
    const minutes = Math.round((h.expiresAt - Date.now()) / 60000);
    // The plain terms travel with the link, so a caller that is not watching stderr can show them next to it.
    const terms = { title: t.title, amount: t.amount, unit: t.unit, summary: t.summary, enforced: t.enforced, notEnforced: t.notEnforced };
    console.log(`APPROVE ${JSON.stringify({ action, url: h.url, expires: new Date(h.expiresAt).toISOString(), terms })}`);
    console.error(`\nThe owner approves this in their own wallet. Open this link in the browser where the wallet is (${rail.walletWords}):\n\n  ${h.url}\n\nThe link works on this computer only and expires in ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round((h.expiresAt - Date.now()) / 1000)} seconds`}. Nothing is sent until the owner approves in the wallet. Waiting...\n`);
    if (!argv.includes("--no-open")) openBrowser(h.url);
  }

  return {
    /** Ask the owner to connect a wallet and sign the free sign-in message. */
    async askConnect(action: string, terms: OwnerTerms, signIn: string) {
      const s = await page();
      const handle = s.request({ kind: "connect", chain: rail.chain, terms, signIn, timeoutMs: OWNER_TIMEOUT_MS });
      announce(action, handle, terms);
      return { handle, outcome: await handle.settled };
    },

    /** EVM and Tempo: ask the owner's wallet to send exactly { to, data, value } from `owner`. */
    async askTransaction(action: string, owner: string, t: { to: string; data?: string; value?: bigint }, terms: OwnerTerms) {
      const s = await page();
      const handle = s.request({
        kind: "evm-transaction", chain: rail.chain, terms, account: owner, timeoutMs: OWNER_TIMEOUT_MS,
        transaction: { to: t.to, data: t.data ?? "0x", value: `0x${(t.value ?? 0n).toString(16)}` },
      });
      announce(action, handle, terms);
      return { handle, outcome: await handle.settled };
    },

    /** Solana: the owner's wallet signs what `port` builds when the owner presses Approve; `port` checks and sends it. */
    async askSolanaTransaction(action: string, owner: string, port: SolanaTransactionPort, terms: OwnerTerms) {
      const s = await page();
      const handle = s.request({ kind: "solana-transaction", chain: rail.chain, terms, account: owner, solana: port, timeoutMs: OWNER_TIMEOUT_MS });
      announce(action, handle, terms);
      return { handle, outcome: await handle.settled };
    },

    /** The owner rejected, or the link expired: one clear RESULT, then exit. Nothing was sent unless the wallet had been asked. */
    async endUnapproved(command: string, outcome: Unapproved, extra: Record<string, unknown> = {}): Promise<never> {
      await closeOwnerPage(2000);
      if (outcome.sending) {
        console.log(`UNKNOWN: ${outcome.reason}. The wallet may have sent it; read the chain before trying again.`);
        process.exit(rail.emit(command, 5, { state: "unknown", reason: outcome.reason, ...extra, next: `${rail.statusCommand}: read whether it landed before running this again` }));
      }
      console.log(`NOT APPROVED: ${outcome.reason}`);
      process.exit(rail.emit(command, 3, { state: "refused_precheck", reason: outcome.status === "expired" ? `the approval link expired: ${outcome.reason}` : outcome.reason, ...extra, next: "nothing was sent. Run the command again only if the owner asks" }));
    },
  };
}
