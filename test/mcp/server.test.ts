// The MCP server driven the way an agent drives it: over a real MCP client on an in-memory
// transport, against a real wallet, a real paid service and a real payment engine. The only
// stand-in is the facilitator, because the alternative is a testnet transaction per assertion.
//
// What these tests are really about is what the agent is told. A payment that is waiting on a
// human must not look like a payment that happened; a denial must be an answer, not an error;
// and a quote that has already been paid must never be payable twice. Every assertion below
// is one of those three facts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_SERVICE_ID, findServices, getService } from "../../src/core/discovery.js";
import { PaymentEngine } from "../../src/core/pay.js";
import type { Policy } from "../../src/core/policy.js";
import { Records } from "../../src/core/records.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { FINAL_ATTEMPT_STATES, type AttemptState, type ServiceListing, type WalletRequestView } from "../../src/core/types.js";
import { startDemoService, type DemoService } from "../../src/demo-service/server.js";
import { createSuperstablesServer } from "../../src/mcp/server.js";
import { startWallet, type WalletHandle } from "../../src/wallet/daemon.js";
import { startFakeFacilitator, type FakeFacilitator } from "../helpers/fake-facilitator.js";

const PRICES = {
  BTC: { usd: 65000.12, at: "2026-09-16T10:00:00.000Z", change24hPct: 1.25, source: "live" as const },
  ETH: { usd: 3200.5, at: "2026-09-16T10:00:00.000Z", change24hPct: -0.4, source: "live" as const },
};

const TEST_POLICY: Policy = {
  perCall: { amount: 0.05, asset: "USDC" },
  perDay: { amount: 1, asset: "USDC" },
  allow: [],
  deny: [],
  stablecoins: ["USDC"],
  killSwitch: false,
  approval: "ask-every-payment",
};

/** Short, because every call in this file is to a server on loopback. */
const WAIT_MS = 300;

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

