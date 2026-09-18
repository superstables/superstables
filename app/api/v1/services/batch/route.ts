import { NextResponse } from "next/server";
import { z } from "zod";
import { getServicesByIds } from "@/lib/directory/query";

export const dynamic = "force-dynamic";

const MAX_IDS = 100;
const batchBodySchema = z.object({ ids: z.unknown() });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "s-maxage=300, stale-while-revalidate=3600",
  "RateLimit-Policy": "300;w=60",
  "RateLimit-Limit": "300",
};

function error(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

/** Normalise a list of ids: strings only, trimmed, lower-cased, deduplicated, 1..MAX_IDS. */
function cleanIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => x.length > 0 && x.length <= 200))];
  return ids.length >= 1 && ids.length <= MAX_IDS ? ids : null;
}

/**
 * Bulk lookup: one request for up to 100 services by id, instead of 100 calls to /api/v1/services/{id}.
 * Read-only; the response lists the records found (list shape, no probe history) and the ids that
 * are not in the index, so an agent can reconcile its own list in a single round trip.
 */
async function lookup(ids: string[]) {
  const found = await getServicesByIds(ids);
  const seen = new Set(found.map((s) => s.id));
  return NextResponse.json(
    { generated_at: new Date().toISOString(), requested: ids.length, found, missing: ids.filter((id) => !seen.has(id)) },
    { headers: CORS }
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "invalid_json", "Body must be JSON: { \"ids\": [\"service-id\", ...] }.");
  }
  const parsed = batchBodySchema.safeParse(body);
  const ids = parsed.success ? cleanIds(parsed.data.ids) : null;
  if (!ids) return error(400, "invalid_ids", `ids must be an array of 1 to ${MAX_IDS} service ids (the slugs shown by /api/v1/services).`);
  try {
    return await lookup(ids);
  } catch {
    return error(500, "internal_error", "The index is temporarily unavailable. Retry with backoff.");
  }
}

/** Same lookup over GET for clients that cannot send a body: ?ids=a,b,c */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ids");
  const ids = cleanIds(raw ? raw.split(",") : []);
  if (!ids) return error(400, "invalid_ids", `Pass ?ids=<comma-separated list of 1 to ${MAX_IDS} service ids>.`);
  try {
    return await lookup(ids);
  } catch {
    return error(500, "internal_error", "The index is temporarily unavailable. Retry with backoff.");
  }
}

export function OPTIONS() {
  return new Response(null, { headers: CORS });
}
