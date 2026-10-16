// A stand-in browser for the local wallet page's script: just enough of the DOM, fetch, location, history and storage
// to run it in a vm context and look at what it renders and sends. Not a test file.

import { runInNewContext } from "node:vm";
import { WALLET_STATUS_LABELS } from "../../src/core/status-labels.js";
import { WALLET_PAGE_SCRIPT } from "../../src/wallet/page.js";

export class El {
  hidden = false;
  disabled = false;
  className = "";
  hover = false;
  children: El[] = [];
  parent?: El;
  attrs = new Map<string, string>();
  private html = "";
  private text = "";
  private listeners = new Map<string, (event: unknown) => void>();
  constructor(readonly tag = "div") {}
  get innerHTML() {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = String(value);
  }
  get textContent() {
    return this.text;
  }
  set textContent(value: string) {
    this.text = String(value);
  }
  value = "";
  appendChild(child: El) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: El) {
    this.children = this.children.filter((c) => c !== child);
    child.parent = undefined;
    return child;
  }
  matches(selector: string) {
    return selector === ":hover" && this.hover;
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
  addEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.set(type, fn);
  }
  fire(type: string, event: unknown = {}) {
    this.listeners.get(type)?.(event);
  }
  /** Everything this node shows, markup included, children after it. */
  get markup(): string {
    return this.html + this.text + this.children.map((c) => c.markup).join("");
  }
}

export interface Call {
  path: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

export type Answer = { status: number; body: unknown };

export const STORAGE_KEY = "superstables-owner-secret";

export function wallet(options: {
  hash?: string;
  /** What the browser's sessionStorage holds before the page loads. */
  stored?: Record<string, string>;
  /** The wallet's answers; the default is an empty list and a plain policy. */
  answer?: (call: Call) => Answer | undefined;
}) {
  const ids = ["unlock", "secret-input", "notice", "policy", "pending", "pending-empty", "history", "status-labels"];
  const nodes = new Map(ids.map((id) => [id, new El(id === "secret-input" ? "input" : "div")]));
  nodes.get("unlock")!.hidden = true;
  nodes.get("notice")!.hidden = true;
  nodes.get("policy")!.hidden = true;
  nodes.get("status-labels")!.textContent = JSON.stringify(WALLET_STATUS_LABELS);
  const location = { hash: options.hash ?? "", pathname: "/", search: "" };
  const store = new Map(Object.entries(options.stored ?? {}));
  const sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
  };
  const history = { replaceState: (_s: unknown, _t: string, url: string) => void (location.hash = url.includes("#") ? "#" + url.split("#")[1] : "") };
  const calls: Call[] = [];
  let requests: unknown[] = [];
  const fetch = async (path: string, init: Call["init"] = {}) => {
    const call = { path, init };
    calls.push(call);
    const custom = options.answer?.(call);
    const answer: Answer =
      custom ??
      (path === "/owner/requests"
        ? { status: 200, body: { requests } }
        : path === "/status"
          ? { status: 200, body: { policy: { perCall: "0.05 USDC", perDay: "1 USDC", allow: [], deny: [], stablecoins: ["USDC"], killSwitch: false, file: "/home/o/.superstables/policy.yaml" } } }
          : { status: 200, body: {} });
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, json: async () => answer.body };
  };
  let onClick: (event: { target: El }) => void = () => undefined;
  let tickFn: () => unknown = () => undefined;
  const document = {
    getElementById: (id: string) => nodes.get(id),
    createElement: (tag: string) => new El(tag),
    addEventListener: (type: string, fn: typeof onClick) => {
      if (type === "click") onClick = fn;
    },
  };
  const window = { addEventListener: () => undefined };
  const context = {
    window, document, location, history, sessionStorage, fetch, Date, JSON, String, Math, Object, Array, Promise, Boolean,
    encodeURIComponent, parseInt, setInterval: (fn: () => unknown) => { tickFn = fn; return 0; },
  };
  runInNewContext(WALLET_PAGE_SCRIPT, context);
  const settle = () => new Promise((done) => setTimeout(done, 20));
  return {
    location, store, calls, nodes,
    node: (id: string) => nodes.get(id)!,
    pending: nodes.get("pending")!,
    /** Sets what the wallet lists, then lets the page's timer fire once. */
    show: async (list: unknown[]) => {
      requests = list;
      tickFn();
      await settle();
    },
    settle,
    /** Presses the button with this `data-act` inside the card, as the document's click handler sees it. */
    click: async (card: El, act: string) => {
      const found = new RegExp(`<button[^>]*data-act="${act}"[^>]*data-id="([^"]*)"`).exec(card.markup);
      if (!found) throw new Error(`no ${act} button in: ${card.markup}`);
      const button = new El("button");
      button.setAttribute("data-act", act);
      button.setAttribute("data-id", found[1]);
      onClick({ target: button });
      await settle();
    },
    /** The calls that decided a request. */
    decisions: () => calls.filter((c) => c.init.method === "POST"),
  };
}

export function request(id: string, createdAt: number, over: Record<string, unknown> = {}) {
  return {
    id,
    status: "pending",
    createdAt,
    expiresAt: Date.now() + 60_000,
    validForSeconds: 300,
    verified: {
      amountDecimal: 0.01,
      amountAtomic: "10000",
      asset: "USDC",
      assetAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      network: "eip155:84532",
      networkLabel: "Base Sepolia (testnet)",
      recipient: `0x${id.padEnd(40, "2").slice(0, 40)}`,
      payer: `0x${"1".repeat(40)}`,
      scheme: "exact",
    },
    ...over,
  };
}
