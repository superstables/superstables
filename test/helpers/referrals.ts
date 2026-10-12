// Referral tokens for tests: an Ed25519 key made per test, a signer that writes tokens shaped like the site's, and a
// fake site that publishes the key set and records the seller events it receives. Tests only; the client never signs.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { REFERRAL_TYPE, type ReferralClaims, type ReferralJwk } from "../../src/seller/referral.js";
import { readBody, sendJson, startServer, type TestServer } from "./servers.js";

export interface TestReferralKey {
  kid: string;
  jwk: ReferralJwk;
  privateKey: KeyObject;
}

/** A fresh Ed25519 key, with its key id computed as the site computes it. */
export function referralKey(): TestReferralKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const kid = createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url").slice(0, 16);
  return { kid, jwk: { kty: "OKP", crv: "Ed25519", x, kid, use: "sig", alg: "EdDSA" }, privateKey };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/** A token signed with `key`. Claims default to a valid directory token for https://api.example.com issued now. */
export function signReferral(
  key: TestReferralKey,
  claims: Partial<ReferralClaims> = {},
  header: Record<string, unknown> = {},
): { token: string; claims: ReferralClaims } {
  const iat = Math.floor(Date.now() / 1000);
  const full: ReferralClaims = {
    iss: "https://www.superstables.com",
    jti: `ref_${randomBytes(16).toString("base64url")}`,
    sub: "api.example.com",
    aud: "https://api.example.com",
    sel: "sel_test",
    agr: "agr_test",
    terms: "terms-1",
    ch: "directory",
    iat,
    exp: iat + 24 * 3600,
    ...claims,
  };
  const input = `${b64({ alg: "EdDSA", typ: REFERRAL_TYPE, kid: key.kid, ...header })}.${b64(full)}`;
  const signature = sign(null, Buffer.from(input, "ascii"), key.privateKey).toString("base64url");
  return { token: `${input}.${signature}`, claims: full };
}

export interface ReceivedEvent {
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

export interface FakeReferralSite extends TestServer {
  /** The key set it publishes; replace it to rotate keys. */
  keys: ReferralJwk[];
  /** When set, the keys route answers this status instead: a site that is down. */
  keysStatus?: number;
  /** Delay the keys route's answer by this long. */
  keysDelayMs?: number;
  events: ReceivedEvent[];
  keyReads: number;
  /** Statuses to answer the next event posts with, in order, before answering 200. */
  failNext: number[];
}

/** A site that publishes `keys` and answers seller events the way the API does. */
export async function startFakeReferralSite(keys: ReferralJwk[]): Promise<FakeReferralSite> {
  const state = { keys, events: [] as ReceivedEvent[], keyReads: 0, failNext: [] as number[] } as Pick<
    FakeReferralSite,
    "keys" | "events" | "keyReads" | "failNext" | "keysStatus" | "keysDelayMs"
  >;
  const server = await startServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/superstables-referral-keys.json") {
      state.keyReads += 1;
      if (state.keysDelayMs) await new Promise((resolve) => setTimeout(resolve, state.keysDelayMs));
      if (state.keysStatus) sendJson(res, state.keysStatus, { error: { code: "internal_error", message: "down" } });
      else sendJson(res, 200, { keys: state.keys });
      return;
    }
    if (req.method === "POST" && req.url === "/api/v1/seller/events") {
      const body = JSON.parse((await readBody(req)) || "{}") as Record<string, any>;
      const status = state.failNext.shift();
      if (status !== undefined) {
        sendJson(res, status, { error: { code: status === 429 ? "rate_limited" : "internal_error", message: "try again" } }, status === 429 ? { "retry-after": "0" } : {});
        return;
      }
      if (req.headers.authorization?.startsWith("Bearer sssk_") !== true) {
        sendJson(res, 401, { error: { code: "unauthorized", message: "a seller API key is required" } });
        return;
      }
      const replayed = state.events.some((e) => e.headers["idempotency-key"] === req.headers["idempotency-key"]);
      state.events.push({ headers: req.headers, body });
      sendJson(res, 200, { purchase: { id: "pur_test", status: body.type === "fulfilled" ? "held" : "not_billable", reason: null, fee: null }, replayed });
      return;
    }
    sendJson(res, 404, { error: { code: "not_found", message: "no such path" } });
  });
  return Object.assign(state, server) as FakeReferralSite;
}
