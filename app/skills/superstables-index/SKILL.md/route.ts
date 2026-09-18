import { SKILL_MD } from "@/lib/agent-skills";

export const dynamic = "force-static";

/** The skill document listed in /.well-known/agent-skills/index.json; the index digest is of these bytes. */
export function GET() {
  return new Response(SKILL_MD, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "s-maxage=3600" },
  });
}
