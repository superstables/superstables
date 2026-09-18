import { SITE } from "@/lib/site";
export const dynamic = "force-static";

/**
 * Schema map (NLWeb Schema Feeds): the structured-data feeds this site publishes, so agents can take
 * the whole index as schema.org data instead of scraping pages. Referenced from robots.txt.
 */
const BODY = `<?xml version="1.0" encoding="UTF-8"?>
<schemamap>
  <feed>
    <loc>${SITE}/feeds/services.jsonl</loc>
    <type>application/x-ndjson</type>
    <schema>https://schema.org/Service</schema>
    <changefreq>hourly</changefreq>
    <description>Every indexed service an AI agent can pay with stablecoins (x402, MPP, ACP), one schema.org Service per line, with liveness status and payment details in additionalProperty.</description>
  </feed>
  <feed>
    <loc>${SITE}/api/v1/services</loc>
    <type>application/json</type>
    <schema>${SITE}/openapi.json#/components/schemas/ServiceList</schema>
    <changefreq>hourly</changefreq>
    <description>The same index as a paged JSON API (limit, offset, filters); OpenAPI at /openapi.json.</description>
  </feed>
</schemamap>
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
