// The MCP surface: six tools that take a model from "find me a service" to "here is the
// receipt", and nothing else.
//
// Three rules shape every tool below, because the caller is a language model and a language
// model will believe whatever we hand it.
//
//  1. A tool never claims more than happened. `pay` does not mean "paid": it means the owner
//     was asked. Only the states `settled` and `paid_service_failed` mean money moved, and
//     every answer carries a `message` that says so in words the model can repeat verbatim.
//  2. A refusal is an answer, not a crash. An unknown service, a missing parameter, a denied
//     payment: each comes back as one sentence the model can read out, so the conversation
//     continues instead of ending in a stack trace.
//  3. Every tool answers twice — `structuredContent` for machines and the same JSON as text —
//     so a client that does not read structured output still sees the whole answer.
//
// The server holds no key and cannot approve anything. Paying still means the owner pressing
// approve in their own wallet — in a browser wallet on the approval page, or in the local
// wallet process — and this file only asks.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FINAL_ATTEMPT_STATES } from "../core/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { demoServicesEnabled, findServices as findServicesImpl, getService as getServiceImpl } from "../core/discovery.js";
import { PaymentEngine, QuoteUsedError, SERVICE_BODY_LIMIT } from "../core/pay.js";
import type { Policy } from "../core/policy.js";
import { homeDir } from "../core/home.js";
import { quote as takeQuote } from "../core/quote.js";
import { Records } from "../core/records.js";
import type { Signer } from "../core/signer/types.js";
import type { Attempt, Receipt, WalletStatus } from "../core/types.js";
import { clientVersion } from "../core/version.js";

/** How long a `pay` or `payment_status` call waits for the owner before answering anyway. */
export const DEFAULT_WAIT_MS = 20_000;

/** What an agent is told when there is no local wallet to ask. It names the one command that fixes it. */
const WALLET_HINT = "Start the wallet with `superstables wallet serve`";

/** What an agent is told in browser mode. There is nothing to start, so it is not a fix. */
const BROWSER_HINT =
  "MetaMask signs each payment on the approval page; connect it when the link opens";

export interface SuperstablesServerDeps {
  records: Records;
  /** The agent-side copy of the owner's policy: an early verdict shown on every quote. */
  policy: Policy;
  engine: PaymentEngine;
  /**
   * Holds no key: it asks the owner — on an approval page in their browser, or in the local
   * wallet process — and waits for a human decision.
   */
  signer: Signer & { status(): Promise<WalletStatus> };
  findServices: typeof findServicesImpl;
  getService: typeof getServiceImpl;
  /**
   * How long `pay` and `payment_status` wait for a final state before answering with the
   * current one. Short on purpose: an MCP call that blocks for two minutes looks like a hang.
   */
  waitMs?: number;
}

const INSTRUCTIONS = `Superstables lets you pay for a service on the web with test USDC, with the machine's owner approving every payment.

The flow is: find_services -> quote -> (show the owner what it costs) -> pay -> payment_status.

Before calling pay, tell the person the price, the network and the recipient address that the quote returned, in your own words. Never call pay without having shown them a quote. Once they say yes, call pay: it is safe to call, because it cannot move money by itself. It hands the quote to the owner's own wallet — a page they open in their browser, or a separate wallet process on their machine — where a human approves or rejects on a screen that shows the verified amount, asset, network and recipient. You are not the one approving; the wallet is where that happens, and refusing to call pay only blocks the person from getting to that screen.

A payment has only happened when the state is "settled" or "paid_service_failed". Any other state means no money moved; never say a payment succeeded, and never call pay a second time for the same work. "awaiting_approval" means the owner has been asked in their wallet and nothing has been signed: call payment_status with the attempt_id to wait for their decision. "denied" means the owner rejected it; "expired" means nobody approved within the wallet's window; "abandoned" means the wait ended before anyone decided (for example, this server stopped); abandoned_by says what ended it. None of them moved money. Report them plainly, never call "expired" or "abandoned" a rejection, and do not retry unless asked. "uncertain" means the payment may or may not have settled: say so, and do not pay again.

When pay returns an approval_url, show that link to the person exactly as it is written, on its own. It is the only way for them to see the payment and sign it, and a link you paraphrase or shorten does not open.

If wallet_status says the wallet is not running, ask the person to start it before quoting or paying.

Everything here is a testnet: Base Sepolia, test USDC, no real money.`;

