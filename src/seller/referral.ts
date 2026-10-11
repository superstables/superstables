// Referral tokens, seen from the seller's side. When a buyer finds a listing in the Superstables
// directory and pays it, the buyer's request carries the listing's referral token. The token is a
// compact JWS signed with Ed25519 by superstables.com; its public keys are published at
// /.well-known/superstables-referral-keys.json, so a seller checks a token without asking anyone.
// Node built-ins only: no JOSE library is needed for one algorithm.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** The request header that carries the referral token. */
export const REFERRAL_HEADER = "superstables-referral";
/** The request header that names the purchase, stable across retries of the same purchase. */
export const PURCHASE_REF_HEADER = "superstables-purchase-ref";
/** The response header a listed endpoint can answer with to prove control of its host. */
export const CLAIM_HEADER = "superstables-claim";
/** The site that issues referral tokens and receives seller events. */
export const DEFAULT_SITE = "https://www.superstables.com";

/** The `typ` every referral token's header carries. */
export const REFERRAL_TYPE = "superstables-referral+jwt";

/** Longer than any token the site issues; anything longer is refused before it is parsed. */
const MAX_TOKEN_LENGTH = 4_096;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PURCHASE_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ReferralClaims {
  /** The issuing site's origin. */
  iss: string;
  /** Referral id. */
  jti: string;
  /** Listing id in the directory. */
  sub: string;
  /** The listing's origin. */
  aud: string;
  /** Seller account id. */
  sel: string;
  /** Agreement id. */
  agr: string;
  /** Terms version. */
  terms: string;
  /** `directory` for a token from the directory API, `hosted` for a purchase on superstables.com. */
  ch: "directory" | "hosted";
  /** For `hosted` only: the purchase id on superstables.com. */
  pur?: string;
  /** Issued at, in seconds. */
  iat: number;
  /** Expires at, in seconds. */
  exp: number;
}

/** One public key of the published key set. */
export interface ReferralJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use?: string;
  alg?: string;
}

export interface ReferralKeySet {
  keys: ReferralJwk[];
}

/** Why a token was not accepted. */
export type ReferralRejection =
  | "malformed"
  | "unsupported_header"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "no_audience"
  | "invalid_options"
  | "keys_unavailable";

export type ReferralVerification = { ok: true; claims: ReferralClaims } | { ok: false; reason: ReferralRejection };

export interface VerifyReferralOptions {
  /** The published key set, or its keys. */
  keys: ReferralKeySet | readonly ReferralJwk[];
  /** The site expected in `iss`, e.g. DEFAULT_SITE. */
  issuer: string;
  /** This service's origin, checked against `aud`. */
  audience?: string;
  /** This service's listing id, checked against `sub`. Either this or `audience` must match. */
  listingId?: string;
  /** The time of the request. Default: now. An invalid Date is refused with `invalid_options`. */
  now?: Date;
  /** Clock skew allowed either side of `iat` and `exp`, a finite number of seconds >= 0. Default 60. */
  skewSeconds?: number;
}

/** Does this look like a compact JWS short enough to be a referral token? Says nothing about its signature. */
export function isReferralToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && COMPACT_JWS.test(value);
}

/** A purchase reference as the headers allow it: 1 to 128 characters of A-Z, a-z, 0-9 and `._:-`. */
export function isPurchaseRef(value: unknown): value is string {
  return typeof value === "string" && PURCHASE_REF.test(value);
}

function part(segment: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A token's header and payload, decoded WITHOUT checking the signature. Use it to read the referral id for a
 * record, never to decide whether to trust the token: that is verifyReferral.
 */
export function decodeReferral(token: unknown): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  if (!isReferralToken(token)) return undefined;
  const [h, p] = token.split(".");
  const header = part(h!);
  const payload = part(p!);
  return header && payload ? { header, payload } : undefined;
}

function originOf(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

function publicKey(jwk: ReferralJwk): KeyObject | undefined {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  } catch {
    return undefined;
  }
}

