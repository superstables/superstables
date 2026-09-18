import { NextResponse } from "next/server";

export const dynamic = "force-static";

/** OpenAPI 3.1 description of the public index API. Field names are a stable contract. */
const SITE = "https://www.superstables.com";

const SERVICE = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable slug of the endpoint host" },
    name: { type: "string" },
    category: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    rails: { type: "array", items: { type: "string", enum: ["x402", "mpp", "acp"] } },
    chains: { type: "array", items: { type: "string" }, description: "base, solana, tempo, ... (unknown chains keep their CAIP-2 id)" },
    assets: { type: "array", items: { type: "string" }, description: "USDC, EURC, USDT, PYUSD, USDG, ..." },
    price: { type: "object", properties: { display: { type: ["string", "null"] }, usd: { type: ["number", "null"] } } },
    endpoint: { type: "string", description: "The URL that answers the payment challenge" },
    facilitator: { type: ["string", "null"] },
    live: { type: ["boolean", "null"], description: "true = answered a payment challenge on the last probe; null = not yet probed (e.g. acp://)" },
    last_seen_live: { type: ["string", "null"], format: "date-time" },
    first_indexed: { type: "string", format: "date-time" },
    sources: { type: "array", items: { type: "string" }, description: "Directories this service was found in" },
  },
} as const;

/** Every 4xx/5xx body has this shape. `code` is stable and machine-readable; `message` says how to recover. */
const ERROR = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          description: "Stable machine-readable code",
          enum: ["not_found", "invalid_endpoint", "invalid_json", "invalid_ids", "missing_query", "rate_limited", "internal_error"],
        },
        message: { type: "string", description: "Human-readable explanation with a pointer to recovery" },
        endpoints: { type: "array", items: { type: "string" }, description: "On not_found for an unknown path: the paths that do exist" },
      },
    },
  },
} as const;

const RATE_LIMIT_HEADERS = {
  "RateLimit-Limit": { $ref: "#/components/headers/RateLimit-Limit" },
  "RateLimit-Policy": { $ref: "#/components/headers/RateLimit-Policy" },
} as const;

