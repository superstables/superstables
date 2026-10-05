// The Solana wallet step of the approval page (src/core/signer/steps/solana.ts): what the server builds for the owner's
// wallet, what it takes back, and the page script that runs it. The server is the real approval server on 127.0.0.1, the
// chain a fake devnet, the wallet a stand-in for Phantom that speaks the Wallet Standard and signs with a real ed25519
// key. What a person relies on: the wallet is given exactly the transfer the page shows, with the seller paying the fee;
// nothing comes back as signed unless it is that transaction, unchanged, signed by the connected account alone; and the
// client is on Solana devnet before anything is built.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SOLANA_DEVNET } from "../../src/core/chain.js";
import { DEFAULT_POLICY } from "../../src/core/policy.js";
import { judgeAccept } from "../../src/core/rails/index.js";
import { TOKEN_PROGRAM, tokenAccountOf } from "../../src/core/rails/solana-transaction.js";
import { APPROVAL_PAGE_SCRIPT } from "../../src/core/signer/approval-page.js";
import { ApprovalServer, type ApprovalHandle } from "../../src/core/signer/approval-server.js";
import { BrowserWalletSigner } from "../../src/core/signer/browser.js";
import { SOLANA_STEP_SCRIPT } from "../../src/core/signer/steps/solana.js";
import { SignRefused, type SolanaSignRequest, type SolanaSignResult } from "../../src/core/signer/types.js";
import type { RawAccept } from "../../src/core/x402.js";
import { MAINNET_GENESIS, MINT, randomAddress, signAsOwner, solanaKey, startFakeDevnet, type FakeSolanaDevnet, type SolanaKey } from "../helpers/fake-solana-pay.js";

let home: string;
let chain: FakeSolanaDevnet;
let server: ApprovalServer;
const owner = solanaKey();
const RPC_ENV = "SUPERSTABLES_SOLANA_RPC";
const savedRpc = process.env[RPC_ENV];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "superstables-solana-step-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
beforeEach(async () => {
  chain = await startFakeDevnet();
  // The wallet step reads devnet where the rail does: SUPERSTABLES_SOLANA_RPC, here the fake chain.
  process.env[RPC_ENV] = chain.url;
  server = new ApprovalServer({ port: 0, recordsDirPath: mkdtempSync(join(home, "records-")) });
  await server.start();
});
afterEach(async () => {
  process.env[RPC_ENV] = savedRpc;
  await server.close();
  await chain.close();
});

function sellerAccept(over: Partial<RawAccept> = {}): RawAccept {
  return { scheme: "exact", network: SOLANA_DEVNET.caip2, amount: "10000", asset: MINT, payTo: randomAddress(), maxTimeoutSeconds: 60, extra: { feePayer: randomAddress() }, ...over };
}

/** One Solana payment waiting on the page, judged as the browser signer judges it. */
function waiting(accept: RawAccept = sellerAccept()): { handle: ApprovalHandle; accept: RawAccept; link: string } {
  const judged = judgeAccept(accept, 2);
  if (!judged.supported) throw new Error(judged.reason);
  const handle = server.request({
    kind: "solana-transaction",
    verified: { ...judged.offer.terms, payer: "" },
    reported: { target: "https://seller.example/paid", serviceName: "Claimed by the agent" },
    requirement: judged.offer.requirement,
    x402Version: 2,
    timeoutMs: 60_000,
  });
  return { handle, accept, link: handle.url };
}

