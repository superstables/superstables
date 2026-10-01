// The server as an MCP client actually starts it: a real `npx tsx src/mcp/main.ts` process,
// spoken to over stdio by a real MCP client, with the environment a client config hands over —
// including `${…}` placeholders nobody expanded, and a HOME of its own so the run cannot touch
// the machine's real one.
//
// Everything else in the test suite drives the server in-process, which cannot catch the two
// failures that matter most when the server is started by someone else: an older copy of the
// server still running after an update, with nothing on screen saying so; and a home directory
// that was not where anyone thought it was. So this file asks the server what it is — its version and its
// home — through the same door an agent uses, and checks that the answer is the truth about
// this process: the version in package.json, and the home derived from HOME.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeFacilitator, type FakeFacilitator } from "../helpers/fake-facilitator.js";
import { startPaidEndpoint, type PaidEndpoint } from "../helpers/paid-endpoint.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/** Spawning a TypeScript server through npx is the slow part; everything after it is loopback. */
const TIMEOUT_MS = 60_000;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

let host: string;
let facilitator: FakeFacilitator;
let endpoint: PaidEndpoint;
let transport: StdioClientTransport;
let client: Client;
let stderr = "";

beforeAll(async () => {
  host = mkdtempSync(join(tmpdir(), "superstables-host-test-"));
  facilitator = await startFakeFacilitator();
  endpoint = await startPaidEndpoint({
    priceDecimal: 0.01,
    payTo: privateKeyToAccount(generatePrivateKey()).address,
    facilitatorUrl: facilitator.url,
  });

  transport = new StdioClientTransport({
    command: NPX,
    args: ["tsx", "src/mcp/main.ts"],
    cwd: ROOT,
    stderr: "pipe",
    env: {
      ...stringEnv(process.env),
      // Placeholders a client config left unexpanded: not a path and not a URL.
      SUPERSTABLES_HOME: "${SUPERSTABLES_HOME}",
      SUPERSTABLES_WALLET_URL: "${SUPERSTABLES_WALLET_URL}",
      // So the server's idea of "the user's home" is this directory and nothing else.
      HOME: host,
      USERPROFILE: host,
    },
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => (stderr += String(chunk)));

  client = new Client({ name: "superstables-host-test", version: "0.0.0" });
  await client.connect(transport);
}, TIMEOUT_MS);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await endpoint?.close();
  await facilitator?.close();
  rmSync(host, { recursive: true, force: true });
});

describe("the MCP server as an MCP client starts it", () => {
  it("offers the six tools over a real stdio transport", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "find_services",
      "list_receipts",
      "pay",
      "payment_status",
      "quote",
      "wallet_status",
    ]);
  }, TIMEOUT_MS);

  it("says which build is running and where its home is", async () => {
    const status = structured<{ running: boolean; mode?: string; home?: string; client_version?: string }>(
      await call("wallet_status", {}),
    );
    expect(status.running).toBe(true);
    expect(status.mode).toBe("browser");
    // The placeholder is not a path: the home is the default one, under the HOME given above.
    expect(status.home).toBe(join(host, ".superstables"));
    expect(status.client_version).toBe(PACKAGE_VERSION);
  }, TIMEOUT_MS);

  it("logs one identity line to stderr, and keeps stdout for the protocol", async () => {
    // The connection above only works if nothing but JSON-RPC was written to stdout.
    await waitFor(() => stderr.includes("superstables client "));
    expect(stderr).toContain(`superstables client ${PACKAGE_VERSION} · home ${join(host, ".superstables")} · wallet browser`);
  }, TIMEOUT_MS);

  it("quotes a paid endpoint without paying anything", async () => {
    const quoted = structured<{ quote_id: string; price: { amount: number; asset: string } }>(
      await call("quote", { url: endpoint.url }),
    );
    expect(quoted.quote_id).toMatch(/[0-9a-f-]{36}/);
    expect(quoted.price).toMatchObject({ amount: 0.01, asset: "USDC" });
    expect(endpoint.hits.paid).toBe(0);
  }, TIMEOUT_MS);
});

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured<T>(result: ToolResult): T {
  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

/** The startup line races the first tool call; give it a moment rather than a sleep. */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** process.env with the unset variables dropped: the transport takes strings only. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>;
}
