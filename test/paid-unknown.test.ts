// Once money may have moved, every answer a person or an agent sees says the payment is unknown or uncertain (or paid),
// never "not paid" or "nothing was paid". The only exceptions are answers the chain proves (EXCEPTIONS). Where money may
// have moved starts differs per path: `pay` once the attempt is approved (the Tempo wallet was asked to send, or an x402
// signature was accepted), the local approval page once the wallet was asked, an owner command once its page or the site
// says the wallet was asked, buy-once once the site's answers carried payment evidence, and a budget buy once its journal
// exists.
//
// One table. Each row drives one path past that point with the repo's own fakes and returns what the CLI, the approval
// page or the budget RESULT showed; assertProperty checks every one of those outputs, and each row pins its literal values.
// The coverage test reads from the code the routes of every wallet step and of the owner approval page, the attempt
// states, the pay CLI's commands and the budget dispatcher's handlers, and fails while any of them has neither a row nor
// a reason in NO_ANSWER_AFTER_BOUNDARY. It needs no row to have run.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { Keypair, SendTransactionError, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PaymentEngine } from "../src/core/pay.js";
import { DEFAULT_POLICY } from "../src/core/policy.js";
import { quote } from "../src/core/quote.js";
import { Records } from "../src/core/records.js";
import { BrowserWalletSigner } from "../src/core/signer/browser.js";
import { OWNER_ACTION_KINDS, OWNER_ROUTES, OwnerApprovalServer, type OwnerActionInput } from "../src/core/signer/owner-approval-server.js";
import { STEPS } from "../src/core/signer/steps/index.js";
import { WalletSigner } from "../src/core/signer/wallet.js";
import { ATTEMPT_STATES } from "../src/core/types.js";
import { startFakeBaseSepolia } from "./helpers/fake-base-sepolia.js";
import { startFakePurchaseSite } from "./helpers/fake-purchase-site.js";
import { evmOwner, startFakeRpc, startFakeSite, type FakeSite } from "./helpers/fake-site.js";
import { startFakeMppSeller, startFakeTempoPay } from "./helpers/fake-tempo-pay.js";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "./helpers/servers.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAIN = resolve(ROOT, "src/cli/main.ts");
const BUDGET = resolve(ROOT, "budget/cli.mjs");

// ---- what a user or agent sees, and the one check every row's outputs go through --------------------------------------

type Surface = "pay" | "approval" | "budget" | "listing";
/** One output: `pay`/`status` JSON, an approval page answer, a budget RESULT, or a listing's text. */
interface Seen {
  at: string;
  surface: Surface;
  /** The command that printed it (`superstables status`, `budget wait`), or the approval page's step and route that answered. */
  cmd?: string;
  step?: string;
  route?: string;
  exit?: number;
  http?: number;
  body?: any;
  text: string;
}
type Exception = keyof typeof EXCEPTIONS;
/** `before`: the wallet was never asked to send, so the boundary was not crossed; only the row's literal values are checked. */
type Verdict = "unknown" | "paid" | "before" | Exception;
interface Expect {
  verdict: Verdict;
  /** Literal values the output must have: exit, http, the JSON's fields, `text` (all of stdout and stderr). */
  match: Record<string, unknown>;
}
interface Row {
  path: string;
  covers: string[];
  run: () => Promise<Seen[]>;
  expect: Expect[];
  timeout?: number;
}

/** The answers that say "not paid" after the boundary, allowed only with the chain's proof (agreed list). */
const EXCEPTIONS = {
  // pay: the chain shows the authorization was never used and can no longer be (src/core/pay.ts recordUnpaid)
  "pay-chain-unpaid": { surface: "pay", state: "failed", proof: (b: any) => b.chain === "unpaid" && /never used, and it can no longer be/.test(b.chain_reason), allows: [/payment did not happen/i, /nothing was paid/i] },
  // budget buy, evm: the pull reverted in a final block, or the price came back, or another final transaction took its nonce
  "evm-pull-reverted": { surface: "budget", state: "failed", proof: (b: any) => typeof b.tx?.pull === "string" && /the pull reverted on chain/.test(b.reason), allows: [/no funds moved/i, /nothing moved/i] },
  // the rail prints the owner's net debit as debit; the dispatcher prints it as amount
  "evm-funds-returned": { surface: "budget", state: "failed", proof: (b: any) => typeof b.tx?.return === "string" && (b.debit ?? b.amount) === "0" && /was returned to the owner/.test(b.reason), allows: [] },
  "evm-nonce-replaced": { surface: "budget", state: "not_found", proof: (b: any) => /a different final transaction 0x[0-9a-f]{64} consumed the pull nonce/.test(b.reason), allows: [/nothing moved/i] },
} as const satisfies Record<string, { surface: Surface; state: string; proof: (b: any) => boolean; allows: readonly RegExp[] }>;

/** What may be said after the boundary, per surface. `undefined`: the answer states no outcome (a refused route). */
const SAYS: Record<"unknown" | "paid", Record<Surface, (string | undefined)[]>> = {
  unknown: { pay: ["uncertain", "approved", "submitting"], budget: ["unknown"], approval: ["unknown", "signed", "sending", "sent", undefined], listing: [undefined] },
  paid: { pay: ["settled", "paid_service_failed"], budget: ["settled"], approval: [], listing: [undefined] },
};
/** Never after the boundary, outside EXCEPTIONS. */
const FORBIDDEN_STATES: Record<Surface, string[]> = {
  pay: ["awaiting_approval", "denied", "expired", "abandoned", "failed"],
  budget: ["failed", "not_found", "refused_precheck", "refused_chain", "waiting_owner"],
  approval: ["denied", "expired", "abandoned", "refused", "rejected", "failed", "pending", "ready"],
  listing: [],
};
// "cannot prove nothing was submitted" says the opposite, so it is not one of them
const FORBIDDEN_TEXT = [
  /payment did not happen/i, /nothing was paid/i, /(?<!prove )nothing was submitted/i, /(?<!prove )nothing was sent/i, /nothing was signed or paid/i,
  /nothing moved/i, /no funds moved/i, /not approved or paid yet/i, /has not finished approving/i, /no payment has been made/i, /did not pay/i,
];
/** Budget answers that read nothing and so state no outcome, with the words each must say that in. */
const NO_OUTCOME: Record<string, RegExp> = {
  show_owner_first: /^this wait did not read the approval, so it says nothing about whether the owner approved or paid it\./,
};
/** The exit code each state stands for: pay (src/cli/outcome.ts), budget (budget/cli.mjs). */
const EXIT: Record<Surface, Record<string, number>> = {
  pay: { uncertain: 5, approved: 0, submitting: 0, settled: 0, paid_service_failed: 4, failed: 1 },
  budget: { unknown: 5, settled: 0, failed: 1, not_found: 1, show_owner_first: 2 },
  approval: {},
  listing: {},
};

/** The outcome an output states. A buy-once refused because an earlier purchase is open speaks for that one, under `pending`. */
function outcomeOf(seen: Seen): { state?: string; paid?: unknown; amount?: unknown; own: boolean } {
  const b = seen.body ?? {};
  if (seen.surface === "approval") return { state: b.status, own: false };
  if (seen.surface === "listing") return { own: false };
  if (b.state === "refused_pending") return { state: b.pending?.state, paid: b.paid, amount: b.amount, own: false };
  return { state: b.state, paid: b.paid, amount: b.amount, own: true };
}

/** Every object inside an answer, with its path (`steps.0`, `pending`); not `history`, the states an attempt had before. */
function* nestedObjects(value: unknown, path = ""): Generator<[string, Record<string, unknown>]> {
  if (!value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (!inner || typeof inner !== "object" || (path === "" && key === "history")) continue;
    const at = path ? `${path}.${key}` : key;
    yield [at, inner as Record<string, unknown>];
    yield* nestedObjects(inner, at);
  }
}

function assertProperty(seen: Seen, e: Expect): void {
  const at = `${seen.at} (${seen.cmd ?? seen.route ?? seen.surface})`;
  if (e.verdict === "before") {
    expect({ exit: seen.exit, http: seen.http, ...(seen.body ?? {}), text: seen.text }, at).toMatchObject(e.match);
    return;
  }
  const o = outcomeOf(seen);
  const exception = e.verdict in EXCEPTIONS ? EXCEPTIONS[e.verdict as Exception] : undefined;
  const allowed: readonly RegExp[] = exception?.allows ?? [];
  for (const f of FORBIDDEN_TEXT) if (!allowed.some((a) => a.source === f.source)) expect(seen.text, `${at}: says ${f}`).not.toMatch(f);
  if (seen.surface === "budget" && o.state !== undefined && o.state in NO_OUTCOME) {
    expect(e.verdict, `${at}: ${o.state} states no outcome`).toBe("unknown");
    expect(seen.body.next, `${at}: ${o.state} says it read nothing`).toMatch(NO_OUTCOME[o.state]);
  } else if (exception) {
    expect([seen.surface, o.state], `${at}: ${e.verdict}`).toEqual([exception.surface, exception.state]);
    expect(exception.proof(seen.body), `${at}: ${e.verdict} without the chain's proof`).toBe(true);
  } else {
    const says = SAYS[e.verdict as "unknown" | "paid"][seen.surface];
    expect(says, `${at}: state ${o.state} for ${e.verdict}`).toContain(o.state);
    expect(FORBIDDEN_STATES[seen.surface], `${at}: forbidden state`).not.toContain(o.state);
    if (o.paid !== undefined) expect(o.paid, `${at}: paid`).not.toBe(false);
    if (o.amount !== undefined) expect(o.amount, `${at}: amount`).not.toBe("0");
    if (seen.body && typeof seen.body === "object" && "money_moved" in seen.body) expect(seen.body.money_moved, `${at}: money_moved`).not.toBe(false);
    // the same for every object inside the answer: a setup's steps, the open purchase under pending, a payment
    for (const [path, inner] of nestedObjects(seen.body)) {
      if ("money_moved" in inner) expect(inner.money_moved, `${at}: ${path}.money_moved`).not.toBe(false);
      if ("paid" in inner) expect(inner.paid, `${at}: ${path}.paid`).not.toBe(false);
      if ("amount" in inner) expect(inner.amount, `${at}: ${path}.amount`).not.toBe("0");
      if (typeof inner.state === "string") expect(FORBIDDEN_STATES[seen.surface], `${at}: ${path}.state`).not.toContain(inner.state);
    }
  }
  if (o.own && o.state !== undefined) {
    const code = seen.surface === "budget" && o.state === "settled" && seen.body?.delivered !== true ? 4 : EXIT[seen.surface][o.state];
    expect(seen.exit, `${at}: exit for ${o.state}`).toBe(code);
  }
  expect({ exit: seen.exit, http: seen.http, ...(seen.body ?? {}), text: seen.text }, at).toMatchObject(e.match);
}