/** A POST as the page makes it: from the page's own origin, JSON. */
async function post(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function state(link: string): Promise<string> {
  return ((await (await fetch(`${link}/state`)).json()) as { status: string }).status;
}

/** Connect the owner and have the server build the transaction: what the wallet is handed. */
async function prepared(link: string, key: SolanaKey = owner): Promise<string> {
  expect((await post(`${link}/account`, { address: key.address })).status).toBe(200);
  const built = await post(`${link}/prepare`, { address: key.address });
  expect(built.status, JSON.stringify(built.body)).toBe(200);
  expect(built.body.chain).toBe("solana:devnet");
  return built.body.transaction as string;
}

describe("the approval page for a Solana payment", () => {
  it("shows the verified terms, the Solana wording and its own step script, and loads nothing from elsewhere", async () => {
    const { accept, link } = waiting();
    const html = await (await fetch(link)).text();
    expect(html).toContain(`<dd class="mono">${accept.payTo}</dd>`);
    expect(html).toContain(`<dt>Network</dt><dd>Solana devnet</dd>`);
    expect(html).toContain(`<dt>Token</dt><dd class="mono">${MINT}</dd>`);
    expect(html).toContain("0.01<span>USDC</span>");
    expect(html).toContain("Check the amount and the recipient, then sign with your Solana wallet, or reject. Your wallet keeps its key.");
    expect(html).toContain("Signing approves this one transfer of 0.01 USDC and nothing else; the seller pays the network fee and sends it.");
    expect(html).toContain("in Phantom: open Settings, Developer Settings, turn on Testnet Mode and pick Solana Devnet.");
    expect(html).toContain("window.superstablesStep");
    expect(html).toContain('"walletChain":"solana:devnet"');
    // the same buttons the page always has
    for (const id of ['id="connect"', 'id="approve"', 'id="reject"']) expect(html).toContain(id);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).toContain("Reported by the agent (not verified)");
  });

  it("connects a Solana account only, and not the seller's own fee payer", async () => {
    const accept = sellerAccept();
    const { link } = waiting(accept);
    expect(await post(`${link}/account`, { address: "0x1111111111111111111111111111111111111111" })).toMatchObject({ status: 400 });
    const feePayer = (accept.extra as { feePayer: string }).feePayer;
    expect(await post(`${link}/account`, { address: feePayer })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/fee payer is your own address/) } });
    expect(await post(`${link}/account`, { address: owner.address })).toMatchObject({ status: 200, body: { summary: expect.stringContaining("0.01 USDC to") } });
    expect(await state(link)).toBe("pending");
  });

  it("builds exactly the transfer the page shows, on a devnet blockhash, with the seller's fee payer", async () => {
    const accept = sellerAccept({ amount: "12345", extra: { feePayer: randomAddress(), memo: "order-7" } });
    const { link } = waiting(accept);
    // nothing is prepared, or built, before the account is connected
    expect(await post(`${link}/prepare`, { address: owner.address })).toMatchObject({ status: 409 });
    const transaction = await prepared(link);
    expect(chain.calls).toEqual(["getGenesisHash", "getLatestBlockhash"]);
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe((accept.extra as { feePayer: string }).feePayer);
    expect(tx.message.header.numRequiredSignatures).toBe(2);
    expect(keys.slice(0, 2)).toContain(owner.address);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const programs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]);
    expect(programs).toEqual(["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", TOKEN_PROGRAM, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]);
    const transfer = tx.message.compiledInstructions[2];
    expect(transfer.accountKeyIndexes.map((i) => keys[i])).toEqual([tokenAccountOf(owner.address, MINT), MINT, tokenAccountOf(accept.payTo!, MINT), owner.address]);
    expect(Buffer.from(transfer.data).readBigUInt64LE(1)).toBe(12345n);
    expect(Buffer.from(tx.message.compiledInstructions[3].data).toString()).toBe("order-7");
    // the account it was prepared for, and no other
    expect(await post(`${link}/prepare`, { address: solanaKey().address })).toMatchObject({ status: 400 });
  });

  it("builds nothing on an RPC that is not Solana devnet, nor when devnet does not answer", async () => {
    const { link } = waiting();
    expect((await post(`${link}/account`, { address: owner.address })).status).toBe(200);
    chain.genesis = MAINNET_GENESIS;
    expect(await post(`${link}/prepare`, { address: owner.address })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/not on Solana devnet .*nothing was signed/) } });
    expect(chain.calls).toEqual(["getGenesisHash"]);
    chain.genesis = SOLANA_DEVNET.genesisHash;
    chain.down = true;
    expect(await post(`${link}/prepare`, { address: owner.address })).toMatchObject({ status: 503, body: { error: expect.stringMatching(/did not answer.*nothing was signed/) } });
    expect(await state(link)).toBe("pending");
  });

  it("takes back only that transaction, unchanged and signed by the connected account, then hands it on", async () => {
    const { link, handle } = waiting();
    const transaction = await prepared(link);
    // nothing but a transaction, nor one for another account
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: "!!" })).toMatchObject({ status: 400 });
    expect(await post(`${link}/signed`, { address: randomAddress(), signedTransaction: signAsOwner(transaction, owner) })).toMatchObject({ status: 400 });
    // a wallet that changed the transfer: the amount in the message differs, and the owner signed that
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    const changed = Buffer.from(tx.message.serialize());
    changed[changed.length - 45] ^= 1;
    const forged = Buffer.concat([Buffer.from([2]), Buffer.alloc(64), Buffer.from(owner.sign(changed)), changed]).toString("base64");
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: forged })).toMatchObject({ status: 400, body: { code: "transaction_changed", error: expect.stringMatching(/changed the transaction.*nothing was accepted/) } });
    // signed by another key in the owner's slot
    const other = solanaKey();
    const byOther = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    byOther.signatures[1] = other.sign(byOther.message.serialize());
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: Buffer.from(byOther.serialize()).toString("base64") })).toMatchObject({ status: 400, body: { code: "bad_signature" } });
    expect(await state(link)).toBe("pending");

    const signed = signAsOwner(transaction, owner);
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: signed })).toMatchObject({ status: 200, body: { status: "signed" } });
    const outcome = await handle.settled;
    expect(outcome.status).toBe("signed");
    const result = (outcome as { result: SolanaSignResult }).result;
    expect(result).toEqual({
      kind: "solana-transaction",
      transaction: signed,
      signature: bs58.encode(VersionedTransaction.deserialize(Buffer.from(signed, "base64")).signatures[1]),
      lastValidBlockHeight: chain.height + 150,
      // the slot devnet had reached when the transaction was built: a search for it starts there
      searchFromSlot: chain.height + 10,
      signer: owner.address,
    });
    // one signature per approval: a second one is not taken
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: signed })).toMatchObject({ status: 409 });
  });

  it("does not take a transaction whose blockhash is about to expire, and lets the owner sign a fresh one", async () => {
    const { link, handle } = waiting();
    const first = await prepared(link);
    chain.height += 140;
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: signAsOwner(first, owner) })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/about to expire/) } });
    expect(await state(link)).toBe("pending");
    const second = await post(`${link}/prepare`, { address: owner.address });
    expect(second.body.transaction).not.toBe(first);
    expect(await post(`${link}/signed`, { address: owner.address, signedTransaction: signAsOwner(second.body.transaction as string, owner) })).toMatchObject({ status: 200 });
    expect((await handle.settled).status).toBe("signed");
  });

  it("ends as the owner's rejection, page or wallet, with nothing signed", async () => {
    const a = waiting();
    await prepared(a.link);
    expect(await post(`${a.link}/reject`, { by: "wallet" })).toMatchObject({ status: 200 });
    expect(await a.handle.settled).toEqual({ status: "denied", reason: "rejected by the owner in their wallet" });
  });
});

