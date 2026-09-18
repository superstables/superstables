import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/** Section-level llms.txt for the API area: just what an agent needs to call the index. */
const BODY = `# Superstables Index API

> Scoped index for the public JSON API. No key, no account, CORS open.
> The site-wide index is [/llms.txt](${SITE}/llms.txt).

## Endpoints

- [GET /api/v1/services](${SITE}/api/v1/services): list services; filters rail, chain, asset, live=true, q, limit (1-500), offset; follow page.next_offset
- GET /api/v1/services/:id: one service plus its last 20 liveness probes
- POST /api/v1/services/batch {"ids": [...]}: bulk lookup of up to 100 services, returns found and missing
- [GET /api/v1/stats](${SITE}/api/v1/stats): census counts
- POST /api/v1/submit: suggest a service for listing; probed before it appears
- [GET /ask?query=...](${SITE}/ask?query=live%20gpu%20compute): natural-language queries, NLWeb style

## Contract

- [OpenAPI 3.1 spec](${SITE}/openapi.json): typed responses, the Error schema, rate-limit headers
- [API reference (markdown)](${SITE}/docs.md)
- Errors are always JSON: { error: { code, message } }
- Rate limit: soft 300 requests per minute (RateLimit-Limit, RateLimit-Policy headers)
- Versioning in the path (/api/v1); within a version fields are only added, never renamed or removed
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
