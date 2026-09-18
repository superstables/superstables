import { mcpManifestResponse } from "@/lib/mcp-manifest";

export const dynamic = "force-static";

/** MCP manifest at the extensionless well-known path agents probe first; same document as /.well-known/mcp.json. */
export function GET() {
  return mcpManifestResponse();
}
