import { NextResponse } from "next/server";
import { getService } from "@/lib/directory/query";

export const dynamic = "force-dynamic";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "s-maxage=300, stale-while-revalidate=3600",
  "RateLimit-Policy": "300;w=60",
  "RateLimit-Limit": "300",
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let service;
  try {
    service = await getService(id);
  } catch {
    return NextResponse.json({ error: { code: "internal_error", message: "The index is temporarily unavailable. Retry with backoff." } }, { status: 500, headers: { ...CORS, "Cache-Control": "no-store" } });
  }
  if (!service) return NextResponse.json({ error: { code: "not_found", message: `No service with id "${id}". List ids via /api/v1/services.` } }, { status: 404, headers: CORS });
  return NextResponse.json(service, { headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { headers: CORS });
}