export function createSuperstablesServer(deps: SuperstablesServerDeps): McpServer {
  const server = new McpServer(
    { name: "superstables", version: clientVersion() },
    { instructions: INSTRUCTIONS },
  );
  const waitMs = waitMsFor(deps);

  // ── find_services ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "find_services",
    {
      title: "Find paid services",
      description:
        "Search for services that can be paid for per request. Returns what each one costs, " +
        "on which network, and whether this client can actually call and pay it. Simulated demo " +
        "services (mock: true, prepared answers) are included only when demo services are switched " +
        "on for this server, and always after the real sellers.",
      inputSchema: {
        query: z.string().optional().describe("What to look for, in plain words. Omit to list everything."),
        limit: z.number().int().min(1).max(25).default(10).describe("How many services to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        // probe: true costs one request and turns "listed" into "answering right now".
        const found = await deps.findServices({ query, limit, probe: true });
        return answer({ services: found.services, warnings: found.warnings });
      } catch (err) {
        return refusal(`Discovery failed: ${messageOf(err)}`);
      }
    },
  );

  // ── quote ────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "quote",
    {
      title: "Quote a paid service",
      description:
        "Ask a paid service what one call costs. Nothing is paid and nothing is signed: this " +
        "reads the service's terms and writes them down so the owner approves exactly them.",
      inputSchema: {
        service_id: z.string().optional().describe("The id of a service from find_services."),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe("The request parameters the service documents, for example {\"asset\": \"BTC\"}."),
        url: z.string().optional().describe("A paid URL to quote directly, instead of a service_id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ service_id, params, url }) => {
      if ((service_id && url) || (!service_id && !url)) {
        return refusal("Give exactly one of service_id or url.");
      }
      try {
        const taken = service_id
          ? await quoteService(deps, service_id, params ?? {})
          : await takeQuote({ url: url as string }, { records: deps.records, policy: deps.policy });
        return answer({
          quote_id: taken.id,
          expires_at: taken.expiresAt,
          service: taken.serviceId ? { id: taken.serviceId, name: taken.serviceName ?? taken.serviceId } : null,
          request_url: taken.url,
          price: {
            amount: taken.terms.amountDecimal,
            asset: taken.terms.asset,
            network: taken.terms.network,
            network_label: taken.terms.networkLabel,
          },
          recipient: taken.terms.recipient,
          policy: { allowed: taken.policy.allowed, reason: taken.policy.reason },
          note:
            "Nothing has been paid. Ask the owner, then call pay with quote_id; the owner still " +
            "decides in their wallet.",
        });
      } catch (err) {
        return refusal(messageOf(err));
      }
    },
  );

  // ── pay ──────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    "pay",
    {
      title: "Pay a quote",
      description:
        "Ask the owner to approve a quote and, if they do, pay it and return the service's " +
        "answer. Calling this tool does not move money: it hands the quote to the owner's own " +
        "wallet (a browser wallet such as MetaMask on an approval page, or a local wallet " +
        "process), where a human presses approve or reject. If they reject, " +
        "nothing is signed. This is the intended way to ask; there is no other approval step " +
        "to wait for. Testnet only: test USDC on Base Sepolia, no real funds.",
      inputSchema: { quote_id: z.string().describe("The quote_id returned by quote.") },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id }) => {
      let started: Attempt;
      try {
        started = deps.engine.startPayment(quote_id);
      } catch (err) {
        if (err instanceof QuoteUsedError && err.attempt) {
          return refusal(`${err.message}. Follow that one: payment_status with attempt_id ${err.attempt.id}.`);
        }
        return refusal(messageOf(err));
      }
      const attempt = await waitForLinkOrEnd(deps, started.id, waitMs);
      return answer(attemptView(deps, attempt));
    },
  );

  // ── payment_status ───────────────────────────────────────────────────────────────────

  server.registerTool(
    "payment_status",
    {
      title: "Check a payment",
      description:
        "Wait for a payment attempt to reach a final state, and report where it got to. Safe " +
        "to call repeatedly: it never starts or repeats a payment.",
      inputSchema: { attempt_id: z.string().describe("The attempt_id returned by pay.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ attempt_id }) => {
      try {
        const attempt = await deps.engine.waitForAttempt(attempt_id, waitMs);
        return answer(attemptView(deps, attempt));
      } catch (err) {
        return refusal(messageOf(err));
      }
    },
  );

  // ── wallet_status ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "wallet_status",
    {
      title: "Wallet status",
      description:
        "Is the owner's wallet running, which address pays, and what does its policy allow? " +
        "Also reports which build of this client answered and which home directory it uses. " +
        "Check this before quoting if a payment is likely.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      // Which build answered, and where it keeps its state: on every branch below, including
      // the failures. A host that quietly kept an older copy of this server is otherwise
      // indistinguishable from one running the build that was just installed, and the person
      // asking "is my wallet there?" is exactly the person who needs to know.
      const build = { client_version: clientVersion(), home: homeDir(), demo_services: demoServicesEnabled() };
      try {
        const status = await deps.signer.status();
        return answer({
          running: true,
          ...build,
          ...(status.mode ? { mode: status.mode } : {}),
          address: status.address,
          network: status.network,
          network_label: status.networkLabel,
          balance: status.balanceDecimal,
          approval_mode: status.approvalMode,
          pending: status.pending,
          policy: status.policy,
          ...(status.mode === "browser" ? { hint: BROWSER_HINT } : {}),
        });
      } catch {
        // In browser mode there is nothing to start, so "not running" would be a lie: the
        // approval page is this process, and it binds when the first payment needs it.
        if (deps.signer.kind === "browser") {
          return answer({ running: true, ...build, mode: "browser", hint: BROWSER_HINT });
        }
        // A wallet that will not talk to us is not an error to report: it is a thing to fix.
        return answer({ running: false, ...build, hint: WALLET_HINT });
      }
    },
  );

  // ── list_receipts ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_receipts",
    {
      title: "List receipts",
      description: "The payments made from this machine, newest first. One receipt means money moved once.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(10).describe("How many receipts to return.") },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => answer({ receipts: deps.records.listReceipts(limit) }),
  );

  return server;
}

