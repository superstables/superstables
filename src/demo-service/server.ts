// The demo market data service: a small paid endpoint we operate ourselves so the payment
// flow can be shown end to end without depending on somebody else's uptime or pricing.
//
// It is a real x402 seller: it answers 402 with its terms, it checks the credential it is
// handed against those terms, and it has a public facilitator verify and settle the transfer
// before it answers. It charges test USDC on Base Sepolia, so no real money ever moves.
//
// Two ordering rules matter and are load bearing:
//   1. the request is validated BEFORE any payment is demanded, so a buyer never pays for a
//      400. A seller that charges first and validates second is a seller that steals.
//   2. the service answers only after the facilitator reports the transfer settled, so the
//      buyer's PAYMENT-RESPONSE header always describes a settlement that actually happened.
//
// It talks to the facilitators directly (a few lines of failover below) rather than through
// the SDK's payment core: the seller side and the buyer side must be able to fail
// independently, and a test that exercises both should not have one of them mock the other.
//
// Two seller features for referrals are off unless the operator switches them on (the CLI reads them
// from the environment, see sellerOptionsFromEnvironment): a claim challenge, which lets the
// operator prove to superstables.com that it controls this host, and referral reporting, which
// verifies the Superstables-Referral header on a paid request and tells superstables.com what
// happened to that purchase. Neither ever changes or delays the answer the buyer gets.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { BASE_SEPOLIA, isSameAddress, toCaip2, usdcRequirement } from "../core/chain.js";
import { DEFAULT_DEMO_SERVICE_PORT } from "../core/home.js";
import { CLAIM_HEADER, DEFAULT_SITE, checkReferral, readReferral } from "../seller/referral.js";
import { ReferralReportError, createReferralReporter, type ReferralEvent, type ReferralSettlement } from "../seller/reporter.js";
import { DEMO_ASSETS, fetchSpotPrices, type PriceLookup, type SpotPrice } from "./prices.js";

/** Public Base Sepolia facilitators, tried in this order. They submit the transfer and pay the gas. */
export const PUBLIC_FACILITATORS = [
  "https://facilitator.x402.rs",
  "https://facilitator.payai.network",
  "https://x402.org/facilitator",
] as const;

const FACILITATOR_TIMEOUT_MS = 20_000;
/** What a call costs unless the operator says otherwise. */
export const DEFAULT_PRICE_DECIMAL = 0.01;

export const SERVICE_NAME = "Superstables demo market data";
export const SERVICE_DESCRIPTION =
  "a controlled test service operated for the Superstables demo; it charges test USDC on Base Sepolia and moves no real money";
export const RESOURCE_DESCRIPTION =
  "Superstables demo market data: spot price and 24h change for one asset (testnet, no real money)";

/** Everything the service needs to answer a request. No port: a handler does not listen. */
export interface DemoHandlerOptions {
  /** Where the money goes: the operator's address on Base Sepolia. */
  payTo: string;
  priceDecimal?: number;
  /** Facilitator base URLs, in failover order. */
  facilitators?: readonly string[];
  /** Silences the per-payment log line. */
  quiet?: boolean;
  /** Where prices come from. Injectable so tests never reach the network. */
  priceSource?: PriceLookup;
  /**
   * A claim challenge from superstables.com (ssc_…): served at /.well-known/superstables.txt and sent as the
   * Superstables-Claim header on every answer of the market endpoint, so the site can confirm this host is the
   * operator's.
   */
  claimChallenge?: string;
  /** Verify Superstables referrals on paid requests and report what happened to each referred purchase. */
  referrals?: SellerReferralOptions;
}

