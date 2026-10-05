// Finding something to pay for. Three sources, deliberately kept apart:
//
//   the built-in catalogue   two services on the testnet with their request parameters
//                            written down: one run by us, one run by a third party. These
//                            are the listings this release can call end to end without a
//                            human reading docs, and they work with no network at all.
//   the hosted catalogue     the paid demo endpoints Superstables operates, published by
//                            the website in this same shape, parameters included. A new
//                            demo service there reaches agents without a client release.
//   the Superstables index   the public directory of x402 services. It records what a
//                            service costs and where it lives, but not yet the request
//                            parameters it needs, so those listings are shown and not
//                            acted on. Saying why is the point: an agent that cannot
//                            pay something should be able to explain the reason.
//
// The hosted catalogue and the index are nice-to-haves: if either is slow or down,
// discovery still works from the built-in catalogue and the caller gets a warning rather
// than an error.

import { z } from "zod";
import { describeNetwork, networkFor, toCaip2 } from "./chain.js";
import { SUPPORTED_NETWORKS } from "./rails/index.js";
import { chainName, isKnownChainName, isKnownRail, payNetworkFor, routesFor } from "./routes.js";
import { SellerTextError, untrustedText } from "./text.js";
import type { ResolvedRequest, ServiceListing, ServiceParam } from "./types.js";

export const DEMO_SERVICE_ID = "superstables-demo-market-data";
export const EXTERNAL_COIN_PRICE_ID = "x402-coin-api.vercel.app";

/**
 * Where the demo service answers. Superstables runs it on the testnet, so a user does not have
 * to run anything to have something to buy; `SUPERSTABLES_DEMO_SERVICE_URL` points at another
 * instance, which is what `superstables demo-service` on this machine needs.
 */
export const HOSTED_DEMO_SERVICE_URL = "https://www.superstables.com/api/demo/market";

/** The public index Superstables runs: every x402 service it has found, with rails, chains and price. */
export const DEFAULT_INDEX_URL = "https://www.superstables.com/api/v1/services";

/** Where the public index lives, as this process started. Kept for SDK users; the code reads indexUrl(). */
export const INDEX_URL = process.env.SUPERSTABLES_INDEX_URL ?? DEFAULT_INDEX_URL;

/**
 * The index to read, or undefined when it is switched off. SUPERSTABLES_INDEX_URL points at
 * another index that answers the same API (a self-hosted one, say); the empty string or "off"
 * switches the index off, and discovery then lists the built-in catalogue only.
 */
export function indexUrl(): string | undefined {
  const raw = process.env.SUPERSTABLES_INDEX_URL;
  if (raw === undefined) return DEFAULT_INDEX_URL;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "off") return undefined;
  return trimmed;
}

/** Where the hosted catalogue lives: every paid demo endpoint the website operates, with parameters. */
export const HOSTED_CATALOGUE_URL = "https://www.superstables.com/api/demo/catalogue";

/**
 * The hosted catalogue to read, or undefined when it is switched off. SUPERSTABLES_CATALOGUE_URL
 * points at another deployment (a local `next dev`, say); the empty string or "off" disables it,
 * which is what an air-gapped test wants.
 */
export function hostedCatalogueUrl(): string | undefined {
  const raw = process.env.SUPERSTABLES_CATALOGUE_URL;
  if (raw === undefined) return HOSTED_CATALOGUE_URL;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "off") return undefined;
  return trimmed;
}

/**
 * Is the hosted catalogue switched on? SUPERSTABLES_DEMO_SERVICES=on (or 1, true, yes) includes
 * Superstables' testnet services from the hosted catalogue in discovery: most return prepared
 * sample output (mock: true); the market data service returns live prices. Off, the default, never reads
 * the catalogue, so a client that was not set up for the demo never sees a simulated listing.
 * The demo page's configuration snippets switch it on.
 */
