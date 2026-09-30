// A stand-in for superstables.com's budget API (/api/v1/budget/), for the hosted approval tests. It checks each agent
// request the way the contract says the site does: the signature over the exact text, the agent in the headers and the
// body, the timestamp. Requests move through their states when a test (or `onPoll`) says so. No network, no real key.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { recoverMessageAddress, type Hex } from "viem";
import { readBody, startServer, type TestServer } from "./servers.js";

export interface FakeRequest {
  id: string;
  kind: "link" | "grant" | "revoke" | "fund_agent";
  token: string;
  body: Record<string, any>;
  state: string;
  owner: string | null;
  tx_hash: string | null;
  wallet_asked?: boolean;
  reason?: string | null;
  polls: number;
  cancels: number;
}

export interface FakeSite extends TestServer {
  requests: FakeRequest[];
  /** Each POST that reached the site, with whether its agent proof checked out. */
  posts: { path: string; ok: boolean; why?: string }[];
  /** The account the next request belongs to (approvals: the owner from the first read). */
  owner: string | null;
  /** Called on every read, before the answer: move the request along. */
  onPoll?: (r: FakeRequest) => void;
  /** Answer POSTs with this status and error instead (a refusal). */
  refuse?: { status: number; error: string };
  /** Answer the next POST that checks out with this status and body instead of creating a request. */
  reply?: (path: string) => { status: number; body: unknown } | undefined;
  services?: unknown;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const FINAL = new Set(["linked", "confirmed", "failed", "rejected", "expired", "cancelled"]);

export async function startFakeSite(): Promise<FakeSite> {
  let n = 0;
  const site = {} as FakeSite;
  site.requests = [];
  site.posts = [];
  site.owner = null;
  const view = (r: FakeRequest) => ({ id: r.id, kind: r.kind, state: r.state, final: FINAL.has(r.state), owner: r.owner, tx_hash: r.tx_hash, reason: r.reason ?? null, ...(r.wallet_asked !== undefined ? { wallet_asked: r.wallet_asked } : {}), next_action: { type: FINAL.has(r.state) ? "stop" : "wait_for_owner" } });
  const server = await startServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const raw = await readBody(req);
    if (req.method === "POST" && (url.pathname === "/api/v1/budget/links" || url.pathname === "/api/v1/budget/approvals")) {
      const why = await checkProof(req, url.pathname, raw);
      site.posts.push({ path: url.pathname, ok: !why, why });
      if (why) return json(res, 401, { error: why });
      if (site.refuse) return json(res, site.refuse.status, { error: site.refuse.error });
      const custom = site.reply?.(url.pathname);
      if (custom) return json(res, custom.status, custom.body);
      const body = JSON.parse(raw);
      const link = url.pathname.endsWith("/links");
      const id = `${link ? "bl" : "ba"}_test${String(++n).padStart(4, "0")}`;
      const r: FakeRequest = { id, kind: link ? "link" : body.kind, token: `ssbt_test_${id}secret`, body, state: "awaiting_owner", owner: link ? null : site.owner, tx_hash: null, polls: 0, cancels: 0 };
      site.requests.push(r);
      return json(res, 201, {
        id,
        access_token: r.token,
        approval: { url: `${server.url}/approve/budget/${id}#ssba_test_owner${n}`, match_code: "ABC-DEF", expires_at: new Date(Date.now() + 600_000).toISOString() },
        message_for_owner: "Open the link and pick ABC-DEF.",
        next_action: { type: "wait_for_owner", poll: `/api/v1/budget/requests/${id}` },
      });
    }
    const m = /^\/api\/v1\/budget\/requests\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m) {
      const r = site.requests.find((x) => x.id === m[1]);
      if (!r || req.headers.authorization !== `Bearer ${r.token}`) return json(res, 404, { error: "no such request" });
      if (m[2] && req.method === "POST") {
        r.cancels++;
        if (r.state !== "awaiting_owner" || r.wallet_asked) return json(res, 409, { error: "the wallet was asked", state: r.state, wallet_asked: r.wallet_asked === true });
        r.state = "cancelled";
        return json(res, 200, view(r));
      }
      r.polls++;
      site.onPoll?.(r);
      return json(res, 200, view(r));
    }
    if (url.pathname === "/api/v1/budget/services" && site.services !== undefined) return json(res, 200, site.services);
    json(res, 404, { error: "not found" });
  });
  return Object.assign(site, server);
}

/** The site's check of an agent request: why it fails, or undefined. */
async function checkProof(req: IncomingMessage, path: string, raw: string): Promise<string | undefined> {
  const agent = String(req.headers["superstables-agent"] ?? "");
  const ts = Number(req.headers["superstables-agent-timestamp"]);
  const sig = String(req.headers["superstables-agent-signature"] ?? "") as Hex;
  if (!agent || !sig || !Number.isFinite(ts)) return "missing agent headers";
  if (Math.abs(ts - Date.now() / 1000) > 300) return "stale timestamp";
  const text = `Superstables agent request\nPOST ${path}\n${createHash("sha256").update(raw).digest("hex")}\n${ts}`;
  const signer = await recoverMessageAddress({ message: text, signature: sig });
  if (signer.toLowerCase() !== agent.toLowerCase()) return "signature is not the agent's";
  if (String(JSON.parse(raw).agent).toLowerCase() !== agent.toLowerCase()) return "body agent differs";
  return undefined;
}

/**
 * A JSON-RPC stand-in for an EVM testnet: every token balance and allowance is 0; every account holds 1 of the gas token.
 * `extra` answers a method first (for example a transaction and its receipt); undefined falls through to the defaults.
 */
export async function startFakeRpc(chainId: number, extra?: (method: string, params: any[]) => unknown): Promise<TestServer> {
  return startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const answer = (c: { id: number; method: string; params?: any[] }) => ({
      jsonrpc: "2.0",
      id: c.id,
      result: extra?.(c.method, c.params ?? []) ?? (c.method === "eth_chainId" ? `0x${chainId.toString(16)}` : c.method === "eth_call" ? `0x${"0".repeat(64)}` : c.method === "eth_blockNumber" ? "0x1" : c.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x0"),
    });
    json(res, 200, Array.isArray(body) ? body.map(answer) : answer(body));
  });
}
