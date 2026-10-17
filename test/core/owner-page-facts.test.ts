// The owner approval page states its facts and does not send on another chain. The page's own script runs in node:vm against
// a small stand-in for the DOM and a wallet that records what it was asked; the rows are read from the HTML the page and the
// real owner server produce. No network beyond 127.0.0.1, no real key.
import { runInNewContext } from "node:vm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER_PAGE_SCRIPT, ownerApprovalPage, type OwnerPageFacts, type OwnerTerms } from "../../src/core/signer/owner-approval-page.js";
import { OwnerApprovalServer, type OwnerActionInput } from "../../src/core/signer/owner-approval-server.js";

const OWNER = privateKeyToAccount(generatePrivateKey());
const OTHER = privateKeyToAccount(generatePrivateKey()).address;
const AGENT = privateKeyToAccount(generatePrivateKey()).address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"ab".repeat(32)}`;
const BASE = "0x14a34";
const OTHER_CHAIN = "0x1";

// ── a stand-in browser ───────────────────────────────────────────────────────────────────

class FakeNode {
  hidden = false;
  className = "";
  disabled = false;
  readonly attrs = new Map<string, string>();
  readonly children: FakeNode[] = [];
  private text: string;
  constructor(readonly tag: string, text = "") {
    this.text = text;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
  }
  set src(value: string) {
    this.attrs.set("src", value);
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  appendChild(child: FakeNode) {
    this.children.push(child);
    return child;
  }
  closest(selector: string) {
    return selector === "button[data-act]" && this.tag === "button" && this.attrs.has("data-act") ? this : null;
  }
}

type Call = { method: string; params?: any };

/**
 * An EIP-1193 wallet. `chains` answers eth_chainId one read at a time (the last answer repeats). `switches`: whether
 * wallet_switchEthereumChain really moves it to the chain asked for. `sendHeld`: eth_sendTransaction waits for `release()`.
 */
function wallet(o: { chains?: string[]; switches?: boolean; watchAsset?: "ok" | "refused"; sendHeld?: boolean } = {}) {
  const chains = [...(o.chains ?? [BASE])];
  const handlers = new Map<string, ((value: unknown) => void)[]>();
  const calls: Call[] = [];
  let release: () => void = () => {};
  const provider = {
    calls,
    on(event: string, fn: (value: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    emit(event: string, value: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(value);
    },
    release: () => release(),
    async request({ method, params }: Call) {
      calls.push({ method, params });
      if (method === "eth_requestAccounts") return [OWNER.address];
      if (method === "eth_chainId") return chains.length > 1 ? chains.shift() : chains[0];
      if (method === "wallet_switchEthereumChain" && o.switches) {
        chains.splice(0, chains.length, params[0].chainId);
        return null;
      }
      if (method === "wallet_watchAsset") {
        if (o.watchAsset === "refused") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        return true;
      }
      if (method === "eth_sendTransaction") {
        if (o.sendHeld) await new Promise<void>((done) => (release = done));
        return HASH;
      }
      return null;
    },
  };
  return provider;
}

function evmFacts(extra: Record<string, unknown> = {}) {
  const data = `0x095ea7b3${AGENT.slice(2).toLowerCase().padStart(64, "0")}${(10000).toString(16).padStart(64, "0")}`;
  return {
    id: "0".repeat(32),
    kind: "evm-transaction",
    chain: { chainId: 84532, chainName: "Base Sepolia", rpcUrl: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, testnet: true },
    chainIdHex: BASE,
    account: OWNER.address,
    transaction: { to: USDC, data, value: "0x0" },
    expiresAt: Date.now() + 60_000,
    ...extra,
  };
}

function pageIn(facts: Record<string, unknown>, install: (window: EventTarget & { ethereum?: unknown }) => void) {
  const nodes = new Map<string, FakeNode>();
  const node = (id: string) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = new FakeNode("div")));
    return n;
  };
  node("owner-facts").textContent = JSON.stringify(facts);
  for (const act of ["connect", "send", "reject"]) {
    const button = new FakeNode("button");
    button.setAttribute("data-act", act);
    nodes.set(act, button);
  }
  for (const id of ["wallet-list", "no-wallet", "send", "say"]) node(id).hidden = true;
  let onClick: (event: { target: FakeNode }) => void = () => {};
  const posted: { path: string; body: any }[] = [];
  const document = {
    body: new FakeNode("body"),
    getElementById: node,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode("#text", text),
    querySelectorAll: () => [node("connect"), node("send"), node("reject")],
    addEventListener: (type: string, fn: typeof onClick) => {
      if (type === "click") onClick = fn;
    },
  };
  const gates = new Map<string, Promise<void>>();
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") posted.push({ path: `/${url.split("/").pop()}`, body: JSON.parse(init.body ?? "{}") });
    await gates.get(`/${url.split("/").pop()}`);
    return { ok: true, status: 200, json: async () => (url.endsWith("/state") ? { status: "pending" } : {}) };
  };
  const window = new EventTarget() as EventTarget & { ethereum?: unknown };
  install(window);
  runInNewContext(OWNER_PAGE_SCRIPT, { window, document, fetch, setTimeout: () => 0, setInterval: () => 0, CustomEvent, Event, TextEncoder, btoa, atob });
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return {
    node,
    posted,
    say: () => node("say").textContent,
    click: async (button: FakeNode) => {
      onClick({ target: button });
      await settle();
    },
    settle,
    /** The next answer for `path` waits until the returned function is called. */
    hold: (path: string) => {
      let open: () => void = () => {};
      gates.set(path, new Promise<void>((done) => (open = done)));
      return open;
    },
  };
}

/** A page whose only wallet is `provider` (window.ethereum), connected and ready to send. */
async function readyPage(provider: ReturnType<typeof wallet>, facts: Record<string, unknown> = evmFacts()) {
  const page = pageIn(facts, (window) => {
    window.ethereum = provider;
  });
  await page.click(page.node("connect"));
  expect(page.node("send").hidden).toBe(false);
  return page;
}

const methods = (provider: ReturnType<typeof wallet>) => provider.calls.map((c) => c.method);

// ── the page never sends on another chain ────────────────────────────────────────────────

describe("the owner page and the wallet's network", () => {
  it("drops ready when the wallet switches network after connecting, and sends nothing if the button is forced", async () => {
    const provider = wallet({ chains: [BASE, BASE, OTHER_CHAIN] });
    const page = await readyPage(provider);
    provider.emit("chainChanged", OTHER_CHAIN);
    expect(page.node("send").hidden).toBe(true);
    expect(page.node("connect").hidden).toBe(false);
    expect(page.say()).toBe("Your wallet switched to another chain. Connect again to switch it back to Base Sepolia.");

    // a test (or a script) forces the hidden button: the wallet stays on the other network
    await page.click(page.node("send"));
    expect(methods(provider)).not.toContain("eth_sendTransaction");
    expect(page.posted.map((p) => p.path)).toEqual(["/account"]);
  });

  it("does not drop ready when the wallet moves to the network the page asked for", async () => {
    const provider = wallet();
    const page = await readyPage(provider);
    provider.emit("chainChanged", "0x14A34");
    expect(page.node("send").hidden).toBe(false);
    expect(page.node("connect").hidden).toBe(true);
  });

  it("switches the wallet back after the click, before it tells the command it is sending", async () => {
    const provider = wallet({ switches: true });
    const page = await readyPage(provider);
    const connectCalls = provider.calls.length;
    await page.click(page.node("send"));
    const afterClick = provider.calls.slice(connectCalls).map((c) => c.method);
    expect(afterClick[0]).toBe("wallet_switchEthereumChain");
    expect(afterClick).toContain("eth_sendTransaction");
    expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending", "/sent"]);
  });

  it("checks the network again after the switch: a wallet that has moved asks nothing and the command is not told it is sending", async () => {
    // reads: connect (1), the click's own check (2), the check right before sending (3: another network)
    const provider = wallet({ chains: [BASE, BASE, OTHER_CHAIN] });
    const page = await readyPage(provider);
    await page.click(page.node("send"));
    expect(methods(provider)).not.toContain("eth_sendTransaction");
    expect(page.posted.map((p) => p.path)).toEqual(["/account"]);
    expect(page.say()).toBe("Your wallet is not on Base Sepolia, so it was not asked to send. Nothing was sent.");
    // still ready: after switching back the owner can press it again
    expect(page.node("send").hidden).toBe(false);
  });

  it("names the chain in the transaction it asks the wallet to send", async () => {
    const provider = wallet();
    const page = await readyPage(provider);
    await page.click(page.node("send"));
    const sent = provider.calls.find((c) => c.method === "eth_sendTransaction")!;
    expect(sent.params).toEqual([{ from: OWNER.address, to: USDC, data: evmFacts().transaction.data, value: "0x0", chainId: BASE }]);
  });

  it("keeps sending from the original account when another account or network is picked while the wallet is asked", async () => {
    const provider = wallet({ sendHeld: true });
    const page = await readyPage(provider);
    await page.click(page.node("send"));
    expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending"]);

    provider.emit("accountsChanged", [OTHER]);
    provider.emit("chainChanged", OTHER_CHAIN);
    expect(page.node("connect").hidden).toBe(true);
    expect(page.say()).not.toMatch(/switched/);

    provider.release();
    await page.settle();
    expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending", "/sent"]);
    for (const p of page.posted) expect(p.body.address).toBe(OWNER.address);
    expect(page.posted.at(-1)!.body.hash).toBe(HASH);
  });

  for (const [what, move] of [
    ["network", (p: ReturnType<typeof wallet>) => p.emit("chainChanged", OTHER_CHAIN)],
    ["account", (p: ReturnType<typeof wallet>) => p.emit("accountsChanged", [OTHER])],
    ["account and then network", (p: ReturnType<typeof wallet>) => { p.emit("accountsChanged", [OTHER]); p.emit("chainChanged", OTHER_CHAIN); }],
  ] as const) {
    it(`does not ask the wallet to send when the ${what} moved while the command was being told, and closes the link`, async () => {
      const provider = wallet({ switches: true });
      const page = await readyPage(provider);
      const open = page.hold("/sending");
      await page.click(page.node("send"));
      expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending"]);
      move(provider);
      open();
      await page.settle();
      expect(methods(provider)).not.toContain("eth_sendTransaction");
      expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending", "/reject"]);
      expect(page.posted.at(-1)!.body).toEqual({ by: "page" });
    });
  }

  it("does not show the send button when the wallet moved while the account was being sent", async () => {
    const provider = wallet({ switches: true });
    const page = pageIn(evmFacts(), (window) => {
      window.ethereum = provider;
    });
    const open = page.hold("/account");
    await page.click(page.node("connect"));
    provider.emit("chainChanged", OTHER_CHAIN);
    open();
    await page.settle();
    expect(page.node("send").hidden).toBe(true);
    expect(page.node("connect").hidden).toBe(false);
  });

  it("says a cancelled network switch sent nothing", async () => {
    const provider = wallet({ chains: [BASE, OTHER_CHAIN] });
    const request = provider.request.bind(provider);
    provider.request = async (a: Call) => {
      // the first switch (connecting) works; the one after the click is cancelled in the wallet
      if (a.method === "wallet_switchEthereumChain" && provider.calls.some((c) => c.method === "wallet_switchEthereumChain")) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      return request(a);
    };
    const page = await readyPage(provider);
    await page.click(page.node("send"));
    expect(methods(provider)).not.toContain("eth_sendTransaction");
    expect(page.posted.map((p) => p.path)).toEqual(["/account"]);
    expect(page.say()).toBe("You cancelled in your wallet. Nothing was sent. You can try again, or reject.");
  });
});

// ── the token offered to the wallet ──────────────────────────────────────────────────────

describe("offering the token to the wallet before a token approval", () => {
  const token = { address: USDC, symbol: "USDC", decimals: 6 };

  it("asks wallet_watchAsset once, before the transaction, with the token's own facts", async () => {
    const provider = wallet();
    const page = await readyPage(provider, evmFacts({ token }));
    await page.click(page.node("send"));
    const order = methods(provider);
    expect(order.indexOf("wallet_watchAsset")).toBeGreaterThan(order.indexOf("eth_requestAccounts"));
    expect(order.indexOf("wallet_watchAsset")).toBeLessThan(order.indexOf("eth_sendTransaction"));
    expect(provider.calls.find((c) => c.method === "wallet_watchAsset")!.params).toEqual({ type: "ERC20", options: { address: USDC, symbol: "USDC", decimals: 6 } });
  });

  it("does not ask for a native transfer, which has no token facts", async () => {
    const provider = wallet();
    const page = await readyPage(provider);
    await page.click(page.node("send"));
    expect(methods(provider)).not.toContain("wallet_watchAsset");
    expect(methods(provider)).toContain("eth_sendTransaction");
  });

  it("sends anyway when the wallet refuses to add the token", async () => {
    const provider = wallet({ watchAsset: "refused" });
    const page = await readyPage(provider, evmFacts({ token }));
    await page.click(page.node("send"));
    expect(methods(provider)).toContain("eth_sendTransaction");
    expect(page.posted.map((p) => p.path)).toEqual(["/account", "/sending", "/sent"]);
  });

  it("offers the token once even when the owner presses the button again after a network problem", async () => {
    const provider = wallet({ chains: [BASE, BASE, BASE, OTHER_CHAIN, BASE] });
    const page = await readyPage(provider, evmFacts({ token }));
    await page.click(page.node("send"));
    await page.click(page.node("send"));
    expect(methods(provider).filter((m) => m === "wallet_watchAsset")).toHaveLength(1);
  });
});

// ── the rows ──────────────────────────────────────────────────────────────────────────────

const TERMS: OwnerTerms = {
  title: "Give your agent a budget",
  amount: "0.01",
  unit: "USDC",
  summary: "Your agent may move up to 0.01 USDC.",
  rows: [{ label: "Agent", value: AGENT, mono: true }],
  enforced: ["A total cap."],
  notEnforced: ["No expiry."],
  notes: ["To end it: superstables budget revoke --rail evm."],
  walletShows: [`approve(spender ${AGENT}, amount 10000): 0.01 USDC`, `To: the USDC token contract ${USDC}`, "A network fee in ETH, paid from your wallet"],
};

function pageFacts(over: Partial<OwnerPageFacts> = {}): OwnerPageFacts {
  return { ...(evmFacts() as unknown as OwnerPageFacts), origin: "http://127.0.0.1:41233", rpc: { hosts: ["sepolia.base.org", "base-sepolia-rpc.publicnode.com"], source: "built-in" }, ...over };
}

/** The `<dl class="rows">` of a page, as label and value pairs. */
function rowsOf(html: string): [string, string][] {
  const dl = html.match(/<dl class="rows">([\s\S]*?)<\/dl>/)![1];
  return [...dl.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2].replace(/<[^>]+>/g, "").trim()]);
}
const row = (html: string, label: string) => rowsOf(html).find(([l]) => l === label)?.[1];

describe("the facts on the owner page", () => {
  it("names the network with its chain id, the RPC hosts and where they come from, and this page's own address", () => {
    const html = ownerApprovalPage(pageFacts(), TERMS);
    expect(row(html, "Network")).toBe("Base Sepolia (chain id 84532)");
    expect(row(html, "RPC the command reads")).toBe("sepolia.base.org, base-sepolia-rpc.publicnode.com (built-in)");
    expect(row(html, "This page")).toBe("http://127.0.0.1:41233, served by the command on this machine (not superstables.com)");
  });

  it("says where owner-chosen RPCs come from", () => {
    const own = ownerApprovalPage(pageFacts({ rpc: { hosts: ["node.example"], source: "owner node" } }), TERMS);
    expect(row(own, "RPC the command reads")).toBe("node.example (owner node)");
    const settings = ownerApprovalPage(pageFacts({ rpc: { hosts: ["a.example", "b.example"], source: "owner settings" } }), TERMS);
    expect(row(settings, "RPC the command reads")).toBe("a.example, b.example (owner settings)");
  });

  it("shows the exact values the wallet will show in their own block, escaped", () => {
    const hostile = { ...TERMS, walletShows: ['<img src=x onerror="alert(1)">', ...TERMS.walletShows!] };
    const html = ownerApprovalPage(pageFacts(), hostile);
    expect(html).toContain('<div class="wallet-shows"><strong>What your wallet will show</strong>');
    expect(html).toContain(`<li>approve(spender ${AGENT}, amount 10000): 0.01 USDC</li>`);
    expect(html).toContain("<li>A network fee in ETH, paid from your wallet</li>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("has no wallet block when the terms list nothing the wallet will show", () => {
    const { walletShows: _, ...bare } = TERMS;
    expect(ownerApprovalPage(pageFacts(), bare)).not.toContain("What your wallet will show");
  });

  it("marks an agent address the owner signed at setup, and warns about one recorded without a signature", () => {
    const signed = ownerApprovalPage(pageFacts({ binding: { state: "signed", signedAt: "2026-10-16T10:00:00.000Z" } }), TERMS);
    expect(row(signed, "Agent binding")).toBe("signed by you at setup");
    expect(signed).toContain('<span class="tag good">signed by you at setup</span>');
    expect(signed).not.toContain("recorded by an older version");

    const legacy = ownerApprovalPage(pageFacts({ binding: { state: "legacy" } }), TERMS);
    expect(row(legacy, "Agent binding")).toBe("not signed at setup This agent address was recorded by an older version, without your signature. Continue only if it is the agent you set up.");
    expect(legacy).toContain('<span class="tag warn">not signed at setup</span>');
  });

  it("shows no binding row when none is given, and never a row for a state it does not know", () => {
    expect(row(ownerApprovalPage(pageFacts(), TERMS), "Agent binding")).toBeUndefined();
    const odd = ownerApprovalPage(pageFacts({ binding: { state: "refused" } as never }), TERMS);
    expect(row(odd, "Agent binding")).toBeUndefined();
  });

  it("names a Solana cluster by its genesis hash instead of a chain id", () => {
    const solana = pageFacts({
      kind: "solana-transaction",
      chainIdHex: "",
      chain: { family: "solana", chainId: 0, chainName: "Solana devnet", rpcUrl: "https://api.devnet.solana.com", explorer: "https://explorer.solana.com", walletChain: "solana:devnet", genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 }, testnet: true },
      rpc: { hosts: ["api.devnet.solana.com"], source: "built-in" },
    });
    const html = ownerApprovalPage(solana, TERMS);
    expect(row(html, "Network")).toBe("Solana devnet (cluster genesis EtWTRABZ…)");
    expect(row(html, "RPC the command reads")).toBe("api.devnet.solana.com (built-in)");
  });

  it("a sign-in has the origin and RPC rows, no wallet block, no binding", () => {
    const html = ownerApprovalPage(pageFacts({ kind: "connect", transaction: undefined, message: "record this wallet" }), { ...TERMS, walletShows: undefined });
    expect(row(html, "This page")).toContain("not superstables.com");
    expect(row(html, "RPC the command reads")).toContain("built-in");
    expect(html).not.toContain("What your wallet will show");
    expect(row(html, "Agent binding")).toBeUndefined();
  });

  it("an older caller's facts (no origin, no RPC) still render the page", () => {
    const html = ownerApprovalPage(evmFacts() as unknown as OwnerPageFacts, TERMS);
    expect(row(html, "Network")).toBe("Base Sepolia (chain id 84532)");
    expect(row(html, "This page")).toBeUndefined();
    expect(row(html, "RPC the command reads")).toBeUndefined();
  });

  it("puts the token in the script's facts only when the terms say the wallet should be offered it", () => {
    const withToken = ownerApprovalPage(pageFacts({ token: { address: USDC, symbol: "USDC", decimals: 6 } }), TERMS);
    expect(withToken).toContain(`"token":{"address":"${USDC}","symbol":"USDC","decimals":6}`);
  });
});

// ── the real server ───────────────────────────────────────────────────────────────────────

const servers: OwnerApprovalServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function action(over: Partial<OwnerActionInput> = {}): OwnerActionInput {
  const facts = evmFacts();
  return { kind: "evm-transaction", chain: facts.chain, terms: TERMS, account: OWNER.address, transaction: facts.transaction, timeoutMs: 60_000, ...over };
}

describe("the owner server fills the page's facts", () => {
  async function get(over: Partial<OwnerActionInput>) {
    const server = new OwnerApprovalServer({ port: 0 });
    await server.start();
    servers.push(server);
    const handle = server.request(action(over));
    const res = await fetch(handle.url);
    return { html: await res.text(), server, handle };
  }

  it("shows the origin the page was really served from", async () => {
    const { html, server } = await get({ rpc: { hosts: ["sepolia.base.org"], source: "built-in" } });
    expect(row(html, "This page")).toBe(`${server.url}, served by the command on this machine (not superstables.com)`);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(row(html, "RPC the command reads")).toBe("sepolia.base.org (built-in)");
  });

  it("carries the binding, and offers the token only for terms that ask for it", async () => {
    const asked = await get({ binding: { state: "legacy" }, token: { address: USDC, symbol: "USDC", decimals: 6 }, terms: { ...TERMS, watchToken: true } });
    expect(row(asked.html, "Agent binding")).toContain("not signed at setup");
    expect(asked.html).toContain(`"token":{"address":"${USDC}"`);
    const plain = await get({ token: { address: USDC, symbol: "USDC", decimals: 6 } });
    expect(plain.html).not.toContain('"token"');
  });

  it("serves the same security headers as before", async () => {
    const { handle } = await get({});
    const res = await fetch(handle.url);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'nonce-");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await res.text()).toContain(`<script nonce="${nonce}">`);
  });
});
