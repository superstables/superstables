// A wait on the local wallet that ends abnormally (the poll fails, an HTTP error, a cut-off body) after the request exists
// must cancel the request in the wallet before the agent forgets its id, and must say what it knows. Here the wallet is
// real, on a throwaway loopback port with a scratch key and policy; only the agent's transport is made to fail.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { usdcRequirement } from "../../src/core/chain.js";
import type { Policy } from "../../src/core/policy.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { SignRefused, type Eip3009SignRequest } from "../../src/core/signer/types.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";

const PAYEE = "0x2222222222222222222222222222222222222222";
const POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: [],
  stablecoins: ["USDC"],
  killSwitch: false,
  approval: "ask-every-payment",
};
const REQ = { kind: "eip3009", x402Version: 2, requirements: usdcRequirement(0.03, PAYEE) } as Eip3009SignRequest;

const dirs: string[] = [];
const wallets: WalletHandle[] = [];
afterEach(async () => {
  while (wallets.length) await wallets.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function realWallet(): Promise<WalletHandle> {
  const dir = mkdtempSync(join(tmpdir(), "superstables-lost-poll-"));
  dirs.push(dir);
  const wallet = await startWallet({
    port: 0, tcp: true, dir, account: privateKeyToAccount(generatePrivateKey()), policy: POLICY, quiet: true, openBrowser: false,
    balance: false, launcherDir: join(dir, "open"),
  });
  wallets.push(wallet);
  return wallet;
}

const call = (w: WalletHandle, path: string, token: string, method = "GET") =>
  fetch(`${w.url}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as SignRefused);

async function pendingId(w: WalletHandle): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const list = (await (await call(w, "/owner/requests", w.ownerSecret)).json()) as { requests: WalletRequestView[] };
    if (list.requests[0]) return list.requests[0].id;
    await sleep(10);
  }
  throw new Error("no request reached the wallet");
}

interface Faults {
  /** What a poll (GET /requests/:id) does: pass, fail before reaching the wallet, or reach it and lose the answer. */
  poll?: "pass" | "fail-before" | "lose-signed" | "lose-denied" | "http-500" | "truncated" | "null";
  /**
   * What the cancel does: pass, fail, answer 404 like a 0.4.0 wallet, answer 503 with a body that imitates a 409,
   * answer 200 with a view that confirms nothing, or fail slowly on its first call only.
   */
  cancel?: "pass" | "fail" | "404" | "503-spoof" | "pending" | "fail-slow-once";
}
function transport(faults: Faults) {
  const calls: string[] = [];
  let cancels = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path.replace(/\/requests\/[^/]+/, "/requests/:id")}`);
    if (method === "POST" && path.endsWith("/cancel")) {
      if (faults.cancel === "fail") throw new TypeError("fetch failed");
      if (faults.cancel === "404") return new Response(JSON.stringify({ error: "no such route" }), { status: 404 });
      if (faults.cancel === "503-spoof") return new Response(JSON.stringify({ error: "(HTTP 409)" }), { status: 503 });
      if (faults.cancel === "pending") return new Response(JSON.stringify({ id: "x", status: "pending" }), { status: 200 });
      if (faults.cancel === "fail-slow-once" && cancels++ === 0) {
        await sleep(200);
        throw new TypeError("fetch failed");
      }
    }
    if (method === "GET" && /^\/requests\/[^/]+$/.test(path)) {
      if (faults.poll === "fail-before") throw new TypeError("fetch failed");
      if (faults.poll === "http-500") return new Response("boom", { status: 500 });
      if (faults.poll === "truncated") return new Response('{"id":"x","status":"pen', { status: 200 });
      if (faults.poll === "null") return new Response("null", { status: 200 });
      const real = await fetch(input, init);
      if (faults.poll === "lose-signed") {
        const body = (await real.clone().json()) as WalletRequestView;
        if (body.status === "signed") throw new TypeError("fetch failed");
      }
      if (faults.poll === "lose-denied") {
        const body = (await real.clone().json()) as WalletRequestView;
        if (body.status === "denied") throw new TypeError("fetch failed");
      }
      return real;
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}
const signerOn = (w: WalletHandle, t: ReturnType<typeof transport>) =>
  new WalletSigner({ url: w.url, agentToken: w.agentToken, fetchImpl: t.fetchImpl, pollMs: 20, timeoutMs: 30_000 });

describe("a wait that ends abnormally cancels the request first", () => {
  it("1. the poll fails: the request is cancelled, so approving it later signs nothing, and the refusal says so", async () => {
    const w = await realWallet();
    const t = transport({ poll: "fail-before" });
    const signer = signerOn(w, t);
    const err = await refusal(signer.sign(REQ));
    await signer.close();
    expect(err).toBeInstanceOf(SignRefused);
    expect(err?.message).toMatch(/cancelled/);
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(1);
    const id = await pendingId(w);
    expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(409);
    const after = (await (await call(w, `/requests/${id}`, w.agentToken)).json()) as WalletRequestView;
    expect(after.status).toBe("expired");
    expect(after.result).toBeUndefined();
  });

  it("2. an HTTP error and a cut-off body on the poll are cancelled the same way", async () => {
    for (const poll of ["http-500", "truncated", "null"] as const) {
      const w = await realWallet();
      const t = transport({ poll });
      const err = await refusal(signerOn(w, t).sign(REQ));
      expect(err).toBeInstanceOf(SignRefused);
      expect(err?.code).toBe("unavailable");
      expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(1);
      const id = await pendingId(w);
      expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(409);
      await w.close();
      wallets.pop();
    }
  });

  it("3. a signature handed out whose answer was lost is unknown, never a final failure", async () => {
    const w = await realWallet();
    const t = transport({ poll: "lose-signed" });
    const pending = refusal(signerOn(w, t).sign(REQ));
    const id = await pendingId(w);
    expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(200);
    const err = await pending;
    expect(err?.code).toBe("unknown");
    expect(err?.message).toMatch(/superstables status/);
    expect(err?.message).not.toMatch(/nothing was signed|signs nothing/);
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(1);
  });

  it("4. a cancel that fails is not reported as a cancel: unknown, with the request still open, and close() tries again", async () => {
    const w = await realWallet();
    const faults: Faults = { poll: "fail-before", cancel: "fail" };
    const t = transport(faults);
    const signer = signerOn(w, t);
    const err = await refusal(signer.sign(REQ));
    expect(err?.code).toBe("unknown");
    expect(err?.message).not.toMatch(/nothing was signed|signs nothing|was cancelled/);
    expect(err?.message).toMatch(/could not be reached to cancel/);
    const id = await pendingId(w);
    // still pending in the wallet: an approval now would sign
    faults.cancel = "pass";
    await signer.close();
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(2);
    expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(409);
  });

  it("5. a 0.4.0 wallet without /cancel is named, and the refusal is unknown, not a final failure", async () => {
    const w = await realWallet();
    const t = transport({ poll: "fail-before", cancel: "404" });
    const err = await refusal(signerOn(w, t).sign(REQ));
    expect(err?.code).toBe("unknown");
    expect(err?.message).toMatch(/0\.4\.0/);
    expect(err?.message).toMatch(/cannot cancel/);
    // a restarted wallet that lost the request answers 404 too, so the text must not blame the version alone
    expect(err?.message).toMatch(/does not know this request/);
  });

  it("6. the deadline with a cancel that fails is unknown too, not 'expired, nothing signed'", async () => {
    const w = await realWallet();
    const t = transport({ cancel: "fail" });
    const signer = new WalletSigner({ url: w.url, agentToken: w.agentToken, fetchImpl: t.fetchImpl, pollMs: 20, timeoutMs: 1100 });
    const err = await refusal(signer.sign(REQ));
    expect(err?.code).toBe("unknown");
    expect(err?.message).not.toMatch(/signs nothing/);
  });

  it("7. a 503 whose text says (HTTP 409) is not a closed request: the status is the number, not the words", async () => {
    const w = await realWallet();
    const faults: Faults = { poll: "fail-before", cancel: "503-spoof" };
    const t = transport(faults);
    const signer = signerOn(w, t);
    const err = await refusal(signer.sign(REQ));
    expect(err?.code).toBe("unknown");
    expect(err?.message).toMatch(/could not be reached to cancel/);
    expect(err?.message).not.toMatch(/already (closed|ended)|signs nothing/);
    const id = await pendingId(w);
    faults.cancel = "pass";
    await signer.close();
    expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(409);
  });

  it("8. a cancel answer that confirms nothing (a pending view) is not a cancel", async () => {
    const w = await realWallet();
    const faults: Faults = { poll: "fail-before", cancel: "pending" };
    const t = transport(faults);
    const signer = signerOn(w, t);
    const err = await refusal(signer.sign(REQ));
    expect(err?.code).toBe("unknown");
    expect(err?.message).not.toMatch(/was cancelled|signs nothing/);
    faults.cancel = "pass";
    await signer.close();
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(2);
  });

  it("9. an owner denial whose poll answer was lost is recorded as denied, not as a lost wait", async () => {
    const w = await realWallet();
    const t = transport({ poll: "lose-denied" });
    const pending = refusal(signerOn(w, t).sign(REQ));
    const id = await pendingId(w);
    expect((await call(w, `/owner/requests/${id}/deny`, w.ownerSecret, "POST")).status).toBe(200);
    const err = await pending;
    expect(err?.code).toBe("denied");
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(1);
  });

  it("10. close() while the first cancel is in flight and then fails tries again", async () => {
    const w = await realWallet();
    const t = transport({ poll: "fail-before", cancel: "fail-slow-once" });
    const signer = signerOn(w, t);
    const waiting = refusal(signer.sign(REQ));
    for (let i = 0; i < 200 && !t.calls.some((c) => c.endsWith("/cancel")); i++) await sleep(10);
    await signer.close();
    const err = await waiting;
    expect(err?.code).toBe("unknown");
    expect(t.calls.filter((c) => c.endsWith("/cancel"))).toHaveLength(2);
    const id = await pendingId(w);
    expect((await call(w, `/owner/requests/${id}/approve`, w.ownerSecret, "POST")).status).toBe(409);
  });
});
