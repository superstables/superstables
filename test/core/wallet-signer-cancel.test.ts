// The agent side of the local wallet: a request it stops waiting for is cancelled in the wallet, it says what it knows
// about a signature that arrived as the wait ended, and it does not return an authorization that is not the one asked for.
// The wallet is a function standing in for fetch: it records every route and answers on cue.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import { referralNonce } from "../../src/core/referral-nonce.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import { SignRefused, type Eip3009SignRequest, type Eip3009SignResult } from "../../src/core/signer/types.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";

const PAYEE = `0x${"22".repeat(20)}`;
const ID = "req-1";
const payer = privateKeyToAccount(generatePrivateKey());
const REQ = { kind: "eip3009", x402Version: 2, requirements: usdcRequirement(0.01, PAYEE) } as Eip3009SignRequest;

const view = (over: Record<string, unknown> = {}) => ({
  id: ID, status: "pending", createdAt: 0, expiresAt: 0,
  verified: { amountAtomic: "10000", amountDecimal: 0.01, asset: "USDC", network: "eip155:84532", recipient: PAYEE, payer: payer.address },
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as SignRefused);

interface Call { method: string; path: string; body?: any }
/** A wallet that keeps the request pending until told otherwise; `onCancel` answers the cancel. */
function fake(opts: { create?: () => Response; poll?: () => Response; onCancel?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST" && path === "/requests") return (opts.create ?? (() => json(view())))();
    if (method === "POST" && path === `/requests/${ID}/cancel`) return (opts.onCancel ?? (() => json(view({ status: "expired" }))))();
    return (opts.poll ?? (() => json(view())))();
  }) as typeof fetch;
  return { calls, fetchImpl, cancels: () => calls.filter((c) => c.path.endsWith("/cancel")) };
}
const signerFor = (f: ReturnType<typeof fake>, timeoutMs = 300) => new WalletSigner({ url: "http://127.0.0.1:1", agentToken: "t", fetchImpl: f.fetchImpl, pollMs: 20, timeoutMs });

describe("giving up", () => {
  it("1. the deadline ends in exactly one cancel, and the refusal says the request was cancelled", async () => {
    const f = fake();
    const err = await refusal(signerFor(f).sign(REQ));
    expect(err?.code).toBe("expired");
    expect(err?.message).toMatch(/cancelled/);
    expect(f.cancels()).toHaveLength(1);
    expect(f.cancels()[0].path).toBe(`/requests/${ID}/cancel`);
  });

  it("2. closing the signer while it waits cancels the request and ends the wait as abandoned", async () => {
    const f = fake();
    const signer = signerFor(f, 30_000);
    const pending = refusal(signer.sign(REQ));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await signer.close();
    const err = await pending;
    expect(err?.code).toBe("abandoned");
    expect(f.cancels()).toHaveLength(1);
  });

  it("3. a signature that arrived as the wait ended: withheld when not handed out, unknown when it was", async () => {
    const withheld = await refusal(signerFor(fake({ onCancel: () => json(view({ status: "signed", served: false, withheld: true })) })).sign(REQ));
    expect(withheld?.code).toBe("expired");
    expect(withheld?.message).toMatch(/withheld/);
    const served = await refusal(signerFor(fake({ onCancel: () => json(view({ status: "signed", served: true })) })).sign(REQ));
    expect(served?.code).toBe("unknown");
    expect(served?.message).toMatch(/superstables status/);
  });

  it("3b. a cancel that lands while the owner's approval is being signed: withheld, not \"cannot cancel\"", async () => {
    const err = await refusal(signerFor(fake({ onCancel: () => json(view({ status: "approved", served: false, withheld: true })) })).sign(REQ));
    expect(err?.code).toBe("expired");
    expect(err?.message).toMatch(/withheld/);
    expect(err?.message).not.toMatch(/cannot cancel/);
  });

  it("4. a wallet that cannot cancel (404) is named as such", async () => {
    const err = await refusal(signerFor(fake({ onCancel: () => json({ error: "no such route" }, 404) })).sign(REQ));
    expect(err?.code).toBe("expired");
    expect(err?.message).toMatch(/cannot cancel/);
  });

  it("7. the request carries the wait the client is prepared to make", async () => {
    const f = fake();
    await refusal(signerFor(f, 300).sign(REQ));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/requests")!;
    expect(create.body.waitMs).toBe(300);
    expect(create.body.sign.kind).toBe("eip3009");
  });
});