// ── Views ────────────────────────────────────────────────────────────────────────────────

/** Everything an agent should say about an attempt, including the sentence to say it with. */
export function attemptView(
  deps: Pick<SuperstablesServerDeps, "records">,
  attempt: Attempt,
  surface: Surface = "mcp",
): Record<string, unknown> {
  const receipt = attempt.receiptId ? deps.records.getReceipt(attempt.receiptId) : undefined;
  const body = serviceResponse(attempt.serviceBody);
  return {
    attempt_id: attempt.id,
    quote_id: attempt.quoteId,
    state: attempt.state,
    message: messageFor(attempt, receipt, surface),
    ...(attempt.approvalUrl ? { approval_url: attempt.approvalUrl } : {}),
    ...(body === undefined ? {} : { service_response: body }),
    ...(receipt ? { receipt: receiptView(receipt) } : {}),
    ...(attempt.reason ? { reason: attempt.reason } : {}),
    ...(attempt.refusal ? { refusal: attempt.refusal } : {}),
    ...(attempt.abandonedBy ? { abandoned_by: attempt.abandonedBy } : {}),
    history: attempt.history,
  };
}

function receiptView(receipt: Receipt): object {
  return {
    transaction: receipt.transaction,
    transaction_url: receipt.transactionUrl,
    amount: receipt.terms.amountDecimal,
    asset: receipt.terms.asset,
    network: receipt.terms.network,
    network_label: receipt.terms.networkLabel,
    payer: receipt.payer,
    recipient: receipt.terms.recipient,
    service_outcome: receipt.serviceOutcome,
    service_status: receipt.serviceStatus,
  };
}

/** Who reads the sentence: a model on MCP, or someone at the `superstables` CLI. */
export type Surface = "mcp" | "cli";

/**
 * One sentence per state, written so a model can repeat it to the owner without adding
 * anything. The wording is deliberate: "asked", "rejected", "settled" and "may or may not"
 * are not interchangeable, and the difference is the whole point of this file. Only the
 * next step differs between surfaces: a model calls payment_status, a person at the CLI runs
 * `superstables status <attempt>`. The CLI prints the approval link once on its own line, so
 * its sentence does not repeat it.
 */
