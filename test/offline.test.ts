// The offline guard itself (test/setup-offline.ts, test/fetch-guard.mjs): non-live tests cannot reach the network.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe.skipIf(process.env.SUPERSTABLES_LIVE)("offline tests", () => {
  it("block fetch to any host but this computer, here and in the node processes a test starts", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(/offline test: a request to example.com was blocked/);
    const child = spawnSync(process.execPath, ["-e", "fetch('https://example.com/').then(() => console.log('reached'), (e) => console.log(e.message))"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(child.stdout).toContain("offline test: a request to example.com was blocked");
  });

  it("answer the third-party coin price service the built-in catalogue lists with a local stand-in", async () => {
    const res = await fetch("https://x402-coin-api.vercel.app/api/price?symbol=BTC");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("offline test stand-in");
  });

  it("read the chain through an address on this computer, whatever the environment said", () => {
    for (const name of ["SUPERSTABLES_RPC_URL", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) {
      expect(process.env[name], name).toBe("http://127.0.0.1:9/");
    }
    expect(process.env.B4_RPC).toBeUndefined();
  });
});
