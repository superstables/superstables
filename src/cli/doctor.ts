// `superstables doctor`: everything that has to be true before a payment can work, checked
// one line at a time.
//
// The rules are the same for every check. It has five seconds. It never throws — a check that
// blows up is a failed check with the reason on the line, because a diagnostic that crashes is
// the one thing worse than no diagnostic. And it says which side of the machine it is about:
// three checks are about this machine and must pass (home, policy, key); the rest are about
// somebody else's uptime and are reported, not enforced.
//
// Two of the checks depend on which wallet is in use. In browser mode the owner has nothing to
// start and no key here, so "is the wallet running?" is replaced by "can this machine serve the
// approval page?"; in local mode the key and the wallet process are checked as before.
//
// SUPERSTABLES_DOCTOR_OFFLINE=1 skips every check that needs a network and says so on the line,
// so the command stays usable on a plane, in CI, and in a test.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DEFAULT_NETWORK } from "../core/chain.js";
import { HOSTED_DEMO_SERVICE_URL, indexUrl } from "../core/discovery.js";
import { FACILITATORS } from "../core/facilitator.js";
import {
  DEFAULT_APPROVE_PORT,
  approvePortFromEnvironment,
  browserWalletPath,
  ensureDir,
  homeDir,
  policyPath,
  walletDir,
  walletUrl,
} from "../core/home.js";
import { loadPolicy } from "../core/policy.js";
import { clientVersion } from "../core/version.js";
import { walletStatus } from "../core/signer/wallet.js";
import { policySummary } from "../wallet/daemon.js";
import { keyExists, keyPath } from "../wallet/keystore.js";
import { walletModeFromEnvironment, type WalletMode } from "./signer.js";

/** Long enough for a loaded public facilitator, short enough that ten checks stay bearable. */
const CHECK_TIMEOUT_MS = 5_000;

export interface Check {
  name: string;
  /** False only when the check ran and failed. A skipped check is not a failure. */
  ok: boolean;
  detail: string;
  /** True when a payment cannot work without this, so the command exits non-zero. */
  essential: boolean;
  skipped?: boolean;
}

export interface DoctorReport {
  checks: Check[];
  /** True when nothing essential is missing. */
  ok: boolean;
  offline: boolean;
  /** Which wallet the checks were run for. */
  mode: WalletMode;
  /** Which build ran the checks. The first thing to compare when two machines disagree. */
  version: string;
  /** The directory every check below is about. */
  home: string;
}

export function doctorIsOffline(): boolean {
  return process.env.SUPERSTABLES_DOCTOR_OFFLINE === "1";
}

export async function runDoctor(mode: WalletMode = walletModeFromEnvironment()): Promise<DoctorReport> {
  const offline = doctorIsOffline();
  const checks: Check[] =
    mode === "browser"
      ? [homeCheck(), policyCheck(), browserWalletCheck(), await approvalPageCheck()]
      : [homeCheck(), policyCheck(), keyCheck(), await walletCheck()];

  if (offline) {
    for (const name of ["demo service", "Superstables index", ...FACILITATORS.map(hostOf)]) {
      checks.push({ name, ok: true, detail: "skipped: SUPERSTABLES_DOCTOR_OFFLINE=1", essential: false, skipped: true });
    }
  } else {
    checks.push(await demoServiceCheck(), await indexCheck(), ...(await facilitatorChecks()));
  }

  return {
    checks,
    ok: checks.every((check) => !check.essential || check.ok),
    offline,
    mode,
    version: clientVersion(),
    home: homeDir(),
  };
}

export function formatReport(report: DoctorReport): string {
  const checkLines = report.checks.map((check) => {
    const mark = check.skipped ? "-" : check.ok ? "✓" : "✗";
    return `${mark} ${check.name.padEnd(24)} ${check.detail}`;
  });
  // Which build, and which directory, before any check: a report pasted into a bug report is
  // worth little if nobody can tell which build produced it, and a machine that was installed
  // over twice can have an older server answering from a home nobody expected.
  const lines = [
    `  ${"client version".padEnd(24)} ${report.version}`,
    `  ${"home".padEnd(24)} ${report.home}`,
    "",
    ...checkLines,
  ];
  lines.push("");
  lines.push(
    report.ok
      ? "Everything this machine needs is in place."
      : "Something essential is missing; the lines marked ✗ above say what.",
  );
  return lines.join("\n");
}

// ── This machine ───────────────────────────────────────────────────────────────────────

function homeCheck(): Check {
  const dir = homeDir();
  const probe = join(dir, ".doctor-write-test");
  try {
    ensureDir(dir);
    writeFileSync(probe, "", { mode: 0o600 });
    rmSync(probe, { force: true });
    return { name: "home directory", ok: true, detail: `${dir} (writable)`, essential: true };
  } catch (err) {
    return { name: "home directory", ok: false, detail: `${dir} is not writable: ${messageOf(err)}`, essential: true };
  }
}

function policyCheck(): Check {
  const path = policyPath();
  try {
    const policy = loadPolicy(path);
    const where = existsSync(path) ? path : `${path} (missing, built-in defaults apply)`;
    return { name: "spend policy", ok: true, detail: `${where}: ${policySummary(policy)}`, essential: true };
  } catch (err) {
    return { name: "spend policy", ok: false, detail: `${path} could not be read: ${messageOf(err)}`, essential: true };
  }
}

function keyCheck(): Check {
  const path = keyPath(walletDir());
  return keyExists(walletDir())
    ? { name: "wallet key", ok: true, detail: path, essential: true }
    : { name: "wallet key", ok: false, detail: "no key yet: run `superstables wallet init`", essential: true };
}

