// The real thing, opt-in: a funded test wallet, the demo service settling through the public
// facilitators, and two payments on Base Sepolia — one the owner approves, one the owner
// rejects. Runs only with SUPERSTABLES_LIVE=1 and a wallet key at
// $SUPERSTABLES_LIVE_HOME/wallet/key (a testnet key with a little USDC; no ETH is needed).
//
//   SUPERSTABLES_LIVE=1 SUPERSTABLES_LIVE_HOME=~/.superstables-live npm run test:live
//
// The recipient is SUPERSTABLES_LIVE_PAY_TO, or a fresh random address (test USDC sent there
// is simply gone, which is fine on a testnet).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usdcBalance } from "../../src/core/chain.js";
import { demoService } from "../../src/core/discovery.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import type { WalletRequestView } from "../../src/core/types.js";
import { startDemoService } from "../../src/demo-service/server.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";

const live = process.env.SUPERSTABLES_LIVE === "1";
const liveHome = process.env.SUPERSTABLES_LIVE_HOME;

describe.skipIf(!live || !liveHome)("Base Sepolia, for real", () => {
  let wallet: WalletHandle;
  let service: Awaited<ReturnType<typeof startDemoService>>;
  let records: Records;
  let engine: PaymentEngine;
  const payTo = process.env.SUPERSTABLES_LIVE_PAY_TO ?? privateKeyToAccount(generatePrivateKey()).address;

  beforeAll(async () => {
    wallet = await startWallet({
      port: 0,
      // the signer below reaches the wallet at its URL
      tcp: true,
      dir: join(liveHome!, "wallet"),
      policy: DEFAULT_POLICY,
      approvalTimeoutMs: 60_000,
      quiet: true,
      openBrowser: false,
    });
    service = await startDemoService({ port: 0, payTo, priceDecimal: 0.01, quiet: false });
    process.env.SUPERSTABLES_DEMO_SERVICE_URL = `${service.url}/v1/market`;
    records = new Records(mkdtempSync(join(tmpdir(), "superstables-live-")));
    engine = new PaymentEngine({
      records,
      policy: DEFAULT_POLICY,
      signer: new WalletSigner({ url: wallet.url, agentToken: wallet.agentToken }),
    });
    const balance = await usdcBalance(wallet.address);
    console.log(`wallet ${wallet.address} has ${balance} USDC; paying ${payTo}`);
    expect(balance).toBeGreaterThan(0.02);
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    await wallet?.close();
  });

  async function pendingRequest(): Promise<WalletRequestView> {
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${wallet.url}/owner/requests`, { headers: { authorization: `Bearer ${wallet.ownerSecret}` } });
      const { requests } = (await res.json()) as { requests: WalletRequestView[] };
      const pending = requests.find((r) => r.status === "pending");
      if (pending) return pending;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("no pending request reached the wallet");
  }

  // approving confirms the amount, recipient and chain the request showed, as the owner's page does
  const decide = (request: WalletRequestView, action: "approve" | "deny") =>
    fetch(`${wallet.url}/owner/requests/${request.id}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${wallet.ownerSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ amountAtomic: request.verified.amountAtomic, recipient: request.verified.recipient, network: request.verified.network }),
    });

  it("pays the demo service once the owner approves, and records the transaction", async () => {
    const q = await quote({ service: demoService(), params: { asset: "BTC" } }, { records, policy: DEFAULT_POLICY });
    expect(q.terms.amountDecimal).toBe(0.01);
    expect(q.terms.recipient.toLowerCase()).toBe(payTo.toLowerCase());

    const attempt = engine.startPayment(q.id);
    const pending = await pendingRequest();
    expect(pending.verified.amountAtomic).toBe("10000");
    expect(pending.verified.recipient.toLowerCase()).toBe(payTo.toLowerCase());
    await decide(pending, "approve");

    const done = await engine.waitForAttempt(attempt.id, 120_000);
    console.log(`attempt ${done.state}: ${done.transactionUrl ?? done.reason}`);
    expect(done.state).toBe("settled");
    expect(done.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const receipt = engine.getReceipt(attempt.id)!;
    expect(receipt.serviceOutcome).toBe("ok");
    expect(JSON.parse(done.serviceBody!).asset).toBe("BTC");
  }, 180_000);

  it("signs nothing when the owner rejects", async () => {
    const q = await quote({ service: demoService(), params: { asset: "ETH" } }, { records, policy: DEFAULT_POLICY });
    const attempt = engine.startPayment(q.id);
    const pending = await pendingRequest();
    await decide(pending, "deny");
    const done = await engine.waitForAttempt(attempt.id, 30_000);
    expect(done.state).toBe("denied");
    expect(done.transaction).toBeUndefined();
    expect(engine.getReceipt(attempt.id)).toBeUndefined();
  }, 60_000);
});
