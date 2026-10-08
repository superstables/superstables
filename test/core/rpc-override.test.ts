import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardedNode } from "../helpers/guarded-process.js";
import { readBody, sendJson, startServer } from "../helpers/servers.js";

describe("Tempo balance RPC", () => {
  it("reads the balance through SUPERSTABLES_TEMPO_RPC", async () => {
    const home = mkdtempSync(join(tmpdir(), "tempo-balance-rpc-"));
    const guardLog = join(home, "network.log");
    writeFileSync(guardLog, "");
    const calls: string[] = [];
    const rpc = await startServer(async (req, res) => {
      const request = JSON.parse(await readBody(req));
      calls.push(request.method);
      sendJson(res, 200, { jsonrpc: "2.0", id: request.id, result: `0x${1_000_000n.toString(16).padStart(64, "0")}` });
    });
    try {
      const child = await guardedNode(["--import=tsx", "--input-type=module", "-e", `
        import { usdcBalance, TEMPO_MODERATO } from "./src/core/chain.ts";
        console.log(await usdcBalance("0x1111111111111111111111111111111111111111", TEMPO_MODERATO));
      `], { HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_TEMPO_RPC: rpc.url, SUPERSTABLES_NETWORK_GUARD_LOG: guardLog });
      expect({ ...child, guard: readFileSync(guardLog, "utf8") }).toEqual({ code: 0, output: "1\n", guard: "" });
      expect(calls).toEqual(["eth_call"]);
    } finally { await rpc.close(); rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