// ---- drivers: the CLIs as processes, the approval page over HTTP --------------------------------------------------------

const homes: string[] = [];
const opened: { close(): Promise<void> | void }[] = [];
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "ss-paid-unknown-"));
  homes.push(home);
  return home;
};
afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

type Ran = { code: number; stdout: string; stderr: string };
function exec(args: string[], env: Record<string, string | undefined>): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.once("error", fail);
    child.once("close", (code) => done({ code: code ?? 0, stdout, stderr }));
  });
}
const payEnv = (home: string, env: Record<string, string> = {}) => ({
  SUPERSTABLES_HOME: home, SUPERSTABLES_DOCTOR_OFFLINE: "1", SUPERSTABLES_APPROVE_PORT: "0", SUPERSTABLES_WALLET_URL: "http://127.0.0.1:1", ...env,
});
/** `superstables ...` in one process, as the installed command runs (a signal reaches the process that pays). */
const superstables = (home: string, args: string[], env: Record<string, string> = {}) => exec(["--import", "tsx", MAIN, ...args], payEnv(home, env));
const budgetEnv = (home: string, env: Record<string, string> = {}) => ({ SUPERSTABLES_HOME: home, SUPERSTABLES_SITE: undefined, SUPERSTABLES_BUDGET_APPROVAL_ID: undefined, ...env });
const budget = (home: string, args: string[], env: Record<string, string> = {}) => exec([BUDGET, ...args], budgetEnv(home, env));
const resultOf = (stdout: string) => {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("RESULT "));
  return line ? JSON.parse(line.slice(7)) : null;
};

const seenPay = (at: string, cmd: string, r: Ran): Seen => ({ at, surface: "pay", cmd: `superstables ${cmd}`, exit: r.code, body: JSON.parse(r.stdout), text: r.stdout + r.stderr });
const seenListing = (at: string, cmd: string, r: Ran): Seen => ({ at, surface: "listing", cmd: `superstables ${cmd}`, exit: r.code, text: r.stdout + r.stderr });
const seenBudget = (at: string, cmd: string, r: Ran): Seen => ({ at, surface: "budget", cmd: `budget ${cmd}`, exit: r.code, body: resultOf(r.stdout), text: r.stdout + r.stderr });
/** `step`: the wallet step whose page answered (a local payment's step kind, or owner:<kind> for the owner approval page). */
async function seenRoute(step: string, at: string, link: string, route: string, body?: unknown): Promise<Seen> {
  const res = await fetch(`${link}${route}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", origin: new URL(link).origin }, body: JSON.stringify(body) });
  const text = await res.text();
  return { at, surface: "approval", step, route, http: res.status, body: JSON.parse(text), text };
}
const status = async (at: string, home: string, id: string, env: Record<string, string>) => seenPay(at, "status", await superstables(home, ["status", id, "--json"], env));

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 20_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = await read();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---- pay on Tempo: the real engine and approval page; the test posts what the page posts ---------------------------------

const RECIPIENT = "0x2222222222222222222222222222222222222222";
async function tempoPay(options: { timeoutMs?: number } = {}) {
  const home = newHome();
  process.env.SUPERSTABLES_HOME = home;
  const chain = await startFakeTempoPay();
  const seller = await startFakeMppSeller(chain, { recipient: RECIPIENT });
  const records = new Records(join(home, "records"));
  const signer = new BrowserWalletSigner({ port: 0, home, policy: DEFAULT_POLICY, timeoutMs: options.timeoutMs ?? 10_000, balance: false });
  const engine = new PaymentEngine({ records, policy: DEFAULT_POLICY, signer, rpcUrl: chain.url });
  opened.push(chain, seller, { close: () => signer.close() });
  const q = await quote({ url: `${seller.url}/paid` }, { records, policy: DEFAULT_POLICY });
  const attempt = engine.startPayment(q.id);
  const link = await until(() => engine.getAttempt(attempt.id)?.approvalUrl, "the approval link");
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  const env = { SUPERSTABLES_TEMPO_RPC: chain.url };
  return { home, chain, seller, records, signer, engine, id: attempt.id, link, owner, env };
}
type Tempo = Awaited<ReturnType<typeof tempoPay>>;
/** The page connects the owner's account and asks the wallet to send: the attempt is approved from here on. */
async function walletAsked(t: Tempo) {
  const account = await seenRoute("tempo-transfer", "connect", t.link, "/account", { address: t.owner });
  expect(account.http).toBe(200);
  const sending = await seenRoute("tempo-transfer", "the wallet is asked to send", t.link, "/sending", { address: t.owner });
  expect(sending.body).toEqual({ status: "send" });
  expect(t.engine.getAttempt(t.id)?.state).toBe("approved");
  return account.body.transaction as { to: string; data: string };
}

// ---- pay with x402: the engine with the local wallet, a seller and its facilitator, and a Base Sepolia chain -------------

async function x402Pay(seller: (chain: Awaited<ReturnType<typeof startFakeBaseSepolia>>, authorization: () => any) => Promise<Response>) {
  const home = newHome();
  const facilitator = await startFacilitator();
  const endpoint = await startPaidEndpoint(facilitator.url);
  const wallet = await startWallet();
  const chain = await startFakeBaseSepolia();
  opened.push(facilitator, endpoint, wallet, chain);
  const records = new Records(join(home, "records"));
  const engine = new PaymentEngine({
    records,
    policy: DEFAULT_POLICY,
    signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }),
    rpcUrl: chain.url,
    fetchImpl: async (input, init) => {
      const res = await fetch(input, init);
      const headers = new Headers(init?.headers);
      return headers.has("payment-signature") || headers.has("x-payment") ? seller(chain, () => facilitator.lastAuthorization!) : res;
    },
  });
  const q = await quote({ url: `${endpoint.url}/v1/market?asset=BTC` }, { records, policy: DEFAULT_POLICY });
  const attempt = await engine.waitForAttempt(engine.startPayment(q.id).id, 10_000);
  return { home, chain, attempt, env: { SUPERSTABLES_RPC_URL: chain.url } };
}

// ---- pay as a process: quote and pay a Tempo seller, the owner's wallet asked through the printed link -------------------

async function payProcessAsked() {
  const home = newHome();
  const chain = await startFakeTempoPay();
  const seller = await startFakeMppSeller(chain, { recipient: RECIPIENT });
  opened.push(chain, seller);
  const env = { SUPERSTABLES_TEMPO_RPC: chain.url };
  const q = JSON.parse((await superstables(home, ["quote", `${seller.url}/paid`, "--json"], env)).stdout) as { id: string };
  const child = spawn(process.execPath, ["--import", "tsx", MAIN, "pay", q.id, "--json"], { cwd: ROOT, env: { ...process.env, ...payEnv(home, env) } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += String(c)));
  child.stderr.on("data", (c) => (stderr += String(c)));
  const closed = new Promise<number>((done) => child.once("close", (code, signal) => done(code ?? (signal ? -1 : 0))));
  const link = await until(() => /http:\/\/127\.0\.0\.1:\d+\/approve\/[0-9a-f]+/.exec(stderr)?.[0], "pay's approval link");
  const id = /\(attempt ([0-9a-f-]+)\)/.exec(stderr)![1];
  const owner = privateKeyToAccount(generatePrivateKey()).address;
  expect((await seenRoute("tempo-transfer", "connect", link, "/account", { address: owner })).http).toBe(200);
  expect((await seenRoute("tempo-transfer", "ask the wallet", link, "/sending", { address: owner })).body).toEqual({ status: "send" });
  expect(new Records(join(home, "records")).getAttempt(id)?.state).toBe("approved");
  return { home, env, id, child, closed, out: () => ({ stdout, stderr }) };
}

// ---- budget: superstables.com (fake site), an EVM RPC, and a chain set up there ------------------------------------------

const OWNER = evmOwner("22");
const AGENT = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
async function hostedBudget(extra?: (method: string, params: any[]) => unknown) {
  const home = newHome();
  const site = await startFakeSite();
  const rpc = await startFakeRpc(84532, extra);
  opened.push(site, rpc);
  mkdirSync(join(home, "budget", "public"), { recursive: true });
  mkdirSync(join(home, "keys", "budget"), { recursive: true });
  writeFileSync(join(home, "keys", "budget", "evm-agent.env"), `B4_AGENT_KEY=0x${"11".repeat(32)}\nB4_AGENT_ADDRESS=${AGENT}\n`, { mode: 0o600 });
  writeFileSync(join(home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\nAPPROVALS=hosted\nSITE=${site.url}\n`);
  site.owner = OWNER;
  return { home, site, env: { B4_RPC: rpc.url } };
}
/** The owner page log has recorded that the wallet was asked for this site request. */
const loggedAsked = (home: string, requestId: string) =>
  until(() => {
    const log = join(home, "budget", "owner-approvals.jsonl");
    return existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => l.includes(requestId) && l.includes('"sending":true'));
  }, "the page log to record the wallet was asked");