describe("what the wallet returns", () => {
  /** What a good wallet returns for REQ: signed by `payer`, over the request's own terms. */
  async function good(): Promise<Eip3009SignResult> {
    return new LocalKeySigner(payer).sign(REQ);
  }
  const signedView = (result: Eip3009SignResult) => json(view({ status: "signed", result }));
  const withAuth = (result: Eip3009SignResult, over: Record<string, unknown>): Eip3009SignResult =>
    ({ ...result, payload: { ...result.payload, authorization: { ...result.payload.authorization, ...over } } });

  it("returns an authorization that is the one asked for", async () => {
    const result = await good();
    const got = await signerFor(fake({ create: () => signedView(result) })).sign(REQ);
    expect(got.signer).toBe(payer.address);
  });

  it("8. a signature that arrives after the signer was closed is not returned", async () => {
    const result = await good();
    let signer!: WalletSigner;
    let polls = 0;
    const f = fake({
      poll: () => {
        polls++;
        // The signer is closed while this poll is in flight, and the answer is the signature.
        void signer.close();
        return signedView(result);
      },
      onCancel: () => json(view({ status: "signed", served: true })),
    });
    signer = signerFor(f, 30_000);
    const err = await refusal(signer.sign(REQ));
    expect(polls).toBe(1);
    expect(err).toBeInstanceOf(SignRefused);
    expect(err?.code).toBe("unknown");
  });

  it("5. refuses one that pays somebody else, another amount, an hour, or another key", async () => {
    const result = await good();
    const now = Math.floor(Date.now() / 1000);
    const other = privateKeyToAccount(generatePrivateKey());
    const variants: Eip3009SignResult[] = [
      withAuth(result, { to: `0x${"33".repeat(20)}` }),
      withAuth(result, { value: "10001" }),
      withAuth(result, { validBefore: String(now + 3600) }),
      { ...(await new LocalKeySigner(other).sign(REQ)), signer: payer.address },
    ];
    for (const variant of variants) {
      const err = await refusal(signerFor(fake({ create: () => signedView(variant) })).sign(REQ));
      expect(err).toBeInstanceOf(SignRefused);
      expect(err?.code).toBe("invalid");
      expect(err?.message).toMatch(/not the one asked for/);
    }
  });

  it("9. refuses one signed with another nonce than the request's, which would lose its referral marker", async () => {
    const asked = { ...REQ, nonce: referralNonce("ref_AAECAwQFBgcICQoLDA0ODw") } as Eip3009SignRequest;
    const honest = await new LocalKeySigner(payer).sign(asked);
    expect((await signerFor(fake({ create: () => signedView(honest) })).sign(asked)).signer).toBe(payer.address);
    // validly signed by the right key over the right terms, but with the wallet's own random nonce
    const own = await new LocalKeySigner(payer).sign(REQ);
    expect(own.payload.authorization.nonce).not.toBe(asked.nonce);
    const err = await refusal(signerFor(fake({ create: () => signedView(own) })).sign(asked));
    expect(err).toBeInstanceOf(SignRefused);
    expect(err?.code).toBe("invalid");
    expect(err?.message).toMatch(/not the one asked for \(nonce\); it was not sent/);
    // a request that names no nonce leaves the wallet's own
    expect((await signerFor(fake({ create: () => signedView(own) })).sign(REQ)).signer).toBe(payer.address);
  });
});

describe("a wallet that is busy", () => {
  it("6. 429 and 503 are unavailable (the owner was not asked), not a refusal of the payment", async () => {
    const full = await refusal(signerFor(fake({ create: () => json({ error: "three payment requests are already waiting" }, 429) })).sign(REQ));
    expect(full?.code).toBe("unavailable");
    expect(full?.message).toMatch(/already waiting/);
    const failing = await refusal(signerFor(fake({ create: () => json({ error: "the wallet could not write its audit log" }, 503) })).sign(REQ));
    expect(failing?.code).toBe("unavailable");
    expect(failing?.message).toMatch(/audit log/);
  });
});
