// The owner's settings: the trust anchors only the owner chooses. Which site hosts approvals, which RPC endpoints owner
// actions and verdicts may read, and what the owner allows for development on this computer. One file, in the account's
// own home (the home directory the operating system records for this user, never $HOME, SUPERSTABLES_HOME or --home):
//
//   <account home>/.superstables/owner/settings.json      mode 600, in a folder only this user can write (700)
//
// It is written by `superstables owner settings`, in the owner's own terminal. An agent's environment does not move
// these anchors: SUPERSTABLES_SITE, --site, a SITE recorded in a public file and the RPC variables (B4_RPC,
// SUPERSTABLES_TEMPO_RPC, SUPERSTABLES_SOLANA_RPC) count for an owner action or a verdict only when they name what these
// settings (or the built-in defaults) allow. Plain reads ("read") keep the environment.
//
// The agent runs as the same user, so it can still edit this file directly: that is a change only the owner's wallet
// signature can make evident, which comes with signed settings. What this file removes now is the environment knob.
//
// Plain JavaScript with JSDoc types, like chain-gate.js: the budget's .mjs files, its TypeScript and src/ share it; tsc
// emits it to dist with its declaration, and scripts/budget-build.mjs bundles it into dist/budget. Node built-ins only.
// It never reads the environment: callers pass the value of a variable, so no variable moves the file or what it says.

import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, privateDirProblem, syncDirectory } from "./private-dir.mjs";

export const OWNER_SETTINGS_VERSION = 1;
/** Production: the only approval site with no setting. superstables.com (the apex) is the same site. */
export const DEFAULT_SITE = "https://www.superstables.com";
export const APEX_SITE = "https://superstables.com";
export const STAGING_SITE = "https://staging.superstables.com";
/** The command the owner runs; every refusal names it. */
export const SETTINGS_COMMAND = "superstables owner settings";
/** The `code` of the Error readOwnerSettings throws for a settings file that exists but cannot be used. */
export const OWNER_SETTINGS_UNREADABLE = "OWNER_SETTINGS_UNREADABLE";
/** The chains an RPC can be set for: the client's chain table (agreement test in test/core/owner-settings.test.ts). */
export const RPC_CHAIN_KEYS = Object.freeze([
  "base-sepolia", "arc-testnet", "arbitrum-sepolia", "polygon-amoy", "skale-base-sepolia", "ethereum-sepolia", "robinhood-testnet",
  "tempo-moderato", "solana-devnet",
]);
export const MAX_RPC_URLS = 5;
/** The fields a signature covers, in this order; `signature`, `present` and `path` are not among them. */
export const SETTINGS_FIELDS = Object.freeze(["version", "site", "rpc", "rpcEnv", "sellers"]);

const MAX_BYTES = 64 * 1024;
const MAX_URL_CHARS = 2048;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @typedef {"owner" | "verdict" | "read"} TrustPurpose
 *   owner: building or checking an owner action (setup, grant, revoke, fund-agent, recover, rotate) and the approval site
 *   verdict: a negative or safety-critical verdict (never paid, revoked, allowance 0, ...): the same rule as owner
 *   read: anything else (a balance, a listing, a status line): the environment is used as given
 */
/**
 * @typedef {object} OwnerRpc
 * @property {string[]} urls      1 to 5, distinct once parsed; https, or http(s) on 127.0.0.1 / localhost / [::1]; no user info, no fragment
 * @property {boolean} ownNode    urls[0] is the owner's own node
 * @property {number} quorum      normalised: ownNode ? (q ?? 1) : max(2, q ?? 2); may exceed urls.length: a lone URL without ownNode has quorum 2, so verdicts through it stay unknown until a second URL is set
 */
/**
 * @typedef {object} OwnerSettings
 * @property {1} version
 * @property {{ origin: string, allowStaging: boolean, allowLoopback: boolean }} site
 * @property {Record<string, OwnerRpc>} rpc        keyed by RPC_CHAIN_KEYS
 * @property {{ allowLoopback: boolean }} rpcEnv   an RPC variable naming this computer counts as the owner's (development)
 * @property {{ allowLoopback: boolean }} sellers  a seller on this computer may be paid on a chain that is not a testnet
 * @property {Record<string, unknown>} [signature] reserved for the owner's wallet signature; opaque here
 * @property {boolean} present                     false: no file, these are the defaults
 * @property {string} path
 */
