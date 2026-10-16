// buy-once names the wallet expected to pay: the hosted owner this machine recorded for that rail and chain on the same
// site, sent only to a site that lists `expected_payer`, echoed back, and checked again when a payment is attributed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_MARKET, SOLANA_PAYER, TEMPO_MARKET, TX, startFakePurchaseSite, type FakePurchaseSite } from "../helpers/fake-purchase-site.js";

process.env.SUPERSTABLES_HOME = mkdtempSync(join(tmpdir(), "ss-payer-"));
const { messageForOwner, settleOnce, startOnce } = await import("../../budget/once.mjs");
const approvals = await import("../../budget/approvals.mjs");
const home = process.env.SUPERSTABLES_HOME;

const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER = "0x4444444444444444444444444444444444444444";
let site: FakePurchaseSite;

beforeEach(async () => {
  rmSync(join(home, "budget"), { recursive: true, force: true });
  site = await startFakePurchaseSite();
  site.finalizedBlock = 1000;
  site.finalizedSlot = 1000;
  site.services.push(TEMPO_MARKET, SOLANA_MARKET);
  for (const key of ["B4_RPC", "SUPERSTABLES_TEMPO_RPC", "SUPERSTABLES_SOLANA_RPC"]) process.env[key] = site.chainUrl;
});
afterEach(async () => { await site.close(); });
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The public file `setup --hosted` writes: the owner, and the site the approvals go through. */
function publicFile(name: string, lines: string[]) {
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  writeFileSync(join(home, "budget", "public", `${name}.env`), `${lines.join("\n")}\n`);
}
const hostedOwner = (over: { site?: string; owner?: string; mode?: string } = {}) =>
  publicFile("evm-base-sepolia", [`B4_OWNER_ADDRESS=${over.owner ?? OWNER}`, `APPROVALS=${over.mode ?? "hosted"}`, `SITE=${over.site ?? site.url}`]);
const buy = (service = "demo-market-data"): Promise<any> => startOnce({ site: site.url, service, params: { asset: "BTC" }, max: "0.01" });
const bodyOf = () => site.purchases[0]?.body as Record<string, unknown>;

