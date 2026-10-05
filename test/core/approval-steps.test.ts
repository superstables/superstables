// The wallet steps of the approval page, run in a stand-in browser: the page's main script and a rail's own step script,
// with a fake EIP-1193 wallet that records what it is asked. What a person relies on: the wallet is switched to the
// payment's own chain with that chain's own currency, and a wallet that sends the payment itself (Tempo) is asked only
// after the client has recorded that money may move, once, and never again after it may have sent.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { APPROVAL_PAGE_SCRIPT } from "../../src/core/signer/approval-page.js";
import { TEMPO_STEP_SCRIPT, tempoStep } from "../../src/core/signer/steps/tempo.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;

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

type Answer = { status: number; body: Record<string, unknown> };

/** The approval page's scripts in a stand-in browser. `answers` decides what the client says to each POST. */
function pageInBrowser(options: {
  facts: Record<string, unknown>;
  stepScript?: string;
  wallet: (method: string, params: unknown[]) => Promise<unknown>;
  answers?: Partial<Record<string, (body: Record<string, unknown>) => Answer>>;
}) {
  const nodes = new Map<string, FakeNode>();
  const node = (id: string) => {
    let n = nodes.get(id);
    if (!n) nodes.set(id, (n = new FakeNode(["connect", "approve", "reject"].includes(id) ? "button" : "div")));
    return n;
  };
  node("approval-facts").textContent = JSON.stringify(options.facts);
  for (const act of ["connect", "approve", "reject"]) node(act).setAttribute("data-act", act);
  const events: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const listeners = new Map<string, (value: unknown) => void>();
  let onClick: (event: { target: FakeNode }) => void = () => {};
  const document = {
    body: new FakeNode("body"),
    getElementById: node,
    querySelectorAll: () => [node("connect"), node("approve"), node("reject")],
    addEventListener: (type: string, fn: typeof onClick) => {
      if (type === "click") onClick = fn;
    },
  };
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const leaf = `/${url.split("/").pop()}`;
    if (init?.method !== "POST") return { ok: true, status: 200, json: async () => ({ status: "pending" }) };
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    events.push(`POST ${leaf}`);
    bodies.push(body);
    const answer = options.answers?.[leaf]?.(body) ?? { status: 200, body: {} };
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  };
  const ethereum = {
    on(event: string, fn: (value: unknown) => void) {
      listeners.set(event, fn);
    },
    async request({ method, params }: { method: string; params?: unknown[] }) {
      events.push(`wallet ${method}`);
      return options.wallet(method, params ?? []);
    },
  };
  const window: Record<string, unknown> = { ethereum };
  const context = { window, document, fetch, setInterval: () => 0, setTimeout, Date, JSON, String, Math, Error, Promise };
  if (options.stepScript) runInNewContext(options.stepScript, context);
  runInNewContext(APPROVAL_PAGE_SCRIPT, context);
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return {
    events,
    bodies,
    say: () => node("say").text,
    shown: (id: string) => !node(id).hidden,
    /** The wallet announces an event to the page, as an EIP-1193 provider does. */
    emit: (event: string, value: unknown) => listeners.get(event)?.(value),
    click: async (act: string) => {
      onClick({ target: node(act) });
      await settle();
    },
  };
}

const tempoFacts = {
  id: "a".repeat(32),
  step: "tempo-transfer",
  amountDecimal: 0.01,
  asset: "pathUSD",
  amountAtomic: "10000",
  recipient: `0x${"22".repeat(20)}`,
  network: "eip155:42431",
  networkLabel: "Tempo Moderato (testnet)",
  assetAddress: "0x20C0000000000000000000000000000000000000",
  expiresAt: Date.now() + 60_000,
  ...tempoStep.pageFacts({} as never),
};
const call = { from: OWNER, to: "0x20C0000000000000000000000000000000000000", data: "0x95777d59", value: "0x0" };

/**
 * A wallet: it shares the owner's account, is on a chain (Tempo Moderato unless told otherwise), switches when asked
 * unless `stays` says it does not, and answers eth_sendTransaction as told, recording what it was asked to send.
 */
