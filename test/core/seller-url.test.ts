// The network boundary for a seller: https, or plain http on this computer only. A payment request read over plain
// http can be rewritten on the way (price and recipient), and a signed payment read there can be replayed, so
// nothing that could carry either goes to such a URL, and nothing is asked first.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { sellerUrlProblem } from "../../src/core/seller-url.mjs";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "../helpers/servers.js";

const open: TestServer[] = [];
const dirs: string[] = [];

/** A fresh records folder, removed after the test. */
function recordsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "superstables-seller-url-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe("sellerUrlProblem", () => {
  it("accepts https, and plain http on 127.0.0.1, localhost and [::1]", () => {
    for (const url of ["https://a.example/x", "https://a.example:8443/x?y=1", "http://127.0.0.1:1/x", "http://localhost:1/x", "http://[::1]:1/x"]) {
      expect(sellerUrlProblem(url), url).toBeUndefined();
    }
  });

  it("refuses plain http elsewhere, including the rest of 127/8", () => {
    for (const url of ["http://example.com/x", "http://127.0.0.2:1/x", "http://10.0.0.1/x", "http://localhost.example.com/x"]) {
      expect(sellerUrlProblem(url), url).toMatch(/^is plain http: only https is accepted, or http on this computer \(127\.0\.0\.1, localhost or \[::1\]\)$/);
    }
  });

  it("judges the host as the URL parser reads it: look-alikes are refused, other spellings of this computer are not", () => {
    for (const url of ["http://[::ffff:127.0.0.1]/", "http://127.0.0.1.nip.io/", "http://localhost./", "http://localhost.evil.com/", "http://user@127.0.0.1/"]) {
      expect(sellerUrlProblem(url), url).toBeDefined();
    }
    for (const url of ["http://LOCALHOST/", "http://127.1/"]) {
      expect(sellerUrlProblem(url), url).toBeUndefined();
    }
  });

  it("refuses a user name or password, on any scheme", () => {
    for (const url of ["http://user:pw@127.0.0.1/x", "https://user@a.example/x", "https://:pw@a.example/x"]) {
      expect(sellerUrlProblem(url), url).toBe("carries a user name or password");
    }
  });

  it("refuses other schemes and text that is not a URL", () => {
    expect(sellerUrlProblem("ftp://a/x")).toBe("is not an https URL");
    expect(sellerUrlProblem("file:///etc/passwd")).toBe("is not an https URL");
    expect(sellerUrlProblem("not a url")).toBe("is not a URL");
    expect(sellerUrlProblem("")).toBe("is not a URL");
  });
});

describe("a seller URL that is not allowed", () => {
  it("is refused by quote before any request", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const records = new Records(recordsDir());
    for (const url of ["http://example.com/x", "http://127.0.0.2:9/x", "ftp://a/x", "http://user:pw@127.0.0.1:9/x"]) {
      await expect(quote({ url }, { records, policy: DEFAULT_POLICY }), url).rejects.toThrow(/^the seller URL /);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is refused by startPayment on an open quote saved with it: nothing is claimed, asked or sent", async () => {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    const wallet = await startWallet();
    open.push(facilitator, seller, wallet);
    const records = new Records(recordsDir());
    const fetchImpl = vi.fn(async () => new Response("", { status: 402 }));
    const engine = new PaymentEngine({
      records,
      policy: DEFAULT_POLICY,
      signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const q = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records, policy: DEFAULT_POLICY });
    // An old quote, or one written by hand: the same quote, naming a seller on plain http.
    records.saveQuote({ ...q, url: "http://example.com/v1/market?asset=BTC" });

    expect(() => engine.startPayment(q.id)).toThrow(/^This quote's seller URL is plain http: .*; nothing was started\. Quote an https URL$/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.attemptForQuote(q.id)).toBeUndefined();
    expect(records.listAttempts()).toHaveLength(0);
    expect(records.getQuote(q.id)?.status).toBe("open");
  });
});
