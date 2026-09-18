import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/** Machine-readable pricing. Honest version: the index is free. */
const BODY = `# Pricing

## Free (everything)

The Superstables index is free to use, for humans and for agents.

- Web directory: ${SITE}/discover - free, no account
- JSON API: ${SITE}/api/v1/services - free, no key, CORS open
- MCP server: ${SITE}/api/mcp - free, no auth
- Natural-language endpoint: ${SITE}/ask - free
- Listing a service: ${SITE}/submit - free; we probe before listing

## Limits

Soft advisory limit of 300 requests per minute per client. Responses are CDN-cached
for 300 seconds. No paid tiers exist today; if that changes, this file changes first.

Contact: https://x.com/superstables
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
