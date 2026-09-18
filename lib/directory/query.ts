import "server-only";
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/** Query layer for the public API and the UI. Kept clean so the MCP server can lift it (briefing §10). */

export type ServiceFilters = { rail?: string; chain?: string; asset?: string; live?: boolean; q?: string; limit?: number; offset?: number };

export function serviceToJson(s: typeof schema.services.$inferSelect, sources?: string[]) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    rails: s.rails,
    chains: s.chains,
    assets: s.assets,
    price: { display: s.priceDisplay, usd: s.priceUsd == null ? null : Number(s.priceUsd) },
    endpoint: s.endpoint,
    facilitator: s.facilitator,
    live: s.live,
    last_seen_live: s.lastSeenLive?.toISOString() ?? null,
    first_indexed: s.firstIndexed.toISOString(),
    sources: sources ?? [],
  };
}

/** The page bounds actually applied: limit clamped to 1-500 (default 100), offset >= 0, non-numbers fall back to defaults. */
export function pageBounds(f: Pick<ServiceFilters, "limit" | "offset">) {
  const limit = Number.isFinite(f.limit) ? Math.min(Math.max(f.limit as number, 1), 500) : 100;
  const offset = Number.isFinite(f.offset) ? Math.max(f.offset as number, 0) : 0;
  return { limit, offset };
}

export async function listServices(f: ServiceFilters) {
  const t = schema.services;
  const conds: SQL[] = [isNull(t.delistedAt)];
  if (f.rail) conds.push(sql`${f.rail} = any(${t.rails})`);
  if (f.chain) conds.push(sql`${f.chain} = any(${t.chains})`);
  if (f.asset) conds.push(sql`${f.asset.toUpperCase()} = any(${t.assets})`);
  if (f.live === true) conds.push(eq(t.live, true));
  if (f.q) {
    const like = `%${f.q}%`;
    conds.push(or(ilike(t.name, like), ilike(t.category, like), ilike(t.description, like), ilike(t.endpoint, like))!);
  }
  const where = and(...conds);
  const { limit, offset } = pageBounds(f);

  const rows = await db.select().from(t).where(where).orderBy(sql`${t.live} desc nulls last`, sql`${t.lastSeenLive} desc nulls last`, t.name).limit(limit).offset(offset);
  return withSources(rows);
}

/** Attach source labels to a page of rows with one query scoped to those ids (not the whole table). */
async function withSources(rows: (typeof schema.services.$inferSelect)[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const srcRows = await db
    .select({ serviceId: schema.serviceSources.serviceId, source: schema.serviceSources.source })
    .from(schema.serviceSources)
    .where(inArray(schema.serviceSources.serviceId, ids));
  const srcMap = new Map<string, string[]>();
  for (const r of srcRows) srcMap.set(r.serviceId, [...(srcMap.get(r.serviceId) ?? []), r.source]);
  return rows.map((s) => serviceToJson(s, srcMap.get(s.id) ?? []));
}

/** Bulk lookup by id (read-only). Returns the records found, in the order requested; callers compute what is missing. */
export async function getServicesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const t = schema.services;
  const rows = await db.select().from(t).where(and(isNull(t.delistedAt), inArray(t.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is typeof schema.services.$inferSelect => r !== undefined);
  return withSources(ordered);
}

/** Census counts for the whole index, or for the services listed on one rail when `rail` is given. */
export async function stats(rail?: string) {
  const t = schema.services;
  const scope = rail ? and(isNull(t.delistedAt), sql`${rail} = any(${t.rails})`) : isNull(t.delistedAt);
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      live: sql<number>`count(*) filter (where live)::int`,
      probed: sql<number>`count(*) filter (where live is not null)::int`,
      dualRail: sql<number>`count(*) filter (where array_length(rails, 1) > 1)::int`,
      rails: rail
        ? sql<number>`count(*) filter (where ${rail} = any(rails))::int`
        : sql<number>`(select count(distinct rail)::int from services, unnest(rails) rail where delisted_at is null)`,
    })
    .from(t)
    .where(scope);
  const [probeAgg] = await db.select({ lastProbe: sql<string | null>`max(probed_at)::text` }).from(schema.probes);
  return { total: row.total, live: row.live, probed: row.probed, dual_rail: row.dualRail, rails: rail ? (row.total > 0 ? 1 : 0) : row.rails, last_probe_at: probeAgg?.lastProbe ?? null };
}

export async function getService(id: string) {
  const [s] = await db.select().from(schema.services).where(eq(schema.services.id, id)).limit(1);
  if (!s) return null;
  const sources = await db.select().from(schema.serviceSources).where(eq(schema.serviceSources.serviceId, id));
  const probes = await db.select().from(schema.probes).where(eq(schema.probes.serviceId, id)).orderBy(desc(schema.probes.probedAt)).limit(20);
  return {
    ...serviceToJson(s, sources.map((x) => x.source)),
    source_urls: sources.map((x) => ({ source: x.source, url: x.sourceUrl })),
    probes: probes.map((p) => ({ probed_at: p.probedAt.toISOString(), ok: p.ok, status_code: p.statusCode, method: p.method, latency_ms: p.latencyMs })),
  };
}