describe("expected payer at creation", () => {
  it("P1: a recorded hosted owner and the feature: the body names it, the record keeps it, and a payment by that owner is paid", async () => {
    site.features = ["expected_payer"];
    hostedOwner();
    const r = await buy();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bodyOf()).toMatchObject({ service_id: "demo-market-data", expected_payer: OWNER });
    expect(site.purchases[0].expectedPayer).toBe(OWNER);
    expect(r.record.expectedPayer).toBe(OWNER);
    site.settle(site.purchases[0], "ok", { transaction: TX, payer: OWNER });
    expect(await settleOnce(approvals.readApproval(r.record.id))).toMatchObject({ code: 0, result: { paid: true } });
  });

  it("P1b: the owner's lowercase spelling is sent, and the checksummed echo matches", async () => {
    site.features = ["expected_payer"];
    hostedOwner({ owner: "0x2222222222222222222222222222222222222222".toUpperCase().replace("0X", "0x") });
    // the listing's site stores it checksummed; the client accepts the echo whatever the case
    const r = await buy();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bodyOf().expected_payer).toBe(OWNER);
  });

  it("P1s: on Solana the base58 owner is sent as it is", async () => {
    site.features = ["expected_payer"];
    publicFile("solana-devnet", [`SOLANA_OWNER_ADDRESS=${SOLANA_PAYER}`, "APPROVALS=hosted", `SITE=${site.url}`]);
    const r = await buy(SOLANA_MARKET.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bodyOf().expected_payer).toBe(SOLANA_PAYER);
  });

  it("P1t: on Tempo the owner comes from OWNER_ADDRESS", async () => {
    site.features = ["expected_payer"];
    publicFile("tempo-moderato", [`OWNER_ADDRESS=${OWNER}`, "APPROVALS=hosted", `SITE=${site.url}`]);
    const r = await buy(TEMPO_MARKET.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(bodyOf().expected_payer).toBe(OWNER);
  });

  it("P2 (adversarial): a site that ignored it and was paid by another wallet gives unknown, naming the expected one", async () => {
    site.features = ["expected_payer"];
    hostedOwner();
    const r = await buy();
    site.settle(site.purchases[0], "ok", { transaction: TX, payer: OTHER });
    const s = await settleOnce(approvals.readApproval(r.record.id));
    expect(s).toMatchObject({ code: 5, result: { state: "unknown", paid: null } });
    expect(s.result.reason).toContain(`not ${OWNER}`);
    expect(JSON.stringify(s)).not.toMatch(/nothing was paid/);
  });

  it("P3: no recorded owner, or another site, or local approvals, means no field", async () => {
    site.features = ["expected_payer"];
    expect((await buy()).ok).toBe(true);
    expect(bodyOf()).not.toHaveProperty("expected_payer");
    for (const [i, over] of [{ site: "https://staging.superstables.com" }, { mode: "local" }].entries()) {
      rmSync(join(home, "budget"), { recursive: true, force: true });
      hostedOwner(over);
      const r = await buy();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(site.purchases[i + 1].body, JSON.stringify(over)).not.toHaveProperty("expected_payer");
    }
  });

  it("P3b: a public file with no readable owner means no field", async () => {
    site.features = ["expected_payer"];
    hostedOwner({ owner: "not an address" });
    expect((await buy()).ok).toBe(true);
    expect(bodyOf()).not.toHaveProperty("expected_payer");
  });

  it("P4: a site that does not list the feature gets no field (production refuses unknown fields)", async () => {
    hostedOwner();
    expect((await buy()).ok).toBe(true);
    expect(bodyOf()).not.toHaveProperty("expected_payer");
  });

  it("P4b: a list of other features, or an unreadable list, gets none either", async () => {
    hostedOwner();
    site.features = ["something_else"];
    expect((await buy()).ok).toBe(true);
    expect(bodyOf()).not.toHaveProperty("expected_payer");
  });

  it("P5 (adversarial): a site that lists the feature and drops the field: the purchase is cancelled and refused, its link never shown", async () => {
    site.features = ["expected_payer"];
    site.echoExpectedPayer = false;
    hostedOwner();
    const r = await buy();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not confirm the wallet expected to pay/);
    expect(r.approve).toBeUndefined();
    expect(site.purchases[0]).toMatchObject({ state: "denied", cancels: 1 });
    expect(JSON.stringify(r)).not.toContain("/approve/");
  });

  it("P5b (adversarial): an echo of another wallet is refused too", async () => {
    site.features = ["expected_payer"];
    hostedOwner();
    site.tweak = (p) => { p.expectedPayer = OTHER; };
    const r = await buy();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not confirm the wallet expected to pay/);
  });

  it("P6: message_for_owner has the Pay from line, after the Paid to line", async () => {
    site.features = ["expected_payer"];
    hostedOwner();
    const r = await buy();
    const m = messageForOwner(r.record) as string;
    const lines = m.split("\n");
    const paidTo = lines.findIndex((l) => l.startsWith("Paid to "));
    expect(lines[paidTo + 1]).toBe("Pay from 0x2222...2222.");
    // no recorded owner, no line
    expect(messageForOwner({ ...r.record, expectedPayer: undefined })).not.toContain("Pay from");
  });

  it("P7: the new words are named", async () => {
    const { siteWord } = await import("../../budget/once.mjs");
    for (const c of ["invalid_expected_payer", "payer_mismatch", "token_expired"]) expect(siteWord("error", c)).toBe(c);
    expect(siteWord("reason", "payer_mismatch")).toBe("payer_mismatch");
  });

  it("P8: a creation the site refuses as invalid_expected_payer is refused in words", async () => {
    site.features = ["expected_payer"];
    site.refuseCreate = { status: 400, error: { code: "invalid_expected_payer", message: "x" } };
    hostedOwner();
    const r = await buy();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("invalid_expected_payer");
  });
});
