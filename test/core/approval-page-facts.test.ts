// What the owner sees on the `pay` approval page before anything is signed, and what the page's server writes down.
//
// The page names the seller this client calls, the spend policy that applied, how long what the wallet signs stays
// valid, and what the wallet's own prompt will show. Text from the seller reaches it only cleaned and bounded, under its
// own label. Only the page's own scripts run. And the approval id, which opens the page, is on disk only as a hash.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ events: [] as string[], paths: new Map<number, string>(), failFsync: false }));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args);
    io.paths.set(fd, String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const fsyncSync = ((fd: number) => {
    const path = io.paths.get(fd);
    if (path !== undefined) io.events.push(`fsync ${basename(path)}`);
    if (io.failFsync) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    return actual.fsyncSync(fd);
  }) as typeof actual.fsyncSync;
  return { ...actual, default: { ...actual, openSync, fsyncSync }, openSync, fsyncSync };
});

import { ARBITRUM_SEPOLIA, ROBINHOOD_TESTNET, SKALE_BASE_SEPOLIA, SOLANA_DEVNET, TEMPO_MODERATO, usdcRequirement, type EvmNetwork } from "../../src/core/chain.js";
import { PaymentEngine } from "../../src/core/pay.js";
import { DEFAULT_POLICY, type Policy } from "../../src/core/policy.js";
import { quote } from "../../src/core/quote.js";
import { judgeAccept } from "../../src/core/rails/index.js";
import { Records } from "../../src/core/records.js";
import { APPROVAL_PAGE_SCRIPT, approvalPage, type ApprovalPageFacts } from "../../src/core/signer/approval-page.js";
import { ApprovalServer } from "../../src/core/signer/approval-server.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { solanaStep } from "../../src/core/signer/steps/solana.js";
import { tempoStep } from "../../src/core/signer/steps/tempo.js";
import { WalletSigner } from "../../src/core/signer/wallet.js";
import { SignRefused, type Eip3009SignRequest, type SignRequest } from "../../src/core/signer/types.js";
import type { RawAccept } from "../../src/core/x402.js";
import type { Attempt } from "../../src/core/types.js";
import { MINT, randomAddress } from "../helpers/fake-solana-pay.js";
import { startFacilitator, startPaidEndpoint, startWallet, type TestServer } from "../helpers/servers.js";

const PRICE = 0.01;
const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const NAMES = ["SUPERSTABLES_POLICY", "SUPERSTABLES_HOME", "SUPERSTABLES_TEST_ACCOUNT_HOME"] as const;

