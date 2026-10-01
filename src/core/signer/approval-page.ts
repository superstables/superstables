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
import { esc, framePage, pageLook, type PageLook } from "./look.js";

export { esc };

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

/** JSON that is safe to inline: nothing in it can close the script element around it. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

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
    document.body.setAttribute("data-state", status);
    if (status === "signed") say("Signed. You can go back to the agent.", "good");
    else if (status === "expired") say("This request expired. Cancel any open wallet request, then ask the agent for a new link.", "bad");
    else say(why || "This payment was rejected. Cancel any open wallet request.", "bad");
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
        say("Ready. Press \\u201cReview in wallet\\u201d and check the amount in your wallet.");
      })
      .catch(function (err) {
        setBusy(false);
        if (err && err.code === 4001) say("You cancelled the connection; nothing was signed.", "bad");
        else say("Could not connect: " + reason(err), "bad");
      });
  }

  function approve() {
    if (!typedData || !account) return;
    var signed = false;
    setBusy(true);
    say("Check your wallet: it is asking you to sign this payment.");
    provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)]
    })
      .then(function (signature) { signed = true; return post("/signature", { address: account, signature: signature }); })
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
        if (signed) say("Your wallet signed, but the client did not confirm it received the signature: " + reason(err) + ". Check the command result before trying again.", "bad");
        else if (err && err.code === 4001) say("You rejected in your wallet; nothing was signed.", "bad");
        else say("The wallet could not sign this: " + reason(err), "bad");
      });
  }

  function reject() {
    setBusy(true);
    post("/reject", {})
      .then(function (answer) {
        if (answer.ok) { ended("denied", "You rejected this payment. Cancel any open wallet request."); return; }
        // 409: the payment ended first (signed, expired, rejected); show that, not a rejection
        if (answer.data.status) { ended(answer.data.status, answer.data.reason); return; }
        setBusy(false);
        say(answer.data.error || "The client did not accept the rejection. Check the command result.", "bad");
      })
      .catch(function () { setBusy(false); say("The client is not answering. Check that the agent is still running.", "bad"); });
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
  if (rows.length === 0) rows.push("<div>The agent provided no payment details.</div>");
  return `<div class="reported"><strong>Reported by the agent (not verified)</strong>${rows.join("")}</div>`;
}

/** The network's name, without the "(testnet)" the bar's pill already says. */
function networkCell(facts: ApprovalPageFacts): string {
  const label = facts.networkLabel || facts.network;
  return esc(label.replace(/\s*\(testnet\)\s*/i, "").trim() || label);
}

/** The whole page for one pending approval, facts and all, ready to serve. */
export function approvalPage(facts: ApprovalPageFacts, look: PageLook = pageLook()): string {
  const seconds = Math.max(0, Math.round((facts.expiresAt - Date.now()) / 1000));
  const body = `
  <div id="no-wallet" class="note bad" hidden>
    MetaMask (or another browser wallet) is needed to sign this payment. Install one at
    <a href="${WALLET_DOWNLOAD_URL}" rel="noreferrer noopener">${WALLET_DOWNLOAD_URL}</a>, then reload this page.
    You can still reject the payment without one.
  </div>

  <div class="card">
    <div class="amount">${esc(facts.amountDecimal)}<span>${esc(facts.asset)}</span></div>
    <dl class="rows">
      <dt>To</dt><dd class="mono">${esc(facts.recipient)}</dd>
      <dt>Network</dt><dd>${networkCell(facts)}</dd>
      <dt>Token</dt><dd class="mono">${esc(facts.assetAddress)}</dd>
      <dt>Expires in</dt><dd><span id="expiry">${seconds}</span> s</dd>
      <dt id="account-label" hidden>Paying from</dt><dd id="account" class="mono" hidden></dd>
    </dl>
    ${reportedBlock(facts.reported)}
    <div id="say" class="note" hidden></div>
    <div class="actions">
      <button id="connect" class="primary" data-act="connect">Connect wallet</button>
      <button id="approve" class="primary" data-act="approve" hidden>Review in wallet</button>
      <button id="reject" data-act="reject">Reject</button>
    </div>
    <p class="fineprint">
      Your wallet shows this amount in the token's smallest unit: ${esc(facts.amountAtomic)} is
      ${esc(facts.amountDecimal)} ${esc(facts.asset)}. Signing authorises this one transfer and nothing else.
    </p>
  </div>

<script id="approval-facts" type="application/json">${inlineJson(facts)}</script>
<script>${APPROVAL_PAGE_SCRIPT}</script>`;
  return framePage({
    look,
    title: "Approve a payment",
    eyebrow: "Payment request",
    lede: "Check the amount and the recipient, then sign with your browser wallet, or reject. Your wallet keeps its key.",
    testnet: /testnet/i.test(facts.networkLabel || facts.network),
    body,
  });
}

/** What an unknown, or already forgotten, approval id gets. Same page furniture, no buttons. */
export function approvalNotFoundPage(look: PageLook = pageLook()): string {
  return framePage({
    look,
    title: "This link is unavailable",
    eyebrow: "Payment request",
    body: `
  <div class="note bad">
    The request may have ended or the client may have restarted. Cancel any open wallet request.
    Check the command result and wallet activity before asking for a new link.
  </div>`,
  });
}
