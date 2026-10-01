// The wallet, driven the way an agent and an owner drive it: over HTTP, on a throwaway port,
// with a throwaway key and a policy handed in rather than read from the machine. Nothing here
// touches the network — no RPC, no facilitator, no seller.
//
// The tests that matter most are the ones about trust: the terms the owner sees come from the
// requirement and not from the agent's description of it, an agent token cannot approve, and a
// refusal leaves nothing signed.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_SEPOLIA, usdcRequirement } from "../../src/core/chain.js";
import type { Policy } from "../../src/core/policy.js";
import type { WalletRequestView, WalletStatus } from "../../src/core/types.js";
import { startWallet, type StartWalletOptions, type WalletHandle } from "../../src/wallet/daemon.js";

const PAYEE = "0x2222222222222222222222222222222222222222";

const TEST_POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: ["*.blocked.example"],
  stablecoins: ["USDC"],
  killSwitch: false,
  approval: "ask-every-payment",
};

interface TestWallet {
  wallet: WalletHandle;
  dir: string;
  privateKey: string;
}

const started: TestWallet[] = [];

async function startTestWallet(overrides: Partial<StartWalletOptions> = {}): Promise<TestWallet> {
  const dir = mkdtempSync(join(tmpdir(), "superstables-wallet-test-"));
  const privateKey = generatePrivateKey();
  const wallet = await startWallet({
    port: 0,
    dir,
    account: privateKeyToAccount(privateKey),
    policy: TEST_POLICY,
    quiet: true,
    openBrowser: false,
    // The status route must never reach an RPC in a unit test.
    balance: false,
    ...overrides,
  });
  const entry = { wallet, dir, privateKey };
  started.push(entry);
  return entry;
}

