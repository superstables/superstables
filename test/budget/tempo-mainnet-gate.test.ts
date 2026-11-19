import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { precheckCharge } from "../../budget/tempo/lib/precheck.mjs";
import { guardedNode } from "../helpers/guarded-process.js";
import { startServer } from "../helpers/servers.js";

afterEach(() => vi.unstubAllEnvs());

const charge = (chainId: number) => ({
  amount: "1000", currency: "0x20C0000000000000000000000000000000000000",
  recipient: "0x2222222222222222222222222222222222222222", methodDetails: { chainId },
});

// The process runs on Moderato; each value is the network mode at the check. Chain 4217 is refused as any other chain is.
it.each(["1", "", "false", "yes"])("Tempo precheck refuses chain 4217 as it refuses any chain but Moderato (%s)", (value) => {
  vi.stubEnv("SUPERSTABLES_TESTNET", value);
  expect(precheckCharge(charge(4217), { maxBase: 1000n })).toEqual({ ok: false, code: "wrong_chain", reason: "chainId 4217 is not Tempo Moderato (42431)" });
  expect(precheckCharge(charge(99999), { maxBase: 1000n })).toEqual({ ok: false, code: "wrong_chain", reason: "chainId 99999 is not Tempo Moderato (42431)" });
  expect(precheckCharge(charge(42431), { maxBase: 1000n })).toMatchObject({ ok: true });
});

it.each([4217, 99999])("Tempo preflight on Moderato finds no offer from a seller on chain %i", async (chainId) => {
  const seller = await startServer((_req, res) => {
    const request = Buffer.from(JSON.stringify(charge(chainId))).toString("base64url");
    res.writeHead(402, { "www-authenticate": `Payment method="tempo", intent="charge", request="${request}"` });
    res.end();
  });
  try {
    const r = await guardedNode(["--import", "tsx", fileURLToPath(new URL("../../budget/tempo/preflight.ts", import.meta.url)), "--url", seller.url], { SUPERSTABLES_TESTNET: "1" });
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain("no tempo.charge offer on Moderato (chain 42431)");
  } finally {
    await seller.close();
  }
});
