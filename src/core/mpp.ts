// The wire format of MPP (the Machine Payments Protocol, https://mpp.dev) as a buyer reads and writes it: the
// `WWW-Authenticate: Payment ...` challenges a seller's 402 carries, the `Authorization: Payment ...` credential sent back,
// and the seller's `Payment-Receipt`. Written out here rather than taken from the mppx SDK, which only the budget bundles;
// tests check this file against mppx itself.
//
// Nothing here judges whether a challenge can be paid (src/core/rails/tempo.ts does): this only reads what the seller
// wrote, refuses what is malformed, and keeps the challenge's request exactly as it arrived, because the credential
// must carry it back unchanged (the seller's challenge id is an HMAC over it).

/** One `Payment` challenge, as the seller wrote it. */
export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** The `request` parameter exactly as received (base64url of JSON): sent back verbatim in the credential. */
  requestRaw: string;
  /** That request, decoded. */
  request: Record<string, unknown>;
  description?: string;
  digest?: string;
  /** ISO 8601: after this the seller no longer accepts a credential for this challenge. */
  expires?: string;
  /** The HTTP field the seller wants the credential in, when it is not Authorization. */
  header?: string;
  opaque?: string;
}

/** As in mppx: a request parameter longer than this is not a challenge. */
const MAX_REQUEST_PARAM = 16 * 1024;
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
/** ISO 8601 date-time in UTC, the shape mppx writes and checks (zod's datetime). */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Every `Payment` challenge in a WWW-Authenticate value, in order. A malformed one is skipped, not fatal: a seller may
 * offer other methods next to the one this client pays with. Returns [] when there is none.
 */
export function parseMppChallenges(header: string | null | undefined): MppChallenge[] {
  if (!header) return [];
  const starts = schemeStarts(header, "Payment");
  const out: MppChallenge[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : header.length;
    const chunk = header.slice(start + "Payment".length, end).replace(/,\s*$/, "");
    try {
      const challenge = fromParams(parseAuthParams(chunk));
      if (challenge) out.push(challenge);
    } catch {
      // a malformed challenge: skipped
    }
  });
  return out;
}

function fromParams(params: Record<string, string>): MppChallenge | undefined {
  const { id, realm, method, intent, request, description, digest, expires, header, opaque } = params;
  if (!id || realm === undefined || !method || intent === undefined || !request) return undefined;
  if (!/^[a-z][a-z0-9:_-]*$/.test(method)) return undefined;
  if (request.length > MAX_REQUEST_PARAM || !BASE64URL_RE.test(request)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(request, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
  if (expires !== undefined && (!DATETIME_RE.test(expires) || Number.isNaN(Date.parse(expires)))) return undefined;
  if (digest !== undefined && !/^sha-256=/.test(digest)) return undefined;
  if (header !== undefined && !TOKEN_RE.test(header)) return undefined;
  return {
    id,
    realm,
    method,
    intent,
    requestRaw: request,
    request: decoded as Record<string, unknown>,
    ...(description !== undefined ? { description } : {}),
    ...(digest !== undefined ? { digest } : {}),
    ...(expires !== undefined ? { expires } : {}),
    // Authorization is the default and is not carried as a header parameter, as mppx does.
    ...(header !== undefined && header.toLowerCase() !== "authorization" ? { header } : {}),
    ...(opaque !== undefined ? { opaque } : {}),
  };
}

/** Where each `Payment` scheme starts in a header value, ignoring anything inside quoted strings. */
function schemeStarts(value: string, token: string): number[] {
  const starts: number[] = [];
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inQuotes = false;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (value.slice(i, i + token.length).toLowerCase() !== token.toLowerCase()) continue;
    const next = value[i + token.length];
    if (!next || !/\s/.test(next)) continue;
    let boundary = i - 1;
    while (boundary >= 0 && /\s/.test(value[boundary])) boundary--;
    if (boundary >= 0 && value[boundary] !== ",") continue;
    starts.push(i);
  }
  return starts;
}

/** auth-params (RFC 9110): key=value or key="quoted \"value\"", comma separated. A repeated key is malformed. */
function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i])) i++;
    if (i >= input.length) break;
    const keyStart = i;
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i])) i++;
    const key = input.slice(keyStart, i).toLowerCase();
    if (!key) throw new Error("malformed auth-param");
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] !== "=") break;
    i++;
    while (i < input.length && /\s/.test(input[i])) i++;
    let value: string;
    if (input[i] === '"') {
      [value, i] = readQuoted(input, i + 1);
    } else {
      const start = i;
      while (i < input.length && input[i] !== ",") i++;
      value = input.slice(start, i).trim();
    }
    if (key in result) throw new Error(`duplicate parameter ${key}`);
    result[key] = value;
  }
  return result;
}

function readQuoted(input: string, start: number): [string, number] {
  let out = "";
  let i = start;
  while (i < input.length) {
    const char = input[i];
    i++;
    if (char === "\\") {
      const next = input[i];
      // \uXXXX: a character above Latin-1, as mppx escapes it
      const hex = next === "u" ? input.slice(i + 1, i + 5) : undefined;
      if (hex && /^[0-9A-Fa-f]{4}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 5;
      } else if (next !== undefined) {
        out += next;
        i++;
      }
      continue;
    }
    if (char === '"') return [out, i];
    out += char;
  }
  throw new Error("unterminated quoted string");
}

/**
 * The credential for a payment the owner's own wallet sent (push mode), as mppx's client writes it: the challenge (its
 * request as received), `{ type: "hash", hash }`, and who paid, as a did:pkh. Goes in the Authorization header.
 */
export function hashCredential(challenge: MppChallenge, hash: string, payer: { address: string; chainId: number }): string {
  const wire = {
    challenge: {
      id: challenge.id,
      realm: challenge.realm,
      method: challenge.method,
      intent: challenge.intent,
      request: challenge.requestRaw,
      ...(challenge.description !== undefined ? { description: challenge.description } : {}),
      ...(challenge.digest !== undefined ? { digest: challenge.digest } : {}),
      ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
      ...(challenge.header !== undefined ? { header: challenge.header } : {}),
      ...(challenge.opaque !== undefined ? { opaque: challenge.opaque } : {}),
    },
    payload: { hash, type: "hash" },
    source: `did:pkh:eip155:${payer.chainId}:${payer.address}`,
  };
  return `Payment ${Buffer.from(JSON.stringify(wire), "utf8").toString("base64url")}`;
}

/** The seller's `Payment-Receipt`, decoded, or undefined. Its fields are the seller's words. */
export function readMppReceipt(header: string | null | undefined): { status?: unknown; reference?: unknown; method?: unknown } | undefined {
  if (!header || header.length > 4_000 || !BASE64URL_RE.test(header.trim())) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(header.trim(), "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