afterEach(async () => {
  while (started.length > 0) {
    const entry = started.pop()!;
    await entry.wallet.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

function call(wallet: WalletHandle, path: string, token?: string, method = "GET", body?: unknown) {
  return fetch(`${wallet.url}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ask(
  wallet: WalletHandle,
  requirements: Record<string, unknown>,
  context?: Record<string, unknown>,
  x402Version: 1 | 2 = 2,
): Promise<WalletRequestView> {
  const res = await call(wallet, "/requests", wallet.agentToken, "POST", {
    sign: { kind: "eip3009", requirements, x402Version, context },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as WalletRequestView;
}

const readRequest = async (wallet: WalletHandle, id: string, token = wallet.agentToken): Promise<WalletRequestView> =>
  (await (await call(wallet, `/requests/${id}`, token)).json()) as WalletRequestView;

const auditLines = (dir: string): Record<string, any>[] =>
  readFileSync(join(dir, "audit.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("wallet credentials", () => {
  it("answers 401 without a token, and with the wrong one", async () => {
    const { wallet } = await startTestWallet();
    expect((await call(wallet, "/status")).status).toBe(401);
    expect((await call(wallet, "/status", "not-the-token")).status).toBe(401);
    expect((await call(wallet, "/status", wallet.agentToken)).status).toBe(200);
    expect((await call(wallet, "/status", wallet.ownerSecret)).status).toBe(200);
  });

  it("lets the agent ask but never decide", async () => {
    const { wallet } = await startTestWallet();
    const pending = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    expect((await call(wallet, "/owner/requests", wallet.agentToken)).status).toBe(403);
    expect(
      (await call(wallet, `/owner/requests/${pending.id}/approve`, wallet.agentToken, "POST")).status,
    ).toBe(403);
    expect((await call(wallet, "/owner/requests", wallet.ownerSecret)).status).toBe(200);
  });

  it("serves the approval page without a token", async () => {
    const { wallet } = await startTestWallet();
    const res = await fetch(wallet.url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Payment approvals");
  });
});

describe("what the owner is shown", () => {
  it("derives the terms from the requirement and keeps the agent's story apart", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.02, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://service.example/weather?city=lisbon",
      serviceName: "Weather",
      description: "current conditions",
    });
    expect(created.status).toBe("pending");
    expect(created.result).toBeUndefined();

    const shown = await readRequest(wallet, created.id);
    expect(shown.verified).toMatchObject({
      amountDecimal: 0.02,
      amountAtomic: "20000",
      asset: "USDC",
      assetAddress: BASE_SEPOLIA.usdc.address,
      network: "eip155:84532",
      networkLabel: BASE_SEPOLIA.label,
      recipient: PAYEE,
      scheme: "exact",
      payer: wallet.address,
    });
    expect(shown.reported).toEqual({
      target: "https://service.example/weather?city=lisbon",
      serviceName: "Weather",
      description: "current conditions",
    });
  });

  it("shows the requirement's amount even when the agent claims another one", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.04, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://service.example/thing",
      serviceName: "A very cheap service",
      description: "costs 0.000001 USDC, basically free",
    });
    const shown = await readRequest(wallet, created.id);
    expect(shown.verified.amountDecimal).toBe(0.04);
    expect(shown.verified.amountAtomic).toBe("40000");
    expect(shown.reported?.description).toContain("0.000001");
  });
});

describe("approving and denying", () => {
  it("signs exactly the stored requirement when the owner approves", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.03, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://service.example/thing",
    });
    const approved = await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST");
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as WalletRequestView).result).toBeUndefined();

    const signed = await readRequest(wallet, created.id);
    expect(signed.status).toBe("signed");
    expect(signed.result?.signer).toBe(wallet.address);
    expect(signed.result?.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
    const authorization = signed.result?.payload.authorization as Record<string, string>;
    expect(authorization.from).toBe(wallet.address);
    expect(authorization.to).toBe(PAYEE);
    expect(authorization.value).toBe("30000");
  });

  it("never lists a signature on the owner's list", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST");
    const listed = (await (await call(wallet, "/owner/requests", wallet.ownerSecret)).json()) as {
      requests: WalletRequestView[];
    };
    expect(listed.requests).toHaveLength(1);
    expect(listed.requests[0].status).toBe("signed");
    expect(listed.requests[0].result).toBeUndefined();
  });

  it("refuses a second decision on the same request", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    expect((await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST")).status).toBe(200);
    expect((await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST")).status).toBe(409);
    expect((await call(wallet, `/owner/requests/${created.id}/deny`, wallet.ownerSecret, "POST")).status).toBe(409);
  });

  it("denies without signing anything when the owner says no", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    const denied = (await (
      await call(wallet, `/owner/requests/${created.id}/deny`, wallet.ownerSecret, "POST")
    ).json()) as WalletRequestView;
    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("denied by the owner in the wallet");
    expect((await readRequest(wallet, created.id)).result).toBeUndefined();
  });

  it("expires a request the owner never answered", async () => {
    const { wallet } = await startTestWallet({ approvalTimeoutMs: 200 });
    const created = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    expect(created.status).toBe("pending");
    await sleep(350);
    const expired = await readRequest(wallet, created.id);
    expect(expired.status).toBe("expired");
    expect(expired.reason).toContain("no answer from the owner");
    expect(expired.result).toBeUndefined();
    expect((await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST")).status).toBe(409);
  });
});

describe("requests the wallet rejects before the owner sees them", () => {
  const cases: Array<{ name: string; requirements: Record<string, unknown>; reason: RegExp }> = [
    {
      name: "another network",
      requirements: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "10000",
        payTo: PAYEE,
      },
      reason: /network .* is not supported/i,
    },
    {
      name: "another asset",
      requirements: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x4444444444444444444444444444444444444444",
        amount: "10000",
        payTo: PAYEE,
      },
      reason: /is not USDC/i,
    },
    {
      name: "a scheme that is not exact",
      requirements: {
        scheme: "upto",
        network: "eip155:84532",
        asset: BASE_SEPOLIA.usdc.address,
        amount: "10000",
        payTo: PAYEE,
      },
      reason: /only exact/i,
    },
    {
      name: "a malformed amount",
      requirements: {
        scheme: "exact",
        network: "eip155:84532",
        asset: BASE_SEPOLIA.usdc.address,
        amount: "0.01",
        payTo: PAYEE,
      },
      reason: /amount is missing or malformed/i,
    },
    {
      name: "a malformed recipient",
      requirements: {
        scheme: "exact",
        network: "eip155:84532",
        asset: BASE_SEPOLIA.usdc.address,
        amount: "10000",
        payTo: "not-an-address",
      },
      reason: /recipient .* missing or malformed/i,
    },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} and signs nothing`, async () => {
      const { wallet } = await startTestWallet();
      const rejected = await ask(wallet, testCase.requirements, { target: "https://service.example/thing" });
      expect(rejected.status).toBe("rejected");
      expect(rejected.reason).toMatch(testCase.reason);
      const stored = await readRequest(wallet, rejected.id);
      expect(stored.result).toBeUndefined();
      expect((await call(wallet, `/owner/requests/${rejected.id}/approve`, wallet.ownerSecret, "POST")).status).toBe(409);
    });
  }

  it("rejects a request for something other than an eip3009 authorization", async () => {
    const { wallet } = await startTestWallet();
    const res = await call(wallet, "/requests", wallet.agentToken, "POST", {
      sign: { kind: "solana-transfer", requirements: usdcRequirement(0.01, PAYEE), x402Version: 2 },
    });
    const rejected = (await res.json()) as WalletRequestView;
    expect(rejected.status).toBe("rejected");
    expect(rejected.reason).toContain("eip3009");
  });
});

describe("the owner's policy, applied inside the wallet", () => {
  it("denies a payment above the per-call cap", async () => {
    const { wallet } = await startTestWallet();
    const denied = await ask(wallet, usdcRequirement(0.2, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://service.example/thing",
    });
    expect(denied.status).toBe("denied");
    expect(denied.reason).toContain("caps.per_call");
    expect((await readRequest(wallet, denied.id)).result).toBeUndefined();
  });

  it("denies a host on the deny list", async () => {
    const { wallet } = await startTestWallet();
    const denied = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://api.blocked.example/thing",
    });
    expect(denied.status).toBe("denied");
    expect(denied.reason).toContain("deny list");
  });

  it("denies once the day's payments would pass the per-day cap", async () => {
    const { wallet } = await startTestWallet({
      policy: { ...TEST_POLICY, perCall: { amount: 0.6, asset: "USDC" }, perDay: { amount: 1, asset: "USDC" } },
    });
    for (const amount of [0.5, 0.5]) {
      const created = await ask(wallet, usdcRequirement(amount, PAYEE) as unknown as Record<string, unknown>);
      expect(created.status).toBe("pending");
      const res = await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST");
      expect(((await res.json()) as WalletRequestView).status).toBe("signed");
    }
    const denied = await ask(wallet, usdcRequirement(0.05, PAYEE) as unknown as Record<string, unknown>);
    expect(denied.status).toBe("denied");
    expect(denied.reason).toContain("caps.per_day");
  });
});

