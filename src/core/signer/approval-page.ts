// The page the owner opens to approve one payment with a browser wallet (MetaMask and
// anything else that speaks window.ethereum). One self-contained HTML string per request,
// served by the approval server on 127.0.0.1, with no build step and no external asset: a
// page that authorises a payment should be readable in full, in one file, by anyone who
// wants to check what it does before they sign.
//
// Three rules the markup follows.
//
//  1. The facts the server derived from the seller's requirement — amount, asset, network,
//     recipient — are rendered into the HTML itself, escaped. They are visible before a line
//     of JavaScript runs, and they are the only thing an approval is ever about.
//  2. Anything the agent said about the payment lives in its own block, labelled as not
//     verified. What the server checked and what the agent claimed must never look alike.
//  3. The key is the browser wallet's. This page asks it to sign typed data the server built;
//     it never sees a private key, and the signature goes straight back to loopback.
//
// The script is plain ES2017 with no bundler, so it is exported separately and parsed by a
// test: a syntax error here would only show up in front of a person about to pay.

import type { PaymentContext } from "../types.js";

/** Everything the page shows and needs, all of it derived by the server. */
export interface ApprovalPageFacts {
  id: string;
  amountDecimal: number;
  asset: string;
  /** Atomic units, so the page can explain what the wallet's popup will show. */
  amountAtomic: string;
  recipient: string;
  network: string;
  networkLabel: string;
  assetAddress: string;
  expiresAt: number;
  /** EIP-155 chain id as the hex string window.ethereum expects, e.g. "0x14a34". */
  chainIdHex: string;
  chainName: string;
  rpcUrl: string;
  explorer: string;
  reported?: PaymentContext;
}

/** Where a person gets a browser wallet, when the page finds none. */
export const WALLET_DOWNLOAD_URL = "https://metamask.io/download";

/** HTML-escape one value. Shared with the owner approval page. */
export function esc(value: unknown): string {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON that is safe to inline: nothing in it can close the script element around it. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The look every Superstables approval page shares. */
export const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --card: #ffffff;
    --ink: #14171f;
    --muted: #61697a;
    --line: #e3e6ec;
    --accent: #1b6b4a;
    --accent-ink: #ffffff;
    --danger: #a3302a;
    --warn-bg: #fff8e6;
    --warn-line: #e7d9ae;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101319;
      --card: #171b23;
      --ink: #e9ecf2;
      --muted: #9aa3b4;
      --line: #262c38;
      --accent: #2f9e6e;
      --accent-ink: #06130d;
      --danger: #e8776f;
      --warn-bg: #241f12;
      --warn-line: #4a3f23;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
  header h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  .note { margin: 18px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--muted); font-size: 13px; }
  .note.bad { border-color: var(--danger); color: var(--danger); }
  .note.good { border-color: var(--accent); color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin: 20px 0 16px; }
  .amount { font-size: 34px; font-weight: 640; letter-spacing: -0.02em; }
  .amount span { font-size: 18px; font-weight: 500; color: var(--muted); margin-left: 6px; }
  .tag { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); vertical-align: 2px; margin-left: 6px; }
  .rows { margin: 16px 0 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 13px; }
  .rows dt { color: var(--muted); }
  .rows dd { margin: 0; word-break: break-all; }
  .reported { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 10px; font-size: 13px; }
  .reported strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; font-weight: 560; padding: 10px 18px; border-radius: 9px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button[disabled] { opacity: 0.55; cursor: default; }
  .fineprint { color: var(--muted); font-size: 12px; margin-top: 14px; }
  a { color: inherit; }