export function demoServicesEnabled(): boolean {
  const raw = (process.env.SUPERSTABLES_DEMO_SERVICES ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true" || raw === "yes";
}

const INDEX_TIMEOUT_MS = 5_000;
const CATALOGUE_TIMEOUT_MS = 5_000;
const CATALOGUE_CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 3_000;
const DEFAULT_LIMIT = 20;

/** Words that should surface the demo service even though its text does not contain them. */
const DEMO_KEYWORDS = [
  "btc", "bitcoin", "eth", "ether", "ethereum", "crypto", "market", "market data", "data",
  "price", "prices", "quote", "demo", "example", "test", "testnet", "usdc", "superstables", "x402",
];

export interface FindServicesOptions {
  /** Free text. Empty or missing means "show me what there is". */
  query?: string;
  /** Most services to return, across both sources. */
  limit?: number;
  /** Ask the Superstables index too. On by default. */
  includeIndex?: boolean;
  /** Check that the demo service is actually answering. Costs one HTTP request. */
  probe?: boolean;
  /** Include Superstables' testnet services from the hosted catalogue (most simulated). Default: the SUPERSTABLES_DEMO_SERVICES switch. */
  demoServices?: boolean;
}

/** Discovery never fails because a remote source did: what went wrong comes back as a warning. */
export interface DiscoveryResult {
  services: ServiceListing[];
  warnings: string[];
}

/** Rails, chains and routes of a listing paid with x402 on Base Sepolia, like every built-in one. */
const BASE_SEPOLIA_X402: Pick<ServiceListing, "rails" | "chains" | "routes"> = {
  rails: ["x402"],
  chains: ["base-sepolia"],
  routes: routesFor(["x402"], ["base-sepolia"]),
};

/** The one service this release can discover, quote and pay without any further setup. */
export function demoService(): ServiceListing {
  const endpoint = process.env.SUPERSTABLES_DEMO_SERVICE_URL ?? HOSTED_DEMO_SERVICE_URL;
  const params: ServiceParam[] = [
    {
      name: "asset",
      in: "query",
      required: true,
      description: "Which asset to return market data for",
      example: "BTC",
      enum: ["BTC", "ETH"],
    },
  ];
  return {
    id: DEMO_SERVICE_ID,
    name: "Superstables demo market data",
    description:
      "Market data for BTC and ETH, priced per request and paid with test USDC on Base Sepolia. " +
      "A controlled service that exists so a payment can be demonstrated end to end without spending real money.",
    endpoint,
    method: "GET",
    params,
    payment: {
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.01, asset: "USDC", display: "0.01 USDC per request" },
    },
    operator: "Superstables (demo service on the testnet)",
    source: "demo-catalogue",
    testnet: true,
    // Live spot prices, not prepared output: the payment is the demo, the data is real.
    mock: false,
    actionable: true,
    ...BASE_SEPOLIA_X402,
  };
}

/**
 * A paid endpoint on Base Sepolia that somebody else runs. It is listed here, and not only
 * in the index, because the index does not yet record the one query parameter it needs.
 * Paying a seller nobody on our side controls is the point of listing it.
 */
export function externalCoinPriceService(): ServiceListing {
  return {
    id: EXTERNAL_COIN_PRICE_ID,
    name: "Coin price API (third party)",
    description:
      "Current price in USD for a coin symbol, paid per request with test USDC on Base Sepolia. " +
      "Run by an independent developer, not by Superstables; listed because it is live on the testnet.",
    endpoint: "https://x402-coin-api.vercel.app/api/price",
    method: "GET",
    params: [
      {
        name: "symbol",
        in: "query",
        required: true,
        description: "Coin symbol. BTC is the one this service has answered reliably; in our tests it returned bitcoin for other symbols too",
        enum: ["BTC"],
        example: "BTC",
      },
    ],
    payment: {
      rail: "x402",
      scheme: "exact",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      asset: "USDC",
      price: { amountDecimal: 0.001, asset: "USDC", display: "0.001 USDC per request" },
    },
    operator: "Third party (not operated by Superstables)",
    source: "demo-catalogue",
    testnet: true,
    actionable: true,
    ...BASE_SEPOLIA_X402,
  };
}

/** Every built-in listing this release can call as-is: ours first, then the third-party one. */
export function catalogue(): ServiceListing[] {
  return [demoService(), externalCoinPriceService()];
}