const allowance = (value: bigint) => (method: string, params: any[]) =>
  method === "eth_call" && String(params[0]?.data).startsWith("0xdd62ed3e") ? `0x${value.toString(16).padStart(64, "0")}` : undefined;

// ---- the owner approval page (src/core/signer/owner-approval-server.ts): the real server, the test posts what its page posts

const OWNER_TERMS = { title: "Send funds for network fees", amount: "0.0001", unit: "ETH", summary: "Send 0.0001 ETH to the agent.", rows: [], enforced: [], notEnforced: [], notes: [] };
const ownerTransfer = (timeoutMs: number): OwnerActionInput => ({
  kind: "evm-transaction",
  chain: { chainId: 84532, chainName: "Base Sepolia", rpcUrl: "http://127.0.0.1:1", explorer: "https://sepolia.basescan.org", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, testnet: true },
  terms: OWNER_TERMS,
  account: OWNER,
  transaction: { to: AGENT, data: "0x", value: "0x5af3107a4000" },
  timeoutMs,
});
async function ownerServer(sendingGraceMs = 120_000) {
  const server = new OwnerApprovalServer({ port: 0, sendingGraceMs });
  await server.start();
  opened.push({ close: () => server.close() });
  return server;
}
/** The owner page asked the wallet to send: the owner's account connected, then /sending. */
async function ownerAsked(url: string, address = OWNER) {
  expect((await seenRoute("owner:evm-transaction", "connect", url, "/account", { address })).http).toBe(200);
  expect((await seenRoute("owner:evm-transaction", "the wallet is asked to send", url, "/sending", { address })).body).toEqual({ status: "sending" });
}

/** Another spender than the agent, for a grant the wallet changed. */
const SPENDER = "0x5555555555555555555555555555555555555555";
type OwnerTx = { to: string; input: Hex; value: bigint; logs: unknown[] };
/**
 * An owner command on this machine (no superstables.com), whose page's wallet reports these transactions: the RPC shows
 * each one mined in block 101, after the request started at block 100, from the owner, successful, with these logs.
 */
async function ownerOnThisMachine(txs: Record<string, OwnerTx>, extra?: (method: string, params: any[]) => unknown) {
  const blockHash = `0x${"ef".repeat(32)}`;
  const b = await hostedBudget((method, params) => {
    if (method === "eth_blockNumber") return "0x64";
    const answer = extra?.(method, params);
    if (answer !== undefined) return answer;
    const t = txs[params[0]];
    if (!t) return undefined;
    if (method === "eth_getTransactionByHash") return { hash: params[0], blockHash, blockNumber: "0x65", from: OWNER, to: t.to, input: t.input, value: `0x${t.value.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
    if (method === "eth_getTransactionReceipt") return { transactionHash: params[0], blockHash, blockNumber: "0x65", from: OWNER, to: t.to, status: "0x1", logs: t.logs, gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
    return undefined;
  });
  writeFileSync(join(b.home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`);
  return b;
}
const approval = (owner: string, spender: string, value: bigint, hash: Hex) => ({
  address: BASE_USDC, topics: encodeEventTopics({ abi: erc20, eventName: "Approval", args: { owner: owner as Hex, spender: spender as Hex } }), data: `0x${value.toString(16).padStart(64, "0")}`,
  blockNumber: "0x65", blockHash: `0x${"ef".repeat(32)}`, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
});
/** The owner's page asked the wallet, which reported `hash`: the page's answer, its state once the command read the chain, and the command's final RESULT. */
async function ownerPageSent(b: { home: string; env: Record<string, string> }, first: any, hash: Hex): Promise<Seen[]> {
  await ownerAsked(first.url);
  const sent = await seenRoute("owner:evm-transaction", "the page reports the transaction", first.url, "/sent", { address: OWNER, hash });
  const verdict = await until(async () => {
    const st = await seenRoute("owner:evm-transaction", "the page's state once the command read the chain", first.url, "/state");
    return st.body.status !== "sent" && st;
  }, "the command's verdict on the page", 60_000);
  return [sent, verdict, seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "90"], b.env))];
}

// ---- budget, in process: the evm rail's reconcile and recover, the chain answered as in their own tests ------------------

const TOKEN = "0x3333333333333333333333333333333333333333";
const SELLER = "0x4444444444444444444444444444444444444444";
const PULL: Hex = `0x${"ab".repeat(32)}`;
const RETURN: Hex = `0x${"14".repeat(32)}`;
const BLOCK_HASH: Hex = `0x${"cd".repeat(32)}`;
const NONCE: Hex = `0x${"ef".repeat(32)}`;
const erc20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "function approve(address spender, uint256 value)",
]);
const transfer = (from: string, to: string, value = 10000n) => ({ address: TOKEN, topics: encodeEventTopics({ abi: erc20, eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }), data: `0x${value.toString(16).padStart(64, "0")}`, removed: false });
const mined = (hash: Hex, block: bigint, logs: unknown[], status = "success") => ({ transactionHash: hash, blockNumber: block, blockHash: BLOCK_HASH, status, logs });
const purchase = (op: string) => ({
  op, rail: "base-sepolia", path: "approve", state: "submitted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: "https://seller.example",
  owner: OWNER, agent: AGENT, token: TOKEN, max: "1", price: "0.01", pullTx: PULL, pullNonce: 7, pullBlock: "80", signed: true,
  auth: { from: AGENT, to: SELLER, value: "10000", nonce: NONCE, validBefore: 1000, validAfter: 0 }, delivered: null, notes: [],
});

