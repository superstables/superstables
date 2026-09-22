// The prepared demo services, and the rules they all follow: ids, the disclosure, parameter
// validation, the response envelope and the catalogue entry. The route under
// /api/demo/services/[service] and the hosted catalogue at /api/demo/catalogue both read
// from here, so what discovery promises is exactly what the endpoint checks.

import type { PaymentRequirements } from "@x402/core/types";
import { NETWORK, USDC } from "@/lib/demoService";
import type { DemoEnvelope, DemoParam, DemoResult, DemoServiceDefinition } from "./types";
import { audioTranscription } from "./services/audio-transcription";
import { contractScreening } from "./services/contract-screening";
import { imageCreation } from "./services/image-creation";
import { jobSearch } from "./services/job-search";
import { productSearch } from "./services/product-search";
import { specialistResearch } from "./services/specialist-research";
import { walletBriefing } from "./services/wallet-briefing";
import { webSearch } from "./services/web-search";
import { websitePerformance } from "./services/website-performance";
import { whitepaperExtraction } from "./services/whitepaper-extraction";

export const PROVIDER = "Superstables demo service";
export const NOTICE = "Simulated service output. Payment uses test USDC on Base Sepolia.";
export const FIXTURE_VERSION = "1";
export const ROUTE_PREFIX = "/api/demo/services";
/** Where the sample documents and images live under public/. */
export const ROUTE_PREFIX_ASSETS = "/demo/services";
export const ID_PREFIX = "superstables-demo-";

/** Every prepared service, in catalogue order. */
export const DEMO_SERVICES: readonly DemoServiceDefinition[] = [
  walletBriefing,
  contractScreening,
  webSearch,
  whitepaperExtraction,
  specialistResearch,
  imageCreation,
  audioTranscription,
  productSearch,
  jobSearch,
  websitePerformance,
];

export function serviceId(def: DemoServiceDefinition): string {
  return `${ID_PREFIX}${def.slug}`;
}

export function bySlug(slug: string): DemoServiceDefinition | undefined {
  return DEMO_SERVICES.find((s) => s.slug === slug);
}

/** The catalogue description: what it sells, then the disclosure, always. */
export function describe(def: DemoServiceDefinition): string {
  return `${def.description} ${NOTICE}`;
}

/** The exact x402 requirement for one call: decimal price to atomic USDC units, no float math. */
export function requirementFor(def: DemoServiceDefinition, recipient: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK.caip2 as PaymentRequirements["network"],
    asset: USDC.address,
    amount: atomicUnits(def.price),
    payTo: recipient,
    maxTimeoutSeconds: 300,
    extra: { name: USDC.eip712.name, version: USDC.eip712.version },
  };
}

/** "0.003" → "3000" for a 6-decimal asset, exactly. Throws on a price that cannot be exact. */
export function atomicUnits(price: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match) throw new Error(`price "${price}" is not a decimal number`);
  const [, whole, fraction = ""] = match;
  if (fraction.length > USDC.decimals) throw new Error(`price "${price}" has more than ${USDC.decimals} decimals`);
  const units = BigInt(whole) * BigInt(10) ** BigInt(USDC.decimals) + BigInt((fraction + "0".repeat(USDC.decimals)).slice(0, USDC.decimals));
  if (units <= BigInt(0)) throw new Error(`price "${price}" must be positive`);
  return units.toString();
}

export type Validation =
  | { ok: true; params: Record<string, string> }
  | { ok: false; status: 400; error: string; allowed?: Record<string, readonly string[]> };

/**
 * Check a request's query against the service's parameters. Unknown names, repeated names,
 * missing required values and values outside the closed set are all refused, naming what
 * would have been accepted. Optional parameters that are absent take their default, so the
 * result is always a complete, canonical set.
 */