`;

/**
 * The page's own script. Exported so a test can parse it: there is no build step here, and a
 * syntax error would otherwise be found by the person holding the wallet.
 */
export const APPROVAL_PAGE_SCRIPT = `
(function () {
  var facts = JSON.parse(document.getElementById("approval-facts").textContent);
  var base = "/approve/" + encodeURIComponent(facts.id);
  var provider = window.ethereum;
  var account = null;
  var typedData = null;
  var busy = false;
  var done = false;

  function el(id) { return document.getElementById(id); }
  function show(id, on) { el(id).hidden = !on; }

  function say(message, kind) {
    var box = el("say");
    box.hidden = false;
    box.className = kind ? "note " + kind : "note";
    box.textContent = message;
  }

  function reason(err) {
    if (!err) return "the wallet gave no reason";
    return String(err.message || err);
  }

  function setBusy(on) {
    busy = on;
    var buttons = document.querySelectorAll("button[data-act]");
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = on || done;
  }

  function countdown() {
    var left = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
    el("expiry").textContent = String(left);
  }

  function ended(status, why) {
    if (done) return;
    done = true;
    setBusy(false);
    show("connect", false);
    show("approve", false);
    show("reject", false);
    if (status === "signed") say("Signed. You can go back to the agent.", "good");
    else if (status === "expired") say("This request expired; nothing was signed. Ask the agent to try again.", "bad");
    else say(why || "This payment was rejected; nothing was signed.", "bad");
  }

  function post(path, body) {
    return fetch(base + path, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function refresh() {
    countdown();
    if (done) return Promise.resolve();
    return fetch(base + "/state", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (state) {
        if (!state) return;
        if (state.status !== "pending") ended(state.status, state.reason);
      })
      .catch(function () { /* a page that cannot reach loopback simply waits */ });
  }

  function ensureChain() {
    return provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: facts.chainIdHex }]
    }).catch(function (err) {
      // 4902: the wallet has never heard of this chain. Offer to add it, then switch.
      if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
        return provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: facts.chainIdHex,
            chainName: facts.chainName,
            rpcUrls: [facts.rpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            blockExplorerUrls: [facts.explorer]
          }]
        });
      }
      throw err;
    });
  }

  function connect() {
    setBusy(true);
    say("Check your wallet: it is asking which account to use.");
    provider.request({ method: "eth_requestAccounts" })
      .then(function (accounts) {
        if (!accounts || accounts.length === 0) throw new Error("no account was shared");
        account = accounts[0];
        return ensureChain();
      })
      .then(function () { return post("/account", { address: account }); })
      .then(function (answer) {
        if (!answer.ok) throw new Error(answer.data.error || "the approval server would not prepare this payment");
        typedData = answer.data.typedData;
        el("account").textContent = account;
        show("account-label", true);
        show("account", true);
        show("connect", false);
        show("approve", true);
        setBusy(false);
        say("Ready. Press \\u201cApprove in MetaMask\\u201d and check the amount in the wallet popup.");
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.code === 4001) say("You cancelled the connection; nothing was signed.", "bad");
        else say("Could not connect: " + reason(err), "bad");
      });
  }

  function approve() {
    if (!typedData || !account) return;
    setBusy(true);
    say("Check your wallet: it is asking you to sign this payment.");
    provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)]
    })
      .then(function (signature) { return post("/signature", { address: account, signature: signature }); })
      .then(function (answer) {
        if (!answer.ok) {
          setBusy(false);
          say(answer.data.error || "That signature was not accepted; you can try again.", "bad");
          return;
        }
        ended("signed");
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.code === 4001) say("You rejected in MetaMask; nothing was signed.", "bad");
        else say("The wallet could not sign this: " + reason(err), "bad");
      });
  }

  function reject() {
    setBusy(true);
    post("/reject", {})
      .then(function () { ended("denied", "You rejected this payment; nothing was signed."); })
      .catch(function () { setBusy(false); say("The approval server is not answering. Is the agent still running?", "bad"); });
  }

  document.addEventListener("click", function (event) {
    var button = event.target && event.target.closest ? event.target.closest("button[data-act]") : null;
    if (!button || button.disabled || busy) return;
    var act = button.getAttribute("data-act");
    if (act === "connect") connect();
    else if (act === "approve") approve();
    else if (act === "reject") reject();
  });

  if (!provider) {
    show("no-wallet", true);
    show("connect", false);
  }

  if (provider && provider.on) {
    // Switching accounts mid-flow must re-prepare the payment for the new one.
    provider.on("accountsChanged", function (accounts) {
      if (done || !accounts || accounts.length === 0) return;
      account = accounts[0];
      typedData = null;
      show("approve", false);
      show("connect", true);
      el("account").textContent = account;
      say("You switched accounts. Connect again so this payment is prepared for " + account + ".");
    });
  }

  refresh();
  setInterval(refresh, 2000);
  setInterval(countdown, 1000);
})();
`;

function reportedBlock(reported?: PaymentContext): string {
  const rows: string[] = [];
  if (reported?.serviceName) rows.push(`<div>Service: ${esc(reported.serviceName)}</div>`);
  if (reported?.target) rows.push(`<div class="mono">${esc(reported.target)}</div>`);
  if (reported?.description) rows.push(`<div>${esc(reported.description)}</div>`);
  if (rows.length === 0) rows.push("<div>The agent said nothing about this payment.</div>");
  return `<div class="reported"><strong>Reported by the agent (not verified)</strong>${rows.join("")}</div>`;
}

function networkCell(facts: ApprovalPageFacts): string {
  const label = facts.networkLabel || facts.network;
  const testnet = /testnet/i.test(label);
  const name = esc(label.replace(/\s*\(testnet\)\s*/i, "").trim() || label);
  return name + (testnet ? ' <span class="tag">testnet</span>' : "");
}

/** The whole page for one pending approval, facts and all, ready to serve. */
export function approvalPage(facts: ApprovalPageFacts): string {
  const seconds = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Superstables &middot; approve a payment</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Superstables &middot; approve a payment</h1>
    <p>Your browser wallet holds the key &middot; the agent can ask, only you can sign.</p>
  </header>

  <div id="say" class="note" hidden></div>

  <div id="no-wallet" class="note bad" hidden>
    MetaMask (or another browser wallet) is needed to sign this payment. Install one at
    <a href="${WALLET_DOWNLOAD_URL}" rel="noreferrer noopener">${WALLET_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject the payment without one.
  </div>

  <div class="card">
    <div class="amount">${esc(facts.amountDecimal)}<span>${esc(facts.asset)}</span></div>
    <dl class="rows">
      <dt>To</dt><dd class="mono">${esc(facts.recipient)}</dd>
      <dt>On</dt><dd>${networkCell(facts)}</dd>
      <dt>Token</dt><dd class="mono">${esc(facts.assetAddress)}</dd>
      <dt>Expires in</dt><dd><span id="expiry">${seconds}</span> s</dd>
      <dt id="account-label" hidden>Paying from</dt><dd id="account" class="mono" hidden></dd>
    </dl>
    ${reportedBlock(facts.reported)}
    <div class="actions">
      <button id="connect" class="primary" data-act="connect">Connect wallet</button>
      <button id="approve" class="primary" data-act="approve" hidden>Approve in MetaMask</button>
      <button id="reject" data-act="reject">Reject</button>
    </div>
    <p class="fineprint">
      Your wallet shows this amount in the token's smallest unit: ${esc(facts.amountAtomic)} is
      ${esc(facts.amountDecimal)} ${esc(facts.asset)}. Signing authorises this one transfer and nothing else.
    </p>
  </div>
</div>

<script id="approval-facts" type="application/json">${inlineJson(facts)}</script>
<script>${APPROVAL_PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/** What an unknown, or already forgotten, approval id gets. Same page furniture, no buttons. */
export function approvalNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Superstables &middot; approve a payment</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Superstables &middot; approve a payment</h1>
    <p>Your browser wallet holds the key &middot; the agent can ask, only you can sign.</p>
  </header>
  <div class="note bad">
    There is no payment waiting under this link. It may have been approved, rejected or expired
    already, or the agent may have been restarted. Nothing was signed. Ask the agent for a new link.
  </div>
</div>
</body>
</html>
`;
}