/**
 * The same chain over JSON-RPC, for the dispatcher (`budget reconcile` spawns the evm rail against B4_RPC): finalized block
 * 90, head 110, time 2000, every authorization unused, the agent holding `held` of Base Sepolia's USDC, and these receipts.
 */
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const rpcTransfer = (from: string, to: string, value: bigint, hash: Hex, block: bigint) => ({
  address: BASE_USDC, topics: encodeEventTopics({ abi: erc20, eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }), data: `0x${value.toString(16).padStart(64, "0")}`,
  blockNumber: hex(block), blockHash: BLOCK_HASH, transactionHash: hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
});
const rpcReceipt = (hash: Hex, block: bigint, logs: unknown[], status = "0x1") => ({
  transactionHash: hash, blockHash: BLOCK_HASH, blockNumber: hex(block), from: AGENT, to: BASE_USDC, status, logs, gasUsed: "0x5208", cumulativeGasUsed: "0x5208",
  effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x2",
});
function rpcChain(receipts: Record<string, unknown>, held = 10000n) {
  return (method: string, params: any[]): unknown => {
    if (method === "eth_blockNumber") return hex(110);
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "finalized" ? 90n : params[0] === "latest" || params[0] === "safe" ? 110n : BigInt(params[0]);
      return { number: hex(n), hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: hex(2000), transactions: [], gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", difficulty: "0x0", extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, miner: AGENT, nonce: "0x0000000000000000", receiptsRoot: BLOCK_HASH, sha3Uncles: BLOCK_HASH, size: "0x1", stateRoot: BLOCK_HASH, totalDifficulty: "0x0", transactionsRoot: BLOCK_HASH, uncles: [] };
    }
    if (method === "eth_getTransactionReceipt") return receipts[String(params[0]).toLowerCase()] ?? null;
    if (method === "eth_getTransactionByHash") return null;
    if (method === "eth_getTransactionCount") return "0x8";
    if (method === "eth_getLogs") return [];
    if (method === "eth_call" && String(params[0]?.data).startsWith("0x70a08231")) return `0x${held.toString(16).padStart(64, "0")}`;
    return undefined;
  };
}
/** `budget reconcile` on one journal, through the dispatcher, as an agent runs it. */
async function reconcileCli(at: string, receipts: Record<string, unknown>, journal: Record<string, unknown>) {
  const b = await hostedBudget(rpcChain(receipts));
  const dir = join(b.home, "budget", "ops", "evm-base-sepolia");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${journal.op}.json`), JSON.stringify({ ...journal, token: BASE_USDC }));
  return { b, seen: seenBudget(at, "reconcile", await budget(b.home, ["reconcile", "--rail", "evm", "--chain", "base-sepolia", "--op", String(journal.op)], b.env)) };
}

/** The chain at finalized block 90, time 2000 (past every authorization here), as the evm rail reads it. */
function evmChain() {
  return {
    getBlockNumber: vi.fn(async () => 110n),
    getBlock: vi.fn(async ({ blockTag, blockNumber }: any) => ({ number: blockNumber ?? (blockTag === "finalized" ? 90n : 110n), timestamp: 2000n, hash: BLOCK_HASH, transactions: [] as unknown[] })),
    getTransactionCount: vi.fn(async () => 8),
    readContract: vi.fn(async () => false),
    getTransaction: vi.fn(async (_: { hash: Hex }): Promise<unknown> => { throw new Error("not found"); }),
    getLogs: vi.fn(async (): Promise<unknown[]> => []),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }): Promise<unknown> => (hash === PULL ? mined(PULL, 80n, [transfer(OWNER, AGENT)]) : null)),
  };
}
async function evmOps(chain: ReturnType<typeof evmChain>, lib: Record<string, unknown> = {}) {
  const dir = newHome();
  vi.resetModules();
  vi.doMock("../budget/evm/lib.js", async (original) => ({
    ...(await original<object>()), OPS_DIR: dir, publicClient: chain, usdcBalance: async () => 10000n, allowanceOf: async () => 10000n, USDC: TOKEN,
    sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f(), ...lib,
  }));
  opened.push({ close: () => void vi.doUnmock("../budget/evm/lib.js") });
  return import(new URL("../budget/evm/ops.ts", import.meta.url).href);
}
/** `budget reconcile` on one journal: the RESULT line and exit code budget/evm/reconcile.ts prints for it. */
async function reconciled(at: string, ops: any, j: unknown): Promise<Seen> {
  const { j: after } = await ops.reconcileJournal(j, { quiet: true });
  const line: string = await ops.resultLine(after, "reconcile");
  return { at, surface: "budget", cmd: "budget/evm/reconcile.ts, in process", exit: ops.exitCodeFor(after.state, after.delivered), body: JSON.parse(line.slice(7)), text: line };
}

// ---- the table ----------------------------------------------------------------------------------------------------------

const UNCERTAIN_PAY = (exit = 5) => ({ exit, state: "uncertain", final: true, message: expect.stringMatching(/^The payment may or may not have settled: /) });

const ROWS: Row[] = [
  {
    path: "pay on Tempo: after the wallet was asked, the page's button and then the page's report of a wallet rejection",
    covers: ["route tempo-transfer /reject", "route tempo-transfer /state", "state uncertain", "command status"],
    run: async () => {
      const t = await tempoPay();
      await walletAsked(t);
      const button = await seenRoute("tempo-transfer", "the page's reject button", t.link, "/reject", {});
      const wallet = await seenRoute("tempo-transfer", "the page says the wallet rejected", t.link, "/reject", { by: "wallet" });
      const state = await seenRoute("tempo-transfer", "the page's state", t.link, "/state");
      await t.engine.waitForAttempt(t.id, 5_000);
      return [button, wallet, state, await status("status", t.home, t.id, t.env)];
    },
    expect: [
      { verdict: "unknown", match: { http: 409, error: "your wallet was asked to send this payment: reject it in your wallet, or check its activity" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", reason: expect.stringMatching(/cannot be checked against the wallet, so whether it was sent is unknown/) } },
      { verdict: "unknown", match: { http: 200, status: "unknown" } },
      { verdict: "unknown", match: { ...UNCERTAIN_PAY(), reason: expect.stringMatching(/cannot be checked against the wallet, so whether it was sent is unknown/) } },
    ],
  },
  {
    path: "pay on Tempo: the wallet is asked again and the page re-prepared after it was asked, then the page's process stops",
    covers: ["route tempo-transfer /sending", "route tempo-transfer /account", "state approved"],
    run: async () => {
      const t = await tempoPay();
      await walletAsked(t);
      const again = await seenRoute("tempo-transfer", "ask the wallet again", t.link, "/sending", { address: t.owner });
      const other = await seenRoute("tempo-transfer", "connect another account", t.link, "/account", { address: privateKeyToAccount(generatePrivateKey()).address });
      const open = await status("status while the wallet may be sending", t.home, t.id, t.env);
      await t.signer.close();
      await t.engine.waitForAttempt(t.id, 5_000);
      return [again, other, open, await status("status after the page stopped", t.home, t.id, t.env)];
    },
    expect: [
      { verdict: "unknown", match: { http: 409, error: "your wallet was already asked to send this payment; it is not asked again" } },
      { verdict: "unknown", match: { http: 409, error: "your wallet was already asked to send this payment; it is not prepared again" } },
      { verdict: "unknown", match: { exit: 0, state: "approved", final: false, message: expect.stringMatching(/whether it has sent it is not known yet/) } },
      { verdict: "unknown", match: { ...UNCERTAIN_PAY(), reason: expect.stringMatching(/the process serving the approval page stopped, and your wallet was asked to send this payment/) } },
    ],
  },
  {
    path: "pay on Tempo: the approval window ends after the wallet was asked",
    covers: [],
    run: async () => {
      const t = await tempoPay({ timeoutMs: 2_500 });
      await walletAsked(t);
      await new Promise((r) => setTimeout(r, 3_000));
      const state = await seenRoute("tempo-transfer", "the page's state after its window", t.link, "/state");
      await t.engine.waitForAttempt(t.id, 5_000);
      return [state, await status("status", t.home, t.id, t.env)];
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "unknown", reason: expect.stringMatching(/^the approval window ended, and your wallet was asked to send this payment/) } },
      { verdict: "unknown", match: { ...UNCERTAIN_PAY(), reason: expect.stringMatching(/^the approval window ended, and your wallet was asked to send this payment/) } },
    ],
  },
  {
    path: "pay on Tempo: the wallet's transaction is reported while the chain does not show it yet, then it lands",
    covers: ["route tempo-transfer /sent", "state submitting", "state settled"],
    run: async () => {
      const t = await tempoPay();
      const call = await walletAsked(t);
      const hash = t.chain.send(t.owner, call, { pending: true });
      const sent = await seenRoute("tempo-transfer", "the page reports the transaction", t.link, "/sent", { address: t.owner, hash });
      await until(() => t.engine.getAttempt(t.id)?.state === "submitting", "submitting");
      const checking = await status("status while the chain is read", t.home, t.id, t.env);
      t.chain.confirm(hash);
      await t.engine.waitForAttempt(t.id, 20_000);
      const landed = await status("status once it landed", t.home, t.id, t.env);
      const none = seenListing("receipts --limit 0", "receipts", await superstables(t.home, ["receipts", "--limit", "0"], t.env));
      return [sent, checking, landed, none];
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "signed" } },
      { verdict: "unknown", match: { exit: 0, state: "submitting", final: false, message: expect.stringMatching(/The client is checking that transfer on chain before it calls the service/) } },
      { verdict: "paid", match: { exit: 0, state: "settled", chain: "verified", message: expect.stringMatching(/^Paid 0\.01 pathUSD on Tempo Moderato/) } },
      { verdict: "paid", match: { exit: 0, text: "when  amount  service  outcome  chain  attempt  transaction\n----  ------  -------  -------  -----  -------  -----------\n" } },
    ],
    timeout: 60_000,
  },
  {
    path: "pay with x402: the seller asks for payment again after the credential, and the chain shows it settled",
    covers: ["state paid_service_failed"],
    run: async () => {
      const x = await x402Pay(async (chain, authorization) => {
        chain.settle(authorization());
        return new Response(JSON.stringify({ error: "payment required" }), { status: 402 });
      });
      expect(x.attempt.state).toBe("uncertain");
      return [await status("status reads the chain", x.home, x.attempt.id, x.env)];
    },
    expect: [{ verdict: "paid", match: { exit: 4, state: "paid_service_failed", chain: "verified" } }],
  },
  {
    path: "pay with x402: the seller says it did not settle; unknown while the authorization can be used, unpaid once the chain shows it never can",
    covers: ["state failed"],
    run: async () => {
      const x = await x402Pay(async () => new Response("{}", {
        status: 402,
        headers: { "payment-response": encodePaymentResponseHeader({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" } as Parameters<typeof encodePaymentResponseHeader>[0]) },
      }));
      const open = await status("status while the authorization is valid", x.home, x.attempt.id, x.env);
      x.chain.advance(300 + 180);
      return [open, await status("status after it expired unused", x.home, x.attempt.id, x.env)];
    },
    expect: [
      { verdict: "unknown", match: { ...UNCERTAIN_PAY(), chain_reason: expect.stringMatching(/^the chain shows the owner's authorization unused so far; it can still be used until /) } },
      { verdict: "pay-chain-unpaid", match: { exit: 1, state: "failed", chain: "unpaid", message: expect.stringMatching(/^Payment did not happen: the chain shows this payment was never made/) } },
    ],
  },
  {
    path: "superstables pay on Tempo, stopped by a signal after the wallet was asked",
    covers: ["command pay"],
    run: async () => {
      const p = await payProcessAsked();
      p.child.kill("SIGTERM");
      const code = await p.closed;
      return [seenPay("pay --json", "pay", { code, ...p.out() })];
    },
    expect: [{ verdict: "unknown", match: { ...UNCERTAIN_PAY(), reason: expect.stringMatching(/was stopped \(SIGTERM\) .* after the owner's wallet was asked to send the payment, so whether it was sent is unknown$/) } }],
    timeout: 90_000,
  },
  {
    path: "superstables pay on Tempo, killed after the wallet was asked: status, receipts and attempts",
    covers: ["command receipts", "command attempts"],
    run: async () => {
      const p = await payProcessAsked();
      p.child.kill("SIGKILL");
      await p.closed;
      const after = await status("status of the stopped payment", p.home, p.id, p.env);
      const receipts = seenListing("receipts", "receipts", await superstables(p.home, ["receipts"], p.env));
      const attempts = seenListing("attempts", "attempts", await superstables(p.home, ["attempts"], p.env));
      return [after, receipts, attempts];
    },
    expect: [
      { verdict: "unknown", match: { ...UNCERTAIN_PAY(), reason: "the process running this payment stopped after the owner's wallet was asked to send it, so whether it was sent is unknown" } },
      { verdict: "unknown", match: { exit: 0, text: expect.stringMatching(/^No receipt is recorded on this machine, but 1 attempt may have paid: [0-9a-f-]+ \(uncertain\)\. Whether it settled is unknown\. Do not pay again/) } },
      { verdict: "unknown", match: { exit: 0, text: expect.stringMatching(/ uncertain /) } },
    ],
    timeout: 90_000,
  },
  {
    path: "budget grant on superstables.com, detached: the site reports the owner's wallet was asked, then that it cannot tell",
    covers: ["budget wait"],
    run: async () => {
      const b = await hostedBudget();
      const first = await budget(b.home, ["grant", "--rail", "evm", "--amount", "0.01"], b.env);
      expect(resultOf(first.stdout)).toMatchObject({ state: "waiting_owner" });
      const id = resultOf(first.stdout).id as string;
      Object.assign(b.site.requests[0], { state: "sending", wallet_asked: true });
      await loggedAsked(b.home, b.site.requests[0].id);
      const plain = seenBudget("wait without --shown", "wait", await budget(b.home, ["wait", "--id", id, "--timeout", "0"], b.env));
      const shown = seenBudget("wait --shown", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "0"], b.env));
      Object.assign(b.site.requests[0], { state: "unknown", reason: "the wallet was asked and never answered" });
      const done = seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "60"], b.env));
      return [plain, shown, done];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: false, next: expect.stringMatching(/^the owner's wallet was asked to send, and whether it sent is not known yet/) } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: false, reason: "the owner's wallet was asked to send; no transaction is reported yet" } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, next: expect.stringMatching(/read whether it landed before running this again/) } },
    ],
    timeout: 120_000,
  },
  {
    path: "budget setup on this machine, detached: the page log records the owner's sign-in, which asks the wallet to send nothing",
    covers: [],
    run: async () => {
      const b = await hostedBudget();
      rmSync(join(b.home, "budget", "public", "evm-base-sepolia.env"));
      const first = resultOf((await budget(b.home, ["setup", "--rail", "evm", "--no-open", "--timeout", "10"], b.env)).stdout);
      expect(first).toMatchObject({ command: "setup", state: "waiting_owner" });
      const page = /\/owner\/([0-9a-f]{32})/.exec(first.url)![1];
      writeFileSync(join(b.home, "budget", "owner-approvals.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), id: page, kind: "connect", title: "connect", status: "confirmed" })}\n`, { flag: "a" });
      const plain = seenBudget("wait without --shown", "wait", await budget(b.home, ["wait", "--id", first.id, "--timeout", "0"], b.env));
      const shown = seenBudget("wait --shown", "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "0"], b.env));
      const ended = seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "40"], b.env));
      return [plain, shown, ended];
    },
    expect: [
      { verdict: "unknown", match: { exit: 2, command: "wait", state: "show_owner_first" } },
      { verdict: "before", match: { exit: 0, command: "setup", state: "waiting_owner", final: false } },
      { verdict: "before", match: { exit: 3, command: "setup", state: "refused_precheck", final: true, reason: expect.stringMatching(/expired/) } },
    ],
    timeout: 90_000,
  },
  {
    path: "budget setup on superstables.com with gas and a budget, detached: the gas step's wallet was asked",
    covers: ["budget setup"],
    run: async () => {
      const b = await hostedBudget();
      const first = await budget(b.home, ["setup", "--rail", "evm", "--hosted", "--site", b.site.url, "--grant", "0.01", "--fund"], b.env);
      const id = resultOf(first.stdout).id as string;
      const r = b.site.requests[0];
      Object.assign(r, { state: "linked", owner: OWNER });
      Object.assign(r.steps![0], { state: "sending", wallet_asked: true });
      const shown = seenBudget("wait --shown", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "0"], b.env));
      Object.assign(r.steps![0], { state: "unknown" });
      Object.assign(r.steps![1], { state: "unknown", wallet_asked: true });
      const done = seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "90"], b.env));
      return [shown, done];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "setup", state: "unknown", final: false } },
      { verdict: "unknown", match: { exit: 5, command: "setup", state: "unknown", final: true, linked: true, steps: [{ kind: "fund_agent", state: "unknown" }, { kind: "grant", state: "unknown" }] } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget grant, fund-agent and revoke on superstables.com, waiting: the site cannot tell whether the wallet sent",
    covers: ["budget grant", "budget fund-agent", "budget revoke"],
    run: async () => {
      let granted = 0n;
      const b = await hostedBudget((method, params) => allowance(granted)(method, params));
      b.site.onPoll = (r) => {
        if (r.polls >= 2) Object.assign(r, { state: "unknown", wallet_asked: true, reason: "the wallet was asked and never answered" });
      };
      const grant = seenBudget("grant --wait", "grant", await budget(b.home, ["grant", "--rail", "evm", "--amount", "0.01", "--wait", "--no-open"], b.env));
      const fund = seenBudget("fund-agent --wait", "fund-agent", await budget(b.home, ["fund-agent", "--rail", "evm", "--wait", "--no-open"], b.env));
      granted = 10000n;
      const revoke = seenBudget("revoke --wait", "revoke", await budget(b.home, ["revoke", "--rail", "evm", "--wait", "--no-open"], b.env));
      return [grant, fund, revoke];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } },
      { verdict: "unknown", match: { exit: 5, command: "fund-agent", state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } },
      { verdict: "unknown", match: { exit: 5, command: "revoke", state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } },
    ],
    timeout: 120_000,
  },
  {
    path: "budget fund-agent on superstables.com: the owner's wallet sent the agent another amount than planned",
    covers: [],
    run: async () => {
      const FUND: Hex = `0x${"c2".repeat(32)}`;
      const blockHash = `0x${"ef".repeat(32)}`;
      const sent = 2n * 10n ** 14n;
      const b = await hostedBudget((method, params) => {
        if (method === "eth_blockNumber") return "0x64";
        if (params[0] !== FUND) return undefined;
        if (method === "eth_getTransactionByHash") return { hash: FUND, blockHash, blockNumber: "0x65", from: OWNER, to: AGENT, input: "0x", value: `0x${sent.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
        if (method === "eth_getTransactionReceipt") return { transactionHash: FUND, blockHash, blockNumber: "0x65", from: OWNER, to: AGENT, status: "0x1", logs: [], gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
        return undefined;
      });
      b.site.onPoll = (r) => {
        if (r.polls >= 2) Object.assign(r, { state: "sent", tx_hash: FUND, wallet_asked: true });
      };
      return [seenBudget("fund-agent --wait", "fund-agent", await budget(b.home, ["fund-agent", "--rail", "evm", "--wait", "--no-open"], b.env))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "fund-agent", state: "unknown", tx: { fundAgent: `0x${"c2".repeat(32)}` }, reason: expect.stringMatching(/value/) } }],
    timeout: 90_000,
  },
  {
    path: "owner approval page, evm transaction: after the wallet was asked, a connect and an ask again, a cancel, a rejection, and the end of the link",
    covers: ["route owner:evm-transaction /account", "route owner:evm-transaction /sending", "route owner:evm-transaction /cancel", "route owner:evm-transaction /reject", "route owner:evm-transaction /state"],
    run: async () => {
      const server = await ownerServer(200);
      const a = server.request(ownerTransfer(10_000));
      await ownerAsked(a.url);
      const connect = await seenRoute("owner:evm-transaction", "connect again", a.url, "/account", { address: OWNER });
      const again = await seenRoute("owner:evm-transaction", "ask the wallet again", a.url, "/sending", { address: OWNER });
      const cancel = await seenRoute("owner:evm-transaction", "the command asks to cancel", a.url, "/cancel", {});
      const reject = await seenRoute("owner:evm-transaction", "the page's reject button", a.url, "/reject", { by: "page" });
      const rejected = await seenRoute("owner:evm-transaction", "the page's state after the rejection", a.url, "/state");
      const b = server.request(ownerTransfer(300));
      await ownerAsked(b.url);
      await new Promise((r) => setTimeout(r, 800));
      return [connect, again, cancel, reject, rejected, await seenRoute("owner:evm-transaction", "the page's state after its link ended", b.url, "/state")];
    },
    expect: [
      { verdict: "unknown", match: { http: 409, error: "this is already sending" } },
      { verdict: "unknown", match: { http: 409, error: "connect the owner account first" } },
      { verdict: "unknown", match: { http: 409, cancelled: false, status: "sending", sending: true } },
      { verdict: "unknown", match: { http: 200, status: "unknown", reason: "a rejection was reported after the wallet was asked to send; the page cannot prove nothing was submitted, so the chain must be checked" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, reason: "the wallet was asked to send, but no transaction came back to this page" } },
    ],
  },
  {
    path: "budget fund-agent on this machine: the owner's wallet reported a transfer the chain shows, but the agent's balance does not",
    covers: ["route owner:evm-transaction /sent"],
    run: async () => {
      const FUND: Hex = `0x${"c4".repeat(32)}`;
      const blockHash = `0x${"ef".repeat(32)}`;
      const b = await hostedBudget((method, params) => {
        if (method === "eth_blockNumber") return "0x64";
        if (params[0] !== FUND) return undefined;
        if (method === "eth_getTransactionByHash") return { hash: FUND, blockHash, blockNumber: "0x65", from: OWNER, to: AGENT, input: "0x", value: "0x5af3107a4000", gas: "0x5208", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
        if (method === "eth_getTransactionReceipt") return { transactionHash: FUND, blockHash, blockNumber: "0x65", from: OWNER, to: AGENT, status: "0x1", logs: [], gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
        return undefined;
      });
      writeFileSync(join(b.home, "budget", "public", "evm-base-sepolia.env"), `B4_OWNER_ADDRESS=${OWNER}\nB4_AGENT_ADDRESS=${AGENT}\n`);
      const first = resultOf((await budget(b.home, ["fund-agent", "--rail", "evm", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "fund-agent", state: "waiting_owner" });
      await ownerAsked(first.url);
      const sent = await seenRoute("owner:evm-transaction", "the page reports the transaction", first.url, "/sent", { address: OWNER, hash: FUND });
      const verdict = await until(async () => {
        const st = await seenRoute("owner:evm-transaction", "the page's state once the command read the chain", first.url, "/state");
        return st.body.status !== "sent" && st;
      }, "the command's verdict on the page", 60_000);
      const done = seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "90"], b.env));
      return [sent, verdict, done];
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"c4".repeat(32)}`, message: "The command could not confirm this transfer on chain yet. Check your wallet's activity." } },
      { verdict: "unknown", match: { exit: 5, command: "fund-agent", state: "unknown", final: true, reason: expect.stringMatching(/^the transaction is on chain, but the agent's balance reads/) } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget fund-agent on this machine: the owner's wallet sent the agent another amount than planned",
    covers: [],
    run: async () => {
      const FUND: Hex = `0x${"c6".repeat(32)}`;
      const b = await ownerOnThisMachine({ [FUND]: { to: AGENT, input: "0x", value: 2n * 10n ** 14n, logs: [] } });
      const first = resultOf((await budget(b.home, ["fund-agent", "--rail", "evm", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "fund-agent", state: "waiting_owner" });
      return ownerPageSent(b, first, FUND);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"c6".repeat(32)}`, message: expect.stringMatching(/^The transfer was not confirmed as the planned step: it sent a value of 200000000000000, not 100000000000000\.$/) } },
      { verdict: "unknown", match: { exit: 5, command: "fund-agent", state: "unknown", final: true, reason: expect.stringMatching(/it sent a value of 200000000000000, not 100000000000000$/) } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget grant on this machine: the owner's wallet approved another spender than the agent",
    covers: [],
    run: async () => {
      const GRANT: Hex = `0x${"c8".repeat(32)}`;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [SPENDER, 10n ** 6n] });
      const b = await ownerOnThisMachine({ [GRANT]: { to: BASE_USDC, input, value: 0n, logs: [approval(OWNER, SPENDER, 10n ** 6n, GRANT)] } });
      const first = resultOf((await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "grant", state: "waiting_owner" });
      return ownerPageSent(b, first, GRANT);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"c8".repeat(32)}`, message: expect.stringMatching(/^The transaction was not accepted as the planned step \(the wallet changed the transaction data.* superstables budget revoke cannot end this approval\. Send from your wallet: approve\(0x5555555555555555555555555555555555555555, 0\) on token 0x036CbD53842c5426634e7929541eC2318f3dCF7e, which this transaction approved for 1 USDC\.$/) } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, tx: { grant: `0x${"c8".repeat(32)}` }, next: "superstables budget revoke --rail evm cannot end this: it sets only the agent's USDC allowance to 0. The owner sends from their own wallet, by hand: approve(0x5555555555555555555555555555555555555555, 0) on token 0x036CbD53842c5426634e7929541eC2318f3dCF7e, which this transaction approved for 1 USDC. Grant again only if the owner asks" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget grant on this machine: the owner's wallet sent the planned approval, and the allowance then reads another amount",
    covers: [],
    run: async () => {
      const GRANT: Hex = `0x${"ca".repeat(32)}`;
      let mined = false;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 10n ** 6n] });
      const b = await ownerOnThisMachine({ [GRANT]: { to: BASE_USDC, input, value: 0n, logs: [approval(OWNER, AGENT, 10n ** 6n, GRANT)] } }, (method, params) => {
        if (method === "eth_getTransactionReceipt" && params[0] === GRANT) mined = true;
        return mined ? allowance(2n * 10n ** 6n)(method, params) : undefined;
      });
      const first = resultOf((await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "grant", state: "waiting_owner" });
      return ownerPageSent(b, first, GRANT);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"ca".repeat(32)}`, message: "The chain now shows an allowance of 2 USDC, not 1 USDC. The budget was not recorded. Revoke it: superstables budget revoke --rail evm. You approve that in your wallet too." } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, next: "revoke (superstables budget revoke --rail evm) to bring the allowance to 0, then grant again" } },
    ],
    timeout: 150_000,
  },
  {
    path: "owner approval page, solana transaction: the send answers with an error after the transaction left this machine; then every route again",
    covers: ["route owner:solana-transaction /prepare", "route owner:solana-transaction /signed", "route owner:solana-transaction /state", "route owner:solana-transaction /account", "route owner:solana-transaction /reject", "route owner:solana-transaction /cancel"],
    run: async () => {
      const owner = Keypair.generate();
      const agent = Keypair.generate().publicKey;
      const errors = [
        new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "Transaction simulation failed: Blockhash not found", logs: [] }),
        Object.assign(new Error("Transaction simulation failed: Blockhash not found"), { name: "SendTransactionError" }),
        new Error("fetch failed"),
      ];
      const server = await ownerServer();
      const seen: Seen[] = [];
      for (const [i, error] of errors.entries()) {
        const conn = {
          getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
          getBlockHeight: async () => 10,
          sendRawTransaction: async () => { throw error; },
        } as unknown as Connection;
        const { transactionPort } = await import(new URL("../budget/solana/owner.ts", import.meta.url).href);
        const { port } = transactionPort(conn, owner.publicKey, () => [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: agent, lamports: 10_000_000 })], () => {});
        const handle = server.request({ ...ownerTransfer(10_000), kind: "solana-transaction", chain: { family: "solana", chainId: 0, chainName: "Solana devnet", rpcUrl: "http://127.0.0.1:1", explorer: "https://explorer.solana.com", explorerQuery: "?cluster=devnet", walletChain: "solana:devnet", nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 }, testnet: true }, account: owner.publicKey.toBase58(), transaction: undefined, solana: port });
        expect((await seenRoute("owner:solana-transaction", "connect", handle.url, "/account", { address: owner.publicKey.toBase58() })).http).toBe(200);
        const prepared = await seenRoute("owner:solana-transaction", "prepare", handle.url, "/prepare", { address: owner.publicKey.toBase58() });
        const tx = Transaction.from(Buffer.from(prepared.body.transaction, "base64"));
        tx.sign(owner);
        seen.push(await seenRoute("owner:solana-transaction", `the signed transaction is sent (${["the RPC's own error", "an error named as the RPC's", "a transport error"][i]})`, handle.url, "/signed", { address: owner.publicKey.toBase58(), signedTransaction: tx.serialize().toString("base64") }));
        seen.push(await seenRoute("owner:solana-transaction", "the page's state after it", handle.url, "/state"));
        if (i < errors.length - 1) continue;
        const address = owner.publicKey.toBase58();
        seen.push(await seenRoute("owner:solana-transaction", "connect again", handle.url, "/account", { address }));
        seen.push(await seenRoute("owner:solana-transaction", "prepare again", handle.url, "/prepare", { address }));
        seen.push(await seenRoute("owner:solana-transaction", "the page's reject button", handle.url, "/reject", { by: "page" }));
        seen.push(await seenRoute("owner:solana-transaction", "the command asks to cancel", handle.url, "/cancel", {}));
      }
      return seen;
    },
    expect: [
      ...[0, 1, 2].flatMap(() => [
        { verdict: "unknown" as const, match: { http: 200, status: "sent", hash: expect.any(String) } },
        { verdict: "unknown" as const, match: { http: 200, status: "sent", sending: true } },
      ]),
      { verdict: "unknown", match: { http: 409, error: "this is already sent" } },
      { verdict: "unknown", match: { http: 409, error: "this is sent; it takes no transaction now" } },
      { verdict: "unknown", match: { http: 409, error: "this is already sent", status: "sent" } },
      { verdict: "unknown", match: { http: 409, cancelled: false, status: "sent", sending: true } },
    ],
  },
  {
    path: "budget recover: its gas step on the owner's page ended while the wallet may be sending (budget/evm/owner.ts, as recover runs it)",
    covers: ["budget recover"],
    run: async () => {
      vi.resetModules();
      vi.doMock("../budget/evm/lib.js", async (original) => ({ ...(await original<object>()), sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f(), readUntil: async <T,>(read: () => Promise<T>) => read() }));
      vi.doMock("../budget/owner-page.js", async (original) => {
        const real = (await original()) as { ownerPageFor: (r: unknown) => Record<string, unknown> };
        const outcome = { status: "expired", reason: "the approval link expired", sending: true };
        return { ...real, closeOwnerPage: async () => {}, ownerPageFor: (r: unknown) => ({ ...real.ownerPageFor(r), askTransaction: async () => ({ handle: { finish: () => {} }, outcome }) }) };
      });
      opened.push({ close: () => { vi.doUnmock("../budget/evm/lib.js"); vi.doUnmock("../budget/owner-page.js"); } });
      const owner = await import(new URL("../budget/evm/owner.ts", import.meta.url).href);
      const lib = await import(new URL("../budget/evm/lib.ts", import.meta.url).href);
      Object.assign(lib.publicClient, { getBlockNumber: async () => 100n, getBalance: async () => 10n ** 18n, readContract: async () => 0n, getLogs: async () => [] });
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void lines.push(String(s)));
      const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw Object.assign(new Error("exit"), { code }); }) as never);
      let code: number | undefined;
      try {
        await owner.fundInWallet("recover", OWNER, AGENT, 10n ** 15n, "0.001", 0n, { result: { ownerRevokeTx: `0x${"ab".repeat(32)}`, allowanceAfterRevoke: "0" }, done: "the allowance read 0 after the owner's revoke", stepTx: "gasTx" });
      } catch (e) {
        code = (e as { code?: number }).code;
        if (code === undefined) throw e;
      } finally {
        log.mockRestore();
        exit.mockRestore();
      }
      return [{ at: "recover's gas step", surface: "budget", cmd: "budget recover", exit: code, body: resultOf(lines.join("\n")), text: lines.join("\n") }];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } }],
  },
  {
    path: "budget buy-once on superstables.com: the owner signed and the payment is being submitted",
    covers: ["budget buy-once"],
    run: async () => {
      const home = newHome();
      const site = await startFakePurchaseSite();
      opened.push(site);
      const env = { B4_RPC: site.chainUrl, SUPERSTABLES_TEMPO_RPC: site.chainUrl, SUPERSTABLES_SOLANA_RPC: site.chainUrl };
      const buyOnce = () => budget(home, ["buy-once", "--site", site.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01"], env);
      const first = resultOf((await buyOnce()).stdout);
      expect(first).toMatchObject({ state: "waiting_owner" });
      site.readAnswer = (p) => ({ status: 200, body: { id: p.id, state: "submitting", final: false, payment: { status: "submitting" }, delivery: { status: "pending" } } });
      // nothing on this machine has read the site since the owner signed: this wait cannot know, and must not say
      const unread = seenBudget("wait without --shown, before any read", "wait", await budget(home, ["wait", "--id", first.id, "--timeout", "0"], env));
      const shown = seenBudget("wait --shown", "wait", await budget(home, ["wait", "--shown", "--id", first.id, "--timeout", "0"], env));
      const plain = seenBudget("wait without --shown", "wait", await budget(home, ["wait", "--id", first.id, "--timeout", "0"], env));
      const next = seenBudget("the next buy-once", "buy-once", await buyOnce());
      return [unread, shown, plain, next];
    },
    expect: [
      { verdict: "unknown", match: { exit: 2, command: "wait", state: "show_owner_first", id: expect.any(String), reason: "wait was run without --shown: nothing was polled" } },
      { verdict: "unknown", match: { exit: 5, command: "buy-once", state: "unknown", final: false, paid: null, amount: null, reason: "the owner signed and the payment is being submitted; payment is not yet confirmed" } },
      { verdict: "unknown", match: { exit: 5, command: "buy-once", state: "unknown", final: false, paid: null, amount: null } },
      { verdict: "unknown", match: { exit: 3, state: "refused_pending", paid: null, pending: { state: "unknown" } } },
    ],
    timeout: 90_000,
  },
  {
    path: "budget buy-once --replace on superstables.com: the site answers the cancel with the payment being submitted",
    covers: [],
    run: async () => {
      const home = newHome();
      const site = await startFakePurchaseSite();
      opened.push(site);
      const env = { B4_RPC: site.chainUrl, SUPERSTABLES_TEMPO_RPC: site.chainUrl, SUPERSTABLES_SOLANA_RPC: site.chainUrl };
      const buyOnce = (...extra: string[]) => budget(home, ["buy-once", "--site", site.url, "--service", "demo-market-data", "--param", "asset=BTC", "--max", "0.01", ...extra], env);
      const first = resultOf((await buyOnce()).stdout);
      expect(first).toMatchObject({ state: "waiting_owner" });
      site.cancelAnswer = (p) => ({ status: 200, body: { id: p.id, state: "submitting", final: false, payment: { status: "submitting" }, delivery: { status: "pending" } } });
      return [seenBudget("buy-once --replace", "buy-once", await buyOnce("--replace"))];
    },
    expect: [{ verdict: "unknown", match: { exit: 3, state: "refused_pending", paid: null, amount: null, pending: { state: "unknown" } } }],
  },
  {
    path: "budget buy with the --op of a purchase whose outcome is unknown",
    covers: ["budget buy"],
    run: async () => {
      const b = await hostedBudget();
      const op = "rb-20261010120000-ab12";
      mkdirSync(join(b.home, "budget", "ops", "evm-base-sepolia"), { recursive: true });
      writeFileSync(join(b.home, "budget", "ops", "evm-base-sepolia", `${op}.json`), JSON.stringify({ ...purchase(op), state: "unknown" }));
      return [seenBudget("buy again", "buy", await budget(b.home, ["buy", "--rail", "evm", "--url", "https://seller.example/x", "--max", "0.01", "--op", op], b.env))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "buy", op: "rb-20261010120000-ab12", state: "unknown", paid: null, amount: null, reason: "op_already_unknown", next: expect.stringMatching(/^superstables budget reconcile --rail evm --chain base-sepolia --op rb-20261010120000-ab12/) } }],
  },
  {
    path: "budget buy with the --op of a purchase whose outcome is unknown, without its agent key or with an unsafe key file; and with an op another buy holds before it wrote a journal",
    covers: [],
    run: async () => {
      const b = await hostedBudget();
      const op = "rb-20261010120000-cd34";
      const dir = join(b.home, "budget", "ops", "evm-base-sepolia");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${op}.json`), JSON.stringify({ ...purchase(op), state: "unknown" }));
      const buyAgain = () => budget(b.home, ["buy", "--rail", "evm", "--url", "https://seller.example/x", "--max", "0.01", "--op", op], b.env);
      const keyFile = join(b.home, "keys", "budget", "evm-agent.env");
      const key = readFileSync(keyFile, "utf8");
      chmodSync(keyFile, 0o644);
      const unsafe = seenBudget("the agent key file is readable by others", "buy", await buyAgain());
      rmSync(keyFile);
      const gone = seenBudget("the agent key is gone", "buy", await buyAgain());
      writeFileSync(keyFile, key, { mode: 0o600 });
      const guard = await import("../budget/buy-guard.mjs");
      const held = "rb-20261010120000-ef56";
      const lock = guard.lockOp(dir, held);
      expect(lock.ok).toBe(true);
      try {
        const busy = await budget(b.home, ["buy", "--rail", "evm", "--url", "https://seller.example/x", "--max", "0.01", "--op", held], b.env);
        return [unsafe, gone, seenBudget("another process holds the op", "buy", busy)];
      } finally {
        if (lock.ok) lock.release();
      }
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "buy", op: "rb-20261010120000-cd34", state: "unknown", paid: null, amount: null, reason: "op_already_unknown", next: expect.stringMatching(/^superstables budget reconcile --rail evm --chain base-sepolia --op rb-20261010120000-cd34/) } },
      { verdict: "unknown", match: { exit: 5, command: "buy", state: "unknown", paid: null, amount: null, reason: "op_already_unknown" } },
      { verdict: "unknown", match: { exit: 5, command: "buy", state: "unknown", paid: null, amount: null, reason: "op_in_progress", next: expect.stringMatching(/Another process \(buy or reconcile\) may be working on this op; wait for its RESULT, then superstables budget reconcile .* Never pay again for this op while its outcome is unknown$/) } },
    ],
  },
  {
    path: "budget reconcile through the dispatcher, evm: the pull landed and can no longer settle; unknown until the price is back with the owner",
    covers: ["budget reconcile"],
    run: async () => {
      const pull = rpcReceipt(PULL, 80n, [rpcTransfer(OWNER, AGENT, 10000n, PULL, 80n)]);
      const stranded = (await reconcileCli("not returned", { [PULL]: pull }, purchase("pull-landed-cli"))).seen;
      const back = rpcReceipt(RETURN, 85n, [rpcTransfer(AGENT, OWNER, 10000n, RETURN, 85n)]);
      const returned = (await reconcileCli("returned", { [PULL]: pull, [RETURN]: back }, { ...purchase("pull-returned-cli"), returnTx: RETURN })).seen;
      return [stranded, returned];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "reconcile", state: "unknown", paid: null, amount: null, tx: { pull: PULL }, reason: expect.stringMatching(/the payment authorization is expired on chain .*; the price 0\.01 USDC pulled from the owner has not been returned$/), next: expect.stringMatching(/superstables budget recover --rail evm/) } },
      { verdict: "evm-funds-returned", match: { exit: 1, command: "reconcile", state: "failed", paid: false, amount: "0", tx: { pull: PULL, return: RETURN } } },
    ],
  },
  {
    path: "budget recover, evm: an earlier return gave back part of the price; recover returns the rest (budget/evm/ops.ts makeSafe, as recover runs it)",
    covers: [],
    run: async () => {
      const REST: Hex = `0x${"15".repeat(32)}`;
      const chain = evmChain();
      let held = 6000n;
      chain.getTransactionReceipt.mockImplementation(async ({ hash }) =>
        hash === PULL ? mined(PULL, 80n, [transfer(OWNER, AGENT)]) : hash === RETURN ? mined(RETURN, 85n, [transfer(AGENT, OWNER, 4000n)]) : hash === REST ? mined(REST, 86n, [transfer(AGENT, OWNER, 6000n)]) : null);
      const sendJournaled = vi.fn(async (_w: unknown, _to: unknown, _data: unknown, _label: string, before: (s: { hash: Hex; nonce: number }) => void) => {
        before({ hash: REST, nonce: 9 });
        held = 0n;
        return { hash: REST, feeWei: 1n };
      });
      const ops = await evmOps(chain, { usdcBalance: async () => held, sendJournaled });
      const partial = await reconciled("part of the price returned", ops, { ...purchase("pull-partly-returned"), returnTx: RETURN });
      const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
      await ops.makeSafe(ops.readJournal("pull-partly-returned"), { account, client: {} }, { log: () => {} });
      expect(sendJournaled).toHaveBeenCalledTimes(1);
      return [partial, await reconciled("the rest returned by recover", ops, ops.readJournal("pull-partly-returned"))];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, state: "unknown", paid: null, returned: "0.004", reason: expect.stringMatching(/the price 0\.01 USDC pulled from the owner has not been returned$/), next: expect.stringMatching(/superstables budget recover --rail evm/) } },
      { verdict: "evm-funds-returned", match: { exit: 1, state: "failed", paid: false, debit: "0", returned: "0.01", tx: { pull: PULL, return: `0x${"15".repeat(32)}` } } },
    ],
  },
  {
    path: "budget reconcile through the dispatcher, evm: the pull reverted; unknown until that block is final",
    covers: [],
    run: async () => {
      const recent = (await reconcileCli("reverted, not final", { [PULL]: rpcReceipt(PULL, 100n, [], "0x0") }, purchase("pull-reverted-cli"))).seen;
      const final = (await reconcileCli("reverted, final", { [PULL]: rpcReceipt(PULL, 80n, [], "0x0") }, purchase("pull-reverted-final-cli"))).seen;
      return [recent, final];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "reconcile", state: "unknown", paid: null, amount: null, reason: "the pull landed and failed, but is not final on chain yet" } },
      { verdict: "evm-pull-reverted", match: { exit: 1, command: "reconcile", state: "failed", paid: false, tx: { pull: PULL } } },
    ],
  },
  {
    path: "budget reconcile, evm: the pull is not on chain; unknown while its receipt cannot be read, not found once a different final transaction took its nonce",
    covers: [],
    run: async () => {
      const replacement: Hex = `0x${"12".repeat(32)}`;
      const chain = evmChain();
      chain.getTransactionReceipt.mockRejectedValue(new Error("RPC unavailable"));
      const ops = await evmOps(chain);
      const unread = await reconciled("the receipt cannot be read", ops, purchase("pull-replaced"));
      chain.getTransactionReceipt.mockImplementation(async ({ hash }) => (hash === PULL ? null : { ...mined(replacement, 80n, []) }));
      chain.getTransaction.mockImplementation(async ({ hash }: any) => (hash === replacement ? { from: AGENT, nonce: 7, hash: replacement } : null));
      chain.getLogs.mockResolvedValue([{ address: TOKEN, topics: encodeEventTopics({ abi: erc20, eventName: "AuthorizationUsed", args: { authorizer: AGENT, nonce: NONCE } }), data: "0x", transactionHash: replacement, blockNumber: 80n, blockHash: BLOCK_HASH, removed: false }]);
      chain.getBlock.mockImplementation(async ({ blockNumber, includeTransactions }: any) => ({ number: blockNumber ?? 110n, timestamp: 2000n, hash: BLOCK_HASH, transactions: includeTransactions ? [{ from: AGENT, nonce: 7, hash: replacement }] : [] }));
      return [unread, await reconciled("a different final transaction", ops, { ...ops.readJournal("pull-replaced"), pullBlock: undefined })];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, state: "unknown", paid: null } },
      { verdict: "evm-nonce-replaced", match: { exit: 1, state: "not_found", paid: false } },
    ],
  },
];