describe("the browser signer on Solana", () => {
  it("re-judges the request, refuses what the policy refuses before any page exists, and remembers the Solana account", async () => {
    const signer = new BrowserWalletSigner({ port: 0, home: mkdtempSync(join(home, "signer-")), policy: DEFAULT_POLICY, timeoutMs: 10_000, balance: false });
    try {
      const accept = sellerAccept();
      const req: SolanaSignRequest = { kind: "solana-transaction", requirements: accept as never, x402Version: 2 };
      await expect(signer.sign({ ...req, requirements: { ...accept, asset: "x" } as never })).rejects.toMatchObject({ code: "invalid" });
      await expect(signer.sign({ ...req, requirements: { ...accept, amount: "900000000" } as never })).rejects.toBeInstanceOf(SignRefused);
      let link = "";
      const signing = signer.sign(req, { onPending: (_id, url) => (link = url ?? "") });
      for (let i = 0; i < 200 && !link; i += 1) await new Promise((r) => setTimeout(r, 10));
      const transaction = await prepared(link);
      await post(`${link}/signed`, { address: owner.address, signedTransaction: signAsOwner(transaction, owner) });
      const result = await signing;
      expect(result).toMatchObject({ kind: "solana-transaction", signer: owner.address });
      expect(await signer.address(SOLANA_DEVNET.caip2)).toBe(owner.address);
      // the EVM account is another one, and none has been connected
      await expect(signer.address("eip155:84532")).rejects.toThrow(/no browser wallet connected yet/);
    } finally {
      await signer.close();
    }
  });
});

