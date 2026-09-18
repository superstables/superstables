import { ABOUT, trustMarkdown } from "@/content/trust";

export const dynamic = "force-static";

/** Markdown twin of /about. */
export function GET() {
  return new Response(trustMarkdown(ABOUT), { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