/**
 * What the code declares that no row drives, each with the reason it never answers after the boundary. Every key is written
 * out: a new route, state or command fails the coverage test until it has a row or a line here.
 */
const SIGNS_ONLY = "the wallet signs and nothing leaves this machine until the payment engine accepts the signature, after this page has closed the approval as signed; every later answer here is 'already signed', and the engine's outcome is what pay and status print (rows: pay with x402)";
const SIGN_IN = "a sign-in: the wallet signs a message, never a transaction, so no answer on this link is about a payment";
const NOT_THIS_KIND = "answers 404 for this kind of owner action, before reading anything; it states no outcome";
const NO_ANSWER_AFTER_BOUNDARY: Record<string, string> = {
  ...Object.fromEntries(["/account", "/signature", "/state", "/reject"].map((r) => [`route eip3009 ${r}`, SIGNS_ONLY])),
  ...Object.fromEntries(["/account", "/prepare", "/signed", "/state", "/reject"].map((r) => [`route solana-transaction ${r}`, SIGNS_ONLY])),
  ...Object.fromEntries(["/state", "/account", "/connect", "/sending", "/sent", "/prepare", "/signed", "/reject", "/cancel"].map((r) => [`route owner:connect ${r}`, SIGN_IN])),
  ...Object.fromEntries(["/connect", "/prepare", "/signed"].map((r) => [`route owner:evm-transaction ${r}`, NOT_THIS_KIND])),
  ...Object.fromEntries(["/connect", "/sending", "/sent"].map((r) => [`route owner:solana-transaction ${r}`, NOT_THIS_KIND])),
  "state awaiting_approval": "the state before the boundary: an attempt leaves it for approved when the wallet is asked to send (Tempo) or its signature is accepted (x402), and nothing moves it back",
  "state denied": "a refusal from the signer after approved ends the attempt uncertain (pay.ts sentMaybe); denied is reached only before",
  "state expired": "the same: an expired approval after the wallet was asked ends uncertain (row: the approval window ends)",
  "state abandoned": "stop() and a stopped process end an approved or submitting attempt uncertain; abandoned only ends one still awaiting approval",
  "command setup": "creates the home directory and policy file; no payment",
  "command wallet": "the local wallet process: it signs for pay, whose answers the pay rows check",
  "command find": "searches listings; no payment",
  "command quote": "asks a seller its price; nothing is signed or paid",
  "command demo-service": "a seller on this machine; it reports no payment of the client's",
  "command doctor": "checks what pay needs; no payment",
  "command policy": "the spend policy file; no payment",
  "command budget": "a group: each of its commands is listed as budget <command>",
  "budget doctor": "keys, addresses, RPC and balances; no payment outcome",
  "budget status": "the budget's allowance, expiry and revocation; no purchase outcome",
  "budget preflight": "reads a seller's price; signs nothing",
  "budget find": "lists services; no payment",
  "budget unlock": "clears locks after the owner stopped every process; it reports lock state only, and its next for an operation is reconcile",
};