const ERROR_RESPONSES = {
  "429": { $ref: "#/components/responses/TooManyRequests" },
  "500": { $ref: "#/components/responses/InternalError" },
  default: { $ref: "#/components/responses/Error" },
} as const;

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Superstables Index API",
    version: "1.0.0",
    description: [
      "The neutral index of services an AI agent can pay with stablecoins, across x402, MPP and ACP, deduplicated and independently probed for liveness. Free, no key, CORS open. Use it to find payable data, compute, tools and agent services.",
      "",
      "Errors: every 4xx/5xx response is JSON with the Error schema ({ error: { code, message } }); never an HTML page.",
      "",
      "Rate limits: a soft advisory limit of 300 requests per minute per client, advertised on every response with RateLimit-Limit and RateLimit-Policy (IETF RateLimit header fields). A 429 carries Retry-After. Responses are CDN-cached for 300 seconds, so polling faster than that returns the same data.",
      "",
      "Versioning: the version is the URL path prefix (/api/v1). Within a version, fields are only ever added; existing field names and types are a stable contract and are not renamed or removed. Nothing is deprecated today.",
    ].join("\n"),
    contact: { name: "Superstables on X", url: "https://x.com/superstables" },
    termsOfService: `${SITE}/pricing.md`,
  },
  externalDocs: { description: "Human and markdown documentation", url: `${SITE}/docs` },
  servers: [{ url: SITE }],
  paths: {
    "/api/v1/services": {
      get: {
        operationId: "listServices",
        summary: "List payable services",
        description:
          "Filterable list of every indexed service. A service is 'live' when it answered a valid payment challenge (HTTP 402, payment-challenge header, or challenge body) on our last probe. Pagination is offset-based: pass limit and offset, and follow page.next_offset until it is null.",
        parameters: [
          { name: "rail", in: "query", schema: { type: "string", enum: ["x402", "mpp", "acp"] } },
          { name: "chain", in: "query", schema: { type: "string" }, example: "base" },
          { name: "asset", in: "query", schema: { type: "string" }, example: "USDC" },
          { name: "live", in: "query", schema: { type: "boolean" }, description: "true returns only services that answered our last probe" },
          { name: "q", in: "query", schema: { type: "string" }, description: "Free-text search over name, category and endpoint" },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 }, description: "Page size" },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 }, description: "Number of services to skip; use page.next_offset from the previous response" },
        ],
        responses: {
          "200": {
            description: "Matching services with census counts and pagination",
            headers: RATE_LIMIT_HEADERS,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceList" } } },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/services/batch": {
      post: {
        operationId: "batchGetServices",
        summary: "Bulk lookup: up to 100 services by id in one request",
        description:
          "Read-only batch operation. Send an array of service ids and get back every record found (list shape, without probe history) plus the ids that are not in the index. Use it instead of many single-record calls when reconciling a list of endpoints.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ids"],
                properties: { ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" }, description: "Service ids (the slugs shown by /api/v1/services); case-insensitive, duplicates ignored" } },
              },
              example: { ids: ["10x402.com", "example.invalid"] },
            },
          },
        },
        responses: {
          "200": {
            description: "Records found and ids missing",
            headers: RATE_LIMIT_HEADERS,
            content: { "application/json": { schema: { $ref: "#/components/schemas/BatchResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          ...ERROR_RESPONSES,
        },
      },
      get: {
        operationId: "batchGetServicesByQuery",
        summary: "Bulk lookup over GET for clients that cannot send a body",
        parameters: [{ name: "ids", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated service ids, 1 to 100", example: "10x402.com,example.invalid" }],
        responses: {
          "200": { description: "Records found and ids missing", headers: RATE_LIMIT_HEADERS, content: { "application/json": { schema: { $ref: "#/components/schemas/BatchResult" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/services/{id}": {
      get: {
        operationId: "getService",
        summary: "One service with probe history",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, example: "10x402.com" }],
        responses: {
          "200": {
            description: "The service plus its last 20 liveness probes",
            headers: RATE_LIMIT_HEADERS,
            content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceDetail" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/stats": {
      get: {
        operationId: "getStats",
        summary: "Census counts",
        responses: {
          "200": {
            description: "Totals for the whole index",
            headers: RATE_LIMIT_HEADERS,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Stats" } } },
          },
          ...ERROR_RESPONSES,
        },
      },
    },
    "/api/v1/submit": {
      post: {
        operationId: "submitService",
        summary: "Submit a service for listing",
        description: "We probe before listing. If the endpoint answers a valid payment challenge it joins the index on the next crawl.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["endpoint"], properties: { endpoint: { type: "string", format: "uri" }, name: { type: "string" }, contact: { type: "string" } } } } },
        },
        parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" }, description: "Optional client key; repeated submissions of the same endpoint within 24h are deduplicated and echoed back." }],
        responses: {
          "200": {
            description: "Accepted into the moderation queue (deduplicated: true when a recent identical submission exists)",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SubmitResult" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          ...ERROR_RESPONSES,
        },
      },
    },
  },
  components: {
    schemas: {
      Service: SERVICE,
      ServiceDetail: {
        allOf: [
          { $ref: "#/components/schemas/Service" },
          {
            type: "object",
            properties: {
              source_urls: { type: "array", items: { type: "object", properties: { source: { type: "string" }, url: { type: ["string", "null"] } } } },
              probes: {
                type: "array",
                description: "Last 20 liveness probes, newest first",
                items: {
                  type: "object",
                  properties: {
                    probed_at: { type: "string", format: "date-time" },
                    ok: { type: "boolean" },
                    status_code: { type: ["integer", "null"] },
                    method: { type: ["string", "null"] },
                    latency_ms: { type: ["integer", "null"] },
                  },
                },
              },
            },
          },
        ],
      },
      ServiceList: {
        type: "object",
        required: ["generated_at", "counts", "page", "services"],
        properties: {
          generated_at: { type: "string", format: "date-time" },
          counts: { type: "object", properties: { total: { type: "integer" }, live: { type: "integer" }, dual_rail: { type: "integer" } } },
          page: {
            type: "object",
            description: "Offset pagination state for this response",
            required: ["limit", "offset", "next_offset"],
            properties: {
              limit: { type: "integer", description: "Page size actually applied (1-500)" },
              offset: { type: "integer", description: "Offset actually applied" },
              next_offset: { type: ["integer", "null"], description: "Pass as offset to fetch the next page; null when this was the last page" },
            },
          },
          services: { type: "array", items: { $ref: "#/components/schemas/Service" } },
        },
      },
      Stats: {
        type: "object",
        properties: {
          generated_at: { type: "string", format: "date-time" },
          total: { type: "integer" },
          live: { type: "integer" },
          probed: { type: "integer" },
          dual_rail: { type: "integer" },
          rails: { type: "integer" },
          last_probe_at: { type: ["string", "null"] },
        },
      },
      BatchResult: {
        type: "object",
        required: ["generated_at", "requested", "found", "missing"],
        properties: {
          generated_at: { type: "string", format: "date-time" },
          requested: { type: "integer", description: "Number of distinct ids looked up" },
          found: { type: "array", items: { $ref: "#/components/schemas/Service" }, description: "Records found, in the order requested" },
          missing: { type: "array", items: { type: "string" }, description: "Requested ids that are not in the index" },
        },
      },
      SubmitResult: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" }, deduplicated: { type: "boolean", description: "true when an identical recent submission already existed" } },
      },
      Error: ERROR,
    },
    headers: {
      "RateLimit-Limit": { description: "Requests allowed per window (IETF RateLimit header fields)", schema: { type: "string" }, example: "300" },
      "RateLimit-Policy": { description: "Quota policy: limit;w=window-seconds", schema: { type: "string" }, example: "300;w=60" },
      "Retry-After": { description: "Seconds to wait before retrying", schema: { type: "integer" } },
    },
    responses: {
      Error: { description: "Any other error; body follows the Error schema", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      BadRequest: { description: "Invalid request (codes: invalid_json, invalid_endpoint, invalid_ids, missing_query)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      NotFound: { description: "Unknown id or path (code: not_found)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      TooManyRequests: {
        description: "Rate limited (code: rate_limited); wait Retry-After seconds",
        headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" }, ...RATE_LIMIT_HEADERS },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      InternalError: { description: "Unexpected failure (code: internal_error); safe to retry with backoff", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  },
} as const;

export function GET() {
  return NextResponse.json(SPEC, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "s-maxage=3600" } });
}
