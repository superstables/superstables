import { listServices } from "@/lib/directory/query";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SITE = "https://www.superstables.com";
const PAGE = 500;

/** One indexed service as a schema.org Service object (the shape /ask already returns per result). */
function toSchemaOrg(s: Awaited<ReturnType<typeof listServices>>[number]) {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    "@id": `${SITE}/s/${s.id}`,
    name: s.name,
    url: `${SITE}/s/${s.id}`,
    description: s.description ?? undefined,
    category: s.category ?? undefined,
    serviceType: "AI agent payable service",
    availableChannel: { "@type": "ServiceChannel", serviceUrl: s.endpoint },
    additionalProperty: [
      { "@type": "PropertyValue", name: "rails", value: s.rails.join(",") },
      { "@type": "PropertyValue", name: "chains", value: s.chains.join(",") },
      { "@type": "PropertyValue", name: "assets", value: s.assets.join(",") },
      { "@type": "PropertyValue", name: "live", value: s.live === null ? "not probed" : String(s.live) },
      ...(s.last_seen_live ? [{ "@type": "PropertyValue", name: "last_seen_live", value: s.last_seen_live }] : []),
      ...(s.price.display ? [{ "@type": "PropertyValue", name: "price", value: s.price.display }] : []),
      ...(s.facilitator ? [{ "@type": "PropertyValue", name: "facilitator", value: s.facilitator }] : []),
    ],
    isBasedOn: s.sources.map((src) => ({ "@type": "CreativeWork", name: src })),
    dateModified: s.last_seen_live ?? s.first_indexed,
  };
}

/**
 * The whole index as newline-delimited JSON, one schema.org Service per line, streamed page by page
 * from the database so memory stays flat. Read-only; same public fields as the JSON API.
 */
export async function GET() {
  const encoder = new TextEncoder();
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const page = await listServices({ limit: PAGE, offset });
        if (cancelled) return;
        offset += page.length;
        if (page.length > 0) {
          controller.enqueue(encoder.encode(page.map((s) => JSON.stringify(toSchemaOrg(s))).join("\n") + "\n"));
        }
        if (page.length < PAGE) controller.close();
      } catch (e) {
        if (!cancelled) controller.error(e);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400",
      Link: `<${SITE}/schemamap.xml>; rel="describedby"; type="application/xml"`,
    },
  });
}
