// Applies pending SQL migrations from ./drizzle to the database.
// Run locally with `npm run db:migrate` (reads .env.local) or in CI with the env vars set.
// Driver: Neon over HTTP by default; DATABASE_DRIVER=postgres uses ordinary PostgreSQL via node-postgres.
// DATABASE_URL_UNPOOLED takes precedence over DATABASE_URL for migrations (direct connection).
import { readFileSync, existsSync } from "node:fs";

for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

if (process.env.DATABASE_DRIVER === "postgres") {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
  console.log("migrations applied (postgres)");
} else {
  const { neon } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  const { migrate } = await import("drizzle-orm/neon-http/migrator");
  await migrate(drizzle(neon(url)), { migrationsFolder: "./drizzle" });
  console.log("migrations applied (neon)");
}