/**
 * In browser mode the key is MetaMask's, so there is nothing on this machine to check but the
 * name of the account that last connected — and not having one yet is perfectly normal.
 */
function browserWalletCheck(): Check {
  const path = browserWalletPath();
  if (!existsSync(path)) {
    return {
      name: "browser wallet",
      ok: true,
      detail: "no account connected yet: MetaMask connects when the first approval link opens",
      essential: false,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { address?: string };
    return parsed.address
      ? { name: "browser wallet", ok: true, detail: `last connected as ${parsed.address}`, essential: false }
      : { name: "browser wallet", ok: true, detail: `${path} names no account`, essential: false };
  } catch (err) {
    return { name: "browser wallet", ok: false, detail: `${path} could not be read: ${messageOf(err)}`, essential: false };
  }
}

/**
 * Can this machine serve the approval page? The one thing that would stop it is a port the
 * owner fixed with SUPERSTABLES_APPROVE_PORT already being taken, so the check is to bind it
 * and let it go again. The default port being taken stops nothing: pay takes a free one.
 */
async function approvalPageCheck(): Promise<Check> {
  const chosen = approvePortFromEnvironment();
  const port = chosen ?? DEFAULT_APPROVE_PORT;
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    return {
      name: "approval page",
      ok: true,
      detail: `http://127.0.0.1:${boundPort} is free; the agent serves the page itself`,
      essential: true,
    };
  } catch (err) {
    const waiting = "probably by another payment waiting for its owner; do not stop it";
    if (chosen === undefined) {
      return {
        name: "approval page",
        ok: true,
        detail: `port ${port} is in use, ${waiting}. pay will serve its page on a free port instead`,
        essential: true,
      };
    }
    return {
      name: "approval page",
      ok: false,
      detail:
        `port ${port} (SUPERSTABLES_APPROVE_PORT) is taken (${messageOf(err)}), ${waiting}. ` +
        "Unset SUPERSTABLES_APPROVE_PORT to let pay pick a free port, or set it to a different one",
      essential: true,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function walletCheck(): Promise<Check> {
  try {
    const status = await walletStatus({ fetchImpl: timedFetch });
    const balance =
      status.balanceDecimal === undefined ? "balance unknown" : `${status.balanceDecimal} ${status.asset}`;
    return {
      name: "wallet",
      ok: true,
      detail: `running at ${walletUrl()} as ${status.address} (${balance})`,
      essential: false,
    };
  } catch {
    return {
      name: "wallet",
      ok: false,
      detail: `not answering at ${walletUrl()}: start it with \`superstables wallet serve\``,
      essential: false,
    };
  }
}

// ── The rest of the world ──────────────────────────────────────────────────────────────

async function demoServiceCheck(): Promise<Check> {
  const url = process.env.SUPERSTABLES_DEMO_SERVICE_URL ?? HOSTED_DEMO_SERVICE_URL;
  const probe = `${url}${url.includes("?") ? "&" : "?"}asset=BTC`;
  try {
    const res = await timedFetch(probe, { method: "GET" });
    // A paid endpoint proves it is alive by asking for payment: 402 is the healthy answer.
    return res.status === 402
      ? { name: "demo service", ok: true, detail: `${url} asks for payment (HTTP 402)`, essential: false }
      : { name: "demo service", ok: false, detail: `${url} answered HTTP ${res.status}, not 402`, essential: false };
  } catch (err) {
    return { name: "demo service", ok: false, detail: `${url} could not be reached: ${messageOf(err)}`, essential: false };
  }
}

async function indexCheck(): Promise<Check> {
  const INDEX_URL = indexUrl();
  if (!INDEX_URL) {
    return { name: "Superstables index", ok: true, detail: "switched off: SUPERSTABLES_INDEX_URL=off", essential: false, skipped: true };
  }
  const url = new URL(INDEX_URL);
  url.searchParams.set("limit", "1");
  try {
    const res = await timedFetch(url.toString(), { headers: { accept: "application/json" } });
    return res.ok
      ? { name: "Superstables index", ok: true, detail: `${INDEX_URL} answered HTTP ${res.status}`, essential: false }
      : { name: "Superstables index", ok: false, detail: `${INDEX_URL} answered HTTP ${res.status}`, essential: false };
  } catch (err) {
    return { name: "Superstables index", ok: false, detail: `${INDEX_URL} could not be reached: ${messageOf(err)}`, essential: false };
  }
}

function facilitatorChecks(): Promise<Check[]> {
  return Promise.all(FACILITATORS.map(facilitatorCheck));
}

async function facilitatorCheck(url: string): Promise<Check> {
  const name = hostOf(url);
  try {
    const res = await timedFetch(`${url}/supported`, { headers: { accept: "application/json" } });
    if (!res.ok) return { name, ok: false, detail: `answered HTTP ${res.status} on /supported`, essential: false };
    const body = (await res.json()) as { kinds?: { network?: string; scheme?: string }[] };
    const kinds = body.kinds ?? [];
    const supported = kinds.some(
      (kind) => kind.network === DEFAULT_NETWORK.caip2 || kind.network === DEFAULT_NETWORK.v1Name,
    );
    return supported
      ? { name, ok: true, detail: `settles exact payments on ${DEFAULT_NETWORK.label}`, essential: false }
      : { name, ok: false, detail: `answered, but does not list ${DEFAULT_NETWORK.caip2}`, essential: false };
  } catch (err) {
    return { name, ok: false, detail: `could not be reached: ${messageOf(err)}`, essential: false };
  }
}

// ── Plumbing ───────────────────────────────────────────────────────────────────────────

/** Every remote read in this file gets the same five seconds, and no check gets to hang. */
function timedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