describe("the audit log", () => {
  it("records every state change and never a key or a signature", async () => {
    const { wallet, dir, privateKey } = await startTestWallet();
    const approvedRequest = await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>, {
      target: "https://service.example/thing",
    });
    await call(wallet, `/owner/requests/${approvedRequest.id}/approve`, wallet.ownerSecret, "POST");
    const deniedRequest = await ask(wallet, usdcRequirement(0.02, PAYEE) as unknown as Record<string, unknown>);
    await call(wallet, `/owner/requests/${deniedRequest.id}/deny`, wallet.ownerSecret, "POST");
    const rejectedRequest = await ask(wallet, { scheme: "exact", network: "eip155:8453", amount: "1" });

    const lines = auditLines(dir);
    expect(lines.filter((line) => line.id === approvedRequest.id).map((line) => line.status)).toEqual([
      "pending",
      "approved",
      "signed",
    ]);
    expect(lines.filter((line) => line.id === deniedRequest.id).map((line) => line.status)).toEqual([
      "pending",
      "denied",
    ]);
    expect(lines.filter((line) => line.id === rejectedRequest.id).map((line) => line.status)).toEqual(["rejected"]);
    for (const line of lines) {
      expect(line.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(line.verified).toBeDefined();
    }

    const raw = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("signature");
    expect(raw).not.toContain(privateKey);
    expect(raw).not.toContain(privateKey.slice(2));
  });
});

describe("status", () => {
  it("reports the address, the network, the approval mode and the pending count", async () => {
    const { wallet } = await startTestWallet();
    await ask(wallet, usdcRequirement(0.01, PAYEE) as unknown as Record<string, unknown>);
    const status = (await (await call(wallet, "/status", wallet.agentToken)).json()) as WalletStatus;
    expect(status.address).toBe(wallet.address);
    expect(status.network).toBe("eip155:84532");
    expect(status.networkLabel).toBe(BASE_SEPOLIA.label);
    expect(status.asset).toBe("USDC");
    expect(status.approvalMode).toBe("ask-every-payment");
    expect(status.pending).toBe(1);
    expect(status.balanceDecimal).toBeUndefined();
    expect(status.policy).toMatchObject({ perCall: "0.05 USDC", perDay: "1 USDC", deny: ["*.blocked.example"] });
  });

  it("answers /address with the payer and the network", async () => {
    const { wallet } = await startTestWallet();
    const body = (await (await call(wallet, "/address", wallet.agentToken)).json()) as Record<string, string>;
    expect(body).toEqual({ address: wallet.address, network: "eip155:84532" });
  });
});

describe("x402 v1 requirements", () => {
  it("accepts and signs a v1 requirement with maxAmountRequired", async () => {
    const { wallet } = await startTestWallet();
    const created = await ask(
      wallet,
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "10000",
        asset: BASE_SEPOLIA.usdc.address,
        payTo: PAYEE,
        extra: { name: "USDC", version: "2" },
      },
      { target: "https://service.example/thing" },
      1,
    );
    expect(created.status).toBe("pending");
    expect(created.verified).toMatchObject({ amountAtomic: "10000", network: "eip155:84532", x402Version: 1 });

    await call(wallet, `/owner/requests/${created.id}/approve`, wallet.ownerSecret, "POST");
    const signed = await readRequest(wallet, created.id);
    expect(signed.status).toBe("signed");
    const authorization = signed.result?.payload.authorization as Record<string, string>;
    expect(authorization.to).toBe(PAYEE);
    expect(authorization.value).toBe("10000");
  });
});
