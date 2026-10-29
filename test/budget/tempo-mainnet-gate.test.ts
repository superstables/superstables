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

it.each([undefined, "1", "true", "yes"])("Tempo precheck consults the mainnet switch (%s)", (value) => {
  vi.stubEnv("SUPERSTABLES_ALLOW_MAINNET", value);
  const r = precheckCharge(charge(4217), { maxBase: 1000n });
  expect(r).toMatchObject({ ok: false, code: "wrong_chain" });
  if (r.ok) throw new Error("mainnet must remain unsupported");
  expect(r.reason).toContain(value === "1" || value === "true" ? "not Tempo Moderato" : "SUPERSTABLES_ALLOW_MAINNET");
  if (value === "yes") expect(r.reason).toContain('is "yes"');
  expect(precheckCharge(charge(99999), { maxBase: 1000n })).toMatchObject({ reason: "chainId 99999 is not Tempo Moderato (42431)" });
  expect(precheckCharge(charge(42431), { maxBase: 1000n })).toMatchObject({ ok: true });
});

it.each([undefined, "1", "true", "yes"])("Tempo preflight consults the mainnet switch (%s)", async (value) => {
  const seller = await startServer((_req, res) => {
    const request = Buffer.from(JSON.stringify(charge(4217))).toString("base64url");
    res.writeHead(402, { "www-authenticate": `Payment method="tempo", intent="charge", request="${request}"` });
    res.end();
  });
  try {
    const r = await guardedNode(["--import", "tsx", fileURLToPath(new URL("../../budget/tempo/preflight.ts", import.meta.url)), "--url", seller.url], { SUPERSTABLES_ALLOW_MAINNET: value });
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(value === "1" || value === "true" ? "no tempo.charge offer on Moderato" : "SUPERSTABLES_ALLOW_MAINNET");
    if (value === "yes") expect(r.output).toContain('is \\"yes\\"');
  } finally {
    await seller.close();
  }
});
