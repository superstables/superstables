// `pay` end to end on the EVM testnets beyond Base Sepolia: a local x402 seller charging in that chain's USDC, a local
// facilitator, a local chain, the real engine and the real approval page, with the test playing the owner's browser
// wallet. The two chains whose USDC signs under another name (Arbitrum's "USD Coin", SKALE's bridged USDC) and Arc,
// whose gas token is USDC itself, are the ones worth running whole.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARBITRUM_SEPOLIA, ARC_TESTNET, SKALE_BASE_SEPOLIA, type EvmNetwork } from "../../src/core/chain.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { Records } from "../../src/core/records.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { paymentReceipt, startFakeBaseSepolia } from "../helpers/fake-base-sepolia.js";
import { startFakeFacilitator } from "../helpers/fake-facilitator.js";
import { startPaidEndpoint } from "../helpers/paid-endpoint.js";

const SELLER = privateKeyToAccount(generatePrivateKey()).address;
let home: string;
const opened: { close(): Promise<void> }[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-pay-evm-"));
});
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.close();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function payOn(network: EvmNetwork) {
  const facilitator = await startFakeFacilitator();
  const seller = await startPaidEndpoint({ priceDecimal: 0.01, payTo: SELLER, facilitatorUrl: facilitator.url, network });
  const chain = await startFakeBaseSepolia();
  const dir = mkdtempSync(join(home, `${network.key}-`));
  const signer = new BrowserWalletSigner({ port: 0, home: dir, policy: DEFAULT_POLICY, timeoutMs: 10_000, balance: false });
  opened.push(facilitator, seller, chain, { close: () => signer.close() });
  // The chain shows the settlement the facilitator made: the authorization it was given, through this chain's USDC.
  chain.dynamic = () => {
    const authorization = (facilitator.lastSettle?.payload.payload as { authorization: Record<string, string> }).authorization;
    return paymentReceipt({ payer: authorization.from, to: authorization.to, value: authorization.value, nonce: authorization.nonce, token: network.usdc.address });
  };
  chain.receipts.clear();
  const records = new Records(join(dir, "records"));
  const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url });

  const q = await quote({ url: seller.url }, { records, policy: DEFAULT_POLICY });
  expect(q.terms).toMatchObject({ network: network.caip2, assetAddress: network.usdc.address, asset: "USDC" });
  const attempt = engine.startPayment(q.id);
  let link = "";
  for (let i = 0; i < 200 && !link; i += 1) {
    link = engine.getAttempt(attempt.id)?.approvalUrl ?? "";
    if (!link) await new Promise((r) => setTimeout(r, 10));
  }
  const html = await (await fetch(link)).text();
  const owner = privateKeyToAccount(generatePrivateKey());
  const prepared = await postJson(`${link}/account`, { address: owner.address });
  expect(prepared.status).toBe(200);
  const typedData = prepared.body.typedData;
  const signature = await owner.signTypedData(typedData);
  expect((await postJson(`${link}/signature`, { address: owner.address, signature })).status).toBe(200);
  const done = await engine.waitForAttempt(attempt.id, 15_000);
  return { done, html, typedData, owner, facilitator, records };
}

describe("pay on the other EVM testnets", () => {
  for (const network of [ARBITRUM_SEPOLIA, SKALE_BASE_SEPOLIA, ARC_TESTNET]) {
    it(`pays on ${network.label} under its own USDC domain, and verifies the settlement on that chain`, async () => {
      const { done, html, typedData, owner, facilitator, records } = await payOn(network);
      expect(html).toContain(network.label.replace(" (testnet)", ""));
      expect(html).toContain(network.usdc.address);
      expect(html).toContain(`"nativeCurrency":${JSON.stringify(network.wallet.nativeCurrency)}`);
      expect(typedData.domain).toEqual({ name: network.usdc.eip712.name, version: "2", chainId: network.chainId, verifyingContract: network.usdc.address });
      // What reached the facilitator: this chain's requirement, and a signature over this chain's USDC domain.
      const settle = facilitator.lastSettle!;
      expect(settle.requirements).toMatchObject({ network: network.caip2, asset: network.usdc.address });
      const payload = settle.payload.payload as { signature: `0x${string}`; authorization: Record<string, string> };
      expect(await verifyTypedData({ address: owner.address, signature: payload.signature, ...typedData } as never)).toBe(true);
      expect(done.state).toBe("settled");
      expect(done.chain).toBe("verified");
      const receipt = records.getReceipt(done.receiptId!)!;
      expect(receipt.transactionUrl).toBe(`${network.explorer}/tx/${receipt.transaction}`);
      expect(receipt.network).toBe(network.caip2);
    });
  }
});