// ── The page script, in a stand-in browser ───────────────────────────────────────────────────────────────────
//
// The step script and the page's main script run in node:vm against a small stand-in for the DOM. Their requests go to
// the real approval server above; the wallet is a stand-in for Phantom that registers through the Wallet Standard.

const SVG_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";

class FakeNode {
  hidden = false;
  disabled = false;
  className = "";
  id = "";
  parentNode: FakeNode | null = null;
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  private text = "";
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }
  set src(v: string) { this.attrs.set("src", v); }
  set href(v: string) { this.attrs.set("href", v); }
  set rel(v: string) { this.attrs.set("rel", v); }
  set alt(v: string) { this.attrs.set("alt", v); }
  set width(v: number) { this.attrs.set("width", String(v)); }
  set height(v: number) { this.attrs.set("height", String(v)); }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  appendChild(child: FakeNode) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  closest(selector: string) {
    return selector === "button[data-act]" && this.tag === "button" && this.attrs.has("data-act") ? this : null;
  }
  find(id: string): FakeNode | null {
    if (this.id === id) return this;
    for (const c of this.children) {
      const found = c.find(id);
      if (found) return found;
    }
    return null;
  }
}

/** A Wallet Standard wallet such as Phantom: it connects one account and signs what it is given, or says no. */
function phantom(name: string, key: SolanaKey, behaviour: { reject?: boolean } = {}) {
  const calls: { method: string; chain?: string }[] = [];
  const account = { address: key.address, publicKey: new PublicKey(key.address).toBytes(), chains: ["solana:devnet"], features: ["solana:signTransaction"] };
  const wallet = {
    name,
    icon: SVG_ICON,
    version: "1.0.0",
    chains: ["solana:mainnet", "solana:devnet", "solana:testnet"],
    accounts: [] as unknown[],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => (calls.push({ method: "connect" }), { accounts: [account] }) },
      "solana:signTransaction": {
        version: "1.0.0",
        signTransaction: async (input: { transaction: Uint8Array; chain?: string }) => {
          calls.push({ method: "signTransaction", chain: input.chain });
          if (behaviour.reject) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          const signed = signAsOwner(Buffer.from(input.transaction).toString("base64"), key);
          return [{ signedTransaction: new Uint8Array(Buffer.from(signed, "base64")) }];
        },
      },
    },
  };
  return { wallet, calls };
}