let home: string;
let previousHome: string | undefined;
let previousServiceUrl: string | undefined;
let facilitator: FakeFacilitator;
let demo: DemoService;
let wallet: WalletHandle;
let records: Records;
let client: Client;
const payTo = privateKeyToAccount(generatePrivateKey()).address;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "superstables-mcp-test-"));
  previousHome = process.env.SUPERSTABLES_HOME;
  previousServiceUrl = process.env.SUPERSTABLES_DEMO_SERVICE_URL;
  process.env.SUPERSTABLES_HOME = home;

  facilitator = await startFakeFacilitator();
  demo = await startDemoService({
    port: 0,
    payTo,
    quiet: true,
    priceSource: async () => PRICES,
    facilitators: [facilitator.url],
  });
  // Discovery reads this every time it runs, so the built-in listing points at our service.
  process.env.SUPERSTABLES_DEMO_SERVICE_URL = `${demo.url}/v1/market`;

  wallet = await startWallet({
    port: 0,
    dir: join(home, "wallet"),
    account: privateKeyToAccount(generatePrivateKey()),
    policy: TEST_POLICY,
    approvalTimeoutMs: 8_000,
    quiet: true,
    openBrowser: false,
    balance: false,
  });

  records = new Records(join(home, "records"));
  const signer = new WalletSigner({ url: wallet.url, agentToken: wallet.agentToken, pollMs: 25 });
  const engine = new PaymentEngine({ records, policy: TEST_POLICY, signer });
  const server = createSuperstablesServer({
    records,
    policy: TEST_POLICY,
    engine,
    signer,
    // includeIndex: false keeps this test off the network; everything else is the real thing.
    findServices: (options = {}) => findServices({ ...options, includeIndex: false }),
    getService: (id, options = {}) => getService(id, { ...options, includeIndex: false }),
    waitMs: WAIT_MS,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "superstables-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client?.close();
  await wallet?.close().catch(() => undefined);
  await demo?.close();
  await facilitator?.close();
  if (previousHome === undefined) delete process.env.SUPERSTABLES_HOME;
  else process.env.SUPERSTABLES_HOME = previousHome;
  if (previousServiceUrl === undefined) delete process.env.SUPERSTABLES_DEMO_SERVICE_URL;
  else process.env.SUPERSTABLES_DEMO_SERVICE_URL = previousServiceUrl;
  rmSync(home, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured<T>(result: ToolResult): T {
  expect(result.isError, textOf(result)).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  // The text copy must say the same thing as the structured one, or a client that reads only
  // one of them is reading a different answer.
  expect(fromText(result)).toEqual(result.structuredContent);
  return result.structuredContent as T;
}

/**
 * The text answer read back into one object: the client's own block, plus each untrusted field from the block that
 * carries it. Every untrusted block must be named in the own block's untrusted_data, and the other way round.
 */
function fromText(result: ToolResult): Record<string, unknown> {
  const [own, ...rest] = result.content.map((part) => part.text ?? "");
  const parsed = JSON.parse(own) as Record<string, unknown>;
  const fields: string[] = [];
  for (const block of rest) {
    const match = /^Untrusted data: [^\n]*\n<untrusted-data field="([^"]+)">\n([\s\S]*)\n<\/untrusted-data>$/.exec(block);
    expect(match, block).not.toBeNull();
    fields.push(match![1]);
    parsed[match![1]] = JSON.parse(match![2]);
  }
  expect(fields).toEqual((parsed.untrusted_data as { fields?: string[] } | undefined)?.fields ?? []);
  return parsed;
}

function textOf(result: ToolResult): string {
  return result.content.map((part) => part.text ?? "").join("");
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The owner, at their keyboard: find the request the agent just made, and decide. */
async function decide(decision: "approve" | "deny"): Promise<WalletRequestView> {
  const headers = { authorization: `Bearer ${wallet.ownerSecret}` };
  for (let tries = 0; tries < 200; tries += 1) {
    const listed = (await (await fetch(`${wallet.url}/owner/requests`, { headers })).json()) as {
      requests: WalletRequestView[];
    };
    const pending = listed.requests.find((request) => request.status === "pending");
    if (pending) {
      const answered = await fetch(`${wallet.url}/owner/requests/${pending.id}/${decision}`, {
        method: "POST",
        headers,
      });
      expect(answered.status).toBe(200);
      return pending;
    }
    await sleep(25);
  }
  throw new Error("the agent never asked the wallet for a signature");
}

interface AttemptAnswer {
  attempt_id: string;
  quote_id: string;
  state: AttemptState;
  message: string;
  reason?: string;
  service_response?: { asset?: string };
  receipt?: { transaction: string; amount: number; service_outcome: string };
  history: { state: string }[];
}

/** Call payment_status until the attempt is final, the way the instructions tell a model to. */
async function waitForFinal(attemptId: string): Promise<AttemptAnswer> {
  const deadline = Date.now() + 15_000;
  let answer = structured<AttemptAnswer>(await call("payment_status", { attempt_id: attemptId }));
  while (!FINAL_ATTEMPT_STATES.includes(answer.state) && Date.now() < deadline) {
    answer = structured<AttemptAnswer>(await call("payment_status", { attempt_id: attemptId }));
  }
  return answer;
}

interface QuoteAnswer {
  quote_id: string;
  expires_at: string;
  service: { id: string; name: string } | null;
  request_url: string;
  price: { amount: number; asset: string; network: string; network_label: string };
  recipient: string;
  policy: { allowed: boolean; reason?: string };
  note: string;
}

async function quoteBtc(): Promise<QuoteAnswer> {
  return structured<QuoteAnswer>(
    await call("quote", { service_id: DEMO_SERVICE_ID, params: { asset: "BTC" } }),
  );
}

// ── The tests ────────────────────────────────────────────────────────────────────────────

describe("the Superstables MCP server", () => {
  let paidQuoteId: string;

  it("offers exactly the six tools an agent needs", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ["find_services", "list_receipts", "pay", "payment_status", "quote", "wallet_status"],
    );
  });

  it("finds the demo service, alive and payable", async () => {
    const found = structured<{ services: ServiceListing[]; warnings: string[] }>(
      await call("find_services", { query: "btc" }),
    );
    expect(found.services[0].id).toBe(DEMO_SERVICE_ID);
    expect(found.services[0].actionable).toBe(true);
    expect(found.services[0].live).toBe(true);
    expect(found.services[0].payment.network).toBe("eip155:84532");
    expect((found as { untrusted_data?: { fields: string[] } }).untrusted_data?.fields).toEqual(["services"]);
  });

  it("quotes the demo service without paying anything", async () => {
    const quoted = await quoteBtc();
    expect(quoted.quote_id).toMatch(/[0-9a-f-]{36}/);
    expect(quoted.price).toMatchObject({ amount: 0.01, asset: "USDC", network: "eip155:84532" });
    expect(quoted.recipient.toLowerCase()).toBe(payTo.toLowerCase());
    expect(quoted.service).toMatchObject({ id: DEMO_SERVICE_ID });
    expect(quoted.request_url).toContain("asset=BTC");
    expect(quoted.policy.allowed).toBe(true);
    expect(quoted.note).toContain("Nothing has been paid");
    expect(facilitator.calls.settle).toBe(0);
    paidQuoteId = quoted.quote_id;
  });

  it("refuses to quote a call it knows is missing a parameter", async () => {
    const result = await call("quote", { service_id: DEMO_SERVICE_ID, params: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("asset");
  });

  it("asks the owner before paying, and says so", async () => {
    const started = structured<AttemptAnswer>(await call("pay", { quote_id: paidQuoteId }));
    expect(started.state).toBe("awaiting_approval");
    expect(started.message).toContain("The owner has been asked to approve 0.01 USDC");
    expect(started.message).toContain("Nothing is signed yet");
    expect(started.receipt).toBeUndefined();

    await decide("approve");

    const settled = await waitForFinal(started.attempt_id);
    expect(settled.state).toBe("settled");
    expect(settled.receipt?.transaction).toBe(facilitator.transaction);
    expect(settled.receipt?.service_outcome).toBe("ok");
    expect(settled.service_response?.asset).toBe("BTC");
    // No chain is reachable in this test, so the settlement stays the seller's report, said as such.
    expect(settled.message).toContain("the service reported it settled, and the chain has not confirmed it yet");
    expect((settled as { chain?: string }).chain).toBe("unchecked");
    expect(facilitator.calls.settle).toBe(1);
    // The seller's answer is marked as somebody else's in the structure itself, not only in the instructions.
    expect((settled as { untrusted_data?: { fields: string[] } }).untrusted_data?.fields).toEqual(["service_response"]);

    const receipts = structured<{ receipts: unknown[]; untrusted_data?: { fields: string[] } }>(await call("list_receipts", {}));
    expect(receipts.receipts).toHaveLength(1);
    expect(receipts.untrusted_data?.fields).toEqual(["receipts"]);
  });

  it("refuses a second payment on a quote that has already been paid", async () => {
    const result = await call("pay", { quote_id: paidQuoteId });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("A payment for this quote already exists: attempt");
    expect(textOf(result)).toContain("payment_status with attempt_id");
    expect(facilitator.calls.settle).toBe(1);
  });

  it("reports a denial as an answer, with nothing signed", async () => {
    const quoted = await quoteBtc();
    const started = structured<AttemptAnswer>(await call("pay", { quote_id: quoted.quote_id }));
    expect(started.state).toBe("awaiting_approval");

    await decide("deny");

    const denied = await waitForFinal(started.attempt_id);
    expect(denied.state).toBe("denied");
    expect(denied.message).toBe(
      "The owner rejected this payment in their wallet. Nothing was signed or submitted, and the service was not called.",
    );
    expect(denied.receipt).toBeUndefined();
    // The denial must have cost nothing: the facilitator never heard about this payment.
    expect(facilitator.calls.settle).toBe(1);
  });

  it("reports the running wallet, and which build answered", async () => {
    const status = structured<{
      running: boolean;
      address?: string;
      approval_mode?: string;
      client_version?: string;
      home?: string;
    }>(await call("wallet_status", {}));
    expect(status.running).toBe(true);
    expect(status.address).toBe(wallet.address);
    expect(status.approval_mode).toBe("ask-every-payment");
    // So nobody has to guess which copy of the server a host is running, or where it writes.
    expect(status.client_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.home).toBe(home);
  });

  it("says what to do when the wallet is not running, and pays nothing", async () => {
    const quoted = await quoteBtc();
    await wallet.close();

    const status = structured<{ running: boolean; hint?: string; client_version?: string; home?: string }>(
      await call("wallet_status", {}),
    );
    expect(status.running).toBe(false);
    expect(status.hint).toContain("superstables wallet serve");
    // A wallet that is not answering is exactly when someone needs to know which build asked.
    expect(status.client_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.home).toBe(home);

    const started = structured<AttemptAnswer>(await call("pay", { quote_id: quoted.quote_id }));
    const failed = FINAL_ATTEMPT_STATES.includes(started.state) ? started : await waitForFinal(started.attempt_id);
    expect(failed.state).toBe("failed");
    expect(failed.reason).toContain("wallet is not running");
    expect(failed.message).toContain("Payment did not happen");
    expect(facilitator.calls.settle).toBe(1);
  });
});

// ── Browser mode ─────────────────────────────────────────────────────────────────────────
//
// The same six tools, with the owner signing in their browser wallet instead of a wallet
// process of their own. What changes for the agent is one thing, and it is the whole point:
// the answer now carries a link, and the sentence the model repeats has to contain it,
// because without that link nobody can approve anything.

describe("the Superstables MCP server in browser mode", () => {
  let browserHome: string;
  let signer: BrowserWalletSigner;
  let browserClient: Client;
  let account: PrivateKeyAccount;

  beforeAll(async () => {
    browserHome = mkdtempSync(join(tmpdir(), "superstables-mcp-browser-"));
    account = privateKeyToAccount(generatePrivateKey());
    signer = new BrowserWalletSigner({
      port: 0,
      home: browserHome,
      policy: TEST_POLICY,
      timeoutMs: 8_000,
      balance: false,
    });
    const browserRecords = new Records(join(browserHome, "records"));
    const engine = new PaymentEngine({ records: browserRecords, policy: TEST_POLICY, signer });
    const server = createSuperstablesServer({
      records: browserRecords,
      policy: TEST_POLICY,
      engine,
      signer,
      findServices: (options = {}) => findServices({ ...options, includeIndex: false }),
      getService: (id, options = {}) => getService(id, { ...options, includeIndex: false }),
      waitMs: WAIT_MS,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    browserClient = new Client({ name: "superstables-browser-test-client", version: "0.0.0" });
    await browserClient.connect(clientTransport);
  });

  afterAll(async () => {
    await browserClient?.close();
    await signer?.close();
    rmSync(browserHome, { recursive: true, force: true });
  });

  async function browserCall(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await browserClient.callTool({ name, arguments: args })) as unknown as ToolResult;
  }

  it("says the browser wallet is there, because there is nothing to start", async () => {
    const status = structured<{ running: boolean; mode?: string; hint?: string; address?: string }>(
      await browserCall("wallet_status", {}),
    );
    expect(status.running).toBe(true);
    expect(status.mode).toBe("browser");
    expect(status.address).toBeUndefined();
    expect(status.hint).toContain("MetaMask signs each payment on the approval page");
  });

  it("hands the agent a link to show the person, and pays once they sign on it", async () => {
    const quoted = structured<QuoteAnswer>(
      await browserCall("quote", { service_id: DEMO_SERVICE_ID, params: { asset: "ETH" } }),
    );
    const started = structured<AttemptAnswer & { approval_url?: string }>(
      await browserCall("pay", { quote_id: quoted.quote_id }),
    );

    expect(started.state).toBe("awaiting_approval");
    expect(started.approval_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/approve\/[0-9a-f]{32}$/);
    expect(started.message).toContain("Open this link to review and sign in MetaMask:");
    expect(started.message).toContain(started.approval_url as string);
    expect(started.message).toContain("Nothing is signed yet");
    expect(started.receipt).toBeUndefined();

    // The person, at their keyboard, with MetaMask: connect, sign, submit.
    const link = started.approval_url as string;
    // As the page itself posts: from its own origin, with a JSON body (Node's fetch sends no Origin).
    const asPage = { "content-type": "application/json", origin: new URL(link).origin };
    const prepared = await fetch(`${link}/account`, {
      method: "POST",
      headers: asPage,
      body: JSON.stringify({ address: account.address }),
    });
    expect(prepared.status).toBe(200);
    const typedData = ((await prepared.json()) as { typedData: Record<string, unknown> }).typedData;
    const signature = await account.signTypedData(typedData as never);
    const submitted = await fetch(`${link}/signature`, {
      method: "POST",
      headers: asPage,
      body: JSON.stringify({ address: account.address, signature }),
    });
    expect(submitted.status).toBe(200);

    const settled = await waitForFinalOn(browserClient, started.attempt_id);
    expect(settled.state).toBe("settled");
    expect(settled.receipt?.service_outcome).toBe("ok");
    expect(settled.service_response?.asset).toBe("ETH");

    const after = structured<{ address?: string }>(await browserCall("wallet_status", {}));
    expect(after.address).toBe(account.address);
  });

  it("reports a rejection on the page as a denial, with nothing signed", async () => {
    const quoted = structured<QuoteAnswer>(
      await browserCall("quote", { service_id: DEMO_SERVICE_ID, params: { asset: "BTC" } }),
    );
    const started = structured<AttemptAnswer & { approval_url?: string }>(
      await browserCall("pay", { quote_id: quoted.quote_id }),
    );
    expect(started.approval_url).toBeDefined();

    const link = started.approval_url as string;
    const rejected = await fetch(`${link}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(link).origin },
      body: "{}",
    });
    expect(rejected.status).toBe(200);

    const denied = await waitForFinalOn(browserClient, started.attempt_id);
    expect(denied.state).toBe("denied");
    expect(denied.message).toContain("rejected this payment");
    expect(denied.receipt).toBeUndefined();
  });
});

/** payment_status until the attempt is final, on whichever client is being driven. */
async function waitForFinalOn(on: Client, attemptId: string): Promise<AttemptAnswer> {
  const deadline = Date.now() + 15_000;
  const ask = async () =>
    structured<AttemptAnswer>(
      (await on.callTool({ name: "payment_status", arguments: { attempt_id: attemptId } })) as unknown as ToolResult,
    );
  let answer = await ask();
  while (!FINAL_ATTEMPT_STATES.includes(answer.state) && Date.now() < deadline) answer = await ask();
  return answer;
}
