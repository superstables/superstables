import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { guardedNode } from "../helpers/guarded-process.js";

it("blocks fetch, net's normalized connect arguments, direct sockets, HTTP and TLS before connecting", async () => {
  const home = mkdtempSync(join(tmpdir(), "network-guard-"));
  const log = join(home, "network.log");
  try {
    const child = await guardedNode(["--input-type=module", "-e", `
      import { connect, Socket } from "node:net";
      import { connect as tlsConnect } from "node:tls";
      import { get } from "node:http";
      const runs = [
        () => connect({ host: "outside.invalid", port: 443 }),
        () => new Socket().connect({ host: "outside.invalid", port: 443 }),
        () => tlsConnect({ host: "outside.invalid", port: 443 }),
        () => get("http://outside.invalid/"),
        () => fetch("https://outside.invalid/"),
      ];
      for (const run of runs) {
        try { await run(); console.log("escaped"); }
        catch (error) { console.log(error.message); }
      }
    `], { HOME: home, SUPERSTABLES_HOME: home, SUPERSTABLES_NETWORK_GUARD_LOG: log });
    const blocked = "Blocked non-loopback network request: outside.invalid\n".repeat(5);
    expect(child).toEqual({ code: 0, output: blocked });
    expect(readFileSync(log, "utf8")).toBe(blocked);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
