#!/usr/bin/env node
// The stdio entry point: `node dist/mcp/main.js`, and the same code behind `superstables mcp`.
//
// stdout belongs to the protocol. Every diagnostic here goes to stderr, because one stray
// console.log would be parsed as a malformed JSON-RPC message and the client would drop the
// connection with no explanation.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findServices, getService } from "../core/discovery.js";
import { approvePortFromEnvironment, homeDir, policyPath, recordsDir } from "../core/home.js";
import { PaymentEngine } from "../core/pay.js";
import { loadPolicy } from "../core/policy.js";
import { Records } from "../core/records.js";
import { BrowserWalletSigner } from "../core/signer/browser.js";
import type { Signer } from "../core/signer/types.js";
import { WalletSigner } from "../core/signer/wallet.js";
import type { WalletStatus } from "../core/types.js";
import { clientVersion } from "../core/version.js";
import { createSuperstablesServer } from "./server.js";

/** Which signer asks the owner. Browser by default: it needs no process of the owner's own. */
export type WalletMode = "browser" | "local";

export function walletModeFromEnvironment(): WalletMode {
  return process.env.SUPERSTABLES_WALLET === "local" ? "local" : "browser";
}

/**
 * The signer this machine is configured for. Neither of them holds a key: the browser signer
 * serves an approval page this process owns and waits for a browser wallet to sign; the local
 * one posts to the wallet process and waits for the owner there.
 */
export function signerFor(mode: WalletMode = walletModeFromEnvironment()): Signer & { status(): Promise<WalletStatus> } {
  if (mode === "local") return new WalletSigner();
  // A port the owner chose is kept as chosen; with none, the default, or a free port when
  // another payment is already waiting on the default.
  return new BrowserWalletSigner({ port: approvePortFromEnvironment() });
}

/**
 * The server this machine is configured for: records under SUPERSTABLES_HOME, the owner's
 * policy file, and a signer that asks the owner to approve. Nothing here holds a key.
 */
export function serverFromEnvironment(): McpServer {
  const records = new Records(recordsDir());
  const policy = loadPolicy(policyPath());
  const signer = signerFor();
  const engine = new PaymentEngine({ records, policy, signer });
  return createSuperstablesServer({ records, policy, engine, signer, findServices, getService });
}

/** Serve MCP over stdin/stdout until the client goes away. Resolves when the transport closes. */
export async function runStdioServer(): Promise<void> {
  let server: McpServer;
  try {
    server = serverFromEnvironment();
  } catch (err) {
    console.error(`superstables mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // One line, on stderr, saying which build just started and where it will keep its state.
  // A host that kept an older copy of this server around says so here, in its own log, before
  // anybody has to ask a tool — and stdout stays the protocol's alone.
  console.error(
    `superstables client ${clientVersion()} · home ${homeDir()} · wallet ${walletModeFromEnvironment()}`,
  );
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    transport.onclose = done;
    // A stdio client that goes away closes this process's stdin. That is the end of the
    // session, and waiting for a close message that will never arrive would hang the exit.
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
  await server.close().catch(() => undefined);
}

/** True when this file was started directly, rather than imported by the CLI. */
function startedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  await runStdioServer();
}
