import { listServices, stats } from "@/lib/directory/query";
import { SITE } from "@/lib/site";

export const dynamic = "force-dynamic";

const ROWS = 100;

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/**
 * Markdown twin of /discover: the census and the first page of the index as a table, with links to
 * every service page, the JSON API and the whole-index feed. Built from the database on request.
 */
export async function GET() {
  try {
    const [counts, services] = await Promise.all([stats(), listServices({ limit: ROWS })]);
    const rows = services.map((s) =>
      `| [${esc(s.name)}](${SITE}/s/${s.id}) | ${s.rails.join(", ")} | ${s.chains.join(", ") || "-"} | ${s.assets.join(", ") || "-"} | ${s.live === true ? "live" : s.live === false ? "no answer" : "not probed"} | ${esc(s.description ?? s.category ?? "").slice(0, 120)} |`
    );
    const body = `---
title: Discover payable services
description: The neutral, liveness-probed index of every service an AI agent can pay with stablecoins, across x402, MPP and ACP.
canonical: ${SITE}/discover
last-updated: ${new Date().toISOString().slice(0, 10)}
---

# Discover payable services

> ${counts.total} indexed services; ${counts.live} answered a valid payment challenge on the last probe; ${counts.dual_rail} are listed on more than one rail.

This is the first ${services.length} of ${counts.total} services, ordered live first, then most recently seen live.
The full index: [JSON API](${SITE}/api/v1/services) (filters: rail, chain, asset, live=true, q, limit, offset),
[whole index as JSONL](${SITE}/feeds/services.jsonl), [OpenAPI spec](${SITE}/openapi.json).

| Service | Rails | Chains | Assets | Status | Description |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Reading the table

- live: answered HTTP 402, a payment-challenge header or a challenge body on our last probe.
- no answer: did not answer a payment challenge on the last probe. Probe history is on each service page.
- not probed: non-HTTP entries (for example acp://) are listed but never marked dead.

[List a service](${SITE}/submit) · [API reference](${SITE}/docs.md) · [Homepage](${SITE}/index.md)
`;
    return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "s-maxage=300, stale-while-revalidate=3600" } });
  } catch {
    return new Response("# Discover payable services\n\nThe index is temporarily unavailable. Retry with backoff.\n", {
      status: 500,
      headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": "no-store" },
    });
  }
}
