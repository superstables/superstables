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
// states, the pay CLI's commands, the budget dispatcher's handlers and each owner command on each rail, and fails while
// any of them has neither a row nor a reason in NO_ANSWER_AFTER_BOUNDARY. It needs no row to have run.
// The rail scan reads every rail script, and the dispatcher, approval record and page code that answer outside it, and fails
// on any place that may end failed or not_revoked without naming a proof from budget/proof.mjs, unless UNPROVEN_FAILED says
// why that place cannot answer after a send, or what answers instead.

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { Keypair, SendTransactionError, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { encodeEventTopics, encodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import bs58 from "bs58";
import { PROOFS } from "../budget/proof.mjs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { endpointTree, type Entry } from "./helpers/endpoint-tree.js";
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
import { startFakeSolana, startFakeTempo } from "./helpers/fake-chains.js";
import { evmOwner, evmOwnerKey, startFakeRpc, startFakeSite, type FakeRequest, type FakeSite } from "./helpers/fake-site.js";
import { startFakeMppSeller, startFakeTempoPay } from "./helpers/fake-tempo-pay.js";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "./helpers/servers.js";
import { agreedFromClient } from "./helpers/agree-from-client.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAIN = resolve(ROOT, "src/cli/main.ts");
const BUDGET = resolve(ROOT, "budget/cli.mjs");
// The budget commands run from a copy whose endpoint table names the fake RPCs: the endpoints that confirm a verdict, and the ones
// an owner command uses, come from that table or the owner's settings, never from an RPC that only the environment names.
const tree = endpointTree();
const TREE_BUDGET = resolve(tree.root, "budget/cli.mjs");
/** The rows set so far: `tree.set` rewrites the whole table, so a later row keeps the earlier ones. */
const rows: Record<string, Entry[]> = {};
const setRows = (table: Record<string, Entry[]>) => tree.set(Object.assign(rows, table));
/** With a fake evm RPC, Base Sepolia's table names it twice, as two operators, so a verdict that needs two agreeing endpoints can be reached. */
const evmTable = (url: string | undefined) => {
  if (url) setRows({ "base-sepolia": [{ url, operator: "fake-a" }, { url: `${url}/`, operator: "fake-b" }] });
  return TREE_BUDGET;
};

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
  // an owner command whose transaction the chain shows changed nothing (it reverted, or a Solana blockhash expired): its
  // RESULT names the proof from budget/proof.mjs and the transaction, and so does its page on this machine
  "owner-chain-proved": { surface: "budget", state: "failed", proof: (b: any) => Object.hasOwn(PROOFS, b.proof) && Object.values(b.tx ?? {}).some((h) => typeof h === "string"), allows: [] },
  "owner-page-chain-proved": { surface: "approval", state: "failed", proof: (b: any) => Object.hasOwn(PROOFS, b.proof) && typeof b.hash === "string", allows: [] },
} as const satisfies Record<string, { surface: Surface; state: string; proof: (b: any) => boolean; allows: readonly RegExp[] }>;

/** What may be said after the boundary, per surface. `undefined`: the answer states no outcome (a refused route). */
const SAYS: Record<"unknown" | "paid", Record<Surface, (string | undefined)[]>> = {
  unknown: { pay: ["uncertain", "approved", "submitting"], budget: ["unknown"], approval: ["unknown", "signed", "sending", "sent", undefined], listing: [undefined] },
  paid: { pay: ["settled", "paid_service_failed"], budget: ["settled"], approval: ["confirmed"], listing: [undefined] },
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
  show_owner_first: /^this wait did not read the approval, so whether the owner approved or paid is not known\./,
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

/**
 * No answer past the boundary says nothing was paid in its fields, whatever its state: not at the top (unless the chain
 * proved it, `proven`), and not in any object inside it (a setup's steps, the open purchase under pending, a payment),
 * where a forbidden state is refused too.
 */
function assertNoUnpaidFields(at: string, surface: Surface, body: unknown, proven: boolean): void {
  if (!body || typeof body !== "object") return;
  const top = body as Record<string, unknown>;
  if (!proven) {
    if ("paid" in top) expect(top.paid, `${at}: paid`).not.toBe(false);
    if ("amount" in top) expect(top.amount, `${at}: amount`).not.toBe("0");
    if ("money_moved" in top) expect(top.money_moved, `${at}: money_moved`).not.toBe(false);
  }
  for (const [path, inner] of nestedObjects(body)) {
    if ("money_moved" in inner) expect(inner.money_moved, `${at}: ${path}.money_moved`).not.toBe(false);
    if ("paid" in inner) expect(inner.paid, `${at}: ${path}.paid`).not.toBe(false);
    if ("amount" in inner) expect(inner.amount, `${at}: ${path}.amount`).not.toBe("0");
    // a step the chain proved changed nothing keeps its own failed state, with its proof (a multi-step setup)
    const stepProven = ["failed", "not_revoked"].includes(inner.state as string) && typeof inner.proof === "string" && Object.hasOwn(PROOFS, inner.proof) && typeof inner.tx === "string";
    if (typeof inner.state === "string" && !stepProven) expect(FORBIDDEN_STATES[surface], `${at}: ${path}.state`).not.toContain(inner.state);
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
  }
  assertNoUnpaidFields(at, seen.surface, seen.body, exception !== undefined);
  if (o.own && o.state !== undefined) {
    // a settled purchase that was not delivered exits 4 (budget/cli.mjs exitFor); a settled owner command exits 0
    const undelivered = seen.surface === "budget" && o.state === "settled" && (seen.body?.delivered === false || (seen.body?.delivered !== true && seen.body?.command === "buy"));
    const code = undelivered ? 4 : EXIT[seen.surface][o.state];
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
  tree.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

type Ran = { code: number; stdout: string; stderr: string };
function exec(args: string[], env: Record<string, string | undefined>, onChild?: (child: ReturnType<typeof spawn>) => void): Promise<Ran> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } as NodeJS.ProcessEnv });
    onChild?.(child);
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
const budget = (home: string, args: string[], env: Record<string, string> = {}, onChild?: (child: ReturnType<typeof spawn>) => void) => exec([evmTable(env.B4_RPC), ...args], budgetEnv(home, env), onChild);
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
/** `status`: the receipt's, "0x1" (success) unless given. `from`: the sender, the owner unless given. */
type OwnerTx = { to: string; input: Hex; value: bigint; logs: unknown[]; status?: "0x0" | "0x1"; from?: string };
/** An RPC that shows each of these transactions mined in block 101, after a request that started at block 100. */
function minedChain(txs: Record<string, OwnerTx>, extra?: (method: string, params: any[]) => unknown) {
  const blockHash = `0x${"ef".repeat(32)}`;
  return (method: string, params: any[]) => {
    if (method === "eth_blockNumber") return "0x64";
    const answer = extra?.(method, params);
    if (answer !== undefined) return answer;
    const t = txs[params[0]];
    if (!t) return undefined;
    const from = t.from ?? OWNER;
    if (method === "eth_getTransactionByHash") return { hash: params[0], blockHash, blockNumber: "0x65", from, to: t.to, input: t.input, value: `0x${t.value.toString(16)}`, gas: "0x10000", gasPrice: "0x1", nonce: "0x0", transactionIndex: "0x0", type: "0x0", v: "0x1b", r: "0x1", s: "0x1", chainId: "0x14a34" };
    if (method === "eth_getTransactionReceipt") return { transactionHash: params[0], blockHash, blockNumber: "0x65", from, to: t.to, status: t.status ?? "0x1", logs: t.logs, gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logsBloom: `0x${"0".repeat(512)}`, transactionIndex: "0x0", type: "0x0" };
    return undefined;
  };
}
/**
 * An owner command on this machine (no superstables.com), whose page's wallet reports these transactions: the RPC shows
 * each one mined in block 101, after the request started at block 100, from the owner, successful, with these logs.
 */
async function ownerOnThisMachine(txs: Record<string, OwnerTx>, extra?: (method: string, params: any[]) => unknown) {
  const b = await hostedBudget(minedChain(txs, extra));
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

/**
 * budget recover on this machine with an allowance of 1 USDC and an agent with gas: the agent lowers it with its own key
 * (transferFrom(owner, owner, n)), and no page is needed while the owner holds all of it. Unless it `lands`, the agent's revoke
 * gets no receipt, so the rail keeps reading the chain (budget/evm/lib.ts receiptOf) until the test stops it. When the owner
 * holds less, what is left needs the owner's revoke on a page.
 */
async function recoverOnThisMachine(o: { ownerHolds?: bigint; lands?: boolean } = {}) {
  let broadcast = false;
  const REVOKE: Hex = `0x${"d1".repeat(32)}`;
  const owns = o.ownerHolds ?? 10n ** 6n;
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
  const b = await ownerOnThisMachine({}, (method, params) => {
    if (method === "eth_getBlockByNumber") return rpcBlock(100n);
    if (method === "eth_estimateGas") return "0x10000";
    const data = String(params[0]?.data ?? "");
    // the agent's transferFrom(owner, owner, n) lowers the allowance by what the owner holds
    if (method === "eth_call" && data.startsWith("0xdd62ed3e")) return word(broadcast && o.lands ? 10n ** 6n - owns : 10n ** 6n);
    if (method === "eth_call" && data.startsWith("0x70a08231")) return word(data.toLowerCase().includes(OWNER.slice(2).toLowerCase()) ? owns : 0n);
    if (method === "eth_sendRawTransaction") { broadcast = true; return REVOKE; }
    if (method === "eth_getTransactionReceipt") return o.lands && params[0] === REVOKE ? { ...rpcReceipt(REVOKE, 101n, []), from: AGENT } : new Error("not yet");
    return undefined;
  });
  const record = async () => {
    const dir = join(b.home, "budget", "approvals");
    const file = await until(() => broadcast && existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(".json")), "the agent's revoke broadcast under an approval", 60_000);
    return JSON.parse(readFileSync(join(dir, file), "utf8")) as { id: string; pid: number; railPgid?: number };
  };
  return { ...b, record, broadcast: () => broadcast };
}
const killGroup = (pgid?: number) => { if (pgid) try { process.kill(-pgid, "SIGKILL"); } catch {} };

// ---- budget on tempo and solana: superstables.com (fake site) or the page on this machine, and fake chains -------------

const TEMPO_KEY = `0x${"44".repeat(32)}` as const;
const TEMPO_AGENT = privateKeyToAccount(TEMPO_KEY).address;
const SOL_AGENT = Keypair.fromSeed(new Uint8Array(32).fill(3));
const SOL_OWNER = Keypair.fromSeed(new Uint8Array(32).fill(4));
/**
 * A tempo or solana budget on a new home: the agent key and the public file, with approvals on the fake site unless
 * `local`, and the owner holding SOL and USDC (solana). `fresh`: only an agent key bound to no owner, for setup.
 */
async function otherRail(rail: "tempo" | "solana", opts: { local?: boolean; fresh?: boolean } = {}) {
  const home = newHome();
  const site = await startFakeSite();
  const tempo = rail === "tempo" ? await startFakeTempo() : undefined;
  const solana = rail === "solana" ? await startFakeSolana() : undefined;
  opened.push(site, (tempo ?? solana)!);
  setRows(tempo ? { "tempo-moderato": [tempo.url] } : { "solana-devnet": [solana!.url] });
  const owner = rail === "tempo" ? OWNER : SOL_OWNER.publicKey.toBase58();
  site.owner = owner;
  const put = (path: string[], text: string, mode: number) => {
    mkdirSync(join(home, ...path.slice(0, -1)), { recursive: true });
    writeFileSync(join(home, ...path), text, { mode });
  };
  const bound = opts.fresh ? "" : rail === "tempo" ? `OWNER_ADDRESS=${owner}\n` : `SOLANA_OWNER_ADDRESS=${owner}\n`;
  if (rail === "tempo") put(["keys", "budget", "tempo-agent.env"], `AGENT_PRIVATE_KEY=${TEMPO_KEY}\nAGENT_ADDRESS=${TEMPO_AGENT}\n${bound}`, 0o600);
  else if (!opts.fresh) put(["keys", "budget", "solana-agent.env"], `SOLANA_AGENT_SECRET_BASE58=${bs58.encode(SOL_AGENT.secretKey)}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT.publicKey.toBase58()}\n${bound}`, 0o600);
  const hosted = opts.local ? "" : `APPROVALS=hosted\nSITE=${site.url}\n`;
  if (!opts.fresh && rail === "tempo") put(["budget", "public", "tempo-moderato.env"], `OWNER_ADDRESS=${owner}\nAGENT_ADDRESS=${TEMPO_AGENT}\n${hosted}`, 0o644);
  if (!opts.fresh && rail === "solana") put(["budget", "public", "solana-devnet.env"], `SOLANA_OWNER_ADDRESS=${owner}\nSOLANA_AGENT_ADDRESS=${SOL_AGENT.publicKey.toBase58()}\n${hosted}`, 0o644);
  solana?.usdc.set(owner, { amount: 5_000_000n, delegate: null, delegated: 0n });
  solana?.balances.set(owner, 10n ** 9n);
  const env: Record<string, string> = tempo ? { SUPERSTABLES_TEMPO_RPC: tempo.url } : { SUPERSTABLES_SOLANA_RPC: solana!.url };
  return { home, site, tempo, solana, owner, env };
}
/** The site moves every request it polls twice to unknown with the wallet asked; a link it adds first, its steps the same. */
const siteCannotTell = (owner: string) => (r: FakeRequest) => {
  if (r.polls < 2 || r.state !== "awaiting_owner") return;
  if (r.kind === "link") {
    Object.assign(r, { state: "linked", owner });
    for (const step of r.steps ?? []) Object.assign(step, { state: "unknown", wallet_asked: true });
  } else Object.assign(r, { state: "unknown", wallet_asked: true, reason: "the wallet was asked and never answered" });
};

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
/** eth_getBlockByNumber's answer for block `n`, at time 2000. */
const rpcBlock = (n: bigint) => ({ number: hex(n), hash: BLOCK_HASH, parentHash: BLOCK_HASH, timestamp: hex(2000), transactions: [], gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1", difficulty: "0x0", extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, miner: AGENT, nonce: "0x0000000000000000", receiptsRoot: BLOCK_HASH, sha3Uncles: BLOCK_HASH, size: "0x1", stateRoot: BLOCK_HASH, totalDifficulty: "0x0", transactionsRoot: BLOCK_HASH, uncles: [] });
function rpcChain(receipts: Record<string, unknown>, held = 10000n) {
  return (method: string, params: any[]): unknown => {
    if (method === "eth_blockNumber") return hex(110);
    if (method === "eth_getBlockByNumber") return rpcBlock(params[0] === "finalized" ? 90n : params[0] === "latest" || params[0] === "safe" ? 110n : BigInt(params[0]));
    if (method === "eth_getTransactionReceipt") return receipts[String(params[0]).toLowerCase()] ?? null;
    if (method === "eth_getTransactionByHash") return null;
    if (method === "eth_getTransactionCount") return "0x8";
    if (method === "eth_getLogs") return [];
    if (method === "eth_call" && String(params[0]?.data).startsWith("0x70a08231")) return `0x${held.toString(16).padStart(64, "0")}`;
    return undefined;
  };
}

/** `budget reconcile` on one journal, through the dispatcher, as an agent runs it. */
async function reconcileCli(at: string, receipts: Record<string, unknown>, journal: Record<string, unknown>, held?: bigint) {
  const b = await hostedBudget(rpcChain(receipts, held));
  const dir = join(b.home, "budget", "ops", "evm-base-sepolia");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${journal.op}.json`), JSON.stringify({ ...journal, token: BASE_USDC }));
  // A verdict needs two agreeing endpoints: the copy's Base Sepolia table names the fake RPC twice, as two operators.
  const cli = evmTable(b.env.B4_RPC);
  return { b, seen: seenBudget(at, "reconcile", await exec([cli, "reconcile", "--rail", "evm", "--chain", "base-sepolia", "--op", String(journal.op)], budgetEnv(b.home, b.env))) };
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
    ...agreedFromClient(chain, TOKEN), sleep: async () => {}, retry: async <T,>(f: () => Promise<T>) => f(), ...lib,
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
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: false, next: expect.stringMatching(/^the owner's wallet may have sent the transaction\. Tell the owner the outcome is unknown/) } },
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
    covers: ["budget setup", "budget setup evm"],
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
    covers: ["budget grant", "budget fund-agent", "budget revoke", "budget grant evm", "budget fund-agent evm", "budget revoke evm"],
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
    path: "owner approval page, evm transaction: after the wallet sent, the command's failed verdict names a proof the chain facts do not include",
    covers: [],
    run: async () => {
      const server = await ownerServer();
      const handle = server.request(ownerTransfer(60_000));
      await ownerAsked(handle.url);
      const sent = await seenRoute("owner:evm-transaction", "the page reports the transaction", handle.url, "/sent", { address: OWNER, hash: `0x${"c7".repeat(32)}` });
      handle.finish({ outcome: "failed", proof: "the_site_said_so" as never, message: "The transfer failed." });
      return [sent, await seenRoute("owner:evm-transaction", "the page's state after that verdict", handle.url, "/state")];
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, message: "The transfer failed." } },
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
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"c8".repeat(32)}`, message: "The transaction was not accepted as the planned step: its call approves the spender 0x5555555555555555555555555555555555555555, not 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A. The budget was not recorded. superstables budget revoke cannot end this approval. Send from your wallet: approve(0x5555555555555555555555555555555555555555, 0) on token 0x036CbD53842c5426634e7929541eC2318f3dCF7e, which this transaction approved for 1 USDC." } },
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
    path: "budget grant on this machine: the owner's approval lands, then reading the allowance back fails and the script stops",
    covers: [],
    run: async () => {
      const GRANT: Hex = `0x${"cb".repeat(32)}`;
      let mined = false;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 10n ** 6n] });
      const b = await ownerOnThisMachine({ [GRANT]: { to: BASE_USDC, input, value: 0n, logs: [approval(OWNER, AGENT, 10n ** 6n, GRANT)] } }, (method, params) => {
        if (method === "eth_getTransactionReceipt" && params[0] === GRANT) mined = true;
        return mined && method === "eth_call" ? new Error("header not found") : undefined;
      });
      const first = resultOf((await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "grant", state: "waiting_owner" });
      return ownerPageSent(b, first, GRANT);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"cb".repeat(32)}`, message: "" } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, reason: "the rail script exited 1", next: "superstables budget status --rail evm: read whether it landed before running this again" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget grant with the owner key file (--yes): the approval is broadcast, then the script stops before its RESULT",
    covers: [],
    run: async () => {
      const SENT: Hex = `0x${"cd".repeat(32)}`;
      const b = await ownerOnThisMachine({}, (method, params) => {
        if (method === "eth_getBlockByNumber") return rpcBlock(100n);
        if (method === "eth_estimateGas") return "0x10000";
        if (method === "eth_sendRawTransaction") return SENT;
        // the receipt shows it reverted: send() throws on that, so the script ends with no RESULT
        if (method === "eth_getTransactionReceipt" && params[0] === SENT) return { ...rpcReceipt(SENT, 101n, [], "0x0"), from: OWNER };
        return undefined;
      });
      const keyFile = join(b.home, "owner.env");
      writeFileSync(keyFile, `B4_OWNER_KEY=${evmOwnerKey("22")}\n`, { mode: 0o600 });
      return [seenBudget("grant --owner-key-file --yes", "grant", await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--owner-key-file", keyFile, "--yes"], b.env))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", reason: "the rail script exited 1", next: "superstables budget status --rail evm: read whether it landed before running this again" } }],
    timeout: 90_000,
  },
  {
    path: "budget grant on this machine: the owner's approval reverted on chain, which proves it granted nothing",
    covers: [],
    run: async () => {
      const GRANT: Hex = `0x${"ce".repeat(32)}`;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 10n ** 6n] });
      const b = await ownerOnThisMachine({ [GRANT]: { to: BASE_USDC, input, value: 0n, logs: [], status: "0x0" } });
      const first = resultOf((await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "grant", state: "waiting_owner" });
      return ownerPageSent(b, first, GRANT);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "owner-page-chain-proved", match: { http: 200, status: "failed", proof: "reverted", message: "The transaction reverted. No allowance was granted by it, but a network fee may have been charged." } },
      { verdict: "owner-chain-proved", match: { exit: 1, command: "grant", state: "failed", proof: "reverted", final: true, tx: { grant: `0x${"ce".repeat(32)}` }, reason: "the approve reverted on chain" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget grant on this machine: the owner's transaction reverted on chain, and its call approves another spender than the agent",
    covers: [],
    run: async () => {
      const GRANT: Hex = `0x${"d4".repeat(32)}`;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [SPENDER, 10n ** 6n] });
      const b = await ownerOnThisMachine({ [GRANT]: { to: BASE_USDC, input, value: 0n, logs: [], status: "0x0" } });
      const first = resultOf((await budget(b.home, ["grant", "--rail", "evm", "--amount", "1", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "grant", state: "waiting_owner" });
      return ownerPageSent(b, first, GRANT);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"d4".repeat(32)}`, message: "The transaction reverted on chain, but it is not the one this page asked for: its call approves the spender 0x5555555555555555555555555555555555555555, not 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A. The budget was not recorded. This command can't read an approval from the transaction. Check your wallet's activity and, if it approved anything, set that approval to 0 from your wallet." } },
      { verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, tx: { grant: `0x${"d4".repeat(32)}` }, reason: "the transaction was not accepted as the planned step: its call approves the spender 0x5555555555555555555555555555555555555555, not 0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A; it reverted on chain. The budget was not recorded." } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget revoke on this machine: the owner's revoke lands, and the allowance still reads above 0",
    covers: [],
    run: async () => {
      const REVOKE: Hex = `0x${"cf".repeat(32)}`;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 0n] });
      const b = await ownerOnThisMachine({ [REVOKE]: { to: BASE_USDC, input, value: 0n, logs: [approval(OWNER, AGENT, 0n, REVOKE)] } }, allowance(10n ** 6n));
      const first = resultOf((await budget(b.home, ["revoke", "--rail", "evm", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "revoke", state: "waiting_owner" });
      return ownerPageSent(b, first, REVOKE);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "unknown", match: { http: 200, status: "unknown", sending: true, hash: `0x${"cf".repeat(32)}`, message: "The chain still shows an allowance of 1 USDC. Run the revoke again." } },
      { verdict: "unknown", match: { exit: 5, command: "revoke", state: "unknown", final: true, reason: "the allowance still reads above 0", next: "superstables budget status --rail evm: read whether it landed before running this again" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget revoke on this machine: the allowance already reads 0, and the owner's revoke is still sent, and is settled once the chain's final block is past it",
    covers: [],
    run: async () => {
      const REVOKE: Hex = `0x${"cf".repeat(32)}`;
      const input = encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 0n] });
      const b = await ownerOnThisMachine({ [REVOKE]: { to: BASE_USDC, input, value: 0n, logs: [approval(OWNER, AGENT, 0n, REVOKE)] } }, allowance(0n));
      const first = resultOf((await budget(b.home, ["revoke", "--rail", "evm", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "revoke", state: "waiting_owner" });
      return ownerPageSent(b, first, REVOKE);
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "paid", match: { http: 200, status: "confirmed", sending: true, hash: `0x${"cf".repeat(32)}` } },
      // The endpoints agree on a final block past the revoke, so the revoke is final and the answer is done.
      { verdict: "paid", match: { exit: 0, command: "revoke", state: "settled", tx: { revoke: `0x${"cf".repeat(32)}` } } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget wait on a finished owner approval that an earlier client stored as failed after the wallet was asked",
    covers: [],
    run: async () => {
      const home = newHome();
      const id = "oa-20261010120000-0a0b0c0d";
      const page = "ab".repeat(16);
      mkdirSync(join(home, "budget", "approvals"), { recursive: true });
      writeFileSync(join(home, "budget", "approvals", `${id}.json`), JSON.stringify({
        id, command: "grant", rail: "evm", chain: "base-sepolia", url: `http://127.0.0.1:1/owner/${page}`, state: "final", endedAt: new Date().toISOString(),
        final: { code: 1, result: { ok: false, command: "grant", rail: "evm", chain: "base-sepolia", state: "failed", final: true, tx: {}, next: "read the output above", reason: "the rail script exited 1" } },
      }), { mode: 0o600 });
      writeFileSync(join(home, "budget", "owner-approvals.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), id: page, kind: "evm-transaction", title: "Grant a spending budget", status: "sent", sending: true })}\n`, { mode: 0o600 });
      return [seenBudget("wait --shown", "wait", await budget(home, ["wait", "--shown", "--id", id, "--timeout", "0"]))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "grant", state: "unknown", final: true, reason: "the rail script exited 1", next: "superstables budget status --rail evm: read whether it landed before running this again" } }],
  },
  {
    path: "budget wait after a recover's background worker stopped: its first page's wallet was asked, its second page's never was",
    covers: [],
    run: async () => {
      const home = newHome();
      const id = "oa-20261010120000-1a1b1c1d";
      const [revoke, gas] = ["cd".repeat(16), "ef".repeat(16)];
      mkdirSync(join(home, "budget", "approvals"), { recursive: true });
      // what recordLink keeps after recover's second link; no process of it runs any more
      writeFileSync(join(home, "budget", "approvals", `${id}.json`), JSON.stringify({
        id, command: "recover", rail: "evm", chain: "base-sepolia", state: "waiting_owner", createdAt: new Date().toISOString(),
        url: `http://127.0.0.1:1/owner/${gas}`, earlierUrls: [`http://127.0.0.1:1/owner/${revoke}`], links: 2,
      }), { mode: 0o600 });
      const line = (page: string, status: string, sending?: true) => JSON.stringify({ at: new Date().toISOString(), id: page, kind: "evm-transaction", title: "recover", status, ...(sending ? { sending } : {}) });
      writeFileSync(join(home, "budget", "owner-approvals.jsonl"), [line(revoke, "sent", true), line(revoke, "confirmed", true), line(gas, "pending")].join("\n") + "\n", { mode: 0o600 });
      return [seenBudget("wait --shown", "wait", await budget(home, ["wait", "--shown", "--id", id, "--timeout", "5"]))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: true, reason: "the background approval stopped after the wallet was asked to send (last page state: pending)" } }],
  },
  {
    path: "budget fund-agent on solana, on this machine: the transfer lands with the planned amount, and the agent's balance then reads lower",
    covers: ["budget fund-agent solana"],
    run: async () => {
      const b = await otherRail("solana", { local: true });
      const address = b.owner;
      // the agent spends right after the transfer lands: the balance never shows it, the transaction does
      b.solana!.afterSend = () => b.solana!.balances.set(SOL_AGENT.publicKey.toBase58(), 1_000_000n);
      const first = resultOf((await budget(b.home, ["fund-agent", "--rail", "solana", "--no-open"], b.env)).stdout);
      expect(first).toMatchObject({ command: "fund-agent", state: "waiting_owner" });
      // the page shows the balance before the transfer, next to "Done. Your agent received ...", as on evm
      expect(await (await fetch(first.url)).text()).toMatch(/>Agent balance before this transfer</);
      expect((await seenRoute("owner:solana-transaction", "connect", first.url, "/account", { address })).http).toBe(200);
      const prepared = await seenRoute("owner:solana-transaction", "prepare", first.url, "/prepare", { address });
      const tx = Transaction.from(Buffer.from(prepared.body.transaction, "base64"));
      tx.sign(SOL_OWNER);
      const signed = await seenRoute("owner:solana-transaction", "the signed transfer is sent", first.url, "/signed", { address, signedTransaction: tx.serialize().toString("base64") });
      const verdict = await until(async () => {
        const st = await seenRoute("owner:solana-transaction", "the page's state once the command read the chain", first.url, "/state");
        return st.body.status !== "sent" && st;
      }, "the command's verdict on the page", 60_000);
      return [signed, verdict, seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "90"], b.env))];
    },
    expect: [
      { verdict: "unknown", match: { http: 200, status: "sent" } },
      { verdict: "paid", match: { http: 200, status: "confirmed", message: "Done. Your agent received 0.01 SOL. You can close this page." } },
      { verdict: "paid", match: { exit: 0, command: "fund-agent", rail: "solana", state: "settled", final: true, amount: "0.01" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget setup on superstables.com with gas and a budget: the gas lands as planned, then the grant reverts on chain",
    covers: [],
    run: async () => {
      const FUND: Hex = `0x${"c4".repeat(32)}`;
      const GRANT: Hex = `0x${"c5".repeat(32)}`;
      const gas = 10n ** 14n;
      let funded = false;
      const txs: Record<string, OwnerTx> = {
        [FUND]: { to: AGENT, input: "0x", value: gas, logs: [] },
        [GRANT]: { to: BASE_USDC, input: encodeFunctionData({ abi: erc20, functionName: "approve", args: [AGENT, 10000n] }), value: 0n, logs: [], status: "0x0" },
      };
      const b = await hostedBudget(minedChain(txs, (method, params) => {
        if (method === "eth_getTransactionReceipt" && params[0] === FUND) funded = true;
        if (method === "eth_getBalance" && String(params[0]).toLowerCase() === AGENT.toLowerCase()) return hex(10n ** 18n + (funded ? gas : 0n));
        return undefined;
      }));
      b.site.onPoll = (r) => {
        if (r.polls < 2 || r.state !== "awaiting_owner") return;
        Object.assign(r, { state: "linked", owner: OWNER });
        Object.assign(r.steps![0], { state: "confirmed", tx_hash: FUND, wallet_asked: true });
        Object.assign(r.steps![1], { state: "failed", tx_hash: GRANT, wallet_asked: true });
      };
      return [seenBudget("setup --hosted --grant --fund --wait", "setup", await budget(b.home, ["setup", "--rail", "evm", "--hosted", "--site", b.site.url, "--grant", "0.01", "--fund", "--wait", "--no-open"], b.env))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "setup", state: "unknown", linked: true, reason: expect.stringMatching(/^partly_done: fund_agent settled before grant failed \(reverted\); agent added: yes/), steps: [{ kind: "fund_agent", state: "settled", tx: `0x${"c4".repeat(32)}` }, { kind: "grant", state: "failed", proof: "reverted", tx: `0x${"c5".repeat(32)}` }] } }],
    timeout: 120_000,
  },
  {
    path: "budget fund-agent on superstables.com: the hash the site reports reverted on chain, sent by another account than the owner",
    covers: [],
    run: async () => {
      const FUND: Hex = `0x${"c6".repeat(32)}`;
      const b = await hostedBudget(minedChain({ [FUND]: { to: AGENT, input: "0x", value: 10n ** 14n, logs: [], status: "0x0", from: SPENDER } }));
      b.site.onPoll = (r) => {
        if (r.polls >= 2) Object.assign(r, { state: "sent", tx_hash: FUND, wallet_asked: true });
      };
      return [seenBudget("fund-agent --wait", "fund-agent", await budget(b.home, ["fund-agent", "--rail", "evm", "--wait", "--no-open"], b.env))];
    },
    expect: [{ verdict: "unknown", match: { exit: 5, command: "fund-agent", state: "unknown", tx: { fundAgent: `0x${"c6".repeat(32)}` }, reason: expect.stringMatching(/0x5555555555555555555555555555555555555555/) } }],
    timeout: 90_000,
  },
  {
    path: "budget fund-agent on solana, on this machine: the transfer never lands and its blockhash expires; then a node that lags behind has no status for a transfer that then lands",
    covers: [],
    run: async () => {
      const run = async (lag: boolean) => {
        const b = await otherRail("solana", { local: true });
        const chain = b.solana!;
        chain.hold = true;
        // the chain moves past the transfer's last valid block height
        chain.afterSend = () => (chain.slot += 200);
        let reads = 0;
        if (lag) chain.statusSlot = () => (++reads === 2 ? (chain.landHeld?.(), chain.slot) : chain.slot - 300);
        const first = resultOf((await budget(b.home, ["fund-agent", "--rail", "solana", "--no-open"], b.env)).stdout);
        expect(first).toMatchObject({ command: "fund-agent", state: "waiting_owner" });
        expect((await seenRoute("owner:solana-transaction", "connect", first.url, "/account", { address: b.owner })).http).toBe(200);
        const prepared = await seenRoute("owner:solana-transaction", "prepare", first.url, "/prepare", { address: b.owner });
        const tx = Transaction.from(Buffer.from(prepared.body.transaction, "base64"));
        tx.sign(SOL_OWNER);
        await seenRoute("owner:solana-transaction", "the signed transfer is sent", first.url, "/signed", { address: b.owner, signedTransaction: tx.serialize().toString("base64") });
        const verdict = await until(async () => {
          const st = await seenRoute("owner:solana-transaction", `the page's state once the command read the chain${lag ? " (a lagging node)" : ""}`, first.url, "/state");
          return st.body.status !== "sent" && st;
        }, "the command's verdict on the page", 60_000);
        return [verdict, seenBudget(`wait for the end${lag ? " (a lagging node)" : ""}`, "wait", await budget(b.home, ["wait", "--shown", "--id", first.id, "--timeout", "90"], b.env))];
      };
      return [...(await run(false)), ...(await run(true))];
    },
    expect: [
      { verdict: "owner-page-chain-proved", match: { http: 200, status: "failed", proof: "blockhash_expired" } },
      { verdict: "owner-chain-proved", match: { exit: 1, command: "fund-agent", rail: "solana", state: "failed", proof: "blockhash_expired", final: true } },
      { verdict: "paid", match: { http: 200, status: "confirmed", message: "Done. Your agent received 0.01 SOL. You can close this page." } },
      { verdict: "paid", match: { exit: 0, command: "fund-agent", rail: "solana", state: "settled", final: true, amount: "0.01" } },
    ],
    timeout: 150_000,
  },
  ...(["tempo", "solana"] as const).map((rail): Row => ({
    path: `budget grant, revoke and setup with a budget on ${rail}, approved on superstables.com, waiting: the site cannot tell whether the wallet sent`,
    covers: [`budget grant ${rail}`, `budget revoke ${rail}`, `budget setup ${rail}`],
    run: async () => {
      const b = await otherRail(rail);
      b.site.onPoll = siteCannotTell(b.owner);
      const grant = seenBudget("grant --wait", "grant", await budget(b.home, ["grant", "--rail", rail, "--amount", "0.05", "--wait", "--no-open"], b.env));
      // a live budget to revoke: the key on tempo, the delegate on solana
      if (b.tempo) b.tempo.keys.set(`${b.owner.toLowerCase()}:${TEMPO_AGENT.toLowerCase()}`, { expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), limit: 50_000n, period: 0n, periodEnd: 0n, revoked: false, scoped: false });
      b.solana?.usdc.set(b.owner, { amount: 5_000_000n, delegate: SOL_AGENT.publicKey.toBase58(), delegated: 50_000n });
      const revoke = seenBudget("revoke --wait", "revoke", await budget(b.home, ["revoke", "--rail", rail, "--wait", "--no-open"], b.env));
      const s = await otherRail(rail, { fresh: true });
      s.site.onPoll = siteCannotTell(s.owner);
      const setup = seenBudget("setup --hosted --grant --wait", "setup", await budget(s.home, ["setup", "--rail", rail, "--hosted", "--site", s.site.url, "--grant", "0.05", "--wait", "--no-open"], s.env));
      return [grant, revoke, setup];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "grant", rail, state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } },
      { verdict: "unknown", match: { exit: 5, command: "revoke", rail, state: "unknown", next: expect.stringMatching(/read whether it landed before running this again/) } },
      { verdict: "unknown", match: { exit: 5, command: "setup", rail, state: "unknown", linked: true, steps: [{ kind: "grant", state: "unknown" }] } },
    ],
    timeout: 180_000,
  })),
  {
    path: "owner commands a rail does not offer: refused as bad input before any rail script runs",
    covers: ["budget fund-agent tempo", "budget recover tempo", "budget recover solana"],
    run: async () => {
      const home = newHome();
      return Promise.all([["fund-agent", "tempo"], ["recover", "tempo"], ["recover", "solana"]].map(async ([cmd, rail]) => seenBudget(`${cmd} on ${rail}`, cmd, await budget(home, [cmd, "--rail", rail]))));
    },
    expect: [
      { verdict: "before", match: { exit: 2, command: "fund-agent", rail: "tempo", state: "failed", reason: expect.stringMatching(/^tempo's agent needs no gas/) } },
      { verdict: "before", match: { exit: 2, command: "recover", rail: "tempo", state: "failed", reason: expect.stringMatching(/^recover is EVM only/) } },
      { verdict: "before", match: { exit: 2, command: "recover", rail: "solana", state: "failed", reason: expect.stringMatching(/^recover is EVM only/) } },
    ],
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
          getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
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
    path: "budget recover, detached: the agent's own revoke is broadcast before any page, then the worker is killed before its RESULT; then again with the command that started it killed first",
    covers: ["budget recover", "budget recover evm"],
    run: async () => {
      const b = await recoverOnThisMachine();
      const first = budget(b.home, ["recover", "--rail", "evm", "--no-open"], b.env);
      const r = await b.record();
      killGroup(r.railPgid);
      killGroup(r.pid);
      const answer = seenBudget("the worker is killed after the broadcast", "recover", await first);
      const replay = seenBudget("wait --shown", "wait", await budget(b.home, ["wait", "--shown", "--id", r.id, "--timeout", "5"], b.env));
      const c = await recoverOnThisMachine();
      let parent: ReturnType<typeof spawn> | undefined;
      const started = budget(c.home, ["recover", "--rail", "evm", "--no-open"], c.env, (child) => (parent = child));
      const r2 = await c.record();
      parent!.kill("SIGKILL");
      await started;
      killGroup(r2.railPgid);
      killGroup(r2.pid);
      return [answer, replay, seenBudget("wait, after every process is gone", "wait", await budget(c.home, ["wait", "--id", r2.id, "--timeout", "10"], c.env))];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "recover", rail: "evm", state: "unknown", id: expect.stringMatching(/^oa-/), reason: "the background approval stopped before it opened a page, after its command was about to broadcast a transaction", next: "superstables budget status --rail evm --chain base-sepolia: read whether it landed before running this again" } },
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: true, reason: "the background approval stopped before it opened a page, after its command was about to broadcast a transaction" } },
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: true, reason: "the background approval stopped after its command was about to broadcast a transaction (last page state: none)" } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget recover, detached: the agent's own revoke is broadcast, and no page comes within the link wait (budget/approvals.mjs startDetached, as the dispatcher runs it, with a 20 s wait)",
    covers: [],
    run: async () => {
      const b = await recoverOnThisMachine();
      const script = `const a = await import(${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))});
        const id = a.newApprovalId();
        if (!a.claim("evm", "base-sepolia", id).ok) throw new Error("chain held");
        const r = await a.startDetached({ id, command: "recover", rail: "evm", chain: "base-sepolia", cmd: process.execPath, args: [${JSON.stringify(BUDGET)}, "recover", "--rail", "evm", "--no-open", "--wait"], cwd: process.cwd(), timeoutS: 600, linkWaitMs: 20000 });
        console.log("STARTED " + JSON.stringify({ kind: r.kind, id, final: r.record?.final }));`;
      const ran = await exec(["--input-type=module", "-e", script], budgetEnv(b.home, b.env));
      const started = JSON.parse(ran.stdout.split("\n").find((l) => l.startsWith("STARTED "))!.slice(8));
      expect(b.broadcast(), "the agent's revoke was broadcast within the link wait").toBe(true);
      // the final the record holds: what the dispatcher prints for it, and what every later wait replays
      const answer: Seen = { at: "no page within the link wait", surface: "budget", cmd: "budget recover (startDetached's stored final)", exit: started.final?.code, body: started.final?.result, text: ran.stdout + ran.stderr };
      return [answer, seenBudget("wait --shown", "wait", await budget(b.home, ["wait", "--shown", "--id", started.id, "--timeout", "5"], b.env))];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown" } },
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: true } },
    ],
    timeout: 120_000,
  },
  {
    path: "budget recover, detached: the background approval stops before it opens a page, and its process group would not stop",
    covers: [],
    run: async () => {
      const b = await recoverOnThisMachine();
      const holder = join(b.home, "holder.pid");
      const preload = join(b.home, "unstoppable-group.mjs");
      // The worker leaves an exited child in its process group, whose parent moved to a group of its own and never reaps
      // it: the group outlives its leader, and no signal ends it.
      const keep = `import os, time\nif os.fork() == 0: os._exit(0)\nos.setpgid(0, 0)\nopen(${JSON.stringify(holder)}, "w").write(str(os.getpid()))\ntime.sleep(120)`;
      writeFileSync(preload, `import { spawn } from "node:child_process";
        import { existsSync } from "node:fs";
        if (process.env.SUPERSTABLES_BUDGET_APPROVAL_ID && !process.env.SUPERSTABLES_BUDGET_HOLDER) {
          spawn("python3", ["-c", ${JSON.stringify(keep)}], { stdio: "ignore" }).unref();
          while (!existsSync(${JSON.stringify(holder)})) await new Promise((r) => setTimeout(r, 50));
          process.exit(0);
        }`);
      try {
        const env = { ...b.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim() };
        return [seenBudget("the worker's group would not stop", "recover", await budget(b.home, ["recover", "--rail", "evm", "--no-open"], env))];
      } finally {
        if (existsSync(holder)) try { process.kill(Number(readFileSync(holder, "utf8")), "SIGKILL"); } catch {}
      }
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "recover", rail: "evm", state: "unknown", id: expect.stringMatching(/^oa-/), next: expect.stringMatching(/^the background approval could not be stopped, so it may still send a transaction\. Check wallet activity and superstables budget status --rail evm before retrying, and do not start another owner command on this chain\. The log is /), reason: expect.stringMatching(/^the background approval stopped before it opened a page, but process group \d+ would not stop; the chain stays held$/) } },
    ],
    timeout: 90_000,
  },
  {
    path: "budget recover, detached: the agent's own revoke lands and lowers part of the allowance, then the owner's page for the rest opens, waits and expires",
    covers: [],
    run: async () => {
      const b = await recoverOnThisMachine({ ownerHolds: 500_000n, lands: true });
      const first = seenBudget("the owner's page opens after the agent's revoke", "recover", await budget(b.home, ["recover", "--rail", "evm", "--no-open", "--timeout", "10"], b.env));
      const id = first.body?.id as string;
      const port = new URL(first.body?.url).port;
      expect(first.body?.next, "the page's port, forwarded over SSH, as waiting_owner gives it").toContain(`It is on this machine only: over SSH the owner first runs ssh -L ${port}:127.0.0.1:${port} user@this-host.`);
      const waiting = seenBudget("wait --shown, while the page waits", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "0"], b.env));
      return [first, waiting, seenBudget("wait for the end", "wait", await budget(b.home, ["wait", "--shown", "--id", id, "--timeout", "60"], b.env))];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: false, url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/owner\//), message_for_owner: expect.stringMatching(/^Review and approve in your wallet: .+\nhttp:\/\/127\.0\.0\.1:\d+\/owner\/[\s\S]*\nTell me when you've approved\.$/), next: expect.stringMatching(/^this command already began sending its own transaction for this approval; its outcome is not known yet\. The owner still has to approve the next step: reply to the owner with message_for_owner, word for word .* Only the owner uses the page, in the browser with their wallet\. It is on this machine only: over SSH the owner first runs ssh -L (\d+):127\.0\.0\.1:\1 user@this-host\. Do not start another owner command$/) } },
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: false, next: expect.stringMatching(/^this command already began sending its own transaction/) } },
      { verdict: "unknown", match: { exit: 5, command: "recover", state: "unknown", final: true, next: expect.stringMatching(/this step sent nothing/) } },
    ],
    timeout: 150_000,
  },
  {
    path: "budget recover: its gas step on the owner's page ended while the wallet may be sending (budget/evm/owner.ts, as recover runs it)",
    covers: [],
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
      return [{ at: "recover's gas step", surface: "budget", cmd: "budget/evm/owner.ts fundInWallet, in process", exit: code, body: resultOf(lines.join("\n")), text: lines.join("\n") }];
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
      const part = rpcReceipt(RETURN, 85n, [rpcTransfer(AGENT, OWNER, 4000n, RETURN, 85n)]);
      const emptied = (await reconcileCli("part returned, and the agent holds nothing", { [PULL]: pull, [RETURN]: part }, { ...purchase("pull-partly-returned-cli"), returnTx: RETURN }, 0n)).seen;
      return [stranded, returned, emptied];
    },
    expect: [
      { verdict: "unknown", match: { exit: 5, command: "reconcile", state: "unknown", paid: null, amount: null, tx: { pull: PULL }, reason: expect.stringMatching(/the payment authorization is expired on chain .*; the price 0\.01 USDC pulled from the owner has not been returned$/), next: expect.stringMatching(/superstables budget recover --rail evm/) } },
      { verdict: "evm-funds-returned", match: { exit: 1, command: "reconcile", state: "failed", paid: false, amount: "0", tx: { pull: PULL, return: RETURN } } },
      { verdict: "unknown", match: { exit: 5, command: "reconcile", state: "unknown", paid: null, amount: null, next: "the agent key holds 0 USDC; check the owner balance by hand. Never pay again for this op." } },
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
const SIGN_SETTINGS = "a settings signature: the wallet signs typed data or a message, never a transaction, so no answer on this link is about a payment";
const NOT_THIS_KIND = "answers 404 for this kind of owner action, before reading anything; it states no outcome";
const NO_ANSWER_AFTER_BOUNDARY: Record<string, string> = {
  ...Object.fromEntries(["/account", "/signature", "/state", "/reject"].map((r) => [`route eip3009 ${r}`, SIGNS_ONLY])),
  ...Object.fromEntries(["/account", "/prepare", "/signed", "/state", "/reject"].map((r) => [`route solana-transaction ${r}`, SIGNS_ONLY])),
  ...Object.fromEntries(["/state", "/account", "/connect", "/sending", "/sent", "/prepare", "/signed", "/reject", "/cancel"].map((r) => [`route owner:connect ${r}`, SIGN_IN])),
  ...Object.fromEntries(["/state", "/account", "/connect", "/sending", "/sent", "/prepare", "/signed", "/reject", "/cancel"].map((r) => [`route owner:settings ${r}`, SIGN_SETTINGS])),
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
  "command owner": "the owner's settings file (owner settings): it refuses to run without the owner at a terminal and moves no money",
  "command budget": "a group: each of its commands is listed as budget <command>",
  "budget doctor": "keys, addresses, RPC and balances; no payment outcome",
  "budget status": "the budget's allowance, expiry and revocation; no purchase outcome",
  "budget preflight": "reads a seller's price; signs nothing",
  "budget find": "lists services; no payment",
  "budget unlock": "clears locks after the owner stopped every process; it reports lock state only, and its next for an operation is reconcile",
  "budget rotate": "rotate runs recover, revoke, reconcile and setup as child commands; each answers for itself",
};

const REASONS: Record<string, string> = NO_ANSWER_AFTER_BOUNDARY;
/** The declared keys that no row covers and no reason explains. An empty or missing reason explains nothing. */
function unexplained(declared: string[], covered: Set<string>, reasons: Record<string, string | undefined>): string[] {
  return declared.filter((k) => !covered.has(k) && !(typeof reasons[k] === "string" && reasons[k]!.trim() !== ""));
}

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

/** budget/cli.mjs's owner commands on each of its rails, `budget <command> <rail>`, read from its OWNER_COMMANDS_LIST and RAILS. */
function ownerCommandsByRail(): string[] {
  const text = readFileSync(BUDGET, "utf8");
  const commands = JSON.parse(/^const OWNER_COMMANDS_LIST = (\[.*\]);$/m.exec(text)?.[1] ?? "null") as string[] | null;
  const rails = [.../^const RAILS = \{\n((?: {2}\w+: .*\n)+)\};$/m.exec(text)?.[1].matchAll(/^ {2}(\w+):/gm) ?? []].map((m) => m[1]);
  if (!commands?.length || !rails.length) throw new Error("budget/cli.mjs has no one-line OWNER_COMMANDS_LIST or no RAILS table to read");
  return commands.flatMap((c) => rails.map((r) => `budget ${c} ${r}`));
}

/** Each row's own runs check it drove what it covers: the route answered, the state was printed, the command ran. */
function assertCovered(row: Row, seen: Seen[]): void {
  for (const key of row.covers) {
    const [kind, name, route] = key.split(" ");
    if (kind === "route") expect(seen.some((s) => s.step === name && s.route === route), key).toBe(true);
    if (kind === "state") expect(seen.some((s) => s.surface === "pay" && s.body.state === name), key).toBe(true);
    if (kind === "command") expect(seen.some((s) => s.cmd === `superstables ${name}`), key).toBe(true);
    // wait prints the owner command's own RESULT, which names that command; a rail run in process is not the dispatcher
    // `budget <command> <rail>`: that command's own RESULT, on that rail, printed by the dispatcher
    if (kind === "budget" && route) expect(seen.some((s) => s.cmd?.startsWith("budget ") && s.body?.command === name && s.body?.rail === route), key).toBe(true);
    else if (kind === "budget") expect(seen.some((s) => s.cmd === `budget ${name}` || (s.cmd?.startsWith("budget ") && s.body?.command === name)), key).toBe(true);
  }
}

// ---- the rail scan: where an owner command can end failed, and why each place without a proof is safe -------------------

const RAIL_DIRS = ["evm", "solana", "tempo"];
/** The code that answers for an owner approval from outside its rail script: the dispatcher, the worker's record, the pages. */
const ANSWERING = ["budget/approvals.mjs", "budget/owner-page.ts", "budget/hosted.ts", "budget/cli.mjs"];
/**
 * A place that may end failed or not_revoked: the word as a string, wherever it is written (a page verdict, a RESULT's
 * state, a call that takes it, a variable or one arm of a ternary, on one line or on its own line), except where it is
 * compared with (`===`, `case`), listed (`[...]`, `.includes(`, `.has(`), or a type (`| "failed"`). A state put together at
 * run time (from a variable holding another word, or from the rail's own RESULT) is not found here: the dispatcher's
 * default (budget/proof.mjs afterSend) answers unknown for it.
 */
const FAILED_SITE = /(?<!(?:[=!]==?|\bcase|\||\[|["'`]\s*,|\.includes\(|\.has\()\s*)["'`](?:failed|not_revoked)["'`](?!\s*(?:\||:(?!\s*["'`])\s*\w|,\s*["'`][\w ]*["'`]\s*[,\]]))/;
/** A proof written out: `proof: "x"`, `proof?: "x"` (a type), or `proof = a ? "x" : "y"`. */
const PROOF_LITERAL = /\bproof\??\s*[:=]\s*(?:[^;,}]*?\?\s*)?["'](\w+)["'](?:\s*:\s*["'](\w+)["'])?/g;
/** `proof` as a property in code: `proof: x`, `{ proof }`, `, proof,` (strings are taken out first, so words do not count). */
const PROOF_PROPERTY = /(?:^|[{,(\s])proof\??\s*[:,}]/;
/** A line as code: no comment line, no trailing `// ...` comment. */
const codeOf = (text: string) => (/^(\/\/|\*|\/\*)/.test(text) ? "" : text.replace(/\s\/\/\s.*$/, ""));
const withoutStrings = (code: string) => code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
function railLines(): { file: string; line: number; text: string }[] {
  const files = [...RAIL_DIRS.flatMap((dir) => readdirSync(resolve(ROOT, "budget", dir), { recursive: true }).map(String).filter((f) => /\.(ts|mjs)$/.test(f)).sort().map((f) => `budget/${dir}/${f}`)), ...ANSWERING];
  return files.flatMap((file) => readFileSync(resolve(ROOT, file), "utf8").split("\n").map((text, i) => ({ file, line: i + 1, text: codeOf(text.trim()) })));
}

const AFTER_SEND_UNPROVEN = "no chain proof: the transaction was sent and the chain reads otherwise than planned, so the page shows unknown (OwnerApprovalServer.finish) and the dispatcher answers unknown, exit 5 (budget/proof.mjs afterSend; rows: the grant whose read-back fails, the key-file grant that stops after its broadcast)";
const SIGN_IN_ONLY = "setup's sign-in: the owner's wallet signs a message and is never asked to send, so nothing was sent";
const READ_ONLY = "preflight reads a seller's price: it signs and sends nothing";
const BEFORE_SIGNING = "a purchase that ends before anything is signed";
const SOLANA_PURCHASE = "a purchase, not an owner command: the agent's own transaction landed with an error and is final (budget/solana/ops.mjs), so it moved nothing; buy and reconcile answer from the op's journal (normalize in budget/cli.mjs)";
const TEMPO_PURCHASE = "a purchase, not an owner command: the payment's receipt reverted (budget/tempo/lib/resolve.ts), so it moved nothing; buy and reconcile answer from the op's journal (normalize in budget/cli.mjs)";
/** Each place in a rail script that ends failed with no proof on its line, found by `has` in that file, and why it is safe. */
const UNPROVEN_FAILED: { file: string; has: string; why: string }[] = [
  { file: "budget/evm/lib.ts", has: "missing ${k} in ${file}", why: "a key or public file lacks a value: the script stops before it reads the chain or sends anything" },
  { file: "budget/evm/ops.ts", has: "the pull reverted on chain", why: "a purchase, not an owner command: the agreed chain proof evm-pull-reverted (rows: budget reconcile through the dispatcher, the pull reverted)" },
  { file: "budget/evm/ops.ts", has: "was returned to the owner", why: "a purchase, not an owner command: the agreed chain proof evm-funds-returned (rows: budget reconcile ... until the price is back)" },
  { file: "budget/evm/owner.ts", has: "The chain still shows an allowance of", why: AFTER_SEND_UNPROVEN },
  { file: "budget/evm/owner.ts", has: 'state: "not_revoked"', why: AFTER_SEND_UNPROVEN },
  { file: "budget/evm/preflight.ts", has: 'state: bad ? "failed"', why: READ_ONLY },
  { file: "budget/evm/recover.ts", has: "the allowance could not be lowered to 0", why: AFTER_SEND_UNPROVEN },
  { file: "budget/evm/recover.ts", has: 'const state = done ? "ok"', why: AFTER_SEND_UNPROVEN },
  { file: "budget/evm/revoke.ts", has: '"not_revoked"', why: AFTER_SEND_UNPROVEN },
  { file: "budget/evm/setup.ts", has: "That is the agent's own address", why: SIGN_IN_ONLY },
  { file: "budget/evm/setup.ts", has: "not this wallet. Nothing was changed.", why: SIGN_IN_ONLY },
  { file: "budget/solana/buy.mjs", has: '"own transaction failed on chain"', why: SOLANA_PURCHASE },
  { file: "budget/solana/buy.mjs", has: "{ tx: own.sig, delivered: false, next:", why: SOLANA_PURCHASE },
  { file: "budget/solana/buy.mjs", has: '"own transaction landed and failed"', why: SOLANA_PURCHASE },
  { file: "budget/solana/buy.mjs", has: "reason: oneLine(JSON.stringify(assessment.err), 300)", why: SOLANA_PURCHASE },
  { file: "budget/solana/reconcile.mjs", has: "reconcile: own transaction failed on chain", why: SOLANA_PURCHASE },
  { file: "budget/solana/reconcile.mjs", has: 'emit(result("failed"', why: SOLANA_PURCHASE },
  { file: "budget/solana/revokeBudget.ts", has: "The chain still shows delegate", why: AFTER_SEND_UNPROVEN },
  { file: "budget/solana/revokeBudget.ts", has: "a delegate still reads on chain", why: AFTER_SEND_UNPROVEN },
  { file: "budget/solana/setup.ts", has: "That is the agent's own address", why: SIGN_IN_ONLY },
  { file: "budget/tempo/buy.ts", has: "signing_failed", why: BEFORE_SIGNING },
  { file: "budget/tempo/buy.ts", has: "reason: j.note", why: TEMPO_PURCHASE },
  { file: "budget/tempo/buy.ts", has: "error before signing", why: BEFORE_SIGNING },
  { file: "budget/tempo/preflight.ts", has: "seller unreachable", why: READ_ONLY },
  { file: "budget/tempo/preflight.ts", has: "the seller did not ask for payment", why: READ_ONLY },
  { file: "budget/tempo/preflight.ts", has: "no tempo.charge offer", why: READ_ONLY },
  { file: "budget/tempo/preflight.ts", has: "offer cannot be paid", why: READ_ONLY },
  { file: "budget/tempo/preflight.ts", has: "main().catch((err) => result('failed'", why: READ_ONLY },
  { file: "budget/tempo/reconcile.ts", has: "done('failed'", why: TEMPO_PURCHASE },
  { file: "budget/tempo/revokeBudget.ts", has: "The chain still shows the key as live", why: AFTER_SEND_UNPROVEN },
  { file: "budget/tempo/revokeBudget.ts", has: "the key still reads as live on chain", why: AFTER_SEND_UNPROVEN },
  { file: "budget/tempo/revokeBudget.ts", has: "scanFailed ? 'failed'", why: "the chain shows the key revoked, but the scan of its payment sessions failed: with no proof the dispatcher answers unknown (budget/proof.mjs afterSend), which is what the exposure is" },
  { file: "budget/tempo/setup.ts", has: "That is the agent's own address", why: SIGN_IN_ONLY },
  { file: "budget/tempo/setup.ts", has: "This machine records another owner for this agent", why: SIGN_IN_ONLY },
  { file: "budget/tempo/setup.ts", has: "not this wallet. Nothing was changed.", why: SIGN_IN_ONLY },
  { file: "budget/tempo/setup.ts", has: "The owner's signature did not come back", why: SIGN_IN_ONLY },
  { file: "budget/tempo/lib/resolve.ts", has: "payment transaction reverted on chain", why: TEMPO_PURCHASE },
  { file: "budget/evm/ops.ts", has: 'return { j, verdict: "failed" };', why: "a purchase's verdict inside ops.ts, after it saved one of the agreed chain proofs evm-pull-reverted or evm-funds-returned (the two places above)" },
  { file: "budget/solana/ops.mjs", has: '{ verdict: "failed", tx: t.sig, err: t.err', why: SOLANA_PURCHASE },
  { file: "budget/solana/owner.ts", has: 'status: tx.meta?.err ? "failed" : "success"', why: "the chain's own status for a transaction it shows with an error (meta.err): the rails name it as the reverted proof only when the transaction is the requested one (budget/site.mjs differsFromRequest)" },
  { file: "budget/approvals.mjs", has: 'state: "failed", id, next: "check wallet activity and budget status before retrying"', why: "the link wait or the worker's exit before any page: decided under the record's lock (recordFinalWith), failed only when the record holds no send (recordMayHaveSent), else unknown (rows: budget recover, detached ...)" },
  { file: "budget/approvals.mjs", has: '{ kind: "failed", record, reason: failedReason }', why: "startDetached's own result, not an answer: only after the worker's group stopped, and with no send on the record when it stored that under the record's lock; a group that would not stop is kind unstopped, which the dispatcher's ownerGate answers unknown" },
  { file: "budget/cli.mjs", has: "emit(2, { ...ctx, state: \"failed\", next: `fix the command; see superstables budget ${ctx.command", why: "badInput: through emit, whose afterSend answers unknown for an owner command that may have sent" },
  { file: "budget/cli.mjs", has: "native Windows is not supported; use WSL", why: "refused before any command runs" },
  { file: "budget/cli.mjs", has: "a checkout without dev packages needs its dist/budget build", why: "refused before any command runs" },
  { file: "budget/cli.mjs", has: "the rail script rejected the input", why: "normalize serves buy and reconcile only: the rail refused its flags before it read the journal or signed anything" },
  { file: "budget/cli.mjs", has: 'const state = ["buy", "reconcile"].includes(cmd) ? "unknown" : "failed";', why: "normalize serves buy and reconcile only, and both take unknown here; failed is for a command that is neither, which no caller passes" },
  { file: "budget/cli.mjs", has: "doctor check", why: "doctor reads files and the chain; it sends nothing" },
  { file: "budget/cli.mjs", has: "the preflight script exited ${r.code} without a RESULT line", why: READ_ONLY },
  { file: "budget/cli.mjs", has: 'state: ok ? "ok" : "failed", amount: ok ? rr.price', why: READ_ONLY },
  { file: "budget/cli.mjs", has: "no budget yet in ${HOME}", why: "status reads files and the chain; it sends nothing" },
  { file: "budget/cli.mjs", has: "setup is done, but the budget could not be read from the chain", why: "status reads files and the chain; it sends nothing" },
  { file: "budget/cli.mjs", has: "const OWNER_STATES = {", why: "the map from a rail's state to the dispatcher's: every owner command's answer then goes through emit's afterSend, which keeps failed only with the chain's proof" },
  { file: "budget/cli.mjs", has: 'const byCode = { 0: "settled", 2: "failed"', why: "ownerOutcome's state for an exit code: every owner command's answer then goes through emit's afterSend, which keeps failed only with the chain's proof" },
  { file: "budget/cli.mjs", has: 'state: rr?.state ?? "failed", owner: rr?.owner', why: "setup --fund-only on tempo: the faucet tops up the owner, and the answer goes through emit's afterSend like every owner command" },
  { file: "budget/cli.mjs", has: 'return emit(1, { ...ctx, state: "failed", id, next: `check wallet activity before retrying', why: "startDetached's failed: the worker's group stopped with no send on its record, stored under the record's lock (budget/approvals.mjs endWithoutLink); a group that would not stop answers unknown (row: its process group would not stop)" },
  { file: "budget/cli.mjs", has: 'emit(2, { ...ctx, service: f.service, state: "failed"', why: "buy-once's bad input, before any purchase exists on the site" },
  { file: "budget/cli.mjs", has: 'this site has no purchase API; a service can still be paid from a budget', why: "find reads a site's service list; it sends nothing" },
  { file: "budget/cli.mjs", has: "no list to show; ${any}", why: "find reads a site's service list; it sends nothing" },
];

describe("the send mark a rail keeps on its approval record (budget/proof.mjs sendBegins)", () => {
  it("lets no broadcast leave without the mark: none for an approval with no record here, and the mark on one that has a record", async () => {
    const script = `const p = await import(${JSON.stringify(resolve(ROOT, "budget/proof.mjs"))});
      const a = await import(${JSON.stringify(resolve(ROOT, "budget/approvals.mjs"))});
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] });
      const attempt = (id) => { process.env[a.HOLDER_ENV] = id; try { p.markSend(body); return "broadcast"; } catch (e) { return "refused: " + e.message; } };
      const kept = a.newApprovalId();
      a.startForeground({ id: kept, command: "grant", rail: "evm", chain: "base-sepolia" });
      const missing = a.newApprovalId();
      console.log("MARK " + JSON.stringify({ missing, refused: attempt(missing), record: a.readApproval(missing), kept: attempt(kept), sending: a.readApproval(kept)?.sending ?? null }));`;
    const ran = await exec(["--input-type=module", "-e", script], budgetEnv(newHome()));
    const mark = JSON.parse(ran.stdout.split("\n").find((l) => l.startsWith("MARK "))!.slice(5));
    expect(mark).toEqual({ missing: mark.missing, refused: `refused: approval ${mark.missing} has no record on this machine to keep this send on; this transaction is not sent`, record: null, kept: "broadcast", sending: true });
  });
});

describe("once money may have moved, every answer says unknown or uncertain", () => {
  for (const row of ROWS) {
    it(row.path, async () => {
      const seen = await row.run();
      expect(seen.map((s) => s.at), "one expectation per output").toHaveLength(row.expect.length);
      seen.forEach((s, i) => assertProperty(s, row.expect[i]));
      assertCovered(row, seen);
    }, row.timeout ?? 60_000);
  }

  it("refuses a not-paid field on any answer past the boundary, and a listed key whose reason is empty", () => {
    const wait = (body: Record<string, unknown>): Seen => ({ at: "self-test", surface: "budget", cmd: "budget wait", exit: 2, body: { command: "wait", state: "show_owner_first", next: "this wait did not read the approval, so whether the owner approved or paid is not known. Then wait --shown.", ...body }, text: "" });
    const check = (body: Record<string, unknown>) => () => assertProperty(wait(body), { verdict: "unknown", match: {} });
    expect(check({})).not.toThrow();
    expect(check({ paid: false })).toThrow(/self-test \(budget wait\): paid/);
    expect(check({ amount: "0" })).toThrow(/self-test \(budget wait\): amount/);
    expect(check({ money_moved: false })).toThrow(/self-test \(budget wait\): money_moved/);
    expect(check({ pending: { paid: false } })).toThrow(/self-test \(budget wait\): pending\.paid/);
    expect(check({ steps: [{ amount: "0" }] })).toThrow(/self-test \(budget wait\): steps\.0\.amount/);
    expect(check({ steps: [{ kind: "grant", state: "failed", proof: "reverted", tx: "0x1" }] })).not.toThrow();
    expect(check({ steps: [{ kind: "grant", state: "failed", tx: "0x1" }] })).toThrow(/self-test \(budget wait\): steps\.0\.state/);
    expect(check({ steps: [{ kind: "grant", state: "failed", proof: "the site said so", tx: "0x1" }] })).toThrow(/self-test \(budget wait\): steps\.0\.state/);
    expect(unexplained(["route a /x", "route a /y", "route a /z", "route a /w"], new Set(["route a /x"]), { "route a /y": "", "route a /z": undefined, "route a /w": "it signs only" })).toEqual(["route a /y", "route a /z"]);
    expect(unexplained(["route a /y"], new Set(), { "route a /y": "   " })).toEqual(["route a /y"]);
  });

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
      ...ownerCommandsByRail(),
    ];
    expect(declared).toEqual(expect.arrayContaining(["route tempo-transfer /sending", "route owner:evm-transaction /sending", "budget fund-agent solana", "budget grant tempo"]));
    const covered = new Set(ROWS.flatMap((r) => r.covers));
    expect(unexplained(declared, covered, REASONS), "declared, with no row and no reason").toEqual([]);
    expect([...covered, ...Object.keys(REASONS)].filter((k) => !declared.includes(k)), "listed, but not declared").toEqual([]);
    expect([...covered].filter((k) => k in REASONS), "both covered by a row and listed with a reason").toEqual([]);
    // every attempt state is either said after the boundary, and then a row covers it (the row checks it printed it), or never is
    const said = new Set<string | undefined>([...SAYS.unknown.pay, ...SAYS.paid.pay, EXCEPTIONS["pay-chain-unpaid"].state]);
    for (const state of ATTEMPT_STATES) {
      if (said.has(state)) expect(covered.has(`state ${state}`), `no row covers ${state}`).toBe(true);
      else expect(FORBIDDEN_STATES.pay, `${state} is neither said nor forbidden`).toContain(state);
    }
  }, 60_000);

  it("lets no rail script end failed after it may have sent unless it names the chain's proof, or a reason says why that place is safe", () => {
    // the scan itself: what it counts as a place that ends failed, and as a proof
    const site = (l: string) => FAILED_SITE.test(codeOf(l.trim()));
    expect(['finish?.({ outcome: "failed", message: "x" })', "{ state: x ? 'not_revoked' : 'revoked' }", 'const state = a ? "ok" : "failed";', 'report("failed", why)', ': "failed",', 'state: `failed`,', 'const s = "failed";', 'return { kind: "failed", record };', 'const M = { gone: "failed", ok: "settled" };'].map(site)).toEqual(Array(9).fill(true));
    expect(['if (j.state === "failed") x()', 'type R = { state: "settled" | "failed" }', 'const n = ["failed", "unknown"].length', 'const n = ["sent", "failed", "unknown"].length', 'case "failed":', 'if (x.includes("failed")) y()', 'new Set(["sent", "failed"])', '// state: "failed"', ' * state: "failed"', 'a(); // ends "failed"', 'x !== "not_revoked"'].map(site)).toEqual(Array(11).fill(false));
    const proofProperty = (l: string) => PROOF_PROPERTY.test(withoutStrings(codeOf(l.trim())));
    expect(['{ state: "failed", proof: "reverted" }', '{ outcome: "failed", proof, message }', '...(r ? { proof: "reverted" } : {})', 'proof?: "reverted"'].map(proofProperty)).toEqual([true, true, true, true]);
    expect(['{ state: "failed", reason: "no proof, sadly" }', '{ state: "failed" } // proof: none', 'const proofs = 1;'].map(proofProperty)).toEqual([false, false, false]);
    expect([...'{ proof: "reverted" } const proof = c.status === "expired" ? "blockhash_expired" : "reverted";'.matchAll(PROOF_LITERAL)].flatMap((m) => [m[1], m[2]].filter(Boolean))).toEqual(["reverted", "blockhash_expired", "reverted"]);
    const lines = railLines();
    const sites = lines.filter((l) => FAILED_SITE.test(l.text));
    const unproven = sites.filter((l) => !PROOF_PROPERTY.test(withoutStrings(l.text)));
    const listed = (l: { file: string; text: string }) => UNPROVEN_FAILED.filter((u) => u.file === l.file && l.text.includes(u.has));
    expect(sites.length - unproven.length, "places that name a proof").toBeGreaterThanOrEqual(18);
    expect(unproven.filter((l) => listed(l).length !== 1).map((l) => `${l.file}:${l.line}: ${l.text}`), "ends failed with no proof and no reason (or two reasons)").toEqual([]);
    expect(UNPROVEN_FAILED.filter((u) => !unproven.some((l) => u.file === l.file && l.text.includes(u.has))).map((u) => `${u.file}: ${u.has}`), "listed, but no such place without a proof").toEqual([]);
    expect(UNPROVEN_FAILED.filter((u) => u.why.trim() === "").map((u) => u.has), "listed with an empty reason").toEqual([]);
    const proofs = lines.flatMap((l) => [...l.text.matchAll(PROOF_LITERAL)].flatMap((m) => [m[1], m[2]].filter(Boolean).map((value) => ({ at: `${l.file}:${l.line}`, value }))));
    expect(new Set(proofs.map((p) => p.value)), "the proofs the rails name").toEqual(new Set(Object.keys(PROOFS)));
    expect(proofs.filter((p) => !Object.hasOwn(PROOFS, p.value)), "a proof that budget/proof.mjs does not define").toEqual([]);
  });
});