let base: string;
const saved: Record<string, string | undefined> = {};
const opened: BrowserWalletSigner[] = [];
const servers: ApprovalServer[] = [];
const stopped: TestServer[] = [];

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "superstables-page-facts-"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const name of NAMES) saved[name] = process.env[name];
  io.events.length = 0;
  io.paths.clear();
  io.failFsync = false;
});
afterEach(async () => {
  io.failFsync = false;
  vi.restoreAllMocks();
  while (opened.length > 0) await opened.pop()?.close();
  while (servers.length > 0) await servers.pop()?.close();
  await Promise.all(stopped.splice(0).map((s) => s.close()));
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

/** Enough of a DOM element for the page's script. */
class FakeNode {
  hidden = false;
  disabled = false;
  className = "";
  text = "";
  attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  get textContent() {
    return this.text;
  }
  set textContent(value: string) {
    this.text = String(value);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  closest(selector: string) {
    return selector === "button[data-act]" && this.tag === "button" ? this : null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

function newHome(): string {
  return mkdtempSync(join(base, "home-"));
}

/** A signer with a home of its own. With no policy option it reads the policy itself, as the CLI does. */
function newSigner(options: { policy?: Policy; home?: string } = {}): { signer: BrowserWalletSigner; home: string } {
  const home = options.home ?? newHome();
  const signer = new BrowserWalletSigner({ port: 0, home, timeoutMs: 5_000, balance: false, ...(options.policy ? { policy: options.policy } : {}) });
  opened.push(signer);
  return { signer, home };
}

function signRequest(context?: SignRequest["context"], maxTimeoutSeconds?: number, network?: EvmNetwork): Eip3009SignRequest {
  const requirements = usdcRequirement(PRICE, SELLER, network);
  return { kind: "eip3009", requirements: maxTimeoutSeconds === undefined ? requirements : { ...requirements, maxTimeoutSeconds }, x402Version: 2, context };
}

async function waitFor(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the signer");
    await new Promise((done) => setTimeout(done, 10));
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Open one approval page on a signer, fetch it, reject it, and hand back what the owner would have seen. */
async function seen(
  context?: SignRequest["context"],
  options: { signer?: BrowserWalletSigner; home?: string; policy?: Policy; maxTimeoutSeconds?: number; network?: EvmNetwork } = {},
) {
  const made = options.signer ? { signer: options.signer, home: options.home ?? "" } : newSigner({ policy: options.policy ?? DEFAULT_POLICY });
  let link = "";
  const pending = made.signer.sign(signRequest(context, options.maxTimeoutSeconds, options.network), { onPending: (_id, url) => (link = url ?? "") }).catch(() => undefined);
  await waitFor(() => link !== "");
  const page = await fetch(link);
  const html = await page.text();
  const state = (await (await fetch(`${link}/state`)).json()) as { reported?: { description?: string } };
  await postJson(`${link}/reject`, {});
  await pending;
  return { html, headers: page.headers, state, link, home: made.home };
}

/** The `reported` block of a page, from its opening div to the status line after it. */
function reportedOf(html: string): string {
  const start = html.indexOf('<div class="reported">');
  const end = html.indexOf('<div id="say"', start);
  return html.slice(start, end);
}

function rowOf(html: string, label: string): string {
  const at = html.indexOf(`<dt>${label}</dt>`);
  if (at < 0) return "";
  return html.slice(at, html.indexOf("</dd>", at));
}

const tempoFacts = (over: Partial<ApprovalPageFacts> = {}): ApprovalPageFacts =>
  ({
    id: "a".repeat(32),
    step: "tempo-transfer",
    amountDecimal: PRICE,
    asset: "pathUSD",
    amountAtomic: "10000",
    recipient: `0x${"22".repeat(20)}`,
    network: TEMPO_MODERATO.caip2,
    networkLabel: "Tempo Moderato (testnet)",
    assetAddress: TEMPO_MODERATO.token.address,
    expiresAt: Date.now() + 60_000,
    ...tempoStep.pageFacts({} as never),
    ...over,
  }) as ApprovalPageFacts;

const solanaFacts = (over: Partial<ApprovalPageFacts> = {}): ApprovalPageFacts =>
  ({
    id: "b".repeat(32),
    step: "solana-transaction",
    amountDecimal: PRICE,
    asset: "USDC",
    amountAtomic: "10000",
    recipient: randomAddress(),
    network: SOLANA_DEVNET.caip2,
    networkLabel: "Solana devnet",
    assetAddress: randomAddress(),
    expiresAt: Date.now() + 60_000,
    ...solanaStep.pageFacts({ network: SOLANA_DEVNET } as never),
    ...over,
  }) as ApprovalPageFacts;

const policyFile = (name: string, text: string): string => {
  const path = join(newHome(), name);
  writeFileSync(path, text);
  return path;
};

// ── a. The seller ────────────────────────────────────────────────────────────────────────

describe("the seller line", () => {
  it("names the scheme and host of the URL this client called, outside the agent's block", async () => {
    const { html } = await seen({ target: "https://api.seller.example/paid", serviceName: "Market data" });
    expect(html).toContain('<div id="seller" class="seller"><span class="scheme">https://</span>api.seller.example</div>');
    expect(reportedOf(html)).not.toContain("api.seller.example");
    expect(reportedOf(html)).toContain("Market data");
  });

  it("marks plain http, which only a seller on this machine may use", async () => {
    const { html } = await seen({ target: "http://127.0.0.1:48151/x" });
    expect(html).toContain('<div id="seller" class="seller plain"><span class="scheme">http://</span>127.0.0.1:48151</div>');
    expect(html).toContain("Plain http: not encrypted");
  });

  it("shows a look-alike host the way the URL parser writes it, never decoded", async () => {
    const { html } = await seen({ target: "https://\u0430pple.example/" });
    expect(html).toContain('<div id="seller" class="seller"><span class="scheme">https://</span>xn--pple-43d.example</div>');
    // the visible card never shows the look-alike spelling (the facts block holds the cleaned target as data)
    expect(html.slice(html.indexOf('<div class="card">'), html.indexOf('<script id="approval-facts"'))).not.toContain("\u0430pple");
  });

  it("shows no seller for a target that is not an http(s) URL, and says so", async () => {
    const { html } = await seen({ target: "javascript:alert(1)" });
    expect(html).not.toContain('id="seller"');
    expect(html).toContain("did not say which seller");
  });

  it("says the same when the program named no target", async () => {
    const { html } = await seen(undefined);
    expect(html).not.toContain('id="seller"');
    expect(html).toContain("did not say which seller");
  });
});

// ── b. The policy ────────────────────────────────────────────────────────────────────────

describe("the policy rows", () => {
  it("name the file in use and its caps, and that it was chosen for this command", async () => {
    const file = policyFile("chosen.yaml", "caps:\n  per_call: 0.02 USDC\n  per_day: 0.5 USDC\n");
    process.env.SUPERSTABLES_POLICY = file;
    process.env.SUPERSTABLES_HOME = newHome();
    const { html } = await seen({ target: "https://api.seller.example/paid" }, { signer: newSigner().signer });
    expect(rowOf(html, "Spend policy")).toContain(file);
    expect(rowOf(html, "Spend policy")).toContain("chosen for this command");
    expect(rowOf(html, "Caps")).toContain("0.02 USDC a payment, 0.5 USDC a day");
  });

  it("shows /dev/null, the default caps and the account's own policy that also applies", async () => {
    const account = newHome();
    mkdirSync(join(account, ".superstables"), { recursive: true });
    const accountFile = join(account, ".superstables", "policy.yaml");
    writeFileSync(accountFile, "caps:\n  per_call: 0.03 USDC\n  per_day: 0.7 USDC\n");
    process.env.SUPERSTABLES_TEST_ACCOUNT_HOME = account;
    process.env.SUPERSTABLES_POLICY = "/dev/null";
    process.env.SUPERSTABLES_HOME = newHome();
    const { html } = await seen({ target: "https://api.seller.example/paid" }, { signer: newSigner().signer });
    expect(rowOf(html, "Spend policy")).toContain("/dev/null");
    expect(rowOf(html, "Spend policy")).toContain("chosen for this command");
    expect(rowOf(html, "Caps")).toContain(`${DEFAULT_POLICY.perCall?.amount} USDC a payment`);
    expect(rowOf(html, "Also applies")).toContain(accountFile);
    expect(rowOf(html, "Also applies")).toContain("0.03 USDC a payment, 0.7 USDC a day");
  });

  it("says when there is no file and the built-in defaults applied", async () => {
    const missing = join(newHome(), "missing.yaml");
    process.env.SUPERSTABLES_POLICY = missing;
    process.env.SUPERSTABLES_HOME = newHome();
    const { html } = await seen({ target: "https://api.seller.example/paid" }, { signer: newSigner().signer });
    expect(rowOf(html, "Spend policy")).toContain(`built-in defaults (no file at ${missing})`);
  });

  it("says a policy object came from the program that asked, with no 'chosen' tag", async () => {
    const { html } = await seen({ target: "https://api.seller.example/paid" }, { policy: DEFAULT_POLICY });
    expect(rowOf(html, "Spend policy")).toContain("set by the program that asked for this payment");
    expect(html).not.toContain("chosen for this command");
  });

  it("cleans a policy path of control and format characters and escapes the rest", async () => {
    const hostile = join(newHome(), "p\u202e<script>x.yaml");
    process.env.SUPERSTABLES_POLICY = hostile;
    process.env.SUPERSTABLES_HOME = newHome();
    const { html } = await seen({ target: "https://api.seller.example/paid" }, { signer: newSigner().signer });
    expect(html).not.toContain("\u202e");
    expect(rowOf(html, "Spend policy")).toContain("&lt;script&gt;");
    expect(html.match(/<script/g)).toHaveLength(2);
  });
});

// ── c. Valid until ───────────────────────────────────────────────────────────────────────

describe("how long what the wallet signs stays valid", () => {
  it("says, before connecting, how long an EVM authorization lasts", async () => {
    const ten = await seen({ target: "https://api.seller.example/paid" }, { maxTimeoutSeconds: 3600 });
    expect(rowOf(ten.html, "Valid until")).toContain("10 minutes after you connect your wallet");
    const five = await seen({ target: "https://api.seller.example/paid" }, { maxTimeoutSeconds: 300 });
    expect(rowOf(five.html, "Valid until")).toContain("5 minutes after you connect your wallet");
  });

  it("says a window that is not whole minutes exactly, never rounded", async () => {
    const at = async (seconds: number) => rowOf((await seen({ target: "https://api.seller.example/paid" }, { maxTimeoutSeconds: seconds })).html, "Valid until");
    expect(await at(90)).toContain("1 min 30 s after you connect your wallet");
    expect(await at(30)).toContain("30 seconds after you connect your wallet");
    expect(await at(1)).toContain("1 second after you connect your wallet");
    expect(await at(1)).not.toContain("1 seconds");
    expect(await at(60)).toContain("1 minute after you connect your wallet");
    expect(rowOf(approvalPage(solanaFacts(), solanaStep), "Valid until")).toContain("about 1 minute");
  });

  it("says a Tempo transfer is sent at once, and a Solana transaction lives about a minute", () => {
    expect(rowOf(approvalPage(tempoFacts(), tempoStep), "Valid until")).toContain("Your wallet sends it at once, as one transfer. It grants nothing that can be used again.");
    expect(rowOf(approvalPage(solanaFacts(), solanaStep), "Valid until")).toContain("about 1 minute after you press");
  });

  it("never offers a page for a seller's window of a billion seconds, and says ten minutes for the longest it takes", async () => {
    const { signer } = newSigner({ policy: DEFAULT_POLICY });
    const refused = await signer.sign(signRequest({ target: "https://api.seller.example/paid" }, 1_000_000_000)).then(() => undefined, (err: unknown) => err);
    expect(refused).toBeInstanceOf(SignRefused);
    expect(signer.url).toBe("");
    const longest = await seen({ target: "https://api.seller.example/paid" }, { maxTimeoutSeconds: 3_600 });
    expect(rowOf(longest.html, "Valid until")).toContain("10 minutes after you connect your wallet");
    expect(rowOf(longest.html, "Valid until")).not.toContain("60 minutes");
  });

  it("calls the approval window 'Approve within'", async () => {
    const { html } = await seen({ target: "https://api.seller.example/paid" });
    expect(html).toContain("<dt>Approve within</dt>");
    expect(html).not.toContain("Expires in");
  });

  it("fills in the exact local time from the typed data once connected, and takes it back when the account changes", async () => {
    const nodes = new Map<string, FakeNode>();
    const node = (id: string) => {
      let n = nodes.get(id);
      if (!n) nodes.set(id, (n = new FakeNode(["connect", "approve", "reject"].includes(id) ? "button" : "div")));
      return n;
    };
    const OWNER = "0x1111111111111111111111111111111111111111";
    const facts = { ...tempoFacts(), step: "eip3009", chainIdHex: "0x14a34", chainName: "Base Sepolia", validity: { kind: "authorization", seconds: 600 } };
    node("approval-facts").textContent = JSON.stringify(facts);
    node("valid-until").textContent = "10 minutes after you connect your wallet";
    node("valid-until").setAttribute("data-before", "10 minutes after you connect your wallet");
    for (const act of ["connect", "approve", "reject"]) node(act).setAttribute("data-act", act);
    const validBefore = String(Math.floor(Date.now() / 1000) + 600);
    const listeners = new Map<string, (value: unknown) => void>();
    let onClick: (event: { target: unknown }) => void = () => {};
    const document = {
      body: node("body"),
      getElementById: node,
      querySelectorAll: () => [node("connect"), node("approve"), node("reject")],
      addEventListener: (type: string, fn: typeof onClick) => {
        if (type === "click") onClick = fn;
      },
    };
    const fetchStub = async (url: string, init?: { method?: string }) => {
      if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ status: "pending" }) };
      if (url.endsWith("/account")) return { ok: true, status: 200, json: async () => ({ typedData: { message: { validBefore } } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const ethereum = {
      on: (event: string, fn: (value: unknown) => void) => void listeners.set(event, fn),
      request: async ({ method }: { method: string }) => (method === "eth_requestAccounts" ? [OWNER] : method === "eth_chainId" ? "0x14a34" : null),
    };
    runInNewContext(APPROVAL_PAGE_SCRIPT, { window: { ethereum }, document, fetch: fetchStub, setInterval: () => 0, setTimeout, Date, JSON, String, Math, Error, Promise });
    onClick({ target: node("connect") });
    await new Promise((done) => setTimeout(done, 50));
    expect(node("valid-until").textContent).toMatch(/your time \(10 min from now\)/);
    expect(node("valid-before-raw").textContent).toContain(validBefore);
    listeners.get("accountsChanged")?.([OWNER.replace("1111", "2222")]);
    expect(node("valid-until").textContent).toBe("10 minutes after you connect your wallet");
    expect(node("valid-before-raw").textContent).toBe("");
  });
});

// ── d. What the seller says ──────────────────────────────────────────────────────────────

describe("the seller's description", () => {
  const hostile = `\u202e${"A".repeat(4_990)}\u{E0041}</div><script>x()</script>`;

  it("is cleaned, cut to 200 characters, labelled as the seller's, and adds no script", async () => {
    const { html } = await seen({ target: "https://api.seller.example/paid", description: hostile });
    const says = html.slice(html.indexOf("The seller says (not verified)"));
    expect(says).toContain(`${"A".repeat(199)}…`);
    expect(html).not.toContain("A".repeat(200));
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u{E0041}");
    expect(html.match(/<script/g)).toHaveLength(2);
  });

  it("adds no script on a Solana page either", async () => {
    const accept: RawAccept = { scheme: "exact", network: SOLANA_DEVNET.caip2, amount: "10000", asset: MINT, payTo: randomAddress(), maxTimeoutSeconds: 60, extra: { feePayer: randomAddress() } };
    const judged = judgeAccept(accept, 2);
    if (!judged.supported) throw new Error(judged.reason);
    const server = new ApprovalServer({ port: 0, recordsDirPath: join(newHome(), "records") });
    servers.push(server);
    await server.start();
    const handle = server.request({
      kind: "solana-transaction",
      verified: { ...judged.offer.terms, payer: "" },
      reported: { target: "https://seller.example/paid", description: hostile },
      requirement: judged.offer.requirement,
      x402Version: 2,
      timeoutMs: 60_000,
    });
    const html = await (await fetch(handle.url)).text();
    expect(html.match(/<script/g)).toHaveLength(3);
    expect(html).toContain("The seller says (not verified)");
    expect(html).not.toContain("A".repeat(200));
  });

  it("is the same bounded text in /state", async () => {
    const { state } = await seen({ target: "https://api.seller.example/paid", description: hostile });
    expect(state.reported?.description).toBe(`${"A".repeat(199)}…`);
  });

  it("is the same bounded text in approvals.jsonl", async () => {
    const { home } = await seen({ target: "https://api.seller.example/paid", description: hostile });
    const lines = readFileSync(join(home, "records", "approvals.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect((JSON.parse(line) as { reported: { description: string } }).reported.description).toBe(`${"A".repeat(199)}…`);
  });

  it("keeps no more than two combining marks in a row, and its box clips what is left", async () => {
    const zalgo = `Z${"\u0301".repeat(198)}`;
    const { html, state } = await seen({ target: "https://api.seller.example/paid", description: zalgo, serviceName: zalgo });
    expect(state.reported?.description).toBe("Z\u0301\u0301");
    expect(html).not.toMatch(/\p{M}{3}/u);
    expect(html).toContain(".says, .reported { overflow: hidden; }");
  });

  it("is never cut inside a surrogate pair", async () => {
    const { state } = await seen({ target: "https://api.seller.example/paid", description: `${"A".repeat(198)}\u{1F600}${"B".repeat(300)}` });
    const text = state.reported?.description ?? "";
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

// ── e. Content security policy ───────────────────────────────────────────────────────────

describe("the page's content security policy", () => {
  it("allows only scripts that carry this response's nonce", async () => {
    const first = await seen({ target: "https://api.seller.example/paid" });
    const csp = first.headers.get("content-security-policy") ?? "";
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]{24})'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    for (const tag of first.html.match(/<script(?![^>]*type="application\/json")[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${nonce}"`);
    expect(first.html.match(/<script(?![^>]*type="application\/json")[^>]*>/g)).toHaveLength(1);
    for (const part of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(part);
    const second = await seen({ target: "https://api.seller.example/paid" });
    const other = /script-src 'nonce-([A-Za-z0-9+/=]{24})'/.exec(second.headers.get("content-security-policy") ?? "")?.[1];
    expect(other).toBeDefined();
    expect(other).not.toBe(nonce);
  });

  it("allows no script at all on the not-found page", async () => {
    const { signer } = newSigner({ policy: DEFAULT_POLICY });
    await signer.start();
    const page = await fetch(`${signer.url}/approve/${"0".repeat(32)}`);
    expect(page.status).toBe(404);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("puts a nonce on the page's own scripts only when it is given one", () => {
    expect(approvalPage(tempoFacts(), tempoStep)).not.toContain("nonce=");
    const withNonce = approvalPage(tempoFacts(), tempoStep, undefined, "abc123==");
    expect(withNonce.match(/<script nonce="abc123==">/g)).toHaveLength(2);
    expect(withNonce).toContain('<script id="approval-facts" type="application/json">');
  });
});

// ── f. The approval id on disk ───────────────────────────────────────────────────────────

describe("the approval id in the records", () => {
  const hashOf = (id: string) => `sha256:${createHash("sha256").update(id).digest("hex")}`;

  async function rejectedPayment() {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    stopped.push(facilitator, seller);
    const { signer, home } = newSigner({ policy: DEFAULT_POLICY });
    const recordsDir = join(newHome(), "records");
    const records = new Records(recordsDir);
    const engine = new PaymentEngine({ records, policy: { ...DEFAULT_POLICY }, signer });
    const taken = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records, policy: DEFAULT_POLICY });
    const linked = new Promise<string>((resolve) => {
      const on = (attempt: Attempt) => {
        if (!attempt.approvalUrl) return;
        engine.events.off("transition", on);
        resolve(attempt.approvalUrl);
      };
      engine.events.on("transition", on);
    });
    const started = engine.startPayment(taken.id);
    const link = await linked;
    const live = engine.getAttempt(started.id)?.approvalUrl;
    await postJson(`${link}/reject`, {});
    await engine.waitForAttempt(started.id, 10_000);
    return { id: link.split("/").pop() as string, link, live, attemptId: started.id, recordsDir, records, home, engine };
  }

  it("is written to approvals.jsonl and to the attempt only as a hash", async () => {
    const run = await rejectedPayment();
    const approvals = readFileSync(join(run.home, "records", "approvals.jsonl"), "utf8");
    expect(approvals).not.toContain(run.id);
    const lines = approvals.trim().split("\n").map((l) => JSON.parse(l) as { id: string });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.id).toBe(hashOf(run.id));
    const attempts = readFileSync(join(run.recordsDir, "attempts.jsonl"), "utf8");
    expect(attempts).not.toContain(run.id);
    expect(attempts).not.toContain("/approve/");
    expect(run.records.getAttempt(run.attemptId)?.walletRequestId).toBe(hashOf(run.id));
  });

  it("keeps the link on the live attempt, in memory, and on no stored one", async () => {
    const run = await rejectedPayment();
    expect(run.live).toBe(run.link);
    expect(new Records(run.recordsDir).getAttempt(run.attemptId)?.approvalUrl).toBeUndefined();
  });

  it("leaves a local wallet's request id as it is: it is not a capability", async () => {
    const facilitator = await startFacilitator();
    const seller = await startPaidEndpoint(facilitator.url);
    const wallet = await startWallet();
    stopped.push(facilitator, seller, wallet);
    const records = new Records(join(newHome(), "records"));
    const engine = new PaymentEngine({ records, policy: { ...DEFAULT_POLICY }, signer: new WalletSigner({ url: wallet.url, agentToken: wallet.token, pollMs: 5, timeoutMs: 3_000 }) });
    const taken = await quote({ url: `${seller.url}/v1/market?asset=BTC` }, { records, policy: DEFAULT_POLICY });
    const started = engine.startPayment(taken.id);
    await engine.waitForAttempt(started.id, 10_000);
    const stored = records.getAttempt(started.id)?.walletRequestId;
    expect(stored).toBeDefined();
    expect(stored).not.toMatch(/^sha256:/);
  });
});

// ── g. Flushing the approvals log ────────────────────────────────────────────────────────

describe("the approvals log is flushed", () => {
  it("fsyncs approvals.jsonl for every state change", async () => {
    const { home } = await seen({ target: "https://api.seller.example/paid" });
    const lines = readFileSync(join(home, "records", "approvals.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(io.events.filter((e) => e === "fsync approvals.jsonl")).toHaveLength(lines.length);
  });

  it("does not stop an approval when the flush fails", async () => {
    const { signer } = newSigner({ policy: DEFAULT_POLICY });
    let link = "";
    const pending = signer.sign(signRequest({ target: "https://api.seller.example/paid" }), { onPending: (_id, url) => (link = url ?? "") }).catch((err: unknown) => err);
    await waitFor(() => link !== "");
    io.failFsync = true;
    const rejected = await postJson(`${link}/reject`, {});
    io.failFsync = false;
    expect(rejected.status).toBe(200);
    expect(await pending).toBeInstanceOf(SignRefused);
  });
});

// ── h. The 500 answer ────────────────────────────────────────────────────────────────────

describe("the page server's 500 answer", () => {
  it("carries no internal error text; stderr has it, cleaned", async () => {
    const { signer } = newSigner({ policy: DEFAULT_POLICY });
    await signer.start();
    vi.spyOn(ApprovalServer.prototype as unknown as { handle: () => Promise<void> }, "handle").mockRejectedValue(new Error("EACCES /home/x/.superstables/records"));
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    const res = await fetch(`${signer.url}/approve/${"0".repeat(32)}`);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "the approval page could not handle that request; the command's error output says why" });
    expect(text).not.toContain("/home/x");
    expect(written.join("")).toContain("approval page: a request failed: EACCES");
  });
});

// ── i. What the wallet will show ─────────────────────────────────────────────────────────

describe("what the wallet will show", () => {
  it("lists the EVM authorization's raw value next to its readable form", async () => {
    const { html } = await seen({ target: "https://api.seller.example/paid" });
    expect(html).toContain("What your wallet will show");
    expect(html).toContain("value: 10000, in the token&#39;s smallest unit. That is 0.01 USDC.");
  });

  it("names the token's own signing name, not its symbol, and says the page is the application asking", async () => {
    const arbitrum = await seen({ target: "https://api.seller.example/paid" }, { network: ARBITRUM_SEPOLIA });
    expect(arbitrum.html).toContain("signs as &quot;USD Coin&quot;");
    const skale = await seen({ target: "https://api.seller.example/paid" }, { network: SKALE_BASE_SEPOLIA });
    expect(skale.html).toContain("signs as &quot;Bridged USDC (SKALE Bridge)&quot;");
    const robinhood = await seen({ target: "https://api.seller.example/paid" }, { network: ROBINHOOD_TESTNET });
    expect(robinhood.html).toContain("signs as &quot;Global Dollar&quot;");
    expect(arbitrum.html).toContain("The application asking is this page");
    expect(arbitrum.html).not.toContain("named as the application asking");
  });

  it("says a Tempo transfer goes to the token contract, with the amount and recipient inside the call", () => {
    const html = approvalPage(tempoFacts(), tempoStep);
    expect(html).toContain(`token contract ${TEMPO_MODERATO.token.address}`);
    expect(html).toContain("Recipient in the call:");
  });

  it("says a Solana transaction has no fee for the owner", () => {
    expect(approvalPage(solanaFacts(), solanaStep)).toContain("No network fee for you");
  });
});