/**
 * @typedef {object} RpcChoice
 * @property {string | undefined} url
 * @property {string[]} urls
 * @property {boolean} ownNode
 * @property {number} quorum
 * @property {"env" | "settings" | "default"} source
 * @property {"settings" | "loopback" | "builtin"} [allowedBy]   why a variable counted for an owner action or a verdict
 */

/** The account's own home: the operating system's record for this user, not $HOME. */
function accountHome() {
  try {
    return userInfo().homedir;
  } catch {
    return homedir();
  }
}
const accountStateDir = () => join(accountHome(), ".superstables");
const ownerDir = () => join(accountStateDir(), "owner");
/** <account home>/.superstables/owner/settings.json */
export function ownerSettingsPath() {
  return join(ownerDir(), "settings.json");
}

/** @returns {OwnerSettings} */
export function defaultOwnerSettings() {
  return {
    version: 1,
    site: { origin: DEFAULT_SITE, allowStaging: false, allowLoopback: false },
    rpc: {},
    rpcEnv: { allowLoopback: false },
    sellers: { allowLoopback: false },
    present: false,
    path: ownerSettingsPath(),
  };
}

const unreadable = (why) => Object.assign(new Error(`the owner settings at ${ownerSettingsPath()} cannot be used: ${why}. Nothing that needs them was done; the owner checks the file with ${SETTINGS_COMMAND} show`), { code: OWNER_SETTINGS_UNREADABLE });

/** An RPC URL the owner may set: https, or http(s) on this computer; no user name or password (a key in the path or query is fine). */
export function ownerRpcUrlProblem(value) {
  if (typeof value !== "string") return "it is not text";
  if (value.length > MAX_URL_CHARS) return `it is longer than ${MAX_URL_CHARS} characters`;
  let u;
  try { u = new URL(value.trim()); } catch { return "it is not a URL"; }
  if (u.username || u.password) return "it carries a user name or password";
  if (u.hash) return "it has a fragment";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return u.protocol === "http:" ? "plain http is accepted only on 127.0.0.1, localhost or [::1]" : "it is not an https URL";
}
/** Whether two RPC URLs are the same once parsed, so a trailing slash (on a path too) or the case of a host does not matter. */
export function sameRpcUrl(a, b) {
  const norm = (v) => { const u = new URL(String(v).trim()); if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, ""); return u.href; };
  try { return norm(a) === norm(b); } catch { return false; }
}
/** A URL as the owner sees it in a message: scheme, host and port; never the path or query, which may hold an access key. */
export function shownUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return `${u.protocol}//${u.host}${(u.pathname && u.pathname !== "/") || u.search ? "/…" : ""}`;
  } catch {
    return "(not a URL)";
  }
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function onlyKeys(o, keys, where) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw unreadable(`${where} has an unknown field "${k.slice(0, 40)}"`);
}
function bool(o, k, where) {
  if (o[k] === undefined) return false;
  if (typeof o[k] !== "boolean") throw unreadable(`${where}.${k} must be true or false`);
  return o[k];
}

/** The site origin in `value` (an origin only: https, or http on this computer), or { error } in words. The apex maps to www. */
function parseSite(value) {
  const raw = String(value ?? "").trim();
  const shown = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, 120);
  let u;
  try { u = new URL(raw); } catch { return { error: `"${shown}" is not a URL (for example ${DEFAULT_SITE})` }; }
  if (u.username || u.password) return { error: "the site URL must not carry a user name or password" };
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { error: `the site must be an https URL (plain http only on 127.0.0.1 or localhost); got "${shown}"` };
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { error: `the site is an origin only, such as ${DEFAULT_SITE}, with no path (got "${shown}")` };
  return { origin: u.origin === APEX_SITE ? DEFAULT_SITE : u.origin, host: u.hostname, loopback };
}

/**
 * The settings in `text` (the file's contents). Strict: an unknown field, a wrong type or a URL that is not allowed throws
 * an Error with code OWNER_SETTINGS_UNREADABLE. Fields left out take their defaults.
 * @param {string} text
 * @returns {OwnerSettings}
 */