/** A commander "Commands:" section's names, as scripts/cli-docs.mjs reads them. */
function commandsOf(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => /^Commands:$/.test(l));
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    const m = /^ {2}(\S+)/.exec(line);
    if (m && m[1] !== "help") names.push(m[1]);
  }
  return names;
}
/**
 * The commands budget/cli.mjs dispatches: the keys of its HANDLERS table, read from the file. Importing it would run the
 * CLI (it parses process.argv at the top level), so its text is read, as scripts/budget-build.mjs reads it.
 */
function budgetHandlers(): string[] {
  const line = /^const HANDLERS = \{ (.+) \};$/m.exec(readFileSync(BUDGET, "utf8"))?.[1];
  if (!line) throw new Error("budget/cli.mjs has no one-line HANDLERS table to read");
  return line.split(", ").map((entry) => entry.split(":")[0].replace(/"/g, "").trim());
}

/** Each row's own runs check it drove what it covers: the route answered, the state was printed, the command ran. */
function assertCovered(row: Row, seen: Seen[]): void {
  for (const key of row.covers) {
    const [kind, name, route] = key.split(" ");
    if (kind === "route") expect(seen.some((s) => s.step === name && s.route === route), key).toBe(true);
    if (kind === "state") expect(seen.some((s) => s.surface === "pay" && s.body.state === name), key).toBe(true);
    if (kind === "command") expect(seen.some((s) => s.cmd === `superstables ${name}`), key).toBe(true);
    // wait prints the owner command's own RESULT, which names that command
    if (kind === "budget") expect(seen.some((s) => s.cmd === `budget ${name}` || (s.surface === "budget" && s.body?.command === name)), key).toBe(true);
  }
}

describe("once money may have moved, every answer says unknown or uncertain", () => {
  for (const row of ROWS) {
    it(row.path, async () => {
      const seen = await row.run();
      expect(seen.map((s) => s.at), "one expectation per output").toHaveLength(row.expect.length);
      seen.forEach((s, i) => assertProperty(s, row.expect[i]));
      assertCovered(row, seen);
    }, row.timeout ?? 60_000);
  }

  it("covers every wallet route, attempt state and command the code declares", async () => {
    const main = commandsOf((await superstables(newHome(), ["--help"])).stdout);
    const budgetCommands = budgetHandlers();
    expect(main).toEqual(expect.arrayContaining(["pay", "status", "receipts", "attempts", "budget"]));
    expect(budgetCommands).toEqual(expect.arrayContaining(["setup", "grant", "buy", "reconcile", "wait", "buy-once"]));
    const declared = [
      ...STEPS.flatMap((s) => [...s.routes, "/state", "/reject"].map((r) => `route ${s.kind} ${r}`)),
      ...OWNER_ACTION_KINDS.flatMap((k) => OWNER_ROUTES.map((r) => `route owner:${k} ${r}`)),
      ...ATTEMPT_STATES.map((s) => `state ${s}`),
      ...main.map((c) => `command ${c}`),
      ...budgetCommands.map((c) => `budget ${c}`),
    ];
    expect(declared).toEqual(expect.arrayContaining(["route tempo-transfer /sending", "route owner:evm-transaction /sending"]));
    const covered = new Set(ROWS.flatMap((r) => r.covers));
    expect(declared.filter((k) => !covered.has(k) && !(k in NO_ANSWER_AFTER_BOUNDARY)), "declared, with no row and no reason").toEqual([]);
    expect([...covered, ...Object.keys(NO_ANSWER_AFTER_BOUNDARY)].filter((k) => !declared.includes(k)), "listed, but not declared").toEqual([]);
    expect([...covered].filter((k) => k in NO_ANSWER_AFTER_BOUNDARY), "both covered by a row and listed with a reason").toEqual([]);
    // every attempt state is either said after the boundary, and then a row covers it (the row checks it printed it), or never is
    const said = new Set<string | undefined>([...SAYS.unknown.pay, ...SAYS.paid.pay, EXCEPTIONS["pay-chain-unpaid"].state]);
    for (const state of ATTEMPT_STATES) {
      if (said.has(state)) expect(covered.has(`state ${state}`), `no row covers ${state}`).toBe(true);
      else expect(FORBIDDEN_STATES.pay, `${state} is neither said nor forbidden`).toContain(state);
    }
  }, 60_000);
});
