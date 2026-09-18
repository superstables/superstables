import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/** Section-level llms.txt for the documentation area: a scoped index, not the whole site. */
const BODY = `# Superstables docs

> Scoped index for the documentation of the Superstables Index API and MCP server.
> The site-wide index is [/llms.txt](${SITE}/llms.txt).

## Reference

- [API reference (HTML)](${SITE}/docs)
- [API reference (markdown)](${SITE}/docs.md): endpoints, pagination, errors, rate limits, versioning
- [OpenAPI 3.1 spec](${SITE}/openapi.json)
- [Authentication](${SITE}/auth.md): none required
- [Pricing](${SITE}/pricing.md): free

## MCP

- [Server card](${SITE}/.well-known/mcp/server-card.json): tools find_services, get_service, get_stats
- Endpoint: ${SITE}/api/mcp (streamable HTTP, no auth)

## Discovery files

- [ARD catalog](${SITE}/.well-known/ard.json)
- [API catalog (RFC 9727)](${SITE}/.well-known/api-catalog)
- [Agent skills index](${SITE}/.well-known/agent-skills/index.json)
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