export function parseOwnerSettings(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw unreadable("it is not JSON"); }
  if (!isObject(j)) throw unreadable("it is not a JSON object");
  onlyKeys(j, ["version", "site", "rpc", "rpcEnv", "sellers", "signature"], "the file");
  if (j.version !== OWNER_SETTINGS_VERSION) throw unreadable(`its version is not ${OWNER_SETTINGS_VERSION}`);
  const out = defaultOwnerSettings();
  out.present = true;
  if (j.site !== undefined) {
    if (!isObject(j.site)) throw unreadable("site must be an object");
    onlyKeys(j.site, ["origin", "allowStaging", "allowLoopback"], "site");
    out.site.allowStaging = bool(j.site, "allowStaging", "site");
    out.site.allowLoopback = bool(j.site, "allowLoopback", "site");
    if (j.site.origin !== undefined) {
      const s = parseSite(j.site.origin);
      if (s.error) throw unreadable(`site.origin: ${s.error}`);
      if (s.loopback && !out.site.allowLoopback) throw unreadable("site.origin is on this computer, but site.allowLoopback is not true");
      out.site.origin = s.origin;
    }
  }
  if (j.rpc !== undefined) {
    if (!isObject(j.rpc)) throw unreadable("rpc must be an object of chains");
    for (const [chain, v] of Object.entries(j.rpc)) {
      if (!RPC_CHAIN_KEYS.includes(chain)) throw unreadable(`rpc has a chain that is not one of ${RPC_CHAIN_KEYS.join(", ")} ("${chain.slice(0, 40)}")`);
      if (!isObject(v)) throw unreadable(`rpc.${chain} must be an object`);
      onlyKeys(v, ["urls", "ownNode", "quorum"], `rpc.${chain}`);
      if (!Array.isArray(v.urls) || v.urls.length < 1 || v.urls.length > MAX_RPC_URLS) throw unreadable(`rpc.${chain}.urls must list 1 to ${MAX_RPC_URLS} URLs`);
      const urls = [];
      for (const url of v.urls) {
        const p = ownerRpcUrlProblem(url);
        if (p) throw unreadable(`rpc.${chain}.urls: ${p}`);
        if (urls.some((u) => sameRpcUrl(u, url))) throw unreadable(`rpc.${chain}.urls lists the same URL twice (${shownUrl(url)})`);
        urls.push(url.trim());
      }
      const ownNode = bool(v, "ownNode", `rpc.${chain}`);
      if (v.quorum !== undefined && (!Number.isInteger(v.quorum) || v.quorum < 1 || v.quorum > MAX_RPC_URLS)) throw unreadable(`rpc.${chain}.quorum must be a whole number from 1 to ${MAX_RPC_URLS}`);
      if (v.quorum !== undefined && v.quorum > urls.length) throw unreadable(`rpc.${chain}.quorum is ${v.quorum}, but only ${urls.length} URL${urls.length === 1 ? " is" : "s are"} listed`);
      const quorum = ownNode ? (v.quorum ?? 1) : Math.max(2, v.quorum ?? 2);
      out.rpc[chain] = { urls, ownNode, quorum };
    }
  }
  for (const k of ["rpcEnv", "sellers"]) {
    if (j[k] === undefined) continue;
    if (!isObject(j[k])) throw unreadable(`${k} must be an object`);
    onlyKeys(j[k], ["allowLoopback"], k);
    out[k].allowLoopback = bool(j[k], "allowLoopback", k);
  }
  if (j.signature !== undefined) {
    if (!isObject(j.signature)) throw unreadable("signature must be an object");
    out.signature = j.signature;
  }
  return out;
}

/**
 * The owner's settings: the defaults when there is no file (or no owner folder), else the file's. Throws an Error with
 * code OWNER_SETTINGS_UNREADABLE when the file exists but cannot be used: a folder or file other users can write to,
 * a symlink, not a regular file, too large, not this user's, or malformed. Read on every call, so a long-running process
 * sees the owner's change.
 * @returns {OwnerSettings}
 */
