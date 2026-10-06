// A stand-in for superstables.com's hosted purchase API (/api/v1/purchase/services, /api/v1/purchases), for the buy-once
// tests. It follows the site's published shape (docs/purchase.md): a listing with inputs and a price, a purchase made with an
// Idempotency-Key, an access token that reads and cancels it, and the owner's link and match code. A test moves a purchase
// along by changing its state, as the owner and the seller would. A payment it reports is also put on its fake chain
// (`chainUrl`: one JSON-RPC server answering as Base Sepolia, Arc Testnet, Tempo Moderato and Solana devnet), where the CLI reads it
// before it says paid; a test can make the site lie by reporting a payment the chain does not show. No network.
import { keccak256, toBytes } from "viem";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, startServer, type TestServer } from "./servers.js";

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const SELLER = "0xAfcd5F5C7622a5C09422A0e8FB850460bdA9E48E";
export const PAYER = "0x2222222222222222222222222222222222222222";
export const TX = `0x${"ab".repeat(32)}`;

export interface FakePurchase {
  id: string;
  token: string;
  key: string | undefined;
  body: { service_id: string; params?: Record<string, string>; max_amount?: string };
  service: Service;
  state: string;
  payment: Record<string, unknown>;
  delivery: Record<string, unknown>;
  reason?: string;
  reason_code?: string;
  final: boolean;
  polls: number;
  cancels: number;
  /** Overrides the terms the site says it created (a seller that changed its price). */
  terms?: Record<string, unknown>;
}

interface Service {
  id: string;
  name: string;
  amount: string;
  asset: string;
  /** CAIP-2; Base Sepolia when absent. */
  network?: string;
  payTo?: string;
  protocol?: string;
  symbol?: string;
  /** The token's decimals the listing and the purchase name (6 when absent; null leaves them out). */
  decimals?: number | null;
  params: { name: string; required: boolean; enum?: string[]; default?: string }[];
  available?: boolean;
  simulated?: boolean;
  /** List it without a simulated flag at all, as a site that does not say. */
  noSimulatedFlag?: boolean;
}

export interface FakePurchaseSite extends TestServer {
  services: Service[];
  purchases: FakePurchase[];
  /** Called on every read of a purchase, before the answer. */
  onPoll?: (p: FakePurchase) => void;
  /** Answer POST /api/v1/purchases with this status and error instead of creating one. */
  refuseCreate?: { status: number; error: { code: string; message: string; allowed?: unknown } };
  /** Answer reads of a purchase with this instead of its view (an error the site returns). */
  readAnswer?: (p: FakePurchase) => { status: number; body: unknown } | undefined;
  /** The origin the approval link points at (default: this site). */
  approvalBase?: string;
  /**
   * Answer the next cancels with this instead of cancelling: a status and body (a refusal, or a 2xx that is not a
   * cancellation), or "unreachable" to drop the connection. The purchase is left as it is.
   */
  cancelAnswer?: { status: number; body: unknown } | "unreachable" | ((p: FakePurchase) => { status: number; body: unknown });
  /** The owner-token fragment of the next approval link, without the # (default: sspa_test_owner<n>). */
  approvalFragment?: string;
  /** Changes what the next POST creates, before it is stored (a different recipient, another price). */
  tweak?: (p: FakePurchase) => void;
  /**
   * The owner signed and the seller answered: the purchase settles (on Base Sepolia unless `paid` names the tx and payer),
   * and the payment lands on the fake chain, unless `paid.chain` is false (a site that lies) or changes what landed.
   */
  settle(p: FakePurchase, result?: unknown, paid?: Paid): void;
  /** Put a purchase's payment on the fake chain (as settle does). */
  pay(p: FakePurchase, paid?: Paid): void;
  /** The fake chain's JSON-RPC URL: B4_RPC, SUPERSTABLES_TEMPO_RPC and SUPERSTABLES_SOLANA_RPC point at it. */
  chainUrl: string;
  /** Defaults below all payments to exercise delivery before finality. */
  finalizedBlock?: number;
}

