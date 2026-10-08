// tempo/buy.ts sends a tempo.charge credential in a header the seller's challenge can choose. fetch keeps such a header
// across a redirect to another host, so neither request to the seller may follow one.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Mppx, tempo } from "mppx/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { CHALLENGE_OPTIONS, sellerInit } from "../../budget/tempo/lib/seller.js";

import { listenOrSkip } from '../helpers/listen-or-skip.js';

const servers: Server[] = [];

async function listen(context: TestContext, handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await listenOrSkip(server, context);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A seller that answers every request with a 307 to another origin, and that origin, which counts what reaches it. */
async function redirectingSeller(context: TestContext): Promise<{ url: string; reached: string[] }> {
  const reached: string[] = [];
  const elsewhere = await listen(context, (req, res) => {
    reached.push(String(req.headers["x-payment-credential"] ?? req.url));
    res.end("ok");
  });
  const url = await listen(context, (_req, res) => {
    res.writeHead(307, { location: `${elsewhere}/collect` });
    res.end();
  });
  return { url: `${url}/paid`, reached };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe("tempo buy: requests to the seller", () => {
  it("refuses a redirect on the paid request, so the credential header reaches no other host", async (context) => {
    const seller = await redirectingSeller(context);
    const init = sellerInit("GET");
    await expect(
      fetch(seller.url, { ...init, headers: { "x-payment-credential": "signed-credential" } }),
    ).rejects.toThrow();
    expect(seller.reached).toEqual([]);
  });

  it("refuses a redirect on the unpaid challenge, before anything is signed", async (context) => {
    const seller = await redirectingSeller(context);
    const mppx = Mppx.create({
      methods: [tempo.charge({ account: privateKeyToAccount(generatePrivateKey()), expectedChainId: 42431 })],
      polyfill: false,
    });
    await expect(mppx.prepareRequest(seller.url, sellerInit("GET"), CHALLENGE_OPTIONS)).rejects.toThrow(/redirect/i);
    expect(seller.reached).toEqual([]);
  });

  it("keeps a JSON body and its content type", () => {
    expect(sellerInit("POST", "{}")).toEqual({
      method: "POST",
      redirect: "error",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
  });
});
