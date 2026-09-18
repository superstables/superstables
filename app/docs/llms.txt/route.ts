export const dynamic = "force-static";

/** Section-level llms.txt for the documentation area: a scoped index, not the whole site. */
const BODY = `# Superstables docs

> Scoped index for the documentation of the Superstables Index API and MCP server.
> The site-wide index is [/llms.txt](https://www.superstables.com/llms.txt).

## Reference

- [API reference (HTML)](https://www.superstables.com/docs)
- [API reference (markdown)](https://www.superstables.com/docs.md): endpoints, pagination, errors, rate limits, versioning
- [OpenAPI 3.1 spec](https://www.superstables.com/openapi.json)
- [Authentication](https://www.superstables.com/auth.md): none required
- [Pricing](https://www.superstables.com/pricing.md): free

## MCP

- [Server card](https://www.superstables.com/.well-known/mcp/server-card.json): tools find_services, get_service, get_stats
- Endpoint: https://www.superstables.com/api/mcp (streamable HTTP, no auth)

## Discovery files

- [ARD catalog](https://www.superstables.com/.well-known/ard.json)
- [API catalog (RFC 9727)](https://www.superstables.com/.well-known/api-catalog)
- [Agent skills index](https://www.superstables.com/.well-known/agent-skills/index.json)
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