function tempoWallet(send: () => Promise<unknown>, options: { chain?: string; stays?: boolean; sent?: unknown[] } = {}) {
  const wallet = { chain: options.chain ?? "0xa5bf" };
  return Object.assign(
    async (method: string, params: unknown[]) => {
      if (method === "eth_requestAccounts") return [OWNER];
      if (method === "eth_chainId") return wallet.chain;
      if (method === "wallet_switchEthereumChain") {
        if (!options.stays) wallet.chain = (params[0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "eth_sendTransaction") {
        options.sent?.push(params[0]);
        return send();
      }
      return null;
    },
    { wallet },
  );
}

describe("the Tempo wallet step on the approval page", () => {
  it("is plain ES2017 that a browser can run without a build step", () => {
    const dir = mkdtempSync(join(tmpdir(), "superstables-step-"));
    try {
      writeFileSync(join(dir, "step.js"), TEMPO_STEP_SCRIPT);
      const checked = spawnSync(process.execPath, ["--check", join(dir, "step.js")], { encoding: "utf8" });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(transformSync(TEMPO_STEP_SCRIPT, { loader: "js", target: "es2017" }).code).toBe(transformSync(TEMPO_STEP_SCRIPT, { loader: "js", target: "esnext" }).code);
  });

  it("switches the wallet to Tempo Moderato, records the payment, and only then asks the wallet to send it, once", async () => {
    const page = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => HASH),
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await page.click("connect");
    await page.click("approve");
    expect(page.events).toEqual([
      "wallet eth_requestAccounts",
      "wallet wallet_switchEthereumChain",
      "wallet eth_chainId",
      "POST /account",
      "wallet wallet_switchEthereumChain",
      "wallet eth_chainId",
      "POST /sending",
      "wallet eth_chainId",
      "wallet eth_sendTransaction",
      "POST /sent",
    ]);
    expect(page.bodies.at(-1)).toEqual({ address: OWNER, hash: HASH });
    expect(page.say()).toBe("Sent. You can go back to the agent.");
  });

  it("sends only on Tempo Moderato: a wallet moved to another chain after connecting is switched back, and the call names the chain", async () => {
    const sent: unknown[] = [];
    const wallet = tempoWallet(async () => HASH, { sent });
    const page = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet,
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await page.click("connect");
    // The owner moves the wallet to Tempo mainnet (4217) before approving; the page is told, and prepares again.
    wallet.wallet.chain = "0x1079";
    page.emit("chainChanged", "0x1079");
    expect(page.shown("approve")).toBe(false);
    expect(page.say()).toContain("switched to another chain");
    await page.click("connect");
    await page.click("approve");
    expect(sent).toEqual([{ from: OWNER, to: call.to, data: call.data, value: "0x0", chainId: "0xa5bf" }]);
    // Even without the event, the wallet is switched back and checked before anything is recorded.
    const quiet = tempoWallet(async () => HASH, { sent: [] });
    const unaware = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: quiet,
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await unaware.click("connect");
    quiet.wallet.chain = "0x1079";
    await unaware.click("approve");
    expect(unaware.events.slice(-6)).toEqual([
      "wallet wallet_switchEthereumChain",
      "wallet eth_chainId",
      "POST /sending",
      "wallet eth_chainId",
      "wallet eth_sendTransaction",
      "POST /sent",
    ]);
  });

  it("does not record or send for a wallet that stays on another chain, or adds Tempo without switching to it", async () => {
    // A wallet that answers the switch but stays on Tempo mainnet: nothing is recorded, nothing is sent.
    const staying = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => HASH, { chain: "0x1079", stays: true }),
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await staying.click("connect");
    expect(staying.events).not.toContain("POST /account");
    expect(staying.say()).toContain("your wallet is on another chain; switch it to Tempo Testnet (Moderato)");

    // A wallet that does not know Tempo: it is added, then switched to explicitly, then checked. One that adds it
    // without making it the current chain is caught by the check.
    const added: string[] = [];
    const adding = (activates: boolean) => {
      const wallet = { chain: "0x1" };
      return async (method: string, params: unknown[]) => {
        added.push(method);
        if (method === "eth_requestAccounts") return [OWNER];
        if (method === "eth_chainId") return wallet.chain;
        if (method === "wallet_switchEthereumChain") {
          if (!added.includes("wallet_addEthereumChain")) throw Object.assign(new Error("unknown chain"), { code: 4902 });
          if (activates) wallet.chain = (params[0] as { chainId: string }).chainId;
          return null;
        }
        return null;
      };
    };
    const known = pageInBrowser({ facts: tempoFacts, stepScript: TEMPO_STEP_SCRIPT, wallet: adding(true), answers: { "/account": () => ({ status: 200, body: { transaction: call } }) } });
    await known.click("connect");
    expect(added).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain", "wallet_switchEthereumChain", "eth_chainId"]);
    expect(known.events).toContain("POST /account");
    added.length = 0;
    const inactive = pageInBrowser({ facts: tempoFacts, stepScript: TEMPO_STEP_SCRIPT, wallet: adding(false), answers: { "/account": () => ({ status: 200, body: { transaction: call } }) } });
    await inactive.click("connect");
    expect(inactive.events).not.toContain("POST /account");
    expect(inactive.say()).toContain("your wallet is on another chain");
  });

  it("does not ask the wallet to send when it cannot confirm the chain after the payment was recorded", async () => {
    let chainReads = 0;
    const page = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: async (method) => {
        if (method === "eth_requestAccounts") return [OWNER];
        if (method === "eth_chainId") {
          chainReads += 1;
          // The read right before the send fails: nothing says the wallet moved.
          if (chainReads === 3) throw new Error("wallet disconnected");
          return "0xa5bf";
        }
        return null;
      },
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await page.click("connect");
    await page.click("approve");
    expect(page.events).not.toContain("wallet eth_sendTransaction");
    expect(page.say()).toContain("This page could not confirm that your wallet is on Tempo Testnet (Moderato), so it did not ask it to send.");
  });

  it("does not ask the wallet to send when it left Tempo Moderato after the payment was recorded, and says so", async () => {
    const wallet = tempoWallet(async () => HASH, { sent: [] });
    let moved = false;
    const page = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet,
      answers: {
        "/account": () => ({ status: 200, body: { transaction: call } }),
        // The wallet moves while the client records the payment.
        "/sending": () => {
          moved = true;
          wallet.wallet.chain = "0x1079";
          return { status: 200, body: { status: "send" } };
        },
      },
    });
    await page.click("connect");
    await page.click("approve");
    expect(moved).toBe(true);
    expect(page.events).not.toContain("wallet eth_sendTransaction");
    expect(page.say()).toBe("This page could not confirm that your wallet is on Tempo Testnet (Moderato), so it did not ask it to send. The client had already recorded that the payment may be sent, so the outcome stays unconfirmed. Check the command result.");
    const before = page.events.length;
    await page.click("approve");
    expect(page.events.length).toBe(before);
  });

  it("does not ask the wallet when the client refuses to record the payment", async () => {
    const page = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => HASH),
      answers: {
        "/account": () => ({ status: 200, body: { transaction: call } }),
        "/sending": () => ({ status: 409, body: { error: "the local spend policy refuses this payment: caps.per_day", status: "refused", reason: "the local spend policy refuses this payment: caps.per_day" } }),
      },
    });
    await page.click("connect");
    await page.click("approve");
    expect(page.events).not.toContain("wallet eth_sendTransaction");
    expect(page.say()).toContain("caps.per_day");
  });

  it("reports the wallet's own no as a rejection, and asks nothing again after a wallet error", async () => {
    const rejecting = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }))),
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }), "/reject": () => ({ status: 200, body: { status: "denied" } }) },
    });
    await rejecting.click("connect");
    await rejecting.click("approve");
    expect(rejecting.events.slice(-2)).toEqual(["wallet eth_sendTransaction", "POST /reject"]);
    expect(rejecting.bodies.at(-1)).toEqual({ by: "wallet" });
    // Once the wallet was asked, the client keeps a reported rejection unconfirmed, and the page says so.
    const unconfirmed = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }))),
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }), "/reject": () => ({ status: 200, body: { status: "unknown" } }) },
    });
    await unconfirmed.click("connect");
    await unconfirmed.click("approve");
    expect(unconfirmed.say()).toContain("records it as unconfirmed until the chain shows the payment");

    const failing = pageInBrowser({
      facts: tempoFacts,
      stepScript: TEMPO_STEP_SCRIPT,
      wallet: tempoWallet(async () => Promise.reject(new Error("internal JSON-RPC error"))),
      answers: { "/account": () => ({ status: 200, body: { transaction: call } }) },
    });
    await failing.click("connect");
    await failing.click("approve");
    expect(failing.say()).toContain("The payment's status could not be confirmed, and it may have been sent");
    const before = failing.events.length;
    // The buttons stay off: neither the approve button nor a new connection hands the payment to the wallet again.
    await failing.click("approve");
    await failing.click("connect");
    await failing.click("reject");
    expect(failing.events.length).toBe(before);
    expect(failing.events.filter((e) => e === "POST /sending")).toHaveLength(1);
  });
});