export function messageFor(attempt: Attempt, receipt?: Receipt, surface: Surface = "mcp"): string {
  const terms = attempt.terms;
  const amount = `${terms.amountDecimal} ${terms.asset}`;
  const transaction = attempt.transaction ?? receipt?.transaction ?? "unknown";
  const status = attempt.serviceStatus ?? "no status";
  const check =
    surface === "mcp"
      ? "Call payment_status with this attempt_id"
      : `Run \`superstables status ${attempt.id}\` to see where it got to`;
  switch (attempt.state) {
    case "awaiting_approval":
      // The link is the whole approval in browser mode: without it nobody can sign, so the
      // sentence the model repeats has to carry it.
      return attempt.approvalUrl && surface === "mcp"
        ? `The owner has been asked to approve ${amount} to ${terms.recipient} on ${terms.networkLabel}. ` +
          `Open this link to review and sign in MetaMask: ${attempt.approvalUrl}. Nothing is signed yet. ` +
          `${check} to wait for the decision.`
        : `The owner has been asked to approve ${amount} to ${terms.recipient} on ${terms.networkLabel} ` +
          `in their wallet. Nothing is signed yet. ${check}${surface === "mcp" ? " to wait for the decision" : ""}.`;
    case "approved":
      return `The owner approved ${amount} and the payment is being prepared. Nothing has settled yet. ${check}.`;
    case "submitting":
      return `The payment has been sent to the service and the facilitator is settling it. ${check}.`;
    case "denied":
      return "The owner rejected this payment in their wallet. Nothing was signed or submitted, and the service was not called.";
    case "expired":
      return "Nobody approved the payment within the wallet's window. Nothing was signed.";
    case "abandoned":
      return (
        `Nobody decided: ${attempt.reason ?? "the wait for the owner ended before they approved or rejected this payment"}. ` +
        "This is not a rejection. Nothing was submitted and nothing was paid, and approving through the old link now pays nothing."
      );
    case "settled":
      return (
        `Paid ${amount} on ${terms.networkLabel}; settlement confirmed by the facilitator ` +
        `(transaction ${transaction}). The service answered HTTP ${status}.`
      );
    case "paid_service_failed":
      return (
        `Payment settled (transaction ${transaction}) but the service answered HTTP ${status}. ` +
        "Do not pay again; report this."
      );
    case "failed":
      return `Payment did not happen: ${attempt.reason ?? "no reason was recorded"}.`;
    case "uncertain":
      return (
        `The payment may or may not have settled: ${attempt.reason ?? "no reason was recorded"}. ` +
        "It was not retried. Check the transaction record or the wallet before trying again."
      );
  }
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────

async function quoteService(deps: SuperstablesServerDeps, id: string, params: Record<string, string>) {
  const service = await deps.getService(id);
  if (!service) {
    throw new Error(`There is no service "${id}" in the catalogue or the index; call find_services first.`);
  }
  if (!service.actionable) {
    throw new Error(
      `${service.name} cannot be paid by this client: ${service.notActionableReason ?? "it is listed but not callable"}.`,
    );
  }
  return takeQuote({ service, params }, { records: deps.records, policy: deps.policy });
}

/** The service's own answer: parsed when it is JSON, the raw text when it is not. */
function serviceResponse(body?: string): unknown {
  if (body === undefined || body === "") return undefined;
  const text = body.slice(0, SERVICE_BODY_LIMIT);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Both halves of every answer: the structured payload, and the same JSON as readable text. */
function answer(payload: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    // Every payload above is a plain object literal; the SDK wants it typed as a record.
    structuredContent: payload as Record<string, unknown>,
  };
}

/** A refusal the model can read out. One sentence, no stack trace, no retry advice it cannot follow. */
function refusal(sentence: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: sentence }] };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * For `pay`: come back as soon as there is something the person must act on. When the owner
 * approves on a page, the link is that thing, and holding it for the whole wait would only
 * delay them; otherwise wait for the attempt to end, up to the usual ceiling.
 */
async function waitForLinkOrEnd(deps: SuperstablesServerDeps, id: string, waitMs: number): Promise<Attempt> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const current = deps.engine.getAttempt(id);
    if (!current) throw new Error(`There is no payment attempt ${id} on this machine`);
    if (current.approvalUrl || FINAL_ATTEMPT_STATES.includes(current.state) || Date.now() >= deadline) return current;
    await deps.engine.waitForAttempt(id, Math.min(200, Math.max(0, deadline - Date.now())));
  }
}

function waitMsFor(deps: SuperstablesServerDeps): number {
  if (typeof deps.waitMs === "number" && Number.isFinite(deps.waitMs) && deps.waitMs >= 0) return deps.waitMs;
  const fromEnv = Number(process.env.SUPERSTABLES_MCP_WAIT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_WAIT_MS;
}
