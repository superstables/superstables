// Local stand-ins for everything a payment touches: a paid endpoint, a facilitator and an
// owner's wallet. All three are real HTTP servers on 127.0.0.1 port 0, so the tests exercise
// the same code paths as production without a network and without a private key that matters.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { usdcRequirement } from "../../src/core/chain.js";
import { termsFor } from "../../src/core/x402.js";
import { settleWith, verifyWith } from "../../src/core/facilitator.js";
import { LocalKeySigner } from "../../src/core/signer/local.js";
import type { WalletRequestView } from "../../src/core/types.js";

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<TestServer> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// ── A facilitator that always says yes ─────────────────────────────────────────────────

export interface FakeFacilitator extends TestServer {
  calls: { verify: number; settle: number };
  transaction: string;
  /** The EIP-3009 authorization in the last payment it settled: what a fake chain needs to show that payment. */
  lastAuthorization?: { from: string; to: string; value: string; nonce: string };
}

export async function startFacilitator(): Promise<FakeFacilitator> {
  const calls = { verify: 0, settle: 0 };
  const transaction = `0x${"ab".repeat(32)}`;
  const state: { lastAuthorization?: FakeFacilitator["lastAuthorization"] } = {};
  const server = await startServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || "{}") as {
      paymentPayload?: { payload?: { authorization?: { from?: string } } };
    };
    const payer = body.paymentPayload?.payload?.authorization?.from ?? `0x${"11".repeat(20)}`;
    const authorization = body.paymentPayload?.payload?.authorization as FakeFacilitator["lastAuthorization"] | undefined;
    if (req.url === "/settle" && authorization) state.lastAuthorization = authorization;
    if (req.url === "/verify") {
      calls.verify += 1;
      sendJson(res, 200, { isValid: true, payer });
      return;
    }
    if (req.url === "/settle") {
      calls.settle += 1;
      sendJson(res, 200, { success: true, transaction, network: "eip155:84532", payer } satisfies SettleResponse);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });
  return {
    ...server,
    calls,
    transaction,
    get lastAuthorization() {
      return state.lastAuthorization;
    },
  };
}

// ── A paid endpoint ────────────────────────────────────────────────────────────────────

export interface PaidEndpointOptions {
  /** What the seller charges. Change it between a quote and a payment to go stale. */
  price: number;
  /** Answer 500 after the payment settled: money moved, service failed. */
  failAfterPaying: boolean;
  /** Answer 200 but forget the receipt header: the outcome becomes unknowable. */
  omitPaymentResponse: boolean;
}

export interface PaidEndpoint extends TestServer {
  options: PaidEndpointOptions;
  payTo: string;
  requests: number;
}

/**
 * A seller: 402 with an x402 v2 challenge until a credential arrives, then verify, settle
 * and answer. This is the shape of the demo service and of any x402 resource server.
 */
export async function startPaidEndpoint(
  facilitatorUrl: string,
  overrides: Partial<PaidEndpointOptions> = {},
): Promise<PaidEndpoint> {
  const options: PaidEndpointOptions = {
    price: 0.01,
    failAfterPaying: false,
    omitPaymentResponse: false,
    ...overrides,
  };
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const state = { requests: 0 };

  const server = await startServer(async (req, res) => {
    state.requests += 1;
    const self = `http://127.0.0.1:${(req.socket.address() as AddressInfo).port}${req.url ?? "/"}`;
    const requirement: PaymentRequirements = usdcRequirement(options.price, payTo);
    const credential = req.headers["payment-signature"];

    if (typeof credential !== "string") {
      const challenge = {
        x402Version: 2,
        error: "payment required",
        resource: { url: self, description: "Market data for one asset" },
        accepts: [requirement],
      };
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": encodePaymentRequiredHeader(challenge),
      });
      res.end(JSON.stringify(challenge));
      return;
    }

    const payload = decodePaymentSignatureHeader(credential);
    const verified = await verifyWith(payload, requirement, [facilitatorUrl]);
    if (!verified.isValid) {
      sendJson(res, 402, { error: verified.invalidReason ?? "invalid payment" });
      return;
    }
    const settled = await settleWith(payload, requirement, [facilitatorUrl]);
    const headers: Record<string, string> = options.omitPaymentResponse
      ? {}
      : { "payment-response": encodePaymentResponseHeader(settled) };
    if (options.failAfterPaying) {
      sendJson(res, 500, { error: "the market data provider is down" }, headers);
      return;
    }
    sendJson(res, 200, { asset: "BTC", price: 64000, at: new Date().toISOString() }, headers);
  });

  return {
    ...server,
    options,
    payTo,
    get requests() {
      return state.requests;
    },
  };
}