export interface SellerReferralOptions {
  /** The seller API key from the seller portal (sssk_…). */
  apiKey: string;
  /** The site that signs referrals and receives events. Default DEFAULT_SITE. */
  site?: string;
  /** This listing's id in the directory, checked against the token's `sub`. */
  listingId?: string;
  /**
   * This service's public origin (e.g. https://api.example.com), checked against the token's `aud`. Never taken from a
   * request: its Host header is the caller's to choose. With neither this nor `listingId`, referrals are not checked
   * or reported.
   */
  origin?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export interface DemoServiceOptions extends DemoHandlerOptions {
  /** 0 asks the operating system for a free port, which is what tests want. */
  port?: number;
  /**
   * Which interface to bind. Loopback by default, because a seller started by hand on a
   * laptop should not be reachable from the network it is on. A container has no loopback
   * worth serving, so an image sets `SUPERSTABLES_DEMO_HOST=0.0.0.0` instead.
   */
  host?: string;
}

export interface DemoService {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface MarketBody {
  asset: string;
  price_usd: number | null;
  change_24h_pct: number | null;
  as_of: string;
  source: string;
  note?: string;
  paid: { amount: string; asset: "USDC"; network: string; transaction: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(text);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CLAIM_CHALLENGE = /^ssc_[A-Za-z0-9_-]{1,200}$/;

/**
 * The seller referral settings from the environment, all off when unset:
 *   SUPERSTABLES_CLAIM_CHALLENGE  the claim challenge to publish
 *   SUPERSTABLES_SELLER_KEY       the seller API key; switches referral reporting on
 *   SUPERSTABLES_SELLER_SITE      the site (default https://www.superstables.com)
 *   SUPERSTABLES_SELLER_LISTING   this listing's id, checked against the token's `sub`
 *   SUPERSTABLES_SELLER_ORIGIN    this service's public origin, checked against the token's `aud`
 * With a key but neither of the last two, referrals are not checked (the service says so when it starts).
 * Throws on a value that cannot be used; the message never repeats the key.
 */
export function sellerOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): Pick<DemoHandlerOptions, "claimChallenge" | "referrals"> {
  const claim = env.SUPERSTABLES_CLAIM_CHALLENGE?.trim();
  if (claim && !CLAIM_CHALLENGE.test(claim)) {
    throw new Error("SUPERSTABLES_CLAIM_CHALLENGE is not a claim challenge: it is ssc_ followed by base64url characters");
  }
  const apiKey = env.SUPERSTABLES_SELLER_KEY?.trim();
  const site = env.SUPERSTABLES_SELLER_SITE?.trim() || DEFAULT_SITE;
  const listingId = env.SUPERSTABLES_SELLER_LISTING?.trim();
  const rawOrigin = env.SUPERSTABLES_SELLER_ORIGIN?.trim();
  let origin: string | undefined;
  if (rawOrigin) {
    origin = originOf(rawOrigin);
    if (!origin) throw new Error("SUPERSTABLES_SELLER_ORIGIN is not an origin: it is https://<host>, or http://<host>:<port>");
  }
  if (apiKey) {
    try {
      createReferralReporter({ apiKey, site });
    } catch (err) {
      throw new Error(`SUPERSTABLES_SELLER_KEY or SUPERSTABLES_SELLER_SITE cannot be used: ${messageOf(err)}`);
    }
  }
  return {
    ...(claim ? { claimChallenge: claim } : {}),
    ...(apiKey ? { referrals: { apiKey, site, ...(listingId ? { listingId } : {}), ...(origin ? { origin } : {}) } } : {}),
  };
}

function originOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Referral checks and reports for one service, or undefined (said once, in the log) when there is nothing to check a
 * token against: no listing id and no origin. `accept` verifies a token against the site's published keys and never
 * rejects; `report` sends an event once `accept` said yes, in the background, and logs a failure by its error code only.
 */
function referralTracking(options: SellerReferralOptions, log: (line: string) => void) {
  const site = options.site ?? DEFAULT_SITE;
  const reporter = createReferralReporter({ apiKey: options.apiKey, site, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const origin = options.origin === undefined ? undefined : originOf(options.origin);
  if (options.origin !== undefined && !origin) throw new TypeError("referrals.origin is not an http or https origin");
  if (!options.listingId && !origin) {
    log(
      "referrals are not checked or reported: no listing id or origin is set (SUPERSTABLES_SELLER_LISTING or " +
        "SUPERSTABLES_SELLER_ORIGIN), so a token cannot be checked against this listing",
    );
    return undefined;
  }
  const expected = { ...(options.listingId ? { listingId: options.listingId } : {}), ...(origin ? { audience: origin } : {}) };
  return {
    site,
    accept: async (token: string): Promise<boolean> => {
      const result = await checkReferral(token, { site, ...expected, ...(options.fetch ? { fetch: options.fetch } : {}) });
      if (!result.ok) {
        log(result.reason === "keys_unavailable" ? "referral not checked: the site's referral keys could not be read" : `referral not accepted: ${result.reason}`);
      }
      return result.ok;
    },
    report: (accepted: Promise<boolean>, event: ReferralEvent): void => {
      void accepted
        .then(async (ok) => {
          if (!ok) return;
          const answer = await reporter.report(event);
          log(`referral ${event.type} reported: purchase ${answer.purchase.id} is ${answer.purchase.status}${answer.replayed ? " (already recorded)" : ""}`);
        })
        .catch((err: unknown) => {
          log(`referral ${event.type} not reported: ${err instanceof ReferralReportError ? err.code : "error"}`);
        });
    },
  };
}

/**
 * Runs `call` against each facilitator in turn and returns the first ANSWER, not the first
 * success: a facilitator that cannot be reached is skipped, but one that answers "no" has
 * decided, and its answer is returned. Failover is for outages, never for shopping around
 * until some facilitator says yes.
 */
async function firstThatWorks<T>(
  facilitators: readonly string[],
  call: (client: HTTPFacilitatorClient) => Promise<T>,
): Promise<{ result: T; facilitator: string }> {
  const failures: string[] = [];
  for (const url of facilitators) {
    try {
      const result = await call(new HTTPFacilitatorClient({ url, timeoutMs: FACILITATOR_TIMEOUT_MS }));
      return { result, facilitator: url };
    } catch (err) {
      failures.push(`${url}: ${messageOf(err)}`);
    }
  }
  throw new Error(`no facilitator could be reached (${failures.join("; ")})`);
}

/** Two requirements name the same payment: same scheme, network, amount, asset and recipient. */
function matchesOurTerms(accepted: PaymentRequirements | undefined, ours: PaymentRequirements): boolean {
  if (!accepted || typeof accepted !== "object") return false;
  return (
    accepted.scheme === ours.scheme &&
    toCaip2(String(accepted.network ?? "")) === toCaip2(ours.network) &&
    String(accepted.amount ?? "") === ours.amount &&
    typeof accepted.asset === "string" &&
    isSameAddress(accepted.asset, ours.asset) &&
    typeof accepted.payTo === "string" &&
    isSameAddress(accepted.payTo, ours.payTo)
  );
}

/**
 * The absolute URL of this request. The scheme comes from the forwarding header when there is
 * one: behind a proxy or on a serverless platform the connection that reaches this process is
 * plain HTTP, and the resource URL inside the challenge has to be the URL the buyer called.
 */
function requestUrl(req: IncomingMessage): URL {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim();
  const proto = forwarded === "https" || forwarded === "http" ? forwarded : "http";
  return new URL(req.url ?? "/", `${proto}://${req.headers.host ?? "127.0.0.1"}`);
}

/**
 * The whole service as one request handler, so it can be served by a Node server here or by
 * any host that hands a function a node:http-style request and response. Everything it needs
 * is closed over once: the terms it charges, where the money goes, and where prices come from.
 */
export function createDemoHandler(opts: DemoHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const priceDecimal = opts.priceDecimal ?? DEFAULT_PRICE_DECIMAL;
  const facilitators = opts.facilitators ?? PUBLIC_FACILITATORS;
  const priceSource = opts.priceSource ?? fetchSpotPrices;
  const requirement = usdcRequirement(priceDecimal, opts.payTo);
  const network = BASE_SEPOLIA;
  const log = (line: string) => {
    if (!opts.quiet) console.log(`[demo-service] ${line}`);
  };
  const claim = opts.claimChallenge;
  if (claim !== undefined && !CLAIM_CHALLENGE.test(claim)) {
    throw new TypeError("claimChallenge is not a claim challenge: it is ssc_ followed by base64url characters");
  }
  const tracking = opts.referrals ? referralTracking(opts.referrals, log) : undefined;

  const challengeFor = (resourceUrl: string, error: string): PaymentRequired => ({
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: RESOURCE_DESCRIPTION, mimeType: "application/json" },
    accepts: [requirement],
  });

  const send402 = (res: ServerResponse, resourceUrl: string, error: string): void => {
    const body = challengeFor(resourceUrl, error);
    sendJson(res, 402, body, { "payment-required": encodePaymentRequiredHeader(body) });
  };

  const describe = (base: string) => ({
    name: SERVICE_NAME,
    description: SERVICE_DESCRIPTION,
    endpoint: `${base}/v1/market`,
    method: "GET",
    params: [
      {
        name: "asset",
        in: "query",
        required: true,
        description: "which asset to price",
        enum: [...DEMO_ASSETS],
        example: "BTC",
      },
    ],
    price: { amountDecimal: priceDecimal, asset: "USDC", display: `${priceDecimal} USDC` },
    payment: {
      rail: "x402",
      scheme: "exact",
      x402Version: 2,
      network: network.caip2,
      networkLabel: network.label,
      testnet: true,
      payTo: opts.payTo,
      asset: { symbol: "USDC", address: network.usdc.address, decimals: network.usdc.decimals },
    },
    returns: { asset: "string", price_usd: "number|null", change_24h_pct: "number|null", as_of: "ISO 8601", source: "string" },
  });

  const priceFor = async (asset: string): Promise<SpotPrice> => {
    // The buyer has paid by the time this runs: a data outage is reported, never thrown.
    const prices = await priceSource().catch(() => ({}) as Record<string, SpotPrice>);
    return prices[asset] ?? { usd: null, at: new Date().toISOString(), change24hPct: null, source: "unavailable" };
  };

  const handleMarket = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const resourceUrl = url.toString();
    // On every answer of the listed endpoint, whatever its status: superstables.com may read it from any of them.
    if (claim) res.setHeader(CLAIM_HEADER, claim);

    // 1. Validate first. A buyer must never be charged for a request we were going to refuse.
    const raw = url.searchParams.get("asset");
    const asset = (raw ?? "").trim().toUpperCase();
    if (!raw || !raw.trim()) {
      sendJson(res, 400, { error: "the asset parameter is required", allowed: [...DEMO_ASSETS] });
      return;
    }
    if (!(DEMO_ASSETS as readonly string[]).includes(asset)) {
      sendJson(res, 400, { error: `unknown asset "${raw}"`, allowed: [...DEMO_ASSETS] });
      return;
    }

    // 2. No credential: answer with our terms. Reading them costs nothing.
    const header = req.headers["payment-signature"];
    const credentialHeader = Array.isArray(header) ? header[0] : header;
    if (!credentialHeader) {
      send402(res, resourceUrl, "Payment required");
      return;
    }

    let credential: PaymentPayload;
    try {
      credential = decodePaymentSignatureHeader(credentialHeader);
    } catch {
      send402(res, resourceUrl, "the PAYMENT-SIGNATURE header could not be decoded");
      return;
    }

    // 3. The credential must be for the payment we asked for, not for terms of its own.
    if (!matchesOurTerms(credential.accepted, requirement)) {
      send402(res, resourceUrl, "payment does not match this service's terms");
      return;
    }

    // A referral on a paid request is checked alongside the payment, never in its way, and its outcome is reported
    // after the buyer has its answer.
    const referral = tracking ? readReferral(req.headers) : null;
    const accepted = tracking && referral ? tracking.accept(referral.token) : undefined;
    const followUp = (type: "fulfilled" | "failed", settlement?: ReferralSettlement): void => {
      if (!tracking || !referral || !accepted) return;
      tracking.report(accepted, {
        type,
        referral: referral.token,
        ...(referral.purchaseRef ? { purchase_ref: referral.purchaseRef } : {}),
        ...(settlement ? { settlement } : {}),
      });
    };

    // 4. Verify, then settle. Either can say no; only an unreachable facilitator is retried.
    let verified: VerifyResponse;
    try {
      ({ result: verified } = await firstThatWorks(facilitators, (f) => f.verify(credential, requirement)));
    } catch (err) {
      send402(res, resourceUrl, `payment could not be verified: ${messageOf(err)}; nothing was charged`);
      return;
    }
    if (!verified.isValid) {
      send402(res, resourceUrl, verified.invalidReason ?? "the facilitator rejected this payment");
      return;
    }

    let settled: SettleResponse;
    try {
      ({ result: settled } = await firstThatWorks(facilitators, (f) => f.settle(credential, requirement)));
    } catch (err) {
      send402(res, resourceUrl, `payment could not be settled: ${messageOf(err)}`);
      followUp("failed");
      return;
    }
    if (!settled.success) {
      send402(res, resourceUrl, settled.errorReason ?? "the payment did not settle");
      followUp("failed");
      return;
    }

    // 5. Paid. From here the buyer gets an answer whatever the upstream data feed is doing.
    const price = await priceFor(asset);
    const body: MarketBody = {
      asset,
      price_usd: price.usd,
      change_24h_pct: price.change24hPct ?? null,
      as_of: price.at,
      source: price.source ?? "live",
      paid: {
        amount: String(priceDecimal),
        asset: "USDC",
        network: requirement.network,
        transaction: settled.transaction,
      },
    };
    if (body.price_usd === null) {
      body.note = "the payment settled; the upstream price feed was unavailable, so there is no price for this call";
    }
    // Delivered means the whole answer was handed over; a connection that closes first is a delivery error.
    const delivered = new Promise<boolean>((resolve) => {
      res.once("finish", () => resolve(true));
      res.once("close", () => resolve(res.writableFinished));
    });
    sendJson(res, 200, body, { "payment-response": encodePaymentResponseHeader(settled) });
    const payer = settled.payer ?? verified.payer;
    const settlement: ReferralSettlement = {
      network: requirement.network,
      transaction: settled.transaction,
      ...(payer ? { payer } : {}),
      amount: requirement.amount,
      asset: requirement.asset,
      status: "settled",
    };
    void delivered.then((ok) => followUp(ok ? "fulfilled" : "failed", settlement));
    log(
      `${new Date().toISOString()} paid ${asset} ${priceDecimal} USDC payer=${settled.payer ?? verified.payer ?? "unknown"} tx=${settled.transaction}`,
    );
  };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = requestUrl(req);
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "this service answers GET only" });
        return;
      }
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/") {
        sendJson(res, 200, describe(url.origin));
        return;
      }
      if (url.pathname === "/v1/market") {
        await handleMarket(req, res, url);
        return;
      }
      if (url.pathname === "/.well-known/superstables.txt" && claim) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(`superstables-claim=${claim}\n`);
        return;
      }
      sendJson(res, 404, { error: `no such endpoint: ${url.pathname}`, endpoint: "/v1/market" });
    } catch (err) {
      // Nothing above this line should throw; if it does, say so without leaking internals.
      if (!res.headersSent) sendJson(res, 500, { error: "the service failed to answer this request" });
      else res.end();
      log(`unhandled error: ${messageOf(err)}`);
    }
  };
}

