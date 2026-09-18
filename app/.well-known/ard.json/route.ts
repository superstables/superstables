import { NextResponse } from "next/server";
import { SITE } from "@/lib/site";

export const dynamic = "force-static";

/**
 * Trust manifest shared by every entry: the identity is the publisher domain in each entry's
 * URN, verifiable because the catalog and every resource are served from that domain over HTTPS.
 */
const TRUST = {
  identity: { type: "domain", domain: "superstables.com", url: "https://www.superstables.com" },
  trustSchema: { governanceUri: `${SITE}/about`, verificationMethods: ["https-origin"] },
};

/** Agentic Resource Discovery catalog (agenticresourcediscovery.org shape). */
const ARD = {
  specVersion: "1.0",
  name: "Superstables",
  description: "The neutral, liveness-probed index of services AI agents can pay with stablecoins across x402, MPP and ACP.",
  url: `${SITE}`,
  publisher: { name: "Superstables", url: `${SITE}`, contact: "https://x.com/superstables" },
  entries: [
    {
      identifier: "urn:air:superstables.com:mcp:superstables",
      displayName: "superstables",
      type: "mcp-server",
      description: "Query the index as native tools: find_services, get_service, get_stats. Read-only, no auth. Streamable HTTP.",
      trustManifest: TRUST,
      mediaType: "application/json",
      url: `${SITE}/api/mcp`,
    },
    {
      identifier: "urn:air:superstables.com:api:index",
      displayName: "Superstables Index API",
      type: "api",
      description: "Public JSON API for the index. No key, CORS open. OpenAPI 3.1 at /openapi.json.",
      trustManifest: TRUST,
      mediaType: "application/openapi+json",
      url: `${SITE}/openapi.json`,
    },
    {
      identifier: "urn:air:superstables.com:nlweb:ask",
      displayName: "Ask the index",
      type: "nlweb",
      description: "Natural-language queries over the index. GET /ask?query=... ; streaming=true for SSE.",
      trustManifest: TRUST,
      mediaType: "application/json",
      url: `${SITE}/ask`,
    },
    {
      identifier: "urn:air:superstables.com:dataset:services-feed",
      displayName: "Superstables index feed",
      type: "dataset",
      description: "The whole index as newline-delimited JSON, one schema.org Service per line. Schema map at /schemamap.xml.",
      trustManifest: TRUST,
      mediaType: "application/x-ndjson",
      url: `${SITE}/feeds/services.jsonl`,
    },
    {
      identifier: "urn:air:superstables.com:document:llms-txt",
      displayName: "llms.txt",
      type: "document",
      description: "Plain-text overview with when-to-use guidance for agents.",
      trustManifest: TRUST,
      mediaType: "text/plain",
      url: `${SITE}/llms.txt`,
    },
  ],
};

export function GET() {
  return NextResponse.json(ARD, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "s-maxage=3600" } });
}