/** A payment as the site reports it, and what the chain shows for it: false for nothing, or other values. */
export type Paid = { transaction: string; payer: string; chain?: false | { amount?: bigint; payTo?: string; asset?: string; failed?: boolean; at?: number } };

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

export const MARKET: Service = {
  id: "demo-market-data",
  name: "Demo market data",
  amount: "0.01",
  asset: USDC,
  params: [{ name: "asset", required: true, enum: ["BTC", "ETH"] }],
};
export const BRIEFING: Service = {
  id: "demo-wallet-briefing",
  name: "Wallet briefing",
  amount: "0.003",
  asset: USDC,
  simulated: true,
  params: [{ name: "sample_wallet", required: true, enum: ["demo-active", "demo-dormant"] }, { name: "period", required: false, enum: ["7d", "30d"], default: "7d" }],
};

export const TEMPO_SELLER = "0x7777777777777777777777777777777777777777";
export const SOLANA_SELLER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** The market-data demo on Tempo Moderato, sold over MPP in pathUSD. */
export const TEMPO_MARKET: Service = {
  id: "demo-market-data-tempo",
  name: "Demo market data (Tempo)",
  amount: "0.001",
  asset: "0x20C0000000000000000000000000000000000000",
  network: "eip155:42431",
  payTo: TEMPO_SELLER,
  protocol: "mpp",
  symbol: "pathUSD",
  params: [{ name: "asset", required: true, enum: ["BTC", "ETH"] }],
};
export const ARC_SELLER = "0xC8beDf4eD3Da53743Ee7fDa62ffd4bcB52Fec707";
/** The same demo on Arc Testnet, sold over x402 in Arc's USDC. */
export const ARC_MARKET: Service = {
  id: "demo-market-data-arc",
  name: "Demo market data (Arc)",
  amount: "0.01",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  payTo: ARC_SELLER,
  protocol: "x402",
  params: [{ name: "asset", required: true, enum: ["BTC", "ETH"] }],
};
/** The same demo on Solana devnet, sold over x402 in USDC. */
export const SOLANA_MARKET: Service = {
  id: "demo-market-data-solana",
  name: "Demo market data (Solana)",
  amount: "0.01",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  payTo: SOLANA_SELLER,
  protocol: "x402",
  params: [{ name: "asset", required: true, enum: ["BTC", "ETH"] }],
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const atomic = (decimal: string) => String(Math.round(Number(decimal) * 1e6));

const listing = (s: Service) => ({
  id: s.id,
  name: s.name,
  description: `${s.name}, a test service.`,
  ...(s.noSimulatedFlag ? {} : { simulated: s.simulated === true }),
  testnet: true,
  available: s.available !== false,
  ...(s.available === false ? { unavailable_reason: "the seller is offline" } : {}),
  request: { method: "GET", endpoint: `https://seller.example/${s.id}`, params: s.params.map((p) => ({ name: p.name, in: "query", required: p.required, ...(p.enum ? { enum: p.enum } : {}), ...(p.default ? { default: p.default } : {}) })), unknown_params: "rejected" },
  payment: { protocol: s.protocol ?? "x402", ...(s.protocol === "mpp" ? {} : { x402_version: 2, scheme: "exact" }), network: s.network ?? "eip155:84532", asset: { symbol: s.symbol ?? "USDC", address: s.asset, ...(s.decimals === null ? {} : { decimals: s.decimals ?? 6 }) }, amount: { decimal: s.amount, atomic: atomic(s.amount) }, pay_to: s.payTo ?? SELLER },
});

export async function startFakePurchaseSite(): Promise<FakePurchaseSite> {
  const site = {} as FakePurchaseSite;
  site.services = [structuredClone(MARKET), structuredClone(BRIEFING)];
  site.purchases = [];
  const terms = (p: FakePurchase) => p.terms ?? { amount: { decimal: p.service.amount, atomic: atomic(p.service.amount) }, asset: { symbol: p.service.symbol ?? "USDC", address: p.service.asset, ...(p.service.decimals === null ? {} : { decimals: p.service.decimals ?? 6 }) }, network: p.service.network ?? "eip155:84532", recipient: p.service.payTo ?? SELLER, protocol: p.service.protocol ?? "x402" };
  const view = (p: FakePurchase) => ({
    id: p.id, state: p.state, final: p.final, livemode: false,
    service: { id: p.service.id, name: p.service.name, simulated: p.service.simulated === true, testnet: true },
    request: { method: "GET", url: `https://seller.example/${p.service.id}`, params: p.body.params ?? {} },
    terms: terms(p), payment: p.payment, delivery: p.delivery,
    ...(p.state === "settled" || p.state === "paid_service_failed" ? { receipt: { id: p.id, purchase_id: p.id, transaction: (p.payment.transaction as string) ?? TX, payer: (p.payment.payer as string) ?? PAYER } } : {}),
    ...(p.reason ? { reason: p.reason } : {}), ...(p.reason_code ? { reason_code: p.reason_code } : {}),
    message: `purchase ${p.state}`, next: "see state", next_action: { type: p.final ? "done" : "wait_for_owner" },
  });
  // the fake chain: payments by transaction id
  const landed = new Map<string, { evm: boolean; payer: string; payTo: string; asset: string; amount: bigint; failed: boolean; at: number; block: number }>();
  site.pay = (p, paid = { transaction: TX, payer: PAYER }) => {
    if (paid.chain === false) return;
    const c = paid.chain ?? {};
    landed.set(paid.transaction, {
      evm: !(p.service.network ?? "").startsWith("solana:"),
      payer: paid.payer,
      payTo: c.payTo ?? p.service.payTo ?? SELLER,
      asset: c.asset ?? p.service.asset,
      amount: c.amount ?? BigInt(atomic(p.service.amount)),
      failed: c.failed === true,
      at: c.at ?? Math.floor(Date.now() / 1000),
      block: 16 + landed.size,
    });
  };
  site.settle = (p, result = { asset: "BTC", price_usd: 65000 }, paid = { transaction: TX, payer: PAYER }) => {
    Object.assign(p, { state: "settled", final: true, payment: { status: "paid", payer: paid.payer, transaction: paid.transaction, chain: { status: "confirmed", block: 7 } }, delivery: { status: "delivered", http_status: 200, result } });
    site.pay(p, paid);
  };
  const chain = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = JSON.parse(await readBody(req));
    const answer = (method: string, params: any[]): unknown => {
      const t = landed.get(params[0]);
      switch (method) {
        case "eth_getTransactionReceipt":
          if (!t || !t.evm) return null;
          return { transactionHash: params[0], status: t.failed ? "0x0" : "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: keccak256(toBytes(`purchase:${t.block}`)), logs: [{ address: t.asset, topics: [TRANSFER_TOPIC, word(t.payer), word(t.payTo)], data: `0x${t.amount.toString(16).padStart(64, "0")}` }] };
        case "eth_getBlockByNumber": {
          const n = params[0] === "finalized" ? site.finalizedBlock ?? 10 : params[0] === "latest" ? 1000 : Number(params[0]);
          const at = [...landed.values()].find((x) => x.evm && x.block === n)?.at ?? Math.floor(Date.now() / 1000);
          return { number: `0x${n.toString(16)}`, hash: keccak256(toBytes(`purchase:${n}`)), timestamp: `0x${at.toString(16)}` };
        }
        case "getTransaction":
          if (!t || t.evm) return null;
          return {
            slot: 100, blockTime: t.at,
            meta: { err: t.failed ? { InstructionError: [0, "Custom"] } : null,
              preTokenBalances: [{ accountIndex: 1, mint: t.asset, owner: t.payer, uiTokenAmount: { amount: String(5_000_000n) } }, { accountIndex: 2, mint: t.asset, owner: t.payTo, uiTokenAmount: { amount: "0" } }],
              postTokenBalances: [{ accountIndex: 1, mint: t.asset, owner: t.payer, uiTokenAmount: { amount: String(5_000_000n - t.amount) } }, { accountIndex: 2, mint: t.asset, owner: t.payTo, uiTokenAmount: { amount: String(t.amount) } }] },
          };
        default:
          return null;
      }
    };
    json(res, 200, Array.isArray(body) ? body.map((c: any) => ({ jsonrpc: "2.0", id: c.id, result: answer(c.method, c.params ?? []) })) : { jsonrpc: "2.0", id: body.id, result: answer(body.method, body.params ?? []) });
  });
  site.chainUrl = chain.url;
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    if (req.method === "GET" && url.pathname === "/api/v1/purchase/services") return json(res, 200, { supported: { network: "eip155:84532" }, services: site.services.map(listing) });
    const one = /^\/api\/v1\/purchase\/services\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      const s = site.services.find((x) => x.id === one[1]);
      return s ? json(res, 200, listing(s)) : json(res, 404, { error: { code: "not_found", message: "no such service", money_moved: false } });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/purchases") {
      if (site.refuseCreate) return json(res, site.refuseCreate.status, { error: { ...site.refuseCreate.error, money_moved: false } });
      const body = JSON.parse(raw);
      const s = site.services.find((x) => x.id === body.service_id);
      if (!s) return json(res, 404, { error: { code: "not_found", message: "no such service", money_moved: false } });
      if (body.max_amount && Number(s.amount) > Number(body.max_amount)) return json(res, 409, { error: { code: "price_above_max", message: `the service costs ${s.amount}, above max_amount ${body.max_amount}`, money_moved: false } });
      const id = randomUUID();
      const p: FakePurchase = { id, token: `sspt_test_${id.replace(/-/g, "")}`, key: String(req.headers["idempotency-key"] ?? "") || undefined, body, service: s, state: "awaiting_approval", final: false, payment: { status: "awaiting_approval" }, delivery: { status: "pending" }, polls: 0, cancels: 0 };
      site.tweak?.(p);
      site.purchases.push(p);
      return json(res, 201, {
        ...view(p), access_token: p.token, replayed: false,
        approval: { url: `${site.approvalBase ?? server.url}/approve/${id}#${site.approvalFragment ?? `sspa_test_owner${site.purchases.length}`}`, match_code: "KPT-RWD", expires_at: new Date(Date.now() + 600_000).toISOString() },
        message_for_owner: "Open the approval link and pick KPT-RWD.",
      });
    }
    const m = /^\/api\/v1\/purchases\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const p = site.purchases.find((x) => x.id === m[1]);
      if (!p || req.headers.authorization !== `Bearer ${p.token}`) return json(res, 404, { error: { code: "not_found", message: "no such purchase", money_moved: false } });
      if (m[2] && req.method === "POST") {
        p.cancels++;
        if (site.cancelAnswer === "unreachable") { req.socket.destroy(); return; }
        if (site.cancelAnswer) {
          const a = typeof site.cancelAnswer === "function" ? site.cancelAnswer(p) : site.cancelAnswer;
          return json(res, a.status, a.body);
        }
        if (p.state !== "awaiting_approval") return json(res, 409, { error: { code: "not_awaiting_approval", message: "the purchase is no longer awaiting approval", money_moved: false } });
        Object.assign(p, { state: "denied", final: true, reason_code: "agent_cancelled", reason: "the agent cancelled it", payment: { status: "not_paid" }, delivery: { status: "not_called" } });
        return json(res, 200, view(p));
      }
      p.polls++;
      const answer = site.readAnswer?.(p);
      if (answer) return json(res, answer.status, answer.body);
      site.onPoll?.(p);
      return json(res, 200, view(p));
    }
    json(res, 404, { error: { code: "not_found", message: "not found" } });
  });
  const closeSite = server.close.bind(server);
  return Object.assign(site, server, { close: async () => { await closeSite(); await chain.close(); } });
}