/**
 * The built-in catalogue plus whatever the hosted catalogue adds to it. The built-in listings
 * are authoritative for the ids they know (they work with no network, and they honour
 * SUPERSTABLES_DEMO_SERVICE_URL); hosted entries with other ids follow them. When the hosted
 * catalogue cannot be read, discovery carries on from the built-in listings and says so.
 */
export async function allListings(
  options: { includeHosted?: boolean; demoServices?: boolean } = {},
): Promise<{ listings: ServiceListing[]; warnings: string[] }> {
  const { includeHosted = true, demoServices = demoServicesEnabled() } = options;
  const builtIn = catalogue();
  const url = hostedCatalogueUrl();
  // The hosted catalogue holds Superstables' testnet services, most of them simulated: it is read only for the demo.
  if (!includeHosted || !demoServices || !url) return { listings: builtIn, warnings: [] };

  const warnings: string[] = [];
  let hosted: ServiceListing[];
  try {
    hosted = await fetchHostedCatalogue(url);
  } catch (err) {
    warnings.push(`The hosted catalogue could not be read (${message(err)}); showing the built-in listings only.`);
    return { listings: builtIn, warnings };
  }

  const known = new Set(builtIn.map((s) => s.id));
  const merged = [...builtIn];
  for (const listing of hosted) {
    if (known.has(listing.id)) continue;
    merged.push(listing);
    known.add(listing.id);
  }
  return { listings: merged, warnings };
}

/**
 * Search both sources. The catalogue comes first when the query plausibly asks for it,
 * because those are the listings that can be paid; index results follow.
 */
export async function findServices(options: FindServicesOptions = {}): Promise<DiscoveryResult> {
  const { query = "", limit = DEFAULT_LIMIT, includeIndex = true, probe = false, demoServices } = options;

  // Network sources (the hosted catalogue and the index) are both behind includeIndex, so a
  // caller that asked for no network gets none. They are read side by side.
  const [{ listings, warnings }, index] = await Promise.all([
    allListings({ includeHosted: includeIndex, demoServices }),
    includeIndex && indexUrl()
      ? fetchIndex(query, limit).then((rows) => ({ rows, error: undefined })).catch((err: unknown) => ({ rows: [] as ServiceListing[], error: message(err) }))
      : Promise.resolve({ rows: [] as ServiceListing[], error: undefined }),
  ]);
  if (index.error !== undefined) {
    warnings.push(`The Superstables index could not be read (${index.error}); showing the built-in catalogue only.`);
  }

  // Catalogue listings that plausibly match, best match first: with a dozen prepared services
  // in the catalogue, "transcribe this clip" must put the transcription service ahead of the
  // ones that merely share the demo vocabulary. Ties keep catalogue order. A listing that only
  // matched through the demo vocabulary goes after the index, so index results stay visible.
  const matched = listings
    .map((listing, order) => ({ listing, order, score: relevance(query, listing) }))
    .filter(({ listing }) => matchesCatalogue(query, listing))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const words = queryWords(query).length > 0;
  // Simulated listings, when the demo switch let them in at all, come after every real seller.
  const real = matched.filter((m) => !m.listing.mock);
  const simulated = matched.filter((m) => m.listing.mock).map((m) => m.listing);
  const byWords = real.filter((m) => m.score > 0 || !words).map((m) => m.listing);
  const byVocabulary = real.filter((m) => m.score === 0 && words).map((m) => m.listing);
  const ordered = [...byWords, ...index.rows, ...byVocabulary, ...simulated].slice(0, Math.max(0, limit));

  // Probe only what is being returned, and only listings that could be paid; side by side,
  // so a slow seller costs one timeout rather than one per listing.
  const services = probe
    ? await Promise.all(ordered.map((listing) => (listing.source === "demo-catalogue" && listing.actionable ? probeDemo(listing) : listing)))
    : ordered;
  return { services, warnings };
}

