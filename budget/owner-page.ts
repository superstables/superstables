// The owner's page, shared by every rail. An owner command builds the transaction and the terms, opens the owner page on
// 127.0.0.1 (the client's OwnerApprovalServer, src/core/signer/owner-approval-server.ts), prints the link and waits. The page
// asks the owner's own wallet to approve exactly that transaction. The command then reads the chain itself: the hash the page
// reports is only a pointer. The agent's machine never holds the owner key.
//
// Hosted approvals (evm only, `setup --hosted`): a rail whose `hosted()` returns settings asks through superstables.com
// instead (hosted.ts): the link opens on any device where the owner is signed in with their wallet, and the owner picks a
// match code there. Same handle, same outcomes, same APPROVE line (plus `matchCode`). Setup, grant, revoke and fund-agent
// use it; any other action (recover's owner steps) keeps the page on this computer.
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
import { HOLDER_ENV, recordHosted } from "./approvals.mjs";
import { HOSTED_KIND, HostedApprovals, HostedRefusal, type HostedSettings } from "./hosted.ts";
import { siteOrigin } from "./site.mjs";

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
/** setup --new-owner: replace the recorded owner (each rail's setup refuses while a budget is live). */
export const NEW_OWNER = argv.includes("--new-owner");
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

let hostedClient: HostedApprovals | undefined;
function hostedFor(settings: Omit<HostedSettings, "auditPath" | "onRecord">): HostedApprovals {
  if (!hostedClient) {
    const holder = process.env[HOLDER_ENV];
    hostedClient = new HostedApprovals({
      ...settings,
      auditPath: ownerApprovalsLog(),
      // the access token lives in the approval record (mode 600), where --replace and wait find it; never in a log
      onRecord: (record) => { if (holder) recordHosted(holder, record); },
    });
  }
  return hostedClient;
}

/** Keep the page up a moment so it can show the final state, then stop it. A hosted request has no page here to keep up. */
export async function closeOwnerPage(lingerMs = 4000) {
  if (hostedClient) {
    await hostedClient.close();
    hostedClient = undefined;
  }
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
  /** Named in the stderr sentence, e.g. "any Solana wallet, such as Phantom, Solflare or Backpack". */
  walletWords: string;
  /** The read-only command that shows whether something landed, for an unknown outcome. */
  statusCommand: string;
  /** The rail's RESULT line printer: returns the exit code. */
  emit: (command: string, exit: number, fields: Record<string, unknown>) => number;
  /** The site that hosts this chain's owner approvals, or null for the page on this computer. */
  hostedSite?: () => string | null;
  /** The settings for a hosted request (read only when one is made: it opens the agent key). */
  hosted?: () => Omit<HostedSettings, "auditPath" | "onRecord">;
}

export type Unapproved = Extract<OwnerActionOutcome, { status: "rejected" | "expired" }>;