describe("the EVM wallet step on the approval page", () => {
  const baseFacts = { ...tempoFacts, step: "eip3009", chainIdHex: "0x14a34", chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } };

  it("switches the wallet to the payment's chain and checks it right before asking for a signature", async () => {
    const wallet = tempoWallet(async () => HASH, { chain: "0x14a34" });
    const signing = pageInBrowser({
      facts: baseFacts,
      wallet,
      answers: { "/account": () => ({ status: 200, body: { typedData: { domain: { chainId: 84532 } } } }), "/signature": () => ({ status: 200, body: { status: "signed" } }) },
    });
    await signing.click("connect");
    // Moved to Ethereum mainnet without the page hearing of it: switched back and checked before it signs.
    wallet.wallet.chain = "0x1";
    await signing.click("approve");
    expect(signing.events.slice(-4)).toEqual(["wallet wallet_switchEthereumChain", "wallet eth_chainId", "wallet eth_signTypedData_v4", "POST /signature"]);

    // A wallet that stays on another chain is never asked to sign.
    const staying = pageInBrowser({
      facts: baseFacts,
      wallet: tempoWallet(async () => HASH, { chain: "0x1", stays: true }),
      answers: { "/account": () => ({ status: 200, body: { typedData: { domain: {} } } }) },
    });
    await staying.click("connect");
    await staying.click("approve");
    expect(staying.events).not.toContain("wallet eth_signTypedData_v4");
    expect(staying.events).not.toContain("POST /account");
  });

  it("says it could not confirm the chain when the wallet does not answer which chain it is on", async () => {
    let chainReads = 0;
    const page = pageInBrowser({
      facts: baseFacts,
      wallet: async (method) => {
        if (method === "eth_requestAccounts") return [OWNER];
        if (method === "eth_chainId") {
          chainReads += 1;
          if (chainReads > 1) throw new Error("wallet disconnected");
          return "0x14a34";
        }
        return null;
      },
      answers: { "/account": () => ({ status: 200, body: { typedData: { domain: {} } } }) },
    });
    await page.click("connect");
    await page.click("approve");
    expect(page.events).not.toContain("wallet eth_signTypedData_v4");
    expect(page.say()).toBe("This page could not confirm that your wallet is on Base Sepolia, so it did not ask it to sign: wallet disconnected");
  });

  it("does not take a declined chain switch as a rejection of the payment", async () => {
    let chain = "0x14a34";
    let declineSwitch = false;
    const page = pageInBrowser({
      facts: baseFacts,
      wallet: async (method, params) => {
        if (method === "eth_requestAccounts") return [OWNER];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          if (declineSwitch) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
          chain = (params[0] as { chainId: string }).chainId;
          return null;
        }
        return null;
      },
      answers: { "/account": () => ({ status: 200, body: { typedData: { domain: {} } } }) },
    });
    await page.click("connect");
    chain = "0x1";
    declineSwitch = true;
    await page.click("approve");
    expect(page.events).not.toContain("POST /reject");
    expect(page.events).not.toContain("wallet eth_signTypedData_v4");
    expect(page.say()).toBe("This page could not confirm that your wallet is on Base Sepolia, so it did not ask it to sign: User rejected the request.");
  });

  it("offers the wallet the chain with its own currency when the wallet does not know it", async () => {
    const added: unknown[] = [];
    const page = pageInBrowser({
      facts: { ...tempoFacts, step: "eip3009", chainIdHex: "0x4cef52", chainName: "Arc Testnet", rpcUrl: "https://rpc.testnet.arc.network", explorer: "https://explorer.testnet.arc.io", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 } },
      wallet: async (method, params) => {
        if (method === "eth_requestAccounts") return [OWNER];
        if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown chain"), { code: 4902 });
        if (method === "wallet_addEthereumChain") added.push(params[0]);
        return null;
      },
      answers: { "/account": () => ({ status: 200, body: { typedData: { domain: {} } } }) },
    });
    await page.click("connect");
    expect(added).toEqual([
      { chainId: "0x4cef52", chainName: "Arc Testnet", rpcUrls: ["https://rpc.testnet.arc.network"], nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, blockExplorerUrls: ["https://explorer.testnet.arc.io"] },
    ]);
  });
});
