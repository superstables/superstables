// A minimal x402 seller for tests: the smallest thing that answers 402, takes a credential,
// settles it through a facilitator and answers. It exists so the buyer side can be tested
// against a server that is not the demo service — including the shapes the demo service will
// never produce (protocol v1) and the failures a well behaved seller will never perform
// (dying after taking the money, forgetting the receipt header, changing its price).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { BASE_SEPOLIA, isSameAddress, toAtomic, toCaip2, type EvmNetwork } from "../../src/core/chain.js";

export type PaidEndpointBehaviour =
  /** Settles and answers 200 with the receipt header. */
  | "ok"
  /** Settles, then fails: the buyer paid and the service did not deliver. */
  | "service-500-after-payment"
  /** Settles and answers 200, but without PAYMENT-RESPONSE: the buyer cannot know what happened. */
  | "no-payment-response"
  /** Raises its price after the first challenge: a quote that goes stale under the buyer. */
  | "change-price-after-first-402";

export interface PaidEndpointOptions {
  priceDecimal: number;
  payTo: string;
  facilitatorUrl: string;
  /** Which x402 wire version to speak. Default 2. */
  version?: 1 | 2;
  /** Which EVM chain it is paid on, in that chain's USDC. Default Base Sepolia. */
  network?: EvmNetwork;
  behaviour?: PaidEndpointBehaviour;
}

export interface PaidEndpoint {
  url: string;
  hits: { total: number; challenges: number; paid: number };
  close(): Promise<void>;
}

const RESOURCE_DESCRIPTION = "test paid endpoint";

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startPaidEndpoint(opts: PaidEndpointOptions): Promise<PaidEndpoint> {
  const version = opts.version ?? 2;
  const behaviour = opts.behaviour ?? "ok";
  const facilitator = new HTTPFacilitatorClient({ url: opts.facilitatorUrl, timeoutMs: 10_000 });
  const hits = { total: 0, challenges: 0, paid: 0 };
  const network = opts.network ?? BASE_SEPOLIA;
  const usdc = network.usdc;

  // The price the seller is asking right now. Only "change-price-after-first-402" moves it.
  const priceNow = (): number =>
    behaviour === "change-price-after-first-402" && hits.challenges > 1 ? opts.priceDecimal * 2 : opts.priceDecimal;

  const requirementV2 = (): PaymentRequirements => ({
    scheme: "exact",
    network: network.caip2 as PaymentRequirements["network"],
    asset: usdc.address,
    amount: toAtomic(priceNow(), usdc.decimals),
    payTo: opts.payTo,
    maxTimeoutSeconds: 300,
    extra: { name: usdc.eip712.name, version: usdc.eip712.version },
  });

  const requirementV1 = (resource: string): Record<string, unknown> => ({
    scheme: "exact",
    network: network.v1Name,
    maxAmountRequired: toAtomic(priceNow(), usdc.decimals),
    resource,
    description: RESOURCE_DESCRIPTION,
    mimeType: "application/json",
    outputSchema: {},
    payTo: opts.payTo,
    maxTimeoutSeconds: 300,
    asset: usdc.address,
    extra: { name: usdc.eip712.name, version: usdc.eip712.version },
  });

  const challenge = (resource: string, error: string) =>
    version === 1
      ? { x402Version: 1, error, accepts: [requirementV1(resource)] }
      : {
          x402Version: 2,
          error,
          resource: { url: resource, description: RESOURCE_DESCRIPTION, mimeType: "application/json" },
          accepts: [requirementV2()],
        };

  const send402 = (res: ServerResponse, resource: string, error: string): void => {
    hits.challenges += 1;
    const body = challenge(resource, error);
    // v1 puts the challenge in the body alone; v2 also carries it in a header.
    const headers: Record<string, string> =
      version === 1
        ? {}
        : { "payment-required": Buffer.from(JSON.stringify(body), "utf8").toString("base64") };
    sendJson(res, 402, body, headers);
  };

  /** The credential, whatever wire version it arrived in, plus the terms it claims to accept. */
  const readCredential = (req: IncomingMessage): { payload: PaymentPayload; accepted?: PaymentRequirements } | undefined => {
    const raw = version === 1 ? headerValue(req, "x-payment") : headerValue(req, "payment-signature");
    if (!raw) return undefined;
    try {
      if (version === 1) {
        const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as PaymentPayload;
        return { payload: decoded };
      }
      const decoded = decodePaymentSignatureHeader(raw);
      return { payload: decoded, accepted: decoded.accepted };
    } catch {
      return undefined;
    }
  };

  const matchesAskingPrice = (accepted: PaymentRequirements | undefined): boolean => {
    if (version === 1) return true; // v1 credentials do not echo the terms back.
    const ours = requirementV2();
    return (
      !!accepted &&
      accepted.scheme === ours.scheme &&
      toCaip2(String(accepted.network ?? "")) === toCaip2(ours.network) &&
      String(accepted.amount ?? "") === ours.amount &&
      typeof accepted.payTo === "string" &&
      isSameAddress(accepted.payTo, ours.payTo)
    );
  };

  const server = createServer((req, res) => {
    void (async () => {
      hits.total += 1;
      const resource = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
      const credential = readCredential(req);
      if (!credential) {
        send402(res, resource, "Payment required");
        return;
      }
      if (!matchesAskingPrice(credential.accepted)) {
        send402(res, resource, "payment does not match the asking price");
        return;
      }

      // The facilitator's shapes differ between wire versions; the client only serialises them.
      const requirements = (version === 1 ? requirementV1(resource) : requirementV2()) as PaymentRequirements;
      const verified = await facilitator.verify(credential.payload, requirements);
      if (!verified.isValid) {
        send402(res, resource, verified.invalidReason ?? "payment is not valid");
        return;
      }
      const settled: SettleResponse = await facilitator.settle(credential.payload, requirements);
      if (!settled.success) {
        send402(res, resource, settled.errorReason ?? "payment did not settle");
        return;
      }

      hits.paid += 1;
      const receiptHeader = version === 1 ? "x-payment-response" : "payment-response";
      const receipt = { [receiptHeader]: encodePaymentResponseHeader(settled) };

      if (behaviour === "service-500-after-payment") {
        sendJson(res, 500, { error: "the service failed after the payment settled" }, receipt);
        return;
      }
      if (behaviour === "no-payment-response") {
        sendJson(res, 200, { ok: true, note: "no receipt header, on purpose" });
        return;
      }
      sendJson(res, 200, { ok: true, service: RESOURCE_DESCRIPTION, transaction: settled.transaction }, receipt);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/paid`,
    hits,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
