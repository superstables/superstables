/**
 * Public origin used for canonical URLs, structured data, Link headers and every
 * machine-readable surface. Production is the canonical domain. A Vercel preview
 * deployment refers to its own unique URL instead, so agents and scanners that
 * follow absolute links stay on the preview rather than crossing to production.
 * SITE_URL overrides both when set.
 */
export const SITE =
  process.env.SITE_URL ||
  (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://www.superstables.com");