export function validate(def: DemoServiceDefinition, query: URLSearchParams): Validation {
  const allowed: Record<string, readonly string[]> = Object.fromEntries(def.params.map((p) => [p.name, p.enum]));
  const known = new Set(def.params.map((p) => p.name));

  const unknown = [...new Set([...query.keys()])].filter((k) => !known.has(k));
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: `unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `"${u}"`).join(", ")}`, allowed };
  }

  const params: Record<string, string> = {};
  for (const param of def.params) {
    const values = query.getAll(param.name);
    if (values.length > 1) {
      return { ok: false, status: 400, error: `the ${param.name} parameter was given ${values.length} times; give it once`, allowed };
    }
    const raw = values[0]?.trim() ?? "";
    if (!raw) {
      if (param.required) return { ok: false, status: 400, error: `the ${param.name} parameter is required`, allowed };
      if (param.default !== undefined) params[param.name] = param.default;
      continue;
    }
    const canonical = param.enum.find((v) => v.toLowerCase() === raw.toLowerCase());
    if (!canonical) {
      return { ok: false, status: 400, error: `unsupported ${param.name} "${raw}"`, allowed };
    }
    params[param.name] = canonical;
  }
  return { ok: true, params };
}

/** Every complete parameter set a service accepts, with optional parameters both given and defaulted. */
export function parameterSets(def: DemoServiceDefinition): Record<string, string>[] {
  let sets: Record<string, string>[] = [{}];
  for (const param of def.params) {
    const next: Record<string, string>[] = [];
    for (const partial of sets) {
      for (const value of param.enum) next.push({ ...partial, [param.name]: value });
      if (!param.required && param.default !== undefined) next.push({ ...partial, [param.name]: param.default });
    }
    sets = next;
  }
  return sets;
}

/** The paid answer, with the disclosure and the settlement, and site-relative sources made absolute. */
export function envelope(
  def: DemoServiceDefinition,
  result: DemoResult,
  origin: string,
  paid: DemoEnvelope["paid"],
): DemoEnvelope {
  return {
    service_id: serviceId(def),
    provider: PROVIDER,
    mock: true,
    notice: NOTICE,
    scenario_id: result.scenario_id,
    fixture_version: FIXTURE_VERSION,
    as_of: result.as_of,
    summary: result.summary,
    data: absoluteAssets(result.data, origin) as Record<string, unknown>,
    sources: result.sources.map((s) => ({ ...s, url: absolute(s.url, origin) })),
    paid,
  };
}

function absolute(url: string, origin: string): string {
  return /^https?:\/\//i.test(url) ? url : new URL(url, origin).toString();
}

/** Site-relative asset paths anywhere in the data (an image's asset_url, say) become absolute too. */
function absoluteAssets(value: unknown, origin: string): unknown {
  if (typeof value === "string") return value.startsWith(`${ROUTE_PREFIX_ASSETS}/`) ? absolute(value, origin) : value;
  if (Array.isArray(value)) return value.map((v) => absoluteAssets(v, origin));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, absoluteAssets(v, origin)]));
  }
  return value;
}

/** What discovery publishes: the same shape the Superstables client's catalogue uses. */
export function listing(def: DemoServiceDefinition, origin: string, recipient: string | undefined) {
  return {
    id: serviceId(def),
    name: def.name,
    description: describe(def),
    endpoint: `${origin}${ROUTE_PREFIX}/${def.slug}`,
    method: "GET" as const,
    params: def.params.map(publishedParam),
    payment: {
      rail: "x402" as const,
      scheme: "exact" as const,
      network: NETWORK.caip2,
      networkLabel: NETWORK.label,
      asset: USDC.symbol,
      price: { amountDecimal: Number(def.price), asset: USDC.symbol, display: `${def.price} ${USDC.symbol} per request` },
      ...(recipient ? { payTo: recipient } : { configured: false }),
    },
    operator: "Superstables (prepared demo service on the testnet)",
    testnet: true,
    mock: true,
    returns: def.returns,
    example_prompts: def.examplePrompts,
  };
}

function publishedParam(p: DemoParam) {
  return {
    name: p.name,
    in: "query" as const,
    required: p.required,
    description: p.default !== undefined ? `${p.description} Default: ${p.default}.` : p.description,
    enum: [...p.enum],
    example: p.example,
  };
}
