import { CONTACT, trustMarkdown } from "@/content/trust";

export const dynamic = "force-static";

/** Markdown twin of /contact. */
export function GET() {
  return new Response(trustMarkdown(CONTACT), { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=3600" } });
}
