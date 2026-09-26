import { createHmac, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { ledgerSchema, TREASURY_LEDGER_KEY } from "@/lib/treasury-ledger";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.TREASURY_SYNC_SECRET;
  if (!secret) return NextResponse.json({ error: "Sync not configured" }, { status: 503 });
  const signature = request.headers.get("x-treasury-signature") ?? "";
  if (!/^[a-f0-9]{64}$/.test(signature)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 1_000_000) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  const expected = createHmac("sha256", secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const result = ledgerSchema.safeParse(input);
  if (!result.success) return NextResponse.json({ error: "Invalid treasury ledger" }, { status: 400 });
  const ledger = result.data;
  const age = Date.now() - Date.parse(ledger.syncedAt);
  if (age > 10 * 60_000 || age < -60_000) return NextResponse.json({ error: "Expired snapshot" }, { status: 400 });

  const saved = await db.insert(schema.settings)
    .values({ key: TREASURY_LEDGER_KEY, value: JSON.stringify(ledger) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`now()` },
      setWhere: sql`(${schema.settings.value}::jsonb->>'syncedAt')::timestamptz < ${ledger.syncedAt}::timestamptz`,
    }).returning({ key: schema.settings.key });
  // Also revalidate on a duplicate, so a retry repairs a failed invalidation after a successful write.
  revalidateTag(TREASURY_LEDGER_KEY, { expire: 0 });
  revalidatePath("/treasury");
  return NextResponse.json({ ok: true, applied: saved.length > 0, syncedAt: ledger.syncedAt });
}