export function readOwnerSettings() {
  const path = ownerSettingsPath();
  const dirProblem = privateDirProblem(ownerDir(), { root: accountStateDir() });
  if (dirProblem) throw unreadable(dirProblem);
  let st;
  try { st = lstatSync(path); } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return defaultOwnerSettings();
    throw unreadable(`it could not be read (${err?.code ?? "error"})`);
  }
  if (st.isSymbolicLink()) throw unreadable("it is a symlink");
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); } catch (err) {
    throw unreadable(`it could not be opened (${err?.code ?? "error"})`);
  }
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) throw unreadable("it is not a regular file");
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && f.uid !== process.getuid()) throw unreadable("it belongs to another user");
      if ((f.mode & 0o022) !== 0) throw unreadable(`other users can write to it (mode ${(f.mode & 0o777).toString(8)}): chmod 600 ${path}`);
    }
    if (f.size > MAX_BYTES) throw unreadable(`it is larger than ${MAX_BYTES} bytes`);
    // a bounded read: a file that grew after fstat is still cut off at one byte past the limit
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > MAX_BYTES) throw unreadable(`it is larger than ${MAX_BYTES} bytes`);
    return parseOwnerSettings(buf.subarray(0, n).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** "" when the settings can be used, else the sentence that says why not. Never throws. */
export function ownerSettingsProblem() {
  try {
    readOwnerSettings();
    return "";
  } catch (err) {
    return err?.code === OWNER_SETTINGS_UNREADABLE ? err.message : `the owner settings could not be read (${err?.message ?? err})`;
  }
}

/** Settings, or { error } in words, for the callers below that answer with { error } instead of throwing. */
function settingsOr(settings) {
  if (settings) return { settings };
  try { return { settings: readOwnerSettings() }; } catch (err) {
    return { error: err?.code === OWNER_SETTINGS_UNREADABLE ? err.message : `the owner settings could not be read (${err?.message ?? err})` };
  }
}

const isSuperstablesHost = (host) => host === "superstables.com" || host.endsWith(".superstables.com");

/**
 * The approval site for `purpose`, from `candidate` (what --site, SUPERSTABLES_SITE or a recorded SITE named), else the
 * owner's own site (settings site.origin, else www.superstables.com). { origin, source } or { error, ownerCommand? }.
 *
 *   owner, verdict: the origin must be www.superstables.com (the apex is mapped to it), the owner's site.origin,
 *                   staging.superstables.com when site.allowStaging, or this computer when site.allowLoopback.
 *   read:           also any other https superstables.com host and this computer: a listing read there asks the owner nothing.
 *
 * @param {TrustPurpose} purpose
 * @param {string | undefined} candidate
 * @param {{ settings?: OwnerSettings }} [options]
 * @returns {{ origin: string, source: "candidate" | "settings" | "default" } | { error: string, ownerCommand?: string }}
 */
export function siteFor(purpose, candidate, options = {}) {
  const got = settingsOr(options.settings);
  // a read of a named site asks the owner nothing: an unusable file does not stop it (the dispatcher refuses the commands that need the file)
  if (got.error && !(purpose === "read" && candidate !== undefined && candidate !== null)) return { error: got.error };
  const s = got.settings ?? defaultOwnerSettings();
  if (candidate === undefined || candidate === null) {
    return { origin: s.site.origin, source: s.site.origin === DEFAULT_SITE ? "default" : "settings" };
  }
  const p = parseSite(candidate);
  if (p.error) return { error: p.error };
  const { origin, host, loopback } = p;
  if (origin === DEFAULT_SITE || origin === s.site.origin) return { origin, source: "candidate" };
  if (origin === STAGING_SITE && s.site.allowStaging) return { origin, source: "candidate" };
  if (loopback && s.site.allowLoopback) return { origin, source: "candidate" };
  if (purpose === "read" && (loopback || (origin.startsWith("https:") && isSuperstablesHost(host)))) return { origin, source: "candidate" };
  const ownerCommand = origin === STAGING_SITE ? `${SETTINGS_COMMAND} allow-staging on` : loopback ? `${SETTINGS_COMMAND} allow-loopback site on` : `${SETTINGS_COMMAND} site ${origin}`;
  return { error: `${origin} is not an approval site the owner allows: approvals use ${s.site.origin} unless the owner runs ${ownerCommand} in their own terminal (an agent never does)`, ownerCommand };
}

/** The settings key of a budget rail and chain: the core chain table's key ("base-sepolia", "tempo-moderato", "solana-devnet"). */
export function budgetChainKey(rail, chain) {
  if (rail === "tempo") return "tempo-moderato";
  if (rail === "solana") return "solana-devnet";
  return chain === "moderato" ? "tempo-moderato" : chain === "devnet" ? "solana-devnet" : chain;
}

/**
 * The RPC for chain `chainKey` and `purpose`. A RpcChoice or { error }.
 *
 *   variable set, "read":                 the variable as given (the file is not read)
 *   variable set, "owner" and "verdict":  only when it is the built-in URL (`fallback`, or one in `builtin`), one of the
 *                                         owner's URLs for the chain (then it is tried first), or names this computer while
 *                                         rpcEnv.allowLoopback is on; else { error }
 *   variable unset:                       the owner's URLs for the chain, else `options.fallback`
 *
 * `ownNode` is true only when urls[0] is the owner's own node. The caller reads the variable and passes its name and
 * value, and the chain table's public URL as `fallback`: this module never reads the environment.
 * @param {string} chainKey
 * @param {TrustPurpose} purpose
 * @param {string | undefined} envValue
 * @param {{ fallback?: string, builtin?: string[], envName?: string, settings?: OwnerSettings }} [options]
 * @returns {RpcChoice | { error: string }}
 */
export function rpcFor(chainKey, purpose, envValue, options = {}) {
  if (!RPC_CHAIN_KEYS.includes(chainKey)) return { error: `no such chain "${String(chainKey).slice(0, 40)}" (the chains are ${RPC_CHAIN_KEYS.join(", ")})` };
  const name = options.envName ?? "the RPC variable";
  const env = typeof envValue === "string" && envValue.trim() !== "" ? envValue.trim() : undefined;
  if (env !== undefined) {
    const problem = ownerRpcUrlProblem(env);
    if (problem) return { error: `${name} is refused: ${problem}` };
    if (purpose === "read") return { url: env, urls: [env], ownNode: false, quorum: 2, source: "env" };
    // the built-in URL is already trusted: a variable that names it (trailing slash or host case aside) is the same RPC
    const builtin = [options.fallback, ...(options.builtin ?? [])].filter((u) => typeof u === "string" && u !== "");
    if (builtin.some((u) => sameRpcUrl(u, env))) return { url: env, urls: [env], ownNode: false, quorum: 2, source: "env", allowedBy: "builtin" };
  }
  const got = settingsOr(options.settings);
  if (got.error) return { error: got.error };
  const s = got.settings;
  const own = Object.hasOwn(s.rpc, chainKey) ? s.rpc[chainKey] : undefined;
  if (env !== undefined) {
    if (own && own.urls.some((u) => sameRpcUrl(u, env))) {
      return { url: env, urls: [env, ...own.urls.filter((u) => !sameRpcUrl(u, env))], ownNode: own.ownNode && sameRpcUrl(env, own.urls[0]), quorum: own.quorum, source: "env", allowedBy: "settings" };
    }
    if (s.rpcEnv.allowLoopback && LOOPBACK.has(new URL(env).hostname)) return { url: env, urls: [env], ownNode: false, quorum: 2, source: "env", allowedBy: "loopback" };
    return { error: `${name} (${shownUrl(env)}) is not an RPC the owner set for ${chainKey}: owner actions and verdicts read only the owner's RPCs or the built-in ones` };
  }
  if (own) return { url: own.urls[0], urls: [...own.urls], ownNode: own.ownNode, quorum: own.quorum, source: "settings" };
  const fallback = options.fallback;
  return { url: fallback, urls: fallback ? [fallback] : [], ownNode: false, quorum: 2, source: "default" };
}

/** Whether the owner allows paying a seller on this computer on a chain that is not a testnet. False on any read error. */
export function loopbackSellersAllowed() {
  const got = settingsOr(undefined);
  return !got.error && got.settings.sellers.allowLoopback === true;
}

/**
 * Writes `next` (the fields in SETTINGS_FIELDS, and a signature when given) as the owner's settings: a new 600 file in the
 * private owner folder, flushed, renamed over the old one, the folder flushed. What the reader would refuse is never written.
 * Only the owner command calls this, after its terminal check.
 * @param {Pick<OwnerSettings, "version" | "site" | "rpc" | "rpcEnv" | "sellers"> & { signature?: Record<string, unknown> }} next
 */
export function writeOwnerSettings(next) {
  const rpc = {};
  // a quorum equal to the one the reader would derive is left out: a lone URL has a derived quorum of 2, which an explicit one could not
  for (const [chain, v] of Object.entries(next.rpc ?? {})) rpc[chain] = { urls: v.urls, ownNode: v.ownNode, ...(v.quorum !== undefined && v.quorum !== (v.ownNode ? 1 : 2) ? { quorum: v.quorum } : {}) };
  const text = `${JSON.stringify({ version: 1, site: next.site, rpc, rpcEnv: next.rpcEnv, sellers: next.sellers, ...(next.signature ? { signature: next.signature } : {}) }, null, 2)}\n`;
  parseOwnerSettings(text); // never write what the reader would refuse
  ensurePrivateDir(ownerDir(), { root: accountStateDir() });
  const path = ownerSettingsPath();
  const tmp = join(ownerDir(), `.settings.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    const data = Buffer.from(text, "utf8");
    let at = 0;
    while (at < data.length) at += writeSync(fd, data, at, data.length - at);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  syncDirectory(ownerDir());
}