/** Runs the service on a loopback port of its own. */
export async function startDemoService(opts: DemoServiceOptions): Promise<DemoService> {
  const priceDecimal = opts.priceDecimal ?? DEFAULT_PRICE_DECIMAL;
  const network = BASE_SEPOLIA;
  const log = (line: string) => {
    if (!opts.quiet) console.log(`[demo-service] ${line}`);
  };
  const handle = createDemoHandler(opts);
  // The handler answers every request itself, including the ones that go wrong, so nothing
  // here has to catch: a rejected promise would be a bug in the handler, not a request error.
  const server = createServer((req, res) => {
    void handle(req, res);
  });

  const port = opts.port ?? DEFAULT_DEMO_SERVICE_PORT;
  const host = opts.host ?? process.env.SUPERSTABLES_DEMO_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  // 0.0.0.0 is not an address anyone can call: the reachable one is whatever the host is
  // published as, so the line a reader can use is the loopback one.
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${boundPort}`;
  log(`${SERVICE_NAME} on ${url} — ${priceDecimal} USDC per call on ${network.label}, paid to ${opts.payTo}`);
  if (opts.claimChallenge) log(`claim challenge served at ${url}/.well-known/superstables.txt and on every answer of /v1/market`);
  if (opts.referrals && (opts.referrals.listingId || opts.referrals.origin)) {
    log(`referrals on paid requests are verified and reported to ${opts.referrals.site ?? DEFAULT_SITE}`);
  }

  return {
    port: boundPort,
    url,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
