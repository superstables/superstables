import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { acceptsMediaType } from "@/lib/negotiate";
import { getService, listServices, stats } from "@/lib/directory/query";

export const maxDuration = 60;

const INSTRUCTIONS = [
  "Superstables is the neutral, read-only index of services an AI agent can pay with stablecoins over x402, MPP or ACP.",
  "Use find_services to search by free text, rail, chain, asset or liveness; get_service for one record with its last 20 liveness probes; get_stats for census counts.",
  "live=true means the endpoint answered a valid payment challenge on our last probe; null means not yet probed (for example acp://).",
  "This server never executes payments and requires no authentication. Soft advisory limit: 300 requests per minute per client.",
].join(" ");

/**
 * MCP server over streamable HTTP: the index as native agent tools.
 * Connect with: { "url": "<site origin>/api/mcp" } - no auth.
 */
const handler = createMcpHandler((server) => {
  server.registerTool(
    "find_services",
    {
      title: "Find payable services",
      description:
        "Find services an AI agent can pay with stablecoins (x402, MPP or ACP). Every HTTP endpoint is independently probed; live=true means it answered a valid payment challenge on the last probe.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        q: z.string().optional().describe("Free-text search over name, category and endpoint"),
        rail: z.enum(["x402", "mpp", "acp"]).optional(),
        chain: z.string().optional().describe("base, solana, tempo, ethereum, polygon, ..."),
        asset: z.string().optional().describe("USDC, EURC, USDT, PYUSD"),
        live_only: z.boolean().optional().describe("Only services that answered our last probe"),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ q, rail, chain, asset, live_only, limit }) => {
      const services = await listServices({ q, rail, chain, asset, live: live_only ? true : undefined, limit: limit ?? 25 });
      return { content: [{ type: "text", text: JSON.stringify({ count: services.length, services }, null, 2) }] };
    }
  );

  server.registerTool(
    "get_service",
    {
      title: "Get one service",
      description: "Full record for one service by id (the slug shown by find_services), including its last 20 liveness probes.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({ id: z.string().describe("Service id, e.g. 10x402.com") }),
    },
    async ({ id }) => {
      const s = await getService(id.toLowerCase());
      if (!s) return { content: [{ type: "text", text: `No service with id "${id}".` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
    }
  );

  server.registerTool(
    "get_stats",
    {
      title: "Index census",
      description: "Census counts for the whole index: total services, how many are verified live, dual-rail count, rails covered.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await stats(), null, 2) }] })
  );
}, { serverInfo: { name: "superstables", version: "1.0.0" }, instructions: INSTRUCTIONS });

export const GET = handler;
export const POST = async (req: Request) => {
  const accept = req.headers.get("accept");
  if (!acceptsMediaType(accept, "application", "json") || !acceptsMediaType(accept, "text", "event-stream")) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Not Acceptable: client must accept application/json and text/event-stream." } },
      { status: 406, headers: { "Cache-Control": "no-store" } }
    );
  }

  // The SDK expects literal media types; expand only formats the client permits.
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  return handler(new Request(req.url, { method: "POST", headers, body: await req.text(), signal: req.signal }));
};
export const DELETE = handler;
