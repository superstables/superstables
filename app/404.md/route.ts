import { SITE } from "@/lib/site";
export const dynamic = "force-dynamic";

/**
 * Markdown 404 for non-browser clients. A fallback rewrite in next.config.ts sends every
 * unmatched path here when the Accept header does not ask for text/html; browsers keep the
 * normal HTML not-found page. The original path arrives as ?path= from the rewrite.
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  // After a rewrite the handler may see the original URL (pathname) or the destination (?path=).
  const raw = url.pathname !== "/404.md" ? url.pathname : (url.searchParams.get("path") ?? "");
  const path = "/" + raw.replace(/[^\w\-./~%]/g, "").replace(/^\/+/, "").slice(0, 200);
  const body = `# 404: nothing is served at ${path}

This path does not exist on ${SITE}. Where to look next:

- [llms.txt](${SITE}/llms.txt): the site index written for agents
- [Sitemap](${SITE}/sitemap.xml): every indexable page
- [API reference](${SITE}/docs.md) and [OpenAPI spec](${SITE}/openapi.json)
- [Service index](${SITE}/discover): the directory itself
- [Homepage as markdown](${SITE}/index.md)
`;
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