/** The approval page at `link`, its scripts run with these wallets installed first. */
async function pageInBrowser(link: string, wallets: unknown[]) {
  const html = await (await fetch(link)).text();
  const factsJson = /<script id="approval-facts" type="application\/json">([^<]*)<\/script>/.exec(html)![1];
  const card = new FakeNode("div");
  const actions = card.appendChild(new FakeNode("div"));
  const byId = new Map<string, FakeNode>();
  const add = (id: string, tag = "div", parent: FakeNode = card) => {
    const n = parent.appendChild(new FakeNode(tag));
    n.id = id;
    byId.set(id, n);
    return n;
  };
  for (const act of ["connect", "approve", "reject"]) add(act, "button", actions).setAttribute("data-act", act);
  for (const id of ["no-wallet", "approve", "account", "account-label", "say"]) (byId.get(id) ?? add(id)).hidden = true;
  add("expiry");
  add("approval-facts").textContent = factsJson;
  const body = new FakeNode("body");
  const listeners: ((event: { target: FakeNode }) => void)[] = [];
  const timers: (() => void)[] = [];
  const document = {
    body,
    getElementById: (id: string) => byId.get(id) ?? card.find(id),
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { textContent: text }),
    querySelectorAll: () => [...actions.children, ...(card.find("wallet-list")?.children ?? [])],
    addEventListener: (type: string, fn: (event: { target: FakeNode }) => void) => {
      if (type === "click") listeners.push(fn);
    },
  };
  const origin = new URL(link).origin;
  const posted: string[] = [];
  const pageFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    if (init.method === "POST") posted.push(url.split("/").pop()!);
    return fetch(`${origin}${url}`, { method: init.method, headers: { ...init.headers, origin }, body: init.body });
  };
  const window = new EventTarget() as EventTarget & { superstablesStep?: unknown };
  window.addEventListener("wallet-standard:app-ready", (event) => (event as CustomEvent).detail.register(...wallets));
  const context = { window, document, fetch: pageFetch, setTimeout: (fn: () => void) => timers.push(fn), setInterval: () => 0, CustomEvent, Event, TextEncoder, btoa, atob, Date, JSON, Promise, Uint8Array, String, Number, Math, Error };
  runInNewContext(SOLANA_STEP_SCRIPT, context);
  runInNewContext(APPROVAL_PAGE_SCRIPT, context);
  const until = async (ready: () => boolean) => {
    for (let i = 0; i < 300 && !ready(); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(ready(), `page says: ${byId.get("say")!.textContent}`).toBe(true);
  };
  return {
    node: (id: string) => document.getElementById(id)!,
    body,
    posted,
    window,
    click: (button: FakeNode) => listeners.forEach((fn) => fn({ target: button })),
    until,
    later: () => timers.splice(0).forEach((fn) => fn()),
  };
}

