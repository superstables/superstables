// The local owner page's /account route: an address other than the owner's changes nothing.
import { afterAll, describe, expect, it } from "vitest";
import { OwnerApprovalServer } from "../../src/core/signer/owner-approval-server.js";

const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TO = "0x4444444444444444444444444444444444444444";

const server = new OwnerApprovalServer();
afterAll(() => server.close?.());

async function open() {
  await server.start();
  const h = server.request({ kind: "evm-transaction", chain: "base-sepolia", terms: { title: "Grant", summary: "s", enforced: [], notEnforced: [] }, account: OWNER, timeoutMs: 60_000, transaction: { to: TO, data: "0x", value: "0x0" } } as any);
  const u = new URL(h.url);
  const post = async (leaf: string, body: unknown) => {
    const r = await fetch(`${u.origin}${u.pathname}/${leaf}${u.search}`, { method: "POST", headers: { "content-type": "application/json", origin: u.origin }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const state = async () => (await (await fetch(`${u.origin}${u.pathname}/state${u.search}`)).json()) as any;
  return { h, post, state };
}

describe("owner page /account", () => {
  it("A1: another address after the owner connected answers 409, keeps ready, and the owner's send still works", async () => {
    const { h, post, state } = await open();
    expect((await post("account", { address: OWNER })).status).toBe(200);
    const wrong = await post("account", { address: OTHER });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatch(new RegExp(`this must be sent from ${OWNER}`));
    expect((await state()).status).toBe("ready");
    expect((await post("sending", { address: OWNER })).status).toBe(200);
    h.finish?.({ outcome: "failed", message: "test" } as any);
  });

  it("A2: another address while pending answers 409 and stays pending; the owner then connects", async () => {
    const { h, post, state } = await open();
    const wrong = await post("account", { address: OTHER });
    expect(wrong.status).toBe(409);
    expect((await state()).status).toBe("pending");
    expect((await post("account", { address: OWNER })).status).toBe(200);
    expect((await state()).status).toBe("ready");
    h.finish?.({ outcome: "failed", message: "test" } as any);
  });
});
