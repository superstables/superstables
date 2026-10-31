// The live connector against the contract copy the plugin skill is checked with. Run by hand or by a smoke run after
// the website deploys: `npm run test:live -- test/live/connector-contract.live.test.ts`. tools/list and initialize need
// no sign-in. A failure means production serves other tools, or states another waiting rule, than the skill was
// written for: regenerate test/scripts/connector-contract.json from the connector's code and update
// plugin/skills/superstables/SKILL.md, or wait for the deploy that brings production to the contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contract = JSON.parse(readFileSync(new URL("../scripts/connector-contract.json", import.meta.url), "utf8")) as { tools: string[]; purchaseWait: { tool: string; param: string; seconds: number } };
const URL_ = process.env.SUPERSTABLES_MCP_URL ?? "https://mcp.superstables.com";

async function rpc(method: string, params?: unknown) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data: "));
  return (data ? JSON.parse(data.slice(6)) : JSON.parse(body)).result;
}

describe("the live connector", () => {
  it("serves exactly the tools in the contract, and states its waiting rule", async () => {
    const { tools } = (await rpc("tools/list")) as { tools: { name: string }[] };
    expect(tools.map((t) => t.name).sort()).toEqual([...contract.tools].sort());
    const { instructions } = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-check", version: "1" } })) as { instructions: string };
    const { tool, param, seconds } = contract.purchaseWait;
    expect(instructions).toContain(`call ${tool} with ${param} ${seconds}`);
    expect(instructions).toContain("If your app only shows your reply when the turn ends, end your turn instead");
  });
});