/** The page helpers bound to one rail and chain. */
export function ownerPageFor(rail: OwnerRail) {
  const inMinutes = (expiresAt: number) => {
    const minutes = Math.round((expiresAt - Date.now()) / 60000);
    return minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${Math.round((expiresAt - Date.now()) / 1000)} seconds`;
  };
  function announce(action: string, h: { url: string; expiresAt: number; matchCode?: string }, t: OwnerTerms, site?: string) {
    // The plain terms travel with the link, so a caller that is not watching stderr can show them next to it.
    const terms = { title: t.title, amount: t.amount, unit: t.unit, summary: t.summary, enforced: t.enforced, notEnforced: t.notEnforced };
    console.log(`APPROVE ${JSON.stringify({ action, url: h.url, expires: new Date(h.expiresAt).toISOString(), terms, ...(h.matchCode ? { matchCode: h.matchCode } : {}) })}`);
    if (site) {
      const host = new URL(site).host.replace(/^www\./, "");
      console.error(`\nWrite this link, the match code ${h.matchCode} and the terms in your reply to the owner, a visible message, not only in your reasoning or a tool call: the page asks them to pick the code. The link opens on any device where the owner is signed in to ${host} with their wallet (${rail.walletWords}):\n\n  ${h.url}\n\n  match code: ${h.matchCode}\n\nThe first link they open asks them to sign in with their wallet (a message, no fee). It expires in ${inMinutes(h.expiresAt)}. Setup links this agent to their ${host} account and sends no transaction. Other actions ask their wallet for a transaction. Testnet only: test USDC, no real money. Then poll the approval id with superstables budget wait. Do not approve for the owner.\n`);
    } else {
      console.error(`\nWrite this link and its terms in your reply to the owner, a visible message, not only in your reasoning or a tool call. Only the owner should use the page, in the browser with their wallet (${rail.walletWords}):\n\n  ${h.url}\n\nThe link works on this computer only and expires in ${inMinutes(h.expiresAt)}. Setup asks for a message signature. Other actions ask for a transaction approval. Testnet only: test USDC, no real money. Then poll the approval id with superstables budget wait. Do not approve for the owner.\n`);
    }
    if (!argv.includes("--no-open")) openBrowser(h.url);
  }

  /** The hosted settings for this action, or undefined for the page on this computer. */
  function hostedSettings(action: string, kind: "connect" | "evm-transaction") {
    const recorded = rail.hostedSite?.();
    if (!recorded || !rail.hosted) return undefined;
    const site = siteOrigin(recorded);
    if (site.error) {
      console.log(`REFUSED: the recorded site is not usable: ${site.error}`);
      process.exit(rail.emit(action, 3, { state: "refused_precheck", reason: `the recorded site is not usable: ${site.error}`, next: "run superstables budget setup --rail evm --hosted again, with --site if you use another site" }));
    }
    if (kind === "evm-transaction" && !HOSTED_KIND[action]) {
      console.error(`${action}: the owner's steps of recover use the approval page on this computer (127.0.0.1), not ${site.origin}. Hosted approvals cover setup, grant, revoke and fund-agent.`);
      return undefined;
    }
    return { ...rail.hosted(), site: site.origin as string };
  }

  /** A request the site did not take: nothing was requested, so nothing was sent. One RESULT, then exit. */
  async function refusedBySite(action: string, err: unknown): Promise<never> {
    if (!(err instanceof HostedRefusal)) throw err;
    await closeOwnerPage(0);
    console.log(`REFUSED: ${err.message}`);
    process.exit(rail.emit(action, 3, { state: "refused_precheck", reason: err.message, next: err.next }));
  }

  return {
    /**
     * Ask the owner to connect a wallet and sign the free sign-in message. `replacing`: the owner on record that
     * setup --new-owner replaces, shown on the page. Hosted: the owner links this agent to their account instead.
     */
    async askConnect(action: string, terms: OwnerTerms, signIn: string, replacing?: string) {
      const hosted = hostedSettings(action, "connect");
      if (hosted) {
        const handle = await hostedFor(hosted).request({ kind: "connect", terms, timeoutMs: OWNER_TIMEOUT_MS }).catch((e) => refusedBySite(action, e));
        // already linked on this chain: no link to show and nothing to wait for
        if (handle.alreadyLinked) console.error(`\nThis agent is already linked on ${hosted.site}; no link is needed.\n`);
        else announce(action, handle, terms, hosted.site);
        return { handle, outcome: await handle.settled };
      }
      const s = await page();
      const handle = s.request({ kind: "connect", chain: rail.chain, terms, signIn, recordedOwner: replacing, timeoutMs: OWNER_TIMEOUT_MS });
      announce(action, handle, terms);
      return { handle, outcome: await handle.settled };
    },

    /** EVM and Tempo: ask the owner's wallet to send exactly { to, data, value } from `owner`. */
    async askTransaction(action: string, owner: string, t: { to: string; data?: string; value?: bigint }, terms: OwnerTerms) {
      const transaction = { to: t.to, data: t.data ?? "0x", value: `0x${(t.value ?? 0n).toString(16)}` };
      const hosted = hostedSettings(action, "evm-transaction");
      if (hosted) {
        const handle = await hostedFor(hosted).request({ kind: "evm-transaction", action, terms, account: owner, transaction, timeoutMs: OWNER_TIMEOUT_MS }).catch((e) => refusedBySite(action, e));
        announce(action, handle, terms, hosted.site);
        return { handle, outcome: await handle.settled };
      }
      const s = await page();
      const handle = s.request({ kind: "evm-transaction", chain: rail.chain, terms, account: owner, timeoutMs: OWNER_TIMEOUT_MS, transaction });
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
      process.exit(rail.emit(command, 3, { state: "refused_precheck", reason: outcome.status === "expired" ? `the approval link expired: ${outcome.reason}` : outcome.reason, ...extra, next: "check the result and wallet activity. Request a new approval only if the owner asks" }));
    },
  };
}
