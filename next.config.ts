import type { NextConfig } from "next";

// Same rule as lib/site.ts: production is the canonical domain; a preview deployment refers to its own URL.
const SITE =
  process.env.SITE_URL ||
  (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.superstables.com");

/** RFC 8288 Link relations every public page advertises. */
const help = [
  `<${SITE}/llms.txt>; rel="help"; type="text/plain"`,
  `<${SITE}/openapi.json>; rel="describedby"; type="application/openapi+json"`,
  `<${SITE}/sitemap.xml>; rel="sitemap"; type="application/xml"`,
  `<${SITE}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
];
const markdownTwin = (path: string) => `<${SITE}${path}>; rel="alternate"; type="text/markdown"`;

const nextConfig: NextConfig = {
  async headers() {
    return [
      // Each content page advertises its markdown twin. The Accept negotiation itself, and the
      // Vary / Cache-Control it needs, live in proxy.ts: a header set here is replaced by the
      // production page writer before the HTML goes out, so it is not enough on its own.
      { source: "/", headers: [{ key: "Link", value: [...help, markdownTwin("/index.md")].join(", ") }] },
      ...["discover", "submit", "docs", "pricing", "about", "privacy", "contact", "demo"].map((p) => ({
        source: `/${p}`,
        headers: [{ key: "Link", value: [...help, markdownTwin(`/${p}.md`)].join(", ") }],
      })),
    ];
  },
  async rewrites() {
    return {
      // Markdown negotiation (Accept quality values and /?mode=agent) is decided in proxy.ts, which
      // redirects to the .md twin; a header regex here cannot honour q=0 or a lower preference.
      beforeFiles: [],
      afterFiles: [],
      fallback: [
        // Unmatched paths: non-browser clients (Accept without text/html, or no Accept) get a short
        // markdown 404 pointing at llms.txt, the sitemap and the docs. Browsers keep the HTML 404 page.
        { source: "/:path*", destination: "/404.md?path=:path*", missing: [{ type: "header", key: "accept", value: ".*text/html.*" }] },
      ],
    };
  },
};

export default nextConfig;
