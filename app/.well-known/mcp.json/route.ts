import { NextResponse } from "next/server";
import { SITE } from "@/lib/site";

export const dynamic = "force-static";

/** Standard MCP manifest: same content as the server card, at the conventional path. */
const MANIFEST = {
  name: "superstables",
  displayName: "Superstables",
  iconUrl: `${SITE}/icon.svg`,
  description: "The neutral index of services an AI agent can pay with stablecoins (x402, MPP, ACP), deduplicated and independently probed for liveness. Read-only, no auth.",
  version: "1.0.0",
  endpoint: `${SITE}/api/mcp`,
  transport: "streamable-http",
  authentication: { type: "none" },
  capabilities: { tools: true },
  tools: [
    { name: "find_services", description: "Find payable services by free text, rail, chain, asset and liveness." },
    { name: "get_service", description: "Full record for one service, including its last 20 liveness probes." },
    { name: "get_stats", description: "Census counts: total, live, probed, dual-rail, rails." },
  ],
  contact: "https://x.com/superstables",
  documentation: `${SITE}/docs`,
};

export function GET() {
  return NextResponse.json(MANIFEST, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "s-maxage=3600" } });
}
