import { NextResponse } from "next/server";

export const dynamic = "force-static";

const SITE = "https://www.superstables.com";

/**
 * RFC 9727 api-catalog: a linkset whose first context lists every API as an "item", and one
 * context per API pointing at its machine-readable description, human docs and metadata.
 */
const LINKSET = {
  linkset: [
    {
      anchor: `${SITE}/.well-known/api-catalog`,
      item: [
        { href: `${SITE}/api/v1/services`, title: "Superstables Index API v1 (REST, JSON)" },
        { href: `${SITE}/api/mcp`, title: "Superstables MCP server (streamable HTTP)" },
        { href: `${SITE}/ask`, title: "Superstables NLWeb ask endpoint" },
      ],
    },
    {
      anchor: `${SITE}/api/v1/services`,
      "service-desc": [{ href: `${SITE}/openapi.json`, type: "application/openapi+json" }],
      "service-doc": [
        { href: `${SITE}/docs`, type: "text/html" },
        { href: `${SITE}/docs.md`, type: "text/markdown" },
      ],
      "service-meta": [
        { href: `${SITE}/llms.txt`, type: "text/plain" },
        { href: `${SITE}/api/llms.txt`, type: "text/plain" },
        { href: `${SITE}/auth.md`, type: "text/markdown" },
      ],
    },
    {
      anchor: `${SITE}/api/mcp`,
      "service-desc": [{ href: `${SITE}/.well-known/mcp/server-card.json`, type: "application/json" }],
      "service-doc": [{ href: `${SITE}/docs`, type: "text/html" }],
      "service-meta": [{ href: `${SITE}/.well-known/ard.json`, type: "application/json" }],
    },
    {
      anchor: `${SITE}/ask`,
      "service-doc": [{ href: `${SITE}/docs.md`, type: "text/markdown" }],
      "service-meta": [{ href: `${SITE}/.well-known/ard.json`, type: "application/json" }],
    },
  ],
};

export function GET() {
  return new NextResponse(JSON.stringify(LINKSET), {
    headers: {
      "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "s-maxage=3600",
    },
  });
}
