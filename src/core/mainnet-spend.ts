// The mainnet spending ledger: every signature or grant this client makes on a mainnet reserves its amount here first,
// under a lock shared by every process on this computer, against the caps in the mainnet manifest (./mainnet-policy.js).
// A reservation is checked and written in one step under the lock, so two payments at once, in one process or in two,
// cannot both fit under a daily cap that only one of them fits under.
//
// What counts: every reservation of the last 24 hours that was not released. A reservation is released only when its
// signer failed before any signature existed. One that was signed, sent, retried, left pending or abandoned by a
// process that stopped keeps counting until its 24 hours pass, because money may still move. A retry of the same
// signature (same operation id) is not counted twice. An unreadable ledger refuses: it is never reset to empty.
//
// The pause file lives next to the ledger. While it exists, or while SUPERSTABLES_MAINNET_PAUSE is set, nothing new is
// reserved, signed or sent on a mainnet (./mainnet-policy.js says what a pause cannot undo). Testnets never touch any
// of this.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
  opId: string;
  chain: string;
  amountAtomic: string;
  at: number;
  state: "reserved" | "signed" | "released";
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
      if (typeof h?.opId !== "string" || typeof h.chain !== "string" || !/^[0-9]+$/.test(String(h.amountAtomic)) || typeof h.at !== "number" || !["reserved", "signed", "released"].includes(h.state)) {
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

/** What counts toward `chain`'s daily cap at `now`: every hold of the last 24 hours that was not released. */
export function heldToday(holds: readonly MainnetHold[], chain: string, now: number): bigint {
  return holds
    .filter((h) => h.chain === chain && h.state !== "released" && h.at > now - MAINNET_WINDOW_MS)
    .reduce((sum, h) => sum + BigInt(h.amountAtomic), 0n);
}

/** A reservation, or none on a testnet. `settle` records how it ended. */
export type Reservation = { held: false } | { held: true; opId: string; dir: string };

/**
 * Reserve `amountAtomic` on `chain` for the operation `opId`, or throw MainnetRefused. On a testnet it reserves nothing.
 * The pause, the manifest, the per-grant cap and the 24-hour cap are all checked under the lock, at the moment of
 * writing, so a pause set while another payment waited for the lock stops that payment too.
 */
export async function reserveMainnetSpend(chain: MainnetChainRef, amountAtomic: bigint, opId: string, opts: LedgerOptions = {}): Promise<Reservation> {
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
    const same = holds.find((h) => h.opId === opId);
    if (same && same.state !== "released") {
      if (same.chain === chain.key && same.amountAtomic === amountAtomic.toString()) return { held: true, opId, dir };
      throw new MainnetRefused(`operation ${opId} already holds another amount or chain; nothing was signed`);
    }
    const used = heldToday(holds, chain.key, now);
    if (used + amountAtomic > caps.perDay) {
      throw new MainnetRefused(`with this one, ${chain.key} would reach ${used + amountAtomic} in 24 hours, above its cap of ${caps.perDay} (in the token's smallest unit); pending and unconfirmed payments count`);
    }
    const kept = holds.filter((h) => h.opId !== opId && h.at > now - 7 * MAINNET_WINDOW_MS);
    writeLedger(path, [...kept, { opId, chain: chain.key, amountAtomic: amountAtomic.toString(), at: now, state: "reserved" }]);
    return { held: true, opId, dir };
  });
}

/**
 * Record how a reservation ended. "signed": a signature exists, so it counts for its 24 hours whatever happens next.
 * "released": the signer failed before any signature existed; only a reservation still marked reserved can be released.
 */
export async function settleMainnetSpend(reservation: Reservation, outcome: "signed" | "released"): Promise<void> {
  if (!reservation.held) return;
  const path = join(reservation.dir, MAINNET_LEDGER);
  await withFileLock(join(reservation.dir, MAINNET_LEDGER_LOCK), () => {
    const holds = readLedger(path);
    const hold = holds.find((h) => h.opId === reservation.opId);
    if (!hold || hold.state !== "reserved") return;
    hold.state = outcome;
    writeLedger(path, holds);
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