// ── An owner's wallet ──────────────────────────────────────────────────────────────────

export type WalletMode = "approve" | "deny" | "policy-refusal";

export interface FakeWallet extends TestServer {
  mode: WalletMode;
  setMode(mode: WalletMode): void;
  token: string;
  address: string;
}

/** Just enough of the wallet's HTTP API for the signer: ask, wait, learn the answer. */
export async function startWallet(mode: WalletMode = "approve"): Promise<FakeWallet> {
  const token = "test-agent-token";
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = new LocalKeySigner(account);
  const state = { mode };
  const requests = new Map<string, WalletRequestView>();
  let next = 0;

  const server = await startServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const path = req.url ?? "/";

    if (path === "/status") {
      sendJson(res, 200, {
        address: account.address,
        network: "eip155:84532",
        networkLabel: "Base Sepolia (testnet)",
        asset: "USDC",
        approvalMode: "ask-every-payment",
        pending: 0,
        policy: { allow: [], deny: [], stablecoins: ["USDC"], killSwitch: false },
      });
      return;
    }
    if (path === "/address") {
      sendJson(res, 200, { address: account.address, network: "eip155:84532" });
      return;
    }

    if (req.method === "POST" && path === "/requests") {
      const body = JSON.parse(await readBody(req)) as { sign: { requirements: PaymentRequirements; x402Version: 1 | 2 } };
      const judged = termsFor(body.sign.requirements, body.sign.x402Version);
      if (!judged.supported) {
        sendJson(res, 200, { id: "rejected", status: "rejected", createdAt: Date.now(), expiresAt: Date.now(), reason: judged.reason });
        return;
      }
      const id = `req-${++next}`;
      if (state.mode === "policy-refusal") {
        sendJson(res, 200, {
          id,
          status: "denied",
          createdAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          verified: { ...judged.terms, payer: account.address },
          reason: "0.01 USDC exceeds caps.per_call (0.001 USDC)",
        });
        return;
      }
      // The owner will "decide" on the next poll; sign now so the answer is ready.
      const result = await signer.sign({ kind: "eip3009", requirements: judged.requirement, x402Version: body.sign.x402Version });
      const view: WalletRequestView = {
        id,
        status: "pending",
        createdAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        verified: { ...judged.terms, payer: account.address },
        result: { kind: "eip3009", payload: result.payload, signer: result.signer },
      };
      requests.set(id, view);
      sendJson(res, 200, { ...view, result: undefined });
      return;
    }

    const match = /^\/requests\/(.+)$/.exec(path);
    if (match) {
      const view = requests.get(decodeURIComponent(match[1]));
      if (!view) {
        sendJson(res, 404, { error: "no such request" });
        return;
      }
      if (state.mode === "deny") {
        sendJson(res, 200, { ...view, status: "denied", result: undefined, reason: "denied by the owner in the wallet" });
        return;
      }
      sendJson(res, 200, { ...view, status: "signed" });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  return {
    ...server,
    token,
    address: account.address,
    get mode() {
      return state.mode;
    },
    setMode(m: WalletMode) {
      state.mode = m;
    },
  };
}
