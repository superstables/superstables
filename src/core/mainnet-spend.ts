// The mainnet spending ledger: every signature or grant this client makes on a mainnet reserves its amount here first,
// under a lock shared by every process on this computer, against the caps in the mainnet manifest (./mainnet-policy.js).
// A reservation is checked and written in one step under the lock, so two payments at once, in one process or in two,
// cannot both fit under a daily cap that only one of them fits under.
//
// What counts: every reservation of the last 24 hours. Each request to sign, and each approval page, reserves its own
// amount before the key or the wallet is asked, and nothing ever releases it: not a refusal, not a failed key, not a
// retry of the same nonce. A retry is a new authorization (a new validBefore), so it is a new reservation. This
// overcounts refusals and failures on purpose: the ledger never has to know which of two requests made the signature
// that exists. An unreadable ledger refuses: it is never reset to empty.
//
// The pause file lives next to the ledger. While it exists, or while SUPERSTABLES_MAINNET_PAUSE is set, nothing new is
// reserved, signed or sent on a mainnet (./mainnet-policy.js says what a pause cannot undo). Testnets never touch any
// of this.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { homeDir } from "./home.js";
import { withFileLock } from "./lock.js";
import { mainnetCaps, mainnetRefusal, setMainnetPauseSource, type MainnetManifest } from "./mainnet-policy.js";

export const MAINNET_LEDGER = "mainnet-spend.json";
export const MAINNET_LEDGER_LOCK = "mainnet-spend.lock";
export const MAINNET_PAUSE_FILE = "mainnet-paused";
export const MAINNET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Where the ledger and the pause file live: the client's home folder unless a caller (a test) names another. */
const dirOf = (dir?: string) => dir ?? homeDir();

setMainnetPauseSource(() => (existsSync(join(dirOf(), MAINNET_PAUSE_FILE)) ? `the pause file ${join(dirOf(), MAINNET_PAUSE_FILE)} exists` : ""));

export interface MainnetHold {
  /** Unique to this reservation. */
  id: string;
  /** What asked for it, for a person reading the ledger. Never used to match one reservation to another. */
  what: string;
  chain: string;
  amountAtomic: string;
  at: number;
}

/** A refusal at the mainnet boundary: nothing was reserved, signed or sent. */
export class MainnetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainnetRefused";
  }
}

export interface MainnetChainRef {
  rail: string;
  key: string;
  chainId?: number;
  testnet: unknown;
  token?: unknown;
}

export interface LedgerOptions {
  dir?: string;
  now?: number;
  manifest?: MainnetManifest;
  env?: Record<string, string | undefined>;
}

function readLedger(path: string): MainnetHold[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MainnetRefused(`the mainnet spending ledger ${path} cannot be read (${(err as Error).message}); nothing was signed`);
  }
  try {
    const parsed = JSON.parse(text) as { holds?: unknown };
    if (!parsed || !Array.isArray(parsed.holds)) throw new Error("no holds list");
    for (const h of parsed.holds as MainnetHold[]) {
      if (typeof h?.id !== "string" || typeof h.what !== "string" || typeof h.chain !== "string" || !/^[0-9]+$/.test(String(h.amountAtomic)) || typeof h.at !== "number") {
        throw new Error("a hold is malformed");
      }
    }
    return parsed.holds as MainnetHold[];
  } catch (err) {
    throw new MainnetRefused(`the mainnet spending ledger ${path} is not valid (${(err as Error).message}); nothing was signed, and the ledger was left as it is`);
  }
}

/** Written whole to a temporary file, flushed, then renamed into place: the ledger is the old one or the new one, never half. */
function writeLedger(path: string, holds: MainnetHold[]): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify({ holds }, null, 1));
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** What counts toward `chain`'s daily cap at `now`: every hold of the last 24 hours. */
export function heldToday(holds: readonly MainnetHold[], chain: string, now: number): bigint {
  return holds
    .filter((h) => h.chain === chain && h.at > now - MAINNET_WINDOW_MS)
    .reduce((sum, h) => sum + BigInt(h.amountAtomic), 0n);
}

/** Whether an amount was reserved: never on a testnet. */
export type Reservation = { held: boolean };

/**
 * Reserve `amountAtomic` on `chain` for one request to sign (`what` says which, for a person), or throw MainnetRefused.
 * On a testnet it reserves nothing. The pause, the manifest, the per-grant cap and the 24-hour cap are all checked under
 * the lock, at the moment of writing, so a pause set while another payment waited for the lock stops that payment too.
 * The reservation counts for its 24 hours whatever happens next: call this only right before the key or the wallet is
 * asked, never to check.
 */
export async function reserveMainnetSpend(chain: MainnetChainRef, amountAtomic: bigint, what: string, opts: LedgerOptions = {}): Promise<Reservation> {
  if (chain.testnet === true) return { held: false };
  const dir = dirOf(opts.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, MAINNET_LEDGER);
  return withFileLock(join(dir, MAINNET_LEDGER_LOCK), () => {
    const refusal = mainnetRefusal(chain, opts.manifest, opts.env);
    if (refusal) throw new MainnetRefused(refusal);
    const caps = mainnetCaps(chain.key, opts.manifest);
    if (!caps) throw new MainnetRefused(`${chain.key} has no caps in the mainnet manifest`);
    if (amountAtomic <= 0n) throw new MainnetRefused("a mainnet amount must be above 0");
    if (amountAtomic > caps.perGrant) {
      throw new MainnetRefused(`${amountAtomic} is above ${chain.key}'s cap of ${caps.perGrant} for one payment or grant (in the token's smallest unit)`);
    }
    const now = opts.now ?? Date.now();
    const holds = readLedger(path);
    const used = heldToday(holds, chain.key, now);
    if (used + amountAtomic > caps.perDay) {
      throw new MainnetRefused(`with this one, ${chain.key} would reach ${used + amountAtomic} in 24 hours, above its cap of ${caps.perDay} (in the token's smallest unit); pending and unconfirmed payments count`);
    }
    const kept = holds.filter((h) => h.at > now - 7 * MAINNET_WINDOW_MS);
    writeLedger(path, [...kept, { id: randomUUID(), what, chain: chain.key, amountAtomic: amountAtomic.toString(), at: now }]);
    return { held: true };
  });
}

/**
 * Why a signature already made on `chain` must not be sent now, or "": the same manifest and pause check as a new
 * signature. A signature kept back is never sent by this client; it stays valid on chain until it expires.
 */
export function mainnetSendRefusal(chain: MainnetChainRef, opts: Pick<LedgerOptions, "manifest" | "env"> = {}): string {
  if (chain.testnet === true) return "";
  return mainnetRefusal(chain, opts.manifest, opts.env);
}