function isEd25519(jwk: unknown): jwk is ReferralJwk {
  const j = jwk as Record<string, unknown> | null;
  return (
    !!j &&
    typeof j === "object" &&
    j.kty === "OKP" &&
    j.crv === "Ed25519" &&
    typeof j.x === "string" &&
    typeof j.kid === "string" &&
    (j.alg === undefined || j.alg === "EdDSA") &&
    (j.use === undefined || j.use === "sig")
  );
}

const shortString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300;

/**
 * Check a referral token: an EdDSA signature by a published key, the expected issuer, this service's origin in `aud`
 * (or its listing id in `sub`), and validity at the time of the request within the clock skew. Never throws: anything
 * wrong with the token is a rejection with a reason.
 */
export function verifyReferral(token: unknown, options: VerifyReferralOptions): ReferralVerification {
  const skew = options.skewSeconds ?? 60;
  const at = options.now ?? new Date();
  // A skew or a time that is not a number would make every comparison below false, and an expired token pass.
  if (typeof skew !== "number" || !Number.isFinite(skew) || skew < 0 || !(at instanceof Date) || !Number.isFinite(at.getTime())) {
    return { ok: false, reason: "invalid_options" };
  }
  const now = Math.floor(at.getTime() / 1000);
  if (options.audience === undefined && options.listingId === undefined) return { ok: false, reason: "no_audience" };

  const decoded = decodeReferral(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  const { header, payload } = decoded;
  // `crit` names header parameters a verifier must understand; this one understands none beyond these.
  if (header.alg !== "EdDSA" || header.typ !== REFERRAL_TYPE || typeof header.kid !== "string" || "crit" in header) {
    return { ok: false, reason: "unsupported_header" };
  }

  const list: readonly unknown[] = Array.isArray(options.keys) ? options.keys : ((options.keys as ReferralKeySet)?.keys ?? []);
  const jwk = list.find((k): k is ReferralJwk => isEd25519(k) && k.kid === header.kid);
  const key = jwk ? publicKey(jwk) : undefined;
  if (!key) return { ok: false, reason: "unknown_key" };

  const [h, p, s] = (token as string).split(".");
  let good = false;
  try {
    good = verify(null, Buffer.from(`${h}.${p}`, "ascii"), key, Buffer.from(s!, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad_signature" };

  const c = payload as Partial<ReferralClaims>;
  if (![c.iss, c.jti, c.sub, c.aud, c.sel, c.agr, c.terms].every(shortString)) return { ok: false, reason: "malformed" };
  if (c.ch !== "directory" && c.ch !== "hosted") return { ok: false, reason: "malformed" };
  if (c.pur !== undefined && !shortString(c.pur)) return { ok: false, reason: "malformed" };
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) || c.exp! <= c.iat!) return { ok: false, reason: "malformed" };

  if (c.iss !== originOf(options.issuer)) return { ok: false, reason: "wrong_issuer" };
  const audienceMatches = options.audience !== undefined && c.aud === originOf(options.audience);
  const listingMatches = options.listingId !== undefined && c.sub === options.listingId;
  if (!audienceMatches && !listingMatches) return { ok: false, reason: "wrong_audience" };
  if (now > c.exp! + skew) return { ok: false, reason: "expired" };
  if (now < c.iat! - skew) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims: c as ReferralClaims };
}

/** Request headers as a Fetch `Headers`, Node's `IncomingHttpHeaders`, or a plain object. */
export type HeaderSource = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The referral a request carries: the token, and the purchase reference when the buyer sent a valid one. Null when the
 * request has no referral header, or its value is not shaped like a token. The token is not verified here.
 */
export function readReferral(headers: HeaderSource): { token: string; purchaseRef?: string } | null {
  const token = header(headers, REFERRAL_HEADER)?.trim();
  if (!isReferralToken(token)) return null;
  const ref = header(headers, PURCHASE_REF_HEADER)?.trim();
  return isPurchaseRef(ref) ? { token, purchaseRef: ref } : { token };
}

// ── The published keys ──────────────────────────────────────────────────────────────────

const KEYS_PATH = "/.well-known/superstables-referral-keys.json";
const KEYS_CACHE_MS = 10 * 60_000;
/** A refresh asked for (a token named a key the cached set does not have) reads the keys again at most this often. */
const KEYS_REFRESH_MS = 60_000;
const KEYS_TIMEOUT_MS = 8_000;
const keyCache = new Map<string, { at: number; keys: Promise<ReferralKeySet> }>();

/**
 * The site's base URL, checked: https, or plain http on this machine. A seller's API key travels there, and the keys
 * that decide which tokens are genuine come from there.
 */
export function siteUrl(site: string): URL {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new TypeError(`the site is not a URL: ${JSON.stringify(site)}`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(`the site must be https, or plain http on this machine (got ${url.origin})`);
  }
  return url;
}

/**
 * The site's published referral keys, read once per ten minutes per site. `refresh` reads them again sooner, for a
 * token signed by a key the cached set does not have (the site rotated its key), but at most once a minute per site.
 * Throws when the keys cannot be read; keys that are not Ed25519 public keys are left out.
 */
export function fetchReferralKeys(site: string = DEFAULT_SITE, options: { fetch?: typeof fetch; refresh?: boolean } = {}): Promise<ReferralKeySet> {
  const url = new URL(KEYS_PATH, siteUrl(site)).toString();
  const cached = keyCache.get(url);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < (options.refresh ? KEYS_REFRESH_MS : KEYS_CACHE_MS)) return cached.keys;
  const doFetch = options.fetch ?? fetch;
  const keys = (async () => {
    const res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(KEYS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the referral keys could not be read (HTTP ${res.status})`);
    const body = (await res.json().catch(() => undefined)) as { keys?: unknown } | undefined;
    if (!body || !Array.isArray(body.keys)) throw new Error("the referral keys answer is not a key set");
    return { keys: body.keys.filter(isEd25519).map(({ kty, crv, x, kid, use, alg }) => ({ kty, crv, x, kid, ...(use ? { use } : {}), ...(alg ? { alg } : {}) })) };
  })();
  keyCache.set(url, { at: Date.now(), keys });
  // A failed read is not remembered: the next request tries again.
  keys.catch(() => {
    if (keyCache.get(url)?.keys === keys) keyCache.delete(url);
  });
  return keys;
}

/** Forget every cached key set. */
export function clearReferralKeysCache(): void {
  keyCache.clear();
}

export interface CheckReferralOptions extends Omit<VerifyReferralOptions, "keys" | "issuer"> {
  /** The site that signs the tokens and publishes the keys. Default DEFAULT_SITE; it is also the expected issuer. */
  site?: string;
  fetch?: typeof fetch;
}

/**
 * verifyReferral with the site's published keys: reads them (cached), reads them once more when the token names a key
 * the cached set does not have (at most once a minute per site), and answers `keys_unavailable` when the keys cannot
 * be read. Never throws, so a site outage never fails the request being checked.
 */
export async function checkReferral(token: unknown, options: CheckReferralOptions = {}): Promise<ReferralVerification> {
  const { site = DEFAULT_SITE, fetch: doFetch, ...rest } = options;
  try {
    const keys = await fetchReferralKeys(site, doFetch ? { fetch: doFetch } : {});
    const first = verifyReferral(token, { ...rest, keys, issuer: site });
    if (first.ok || first.reason !== "unknown_key") return first;
    const fresh = await fetchReferralKeys(site, { ...(doFetch ? { fetch: doFetch } : {}), refresh: true });
    return fresh === keys ? first : verifyReferral(token, { ...rest, keys: fresh, issuer: site });
  } catch {
    return { ok: false, reason: "keys_unavailable" };
  }
}
