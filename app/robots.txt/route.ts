export const dynamic = "force-static";

/**
 * robots.txt as a route handler (the metadata convention cannot emit the NLWeb schemamap directive).
 * Same policy as before: answer/search crawlers allowed, training-only crawlers blocked, private
 * areas disallowed for everyone; plus the sitemap and the schema map of structured-data feeds.
 */
const SITE = "https://www.superstables.com";

const BODY = `User-Agent: *
Allow: /
Disallow: /start
Disallow: /onboarding
Disallow: /app
Disallow: /api/cron
Disallow: /api/gate
Disallow: /api/early-access
Disallow: /brand

User-Agent: GPTBot
User-Agent: ClaudeBot
User-Agent: PerplexityBot
User-Agent: OAI-SearchBot
User-Agent: Google-Extended
Allow: /
Allow: /api/v1/
Allow: /llms.txt
Disallow: /start
Disallow: /onboarding
Disallow: /app

User-Agent: CCBot
User-Agent: Bytespider
Disallow: /

Sitemap: ${SITE}/sitemap.xml
schemamap: ${SITE}/schemamap.xml
`;

export function GET() {
  return new Response(BODY, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "s-maxage=3600" } });
}