/** One listing by id, from either source. Undefined when nothing has that id. */
export async function getService(
  id: string,
  options: { includeIndex?: boolean; probe?: boolean; demoServices?: boolean } = {},
): Promise<ServiceListing | undefined> {
  const { includeIndex = true, probe = false, demoServices } = options;
  // Built-in first, without a network round trip: the demo service is known offline.
  const builtIn = catalogue().find((s) => s.id === id);
  if (builtIn) return probe ? await probeDemo(builtIn) : builtIn;
  const { listings } = await allListings({ includeHosted: includeIndex, demoServices });
  const listed = listings.find((s) => s.id === id);
  if (listed) return probe ? await probeDemo(listed) : listed;
  if (!includeIndex || !indexUrl()) return undefined;
  try {
    const found = await fetchIndex(id, DEFAULT_LIMIT);
    return found.find((s) => s.id === id);
  } catch {
    return undefined; // an unreachable index is not an answer, and not a crash either
  }
}

/**
 * Turn a listing plus the caller's parameters into the exact URL that will be quoted and
 * paid. Refuses before any money is involved, with one sentence naming what is wrong and
 * what would be right.
 */
export function resolveRequest(service: ServiceListing, params: Record<string, string>): ResolvedRequest {
  const problems: string[] = [];
  const given: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") given[key] = String(value);
  }

  for (const param of service.params) {
    const value = given[param.name];
    if (value === undefined) {
      if (param.required) problems.push(`${param.name} is required${allowed(param)}`);
      continue;
    }
    if (param.enum && param.enum.length > 0 && !param.enum.some((v) => v.toLowerCase() === value.toLowerCase())) {
      problems.push(`${param.name}="${value}" is not one of ${param.enum.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    // Parameter names and allowed values are the listing's, so they are the detail, not the client's sentence.
    throw new SellerTextError("The parameters given do not match what this service's listing asks for", `${service.name}: ${problems.join("; ")}`);
  }

  const url = new URL(service.endpoint);
  // Declared parameters first, in the order the service documents them, so two identical
  // calls always produce the same URL; anything else the caller passed follows.
  const ordered = [
    ...service.params.map((p) => p.name).filter((name) => given[name] !== undefined),
    ...Object.keys(given).filter((name) => !service.params.some((p) => p.name === name)),
  ];
  const resolved: Record<string, string> = {};
  for (const name of ordered) {
    const param = service.params.find((p) => p.name === name);
    // Match the documented spelling of an enum value, so the seller sees what it published.
    const value = param?.enum?.find((v) => v.toLowerCase() === given[name].toLowerCase()) ?? given[name];
    url.searchParams.set(name, value);
    resolved[name] = value;
  }

  return { serviceId: service.id, method: "GET", url: url.toString(), params: resolved };
}

// ── The built-in catalogue ─────────────────────────────────────────────────────────────

/** Words that say nothing about which service is wanted: articles, glue, and the verbs every request uses. */
const STOPWORDS = new Set([
  "the", "this", "that", "these", "those", "for", "and", "with", "from", "into", "onto", "about",
  "get", "buy", "find", "give", "show", "tell", "use", "using", "need", "want", "please", "can", "could",
  "you", "your", "our", "its", "some", "one", "any", "all", "how", "what", "which", "who",
  "paid", "pay", "service", "services", "provider",
]);

/** The words of a query worth matching on: three letters or more and not a stopword. */
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** "transcribe" and "transcription" share their first six letters; "transaction" does not. */
function stem(word: string): string {
  return word.length > 6 ? word.slice(0, 6) : word;
}

/** What a listing says about itself, lowercased: its id and name count double against the rest. */
function ownText(listing: ServiceListing): { strong: string; weak: string } {
  return {
    strong: [listing.id, listing.name].join(" ").toLowerCase(),
    weak: [
      listing.description,
      listing.operator ?? "",
      ...listing.params.flatMap((p) => [p.name, p.description ?? "", p.example ?? "", ...(p.enum ?? [])]),
    ]
      .join(" ")
      .toLowerCase(),
  };
}

/** How well the listing itself answers the query's words. Zero for an empty query. */
function relevance(query: string, listing: ServiceListing): number {
  const { strong, weak } = ownText(listing);
  let score = 0;
  for (const word of queryWords(query)) {
    const s = stem(word);
    if (strong.includes(s)) score += 2;
    else if (weak.includes(s)) score += 1;
  }
  return score;
}

/**
 * Does this query plausibly ask for a catalogue listing? An empty query asks for everything.
 * The demo vocabulary ("bitcoin", "price", "testnet"...) surfaces the market data service
 * alone: it is what a person trying the demo asks for, and it must not drag every other
 * listing along.
 */
function matchesCatalogue(query: string, listing: ServiceListing): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  if (relevance(query, listing) > 0) return true;
  if (listing.id !== DEMO_SERVICE_ID) return false;
  return words.some((word) => DEMO_KEYWORDS.some((keyword) => keyword.includes(stem(word))));
}

/**
 * Is a catalogue service answering? A paid endpoint proves it is alive by asking for payment:
 * a 402 is the healthy answer. Anything else, including silence, means "not right now".
 */
async function probeDemo(service: ServiceListing): Promise<ServiceListing> {
  const url = service.params.some((p) => p.required && p.example)
    ? withExamples(service)
    : service.endpoint;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue; // try GET
      const live = res.status === 402;
      return live ? { ...service, live, lastSeenLive: new Date().toISOString() } : { ...service, live };
    } catch {
      if (method === "GET") return { ...service, live: false };
    }
  }
  return { ...service, live: false };
}

function withExamples(service: ServiceListing): string {
  const url = new URL(service.endpoint);
  for (const param of service.params) {
    if (param.required && param.example) url.searchParams.set(param.name, param.example);
  }
  return url.toString();
}

// ── The hosted catalogue ───────────────────────────────────────────────────────────────

/** One entry as the website publishes it. Anything it does not say is filled in conservatively. */
const HostedParamSchema = z.object({
  name: z.string().min(1),
  in: z.literal("query"),
  required: z.boolean(),
  description: z.string().optional(),
  example: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

const HostedListingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  endpoint: z.string().min(1),
  method: z.literal("GET"),
  params: z.array(HostedParamSchema),
  payment: z.object({
    rail: z.enum(["x402", "mpp"]),
    scheme: z.enum(["exact", "charge"]),
    network: z.string().min(1),
    networkLabel: z.string().optional(),
    asset: z.string().min(1),
    price: z.object({ amountDecimal: z.number().positive(), asset: z.string(), display: z.string() }).optional(),
    payTo: z.string().optional(),
    configured: z.boolean().optional(),
  }),
  operator: z.string().optional(),
  testnet: z.boolean().optional(),
  mock: z.boolean().optional(),
  example_prompts: z.array(z.string()).optional(),
});

const HostedCatalogueSchema = z.object({ services: z.array(z.unknown()) });

let catalogueCache: { url: string; at: number; listings: ServiceListing[] } | undefined;
/** A failed read is remembered briefly, so an outage costs one timeout rather than one per call. */
let catalogueFailure: { url: string; at: number; error: string } | undefined;
const CATALOGUE_FAILURE_MS = 60_000;

/** Forgets the cached hosted catalogue, and any remembered failure. Tests use this; the client never needs it. */
export function clearHostedCatalogueCache(): void {
  catalogueCache = undefined;
  catalogueFailure = undefined;
}

/**
 * Read the hosted catalogue once per five minutes. Entries that do not parse are dropped one
 * by one rather than taking the whole catalogue down with them. Throws when the catalogue
 * itself cannot be read, so the caller can say so.
 */
export async function fetchHostedCatalogue(url?: string): Promise<ServiceListing[]> {
  const target = url ?? hostedCatalogueUrl();
  if (!target) return [];
  const now = Date.now();
  if (catalogueCache && catalogueCache.url === target && now - catalogueCache.at < CATALOGUE_CACHE_MS) {
    return catalogueCache.listings;
  }
  if (catalogueFailure && catalogueFailure.url === target && now - catalogueFailure.at < CATALOGUE_FAILURE_MS) {
    throw new Error(catalogueFailure.error);
  }
  try {
    const res = await fetch(target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = HostedCatalogueSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("the response is not a catalogue");
    const listings: ServiceListing[] = [];
    for (const row of parsed.data.services) {
      const entry = HostedListingSchema.safeParse(row);
      if (!entry.success) continue;
      const listing = fromHostedRow(entry.data);
      if (listing) listings.push(listing);
    }
    catalogueCache = { url: target, at: now, listings };
    catalogueFailure = undefined;
    return listings;
  } catch (err) {
    catalogueFailure = { url: target, at: now, error: message(err) };
    throw err;
  }
}

function fromHostedRow(row: z.infer<typeof HostedListingSchema>): ServiceListing | undefined {
  let endpoint: URL;
  try {
    endpoint = new URL(row.endpoint);
  } catch {
    return undefined;
  }
  // A payment credential travels to the endpoint: only https, or plain http on this machine.
  const secure =
    endpoint.protocol === "https:" ||
    (endpoint.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(endpoint.hostname));
  const network = toCaip2(row.payment.network);
  const networkLabel = row.payment.networkLabel ?? describeNetwork(row.payment.network);
  // A chain `pay` pays on, in that chain's token, over the protocol its rail speaks (MPP on Tempo, x402 elsewhere).
  const chain = SUPPORTED_NETWORKS.find((n) => n.caip2 === network);
  const supported =
    chain !== undefined &&
    row.payment.asset.toUpperCase() === chain.token.symbol.toUpperCase() &&
    row.payment.rail === (chain.rail === "tempo" ? "mpp" : "x402") &&
    row.payment.scheme === (chain.rail === "tempo" ? "charge" : "exact");
  const configured = row.payment.configured !== false;
  const notActionableReason = !secure
    ? "the endpoint is not https, so a payment credential would travel in the clear"
    : !supported
      ? // The catalogue's own label is not repeated: the client names the network and asset only when it knows them.
        `${isKnownChainName(row.payment.network) ? describeNetwork(row.payment.network) : "this network"} in ${/^[A-Za-z0-9]{1,12}$/.test(row.payment.asset) ? row.payment.asset : "this asset"} is not supported in this release`
      : !configured
        ? "the seller has no payout address configured, so it cannot be paid right now"
        : undefined;
  return {
    id: row.id,
    // The same rule as an index row's text: the catalogue's address can be pointed elsewhere, and what it says
    // about a service reaches an agent that then chooses what to pay.
    name: untrustedText(row.name, 200),
    description: untrustedText(row.description, 500),
    endpoint: row.endpoint,
    method: "GET",
    params: row.params.map((p) => ({
      name: p.name,
      in: "query",
      required: p.required,
      ...(p.description !== undefined ? { description: p.description } : {}),
      ...(p.example !== undefined ? { example: p.example } : {}),
      ...(p.enum && p.enum.length > 0 ? { enum: p.enum } : {}),
    })),
    payment: {
      rail: row.payment.rail,
      scheme: row.payment.scheme,
      network,
      networkLabel,
      asset: row.payment.asset,
      ...(row.payment.price ? { price: row.payment.price } : {}),
    },
    ...(row.operator ? { operator: row.operator } : {}),
    source: "demo-catalogue",
    // What the network says, not what the row claims.
    testnet: networkFor(network)?.testnet === true || /sepolia|testnet|devnet/i.test(networkLabel),
    actionable: notActionableReason === undefined,
    ...(notActionableReason ? { notActionableReason } : {}),
    ...(row.mock !== undefined ? { mock: row.mock } : {}),
    ...(row.example_prompts && row.example_prompts.length > 0 ? { examplePrompts: row.example_prompts } : {}),
    rails: [row.payment.rail],
    chains: [chainName(network)],
    routes: routesFor([row.payment.rail], [chainName(network)]),
  };
}

// ── The Superstables index ─────────────────────────────────────────────────────────────

/** One row of the public index, as the API returns it. */
interface IndexRow {
  id?: string;
  name?: string;
  description?: string;
  endpoint?: string;
  rails?: string[];
  chains?: string[];
  assets?: string[];
  price?: { display?: string; usd?: number };
  live?: boolean;
  last_seen_live?: string;
}

async function fetchIndex(query: string, limit: number): Promise<ServiceListing[]> {
  const url = new URL(indexUrl() ?? DEFAULT_INDEX_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("live", "true");
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString(), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { services?: IndexRow[] } | IndexRow[];
  const rows = Array.isArray(body) ? body : (body.services ?? []);
  return rows.filter((row) => row && row.id && row.endpoint).map(fromIndexRow);
}

function fromIndexRow(row: IndexRow): ServiceListing {
  // The row's own words for its chains and rails end up in the listing and in the reason it cannot be paid.
  const chains = (row.chains ?? []).map((c) => untrustedText(c, 60)).filter(Boolean);
  const rails = (row.rails ?? []).map((r) => untrustedText(r, 60)).filter(Boolean);
  const routes = routesFor(rails, chains);
  // The network shown is the one `pay` could use when the listing offers it, not merely the
  // first one listed: ["base", "base-sepolia"] is a Base Sepolia listing as far as `pay` goes.
  const chain = chains.find((c) => payNetworkFor(c)) ?? chains[0] ?? "";
  const payNetwork = payNetworkFor(chain);
  const onTempo = payNetwork?.rail === "tempo";
  const testnet = chains.some((c) => /sepolia|testnet|devnet|amoy|moderato/i.test(c));
  // A payment credential travels to this endpoint too, so it gets the same test the hosted
  // catalogue rows get: only https, or plain http on this machine. An index row names its own
  // endpoint, and `chains` is the row's own claim about where it pays, so neither is a check.
  let endpoint: URL | undefined;
  try { endpoint = new URL(String(row.endpoint)); } catch {}
  const secure = endpoint !== undefined && (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(endpoint.hostname)));
  return {
    // Index text is whoever registered the service. It reaches an agent that then chooses what to pay and
    // what to tell the owner, so it is flattened to one bounded line here rather than at each place it is shown.
    id: untrustedText(row.id, 200),
    name: untrustedText(row.name ?? row.id, 200),
    description: untrustedText(row.description, 500),
    endpoint: String(row.endpoint),
    method: "GET",
    // The index does not record request parameters yet; an empty list says exactly that.
    params: [],
    payment: {
      rail: onTempo ? "mpp" : "x402",
      scheme: onTempo ? "charge" : "exact",
      network: payNetwork?.caip2 ?? toCaip2(chain),
      networkLabel: payNetwork?.label ?? describeNetwork(chain),
      asset: row.assets?.[0] ?? "USDC",
      price:
        typeof row.price?.usd === "number"
          ? {
              amountDecimal: row.price.usd,
              asset: row.assets?.[0] ?? "USDC",
              display: row.price.display ?? `${row.price.usd} ${row.assets?.[0] ?? "USDC"}`,
            }
          : undefined,
    },
    source: "superstables-index",
    live: row.live,
    lastSeenLive: row.last_seen_live,
    testnet,
    actionable: false,
    notActionableReason: !secure
      ? endpoint === undefined
        ? "the index records no usable endpoint for this service"
        : "the endpoint is not https, so a payment credential would travel in the clear"
      : routes.pay
        ? "the index does not yet record the request parameters this service needs"
        : !testnet
          ? `mainnet only (${describeOffer(rails, chains)}); this client pays on testnets only`
          : routes.budget.length > 0
            ? `\`superstables pay\` does not pay ${describeOffer(rails, chains)}; a \`superstables budget\` rail could`
            : `this client does not pay ${describeOffer(rails, chains)}`,
    rails,
    chains,
    // routes, with `pay` off where the endpoint cannot carry a credential safely. This is the field
    // both the CLI and the MCP server gate a payment on, so it is where the rule belongs.
    routes: secure ? routes : { ...routes, pay: false },
  };
}

/**
 * What a listing offers, in the client's own words: only the rail and chain names the client knows are repeated, and
 * the rest are counted, never quoted, because this text goes into the client's sentence about the listing.
 */
function describeOffer(rails: string[], chains: string[]): string {
  const name = (known: string[], others: number, one: string, none: string) =>
    known.length === 0 && others === 0
      ? none
      : [...known, ...(others > 0 ? [`${others} other ${one}${others === 1 ? "" : "s"}`] : [])].join(", ");
  const knownRails = rails.filter(isKnownRail);
  const knownChains = chains.filter(isKnownChainName);
  return `${name(knownRails, rails.length - knownRails.length, "protocol", "an unnamed protocol")} on ${name(knownChains, chains.length - knownChains.length, "chain", "no named chain")}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function allowed(param: ServiceParam): string {
  if (param.enum && param.enum.length > 0) return ` (one of ${param.enum.join(", ")})`;
  if (param.example) return ` (for example ${param.example})`;
  return "";
}
