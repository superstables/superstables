import { NextResponse } from "next/server";
import { listServices, pageBounds, stats } from "@/lib/directory/query";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "s-maxage=300, stale-while-revalidate=3600",
  "RateLimit-Policy": "300;w=60",
  "RateLimit-Limit": "300",
};

/** Public, keyless, CORS-open. Field names are a contract — agents hardcode them. */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const page = pageBounds({
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
    offset: p.get("offset") ? Number(p.get("offset")) : undefined,
  });
  let counts, servicesList;
  try {
    [counts, servicesList] = await Promise.all([
      stats(),
      listServices({
        rail: p.get("rail") ?? undefined,
        chain: p.get("chain") ?? undefined,
        asset: p.get("asset") ?? undefined,
        live: p.get("live") === "true" ? true : undefined,
        q: p.get("q") ?? undefined,
        ...page,
      }),
    ]);
  } catch {
    // Same Error shape as every other failure, never an empty or HTML 500.
    return NextResponse.json({ error: { code: "internal_error", message: "The index is temporarily unavailable. Retry with backoff." } }, { status: 500, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    {
      generated_at: new Date().toISOString(),
      counts: { total: counts.total, live: counts.live, dual_rail: counts.dual_rail },
      // Offset pagination state; next_offset is null on the last page.
      page: { ...page, next_offset: servicesList.length === page.limit ? page.offset + page.limit : null },
      services: servicesList,
    },
    { headers: CORS }
  );
}

export function OPTIONS() {
  return new Response(null, { headers: CORS });
}