describe("the Solana step's page script", () => {
  it("is plain ES2017 that a browser can run without a build step", () => {
    const dir = mkdtempSync(join(home, "script-"));
    const file = join(dir, "solana-step.js");
    writeFileSync(file, SOLANA_STEP_SCRIPT);
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
    expect(SOLANA_STEP_SCRIPT).toContain('"solana:signTransaction"');
    expect(SOLANA_STEP_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });

  it("connects the one wallet installed, has it sign the transaction the server built, and the page says signed", async () => {
    const { link, handle } = waiting();
    const p = phantom("Phantom", owner);
    const page = await pageInBrowser(link, [p.wallet]);
    expect(page.node("connect").hidden).toBe(false);
    expect(page.node("no-wallet").hidden).toBe(true);
    page.click(page.node("connect"));
    await page.until(() => !page.node("approve").hidden);
    expect(p.calls).toEqual([{ method: "connect" }]);
    expect(page.node("account").textContent).toBe(owner.address);
    expect(page.node("connect").hidden).toBe(true);
    expect(page.node("say").textContent).toBe("Ready. Press “Review in wallet” and check the amount in Phantom.");
    page.click(page.node("approve"));
    await page.until(() => page.body.getAttribute("data-state") === "signed");
    expect(p.calls).toEqual([{ method: "connect" }, { method: "signTransaction", chain: "solana:devnet" }]);
    expect(page.posted).toEqual(["account", "prepare", "signed"]);
    expect(page.node("say").textContent).toBe("Signed. You can go back to the agent.");
    expect((await handle.settled).status).toBe("signed");
  });

  it("asks which wallet to use when several register, shows names as text and icons only as images, and uses that one alone", async () => {
    const { link, handle } = waiting();
    const a = phantom("Phantom", solanaKey());
    const b = phantom('<img src=x onerror="alert(1)">Solflare', owner);
    const page = await pageInBrowser(link, [a.wallet, b.wallet]);
    page.click(page.node("connect"));
    const list = page.node("wallet-list");
    expect(list.hidden).toBe(false);
    expect(list.className).toBe("actions");
    // under the page's own buttons, not among them
    expect(list.parentNode).toBe(page.node("reject").parentNode!.parentNode);
    expect(list.children.map((c) => c.textContent)).toEqual(["Phantom", '<img src=x onerror="alert(1)">Solflare']);
    expect([...list.children[0].children[0].attrs]).toEqual([["src", SVG_ICON], ["width", "18"], ["height", "18"], ["alt", ""]]);
    expect(page.node("say").textContent).toBe("More than one wallet is installed. Choose the one to use.");
    page.click(list.children[1]);
    await page.until(() => !page.node("approve").hidden);
    page.click(page.node("approve"));
    await page.until(() => page.body.getAttribute("data-state") === "signed");
    expect(a.calls).toEqual([]);
    expect(b.calls.map((c) => c.method)).toEqual(["connect", "signTransaction"]);
    expect(((await handle.settled) as { result: SolanaSignResult }).result.signer).toBe(owner.address);
  });

  it("says a Solana wallet is needed, with where to get one, when none registers", async () => {
    const { link } = waiting();
    const page = await pageInBrowser(link, []);
    expect(page.node("connect").hidden).toBe(true);
    page.later();
    expect(page.node("no-wallet").hidden).toBe(false);
    expect(page.node("no-wallet").textContent).toBe(
      "A Solana wallet (Phantom, Solflare, Backpack, ...) is needed to sign this payment. Install one, for example Phantom from https://phantom.com/download, then reload this page. You can still reject the payment without one.",
    );
    // a wallet without solana:signTransaction, or not on devnet, is not one the page can use
    const evmOnly = { name: "Other", chains: ["solana:devnet"], features: { "standard:connect": {} } };
    const mainnetOnly = { ...phantom("Mainnet", owner).wallet, chains: ["solana:mainnet"] };
    const other = await pageInBrowser(waiting().link, [evmOnly, mainnetOnly]);
    other.later();
    expect(other.node("no-wallet").hidden).toBe(false);
  });

  it("ends the payment as rejected when the owner says no in the wallet, with nothing signed", async () => {
    const { link, handle } = waiting();
    const p = phantom("Phantom", owner, { reject: true });
    const page = await pageInBrowser(link, [p.wallet]);
    page.click(page.node("connect"));
    await page.until(() => !page.node("approve").hidden);
    page.click(page.node("approve"));
    await page.until(() => page.body.getAttribute("data-state") === "denied");
    expect(page.posted).toEqual(["account", "prepare", "reject"]);
    expect(page.node("say").textContent).toBe("You rejected this payment in your wallet. Nothing was signed.");
    expect(await handle.settled).toEqual({ status: "denied", reason: "rejected by the owner in their wallet" });
  });

  it("shows why the client would not build it, and keeps the payment open", async () => {
    const { link } = waiting();
    const p = phantom("Phantom", owner);
    const page = await pageInBrowser(link, [p.wallet]);
    page.click(page.node("connect"));
    await page.until(() => !page.node("approve").hidden);
    chain.genesis = MAINNET_GENESIS;
    page.click(page.node("approve"));
    await page.until(() => /not on Solana devnet/.test(page.node("say").textContent));
    expect(p.calls.map((c) => c.method)).toEqual(["connect"]);
    expect(page.node("say").className).toBe("note bad");
    expect(page.node("approve").disabled).toBe(false);
    expect(await state(link)).toBe("pending");
  });
});
