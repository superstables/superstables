import "server-only";
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Default driver: Neon over HTTP (production; no connection pool to manage, works in Node and Edge).
 * DATABASE_DRIVER=postgres selects ordinary PostgreSQL over node-postgres instead, for private
 * copies and local development. The choice is explicit, never inferred from the URL shape, and
 * there is no fallback from one driver to the other.
 */
function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/** Query-builder surface shared by both drivers; callers never depend on driver-specific extras. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

function connect(): Db {
  if (process.env.DATABASE_DRIVER === "postgres") {
    // Small pool; idle clients close quickly and never keep short-lived processes (build workers, scripts) alive.
    const pool = new Pool({ connectionString: connectionString(), max: 5, idleTimeoutMillis: 1_000, allowExitOnIdle: true });
    return drizzlePg(pool, { schema });
  }
  return drizzleNeon(neon(connectionString()), { schema });
}

export const db: Db = connect();
export { schema };
